import { AgentMuxError } from './errors.js'
import type {
  AgentMuxAcpEvent,
  AgentMuxEvidence,
  AgentMuxEvidenceSource,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineItemStatus,
  AgentTimelineMutation
} from './types.js'

export type {
  AgentTimelineCommit,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTimelineItemStatus,
  AgentTimelineMutation,
  AgentTimelineSnapshot
} from './types.js'

export const MAX_AGENT_TIMELINE_ITEMS = 200
const MAX_TIMELINE_MUTATION_BYTES = 128 * 1024
const UTF8_ENCODER = new TextEncoder()
const KINDS: readonly AgentTimelineItemKind[] = [
  'user_message', 'assistant_message', 'tool_call', 'permission', 'lifecycle'
]
const STATUSES: readonly AgentTimelineItemStatus[] = ['streaming', 'complete', 'failed']
const SOURCES: readonly AgentMuxEvidenceSource[] = [
  'terminal-output', 'run-process', 'native-hook', 'acp', 'user'
]

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Timeline mutation must be an object.', 'INVALID_AGENT_TIMELINE')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /\0/u.test(value)) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_TIMELINE')
  }
  return value
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentMuxError(`${name} is invalid.`, 'INVALID_AGENT_TIMELINE')
  }
  return value as number
}

function optionalText(
  source: Record<string, unknown>,
  name: string,
  allowEmpty = true
): string | undefined {
  return source[name] === undefined ? undefined : text(source[name], name, allowEmpty)
}

function optionalField(
  source: Record<string, unknown>,
  name: string,
  allowEmpty = true
): Record<string, string> {
  const value = optionalText(source, name, allowEmpty)
  return value === undefined ? {} : { [name]: value }
}

function sameItemSemantics(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftSemantics } = left
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightSemantics } = right
  return JSON.stringify(leftSemantics) === JSON.stringify(rightSemantics)
}

function acpTimelineItemId(
  evidence: AgentMuxEvidence,
  kind: 'activity' | 'permission',
  rawId: string
): string {
  if (evidence.source !== 'acp') {
    throw new AgentMuxError('ACP Timeline evidence source is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  return JSON.stringify([
    'acp',
    text(evidence.acpAdapterId, 'ACP adapter id'),
    text(evidence.acpSessionId, 'ACP Session id'),
    kind,
    text(rawId, 'ACP event id')
  ])
}

