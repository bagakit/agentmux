import { useSyncExternalStore } from 'react'
import type { NoteFileTarget } from './file-document-consumers'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { sameWorkbenchProjectionSelection } from './workbench-projection'
import type { AppState } from '../store'

export type NoteReadingReturn = { from: WorkbenchProjectionSelection; to: WorkbenchProjectionSelection; original: NoteFileTarget; title: string; surface: AppState['mainSurface'] }
/** Check the original navigation owner after selecting an exact, already validated occurrence. */
export function noteReadingReferenceIsSelected(state: Pick<AppState, 'mainSurface' | 'recallZoneSelection' | 'surveyZoneSelection' | 'workbenchSpaceSelection'>, reference: WorkbenchProjectionSelection): boolean {
  if (state.mainSurface === 'recall' || state.mainSurface === 'survey') {
    const active = (state.mainSurface === 'recall' ? state.recallZoneSelection : state.surveyZoneSelection)?.active
    return active?.tabId === reference.tabId && active.regionId === reference.regionId
  }
  const selected = state.workbenchSpaceSelection
  return Boolean(selected && selected.workspaceId === reference.displayWorkspaceId && selected.groupId === reference.groupId && selected.tabId === reference.tabId && selected.regionId === reference.regionId)
}
// One transient reading journey, not a second persisted navigation history.
let journey: NoteReadingReturn | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => journey
export function rememberNoteReadingReturn(next: NoteReadingReturn) {
  if (sameWorkbenchProjectionSelection(next.from, next.to)) return
  journey = journey && journey.surface === next.surface && sameWorkbenchProjectionSelection(journey.to, next.from) ? { ...journey, to: next.to } : next
  for (const listener of listeners) listener()
}
export function clearNoteReadingReturn(expected: NoteReadingReturn) {
  if (journey !== expected) return
  journey = null
  for (const listener of listeners) listener()
}
export function useNoteReadingReturn(reference: WorkbenchProjectionSelection | null | undefined, surface: AppState['mainSurface']) {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  return reference && value && value.surface === surface && sameWorkbenchProjectionSelection(value.to, reference) ? value : null
}
