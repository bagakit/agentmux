// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { parseFocusResult } from '@agentmux/core/focus-control'
import { readFocusGroups } from '../src/renderer/src/lib/focus-read-projection'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, agentRegionExecution, agentRegionLocationsKnown, agentRegionLocationBindings } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

composerDOM()
const project = composerConfig.workspaces[0]!
const scope = { kind: 'project' as const, hostId: project.hostId, projectSpaceId: folderSpaceFacts(project).space.spaceId }
const source = { clientId: 'original-client', rendererId: 'original-renderer', documentGeneration: 1 }
const all = { scope, selection: { kind: 'all' as const } }
const locations = () => ({ known: agentRegionLocationsKnown(), executionFor: agentRegionExecution, bindings: agentRegionLocationBindings() })
const ref = (contextId: string, hostId = 'local') => ({ hostId, contextId })
const read = (params: typeof all | Parameters<typeof readFocusGroups<'focus.read'>>[1]['params']) => readFocusGroups(useAppStore.getState(), { method: 'focus.read', params }, source, locations())

beforeEach(async () => {
  const sessions = ['a', 'b', 'c'].map(id => composerSession(id))
  const tabs = Object.fromEntries(sessions.map(session => [session.id, createWorkbenchTab(session.id, {
    kind: 'agent', phase: 'attached', regionId: 'region-' + session.id, workspaceId: project.id, sessionId: session.id
  })]))
  useAppStore.setState({ loading: false, config: composerConfig, sessions, tabs,
    layouts: { [project.id]: createWorkspaceLayout('original-group', Object.keys(tabs)) }, agentNames: { a: 'Original A', b: 'Original B' }, timelines: {},
    mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {}, scratchTopicSnapshots: {}, spaceZoneBindings: {}, topicCategories: [] })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
})

it('the original loaded Focus derivation exposes one exact directory and bounded member page without effects', () => {
  const state = useAppStore.getState(), before = { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts }
  const directory = readFocusGroups(state, { method: 'focus.ls', params: {} }, source, locations())
  expect(directory.items).toEqual([{ scope, name: project.name, identityStatus: 'confirmed', memberCount: 3 }])
  const page = read({ ...all, limit: 2 })
  expect(page.items.map(item => item.reference)).toEqual([ref('a'), ref('b')])
  expect(page.items[0]).toMatchObject({ name: 'Original A', availability: 'observed', agent: { hostId: 'local', agentSessionId: 'a', run: { runId: 'run-a' } } })
  expect(page.items[0]!.locations.occurrences).toEqual([{ hostId: 'local', workspaceId: project.id, groupId: 'original-group', tabId: 'a', regionId: 'region-a' }])
  expect(page.nextCursor).toBeTruthy(); expect(page.coverage.complete).toBe(false)
  expect(parseFocusResult('focus.read', page, { ...all, limit: 2 })).toEqual(page)
  const next = read({ ...all, limit: 2, cursor: page.nextCursor! })
  expect(next.items.map(item => item.reference)).toEqual([ref('c')]); expect(next.coverage.complete).toBe(true)
  for (const [key, value] of Object.entries(before)) expect(({ sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts })[key as keyof typeof before]).toBe(value)
  expect(useAppStore.getState()).toBe(state)
})

it('an exact selected subset retains missing/cross-Host references and never widens to the other group members', () => {
  let page!: ReturnType<typeof read>
  expect(() => { page = read({ scope, selection: { kind: 'members', references: [ref('b'), ref('a', 'another-host'), ref('missing')] } }) },
    'An exact selected-member read succeeds without exposing non-selected members').not.toThrow()
  expect(page.items.map(item => item.reference)).toEqual([ref('a', 'another-host'), ref('b'), ref('missing')])
  expect(page.items[0]).toMatchObject({ availability: 'unconfirmed', name: null, agent: null, state: null })
  expect(page.items[1]).toMatchObject({ availability: 'observed', name: 'Original B' })
  expect(page.items[2]).toMatchObject({ availability: 'unconfirmed', agent: null })
  expect(page.items.some(item => item.reference.contextId === 'c')).toBe(false)
  expect(page.coverage).toMatchObject({ total: 3, selected: 3, returned: 3, complete: false })
})

it('a project on another Host cannot borrow the original project even with the same claimed Space ID', () => {
  const page = read({ scope: { ...scope, hostId: 'another-host' }, selection: { kind: 'all' } })
  expect(page.items).toEqual([]); expect(page.status).toBe('unconfirmed')
  expect(page.issues).toContainEqual(expect.objectContaining({ code: 'FOCUS_GROUP_UNCONFIRMED' }))
})

it('content updates retain continuation while source or member changes explicitly invalidate it', () => {
  const first = read({ ...all, limit: 1 }), params = { ...all, limit: 1, cursor: first.nextCursor! }
  useAppStore.setState({ agentNames: { ...useAppStore.getState().agentNames, b: 'Later B' } })
  const second = read(params)
  expect(second.items[0]).toMatchObject({ reference: ref('b'), name: 'Later B' })
  const replaced = readFocusGroups(useAppStore.getState(), { method: 'focus.read', params }, { ...source, documentGeneration: 2 }, locations())
  expect(replaced).toMatchObject({ status: 'changed', items: [], nextCursor: null })
  useAppStore.setState({ sessions: useAppStore.getState().sessions.filter(session => session.id !== 'c') })
  const changed = read(params)
  expect(changed).toMatchObject({ status: 'changed', items: [], nextCursor: null })
  expect(changed.issues).toContainEqual(expect.objectContaining({ code: 'FOCUS_CONTINUATION_CHANGED' }))
})

