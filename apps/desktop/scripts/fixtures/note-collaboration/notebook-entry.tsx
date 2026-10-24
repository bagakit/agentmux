import { StrictMode, useCallback, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import { GlobalRecallSurface } from '../../../src/renderer/src/components/GlobalRecallSurface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { observeNotebookLibrary, refreshNotebookLibrary, useNotebookLibrary } from '../../../src/renderer/src/lib/notebook-library'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { projectWorkbenchProjection, resolveWorkbenchZone, workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from '../../../src/renderer/src/lib/workbench-projection'
import { surveyResolvedZoneSelection, surveySelectReference } from '../../../src/renderer/src/lib/survey-workface'
import type { WorkbenchViewTargets } from '../../../src/renderer/src/lib/workbench-presentation'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import '../../../src/renderer/src/styles/index.css'

// Transport replacement only: page creation, binding, registration, navigation, document
// sessions, history and presentation all remain at their original product owners.
Object.assign(window, { __noteErrors: [] })
window.addEventListener('error', event => (window as any).__noteErrors.push({ message: event.message, stack: event.error?.stack }))
window.addEventListener('unhandledrejection', event => (window as any).__noteErrors.push({ message: String(event.reason), stack: event.reason?.stack }))
async function invoke(method: string, ...args: unknown[]) {
  const response = await fetch('/__note/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const result = await response.json()
  if (!response.ok) throw Object.assign(Error(result.error.message), { code: result.error.code })
  return result.value
}
const original = await invoke('bootstrap')
if (original.mode !== 'notebook') throw Error('Start the private Host with explicit Notebook mode; no default workface is repurposed')
const invalidations = new Set<(event: any) => void>(), spatial = new Set<(value: any) => void>(), notebooks = new Set<(value: any) => void>()
const appearance = new URLSearchParams(location.search).get('appearance')
const stopTheme = mountThemeRuntime(window, { ...original.config.appearance, ...(appearance === 'light' || appearance === 'dark' ? { appAppearance: appearance } : {}) })
const events = new EventSource('/__note/events')
events.onmessage = event => {
  const value = JSON.parse(event.data), listeners = value.channel === 'file' ? invalidations : value.channel === 'notebook' ? notebooks : null
  if (listeners) for (const listener of listeners) listener(value.value)
}
api.config.get = () => invoke('config.get')
api.spatial.read = () => invoke('spatial.read')
api.spatial.commit = async input => { const value = await invoke('spatial.commit', input); for (const listener of spatial) listener(value); return value }
api.spatial.retainLabels = input => invoke('spatial.retainLabels', input)
api.spatial.onChange = listener => { spatial.add(listener); return () => { spatial.delete(listener) } }
api.notesStorage.inspect = () => invoke('notes.inspect')
api.notebooks.read = () => invoke('notebooks.read')
api.notebooks.apply = input => invoke('notebooks.apply', input)
api.notebooks.onChange = listener => { notebooks.add(listener); return () => { notebooks.delete(listener) } }
api.notebooks.actor = async () => original.actor
api.notebooks.graph = input => invoke('notebooks.graph', input)
api.notebooks.content = noteId => invoke('notebooks.content', noteId)
api.notebooks.resolve = input => invoke('notebooks.resolve', input)
for (const method of ['read', 'write', 'readDirectory', 'list', 'observe', 'unobserve'] as const) (api.files[method] as any) = (...args: unknown[]) => invoke(method, ...args)
for (const [method, rpc] of [['readPublic', 'file.read'], ['createPublic', 'file.create'], ['historyPublic', 'file.history'], ['restorePublic', 'file.restore'], ['undoPublic', 'file.undo']] as const) api.files[method] = input => invoke('rpc', rpc, input)
api.files.sharePublic = input => invoke('sharePublic', input)
api.files.shareUndoPublic = input => invoke('shareUndoPublic', input)
api.files.inspectSharePublic = input => invoke('inspectSharePublic', input)
api.files.onInvalidated = listener => { invalidations.add(listener); return () => { invalidations.delete(listener) } }
api.ui.requestStorageFlush = () => invoke('storage.flush', localStorage.getItem('agentmux-workbench-v1'))
const ready = await useAppStore.getState().initialize()
const stopLibrary = observeNotebookLibrary()
await refreshNotebookLibrary()
useAppStore.getState().setMainSurface('recall')

function currentPage() {
  const state = useAppStore.getState(), noteId = state.recallNoteId
  return noteId ? useNotebookLibrary.getState().state?.pages[noteId] : undefined
}
Object.assign(window, { noteNotebook: {
  original,
  async facts() {
    const state = useAppStore.getState(), page = currentPage(), key = page ? documentKey(page.resource.workspaceId, page.resource.path) : null
    return { original, page, host: await invoke('facts', page?.noteId), tabs: state.tabs, layouts: state.layouts, recallZoneSelection: state.recallZoneSelection,
      spaceZoneBindings: state.spaceZoneBindings, catalog: spatialCatalog(state, []), document: key ? state.documents[key] : null,
      retained: key ? state.retainedDocumentDrafts[key] : null, issue: key ? state.documentIssues[key] : null, dirty: key ? state.dirtyDocuments[key] : null,
      error: state.error, localStorage: localStorage.getItem('agentmux-workbench-v1') }
  },
  async closeCurrentTab() {
    const state = useAppStore.getState(), held = state.recallZoneSelection, active = held?.active
    if (!active || !held) throw Error('Choose the exact original Notebook page before closing')
    const catalog = spatialCatalog(state, []), reference = catalog.locations.find(location => location.zoneId === held.zoneId && location.tabId === active.tabId && location.regionId === active.regionId)
    if (!reference) throw Error('The exact original page occurrence is not confirmed')
    return state.closeTab(reference.displayWorkspaceId, reference.groupId, reference.tabId)
  },
  async inspect() {
    const state = useAppStore.getState(), page = currentPage(), active = state.recallZoneSelection?.active
    if (!page || !active) throw Error('Choose the exact original Notebook page before reading its history')
    return state.inspectNoteHistory(active.tabId, active.regionId, page.noteId)
  },
  async flush() { await prepareRendererUpdate() },
  async openOriginalFile(path: string) {
    const state = useAppStore.getState(), held = state.recallZoneSelection, active = held?.active
    const location = active && spatialCatalog(state, []).locations.find(item => item.zoneId === held!.zoneId && item.tabId === active.tabId && item.regionId === active.regionId)
    const binding = held && state.spaceZoneBindings[held.zoneId]
    const workspace = location && state.config?.workspaces.find(item => item.id === location.workspaceId)
    if (!held || !location || !binding || !workspace) throw Error('Select the original Notebook resource before opening its file')
    const observed: { result?: import('../../../src/renderer/src/lib/file-workbench-state').FileOpenResult } = {}
    const opened = await state.openFile(path, location.groupId, undefined, workspace.id, undefined, {
      displayWorkspaceId: location.displayWorkspaceId, space: { spaceId: binding.spaceId, zoneId: held.zoneId },
      resource: { hostId: workspace.hostId, path: workspace.path }, onResult: value => { observed.result = value }
    })
    const result = observed.result
    if (result?.placement.tabId && result.placement.regionId) useAppStore.getState().setRecallZoneSelection(surveySelectReference(held, { tabId: result.placement.tabId, regionId: result.placement.regionId }))
    return { opened, result }
  },
  dispose() { stopLibrary(); ready(); events.close(); stopTheme() }
} })

function NotebookFixture() {
  const state = useAppStore(), catalog = useMemo(() => spatialCatalog(state, []), [state.config, state.sessions, state.tabs, state.layouts, state.spaceZoneBindings])
  const held = state.recallZoneSelection
  const select = useCallback((reference: WorkbenchProjectionSelection) => {
    const current = useAppStore.getState()
    if (current.recallZoneSelection) current.setRecallZoneSelection(surveySelectReference(current.recallZoneSelection, reference))
  }, [])
  const projection = useMemo(() => {
    if (!held) return null
    const original = resolveWorkbenchZone(held.zoneId, catalog, state.layouts, state.tabs, 'recall-workbench', held.active ? [...held.selection, held.active] : held.selection, select)
    if (!original || !state.recallNoteId || !held.active || state.tabs[held.active.tabId]?.regions[held.active.regionId]?.kind !== 'file') return original
    const matches = original.selection.filter(reference => reference.tabId === held.active!.tabId && reference.regionId === held.active!.regionId)
    return matches.length === 1 ? { ...original, entity: { kind: 'region' as const, regionId: matches[0]!.regionId }, selection: matches } : original
  }, [held, catalog, state.layouts, state.tabs, state.recallNoteId, select])
  const selection = held ? surveyResolvedZoneSelection(held, projection) : null
  const targets = useMemo<WorkbenchViewTargets>(() => {
    if (!projection) return {}
    const result: Record<string, WorkbenchViewTargets[string]> = {}, projected = projectWorkbenchProjection(state.layouts[projection.displayWorkspaceId], state.tabs, projection)
    for (const reference of projected.selection) {
      if (projected.unsupportedTabIds.has(reference.tabId)) continue
      const slot = projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId
      const target = { hostId: slot(`${projection.presentationId}-slot`, reference), active: true, visible: true, surface: 'recall' as const,
        controlsOpen: false, projection: projection as WorkbenchProjection, reference, retainedRegionId: reference.regionId,
        onSelectRegion: (regionId: string) => select({ ...reference, regionId }) }
      result[reference.tabId] = [...(result[reference.tabId] ?? []), target]
    }
    return result
  }, [projection, state.layouts, state.tabs, select])
  return <DesktopClientUiProvider><WindowOverlayHost />
    <main className="workspace-main-surface" style={{ width: '100%', height: '100vh' }}>
      <GlobalRecallSurface catalog={catalog} projection={projection} selection={selection} onSelectReference={select} viewTargets={targets} />
      <div className="workspace-workbench-registry workspace-workbench-registry--parked">
        <WorkspaceWorkbench workspaceId={NOTES_WORKSPACE_ID} visible={false} viewTargets={targets} />
      </div>
    </main>
  </DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<StrictMode><NotebookFixture /></StrictMode>)
