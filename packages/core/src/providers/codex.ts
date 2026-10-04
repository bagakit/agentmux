import { readCodexPromptExecutionEvidence, createCodexPromptExecutionTransportVerifier } from './codex-prompt-execution-evidence.js'
import { createCodexPromptTransportPreparation } from './codex-prompt-transport-preparation.js'
import { inspectCodexPromptExecution } from './codex-prompt-execution.js'
import { createCodexInteractionResponsePreparation } from './codex-interaction-target.js'
import { observeCodexSessionStatus } from './codex-session-status.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { inspectCodexHookActivation } from './codex-hook-activation.js'
import { isAbsolute } from 'node:path'
import { join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CODEX_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { discoverAppServerNativeSession } from './app-server-native-session.js'
import { codexQuestionAnswers, codexQuestionComposerNavigation } from './codex-question.js'
import { readAppServerSessionHistoryPage, readAppServerSessionHistoryRecord, prepareAppServerSessionQuestionReply } from './app-server-native-history.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition, AgentProviderHookNormalizationContext } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { nativeHookToolCallId } from '../hook-normalizer.js'
import type { AgentHookToolInvocation } from '../types.js'
import { buildPromptInputPayload, catalog, managedHookCommand, sanitizeBracketedPasteText, hookCommandTimeout } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

function openToolInvocation(eventName: string, payload: Readonly<Record<string, unknown>>,
  context: AgentProviderHookNormalizationContext, mainSubject: boolean): AgentHookToolInvocation | undefined {
  const previous = context.previousHookReceipt?.toolInvocation
  if (!mainSubject) return previous
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
  const turn = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined
  const path = typeof payload.transcript_path === 'string' && isAbsolute(payload.transcript_path) ? payload.transcript_path : undefined
  const id = nativeHookToolCallId(payload as Record<string, unknown>)
  const sameSource = previous && (sid ? sid === previous.nativeSessionId :
    context.nativeHandle?.kind === 'provider' && context.nativeHandle.sessionId === previous.nativeSessionId) &&
    (payload.transcript_path === undefined ? context.nativeHandle?.kind === 'provider' &&
      context.nativeHandle.transcriptPath === previous.nativeTranscriptPath : path === previous.nativeTranscriptPath)
  const sameTurn = sameSource && (!turn || turn === previous.nativeTurnId)
  if (eventName === 'Stop' || eventName === 'Interrupt' || eventName === 'SessionStart') return undefined
  if (eventName === 'PreToolUse' && sid && turn && path && id && typeof payload.tool_name === 'string' && payload.tool_name && payload.tool_input !== undefined) {
    const toolInput = typeof payload.tool_input === 'string' ? payload.tool_input : JSON.stringify(payload.tool_input)
    return { nativeSessionId: sid, nativeTurnId: turn, nativeTranscriptPath: path, nativeToolCallId: id, toolName: payload.tool_name, toolInput,
      ...(sameTurn && (previous.ambiguous || previous.nativeToolCallId !== id) ? { ambiguous: true as const } : {}) }
  }
  if (!sameTurn) return undefined
  // A single exact completion can close its known Pre. One Post cannot prove that
  // every observed ambiguous candidate has completed; retain ambiguity to turn end.
  if (eventName === 'PostToolUse' && !previous.ambiguous && id === previous.nativeToolCallId) return undefined
  return previous
}

function permissionToolCallId(eventName: string, payload: Readonly<Record<string, unknown>>,
  context: AgentProviderHookNormalizationContext): string | undefined {
  const previous = context.previousHookReceipt, invocation = previous?.toolInvocation
  const native = context.nativeHandle
  // PermissionRequest omits tool_use_id in the native protocol. Only the exact
  // immediately preceding authenticated PreToolUse supplies that missing identity.
  if (eventName !== 'PermissionRequest' || previous?.eventName !== 'PreToolUse' ||
      previous.providerId !== 'codex' || previous.lifecycleEvent !== 'tool-use-start' ||
      !previous.nativeTurnId || typeof payload.turn_id !== 'string' || !payload.turn_id || previous.nativeTurnId !== payload.turn_id ||
      !invocation || invocation.ambiguous || !invocation.nativeTurnId || invocation.nativeTurnId !== payload.turn_id || native?.kind !== 'provider' || native.providerId !== 'codex' ||
      typeof payload.session_id !== 'string' || !payload.session_id ||
      invocation.nativeSessionId !== payload.session_id || native.sessionId !== payload.session_id ||
      !invocation.nativeTranscriptPath || invocation.nativeTranscriptPath !== payload.transcript_path || native.transcriptPath !== payload.transcript_path ||
      invocation.toolName !== 'Bash' || payload.tool_name !== 'Bash') return undefined
  try {
    const before = JSON.parse(invocation.toolInput) as Record<string, unknown>
    const after = payload.tool_input as Record<string, unknown> | undefined
    if (!after || Array.isArray(after) || typeof after !== 'object' ||
        Object.keys(before).some(key => !['command', 'description'].includes(key)) ||
        Object.keys(after).some(key => !['command', 'description'].includes(key)) ||
        typeof before.command !== 'string' || !before.command || before.command !== after.command ||
        before.description !== undefined && before.description !== after.description ||
        after.description !== undefined && typeof after.description !== 'string') return undefined
    return invocation.nativeToolCallId
  } catch { return undefined }
}

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
  toolInvocation: openToolInvocation,
  resolveInteractionToolCallId: permissionToolCallId,
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
  const interaction = createNumberedTerminalInteractionProtocol({
    questionEvents: ['PreToolUse'], questionTools: ['request_user_input', 'askuserquestion'],
    questionCompletionEvents: ['PostToolUse'], permissionCompletionEvents: ['PostToolUse'], permissionOptions: CODEX_PERMISSION_OPTIONS
  })
  const verifyPromptExecutionTransport = createCodexPromptExecutionTransportVerifier()
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
        promptExecution: { immediate: 'native-steer' },
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
    verifyPromptExecutionTransport,
    preparePromptExecutionTransport: createCodexPromptTransportPreparation(verifyPromptExecutionTransport),
    readPromptExecutionEvidence: readCodexPromptExecutionEvidence,
    observeSessionStatus: observeCodexSessionStatus,
    planPromptInput: (prompt, context) => ({
      kind: 'render-then-submit',
      // Native async option editors treat a paste as an Other answer. Return to
      // the original main composer only for an exact question reply on this visible editor.
      payload: (context?.intent === 'question-reply' && codexQuestionAnswers([{ type: 'text', text: prompt }]) ? codexQuestionComposerNavigation(context.terminalScreen) : '') + buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      // The native composer submits into its active turn; interruption is not part of this input.
      submit: '\r'
    }),
    interaction,
    prepareInteractionResponse: createCodexInteractionResponsePreparation(interaction.planResponse),
    hook: CODEX_HOOKS,
    discoverNativeSession: context => discoverAppServerNativeSession(context, 'codex'),
    readSessionHistoryPage: readAppServerSessionHistoryPage,
    readSessionHistoryRecord: readAppServerSessionHistoryRecord,
    prepareSessionQuestionReply: prepareAppServerSessionQuestionReply,
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
