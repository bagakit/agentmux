const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { sourceTreeFileLocation } from '../src/shared/source-files'
import { createWorkspaceLayout } from '@agentmux/layout'
import { revealInFileManagerLabel } from '../src/renderer/src/lib/host-platform'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope, type ScratchTopicsSnapshot } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, type ScratchTopicSnapshot } from '@agentmux/host/mote-model'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'

const dom = composerDOM()
const home = _hygiene_fixturePath("Users/scratch-reader")
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Scratch', kind: 'folder' as const, path: ("" + (home) + _hygiene_fixturePath("scratch")) }
const logical = 'topic--view--relocated'
const files = ['first.md', 'second.md']
const addresses = files.map(name => `${logical}/${name}`)
const physical = ("" + (home) + _hygiene_fixturePath("topics/confirmed-original"))
const relocated = `${home}/motes/confirmed-relocated`
const topic: ScratchTopicSnapshot = { id: 'view:relocated', title: 'Relocated', summary: '', directoryPath: logical,
  physicalDirectoryPath: physical, identityDirectoryPath: `${workspace.path}/${logical}`, topicPath: `${logical}/topic.md`, collaborators: [] }
const snapshot = (topics: readonly ScratchTopicSnapshot[] | null, revision = 1): ScratchTopicsSnapshot => ({
  scope: scratchTopicsScope(workspace), revision, topics, reading: false, error: null
})
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')
let read: MockInstance<typeof api.files.readDirectory>, clipboard: MockInstance<typeof api.ui.writeClipboardText>, report: ReturnType<typeof vi.fn>
beforeEach(() => {
  installFileTreeGeometry()
  read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, path) => {
    expect(id).toBe(SCRATCH_WORKSPACE_ID)
    if (path === '') return [{ name: logical, path: logical, isDirectory: true, isSymlink: false }]
    expect(path).toBe(logical)
    return files.map(name => ({ name, path: `${logical}/${name}`, isDirectory: false, isSymlink: false }))
  })
  // Selecting a file row opens it. The same fixture files must exist for both listing and reading.
  vi.spyOn(api.files, 'read').mockImplementation(async (id, path) => id === workspace.id && addresses.includes(path)
    ? { status: 'read', document: { path, content: path, revision: 'fixture-revision' } }
    : { status: 'deleted' })
  clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  report = vi.fn()
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
    status: vi.fn(async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path }))
  } } })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace], copyPathsAsAbsolute: false }, localHome: home,
    activeWorkspaceId: workspace.id, sessions: [], layouts: {}, tabs: {}, fileExplorerStates: {}, workspaceFileRevisions: {},
    lastActiveFileByWorkspace: {}, dirtyDocuments: {}, pinnedItems: {}, reportError: report,
    scratchTopicSnapshots: { [workspace.id]: snapshot([topic]) }, refreshScratchTopics: vi.fn(async () => {}) })
})
afterEach(() => {
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
})
function row(path = addresses[0]!) {
  const element = dom.container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)
  expect(element, 'Actual mounted logical file row').not.toBeNull()
  return element!
}
async function mount() {
  await dom.render(<FileExplorer />)
  const directory = dom.container.querySelector<HTMLButtonElement>(`[aria-label="Expand ${logical}"]`)
  expect(directory, 'Current Topic root exposes its original directory').not.toBeNull()
  await act(async () => directory!.click())
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-tree-path]')].filter(node => node.dataset.treePath !== logical).map(node => node.dataset.treePath)).toEqual(addresses)
  expect(read.mock.calls.map(call => call.slice(0, 2))).toEqual([[workspace.id, ''], [workspace.id, logical]])
}
async function selectBoth() {
  await act(async () => {
    row(addresses[0]).querySelector<HTMLElement>('.tree-row__label')!.click()
    row(addresses[1]).querySelector<HTMLElement>('.tree-row__label')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
  })
  expect([...useAppStore.getState().fileExplorerStates[workspace.id]!.selection.selectedPaths]).toEqual(addresses)
}
async function openMenu(path = addresses[0]!) {
  await act(async () => {
    row(path).focus()
    row(path).dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
  })
  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
}
async function chooseCopy(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === label)
  expect(item, 'Production Radix Copy action').toBeDefined()
  await act(async () => item!.click())
}
async function changeSnapshot(value: ScratchTopicsSnapshot) {
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [workspace.id]: value } }))
}

