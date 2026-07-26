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

export type AgentNativeHookSpecification = {
  rules: readonly AgentNativeHookStateRule[]
  nativeHandle?: {
    sessionIdKeys: readonly string[]
    transcriptPathKeys?: readonly string[]
    requireTranscriptPath?: boolean
  }
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
  const semanticState = eventState(specification, eventName, payload)
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
