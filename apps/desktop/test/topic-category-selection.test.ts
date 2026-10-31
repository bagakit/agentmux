// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { AgentMuxControlServer, connectAgentMuxRpc, type ExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { categoriesFromSpatial } from '@agentmux/host/topic-categories'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, rereadAgentRegionExecution } from '../src/renderer/src/store'
import { desktopSpatialGraph, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { workbenchObjectLayout } from '../src/renderer/src/lib/desktop-focus-navigation'
import { moveKnowledgeTopic } from '../src/renderer/src/lib/topic-knowledge-actions'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { directoryIdentity } from '../src/shared/space-addresses'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { initializeTopicSpatialClient } from './helpers/topic-spatial-client-fixture'
import { moteAgent } from './fixtures/mote-workface'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('No image decoder belongs to this selection test.') } } }))
const original = useAppStore.getState(), roots: string[] = [], disposers: (() => void | Promise<void>)[] = []
const sourceId = '11111111-1111-4111-8111-111111111111', targetId = '22222222-2222-4222-8222-222222222222', thirdId = '33333333-3333-4333-8333-333333333333'
afterEach(async () => {
  await useAppStore.getState().refreshSpatialState()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); useAppStore.setState(original, true)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
})
async function fixture(delivery: 'live' | 'queued' | 'refresh' = 'live') {
  vi.stubGlobal('crypto', webcrypto)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'topic-selection-'))); roots.push(root)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: join(root, 'scratch'), kind: 'folder' }
  await mkdir(workspace.path)
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state: spatial, workspace: () => workspace,
    topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const source = (await owner.call('topic.category.create', { categoryId: sourceId, title: 'Learning' })).category
  const target = (await owner.call('topic.category.create', { categoryId: targetId, title: 'Work' })).category
  const third = (await owner.call('topic.category.create', { categoryId: thirdId, title: 'Ideas' })).category
  const created = (await owner.call('topic.create', { topicId: 'AbCdEfGh1234', title: 'Original Topic', categoryId: sourceId })).topic
  const sibling = (await owner.call('topic.create', { topicId: 'BcDeFgHi2345', title: 'Sibling Topic', categoryId: targetId })).topic
  const topics = await owner.listTopicSnapshots()
  const session = { ...moteAgent('original-session', created.topicId), workspacePath: created.directoryPath }
  const space = { spaceId: directoryIdentity('local', created.directoryPath), zoneId: created.zoneId }
  const tab = { ...addWorkbenchRegion(createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id,
    sessionId: session.id, regionId: 'original-agent' }), 'original-agent', 'right', { kind: 'file', workspaceId: workspace.id, path: 'topic--' + created.topicId + '/topic.md', regionId: 'original-file' }),
    topicId: created.topicId, space }
  const other = { ...createWorkbenchTab('sibling-tab', { kind: 'launcher', workspaceId: workspace.id, regionId: 'sibling-region' }),
    topicId: sibling.topicId, space: { spaceId: directoryIdentity('local', sibling.directoryPath), zoneId: sibling.zoneId } }
  const related = { ...createWorkbenchTab('same-topic-tab', { kind: 'launcher', workspaceId: workspace.id, regionId: 'same-topic-region' }),
    topicId: created.topicId, space }
  const first = createWorkspaceLayout('first-group', [tab.id, related.id, other.id])
  const layout = { ...first, activeGroupId: 'second-group', root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .37,
    first: first.root, second: { type: 'leaf' as const, groupId: 'second-group' } },
    groups: [...first.groups, { ...first.groups[0]!, id: 'second-group', tabOrder: [tab.id], activeTabId: tab.id }] }
  const current = (await spatial.read())!, work = { config, sessions: [session], tabs: { [tab.id]: tab, [other.id]: other, [related.id]: related },
    layouts: { [workspace.id]: layout }, spaceZoneBindings: desktopBindingsFromSpatial(current.graph), topicCategories: categoriesFromSpatial(current.graph), spatialRequests: {} }
  await spatial.commit({ expectedRevision: current.revision, graph: desktopSpatialGraph(work, topics, current.graph) })
  const choice = { spaceId: source.spaceId, zoneId: created.zoneId, workspaceId: workspace.id, topicId: created.topicId,
    tabId: tab.id, groupId: 'second-group', regionId: 'original-file' }
  useAppStore.setState({ ...work, loading: false, activeWorkspaceId: workspace.id, mainSurface: 'workbench', workbenchSpaceSelection: choice,
    restoredWorkbench: { tabs: work.tabs, layouts: work.layouts }, timelines: {}, demands: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'Original unsent input' },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics, reading: false, error: null } } })
  const pending: (() => void)[] = []
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  const subscription = vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(state => {
    if (delivery === 'queued') pending.push(() => listener(state))
    else if (delivery === 'live') listener(state)
  }))
  disposers.push(await initializeTopicSpatialClient(() => owner.listTopicSnapshots()))
  useAppStore.setState({ workbenchSpaceSelection: choice, mainSurface: 'workbench', activeWorkspaceId: workspace.id })
  const before = useAppStore.getState()
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, coreClients: () => [], topics: owner })
  await server.start(); disposers.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'rpc.sock') } }); disposers.push(() => client.dispose())
  const move = async () => {
    const inspection = await client.call('topic.inspect', { topicId: created.topicId })
    return client.call('topic.move', { topicId: created.topicId, categoryId: targetId, expectedRevision: inspection.topic!.spatialRevision })
  }
  return { root, spatial, owner, client, source, target, third, created, sibling, before, choice, tab, other, related, subscription, move,
    deliver() { for (const notify of pending.splice(0)) notify() } }
}
function assertRetained(f: Awaited<ReturnType<typeof fixture>>) {
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toMatchObject({ zoneId: f.choice.zoneId, topicId: f.choice.topicId, tabId: f.choice.tabId,
    groupId: f.choice.groupId, regionId: f.choice.regionId, workspaceId: f.choice.workspaceId })
  expect(after.tabs[f.tab.id]!.space).toEqual(f.tab.space)
  expect(after.tabs[f.tab.id]!.regions['original-agent']).toBe(f.before.tabs[f.tab.id]!.regions['original-agent'])
  expect(after.tabs[f.tab.id]!.regions['original-file']).toBe(f.before.tabs[f.tab.id]!.regions['original-file'])
  expect(after.agentComposerDrafts).toBe(f.before.agentComposerDrafts)
  expect(after.agentComposerDrafts['original-session']).toBe('Original unsent input')
  expect(after.layouts).toEqual(f.before.layouts)
  const shown = workbenchObjectLayout(after, f.choice.workspaceId)
  expect(shown.layout?.groups.some(group => group.id === f.choice.groupId && group.tabOrder.includes(f.tab.id))).toBe(true)
  expect(shown.layout?.groups.some(group => group.tabOrder.includes(f.related.id))).toBe(true)
  return shown
}

