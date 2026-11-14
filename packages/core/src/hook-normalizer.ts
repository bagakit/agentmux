import { Buffer } from 'node:buffer'
import type { AgentProviderHookNormalizationContext } from './agent-provider.js'
import type {
  AgentTimelineItem,
  AgentHookSubject,
  AgentTimelineItemKind,
  AgentTimelineMutation,
  AgentHookLifecycleEvent,
  AgentProviderId,
  AgentNativeSessionHandle,
  AgentHookToolInvocation,
  AgentSemanticState,
  AgentStatus,
  AgentNativeActivityEvent,
  AgentHookObservationFailure,
  AgentHookContinuityObservation,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'
import {
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath
} from './agent-native-locator.js'
import {
  canonicalHookLifecycleEvent,
  resolveHookEventName,
  type AgentHookEventNameSource,
  type AgentHookLifecycleDialect,
  type HookEventNamePayloadKey
} from './agent-hook-event.js'
import { agentDisplayState } from './agent-status-freshness.js'
import type { HookToolOutcome } from './hook-tool-outcome.js'
import { HOOK_PAYLOAD_USAGE_KEY, parseTurnUsage } from './agent-usage-transcript.js'

export type AgentNativeHookStateRule = {
  events: readonly string[]
  state: AgentSemanticState
  toolNames?: readonly string[]
  /** A pure predicate over this Provider's original payload; first matching rule wins. */
  matches?: (payload: Readonly<Record<string, unknown>>) => boolean
  /** Undefined uses only this Provider's declared dialect; null explicitly declares no lifecycle. */
  lifecycleEvent?: AgentHookLifecycleEvent | null
}

export type AgentNativeHookToolFields = {
  toolName?: string
  toolInput?: unknown
  reportedToolCallId?: string
}

/** Provider protocol facts for the one existing per-Run child roster. Pre-veto callbacks are not ends. */
export type AgentNativeSubagentTracking = {
  /** Some native event names carry either a main or child; only declared members touch the roster. */
  matches?: (eventName: string, payload: Readonly<Record<string, unknown>>) => boolean
  /** A resumable child is settled only by the end of its exact ordered native turn. */
  turnIdentity?: (payload: Readonly<Record<string, unknown>>) => {
    nativeTurnId: string; sourceId: string; sequence: number
  } | undefined
  /** Provider-confirmed child state/outcome; absent adapters supply only lifecycle observation. */
  readState?: (eventName: string, payload: Readonly<Record<string, unknown>>) =>
    Pick<import('./agent-subagent-state.js').AgentSubagentSession, 'state' | 'outcome' | 'waitingFor'> | undefined
  /** 子代理开始事件。 */
  startEvents: readonly string[]
  /** 子代理结束事件；不产生主轮结果。 */
  stopEvents: readonly string[]
  /** Update only an already observed, same-turn child; never opens or ends a turn. */
  stateEvents?: readonly string[]
  /** 唯一原生子主体 ID 键；名称与类型不能充当身份。缺失保持未确认。 */
  idKeys?: readonly string[]
}

export type AgentNativeHookSpecification = {
  lifecycle?: AgentHookLifecycleDialect
  /** Select only fields actually reported by this Provider in the original event. */
  toolFields?: (eventName: string, rawPayload: Readonly<Record<string, unknown>>) => AgentNativeHookToolFields
  /** Provider-owned display text, without promoting its surrounding payload into control facts. */
  assistantResponse?: (eventName: string, rawPayload: Readonly<Record<string, unknown>>) => string | undefined
  /** Interpret only this Provider's original payload; shared nesting is not a result protocol. */
  toolOutcome?: (eventName: string, rawPayload: Readonly<Record<string, unknown>>) => HookToolOutcome
  /**
   * The Provider's managed Hooks travel with its launch (a launch-loaded plugin or per-launch flags)
   * instead of a file in the user's workspace. Its Runs then accept only calls marked by that launch.
   */
  launchCarried?: true
  /** Shared native declarations whose executable and routing come from the original Run. */
  retainedRuntime?: true
  /** Transcript sample availability is independent of final turn outcome. */
  usageFinalizationEvents?: readonly string[]
  /** Pure projection from the original native payload, only after current main-subject verification. */
  continuity?: (eventName: string, payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext) => AgentHookContinuityObservation | undefined
  /** Pure diagnostic from the authenticated Run; it cannot promote an unknown native actor. */
  observationFailure?: (eventName: string, payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext) => AgentHookObservationFailure | undefined
  /** Ordered native main-turn activity, independent of task completion and permissions. */
  currentActivity?: (eventName: string, payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext) => AgentNativeActivityEvent | undefined
  /** Exact synchronous native Hook decision outputs; absent hooks remain observers. */
  permissionDecision?: {
    eventName: string
    outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  }
  /**
   * The native turn-end decision that hands one genuinely ending main turn a platform notice:
   * either continuing that turn, or queueing it in the native idle queue as its own next turn.
   * Only the Provider knows its schema; absent, the event stays an observer.
   */
  turnEndDecision?: {
    eventName: string
    /** The native turn and whether this callback is the turn's first stop; unknown abstains. */
    readTurn(payload: Readonly<Record<string, unknown>>): { nativeTurnId: string; firstStop: boolean } | undefined
    /** The exact native output that hands this frozen notice to the model. */
    output(notice: string, notificationId: string): Readonly<Record<string, unknown>>
    /**
     * Present when a written answer only queues the notice natively: the event that reports the
     * native queue's own admission. Absent, a written answer is the delivery itself.
     */
    admission?: {
      eventName: string
      read(payload: Readonly<Record<string, unknown>>): { notificationId: string; admitted: true } |
        { notificationId: string; admitted: false; reason: string } | undefined
    }
  }
  rules: readonly AgentNativeHookStateRule[]
  nativeTurnIdKeys?: readonly string[]
  /** Provider protocol correlation with the immediately preceding durable Hook. */
  resolveInteractionToolCallId?: (
    eventName: string,
    payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext
  ) => string | undefined
  /** Pure Provider projection of actual open tool facts into the original HookReceipt owner. */
  toolInvocation?: (
    eventName: string,
    payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext,
    mainSubject: boolean
  ) => AgentHookToolInvocation | undefined
  /** Provider requires an exact Run process-native witness before promoting its native subject. */
  processNativeIdentity?: boolean
  resolveSubject?: (payload: Readonly<Record<string, unknown>>, context: AgentProviderHookNormalizationContext) => AgentHookSubject
  /** Provider-declared transition triggers a fresh current-main witness; arrival is not identity proof. */
  nativeSessionTransition?: (eventName: string, payload: Readonly<Record<string, unknown>>) => boolean
  /** Pure native Session membership/transition evidence; false preserves only observation. */
  matchesNativeSession?: (
    eventName: string,
    payload: Readonly<Record<string, unknown>>,
    context: AgentProviderHookNormalizationContext
  ) => boolean
  /** Native child subject evidence, independent of start/stop events or a live roster. */
  subagentSubject?: (payload: Readonly<Record<string, unknown>>) => boolean
  subagentTracking?: AgentNativeSubagentTracking
  nativeHandle?: {
    sessionIdKeys: readonly string[]
    transcriptPathKeys?: readonly string[]
    requireTranscriptPath?: boolean
  }
  /**
   * **这个 Provider 的事件名从哪来。** 声明原生 hook、且由 AgentMux 写配置（`explicit-managed`）的
   * Provider **必须**回答，因为 `agent-hook-command` 那个子进程只有几条路能解析出事件名——`--event`
   * 旗标、或负载里的某个键——全落空时 `eventName` 为 falsy，整条 POST 被
   * `if (url && token && eventName)` 静默跳过：那家 Provider 的 Agent「装上了但永远不动」（时间线空、
   * 状态永不变、无法 resume），而所有测试照旧全绿。此前这件事在代码里、文档里、守卫里都没有记录，
   * 于是「新接一家忘了让事件名有来源」不可能被任何测试发现。copilot 正是这么漏的：既无 `--event`、
   * 其 camelCase 负载又不带三拼法里的任何键。
   *
   * 把来源做成**声明**而非注释，是为了让守卫能机器核对「声明的来源在配置里真的成立」：
   * - `flag`：安装计划里每条 hook 命令都带 `--event <eventName>`（antigravity/cursor/copilot 这么做，
   *   因为它们的负载里没有任何事件名键，本机 bundle/runtime 实测）。
   * - `payload`：Provider 的负载自带事件名，`payloadKey` 指明是三拼法里的哪一个。这是**投递侧**的拼法，
   *   与**配置侧**可能不同（grok 配置写 PascalCase、负载报 snake_case），所以必须单独声明、单独佐证——
   *   守卫因此把「装了对的事件名」（配置侧）与「子进程解析得出事件名」（投递侧）分成两条。
   * - `generated-code`：上面两条都**不适用**——这家 Provider 的 hook 面不是「一条命令」，而是一份
   *   AgentMux 生成的代码文件（pi 的 `extensions/agentmux.js`、opencode 的 `plugin/agentmux.js`）。
   *   代码跑在 Provider 自己的进程里，**自己直接 POST**，`agent-hook-command` 那个子进程整个不在链路上。
   *   于是事件名不是「解析出来的」而是生成时就写死在每个回调里，本条注释开头那种静默跳过**结构上不可能**
   *   发生——但它不可能发生这件事必须由守卫钉住，不能只写在注释里（见本仓「声明了却静默不做的能力」）。
   *
   * 缺省是**刻意允许**的一种情形，不是「忘了填」：
   * - `hookStrategy.kind === 'none'`（traex）：根本没有 hook，谈不上事件名来源。
   *
   * `installation === 'unmanaged'` 的那些同样不强制——AgentMux 不写它们的配置，保证不了 `--event`。
   * 守卫只对 `explicit-managed` 强制此声明：那正是 AgentMux 亲手写配置、能静默漏掉事件名的那批。
   */
  eventNameSource?: AgentHookEventNameSource
}

export type { AgentHookEventNameSource }

/** Native child state is a pure proposal. Core adopts it with the original receipt CAS. */
function subagentId(
  tracking: AgentNativeSubagentTracking,
  payload: Record<string, unknown>
): string | undefined {
  return stringField(payload, ...(tracking.idKeys ?? []))
}

/** The same declared subject boundary used for native locator and interaction promotion. */
export function nativeHookHasSubagentSubject(
  specification: AgentNativeHookSpecification,
  eventName: string,
  payload: Record<string, unknown>
): boolean {
  if (specification.subagentSubject?.(payload)) return true
  const tracking = specification.subagentTracking
  return Boolean(tracking && (tracking.matches?.(eventName, payload) ?? true) && (
    subagentId(tracking, payload) ||
    tracking.startEvents.includes(eventName) || tracking.stopEvents.includes(eventName)
  ))
}

/**
 * Pure child transition for the original Session metadata transaction.
 * A child event never supplies a main turn outcome or main input readiness.
 */
export function nextSubagentSessions(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope,
  context: AgentProviderHookNormalizationContext,
  subject: AgentHookSubject,
  observedAt: number
): import('./agent-subagent-state.js').AgentNativeSubagents | undefined {
  const tracking = specification.subagentTracking
  if (!tracking || subject.kind !== 'child' && subject.kind !== 'main') return
  const payload = envelope.payload ?? {}, eventName = resolveHookEventName(envelope.eventName, payload, specification.eventNameSource) ?? 'unknown'
  if (!(tracking.matches?.(eventName, payload) ?? true)) return
  const starts = tracking.startEvents.includes(eventName), ends = tracking.stopEvents.includes(eventName)
  const changes = tracking.stateEvents?.includes(eventName) === true
  if (!starts && !ends && !changes) return
  const native = context.nativeHandle
  if (native?.kind !== 'provider' || native.providerId !== envelope.providerId) return
  const retained = context.nativeSubagents
  const previous = retained?.run.runId === envelope.runId && retained.providerId === envelope.providerId &&
    retained.nativeSessionId === native.sessionId ? retained : undefined
  const next: import('./agent-subagent-state.js').AgentNativeSubagents = previous ? { ...structuredClone(previous) } : { run: { runId: envelope.runId }, providerId: envelope.providerId,
    nativeSessionId: native.sessionId, unconfirmed: false, sessions: [] }
  const id = subagentId(tracking, payload), identity = tracking.turnIdentity?.(payload)
  const expectedSource = next.sourceId ?? context.nativeActivitySourceId
  if (identity && expectedSource !== undefined && identity.sourceId !== expectedSource) {
    next.sourceId = expectedSource
    next.unconfirmed = true
    next.sessions = next.sessions.map(child => child.phase === 'running' ? { ...child, state: 'unknown' } : child)
    return next
  }
  if (!id || tracking.turnIdentity && !identity) {
    next.unconfirmed = true
    return next
  }
  const index = next.sessions.findIndex(item => item.nativeAgentId === id), before = next.sessions[index]
  if (before?.hookReceiptId === envelope.receiptId) return
  if (identity && before?.sequence !== undefined && identity.sequence <= before.sequence) return
  if ((ends || changes) && (!before || before.phase === 'ended' || tracking.turnIdentity && (!identity ||
      before.sourceId !== identity.sourceId || before.nativeTurnId !== identity.nativeTurnId))) return
  if (identity) next.sourceId = identity.sourceId
  const state = tracking.readState?.(eventName, payload)
  if (tracking.readState && !state) return
  const item: import('./agent-subagent-state.js').AgentSubagentSession = { nativeAgentId: id, hookReceiptId: envelope.receiptId, observedAt,
    state: starts ? 'working' : 'unknown', ...state, phase: ends ? 'ended' : 'running', ...identity }
  if (index >= 0) next.sessions[index] = item
  else next.sessions.push(item)
  return next
}

function stringField(payload: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function sessionIdField(
  payload: Record<string, unknown>,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = normalizeNativeSessionId(payload[name])
    if (value) return value
  }
  return undefined
}

function transcriptPathField(
  payload: Record<string, unknown>,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = normalizeNativeTranscriptPath(payload[name])
    if (value) return value
  }
  return undefined
}

