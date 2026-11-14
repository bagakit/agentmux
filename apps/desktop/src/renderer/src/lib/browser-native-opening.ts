import { knowledgeSurfacePresented } from './knowledge-surface-navigation'
import type { BrowserEvent } from '../../../shared/contracts'
import type { WorkbenchReturnContext } from '../../../shared/workbench-windows'
import { readWorkbenchReturnContext } from '../../../shared/workbench-windows'
import type { AppState } from '../store'
import { mainRegionReference } from './desktop-focus-navigation'
import { workbenchNavigationStamp } from './workbench-window-registry'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from './workbench-projection'
import { isSurveyPage } from './survey-page-references'
import { surveySelectReference } from './survey-workface'
import { admitPreparedSurveyPage } from './survey-profile-binding'

type Opening = Extract<BrowserEvent, { type: 'native-opened' }>
type OpeningState = Pick<AppState, 'tabs' | 'mainSurface' | 'workbenchSpaceSelection' | 'surveyZoneSelection' |
  'surveyProfileView' | 'surveyPageReferences' | 'registerSurveyBrowserPage' | 'setSurveyPageCollected' | 'reportError'>

/** Later selection is a fence, never evidence of the original triggering surface. */
export function nativeOpeningSourceSelected(state: OpeningState, context: WorkbenchReturnContext | null): boolean {
  if (!context) return false
  if (context.surface !== 'survey') return state.mainSurface === (context.surface === 'focus' ? 'agents' : 'workbench') &&
    sameWorkbenchProjectionSelection(mainRegionReference(state.workbenchSpaceSelection), context.reference)
  if (!knowledgeSurfacePresented(state.mainSurface, 'survey')) return false
  const selected = state.surveyZoneSelection
  if (isSurveyPage(selected)) return 'kind' in context.selection && context.selection.kind === 'page' &&
    selected.regionId === context.selection.regionId && selected.browserId === context.selection.browserId &&
    (!selected.presentation || sameWorkbenchProjectionSelection(selected.presentation, context.reference))
  return !!selected && !('kind' in context.selection) && selected.zoneId === context.selection.zoneId &&
    selected.active?.tabId === context.reference.tabId && selected.active.regionId === context.reference.regionId
}

/** Reposition one existing scene's selection; this neither copies a layout nor creates a page. */
export function nativeOpeningDestinationContext(context: WorkbenchReturnContext | null, target: WorkbenchProjectionSelection,
  browserId: string, destination: 'window' | 'tab' | 'region'): WorkbenchReturnContext | null {
  if (!context) return null
  if (context.surface !== 'survey') return readWorkbenchReturnContext({ ...context, reference: target,
    view: destination === 'region' ? 'tab' : context.view })
  const selected = context.selection
  if ('zoneId' in selected) return readWorkbenchReturnContext({ surface: 'survey', reference: target, selection: surveySelectReference(selected, target) })
  return readWorkbenchReturnContext({ surface: 'survey', reference: target,
    selection: destination === 'region'
      ? { ...selected, presentation: { kind: 'tab', ...target } }
      : { kind: 'page', regionId: target.regionId, browserId } })
}

/** Complete only this original native child's display and weak Survey admission. No navigation is replayed. */
export async function finishNativeBrowserOpening(ports: {
  get(): OpeningState
  checkpoint(): Promise<void>
  openWindow(target: WorkbenchProjectionSelection, context: WorkbenchReturnContext | null, shouldFocus?: () => boolean): Promise<void>
  reveal(context: WorkbenchReturnContext, stillCurrent: () => boolean): Promise<void>
}, event: Opening, target: WorkbenchProjectionSelection, destination: 'window' | 'tab' | 'region'): Promise<void> {
  const original = ports.get(), context = event.opening?.context ?? null
  const selected = nativeOpeningSourceSelected(original, context), profileView = original.surveyProfileView, navigation = workbenchNavigationStamp()
  const current = () => selected && nativeOpeningSourceSelected(ports.get(), context) &&
    (context?.surface !== 'survey' || ports.get().surveyProfileView === profileView) &&
    (context?.surface !== 'focus' || workbenchNavigationStamp() === navigation)
  const kept = () => {
    const surface = ports.get().tabs[target.tabId]?.regions[target.regionId]
    return surface?.kind === 'browser' && surface.browserId === event.browser.id
  }
  const report = (message: unknown) => ports.get().reportError(message instanceof Error ? message : new Error(String(message)),
    { kind: 'indeterminate', event: { source: 'spatial', key: `native-browser-save:${event.browser.id}` } })
  // An unavailable save does not remove an already-created healthy page or authorize another request.
  void ports.checkpoint().catch(report)
  if (!kept()) return
  const returnContext = nativeOpeningDestinationContext(context, target, event.browser.id, destination)
  if (context?.surface === 'survey' && 'kind' in context.selection && context.selection.kind === 'page' && destination !== 'region') {
    void admitPreparedSurveyPage(ports.get, { regionId: target.regionId, browserId: event.browser.id },
      event.browser, original.surveyPageReferences).then(({ admission }) => {
      if (admission.outcome === 'unknown' || admission.outcome === 'partial') report(admission.issues.map(issue => issue.message + ' ' + issue.recovery).join(' '))
    }).catch(report)
  }
  if (!kept()) return
  if (destination === 'window') {
    await ports.openWindow(target, returnContext, event.opening?.foreground && context ? current : undefined)
    return
  }
  if (!returnContext || !current()) return
  if (event.opening?.foreground) { await ports.reveal(returnContext, current); return }
  // A new split must be visible in the same selected workface, while keeping its original caret/input.
  if (destination === 'region' && context) {
    const retained = nativeOpeningDestinationContext(context, context.reference, event.browser.source?.browserId ?? '', 'region')
    if (retained) await ports.reveal(retained, current)
  }
}