function normalizeItem(value: unknown): AgentTimelineItem {
  const source = record(value)
  if (!KINDS.includes(source.kind as AgentTimelineItemKind)) {
    throw new AgentMuxError('Timeline item kind is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (!STATUSES.includes(source.status as AgentTimelineItemStatus)) {
    throw new AgentMuxError('Timeline item status is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (!SOURCES.includes(source.source as AgentMuxEvidenceSource)) {
    throw new AgentMuxError('Timeline item source is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const createdAt = timestamp(source.createdAt, 'Timeline item createdAt')
  const updatedAt = timestamp(source.updatedAt, 'Timeline item updatedAt')
  if (updatedAt < createdAt) {
    throw new AgentMuxError('Timeline item update precedes creation.', 'INVALID_AGENT_TIMELINE')
  }
  return {
    id: text(source.id, 'Timeline item id'),
    agentSessionId: text(source.agentSessionId, 'Timeline Agent Session id'),
    kind: source.kind as AgentTimelineItemKind,
    status: source.status as AgentTimelineItemStatus,
    source: source.source as AgentMuxEvidenceSource,
    createdAt,
    updatedAt,
    title: text(source.title, 'Timeline item title'),
    ...optionalField(source, 'content'),
    ...optionalField(source, 'toolName'),
    ...optionalField(source, 'toolInput'),
    ...optionalField(source, 'eventName')
  }
}

export function normalizeAgentTimelineMutation(value: unknown): AgentTimelineMutation {
  if (UTF8_ENCODER.encode(JSON.stringify(value)).byteLength > MAX_TIMELINE_MUTATION_BYTES) {
    throw new AgentMuxError('Timeline mutation exceeds the maximum size.', 'AGENT_TIMELINE_TOO_LARGE')
  }
  const source = record(value)
  if (Object.hasOwn(source, 'contentDelta')) {
    throw new AgentMuxError(
      'Timeline updates require complete content.',
      'INVALID_AGENT_TIMELINE'
    )
  }
  const agentSessionId = text(source.agentSessionId, 'Timeline Agent Session id')
  if (source.type === 'append') {
    const item = normalizeItem(source.item)
    if (item.agentSessionId !== agentSessionId) {
      throw new AgentMuxError('Timeline item belongs to another Agent Session.', 'INVALID_AGENT_TIMELINE')
    }
    return { type: 'append', agentSessionId, item }
  }
  if (source.type !== 'update') {
    throw new AgentMuxError('Timeline mutation type is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  if (source.status !== undefined && !STATUSES.includes(source.status as AgentTimelineItemStatus)) {
    throw new AgentMuxError('Timeline item status is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  return {
    type: 'update',
    agentSessionId,
    itemId: text(source.itemId, 'Timeline item id'),
    updatedAt: timestamp(source.updatedAt, 'Timeline item updatedAt'),
    ...(source.status === undefined ? {} : { status: source.status as AgentTimelineItemStatus }),
    ...optionalField(source, 'title', false),
    ...optionalField(source, 'content'),
    ...optionalField(source, 'toolName'),
    ...optionalField(source, 'toolInput'),
    ...optionalField(source, 'eventName')
  }
}

export function applyAgentTimelineMutation(
  current: readonly AgentTimelineItem[],
  value: AgentTimelineMutation
): AgentTimelineItem[] {
  const mutation = normalizeAgentTimelineMutation(value)
  const items = current.map((item) => normalizeItem(item))
  if (items.some((item) => item.agentSessionId !== mutation.agentSessionId)) {
    throw new AgentMuxError('Timeline contains another Agent Session.', 'INVALID_AGENT_TIMELINE')
  }
  if (mutation.type === 'append') {
    const existing = items.find((item) => item.id === mutation.item.id)
    if (existing) {
      if (sameItemSemantics(existing, mutation.item)) return items
      throw new AgentMuxError('Timeline item identity conflicts with existing content.', 'AGENT_TIMELINE_ID_CONFLICT')
    }
    return [...items, structuredClone(mutation.item)].slice(-MAX_AGENT_TIMELINE_ITEMS)
  }
  const index = items.findIndex((item) => item.id === mutation.itemId)
  if (index < 0) {
    throw new AgentMuxError('Timeline update target is unavailable.', 'UNKNOWN_AGENT_TIMELINE_ITEM')
  }
  const previous = items[index]!
  if (mutation.updatedAt < previous.updatedAt) {
    throw new AgentMuxError('Timeline update is stale.', 'STALE_AGENT_TIMELINE_ITEM')
  }
  const next: AgentTimelineItem = {
    ...previous,
    updatedAt: mutation.updatedAt,
    ...(mutation.status === undefined ? {} : { status: mutation.status }),
    ...(mutation.title === undefined ? {} : { title: mutation.title }),
    ...(mutation.content === undefined ? {} : { content: mutation.content }),
    ...(mutation.toolName === undefined ? {} : { toolName: mutation.toolName }),
    ...(mutation.toolInput === undefined ? {} : { toolInput: mutation.toolInput }),
    ...(mutation.eventName === undefined ? {} : { eventName: mutation.eventName })
  }
  if (sameItemSemantics(previous, next)) return items
  items[index] = next
  return items
}

export function normalizeAgentTimeline(
  agentSessionId: string,
  values: readonly unknown[]
): AgentTimelineItem[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_TIMELINE_ITEMS) {
    throw new AgentMuxError('Agent Timeline exceeds its item limit.', 'AGENT_TIMELINE_LIMIT')
  }
  return values.reduce<AgentTimelineItem[]>((items, item) => applyAgentTimelineMutation(items, {
    type: 'append',
    agentSessionId,
    item: normalizeItem(item)
  }), [])
}

export function agentTimelineMutationFromAcpEvent(
  agentSessionId: string,
  event: AgentMuxAcpEvent,
  evidence: AgentMuxEvidence
): AgentTimelineMutation | null {
  if (event.type === 'activity') {
    if (Object.hasOwn(event, 'contentDelta')) {
      throw new AgentMuxError(
        'ACP activity updates require complete content.',
        'INVALID_AGENT_TIMELINE'
      )
    }
    if (event.operation === 'append') {
      return normalizeAgentTimelineMutation({
        type: 'append',
        agentSessionId,
        item: {
          id: acpTimelineItemId(evidence, 'activity', event.activityId),
          agentSessionId,
          kind: event.kind,
          status: event.status,
          source: 'acp',
          createdAt: evidence.observedAt,
          updatedAt: evidence.observedAt,
          title: event.title,
          ...(event.content === undefined ? {} : { content: event.content }),
          ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
          ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
        }
      })
    }
    return normalizeAgentTimelineMutation({
      type: 'update',
      agentSessionId,
      itemId: acpTimelineItemId(evidence, 'activity', event.activityId),
      updatedAt: evidence.observedAt,
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.content === undefined ? {} : { content: event.content }),
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
    })
  }
  if (event.type !== 'permission') return null
  return normalizeAgentTimelineMutation({
    type: 'append',
    agentSessionId,
    item: {
      id: acpTimelineItemId(evidence, 'permission', event.requestId),
      agentSessionId,
      kind: 'permission',
      status: 'complete',
      source: 'acp',
      createdAt: evidence.observedAt,
      updatedAt: evidence.observedAt,
      title: event.title,
      ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput })
    }
  })
}