function eventRule(
  specification: AgentNativeHookSpecification,
  eventName: string,
  payload: Record<string, unknown>,
  tool: AgentNativeHookToolFields
): AgentNativeHookStateRule | undefined {
  const toolName = tool.toolName?.toLowerCase()
  for (const rule of specification.rules) {
    if (!rule.events.includes(eventName)) continue
    if (rule.toolNames && !rule.toolNames.includes(toolName ?? '')) continue
    if (rule.matches && !rule.matches(payload)) continue
    return rule
  }
  return undefined
}

/**
 * 这个工具本身是否是「等待用户」类工具——判定只看工具名，与 Pre/Post 无关。
 *
 * askuserquestion / request_user_input / clarify 这类工具在 `PreToolUse` 被规则判成 waiting/blocked，
 * 落的是 append-only 的 permission 行（id 由 receiptId 派生），它等的是用户、不是一次有 Post 收尾的执行。
 * 可这类工具的 `PostToolUse` 语义是 working——若只按**当前事件**的 state 决定 kind，Post 会被判成
 * tool_call，去 upsert 一条关联工具行，而 Pre 落的是 permission 行、从没按 tool 关联过：
 * 这条 upsert 命不中目标，就补落一条 kind=tool_call 的重影行，把一次等待硬生生显示成两条。所以 kind
 * 判定要从 rules 这个 SSOT 认出「这是个等待工具」，让 Pre 与 Post 得到同一个 kind，两端都留在 append-only。
 */
