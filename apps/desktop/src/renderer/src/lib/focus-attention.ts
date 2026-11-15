import type { FocusContext } from './focus-context'
import type { AgentFocusHistoryEntry } from './agent-focus'

export const FOCUS_QUIET_AGE_MS = 48 * 3_600_000
export type FocusHeat = 'recent' | 'warm' | 'cool' | 'unknown'
const recorded = (at: number | null | undefined, now: number): at is number => at != null && Number.isFinite(at) && at > 0 && at <= now

/** A visit is only a visit. Keep its source separate from original task activity. */
export function focusVisitTimes(history: readonly AgentFocusHistoryEntry[], now = Date.now()) {
  const visits = new Map<string, number>()
  for (const entry of history) if (entry.identity?.hostId && recorded(entry.focusedAt, now)) {
    const source = entry.identity.source
    const key = source?.runtimeId ? JSON.stringify(['source', source.runtimeId, source.agentSessionId])
      : JSON.stringify([entry.identity.hostId, entry.sessionId])
    visits.set(key, Math.max(visits.get(key) ?? 0, entry.focusedAt))
  }
  return visits
}
export function focusContextVisit(context: FocusContext, visits: ReadonlyMap<string, number>) {
  const source = context.access?.identity
  if (source?.runtimeId) return visits.get(JSON.stringify(['source', source.runtimeId, source.agentSessionId]))
  const presentation = visits.get(JSON.stringify([context.hostId, context.id]))
  const original = context.control ? visits.get(JSON.stringify([context.control.hostId, context.control.agentSessionId])) : undefined
  return Math.max(presentation ?? 0, original ?? 0) || undefined
}
export function focusContextHeat(context: FocusContext, visitedAt: number | undefined, now: number): FocusHeat {
  if (context.bucket === 'attention' || context.bucket === 'working') return 'recent'
  const at = Math.max(recorded(context.lastActivityAt, now) ? context.lastActivityAt : 0, recorded(visitedAt, now) ? visitedAt : 0)
  return !at ? 'unknown' : now - at < 3_600_000 ? 'recent' : now - at < FOCUS_QUIET_AGE_MS ? 'warm' : 'cool'
}
/** Unknown observations cannot establish a quiet project. This never decides Run eligibility. */
export function focusQuietProject(contexts: readonly FocusContext[], visits: ReadonlyMap<string, number>, now: number): boolean {
  return contexts.length > 0 && contexts.every(context => context.activitySemantic === 'idle' && !context.runUnobserved
    && context.detailKind !== 'service' && recorded(context.lastActivityAt, now) && now - context.lastActivityAt >= FOCUS_QUIET_AGE_MS
    && (!recorded(focusContextVisit(context, visits), now) || now - focusContextVisit(context, visits)! >= FOCUS_QUIET_AGE_MS))
}
