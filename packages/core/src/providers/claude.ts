import { prepareClaudeToolExecutionLaunch } from './claude-tool-execution-launch.js'
import { prepareClaudeExecutionHelper } from './claude-execution-helper.js'
import { CLAUDE_USAGE_CAPABILITY } from './claude-usage.js'
import { inspectClaudeHookActivation } from './claude-hook-activation.js'
import { listClaudeNativeSessions, assertClaudeNativeResumeSource } from './claude-native-catalog.js'
import { readClaudeSessionHistoryPage, readClaudeSessionHistoryRecord, readClaudeConversationChanges } from './claude-native-history.js'
import { discoverClaudeNativeSession } from './claude-native-session.js'
import { prepareClaudeNativeInput } from './claude-native-input.js'
import { prepareClaudeOwnedWorkspaceTrust } from './claude-workspace-trust.js'
import {
  CLAUDE_ASKED_TOOL_END_EVENT,
  CLAUDE_CHILD_ACTIVITY_EVENT,
  claudeNativeActivity,
  claudePlugin,
  CLAUDE_TURN_END_DECISION,
  CLAUDE_TURN_END_EVENT,
  CLAUDE_NOTICE_ADMISSION_EVENT,
  claudeNativeObservationFailure,
  claudeNativeTurnIdentity,
  withClaudePlugin
} from './claude-native-activity.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { CLAUDE_LAUNCH_OPTIONS } from './launch-options.js'
import { createNumberedTerminalInteractionProtocol, type TerminalPermissionOption } from '../agent-interaction.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import {
  buildPromptInputPayload,
  catalog,
  hookToolFields,
  runScopedHookCommand,
  hookCommandTimeout,
  sanitizeBracketedPasteText
} from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * AgentMux 插件 `hooks/hooks.json` 声明的经典事件名（随启动经 `--plugin-dir` 加载，不写进工作区）。
 *
 * 这份清单是**实际注册**的那一份，与 `CLAUDE_HOOKS.rules` 引用的名字必须一致：rules 里写了却没装的
 * 事件，Claude 压根不会发——声明看着完整，运行时永远命中不到。此前 `PostToolUseFailure`、
 * `StopFailure`、`PreCompact` 三个就是这样：rules 引用它们，清单不装它们（同族的 grok Provider
 * 反倒装了 `PostToolUseFailure`/`StopFailure`）。三个都被本机 CLI 的事件全集与负载 schema 佐证，
 * 所以补装而不是把 rules 删掉。
 *
 * 各自不可替代的作用（负载形状取自本机 bundle 的 zod schema）：
 * - `PostToolUseFailure`：`{tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?}`。
 *   **没有** `tool_response`，正文只在 `error` 里。少了这条，一次失败的工具调用会永远停在
 *   streaming 徽标上——`PostToolUse` 只在成功时触发（bundle 内嵌文档逐字："Run after successful tool"）。
 * - `StopFailure`：`{error, error_details?, last_assistant_message?}`。它**取代** `Stop`，也就是说
 *   报错收尾根本不会有 `Stop`。少装它，Agent 报错后会永远停在 working。
 * - `PreCompact`：`{trigger: 'manual'|'auto', custom_instructions}`。压缩期间 Agent 仍在干活，
 *   而这段时间没有任何工具事件——少了它，长压缩看起来像卡死。
 *
 * Claude 的事件全集有 33 个（bundle 里的 `_y`）。其余不装：`Notification`/`MessageDisplay`/
 * `StatusLine`/`FileSuggestion` 是 UI 通路；`FileChanged`/`CwdChanged`/`DirectoryAdded` 每次文件
 * 变动都触发，是把子进程挂到最热路径上；`PostCompact`/`SessionEnd`/`TeammateIdle`/`TaskCreated`/
 * `TaskCompleted`/`PermissionDenied`/`PostToolBatch` 等 Core 今天没有判断需要（见下方 rules 的说明）。
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact'
] as const

