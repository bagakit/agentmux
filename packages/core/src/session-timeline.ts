import { AgentMuxError } from './errors.js'
import { applyNormalizedTimelineMutation, MAX_TIMELINE_ITEMS_PER_WINDOW } from './session-timeline-reducer.js'
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

export const MAX_AGENT_TIMELINE_ITEMS = 2 * MAX_TIMELINE_ITEMS_PER_WINDOW
const MAX_TIMELINE_MUTATION_BYTES = 128 * 1024
const UTF8_ENCODER = new TextEncoder()
// These three arrays are the sole runtime validation gate in `normalizeItem`. A plain
// `readonly X[]` literal annotation only enforces ⊆ (every listed string is a union member); it is
// blind to ⊇ (every union member is listed). Adding a member to a union in types.ts and forgetting
// to list it here would silently REJECT every legitimate timeline item carrying the new member with
// INVALID_AGENT_TIMELINE — a fail-closed data drop with NO compile error, and addition is the
// common direction. Projecting each array off a total `Record<Union, true>` table turns BOTH
// directions into a compile error at THIS file: a missing key errors (TS2741 — the ⊇ drift this
// guards, kills the mutation "add a union member, forget the table entry"), and an extra key errors
// (TS2353 — a stale entry left after a member is removed). Measured in this repo (session-timeline
// via `npx tsc --noEmit`): the explicit `Record<Union, true>` annotation errors on a missing key AND
// on an extra key; that is the load-bearing thing here, not any runtime `.includes` check — a
// hand-written array is behaviourally identical to this projection, so only the compiler catches the
// drift. Blind spot: it does not check the ORDER of members, only their exact set.
const KIND_MEMBERS: Record<AgentTimelineItemKind, true> = {
  system_message: true,
  user_message: true,
  assistant_message: true,
  tool_call: true,
  permission: true,
  lifecycle: true
}
const KINDS = Object.keys(KIND_MEMBERS) as readonly AgentTimelineItemKind[]
const STATUS_MEMBERS: Record<AgentTimelineItemStatus, true> = {
  streaming: true,
  complete: true,
  failed: true
}
const STATUSES = Object.keys(STATUS_MEMBERS) as readonly AgentTimelineItemStatus[]
const SOURCE_MEMBERS: Record<AgentMuxEvidenceSource, true> = {
  'terminal-output': true,
  'run-process': true,
  'native-hook': true,
  acp: true,
  user: true,
  agentmux: true
}
const SOURCES = Object.keys(SOURCE_MEMBERS) as readonly AgentMuxEvidenceSource[]

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
  if (source.authorHuman !== undefined && typeof source.authorHuman !== 'boolean') {
    throw new AgentMuxError('Timeline item authorHuman is invalid.', 'INVALID_AGENT_TIMELINE')
  }
  const authorAgent = optionalField(source, 'authorAgentSessionId')
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
    ...authorAgent,
    ...(authorAgent.authorAgentSessionId === undefined && source.authorHuman === true ? { authorHuman: true } : {}),
    ...optionalField(source, 'toolName'),
    ...optionalField(source, 'toolInput'),
    ...optionalField(source, 'toolOutput'),
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
  if (source.type === 'append' || source.type === 'upsert') {
    const item = normalizeItem(source.item)
    if (item.agentSessionId !== agentSessionId) {
      throw new AgentMuxError('Timeline item belongs to another Agent Session.', 'INVALID_AGENT_TIMELINE')
    }
    return { type: source.type, agentSessionId, item }
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
    ...optionalField(source, 'toolOutput'),
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
  return applyNormalizedTimelineMutation(items, mutation)
}

export function normalizeAgentTimeline(
  agentSessionId: string,
  values: readonly unknown[]
): AgentTimelineItem[] {
  if (!Array.isArray(values) || values.length > MAX_AGENT_TIMELINE_ITEMS) {
    throw new AgentMuxError('Agent Timeline exceeds its item limit.', 'AGENT_TIMELINE_LIMIT')
  }
  const normalized = values.map(normalizeItem)
  const inputs = normalized.filter((item) => item.kind === 'user_message').length
  if (inputs > MAX_TIMELINE_ITEMS_PER_WINDOW || normalized.length - inputs > MAX_TIMELINE_ITEMS_PER_WINDOW) {
    throw new AgentMuxError('Agent Timeline exceeds its retention window.', 'AGENT_TIMELINE_LIMIT')
  }
  return normalized.reduce<AgentTimelineItem[]>((items, item) => applyNormalizedTimelineMutation(items, normalizeAgentTimelineMutation({
    type: 'append',
    agentSessionId,
    item
  })), [])
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
