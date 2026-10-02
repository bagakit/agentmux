import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'
import { useAppStore } from '../store'
import { api } from './api'
import { changeNotebook, notebookPageResourceMatches } from './notebook-library'
import { spatialCatalog, zoneContext } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { surveyInitialZoneSelection, surveySelectReference } from './survey-workface'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { readNoteDocument } from '../../../shared/note-document'
import type { WorkbenchProjection } from './workbench-projection'

function catalogNow() {
  const state = useAppStore.getState()
  return spatialCatalog(state, scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(w => w.id === SCRATCH_WORKSPACE_ID)) ?? [])
}
/** A Notebook's workface is the original shared Zone, created only when content is added. */
export async function prepareNotebookWorkface(notebook: Notebook, workspaceId: string, onPrepared?: (workface: { zoneId: string; workspaceId: string }) => void) {
  if (notebook.workface) return notebook.workface
  const created = await useAppStore.getState().createWorkbenchZone({ workspaceId, spaceIds: [] })
  const workface = { zoneId: created.zone.zoneId, workspaceId }
  onPrepared?.(workface)
  await changeNotebook({ kind: 'bind', notebookId: notebook.notebookId, workface }, 'notebook-workface:' + notebook.notebookId + ':' + workface.zoneId)
  return workface
}
/** Closing a page never loses this resource. Reopening uses the same file and original workbench. */
export async function openNotebookPage(page: NotebookPage): Promise<boolean> {
  const before = useAppStore.getState()
  if (!notebookPageResourceMatches(page, before.config)) throw new Error('The Note’s original Host or folder is unavailable. Its page and history are kept; reconnect this resource.')
  const catalog = catalogNow(), zone = catalog.zones.find(z => z.zoneId === page.workface?.zoneId)
  if (!zone || zone.workspaceId !== page.resource.workspaceId) throw new Error('This page’s work surface is unavailable. Its saved Note and history remain in this Notebook.')
  const layout = before.layouts[page.resource.workspaceId]
  if (!layout) throw new Error('This Note’s work surface is restoring. Its saved page is kept; try opening it again.')
  const groupId = layout.activeGroupId, heldBook = before.surveyNotebookId, heldNote = before.surveyNoteId
  const initial = surveyInitialZoneSelection(catalog, zone.zoneId, before.layouts, before.tabs, page.resource.workspaceId)
  before.setSurveyZoneSelection(initial)
  const heldSelection = useAppStore.getState().surveyZoneSelection
  const observed = await api.files.read(page.resource.workspaceId, page.resource.path)
  const read = observed.status === 'read' ? readNoteDocument(observed.document.content) : null
  if (read?.status !== 'valid' || read.note.noteId !== page.noteId) throw new Error('The original Note file could not be confirmed. Its directory entry and sources are kept; reconnect or restore this same file.')
  const current = useAppStore.getState()
  if (current.surveyNotebookId !== heldBook || current.surveyNoteId !== heldNote || current.surveyZoneSelection !== heldSelection) return false
  const projection: WorkbenchProjection = { entity: { kind: 'zone', zoneId: zone.zoneId }, presentationId: 'survey-workbench',
    displayWorkspaceId: page.resource.workspaceId, catalog: catalogNow(), selection: [], onSelect(reference) {
      const now = useAppStore.getState()
      if (now.mainSurface === 'survey' && now.surveyNotebookId === heldBook && now.surveyNoteId === heldNote && now.surveyZoneSelection === heldSelection)
        now.setSurveyZoneSelection(surveySelectReference(initial, reference))
    } }
  return current.openFile(page.resource.path, groupId, undefined, page.resource.workspaceId, true,
    { displayWorkspaceId: page.resource.workspaceId, space: { zoneId: zone.zoneId, spaceId: zoneContext(current, [], zone) },
      resource: { hostId: page.resource.hostId, path: page.resource.workspacePath }, projection })
}