it('coordinates a real public Topic transfer through the Desktop subscription and retains the exact second occurrence', async () => {
  const f = await fixture()
  const moved = await f.move()
  await vi.waitFor(() => expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.target.spaceId))
  expect(moved.topic.zoneId).toBe(f.created.zoneId)
  expect(f.subscription).toHaveBeenCalledOnce()
  expect(assertRetained(f).confirmed).toBe(true)
})

it('uses the same spatial observation path for the GUI helper when its push observation has not arrived', async () => {
  const f = await fixture('refresh')
  vi.spyOn(api.topics, 'call').mockImplementation((method, params) => f.client.call(method, params) as any)
  const topic = (await f.client.call('topic.inspect', { topicId: f.created.topicId })).topic!
  await moveKnowledgeTopic(topic, targetId)
  expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.target.spaceId)
  expect(assertRetained(f).confirmed).toBe(true)
})

it.each(['queued', 'refresh'] as const)('does not let an exact execution read consume a pending %s classification observation', async delivery => {
  const f = await fixture(delivery)
  await f.move()
  await rereadAgentRegionExecution({ tabId: f.tab.id, regionId: 'original-agent', agentSessionId: 'original-session' })
  if (delivery === 'queued') f.deliver()
  else await useAppStore.getState().refreshSpatialState()
  expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.target.spaceId)
  expect(assertRetained(f).confirmed).toBe(true)
})

