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
  user: true
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
    ...optionalField(source, 'authorAgentSessionId'),
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
  if (mutation.type === 'append') {
    const existing = items.find((item) => item.id === mutation.item.id)
    if (existing) {
      if (sameItemSemantics(existing, mutation.item)) return items
      throw new AgentMuxError('Timeline item identity conflicts with existing content.', 'AGENT_TIMELINE_ID_CONFLICT')
    }
    return [...items, structuredClone(mutation.item)].slice(-MAX_AGENT_TIMELINE_ITEMS)
  }
  if (mutation.type === 'upsert') {
    const index = items.findIndex((item) => item.id === mutation.item.id)
    if (index < 0) {
      // 目标不在（事前那条丢投或被逐出）：补落一条自洽的终态行，而不是抛错吞掉整条 hook 事件。
      return [...items, structuredClone(mutation.item)].slice(-MAX_AGENT_TIMELINE_ITEMS)
    }
    // 就地替换。保留最初的 createdAt——这仍是「同一件事」，创建时刻不该被事后投递改写；
    // 语义未变则原样返回，避免推空的 revision。
    const previous = items[index]!
    // 更旧的观测**不许**改写更新的：否则一条乱序/重投的事件会把已完成的工具结果静默回退成
    // 在途态（`complete/有 toolOutput` → `streaming/旧输出`，`updatedAt` 甚至倒流），而这一行随后
    // 被持久化、被 renderer 原样重放——那次调用在界面上「退回未完成」。
    //
    // 与 update 路径（下面那处抛 `STALE_AGENT_TIMELINE_ITEM`）判的是同一件事，但**处置不同**：
    // upsert 的调用方是 hook 事件，抛错会让整条事件回 503（这正是 index<0 那支补落而不抛的理由）。
    // 所以这里保留原行、原样返回——拒绝这次回退，而不是把回退变成一次失败。
    if (mutation.item.updatedAt < previous.updatedAt) return items
    const next: AgentTimelineItem = { ...structuredClone(mutation.item), createdAt: previous.createdAt }
    if (sameItemSemantics(previous, next)) return items
    items[index] = next
    return items
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
    ...(mutation.toolOutput === undefined ? {} : { toolOutput: mutation.toolOutput }),
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
