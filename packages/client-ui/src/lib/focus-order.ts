import type { AgentTimelineItem } from '@agentmux/core'
import type { AgentMuxAgentPresentation } from '@agentmux/core/control'
import { isAgentActivityStatusSource } from '@agentmux/core/agent-status'

export const FOCUS_RECENT_ACTIVITY_HOURS = [12, 24, 48, 72, 168] as const
export type FocusRecentActivityHours = typeof FOCUS_RECENT_ACTIVITY_HOURS[number]
export const DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS: FocusRecentActivityHours = 48
export function resolveFocusRecentActivityHours(value: unknown): FocusRecentActivityHours {
  return FOCUS_RECENT_ACTIVITY_HOURS.includes(value as FocusRecentActivityHours) ? value as FocusRecentActivityHours : DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS
}

export function focusActivityEntryAt(activity: { source: Parameters<typeof isAgentActivityStatusSource>[0]; stateEnteredAt?: number; aggregateActivityAt?: number } | undefined, now = Date.now()): number | undefined {
  if (!activity || !isAgentActivityStatusSource(activity.source)) return undefined
  const held = [activity.stateEnteredAt, activity.aggregateActivityAt].filter((at): at is number => at !== undefined && Number.isFinite(at) && at > 0 && at <= now)
  return held.length ? Math.max(...held) : undefined
}

/** Task facts only: transport observations, visits and output bytes never make work recent. */
export function focusLastTaskActivityAt(items: readonly AgentTimelineItem[], enteredAt?: number, now = Date.now()): number | null {
  let latest: number | null = null
  const remember = (at: number | undefined) => {
    if (at !== undefined && Number.isFinite(at) && at > 0 && at <= now) latest = Math.max(latest ?? 0, at)
  }
  remember(enteredAt)
  for (const item of items) {
    if (item.kind !== 'lifecycle') remember(item.updatedAt)
    else if (item.activityState && 'state' in item.activityState && isAgentActivityStatusSource(item.source)) remember(item.activityState.stateEnteredAt)
  }
  return latest
}

export function focusWorkPriority(bucket: string, at: number | null | undefined, now: number, recentActivityMs: number): number {
  return bucket === 'attention' ? 0 : bucket === 'working' ? 1 : at != null && at > 0 && at <= now
    ? now - at <= recentActivityMs ? 2 : 3 : 4
}

export function compareFocusWork(a: { priority: number; lastActivityAt?: number | null | undefined }, b: { priority: number; lastActivityAt?: number | null | undefined }): number {
  return a.priority - b.priority || (a.priority < 3 ? (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) : 0)
}

/** One owner order for public directory consumers; ties retain their original position. */
export function orderFocusPresentation<T extends AgentMuxAgentPresentation>(rows: readonly T[], recentActivityMs: number, now = Date.now()): T[] {
  const groups = new Map<string, { priority: number; lastActivityAt: number | null; index: number }>()
  const key = (row: T) => row.projectGroup?.key ?? 'unconfirmed-projects'
  for (const row of rows) {
    const priority = focusWorkPriority(row.group, row.lastActivityAt, now, recentActivityMs)
    const previous = groups.get(key(row)) ?? { priority, lastActivityAt: null, index: groups.size }
    previous.priority = Math.min(previous.priority, priority)
    if (row.lastActivityAt != null && row.lastActivityAt > 0 && row.lastActivityAt <= now) previous.lastActivityAt = Math.max(previous.lastActivityAt ?? 0, row.lastActivityAt)
    groups.set(key(row), previous)
  }
  return [...rows].sort((a, b) => {
    const first = groups.get(key(a))!, second = groups.get(key(b))!
    return compareFocusWork(first, second) || first.index - second.index
      || compareFocusWork({ priority: focusWorkPriority(a.group, a.lastActivityAt, now, recentActivityMs), lastActivityAt: a.lastActivityAt },
        { priority: focusWorkPriority(b.group, b.lastActivityAt, now, recentActivityMs), lastActivityAt: b.lastActivityAt })
  })
}
