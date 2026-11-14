const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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

vi.mock('../src/renderer/src/lib/api.js', async importOriginal => process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD === '1'
  ? await importOriginal() : { api: fileApi.api })
vi.mock('electron', () => ({ app: { getPath: () => '/private-unused-save-fixture' } }))

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
    if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD === '1') { await actualSourceSaveMove(); return }
    await runPrivateFileTest('admits a move before waiting for saves')
  }, 180000)

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
    if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD !== '1') { await runPrivateFileTest('does not send a queued save into a reopened lifetime at the same file key'); return }
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'old-draft')
    const firstSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)
    const queuedSave = useAppStore.getState().saveDocument(tab.id)
    // A save in flight makes the original close plan draft-busy. It cannot discard
    // an unacknowledged writer; the old pending-after-close oracle is no longer legal.
    expect(await explicitlyCloseFile(workspace.id, tab.id)).toBe(false)
    expect(useAppStore.getState().tabs[tab.id]).toBeDefined()
    expect(useAppStore.getState().documents[key]?.content).toBe('old-draft')
    expect(fileApi.writes).toHaveLength(1); expect(fileApi.reads).toHaveLength(0)
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-old-draft' })
    await Promise.all([firstSave, queuedSave])
    useAppStore.getState().updateDocument(tab.id, 'discarded-after-original-save')
    expect(await explicitlyCloseFile(workspace.id, tab.id)).toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    const reopen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read', document: { path: tab.path, content: 'reopened', revision: 'revision-reopened' }
    })
    await reopen
    expect(useAppStore.getState().tabs[tab.id]).toBeDefined()
    useAppStore.getState().updateDocument(tab.id, 'new-draft')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fileApi.writes).toHaveLength(1)
    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path, content: 'new-draft', revision: 'revision-reopened'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    // Both original save requests settled before closing and never entered the new lifetime.
  }, 180000)

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
    if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD !== '1') { await runPrivateFileTest('restarts a joined open when the first tab closes during open completion'); return }
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
      close = explicitlyCloseFile(workspace.id, tab.id)
      reopen = close.then(closed => { expect(closed).toBe(true); return useAppStore.getState().openFile(tab.path, 'pane') })
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
  }, 180000)

  it('does not apply an old save receipt to a closed and reopened document', async () => {
    if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD !== '1') { await runPrivateFileTest('does not apply an old save receipt to a closed and reopened document'); return }
    const { workspace, tab, key } = seed()
    useAppStore.getState().updateDocument(tab.id, 'old-draft')
    const oldSave = useAppStore.getState().saveDocument(tab.id)
    await waitFor(() => fileApi.writes.length === 1)

    expect(await explicitlyCloseFile(workspace.id, tab.id)).toBe(false)
    expect(useAppStore.getState().tabs[tab.id]).toBeDefined()
    expect(useAppStore.getState().documents[key]?.content).toBe('old-draft')
    expect(fileApi.writes).toHaveLength(1); expect(fileApi.reads).toHaveLength(0)
    fileApi.writes[0]!.resolve({ status: 'written', revision: 'revision-old-draft' })
    await oldSave
    useAppStore.getState().updateDocument(tab.id, 'discarded-after-original-save')
    expect(await explicitlyCloseFile(workspace.id, tab.id)).toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBeUndefined()
    const reopen = useAppStore.getState().openFile(tab.path, 'pane')
    await waitFor(() => fileApi.reads.length === 1)
    fileApi.reads[0]!.resolve({
      status: 'read',
      document: { path: tab.path, content: 'reopened', revision: 'revision-reopened' }
    })
    await reopen

    // No pending writer may cross the confirmed close; no old request is replayed.
    expect(fileApi.writes).toHaveLength(1)

    expect(useAppStore.getState().documents[key]).toEqual({
      path: tab.path,
      content: 'reopened',
      revision: 'revision-reopened'
    })
    expect(useAppStore.getState().dirtyDocuments[key]).not.toBe(true)
    expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
    expect(useAppStore.getState().savingDocuments[key]).toBeUndefined()
  }, 180000)

  it('does not apply an old refresh to a closed and reopened document', async () => {
    if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD !== '1') { await runPrivateFileTest('does not apply an old refresh to a closed and reopened document'); return }
    const { workspace, tab, key } = seed()
    const oldRefresh = useAppStore.getState().refreshDocument(workspace.id, tab.path)
    await waitFor(() => fileApi.reads.length === 1)

    expect(await explicitlyCloseFile(workspace.id, tab.id)).toBe(true)
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
  }, 180000)

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