function toolAwaitsUser(specification: AgentNativeHookSpecification, toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return specification.rules.some(
    (rule) =>
      (rule.state === 'waiting' || rule.state === 'blocked') &&
      (rule.toolNames?.includes(lower) ?? false)
  )
}

function nativeHandle(
  providerId: AgentProviderId,
  specification: AgentNativeHookSpecification,
  payload: Record<string, unknown>
): AgentNativeSessionHandle | undefined {
  const definition = specification.nativeHandle
  if (!definition) return undefined
  const sessionId = sessionIdField(payload, definition.sessionIdKeys)
  if (!sessionId) return undefined
  const transcriptPath = definition.transcriptPathKeys
    ? transcriptPathField(payload, definition.transcriptPathKeys)
    : undefined
  if (definition.requireTranscriptPath && !transcriptPath) return undefined
  return {
    kind: 'provider',
    providerId: providerId,
    sessionId,
    ...(transcriptPath ? { transcriptPath } : {})
  }
}

function timelineItem(
  envelope: NativeHookEnvelope,
  index: number,
  kind: AgentTimelineItemKind,
  title: string,
  eventName: string,
  observedAt: number,
  // `id` 可被覆盖：已核主体与调用身份齐备时，Pre 落的 item 用关联身份而不是 receiptId
  // 派生的默认 id，好让 Post 的 upsert 能命中同一条。`...fields` 排在 `id:` 之后，故覆盖生效。
  fields: Partial<Omit<AgentTimelineItem, 'agentSessionId' | 'kind' | 'source' | 'createdAt' | 'updatedAt' | 'title'>> = {},
  // Pre 用 append（首落）；Post 用 upsert（目标在就替换、丢投/被逐出就补落），绝不因缺目标抛错。
  type: 'append' | 'upsert' = 'append'
): AgentTimelineMutation {
  return {
    type,
    agentSessionId: envelope.agentSessionId,
    item: {
      id: `${envelope.runId}:${envelope.receiptId}:${index}`,
      agentSessionId: envelope.agentSessionId,
      kind,
      // 默认成立，但**可被观察到的失败覆盖**——此前这里写死在 spread 之后，于是无论采集到什么
      // 结果，每一步都盖 complete。失败的命令因此和成功的长得一模一样。
      status: 'complete',
      source: 'native-hook',
      createdAt: observedAt,
      updatedAt: observedAt,
      title,
      eventName,
      ...fields
    }
  }
}

