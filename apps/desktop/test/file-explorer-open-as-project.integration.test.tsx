// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

const { configGet, addWorkspace } = vi.hoisted(() => ({ configGet: vi.fn(), addWorkspace: vi.fn() }))
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: {
    config: { get: configGet },
    workspaces: { add: addWorkspace },
    files: { readDirectory: vi.fn(), reveal: vi.fn() }
  }
}))

vi.mock('../src/renderer/src/hooks/useGitStatus.js', () => ({
  useGitStatus: () => ({ status: null, refresh: vi.fn(async () => true) })
}))

vi.mock('../src/renderer/src/components/file-tree/useWorkspaceFileTree.js', () => ({
  flattenFileTree: (children: readonly unknown[]) => children,
  useWorkspaceFileTree: () => ({
    dirCache: {},
    rootCache: {
      // 目录节点在前、文件节点在后：flattenFileTree 直通保序，(a) 依赖目录行仍是第一行。
      children: [
        { path: 'packages/core', name: 'core', isDirectory: true, isSymlink: false, ignored: false, depth: 0 },
        { path: 'README.md', name: 'README.md', isDirectory: false, isSymlink: false, ignored: false, depth: 0 }
      ]
    },
    refreshTree: vi.fn(async () => true),
    refreshDir: vi.fn(async () => true),
    loadDir: vi.fn(async () => true),
    rootError: null,
    isDirStale: () => false
  })
}))

import { FileExplorer } from '../src/renderer/src/components/FileExplorer.js'
import { CONFIG_VERSION, type AppConfig, type WorkspaceRecord } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { joinWorkspacePath } from '../src/renderer/src/lib/workspace-paths.js'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const initialStore = useAppStore.getState()
const workspace = { id: 'root', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder' as const }
const created = { id: 'core-project', name: 'core', hostId: 'local', path: '/repo/packages/core', kind: 'folder' as const }

function config(workspaces: WorkspaceRecord[] = [workspace]): AppConfig {
  return {
    version: CONFIG_VERSION,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces,
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }
}

afterEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialStore, true)
  document.body.replaceChildren()
})

describe('FileExplorer directory context menu', () => {
  it('opens a nested directory as a Workspace and selects the returned project', async () => {
    let currentConfig = config()
    configGet.mockImplementation(async () => currentConfig)
    addWorkspace.mockImplementation(async (_input: { hostId: string; path: string; name?: string }) => {
      currentConfig = config([...currentConfig.workspaces, created])
      return created
    })
    useAppStore.setState({ config: currentConfig, activeWorkspaceId: workspace.id, loading: false })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<FileExplorer />) })

    const row = host.querySelector<HTMLElement>('[data-tree-path="packages/core"]')
    expect(row, 'directory row did not render; menu assertion would be vacuous').not.toBeNull()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })
    const menuItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Open as Project'))
    expect(menuItem, 'directory context menu did not expose Open as Project').not.toBeUndefined()

    await act(async () => { menuItem!.click() })
    expect(addWorkspace).toHaveBeenCalledWith({ hostId: 'local', path: '/repo/packages/core', name: 'core' })
    expect(useAppStore.getState().activeWorkspaceId).toBe('core-project')
    expect(useAppStore.getState().config?.workspaces).toContainEqual(created)
    root.unmount()
  })

  /** 渲染 FileExplorer 并对某一行开右键菜单，返回可点的 'Open as Project' 菜单项（可能为 undefined）。 */
  async function openMenu(treePath: string): Promise<{ item: HTMLElement | undefined; root: ReturnType<typeof createRoot> }> {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<FileExplorer />) })
    const row = host.querySelector<HTMLElement>(`[data-tree-path="${treePath}"]`)
    expect(row, `行 ${treePath} 未渲染；菜单断言会落空`).not.toBeNull()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((entry) => entry.textContent?.includes('Open as Project'))
    return { item, root }
  }

  it('已注册的目录不重复添加，改选中已存在的项目', async () => {
    // (b) 去重：config 已含 /repo/packages/core，右键该目录并点 Open as Project，
    // 不能再 add 一遍，而是选中已有的那条。删掉 657-662 的 existing 分支 → add 被调用 → 本条红。
    const existingPath = joinWorkspacePath(workspace.path, 'packages/core')
    const seeded = { ...created, id: 'already-here', path: existingPath }
    configGet.mockImplementation(async () => config([workspace, seeded]))
    useAppStore.setState({ config: config([workspace, seeded]), activeWorkspaceId: workspace.id, loading: false })

    const { item, root } = await openMenu('packages/core')
    expect(item, '目录右键菜单未暴露 Open as Project').not.toBeUndefined()
    await act(async () => { item!.click() })

    expect(addWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorkspaceId).toBe('already-here')
    root.unmount()
  })

  it('文件行不暴露 Open as Project 入口', async () => {
    // (c) 文件没有这个入口。去掉 FileTreeContextMenu.tsx:103 的 isDirectory 守卫 → 文件也长出入口 → 本条红。
    configGet.mockImplementation(async () => config())
    useAppStore.setState({ config: config(), activeWorkspaceId: workspace.id, loading: false })

    const { item, root } = await openMenu('README.md')
    expect(item, '文件行不应出现 Open as Project').toBeUndefined()
    root.unmount()
  })

  it('添加失败对用户可见（进 error 状态而非被吞）', async () => {
    // (d) 失败可见：add 抛错时 error 必须点亮（TransientErrorNotice 的载体）。
    // 把 FileExplorer.tsx:667 的 reportError(error) 换成 {} → error 保持 null → 本条红。
    configGet.mockImplementation(async () => config())
    addWorkspace.mockImplementation(async () => { throw new Error('add failed') })
    useAppStore.setState({ config: config(), activeWorkspaceId: workspace.id, loading: false })
    expect(useAppStore.getState().error).toBeNull()

    const { item, root } = await openMenu('packages/core')
    expect(item, '目录右键菜单未暴露 Open as Project').not.toBeUndefined()
    await act(async () => { item!.click() })

    expect(useAppStore.getState().error).toBeTruthy()
    root.unmount()
  })
})
