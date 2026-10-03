const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const originalTab = createWorkbenchTab('original', { kind: 'launcher', regionId: 'original-region', workspaceId: workspace.id })
let read: ReturnType<typeof vi.spyOn<typeof api.files, 'read'>>
beforeEach(() => {
  installFileTreeGeometry()
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id, mainSurface: 'agents',
    tabs: { original: originalTab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', ['original']) },
    documents: {}, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {},
    fileExplorerStates: {}, workspaceFileRevisions: {}, lastActiveFileByWorkspace: {}, scratchTopicSnapshots: {},
    workbenchSpaceSelection: null, surveyZoneSelection: null, retainedSpatialFocus: null, regionCaretFocus: null, error: null })
  vi.spyOn(api.files, 'readDirectory').mockImplementation(async (_id, path) => path
    ? [{ path: 'folder/inside.ts', name: 'inside.ts', isDirectory: false, isSymlink: false }]
    : ['one.ts', 'photo.png', 'folder'].map(path => ({ path, name: path, isDirectory: path === 'folder', isSymlink: false })))
  read = vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => ({ status: 'read', document: { path, content: 'Original source\n', revision: 'original-revision' } }))
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
})
function element(selector: string) {
  const node = dom.container.querySelector<HTMLElement>(selector)
  expect(node, 'Actual mounted Explorer consumer ' + selector).not.toBeNull()
  return node!
}
const row = (path: string) => element(`[data-tree-path="${path}"]`)
const label = (path: string) => element(`[data-tree-path="${path}"] .tree-row__label`)
async function click(node: HTMLElement, init: MouseEventInit = {}) {
  await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ...init })))
}
function destination(path: string) {
  const state = useAppStore.getState(), tabId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(tabId)
  expect(state.mainSurface).toBe('workbench')
  expect(state.activeWorkspaceId).toBe(workspace.id)
  expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: workspace.id, tabId, regionId })
  expect(state.tabs[tabId]?.layout.activeRegionId).toBe(regionId)
  const layout = state.layouts[workspace.id]!
  expect(layout.groups.find(group => group.id === layout.activeGroupId)?.activeTabId).toBe(tabId)
  expect(state.regionCaretFocus).toMatchObject({ regionId })
  expect(state.agentComposerDrafts['agent-1']).toBe('Keep my draft')
  expect(state.tabs.original).toBe(originalTab)
  return state
}
it.each(['one.ts', 'photo.png'])('name click reveals the actual %s File from Focus and requests exact input focus', async path => {
  await dom.render(<FileExplorer />); await click(label(path))
  const state = destination(path)
  expect(state.tabs[fileTabId(workspace.id, path)]!.regions[initialWorkbenchRegionId(fileTabId(workspace.id, path))]).toMatchObject({ kind: 'file', workspaceId: workspace.id, path })
  if (path === 'photo.png') expect(read).not.toHaveBeenCalled()
  else expect(read).toHaveBeenCalledExactlyOnceWith(workspace.id, path)
})
it('name click returns to the original file Region in another group without rereading or losing its draft', async () => {
  const path = 'one.ts', tabId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(tabId), key = documentKey(workspace.id, path)
  const file = addWorkbenchRegion(createWorkbenchTab(tabId, { kind: 'file', regionId, workspaceId: workspace.id, path }), regionId, 'right',
    { kind: 'launcher', regionId: 'other-split', workspaceId: workspace.id })
  const layout = moveTabToNewGroup(createWorkspaceLayout('original-group', ['original', tabId]), tabId, 'original-group', 'original-group', 'right', 'file-group')
  const draft = { path, content: 'Original unsaved draft', revision: 'original-revision' }
  useAppStore.setState({ tabs: { original: originalTab, [tabId]: file }, layouts: { [workspace.id]: { ...layout, activeGroupId: 'original-group' } },
    documents: { [key]: draft }, dirtyDocuments: { [key]: true } })
  await dom.render(<FileExplorer />); await click(label(path))
  const state = destination(path)
  expect(state.layouts[workspace.id]!.activeGroupId).toBe('file-group')
  expect(state.tabs[tabId]!.layout.root).toBe(file.layout.root)
  expect(state.documents[key]).toBe(draft); expect(state.dirtyDocuments[key]).toBe(true)
  expect(read).not.toHaveBeenCalled()
})
it.each(['icon', 'row', 'Enter'])('existing %s activation shares the same explicit navigation', async target => {
  await dom.render(<FileExplorer />)
  if (target === 'Enter') {
    await act(async () => row('one.ts').focus())
    await act(async () => row('one.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  } else await click(target === 'icon' ? element('[data-tree-path="one.ts"] .tree-row__icon') : row('one.ts'))
  destination('one.ts')
})
it('range and toggle clicks change selection without opening or taking input', async () => {
  await dom.render(<FileExplorer />)
  await click(label('one.ts'), { ctrlKey: true, metaKey: true })
  await click(label('photo.png'), { shiftKey: true })
  expect([...useAppStore.getState().fileExplorerStates[workspace.id]!.selection.selectedPaths]).toEqual(['one.ts', 'photo.png'])
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().regionCaretFocus).toBeNull(); expect(read).not.toHaveBeenCalled()
})
it('a real double-click sequence activates once and keeps Rename focus when its pending read finishes', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />)
  await click(label('one.ts')); await click(label('one.ts'), { detail: 2 })
  await act(async () => label('one.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })))
  const input = element('.tree-inline-input') as HTMLInputElement
  expect(document.activeElement).toBe(input); expect(input.value).toBe('one.ts')
  await act(async () => complete({ status: 'read', document: { path: 'one.ts', content: 'Original source', revision: 'r1' } }))
  expect(read).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(document.activeElement).toBe(input)
})
it('directory name expands once, second click retains expansion and double-click renames', async () => {
  await dom.render(<FileExplorer />); await click(label('folder'))
  expect(row('folder').getAttribute('aria-expanded')).toBe('true'); expect(row('folder/inside.ts')).not.toBeNull()
  await click(label('folder'), { detail: 2 })
  expect(row('folder').getAttribute('aria-expanded')).toBe('true')
  await act(async () => label('folder').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })))
  expect((element('.tree-inline-input') as HTMLInputElement).value).toBe('folder')
  expect(read).not.toHaveBeenCalled()
})
it('deleted-file failure keeps the current working face and reports its real reason', async () => {
  read.mockResolvedValueOnce({ status: 'deleted' })
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(useAppStore.getState().error).toContain('File was deleted')
  expect(useAppStore.getState().tabs.original).toBe(originalTab)
})
it('late reads do not reclaim an intervening navigation, even when it returns to the same surface', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  await act(async () => { useAppStore.setState({ mainSurface: 'goals' }); useAppStore.setState({ mainSurface: 'agents' }) })
  await act(async () => complete({ status: 'read', document: { path: 'one.ts', content: 'Original source', revision: 'r1' } }))
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
})
it('custom Mote file navigation remains owned by its original callback', async () => {
  const open = vi.fn(async () => undefined)
  await dom.render(<FileExplorer onOpenPath={open} />); await click(label('one.ts'))
  expect(open).toHaveBeenCalledExactlyOnceWith('one.ts'); expect(read).not.toHaveBeenCalled()
  expect(useAppStore.getState().mainSurface).toBe('agents')
})
it('low-level file preparation preserves the current main surface', async () => {
  await useAppStore.getState().openFile('one.ts', undefined, undefined, workspace.id)
  expect(useAppStore.getState().documents[documentKey(workspace.id, 'one.ts')]).toMatchObject({ content: 'Original source\n' })
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
})

