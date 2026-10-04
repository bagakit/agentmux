import { readCodexPromptExecutionEvidence, createCodexPromptExecutionTransportVerifier } from './codex-prompt-execution-evidence.js'
import { inspectCodexPromptExecution } from './codex-prompt-execution.js'
import { observeCodexSessionStatus } from './codex-session-status.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { inspectCodexHookActivation } from './codex-hook-activation.js'
import { isAbsolute } from 'node:path'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CODEX_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { discoverCodexNativeSession } from './codex-native-session.js'
import { readCodexSessionHistoryPage } from './codex-native-history.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { buildPromptInputPayload, catalog, managedHookCommand, sanitizeBracketedPasteText, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt'
] as const

export const CODEX_HOOKS: AgentNativeHookSpecification = {
  processNativeIdentity: true,
  resolveSubject(payload, context) {
    const main = context.processNativeHandle
    const nativeId = normalizeNativeSessionId(payload.session_id)
    const childId = normalizeNativeSessionId(payload.agent_id ?? payload.agentId)
    if (!main) return { kind: 'unknown', basis: 'process-native-record', reason: context.nativeIdentityReason ?? 'native-witness-unavailable' }
    if (nativeId !== main.sessionId) return { kind: 'foreign', basis: 'process-native-record', reason: 'native-parent-mismatch', ...(nativeId ? { nativeSessionId: nativeId } : {}) }
    // Codex root session_id is shared by descendants; agent_id is the spawned thread ID.
    if (childId) return { kind: childId !== main.sessionId && context.processNativeChildSessionIds?.includes(childId) ? 'child' : 'unknown', basis: 'process-native-record', nativeSessionId: childId,
      reason: childId === main.sessionId ? 'conflicting-codex-subject' : context.processNativeChildSessionIds?.includes(childId) ? 'codex-child-of-confirmed-main' : 'native-child-membership-unconfirmed' }
    return { kind: 'main', basis: 'process-native-record', nativeSessionId: main.sessionId, reason: 'codex-confirmed-main' }
  },
  // 事件名随负载到达：与 Claude 同族，stdin 负载带 `hook_event_name`。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  nativeTurnIdKeys: ['turn_id'],
  rules: [
    { events: ['Interrupt'], state: 'unknown', lifecycleEvent: 'turn-end' },
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
    hooks: [{ type: 'command', command, ...hookCommandTimeout('codex') }]
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
    planManagedHooks: ({ workspacePath }) => createCodexManagedHookPlan(workspacePath),
    catalog: catalog({
      composer: {"skillRoots": [".agents/skills", ".codex/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/status", "description": "Session and usage"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}, {"text": "/diff", "description": "Review changes"}]},
      id: 'codex', label: 'Codex', executable: 'codex', expectedProcess: 'codex',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, replyCorrelation: 'none',
        providerFork: { current: true },
        promptExecution: { immediate: 'interrupt-before-input' },
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
    inspectPromptExecution: inspectCodexPromptExecution,
    verifyPromptExecutionTransport: createCodexPromptExecutionTransportVerifier(),
    readPromptExecutionEvidence: readCodexPromptExecutionEvidence,
    observeSessionStatus: observeCodexSessionStatus,
    planPromptInput: (prompt, context) => ({
      kind: 'render-then-submit',
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      submit: '\r',
      ...(context?.execution === 'immediate' ? { prepare: { refresh: '\u001b[I', interrupt: '\u001b', endEvent: 'Interrupt' } } : {})
    }),
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['PreToolUse'],
      questionTools: ['request_user_input', 'askuserquestion'],
      questionCompletionEvents: ['PostToolUse'],
      permissionCompletionEvents: ['PostToolUse'],
      permissionOptions: CODEX_PERMISSION_OPTIONS
    }),
    hook: CODEX_HOOKS,
    discoverNativeSession: discoverCodexNativeSession,
    readSessionHistoryPage: readCodexSessionHistoryPage,
    observeSessionHistory: observeNativeJsonlHistory,
    inspectHookActivation: inspectCodexHookActivation,
    launchOptions: CODEX_LAUNCH_OPTIONS,
    buildForkArgs: (sessionId, _transcriptPath, prompt, args) => [
      'fork', sessionId,
      ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
      ...(prompt ? [prompt] : []),
      ...args
    ],
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      'resume', sessionId,
      ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
      ...(prompt ? [prompt] : []),
      ...args
    ]
  })
}
