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
      children: [{ path: 'packages/core', name: 'core', isDirectory: true, isSymlink: false, ignored: false, depth: 0 }]
    },
    refreshTree: vi.fn(async () => true),
    refreshDir: vi.fn(async () => true),
    loadDir: vi.fn(async () => true),
    rootError: null,
    isDirStale: () => false
  })
}))

import { FileExplorer } from '../src/renderer/src/components/FileExplorer.js'
import { CONFIG_VERSION, type AppConfig } from '../src/shared/contracts.js'
import { useAppStore } from '../src/renderer/src/store.js'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const initialStore = useAppStore.getState()
const workspace = { id: 'root', name: 'repo', hostId: 'local', path: '/repo', kind: 'folder' as const }
const created = { id: 'core-project', name: 'core', hostId: 'local', path: '/repo/packages/core', kind: 'folder' as const }

function config(workspaces = [workspace]): AppConfig {
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
    addWorkspace.mockImplementation(async (input: { hostId: string; path: string; name?: string }) => {
      currentConfig = config([...currentConfig.workspaces, { ...input, id: created.id, kind: 'folder' }])
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
})
