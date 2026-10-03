// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { ExecutionHost } from '@agentmux/core'
import type { TopicMethod, TopicParams, TopicResult } from '@agentmux/core/control'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { TopicMoveDialog, type TopicMoveTarget } from '../src/renderer/src/components/TopicMoveDialog'
import { TopicActionsMenu, TopicContextMenu } from '../src/renderer/src/components/TopicContextMenu'
import { TopicKnowledgePanel } from '../src/renderer/src/components/TopicKnowledgePanel'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { categoriesFromSpatial } from '../src/shared/topic-categories'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('No avatar writes in this fixture') } } }))
const initial = useAppStore.getState(), DESTINATION = '11111111-1111-4111-8111-111111111111'
let directories: string[] = [], root: Root | null = null, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useAppStore.setState(initial, true); host = document.createElement('div'); document.body.append(host) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate()).toBe(true)
}
async function mount(component: React.ReactNode) { root = createRoot(host); await act(async () => root!.render(component)) }
async function click(node: Element) { await act(async () => { (node as HTMLElement).click() }) }
async function input(node: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => { const type = node instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement; Object.getOwnPropertyDescriptor(type.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  expect(node, label).toBeDefined(); return node!
}
async function ready() { await settle(() => !document.querySelector('.topic-move-dialog [role="status"]')) }
async function fixture(withDestination = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'topic-move-owner-'))); directories.push(directory)
  const path = join(directory, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)), state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const first = (await owner.call('topic.create', { topicId: 'view:move-first', title: 'Original Topic' })).topic
  const second = (await owner.call('topic.create', { topicId: 'view:move-second', title: 'Other Topic' })).topic
  const destination = withDestination ? (await owner.call('topic.category.create', { categoryId: DESTINATION, title: 'Research' })).category : null
  const original = (await state.read())!, tabs = [first, second].map(topic => ({ ...createWorkbenchTab('chat:' + topic.topicId, { kind: 'agent', phase: 'attached', regionId: 'thread:' + topic.topicId, workspaceId: workspace.id, sessionId: 'healthy:' + topic.topicId }), topicId: topic.topicId, space: { spaceId: topic.categorySpaceIds[0]!, zoneId: topic.zoneId } }))
  const layout = createWorkspaceLayout('original-group', tabs.map(tab => tab.id)), graph = original.graph
  graph.tabs = tabs.map(tab => ({ tabId: tab.id, zoneId: tab.space.zoneId, workspaceId: workspace.id, name: null, regionIds: [tab.layout.activeRegionId] }))
  graph.regions = tabs.map(tab => ({ tabId: tab.id, regionId: tab.layout.activeRegionId, kind: 'agent', agentSessionId: 'healthy:' + tab.topicId, runId: 'original-run', execution: { hostId: 'local', cwd: first.directoryPath } }))
  graph.layouts[workspace.id] = layout
  await state.commit({ expectedRevision: original.revision, graph })
  const topics = await scratch.list(workspace)
  useAppStore.setState({ loading: false, activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspace.id]: layout }, topicCategories: categoriesFromSpatial(graph), spaceZoneBindings: desktopBindingsFromSpatial(graph), scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, reading: false, error: null, topics } }, workbenchSpaceSelection: { workspaceId: workspace.id, spaceId: first.categorySpaceIds[0]!, zoneId: first.zoneId, topicId: first.topicId, tabId: tabs[0]!.id, groupId: layout.activeGroupId, regionId: tabs[0]!.layout.activeRegionId }, pinnedItems: { [workspace.id]: [first.topicId] }, agentComposerDrafts: { ['healthy:' + first.topicId]: 'Original unsent draft' } })
  vi.spyOn(api.topics, 'call').mockImplementation(owner.call.bind(owner)); vi.spyOn(api.spatial, 'read').mockImplementation(() => state.read()); vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  return { workspace, owner, state, first, second, destination, topics }
}
function target(topic: { topicId: string; title: string }): TopicMoveTarget { return { topicId: topic.topicId, title: topic.title } }
function Moving({ moveTarget, onMoved }: { moveTarget: TopicMoveTarget; onMoved?(): void }) {
  const [value, setValue] = useState<TopicMoveTarget | null>(moveTarget)
  return createElement(TopicMoveDialog, { target: value, onClose: () => setValue(null), ...(onMoved ? { onMoved } : {}) })
}

