import type { MainSurface } from '../store'
import type { WorkbenchBrowserPresentation } from '../components/BrowserPresentationStage'
import type { SurveyZoneSelection } from './survey-workface'

type SelectionState = {
  mainSurface: MainSurface
  layouts: Readonly<Record<string, { activeGroupId: string } | undefined>>
  surveyZoneSelection: SurveyZoneSelection | null
}

/** A Tab projection displays its Browser siblings independently of the focused Region. */
export function selectedBrowserPresentationId(presentations: readonly WorkbenchBrowserPresentation[], state: SelectionState): string | null {
  const selected = presentations.filter(({ target, occurrence, visible, active }) => {
    const reference = target.reference, location = occurrence.location
    if (!visible || !active || !reference || reference.displayWorkspaceId !== location.displayWorkspaceId ||
      reference.groupId !== location.groupId || reference.tabId !== location.tabId) return false
    if (target.surface === 'space') return state.mainSurface === 'workbench' &&
      state.layouts[location.displayWorkspaceId]?.activeGroupId === location.groupId
    const scope = target.projection?.entity
    const included = scope?.kind === 'tab' ? scope.tabId === location.tabId
      : scope?.kind === 'zone' ? true
        : scope?.kind === 'region' && scope.regionId === location.regionId && reference.regionId === location.regionId
    if (!included) return false
    if (target.surface === 'survey') return state.mainSurface === 'survey'
    return target.surface === 'focus' && state.mainSurface === 'agents'
  })
  const current = state.mainSurface === 'survey' ? state.surveyZoneSelection?.active : null
  const explicit = current ? selected.filter(presentation => presentation.target.surface === 'survey' &&
    presentation.occurrence.location.tabId === current.tabId) : []
  return explicit.length === 1 ? explicit[0]!.occurrence.presentationId : selected.length === 1 ? selected[0]!.occurrence.presentationId : null
}