describe('actual FileExplorer Scratch physical hover and clipboard admission', () => {
  it('formats confirmed physical paths per setting, preserves logical selection, and consumes updated snapshot while the real menu is open', async () => {
    await mount()
    expect(addresses.map(path => row(path).title)).toEqual(files.map(name => `~/topics/confirmed-original/${name}`))
    expect(report).not.toHaveBeenCalled()
    await selectBoth(); await openMenu(addresses[1]); await chooseCopy('Copy Paths')
    expect(clipboard).toHaveBeenLastCalledWith(files.map(name => `~/topics/confirmed-original/${name}`).join('\n'))
    await openMenu(addresses[1])
    await changeSnapshot(snapshot([{ ...topic, physicalDirectoryPath: relocated }], 2))
    expect(addresses.map(path => row(path).title)).toEqual(files.map(name => `~/motes/confirmed-relocated/${name}`))
    await chooseCopy('Copy Paths')
    expect(clipboard).toHaveBeenLastCalledWith(files.map(name => `~/motes/confirmed-relocated/${name}`).join('\n'))
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, copyPathsAsAbsolute: true } }))
    expect(addresses.map(path => row(path).title)).toEqual(files.map(name => `${relocated}/${name}`))
    await openMenu(addresses[1]); await chooseCopy('Copy Paths')
    expect(clipboard).toHaveBeenLastCalledWith(files.map(name => `${relocated}/${name}`).join('\n'))
    await openMenu(addresses[1]); await chooseCopy('Copy Relative Paths')
    expect(clipboard).toHaveBeenLastCalledWith(addresses.join('\n'))
    expect(clipboard).toHaveBeenCalledTimes(4)
    expect([...useAppStore.getState().fileExplorerStates[workspace.id]!.selection.selectedPaths]).toEqual(addresses)
    expect(useAppStore.getState().config!.workspaces[0]!.path).toBe(workspace.path)
    expect(useAppStore.getState().scratchTopicSnapshots[workspace.id]!.topics![0]!.directoryPath).toBe(logical)
    expect(read).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
  })

  it.each(['unconfirmed', 'wrong-scope', 'read-error'] as const)('does not invent a physical hover/copy path for %s, then reacts to a confirmed snapshot without parent remount', async mode => {
    const uncertain = mode === 'unconfirmed' ? snapshot(null)
      : mode === 'wrong-scope' ? { ...snapshot([topic]), scope: scratchTopicsScope({ ...workspace, path: `${home}/another-scratch` }) }
        : snapshot([{ ...topic, readError: 'Original directory read failed' }])
    useAppStore.setState({ scratchTopicSnapshots: { [workspace.id]: uncertain } })
    await mount()
    expect(row().title).toBe('')
    expect(report).not.toHaveBeenCalled()
    await openMenu(); await chooseCopy('Copy Path')
    expect(clipboard).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledTimes(1)
    expect((report.mock.calls[0]![0] as Error).message).toBe('The original directory read is not confirmed. Refresh Files and retry this operation.')
    await changeSnapshot(snapshot([topic], 2))
    expect(row().title).toBe('~/topics/confirmed-original/first.md')
    await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, copyPathsAsAbsolute: true } }))
    expect(row().title).toBe(`${physical}/first.md`)
    await openMenu(); await chooseCopy('Copy Path')
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(`${physical}/first.md`)
    expect(read).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(1)
  })
})

