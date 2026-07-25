import { AgentMuxError } from './errors.js'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutionHost } from './execution-host.js'
import type { AgentManagedHookPlan } from './managed-hook-installer.js'
import { resolveCoreBinPath } from './runtime-paths.js'
import {
  normalizeNativeHook,
  type AgentNativeHookSpecification
} from './hook-normalizer.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentProviderId,
  AgentLaunchPlan,
  AgentPromptInputPlan,
  AgentProviderLaunchContext,
  AgentProviderResumeContext,
  AgentTerminalHandshake,
  AgentTerminalPromptRenderMatcher,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

export type AgentExecutableProbe = {
  hasExecutable(executable: string): Promise<boolean>
}

export type AgentProvider = {
  readonly id: AgentProviderId
  readonly label: string
  readonly executable: string
  readonly catalog: AgentCatalogEntry
  readonly terminalHandshake?: AgentTerminalHandshake
  readonly terminalPromptRender?: AgentTerminalPromptRenderMatcher
  probeCapabilities(probe: AgentExecutableProbe, commandOverride?: string): Promise<AgentCapabilitySnapshot>
  buildLaunch(context: AgentProviderLaunchContext): AgentLaunchPlan
  buildResumeLaunch(context: AgentProviderResumeContext): AgentLaunchPlan
  planPromptInput(prompt: string): AgentPromptInputPlan
  normalizeHook(envelope: NativeHookEnvelope): NormalizedHookEvent
}

export type AgentProviderDefinition = {
  catalog: AgentCatalogEntry
  buildArgs(prompt: string, args: readonly string[]): string[]
  hook: AgentNativeHookSpecification
  terminalHandshake?: AgentTerminalHandshake
  terminalPromptRender?: AgentTerminalPromptRenderMatcher
  buildResumeArgs?: (
    sessionId: string,
    transcriptPath: string | undefined,
    prompt: string | undefined,
    args: readonly string[]
  ) => string[]
  planPromptInput?: (prompt: string) => AgentPromptInputPlan
}

const NO_HOOKS: AgentNativeHookSpecification = { rules: [] }
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'Stop'
] as const