export const CLAUDE_HOOKS: AgentNativeHookSpecification = {
  toolFields(eventName, payload) {
    if (eventName === CLAUDE_ASKED_TOOL_END_EVENT) return hookToolFields(payload.tool_name, undefined, payload.tool_use_id)
    if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(eventName)) return {}
    // Our native plugin attaches the asked call's own ID to classic PermissionRequest.
    return hookToolFields(payload.tool_name, payload.tool_input, payload.tool_use_id)
  },
  toolOutcome(eventName, payload) {
    const failed = eventName === 'PostToolUseFailure'
    const body = failed ? (typeof payload.error === 'string' ? payload.error : undefined)
      : eventName === 'PostToolUse' ? payload.tool_response : undefined
    // Native tool_response is opaque; its business JSON does not establish failure.
    const output = formatHookToolOutput(body)
    return { failed, ...(output === undefined ? {} : { output }) }
  },
  launchCarried: true,
  // Return a decision on the original native PermissionRequest pipe. This does not
  // grant an Agent authority to answer: the common interaction owner verifies its author.
  permissionDecision: {
    eventName: 'PermissionRequest',
    outputs: {
      'allow-once': { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
      'reject-once': { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } }
    }
  },

  lifecycle: {
    SessionStart: 'session-start',
    UserPromptSubmit: 'user-prompt-submit',
    PermissionRequest: 'permission-request',
    PreToolUse: 'tool-use-start',
    PostToolUse: 'tool-use-end',
    PostToolUseFailure: 'tool-use-end',
    // The exact end of an asked call: a late one cannot reopen an ended turn.
    [CLAUDE_ASKED_TOOL_END_EVENT]: 'tool-use-end',
    SubagentStart: 'subagent-start',
    StopFailure: 'turn-end',
  },
  usageFinalizationEvents: ['Stop', 'StopFailure'],
  turnEndDecision: CLAUDE_TURN_END_DECISION,
  observationFailure: claudeNativeObservationFailure,
  currentActivity: claudeNativeActivity,
  nativeTurnIdKeys: ['turnId'],
  nativeSessionTransition: (eventName, payload) => eventName === 'SessionStart' &&
    ['startup', 'resume', 'clear', 'compact', 'fork'].includes(String(payload.source)),
  // `claude --resume <id>` reports SessionStart with source "resume" and the resumed session_id
  // (observed on a real run; a fresh start reports "startup"). Core only accepts it from the exact
  // main subject of the current authenticated recovery Run, so a late or foreign event cannot count.
  continuity(eventName, payload) {
    const nativeSessionId = normalizeNativeSessionId(payload.session_id)
    return eventName === 'SessionStart' && payload.hook_event_name === 'SessionStart' && payload.source === 'resume' && nativeSessionId
      ? { kind: 'context-restored', nativeSessionId } : undefined
  },
  // 事件名随负载到达：Claude 一族的 stdin 负载带 `hook_event_name`（这也是 claude/codex 的配置都不带
  // `--event` 却照样能用的原因——事件名不在配置侧、在投递侧）。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  subagentSubject: (payload) =>
    (typeof payload.agent_id === 'string' && payload.agent_id.length > 0) ||
    (typeof payload.agentId === 'string' && payload.agentId.length > 0),
  rules: [
    // Native mods observe the actual runner end; activity is independent of task completion.
    { events: ['turn.start'], state: 'working', lifecycleEvent: 'turn-start',
      matches: payload => claudeNativeTurnIdentity(payload) !== undefined },
    { events: ['turn.complete'], state: 'error', lifecycleEvent: 'turn-end',
      matches: payload => payload.reason === 'error' && claudeNativeActivity('turn.complete', payload) !== undefined },
    { events: ['turn.start', 'turn.complete', 'AgentMuxActivityUnavailable'], state: 'unknown', lifecycleEvent: null },
    // An Inbox notice ask and its native queue report carry no activity: they leave semantic state as it was.
    { events: [CLAUDE_TURN_END_EVENT, CLAUDE_NOTICE_ADMISSION_EVENT], state: 'unknown', lifecycleEvent: null },
    { events: ['PermissionRequest'], state: 'waiting' },
    { events: ['PreToolUse'], toolNames: ['askuserquestion'], state: 'waiting' },
    // Stop 与 SubagentStop 是 Claude Code 的决策前回调（可被其它 hook 否决或追加 context 继续），
    // 不证明所有 hook 已收口或最终主轮/子轮成功完成；显式 opt out 声明 lifecycleEvent: null，
    // 保持 unknown 状态与真实 service notice，绝不伪造主轮成功或 turn-end。
    { events: ['Stop', 'SubagentStop'], state: 'unknown', lifecycleEvent: null },
    // StopFailure 是真失败终态（报错收尾），归入 turn-end，语义状态为 error（真实失败，非 done）。
    { events: ['StopFailure'], state: 'error' },
    // The asked call ended, so the person is no longer awaited; the call's own turn continues,
    // exactly as PostToolUse would report (a terminal decline sends no classic Hook at all).
    { events: [CLAUDE_ASKED_TOOL_END_EVENT], state: 'working' },
    { events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact'], state: 'working' }
  ],
  subagentTracking: {
    startEvents: ['turn.start'],
    stopEvents: ['turn.complete'],
    stateEvents: [CLAUDE_CHILD_ACTIVITY_EVENT],
    // Child IDs survive resume. Only this exact native turn can settle the existing roster entry.
    matches: (_eventName, payload) => typeof payload.agent_id === 'string' && payload.agent_id.length > 0,
    turnIdentity: claudeNativeTurnIdentity,
    readState: (event, payload) => {
      if (!claudeNativeTurnIdentity(payload)) return
      if (event === 'turn.start') return { state: 'working' }
      if (event === CLAUDE_CHILD_ACTIVITY_EVENT) {
        if (typeof payload.tool_use_id !== 'string' || !payload.tool_use_id.trim() ||
            !['working', 'waiting', 'unknown'].includes(String(payload.state)) || !['permission', 'question'].includes(String(payload.reason))) return
        const state = payload.state as 'working' | 'waiting' | 'unknown'
        return { state, ...(state === 'working' ? {} : { waitingFor: payload.reason as 'permission' | 'question' }) }
      }
      if (event !== 'turn.complete' || typeof payload.isAborted !== 'boolean' ||
          !['answer', 'aborted', 'refusal', 'error'].includes(String(payload.reason)) ||
          (payload.reason === 'aborted') !== payload.isAborted) return
      return payload.reason === 'answer' ? { state: 'done', outcome: 'completed' } : payload.reason === 'error'
        ? { state: 'error', outcome: 'failed' } : { state: 'unknown', outcome: payload.reason === 'aborted' ? 'interrupted' : 'refused' }
    },
    idKeys: ['agent_id', 'agentId']
  },
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['transcript_path', 'transcriptPath']
  }
}

