import type {
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineMutation,
  AgentHookLifecycleEvent,
  AgentProviderId,
  AgentNativeSessionHandle,
  AgentSemanticState,
  AgentStatus,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'
import {
  normalizeNativeSessionId,
  normalizeNativeTranscriptPath
} from './agent-native-locator.js'
import { canonicalHookLifecycleEvent, resolveHookEventName } from './agent-hook-event.js'
import { hookToolOutcome } from './hook-tool-outcome.js'
import { HOOK_PAYLOAD_USAGE_KEY, parseTurnUsage } from './agent-usage-transcript.js'

export type AgentNativeHookStateRule = {
  events: readonly string[]
  state: AgentSemanticState
  toolNames?: readonly string[]
}

/**
 * 子代理在途记账的 SSOT 声明——每个 Provider 声明自己的事件名，normalizer 据此按会话记「有几个
 * 子代理还活着」。只有归零时主 Agent 的收尾事件才算真正 done。
 *
 * 为什么需要：主 Agent 报收尾（Claude/Codex 的 `Stop`）时，子代理可能还在干活。此前 `Stop` 被照单
 * 全收判成 `done`，于是界面提前翻成完成、误报完成通知，而工作还在继续。这里把主收尾压住，直到子代理
 * 全部结束。
 */
export type AgentNativeSubagentTracking = {
  /** 子代理开始事件（roster 加一）。 */
  startEvents: readonly string[]
  /** 子代理结束事件（roster 减一）。归零且主 Agent 已请求收尾时，这一步收敛为 `done`。 */
  stopEvents: readonly string[]
  /** 主 Agent 的收尾事件——roster 非空时压成 `working`，为空时才放行 rules 给出的 `done`。 */
  mainStopEvents: readonly string[]
  /** 关联同一个子代理 start/stop 的 id 键。Claude/Codex 都给 `agent_id`。取第一个能读出的。 */
  idKeys?: readonly string[]
}

export type AgentNativeHookSpecification = {
  rules: readonly AgentNativeHookStateRule[]
  subagentTracking?: AgentNativeSubagentTracking
  nativeHandle?: {
    sessionIdKeys: readonly string[]
    transcriptPathKeys?: readonly string[]
    requireTranscriptPath?: boolean
  }
}

/**
 * 一个 run 一份子代理花名册。
 *
 * `live` 按 `agent_id` 去重——hook 会重投（agent-hook-command.ts 的 fetch 重试用同一 receiptId），
 * 用 Set 而不是裸计数器，重复的 start/stop 天然幂等。`mainStopPending` 记「主 Agent 已请求收尾但被子
 * 代理压住」——好让最后一个子代理结束时能收敛到 `done`，而不是永远卡在 working。
 *
 * 只按 id 记账，不为「不带 id 的 Provider」留降级计数：当前内建 Provider（claude/codex）的子代理事件
 * 都带 `agent_id`，真出现无 id 的 Provider 再按其真实形状设计，别预支一个够不到测试、还会和 id 记账混
 * 算的抽象。
 */
type SubagentRoster = {
  live: Set<string>
  mainStopPending: boolean
}

// 进程级、按 `runId` 归档。normalizer 本身是纯函数逐事件调用，子代理在途是**跨事件**的事实（一个孤立
// 的 Stop 信封看不出还有没有子代理活着），所以状态必须落在这里。runId 由 ctxmux 全局唯一签发、`bindRun`
// 拒绝任何 runId 变更，故它单独就够区分并发的 run——这与本文件 T-002 给时间轴 item 定 id 的口径一致
// （`${runId}:…`，不掺 session/provider）。仅 subagentTracking 的 Provider 会写入；归零即删除条目。
const subagentRosters = new Map<string, SubagentRoster>()

function subagentRosterKey(envelope: NativeHookEnvelope): string {
  return envelope.runId
}

/**
 * run 进程终结（exited/interrupted）时清掉它的子代理花名册。
 *
 * 为什么必须有这条路径：子代理被信号/OOM 杀死、或它的 SubagentStop 两次 fetch 都失败时，SubagentStop
 * 永不投递——花名册里那条 id 永不删除，Map 条目随进程泄漏，主 Stop 被压住的 pending 也再无事件兑现。
 * 进程退出是「这个 run 再不会有 hook 事件」的权威终点，在此归零给「子代理事件丢失」一个终结路径。
 * 返回是否确实清掉了一条，供调用方判定是否需要把语义状态收敛。
 */
export function releaseSubagentRoster(runId: string): boolean {
  return subagentRosters.delete(runId)
}

function subagentRosterAlive(roster: SubagentRoster): boolean {
  return roster.live.size > 0
}

/**
 * 把一条 hook 事件并入子代理花名册，返回**经过在途压制后**的语义状态。
 *
 * 非子代理、非主收尾事件原样返回 `baseState`。三类被接管的事件：
 * - 子代理开始：记一个在途，Agent 仍在 `working`。
 * - 子代理结束：去掉一个在途；若归零且主 Agent 早已请求收尾，则这一步收敛为 `done`（否则 `working`，
 *   主 turn 还没结束）。
 * - 主 Agent 收尾：roster 非空则压成 `working` 并记下 pending；为空才放行 rules 的 `done`。
 */
function applySubagentTracking(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope,
  eventName: string,
  payload: Record<string, unknown>,
  baseState: AgentSemanticState
): AgentSemanticState {
  const tracking = specification.subagentTracking
  if (!tracking) return baseState
  const key = subagentRosterKey(envelope)
  const id = stringField(payload, ...(tracking.idKeys ?? ['agent_id', 'agentId', 'subagent_id']))
  if (tracking.startEvents.includes(eventName)) {
    // 只按 id 记账。内建 Provider 的子代理事件都带 id；无 id 时不虚记一个够不到 stop 的幽灵条目，
    // Agent 照旧显示 working（子代理确实在跑），但不会把主 Stop 永远压住。
    if (id) {
      const roster = subagentRosters.get(key) ?? { live: new Set<string>(), mainStopPending: false }
      roster.live.add(id)
      subagentRosters.set(key, roster)
    }
    return 'working'
  }
  if (tracking.stopEvents.includes(eventName)) {
    const roster = subagentRosters.get(key)
    // 花名册不存在：可能这个 run 从没记过子代理，也可能是最后一个 SubagentStop 已收敛并删掉了 roster、
    // 而这一条是它的网络重投（服务端已处理，客户端 2s 超时又发了同一条）。硬编码 'working' 会把已经 done
    // 的主 Agent 翻回运行中——归零后迟到的 stop 反倒成了假信号。退回 baseState（SubagentStop 无匹配 rule，
    // baseState 即 'unknown'，落点中性、不落库不改写既有状态），让这条迟到 stop 成为无害幂等。
    if (!roster) return baseState
    if (id) roster.live.delete(id)
    if (subagentRosterAlive(roster)) return 'working'
    const pending = roster.mainStopPending
    subagentRosters.delete(key)
    // 最后一个子代理落地：主 Agent 之前被压住的收尾在此刻兑现为 done——否则会永远卡在 working。
    return pending ? 'done' : 'working'
  }
  if (tracking.mainStopEvents.includes(eventName)) {
    const roster = subagentRosters.get(key)
    if (roster && subagentRosterAlive(roster)) {
      // 主 Agent 说完成了，但子代理还在跑——压住，别让界面提前翻成完成、别误报完成通知。
      roster.mainStopPending = true
      return 'working'
    }
    // 没有在途子代理：清掉可能残留的空条目，放行 rules 给出的收尾状态。
    subagentRosters.delete(key)
    return baseState
  }
  return baseState
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

function eventState(
  specification: AgentNativeHookSpecification,
  eventName: string,
  payload: Record<string, unknown>
): AgentSemanticState {
  const toolName = stringField(payload, 'tool_name', 'toolName', 'name')?.toLowerCase()
  for (const rule of specification.rules) {
    if (!rule.events.includes(eventName)) continue
    if (rule.toolNames && !rule.toolNames.includes(toolName ?? '')) continue
    return rule.state
  }
  return 'unknown'
}

/**
 * 这个工具本身是否是「等待用户」类工具——判定只看工具名，与 Pre/Post 无关。
 *
 * askuserquestion / request_user_input / clarify 这类工具在 `PreToolUse` 被规则判成 waiting/blocked，
 * 落的是 append-only 的 permission 行（id 由 receiptId 派生），它等的是用户、不是一次有 Post 收尾的执行。
 * 可这类工具的 `PostToolUse` 语义是 working——若只按**当前事件**的 state 决定 kind，Post 会被判成
 * tool_call，去 upsert 一条 `runId:tool:<toolCallId>`，而 Pre 落的是 permission 行、从没按 tool 关联过：
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
  // `id` 可被覆盖：关联 id 存在时，Pre 落的 item 要用 `runId:tool:<toolCallId>` 而不是 receiptId
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

/**
 * 各家 Provider 用来标识**同一次工具调用**的关联键。
 *
 * Claude Code 与 Codex 的 `PreToolUse`/`PostToolUse` 都带 `tool_use_id`（值形如 `toolu_01…`），
 * 一次调用的事前事后两条信封携带同一个 id——这是把「入参」和「结果」认成同一次调用的唯一权威依据。
 * 其余是同族命名变体，留给尚未接入的 Provider；取第一个能读出的。顺序即优先级。
 */
const TOOL_CALL_ID_KEYS = [
  'tool_use_id',
  'toolUseId',
  'tool_call_id',
  'toolCallId',
  'call_id',
  'callId'
] as const

function buildTimeline(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope,
  eventName: string,
  lifecycleEvent: AgentHookLifecycleEvent | undefined,
  payload: Record<string, unknown>,
  observedAt: number
): AgentTimelineMutation[] {
  const assistant = stringField(
    payload,
    'last_assistant_message',
    'lastAssistantMessage',
    'assistant_response',
    'text'
  )
  const toolName = stringField(payload, 'tool_name', 'toolName', 'name')
  const rawToolInput = payload.tool_input ?? payload.toolInput ?? payload.args ?? payload.input
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
    const toolCallId = stringField(payload, ...TOOL_CALL_ID_KEYS)
    // 结果只有事后才知道，所以只在事后事件上采集——事前那一行谈不上成败，给它盖任何结论都是编造。
    const outcome = isToolResult ? hookToolOutcome(payload) : undefined
    if (toolCallId && kind === 'tool_call') {
      // Provider 给了关联 id：把一次调用的入参与结果收敛到**同一条 item**。
      // id 从 receiptId（Pre/Post 各不相同）改绑 toolCallId（同一次调用两端一致），于是
      // 时间轴上一次调用就是一条，而不是两条。receiptId 方案在这里被彻底取代——不是两套并存。
      const itemId = `${envelope.runId}:tool:${toolCallId}`
      if (isToolResult) {
        // 事后：翻成终态并挂上结果。走 `upsert` 而不是 `update`——正常情况命中 Pre 落的那条替换掉，
        // 但 Pre 可能压根没落库：它的两次 fetch 都失败、或在 Pre/Post 之间被 200 条上限逐出（子代理
        // 场景尤甚）。`update` 命中不到目标会抛 UNKNOWN_AGENT_TIMELINE_ITEM，冒泡出 client 的 timeline
        // 循环、跳过 publishHook、把整条 hook 事件打成 503，这一步的结果和完成态永久丢失。upsert 目标
        // 缺失就补落一条自洽的终态行——携带完整 item（kind/source/title 俱全），不靠残缺字段合成。
        timeline.push(timelineItem(envelope, timeline.length, kind, toolName, eventName, observedAt, {
          id: itemId,
          toolName,
          // 失败是**观察到的事实**，不是默认值：采集判定失败才翻 failed，否则收敛为 complete
          // （不再是 streaming——调用已结束）。
          status: outcome?.failed ? 'failed' : 'complete',
          ...(toolInput ? { toolInput } : {}),
          ...(outcome?.output ? { toolOutput: outcome.output } : {})
        }, 'upsert'))
      } else {
        // 事前：先落在途态。`streaming` 徽标此前只有 ACP 会点亮，而所有 Provider 的 ACP 都是
        // none——hook 驱动的 Agent 由此第一次能显示「这一步正在跑」。
        timeline.push(timelineItem(envelope, timeline.length, kind, toolName, eventName, observedAt, {
          id: itemId,
          toolName,
          status: 'streaming',
          ...(toolInput ? { toolInput } : {})
        }))
      }
    } else {
      // 没有关联 id（或是 permission 行）：如实退回 append-only，绝不伪造关联。此路径仍带上
      // 事后结果，靠渲染层的折叠让带结果的那行胜出（f-23p8fsbs8/T-001 在无关联前提下的最简解）。
      append(kind, toolName, {
        toolName,
        ...(toolInput ? { toolInput } : {}),
        ...(outcome?.output ? { toolOutput: outcome.output } : {}),
        ...(outcome?.failed ? { status: 'failed' as const } : {})
      })
    }
  }
  if (assistant) {
    append('assistant_message', 'Assistant response', { content: assistant })
  }
  if (timeline.length === 0) {
    append('lifecycle', eventName)
  }
  return timeline
}

export function normalizeNativeHook(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope
): NormalizedHookEvent {
  const payload = envelope.payload ?? {}
  // 事件名可能在信封上，也可能藏在负载的三个拼法之一里——读取顺序由 agent-hook-event.ts 唯一持有，
  // 与 hook 子进程共用同一份，故不会再出现「一边认得出、另一边读成 null」。读不出时如实记为 'unknown'。
  const eventName = resolveHookEventName(envelope.eventName, payload) ?? 'unknown'
  // 归一化到 Core canonical 生命周期事件。认不出就是 `undefined`——语义状态照旧只由 Provider 的
  // `rules` 给出，绝不因为归一化失败而伪造 working/done。
  const lifecycleEvent = canonicalHookLifecycleEvent(eventName)
  // 先按 rules 定出这条事件本身的语义，再经子代理在途记账压制：主 Agent 报收尾时若子代理还活着，
  // rules 给出的 `done` 会被压回 `working`，直到最后一个子代理落地才兑现。
  const semanticState = applySubagentTracking(
    specification,
    envelope,
    eventName,
    payload,
    eventState(specification, eventName, payload)
  )
  const observedAt = Date.now()
  const status: AgentStatus = {
    state: semanticState === 'unknown' ? 'running' : semanticState,
    source: 'native-hook',
    observedAt,
    // 诊断带的是**原始**事件名：一条 Core 没认出来的事件，唯一有用的线索就是 Provider 到底叫它什么。
    detail: eventName
  }
  const handle = nativeHandle(envelope.providerId, specification, payload)
  // usage 由 hook 命令进程读 transcript 后并进 payload；normalizer 只把它校验回结构化用量，绝不自己读文件。
  // 缺席（Provider 不报 usage、非收尾事件、读失败）时它就是 undefined，一路缺席到 UI。
  const turnUsage = parseTurnUsage(payload[HOOK_PAYLOAD_USAGE_KEY]) ?? undefined
  return {
    agentSessionId: envelope.agentSessionId,
    run: {
      runId: envelope.runId
    },
    providerId: envelope.providerId,
    eventName,
    ...(lifecycleEvent ? { lifecycleEvent } : {}),
    semanticState,
    status,
    timeline: buildTimeline(specification, envelope, eventName, lifecycleEvent, payload, observedAt),
    ...(handle ? { nativeHandle: handle } : {}),
    ...(turnUsage ? { turnUsage } : {})
  }
}
