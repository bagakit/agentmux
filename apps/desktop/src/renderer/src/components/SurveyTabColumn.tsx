import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { documentKey, titleWorkbenchSurface, type WorkbenchTab } from '../lib/workbench-tabs'
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

/** The same Tab naming owner as the workbench, scoped to this Tab's Sessions. */
export function SurveyTabColumn({ tab, selected, onSelect }: { tab: WorkbenchTab; selected: boolean; onSelect(): void }) {
  const sessions = useWorkbenchTabSessions(tab)
  const metadata = useWorkbenchTabNameMetadata(tab)
  const names = useWorkbenchTabRecord('agentNames', tab)
  const timelines = useWorkbenchTabRecord('timelines', tab)
  const config = useAppStore(state => state.config)
  const surface = titleWorkbenchSurface(tab)
  const document = useAppStore(state => surface.kind === 'file' ? state.documents[documentKey(surface.workspaceId, surface.path)] : undefined)
  const noteName = useNoteFileName(surface.kind === 'file' ? surface.workspaceId : undefined, surface.kind === 'file' ? surface.path : undefined)
  const title = workbenchTabDisplayName(tab, sessions, names, timelines, metadata, noteName)
  const marks = workbenchTabMarks(tab, tabMarkAgentFactsFor(sessions, config?.executors, config?.appearance.agentAvatars))
  const Icon = surface.kind === 'file' ? document && parseNoteFile(document).status === 'valid' ? NoteIcon : FileIcon : BrowserIcon
  const customPrimary = surface.kind === 'browser' || surface.kind === 'file'
  return <button type="button" className="survey-tab-column" data-survey-tab-id={tab.id} aria-label={`Show survey tab: ${title}`}
    aria-current={selected ? 'true' : undefined} title={title} onClick={onSelect}>
    <span className="survey-tab-column__marks" aria-hidden="true">
      {customPrimary ? <span className="survey-page-favicon"><Icon size={16} />{surface.kind === 'browser' && surface.faviconDataUrl
        ? <img key={surface.faviconDataUrl} src={surface.faviconDataUrl} alt="" onError={event => { event.currentTarget.hidden = true }} /> : null}</span> : null}
      <WorkbenchTabMarks marks={customPrimary ? marks.filter(mark => mark.regionId !== surface.regionId) : marks} />
    </span>
    <span>{title}</span>
  </button>
}
