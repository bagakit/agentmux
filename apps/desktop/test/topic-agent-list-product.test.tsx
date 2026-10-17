// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { DndContext } from '@dnd-kit/core'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId, type SpaceZoneBindings } from '../src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workspaceAgentOrderKey } from '../src/renderer/src/lib/workspace-agent-order'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

vi.mock('../src/renderer/src/components/WorkspaceFilesTool', () => ({ WorkspaceFilesTool: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceGitTool', () => ({ WorkspaceGitTool: () => null }))
const drag = vi.hoisted(() => ({ end: undefined as ComponentProps<typeof DndContext>['onDragEnd'] }))
vi.mock('@dnd-kit/core', async original => {
  const actual = await original<typeof import('@dnd-kit/core')>()
  return { ...actual, DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
    drag.end = props.onDragEnd
    return <actual.DndContext {...props} />
  } }
})

const dom = composerDOM()
const scratch = { ...composerConfig.workspaces[0]!, id: '__scratch__', name: 'Topics', path: composerConfig.workspaces[0]!.path + '/scratch' }
const category = { categoryId: 'shared-category', hostId: 'local', title: 'Shared Category',
  directoryPath: scratch.path + '/category', spaceId: directoryIdentity('local', scratch.path + '/category'), revision: null }
const topics: ScratchTopicSnapshot[] = ['one', 'two', 'mote'].map(name => {
  const id = 'launcher:' + name, directoryPath = scratchTopicDirectoryName(id), path = scratch.path + '/' + directoryPath
  return { id, title: 'Object ' + name, summary: '', kind: name === 'mote' ? 'mote' : 'topic',
    directoryPath, physicalDirectoryPath: path, identityDirectoryPath: path, confirmedDirectoryPaths: [path],
    topicPath: directoryPath + '/topic.md', collaborators: [],
    ...(name === 'mote' ? { soul: { path: 'SOUL.md', content: 'Original persona', version: 'original' } } : {}) }
})
const address = (topic: ScratchTopicSnapshot) => {
  const source = directoryIdentity(scratch.hostId, topic.identityDirectoryPath!)
  return { spaceId: topic.kind === 'mote' ? source : category.spaceId, zoneId: homeZoneId(source) }
}
const bindings: SpaceZoneBindings = Object.fromEntries(topics.map(topic => [address(topic).zoneId, {
  spaceId: directoryIdentity(scratch.hostId, topic.identityDirectoryPath!), workspaceId: scratch.id,
  directoryPath: topic.physicalDirectoryPath, topicId: topic.id, contentKind: topic.kind,
  ...(topic.kind !== 'mote' ? { relations: { [category.spaceId]: true } } : {})
}]))
const source = [
  { ...composerSession('one-open'), workspacePath: topics[0]!.physicalDirectoryPath!, createdAt: 1 },
  { ...composerSession('one-closed'), workspacePath: topics[0]!.physicalDirectoryPath!, createdAt: 2 },
  { ...composerSession('two-agent'), workspacePath: topics[1]!.physicalDirectoryPath!, createdAt: 3 },
  { ...composerSession('mote-agent'), workspacePath: topics[2]!.physicalDirectoryPath!, createdAt: 4 },
  { ...composerSession('unbound'), workspacePath: scratch.path, createdAt: 5 }
]
const tabs = Object.fromEntries([0, 2, 3].map((index, at) => {
  const topic = topics[at]!, name = topic.id.slice('launcher:'.length), tab = createWorkbenchTab('tab-' + name, { kind: 'agent', phase: 'attached',
    regionId: 'region-' + name, workspaceId: scratch.id, sessionId: source[index]!.id })
  return [tab.id, { ...tab, topicId: topic.id, space: address(topic) }]
}))
const choice = (topic: ScratchTopicSnapshot) => ({ ...address(topic), workspaceId: scratch.id, topicId: topic.id,
  tabId: 'tab-' + topic.id.slice('launcher:'.length), regionId: 'region-' + topic.id.slice('launcher:'.length), groupId: 'original-group' })
const ids = () => [...dom.container.querySelectorAll<HTMLElement>('.workspace-agent-list-item button.focus-context[data-session-id]')].map(node => node.dataset.sessionId)
const button = (name: string) => {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name)
  expect(found, name).toBeDefined()
  return found!
}
beforeEach(async () => {
  drag.end = undefined
  const layout = createWorkspaceLayout('original-group', ['tab-two', 'tab-one', 'tab-mote'])
  useAppStore.setState({ config: { ...composerConfig, workspaces: [scratch] }, sessions: source,
    tabs, layouts: { [scratch.id]: layout }, topicCategories: [category], spaceZoneBindings: bindings, spatialRequests: {},
    mainSurface: 'workbench', activeWorkspaceId: scratch.id, workbenchSpaceSelection: choice(topics[0]!),
    loading: false, workspaceTool: 'agents', projectRailOpen: true, timelines: {}, agentNames: {}, demands: {},
    workspaceAgentOrder: {}, scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1,
      topics, error: null, reading: false } }, agentComposerDrafts: { 'one-open': 'Original unsent input' } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), topics) })
  await initializeSpatialControlFixture(topics)
})