it('unrelated unavailable sources do not withdraw a confirmed project read', () => {
  useAppStore.setState({ mountedSpaceObservations: { unrelated: { reading: false, error: 'Unrelated source unavailable' } },
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, reading: true, error: 'Directory update unconfirmed', topics: [] } } })
  const page = read(all)
  expect(page.status).toBe('observed'); expect(page.coverage.complete).toBe(true)
  expect(page.coverage.sourceStatuses.some(item => item.source === 'mounted-space:unrelated')).toBe(false)
  const directory = readFocusGroups(useAppStore.getState(), { method: 'focus.ls', params: {} }, source, locations())
  expect(directory.coverage.complete).toBe(false)
  const unknown = readFocusGroups(useAppStore.getState(), { method: 'focus.read', params: all }, source)
  expect(unknown.coverage.complete).toBe(false)
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, reading: false, error: null, topics: null } } })
  expect(readFocusGroups(useAppStore.getState(), { method: 'focus.ls', params: {} }, source, locations()).coverage.sourceStatuses)
    .toContainEqual({ source: 'topic-directory:' + scratchWorkspace.id, status: 'unconfirmed' })
  expect(read(all).status).toBe('observed')
})

it('Collection scope is the complete original Category set, including an explicit unconfirmed bucket', async () => {
  const topic = { ...moteTopic('launcher:public-focus-topic', 'Same display title', false), kind: 'topic' as const }
  const categories = ['alpha', 'beta'].map(categoryId => ({ categoryId, hostId: 'local', title: 'Same display title',
    directoryPath: scratchWorkspace.path + '/' + categoryId, revision: 'original-category', spaceId: directoryIdentity('local', scratchWorkspace.path + '/' + categoryId) }))
  const spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
  const session = { ...composerSession('collection-context'), workspacePath: topic.directoryPath }
  const tab = { ...createWorkbenchTab('topic-tab', { kind: 'agent' as const, phase: 'attached' as const, regionId: 'topic-region', workspaceId: scratchWorkspace.id, sessionId: session.id }), topicId: topic.id, space: { spaceId, zoneId } }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [project, scratchWorkspace] }, sessions: [session], tabs: { [tab.id]: tab },
    layouts: { [scratchWorkspace.id]: createWorkspaceLayout('topic-group', [tab.id]) }, topicCategories: categories,
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, reading: false, error: null, topics: [topic] } },
    spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: scratchWorkspace.id, topicId: topic.id, directoryPath: topic.directoryPath, contentKind: 'topic',
      relations: Object.fromEntries(categories.map(category => [category.spaceId, true])), resource: { kind: 'home', hostId: 'local', directoryPath: topic.directoryPath, branch: null } } } })
  vi.mocked(api.spatial.read).mockResolvedValue({ schemaVersion: 1, revision: 2, graph: desktopSpatialGraph(useAppStore.getState(), [topic]) })
  await initializeSpatialControlFixture([topic])
  const collection = { kind: 'collection' as const, hostId: 'local', categorySpaceIds: categories.map(category => category.spaceId).sort() }
  expect(read({ scope: collection, selection: { kind: 'all' } }).items.map(item => item.reference)).toEqual([ref(session.id)])
  expect(read({ scope: { ...collection, categorySpaceIds: [categories[0]!.spaceId] }, selection: { kind: 'all' } }).items).toEqual([])
  useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: { ...useAppStore.getState().scratchTopicSnapshots[scratchWorkspace.id]!, reading: true, error: 'Metadata update unconfirmed' } } })
  const cached = read({ scope: collection, selection: { kind: 'all' } })
  expect(cached.items.map(item => item.reference)).toEqual([ref(session.id)])
  expect(cached.coverage.complete).toBe(false); expect(cached.status).toBe('unconfirmed')
  expect(cached.coverage.sourceStatuses).toContainEqual({ source: 'topic-directory:' + scratchWorkspace.id, status: 'unconfirmed' })
  expect(cached.issues).toContainEqual(expect.objectContaining({ code: 'FOCUS_METADATA_UNCONFIRMED' }))
  useAppStore.setState({ topicCategories: [] })
  const unknown = read({ scope: { ...collection, categorySpaceIds: [] }, selection: { kind: 'all' } })
  expect(unknown.items.map(item => item.reference)).toEqual([ref(session.id)])
  expect(unknown.status).toBe('unconfirmed'); expect(unknown.coverage.complete).toBe(false)
})

it('a member moved to another project keeps its exact known facts while original membership is changed', async () => {
  const before = useAppStore.getState(), other = { ...project, id: 'other-project', name: 'Other project', path: project.path + '/other' }
  const originalTab = before.tabs.b!, regionId = originalTab.layout.activeRegionId
  useAppStore.setState({ config: { ...before.config!, workspaces: [project, other] },
    tabs: { ...before.tabs, b: { ...originalTab, workspaceId: other.id, regions: { ...originalTab.regions, [regionId]: { ...originalTab.regions[regionId]!, workspaceId: other.id } } } },
    layouts: { [project.id]: createWorkspaceLayout('original-group', ['a', 'c']), [other.id]: createWorkspaceLayout('other-group', ['b']) } })
  vi.mocked(api.spatial.read).mockResolvedValue({ schemaVersion: 1, revision: 3, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  const page = read({ scope, selection: { kind: 'members', references: [ref('b')] } })
  expect(page).toMatchObject({ status: 'changed', coverage: { complete: false } })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ reference: ref('b'), availability: 'changed', name: 'Original B', kind: 'agent',
    agent: { hostId: 'local', agentSessionId: 'b', run: { runId: 'run-b' } }, locations: { status: 'confirmed', occurrences: [{ hostId: 'local', workspaceId: other.id, groupId: 'other-group', tabId: 'b', regionId }] } })
  expect(page.items[0]!.state).not.toBeNull(); expect(page.items[0]!.excerpt).not.toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})