/** Pure Provider selection; absence never enables an alias or a nested-payload fallback. */
export function projectNativeHookToolFields(
  specification: AgentNativeHookSpecification,
  eventName: string,
  rawPayload: Readonly<Record<string, unknown>>
): AgentNativeHookToolFields {
  return specification.toolFields?.(eventName, rawPayload) ?? {}
}

/** Pure projection only: safe to repeat at the durable CAS without replaying roster or lifecycle effects. */
export function projectNativeHookToolInvocation(
  specification: AgentNativeHookSpecification,
  eventName: string,
  payload: Record<string, unknown>,
  context: AgentProviderHookNormalizationContext,
  mainSubject: boolean
): AgentHookToolInvocation | undefined {
  return specification.toolInvocation?.(eventName, payload, context, mainSubject)
}

type NativeToolSubject = {
  kind: 'main' | 'child'
  nativeSessionId: string
}

function resolveNativeToolSubject(
  providerId: AgentProviderId,
  specification: AgentNativeHookSpecification,
  payload: Record<string, unknown>,
  context: AgentProviderHookNormalizationContext,
  nativeSessionMatches: boolean,
  childSubject: boolean
): NativeToolSubject | undefined {
  if (!nativeSessionMatches) return undefined

  const keys = specification.nativeHandle?.sessionIdKeys ?? []
  const incomingId = sessionIdField(payload, keys)
  const current = context.nativeHandle
  const currentId = current?.kind === 'provider' && current.providerId === providerId
    ? normalizeNativeSessionId(current.sessionId)
    : undefined

  // A roster label is not an independent native source; a child never borrows its parent.
  if (childSubject) {
    return incomingId && currentId && incomingId !== currentId
      ? { kind: 'child', nativeSessionId: incomingId }
      : undefined
  }
  if (incomingId) return { kind: 'main', nativeSessionId: incomingId }

  // Invalid reports, including null, are not absence. Only explicit membership can fill absence.
  const reported = keys.some(key => payload[key] !== undefined)
  return !reported && specification.matchesNativeSession && currentId
    ? { kind: 'main', nativeSessionId: currentId }
    : undefined
}

