import type { DiagnosticEvidenceRead } from '@agentmux/diagnostic-evidence'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export const CLIENT_NOTIFICATION_SOURCES = ['environment', 'runtime-ownership', 'session-names', 'startup-agent-availability',
  'runtime-endpoints', 'displaced-agents', 'sessions', 'workbench-save', 'native-chrome', 'desktop-navigation', 'workflow', 'events'] as const
export const CLIENT_NOTIFICATION_CATEGORIES = ['system', 'connections', 'agents', 'operations'] as const
export const CLIENT_NOTIFICATION_LEVELS = ['healthy', 'agent-broken', 'process-degraded', 'indeterminate'] as const
export const CLIENT_NOTIFICATION_SUBJECT_KINDS = ['application', 'host', 'agent', 'terminal', 'workspace', 'document', 'browser',
  'tab-group', 'tab', 'region', 'zone', 'unknown'] as const
export const CLIENT_NOTIFICATIONS_MAX_PAGE = 32
export type AgentMuxClientNotificationSource = typeof CLIENT_NOTIFICATION_SOURCES[number]
export type AgentMuxClientNotificationCategory = typeof CLIENT_NOTIFICATION_CATEGORIES[number]
export type AgentMuxClientNotificationLevel = typeof CLIENT_NOTIFICATION_LEVELS[number]
export type AgentMuxClientNotificationsList = {
  section?: 'current' | 'activity'; category?: AgentMuxClientNotificationCategory; unreadOnly?: boolean; limit?: number; cursor?: string
}
/** hostId routes to the client; each notification retains its own original subject Host. */
export type AgentMuxClientNotificationsTarget = { domain: 'client.notifications'; hostId: string } &
  ({ list: AgentMuxClientNotificationsList } | { notificationId: string })
export type AgentMuxClientNotificationSubject = {
  kind: typeof CLIENT_NOTIFICATION_SUBJECT_KINDS[number]
  /** Compacted complete original typed object identity; not an executable address. */
  objectKey?: string
  hostId?: string; agentSessionId?: string; runId?: string; tabId?: string; regionId?: string; workspaceId?: string; operationId?: string
}
export type AgentMuxClientNotificationOriginal = {
  title: string; detail: string; impact?: string; subjectLabel?: string; subjectContext?: string; provenance?: string
}
export type AgentMuxClientNotificationRecord = {
  /** Original notice scope/item identity, compacted; neither a logId nor an authorization. */
  notificationId: string
  /** Original notice content version, compacted independently of reading state. */
  version: string
  source: AgentMuxClientNotificationSource
  section: 'current' | 'activity'
  category: AgentMuxClientNotificationCategory
  level: AgentMuxClientNotificationLevel
  unread: boolean
  subject: AgentMuxClientNotificationSubject
  observedAt: number | null
  occurrences: number | null
  original: AgentMuxClientNotificationOriginal | null
}
export type AgentMuxClientNotificationsEvidence = {
  kind: 'client-notifications'
  /** Actual document lifetime of the registered reader, never guessed from focus. */
  client: { instanceId: string }
  items: AgentMuxClientNotificationRecord[]
  /** Matching items before this page; not the number of groups or all windows. */
  total: number
  nextCursor: string | null
  snapshot: string
  coverage: { state: 'available' | 'partial'; unavailableSources: AgentMuxClientNotificationSource[] }
  omissions: Array<'raw-query-budget'>
}
export type AgentMuxClientNotificationsObservation = {
  schema: 'agentmux.client-notifications.v1'
  target: AgentMuxClientNotificationsTarget
  availability: 'found' | 'not-found' | 'unavailable' | 'expired'
  data: AgentMuxClientNotificationsEvidence | null
  raw: { retention: 'retained' | 'not-retained' | 'unknown'; returned: 'included' | 'withheld' | 'unavailable'; truncated: null }
  issue: 'query-budget' | 'source-unavailable' | null
}
/** The host borrows the existing client owner. Core retains no notification state. */
export type AgentMuxClientNotificationsPort = {
  hostId: string
  read(target: AgentMuxClientNotificationsTarget, bounds: { signal: AbortSignal; maxBytes: number; includeRaw: boolean }):
    Promise<DiagnosticEvidenceRead<AgentMuxClientNotificationsTarget, AgentMuxClientNotificationsEvidence>>
}

