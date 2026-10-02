import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { X } from 'lucide-react'
import { FileSurfaceView } from '../../../src/renderer/src/components/FileSurfaceView'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../../../src/renderer/src/lib/workbench-tabs'
import type { WorkspaceFileReadResult, WorkspaceFileWriteResult } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/workbench.css'
import '../../../src/renderer/src/styles/file-preview.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/full-page-loading.css'
import '@agentmux/client-ui/styles/interaction.css'
import '@agentmux/client-ui/styles/markdown.css'
const workspace = { id: 'ordinary-files', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("fixture/project"), kind: 'folder' as const }
const path = 'notes/preferences.txt', id = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(id), key = documentKey(workspace.id, path)
const surface = { kind: 'file' as const, workspaceId: workspace.id, path, regionId }
const tab = createWorkbenchTab(id, surface)
const original = 'Writing preferences\n\nKeep explanations brief.\nKeep the source with each decision.\n'
let disk = { path, content: original, revision: 'revision-original' }, writeOutcome: 'written' | 'unknown' = 'written'
let readOutcome: WorkspaceFileReadResult | null = null, writes = 0, reads = 0
api.files.write = async (_workspace, input): Promise<WorkspaceFileWriteResult> => {
  writes++; disk = { path, content: input.content, revision: 'revision-written-' + writes }
  return writeOutcome === 'unknown' ? { status: 'unknown', code: 'RECEIPT_LOST', message: 'The write receipt was lost.' } : { status: 'written', revision: disk.revision }
}
api.files.read = async (): Promise<WorkspaceFileReadResult> => { reads++; return readOutcome ?? { status: 'read', document: { ...disk } } }
function reset() {
  disk = { path, content: original, revision: 'revision-original' }; writes = 0; reads = 0; readOutcome = null; writeOutcome = 'written'
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('group', [id]) },
    documents: { [key]: { ...disk } }, dirtyDocuments: {}, documentGenerations: {}, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {}, editorRegionModes: {} })
}
reset()
const fixture = {
  reset,
  loseReceipt() { writeOutcome = 'unknown' },
  failCheck() { readOutcome = { status: 'error', code: 'EIO', message: 'The file could not be read. Try checking again.' } },
  recoverCheck() { readOutcome = null },
  conflict() { readOutcome = { status: 'read', document: { path, content: 'A different writer changed this file.\n', revision: 'revision-external' } } },
  width(value: number) { document.querySelector<HTMLElement>('.workbench-region')!.style.width = value + 'px' },
  facts() { const state = useAppStore.getState(); return { document: state.documents[key], issue: state.documentIssues[key], dirty: state.dirtyDocuments[key], saving: state.savingDocuments[key], disk, writes, reads, tabPreserved: state.tabs[id] === tab, monaco: '__agentmuxFileEditingProbe' in window } }
}
Object.assign(window, { fileSaveRecovery: fixture })
createRoot(document.getElementById('root')!).render(<><WindowOverlayHost /><div style={{ height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
  <div className="workbench-region" style={{ width: 'min(820px, 100%)', height: '100%', minHeight: 0, position: 'relative' }}>
    <FileSurfaceView tabId={id} surface={surface} />
    <button className="workbench-region__close icon-button" aria-label="Close file Region" title="Close file Region" onClick={() => useAppStore.getState().closeRegion(workspace.id, id, regionId)}><X size={12} /></button>
  </div>
</div></>)