const PERMISSION_ESC = '\u001b'
const CLAUDE_PERMISSION_OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe', input: '1' },
  // Persistent grants require the exact native permission update, not a guessed
  // terminal choice or a generic tool-wide rule. Only the two native decisions are offered.
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: PERMISSION_ESC }
]

/**
 * Claude's managed Hooks travel with the launch: the classic command Hooks and the module live in one
 * plugin under AgentMux's state directory, loaded by --plugin-dir. Nothing is written into the
 * workspace, so the plan is the same for every workspace.
 */
export function claudeManagedPlugin(): ReturnType<typeof claudePlugin> {
  const command = runScopedHookCommand('claude')
  return claudePlugin(Object.fromEntries(CLAUDE_HOOK_EVENTS.map((eventName) => [eventName, [{
    // 三个 tool 事件按 matcher 分派（bundle 内嵌文档的 Hook Events 表里，这三行的 Matcher 列都是
    // "Tool name"）。`*` 是「所有工具」；缺了 matcher，Claude 对 tool 事件不会分派到我们这条。
    ...(eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
      ? { matcher: '*' }
      : {}),
    hooks: [{ type: 'command', command, ...(eventName === 'PermissionRequest' ? {} : hookCommandTimeout('claude')) }]
  }]])))
}

export function createClaudeManagedHookPlan(): AgentManagedHookPlan {
  return { providerId: 'claude', mutations: claudeManagedPlugin().mutations }

}