it('first File activation creates the original Workspace layout from Focus', async () => {
  useAppStore.setState({ layouts: {} })
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  destination('one.ts')
})
it('a late old read does not reveal across a new Create field', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  await click(element('[title="New file"]'))
  const field = element('[aria-label="New file name"]')
  expect(document.activeElement).toBe(field)
  await act(async () => complete({ status: 'read', document: { path: 'one.ts', content: 'Old source', revision: 'old' } }))
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(document.activeElement).toBe(field)
})
it.each(['path', 'host', 'roundtrip'])('a %s rebind must not attach old bytes under the rebound Workspace key', async change => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  const opening = useAppStore.getState().openFileAndReveal('one.ts', undefined, undefined, workspace.id)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  useAppStore.setState({ config: { ...composerConfig, workspaces: [{ ...workspace, ...(change === 'host' ? { hostId: 'another-host' } : { path: _hygiene_fixturePath("different-resource") }) }] } })
  if (change === 'roundtrip') useAppStore.setState({ config: composerConfig })
  complete({ status: 'read', document: { path: 'one.ts', content: 'Old host/path bytes', revision: 'old' } })
  expect(await opening).toBe(false)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().documents[documentKey(workspace.id, 'one.ts')]).toBeUndefined()
})
it('late successful Create must not reveal across a later Workspace selection', async () => {
  const second = { ...workspace, id: 'second', path: _hygiene_fixturePath("second") }
  useAppStore.setState(state => ({ config: { ...composerConfig, workspaces: [workspace, second] }, layouts: { ...state.layouts, second: createWorkspaceLayout('second-group') } }))
  let complete!: (id: string) => void
  const create = vi.spyOn(useAppStore.getState(), 'createPath').mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(element('[title="New file"]'))
  const field = element('[aria-label="New file name"]') as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'created.ts'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(create).toHaveBeenCalledTimes(1)
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'second' }))
  await act(async () => complete(workspace.id))
  expect(useAppStore.getState().activeWorkspaceId).toBe('second')
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
})