async function actualSourceSaveMove(): Promise<void> {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  const facts: Record<string, unknown> = { scenario: 'actual Source save-tail / move / racing draft', writes: [], moves: [] }
  try {
    const { source, bridge, workspace, api } = await privateFileFixture(cleanup)
    const selected = await useAppStore.getState().resolveFilesSource(workspace.id)
    expect(selected.status).toBe('registration-required')
    if (selected.status !== 'registration-required') throw Error('Actual Source registration packet required')
    expect((await useAppStore.getState().useFilesSourceFolder(workspace.id, selected.registration)).status).toBe('located')
    await useAppStore.getState().openFile('src/app.ts', 'pane', undefined, workspace.id)
    const tab = Object.values(useAppStore.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'src/app.ts'))!
    const key = documentKey(workspace.id, 'src/app.ts'), original = useAppStore.getState().documents[key]!
    facts.afterOpen = { workspace, active: useAppStore.getState().activeWorkspaceId, documents: useAppStore.getState().documents, error: useAppStore.getState().error, issues: useAppStore.getState().documentIssues, tabs: useAppStore.getState().tabs }
    if (!original) throw Error('Actual Source body unavailable: ' + JSON.stringify(facts.afterOpen))
    expect(original.readSource?.resource.hostId).toBe('local')
    expect(original.readSource?.target.hostId).toBe(source.id)
    const writes: Array<{ request: unknown; receipt: any; release(): void }> = [], moves: unknown[] = []
    vi.spyOn(api.sourceFiles, 'call').mockImplementation(async (target, method, request, signal) => {
      const result = await bridge.files.call(target, method, request, signal)
      if (method === 'file.write') {
        let release!: () => void
        const paused = new Promise<void>(yes => { release = yes })
        writes.push({ request: structuredClone(request), receipt: result, release })
        facts.writes = writes.map(item => ({ request: item.request, receipt: item.receipt }))
        await paused // Pause the real post-effect owner reply; never invent a revision.
      }
      if (method === 'file.move') { moves.push(structuredClone(request)); facts.moves = moves }
      return result
    })
    useAppStore.getState().updateDocument(tab.id, 'bravo')
    const firstSave = useAppStore.getState().saveDocument(tab.id)
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    const bravo = writes[0]!.receipt.result.result
    expect(bravo.status).toBe('written')
    expect(await readFile(join(source.project, 'src/app.ts'), 'utf8')).toBe('bravo')
    const rename = useAppStore.getState().renamePath('src/app.ts', 'src/renamed.ts', workspace.id)
    useAppStore.getState().updateDocument(tab.id, 'charlie')
    const saveDuringMove = useAppStore.getState().saveDocument(tab.id)
    await new Promise(yes => setTimeout(yes, 0))
    expect(moves).toHaveLength(0); expect(writes).toHaveLength(1)
    writes[0]!.release()
    await firstSave; await rename
    await new Promise(yes => setTimeout(yes, 0))
    // Settle an erroneous redirected write before reporting its concrete assertion.
    writes[1]?.release()
    await saveDuringMove
    const nextKey = documentKey(workspace.id, 'src/renamed.ts'), state = useAppStore.getState()
    facts.afterMove = { regions: state.tabs[tab.id]?.regions, documents: state.documents, dirty: state.dirtyDocuments, issues: state.documentIssues, error: state.error }
    expect(moves).toHaveLength(1); expect(writes).toHaveLength(1)
    expect(moves[0]).toMatchObject({ path: 'src/app.ts', expectedResource: original.readSource!.resource, destination: { path: 'src/renamed.ts' } })
    await expect(readFile(join(source.project, 'src/app.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source.project, 'src/renamed.ts'), 'utf8')).toBe('bravo')
    expect(state.tabs[tab.id]!.regions[tab.titleRegionId]).toMatchObject({ path: 'src/renamed.ts' })
    expect(state.documents[nextKey]).toMatchObject({ content: 'charlie', revision: bravo.revision })
    expect(state.dirtyDocuments[nextKey]).toBe(true)
    expect(state.error).toContain('save the current file to continue')
    const freshSave = useAppStore.getState().saveDocument(tab.id)
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]!.request).toMatchObject({ path: 'src/renamed.ts', content: 'charlie', expectedRevision: bravo.revision })
    writes[1]!.release(); await freshSave
    expect(useAppStore.getState().dirtyDocuments[nextKey]).toBe(false)
    expect(await readFile(join(source.project, 'src/renamed.ts'), 'utf8')).toBe('charlie')
    facts.status = 'passed'
  } finally {
    if (process.env.AGENTMUX_TEST_SAVE_MOVE_FACTS) await writeFile(process.env.AGENTMUX_TEST_SAVE_MOVE_FACTS, JSON.stringify(facts, null, 2))
    for (const close of cleanup.reverse()) await close()
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  }
}