describe('native file gestures follow the Source that listed the directory', () => {
  function connect(carrier = 'local', current = true, name = logical) {
    const resource = { workspaceId: workspace.id, workspacePath: workspace.path,
      hostId: 'local', zoneId: 'selected-zone', zonePath: workspace.path + '/nested', path: 'nested' }
    const mount = { hostId: carrier, reference: { runtimeId: 'selected-runtime', spaceId: 'selected-space' }, zoneId: resource.zoneId, workspaceId: resource.workspaceId }
    const target = { hostId: carrier, reference: mount.reference }
    const locator = { mount, resource }, input = { workspace, target, locator, selection: { kind: 'mount' as const, mount } }
    const witness = { device: '1', inode: '2', size: '1', ctimeNs: '1', mtimeNs: '1', birthtimeNs: null }
    const rpc = vi.spyOn(api.sourceFiles, 'call').mockImplementation(async (called, method, query) => {
      expect(called).toEqual(target)
      if (!('path' in query)) throw new Error('A file gesture requires its original path')
      const path = query.path === '.' ? resource.path : resource.path + '/' + query.path
      if (method === 'file.list') return { carrierCurrent: true, result: { resource: { ...resource, path }, result: {
        status: 'directory-listed', complete: true, omitted: 'none', partialReason: null,
        entries: [{ path: path + '/' + name, name, isDirectory: true, isSymlink: false }] } } }
      expect(method).toBe('file.stat')
      expect(query).toEqual({ zoneId: resource.zoneId, spaceId: mount.reference.spaceId, path: logical,
        expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } })
      return { carrierCurrent: current, result: { resource: { ...resource, path }, result: {
        status: 'observed', observation: { root: witness, parent: witness, parentPath: resource.path,
          entry: { kind: 'directory', witness }, implementation: { platform: 'darwin', stat: 'native', mkdir: 'native-no-replace' } } } } }
    })
    const launchTerminal = vi.fn(async () => {}), selectWorkspace = vi.fn(async () => {})
    const project = vi.spyOn(api.workspaces, 'add').mockImplementation(async () => { if (!current) throw new Error('Source directory is unavailable'); return workspace })
    const reveal = vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
    useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...composerConfig.hosts, { id: 'original-host', kind: 'ssh', hostname: 'original.invalid', label: 'Remote' }] }, layouts: { [workspace.id]: createWorkspaceLayout('files') },
      sourceFilesInputs: { selections: { [workspace.id]: input }, pending: {}, creations: {}, folderRequests: {} },
      launchTerminal, selectWorkspace }))
    return { rpc, locator, project, reveal, launchTerminal, selectWorkspace }
  }
  it('copies, reveals, opens a project and starts a terminal at the original nested Zone even when Scratch has a same-named Topic', async () => {
    const { locator, rpc, reveal, launchTerminal, project, selectWorkspace } = connect()
    const path = locator.resource.zonePath + '/' + logical
    await dom.render(<FileExplorer />)
    expect(row(logical).title).toBe('~/scratch/nested/' + logical)
    await openMenu(logical)
    expect([...document.querySelectorAll('[role="menuitem"] span')].some(item => item.textContent === 'Rename')).toBe(true)
    await chooseCopy('Copy Path')
    expect(clipboard).toHaveBeenCalledExactlyOnceWith('~/scratch/nested/' + logical)
    await openMenu(logical); await chooseCopy(revealInFileManagerLabel())
    expect(reveal).toHaveBeenCalledExactlyOnceWith(workspace.id, logical, sourceTreeFileLocation(locator, logical))
    await openMenu(logical); await chooseCopy('Open in Terminal')
    expect(launchTerminal).toHaveBeenCalledExactlyOnceWith('files', undefined, path)
    await openMenu(logical); await chooseCopy('Open as Project')
    expect(project).toHaveBeenCalledExactlyOnceWith({ name: logical, path, hostId: 'local', expectedHost: composerConfig.hosts[0] }, sourceTreeFileLocation(locator, logical))
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.id)
    expect(rpc.mock.calls.map(([,method]) => method)).toEqual(['file.list','file.stat'])
    expect(read).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
  it('keeps a POSIX backslash in a file name in a mounted Source and the original Topic', async () => {
    const name = String.raw`notes\draft`
    connect('local', true, name)
    await dom.render(<FileExplorer />)
    function literalRow(path: string) {
      const result = [...dom.container.querySelectorAll<HTMLElement>('[data-tree-path]')].find(row => row.dataset.treePath === path)
      expect(result).toBeDefined()
      return result!
    }
    expect(literalRow(name).title).toBe('~/scratch/nested/' + name)
    read.mockResolvedValue([{ name, path: logical + '/' + name, isDirectory: false, isSymlink: false }])
    await dom.render(<FileExplorer rootPath={logical} objectDirectory={logical} />)
    const document = { path: logical + '/' + name, content: 'Original Topic document', revision: 'original' }
    const readDocument = vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document })
    const file = literalRow(document.path)
    await act(async () => file.querySelector<HTMLElement>('.tree-row__label')!.click())
    expect(readDocument.mock.calls.some(([id, path]) => id === workspace.id && path === document.path)).toBe(true)
    expect(file.title).toBe('~/topics/confirmed-original/' + name)
    await act(async () => {
      file.focus()
      file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    })
    await chooseCopy('Copy Path')
    expect(clipboard).toHaveBeenCalledExactlyOnceWith('~/topics/confirmed-original/' + name)
  })
  it('keeps a remote Source path absolute and opens its project through the actual carrier', async () => {
    const { locator, project, reveal } = connect('original-host')
    await dom.render(<FileExplorer />)
    const path = locator.resource.zonePath + '/' + logical
    expect(row(logical).title).toBe(path)
    await openMenu(logical)
    const labels = [...document.querySelectorAll('[role="menuitem"] span')].map(item => item.textContent)
    expect(labels).not.toContain(revealInFileManagerLabel())
    expect(labels).not.toContain('Open in Terminal')
    await chooseCopy('Copy Path')
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(path)
    await openMenu(logical); await chooseCopy('Open as Project')
    expect(project).toHaveBeenCalledExactlyOnceWith({ name: logical, path, hostId: 'original-host', expectedHost: expect.objectContaining({ hostname: 'original.invalid' }) }, sourceTreeFileLocation(locator, logical))
    expect(reveal).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
  it('keeps the original tree when a native gesture can no longer confirm its carrier', async () => {
    const { launchTerminal, project } = connect('local', false)
    await dom.render(<FileExplorer />)
    await openMenu(logical); await chooseCopy('Open in Terminal')
    await openMenu(logical); await chooseCopy('Open as Project')
    expect(launchTerminal).not.toHaveBeenCalled()
    expect(project).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledTimes(2)
    expect(row(logical).title).toBe('~/scratch/nested/' + logical)
  })
})
