import type { ServiceNoticeKind } from './service-window-notice'

export const notificationCategories = {
  all: 'All', system: 'System', connections: 'Connections', agents: 'Agents', operations: 'Operations'
} as const
export type NotificationCategory = Exclude<keyof typeof notificationCategories, 'all'>
export type NotificationFilter = keyof typeof notificationCategories
export type NotificationSection = 'current' | 'history'

export const notificationLevels: Record<ServiceNoticeKind, { label: string; rank: number }> = {
  'agent-broken': { label: 'Failed', rank: 0 },
  'process-degraded': { label: 'Degraded', rank: 1 },
  indeterminate: { label: 'Unconfirmed', rank: 2 },
  healthy: { label: 'Info', rank: 3 }
}

export type NotificationSubject = { key: string; label: string; context?: string }
export type GroupableNotification = {
  id: string; category: NotificationCategory; subject: NotificationSubject; kind: ServiceNoticeKind
}
export type NotificationGroup<T extends GroupableNotification> = {
  id: string; subject: NotificationSubject; category: NotificationCategory; items: T[]
}

/** A view of original records, never a root-cause detector or a settlement owner. */
export function groupNotifications<T extends GroupableNotification>(entries: readonly T[]): NotificationGroup<T>[] {
  const groups = new Map<string, NotificationGroup<T>>()
  for (const entry of entries) {
    const key = JSON.stringify([entry.category, entry.subject.key])
    let group = groups.get(key)
    if (!group) {
      group = { id: key, subject: entry.subject, category: entry.category, items: [] }
      groups.set(key, group)
    }
    group.items.push(entry)
  }
  for (const group of groups.values()) group.items.sort((a, b) => notificationLevels[a.kind].rank - notificationLevels[b.kind].rank)
  return [...groups.values()].sort((a, b) => notificationLevels[a.items[0]!.kind].rank - notificationLevels[b.items[0]!.kind].rank)
}

/** Time has an explicit provenance; no render-time timestamp is invented. */
export function notificationTimestamp(value: number | undefined, provenance: 'Observed' | 'Received' = 'Observed') {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return { label: `${provenance} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    title: `${provenance} ${date.toLocaleString()}`, dateTime: date.toISOString() }
}