it('Create completion must not reclaim a navigation that returns to the same surface', async () => {
  let complete!: (id: string) => void
  const create = vi.spyOn(useAppStore.getState(), 'createPath').mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(element('[title="New file"]'))
  const field = element('[aria-label="New file name"]') as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'created.ts'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(create).toHaveBeenCalledTimes(1)
  await act(async () => { useAppStore.setState({ mainSurface: 'goals' }); useAppStore.setState({ mainSurface: 'agents' }) })
  await act(async () => complete(workspace.id))
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
})

it('a late file read does not take caret from a later tree keyboard selection', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  await act(async () => row('one.ts').focus())
  await act(async () => row('one.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(useAppStore.getState().fileExplorerStates[workspace.id]!.selection.activePath).toBe('photo.png')
  await act(async () => complete({ status: 'read', document: { path: 'one.ts', content: 'Old source', revision: 'old' } }))
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(useAppStore.getState().mainSurface).toBe('agents')
})
it('reuses the original File after promotion out of its canonical Tab, including Changes navigation', async () => {
  const path = 'one.ts', tabId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(tabId), key = documentKey(workspace.id, path)
  const file = addWorkbenchRegion(createWorkbenchTab(tabId, { kind: 'file', regionId, workspaceId: workspace.id, path }), regionId, 'right',
    { kind: 'launcher', regionId: 'retained-launcher', workspaceId: workspace.id })
  const draft = { path, content: 'Promoted unsaved draft', revision: 'original' }
  useAppStore.setState({ tabs: { original: originalTab, [tabId]: file }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', ['original', tabId]) },
    documents: { [key]: draft }, dirtyDocuments: { [key]: true } })
  useAppStore.getState().promoteRegionToTab(workspace.id, tabId, regionId)
  const promoted = Object.values(useAppStore.getState().tabs).find(tab => tab.id !== tabId && tab.regions[regionId])!
  expect(promoted).toBeDefined()
  await dom.render(<FileExplorer />); await click(label(path))
  const state = useAppStore.getState()
  expect(state.mainSurface).toBe('workbench'); expect(state.workbenchSpaceSelection).toMatchObject({ tabId: promoted.id, regionId })
  expect(state.regionCaretFocus).toMatchObject({ regionId }); expect(state.documents[key]).toBe(draft); expect(read).not.toHaveBeenCalled()
  expect(Object.values(state.tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'file' && region.path === path)).toHaveLength(1)
  const mode = vi.spyOn(state, 'setEditorRegionMode').mockResolvedValue()
  await state.openFileDiff(path, workspace.id)
  expect(mode).toHaveBeenCalledExactlyOnceWith(regionId, workspace.id, path, 'diff')
})
it('reopens a closed File without replacing the remaining canonical Tab Region', async () => {
  const path = 'one.ts', tabId = fileTabId(workspace.id, path), regionId = initialWorkbenchRegionId(tabId), key = documentKey(workspace.id, path)
  const file = addWorkbenchRegion(createWorkbenchTab(tabId, { kind: 'file', regionId, workspaceId: workspace.id, path }), regionId, 'right',
    { kind: 'launcher', regionId: 'retained-launcher', workspaceId: workspace.id })
  useAppStore.setState({ tabs: { original: originalTab, [tabId]: file }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', ['original', tabId]) },
    documents: { [key]: { path, content: 'Unchanged source', revision: 'r1' } } })
  useAppStore.getState().closeRegion(workspace.id, tabId, regionId)
  const retained = useAppStore.getState().tabs[tabId]!.regions['retained-launcher']
  expect(retained).toBeDefined()
  await dom.render(<FileExplorer />); await click(label(path))
  destination(path)
  expect(useAppStore.getState().tabs[tabId]!.regions['retained-launcher']).toBe(retained)
  expect(Object.keys(useAppStore.getState().tabs[tabId]!.regions)).toHaveLength(2)
})

it('F2 Rename cancels a pending name activation before its read completes', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  read.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  await dom.render(<FileExplorer />); await click(label('one.ts'))
  await act(async () => row('one.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })))
  const input = element('.tree-inline-input')
  await act(async () => complete({ status: 'read', document: { path: 'one.ts', content: 'Source', revision: 'r1' } }))
  expect(document.activeElement).toBe(input)
  expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().regionCaretFocus).toBeNull()
})