function nativeHookToolItemId(
  runId: string,
  providerId: AgentProviderId,
  subjectKind: 'main' | 'child',
  nativeSessionId: string,
  toolCallId: string
): string {
  const token = Buffer.from(
    JSON.stringify([runId, providerId, subjectKind, nativeSessionId, toolCallId])
  ).toString('base64url')
  return `tool_${token}`
}

function buildTimeline(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope,
  eventName: string,
  lifecycleEvent: AgentHookLifecycleEvent | undefined,
  payload: Record<string, unknown>,
  tool: AgentNativeHookToolFields,
  observedAt: number,
  subject: NativeToolSubject | undefined,
  childSpeaker: boolean
): AgentTimelineMutation[] {
  const assistant = specification.assistantResponse ? specification.assistantResponse(eventName, envelope.payload ?? {}) : stringField(
    payload,
    'last_assistant_message',
    'lastAssistantMessage',
    'assistant_response',
    'text'
  )
  const toolName = tool.toolName
  const rawToolInput = tool.toolInput
  const toolInput =
    typeof rawToolInput === 'string'
      ? rawToolInput
      : rawToolInput === undefined
        ? undefined
        : JSON.stringify(rawToolInput)
  const timeline: AgentTimelineMutation[] = []
  const append = (
    kind: AgentTimelineItemKind,
    title: string,
    fields?: Partial<Omit<AgentTimelineItem, 'id' | 'agentSessionId' | 'kind' | 'source' | 'createdAt' | 'updatedAt' | 'title'>>
  ): void => {
    timeline.push(timelineItem(envelope, timeline.length, kind, title, eventName, observedAt, fields))
  }
  if (toolName) {
    // kind 由**工具身份**决定，不由当前事件的 state 决定：等待用户的工具（askuserquestion 等）在 Pre 判
    // waiting→permission，其 Post 的 state 却是 working。若按 state 定 kind，Post 会变成 tool_call 走
    // 关联 update 去更新 Pre 从未按 tool 落过的那条 item，必抛 UNKNOWN_AGENT_TIMELINE_ITEM。让 Pre/Post
    // 对同一工具得到同一个 kind，等待类一律留在 append-only 的 permission 通路。
    const kind: AgentTimelineItemKind = toolAwaitsUser(specification, toolName) ? 'permission' : 'tool_call'
    // 「这是一次工具调用的事后吗」由 canonical 生命周期事件回答，不再由事件名的形状猜。
    // 此前这里是 `eventName.startsWith('Post')`：它只对 PascalCase 的 Provider 成立，把 Antigravity 的
    // `PostInvocation` 误当成工具结果，同时对 Hermes 的 `post_tool_call`、Pi 的 `tool_execution_end`
    // 完全失明——那两家虽都声明了 `timeline: 'complete-events'`，失败的命令却和成功的长得一模一样。
    // 认不出生命周期（`undefined`）时按事前处理：没有 canonical 依据就不宣称「已经有结果了」。
    const isToolResult = lifecycleEvent === 'tool-use-end'
    const toolCallId = tool.reportedToolCallId
    // 结果只有事后才知道，所以只在事后事件上采集——事前那一行谈不上成败，给它盖任何结论都是编造。
    const outcome = isToolResult ? specification.toolOutcome?.(eventName, envelope.payload ?? {}) : undefined
    if (subject && toolCallId && kind === 'tool_call') {
      // Provider 给了关联 id：把一次调用的入参与结果收敛到**同一条 item**。
      // id 包含 [run, provider, subject-kind, nativeID, callID] 的 JSON tuple base64url，
      // 以固定 ASCII 前缀 tool_ 开头，防止不同主体/会话的相同调用 ID 发生碰撞。
      const conversation = { invocations: ([...(toolInput === undefined ? [] : ['toolInput' as const]), ...(outcome?.output === undefined ? [] : ['toolOutput' as const])]).map(field => ({
        selector: { kind: 'captured-field' as const, field }, invocation: { source: { providerId: envelope.providerId, nativeSessionId: subject.nativeSessionId },
          subject: subject.kind === 'main' ? 'main' as const : { kind: 'child' as const, nativeActorId: subject.nativeSessionId }, scope: { kind: 'session' as const }, callId: toolCallId }
      })) }
      const itemId = nativeHookToolItemId(
        envelope.runId,
        envelope.providerId,
        subject.kind,
        subject.nativeSessionId,
        toolCallId
      )
      if (isToolResult) {
        // 事后：翻成终态并挂上结果。走 `upsert` 而不是 `update`——正常情况命中 Pre 落的那条替换掉，
        // 但 Pre 可能压根没落库：它的两次 fetch 都失败、或在 Pre/Post 之间被 200 条上限逐出（子代理
        // 场景尤甚）。`update` 命中不到目标会抛 UNKNOWN_AGENT_TIMELINE_ITEM，冒泡出 client 的 timeline
        // 循环、跳过 publishHook、把整条 hook 事件打成 503，这一步的结果和完成态永久丢失。upsert 目标
        // 缺失就补落一条自洽的终态行——携带完整 item（kind/source/title 俱全），不靠残缺字段合成。
        timeline.push(timelineItem(envelope, timeline.length, kind, toolName, eventName, observedAt, {
          id: itemId,
          conversation,
          toolName,
          // 失败是**观察到的事实**，不是默认值：采集判定失败才翻 failed，否则收敛为 complete
          // （不再是 streaming——调用已结束）。
          status: outcome?.failed ? 'failed' : 'complete',
          ...(toolInput === undefined ? {} : { toolInput }),
          ...(outcome?.output === undefined ? {} : { toolOutput: outcome.output })
        }, 'upsert'))
      } else {
        // 事前：先落在途态。`streaming` 徽标此前只有 ACP 会点亮，而所有 Provider 的 ACP 都是
        // none——hook 驱动的 Agent 由此第一次能显示「这一步正在跑」。
        timeline.push(timelineItem(envelope, timeline.length, kind, toolName, eventName, observedAt, {
          id: itemId,
          conversation,
          toolName,
          status: 'streaming',
          ...(toolInput === undefined ? {} : { toolInput })
        }))
      }
    } else {
      // 没有关联 id（或是 permission 行）：如实退回 append-only，绝不伪造关联。此路径仍带上
      // 事后结果，靠渲染层的折叠让带结果的那行胜出（f-23p8fsbs8/T-001 在无关联前提下的最简解）。
      append(kind, toolName, {
        toolName,
        ...(toolInput === undefined ? {} : { toolInput }),
        ...(outcome?.output === undefined ? {} : { toolOutput: outcome.output }),
        ...(outcome?.failed ? { status: 'failed' as const } : {})
      })
    }
  }
  // A reply snapshot speaks for the main Agent. A child's last message (SubagentStop)
  // is that child's report, not a reply in the parent conversation, whether or not its
  // roster membership is confirmed yet. Without a child identity the snapshot stays:
  // an observation gap is not a child.
  if (assistant && !childSpeaker) {
    append('assistant_message', 'Assistant response', { content: assistant })
  }
  if (timeline.length === 0) {
    append('lifecycle', eventName)
  }
  return timeline
}

