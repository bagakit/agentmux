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
  fields: Partial<Omit<AgentTimelineItem, 'id' | 'agentSessionId' | 'kind' | 'status' | 'source' | 'createdAt' | 'updatedAt' | 'title'>> = {}
): AgentTimelineMutation {
  return {
    type: 'append',
    agentSessionId: envelope.agentSessionId,
    item: {
      id: `${envelope.runId}:${envelope.receiptId}:${index}`,
      agentSessionId: envelope.agentSessionId,
      kind,
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
    fields?: Partial<Omit<AgentTimelineItem, 'id' | 'agentSessionId' | 'kind' | 'status' | 'source' | 'createdAt' | 'updatedAt' | 'title'>>
  ): void => {
    timeline.push(timelineItem(envelope, timeline.length, kind, title, eventName, observedAt, fields))
  }
  if (toolName) {
    append(
      state === 'waiting' || state === 'blocked' ? 'permission' : 'tool_call',
      toolName,
      { toolName, ...(toolInput ? { toolInput } : {}) }
    )
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
