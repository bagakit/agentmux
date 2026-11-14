import { readWorkbenchReturnContext, type WorkbenchReturnContext, type WorkbenchReturnReference, type WorkbenchReturnSelection } from '../../../shared/workbench-windows'
import type { WorkbenchPresentation } from './workbench-presentation'
import { surveySelectReference } from './survey-workface'

/** The original presentation owner supplies provenance; current global focus is not an origin. */
export function workbenchReturnContext(presentation: Pick<WorkbenchPresentation, 'surface' | 'survey' | 'projection' | 'reference' | 'returnContext'> & {
  returnSelection?: WorkbenchReturnSelection | undefined
}, reference: WorkbenchReturnReference | undefined = presentation.reference): WorkbenchReturnContext | null {
  if (!reference) return null
  const frozen = presentation.returnContext === undefined ? undefined : readWorkbenchReturnContext(presentation.returnContext)
  if (frozen === null) return null
  const surface = frozen?.surface ?? presentation.surface ?? (presentation.survey ? 'survey' : !presentation.projection ? 'space' : undefined)
  if (surface === 'space' || surface === 'focus') return readWorkbenchReturnContext({ surface, reference,
    view: frozen && frozen.surface !== 'survey' ? frozen.view : presentation.projection?.entity.kind === 'region' ? 'region' : 'tab' })
  const original = frozen?.surface === 'survey' ? frozen.selection : presentation.returnSelection
  if (surface !== 'survey' || !original) return null
  const selection = 'zoneId' in original ? surveySelectReference(original, reference)
    : original.presentation ? { ...original, presentation: { kind: 'tab', ...reference } }
      : original.regionId === reference.regionId ? original : null
  return selection ? readWorkbenchReturnContext({ surface, reference, selection }) : null
}