describe('whole Topic transfer through the original Host and Core owners', () => {
  it('confirms an exact Topic/revision, moves once and keeps original content, IDs, cwd, workfaces, pin and draft', async () => {
    const f = await fixture(), moved = vi.fn(), before = useAppStore.getState(), graph = (await f.state.read())!.graph
    const bytes = await readFile(join(f.first.directoryPath, 'topic.md'), 'utf8')
    await mount(createElement(Moving, { moveTarget: target(f.first), onMoved: moved })); await ready()
    expect(document.querySelector('.topic-move-dialog')!.textContent).toContain('Original Topic')
    const inspected = (await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!
    await input(document.querySelector<HTMLSelectElement>('.topic-move-dialog select')!, DESTINATION)
    await click(button('Move Topic')); await settle(() => moved.mock.calls.length === 1)
    expect(api.topics.call).toHaveBeenCalledWith('topic.move', { topicId: f.first.topicId, categoryId: DESTINATION, expectedRevision: inspected.spatialRevision })
    expect(document.querySelector('.topic-move-dialog')).toBeNull()
    const result = (await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!
    expect(result).toMatchObject({ topicId: f.first.topicId, directoryPath: f.first.directoryPath, zoneId: f.first.zoneId, categorySpaceIds: [f.destination!.spaceId] })
    expect(await readFile(join(f.first.directoryPath, 'topic.md'), 'utf8')).toBe(bytes)
    expect((await f.state.read())!.graph.tabs).toEqual(graph.tabs); expect((await f.state.read())!.graph.regions).toEqual(graph.regions); expect((await f.state.read())!.graph.layouts).toEqual(graph.layouts)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().pinnedItems).toBe(before.pinnedItems); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.destination!.spaceId, zoneId: f.first.zoneId, topicId: f.first.topicId })
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('cancel writes nothing, while one Category can create a destination without automatically moving', async () => {
    const f = await fixture(false), revision = (await f.state.read())!.revision
    await mount(createElement(Moving, { moveTarget: target(f.first) })); await ready(); await click(button('Cancel'))
    expect((await f.state.read())!.revision).toBe(revision)
    expect(vi.mocked(api.topics.call).mock.calls.some(([method]) => method === 'topic.move')).toBe(false)
    await act(async () => root!.render(createElement(Moving, { key: 'new-opening', moveTarget: target(f.first) }))); await ready()
    expect(document.querySelectorAll('.topic-move-dialog select option')).toHaveLength(1)
    await click(button('New category…'))
    await input(document.querySelector<HTMLInputElement>('.topic-dialog:not(.topic-move-dialog) input')!, 'New destination')
    await click(button('Save category')); await settle(() => !document.querySelector('.topic-dialog:not(.topic-move-dialog)')); await ready()
    const category = (await f.owner.call('topic.category.ls', {})).categories.find(category => category.title === 'New destination')!
    expect(await readFile(join(category.directoryPath, 'category.md'), 'utf8')).toBe('# New destination\n')
    expect(vi.mocked(api.topics.call).mock.calls.some(([method]) => method === 'topic.move')).toBe(false)
    expect((await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!.categorySpaceIds).toEqual(f.first.categorySpaceIds)
    await input(document.querySelector<HTMLSelectElement>('.topic-move-dialog select')!, category.categoryId)
    await click(button('Move Topic')); await settle(() => !document.querySelector('.topic-move-dialog'))
    expect((await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!.categorySpaceIds).toEqual([category.spaceId])
  })
  it('a real stale revision keeps its destination, blocks blind retry, and refresh permits an explicit confirmed move', async () => {
    const f = await fixture(), original = (await f.state.read())!.graph
    await mount(createElement(Moving, { moveTarget: target(f.first) })); await ready()
    await input(document.querySelector<HTMLSelectElement>('.topic-move-dialog select')!, DESTINATION)
    await f.owner.call('topic.category.create', { categoryId: '22222222-2222-4222-8222-222222222222', title: 'Concurrent Category' })
    await click(button('Move Topic')); await settle(() => !!document.querySelector('.topic-move-dialog [role="alert"]'))
    expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe(DESTINATION)
    expect(button('Move Topic').disabled).toBe(true)
    expect((await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!.categorySpaceIds).toEqual(f.first.categorySpaceIds)
    expect((await f.state.read())!.graph.regions).toEqual(original.regions)
    await click(button('Refresh Topic and categories')); await ready()
    expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe(DESTINATION)
    expect(button('Move Topic').disabled).toBe(false)
    await click(button('Move Topic')); await settle(() => !document.querySelector('.topic-move-dialog'))
    expect(vi.mocked(api.topics.call).mock.calls.filter(([method]) => method === 'topic.move')).toHaveLength(2)
  })
  it('unknown reads preserve the workface and become usable after an explicit refresh', async () => {
    const f = await fixture(), before = useAppStore.getState()
    vi.mocked(api.spatial.read).mockResolvedValueOnce(null)
    await mount(createElement(Moving, { moveTarget: target(f.first) })); await ready()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('not confirmed')
    expect(button('Move Topic').disabled).toBe(true)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    await click(button('Refresh Topic and categories')); await ready()
    await input(document.querySelector<HTMLSelectElement>('select')!, DESTINATION)
    expect(button('Move Topic').disabled).toBe(false)
    await click(button('Cancel'))
    expect(vi.mocked(api.topics.call).mock.calls.some(([method]) => method === 'topic.move')).toBe(false)
  })
  it('a lost save reply keeps choice and does not repeat the mutation on refresh', async () => {
    const f = await fixture(), call = f.owner.call.bind(f.owner)
    vi.mocked(api.topics.call).mockImplementation(async <M extends TopicMethod>(method: M, params: TopicParams<M>): Promise<TopicResult<M>> => {
      const result = await call(method, params)
      if (method === 'topic.move') throw Error('The saved transfer reply is unavailable')
      return result
    })
    await mount(createElement(Moving, { moveTarget: target(f.first) })); await ready()
    await input(document.querySelector<HTMLSelectElement>('select')!, DESTINATION); await click(button('Move Topic'))
    await settle(() => !!document.querySelector('[role="alert"]'))
    expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe(DESTINATION)
    expect(button('Move Topic').disabled).toBe(true)
    expect((await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!.categorySpaceIds).toEqual([f.destination!.spaceId])
    await click(button('Refresh Topic and categories')); await ready()
    expect(button('Move Topic').disabled).toBe(true)
    expect(vi.mocked(api.topics.call).mock.calls.filter(([method]) => method === 'topic.move')).toHaveLength(1)
    await click(button('Cancel'))
  })
  it('a late mutation preserves newer navigation and cannot close another Topic dialog', async () => {
    const f = await fixture(), call = f.owner.call.bind(f.owner), close = vi.fn()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.topics.call).mockImplementation(async <M extends TopicMethod>(method: M, params: TopicParams<M>): Promise<TopicResult<M>> => { if (method === 'topic.move') await held; return call(method, params) })
    await mount(createElement(TopicMoveDialog, { target: target(f.first), onClose: close })); await ready()
    await input(document.querySelector<HTMLSelectElement>('select')!, DESTINATION); await click(button('Move Topic'))
    const newer = { ...useAppStore.getState().workbenchSpaceSelection!, topicId: f.second.topicId, zoneId: f.second.zoneId }
    await act(async () => { useAppStore.setState({ workbenchSpaceSelection: newer }); root!.render(createElement(TopicMoveDialog, { target: target(f.second), onClose: close })) }); await ready()
    await act(async () => { release(); await held }); await settle(() => vi.mocked(api.spatial.read).mock.calls.length >= 3)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(newer)
    expect(document.querySelector('.topic-move-dialog')!.textContent).toContain('Other Topic'); expect(close).not.toHaveBeenCalled()
  })
  it('the actual Topic knowledge panel opens the shared dialog for that original Topic', async () => {
    const f = await fixture(), snapshot = f.topics.find(topic => topic.id === f.first.topicId)!
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: snapshot }))
    await settle(() => !host.textContent!.includes('Reading knowledge…'))
    await click(button('Move to category…')); await ready()
    expect(document.querySelector('.topic-move-dialog')!.textContent).toContain(f.first.title)
    expect(api.topics.call).toHaveBeenCalledWith('topic.inspect', { topicId: f.first.topicId })
    await click(button('Cancel'))
    expect(document.querySelector('.topic-knowledge-panel')).not.toBeNull()
  })
})

describe('Topic action menus use actual Radix items and original actions', () => {
  function actions() { return { pinned: true, onCopyPath: vi.fn(), onRename: vi.fn(), onReveal: vi.fn(), onTogglePin: vi.fn(), onEditWiki: vi.fn(), onMove: vi.fn(), onChangeIcon: vi.fn(), onToggleWiki: vi.fn(), onResetWiki: vi.fn(), wikiEnabled: true } }
  async function openActions() {
    const trigger = button('Actions for Original Topic'); trigger.focus()
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await settle(() => !!document.querySelector('[role="menu"]'))
    return trigger
  }
  it('visible row menu retains every action and hands focus back to its invoker before the transfer dialog callback', async () => {
    const a = actions(); let invoker: Element | null = null
    a.onMove.mockImplementation(() => { invoker = document.activeElement })
    await mount(createElement(TopicActionsMenu, { title: 'Original Topic', ...a })); const trigger = await openActions()
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Move to category…', 'Change icon…', 'Unpin Topic', 'Rename Topic', 'Reveal in Files', 'Copy Topic Path', 'Edit Topic Wiki', 'Disable Topic Wiki', 'Restore default Topic Wiki'])
    await click(document.querySelector('[role="menuitem"]')!); await settle(() => a.onMove.mock.calls.length === 1)
    expect(invoker).toBe(trigger)
    expect(a.onReveal).not.toHaveBeenCalled(); expect(a.onTogglePin).not.toHaveBeenCalled()
  })
  it('the action trigger and original pin/reveal actions do not activate the enclosing sortable row', async () => {
    const a = actions(), row = vi.fn()
    await mount(createElement('div', { onKeyDown: row, onPointerDown: row, onClick: row }, createElement(TopicActionsMenu, { title: 'Original Topic', ...a })))
    const trigger = await openActions()
    expect(row).not.toHaveBeenCalled()
    await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Unpin Topic')!)
    await settle(() => a.onTogglePin.mock.calls.length === 1)
    expect(row).not.toHaveBeenCalled()
    await settle(() => document.activeElement === trigger)
    await openActions()
    await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Reveal in Files')!)
    await settle(() => a.onReveal.mock.calls.length === 1)
    expect(row).not.toHaveBeenCalled(); expect(a.onMove).not.toHaveBeenCalled()
  })
  it('right-click and Shift+F10 expose the same transfer action without opening the Topic', async () => {
    const a = actions(), opened = vi.fn()
    await mount(createElement(TopicContextMenu, { ...a, children: createElement('div', { role: 'button', tabIndex: 0, onClick: opened }, 'Original Topic') }))
    const row = host.querySelector<HTMLElement>('[role="button"]')!; row.focus()
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
    await settle(() => !!document.querySelector('[role="menu"]'))
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(9)
    expect(document.querySelector('[role="menuitem"]')!.textContent).toBe('Move to category…')
    await click(document.querySelector('[role="menuitem"]')!); await settle(() => a.onMove.mock.calls.length === 1)
    expect(opened).not.toHaveBeenCalled(); expect(document.activeElement).toBe(row)
  })
})
