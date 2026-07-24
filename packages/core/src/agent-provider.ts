import { AgentMuxError } from './errors.js'
import type { ExecutionHost } from './execution-host.js'
import {
  normalizeNativeHook,
  type AgentNativeHookSpecification
} from './hook-normalizer.js'
import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentId,
  AgentLaunchPlan,
  AgentProviderLaunchContext,
  AgentProviderResumeContext,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

export type AgentExecutableProbe = {
  hasExecutable(executable: string): Promise<boolean>
}

export type AgentProvider = {
  readonly id: AgentId
  readonly label: string
  readonly executable: string
  readonly catalog: AgentCatalogEntry
  probeCapabilities(probe: AgentExecutableProbe, commandOverride?: string): Promise<AgentCapabilitySnapshot>
  buildLaunch(context: AgentProviderLaunchContext): AgentLaunchPlan
  buildResumeLaunch(context: AgentProviderResumeContext): AgentLaunchPlan
  normalizeHook(envelope: NativeHookEnvelope): NormalizedHookEvent
}

export type AgentProviderDefinition = {
  catalog: AgentCatalogEntry
  buildArgs(prompt: string, args: readonly string[]): string[]
  hook: AgentNativeHookSpecification
  buildResumeArgs?: (sessionId: string, transcriptPath: string | undefined, args: readonly string[]) => string[]
}

const NO_HOOKS: AgentNativeHookSpecification = { rules: [] }

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

const HERMES_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['pre_approval_request'], state: 'waiting' },
    {
      events: ['post_llm_call', 'on_session_end', 'on_session_finalize', 'on_session_reset'],
      state: 'done'
    },
    {
      events: ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_approval_response'],
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
  return {
    id: catalog.id,
    label: catalog.label,
    executable: catalog.executable,
    catalog,
    async probeCapabilities(probe, commandOverride) {
      const command = executable(commandOverride, catalog.executable)
      return {
        agentId: catalog.id,
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
        args: definition.buildResumeArgs(handle.sessionId, handle.transcriptPath, context.args),
        env: { ...context.env }
      }
    },
    normalizeHook(envelope) {
      if (envelope.agentId !== catalog.id) {
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
        permission: 'observe',
        providerResume: true,
        acp: false
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: CODEX_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, args) => ['resume', sessionId, ...args]
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
        permission: 'observe',
        providerResume: true,
        acp: false
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: CLAUDE_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, args) => ['--resume', sessionId, ...args]
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
        permission: 'none',
        providerResume: false,
        acp: false
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
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        permission: 'observe',
        providerResume: false,
        acp: false
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
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'transcript-path' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        permission: 'observe',
        providerResume: true,
        acp: false
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: PI_HOOKS,
    buildResumeArgs: (_sessionId, transcriptPath, args) => {
      if (!transcriptPath) {
        throw new AgentMuxError('Pi resume requires its hook-reported session file.', 'INVALID_NATIVE_SESSION_HANDLE')
      }
      return ['--session', transcriptPath, ...args]
    }
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
  private readonly providers = new Map<AgentId, AgentProvider>()

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

  get(id: AgentId): AgentProvider {
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