export function normalizeNativeHook(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope,
  context: AgentProviderHookNormalizationContext
): NormalizedHookEvent {
  const rawPayload = envelope.payload ?? {}
  const payload = rawPayload
  // 事件名优先读取信封显式名，其次按该 Provider 声明的精确来源（仅当 payload 声明时读指定键，
  // 缺席/空白/非字符串时不读其他合法键；flag/generated-code 不借 payload 补名）。读不出时如实记为 'unknown'。
  // Every protocol reader receives the original payload; only its Provider interprets nesting.
  const eventName = resolveHookEventName(envelope.eventName, rawPayload, specification.eventNameSource ?? null) ?? 'unknown'
  if (context.protectedNativeTarget === true && context.nativeTargetMismatch === true) {
    const observedAt = Date.now()
    return { agentSessionId: envelope.agentSessionId, providerId: envelope.providerId, run: { runId: envelope.runId }, eventName,
      mainSubject: false, subject: { kind: 'unknown', basis: 'process-native-record', reason: 'resume-target-mismatch' },
      lifecycleEvent: null, semanticState: 'unknown', status: { state: agentDisplayState('unknown'), source: 'native-hook', observedAt, detail: eventName }, timeline: [] }
  }
  const tool = projectNativeHookToolFields(specification, eventName, rawPayload)
  const rule = eventRule(specification, eventName, payload, tool)
  // 归一化到 Core canonical 生命周期事件。认不出就是 `undefined`——语义状态照旧只由 Provider 的
  // `rules` 给出，绝不因为归一化失败而伪造 working/done。
  const nativeLifecycleEvent = canonicalHookLifecycleEvent(eventName, rule?.lifecycleEvent, specification.lifecycle)
  const declaredSubject = specification.resolveSubject?.(payload, context)
  const childSubject = declaredSubject ? declaredSubject.kind === 'child' : nativeHookHasSubagentSubject(specification, eventName, payload)
  // The payload's own child identity says who spoke, even before roster membership confirms the child.
  const childSpeaker = childSubject || nativeHookHasSubagentSubject(specification, eventName, payload)
  const incomingId = sessionIdField(payload, specification.nativeHandle?.sessionIdKeys ?? [])
  const incomingPath = transcriptPathField(payload, specification.nativeHandle?.transcriptPathKeys ?? [])
  const currentHandle = context.nativeHandle
  const knownLocatorChanged = currentHandle !== undefined && (
    currentHandle.kind !== 'provider' || currentHandle.providerId !== envelope.providerId ||
    (incomingId !== undefined && incomingId !== currentHandle.sessionId) ||
    (incomingPath !== undefined && currentHandle.transcriptPath !== undefined && incomingPath !== currentHandle.transcriptPath)
  )
  // Authentication binds the Core Session/Run. A different native identity still needs an
  // explicit Provider membership/transition rule; absence of a witness never grants one.
  const protectedTargetMismatch = context.protectedNativeTarget === true && knownLocatorChanged && !childSubject
  const missingMemberSubject = context.nativeTargetMembershipOnly === true && !declaredSubject && !incomingId
  const nativeSessionMatches = !protectedTargetMismatch && !missingMemberSubject && (declaredSubject
    ? declaredSubject.kind === 'main' || declaredSubject.kind === 'child'
    : specification.matchesNativeSession?.(eventName, rawPayload, context) ?? !knownLocatorChanged)
  const mainSubject = nativeSessionMatches && !childSubject
  const subject: AgentHookSubject = missingMemberSubject ? {
    kind: 'unknown', basis: 'process-native-record', reason: 'native-subject-unconfirmed'
  } : protectedTargetMismatch ? {
    kind: 'unknown', basis: 'provider-protocol', reason: 'resume-target-mismatch',
    ...(incomingId ? { nativeSessionId: incomingId } : {})
  } : declaredSubject ?? {
    kind: !nativeSessionMatches ? 'foreign' : childSubject ? 'child' : 'main',
    basis: 'provider-protocol', reason: !nativeSessionMatches ? 'native-session-mismatch' : childSubject ? 'declared-child-subject' :
      specification.matchesNativeSession ? 'provider-native-membership' : !incomingId ? 'run-bound-protocol' :
        currentHandle ? 'native-session-match' : 'native-session-first-observation',
    ...(incomingId ? { nativeSessionId: incomingId } : {})
  }
  const childActivity = childSubject && nativeSessionMatches &&
    (specification.resolveSubject !== undefined || specification.subagentTracking?.turnIdentity?.(payload) !== undefined) && rule?.state === 'working' &&
    !specification.subagentTracking?.stopEvents.includes(eventName)
  // Main contributions share the same subject boundary as locator and interaction promotion.
  // Native lifecycle is retained separately for child tool results and trace; it cannot open or
  // end the main turn. Child observations never synthesize a parent result.
  const semanticState = mainSubject ? rule?.state ?? 'unknown' : 'unknown'
  const lifecycleEvent = mainSubject && rule?.lifecycleEvent !== null ? nativeLifecycleEvent : null
  const observedAt = Date.now()
  const nativeTurnId = mainSubject
    ? specification.nativeTurnIdKeys?.map(key => payload[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined
  const status: AgentStatus = {
    // 语义态 → 显示态经 agentDisplayState 一处决定（见 agent-status-freshness.ts 那段注释：
    // tsc 只守住"你没漏掉 unknown"，守不住"你映射到了哪"）。此前这里是三份手抄之一。
    state: agentDisplayState(semanticState),
    source: 'native-hook',
    observedAt,
    ...(nativeTurnId ? { nativeTurnId } : {}),
    // 诊断带的是**原始**事件名：一条 Core 没认出来的事件，唯一有用的线索就是 Provider 到底叫它什么。
    detail: eventName
  }
  const handle = mainSubject ? nativeHandle(envelope.providerId, specification, payload) : undefined
  // usage 由 hook 命令进程读 transcript 后并进 payload；normalizer 只把它校验回结构化用量，绝不自己读文件。
  // 缺席（Provider 不报 usage、非收尾事件、读失败）时它就是 undefined，一路缺席到 UI。
  const turnUsage = mainSubject ? parseTurnUsage(payload[HOOK_PAYLOAD_USAGE_KEY]) ?? undefined : undefined
  const toolSubject = declaredSubject?.kind === 'child' && declaredSubject.nativeSessionId
    ? { kind: 'child' as const, nativeSessionId: declaredSubject.nativeSessionId } : resolveNativeToolSubject(
    envelope.providerId,
    specification,
    payload,
    context,
    nativeSessionMatches,
    childSubject
  )
  const currentActivity = mainSubject ? specification.currentActivity?.(eventName, payload, context) : undefined
  const observationFailure = specification.observationFailure?.(eventName, payload, context)
  let continuity: AgentHookContinuityObservation | undefined, continuityObservationFailure: AgentHookObservationFailure | undefined
  try {
    const fact = mainSubject ? specification.continuity?.(eventName, rawPayload, context) : undefined
    if (fact) {
      const kind = fact.kind, nativeSessionId = fact.nativeSessionId
      if (typeof nativeSessionId === 'string' && nativeSessionId.trim()) {
        if (kind === 'context-restored') continuity = { kind, nativeSessionId }
        else if (kind === 'explicit-user-cancelled') {
          const scope = fact.scope, nativeOperationId = fact.nativeOperationId
          if (scope === 'recovery-intent' && typeof nativeOperationId === 'string' && nativeOperationId.trim()) {
            continuity = { kind, scope, nativeSessionId, nativeOperationId }
          }
        }
      }
    }
  } catch (error) {
    // This optional observation cannot consume the original activity/receipt on failure.
    continuityObservationFailure = { code: 'AGENT_CONTINUITY_HOOK_UNCONFIRMED', message: `Native recovery observation failed. ${error instanceof Error ? error.message : String(error)}` }
  }
  const subagentSessions = nextSubagentSessions(specification, { ...envelope, eventName }, context, subject, observedAt)
  return {
    agentSessionId: envelope.agentSessionId,
    run: {
      runId: envelope.runId
    },
    providerId: envelope.providerId,
    eventName,
    mainSubject,
    ...(currentActivity ? { currentActivity } : {}),
    ...(observationFailure ? { observationFailure } : {}),
    ...(continuity ? { continuity } : {}),
    ...(continuityObservationFailure ? { continuityObservationFailure } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    subject,
    ...(childActivity ? { childActivity: true } : {}),
    ...(lifecycleEvent !== undefined ? { lifecycleEvent } : {}),
    ...(() => {
      const nativeToolCallId = tool.reportedToolCallId
      const toolName = tool.toolName
      const input = tool.toolInput
      const toolInput = typeof input === 'string' ? input : input === undefined ? undefined : JSON.stringify(input)
      if (specification.toolInvocation) {
        const invocation = projectNativeHookToolInvocation(specification, eventName, payload, context, mainSubject)
        return invocation ? { toolInvocation: invocation } : {}
      }
      return mainSubject && toolSubject?.kind === 'main' && nativeToolCallId && toolName && toolInput !== undefined
        ? { toolInvocation: { nativeSessionId: toolSubject.nativeSessionId, nativeToolCallId, toolName, toolInput } } : {}
    })(),
    semanticState,
    ...(subagentSessions ? { subagentSessions } : {}),
    status,
    timeline: buildTimeline(specification, envelope, eventName, nativeLifecycleEvent, payload, tool, observedAt, toolSubject, childSpeaker),
    ...(handle ? { nativeHandle: handle } : {}),
    ...(turnUsage ? { turnUsage } : {})
  }
}
