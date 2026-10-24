import type { FocusBucket, FocusContext } from './focus-context'
import type { FocusSourceType } from './focus-lane-origin'

export type FocusStateFilter = FocusBucket | 'unknown' | 'recovery'
export type FocusFilters = {
  projects: readonly { id: string; name: string }[]
  states: readonly FocusStateFilter[]
  types: readonly FocusSourceType[]
}
export const EMPTY_FOCUS_FILTERS: FocusFilters = { projects: [], states: [], types: [] }
export const FOCUS_FILTER_STATES: readonly { id: FocusStateFilter; name: string }[] = [
  { id: 'attention', name: 'Attention' }, { id: 'working', name: 'Working' }, { id: 'results', name: 'Results' },
  { id: 'idle', name: 'Idle / Recovery' }, { id: 'unknown', name: 'Activity unknown' }, { id: 'recovery', name: 'Needs recovery' }
]

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