async function privateFileFixture(cleanup: Array<() => unknown | Promise<unknown>>) {
    const { webcrypto } = await import('node:crypto')
    vi.stubGlobal('crypto', webcrypto)
    window.localStorage.clear()
    const { sourceFilesHosts } = await import('./helpers/source-files-hosts.js')
    const { sourceFilesIpcBridge } = await import('./helpers/source-files-ipc-bridge.js')
    const { WorkbenchUserStateStore } = await import('../src/main/workbench-user-state.js')
    const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state')
    const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state.js')
    const { providerCatalogReader, historySourcesReader } = await import('./helpers/startup-observation-api-fixture.js')
    const { api } = await import('../src/renderer/src/lib/api.js')
    const f = await sourceFilesHosts(cleanup), source = f.sources[1]!, bridge = sourceFilesIpcBridge(f.runtime, cleanup)
    await mkdir(join(source.project, 'src'))
    await writeFile(join(source.project, 'src/app.ts'), 'alpha')
    const workspace = { id: 'save-source-workspace', hostId: source.id, path: source.project, name: 'Actual Source save', kind: 'folder' as const }
    const config = { version: 9, hosts: [{ id: source.id, kind: 'local', label: source.id }], executors: {}, workspaces: [workspace],
      appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } as AppConfig
    useAppStore.setState({ config, tabs: {}, documents: {}, layouts: { [workspace.id]: createWorkspaceLayout('pane', []) }, activeWorkspaceId: workspace.id })
    const user = new WorkbenchUserStateStore(join(f.root, 'save-user.json'))
    const spatial = new AgentMuxSpatialStateStore(join(f.root, 'save-spatial.json'))
    await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
    vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
    vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
    vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
    vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
    vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.demands, 'list').mockResolvedValue([])
    vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
    vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
    vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
    vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
    vi.spyOn(api.sourceFiles, 'resolve').mockImplementation(bridge.files.resolve)
    vi.spyOn(api.sourceFiles, 'call').mockImplementation(bridge.files.call)
    vi.spyOn(api.sourceFiles, 'watch').mockImplementation(bridge.files.watch)
    vi.spyOn(api.spaceMounts, 'call').mockImplementation(bridge.spaces.call)
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockImplementation(async () => { throw Error('Source save fixture must not read Main') })
    vi.spyOn(api.files, 'write').mockImplementation(async () => { throw Error('Source save fixture must not write Main') })
    cleanup.push(await useAppStore.getState().initialize())
    return { f, source, bridge, workspace, user, api }
}