export function createClaudeProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const provider = defineAgentProvider({
    prepareToolExecutionLaunch: prepareClaudeToolExecutionLaunch,
    prepareExecutionHelper: prepareClaudeExecutionHelper,
    planManagedHooks: () => createClaudeManagedHookPlan(),
    prepareOwnedWorkspaceTrust: prepareClaudeOwnedWorkspaceTrust,
    readSessionHistoryPage: readClaudeSessionHistoryPage,
    readSessionHistoryRecord: readClaudeSessionHistoryRecord,
    readConversationChanges: readClaudeConversationChanges,
    discoverNativeSession: discoverClaudeNativeSession,
    prepareNativeInput: prepareClaudeNativeInput,
    listNativeSessions: listClaudeNativeSessions,
    assertNativeResumeSource: assertClaudeNativeResumeSource,
    observeSessionHistory: observeNativeJsonlHistory,
    catalog: catalog({
      composer: {"skillRoots": [".claude/skills", ".agents/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}, {"text": "/cost", "description": "Session usage"}, {"text": "/context", "description": "Context usage"}]},
      id: 'claude', label: 'Claude', executable: 'claude', expectedProcess: 'claude',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        turnOutcomes: { observation: ['failed'] },
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, nativeInterruption: true, replyCorrelation: 'none',
        nativeConversationInput: { managedRuns: true, interactionQueue: true, idleQueue: false },
        providerFork: { current: true },
        usage: CLAUDE_USAGE_CAPABILITY
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    // Claude's composer is a real TUI input line. Send the payload first, verify that the \`❯\` line
    // contains the exact text, then send Enter as a separate CtxMux operation. A single write can
    // visibly populate the line while the TUI is still in a redraw/steer transition, leaving the
    // user with text that was never submitted.
    terminalPromptRender: { frameStart: '\u001b[?2026h', activeComposer: '❯', frameEnd: '\u001b[?2026l' },
    planPromptInput: (prompt) => ({
      kind: 'render-then-submit',
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      submit: '\r'
    }),
    interaction: createNumberedTerminalInteractionProtocol({
      // Claude asks once per question call: PreToolUse carries its tool_use_id. The same call's
      // PermissionRequest is its ask stage, not a second request.
      questionEvents: ['PreToolUse'],
      questionTools: ['askuserquestion'],
      // A declined or answered asked call ends without any classic Hook; the native activity
      // observer reports that exact end (see CLAUDE_ASKED_TOOL_END_EVENT).
      questionCompletionEvents: ['PostToolUse', 'PostToolUseFailure', CLAUDE_ASKED_TOOL_END_EVENT],
      permissionCompletionEvents: ['PostToolUse', 'PostToolUseFailure', CLAUDE_ASKED_TOOL_END_EVENT],
      permissionOptions: CLAUDE_PERMISSION_OPTIONS
    }),
    hook: CLAUDE_HOOKS,
    inspectHookActivation: inspectClaudeHookActivation,
    launchOptions: CLAUDE_LAUNCH_OPTIONS,
    buildForkArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, '--fork-session', ...args, ...(prompt ? [prompt] : [])
    ],
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
  return {
    ...provider,
    normalizeHook(envelope, context) {
      let normalized = provider.normalizeHook(envelope, context)
      if (normalized.mainSubject && normalized.eventName === 'turn.complete' && normalized.currentActivity?.state === 'unknown') {
        normalized = { ...normalized, currentActivityIssue: envelope.payload?.backgroundWork === 'pending'
          ? 'The native turn reported background tasks, which may include ambient observers. Current idle or active is unconfirmed. The original Session, Run, results and input remain available; a later native turn with a confirmed empty task snapshot can confirm idle.'
          : 'The native turn has no confirmed matching background-task snapshot. Current idle is unconfirmed. The original Session, Run, results and input remain available; a later native turn with a confirmed empty task snapshot can confirm idle.' }
      }
      // Only the interaction end belongs to this observation; it is not a tool row or activity.
      if (normalized.eventName === CLAUDE_ASKED_TOOL_END_EVENT) return { ...normalized, timeline: [] }
      // An identified ask is a stage of the call PreToolUse already recorded; its tool row is that one.
      if (normalized.eventName === 'PermissionRequest' && normalized.interaction?.nativeToolCallId) {
        return { ...normalized, timeline: normalized.timeline.filter(mutation => mutation.type === 'update' || mutation.item.kind !== 'tool_call') }
      }
      if (normalized.eventName === 'StopFailure') {
        // Classic StopFailure exposes error text but no native turn identity. Keep its local
        // diagnostic without borrowing the most recent turn or publishing its last answer.
        const payload = envelope.payload ?? {}
        const detail = [payload.error, payload.error_details].filter(value => typeof value === 'string').join(': ')
        return { ...normalized, status: { ...normalized.status,
          detail: detail || 'Native request failed; its native turn identity is unconfirmed.' },
          timeline: normalized.timeline.map(mutation => mutation.type === 'update' ? mutation : {
            ...mutation, item: { ...mutation.item,
              ...(mutation.item.kind === 'assistant_message' ? { contentEligibility: 'unconfirmed' as const } :
                detail ? { content: detail } : {}) }
          }) }
      }
      if (normalized.eventName === 'turn.complete' && normalized.mainSubject &&
        normalized.semanticState === 'error' && normalized.currentActivity) {
        const nativeTurnId = normalized.currentActivity.nativeTurnId
        if (!nativeTurnId) return normalized
        // The native runner identifies its error end, but exposes no original API error fields.
        const failure = { code: 'AGENT_PROVIDER_ERROR', nativeTurnId,
          message: 'The native Claude turn ended in error; the original error code is unavailable.',
          publicMessage: 'Claude could not finish this request.',
          recovery: 'Inspect the original Agent for details. Retry only after choosing to submit again.' }
        return { ...normalized, status: { ...normalized.status, failure, detail: failure.message },
          timeline: normalized.timeline.map(mutation => mutation.type === 'update' ? mutation : {
            ...mutation, item: { ...mutation.item, turnOutcome: { status: 'failed' as const, failure } }
          }) }
      }
      return normalized
    },
    buildLaunch(context) {
      const launch = provider.buildLaunch(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    },
    buildResumeLaunch(context) {
      const launch = provider.buildResumeLaunch(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    },
    ...(provider.buildForkLaunch ? { buildForkLaunch(context: Parameters<NonNullable<AgentProvider['buildForkLaunch']>>[0]) {
      const launch = provider.buildForkLaunch!(context)
      return { ...launch, args: withClaudePlugin(launch.args, claudeManagedPlugin().directory) }
    } } : {})
  }
}
