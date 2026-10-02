import type { AgentFocusHistoryIdentity } from './agent-focus'
import type { AgentTimelineItem, AgentTimelineSnapshot, AgentWorkHistoryProjection } from '@agentmux/core'
import { focusTimePosition, type FocusTimeWindow } from './focus-time-window'

export const EMPTY_FOCUS_WORK_ITEMS: readonly AgentTimelineItem[] = []
export const MAX_FOCUS_WORK_RECORDS = 200
export type FocusWorkFacts = {
  items: readonly AgentTimelineItem[]
  identity?: AgentFocusHistoryIdentity | undefined
  /** Per-record Context identity observed in this mounted holder, never a claim
   * about an unobserved historical project's ownership. Bounded by items. */
  identities?: ReadonlyMap<string, AgentFocusHistoryIdentity | undefined>
  trimmed: boolean
  error: string | null
}
export type FocusWorkInterval = AgentWorkHistoryProjection['segments'][number]

/** Only typed semantic facts determine this leaf's subscription. Normalization
 * may clone the old items on a tool update; reference equality is not evidence. */
export function sameFocusWorkItems(a: readonly AgentTimelineItem[], b: readonly AgentTimelineItem[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]!, left = item.activityState!, right = other.activityState!
    return item.id === other.id && item.agentSessionId === other.agentSessionId && item.createdAt === other.createdAt
      && left.run.runId === right.run.runId && left.previousObservationId === right.previousObservationId
      && ('state' in left ? 'state' in right && left.state === right.state && left.stateEnteredAt === right.stateEnteredAt
        : 'boundary' in right && left.boundary === right.boundary)
  })
}
export function createFocusWorkSelector(sessionId: string) {
  let retained = EMPTY_FOCUS_WORK_ITEMS
  return (state: { timelines: Record<string, AgentTimelineSnapshot> }) => {
    const items = state.timelines[sessionId]?.items.filter(item => item.activityState !== undefined) ?? EMPTY_FOCUS_WORK_ITEMS
    if (!sameFocusWorkItems(retained, items)) retained = items
    return retained
  }
}
/** Merge only this page's actually seen facts, never infer a missing transition. */
export function mergeFocusWorkItems(before: readonly AgentTimelineItem[], incoming: readonly AgentTimelineItem[]): readonly AgentTimelineItem[] {
  if (sameFocusWorkItems(before, incoming)) return before
  const byId = new Map(before.map(item => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  const items = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  return sameFocusWorkItems(before, items) ? before : items
}
/** Unknown ends are a point at the last known observation, never a band to Now. */
export function clipFocusWorkInterval(segment: FocusWorkInterval, window: FocusTimeWindow, now: number) {
  const through = segment.end === 'current' ? now : segment.endAt ?? segment.startAt
  if (segment.startAt > Math.min(now, window.end) || through < window.start) return null
  const left = focusTimePosition(Math.max(window.start, segment.startAt), window)
  const right = focusTimePosition(Math.min(window.end, through), window)
  return { left, width: Math.max(0, right - left), through }
}
