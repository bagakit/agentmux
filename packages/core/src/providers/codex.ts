import { prepareCodexToolExecutionLaunch } from './codex-tool-execution-launch.js'
import { prepareCodexExecutionHelper } from './codex-execution-helper.js'
import { CODEX_USAGE_CAPABILITY } from '@agentmux/providers/codex/usage'
import { planCodexQuestionReply } from './codex-question.js'
import { observeCodexTerminalFrontend, reconnectCodexTerminalFrontend } from './codex-managed-frontend.js'
import { readCodexPromptExecutionEvidence, createCodexPromptExecutionTransportVerifier } from './codex-prompt-execution-evidence.js'
import { readCodexResumedTurnInterruption } from './codex-resumed-turn-interruption.js'
import { listCodexNativeSessions, assertCodexNativeResumeSource, codexRecoveryFiles } from './codex-native-catalog.js'
import { createCodexPromptTransportPreparation } from './codex-prompt-transport-preparation.js'
import { inspectCodexPromptExecution, inspectCodexPromptPreparationWait } from './codex-prompt-execution.js'
import { observeCodexSessionStatus } from './codex-session-status.js'
import { prepareCodexManagedLaunch, prepareCodexNativeInput } from './codex-native-input.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { inspectCodexHookActivation } from './codex-hook-activation.js'
import { withCodexLaunchHooks } from './codex-launch-hooks.js'
export { CODEX_HOOK_EVENTS } from './codex-launch-hooks.js'
import { isAbsolute } from 'node:path'
import { codexMainNativeRecord } from './codex-native-record-role.js'
import { CODEX_LAUNCH_OPTIONS } from './launch-options.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { discoverAppServerNativeSession } from './app-server-native-session.js'
import { readAppServerSessionHistoryPage, readAppServerSessionHistoryRecord } from './app-server-native-history.js'
import { readCodexSavedSessionHistoryPage, readCodexSavedSessionHistoryRecord, readCodexSavedConversationChanges } from './codex-saved-history.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition, AgentProviderHookNormalizationContext } from '../agent-provider.js'
import type { AgentNativeHookSpecification, AgentNativeHookToolFields } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import type { AgentHookToolInvocation, AgentLaunchPlan } from '../types.js'
import { buildPromptInputPayload, catalog, hookToolFields, sanitizeBracketedPasteText } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

function codexToolFields(eventName: string, payload: Readonly<Record<string, unknown>>): AgentNativeHookToolFields {
  if (eventName === 'PermissionRequest') return hookToolFields(payload.tool_name, payload.tool_input)
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') return {}
  return hookToolFields(payload.tool_name, payload.tool_input, payload.tool_use_id)
}

