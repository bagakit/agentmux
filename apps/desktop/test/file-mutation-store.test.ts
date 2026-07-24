import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import { documentKey, type FileWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('file mutation resource reconciliation', () => {
  it('renames and deletes only the exact file subtree across tabs, documents, layout, and last-active state', async () => {
    const workspace: WorkspaceRecord = {
      id: 'mutation-workspace',
      name: 'Mutation fixture',
      hostId: 'local',
      path: '/fixture',
      kind: 'folder'
    }
    const config: AppConfig = {
      version: 1,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      agents: {},
      workspaces: [workspace]
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

    const child: FileWorkbenchTab = {
      id: `file:${workspace.id}:src/app/index.ts`,
      kind: 'file',
      workspaceId: workspace.id,
      path: 'src/app/index.ts'
    }
    const neighbor: FileWorkbenchTab = {
      id: `file:${workspace.id}:src/application.ts`,
      kind: 'file',
      workspaceId: workspace.id,
      path: 'src/application.ts'
    }
    useAppStore.setState({
      tabs: { [child.id]: child, [neighbor.id]: neighbor },
      documents: {
        [documentKey(workspace.id, child.path)]: { path: child.path, content: 'child' },
        [documentKey(workspace.id, 'src/app/closed.ts')]: { path: 'src/app/closed.ts', content: 'closed' },
        [documentKey(workspace.id, neighbor.path)]: { path: neighbor.path, content: 'neighbor' }
      },
      dirtyDocuments: {
        [documentKey(workspace.id, child.path)]: true,
        [documentKey(workspace.id, 'src/app/closed.ts')]: true,
        [documentKey(workspace.id, neighbor.path)]: true
      },
      layouts: { [workspace.id]: createWorkspaceLayout('pane', [child.id, neighbor.id]) },
      lastActiveFileByWorkspace: { [workspace.id]: neighbor.path }
    })

    await useAppStore.getState().renamePath('src/app', 'src/renamed')

    const renamedPath = 'src/renamed/index.ts'
    const renamedId = `file:${workspace.id}:${renamedPath}`
    const renamed = useAppStore.getState()
    expect(renamed.tabs[child.id]).toBeUndefined()
    expect(renamed.tabs[renamedId]).toMatchObject({ path: renamedPath })
    expect(renamed.tabs[neighbor.id]).toEqual(neighbor)
    expect(renamed.documents[documentKey(workspace.id, renamedPath)]).toEqual({
      path: renamedPath,
      content: 'child'
    })
    expect(renamed.documents[documentKey(workspace.id, 'src/renamed/closed.ts')]).toEqual({
      path: 'src/renamed/closed.ts',
      content: 'closed'
    })
    expect(renamed.dirtyDocuments[documentKey(workspace.id, 'src/renamed/closed.ts')]).toBe(true)
    expect(renamed.documents[documentKey(workspace.id, neighbor.path)]).toEqual({
      path: neighbor.path,
      content: 'neighbor'
    })
    expect(renamed.dirtyDocuments[documentKey(workspace.id, renamedPath)]).toBe(true)
    expect(renamed.layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([renamedId, neighbor.id])
    expect(renamed.lastActiveFileByWorkspace[workspace.id]).toBe(neighbor.path)

    useAppStore.setState({
      lastActiveFileByWorkspace: { [workspace.id]: renamedPath }
    })
    await useAppStore.getState().renamePath('src/renamed', 'src/final')
    expect(useAppStore.getState().lastActiveFileByWorkspace[workspace.id]).toBe('src/final/index.ts')

    await useAppStore.getState().deletePath('src/final')
    const deleted = useAppStore.getState()
    expect(deleted.tabs[neighbor.id]).toEqual(neighbor)
    expect(deleted.tabs[`file:${workspace.id}:src/final/index.ts`]).toBeUndefined()
    expect(deleted.documents[documentKey(workspace.id, neighbor.path)]).toBeDefined()
    expect(deleted.documents[documentKey(workspace.id, 'src/final/index.ts')]).toBeUndefined()
    expect(deleted.documents[documentKey(workspace.id, 'src/final/closed.ts')]).toBeUndefined()
    expect(deleted.dirtyDocuments[documentKey(workspace.id, 'src/final/closed.ts')]).toBeUndefined()
    expect(deleted.lastActiveFileByWorkspace[workspace.id]).toBeUndefined()
    expect(deleted.layouts[workspace.id]?.groups[0]?.tabOrder).toEqual([neighbor.id])
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
        version: 1,
        hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
        agents: {},
        workspaces: [workspace]
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
    expect(useAppStore.getState().documents[documentKey(workspace.id, path)]).toEqual({
      path,
      content: ''
    })
    expect(useAppStore.getState().dirtyDocuments[documentKey(workspace.id, path)]).toBeUndefined()
    await useAppStore.getState().deletePath(path)
  })
})
