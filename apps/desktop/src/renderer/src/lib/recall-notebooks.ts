import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'
import { fileNavigationSelection, useAppStore } from '../store'
import { api } from './api'
import { changeNotebook, notebookPageResourceMatches } from './notebook-library'
import { spatialCatalog, zoneContext } from './space-agent-control'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { surveyInitialZoneSelection, surveySelectReference } from './survey-workface'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { readNoteDocument, type NoteBlockTarget } from '../../../shared/note-document'
import type { WorkbenchProjection, WorkbenchProjectionSelection } from './workbench-projection'
import { sameWorkbenchProjectionSelection } from './workbench-projection'
import type { WorkbenchTab } from './workbench-tabs'

export type NotePageOpenOrigin = { reference: WorkbenchProjectionSelection; space: NonNullable<WorkbenchTab['space']>; projection?: WorkbenchProjection }

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
export async function openNotebookPage(page: NotebookPage, onSelectReference?: (reference: WorkbenchProjectionSelection) => void, selectedReference?: WorkbenchProjectionSelection | null, target?: NoteBlockTarget, origin?: NotePageOpenOrigin): Promise<boolean> {
  const before = useAppStore.getState()
  if (target && target.noteId !== page.noteId) throw new Error('The requested block belongs to another Note. The original page is kept; choose its exact source.')
  if (!notebookPageResourceMatches(page, before.config)) throw new Error('The Note’s original Host or folder is unavailable. Its page and history are kept; reconnect this resource.')
  const catalog = catalogNow(), zone = catalog.zones.find(z => z.zoneId === (origin?.space.zoneId ?? page.workface?.zoneId))
  if (!zone) throw new Error('This page’s work surface is unavailable. Its saved Note and history remain in this Notebook.')
  const layout = before.layouts[origin?.reference.displayWorkspaceId ?? page.resource.workspaceId]
  const matches = catalog.locations.filter(location => {
    const region = before.tabs[location.tabId]?.regions[location.regionId]
    return location.zoneId === zone.zoneId && region?.kind === 'file' && region.workspaceId === page.resource.workspaceId && region.path === page.resource.path
  })
  const inCurrentGroup = matches.filter(location => location.displayWorkspaceId === (origin?.reference.displayWorkspaceId ?? page.resource.workspaceId) && location.groupId === (origin?.reference.groupId ?? layout?.activeGroupId))
  const selectedMatches = selectedReference ? matches.filter(location => sameWorkbenchProjectionSelection(location, selectedReference)) : []
  const reference = selectedMatches.length === 1 ? selectedMatches[0] : inCurrentGroup.length === 1 ? inCurrentGroup[0] : matches.length === 1 ? matches[0] : undefined
  const displayWorkspaceId = reference?.displayWorkspaceId ?? origin?.reference.displayWorkspaceId ?? page.resource.workspaceId
  const heldBook = before.recallNotebookId, heldNote = before.recallNoteId
  const heldNavigation = fileNavigationSelection(before)
  const initial = surveyInitialZoneSelection(catalog, zone.zoneId, before.layouts, before.tabs, page.resource.workspaceId)
  // Keep an already confirmed page visible while the canonical read is pending.
  // The layout's active sibling is not an intermediate navigation destination.
  if (!origin) before.setRecallZoneSelection(reference ? surveySelectReference(initial, reference) : initial)
  const heldSelection = useAppStore.getState().recallZoneSelection
  const observed = await api.files.read(page.resource.workspaceId, page.resource.path)
  const read = observed.status === 'read' ? readNoteDocument(observed.document.content) : null
  if (read?.status !== 'valid' || read.note.noteId !== page.noteId) throw new Error('The original Note file could not be confirmed. Its directory entry and sources are kept; reconnect or restore this same file.')
  if (matches.length && !reference) throw new Error('This page is already open in multiple locations. Choose its Tab in the work surface, then reopen from this Notebook. Your page and all locations are kept.')
  const current = useAppStore.getState()
  if (origin && fileNavigationSelection(current) !== heldNavigation) return false
  if (current.recallNotebookId !== heldBook || current.recallNoteId !== heldNote || current.recallZoneSelection !== heldSelection) return false
  const groupId = reference?.groupId ?? origin?.reference.groupId ?? current.prepareWorkbenchLayout(displayWorkspaceId).activeGroupId
  const projection: WorkbenchProjection = { entity: { kind: 'zone', zoneId: zone.zoneId }, presentationId: 'recall-workbench',
    displayWorkspaceId, catalog: catalogNow(), selection: [], onSelect(reference) {
      const now = useAppStore.getState()
      if (now.mainSurface === 'recall' && now.recallNotebookId === heldBook && now.recallNoteId === heldNote && now.recallZoneSelection === heldSelection)
        { now.setRecallZoneSelection(surveySelectReference(initial, reference)); onSelectReference?.(reference) }
    } }
  return current.openFile(page.resource.path, groupId, target ? { line: 1, noteBlock: target } : undefined, page.resource.workspaceId, true,
    { displayWorkspaceId, ...(reference ? { reference } : {}), space: { zoneId: zone.zoneId, spaceId: zoneContext(current, scratchTopicsForWorkspace(current.scratchTopicSnapshots, current.config?.workspaces.find(w => w.id === SCRATCH_WORKSPACE_ID)) ?? [], zone) },
      resource: { hostId: page.resource.hostId, path: page.resource.workspacePath }, ...(origin ? { ...(origin.projection ? { projection: origin.projection } : {}) } : { projection }) })
}