function openToolInvocation(eventName: string, payload: Readonly<Record<string, unknown>>,
  context: AgentProviderHookNormalizationContext, mainSubject: boolean): AgentHookToolInvocation | undefined {
  const previous = context.previousHookReceipt?.toolInvocation
  if (!mainSubject) return previous
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
  const turn = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined
  const path = typeof payload.transcript_path === 'string' && isAbsolute(payload.transcript_path) ? payload.transcript_path : undefined
  const tool = codexToolFields(eventName, payload), id = tool.reportedToolCallId
  const sameSource = previous && (sid ? sid === previous.nativeSessionId :
    context.nativeHandle?.kind === 'provider' && context.nativeHandle.sessionId === previous.nativeSessionId) &&
    (payload.transcript_path === undefined ? context.nativeHandle?.kind === 'provider' &&
      context.nativeHandle.transcriptPath === previous.nativeTranscriptPath : path === previous.nativeTranscriptPath)
  const sameTurn = sameSource && (!turn || turn === previous.nativeTurnId)
  if (eventName === 'Stop' || eventName === 'Interrupt' || eventName === 'SessionStart') return undefined
  if (eventName === 'PreToolUse' && sid && turn && path && id && tool.toolName && tool.toolInput !== undefined) {
    const toolInput = typeof tool.toolInput === 'string' ? tool.toolInput : JSON.stringify(tool.toolInput)
    return { nativeSessionId: sid, nativeTurnId: turn, nativeTranscriptPath: path, nativeToolCallId: id, toolName: tool.toolName, toolInput,
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
  const tool = codexToolFields(eventName, payload)
  // PermissionRequest omits tool_use_id in the native protocol. Only the exact
  // immediately preceding authenticated PreToolUse supplies that missing identity.
  if (eventName !== 'PermissionRequest' || previous?.eventName !== 'PreToolUse' ||
      previous.providerId !== 'codex' || previous.lifecycleEvent !== 'tool-use-start' ||
      !previous.nativeTurnId || typeof payload.turn_id !== 'string' || !payload.turn_id || previous.nativeTurnId !== payload.turn_id ||
      !invocation || invocation.ambiguous || !invocation.nativeTurnId || invocation.nativeTurnId !== payload.turn_id || native?.kind !== 'provider' || native.providerId !== 'codex' ||
      typeof payload.session_id !== 'string' || !payload.session_id ||
      invocation.nativeSessionId !== payload.session_id || native.sessionId !== payload.session_id ||
      !invocation.nativeTranscriptPath || invocation.nativeTranscriptPath !== payload.transcript_path || native.transcriptPath !== payload.transcript_path ||
      invocation.toolName !== 'Bash' || tool.toolName !== 'Bash') return undefined
  try {
    const before = JSON.parse(invocation.toolInput) as Record<string, unknown>
    const after = tool.toolInput as Record<string, unknown> | undefined
    if (!after || Array.isArray(after) || typeof after !== 'object' ||
        Object.keys(before).some(key => !['command', 'description'].includes(key)) ||
        Object.keys(after).some(key => !['command', 'description'].includes(key)) ||
        typeof before.command !== 'string' || !before.command || before.command !== after.command ||
        before.description !== undefined && before.description !== after.description ||
        after.description !== undefined && typeof after.description !== 'string') return undefined
    return invocation.nativeToolCallId
  } catch { return undefined }
}

export const CODEX_HOOKS: AgentNativeHookSpecification = {
  toolFields: codexToolFields,
  toolOutcome(eventName, payload) {
    // Unified exec sends plain output without its exit code; other responses are tool-owned JSON.
    const output = formatHookToolOutput(eventName === 'PostToolUse' ? payload.tool_response : undefined)
    return { failed: false, ...(output === undefined ? {} : { output }) }
  },
  launchCarried: true,
  lifecycle: {
    SessionStart: 'session-start',
    UserPromptSubmit: 'user-prompt-submit',
    PermissionRequest: 'permission-request',
    PreToolUse: 'tool-use-start',
    PostToolUse: 'tool-use-end',
    SubagentStart: 'subagent-start',
  },
  usageFinalizationEvents: ['Stop', 'StopFailure'],
  permissionDecision: {
    eventName: 'PermissionRequest',
    outputs: {
      'allow-once': { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
      'reject-once': { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } }
    }
  },
  processNativeIdentity: true,
  continuity(eventName, payload) {
    // Interrupt has no human-origin cancellation fact; internal compaction can emit it too.
    const nativeSessionId = normalizeNativeSessionId(payload.session_id)
    return eventName === 'SessionStart' && payload.hook_event_name === 'SessionStart' && payload.source === 'resume' && nativeSessionId
      ? { kind: 'context-restored', nativeSessionId } : undefined
  },
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
    // Stop callbacks can still be vetoed; the original native outcome observer owns completion.
    { events: ['Stop', 'SubagentStop'], state: 'unknown', lifecycleEvent: null },
    {
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart'],
      state: 'working'
    }
  ],
  subagentTracking: {
    startEvents: ['SubagentStart'],
    stopEvents: [],
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

export function createCodexProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const interaction = createNumberedTerminalInteractionProtocol({
    questionEvents: ['PreToolUse'], questionTools: ['request_user_input', 'askuserquestion'],
    questionCompletionEvents: ['PostToolUse'], permissionCompletionEvents: ['PostToolUse'], permissionOptions: CODEX_PERMISSION_OPTIONS
  })
  const verifyPromptExecutionTransport = createCodexPromptExecutionTransportVerifier()
  const provider = defineAgentProvider({
    prepareToolExecutionLaunch: (plan, context) => prepareCodexToolExecutionLaunch(plan, { workspacePath: context.binding.workspacePath, url: context.url }, { launchWorkspacePath: context.launchWorkspacePath, ...(context.invocation ? { invocation: context.invocation } : {}) }),
    prepareExecutionHelper: prepareCodexExecutionHelper,
    prepareManagedLaunch: prepareCodexManagedLaunch,
    prepareNativeInput: prepareCodexNativeInput,
    planQuestionReply: planCodexQuestionReply,
    observeTerminalFrontend: observeCodexTerminalFrontend,
    reconnectTerminalFrontend: reconnectCodexTerminalFrontend,
    catalog: catalog({
      composer: {"skillRoots": [".agents/skills", ".codex/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/status", "description": "Session and usage"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}, {"text": "/diff", "description": "Review changes"}]},
      id: 'codex', label: 'Codex', executable: 'codex', expectedProcess: 'codex',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'launch-carried' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        turnOutcomes: { observation: ['completed', 'failed', 'interrupted'] },
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, nativeInterruption: true, replyCorrelation: 'none', nativeConversationInput: { managedRuns: true },
        asyncQuestionReply: 'native-input',
        providerFork: { current: true },
        promptExecution: { immediate: 'terminal-submit' },
        usage: CODEX_USAGE_CAPABILITY
      }
    }),
    buildArgs: (prompt, args) => codexInvocation(args, [], prompt),
    terminalHandshake: { query: '\u001b[?u', response: '\u001b[?0u' },
    terminalPromptRender: { frameStart: '\u001b[?2026h', activeComposer: '›', frameEnd: '\u001b[?2026l' },
    inspectPromptExecution: inspectCodexPromptExecution,
    inspectPromptPreparationWait: inspectCodexPromptPreparationWait,
    verifyPromptExecutionTransport,
    preparePromptExecutionTransport: createCodexPromptTransportPreparation(verifyPromptExecutionTransport),
    readPromptExecutionEvidence: readCodexPromptExecutionEvidence,
    readResumedTurnInterruption: readCodexResumedTurnInterruption,
    observeSessionStatus: observeCodexSessionStatus,
    planPromptInput: prompt => ({
      kind: 'render-then-submit',
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      // The native composer submits into its active turn; interruption is not part of this input.
      submit: '\r'
    }),
    interaction,
    hook: CODEX_HOOKS,
    discoverNativeSession: context => discoverAppServerNativeSession(context, 'codex', codexMainNativeRecord),
    listNativeSessions: listCodexNativeSessions,
    assertNativeResumeSource: assertCodexNativeResumeSource,
    readConversationChanges: readCodexSavedConversationChanges,
    readSessionHistoryPage: context => context.transcriptPath ? readCodexSavedSessionHistoryPage(context) : readAppServerSessionHistoryPage(context),
    recoveryFiles: codexRecoveryFiles,
    readSessionHistoryRecord: context => context.transcriptPath ? readCodexSavedSessionHistoryRecord(context) : readAppServerSessionHistoryRecord(context),
    observeSessionHistory: observeNativeJsonlHistory,
    inspectHookActivation: inspectCodexHookActivation,
    launchOptions: CODEX_LAUNCH_OPTIONS,
    buildForkArgs: (sessionId, _transcriptPath, prompt, args) => codexInvocation(args, ['fork', sessionId], prompt),
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => codexInvocation(args, ['resume', sessionId], prompt)
  })
  const withHookIssue = (plan: AgentLaunchPlan, args: readonly string[]): AgentLaunchPlan => {
    const issue = withCodexLaunchHooks(args).issue
    return issue ? { ...plan, hookLaunchIssue: { code: 'HOOK_LAUNCH_CONFIGURATION_UNCONFIRMED', message: issue } } : plan
  }
  return { ...provider,
    buildLaunch: context => withHookIssue(provider.buildLaunch(context), context.args),
    buildResumeLaunch: context => withHookIssue(provider.buildResumeLaunch(context), context.args),
    buildForkLaunch: context => withHookIssue(provider.buildForkLaunch!(context), context.args)
  }
}

/** Keep the configured launcher intact. Native root options also apply to resume/fork. */
function codexInvocation(args: readonly string[], action: readonly string[], prompt?: string): string[] {
  return [...withCodexLaunchHooks(args).args,
    ...(args.includes('--dangerously-bypass-hook-trust') ? [] : ['--dangerously-bypass-hook-trust']),
    ...action,
    ...(prompt ? ['--', prompt] : [])]
}
