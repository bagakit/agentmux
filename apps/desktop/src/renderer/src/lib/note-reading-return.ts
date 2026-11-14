import { useSyncExternalStore } from 'react'
import type { NoteFileTarget } from './file-document-consumers'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { sameWorkbenchProjectionSelection } from './workbench-projection'
import { knowledgeSurfacePresented } from './knowledge-surface-navigation'
import type { AppState } from '../store'

export type NoteReadingReturn = { from: WorkbenchProjectionSelection; to: WorkbenchProjectionSelection; original: NoteFileTarget; title: string; surface: AppState['mainSurface'] }
/** Check the original navigation owner after selecting an exact, already validated occurrence. */
export function noteReadingReferenceIsSelected(state: Pick<AppState, 'mainSurface' | 'recallZoneSelection' | 'surveyZoneSelection' | 'workbenchSpaceSelection'>, reference: WorkbenchProjectionSelection, surface = state.mainSurface): boolean {
  if (surface === 'recall' || surface === 'survey') {
    if (!knowledgeSurfacePresented(state.mainSurface, surface)) return false
    const active = (surface === 'recall' ? state.recallZoneSelection : state.surveyZoneSelection)?.active
    return active?.tabId === reference.tabId && active.regionId === reference.regionId
  }
  const selected = state.workbenchSpaceSelection
  return Boolean(state.mainSurface === surface && selected && selected.workspaceId === reference.displayWorkspaceId && selected.groupId === reference.groupId && selected.tabId === reference.tabId && selected.regionId === reference.regionId)
}
const journeys = new Map<AppState['mainSurface'], NoteReadingReturn>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function rememberNoteReadingReturn(next: NoteReadingReturn) {
  if (sameWorkbenchProjectionSelection(next.from, next.to)) return
  const journey = journeys.get(next.surface)
  journeys.set(next.surface, journey && sameWorkbenchProjectionSelection(journey.to, next.from) ? { ...journey, to: next.to } : next)
  for (const listener of listeners) listener()
}
export function clearNoteReadingReturn(expected: NoteReadingReturn) {
  if (journeys.get(expected.surface) !== expected) return
  journeys.delete(expected.surface)
  for (const listener of listeners) listener()
}
export function useNoteReadingReturn(reference: WorkbenchProjectionSelection | null | undefined, surface: AppState['mainSurface']) {
  const snapshot = () => journeys.get(surface)
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  return reference && value && value.surface === surface && sameWorkbenchProjectionSelection(value.to, reference) ? value : null
}