it('the production Dock follows the explicit Topic and Mote while keeping off-Tab originals and clearing management selection', async () => {
  const initial = useAppStore.getState(), stop = vi.spyOn(api.sessions, 'stop')
  await dom.render(<SurfaceToolDock workspace={scratch} />)
  expect(ids()).toEqual(['one-open', 'one-closed'])
  expect(dom.container.querySelector('.workspace-agents-tool__identity strong')?.textContent).toBe('Object one')
  expect(dom.container.querySelector('[aria-label="2 Agents · Startup order"]')).not.toBeNull()
  await act(async () => button('Select Agents').click())
  const checkbox = dom.container.querySelector<HTMLInputElement>('input[aria-label="Select Agent codex"]')
    ?? dom.container.querySelector<HTMLInputElement>('.workspace-agent-list-item input')
  expect(checkbox).not.toBeNull()
  await act(async () => checkbox!.click())
  expect(dom.container.querySelectorAll('input:checked')).toHaveLength(1)
  for (const topic of topics.slice(1)) {
    await act(async () => useAppStore.setState({ workbenchSpaceSelection: choice(topic) }))
    expect(ids()).toEqual([topic.kind === 'mote' ? 'mote-agent' : 'two-agent'])
    expect(dom.container.querySelector('.workspace-agents-tool__identity strong')?.textContent).toBe(topic.title)
    expect(dom.container.querySelectorAll('input:checked')).toHaveLength(0)
    expect(button('Select Agents')).toBeDefined()
    expect(dom.container.querySelector('[aria-label="1 Agents · Startup order"]')).not.toBeNull()
  }
  expect(useAppStore.getState().sessions).toBe(initial.sessions)
  expect(useAppStore.getState().tabs).toBe(initial.tabs)
  expect(useAppStore.getState().layouts).toBe(initial.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(initial.agentComposerDrafts)
  expect(stop).not.toHaveBeenCalled()
})

it('a temporary metadata gap keeps the selected object and never exposes the full Scratch roster', async () => {
  await dom.render(<SurfaceToolDock workspace={scratch} />)
  expect(ids()).toEqual(['one-open', 'one-closed'])
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratch.id]: {
    scope: scratchTopicsScope(scratch), revision: 2, topics: null, error: 'Original directory observation unavailable', reading: false
  } } }))
  expect(ids()).toEqual(['one-open', 'one-closed'])
  expect(useAppStore.getState().workbenchSpaceSelection?.topicId).toBe('launcher:one')
})

it('filters and bulk copies only members of the selected Topic through the production controls', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  useAppStore.setState({ sessions: source.map(session => session.id === 'two-agent' ? { ...session,
    status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() }
  } : session) })
  await dom.render(<SurfaceToolDock workspace={scratch} />)
  const filter = (value: string) => dom.container.querySelector<HTMLButtonElement>(`[data-agent-filter="${value}"]`)!
  expect(filter('working').querySelector('b')?.textContent).toBe('0')
  await act(async () => filter('working').click())
  expect(ids()).toEqual([])
  await act(async () => filter('all').click())
  await act(async () => button('Select Agents').click())
  await act(async () => button('Select visible Agents').click())
  await act(async () => button('Copy titles + Agent links').click())
  expect(copy).toHaveBeenCalledTimes(1)
  expect(copy.mock.calls[0]![0]).toContain('amux://agent/one-open')
  expect(copy.mock.calls[0]![0]).toContain('amux://agent/one-closed')
  expect(copy.mock.calls[0]![0]).not.toMatch(/two-agent|mote-agent|unbound/)
})

it('the real reorder callback saves only the current subset slots and preserves other objects and retained preferences', async () => {
  const key = (id: string) => workspaceAgentOrderKey(composerSession(id))
  const before = ['two-agent', 'one-open', 'temporarily-absent', 'mote-agent', 'one-closed'].map(key)
  useAppStore.setState({ workspaceAgentOrder: { [scratch.id]: before } })
  await dom.render(<SurfaceToolDock workspace={scratch} />)
  expect(ids()).toEqual(['one-open', 'one-closed'])
  expect(drag.end).toBeTypeOf('function')
  await act(async () => drag.end!({ active: { id: key('one-closed') }, over: { id: key('one-open') } } as never))
  expect(useAppStore.getState().workspaceAgentOrder[scratch.id]).toEqual([
    key('two-agent'), key('one-closed'), key('temporarily-absent'), key('mote-agent'), key('one-open'), key('unbound')
  ])
  expect(ids()).toEqual(['one-closed', 'one-open'])
  expect(useAppStore.getState().agentComposerDrafts['one-open']).toBe('Original unsent input')
})
