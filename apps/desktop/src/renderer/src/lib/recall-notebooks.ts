import type { Notebook, NotebookPage, NoteResource } from '@agentmux/core/notebook-catalog'
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

export type NotePageOpenOrigin = { reference: WorkbenchProjectionSelection; space: NonNullable<WorkbenchTab['space']>; projection?: WorkbenchProjection;
  onResult?: import('./file-workbench-state').FileOpenPlacement['onResult']; onPlaced?(reference: WorkbenchProjectionSelection): void }

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
export async function openNotebookPage(page: NotebookPage, onSelectReference?: (reference: WorkbenchProjectionSelection) => void, selectedReference?: WorkbenchProjectionSelection | null, target?: NoteBlockTarget, origin?: NotePageOpenOrigin, signal?: AbortSignal): Promise<boolean> {
  return openNotebookFile(page, onSelectReference, selectedReference, target, origin, signal)
}

/** Shared Markdown uses the same original file and workface navigation as a catalog page. */
export async function openNotebookFile(page: Pick<NotebookPage, 'noteId' | 'resource' | 'workface'>, onSelectReference?: (reference: WorkbenchProjectionSelection) => void, selectedReference?: WorkbenchProjectionSelection | null, target?: NoteBlockTarget, origin?: NotePageOpenOrigin, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  if (target && target.noteId !== page.noteId) throw new Error('The requested block belongs to another Note. The original page is kept; choose its exact source.')
  return openNotebookResource(page, onSelectReference, selectedReference, target ? { line: 1, noteBlock: target } : undefined, origin, signal, async () => {
    const observed = await api.files.read(page.resource.workspaceId, page.resource.path)
    if (signal?.aborted) return
    const read = observed.status === 'read' ? readNoteDocument(observed.document.content) : null
    if (read?.status !== 'valid' || read.note.noteId !== page.noteId) throw new Error('The original Note file could not be confirmed. Its directory entry and sources are kept; reconnect or restore this same file.')
  }, true)
}

/** Attachments retain the same Files owner without claiming a Note identity. */
export function openNotebookAttachment(resource: NoteResource, workface: NonNullable<Notebook['workface']>, onSelectReference?: (reference: WorkbenchProjectionSelection) => void, selectedReference?: WorkbenchProjectionSelection | null, location?: { line: number; column?: number }, signal?: AbortSignal, origin?: NotePageOpenOrigin): Promise<boolean> {
  return openNotebookResource({ resource, workface }, onSelectReference, selectedReference, location, origin, signal)
}

async function openNotebookResource(page: Pick<NotebookPage, 'resource' | 'workface'>, onSelectReference?: (reference: WorkbenchProjectionSelection) => void, selectedReference?: WorkbenchProjectionSelection | null, location?: { line: number; column?: number; noteBlock?: NoteBlockTarget }, origin?: NotePageOpenOrigin, signal?: AbortSignal, confirm?: () => Promise<void>, openAsText?: boolean): Promise<boolean> {
  if (signal?.aborted) return false
  const before = useAppStore.getState()
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
  if (confirm) await confirm()
  if (signal?.aborted) return false
  if (matches.length && !reference) throw new Error('This page is already open in multiple locations. Choose its Tab in the work surface, then reopen from this Notebook. Your page and all locations are kept.')
  const current = useAppStore.getState()
  if (signal?.aborted || current.mainSurface !== before.mainSurface) return false
  if (origin && fileNavigationSelection(current) !== heldNavigation) return false
  if (current.recallNotebookId !== heldBook || current.recallNoteId !== heldNote || current.recallZoneSelection !== heldSelection) return false
  const groupId = reference?.groupId ?? origin?.reference.groupId ?? current.prepareWorkbenchLayout(displayWorkspaceId).activeGroupId
  const projection: WorkbenchProjection = { entity: { kind: 'zone', zoneId: zone.zoneId }, presentationId: 'recall-workbench',
    displayWorkspaceId, catalog: catalogNow(), selection: [], onSelect(reference) {
      const now = useAppStore.getState()
      if (now.mainSurface === 'recall' && now.recallNotebookId === heldBook && now.recallNoteId === heldNote && now.recallZoneSelection === heldSelection)
        { now.setRecallZoneSelection(surveySelectReference(initial, reference)); onSelectReference?.(reference) }
    } }
  // Presentation may be scoped to the source Region. An existing destination must
  // carry its own exact scope while retaining the original navigation owner.
  const targetProjection: WorkbenchProjection | undefined = origin?.projection && reference ? {
    ...origin.projection, displayWorkspaceId, selection: [reference],
    entity: origin.projection.entity.kind === 'zone' ? origin.projection.entity
      : origin.projection.entity.kind === 'tab' ? { kind: 'tab', tabId: reference.tabId }
        : { kind: 'region', regionId: reference.regionId }
  } : origin?.projection
  return current.openFile(page.resource.path, groupId, location, page.resource.workspaceId, openAsText,
    { displayWorkspaceId, ...(reference ? { reference } : {}), space: { zoneId: zone.zoneId, spaceId: zoneContext(current, scratchTopicsForWorkspace(current.scratchTopicSnapshots, current.config?.workspaces.find(w => w.id === SCRATCH_WORKSPACE_ID)) ?? [], zone) },
      resource: { hostId: page.resource.hostId, path: page.resource.workspacePath }, ...(origin ? { ...(targetProjection ? { projection: targetProjection } : {}),
        ...(origin.onResult || origin.onPlaced ? { onResult(result) {
          const placed = result.placement
          if ((placed.status === 'created' || placed.status === 'reused') && placed.tabId && placed.regionId)
            origin.onPlaced?.({ displayWorkspaceId, groupId, tabId: placed.tabId, regionId: placed.regionId })
          origin.onResult?.(result)
        } } : {}) } : { projection }) }, signal)
}
