import { afterEach, describe, expect, it, vi } from 'vitest'

const fileApi = vi.hoisted(() => {
  const writes: Array<{
    workspaceId: string
    input: { path: string; content: string; expectedRevision: string | null }
    resolve(value: unknown): void
  }> = []
  const reads: Array<{
    workspaceId: string
    path: string
    resolve(value: unknown): void
  }> = []
  const observes: Array<{ workspaceId: string; path: string }> = []
  const unobserves: Array<{ workspaceId: string; path: string }> = []
  return {
    writes,
    reads,
    observes,
    unobserves,
    api: {
      files: {
        write(workspaceId: string, input: { path: string; content: string; expectedRevision: string | null }) {
          return new Promise((resolve) => writes.push({ workspaceId, input, resolve }))
        },
        read(workspaceId: string, path: string) {
          return new Promise((resolve) => reads.push({ workspaceId, path, resolve }))
        },
        observe: async (workspaceId: string, path: string) => { observes.push({ workspaceId, path }) },
        unobserve: async (workspaceId: string, path: string) => { unobserves.push({ workspaceId, path }) },
        onInvalidated: () => () => {}
      }
    }
  }
})

vi.mock('../src/renderer/src/lib/api.js', () => ({ api: fileApi.api }))

import type { AppConfig, FileDocument, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { documentKey, fileTabId, type FileWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
  fileApi.writes.splice(0)
  fileApi.reads.splice(0)
  fileApi.observes.splice(0)
  fileApi.unobserves.splice(0)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for file Store operation')
}

function seed(document: FileDocument = {
  path: 'src/app.ts',
  content: 'alpha',
  revision: 'revision-alpha'
}): { workspace: WorkspaceRecord; tab: FileWorkbenchTab; key: string } {
  const workspace: WorkspaceRecord = {
    id: 'save-workspace',
    name: 'Save fixture',
    hostId: 'local',
    path: '/fixture',
    kind: 'folder'
  }
  const config: AppConfig = {
    version: 4,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    agents: {},
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }
  }
  const tab: FileWorkbenchTab = {
    id: fileTabId(workspace.id, document.path),
    kind: 'file',
    workspaceId: workspace.id,
    path: document.path
  }
  const key = documentKey(workspace.id, document.path)
  useAppStore.setState({
    config,
    activeWorkspaceId: workspace.id,
    tabs: { [tab.id]: tab },
    documents: { [key]: document },
    dirtyDocuments: { [key]: false },
    documentGenerations: { [key]: 0 },
    documentObservationGenerations: { [key]: 0 },
    documentIssues: {},
    savingDocuments: {},
    layouts: { [workspace.id]: createWorkspaceLayout('pane', [tab.id]) }
  })
  return { workspace, tab, key }
}

