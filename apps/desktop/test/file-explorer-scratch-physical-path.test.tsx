const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope, type ScratchTopicsSnapshot } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, type ScratchTopicSnapshot } from '../src/shared/scratch-topics'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

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
let read: ReturnType<typeof vi.spyOn>, clipboard: ReturnType<typeof vi.spyOn>, report: ReturnType<typeof vi.fn>
beforeEach(() => {
  read = vi.spyOn(api.files, 'readDirectory').mockImplementation(async (id, path) => {
    expect(id).toBe(SCRATCH_WORKSPACE_ID)
    if (path === '') return [{ name: logical, path: logical, isDirectory: true, isSymlink: false }]
    expect(path).toBe(logical)
    return files.map(name => ({ name, path: `${logical}/${name}`, isDirectory: false, isSymlink: false }))
  })
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
