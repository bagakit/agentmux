import type { FocusBucket, FocusContext } from './focus-context'
import type { FocusSourceType } from './focus-lane-origin'
import { focusContextVisit } from './focus-attention'

export type FocusStateFilter = FocusBucket | 'unknown' | 'recovery'
export type FocusFilters = {
  projects: readonly { id: string; name: string }[]
  states: readonly FocusStateFilter[]
  types: readonly FocusSourceType[]
  interactionMinutes?: number | undefined
}
export const EMPTY_FOCUS_FILTERS: FocusFilters = { projects: [], states: [], types: [] }
export const FOCUS_FILTER_STATES: readonly { id: FocusStateFilter; name: string }[] = [
  { id: 'attention', name: 'Attention' }, { id: 'working', name: 'Working' }, { id: 'results', name: 'Results' },
  { id: 'idle', name: 'Idle / Recovery' }, { id: 'unknown', name: 'Activity unknown' }, { id: 'recovery', name: 'Needs recovery' }
]
export const FOCUS_INTERACTION_RANGES: readonly { minutes?: number; label: string; short: string }[] = [
  { minutes: 15, label: 'Past 15 minutes', short: '15 min' },
  { minutes: 60, label: 'Past hour', short: '1 hr' },
  { minutes: 240, label: 'Past 4 hours', short: '4 hr' },
  { minutes: 1440, label: 'Past 24 hours', short: '24 hr' },
  { minutes: 4320, label: 'Past 3 days', short: '3 days' },
  { minutes: 10080, label: 'Past 7 days', short: '7 days' },
  { label: 'Any time', short: 'Any time' },
]

export function focusInteractionTime(row: FocusContext, visits: ReadonlyMap<string, number>, localHosts: ReadonlySet<string>, now: number): number {
  const visit = row.access && !row.access.identity.runtimeId ? undefined : focusContextVisit(row, visits)
  const input = !row.access && row.control && localHosts.has(row.control.hostId) ? row.lastHumanInputAt : undefined
  return Math.max(visit && visit <= now ? visit : 0, input && input <= now ? input : 0)
}

/** A refinement of the original neutral group, never an inferred Run or task state. */
export function focusMatchesState(row: FocusContext, states: readonly FocusStateFilter[]): boolean {
  return states.length === 0 || states.some(state => state === 'unknown'
    ? row.bucket === 'idle' && (row.runUnobserved === true || row.processState === 'running' && (row.activitySemantic === 'unknown' || row.activitySemantic === 'unsupported'))
    : state === 'recovery'
      ? row.bucket === 'idle' && !row.runUnobserved && (row.processState === 'interrupted' || row.processState === 'exited')
      : row.bucket === state)
}

export function focusMatchesTypes(types: readonly FocusSourceType[], selected: readonly FocusSourceType[]): boolean {
  return selected.length === 0 || selected.some(type => types.includes(type))
}

export function focusMatchesProject(key: string | undefined, selected: FocusFilters['projects']): boolean {
  return selected.length === 0 || selected.some(project => project.id === key)
}
