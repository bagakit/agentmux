const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'

const fileApi = vi.hoisted(() => {
  const reads: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = []
  const observes: string[] = [], unobserves: string[] = []
  const cleanup: Array<() => void> = []
  const observation: Array<() => void> = []
  let deferObservation = false
  let deferCleanup = false
  return { reads, observes, unobserves, cleanup, observation,
    deferObserve(value: boolean) { deferObservation = value },
    defer(value: boolean) { deferCleanup = value },
    api: { files: {
      read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
      observe: async (_workspaceId: string, path: string) => {
        observes.push(path)
        if (deferObservation) await new Promise<void>(resolve => observation.push(resolve))
      },
      unobserve: async (_workspaceId: string, path: string) => {
        unobserves.push(path)
        if (deferCleanup) await new Promise<void>(resolve => cleanup.push(resolve))
      }
    } }
  }
})
vi.mock('../src/renderer/src/lib/api.js', () => ({ api: fileApi.api }))

import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()
const reportError = vi.fn()
let fixtureId = 0
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

afterEach(async () => {
  fileApi.defer(false); fileApi.deferObserve(false)
  fileApi.observation.splice(0).forEach(resolve => resolve())
  fileApi.cleanup.splice(0).forEach(resolve => resolve())
  fileApi.reads.forEach(read => read.resolve({ status: 'deleted' }))
  await tick()
  useAppStore.setState(initialState, true)
  fileApi.reads.splice(0); fileApi.observes.splice(0); fileApi.unobserves.splice(0)
  reportError.mockClear()
})

function seed() {
  const workspace: WorkspaceRecord = { id: `restore-${++fixtureId}`, name: 'Restore', hostId: 'local', path: _hygiene_fixturePath("original"), kind: 'folder' }
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const path = 'src/restored.ts', key = documentKey(workspace.id, path)
  const tabId = fileTabId(workspace.id, path)
  const tab = createWorkbenchTab(tabId, { regionId: initialWorkbenchRegionId(tabId), kind: 'file', workspaceId: workspace.id, path })
  const draftPath = 'draft.md', draftKey = documentKey(workspace.id, draftPath), draftId = fileTabId(workspace.id, draftPath)
  const draftTab = createWorkbenchTab(draftId, { regionId: initialWorkbenchRegionId(draftId), kind: 'file', workspaceId: workspace.id, path: draftPath })
  const draft = { path: draftPath, content: 'unsaved draft', revision: 'disk-draft' }
  const tabs = { [tabId]: tab, [draftId]: draftTab }, layouts = { [workspace.id]: createWorkspaceLayout('pane', [tabId, draftId]) }
  useAppStore.setState({ config, activeWorkspaceId: workspace.id, tabs, layouts, documents: { [draftKey]: draft }, dirtyDocuments: { [draftKey]: true }, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, reportError })
  const preserved = () => {
    expect(useAppStore.getState().tabs[tabId]).toBe(tab)
    expect(useAppStore.getState().layouts).toBe(layouts)
    expect(useAppStore.getState().documents[draftKey]).toBe(draft)
    expect(useAppStore.getState().dirtyDocuments[draftKey]).toBe(true)
  }
  const rebind = (field: 'hostId' | 'path', aba = false) => {
    useAppStore.setState({ config: { ...config, workspaces: [{ ...workspace, [field]: field === 'path' ? _hygiene_fixturePath("replacement") : 'other-host' }] } })
    if (aba) useAppStore.setState({ config })
  }
  return { workspace, config, path, key, tabId, tabs, layouts, preserved, rebind }
}
const read = (path: string, content = 'current') => ({ status: 'read', document: { path, content, revision: `disk-${content}` } })

