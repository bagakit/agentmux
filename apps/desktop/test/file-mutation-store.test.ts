import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  documentKey,
  initialWorkbenchRegionId,
  titleWorkbenchSurface
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { api } from '../src/renderer/src/lib/api.js'
import { revealFileExplorerPath } from '../src/renderer/src/lib/file-explorer-selection.js'

const initialState = useAppStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

function fileProjection() {
  const state = useAppStore.getState()
  return {
    tabs: state.tabs,
    documents: state.documents,
    dirtyDocuments: state.dirtyDocuments,
    documentGenerations: state.documentGenerations,
    documentObservationGenerations: state.documentObservationGenerations,
    documentIssues: state.documentIssues,
    savingDocuments: state.savingDocuments,
      layouts: state.layouts,
      lastActiveFileByWorkspace: state.lastActiveFileByWorkspace,
      fileExplorerStates: state.fileExplorerStates
  }
}

describe('file mutation resource reconciliation', () => {
  it('rejects a destination document owner before asking Main to move', async () => {
    const workspaceId = 'collision-workspace'
    const sourcePath = 'src/source.ts'
    const destinationPath = 'src/destination.ts'
    const sourceId = `file:${workspaceId}:${sourcePath}`
    const destinationId = `file:${workspaceId}:${destinationPath}`
    const source = createWorkbenchTab(sourceId, {
      regionId: initialWorkbenchRegionId(sourceId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    const destination = createWorkbenchTab(destinationId, {
      regionId: initialWorkbenchRegionId(destinationId),
      kind: 'file',
      workspaceId,
      path: destinationPath
    })
    useAppStore.setState({
      activeWorkspaceId: workspaceId,
      tabs: { [sourceId]: source, [destinationId]: destination },
      documents: {
        [documentKey(workspaceId, sourcePath)]: { path: sourcePath, content: 'source', revision: 'source-revision' },
        [documentKey(workspaceId, destinationPath)]: {
          path: destinationPath,
          content: 'destination draft',
          revision: 'destination-revision'
        }
      },
      dirtyDocuments: { [documentKey(workspaceId, destinationPath)]: true },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceId, destinationId]) }
    })
    const move = vi.spyOn(api.files, 'move')
    const before = fileProjection()

    await expect(useAppStore.getState().renamePath(sourcePath, destinationPath)).rejects.toMatchObject({
      code: 'WORKSPACE_MOVE_RENDERER_DESTINATION_OWNED'
    })

    expect(move).not.toHaveBeenCalled()
    expect(fileProjection()).toEqual(before)
  })

  it('keeps the Renderer projection unchanged when Main reports an unknown move location', async () => {
    const workspaceId = 'unknown-move-workspace'
    const sourcePath = 'src/source.ts'
    const destinationPath = 'lib/source.ts'
    const sourceId = `file:${workspaceId}:${sourcePath}`
    const source = createWorkbenchTab(sourceId, {
      regionId: initialWorkbenchRegionId(sourceId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    useAppStore.setState({
      activeWorkspaceId: workspaceId,
      tabs: { [sourceId]: source },
      documents: {
        [documentKey(workspaceId, sourcePath)]: { path: sourcePath, content: 'draft', revision: 'source-revision' }
      },
      dirtyDocuments: { [documentKey(workspaceId, sourcePath)]: true },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceId]) },
      lastActiveFileByWorkspace: { [workspaceId]: sourcePath }
    })
    vi.spyOn(api.files, 'move').mockResolvedValue({
      status: 'error',
      code: 'WORKSPACE_MOVE_RECEIPT_UNKNOWN',
      message: 'The final location is unknown',
      finalLocation: 'unknown'
    })
    const before = fileProjection()

    await expect(useAppStore.getState().renamePath(sourcePath, destinationPath)).rejects.toMatchObject({
      code: 'WORKSPACE_MOVE_RECEIPT_UNKNOWN',
      finalLocation: 'unknown'
    })

    expect(fileProjection()).toEqual(before)
  })

  it('keeps a confirmed move committed when observation rebinding fails', async () => {
    const workspaceId = 'observation-move-workspace'
    const sourcePath = `source-${crypto.randomUUID()}.ts`
    const destinationPath = `destination-${crypto.randomUUID()}.ts`
    const sourceId = `file:${workspaceId}:${sourcePath}`
    const source = createWorkbenchTab(sourceId, {
      regionId: initialWorkbenchRegionId(sourceId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    useAppStore.setState({
      activeWorkspaceId: workspaceId,
      tabs: { [sourceId]: source },
      documents: {
        [documentKey(workspaceId, sourcePath)]: { path: sourcePath, content: '', revision: 'source-revision' }
      },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceId]) }
    })
    await api.files.create(workspaceId, { path: sourcePath, kind: 'file' })
    const unobserve = vi.spyOn(api.files, 'unobserve').mockRejectedValueOnce(new Error('unobserve failed'))
    const observe = vi.spyOn(api.files, 'observe').mockRejectedValueOnce(new Error('observe failed'))
    const read = vi.spyOn(api.files, 'read')

    await expect(useAppStore.getState().renamePath(sourcePath, destinationPath)).resolves.toBeUndefined()

    const destinationId = `file:${workspaceId}:${destinationPath}`
    expect(useAppStore.getState().tabs[sourceId]).toBeUndefined()
    expect(titleWorkbenchSurface(useAppStore.getState().tabs[destinationId]!)).toMatchObject({ path: destinationPath })
    expect(useAppStore.getState().documents[documentKey(workspaceId, sourcePath)]).toBeUndefined()
    expect(useAppStore.getState().documents[documentKey(workspaceId, destinationPath)]).toBeDefined()
    expect(unobserve).toHaveBeenCalledWith(workspaceId, sourcePath)
    expect(observe).toHaveBeenCalledWith(workspaceId, destinationPath)
    expect(read).toHaveBeenCalledWith(workspaceId, destinationPath)
    await api.files.delete(workspaceId, destinationPath)
  })

  it('reloads a moved changed document from its destination payload before observation rebind completes', async () => {
    const workspaceId = 'changed-move-workspace'
    const sourcePath = 'src/app/index.ts'
    const destinationPath = 'src/moved/index.ts'
    const neighborPath = 'src/application.ts'
    const sourceKey = documentKey(workspaceId, sourcePath)
    const neighborKey = documentKey(workspaceId, neighborPath)
    const sourceId = `file:${workspaceId}:${sourcePath}`
    const source = createWorkbenchTab(sourceId, {
      regionId: initialWorkbenchRegionId(sourceId),
      kind: 'file',
      workspaceId,
      path: sourcePath
    })
    useAppStore.setState({
      activeWorkspaceId: workspaceId,
      tabs: { [sourceId]: source },
      documents: {
        [sourceKey]: { path: sourcePath, content: 'draft', revision: 'source-revision' },
        [neighborKey]: { path: neighborPath, content: 'neighbor', revision: 'neighbor-revision' }
      },
      dirtyDocuments: { [sourceKey]: true, [neighborKey]: true },
      documentIssues: {
        [sourceKey]: {
          kind: 'changed',
          observed: { path: sourcePath, content: 'observed', revision: 'observed-revision' }
        },
        [neighborKey]: { kind: 'deleted' }
      },
      layouts: { [workspaceId]: createWorkspaceLayout('pane', [sourceId]) },
      lastActiveFileByWorkspace: { [workspaceId]: sourcePath }
    })
    vi.spyOn(api.files, 'move').mockResolvedValue({ status: 'moved' })
    let releaseUnobserve!: () => void
    const unobserveBlocked = new Promise<void>((resolve) => { releaseUnobserve = resolve })
    vi.spyOn(api.files, 'unobserve').mockReturnValue(unobserveBlocked)
    vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
    vi.spyOn(api.files, 'read').mockResolvedValue({
      status: 'read',
      document: { path: destinationPath, content: 'disk', revision: 'destination-revision' }
    })

    const moving = useAppStore.getState().renamePath('src/app', 'src/moved')
    const destinationId = `file:${workspaceId}:${destinationPath}`
    const destinationKey = documentKey(workspaceId, destinationPath)
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabs[destinationId]).toBeDefined()
    })

    await useAppStore.getState().reloadDocument(destinationId)
    const reloaded = useAppStore.getState()
    expect(reloaded.documents[destinationKey]).toEqual({
      path: destinationPath,
      content: 'observed',
      revision: 'observed-revision'
    })
    expect(reloaded.documents[sourceKey]).toBeUndefined()
    expect(reloaded.documents[neighborKey]).toEqual({
      path: neighborPath,
      content: 'neighbor',
      revision: 'neighbor-revision'
    })
    expect(reloaded.documentIssues[neighborKey]).toEqual({ kind: 'deleted' })

    releaseUnobserve()
    await moving
  })

  it('renames and deletes only the exact file subtree across tabs, documents, layout, and last-active state', async () => {
    const workspace: WorkspaceRecord = {
      id: 'mutation-workspace',
      name: 'Mutation fixture',
      hostId: 'local',
      path: '/fixture',
      kind: 'folder'
    }
    const config: AppConfig = {
      version: 6,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      executors: {},
      workspaces: [workspace],
      appearance: { terminalTheme: 'graphite' }
    }
    useAppStore.setState({
      config,
      activeWorkspaceId: workspace.id,
      layouts: { [workspace.id]: createWorkspaceLayout('pane') }
    })
    await useAppStore.getState().createPath({ path: 'src', kind: 'directory' })
    await useAppStore.getState().createPath({ path: 'src/app', kind: 'directory' })
    await useAppStore.getState().createPath({ path: 'src/app/index.ts', kind: 'file' })
    await useAppStore.getState().createPath({ path: 'src/app/closed.ts', kind: 'file' })
    await useAppStore.getState().createPath({ path: 'src/application.ts', kind: 'file' })

    const childPath = 'src/app/index.ts'
    const childId = `file:${workspace.id}:${childPath}`
    const child = createWorkbenchTab(childId, {
      regionId: initialWorkbenchRegionId(childId),
      kind: 'file',
      workspaceId: workspace.id,
      path: childPath
    })
    const neighborPath = 'src/application.ts'
    const neighborId = `file:${workspace.id}:${neighborPath}`
    const neighbor = createWorkbenchTab(neighborId, {
      regionId: initialWorkbenchRegionId(neighborId),
      kind: 'file',
      workspaceId: workspace.id,
      path: neighborPath
    })
    useAppStore.setState({
      tabs: { [child.id]: child, [neighbor.id]: neighbor },
      documents: {
        [documentKey(workspace.id, childPath)]: { path: childPath, content: 'child', revision: 'child-revision' },
        [documentKey(workspace.id, 'src/app/closed.ts')]: { path: 'src/app/closed.ts', content: 'closed', revision: 'closed-revision' },
        [documentKey(workspace.id, neighborPath)]: { path: neighborPath, content: 'neighbor', revision: 'neighbor-revision' }
      },
      dirtyDocuments: {
        [documentKey(workspace.id, childPath)]: true,
        [documentKey(workspace.id, 'src/app/closed.ts')]: true,
        [documentKey(workspace.id, neighborPath)]: true
      },
      documentGenerations: {
        [documentKey(workspace.id, childPath)]: 3,
        [documentKey(workspace.id, 'src/app/closed.ts')]: 4
      },
      documentObservationGenerations: {
        [documentKey(workspace.id, childPath)]: 5,
        [documentKey(workspace.id, 'src/app/closed.ts')]: 6
      },
      documentIssues: {
        [documentKey(workspace.id, childPath)]: { kind: 'write-error', code: 'EIO', message: 'retry' }
      },
      savingDocuments: {
        [documentKey(workspace.id, childPath)]: true
      },
      layouts: { [workspace.id]: createWorkspaceLayout('pane', [child.id, neighbor.id]) },
      lastActiveFileByWorkspace: { [workspace.id]: neighborPath },
      fileExplorerStates: {
        [workspace.id]: {
          selection: {
            activePath: childPath,
            anchorPath: childPath,
            selectedPaths: new Set([childPath, neighborPath])
          },
          expandedPaths: new Set(['src', 'src/app', 'src/application'])
        }
      }
    })

    let explorerProjectionWrites = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.fileExplorerStates[workspace.id] !== previous.fileExplorerStates[workspace.id]) {
        explorerProjectionWrites += 1
      }
    })
    await useAppStore.getState().renamePath('src/app', 'src/renamed')

    const renamedPath = 'src/renamed/index.ts'
    const renamedId = `file:${workspace.id}:${renamedPath}`
    const renamed = useAppStore.getState()
    expect(renamed.tabs[child.id]).toBeUndefined()
    expect(titleWorkbenchSurface(renamed.tabs[renamedId]!)).toMatchObject({ path: renamedPath })
    expect(renamed.tabs[neighbor.id]).toEqual(neighbor)
    expect(renamed.documents[documentKey(workspace.id, renamedPath)]).toEqual({
      path: renamedPath,
      content: 'child',
      revision: 'child-revision'
    })
    expect(renamed.documents[documentKey(workspace.id, 'src/renamed/closed.ts')]).toEqual({
      path: 'src/renamed/closed.ts',
      content: 'closed',
      revision: 'closed-revision'
    })
    expect(renamed.dirtyDocuments[documentKey(workspace.id, 'src/renamed/closed.ts')]).toBe(true)
    expect(renamed.documents[documentKey(workspace.id, neighborPath)]).toEqual({
      path: neighborPath,
      content: 'neighbor',
      revision: 'neighbor-revision'
    })
    expect(renamed.dirtyDocuments[documentKey(workspace.id, renamedPath)]).toBe(true)
    expect(renamed.documentGenerations[documentKey(workspace.id, renamedPath)]).toBe(3)
    expect(renamed.documentObservationGenerations[documentKey(workspace.id, renamedPath)]).toBe(6)
    expect(renamed.documentIssues[documentKey(workspace.id, renamedPath)]).toEqual({
      kind: 'changed',
      observed: { path: renamedPath, content: '', revision: expect.any(String) }
    })
    expect(renamed.savingDocuments[documentKey(workspace.id, renamedPath)]).toBe(false)
    expect(renamed.layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([renamedId, neighbor.id])
    expect(renamed.lastActiveFileByWorkspace[workspace.id]).toBe(neighborPath)
    expect(renamed.fileExplorerStates[workspace.id]?.selection.selectedPaths).toEqual(
      new Set([renamedPath, neighborPath])
    )
    expect(renamed.fileExplorerStates[workspace.id]?.expandedPaths).toEqual(
      new Set(['src', 'src/renamed', 'src/application'])
    )
    expect(explorerProjectionWrites).toBe(1)

    useAppStore.setState({
      lastActiveFileByWorkspace: { [workspace.id]: renamedPath }
    })
    await useAppStore.getState().renamePath('src/renamed', 'src/final')
    const renamedAgain = useAppStore.getState()
    expect(renamedAgain.lastActiveFileByWorkspace[workspace.id]).toBe('src/final/index.ts')
    const renamedAgainExplorer = renamedAgain.fileExplorerStates[workspace.id]!
    expect(renamedAgainExplorer.selection.selectedPaths).toEqual(
      new Set(['src/final/index.ts', neighborPath])
    )
    expect(revealFileExplorerPath(renamedAgainExplorer, 'src/final/index.ts')).toBe(
      renamedAgainExplorer
    )
    expect(explorerProjectionWrites).toBe(2)
    unsubscribe()

    await useAppStore.getState().deletePath('src/final')
    const deleted = useAppStore.getState()
    expect(deleted.tabs[neighbor.id]).toEqual(neighbor)
    expect(deleted.tabs[`file:${workspace.id}:src/final/index.ts`]).toBeUndefined()
    expect(deleted.documents[documentKey(workspace.id, neighborPath)]).toBeDefined()
    expect(deleted.documents[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.documents[documentKey(workspace.id, 'src/final/closed.ts')]).toBeUndefined()
    expect(deleted.dirtyDocuments[documentKey(workspace.id, 'src/final/closed.ts')]).toBeUndefined()
    expect(deleted.documentGenerations[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.documentObservationGenerations[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.documentIssues[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.savingDocuments[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.lastActiveFileByWorkspace[workspace.id]).toBeUndefined()
    expect(deleted.layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([neighbor.id])
    expect(deleted.fileExplorerStates[workspace.id]?.selection).toEqual({
      activePath: neighborPath,
      anchorPath: neighborPath,
      selectedPaths: new Set([neighborPath])
    })
  })

  it('discards document memory when a file tab closes and reloads from disk when reopened', async () => {
    const workspace: WorkspaceRecord = {
      id: 'discard-workspace',
      name: 'Discard fixture',
      hostId: 'local',
      path: '/fixture',
      kind: 'folder'
    }
    useAppStore.setState({
      config: {
        version: 6,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        executors: {},
        workspaces: [workspace],
        appearance: { terminalTheme: 'graphite' }
      },
      activeWorkspaceId: workspace.id,
      layouts: { [workspace.id]: createWorkspaceLayout('pane') }
    })
    const path = `discard-${crypto.randomUUID()}.ts`
    await useAppStore.getState().createPath({ path, kind: 'file' })
    await useAppStore.getState().openFile(path, 'pane')
    const tabId = `file:${workspace.id}:${path}`
    useAppStore.getState().updateDocument(tabId, 'unsaved')

    await useAppStore.getState().closeTab(workspace.id, 'pane', tabId)
    const closed = useAppStore.getState()
    expect(closed.tabs[tabId]).toBeUndefined()
    expect(closed.documents[documentKey(workspace.id, path)]).toBeUndefined()
    expect(closed.dirtyDocuments[documentKey(workspace.id, path)]).toBeUndefined()

    await useAppStore.getState().openFile(path, 'pane')
    expect(useAppStore.getState().documents[documentKey(workspace.id, path)]).toMatchObject({
      path,
      content: ''
    })
    expect(useAppStore.getState().dirtyDocuments[documentKey(workspace.id, path)]).toBeUndefined()
    await useAppStore.getState().deletePath(path)
  })
})