const bad = (): never => { throw new AgentMuxError('Client notification observation does not satisfy its contract.', 'CONTROL_PROTOCOL_ERROR') }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const object = (value: unknown, keys: readonly string[], required = keys) => {
  const p = rpcRecord(value, keys, 'CONTROL_PROTOCOL_ERROR')
  if (required.some(key => !Object.hasOwn(p, key))) bad()
  return p
}
const member = (value: unknown, choices: readonly unknown[]) => { if (!choices.includes(value)) bad() }
const id = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value) || new TextEncoder().encode(value).byteLength > 512) bad() }
const digest = (value: unknown) => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) bad() }
const count = (value: unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 0) bad() }
const cursor = (value: unknown) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value)) bad() }
function list(value: unknown, max: number, consume: (value: unknown) => void) {
  if (!Array.isArray(value) || value.length > max) bad()
  for (const item of value as unknown[]) consume(item)
}
export function parseClientNotificationsTarget(value: unknown): AgentMuxClientNotificationsTarget {
  const r = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  const p = object(r, ['domain', 'hostId', Object.hasOwn(r, 'notificationId') ? 'notificationId' : 'list'])
  member(p.domain, ['client.notifications']); id(p.hostId)
  if (Object.hasOwn(p, 'notificationId')) digest(p.notificationId)
  else {
    const q = object(p.list, ['section', 'category', 'unreadOnly', 'limit', 'cursor'], [])
    if (q.section !== undefined) member(q.section, ['current', 'activity'])
    if (q.category !== undefined) member(q.category, CLIENT_NOTIFICATION_CATEGORIES)
    if (q.unreadOnly !== undefined) member(q.unreadOnly, [true, false])
    if (q.limit !== undefined) { count(q.limit); if ((q.limit as number) < 1 || (q.limit as number) > CLIENT_NOTIFICATIONS_MAX_PAGE) bad() }
    if (q.cursor !== undefined) cursor(q.cursor)
  }
  if (bytes(p) > 1024) bad()
  return p as AgentMuxClientNotificationsTarget
}
export function clientNotificationsTargetMatches(a: AgentMuxClientNotificationsTarget, b: AgentMuxClientNotificationsTarget): boolean {
  if (a.hostId !== b.hostId || a.domain !== b.domain) return false
  if ('notificationId' in a || 'notificationId' in b) return 'notificationId' in a && 'notificationId' in b && a.notificationId === b.notificationId
  return ['section', 'category', 'unreadOnly', 'limit', 'cursor'].every(key =>
    a.list[key as keyof AgentMuxClientNotificationsList] === b.list[key as keyof AgentMuxClientNotificationsList])
}
export function parseClientNotificationsEvidence(value: unknown, target: AgentMuxClientNotificationsTarget,
  includeRaw: boolean): AgentMuxClientNotificationsEvidence {
  const p = object(value, ['kind', 'client', 'items', 'total', 'nextCursor', 'snapshot', 'coverage', 'omissions'])
  member(p.kind, ['client-notifications']); id(object(p.client, ['instanceId']).instanceId); count(p.total); digest(p.snapshot)
  const seen = new Set<string>()
  list(p.items, 'list' in target ? target.list.limit ?? CLIENT_NOTIFICATIONS_MAX_PAGE : 1, value => {
    const r = object(value, ['notificationId', 'version', 'source', 'section', 'category', 'level', 'unread', 'subject', 'observedAt', 'occurrences', 'original'])
    digest(r.notificationId); digest(r.version)
    if (seen.has(r.notificationId as string)) bad()
    seen.add(r.notificationId as string)
    member(r.source, CLIENT_NOTIFICATION_SOURCES); member(r.section, ['current', 'activity']); member(r.category, CLIENT_NOTIFICATION_CATEGORIES)
    member(r.level, CLIENT_NOTIFICATION_LEVELS); member(r.unread, [true, false])
    const subject = object(r.subject, ['kind', 'objectKey', 'hostId', 'agentSessionId', 'runId', 'tabId', 'regionId', 'workspaceId', 'operationId'], ['kind'])
    member(subject.kind, CLIENT_NOTIFICATION_SUBJECT_KINDS)
    for (const key of Object.keys(subject)) if (key === 'objectKey') digest(subject[key]); else if (key !== 'kind') id(subject[key])
    if (r.observedAt !== null && (typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt) || r.observedAt < 0)) bad()
    if (r.occurrences !== null) { count(r.occurrences); if ((r.occurrences as number) < 1) bad() }
    if (r.original !== null) {
      if (!includeRaw) bad()
      const original = object(r.original, ['title', 'detail', 'impact', 'subjectLabel', 'subjectContext', 'provenance'], ['title', 'detail'])
      for (const text of Object.values(original)) if (typeof text !== 'string') bad()
    }
    if ('notificationId' in target) { if (r.notificationId !== target.notificationId) bad() }
    else if (target.list.section !== undefined && target.list.section !== r.section ||
      target.list.category !== undefined && target.list.category !== r.category || target.list.unreadOnly === true && r.unread !== true) bad()
  })
  if ((p.items as unknown[]).length > (p.total as number)) bad()
  if (p.nextCursor !== null) cursor(p.nextCursor)
  if ('notificationId' in target && ((p.items as unknown[]).length !== 1 || p.total !== 1 || p.nextCursor !== null)) bad()
  const coverage = object(p.coverage, ['state', 'unavailableSources']); member(coverage.state, ['available', 'partial'])
  list(coverage.unavailableSources, CLIENT_NOTIFICATION_SOURCES.length, value => member(value, CLIENT_NOTIFICATION_SOURCES))
  if (new Set(coverage.unavailableSources as unknown[]).size !== (coverage.unavailableSources as unknown[]).length ||
    (coverage.state === 'available') !== ((coverage.unavailableSources as unknown[]).length === 0)) bad()
  list(p.omissions, 1, value => member(value, ['raw-query-budget']))
  if (!includeRaw && (p.omissions as unknown[]).length) bad()
  return p as AgentMuxClientNotificationsEvidence
}
export function parseClientNotificationsObservation(value: unknown, query: AgentMuxClientNotificationsTarget,
  includeRaw: boolean): AgentMuxClientNotificationsObservation {
  const p = object(value, ['schema', 'target', 'availability', 'data', 'raw', 'issue'])
  member(p.schema, ['agentmux.client-notifications.v1'])
  if (!clientNotificationsTargetMatches(parseClientNotificationsTarget(p.target), query)) bad()
  member(p.availability, ['found', 'not-found', 'unavailable', 'expired']); member(p.issue, ['query-budget', 'source-unavailable', null])
  const data = p.data === null ? null : parseClientNotificationsEvidence(p.data, query, includeRaw)
  if ((p.availability === 'found') !== (data !== null)) bad()
  if (p.availability === 'expired' && (!('list' in query) || query.list.cursor === undefined) ||
    p.availability === 'not-found' && !('notificationId' in query)) bad()
  const raw = object(p.raw, ['retention', 'returned', 'truncated'])
  member(raw.retention, ['retained', 'not-retained', 'unknown']); member(raw.returned, ['included', 'withheld', 'unavailable'])
  if (raw.truncated !== null || (raw.returned === 'included') !== (data?.items.some(item => item.original !== null) ?? false)) bad()
  if (raw.returned === 'included' && (!includeRaw || raw.retention !== 'retained')) bad()
  if (p.issue !== null && p.availability !== 'unavailable' || p.issue !== null && data !== null) bad()
  if (data === null && (raw.returned !== 'unavailable' || raw.retention !== 'unknown')) bad()
  return p as AgentMuxClientNotificationsObservation
}
