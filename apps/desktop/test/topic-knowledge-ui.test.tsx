const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore, spatialCatalog } from '@agentmux/core/spatial-state'
import type { ExecutionHost, TopicKnowledge, TopicKnowledgeSource } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '../src/main/file-read-owner'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { TopicKnowledgePanel } from '../src/renderer/src/components/TopicKnowledgePanel'
import { TopicKnowledgeCapture, TopicKnowledgeEditor } from '../src/renderer/src/components/TopicKnowledgeEditor'
import { TopicCategoryDialog } from '../src/renderer/src/components/TopicCategoryDialog'
import { SpaceTopicsTree } from '../src/renderer/src/components/SpaceTopicsTree'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { WorkspaceFilesTool } from '../src/renderer/src/components/SurfaceToolDock'
import { createWorkbenchTab, fileTabId, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { selectedKnowledgeSources, moveKnowledgeTopic, openKnowledgeSource } from '../src/renderer/src/lib/topic-knowledge-actions'
import { desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { categoriesFromSpatial } from '../src/shared/topic-categories'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useAppStore } from '../src/renderer/src/store'
import { resolveDesktopSpaceSelection, workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { api } from '../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
const dragBoundary = vi.hoisted(() => ({ end: undefined as ((event: import('@dnd-kit/core').DragEndEvent) => void) | undefined }))
// Observe the real component's registered drag callback; all Dnd rendering and Topic owners remain original.
vi.mock('@dnd-kit/core', async load => {
  const original = await load<typeof import('@dnd-kit/core')>()
  return { ...original, DndContext: (props: import('@dnd-kit/core').DndContextProps) => {
    dragBoundary.end = props.onDragEnd
    return createElement(original.DndContext, props)
  } }
})
// Native PTY painting is outside this happy-dom navigation boundary; Electron proves the real workface.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('div', { 'data-native-pty-paint-isolated': '' }) }))
// The production File action warms Monaco. This navigation fixture mounts no editor;
// the private Electron proof checks the real canvas and one-click visible File.
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('No avatar writes in this proof') } } }))
const initial = useAppStore.getState(), CATEGORY = '11111111-1111-4111-8111-111111111111'
let directories: string[] = [], root: Root | null = null, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useAppStore.setState(initial, true); host = document.createElement('div'); document.body.append(host) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(predicate()).toBe(true)
}
async function mount(component: React.ReactNode) { root = createClientUiRoot(host); await act(async () => root!.render(component)) }
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
  const publicFiles = new FileReadOwner({ workspace: id => id === workspace.id ? workspace : undefined,
    topicForDirectory: (candidate, directory) => scratch.readForDirectory(candidate, directory), files,
    catalog: async () => { const current = await state.read(); return current ? spatialCatalog(current.graph) : null } })
  owner.setFileReadPort(publicFiles)
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
  vi.spyOn(api.files, 'readPublic').mockImplementation(publicFiles.read.bind(publicFiles))
  vi.spyOn(api.files, 'read').mockImplementation((_workspace, path) => files.read(workspace, path))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  return { workspace, owner, state, first, second, category, topics, tabs, layout, publicFiles }
}
async function entry(owner: TopicKnowledgeOwner, topicId: string, title: string, sources: TopicKnowledgeSource[] = []): Promise<TopicKnowledge> {
  return (await owner.call('topic.knowledge.write', { topicId, entryId: crypto.randomUUID(), title, content: 'Useful original conclusion', form: sources.length ? 'reference' : 'derived', certainty: 'decision', sources, expectedRevision: null })).entry
}
describe('Topic knowledge UI consumes the real Host content and Core graph owners', () => {
  it('finds Chinese body-only text in an existing original file and reads its exact public Files source without creating knowledge', async () => {
    const f = await fixture(), body = '# 原文\n挂载磁盘权限与安全清理的原始讨论。\n'
    await writeFile(join(f.first.directoryPath, 'outcome', 'report.md'), body)
    await writeFile(join(f.second.directoryPath, 'outcome', 'report.md'), '另一个 Topic 的磁盘资料。')
    const before = useAppStore.getState()
    await expect(access(join(f.first.directoryPath, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)!, topics: f.topics }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!
    await input(field, '磁盘'); await click(button('Search'))
    await settle(() => host.querySelectorAll('[data-document-path="outcome/report.md"]').length === 1)
    const row = host.querySelector<HTMLButtonElement>('[data-document-path="outcome/report.md"]')!
    expect(row.dataset.documentTopicId).toBe(f.first.topicId)
    expect(row.textContent).toContain('挂载磁盘权限')
    expect(host.querySelector('[data-knowledge-topic-id]')).toBeNull()
    await click(row)
    await settle(() => !!host.querySelector('[aria-label="Original document detail"]')?.textContent?.includes('挂载磁盘权限'))
    expect(api.files.readPublic).toHaveBeenCalledWith(expect.objectContaining({ zoneId: f.first.zoneId, path: 'outcome/report.md', maxBytes: 131072 }))
    expect(host.querySelector('[aria-label="Original document detail"]')?.textContent).toContain('Original file · outcome/report.md')
    const open = vi.spyOn(useAppStore.getState(), 'openFile').mockResolvedValue(true)
    await click(button('Open original file'))
    const original = await f.publicFiles.read((await f.owner.call('topic.knowledge.search', { topicId: f.first.topicId, query: '磁盘' })).documents[0]!.target)
    expect(open).toHaveBeenCalledWith(original.resource!.path, expect.any(String), undefined, f.workspace.id, true,
      expect.objectContaining({ focus: true, space: expect.objectContaining({ zoneId: f.first.zoneId }), selection: expect.objectContaining({ topicId: f.first.topicId }) }))
    await click(button('Close document detail'))
    expect(document.activeElement).toBe(row); expect(field.value).toBe('磁盘')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(api.sessions.stop).not.toHaveBeenCalled()
    expect(await readFile(join(f.first.directoryPath, 'outcome', 'report.md'), 'utf8')).toBe(body)
    await expect(access(join(f.first.directoryPath, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('global file results retain their source Topic and late document reads cannot take over after clear', async () => {
    const f = await fixture()
    await writeFile(join(f.second.directoryPath, 'outcome', 'source.txt'), '正文里的磁盘资料。')
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topics: f.topics }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!
    await input(field, '磁盘'); await click(button('Search'))
    await settle(() => !!host.querySelector('[data-document-path="outcome/source.txt"]'))
    const row = host.querySelector('[data-document-path="outcome/source.txt"]')!
    expect(row.textContent).toContain('学习资料'); expect(row.getAttribute('data-document-topic-id')).toBe(f.second.topicId)
    let release!: () => void
    vi.mocked(api.files.readPublic).mockImplementation(async request => { await new Promise<void>(resolve => { release = resolve }); return f.publicFiles.read(request) })
    await click(row); await settle(() => !!release)
    await click(button('Clear search')); await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(host.querySelector('[aria-label="Original document detail"]')).toBeNull()
    expect(host.querySelector('.topic-knowledge-row')).toBeNull(); expect(document.activeElement).toBe(field)
  })
  it('keeps the confirmed body and exact file actions through an observation gap, and refuses both actions after the Workspace changes', async () => {
    const f = await fixture(), body = '原始磁盘记录。\n[原参考](../refs/reference.txt)'
    await writeFile(join(f.first.directoryPath, 'outcome', 'source.md'), body)
    await writeFile(join(f.first.directoryPath, 'refs', 'reference.txt'), '原参考内容')
    const before = useAppStore.getState()
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    await settle(() => !!host.querySelector('[data-document-path="outcome/source.md"]'))
    await click(host.querySelector('[data-document-path="outcome/source.md"]')!)
    await settle(() => !!host.querySelector('[aria-label="Original document detail"] .md-link--file'))
    const open = vi.spyOn(useAppStore.getState(), 'openFile').mockResolvedValue(true)
    const source = (await f.owner.call('topic.knowledge.ls', { topicId: f.first.topicId })).documents.find(document => document.target.path === 'outcome/source.md')!
    const original = (await f.publicFiles.read(source.target)).resource!
    const referencePath = host.querySelector('[aria-label="Original document detail"] .md-link--file')!.getAttribute('title')!
    vi.mocked(api.files.readPublic).mockResolvedValue({ resource: null, result: { status: 'unknown', code: 'FILE_RESOURCE_UNCONFIRMED', message: 'Source temporarily unavailable' } })
    await click(button('Refresh knowledge'))
    await settle(() => !!host.textContent?.includes('Source temporarily unavailable'))
    expect(host.querySelector('[aria-label="Original document detail"]')?.textContent).toContain('原始磁盘记录。')
    await click(button('Open original file'))
    expect(open).toHaveBeenLastCalledWith(original.path, expect.any(String), undefined, f.workspace.id, true, expect.objectContaining({ focus: true }))
    await click(host.querySelector('[aria-label="Original document detail"] .md-link--file')!)
    expect(open).toHaveBeenLastCalledWith(referencePath, expect.any(String), undefined, f.workspace.id, true, expect.objectContaining({ focus: true }))
    open.mockClear()
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...f.workspace, path: _hygiene_fixturePath("different-resource") }] } }))
    await click(button('Open original file')); await click(host.querySelector('[aria-label="Original document detail"] .md-link--file')!)
    expect(open).not.toHaveBeenCalled(); expect(host.textContent).toContain('original Workspace changed')
    expect(host.querySelector('[aria-label="Original document detail"]')?.textContent).toContain('原始磁盘记录。')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('reports a bounded read omission as incomplete instead of a complete empty search', async () => {
    const f = await fixture()
    await writeFile(join(f.first.directoryPath, 'outcome', 'large.txt'), 'x'.repeat(131073) + '磁盘')
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!
    await input(field, '磁盘'); await click(button('Search'))
    await settle(() => host.querySelector('.topic-knowledge-results__label')?.textContent === 'Search incomplete')
    expect(host.textContent).toContain('Some sources could not be searched'); expect(host.textContent).not.toContain('No matches')
    expect(host.textContent).not.toContain('No saved knowledge or text documents match this search.')
    expect(await readFile(join(f.first.directoryPath, 'outcome', 'large.txt'), 'utf8')).toHaveLength(131075)
  })
  it('opens a global original-file result directly into its own visible Zone using the production store, keeping the original Chats and drafts', async () => {
    const f = await fixture(), body = '原文磁盘资料。\n[来源](../refs/reference.txt)'
    await writeFile(join(f.second.directoryPath, 'outcome', 'report.md'), body)
    await writeFile(join(f.second.directoryPath, 'refs', 'reference.txt'), '原参考正文')
    const before = useAppStore.getState()
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topics: f.topics }))
    await input(host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!, '磁盘'); await click(button('Search'))
    await settle(() => !!host.querySelector('[data-document-path="outcome/report.md"]'))
    await click(host.querySelector('[data-document-path="outcome/report.md"]')!)
    await settle(() => !!host.querySelector('[aria-label="Original document detail"] .md-link--file'))
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    await click(button('Open original file'))
    const resource = (await f.publicFiles.read((await f.owner.call('topic.knowledge.search', { query: '磁盘' })).documents[0]!.target)).resource!
    const tabId = fileTabId(f.workspace.id, resource.path)
    await settle(() => useAppStore.getState().workbenchSpaceSelection?.tabId === tabId)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ zoneId: f.second.zoneId, topicId: f.second.topicId, tabId })
    expect(useAppStore.getState().tabs[tabId]?.space?.zoneId).toBe(f.second.zoneId)
    expect(useAppStore.getState().documents[documentKey(f.workspace.id, resource.path)]?.content).toBe(body)
    const relative = host.querySelector('[aria-label="Original document detail"] .md-link--file')!
    const referencePath = relative.getAttribute('title')!, referenceTab = fileTabId(f.workspace.id, referencePath)
    await click(relative); await settle(() => useAppStore.getState().workbenchSpaceSelection?.tabId === referenceTab)
    expect(useAppStore.getState().workbenchSpaceSelection?.zoneId).toBe(f.second.zoneId)
    expect(useAppStore.getState().documents[documentKey(f.workspace.id, referencePath)]?.content).toBe('原参考正文')
    for (const tab of f.tabs) expect(useAppStore.getState().tabs[tab.id]).toBe(before.tabs[tab.id])
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('clears the search and detail without a late global result reclaiming the panel', async () => {
    const f = await fixture(), saved = await entry(f.owner, f.first.topicId, 'Original decision'), before = useAppStore.getState()
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topics: f.topics }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!
    await input(field, saved.title); await click(button('Search'))
    await settle(() => !!host.querySelector('.topic-knowledge-row'))
    await click(host.querySelector('.topic-knowledge-row')!)
    expect(host.querySelector('.topic-knowledge-entry')).not.toBeNull()
    let release!: () => void
    vi.mocked(api.topics.call).mockImplementation(async (method, request) => {
      if (method === 'topic.knowledge.search') await new Promise<void>(resolve => { release = resolve })
      return f.owner.call(method, request)
    })
    await input(field, 'Later result'); await click(button('Search')); await settle(() => !!release)
    await click(button('Clear search'))
    expect(field.value).toBe(''); expect(document.activeElement).toBe(field)
    expect(host.querySelector('.topic-knowledge-entry')).toBeNull(); expect(host.querySelector('.topic-knowledge-row')).toBeNull()
    await act(async () => release())
    expect(host.querySelector('.topic-knowledge-row')).toBeNull()
    expect(host.textContent).toContain('Search across all Topics to find saved knowledge and original text documents.')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('closes the reader back to its original result and keeps the exact query and sources', async () => {
    const f = await fixture(), saved = await entry(f.owner, f.first.topicId, 'Original reference', [{ kind: 'url', url: 'https://example.com/original' }])
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!
    await input(field, saved.title); await click(button('Search')); await settle(() => !!host.querySelector('.topic-knowledge-row'))
    const row = host.querySelector<HTMLButtonElement>('.topic-knowledge-row')!
    await click(row); expect(host.querySelector('.topic-knowledge-source')?.textContent).toContain('https://example.com/original')
    await click(button('Close knowledge detail'))
    expect(host.querySelector('.topic-knowledge-entry')).toBeNull(); expect(field.value).toBe(saved.title)
    expect(document.activeElement).toBe(row); expect(host.querySelector('.topic-knowledge-row')).toBe(row)
    await click(row)
    expect(host.querySelector('.topic-knowledge-source')?.textContent).toContain('https://example.com/original')
    await click(button('Clear search')); await settle(() => !!host.querySelector('.topic-knowledge-row'))
    expect(field.value).toBe(''); expect(host.querySelector('.topic-knowledge-entry')).toBeNull()
    expect(api.topics.call).toHaveBeenLastCalledWith('topic.knowledge.ls', { topicId: f.first.topicId, limit: 100 })
  })
  it('closes a retained detail to the search input when a partial read removes its result row', async () => {
    const f = await fixture(), saved = await entry(f.owner, f.first.topicId, 'Original reference'), before = useAppStore.getState()
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    await settle(() => !!host.querySelector('.topic-knowledge-row')); await click(host.querySelector('.topic-knowledge-row')!)
    vi.mocked(api.topics.call).mockImplementation(async (method, request) => {
      if (method === 'topic.knowledge.ls') return { entries: [], documents: [], unavailable: [{ code: 'read-unavailable', message: 'Knowledge read is temporarily unavailable', recovery: 'Refresh knowledge' }] }
      return f.owner.call(method, request)
    })
    await click(button('Refresh knowledge')); await settle(() => !host.querySelector('.topic-knowledge-row'))
    expect(host.querySelector('.topic-knowledge-entry')?.textContent).toContain(saved.title)
    const close = button('Close knowledge detail'); close.focus(); await click(close)
    expect(host.querySelector('.topic-knowledge-entry')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Search this Topic"]'))
    expect(host.textContent).toContain('Knowledge read is temporarily unavailable')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })
  it('keeps the search and detail when Escape cancels IME composition, then clears on ordinary Escape', async () => {
    const f = await fixture(), saved = await entry(f.owner, f.first.topicId, 'Original reference')
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    const field = host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!
    await input(field, saved.title); await click(button('Search')); await settle(() => !!host.querySelector('.topic-knowledge-row'))
    await click(host.querySelector('.topic-knowledge-row')!)
    field.focus()
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...composition })
      await act(async () => { field.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false); expect(field.value).toBe(saved.title)
      expect(host.querySelector('.topic-knowledge-entry')).not.toBeNull(); expect(document.activeElement).toBe(field)
    }
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(field.value).toBe(''); expect(host.querySelector('.topic-knowledge-entry')).toBeNull()
    expect(document.activeElement).toBe(field)
  })
  it('reorders only the shown Category without erasing another Category user order', async () => {
    const f = await fixture(), extra = (await f.owner.call('topic.create', { topicId: 'view:neighbor', title: '工作里的邻居' })).topic
    await moveKnowledgeTopic((await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!, CATEGORY)
    await moveKnowledgeTopic((await f.owner.call('topic.inspect', { topicId: extra.topicId })).topic!, CATEGORY)
    await useAppStore.getState().refreshScratchTopics(f.workspace.id, true)
    useAppStore.setState({ pinnedItems: {}, scratchTopicOrder: [f.second.topicId, 'unshown-original-id', f.first.topicId, extra.topicId] })
    const original = useAppStore.getState()
    await mount(createElement(WorkspaceTopicsPanel, { workspace: f.workspace, categorySpaceId: f.category.spaceId, onRevealDirectory: () => {} }))
    await settle(() => host.querySelectorAll('[data-topic-id]').length === 2)
    expect([...host.querySelectorAll('[data-topic-id]')].map(row => row.getAttribute('data-topic-id'))).toEqual([f.first.topicId, extra.topicId])
    await act(async () => dragBoundary.end!({ active: { id: extra.topicId }, over: { id: f.first.topicId } } as import('@dnd-kit/core').DragEndEvent))
    expect(useAppStore.getState().scratchTopicOrder).toEqual([f.second.topicId, 'unshown-original-id', extra.topicId, f.first.topicId])
    expect([...host.querySelectorAll('[data-topic-id]')].map(row => row.getAttribute('data-topic-id'))).toEqual([extra.topicId, f.first.topicId])
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(original.workbenchSpaceSelection)
    expect(useAppStore.getState().tabs).toBe(original.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  })
  it('opens an exact discussion source once without waiting for a default Chat metadata jump', async () => {
    const f = await fixture(), chat = { ...createWorkbenchTab('source-chat', { kind: 'agent', phase: 'attached', regionId: 'source-thread', workspaceId: f.workspace.id, sessionId: 'source-agent' }), topicId: f.first.topicId, space: f.tabs[0]!.space }
    const graph = (await f.state.read())!.graph, layout = { ...f.layout, groups: f.layout.groups.map(group => ({ ...group, tabOrder: [...group.tabOrder, chat.id] })) }
    graph.tabs.push({ tabId: chat.id, zoneId: f.first.zoneId, workspaceId: f.workspace.id, name: null, regionIds: ['source-thread'] })
    graph.regions.push({ tabId: chat.id, regionId: 'source-thread', kind: 'agent', agentSessionId: 'source-agent', runId: 'source-run', execution: { hostId: 'local', cwd: f.first.directoryPath } })
    graph.layouts[f.workspace.id] = layout
    await f.state.commit({ expectedRevision: (await f.state.read())!.revision, graph })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [chat.id]: chat }, layouts: { ...state.layouts, [f.workspace.id]: layout } }))
    const before = useAppStore.getState(), source = { kind: 'topic' as const, topicId: f.first.topicId, chatId: chat.id, threadId: 'source-thread' }
    await entry(f.owner, f.first.topicId, 'Discussion reference', [source])
    vi.mocked(api.scratch.readTopic).mockImplementation(() => new Promise(() => {}))
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topic: f.topics.find(topic => topic.id === f.first.topicId)! }))
    await settle(() => !!host.querySelector('.topic-knowledge-row')); await click(host.querySelector('.topic-knowledge-row')!)
    const positions: string[] = []
    const unsubscribe = useAppStore.subscribe((next, previous) => { if (next.workbenchSpaceSelection?.tabId !== previous.workbenchSpaceSelection?.tabId) positions.push(next.workbenchSpaceSelection?.tabId ?? 'none') })
    try {
      await click(host.querySelector('.topic-knowledge-source')!)
      await settle(() => useAppStore.getState().workbenchSpaceSelection?.tabId === chat.id)
      expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ topicId: f.first.topicId, zoneId: f.first.zoneId, tabId: chat.id, regionId: 'source-thread' })
      expect(positions).toEqual([chat.id]); expect(api.scratch.readTopic).not.toHaveBeenCalled()
      expect(useAppStore.getState().tabs).toEqual(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(api.sessions.stop).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })
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
  it('shows Categories in Space and their Topics in the directory while move keeps original Chat, Thread, pin and draft', async () => {
    const f = await fixture(), before = useAppStore.getState(), current = (await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!
    await moveKnowledgeTopic(current, CATEGORY)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.category.spaceId, zoneId: f.first.zoneId, tabId: f.tabs[0]!.id, regionId: f.tabs[0]!.layout.activeRegionId })
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().pinnedItems).toBe(before.pinnedItems); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect((await f.state.read())!.graph.regions).toHaveLength(2); expect(api.sessions.stop).not.toHaveBeenCalled()
    await mount(createElement(SpaceTopicsTree, { workspace: f.workspace, icons: {}, onChangeIcon: () => {} }))
    expect(document.querySelector(`[data-space-nav="topic:${f.first.topicId}"]`)).toBeNull()
    const row = document.querySelector(`[data-space-nav="topic-category:${CATEGORY}"]`)!
    expect(row.getAttribute('data-space-parent')).toBe('space:topics')
    expect(row.closest('.space-category-heading')!.querySelector('[data-space-disclosure]')).toBeNull()
    await click(document.querySelector(`[data-space-nav="topic-category:${CATEGORY}"]`)!)
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.category.spaceId, zoneId: null, topicId: null })
    await act(async () => root!.render(createElement(WorkspaceTopicsPanel, { workspace: f.workspace, categorySpaceId: f.category.spaceId, onRevealDirectory: () => {} })))
    await settle(() => !!host.querySelector('[data-topic-id]'))
    expect([...host.querySelectorAll('[data-topic-id]')].map(row => row.getAttribute('data-topic-id'))).toEqual([f.first.topicId])
    expect(host.querySelector('.workspace-topic-index-header')!.textContent).toBe('Topics1')
    expect(host.querySelector('[aria-label="Actions for 工作方法"]')).not.toBeNull()
  })
  it('creates a durable Category from the only Topics creation icon without creating a Topic', async () => {
    const f = await fixture(), original = (await f.owner.call('topic.ls', {})).topics.map(topic => topic.topicId)
    await mount(createElement(SpaceTopicsTree, { workspace: f.workspace, icons: {}, onChangeIcon: () => {} }))
    expect(host.querySelector('.space-category-create')).toBeNull()
    await click(button('Create Category'))
    await settle(() => !!document.querySelector('[role="dialog"] input'))
    await input(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'Ideas from discussions')
    await click(button('Save category')); await settle(() => !document.querySelector('[role="dialog"]'))
    const category = (await f.owner.call('topic.category.ls', {})).categories.find(category => category.title === 'Ideas from discussions')!
    expect(category).toBeDefined()
    expect(await readFile(join(category.directoryPath, 'category.md'), 'utf8')).toBe('# Ideas from discussions\n')
    expect((await f.owner.call('topic.ls', {})).topics.map(topic => topic.topicId)).toEqual(original)
    expect(host.querySelector(`[data-space-nav="topic-category:${category.categoryId}"]`)).not.toBeNull()
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })
  it('retains the requested Category through a missing description without leaking the library or creating in a default Category', async () => {
    const f = await fixture(), fact = (await f.owner.call('topic.inspect', { topicId: f.first.topicId })).topic!
    await moveKnowledgeTopic(fact, CATEGORY)
    useAppStore.setState({ topicCategories: [], workbenchSpaceSelection: { workspaceId: f.workspace.id, spaceId: f.category.spaceId, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } })
    const create = vi.spyOn(useAppStore.getState(), 'createScratchTopic')
    useAppStore.setState({ explorerCollapsed: { [f.workspace.id]: true } })
    await mount(createElement(WorkspaceFilesTool, { workspace: f.workspace, isScratch: true, visible: true }))
    await settle(() => !!host.querySelector('[data-topic-id]'))
    expect([...host.querySelectorAll('[data-topic-id]')].map(row => row.getAttribute('data-topic-id'))).toEqual([f.first.topicId])
    expect(host.textContent).toContain('Category description is still restoring')
    await click(button('Create new Topic'))
    expect(create).not.toHaveBeenCalled()
    expect(host.textContent).toContain('selected Category description is not confirmed')
    expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.category.spaceId)
    expect(api.sessions.stop).not.toHaveBeenCalled()
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
    await click(button('Search')); await settle(() => host.textContent!.includes('No saved knowledge or text documents match this search.'))
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
    const notebookId = 'source:' + crypto.randomUUID(), library = await api.notebooks.read()
    const registered = await api.notebooks.apply({ expectedRevision: library.revision, operationId: crypto.randomUUID(), change: { kind: 'create', notebookId, name: 'Original notebook' } })
    const notebook: TopicKnowledgeSource = { kind: 'notebook', notebookId }
    await mount(createElement(TopicKnowledgeEditor, { target: { topicId: f.first.topicId, title: 'Selected source', sources: [source, notebook] }, onClose: () => {}, onSaved: saved }))
    await settle(() => !!document.querySelector('textarea'))
    await input(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Bounded derived conclusion')
    useAppStore.setState(state => ({ workbenchSpaceSelection: { ...state.workbenchSpaceSelection!, topicId: f.second.topicId, zoneId: f.second.zoneId } }))
    await click(button('Save knowledge')); await settle(() => saved.mock.calls.length > 0)
    expect(saved.mock.calls[0]![0]).toMatchObject({ topicId: f.first.topicId, sources: [source, notebook], content: 'Bounded derived conclusion' })
    expect((await f.owner.call('topic.knowledge.ls', { topicId: f.second.topicId })).entries).toEqual([])
    await expect(openKnowledgeSource({ kind: 'notebook', notebookId: 'missing-original' })).rejects.toThrow('not confirmed')
    const before = useAppStore.getState(), read = vi.spyOn(api.notebooks, 'read')
    let release!: (value: typeof registered) => void
    read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const opening = openKnowledgeSource(notebook)
    useAppStore.setState({ mainSurface: 'agents' }); release(registered); await opening
    expect(useAppStore.getState().mainSurface).toBe('agents')
    await openKnowledgeSource(notebook)
    expect(useAppStore.getState()).toMatchObject({ mainSurface: 'survey', surveyNotebookId: notebookId })
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
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
  it('a Category Topic click selects its original Chat once while delayed metadata only refreshes content', async () => {
    const f = await fixture(), originalSpatial = await f.state.read()
    useAppStore.setState({ workbenchSpaceSelection: { workspaceId: f.workspace.id, spaceId: f.first.categorySpaceIds[0]!, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } })
    const read = vi.mocked(api.scratch.readTopic).getMockImplementation()!
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(api.scratch.readTopic).mockImplementation(async (workspace, id) => { await gate; return read(workspace, id) })
    await mount(createElement(WorkspaceTopicsPanel, { workspace: f.workspace, categorySpaceId: f.first.categorySpaceIds[0], onRevealDirectory: () => {} }))
    await settle(() => !!host.querySelector(`[data-topic-id="${f.second.topicId}"]`))
    const commits: unknown[] = []
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.workbenchSpaceSelection !== previous.workbenchSpaceSelection || next.layouts !== previous.layouts) commits.push(next.workbenchSpaceSelection)
    })
    try {
      await click(host.querySelector(`[data-topic-id="${f.second.topicId}"]`)!)
      const chosen = useAppStore.getState()
      expect(chosen.workbenchSpaceSelection).toMatchObject({ topicId: f.second.topicId, tabId: f.tabs[1]!.id, regionId: f.tabs[1]!.layout.activeRegionId })
      await act(async () => { finish(); await gate })
      await settle(() => host.querySelector(`[data-topic-id="${f.second.topicId}"]`)?.getAttribute('aria-disabled') === 'false')
      expect(commits).toHaveLength(1)
      expect(useAppStore.getState().workbenchSpaceSelection).toBe(chosen.workbenchSpaceSelection)
      expect(useAppStore.getState().layouts).toBe(chosen.layouts)
      expect(useAppStore.getState().tabs).toBe(chosen.tabs)
      expect(useAppStore.getState().agentComposerDrafts).toEqual(chosen.agentComposerDrafts)
      expect(api.sessions.stop).not.toHaveBeenCalled()
      expect((await f.state.read())!.graph).toEqual(originalSpatial!.graph)
    } finally { unsubscribe() }
  })

  it.each(['category', 'other-topic'] as const)('a late Topic read preserves a newer %s choice', async destination => {
    const f = await fixture(), read = vi.mocked(api.scratch.readTopic).getMockImplementation()!
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(api.scratch.readTopic).mockImplementation(async (workspace, id) => { await gate; return read(workspace, id) })
    let opening!: Promise<boolean>
    await act(async () => { opening = useAppStore.getState().openScratchTopic(f.second.topicId, f.workspace.id) })
    const later = destination === 'category'
      ? { workspaceId: f.workspace.id, spaceId: f.category.spaceId, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null }
      : { workspaceId: f.workspace.id, spaceId: f.first.categorySpaceIds[0]!, zoneId: f.first.zoneId, topicId: f.first.topicId, tabId: f.tabs[0]!.id, groupId: f.layout.activeGroupId, regionId: f.tabs[0]!.layout.activeRegionId }
    await act(async () => { useAppStore.setState({ workbenchSpaceSelection: later }); finish(); expect(await opening).toBe(false) })
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
    expect(useAppStore.getState().tabs).toEqual(Object.fromEntries(f.tabs.map(tab => [tab.id, tab])))
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('a failed Topic metadata read retains the chosen original Chat and reports recovery', async () => {
    const f = await fixture()
    vi.mocked(api.scratch.readTopic).mockRejectedValue(new Error('Private Topic metadata unavailable'))
    await expect(useAppStore.getState().openScratchTopic(f.second.topicId, f.workspace.id)).rejects.toThrow('Private Topic metadata unavailable')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ topicId: f.second.topicId, tabId: f.tabs[1]!.id, regionId: f.tabs[1]!.layout.activeRegionId })
    expect(useAppStore.getState().error).toMatch(/Private Topic metadata unavailable/); expect(useAppStore.getState().errorNoticeContext?.summary).toMatch(/Topic metadata.*retry this Topic/i)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('a Topic Zone opens all its Tabs across Groups from another active Topic without inventing a Chat', async () => {
    const f = await fixture()
    const extra = { ...createWorkbenchTab('chat:second-first-topic', { kind: 'launcher', regionId: 'thread:second-first-topic', workspaceId: f.workspace.id }), topicId: f.first.topicId, space: f.tabs[0]!.space }
    const groups = [createWorkspaceLayout('a-left', [f.tabs[0]!.id]), createWorkspaceLayout('a-right', [extra.id]), createWorkspaceLayout('b-current', [f.tabs[1]!.id])]
    const layout = { activeGroupId: 'b-current', groups: groups.flatMap(item => item.groups), root: { type: 'split' as const, direction: 'horizontal' as const, ratio: 0.5, first: groups[0]!.root, second: { type: 'split' as const, direction: 'vertical' as const, ratio: 0.5, first: groups[1]!.root, second: groups[2]!.root } } }
    const original = await f.state.read(), graph = original!.graph
    graph.tabs.push({ tabId: extra.id, zoneId: f.first.zoneId, workspaceId: f.workspace.id, name: null, regionIds: [extra.layout.activeRegionId] })
    graph.regions.push({ tabId: extra.id, regionId: extra.layout.activeRegionId, kind: 'launcher', agentSessionId: null, runId: null, execution: null })
    graph.layouts[f.workspace.id] = layout
    await f.state.commit({ expectedRevision: original!.revision, graph })
    const tabs = { ...useAppStore.getState().tabs, [extra.id]: extra }
    useAppStore.setState({ tabs, layouts: { [f.workspace.id]: layout }, workbenchSpaceSelection: { workspaceId: f.workspace.id, spaceId: f.first.categorySpaceIds[0]!, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } })
    await mount(createElement(WorkspaceTopicsPanel, { workspace: f.workspace, categorySpaceId: f.first.categorySpaceIds[0], onRevealDirectory: () => {} }))
    await settle(() => !!host.querySelector(`[data-topic-id="${f.first.topicId}"]`))
    const current = useAppStore.getState()
    expect(resolveDesktopSpaceSelection(current, workbenchSelectionCatalog(current), { spaceId: f.first.categorySpaceIds[0]!, zoneId: f.first.zoneId })).toMatchObject({ zoneId: f.first.zoneId, topicId: f.first.topicId, tabId: null, groupId: null })
    expect(() => resolveDesktopSpaceSelection(current, workbenchSelectionCatalog(current), { spaceId: f.first.categorySpaceIds[0]!, zoneId: f.first.zoneId, groupId: 'b-current' })).toThrow()
    await click(host.querySelector(`[data-topic-id="${f.first.topicId}"]`)!)
    await settle(() => host.querySelector(`[data-topic-id="${f.first.topicId}"]`)?.getAttribute('aria-disabled') === 'false')
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ topicId: f.first.topicId, zoneId: f.first.zoneId, tabId: null, groupId: null })
    expect(useAppStore.getState().tabs).toBe(tabs)
    expect(useAppStore.getState().layouts[f.workspace.id]).toBe(layout)
    await act(async () => root!.render(createElement(WorkspaceWorkbench, { workspaceId: f.workspace.id })))
    await settle(() => host.querySelectorAll('button.workbench-tab').length === 2)
    expect([...host.querySelectorAll('button.workbench-tab')].map(tab => tab.getAttribute('data-workbench-tab-id')).sort()).toEqual([f.tabs[0]!.id, extra.id].sort())
    await act(async () => useAppStore.getState().focusTabGroup(f.workspace.id, 'a-right'))
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ topicId: f.first.topicId, zoneId: f.first.zoneId, tabId: extra.id, groupId: 'a-right' })
    expect(api.sessions.stop).not.toHaveBeenCalled()
    expect((await f.state.read())!.graph.tabs.map(tab => tab.tabId).sort()).toEqual([...f.tabs.map(tab => tab.id), extra.id].sort())
  })

  it('Category selection clears Topic current marking and a Chat chip opens its exact Topic once', async () => {
    const f = await fixture()
    useAppStore.setState({ workbenchSpaceSelection: { workspaceId: f.workspace.id, spaceId: f.first.categorySpaceIds[0]!, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } })
    await mount(createElement(WorkspaceTopicsPanel, { workspace: f.workspace, categorySpaceId: f.first.categorySpaceIds[0], onRevealDirectory: () => {} }))
    await settle(() => !!host.querySelector(`[data-topic-tab-id="${f.tabs[1]!.id}"]`))
    expect(host.querySelector('[aria-current="page"]')).toBeNull()
    const choices: unknown[] = []
    const unsubscribe = useAppStore.subscribe((next, previous) => { if (next.workbenchSpaceSelection !== previous.workbenchSpaceSelection) choices.push(next.workbenchSpaceSelection) })
    try {
      await click(host.querySelector(`[data-topic-tab-id="${f.tabs[1]!.id}"]`)!)
      await settle(() => useAppStore.getState().workbenchSpaceSelection?.tabId === f.tabs[1]!.id)
      expect(choices).toHaveLength(1)
      expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.first.categorySpaceIds[0]!, zoneId: f.second.zoneId, topicId: f.second.topicId, tabId: f.tabs[1]!.id })
      expect(api.sessions.stop).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })

  it('the secondary Category directory persists through Topic clicks and knowledge toggles without duplicate Chats', async () => {
    const f = await fixture(), foreign = (await f.owner.call('topic.inspect', { topicId: f.second.topicId })).topic!
    await moveKnowledgeTopic(foreign, CATEGORY)
    useAppStore.setState({ explorerCollapsed: { [f.workspace.id]: true } })
    const original = await entry(f.owner, f.first.topicId, 'Original Topic conclusion')
    await entry(f.owner, f.second.topicId, 'Original other Topic conclusion')
    await mount(createElement(WorkspaceFilesTool, { workspace: f.workspace, isScratch: true, visible: true }))
    const ids = () => [...host.querySelectorAll('[data-topic-id]')].map(node => node.getAttribute('data-topic-id'))
    await settle(() => ids().length === 1)
    expect(ids()).toEqual([f.first.topicId])
    expect(host.querySelector('[data-topic-chat-id]')).toBeNull()
    await click(host.querySelector(`[data-topic-id="${f.first.topicId}"]`)!)
    await settle(() => useAppStore.getState().workbenchSpaceSelection?.topicId === f.first.topicId)
    expect(ids()).toEqual([f.first.topicId])
    const before = useAppStore.getState()
    await click(button('Show Knowledge'))
    await settle(() => host.querySelector('.topic-knowledge-row')?.textContent?.includes(original.title) === true)
    expect(host.querySelectorAll('[data-knowledge-topic-id]')).toHaveLength(1)
    await input(host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!, 'Original')
    await click(button('Search'))
    await settle(() => vi.mocked(api.topics.call).mock.calls.some(call => call[0] === 'topic.knowledge.search') && !host.textContent!.includes('Reading knowledge…'))
    expect(api.topics.call).toHaveBeenCalledWith('topic.knowledge.search', { topicId: f.first.topicId, query: 'Original', limit: 100 })
    expect(host.querySelectorAll('.topic-knowledge-row')).toHaveLength(1)
    const results = host.querySelector('.topic-knowledge-list')!.textContent
    await click(button('Show Topics'))
    expect(ids()).toEqual([f.first.topicId])
    expect(host.querySelector('.topic-navigation-panel__knowledge')!.hasAttribute('hidden')).toBe(true)
    await click(button('Show Knowledge'))
    expect(host.querySelector<HTMLInputElement>('[aria-label="Search this Topic"]')!.value).toBe('Original')
    expect(host.querySelector('.topic-knowledge-list')!.textContent).toBe(results)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(api.sessions.stop).not.toHaveBeenCalled()
    await click(button('Show Topics'))
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: { ...useAppStore.getState().workbenchSpaceSelection!, spaceId: f.category.spaceId, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } }))
    await settle(() => ids()[0] === f.second.topicId)
    await click(host.querySelector(`[data-topic-id="${f.second.topicId}"]`)!)
    await settle(() => useAppStore.getState().workbenchSpaceSelection?.topicId === f.second.topicId)
    expect(ids()).toEqual([f.second.topicId])
    expect(host.querySelector('[data-topic-chat-id]')).toBeNull()
    expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.category.spaceId, zoneId: f.second.zoneId, tabId: f.tabs[1]!.id })
  })

  it('Category-only knowledge searches All Topics with accurate source identities and keeps the original workface', async () => {
    const f = await fixture()
    await entry(f.owner, f.first.topicId, 'Shared conclusion one')
    await entry(f.owner, f.second.topicId, 'Shared conclusion two')
    useAppStore.setState({ explorerCollapsed: { [f.workspace.id]: true }, workbenchSpaceSelection: { ...useAppStore.getState().workbenchSpaceSelection!, zoneId: null, topicId: null, tabId: null, groupId: null, regionId: null } })
    await mount(createElement(WorkspaceFilesTool, { workspace: f.workspace, isScratch: true, visible: true }))
    const before = useAppStore.getState()
    await click(button('Show Knowledge'))
    expect(host.textContent).toContain('All Topics')
    expect(api.topics.call).not.toHaveBeenCalledWith('topic.knowledge.ls', expect.anything())
    await input(host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!, 'Shared conclusion')
    await click(button('Search'))
    await settle(() => host.querySelectorAll('.topic-knowledge-row').length === 2)
    expect(api.topics.call).toHaveBeenCalledWith('topic.knowledge.search', { query: 'Shared conclusion', limit: 100 })
    expect([...host.querySelectorAll('[data-knowledge-topic-id]')].map(row => row.getAttribute('data-knowledge-topic-id')).sort()).toEqual([f.first.topicId, f.second.topicId].sort())
    await click(host.querySelector(`[data-knowledge-topic-id="${f.second.topicId}"]`)!)
    await click(button('Edit knowledge'))
    await settle(() => !!document.querySelector('[role="dialog"]'))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('Shared conclusion two')
    await click(button('Cancel'))
    await click(button('Show Topics')); await click(button('Show Knowledge'))
    expect(host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!.value).toBe('Shared conclusion')
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('unconfirmed selected Topic keeps Category navigation and refuses to broaden knowledge to All Topics', async () => {
    const f = await fixture()
    useAppStore.setState({ explorerCollapsed: { [f.workspace.id]: true }, workbenchSpaceSelection: { ...useAppStore.getState().workbenchSpaceSelection!, topicId: 'unconfirmed-topic' } })
    await mount(createElement(WorkspaceFilesTool, { workspace: f.workspace, isScratch: true, visible: true }))
    await settle(() => host.querySelectorAll('[data-topic-id]').length === 2)
    await click(button('Show Knowledge'))
    expect(host.textContent).toContain('selected Topic is still restoring')
    expect(host.querySelector('[aria-label="Search all Topics"]')).toBeNull()
    await click(button('Show Topics'))
    expect(host.querySelectorAll('[data-topic-id]')).toHaveLength(2)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('Topic metadata reads retain the secondary directory order and later selection', async () => {
    const f = await fixture()
    useAppStore.setState({ explorerCollapsed: { [f.workspace.id]: true }, pinnedItems: {} })
    await mount(createElement(WorkspaceFilesTool, { workspace: f.workspace, isScratch: true, visible: true }))
    const ids = () => [...host.querySelectorAll('[data-topic-id]')].map(node => node.getAttribute('data-topic-id'))
    await settle(() => ids().length === 2)
    const order = ids(), before = useAppStore.getState().scratchTopicSnapshots[f.workspace.id]!.topics!.find(topic => topic.id === f.first.topicId)
    await click(host.querySelector(`[data-topic-id="${f.first.topicId}"]`)!)
    await settle(() => useAppStore.getState().scratchTopicSnapshots[f.workspace.id]!.topics!.find(topic => topic.id === f.first.topicId) !== before)
    expect(ids()).toEqual(order)
    expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe(f.first.topicId)
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

  it('global knowledge keeps prose, sources and editing when its source directory is unconfirmed and never guesses a file', async () => {
    const f = await fixture(), saved = await entry(f.owner, f.second.topicId, 'Source directory unavailable')
    await f.owner.call('topic.knowledge.write', { topicId: saved.topicId, entryId: saved.entryId, title: saved.title, content: '[Original note](notes/original.md)', form: saved.form, certainty: saved.certainty, sources: [{ kind: 'url', url: 'https://example.com/original-source' }], expectedRevision: saved.revision })
    const open = vi.spyOn(useAppStore.getState(), 'openFile')
    await mount(createElement(TopicKnowledgePanel, { workspace: f.workspace, topics: [] }))
    await input(host.querySelector<HTMLInputElement>('[aria-label="Search all Topics"]')!, saved.title)
    await click(button('Search')); await settle(() => host.querySelectorAll('.topic-knowledge-row').length === 1)
    await click(host.querySelector('.topic-knowledge-row')!)
    expect(host.textContent).toContain('source Topic directory is not confirmed')
    expect(host.querySelector('.topic-knowledge-entry .md-link--file')).toBeNull()
    expect(host.querySelector('.topic-knowledge-source')!.textContent).toContain('example.com/original-source')
    expect(open).not.toHaveBeenCalled()
    await click(button('Edit knowledge')); await settle(() => !!document.querySelector('[role="dialog"]'))
    expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('[Original note](notes/original.md)')
    expect(api.sessions.stop).not.toHaveBeenCalled()
  })

})
