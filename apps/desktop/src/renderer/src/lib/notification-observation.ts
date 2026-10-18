import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxClientNotificationRecord, AgentMuxClientNotificationSubject,
  AgentMuxClientNotificationsObservation, AgentMuxControlInspectNotificationsRequest } from '@agentmux/core/control'
import type { NotificationEntry } from '../components/NotificationGroup'
import { compactNotificationIdentity } from './notification-read-identity'

export type ObservedNotificationEntry = NotificationEntry & {
  observation: {
    source: AgentMuxClientNotificationRecord['source']
    subject: AgentMuxClientNotificationSubject
    version: string
    observedAt?: number | undefined
    provenance?: string
  }
}
export type NotificationProjection = {
  current: ObservedNotificationEntry[]
  activity: ObservedNotificationEntry[]
  unavailableSources: AgentMuxClientNotificationRecord['source'][]
}

// A borrowed reader of the committed notification owner, not another notification
// store. Disposing that owner removes its reader; an absent owner is never empty.
const instanceId = mintObjectId()
const readers = new Set<() => NotificationProjection>()
export function registerNotificationReader(read: () => NotificationProjection): () => void {
  readers.add(read)
  return () => { readers.delete(read) }
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const digest = (value: unknown) => compactNotificationIdentity(JSON.stringify(value))

/** No hooks, acknowledgement, navigation, refresh or business action runs here. */
export function observeNotifications(request: AgentMuxControlInspectNotificationsRequest): AgentMuxClientNotificationsObservation {
  const target = request.target
  const result: AgentMuxClientNotificationsObservation = {
    schema: 'agentmux.client-notifications.v1', target, availability: 'unavailable', data: null,
    raw: { retention: 'unknown', returned: 'unavailable', truncated: null }, issue: 'source-unavailable'
  }
  if (readers.size !== 1) return result
  const projection = readers.values().next().value!()
  const entries = [
    ...projection.current.map(entry => ({ entry, section: 'current' as const })),
    ...projection.activity.map(entry => ({ entry, section: 'activity' as const }))
  ]
  const list = 'list' in target ? target.list : null
  const selected = entries.map(({ entry, section }) => ({ entry, section, notificationId: digest([section, entry.id]) }))
    .filter(item => 'notificationId' in target ? item.notificationId === target.notificationId
      : (!list?.section || item.section === list.section) && (!list?.category || item.entry.category === list.category) &&
        (!list?.unreadOnly || item.entry.unread === true))
  const filters = { section: list?.section ?? null, category: list?.category ?? null, unreadOnly: list?.unreadOnly ?? false,
    limit: list?.limit ?? 32, includeRaw: request.includeRaw }
  const snapshot = digest([instanceId, target.hostId, filters, projection.unavailableSources,
    selected.map(({ entry, notificationId }) => [notificationId, entry.observation.version, entry.unread,
      entry.observation.subject, entry.observation.observedAt, entry.occurrences, entry.title, entry.impact, entry.subject])])
  let start = 0
  if (list?.cursor) {
    const match = /^([a-f0-9]{64})_([1-9][0-9]*)$/u.exec(list.cursor)
    if (!match || match[1] !== snapshot.slice(7) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) >= selected.length) {
      return { ...result, availability: 'expired', issue: null }
    }
    start = Number(match[2])
  }
  if ('notificationId' in target && selected.length === 0) return { ...result,
    availability: projection.unavailableSources.length ? 'unavailable' : 'not-found',
    issue: projection.unavailableSources.length ? 'source-unavailable' : null }
  result.availability = 'found'; result.issue = null
  result.raw = { retention: 'retained', returned: 'withheld', truncated: null }
  result.data = { kind: 'client-notifications', client: { instanceId }, items: [], total: selected.length,
    nextCursor: null, snapshot,
    coverage: { state: projection.unavailableSources.length ? 'partial' : 'available', unavailableSources: projection.unavailableSources },
    omissions: [] }
  const page = selected.slice(start, start + (list?.limit ?? 32))
  for (const { entry, section, notificationId } of page) {
    const record: AgentMuxClientNotificationRecord = { notificationId, version: digest(entry.observation.version),
      source: entry.observation.source, section, category: entry.category, level: entry.kind,
      unread: entry.unread === true, subject: entry.observation.subject,
      observedAt: entry.observation.observedAt ?? null, occurrences: entry.occurrences ?? null, original: null }
    result.data.items.push(record)
    const after = start + result.data.items.length
    result.data.nextCursor = after < selected.length ? `${snapshot.slice(7)}_${after}` : null
    if (bytes(result) > request.maxBytes) {
      result.data.items.pop()
      if (result.data.items.length === 0) return { ...result, availability: 'unavailable', data: null, issue: 'query-budget', raw: { retention: 'unknown', returned: 'unavailable', truncated: null } }
      result.data.nextCursor = `${snapshot.slice(7)}_${start + result.data.items.length}`
      break
    }
    if (request.includeRaw) {
      // Original getters stay lazy for safe metadata reads and for off-page items.
      record.original = { title: entry.title, detail: entry.detail,
        ...(entry.impact === undefined ? {} : { impact: entry.impact }),
        subjectLabel: entry.subject.label,
        ...(entry.subject.context === undefined ? {} : { subjectContext: entry.subject.context }),
        ...(entry.observation.provenance === undefined ? {} : { provenance: entry.observation.provenance }) }
      result.raw.returned = 'included'
      if (bytes(result) > request.maxBytes - 64) {
        record.original = null
        if (!result.data.omissions.length) result.data.omissions.push('raw-query-budget')
        result.raw.returned = result.data.items.some(item => item.original !== null) ? 'included' : 'withheld'
      }
    }
  }
  if (bytes(result) > request.maxBytes) return { ...result, availability: 'unavailable', data: null, issue: 'query-budget',
    raw: { retention: 'unknown', returned: 'unavailable', truncated: null } }
  return result
}
