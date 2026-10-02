const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

const { configGet, addWorkspace, writeClipboard, listTopics, tree, defaultChildren } = vi.hoisted(() => {
  const defaultChildren = [
    { path: 'packages/core', name: 'core', isDirectory: true, isSymlink: false, ignored: false, depth: 0 },
    { path: 'README.md', name: 'README.md', isDirectory: false, isSymlink: false, ignored: false, depth: 0 }
  ]
  return { configGet: vi.fn(), addWorkspace: vi.fn(), writeClipboard: vi.fn(), listTopics: vi.fn(), tree: { children: defaultChildren, dirCache: { '': { children: defaultChildren } } }, defaultChildren }
})
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: {
    config: { get: configGet },
    ui: { writeClipboardText: writeClipboard },
    scratch: { listTopics },
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
    dirCache: tree.dirCache,
    rootCache: {
      // 目录节点在前、文件节点在后：flattenFileTree 直通保序，(a) 依赖目录行仍是第一行。
      children: tree.children
    },
    refreshTree: vi.fn(async () => true),
    refreshDir: vi.fn(async () => true),
    loadDir: vi.fn(async () => true),
    rootError: null,
    isDirStale: () => false
  })
}))

import * as moveModel from '../src/renderer/src/lib/file-explorer-move.js'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer.js'
import { CONFIG_VERSION, type AppConfig, type WorkspaceRecord } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { joinWorkspacePath } from '../src/renderer/src/lib/workspace-paths.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const initialStore = useAppStore.getState()
const workspace = { id: 'root', name: 'repo', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' as const }
const created = { id: 'core-project', name: 'core', hostId: 'local', path: _hygiene_fixturePath("repo/packages/core"), kind: 'folder' as const }

function config(workspaces: WorkspaceRecord[] = [workspace]): AppConfig {
  return {
    version: CONFIG_VERSION,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: {},
    workspaces,
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
}

afterEach(() => {
  vi.clearAllMocks()
  tree.children = defaultChildren
  tree.dirCache = { '': { children: defaultChildren } }
  vi.restoreAllMocks()
  useAppStore.setState(initialStore, true)
  document.body.replaceChildren()
})

describe('FileExplorer directory context menu', () => {
  it('keeps 500 actual closed row menus free of target enumeration and opens only the selected item against one current tree index', async () => {
    tree.children = Array.from({ length: 500 }, (_, i) => ({ ...defaultChildren[1]!,
      path: i < 100 ? `dir-${i}` : `file-${i}.txt`, name: i < 100 ? `dir-${i}` : `file-${i}.txt`, isDirectory: i < 100 }))
    tree.dirCache = { '': { children: tree.children } }
    const targets = vi.spyOn(moveModel, 'fileExplorerMoveTargets'), index = vi.spyOn(moveModel, 'createFileExplorerMoveIndex')
    const rename = vi.fn(async () => {}), drafts = { original: 'Keep original draft' }, dirty = { original: true }
    useAppStore.setState({ config: config(), activeWorkspaceId: workspace.id, loading: false,
      layouts: { [workspace.id]: createWorkspaceLayout('files-group') }, renamePath: rename,
      agentComposerDrafts: drafts, dirtyDocuments: dirty })
    const before = useAppStore.getState(), host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    try {
    await act(async () => root.render(<FileExplorer />))
    expect(host.querySelectorAll('[data-tree-path]')).toHaveLength(500)
    expect(targets).not.toHaveBeenCalled()
    expect(index).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<FileExplorer />))
    expect(index).toHaveBeenCalledTimes(1)
    expect(targets).not.toHaveBeenCalled()
    const row = host.querySelector<HTMLElement>('[data-tree-path="file-100.txt"]')!
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
    expect(targets.mock.calls.length).toBeGreaterThan(0)
    expect(targets.mock.calls.every(([, path]) => path === 'file-100.txt')).toBe(true)
    expect(index).toHaveBeenCalledTimes(1)
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes('Move This Item to'))!
    expect(trigger, 'actual Move submenu must be reachable').toBeDefined()
    expect(trigger.getAttribute('data-disabled')).toBeNull()
    await act(async () => { trigger.click() })
    const destination = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === 'dir-0')
    expect(destination, 'open Move submenu must contain actual indexed destinations').toBeDefined()
    await act(async () => destination!.click())
    expect(rename).toHaveBeenCalledExactlyOnceWith('file-100.txt', 'dir-0/file-100.txt', workspace.id)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(useAppStore.getState().dirtyDocuments).toBe(dirty)
    targets.mockClear()
    tree.dirCache = { ...tree.dirCache, 'dir-0': { children: [{ ...defaultChildren[1]!, path: 'dir-0/file-100.txt' }] } }
    await act(async () => root.render(<FileExplorer />))
    expect(index).toHaveBeenCalledTimes(2)
    expect(targets).not.toHaveBeenCalled()
    await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })) })
    expect(targets.mock.calls.length, 'Shift+F10 must open the same actual row menu').toBeGreaterThan(0)
    expect(targets.mock.results.at(-1)!.value.map((target: { path: string }) => target.path)).not.toContain('dir-0')
    expect(targets.mock.results.at(-1)!.value.length).toBeGreaterThan(0)
    } finally { await act(async () => root.unmount()) }
  })

  it.each(['topics', 'motes'] as const)('uses the physical %s directory for original copy/terminal/project actions while relative file keys stay unchanged', async kind => {
    const id = 'launcher:physical-' + kind, logical = scratchTopicDirectoryName(id)
    const owner = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: _hygiene_fixturePath("data/scratch") }
    const physical = _hygiene_fixturePath("data/") + kind + '/' + logical
    tree.children = [{ ...defaultChildren[0]!, path: logical, name: logical }]
    const launch = vi.fn(async () => {}), draft = { original: 'Keep this draft' }
    let currentConfig = config([owner])
    const project = { ...created, path: physical, name: logical }
    configGet.mockImplementation(async () => currentConfig)
    addWorkspace.mockImplementation(async () => {
      currentConfig = config([owner, project]); useAppStore.getState().setConfig(currentConfig); return project
    })
    useAppStore.setState({ config: currentConfig, activeWorkspaceId: owner.id, loading: false, localHome: '',
      layouts: { [owner.id]: createWorkspaceLayout('files-group') }, launchTerminal: launch,
      agentComposerDrafts: draft, scratchTopicSnapshots: { [owner.id]: { scope: scratchTopicsScope(owner), revision: 0,
        topics: [{ id, title: kind, summary: '', collaborators: [], directoryPath: logical, topicPath: logical + '/topic.md',
          identityDirectoryPath: owner.path + '/' + logical, physicalDirectoryPath: physical }], error: null, reading: false } } })
    listTopics.mockImplementation(async () => useAppStore.getState().scratchTopicSnapshots[owner.id]!.topics)
    for (const label of ['Copy Path', 'Copy Relative Path', 'Open in Terminal', 'Open as Project']) {
      const { root } = await openMenu(logical)
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label)
      expect(item, 'actual directory menu is missing ' + label).not.toBeUndefined()
      await act(async () => item!.click())
      await act(async () => root.unmount())
    }
    expect(writeClipboard.mock.calls).toEqual([[physical], [logical]])
    expect(launch).toHaveBeenCalledExactlyOnceWith('files-group', undefined, physical)
    expect(addWorkspace).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', path: physical, name: logical })
    expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
    expect(useAppStore.getState().activeWorkspaceId).toBe(project.id)
  })

  it('retains original state and reports an unconfirmed directory instead of guessing a cwd or copying a broken path', async () => {
    const logical = scratchTopicDirectoryName('launcher:unconfirmed'), owner = { ...workspace, id: SCRATCH_WORKSPACE_ID, path: _hygiene_fixturePath("data/scratch") }
    tree.children = [{ ...defaultChildren[0]!, path: logical, name: logical }]
    const launch = vi.fn(async () => {}), draft = { original: 'Keep this draft' }
    useAppStore.setState({ config: config([owner]), activeWorkspaceId: owner.id, loading: false, error: null,
      layouts: { [owner.id]: createWorkspaceLayout('files-group') }, launchTerminal: launch,
      scratchTopicSnapshots: {}, agentComposerDrafts: draft })
    listTopics.mockResolvedValue([])
    const before = useAppStore.getState()
    let retainedRoot: ReturnType<typeof createRoot> | undefined
    for (const label of ['Copy Path', 'Open in Terminal', 'Open as Project']) {
      const { root } = await openMenu(logical)
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label)
      expect(item).not.toBeUndefined()
      await act(async () => item!.click())
      if (label === 'Open as Project') retainedRoot = root
      else await act(async () => root.unmount())
    }
    expect(writeClipboard).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(addWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toContain('original directory read is not confirmed')
    expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().activeWorkspaceId).toBe(owner.id)
    const physical = _hygiene_fixturePath("data/motes/") + logical
    listTopics.mockResolvedValue([{ id: 'launcher:unconfirmed', title: 'Recovered original directory', summary: '', collaborators: [],
      directoryPath: logical, topicPath: logical + '/topic.md', physicalDirectoryPath: physical, identityDirectoryPath: physical }])
    const refresh = document.querySelector<HTMLButtonElement>('[title="Refresh explorer"]')
    expect(refresh).not.toBeNull()
    const reads = listTopics.mock.calls.length
    await act(async () => refresh!.click())
    expect(listTopics.mock.calls.length).toBeGreaterThan(reads)
    expect(listTopics).toHaveBeenLastCalledWith(owner.id)
    for (const label of ['Copy Path', 'Open in Terminal']) {
      const row = document.querySelector<HTMLElement>('[data-tree-path="' + logical + '"]')!
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label)
      expect(item).not.toBeUndefined(); await act(async () => item!.click())
    }
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(physical)
    expect(launch).toHaveBeenCalledExactlyOnceWith('files-group', undefined, physical)
    expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
    await act(async () => retainedRoot!.unmount())
  })

  it('opens a nested directory as a Workspace and selects the returned project', async () => {
    let currentConfig = config()
    configGet.mockImplementation(async () => currentConfig)
    addWorkspace.mockImplementation(async (_input: { hostId: string; path: string; name?: string }) => {
      currentConfig = config([...currentConfig.workspaces, created])
      useAppStore.getState().setConfig(currentConfig)
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
    expect(addWorkspace).toHaveBeenCalledWith({ hostId: 'local', path: _hygiene_fixturePath("repo/packages/core"), name: 'core' })
    expect(useAppStore.getState().activeWorkspaceId).toBe('core-project')
    expect(useAppStore.getState().config?.workspaces).toContainEqual(created)
    await act(async () => root.unmount())
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
    // Main owns same-location reuse; the Renderer uses the returned original identity.
    const existingPath = joinWorkspacePath(workspace.path, 'packages/core')
    const seeded = { ...created, id: 'already-here', path: existingPath }
    configGet.mockImplementation(async () => config([workspace, seeded]))
    addWorkspace.mockResolvedValue(seeded)
    useAppStore.setState({ config: config([workspace, seeded]), activeWorkspaceId: workspace.id, loading: false })

    const { item, root } = await openMenu('packages/core')
    expect(item, '目录右键菜单未暴露 Open as Project').not.toBeUndefined()
    await act(async () => { item!.click() })

    expect(addWorkspace).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', path: existingPath, name: 'core' })
    expect(configGet).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorkspaceId).toBe('already-here')
    await act(async () => root.unmount())
  })

  it('文件行不暴露 Open as Project 入口', async () => {
    // (c) 文件没有这个入口。去掉 FileTreeContextMenu.tsx:103 的 isDirectory 守卫 → 文件也长出入口 → 本条红。
    configGet.mockImplementation(async () => config())
    useAppStore.setState({ config: config(), activeWorkspaceId: workspace.id, loading: false })

    const { item, root } = await openMenu('README.md')
    expect(item, '文件行不应出现 Open as Project').toBeUndefined()
    await act(async () => root.unmount())
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
    await act(async () => root.unmount())
  })
})