const CLAUDE_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['PermissionRequest'], state: 'waiting' },
    { events: ['PreToolUse'], toolNames: ['askuserquestion'], state: 'waiting' },
    { events: ['Stop', 'StopFailure'], state: 'done' },
    {
      events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact'],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

const CODEX_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['PermissionRequest'], state: 'waiting' },
    {
      events: ['PreToolUse'],
      toolNames: ['request_user_input', 'askuserquestion'],
      state: 'waiting'
    },
    { events: ['Stop'], state: 'done' },
    {
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart'],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the managed hook `command` string written into a provider's hooks config.
 *
 * `process.execPath` is a real `node` binary in dev/tests but the Electron app binary when packaged;
 * `ELECTRON_RUN_AS_NODE=1` makes the Electron binary run the .js as a plain Node script, while a real
 * node binary ignores the unknown var — so one string is correct in both contexts. `AGENTMUX_HOOK_PROVIDER`
 * is baked in (not merely inherited from the launch env) so the hook emits the provider-correct decision
 * schema even across PTY restart/SSH, and so `antigravity` (agy) is never confused with `gemini` under
 * the shared ~/.gemini root. Relies on the agent CLI running the command through a shell, matching the
 * existing POSIX-quoting assumption.
 */
function managedHookCommand(providerId: AgentProviderId): string {
  const commandPath = resolveCoreBinPath('agentmux-hook.js')
  return `ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote(providerId)} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

/**
 * The hermes variant of {@link managedHookCommand}. hermes runs a shell hook as
 * `subprocess.run(shlex.split(command), shell=False)` — no shell — so the bare `VAR=val exec …` prefix
 * used everywhere else would make `ELECTRON_RUN_AS_NODE=1` the argv[0] hermes tries to exec. Prefixing
 * `/usr/bin/env` restores the environment assignment: `env` itself parses the `NAME=value` operands and
 * then execs the interpreter, so `ELECTRON_RUN_AS_NODE` and the baked-in `AGENTMUX_HOOK_PROVIDER` reach
 * the hook exactly as the other providers get them. Because the hook `.js` is interpreter-prefixed (not
 * argv[0]), hermes only requires it to be readable, never executable.
 */
function hermesHookCommand(): string {
  const commandPath = resolveCoreBinPath('agentmux-hook.js')
  return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER=${shellQuote('hermes')} ${shellQuote(process.execPath)} ${shellQuote(commandPath)}`
}

export function createCodexManagedHookPlan(workspacePath: string): AgentManagedHookPlan {
  const workspace = resolve(workspacePath)
  if (!isAbsolute(workspacePath) || workspace !== workspacePath) {
    throw new AgentMuxError('Codex Hook workspace must be an absolute normalized path.', 'INVALID_HOOK_PLAN')
  }
  const command = managedHookCommand('codex')
  const hooks = Object.fromEntries(CODEX_HOOK_EVENTS.map((eventName) => [eventName, [{
    ...(eventName === 'SessionStart' ? { matcher: 'startup|resume|clear|compact' } : {}),
    hooks: [{ type: 'command', command, timeout: 10 }]
  }]]))
  return {
    providerId: 'codex',
    mutations: [{
      path: join(workspace, '.codex', 'hooks.json'),
      content: `${JSON.stringify({
        description: 'AgentMux Codex lifecycle bridge.',
        hooks
      }, null, 2)}\n`,
      mode: 0o600,
      // `.codex/hooks.json` may hold project-committed foreign hooks; inject only AgentMux entries.
      // The marker is the hook script filename, not the full command, so a moved execPath still
      // sweeps our stale entries instead of duplicating them (Codex rejects unknown top-level fields,
      // so we cannot namespace under our own key the way antigravity does).
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

// Claude fires `matcher`-scoped tool events; every other lifecycle event is a flat command entry.
const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

/**
 * `.claude/settings.json` is the user's whole Claude Code settings file (permissions, model, MCP
 * servers, …) with hooks under a top-level `hooks` key — the canonical shared config. AgentMux owns
 * only its own command entries, matched by the hook script filename, and the merge preserves every
 * foreign setting and foreign hook. Workspace-scoped (like Codex) so the bridge is project-local.
 */
export function createClaudeManagedHookPlan(workspacePath: string): AgentManagedHookPlan {
  const workspace = resolve(workspacePath)
  if (!isAbsolute(workspacePath) || workspace !== workspacePath) {
    throw new AgentMuxError('Claude Hook workspace must be an absolute normalized path.', 'INVALID_HOOK_PLAN')
  }
  const command = managedHookCommand('claude')
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((eventName) => [eventName, [{
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command, timeout: 10 }]
  }]]))
  return {
    providerId: 'claude',
    mutations: [{
      path: join(workspace, '.claude', 'settings.json'),
      content: `${JSON.stringify({ hooks }, null, 2)}\n`,
      mode: 0o600,
      // settings.json carries far more than hooks; inject only AgentMux command entries and keep
      // every foreign top-level setting and foreign hook (Claude, like Codex, uses the `hooks` key).
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

const ANTIGRAVITY_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreInvocation',
  'PostInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop'
] as const

const ANTIGRAVITY_HOOKS: AgentNativeHookSpecification = {
  rules: [
    {
      events: ['PreToolUse'],
      toolNames: ['ask_question', 'ask_permission', 'request_user_input', 'askuserquestion'],
      state: 'waiting'
    },
    { events: ['Stop'], state: 'done' },
    {
      events: ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'SessionStart'],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['conversationId', 'conversation_id', 'session_id', 'sessionId'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

export function createAntigravityManagedHookPlan(homeOrWorkspacePath?: string): AgentManagedHookPlan {
  const targetRoot = homeOrWorkspacePath ? resolve(homeOrWorkspacePath) : homedir()
  const targetPath = targetRoot.endsWith('.json')
    ? targetRoot
    : join(targetRoot, '.gemini', 'config', 'hooks.json')
  const command = managedHookCommand('antigravity')

  const bundle: Record<string, unknown> = {}
  for (const eventName of ANTIGRAVITY_HOOK_EVENTS) {
    const eventCmd = `${command} --event ${eventName}`
    if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
      bundle[eventName] = [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: eventCmd, timeout: 10 }]
        }
      ]
    } else {
      bundle[eventName] = [
        { type: 'command', command: eventCmd, timeout: 10 }
      ]
    }
  }

  return {
    providerId: 'antigravity',
    mutations: [{
      path: targetPath,
      content: `${JSON.stringify({ 'agentmux-status': bundle }, null, 2)}\n`,
      mode: 0o600,
      // `~/.gemini/config/hooks.json` is shared with the real Gemini CLI; AgentMux owns only the
      // `agentmux-status` top-level bundle and must leave every sibling key untouched.
      merge: { kind: 'json-owned-key', key: 'agentmux-status' }
    }]
  }
}

/**
 * hermes' shell hooks live in the user's global `~/.hermes/config.yaml` — a comment-rich file that also
 * holds their model, credentials, and their own `hooks:` — plus a consent gate in
 * `~/.hermes/shell-hooks-allowlist.json`. AgentMux writes two mutations:
 *
 *   1. A comment-preserving YAML merge that adds our command entry under each event bucket in `hooks:`,
 *      owning only entries whose command carries the `agentmux-hook.js` marker and leaving every foreign
 *      key, foreign hook, and comment intact.
 *   2. A JSON merge that adds our `(event, command)` approvals to the allowlist, since hermes gates each
 *      shell hook on an exact approval and a non-TTY launch would otherwise skip our hooks. We add ONLY
 *      our own entries — never the global `hooks_auto_accept` / `HERMES_ACCEPT_HOOKS` opt-in, which would
 *      auto-approve every hook the user or another tool ever configures.
 *
 * Both mutations are idempotent (our approvals carry no timestamps; the YAML merge round-trips), so the
 * installer's install-and-leave path re-runs cheaply and never rewrites the secrets-bearing config once
 * installed. `homeOverride` exists only for tests; production always targets the real `~/.hermes`.
 */
export function createHermesManagedHookPlan(homeOverride?: string): AgentManagedHookPlan {
  const home = homeOverride ? resolve(homeOverride) : homedir()
  const command = hermesHookCommand()
  const hooks = Object.fromEntries(
    HERMES_HOOK_EVENTS.map((eventName) => [eventName, [{ command, timeout: 10 }]])
  )
  const approvals = HERMES_HOOK_EVENTS.map((eventName) => ({ event: eventName, command }))
  return {
    providerId: 'hermes',
    mutations: [
      {
        path: join(home, '.hermes', 'config.yaml'),
        // The owned fragment is JSON — the YAML merge reads it as data and edits the YAML doc in place,
        // so nothing here dictates the on-disk formatting; comments and foreign keys are preserved.
        content: `${JSON.stringify({ hooks }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'yaml-managed-events', marker: 'agentmux-hook.js' }
      },
      {
        path: join(home, '.hermes', 'shell-hooks-allowlist.json'),
        content: `${JSON.stringify({ approvals }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'json-managed-approvals', marker: 'agentmux-hook.js' }
      }
    ]
  }
}

/**
 * Resolve the managed Hook plan a provider needs installed before it can report status, or `null`
 * when the provider has no installable plan yet. Codex and Claude write a workspace-scoped hooks
 * config; Antigravity writes the global `~/.gemini` bundle it shares with Gemini; Hermes writes its
 * global `~/.hermes/config.yaml` shell hooks plus the matching consent allowlist. Pi (TypeScript
 * extension) declares native hooks but installs on a surface AgentMux does not write yet, so it
 * resolves to `null` and is simply not auto-installed.
 */
export function resolveManagedHookPlan(
  providerId: AgentProviderId,
  workspacePath: string
): AgentManagedHookPlan | null {
  switch (providerId) {
    case 'codex':
      return createCodexManagedHookPlan(workspacePath)
    case 'claude':
      return createClaudeManagedHookPlan(workspacePath)
    case 'antigravity':
      return createAntigravityManagedHookPlan()
    case 'hermes':
      return createHermesManagedHookPlan()
    default:
      return null
  }
}

const PI_HOOKS: AgentNativeHookSpecification = {
  rules: [
    {
      events: ['tool_call', 'tool_execution_start'],
      toolNames: ['ask_user_question', 'askuserquestion'],
      state: 'blocked'
    },
    { events: ['agent_end', 'agent_settled'], state: 'done' },
    {
      events: [
        'before_agent_start',
        'agent_start',
        'tool_call',
        'tool_execution_start',
        'tool_execution_end',
        'message_end'
      ],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['session_file'],
    requireTranscriptPath: true
  }
}

// hermes fires only these six lifecycle events on the CLI path (agent/turn_finalizer.py,
// agent/conversation_loop.py, model_tools.py, hermes_cli/plugins.py). `post_llm_call` fires once per
// turn after the tool loop completes — not per LLM round-trip — so it maps cleanly to `done` without
// mid-turn flicker. hermes has no resume, so the spec needs no nativeHandle.
const HERMES_HOOK_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'post_llm_call',
  'on_session_end'
] as const

const HERMES_HOOKS: AgentNativeHookSpecification = {
  rules: [
    // hermes' interactive ask-user tool is `clarify` — a pending tool call on it means AgentMux is
    // waiting on the user. This rule precedes the generic pre_tool_call rule so it wins the match.
    { events: ['pre_tool_call'], toolNames: ['clarify'], state: 'waiting' },
    { events: ['post_llm_call', 'on_session_end'], state: 'done' },
    {
      events: ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call'],
      state: 'working'
    }
  ]
}

function executable(commandOverride: string | undefined, fallback: string): string {
  const command = commandOverride?.trim() || fallback
  if (!command) throw new AgentMuxError('Agent command cannot be empty.', 'INVALID_AGENT_COMMAND')
  return command
}

export function defineAgentProvider(definition: AgentProviderDefinition): AgentProvider {
  const { catalog } = definition
  if (
    definition.terminalHandshake &&
    (!definition.terminalHandshake.query || !definition.terminalHandshake.response)
  ) {
    throw new AgentMuxError('Agent terminal handshake bytes cannot be empty.', 'INVALID_AGENT_PROVIDER')
  }
  if (
    definition.terminalPromptRender &&
    (
      !definition.terminalPromptRender.frameStart ||
      !definition.terminalPromptRender.activeComposer ||
      !definition.terminalPromptRender.frameEnd
    )
  ) {
    throw new AgentMuxError('Agent terminal prompt render matcher cannot be empty.', 'INVALID_AGENT_PROVIDER')
  }
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    catalog,
    ...(definition.terminalHandshake
      ? { terminalHandshake: { ...definition.terminalHandshake } }
      : {}),
    ...(definition.terminalPromptRender
      ? { terminalPromptRender: { ...definition.terminalPromptRender } }
      : {}),
    async probeCapabilities(probe, commandOverride) {
      const command = executable(commandOverride, catalog.executable)
      return {
        providerId: catalog.id,
        executable: command,
        installed: await probe.hasExecutable(command),
        capabilities: { ...catalog.capabilities }
      }
    },
    buildLaunch(context) {
      return {
        command: executable(context.commandOverride, catalog.executable),
        args: definition.buildArgs(context.prompt.trim(), context.args),
        env: { ...context.env }
      }
    },
    buildResumeLaunch(context) {
      if (!definition.buildResumeArgs || catalog.resumeStrategy.kind === 'none') {
        throw new AgentMuxError(`${catalog.label} does not support provider-native resume.`, 'AGENT_RESUME_UNSUPPORTED')
      }
      const handle = context.nativeHandle
      if (handle.kind !== 'provider' || handle.providerId !== catalog.id) {
        throw new AgentMuxError('Native session handle does not belong to this provider.', 'INVALID_NATIVE_SESSION_HANDLE')
      }
      return {
        command: executable(context.commandOverride, catalog.executable),
        args: definition.buildResumeArgs(
          handle.sessionId,
          handle.transcriptPath,
          context.prompt?.trim() || undefined,
          context.args
        ),
        env: { ...context.env }
      }
    },
    planPromptInput(prompt) {
      return definition.planPromptInput?.(prompt) ?? {
        kind: 'single-phase',
        data: `${prompt}\r`
      }
    },
    normalizeHook(envelope) {
      if (envelope.providerId !== catalog.id) {
        throw new AgentMuxError('Hook event does not belong to this provider.', 'HOOK_PROVIDER_MISMATCH')
      }
      return normalizeNativeHook(definition.hook, envelope)
    }
  }
}

function catalog(
  input: Omit<AgentCatalogEntry, 'readySignal'>
): AgentCatalogEntry {
  return {
    ...input,
    readySignal: { kind: 'foreground-process', expectedProcess: input.expectedProcess }
  }
}

export const BUILT_IN_AGENT_PROVIDERS: readonly AgentProvider[] = [
  defineAgentProvider({
    catalog: catalog({
      id: 'codex',
      label: 'Codex',
      executable: 'codex',
      expectedProcess: 'codex',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    terminalHandshake: {
      query: '\u001b[?u',
      response: '\u001b[?0u'
    },
    terminalPromptRender: {
      frameStart: '\u001b[?2026h',
      activeComposer: '›',
      frameEnd: '\u001b[?2026l'
    },
    planPromptInput: (prompt) => ({
      kind: 'render-then-submit',
      payload: prompt,
      submit: '\r'
    }),
    hook: CODEX_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      'resume', sessionId, ...(prompt ? [prompt] : []), ...args
    ]
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'claude',
      label: 'Claude',
      executable: 'claude',
      expectedProcess: 'claude',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: CLAUDE_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'traex',
      label: 'TraeX',
      executable: 'traex',
      expectedProcess: 'traex',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: false,
        timeline: 'unavailable',
        permission: 'none',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: NO_HOOKS
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'hermes',
      label: 'Hermes',
      executable: 'hermes',
      expectedProcess: 'hermes',
      promptDelivery: 'hermes-query',
      // AgentMux writes hermes' shell hooks into ~/.hermes/config.yaml plus the consent allowlist,
      // preserving the user's credentials, foreign hooks, and comments (see createHermesManagedHookPlan).
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) =>
      prompt ? ['chat', '--query', prompt, ...args, '--tui'] : [...args, '--tui'],
    hook: HERMES_HOOKS
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'pi',
      label: 'Pi',
      executable: 'pi',
      expectedProcess: 'pi',
      promptDelivery: 'positional-argv',
      // Native hooks ship as a TypeScript extension AgentMux does not deploy yet — unmanaged.
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      resumeStrategy: { kind: 'provider-native', locator: 'transcript-path' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: PI_HOOKS,
    buildResumeArgs: (_sessionId, transcriptPath, prompt, args) => {
      if (!transcriptPath) {
        throw new AgentMuxError('Pi resume requires its hook-reported session file.', 'INVALID_NATIVE_SESSION_HANDLE')
      }
      return ['--session', transcriptPath, ...args, ...(prompt ? [prompt] : [])]
    }
  }),
  // Terminal-only ports of Orca's TUI agents. Launch argv grammar is copied verbatim from
  // orca `src/shared/tui-agent-{config,startup}.ts`. Resume/hook capture stay OFF: they
  // require a hook envelope carrying a native session handle, and AgentMux does not yet run
  // the per-agent hook relay Orca uses to originate those events for grok/gemini/antigravity.
  // Declaring them would surface a Resume affordance that can never bind a handle.
  defineAgentProvider({
    catalog: catalog({
      id: 'grok',
      label: 'Grok',
      executable: 'grok',
      expectedProcess: 'grok',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: false,
        timeline: 'unavailable',
        permission: 'none',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    // Orca: promptInjectionMode 'argv' with argvPromptSeparator '--' → `grok -- <prompt>`
    // (separator so prompts like `--version` aren't parsed as Grok CLI flags).
    buildArgs: (prompt, args) => (prompt ? [...args, '--', prompt] : [...args]),
    hook: NO_HOOKS
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'gemini',
      label: 'Gemini',
      executable: 'gemini',
      expectedProcess: 'gemini',
      promptDelivery: 'flag-prompt-interactive',
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: false,
        timeline: 'unavailable',
        permission: 'none',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    // Orca: promptInjectionMode 'flag-prompt-interactive' → `gemini --prompt-interactive <prompt>`.
    buildArgs: (prompt, args) => (prompt ? ['--prompt-interactive', prompt, ...args] : [...args]),
    hook: NO_HOOKS
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'antigravity',
      label: 'Antigravity',
      executable: 'agy',
      expectedProcess: 'agy',
      promptDelivery: 'flag-prompt-interactive',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    // Orca: executable `agy`, promptInjectionMode 'flag-prompt-interactive' → `agy --prompt-interactive <prompt>`.
    buildArgs: (prompt, args) => (prompt ? ['--prompt-interactive', prompt, ...args] : [...args]),
    hook: ANTIGRAVITY_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--conversation', sessionId, ...args, ...(prompt ? ['--prompt-interactive', prompt] : [])
    ]
  }),
  defineAgentProvider({
    catalog: catalog({
      id: 'cursor',
      label: 'Cursor',
      executable: 'cursor-agent',
      expectedProcess: 'cursor-agent',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: false,
        timeline: 'unavailable',
        permission: 'none',
        providerResume: false,
        acp: false,
        replyCorrelation: 'none'
      }
    }),
    // Orca: executable `cursor-agent`, promptInjectionMode 'argv' (no separator) → `cursor-agent <prompt>`.
    // Orca's `preflightTrust: 'cursor'` pre-seeds a trust marker; AgentMux has no such mechanism,
    // so the first launch may show Cursor's trust prompt.
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: NO_HOOKS
  })
]

export function executionHostProbe(host: ExecutionHost): AgentExecutableProbe {
  return {
    async hasExecutable(command) {
      const result = await host.run(
        'sh',
        ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'agentmux-detect', command],
        { timeoutMs: 8_000 }
      )
      return result.exitCode === 0
    }
  }
}

export class AgentProviderRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>()

  constructor(providers: readonly AgentProvider[] = BUILT_IN_AGENT_PROVIDERS) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new AgentMuxError(`Agent provider already registered: ${provider.id}`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(provider.id, provider)
  }

  replace(provider: AgentProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: AgentProviderId): AgentProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new AgentMuxError(`Unknown agent provider: ${id}`, 'UNKNOWN_PROVIDER')
    return provider
  }

  list(): AgentProvider[] {
    return [...this.providers.values()]
  }

  catalog(): AgentCatalogEntry[] {
    return this.list().map((provider) => ({
      ...provider.catalog,
      readySignal: { ...provider.catalog.readySignal },
      hookStrategy: { ...provider.catalog.hookStrategy },
      resumeStrategy: { ...provider.catalog.resumeStrategy },
      acpStrategy: { ...provider.catalog.acpStrategy },
      capabilities: { ...provider.catalog.capabilities }
    }))
  }
}