describe('revision-aware file save Store', () => {
  it('serializes each file and binds save completion to the captured edit generation', async () => {
    const { tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const saveBravo = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    expect(fileApi.writes[0]?.input).toEqual({
      path: tab.path,
      content: 'bravo',
      expectedRevision: 'revision-alpha'
    })

    useAppStore.getState().updateDocument(tab.id, 'charlie')
    const saveCharlie = useAppStore.getState().saveDocument(tab.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fileApi.writes).toHaveLength(1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.writes.length === 2)
    expect(useAppStore.getState().documents[key]).toMatchObject({
      content: 'charlie',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(fileApi.writes[1]?.input).toEqual({
      path: tab.path,
      content: 'charlie',
      expectedRevision: 'revision-bravo'
    })

    fileApi.writes[1]!.resolve({ status: 'written', revision: 'revision-charlie' })
    await Promise.all([saveBravo, saveCharlie])
    expect(useAppStore.getState().documents[key]).toMatchObject({
      content: 'charlie',
      revision: 'revision-charlie'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })

  it('ignores a pre-write disk read that completes after the written receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const staleRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await save
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    await staleRefresh

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'bravo',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })

  it('does not clear a newer deletion observed after Overwrite starts', async () => {
    const { workspace, tab, key } = seed()
    const firstRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status: 'deleted' })
    await firstRefresh

    const overwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const newerRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({ status: 'deleted' })
    await newerRefresh
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-recreated' })
    await overwrite

    expect(useAppStore.getState().documents[key]).toMatchObject({
      content: 'alpha',
      revision: 'revision-recreated'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toEqual({ kind: 'deleted' })
  })

  it('coalesces concurrent opens before one read can release the shared observation', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.setState({
      tabs: {},
      documents: {},
      dirtyDocuments: {},
      documentGenerations: {},
      documentObservationGenerations: {},
      documentIssues: {},
      savingDocuments: {}
    })

    const first = useAppStore.getState().openFile(tab.path, 'pane')
    const second = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    expect(fileApi.observes).toEqual([{ workspaceId: workspace.id, path: tab.path }])
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    await Promise.all([first, second])

    expect(fileApi.reads).toHaveLength(1)
    expect(fileApi.unobserves).toHaveLength(0)
    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'alpha',
      revision: 'revision-alpha'
    })
  })

  it('keeps a dirty draft on invalidation, reloads explicitly, and overwrites only the latest observed revision', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'draft')
    const firstRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-bravo', revision: 'revision-bravo' }
    })
    await firstRefresh
    expect(useAppStore.getState().documents[key]?.content).toBe('draft')
    expect(useAppStore.getState().documentIssues[key]).toEqual({
      kind: 'changed',
      observed: { path: tab.path, content: 'disk-bravo', revision: 'revision-bravo' }
    })

    await useAppStore.getState().reloadDocument(tab.id)
    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'disk-bravo',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)

    useAppStore.getState().updateDocument(tab.id, 'new-draft')
    const secondRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-charlie', revision: 'revision-charlie' }
    })
    await secondRefresh

    const firstOverwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    expect(fileApi.writes[0]?.input.expectedRevision).toBe('revision-charlie')
    fileApi.writes[0]!.resolve({ status: 'conflict', observedRevision: 'revision-delta' })
    await waitFor(() => fileApi.reads.length === 3)
    fileApi.reads[2]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })
    await firstOverwrite
    expect(useAppStore.getState().documents[key]?.content).toBe('new-draft')
    expect(useAppStore.getState().documentIssues[key]).toMatchObject({
      kind: 'changed',
      observed: { revision: 'revision-delta' }
    })

    const secondOverwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 2)
    expect(fileApi.writes[1]?.input.expectedRevision).toBe('revision-delta')
    fileApi.writes[1]!.resolve({ status: 'written', revision: 'revision-new-draft' })
    await secondOverwrite
    expect(useAppStore.getState().documents[key]).toMatchObject({
      content: 'new-draft',
      revision: 'revision-new-draft'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('distinguishes deletion and read failure without dropping the buffer', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'draft')
    const deletedRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status: 'deleted' })
    await deletedRefresh
    expect(useAppStore.getState().documents[key]?.content).toBe('draft')
    expect(useAppStore.getState().documentIssues[key]).toEqual({ kind: 'deleted' })

    const failedRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({ status: 'error', code: 'EIO', message: 'read failed' })
    await failedRefresh
    expect(useAppStore.getState().documents[key]?.content).toBe('draft')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toEqual({
      kind: 'read-error',
      code: 'EIO',
      message: 'read failed'
    })
  })

  it('lets a clean externally deleted buffer Overwrite without inventing an edit', async () => {
    const { workspace, tab, key } = seed()
    const refresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status: 'deleted' })
    await refresh

    expect(useAppStore.getState().documents[key]?.content).toBe('alpha')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toEqual({ kind: 'deleted' })

    const overwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    expect(fileApi.writes[0]?.input).toEqual({
      path: tab.path,
      content: 'alpha',
      expectedRevision: null
    })
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-recreated' })
    await overwrite

    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('keeps a newer disk conflict actionable when its read precedes the save receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)

    const refresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })
    await refresh
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await save

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'bravo',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toEqual({
      kind: 'changed',
      observed: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })

    const overwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 2)
    expect(fileApi.writes[1]?.input.expectedRevision).toBe('revision-delta')
    fileApi.writes[1]!.resolve({ status: 'written', revision: 'revision-bravo-overwrite' })
    await overwrite
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('keeps a failed write dirty and visible without changing the baseline revision', async () => {
    const { tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'draft')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'error', code: 'ENOSPC', message: 'disk full' })
    await save

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'draft',
      revision: 'revision-alpha'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toEqual({
      kind: 'write-error',
      code: 'ENOSPC',
      message: 'disk full'
    })
  })

  it('ignores an older invalidation read that finishes after a newer disk revision', async () => {
    const { workspace, tab, key } = seed()
    const older = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    const newer = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)

    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'newer', revision: 'revision-newer' }
    })
    await newer
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'older', revision: 'revision-older' }
    })
    await older

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'newer',
      revision: 'revision-newer'
    })
  })
})
