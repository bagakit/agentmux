import { SurveyCompositionCheckbox } from './SurveyCompositionCheckbox'
import type { SurveyCompositionSelectionControl } from '../lib/survey-composition-drag'
import { surveyContentKey, useSurveyContentDrag } from '../lib/survey-composition-drag'
import { workReferenceHostId } from '../lib/agent-work-mode'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { documentKey, titleWorkbenchSurface, workbenchSurfaces, type WorkbenchTab } from '../lib/workbench-tabs'
import { surveyBrowserControl } from '../lib/survey-workface'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { useWorkbenchTabNameMetadata, useWorkbenchTabRecord, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { useNoteFileName } from '../lib/note-source-name'
import { tabMarkAgentFactsFor, workbenchTabMarks } from '../lib/workbench-tab-marks'
import { WorkbenchTabMarks } from './WorkbenchTabMarks'
import { useAppStore } from '../store'
import { parseNoteFile } from '../lib/note-knowledge'

const BrowserIcon = semanticIconComponent('object.browser')
const NoteIcon = semanticIconComponent('object.note')
const FileIcon = semanticIconComponent('file.text')
const CloseIcon = semanticIconComponent('action.close')

/** The same Tab naming owner as the workbench, scoped to this Tab's Sessions. */
export function SurveyTabColumn({ tab, selected, onSelect, onClose, unconfirmedBrowserRegionIds, compositionEnabled = false, selection }: { tab: WorkbenchTab; selected: boolean; onSelect(): void; onClose(title: string): void; unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined; compositionEnabled?: boolean; selection?: SurveyCompositionSelectionControl | undefined }) {
  const reference = { kind: 'tab' as const, tabId: tab.id }
  const sessions = useWorkbenchTabSessions(tab)
  const metadata = useWorkbenchTabNameMetadata(tab)
  const names = useWorkbenchTabRecord('agentNames', tab)
  const timelines = useWorkbenchTabRecord('timelines', tab)
  const config = useAppStore(state => state.config)
  const surface = titleWorkbenchSurface(tab)
  const document = useAppStore(state => surface.kind === 'file' ? state.documents[documentKey(surface.workspaceId, surface.path)] : undefined)
  const noteName = useNoteFileName(surface.kind === 'file' ? surface.workspaceId : undefined, surface.kind === 'file' ? surface.path : undefined)
  const title = workbenchTabDisplayName(tab, sessions, names, timelines, metadata, noteName)
  const marks = workbenchTabMarks(tab, tabMarkAgentFactsFor(sessions, config?.executors, config?.appearance.agentAvatars, config ? workReferenceHostId(config.hosts) : null))
  const Icon = surface.kind === 'file' ? document && parseNoteFile(document).status === 'valid' ? NoteIcon : FileIcon : BrowserIcon
  const drag = useSurveyContentDrag(reference, compositionEnabled, { title, icon: <span className="survey-page-favicon"><Icon size={14} />{surface.kind === 'browser' && surface.faviconDataUrl ? <img src={surface.faviconDataUrl} alt="" /> : null}</span> })
  const customPrimary = surface.kind === 'browser' || surface.kind === 'file'
  const unknown = workbenchSurfaces(tab).some(region => region.kind === 'browser' && surveyBrowserControl(region, Boolean(unconfirmedBrowserRegionIds?.has(region.regionId))) === 'unknown')
  const status = unknown ? 'Page status unconfirmed · open this Tab to check' : undefined
  return <div className="survey-tab-cell" data-selectable={Boolean(selection) || undefined} data-content-dragging={drag.isDragging || undefined}>{selection ? <SurveyCompositionCheckbox selection={selection} label={`Select complete Tab: ${title}`} /> : null}<button ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} data-survey-content-key={surveyContentKey(reference)} type="button" className="survey-tab-column" data-survey-tab-id={tab.id} aria-label={`Show survey tab: ${title}`}
    aria-current={selected ? 'true' : undefined} aria-description={status} title={status ? `${title}\n${status}` : title} onClick={onSelect}>
    <span className="survey-tab-column__marks" aria-hidden="true">
      {customPrimary ? <span className="survey-page-favicon"><Icon size={16} />{surface.kind === 'browser' && surface.faviconDataUrl
        ? <img key={surface.faviconDataUrl} src={surface.faviconDataUrl} alt="" onError={event => { event.currentTarget.hidden = true }} /> : null}</span> : null}
      <WorkbenchTabMarks marks={customPrimary ? marks.filter(mark => mark.regionId !== surface.regionId) : marks} />
    </span>
    <span className="survey-tab-label"><span>{title}</span>{unknown ? <span className="survey-status-label" aria-hidden="true">Unconfirmed</span> : null}</span>
  </button><button type="button" className="survey-tab-close" aria-label={`Close survey tab: ${title}`} title={`Close ${title}`}
    onClick={() => onClose(title)}><CloseIcon size={12} /></button></div>
}
