import { SurveyCompositionCheckbox } from './SurveyCompositionCheckbox'
import type { SurveyCompositionSelectionControl } from '../lib/survey-composition-drag'
import { useDroppable } from '@dnd-kit/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import type { AgentMuxSurveyPageReference } from '@agentmux/core/control'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { surveyContentKey, useSurveyContentDrag, type SurveyPageDrop } from '../lib/survey-composition-drag'

const BrowserIcon = semanticIconComponent('object.browser')
/** One saved reference, distinct from every sibling in its original project or Tab. */
export function SurveyPageItem({ page, browser, selected, enabled, actions, onSelect, selection }: {
  selection?: SurveyCompositionSelectionControl | undefined
  page: AgentMuxSurveyPageReference; browser: BrowserWorkbenchSurface | null; selected: boolean; enabled: boolean; actions: ReactNode; onSelect(): void
}) {
  const reference = { kind: 'page' as const, ...page }, title = browser?.title || 'Retained page'
  const drag = useSurveyContentDrag(reference, enabled && Boolean(browser), { title, icon: <span className="survey-page-favicon"><BrowserIcon size={14} />{browser?.faviconDataUrl ? <img src={browser.faviconDataUrl} alt="" /> : null}</span> })
  const drop = useDroppable({ id: 'survey-page-target:' + surveyContentKey(reference), disabled: !enabled || !browser,
    data: { kind: 'page-target', reference } satisfies SurveyPageDrop })
  return <div ref={drop.setNodeRef} className="survey-item-row" data-survey-page-region-id={page.regionId} data-survey-page-browser-id={page.browserId}
    data-selected={selected} data-selectable={Boolean(selection) || undefined} data-compose-over={drop.isOver || undefined} data-content-dragging={drag.isDragging || undefined}>
    {selection ? <SurveyCompositionCheckbox selection={selection} label={`Select page: ${title}`} /> : null}
    <button ref={drag.setNodeRef} type="button" className="survey-item" {...drag.attributes} {...drag.listeners}
      data-survey-content-key={surveyContentKey(reference)} aria-label={`Show survey page: ${title}`} onClick={onSelect}>
      <span className="survey-item-glyph" aria-hidden="true"><span className="survey-page-favicon"><BrowserIcon size={16} />{browser?.faviconDataUrl
        ? <img key={browser.faviconDataUrl} src={browser.faviconDataUrl} alt="" onError={event => { event.currentTarget.hidden = true }} /> : null}</span></span><strong>{title}</strong>
    </button>
    <div className="survey-item-shortcuts">{actions}</div>
    {drop.isOver ? <span className="survey-compose-cue" aria-hidden="true">Combine into new research</span> : null}
    {!browser ? <span role="status" className="survey-relation-notice">The original Browser is unconfirmed. Its exact reference is kept.</span> : null}
  </div>
}
