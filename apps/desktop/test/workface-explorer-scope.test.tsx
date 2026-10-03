import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { useWorkspaceFileTree } from '../src/renderer/src/components/file-tree/useWorkspaceFileTree'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const a = { id: 'scope-a', hostId: 'local', name: 'Resource A', kind: 'folder' as const, path: _hygiene_fixturePath("workface/a") }
const b = { ...a, id: 'scope-b', name: 'Resource B', path: _hygiene_fixturePath("workface/b") }
const entry = (path: string, directory = false) => ({ path, name: path.split('/').at(-1)!, isDirectory: directory, isSymlink: false })
const bridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
let read: MockInstance<typeof api.files.readDirectory>, open: ReturnType<typeof vi.fn>, terminal: ReturnType<typeof vi.fn>
beforeEach(() => {
  installFileTreeGeometry()
  open = vi.fn(async () => true); terminal = vi.fn(async () => {})
  useAppStore.setState({ config: { ...composerConfig, workspaces: [a, b] }, activeWorkspaceId: b.id,
    sessions: [], tabs: {}, layouts: {}, fileExplorerStates: {}, workspaceFileRevisions: {}, lastActiveFileByWorkspace: {},
    dirtyDocuments: {}, pinnedItems: {}, scratchTopicSnapshots: {}, openFile: open, openFileAndReveal: open, launchTerminal: terminal })
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status: async (id: string) =>
    ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: id === a.id ? a.path : b.path }) } } })
  read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, path) =>
    [entry(path ? path + '/' + id + '.md' : id + '.md')])
})
afterEach(() => { if (bridge) Object.defineProperty(window, 'agentmux', bridge); else Reflect.deleteProperty(window, 'agentmux') })
const paths = () => [...dom.container.querySelectorAll<HTMLElement>('[data-tree-path]')].map(node => node.dataset.treePath)
function row(path: string) { const node = dom.container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`); expect(node).not.toBeNull(); return node! }
async function waitPaths(expected: string[]) { await vi.waitFor(() => expect(paths()).toEqual(expected)) }
async function view(path: string) { await act(async () => row(path).click()) }
async function menu(path: string, label: string) {
  await act(async () => { row(path).focus(); row(path).dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(node => node.textContent?.trim() === label)
  expect(item, 'Actual original File row menu action ' + label).toBeDefined(); await act(async () => item!.click())
}
it('explicit resource and subtree keep two Workspaces separate and reject out-of-root returned rows', async () => {
  read.mockResolvedValue([entry('mote-a/notes.md'), entry('mote-b/foreign.md')])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" rootLabel="Mote A materials" />)
  await waitPaths(['mote-a/notes.md'])
  expect(read).toHaveBeenCalledExactlyOnceWith(a.id, 'mote-a')
  expect(dom.container.querySelector('.file-explorer')?.getAttribute('data-file-workspace')).toBe(a.id)
  expect(dom.container.querySelector('.file-explorer')?.getAttribute('data-file-root')).toBe('mote-a')
  expect(dom.container.querySelector('.file-tree-root-target')?.textContent).toContain('Mote A materials')
  expect(useAppStore.getState().activeWorkspaceId).toBe(b.id)
  await view('mote-a/notes.md'); expect(open).toHaveBeenCalledExactlyOnceWith('mote-a/notes.md', undefined, undefined, a.id, expect.any(AbortSignal))
})
it('default Explorer keeps current Workspace navigation and the original file action', async () => {
  await dom.render(<FileExplorer />); await waitPaths(['scope-b.md']); expect(read).toHaveBeenCalledWith(b.id, '')
  await act(async () => useAppStore.setState({ activeWorkspaceId: a.id }))
  await waitPaths(['scope-a.md']); expect(read).toHaveBeenLastCalledWith(a.id, '')
  await view('scope-a.md'); expect(open).toHaveBeenCalledExactlyOnceWith('scope-a.md', undefined, undefined, a.id, expect.any(AbortSignal))
})
it('a same-Workspace root switch rejects the exact older root completion', async () => {
  let complete!: (entries: ReturnType<typeof entry>[]) => void
  const earlier = new Promise<ReturnType<typeof entry>[]>(resolve => { complete = resolve })
  read.mockImplementation(async (_id, path) => path === 'mote-a' ? earlier : [entry('mote-b/current.md')])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" />)
  expect(read).toHaveBeenCalledWith(a.id, 'mote-a')
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-b" />); await waitPaths(['mote-b/current.md'])
  await act(async () => complete([entry('mote-a/late.md')]))
  expect(paths()).toEqual(['mote-b/current.md']); expect(read.mock.calls).toEqual([[a.id, 'mote-a'], [a.id, 'mote-b']])
})
it('a different-Workspace scope switch rejects the older resource completion without changing the active project', async () => {
  let complete!: (entries: ReturnType<typeof entry>[]) => void
  const earlier = new Promise<ReturnType<typeof entry>[]>(resolve => { complete = resolve })
  read.mockImplementation(async (id, path) => id === a.id ? earlier : [entry(path + '/current.md')])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" />)
  await dom.render(<FileExplorer workspaceId={b.id} rootPath="mote-b" />); await waitPaths(['mote-b/current.md'])
  await act(async () => complete([entry('mote-a/late.md')]))
  expect(paths()).toEqual(['mote-b/current.md']); expect(read.mock.calls).toEqual([[a.id, 'mote-a'], [b.id, 'mote-b']])
  expect(useAppStore.getState().activeWorkspaceId).toBe(b.id)
})
it('original file and directory menus call the explicit owner with original relative resource paths', async () => {
  const opened = vi.fn(async () => {}), launched = vi.fn(async () => {})
  read.mockResolvedValue([entry('mote-a/notes.md'), entry('mote-a/assets', true)])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" onOpenPath={opened} onOpenTerminal={launched} />)
  await waitPaths(['mote-a/notes.md', 'mote-a/assets'])
  await view('mote-a/notes.md'); expect(opened).toHaveBeenCalledExactlyOnceWith('mote-a/notes.md')
  await menu('mote-a/assets', 'Open in Terminal'); expect(launched).toHaveBeenCalledExactlyOnceWith('mote-a/assets')
  expect(open).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled(); expect(useAppStore.getState().activeWorkspaceId).toBe(b.id)
})
it('the original hook rejects out-of-scope expanded and imperative paths before filesystem requests', async () => {
  let tree: ReturnType<typeof useWorkspaceFileTree> | undefined
  const expanded = new Set(['mote-b/private', 'mote-a/assets'])
  function Probe() { const current = useWorkspaceFileTree(a.id, expanded, 'mote-a'); useEffect(() => { tree = current }, [current]); return null }
  await dom.render(<Probe />)
  await vi.waitFor(() => expect(tree?.rootCache?.children.length).toBeGreaterThan(0))
  expect(read.mock.calls.map(call => call[1])).toEqual(['mote-a', 'mote-a/assets'])
  await act(async () => expect(await tree!.loadDir('mote-b/private')).toBe(false))
  expect(read.mock.calls.map(call => call[1])).toEqual(['mote-a', 'mote-a/assets'])
})

it('expand and refresh retain the original subtree and relative indentation', async () => {
  read.mockImplementation(async (_id, path) => path === 'mote-a'
    ? [entry('mote-a/assets', true)] : [entry('mote-a/assets/image.png')])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" rootLabel="Mote A" />)
  await waitPaths(['mote-a/assets'])
  expect(row('mote-a/assets').getAttribute('aria-level')).toBe('1')
  await act(async () => row('mote-a/assets').querySelector<HTMLButtonElement>('.tree-row__disclosure')!.click())
  await waitPaths(['mote-a/assets', 'mote-a/assets/image.png'])
  expect(row('mote-a/assets/image.png').getAttribute('aria-level')).toBe('2')
  expect(read.mock.calls).toEqual([[a.id, 'mote-a'], [a.id, 'mote-a/assets']])
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[title="Refresh explorer"]')!.click())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  expect(read.mock.calls.slice(2)).toEqual([[a.id, 'mote-a'], [a.id, 'mote-a/assets']])
  expect(paths()).toEqual(['mote-a/assets', 'mote-a/assets/image.png'])
})
it('scope changes close a prepared deletion and keep the captured resource out of the next Workspace', async () => {
  const deletion = vi.fn(async () => {})
  useAppStore.setState({ deletePath: deletion })
  read.mockResolvedValue([entry('mote-a/original.txt')])
  await dom.render(<FileExplorer workspaceId={a.id} rootPath="mote-a" />)
  await waitPaths(['mote-a/original.txt'])
  await act(async () => {
    row('mote-a/original.txt').querySelector<HTMLElement>('.tree-row__label')!.click()
    row('mote-a/original.txt').focus()
    row('mote-a/original.txt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  })
  expect(document.querySelector('[data-confirm-label="Delete"]')).not.toBeNull()
  await dom.render(<FileExplorer workspaceId={b.id} rootPath="mote-a" />)
  expect(document.querySelector('[data-confirm-label="Delete"]')).toBeNull()
  expect(deletion).not.toHaveBeenCalled()
  await act(async () => {
    row('mote-a/original.txt').querySelector<HTMLElement>('.tree-row__label')!.click()
    row('mote-a/original.txt').focus()
    row('mote-a/original.txt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
  })
  const confirm = document.querySelector<HTMLButtonElement>('[data-confirm-label="Delete"]')
  expect(confirm).not.toBeNull(); await act(async () => confirm!.click())
  expect(deletion).toHaveBeenCalledExactlyOnceWith('mote-a/original.txt', b.id)
})
