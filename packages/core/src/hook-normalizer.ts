import type {
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineMutation,
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
import { hookToolOutcome } from './hook-tool-outcome.js'

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
 * 用 Set 而不是裸计数器，重复的 start/stop 天然幂等。`anon` 是没有 id 的降级计数（当前内建 Provider
 * 都带 id，用不到；留作不带 id 的 Provider 的安全网）。`mainStopPending` 记「主 Agent 已请求收尾但
 * 被子代理压住」——好让最后一个子代理结束时能收敛到 `done`，而不是永远卡在 working。
 */
type SubagentRoster = {
  live: Set<string>
  anon: number
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

function subagentRosterAlive(roster: SubagentRoster): boolean {
  return roster.live.size > 0 || roster.anon > 0
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
    const roster = subagentRosters.get(key) ?? { live: new Set<string>(), anon: 0, mainStopPending: false }
    if (id) roster.live.add(id)
    else roster.anon += 1
    subagentRosters.set(key, roster)
    return 'working'
  }
  if (tracking.stopEvents.includes(eventName)) {
    const roster = subagentRosters.get(key)
    if (!roster) return 'working'
    if (id) roster.live.delete(id)
    else roster.anon = Math.max(0, roster.anon - 1)
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
  // 派生的默认 id，好让 Post 的 `update` 能命中同一条。`...fields` 排在 `id:` 之后，故覆盖生效。
  fields: Partial<Omit<AgentTimelineItem, 'agentSessionId' | 'kind' | 'source' | 'createdAt' | 'updatedAt' | 'title'>> = {}
): AgentTimelineMutation {
  return {
    type: 'append',
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
  envelope: NativeHookEnvelope,
  eventName: string,
  payload: Record<string, unknown>,
  state: AgentSemanticState,
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
    const kind: AgentTimelineItemKind =
      state === 'waiting' || state === 'blocked' ? 'permission' : 'tool_call'
    const isPost = eventName.startsWith('Post')
    const toolCallId = stringField(payload, ...TOOL_CALL_ID_KEYS)
    // 结果只有事后才知道，所以只在事后事件上采集——`PreToolUse` 那一行谈不上成败，给它盖任何
    // 结论都是编造。事件名以 `Post` 开头的才带结果，其余照旧只有入参。
    const outcome = isPost ? hookToolOutcome(payload) : undefined
    if (toolCallId && kind === 'tool_call') {
      // Provider 给了关联 id：把一次调用的入参与结果收敛到**同一条 item**。
      // id 从 receiptId（Pre/Post 各不相同）改绑 toolCallId（同一次调用两端一致），于是
      // 时间轴上一次调用就是一条，而不是两条。receiptId 方案在这里被彻底取代——不是两套并存。
      const itemId = `${envelope.runId}:tool:${toolCallId}`
      if (isPost) {
        // 事后：翻成终态并挂上结果。走 `update` 而不是再 append——Pre 已经落过这条 id，append
        // 同 id 会撞 `AGENT_TIMELINE_ID_CONFLICT`。Pre 与 Post 在同一 binding 上按序投递，
        // Pre 的时间轴在 Post 的 onEvent 开始前已持久化，所以更新目标总是就位。
        timeline.push({
          type: 'update',
          agentSessionId: envelope.agentSessionId,
          itemId,
          updatedAt: observedAt,
          // 失败是**观察到的事实**，不是默认值：采集判定失败才翻 failed，否则收敛为 complete
          // （不再是 streaming——调用已结束）。
          status: outcome?.failed ? 'failed' : 'complete',
          eventName,
          ...(toolInput ? { toolInput } : {}),
          ...(outcome?.output ? { toolOutput: outcome.output } : {})
        })
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
  const eventName = envelope.eventName ?? stringField(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
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
    detail: eventName
  }
  const handle = nativeHandle(envelope.providerId, specification, payload)
  return {
    agentSessionId: envelope.agentSessionId,
    run: {
      runId: envelope.runId
    },
    providerId: envelope.providerId,
    eventName,
    semanticState,
    status,
    timeline: buildTimeline(envelope, eventName, payload, semanticState, observedAt),
    ...(handle ? { nativeHandle: handle } : {})
  }
}
