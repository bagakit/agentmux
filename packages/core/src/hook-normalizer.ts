import { randomUUID } from 'node:crypto'
import type {
  AgentActivity,
  AgentId,
  AgentNativeSessionHandle,
  AgentSemanticState,
  AgentStatus,
  NativeHookEnvelope,
  NormalizedHookEvent
} from './types.js'

const MAX_NATIVE_SESSION_ID_BYTES = 512
const MAX_TRANSCRIPT_PATH_BYTES = 4 * 1024

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

function hasUnsafeControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function boundedField(
  payload: Record<string, unknown>,
  names: readonly string[],
  maxBytes: number
): string | undefined {
  const value = stringField(payload, ...names)
  if (!value || Buffer.byteLength(value) > maxBytes || hasUnsafeControlCharacters(value)) return undefined
  return value
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
  agentId: AgentId,
  specification: AgentNativeHookSpecification,
  payload: Record<string, unknown>
): AgentNativeSessionHandle | undefined {
  const definition = specification.nativeHandle
  if (!definition) return undefined
  const sessionId = boundedField(payload, definition.sessionIdKeys, MAX_NATIVE_SESSION_ID_BYTES)
  if (!sessionId || sessionId.startsWith('-')) return undefined
  const transcriptPath = definition.transcriptPathKeys
    ? boundedField(payload, definition.transcriptPathKeys, MAX_TRANSCRIPT_PATH_BYTES)
    : undefined
  if (definition.requireTranscriptPath && !transcriptPath) return undefined
  return {
    kind: 'provider',
    providerId: agentId,
    sessionId,
    ...(transcriptPath ? { transcriptPath } : {})
  }
}

function activity(
  semanticSessionId: string,
  kind: AgentActivity['kind'],
  title: string,
  eventName: string,
  fields: Partial<Omit<AgentActivity, 'id' | 'sessionId' | 'kind' | 'source' | 'createdAt' | 'title'>> = {}
): AgentActivity {
  return {
    id: randomUUID(),
    sessionId: semanticSessionId,
    kind,
    source: 'native-hook',
    createdAt: Date.now(),
    title,
    eventName,
    ...fields
  }
}

function buildActivities(
  envelope: NativeHookEnvelope,
  eventName: string,
  payload: Record<string, unknown>,
  state: AgentSemanticState
): AgentActivity[] {
  const prompt = stringField(payload, 'prompt', 'user_prompt', 'userPrompt', 'user_message')
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
  const activities: AgentActivity[] = []
  if (prompt) {
    activities.push(activity(envelope.semanticSessionId, 'prompt', 'Prompt received', eventName, { content: prompt }))
  }
  if (toolName) {
    activities.push(
      activity(
        envelope.semanticSessionId,
        state === 'waiting' || state === 'blocked' ? 'permission' : 'tool',
        toolName,
        eventName,
        { toolName, ...(toolInput ? { toolInput } : {}) }
      )
    )
  }
  if (assistant) {
    activities.push(
      activity(envelope.semanticSessionId, 'assistant', 'Assistant response', eventName, { content: assistant })
    )
  }
  if (activities.length === 0) {
    activities.push(activity(envelope.semanticSessionId, 'lifecycle', eventName, eventName))
  }
  return activities
}

export function normalizeNativeHook(
  specification: AgentNativeHookSpecification,
  envelope: NativeHookEnvelope
): NormalizedHookEvent {
  const payload = envelope.payload ?? {}
  const eventName = envelope.eventName ?? stringField(payload, 'hook_event_name', 'hookEventName') ?? 'unknown'
  const semanticState = eventState(specification, eventName, payload)
  const status: AgentStatus = {
    state: semanticState === 'unknown' ? 'running' : semanticState,
    source: 'native-hook',
    observedAt: Date.now(),
    detail: eventName
  }
  const handle = nativeHandle(envelope.agentId, specification, payload)
  return {
    semanticSessionId: envelope.semanticSessionId,
    daemonSession: {
      sessionId: envelope.daemonSessionId,
      incarnationId: envelope.incarnationId
    },
    agentId: envelope.agentId,
    eventName,
    semanticState,
    status,
    activities: buildActivities(envelope, eventName, payload, semanticState),
    ...(handle ? { nativeHandle: handle } : {})
  }
}
