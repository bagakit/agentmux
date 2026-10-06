const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
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
  const moves: Array<{
    input: {
      source: { workspaceId: string; path: string }
      destination: { workspaceId: string; path: string }
    }
    resolve(value: unknown): void
  }> = []
  return {
    writes,
    reads,
    observes,
    unobserves,
    moves,
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
        onInvalidated: () => () => {},
        move(input: {
          source: { workspaceId: string; path: string }
          destination: { workspaceId: string; path: string }
        }) {
          return new Promise((resolve) => moves.push({ input, resolve }))
        }
      }
    }
  }
})

vi.mock('../src/renderer/src/lib/api.js', () => ({ api: fileApi.api }))

import type { AppConfig, FileDocument, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  documentKey,
  fileTabId,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { editorSaveAction } from '../src/renderer/src/lib/editor-save-shortcut.js'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
  fileApi.writes.splice(0)
  fileApi.reads.splice(0)
  fileApi.observes.splice(0)
  fileApi.unobserves.splice(0)
  fileApi.moves.splice(0)
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
}): { workspace: WorkspaceRecord; tab: WorkbenchTab & { path: string }; key: string } {
  const workspace: WorkspaceRecord = {
    id: 'save-workspace',
    name: 'Save fixture',
    hostId: 'local',
    path: _hygiene_fixturePath("fixture"),
    kind: 'folder'
  }
  const config: AppConfig = {
    version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  const tabId = fileTabId(workspace.id, document.path)
  const tab = {
    ...createWorkbenchTab(tabId, {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId: workspace.id,
      path: document.path
    }),
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
  it.each([false, true])('absorbs canonical saved content only when no later draft exists (%s)', async later => {
    const { tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'Submitted text')
    const saving = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    if (later) useAppStore.getState().updateDocument(tab.id, 'Later draft')
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'canonical-revision', content: 'Canonical saved text', noteAttribution: { status: 'unconfirmed', reason: 'Actor unavailable' } })
    await saving
    expect(useAppStore.getState().documents[key]).toMatchObject({ content: later ? 'Later draft' : 'Canonical saved text', revision: 'canonical-revision', noteWriteAttribution: { status: 'unconfirmed' } })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(later)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    useAppStore.getState().updateDocument(tab.id, 'Next edit')
    const nextSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 2)
    expect(fileApi.writes[1]!.input.expectedRevision).toBe('canonical-revision')
    fileApi.writes[1]!.resolve({ status: 'written', revision: 'next-revision', noteAttribution: { status: 'recorded' } })
    await nextSave
    expect(useAppStore.getState().documents[key]?.noteWriteAttribution).toEqual({ status: 'recorded' })
  })
  it('keeps the original dirty document when a published save has no confirmed receipt', async () => {
    const { tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'unknown', code: 'WORKSPACE_FILE_RESULT_UNKNOWN', message: 'Write result is unconfirmed' })
    await save
    expect(fileApi.writes).toHaveLength(1)
    expect(fileApi.reads).toHaveLength(0)
    expect(useAppStore.getState().documents[key]).toEqual({ path: tab.path, content: 'bravo', revision: 'revision-alpha' })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toMatchObject({ code: 'WORKSPACE_FILE_RESULT_UNKNOWN', message: 'Write result is unconfirmed' })
  })

  it('does not create another bookmark candidate after an unknown write', async () => {
    const { workspace } = seed()
    const saving = useAppStore.getState().saveBrowserBookmark(workspace.id, 'https://example.org/page', 'Page')
    const rejected = expect(saving).rejects.toMatchObject({ code: 'WORKSPACE_FILE_RESULT_UNKNOWN' })
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'unknown', code: 'WORKSPACE_FILE_RESULT_UNKNOWN', message: 'Unconfirmed bookmark' })
    // Settle an erroneously issued next candidate so the assertion reports the wrong verdict,
    // rather than leaving an unresolved write and letting a timeout masquerade as mutation proof.
    await new Promise(resolve => setTimeout(resolve, 0))
    fileApi.writes[1]?.resolve({ status: 'error', code: 'UNEXPECTED_CANDIDATE', message: 'A second write was issued' })
    await rejected
    expect(fileApi.writes).toHaveLength(1)
    expect(fileApi.writes[0]?.input.path).toBe('Page.webloc')
  })

  it('admits a move before waiting for saves and prevents a racing save from recreating the source', async () => {
    const { workspace, tab } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const firstSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)

    const rename = useAppStore.getState().renamePath(tab.path, 'src/renamed.ts')
    useAppStore.getState().updateDocument(tab.id, 'charlie')
    const saveDuringMove = useAppStore.getState().saveDocument(tab.id)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fileApi.moves).toHaveLength(0)
    expect(fileApi.writes).toHaveLength(1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.moves.length === 1)
    expect(fileApi.moves[0]!.input).toEqual({
      source: { workspaceId: workspace.id, path: tab.path },
      destination: { workspaceId: workspace.id, path: 'src/renamed.ts' }
    })
    expect(fileApi.writes).toHaveLength(1)

    fileApi.moves[0]!.resolve({ status: 'moved' })
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: 'src/renamed.ts', content: 'bravo', revision: 'revision-bravo' }
    })
    await rename
    // Settle an erroneous redirected write so a mutant fails assertions rather than timing out.
    await new Promise((resolve) => setTimeout(resolve, 0))
    fileApi.writes[1]?.resolve({ status: 'written', revision: 'unexpected-redirect' })
    await Promise.all([firstSave, rename, saveDuringMove])

    const nextKey = documentKey(workspace.id, 'src/renamed.ts')
    expect(fileApi.writes).toHaveLength(1)
    expect(useAppStore.getState().tabs[tab.id]!.regions[tab.titleRegionId]).toMatchObject({ path: 'src/renamed.ts' })
    expect(useAppStore.getState().documents[nextKey]).toMatchObject({ content: 'charlie' })
    expect(useAppStore.getState().dirtyDocuments[nextKey]).toBe(true)
    expect(useAppStore.getState().error).toContain('save the current file to continue')

    const freshSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 2)
    expect(fileApi.writes[1]!.input).toEqual({
      path: 'src/renamed.ts', content: 'charlie', expectedRevision: 'revision-bravo'
    })
    fileApi.writes[1]!.resolve({ status: 'written', revision: 'revision-charlie' })
    await freshSave
    expect(useAppStore.getState().dirtyDocuments[nextKey]).toBe(false)
  })

  it('does not redirect a queued save when the same Region is rebound to another file', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const firstSave = useAppStore.getState().saveDocument(tab.id, tab.titleRegionId)
    await waitFor(() => fileApi.writes.length === 1)
    const queuedSave = useAppStore.getState().saveDocument(tab.id, tab.titleRegionId)
    const otherPath = 'src/other.ts'
    const otherKey = documentKey(workspace.id, otherPath)
    useAppStore.setState((state) => ({
      tabs: { ...state.tabs, [tab.id]: createWorkbenchTab(tab.id, {
        regionId: tab.titleRegionId, kind: 'file', workspaceId: workspace.id, path: otherPath
      }) },
      documents: { ...state.documents, [otherKey]: { path: otherPath, content: 'other-draft', revision: 'other-revision' } },
      dirtyDocuments: { ...state.dirtyDocuments, [otherKey]: true }
    }))
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await firstSave
    await new Promise((resolve) => setTimeout(resolve, 0))
    fileApi.writes[1]?.resolve({ status: 'written', revision: 'unexpected-other-write' })
    await queuedSave
    expect(fileApi.writes).toHaveLength(1)
    expect(useAppStore.getState().documents[key]?.content).toBe('bravo')
    expect(useAppStore.getState().documents[otherKey]?.content).toBe('other-draft')
    expect(useAppStore.getState().dirtyDocuments[otherKey]).toBe(true)
    expect(useAppStore.getState().error).toContain('No write was sent')
  })

  it('does not send a queued save into a reopened lifetime at the same file key', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'old-draft')
    const firstSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const queuedSave = useAppStore.getState().saveDocument(tab.id)
    await useAppStore.getState().closeTab(workspace.id, 'pane', tab.id)
    const reopen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read', document: { path: tab.path, content: 'reopened', revision: 'revision-reopened' }
    })
    await reopen
    expect(useAppStore.getState().tabs[tab.id]).toBeDefined()
    useAppStore.getState().updateDocument(tab.id, 'new-draft')
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-old-draft' })
    await firstSave
    await new Promise((resolve) => setTimeout(resolve, 0))
    fileApi.writes[1]?.resolve({ status: 'written', revision: 'unexpected-new-lifetime-write' })
    await queuedSave
    expect(fileApi.writes).toHaveLength(1)
    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path, content: 'new-draft', revision: 'revision-reopened'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().error).toContain('No write was sent')
  })

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

  it('reconciles after cancelling a pre-write disk read at the written receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const staleRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'bravo', revision: 'revision-bravo' }
    })
    await save
    await staleRefresh

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'bravo',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })

  it('adopts a newer disk fact instead of losing it behind the written receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const overlappingRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })
    await Promise.all([save, overlappingRefresh])

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'disk-delta',
      revision: 'revision-delta'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it.each([
    {
      label: 'deletion',
      result: { status: 'deleted' as const },
      issue: { kind: 'deleted' }
    },
    {
      label: 'read failure',
      result: { status: 'error' as const, code: 'EIO', message: 'read failed' },
      issue: { kind: 'read-error', code: 'EIO', message: 'read failed' }
    }
  ])('keeps a fresh $label visible after cancelling an overlapping read', async ({ result, issue }) => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const overlappingRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    fileApi.reads[1]!.resolve(result)
    await Promise.all([save, overlappingRefresh])

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'bravo',
      revision: 'revision-bravo'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toEqual(issue)
  })

  it('reconciles a same-revision ABA read that completes before the written receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const overlappingRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    await overlappingRefresh

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-bravo' })
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    await save

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'alpha',
      revision: 'revision-alpha'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('reconciles a deletion read that completes before the Overwrite receipt', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'draft')
    const firstRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status: 'deleted' })
    await firstRefresh

    const overwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const overlappingRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({ status: 'deleted' })
    await overlappingRefresh
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-recreated' })
    await waitFor(() => fileApi.reads.length === 3)
    fileApi.reads[2]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'draft', revision: 'revision-recreated' }
    })
    await overwrite

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'draft',
      revision: 'revision-recreated'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('keeps edits made while an Overwrite reconciliation read is in flight', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'draft')
    const firstRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status: 'deleted' })
    await firstRefresh

    const overwrite = useAppStore.getState().overwriteDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const overlappingRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({ status: 'deleted' })
    await overlappingRefresh
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-recreated' })
    await waitFor(() => fileApi.reads.length === 3)

    useAppStore.getState().updateDocument(tab.id, 'newer draft')
    fileApi.reads[2]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'draft', revision: 'revision-recreated' }
    })
    await overwrite

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'newer draft',
      revision: 'revision-recreated'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })

  it('keeps a deletion confirmed after Overwrite reconciliation', async () => {
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
    await waitFor(() => fileApi.reads.length === 3)
    fileApi.reads[2]!.resolve({ status: 'deleted' })
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

  it('restarts a joined open when the first tab closes during open completion', async () => {
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

    let close: Promise<boolean> | undefined
    let reopen: Promise<boolean> | undefined
    let triggered = false
    const unsubscribe = useAppStore.subscribe((state) => {
      if (triggered || !state.documents[key]) return
      triggered = true
      close = useAppStore.getState().closeTab(workspace.id, 'pane', tab.id)
      reopen = useAppStore.getState().openFile(tab.path, 'pane')
    })
    const firstOpen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' }
    })
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'bravo', revision: 'revision-bravo' }
    })
    await Promise.all([firstOpen, close!, reopen!])
    unsubscribe()

    expect(fileApi.observes).toEqual([
      { workspaceId: workspace.id, path: tab.path },
      { workspaceId: workspace.id, path: tab.path }
    ])
    expect(fileApi.unobserves).toEqual([{ workspaceId: workspace.id, path: tab.path }])
    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'bravo',
      revision: 'revision-bravo'
    })
  })

  it('does not apply an old save receipt to a closed and reopened document', async () => {
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'old-draft')
    const oldSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)

    await useAppStore.getState().closeTab(workspace.id, 'pane', tab.id)
    const reopen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'reopened', revision: 'revision-reopened' }
    })
    await reopen

    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-old-draft' })
    await oldSave

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'reopened',
      revision: 'revision-reopened'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    expect(useAppStore.getState().savingDocuments[key]).toBeUndefined()
  })

  it('does not apply an old refresh to a closed and reopened document', async () => {
    const { workspace, tab, key } = seed()
    const oldRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    await useAppStore.getState().closeTab(workspace.id, 'pane', tab.id)
    const reopen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'reopened', revision: 'revision-reopened' }
    })
    await reopen

    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'old-owner', revision: 'revision-old-owner' }
    })
    await oldRefresh

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'reopened',
      revision: 'revision-reopened'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
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
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'disk-delta', revision: 'revision-delta' }
    })
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
describe('original File owner unconfirmed save checks', () => {
  it('rejects only a save without its original workspace and can retry when restored', async () => {
    const { tab, key, workspace } = seed()
    useAppStore.getState().updateDocument(tab.id, 'saved attempt')
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [] } }))
    await useAppStore.getState().saveDocument(tab.id)
    expect(fileApi.writes).toHaveLength(0)
    expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'write-error', code: 'WORKSPACE_FILE_RESOURCE_UNCONFIRMED' })
    expect(useAppStore.getState().documents[key]?.content).toBe('saved attempt')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace] } }))
    const retry = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'restored-write' })
    await retry
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })

  async function unknown() {
    const original = seed()
    useAppStore.getState().updateDocument(original.tab.id, 'saved attempt')
    const save = useAppStore.getState().saveDocument(original.tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'unknown', code: 'RECEIPT_LOST', message: 'receipt missing' })
    await save
    return original
  }
  it.each(['same', 'old', 'different', 'unreadable'] as const)('checks %s disk contents without blindly writing again', async kind => {
    const { workspace, tab, key } = await unknown()
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
    expect(editorSaveAction({ dirty: true, saving: false, issue: 'write-unknown' })).toBe('none')
    const blocked = useAppStore.getState().saveDocument(tab.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fileApi.writes).toHaveLength(1)
    await blocked
    await useAppStore.getState().overwriteDocument(tab.id)
    expect(fileApi.writes).toHaveLength(1)
    const check = useAppStore.getState().reloadDocument(tab.id)
    await waitFor(() => fileApi.reads.length === 1)
    expect(fileApi.reads[0]).toMatchObject({ workspaceId: workspace.id, path: tab.path })
    expect(useAppStore.getState().savingDocuments[key]).toBe(true)
    fileApi.reads[0]!.resolve(kind === 'unreadable'
      ? { status: 'error', code: 'EIO', message: 'source unavailable' }
      : { status: 'read', document: { path: tab.path,
          content: kind === 'same' ? 'saved attempt' : kind === 'old' ? 'alpha' : 'another discussion changed this',
          revision: kind === 'old' ? 'revision-alpha' : 'revision-observed' } })
    await check
    expect(useAppStore.getState().documents[key]?.content).toBe('saved attempt')
    expect(useAppStore.getState().savingDocuments[key]).toBe(false)
    expect(fileApi.writes).toHaveLength(1)
    if (kind === 'same') {
      expect(useAppStore.getState().documents[key]?.revision).toBe('revision-observed')
      expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
      expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    } else if (kind === 'old') {
      expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
      expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
      const retry = useAppStore.getState().saveDocument(tab.id)
      await waitFor(() => fileApi.writes.length === 2)
      expect(fileApi.writes[1]?.input).toMatchObject({ content: 'saved attempt', expectedRevision: 'revision-alpha' })
      fileApi.writes[1]!.resolve({ status: 'written', revision: 'revision-retry' }); await retry
    } else if (kind === 'different') {
      expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'changed', observed: { content: 'another discussion changed this' } })
      expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    } else {
      expect(useAppStore.getState().documentIssues[key]).toMatchObject({ kind: 'write-unknown', checkMessage: 'source unavailable' })
      expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    }
  })
  it.each(['deleted', 'binary', 'directory'] as const)('keeps the original draft when check finds %s', async status => {
    const { tab, key } = await unknown()
    const check = useAppStore.getState().reloadDocument(tab.id)
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({ status })
    await check
    expect(useAppStore.getState().documents[key]?.content).toBe('saved attempt')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe(status === 'deleted' ? 'deleted' : 'write-unknown')
    expect(useAppStore.getState().savingDocuments[key]).toBe(false)
    expect(fileApi.writes).toHaveLength(1)
  })
  it('confirms the attempted bytes while retaining input typed during the check', async () => {
    const { tab, key } = await unknown()
    const check = useAppStore.getState().reloadDocument(tab.id)
    await waitFor(() => fileApi.reads.length === 1)
    useAppStore.getState().updateDocument(tab.id, 'later unsaved input')
    fileApi.reads[0]!.resolve({ status: 'read', document: { path: tab.path, content: 'saved attempt', revision: 'revision-saved' } })
    await check
    expect(useAppStore.getState().documents[key]).toEqual({ path: tab.path, content: 'later unsaved input', revision: 'revision-saved' })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })
  it('does not use a read started before the missing receipt to authorize another save', async () => {
    const { workspace, tab, key } = seed()
    const stale = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)
    useAppStore.getState().updateDocument(tab.id, 'saved attempt')
    const save = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    fileApi.writes[0]!.resolve({ status: 'unknown', code: 'RECEIPT_LOST', message: 'receipt missing' }); await save
    fileApi.reads[0]!.resolve({ status: 'read', document: { path: tab.path, content: 'alpha', revision: 'revision-alpha' } }); await stale
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
    await useAppStore.getState().saveDocument(tab.id)
    expect(fileApi.writes).toHaveLength(1)
  })
  it('rejects a check across resource A → B → A and allows a fresh check on A', async () => {
    const { workspace, tab, key } = await unknown()
    const check = useAppStore.getState().reloadDocument(tab.id)
    await waitFor(() => fileApi.reads.length === 1)
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...workspace, path: _hygiene_fixturePath("other-resource") }] } }))
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace] } }))
    fileApi.reads[0]!.resolve({ status: 'read', document: { path: tab.path, content: 'saved attempt', revision: 'wrong-resource' } })
    await check
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
    expect(useAppStore.getState().documents[key]?.revision).toBe('revision-alpha')
    const fresh = useAppStore.getState().reloadDocument(tab.id)
    await waitFor(() => fileApi.reads.length === 2)
    fileApi.reads[1]!.resolve({ status: 'read', document: { path: tab.path, content: 'saved attempt', revision: 'original-resource' } })
    await fresh
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    expect(useAppStore.getState().documents[key]?.revision).toBe('original-resource')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(false)
  })
  it.each(['before', 'during'] as const)('preserves unknown when the original workspace resource changes %s checking', async when => {
    const { workspace, tab, key } = await unknown()
    const change = () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...workspace, path: _hygiene_fixturePath("different-resource") }] } }))
    if (when === 'before') change()
    const check = useAppStore.getState().reloadDocument(tab.id)
    if (when === 'during') {
      await waitFor(() => fileApi.reads.length === 1)
      change()
      fileApi.reads[0]!.resolve({ status: 'read', document: { path: tab.path, content: 'saved attempt', revision: 'wrong-resource' } })
    }
    await check
    expect(fileApi.reads).toHaveLength(when === 'before' ? 0 : 1)
    expect(useAppStore.getState().documentIssues[key]?.kind).toBe('write-unknown')
    expect(useAppStore.getState().documents[key]?.revision).toBe('revision-alpha')
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
  })
})