it('rebases a local split edit from the applied workface after an execution read observes a transfer ahead', async () => {
  const f = await fixture('refresh')
  await f.move()
  await rereadAgentRegionExecution({ tabId: f.tab.id, regionId: 'original-agent', agentSessionId: 'original-session' })
  useAppStore.getState().updateRegionSplitRatio(f.choice.workspaceId, f.tab.id, '', .61)
  await useAppStore.getState().refreshSpatialState()
  const saved = (await f.spatial.read())!
  expect(saved.graph.bindings.filter(binding => binding.zoneId === f.created.zoneId &&
    [f.source.spaceId, f.target.spaceId].includes(binding.spaceId))).toEqual([{ zoneId: f.created.zoneId, spaceId: f.target.spaceId }])
  expect(saved.graph.tabLayouts[f.tab.id]!.root).toHaveProperty('ratio', .61)
  expect(useAppStore.getState().workbenchSpaceSelection?.spaceId).toBe(f.target.spaceId)
  expect(assertRetained(f).confirmed).toBe(true)
})

it('keeps later navigation when an older public transfer observation arrives', async () => {
  const f = await fixture('queued')
  await f.move()
  const later = { spaceId: f.target.spaceId, zoneId: f.sibling.zoneId, workspaceId: f.choice.workspaceId, topicId: f.sibling.topicId,
    groupId: 'first-group', tabId: f.other.id, regionId: 'sibling-region' }
  useAppStore.setState({ workbenchSpaceSelection: later, mainSurface: 'recall' })
  f.deliver()
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
  expect(useAppStore.getState().mainSurface).toBe('recall')
  expect(useAppStore.getState().agentComposerDrafts).toBe(f.before.agentComposerDrafts)
})

it.each(['ambiguous', 'unavailable', 'unidentified-container', 'space-issue', 'none', 'source-still-bound'] as const)('retains the original visible occurrence for %s Category relationships', async condition => {
  const f = await fixture(), current = (await f.spatial.read())!, graph = structuredClone(current.graph)
  if (condition !== 'source-still-bound') graph.bindings = graph.bindings.filter(binding => binding.zoneId !== f.created.zoneId || binding.spaceId !== f.source.spaceId)
  if (condition !== 'none') graph.bindings.push({ zoneId: f.created.zoneId, spaceId: f.target.spaceId })
  if (condition === 'ambiguous') graph.bindings.push({ zoneId: f.created.zoneId, spaceId: f.third.spaceId })
  if (condition === 'unidentified-container') {
    graph.bindings.push({ zoneId: f.created.zoneId, spaceId: f.third.spaceId })
    delete graph.resources['space:' + f.third.spaceId]
  }
  if (condition === 'space-issue') graph.spaces.find(space => space.spaceId === f.target.spaceId)!.issue = 'Original Category facts are unavailable'
  if (condition === 'unavailable') {
    const resource = graph.resources['space:' + f.target.spaceId] as Record<string, any>
    resource.readError = 'Original Category metadata is unavailable'
  }
  await f.spatial.commit({ expectedRevision: current.revision, graph })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(f.before.workbenchSpaceSelection)
  const shown = assertRetained(f)
  expect(shown.confirmed).toBe(condition === 'source-still-bound')
  if (condition !== 'source-still-bound') expect(shown.issues.join(' ')).toContain('Category')
  useAppStore.getState().focusRegion(f.choice.workspaceId, f.tab.id, 'original-agent', 'pointer', f.choice.groupId)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.source.spaceId, regionId: 'original-agent' })
  useAppStore.getState().activateTab(f.choice.workspaceId, 'first-group', f.related.id, 'local')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.source.spaceId, zoneId: f.created.zoneId, tabId: f.related.id })
  const held = useAppStore.getState().workbenchSpaceSelection
  useAppStore.getState().activateTab(f.choice.workspaceId, 'first-group', f.other.id, 'local')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(held)
})

it('does not infer a new selection when the original Region has actually left its occurrence', async () => {
  const f = await fixture(), current = (await f.spatial.read())!, graph = structuredClone(current.graph)
  graph.bindings = graph.bindings.filter(binding => binding.zoneId !== f.created.zoneId || binding.spaceId !== f.source.spaceId)
  graph.bindings.push({ zoneId: f.created.zoneId, spaceId: f.target.spaceId })
  graph.layouts[f.choice.workspaceId]!.groups.find(group => group.id === f.choice.groupId)!.tabOrder = []
  graph.layouts[f.choice.workspaceId]!.groups.find(group => group.id === f.choice.groupId)!.activeTabId = null
  graph.layouts[f.choice.workspaceId]!.groups.find(group => group.id === f.choice.groupId)!.recentTabIds = []
  await f.spatial.commit({ expectedRevision: current.revision, graph })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(f.before.workbenchSpaceSelection)
  expect(useAppStore.getState().tabs[f.tab.id]!.space).toEqual(f.tab.space)
})