async function runPrivateFileTest(name: string): Promise<void> {
    // The original minimal file mocks stay isolated from the actual Source owners.
    const directory = await mkdtemp(join(resolve('.local'), 'save-source-test-'))
    const config = join(directory, 'vitest.config.mts')
    await writeFile(config, `import original from ${JSON.stringify(resolve('apps/desktop/test/vitest.file-path-client.config.mts'))}; export default {...original,test:{...original.test,environment:'happy-dom',include:['apps/desktop/test/file-save-store.test.ts'],passWithNoTests:false,hookTimeout:60000}}`)
    try {
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '-t', name], {
        cwd: process.cwd(), env: { ...process.env, AGENTMUX_TEST_SAVE_SOURCE_CHILD: '1', AGENTMUX_WORKSPACE_MOVE_HELPER: resolve('apps/host/resources/bin/agentmux-workspace-move') }, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''
      child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
      const code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes) })
      if (process.env.AGENTMUX_TEST_SAVE_EVIDENCE_DIRECTORY) {
        const { createHash } = await import('node:crypto')
        const id = createHash('sha256').update(name).digest('hex').slice(0, 12)
        await writeFile(join(process.env.AGENTMUX_TEST_SAVE_EVIDENCE_DIRECTORY, 'child-' + id + '.log'), log)
      }
      expect(code, log).toBe(0)
      expect(log).toMatch(/Tests\s+1 passed/)
    } finally { await rm(directory, { recursive: true, force: true }) }
}

const closeCleanup: Array<() => unknown | Promise<unknown>> = []
beforeEach(async context => {
  if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD !== '1' || context.task.name.startsWith('admits a move')) return
  const { f, user, api } = await privateFileFixture(closeCleanup)
  vi.mocked(api.files.read).mockImplementation(fileApi.api.files.read as any)
  vi.mocked(api.files.write).mockImplementation(fileApi.api.files.write as any)
  vi.mocked(api.files.observe).mockImplementation(fileApi.api.files.observe)
  vi.mocked(api.files.unobserve).mockImplementation(fileApi.api.files.unobserve)
  const { DesktopControlIpcBridge } = await import('../src/main/control-ipc-bridge.js')
  const { createDesktopWorkbenchCloseOwner } = await import('../src/main/workbench-close-owner.js')
  const { spaceCloseDigest } = await import('@agentmux/core')
  let bridge: InstanceType<typeof DesktopControlIpcBridge>
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(request) {
    void useAppStore.getState().executeWorkbenchClose(request as import('../src/shared/workbench-close-control.js').WorkbenchCloseRendererRequest).then(
      result => { bridge.accept({ requestId: request.requestId, ok: true, result }) },
      error => { bridge.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_UNAVAILABLE', message: error.message } }) })
  } })
  closeCleanup.push(() => bridge.dispose())
  const owner = createDesktopWorkbenchCloseOwner({ store: user, bridge, runtime: f.runtime, closeBrowser: async () => { throw Error('Unexpected Browser close') },
    authority: () => ({ ownerId: spaceCloseDigest(user.path), endpoint: 'private-save-main', documentGeneration: 'private-save-client' }) })
  vi.spyOn(api.workbenchClose, 'call').mockImplementation((method, params) => owner.call(method, params, { actor: { kind: 'user', id: 'private-save-user' } }))
})
afterEach(async () => {
  for (const close of closeCleanup.splice(0).reverse()) await close()
  if (process.env.AGENTMUX_TEST_SAVE_SOURCE_CHILD === '1') { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})
async function explicitlyCloseFile(workspaceId: string, tabId: string): Promise<boolean> {
  const approved = await useAppStore.getState().prepareWorkbenchClose({ target: { kind: 'tab-occurrence', displayWorkspaceId: workspaceId, groupId: 'pane', tabId }, keepAgentSessions: true })
  const closed = await useAppStore.getState().closeTab(workspaceId, 'pane', tabId, { approved, keepAgentSessions: true })
  console.info('FILE_SAVE_CLOSE_FACT', JSON.stringify({ operationId: approved.operationId, blockers: approved.plan.projection.surfaces.map(surface => surface.blocker), drafts: approved.plan.projection.drafts.length, closed, retainedTab: Boolean(useAppStore.getState().tabs[tabId]), writes: fileApi.writes.length, reads: fileApi.reads.length }))
  return closed
}
