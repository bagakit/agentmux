import type { ProviderHookServices } from '../hook-services.js'
import { CLAUDE_LAUNCH_OPTIONS } from './launch-options.js'
import { CLAUDE_USAGE_CAPABILITY } from './usage.js'
import {
  CLAUDE_ASKED_TOOL_END_EVENT, CLAUDE_CHILD_ACTIVITY_EVENT, CLAUDE_TURN_END_DECISION, CLAUDE_TURN_END_EVENT,
  CLAUDE_NOTICE_ADMISSION_EVENT, CLAUDE_INFORMATION_EVENT, claudeNativeActivity, claudeNativeObservationFailure, claudeNativeTurnIdentity, claudeNativeInformation
} from './native-activity.js'

type Payload = Readonly<Record<string, unknown>>
type ClaudeHookServices = ProviderHookServices<'claude'> & {
  normalizeNativeSessionId(value: unknown): string | undefined
  buildPromptInputPayload(prompt: string): string
  sanitizeBracketedPasteText(prompt: string): string
}

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

export function claudeProvider({
  hookToolFields, formatHookToolOutput, normalizeNativeSessionId, buildPromptInputPayload, sanitizeBracketedPasteText,
  runScopedHookCommand, hookCommandTimeout
}: ClaudeHookServices) {
  const hook = {
    toolFields(eventName: string, payload: Payload) {
      if (eventName === CLAUDE_ASKED_TOOL_END_EVENT) return hookToolFields(payload.tool_name, undefined, payload.tool_use_id)
      if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(eventName)) return {}
      // Our native plugin attaches the asked call's own ID to classic PermissionRequest.
      return hookToolFields(payload.tool_name, payload.tool_input, payload.tool_use_id)
    },
    toolOutcome(eventName: string, payload: Payload) {
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
    information: claudeNativeInformation,
    nativeTurnIdKeys: ['turnId'],
    nativeSessionTransition: (eventName: string, payload: Payload) => eventName === 'SessionStart' &&
      ['startup', 'resume', 'clear', 'compact', 'fork'].includes(String(payload.source)),
    // `claude --resume <id>` reports SessionStart with source "resume" and the resumed session_id
    // (observed on a real run; a fresh start reports "startup"). Core only accepts it from the exact
    // main subject of the current authenticated recovery Run, so a late or foreign event cannot count.
    continuity(eventName: string, payload: Payload) {
      const nativeSessionId = normalizeNativeSessionId(payload.session_id)
      return eventName === 'SessionStart' && payload.hook_event_name === 'SessionStart' && payload.source === 'resume' && nativeSessionId
        ? { kind: 'context-restored' as const, nativeSessionId } : undefined
    },
    // 事件名随负载到达：Claude 一族的 stdin 负载带 `hook_event_name`（这也是 claude/codex 的配置都不带
    // `--event` 却照样能用的原因——事件名不在配置侧、在投递侧）。
    eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
    subagentSubject: (payload: Payload) =>
      (typeof payload.agent_id === 'string' && payload.agent_id.length > 0) ||
      (typeof payload.agentId === 'string' && payload.agentId.length > 0),
    rules: [
      // Native mods observe the actual runner end; activity is independent of task completion.
      { events: ['turn.start'], state: 'working', lifecycleEvent: 'turn-start',
        matches: (payload: Payload) => claudeNativeTurnIdentity(payload) !== undefined },
      { events: ['turn.complete'], state: 'error', lifecycleEvent: 'turn-end',
        matches: (payload: Payload) => payload.reason === 'error' && claudeNativeActivity('turn.complete', payload) !== undefined },
      { events: ['turn.start', 'turn.complete', 'AgentMuxActivityUnavailable'], state: 'unknown', lifecycleEvent: null },
      // An Inbox notice ask and its native queue report carry no activity: they leave semantic state as it was.
      { events: [CLAUDE_TURN_END_EVENT, CLAUDE_NOTICE_ADMISSION_EVENT, CLAUDE_INFORMATION_EVENT], state: 'unknown', lifecycleEvent: null },
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
      matches: (_eventName: string, payload: Payload) => typeof payload.agent_id === 'string' && payload.agent_id.length > 0,
      turnIdentity: claudeNativeTurnIdentity,
      readState: (event: string, payload: Payload) => {
        if (!claudeNativeTurnIdentity(payload)) return
        if (event === 'turn.start') return { state: 'working' as const }
        if (event === CLAUDE_CHILD_ACTIVITY_EVENT) {
          if (typeof payload.tool_use_id !== 'string' || !payload.tool_use_id.trim() ||
              !['working', 'waiting', 'unknown'].includes(String(payload.state)) || !['permission', 'question'].includes(String(payload.reason))) return
          const state = payload.state as 'working' | 'waiting' | 'unknown'
          return { state, ...(state === 'working' ? {} : { waitingFor: payload.reason as 'permission' | 'question' }) }
        }
        if (event !== 'turn.complete' || typeof payload.isAborted !== 'boolean' ||
            !['answer', 'aborted', 'refusal', 'error'].includes(String(payload.reason)) ||
            (payload.reason === 'aborted') !== payload.isAborted) return
        return payload.reason === 'answer' ? { state: 'done' as const, outcome: 'completed' as const } : payload.reason === 'error'
          ? { state: 'error' as const, outcome: 'failed' as const } : { state: 'unknown' as const, outcome: payload.reason === 'aborted' ? 'interrupted' as const : 'refused' as const }
      },
      idKeys: ['agent_id', 'agentId']
    },
    nativeHandle: {
      sessionIdKeys: ['session_id'],
      transcriptPathKeys: ['transcript_path', 'transcriptPath']
    }
  } as const

  const PERMISSION_ESC = '\u001b'
  const CLAUDE_PERMISSION_OPTIONS = [
    { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe', input: '1' },
    // Persistent grants require the exact native permission update, not a guessed
    // terminal choice or a generic tool-wide rule. Only the two native decisions are offered.
    { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: PERMISSION_ESC }
  ] as const

  function managedHookGroups() {
    const command = runScopedHookCommand('claude')
    return Object.fromEntries(CLAUDE_HOOK_EVENTS.map(eventName => [eventName, [{
      ...(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, ...(eventName === 'PermissionRequest' ? {} : hookCommandTimeout('claude')) }]
    }]]))
  }

  const composer = {
    skillRoots: ['.claude/skills', '.agents/skills'],
    commands: [
      { text: '/help', description: 'Available commands' },
      { text: '/model', description: 'Choose model' },
      { text: '/compact', description: 'Compact context' },
      { text: '/cost', description: 'Session usage' },
      { text: '/context', description: 'Context usage' }
    ]
  }
  const turnOutcomes = { observation: ['failed' as const] }
  return {
    managedHookGroups,
    catalog: {
      composer,
      id: 'claude', label: 'Claude', executable: 'claude', expectedProcess: 'claude',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        turnOutcomes,
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, nativeInterruption: true, replyCorrelation: 'none',
        nativeConversationInput: { managedRuns: true, interactionQueue: true, idleQueue: false },
        providerFork: { current: true },
        usage: CLAUDE_USAGE_CAPABILITY
      }
    },
    buildArgs: (prompt: string, args: readonly string[]) => [...args, ...(prompt ? [prompt] : [])],
    // Claude's composer is a real TUI input line. Send the payload first, verify that the \`❯\` line
    // contains the exact text, then send Enter as a separate CtxMux operation. A single write can
    // visibly populate the line while the TUI is still in a redraw/steer transition, leaving the
    // user with text that was never submitted.
    terminalPromptRender: { frameStart: '\u001b[?2026h', activeComposer: '❯', frameEnd: '\u001b[?2026l' },
    planPromptInput: (prompt: string) => ({
      kind: 'render-then-submit' as const,
      payload: buildPromptInputPayload(prompt),
      renderedText: sanitizeBracketedPasteText(prompt).replace(/\r\n?/gu, '\n'),
      submit: '\r'
    }),
    terminalInteraction: {
      // Claude asks once per question call: PreToolUse carries its tool_use_id. The same call's
      // PermissionRequest is its ask stage, not a second request.
      questionEvents: ['PreToolUse'],
      questionTools: ['askuserquestion'],
      // A declined or answered asked call ends without any classic Hook; the native activity
      // observer reports that exact end (see CLAUDE_ASKED_TOOL_END_EVENT).
      questionCompletionEvents: ['PostToolUse', 'PostToolUseFailure', CLAUDE_ASKED_TOOL_END_EVENT],
      permissionCompletionEvents: ['PostToolUse', 'PostToolUseFailure', CLAUDE_ASKED_TOOL_END_EVENT],
      permissionOptions: CLAUDE_PERMISSION_OPTIONS
    },
    hook,
    launchOptions: CLAUDE_LAUNCH_OPTIONS,
    buildForkArgs: (sessionId: string, _transcriptPath: string | undefined, prompt: string | undefined, args: readonly string[]) => [
      '--resume', sessionId, '--fork-session', ...args, ...(prompt ? [prompt] : [])
    ],
    buildResumeArgs: (sessionId: string, _transcriptPath: string | undefined, prompt: string | undefined, args: readonly string[]) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  } as const
}
