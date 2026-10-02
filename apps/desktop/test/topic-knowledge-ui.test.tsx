// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { ExecutionHost, TopicKnowledge, TopicKnowledgeSource } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { TopicKnowledgePanel } from '../src/renderer/src/components/TopicKnowledgePanel'
import { TopicKnowledgeCapture, TopicKnowledgeEditor } from '../src/renderer/src/components/TopicKnowledgeEditor'
import { TopicCategoryDialog } from '../src/renderer/src/components/TopicCategoryDialog'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { selectedKnowledgeSources, moveKnowledgeTopic, openKnowledgeSource } from '../src/renderer/src/lib/topic-knowledge-actions'
import { desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { categoriesFromSpatial } from '../src/shared/topic-categories'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('No avatar writes in this proof') } } }))
const initial = useAppStore.getState(), CATEGORY = '11111111-1111-4111-8111-111111111111'
let directories: string[] = [], root: Root | null = null, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useAppStore.setState(initial, true); host = document.createElement('div'); document.body.append(host) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate()).toBe(true)
}
async function mount(component: React.ReactNode) { root = createRoot(host); await act(async () => root!.render(component)) }
async function click(node: Element) { await act(async () => { (node as HTMLElement).click() }) }
async function input(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => { const type = node instanceof HTMLSelectElement ? HTMLSelectElement : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(type.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
function button(label: string): HTMLButtonElement { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label); expect(node, label).toBeDefined(); return node! }
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'topic-ui-owner-'))); directories.push(directory)
  const path = join(directory, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)), state = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const first = (await owner.call('topic.create', { topicId: 'view:first', title: '工作方法' })).topic
  const second = (await owner.call('topic.create', { topicId: 'view:second', title: '学习资料' })).topic
  const category = (await owner.call('topic.category.create', { categoryId: CATEGORY, title: '工作' })).category
  const original = (await state.read())!, tabs = [first, second].map(topic => ({ ...createWorkbenchTab('chat:' + topic.topicId, { kind: 'agent', phase: 'attached', regionId: 'thread:' + topic.topicId, workspaceId: workspace.id, sessionId: 'healthy:' + topic.topicId }), topicId: topic.topicId, space: { spaceId: topic.categorySpaceIds[0]!, zoneId: topic.zoneId } }))
  const layout = createWorkspaceLayout('original-group', tabs.map(tab => tab.id))
  const graph = original.graph
  graph.tabs = tabs.map(tab => ({ tabId: tab.id, zoneId: tab.space.zoneId, workspaceId: workspace.id, name: null, regionIds: [tab.layout.activeRegionId] }))
  graph.regions = tabs.map(tab => ({ tabId: tab.id, regionId: tab.layout.activeRegionId, kind: 'agent', agentSessionId: 'healthy:' + tab.topicId, runId: 'original-run', execution: { hostId: 'local', cwd: first.directoryPath } }))
  graph.layouts[workspace.id] = layout
  await state.commit({ expectedRevision: original.revision, graph })
  const topics = await scratch.list(workspace), config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  useAppStore.setState({ config, loading: false, activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspace.id]: layout }, topicCategories: categoriesFromSpatial(graph), spaceZoneBindings: desktopBindingsFromSpatial(graph), scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, reading: false, error: null, topics } }, workbenchSpaceSelection: { workspaceId: workspace.id, spaceId: first.categorySpaceIds[0]!, zoneId: first.zoneId, topicId: first.topicId, tabId: tabs[0]!.id, groupId: layout.activeGroupId, regionId: tabs[0]!.layout.activeRegionId }, pinnedItems: { [workspace.id]: [first.topicId] }, agentComposerDrafts: { ['healthy:' + first.topicId]: 'Original unsent draft' } })
  vi.spyOn(api.topics, 'call').mockImplementation(owner.call.bind(owner))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => state.read())
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => scratch.list(workspace))
  vi.spyOn(api.scratch, 'readTopic').mockImplementation((_workspace, id) => scratch.read(workspace, id))
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  return { workspace, owner, state, first, second, category, topics, tabs, layout }
}
async function entry(owner: TopicKnowledgeOwner, topicId: string, title: string, sources: TopicKnowledgeSource[] = []): Promise<TopicKnowledge> {
  return (await owner.call('topic.knowledge.write', { topicId, entryId: crypto.randomUUID(), title, content: 'Useful original conclusion', form: sources.length ? 'reference' : 'derived', certainty: 'decision', sources, expectedRevision: null })).entry
}
describe('Topic knowledge UI consumes the real Host content and Core graph owners', () => {
  it('creates a Category in its original owner and cancel does not rename or write', async () => {
    const f = await fixture(), close = vi.fn()
    await mount(createElement(TopicCategoryDialog, { target: 'create', onClose: close }))
    await settle(() => !!document.querySelector('[role="dialog"] input'))
    await input(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Ideas')
    await click(button('Save category')); await settle(() => close.mock.calls.length === 1)
    const category = (await f.owner.call('topic.category.ls', {})).categories.find(category => category.title === 'Ideas')!
    expect(await readFile(join(category.directoryPath, 'category.md'), 'utf8')).toBe('# Ideas\n')
    expect((await f.state.read())!.graph.spaces.some(space => space.spaceId === category.spaceId)).toBe(true)
    await act(async () => root!.render(createElement(TopicCategoryDialog, { target: category, onClose: close })))
    await input(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Cancelled name'); await click(button('Cancel'))
    expect((await f.owner.call('topic.category.ls', {})).categories.find(item => item.categoryId === category.categoryId)?.title).toBe('Ideas')
    await input(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Research')
    await click(button('Save category')); await settle(() => close.mock.calls.length === 3)
    expect((await f.owner.call('topic.category.ls', {})).categories.find(item => item.categoryId === category.categoryId)).toMatchObject({ title: 'Research', spaceId: category.spaceId, directoryPath: category.directoryPath })
  })
  it('shows Category→Topic from Core membership and Topic move keeps original Chat, Thread, pin and draft', async () => {
    const f = await fixture(), before = useAppStore.getState(), current = (await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!
    await moveKnowledgeTopic(current, CATEGORY)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.category.spaceId, zoneId: f.first.zoneId, tabId: f.tabs[0]!.id, regionId: f.tabs[0]!.layout.activeRegionId })
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().pinnedItems).toBe(before.pinnedItems); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect((await f.state.read())!.graph.regions).toHaveLength(2); expect(api.sessions.stop).not.toHaveBeenCalled()
    await mount(createElement(SpaceTopicsTree, { workspace: f.workspace, icons: {}, onChangeIcon: () => {} }))
    const row = document.querySelector(`[data-space-nav="topic:${f.first.topicId}"]`)!
    expect(row.getAttribute('data-space-parent')).toBe('topic-category:' + CATEGORY)
    expect((row as HTMLElement).style.getPropertyValue('--rail-depth')).toBe('2')
    await click(document.querySelector(`[data-space-nav="topic-category:${CATEGORY}"]`)!)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.category.spaceId, zoneId: null, topicId: null })
  })
  it('lists and searches only this Topic, rejects a stale real save and keeps the editing draft', async () => {
    const f = await fixture(), original = await entry(f.owner, f.first.topicId, 'Hiring principles')
    await entry(f.owner, f.second.topicId, 'Private other Topic')
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    await settle(() => !!document.querySelector('.topic-knowledge-row'))
    expect(host.textContent).toContain('Hiring principles'); expect(host.textContent).not.toContain('Private other Topic')
    expect(api.topics.call).toHaveBeenCalledWith('topic.knowledge.ls', { topicId: f.first.topicId, limit: 100 })
    await click(document.querySelector('.topic-knowledge-row')!)
    await input(document.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!, 'No match here')
    await click(button('Search')); await settle(() => host.textContent!.includes('No knowledge matches this search.'))
    expect(document.querySelector('.topic-knowledge-entry')).toBeNull()
    expect(api.topics.call).toHaveBeenCalledWith('topic.knowledge.search', { topicId: f.first.topicId, query: 'No match here', limit: 100 })
    await input(document.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!, '')
    await settle(() => !!document.querySelector('.topic-knowledge-row'))
    await click(document.querySelector('.topic-knowledge-row')!); await click(button('Edit knowledge'))
    await input(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'My preserved draft')
    const newer = (await f.owner.call('topic.knowledge.write', { topicId: original.topicId, entryId: original.entryId, title: original.title, form: original.form, certainty: original.certainty, sources: original.sources, expectedRevision: original.revision, content: 'Concurrent saved conclusion' }).catch(() => { throw Error('Strict fixture payload') }))
    expect(newer.entry.content).toBe('Concurrent saved conclusion')
    await click(button('Save knowledge')); await settle(() => !!document.querySelector('[role="alert"]'))
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('My preserved draft')
    expect((await f.owner.call('topic.knowledge.read', { topicId: original.topicId, entryId: original.entryId })).entry!.content).toBe('Concurrent saved conclusion')
  })
  it('writes a captured original research reference to an explicit Topic without changing the current workface', async () => {
    const f = await fixture(), before = useAppStore.getState(), sources: TopicKnowledgeSource[] = [{ kind: 'survey', zoneId: 'original-research', tabId: 'original-tab', regionId: 'original-note' }]
    await new ScratchTopics().renameTitle(f.workspace, f.second.topicId, f.first.title)
    await mount(createElement(TopicKnowledgeCapture, { target: { title: 'Original research', sources }, onClose: () => {} }))
    await settle(() => document.querySelectorAll('select option').length >= 3)
    const destinations = [...document.querySelectorAll<HTMLOptionElement>('select option')].filter(option => option.value.startsWith('view:'))
    expect(destinations.map(option => option.textContent)).toEqual([expect.stringContaining(f.first.directoryPath), expect.stringContaining(f.second.directoryPath)])
    expect(new Set(destinations.map(option => option.textContent)).size).toBe(2)
    await input(document.querySelector<HTMLSelectElement>('select')!, f.second.topicId); await click(button('Continue'))
    await settle(() => !!document.querySelector('textarea'))
    await click(button('Save knowledge')); await settle(() => !!api.topics.call && [...document.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Continue'))
    const result = await f.owner.call('topic.knowledge.ls', { topicId: f.second.topicId })
    expect(result.entries).toContainEqual(expect.objectContaining({ title: 'Original research', form: 'reference', sources, content: '' }))
    await input(document.querySelector<HTMLSelectElement>('select')!, '__new_topic__')
    await input(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Research methods')
    await input(document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')[1]!, CATEGORY)
    await click(button('Continue')); await settle(() => !!document.querySelector('textarea'))
    const created = (await f.owner.call('topic.ls', {})).topics.find(topic => topic.title === 'Research methods')!
    expect(created.categorySpaceIds).toEqual([f.category.spaceId])
    await click(button('Save knowledge')); await settle(() => [...document.querySelectorAll('button')].some(node => node.textContent?.trim() === 'Continue'))
    expect((await f.owner.call('topic.knowledge.ls', { topicId: created.topicId })).entries).toContainEqual(expect.objectContaining({ title: 'Original research', sources, form: 'reference' }))
    expect((await f.state.read())!.graph.tabs.map(tab => tab.tabId)).toEqual(f.tabs.map(tab => tab.id))
    expect((await f.state.read())!.graph.regions).toHaveLength(2); expect(api.sessions.stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  })
  it('keeps a captured target through later navigation and writes original revision/source metadata', async () => {
    const f = await fixture(), source: TopicKnowledgeSource = { kind: 'file', hostId: 'local', path: f.first.directoryPath + '/outcome/original.md', revision: 'original-source' }, saved = vi.fn()
    await mount(createElement(TopicKnowledgeEditor, { target: { topicId: f.first.topicId, title: 'Selected source', sources: [source] }, onClose: () => {}, onSaved: saved }))
    await settle(() => !!document.querySelector('textarea'))
    await input(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Bounded derived conclusion')
    useAppStore.setState(state => ({ workbenchSpaceSelection: { ...state.workbenchSpaceSelection!, topicId: f.second.topicId, zoneId: f.second.zoneId } }))
    await click(button('Save knowledge')); await settle(() => saved.mock.calls.length > 0)
    expect(saved.mock.calls[0]![0]).toMatchObject({ topicId: f.first.topicId, sources: [source], content: 'Bounded derived conclusion' })
    expect((await f.owner.call('topic.knowledge.ls', { topicId: f.second.topicId })).entries).toEqual([])
  })
  it('rejects a source Chat claim pointing to another Topic before navigation and uses general Space provenance for unknown objects', async () => {
    const f = await fixture(), navigation = vi.spyOn(useAppStore.getState(), 'openScratchTopic')
    await expect(openKnowledgeSource({ kind: 'topic', topicId: f.first.topicId, chatId: f.tabs[1]!.id, threadId: f.tabs[1]!.layout.activeRegionId })).rejects.toThrow('not uniquely confirmed')
    expect(navigation).not.toHaveBeenCalled()
    useAppStore.setState({ spaceZoneBindings: {} })
    expect(selectedKnowledgeSources(f.workspace.id)?.sources).toEqual([{ kind: 'space', zoneId: f.first.zoneId, tabId: f.tabs[0]!.id, regionId: f.tabs[0]!.layout.activeRegionId }])
    const originalBindings = desktopBindingsFromSpatial((await f.state.read())!.graph)
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [f.tabs[0]!.id]: { ...state.tabs[f.tabs[0]!.id]!, topicId: 'view:obsolete-tag' } }, spaceZoneBindings: originalBindings }))
    expect(selectedKnowledgeSources(f.workspace.id)?.sources).toEqual([{ kind: 'topic', topicId: f.first.topicId, chatId: f.tabs[0]!.id, threadId: f.tabs[0]!.layout.activeRegionId }])
  })
})