describe('restored File original resource and lifetime admission', () => {
  it('restores the existing visible owner once and reuses the loaded document', async () => {
    const f = seed()
    const a = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    const b = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick()
    expect(fileApi.reads).toHaveLength(1)
    fileApi.reads[0]!.resolve(read(f.path))
    await Promise.all([a, b])
    await useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    expect(fileApi.reads).toHaveLength(1)
    expect(useAppStore.getState().documents[f.key]?.content).toBe('current')
    expect(fileApi.unobserves).toHaveLength(0)
    f.preserved()
  })

  it.each(['hostId', 'path'] as const)('rejects old success after same-ID %s rebind', async field => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); f.rebind(field)
    fileApi.reads[0]!.resolve(read(f.path, 'old-resource'))
    await old
    expect(useAppStore.getState().documents[f.key]).toBeUndefined()
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    expect(reportError).not.toHaveBeenCalled()
    f.preserved()
  })

  it.each(['read', 'binary', 'deleted', 'error', 'reject'] as const)('rejects old %s after A→B→A and permits a fresh original read', async verdict => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); f.rebind('path', true)
    if (verdict === 'reject') fileApi.reads[0]!.reject(new Error('old fault'))
    else fileApi.reads[0]!.resolve(verdict === 'read' ? read(f.path, 'old') : verdict === 'binary' ? { status: 'binary', revision: 'old', byteLength: 8 } : verdict === 'error' ? { status: 'error', code: 'OLD', message: 'old fault' } : { status: 'deleted' })
    await old
    expect(useAppStore.getState().documents[f.key]).toBeUndefined()
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    expect(reportError).not.toHaveBeenCalled()
    const fresh = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); expect(fileApi.reads).toHaveLength(2)
    fileApi.reads[1]!.resolve(read(f.path)); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('current')
    f.preserved()
  })

  it('releases the old slot and observer at rebind, before the old IPC settles', async () => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); f.rebind('hostId')
    const fresh = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick()
    expect(fileApi.reads).toHaveLength(2)
    expect(fileApi.unobserves).toEqual([f.path])
    fileApi.reads[0]!.reject(new Error('obsolete'))
    await old
    expect(fileApi.unobserves).toEqual([f.path])
    expect(reportError).not.toHaveBeenCalled()
    fileApi.reads[1]!.resolve(read(f.path, 'replacement')); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('replacement')
    f.preserved()
  })

  it.each(['binary', 'deleted', 'reject'] as const)('rechecks owner after awaited %s cleanup', async verdict => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); fileApi.defer(true)
    if (verdict === 'reject') fileApi.reads[0]!.reject(new Error('old fault'))
    else fileApi.reads[0]!.resolve(verdict === 'binary' ? { status: 'binary', revision: 'old', byteLength: 8 } : { status: 'deleted' })
    await tick(); expect(fileApi.cleanup).toHaveLength(1)
    f.rebind('path', true)
    fileApi.defer(false); fileApi.cleanup.splice(0).forEach(resolve => resolve())
    await old
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    expect(reportError).not.toHaveBeenCalled()
    f.preserved()
  })

  it('a closed lifetime rejection cannot poison a restored replacement or remove its observer', async () => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick()
    await useAppStore.getState().closeTab(f.workspace.id, 'pane', f.tabId)
    // Adopt the durable original projection again, as restore does; load through its real action.
    useAppStore.setState({ tabs: f.tabs, layouts: f.layouts })
    const fresh = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick()
    fileApi.reads[0]!.reject(new Error('closed read'))
    await old
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    expect(fileApi.unobserves).toEqual([f.path])
    expect(reportError).not.toHaveBeenCalled()
    expect(fileApi.reads).toHaveLength(2)
    fileApi.reads[1]!.resolve(read(f.path, 'reopened')); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('reopened')
    f.preserved()
  })

  it.each(['read', 'binary', 'directory', 'error', 'reject'] as const)('an old openFile %s cannot dispose or fault a fresh restored owner', async verdict => {
    const f = seed(), old = useAppStore.getState().openFile(f.path, 'pane')
    await tick(); expect(fileApi.reads).toHaveLength(1)
    await useAppStore.getState().closeTab(f.workspace.id, 'pane', f.tabId)
    useAppStore.setState({ tabs: f.tabs, layouts: f.layouts })
    const fresh = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); expect(fileApi.reads).toHaveLength(2)
    if (verdict === 'reject') fileApi.reads[0]!.reject(new Error('closed open fault'))
    else fileApi.reads[0]!.resolve(verdict === 'read' ? read(f.path, 'old-open') : verdict === 'binary' ? { status: 'binary', revision: 'old', byteLength: 8 } : verdict === 'error' ? { status: 'error', code: 'OLD', message: 'old open fault' } : { status: 'directory' })
    await old
    expect(fileApi.unobserves).toEqual([f.path])
    expect(reportError).not.toHaveBeenCalled()
    expect(useAppStore.getState().documents[f.key]).toBeUndefined()
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    fileApi.reads[1]!.resolve(read(f.path, 'restored')); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('restored')
    f.preserved()
  })

  it('an old restore rejection cannot dispose a fresh openFile observer', async () => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); await useAppStore.getState().closeTab(f.workspace.id, 'pane', f.tabId)
    const fresh = useAppStore.getState().openFile(f.path, 'pane')
    await tick(); expect(fileApi.reads).toHaveLength(2)
    fileApi.reads[0]!.reject(new Error('closed restore fault')); await old
    expect(fileApi.unobserves).toEqual([f.path])
    expect(reportError).not.toHaveBeenCalled()
    fileApi.reads[1]!.resolve(read(f.path, 'opened')); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('opened')
    expect(useAppStore.getState().tabs[f.tabId]?.regions[initialWorkbenchRegionId(f.tabId)]).toMatchObject({ kind: 'file', path: f.path })
    expect(Object.values(useAppStore.getState().dirtyDocuments)).toContain(true)
  })

  it('does not read after its observation finishes on a rebound resource', async () => {
    const f = seed(); fileApi.deferObserve(true)
    const old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); expect(fileApi.reads).toHaveLength(0)
    f.rebind('hostId', true)
    fileApi.deferObserve(false)
    const fresh = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); expect(fileApi.reads).toHaveLength(1)
    fileApi.observation.splice(0).forEach(resolve => resolve()); await old
    expect(fileApi.reads).toHaveLength(1)
    expect(fileApi.unobserves).toEqual([f.path])
    fileApi.reads[0]!.resolve(read(f.path)); await fresh
    expect(useAppStore.getState().documents[f.key]?.content).toBe('current')
    f.preserved()
  })

  it('retains an orphan File with an honest resource issue and permits Retry after configuration returns', async () => {
    const f = seed()
    useAppStore.setState({ config: { ...f.config, workspaces: [] } })
    const missing = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); fileApi.reads[0]?.resolve({ status: 'deleted' }); await missing
    expect(fileApi.reads).toHaveLength(0)
    expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'read-error', code: 'WORKSPACE_FILE_RESOURCE_UNAVAILABLE' })
    f.preserved()
    useAppStore.setState({ config: f.config })
    const retry = useAppStore.getState().reloadDocument(f.tabId)
    await tick(); expect(fileApi.reads).toHaveLength(1)
    fileApi.reads[0]!.resolve(read(f.path)); await retry
    expect(useAppStore.getState().documents[f.key]?.content).toBe('current')
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    f.preserved()
  })

  it('keeps a genuine current failure actionable and Retry loads that same owner', async () => {
    const f = seed(), old = useAppStore.getState().attachPersistedFileDocument(f.workspace.id, f.path)
    await tick(); fileApi.reads[0]!.reject(new Error('current fault')); await old
    expect(useAppStore.getState().documentIssues[f.key]).toMatchObject({ kind: 'read-error', code: 'WORKSPACE_FILE_READ_FAILED', message: 'current fault' })
    expect(reportError).toHaveBeenCalledTimes(1)
    const retry = useAppStore.getState().reloadDocument(f.tabId)
    await tick(); expect(fileApi.reads).toHaveLength(2)
    fileApi.reads[1]!.resolve(read(f.path)); await retry
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    expect(useAppStore.getState().documents[f.key]?.content).toBe('current')
    f.preserved()
  })

  it('Retry also binds the original Host/root across A→B→A', async () => {
    const f = seed()
    useAppStore.setState({ documentIssues: { [f.key]: { kind: 'read-error', code: 'RETRY', message: 'retry' } } })
    const retry = useAppStore.getState().reloadDocument(f.tabId)
    await tick(); f.rebind('hostId', true)
    fileApi.reads[0]!.resolve(read(f.path, 'old-retry')); await retry
    expect(useAppStore.getState().documents[f.key]).toBeUndefined()
    expect(useAppStore.getState().documentIssues[f.key]).toBeUndefined()
    f.preserved()
  })
})
