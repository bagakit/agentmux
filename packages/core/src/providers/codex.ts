import { isAbsolute } from 'node:path'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CODEX_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { buildPromptInputPayload, catalog, managedHookCommand, sanitizeBracketedPasteText } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop'
] as const

export const CODEX_HOOKS: AgentNativeHookSpecification = {
  // 事件名随负载到达：与 Claude 同族，stdin 负载带 `hook_event_name`。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    { events: ['PermissionRequest'], state: 'waiting' },
    { events: ['PreToolUse'], toolNames: ['request_user_input', 'askuserquestion'], state: 'waiting' },
    { events: ['Stop'], state: 'done' },
    {
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart'],
      state: 'working'
    }
  ],
  subagentTracking: {
    startEvents: ['SubagentStart'],
    stopEvents: ['SubagentStop'],
    mainStopEvents: ['Stop'],
    idKeys: ['agent_id', 'agentId']
  },
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

const PERMISSION_ESC = '\u001b'
const CODEX_PERMISSION_OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow', kind: 'allow-once', tier: 'safe', input: '1' },
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: PERMISSION_ESC }
]

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
      content: `${JSON.stringify({ description: 'AgentMux Codex lifecycle bridge.', hooks }, null, 2)}\n`,
      mode: 0o600,
      merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
    }]
  }
}

export function createCodexProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'codex', label: 'Codex', executable: 'codex', expectedProcess: 'codex',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, acp: false, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
      }
    }),
    buildArgs: (prompt, args) => [
      ...args,
      ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
      ...(prompt ? [prompt] : [])
    ],
    terminalHandshake: { query: '\u001b[?u', response: '\u001b[?0u' },
    terminalPromptRender: { frameStart: '\u001b[?2026h', activeComposer: '›', frameEnd: '\u001b[?2026l' },
    planPromptInput: (prompt) => ({
      kind: 'render-then-submit',
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      submit: '\r'
    }),
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['PreToolUse'],
      questionTools: ['request_user_input', 'askuserquestion'],
      permissionOptions: CODEX_PERMISSION_OPTIONS
    }),
    hook: CODEX_HOOKS,
    launchOptions: CODEX_LAUNCH_OPTIONS,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      'resume', sessionId,
      ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
      ...(prompt ? [prompt] : []),
      ...args
    ]
  })
}