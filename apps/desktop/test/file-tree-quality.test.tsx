const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'

const { readDirectory, refreshGit } = vi.hoisted(() => ({ readDirectory: vi.fn(), refreshGit: vi.fn(async () => true) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: { readDirectory } } }))
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, refresh: refreshGit }) }))

import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { useAppStore } from '../src/renderer/src/store'
import { CONFIG_VERSION, type AppConfig } from '../src/shared/contracts'
import { createSingleFileExplorerSelection } from '../src/renderer/src/lib/file-explorer-selection'

const initialStore = useAppStore.getState()
const workspace = { id: 'tree-quality', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' as const }
const config: AppConfig = { version: CONFIG_VERSION, hosts: [{ id: 'local', label: 'Local', kind: 'local' }],
  executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const entries = Array.from({ length: 1500 }, (_, index) => ({ name: `item-${String(index).padStart(4, '0')}.txt`,
  path: `item-${String(index).padStart(4, '0')}.txt`, isDirectory: false, isSymlink: false }))
let host: HTMLDivElement, root: Root
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
async function settle() { await act(async () => { await nextFrame(); await nextFrame() }) }
function tree() { return host.querySelector<HTMLElement>('[role="tree"]')! }
function row(path: string) { return host.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`) }
async function key(target: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })))
  await settle()
}
async function scroll(top: number) {
  await act(async () => { tree().scrollTop = top; tree().dispatchEvent(new Event('scroll')) })
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installFileTreeGeometry()
  readDirectory.mockResolvedValue(entries)
  useAppStore.setState({ ...initialStore, config, activeWorkspaceId: workspace.id, loading: false,
    sessions: [], tabs: {}, layouts: {}, fileExplorerStates: {}, workspaceFileRevisions: {},
    lastActiveFileByWorkspace: {}, dirtyDocuments: { retained: true }, agentComposerDrafts: { original: 'Keep draft' } }, true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); document.body.replaceChildren(); useAppStore.setState(initialStore, true)
  vi.restoreAllMocks(); vi.clearAllMocks()
})
async function mount() { await act(async () => root.render(<FileExplorer />)); await settle() }

describe('actual FileExplorer visible window', () => {
  it('renders a bounded window of 1500 original paths and moves keyboard focus to an off-window item before opening its menu', async () => {
    const before = useAppStore.getState()
    await mount()
    const mounted = host.querySelectorAll('[data-tree-path]')
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThan(40)
    expect(readDirectory).toHaveBeenCalledExactlyOnceWith(workspace.id, '')
    await act(async () => { row(entries[0]!.path)!.focus() })
    await key(row(entries[0]!.path)!, 'End')
    const last = entries.at(-1)!.path
    expect(row(last), 'keyboard destination must mount through the real projection').not.toBeNull()
    expect(document.activeElement).toBe(row(last))
    expect(tree().scrollTop).toBeGreaterThan(30000)
    expect(host.querySelectorAll('[data-tree-path]').length).toBeLessThan(40)
    await key(row(last)!, 'F10', { shiftKey: true })
    const menuItems = [...document.querySelectorAll('[role="menuitem"]')]
    expect(menuItems.length).toBeGreaterThan(0)
    expect(menuItems.some(item => item.textContent?.startsWith('Rename'))).toBe(true)
    const menuRow = row(last)
    await scroll(0)
    expect(row(last)).toBe(menuRow)
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().dirtyDocuments).toBe(before.dirtyDocuments)
  })

  it('keeps the same rename input and its draft mounted when it leaves the visible window', async () => {
    const rename = vi.fn(async () => { throw new Error('Original rename failed') })
    useAppStore.setState({ renamePath: rename })
    await mount()
    await act(async () => row(entries[0]!.path)!.focus())
    await key(row(entries[0]!.path)!, 'End')
    const path = entries.at(-1)!.path
    await key(row(path)!, 'F2')
    const input = host.querySelector<HTMLInputElement>(`[aria-label="Rename ${path}"]`)!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-draft.txt')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await scroll(0)
    expect(host.querySelector(`[aria-label="Rename ${path}"]`)).toBe(input)
    expect(input.value).toBe('my-draft.txt')
    expect(host.querySelectorAll('[data-tree-path]').length).toBeLessThan(40)
    await key(input, 'Enter')
    expect(rename).toHaveBeenCalledExactlyOnceWith(path, 'my-draft.txt', workspace.id)
    expect(host.querySelector(`[aria-label="Rename ${path}"]`)).toBe(input)
    expect(input.value).toBe('my-draft.txt')
    expect(host.textContent).toContain('Original rename failed')
    const wrapper = input.closest<HTMLElement>('.file-tree__virtual-row')!
    expect(wrapper.offsetHeight).toBeGreaterThan(24)
  })

  it('reveals a create field below an off-window directory and preserves it while scrolling elsewhere', async () => {
    const paths = entries.map((entry, index) => index === 1499 ? { ...entry, path: 'last-folder', name: 'last-folder', isDirectory: true } : entry)
    readDirectory.mockImplementation(async (_id, path) => path === '' ? paths : [])
    const create = vi.fn(async () => workspace.id)
    const open = vi.fn(async () => true)
    useAppStore.setState({ createPath: create, openFile: open })
    await mount()
    await act(async () => row(paths[0]!.path)!.focus())
    await key(row(paths[0]!.path)!, 'End')
    await act(async () => host.querySelector<HTMLButtonElement>('[title="New file"]')!.click())
    await settle()
    const input = host.querySelector<HTMLInputElement>('[aria-label="New file name"]')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'created.txt')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await scroll(0)
    expect(host.querySelector('[aria-label="New file name"]')).toBe(input)
    expect(input.value).toBe('created.txt')
    await key(input, 'Enter')
    expect(create).toHaveBeenCalledExactlyOnceWith({ path: 'last-folder/created.txt', kind: 'file' }, workspace.id)
    expect(readDirectory.mock.calls.some(([, path]) => path === 'last-folder')).toBe(true)
  })

  it('retains original rows and provides retry when a refreshed root fails', async () => {
    await mount()
    const before = useAppStore.getState()
    readDirectory.mockRejectedValueOnce(new Error('Original directory unavailable'))
    await act(async () => host.querySelector<HTMLButtonElement>('[title="Refresh explorer"]')!.click())
    expect(host.textContent).toContain('Original directory unavailable')
    expect(host.querySelectorAll('[data-tree-path]').length).toBeGreaterThan(0)
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!
    expect(retry).toBeDefined()
    await act(async () => retry.click())
    expect(host.textContent).not.toContain('Original directory unavailable')
    expect(host.querySelectorAll('[data-tree-path]').length).toBeGreaterThan(0)
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
  })

  it('opens the exact selected path menu even after scrolling that path out of view', async () => {
    await mount()
    const path = entries.at(-1)!.path
    await act(async () => useAppStore.getState().updateFileExplorerState(workspace.id, current => ({ ...current,
      selection: createSingleFileExplorerSelection(path) })))
    expect(row(path)).toBeNull()
    await act(async () => tree().focus())
    await key(tree(), 'F10', { shiftKey: true })
    expect(row(path)).not.toBeNull()
    expect(useAppStore.getState().fileExplorerStates[workspace.id]!.selection.activePath).toBe(path)
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  })

  it('keeps the real pointer drag source mounted across the window and drops through the original single-item Move owner', async () => {
    const paths = entries.map((entry, index) => index === 1499 ? { ...entry, path: 'last-folder', name: 'last-folder', isDirectory: true } : entry)
    readDirectory.mockImplementation(async (_id, path) => path === '' ? paths : [])
    const move = vi.fn(async () => {})
    useAppStore.setState({ renamePath: move })
    await mount()
    const source = row(paths[0]!.path)!
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, button: 0, pointerId: 1, clientX: x, clientY: y
    })
    await act(async () => source.dispatchEvent(pointer('pointerdown', 100, 36)))
    await act(async () => document.dispatchEvent(pointer('pointermove', 115, 50)))
    await settle()
    expect(host.querySelector('.tree-row--dragging'), 'production PointerSensor must activate').toBe(source)
    await scroll(35880)
    expect(row(paths[0]!.path)).toBe(source)
    const destination = row('last-folder')!
    expect(destination, 'drop target must be a real newly mounted row').not.toBeNull()
    const targetY = destination.getBoundingClientRect().top + 12
    await act(async () => document.dispatchEvent(pointer('pointermove', 100, targetY)))
    await settle()
    await act(async () => document.dispatchEvent(pointer('pointerup', 100, targetY)))
    expect(move).toHaveBeenCalledExactlyOnceWith(paths[0]!.path, `last-folder/${paths[0]!.path}`, workspace.id)
    expect(useAppStore.getState().fileExplorerStates[workspace.id]!.selection.selectedPaths).toEqual(new Set([paths[0]!.path]))
  })
})
