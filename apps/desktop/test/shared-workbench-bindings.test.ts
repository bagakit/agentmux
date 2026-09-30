// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, type AgentMuxSpaceControlRequest } from '@agentmux/core'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { directoryIdentity, workspaceZoneId, homeZoneId } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench, restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { spatialCatalog, selectSpatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { resolveDesktopSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { installNativePopover } from './fixtures/mote-workface'

const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }, { id: 'remote', kind: 'ssh', label: 'Resource host', hostname: 'private.invalid' }], executors: {},
  workspaces: [{ id: 'resource', hostId: 'remote', name: 'Resource', path: '/resource', kind: 'folder' },
    { id: 'display', hostId: 'local', name: 'Display', path: '/display', kind: 'folder' },
    { id: '__scratch__', hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const topics = ['a', 'b'].map(id => ({ id, title: 'Same title', summary: '', directoryPath: `topic--${id}`, topicPath: `topic--${id}/topic.md`, collaborators: [] }))
const folder = directoryIdentity('remote', '/resource'), topicA = directoryIdentity('local', '/topics/topic--a'), topicB = directoryIdentity('local', '/topics/topic--b')
const zone = workspaceZoneId(folder, 'resource'), savedZone = workspaceZoneId(topicA, 'resource')
const tab = { ...createWorkbenchTab('retained-tab', { regionId: 'retained-region', kind: 'file', workspaceId: 'resource', path: 'draft.txt' }), space: { spaceId: folder, zoneId: zone } }
const first = createWorkspaceLayout('first', [tab.id])
const twoGroups: WorkspaceLayout = { ...first, root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: { type: 'leaf', groupId: 'second' } },
  groups: [...first.groups, { ...first.groups[0]!, id: 'second' }], activeGroupId: 'second' }
const originalAgent = { id: 'original-agent', kind: 'agent', providerId: 'codex', executorId: 'fixture', hostId: 'remote', workspacePath: '/execution-original',
  label: 'Original', capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
  control: { kind: 'agent', agentSessionId: 'original-agent', hostId: 'remote', run: { runId: 'original-run' } } } satisfies Extract<SessionSnapshot, { kind: 'agent' }>
let server: AgentMuxControlServer | undefined, directory: string | undefined
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  useAppStore.setState({ ...initial, config, tabs: {}, layouts: { resource: first, display: createWorkspaceLayout('foreign') }, sessions: [], spaceZoneBindings: {}, spatialRequests: {}, activeWorkspaceId: 'resource' }, true)
  await initializeSpatialControlFixture(topics)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
})
afterEach(async () => { await server?.stop(); if (directory) await rm(directory, { recursive: true }); server = undefined; directory = undefined; vi.restoreAllMocks(); useAppStore.setState(initial, true); vi.unstubAllGlobals() })
async function wire(request: AgentMuxSpaceControlRequest) {
  if (!server) { directory = await mkdtemp(join(tmpdir(), 'amx-bindings-')); server = new AgentMuxControlServer({ execute: request => useAppStore.getState().executeControl(request) }, join(directory, 'control.sock')); await server.start() }
  const value = await new Promise<unknown>((resolve, reject) => { const socket = createConnection(server!.path); let reply = ''; socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(JSON.stringify(request) + '\n')); socket.on('data', part => reply += part); socket.once('error', reject);
    socket.once('end', () => { try { resolve(JSON.parse(reply)) } catch (error) { reject(error) } }) })
  const receipt = parseAgentMuxControlReceipt(value)
  expect(receipt.ok).toBe(true)
  if (!receipt.ok) throw new Error(receipt.error.message)
  return receipt
}
async function catalog() {
  const receipt = await wire({ schemaVersion: 5, requestId: `ls:${crypto.randomUUID()}`, operation: 'space.ls', target: {} })
  if (receipt.operation !== 'space.ls') throw new Error('Wrong receipt')
  return receipt.result.catalog
}
it('retains default and every original saved/Tab seed without replacing opaque IDs', async () => {
  const retained = { ...tab, space: { zoneId: savedZone, spaceId: topicB } }
  const bindings = { [savedZone]: { spaceId: topicA, workspaceId: 'resource' } }
  useAppStore.setState({ tabs: { [tab.id]: retained }, layouts: { resource: twoGroups }, spaceZoneBindings: bindings })
  const actual = await catalog()
  expect(actual.zones.filter(item => item.workspaceId === 'resource').map(item => item.zoneId)).toEqual([zone, savedZone])
  expect(actual.bindings.filter(item => item.zoneId === savedZone)).toEqual([{ zoneId: savedZone, spaceId: topicA }, { zoneId: savedZone, spaceId: topicB }])
  expect(useAppStore.getState().spaceZoneBindings).toBe(bindings)
  expect(actual.tabs).toEqual([{ tabId: tab.id, zoneId: savedZone, workspaceId: 'resource', name: null, regionIds: ['retained-region'] }])
})
it('uses one actual UI/transport owner for exact cross-host relations and zero-write repeats', async () => {
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: first } })
  expect((await useAppStore.getState().setZoneSpaceRelation(zone, topicA, true)).outcome).toBe('linked')
  const reply = await wire({ schemaVersion: 5, requestId: 'link-b', operation: 'space.bind', binding: { kind: 'zone-space', zoneId: zone, spaceId: topicB } })
  expect(reply.operation).toBe('space.bind')
  const actual = await catalog()
  expect(actual.zones.filter(item => item.zoneId === zone)).toEqual([{ zoneId: zone, workspaceId: 'resource', kind: 'directory', hostId: 'remote', directoryPath: '/resource', branch: null }])
  expect(actual.bindings.filter(item => item.zoneId === zone)).toEqual([{ zoneId: zone, spaceId: folder }, { zoneId: zone, spaceId: topicA }, { zoneId: zone, spaceId: topicB }])
  expect(actual.locations.filter(item => item.zoneId === zone).map(item => item.spaceId)).toEqual([folder, topicA, topicB])
  const before = useAppStore.getState(), flush = vi.spyOn(api.ui, 'requestStorageFlush'), writes = vi.fn(), unsubscribe = useAppStore.subscribe(writes)
  expect((await useAppStore.getState().setZoneSpaceRelation(zone, topicA, true)).outcome).toBe('unchanged')
  expect((await useAppStore.getState().setZoneSpaceRelation(zone, directoryIdentity('local', '/display'), false)).outcome).toBe('unchanged')
  expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings)
  expect(writes).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); unsubscribe()
  const removed = await wire({ schemaVersion: 5, requestId: 'unlink-seed', operation: 'space.unbind', binding: { kind: 'zone-space', zoneId: zone, spaceId: folder } })
  expect(removed.operation).toBe('space.unbind')
  expect((await catalog()).bindings.filter(item => item.zoneId === zone)).toEqual([{ zoneId: zone, spaceId: topicA }, { zoneId: zone, spaceId: topicB }])
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  expect(useAppStore.getState().spaceZoneBindings[zone]).toEqual({ spaceId: folder, workspaceId: 'resource', relations: { [topicA]: true, [topicB]: true, [folder]: false } })
  const persisted = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
  expect(persisted.spaceZoneBindings).toEqual(useAppStore.getState().spaceZoneBindings)
})
it('enumerates and removes exact occurrences without closing the final entity or recreating it on restore', async () => {
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: twoGroups, display: createWorkspaceLayout('foreign') } })
  expect((await useAppStore.getState().setTabDisplayPlacement(tab.id, 'display', 'foreign', true)).outcome).toBe('linked')
  expect((await catalog()).tabs.map(item => item.tabId)).toEqual([tab.id])
  expect((await catalog()).locations.map(item => [item.displayWorkspaceId, item.groupId])).toEqual([['resource', 'first'], ['resource', 'second'], ['display', 'foreign']])
  const raw = projectPersistedWorkbench(useAppStore.getState())
  const restored = restorePersistedWorkbench({ config, sessions: [], persisted: raw, createTabGroupId: () => 'unused-empty' })
  expect(restored.tabs).toEqual({ [tab.id]: tab }); expect(restored.layouts.resource).toEqual(twoGroups)
  expect(restored.layouts.display).toEqual(useAppStore.getState().layouts.display)
  expect(resolveDesktopSpaceSelection(useAppStore.getState(), await catalog(), { tabId: tab.id, displayWorkspaceId: 'display', groupId: 'foreign' })).toMatchObject({ workspaceId: 'display', groupId: 'foreign', tabId: tab.id, regionId: 'retained-region' })
  for (const [workspaceId, groupId] of [['resource', 'second'], ['display', 'foreign'], ['resource', 'first']] as const) {
    expect((await useAppStore.getState().setTabDisplayPlacement(tab.id, workspaceId, groupId, false)).outcome).toBe('unlinked')
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  }
  expect((await catalog()).locations).toEqual([])
  const unbound = projectPersistedWorkbench(useAppStore.getState())
  const after = restorePersistedWorkbench({ config, sessions: [], persisted: unbound, createTabGroupId: () => 'unused-empty' })
  expect(after.tabs).toEqual({ [tab.id]: tab }); expect(after.layouts.resource!.groups.map(group => group.tabOrder)).toEqual([[]])
})
it('adds a second exact Group through the original layout owner while preserving selection', async () => {
  const emptySecond = { ...twoGroups, groups: twoGroups.groups.map(group => group.id === 'second' ? { ...group, tabOrder: [], activeTabId: null, recentTabIds: [] } : group), activeGroupId: 'first' }
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: emptySecond } })
  await useAppStore.getState().setTabDisplayPlacement(tab.id, 'resource', 'second', true)
  expect((await catalog()).locations.map(item => item.groupId)).toEqual(['first', 'second'])
  expect(useAppStore.getState().layouts.resource!.activeGroupId).toBe('first')
  expect(useAppStore.getState().layouts.resource!.groups.map(group => group.activeTabId)).toEqual([tab.id, null])
})
it('creates two stable temporary Zones on one resource through the original save/Launcher owners', async () => {
  const createResource = vi.spyOn(api.workspaces, 'createZoneResource'), launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  const a = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  const b = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  expect(a.zone.zoneId).not.toBe(b.zone.zoneId)
  expect([a.zone, b.zone].map(item => [item.workspaceId, item.hostId, item.directoryPath])).toEqual([['resource', 'remote', '/resource'], ['resource', 'remote', '/resource']])
  expect(a.save).toEqual({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null })
  const id = useAppStore.getState().openLauncher({ workspaceId: 'resource', tabGroupId: 'first', zoneId: a.zone.zoneId, reveal: false })!
  expect(useAppStore.getState().tabs[id]!.space).toEqual({ zoneId: a.zone.zoneId, spaceId: folder })
  expect((await catalog()).bindings.filter(item => [a.zone.zoneId, b.zone.zoneId].includes(item.zoneId))).toEqual([])
  expect((await catalog()).locations.filter(item => item.tabId === id).map(item => item.spaceId)).toEqual([null])
  expect(createResource).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('opens an explicit original default Zone without requiring a relation override record', async () => {
  const before = useAppStore.getState().spaceZoneBindings
  const id = useAppStore.getState().openLauncher({ workspaceId: 'resource', tabGroupId: 'first', zoneId: zone, reveal: false })
  expect(id).toBeTypeOf('string')
  expect(useAppStore.getState().tabs[id!]!.space).toEqual({ zoneId: zone, spaceId: folder })
  expect(useAppStore.getState().spaceZoneBindings).toBe(before)
})
it('creates a Zone Launcher directly in an exact foreign Group and rejects unknown placement before admission', async () => {
  const created = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  const foreign = createWorkspaceLayout('display-first')
  const display: WorkspaceLayout = { ...foreign, root: { type: 'split', direction: 'horizontal', ratio: .4, first: foreign.root, second: { type: 'leaf', groupId: 'foreign' } },
    groups: [...foreign.groups, { ...foreign.groups[0]!, id: 'foreign' }], activeGroupId: 'display-first' }
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: twoGroups, display }, retainedSpatialFocus: {
    workspaceId: 'resource', displayWorkspaceId: 'resource', spaceId: folder, zoneId: zone, groupId: 'second', tabId: tab.id, regionId: 'retained-region' } })
  const before = useAppStore.getState(), resource = vi.spyOn(api.workspaces, 'createZoneResource'), launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  const id = useAppStore.getState().openLauncher({ workspaceId: 'resource', zoneId: created.zone.zoneId,
    displayWorkspaceId: 'display', tabGroupId: 'foreign', reveal: false })!
  expect(id).toBeTypeOf('string')
  expect(useAppStore.getState().tabs[id]!.workspaceId).toBe('resource')
  expect(useAppStore.getState().tabs[id]!.space).toEqual({ zoneId: created.zone.zoneId, spaceId: folder })
  expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings)
  expect(useAppStore.getState().layouts.resource).toBe(before.layouts.resource)
  expect(useAppStore.getState().layouts.display!.activeGroupId).toBe('display-first')
  expect(useAppStore.getState().layouts.display!.groups.map(group => [group.id, group.tabOrder, group.activeTabId, group.recentTabIds])).toEqual([
    ['display-first', [], null, []], ['foreign', [id], null, []]])
  expect(spatialCatalog(useAppStore.getState(), topics).locations.filter(item => item.tabId === id).map(item => [item.workspaceId, item.displayWorkspaceId, item.groupId])).toEqual([['resource', 'display', 'foreign']])
  const admitted = useAppStore.getState(), saved = localStorage.getItem('agentmux-workbench-v1'), flush = vi.spyOn(api.ui, 'requestStorageFlush')
  for (const [displayWorkspaceId, tabGroupId] of [['missing', 'foreign'], ['display', 'missing']] as const) {
    expect(useAppStore.getState().openLauncher({ workspaceId: 'resource', zoneId: created.zone.zoneId, displayWorkspaceId, tabGroupId, reveal: true })).toBeUndefined()
    expect(useAppStore.getState().tabs).toBe(admitted.tabs)
    expect(useAppStore.getState().layouts).toBe(admitted.layouts)
    expect(useAppStore.getState().spaceZoneBindings).toBe(admitted.spaceZoneBindings)
    expect(useAppStore.getState().retainedSpatialFocus).toBe(admitted.retainedSpatialFocus)
    expect(useAppStore.getState().activeWorkspaceId).toBe(admitted.activeWorkspaceId)
    expect(localStorage.getItem('agentmux-workbench-v1')).toBe(saved)
  }
  expect(flush).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('keeps an explicit temporary Scratch Zone separate from the active Topic and preserves its original home Zone', async () => {
  const original = { ...createWorkbenchTab('topic-tab', { kind: 'launcher', regionId: 'topic-region', workspaceId: '__scratch__' }),
    topicId: 'a', space: { zoneId: homeZoneId(topicA), spaceId: topicA } }
  useAppStore.setState({ tabs: { [original.id]: original }, layouts: { __scratch__: createWorkspaceLayout('topic-group', [original.id]) } })
  await useAppStore.getState().refreshScratchTopics('__scratch__', true)
  const temporary = await useAppStore.getState().createWorkbenchZone({ workspaceId: '__scratch__', spaceIds: [] })
  const id = useAppStore.getState().openLauncher({ workspaceId: '__scratch__', tabGroupId: 'topic-group', zoneId: temporary.zone.zoneId, reveal: false })!
  expect(useAppStore.getState().tabs[id]!.topicId).toBeUndefined()
  expect(useAppStore.getState().tabs[id]!.space).toEqual({ zoneId: temporary.zone.zoneId, spaceId: directoryIdentity('local', '/topics') })
  expect(spatialCatalog(useAppStore.getState(), topics).zones.find(zone => zone.zoneId === temporary.zone.zoneId)).toMatchObject({ hostId: 'local', directoryPath: '/topics' })
  const home = useAppStore.getState().openLauncher({ workspaceId: '__scratch__', tabGroupId: 'topic-group', zoneId: homeZoneId(topicA), reveal: false })!
  expect(useAppStore.getState().tabs[home]!.topicId).toBe('a')
  expect(useAppStore.getState().tabs[home]!.space).toEqual({ zoneId: homeZoneId(topicA), spaceId: topicA })
  expect(spatialCatalog(useAppStore.getState(), topics).zones.find(zone => zone.zoneId === homeZoneId(topicA))).toMatchObject({ kind: 'home', directoryPath: '/topics/topic--a' })
  const inherited = useAppStore.getState().openLauncher({ workspaceId: '__scratch__', tabGroupId: 'topic-group', reveal: false })!
  expect(useAppStore.getState().tabs[inherited]!.topicId).toBe('a')
})
it('returns the already-created Zone when saving is unknown and retains identities when config disappears', async () => {
  vi.spyOn(api.ui, 'requestStorageFlush').mockRejectedValue(new Error('private save unknown'))
  const result = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  expect(result.save).toMatchObject({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'private save unknown' })
  expect(result.issues.map(item => item.code)).toEqual(['SPACE_SAVE_UNCONFIRMED'])
  expect(Object.keys(useAppStore.getState().spaceZoneBindings)).toEqual([result.zone.zoneId])
  useAppStore.setState({ config: null, tabs: { [tab.id]: tab }, layouts: { display: first } })
  const actual = spatialCatalog(useAppStore.getState(), [])
  expect(actual.zones.map(item => item.zoneId)).toEqual([result.zone.zoneId, zone])
  expect(actual.zones.map(item => [item.kind, item.hostId, item.directoryPath])).toEqual([['unknown', null, null], ['unknown', null, null]])
  expect(actual.tabs.map(item => item.tabId)).toEqual([tab.id])
  expect(actual.locations.map(item => [item.workspaceId, item.displayWorkspaceId, item.groupId])).toEqual([['resource', 'display', 'first']])
})
it('rejects a shared Region move before admission even with an exact source Group, retaining the healthy owner', async () => {
  const attached = { ...createWorkbenchTab(tab.id, { kind: 'agent', phase: 'attached', workspaceId: 'resource', regionId: 'retained-region', sessionId: 'original-agent' }), space: tab.space }
  const layouts = { resource: twoGroups, display: createWorkspaceLayout('foreign', [tab.id]) }
  const sessions = [originalAgent]
  useAppStore.setState({ tabs: { [tab.id]: attached }, layouts, sessions })
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop'), resource = vi.spyOn(api.workspaces, 'createZoneResource'), flush = vi.spyOn(api.ui, 'requestStorageFlush')
  const before = useAppStore.getState()
  const receipt = await wire({ schemaVersion: 5, requestId: 'shared-move', operation: 'space.mv', fromRegionId: 'retained-region', expectedAgentSessionId: 'original-agent',
    fromLocation: { displayWorkspaceId: 'resource', groupId: 'second' }, destination: { spaceId: directoryIdentity('local', '/display'), newTab: true }, focus: false })
  if (receipt.operation !== 'space.mv') throw new Error('Wrong receipt')
  expect(receipt.result.issues.map(item => item.code)).toEqual(['SPACE_MOVE_MULTIPLE_OCCURRENCES_UNSUPPORTED'])
  expect(receipt.result.issues[0]!.candidates!.map(item => [item.displayWorkspaceId, item.groupId])).toEqual([['resource', 'first'], ['resource', 'second'], ['display', 'foreign']])
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().spatialRequests).toEqual({})
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled()
})
it('deduplicates only complete addresses and retains contradictory Tab membership as unknown', async () => {
  const repeated = { ...twoGroups, groups: twoGroups.groups.map(group => ({ ...group, tabOrder: [tab.id, tab.id] })) }
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { resource: repeated } })
  expect((await catalog()).locations.map(item => item.groupId)).toEqual(['first', 'second'])
  const contradictory = { ...tab, workspaceId: 'display' }
  useAppStore.setState({ spaceZoneBindings: { [zone]: { workspaceId: 'resource', spaceId: folder } }, tabs: { [tab.id]: contradictory } })
  const actual = await catalog()
  expect(actual.tabs.map(item => [item.tabId, item.zoneId])).toEqual([[tab.id, null]])
  expect(actual.tabs[0]!.issue).toContain('contradicts')
  expect(actual.zones.filter(item => item.zoneId === zone).map(item => item.workspaceId)).toEqual(['resource'])
})
it('keeps temporary creation available with an explicit discovery notice', async () => {
  vi.spyOn(api.scratch, 'listTopics').mockRejectedValue(new Error('private discovery unavailable'))
  const result = await useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  expect(Object.keys(useAppStore.getState().spaceZoneBindings)).toEqual([result.zone.zoneId])
  expect(result.issues.map(item => item.code)).toEqual(['SPACE_DISCOVERY_UNCONFIRMED'])
})
it('rejects a phantom display through the typed transport before any intent, layout or save admission', async () => {
  const sessions = [originalAgent]
  useAppStore.setState({ sessions })
  const before = useAppStore.getState(), flush = vi.spyOn(api.ui, 'requestStorageFlush'), launch = vi.spyOn(api.sessions, 'launchAgent'),
    resource = vi.spyOn(api.workspaces, 'createZoneResource'), attach = vi.spyOn(api.sessions, 'creation'), stop = vi.spyOn(api.sessions, 'stop')
  const receipt = await wire({ schemaVersion: 5, requestId: 'phantom-display', operation: 'agent.open',
    content: { kind: 'agent-session', agentSessionId: originalAgent.id }, destination: { zoneId: zone, displayWorkspaceId: 'missing-display', newTab: true }, focus: false })
  if (receipt.operation !== 'agent.open') throw new Error('Wrong receipt')
  expect(receipt.result.outcome).toBe('unknown')
  expect(receipt.result.issues.map(item => item.code)).toEqual(['SPACE_LOCATION_UNKNOWN'])
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings); expect(useAppStore.getState().spatialRequests).toBe(before.spatialRequests)
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(flush).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})
it('opens an existing Agent presentation in a linked temporary Zone without making the display Topic its resource context', async () => {
  const temporary = await useAppStore.getState().createWorkbenchZone({ workspaceId: '__scratch__', spaceIds: [topicA] })
  const sessions = [originalAgent]
  useAppStore.setState({ sessions, layouts: { __scratch__: createWorkspaceLayout('scratch-group') } })
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop'), resource = vi.spyOn(api.workspaces, 'createZoneResource')
  const receipt = await wire({ schemaVersion: 5, requestId: 'temporary-topic-presentation', operation: 'agent.open',
    content: { kind: 'agent-session', agentSessionId: originalAgent.id }, destination: { zoneId: temporary.zone.zoneId, spaceId: topicA, displayWorkspaceId: '__scratch__', groupId: 'scratch-group', newTab: true }, focus: false })
  if (receipt.operation !== 'agent.open') throw new Error('Wrong receipt')
  expect(receipt.result.outcome).toBe('opened')
  expect(receipt.result.to).toMatchObject({ zoneId: temporary.zone.zoneId, spaceId: topicA, workspaceId: '__scratch__', displayWorkspaceId: '__scratch__', groupId: 'scratch-group' })
  const placed = useAppStore.getState().tabs[receipt.result.to!.tabId]!
  expect(placed.topicId).toBeUndefined()
  expect(placed.space).toEqual({ zoneId: temporary.zone.zoneId, spaceId: directoryIdentity('local', '/topics') })
  expect(useAppStore.getState().sessions).toBe(sessions)
  expect(receipt.result.agent).toMatchObject({ hostId: 'remote', cwd: '/execution-original', runId: 'original-run' })
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(resource).not.toHaveBeenCalled()
})
it('retains the exact original home resource on empty discovery and reports contradictory contexts as unknown', async () => {
  const home = homeZoneId(topicA), retained = { ...createWorkbenchTab('home-tab', { kind: 'launcher', regionId: 'home-region', workspaceId: '__scratch__' }),
    topicId: 'a', space: { zoneId: home, spaceId: topicA } }
  useAppStore.setState({ tabs: { [retained.id]: retained }, layouts: { __scratch__: createWorkspaceLayout('home-group', [retained.id]) },
    spaceZoneBindings: { [home]: { workspaceId: '__scratch__', spaceId: topicA } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const actual = await catalog()
  expect(actual.zones.filter(zone => zone.zoneId === home)).toEqual([{ zoneId: home, workspaceId: '__scratch__', kind: 'home', hostId: 'local', directoryPath: '/topics/topic--a', branch: null }])
  expect(actual.bindings.filter(binding => binding.zoneId === home)).toEqual([{ zoneId: home, spaceId: topicA }])
  expect(actual.tabs.filter(tab => tab.tabId === retained.id).map(tab => tab.zoneId)).toEqual([home])
  const contradicted = { ...retained, workspaceId: 'resource' }
  useAppStore.setState({ tabs: { [retained.id]: contradicted } })
  const unknown = (await catalog()).zones.find(zone => zone.zoneId === home)!
  expect(unknown).toMatchObject({ zoneId: home, workspaceId: '__scratch__', kind: 'unknown', hostId: null, directoryPath: null })
  expect(unknown.issue).toContain('conflict')
  expect(useAppStore.getState().tabs[retained.id]).toBe(contradicted)
})
it('keeps a complete neutral parent after Close instead of relabeling another Zone\'s foreign Tab', async () => {
  const peerSpace = directoryIdentity('local', '/display'), peerZone = workspaceZoneId(peerSpace, 'display')
  const peer = { ...createWorkbenchTab('peer-tab', { kind: 'file', regionId: 'peer-region', workspaceId: 'display', path: 'peer.txt' }), space: { zoneId: peerZone, spaceId: peerSpace } }
  const choice = { spaceId: folder, zoneId: zone, workspaceId: 'display', tabId: tab.id, groupId: 'foreign', regionId: 'retained-region', topicId: null }
  useAppStore.setState({ tabs: { [tab.id]: tab, [peer.id]: peer }, layouts: { resource: createWorkspaceLayout('original-empty'), display: createWorkspaceLayout('foreign', [tab.id, peer.id]) },
    activeWorkspaceId: 'display', workbenchSpaceSelection: choice })
  expect(await useAppStore.getState().closeTab('display', 'foreign', tab.id)).toBe(true)
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual({ spaceId: folder, zoneId: zone, workspaceId: 'display', tabId: null, groupId: null, regionId: null, topicId: null })
  expect(useAppStore.getState().layouts.display!.groups[0]!.activeTabId).toBe(peer.id)
  expect(useAppStore.getState().tabs).toEqual({ [peer.id]: peer })
})

it('joins display selectors only to their exact members while an unplaced entity remains inspectable', async () => {
  const other = createWorkbenchTab('unrelated-tab', { regionId: 'unrelated-region', kind: 'file', workspaceId: 'display', path: 'other.txt' })
  useAppStore.setState({ tabs: { [tab.id]: tab, [other.id]: other }, layouts: { resource: twoGroups, display: createWorkspaceLayout('foreign', [tab.id]) } })
  const all = await catalog()
  const selected = selectSpatialCatalog(all, { displayWorkspaceId: 'display', groupId: 'foreign' })
  expect(selected.tabs.map(item => item.tabId)).toEqual([tab.id])
  expect(selected.regions.map(item => item.regionId)).toEqual(['retained-region'])
  expect(selected.zones.map(item => item.zoneId)).toEqual([zone])
  expect(selected.bindings).toEqual([{ zoneId: zone, spaceId: folder }])
  expect(selected.locations.map(item => [item.tabId, item.displayWorkspaceId, item.groupId])).toEqual([[tab.id, 'display', 'foreign']])
  expect(selectSpatialCatalog(all, { tabId: other.id }).tabs.map(item => item.tabId)).toEqual([other.id])
  expect(selectSpatialCatalog(all, { tabId: other.id }).locations).toEqual([])
})
it('rechecks the explicit resource owner after awaited discovery without creating a stale Zone', async () => {
  let release!: () => void
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => new Promise(resolve => { release = () => resolve([]) }))
  const before = useAppStore.getState(), flush = vi.spyOn(api.ui, 'requestStorageFlush')
  const pending = useAppStore.getState().createWorkbenchZone({ workspaceId: 'resource', spaceIds: [] })
  useAppStore.setState({ config: { ...config, workspaces: config.workspaces.filter(workspace => workspace.id !== 'resource') } })
  release()
  await expect(pending).rejects.toMatchObject({ issue: { code: 'SPACE_RESOURCE_UNKNOWN' } })
  expect(useAppStore.getState().spaceZoneBindings).toBe(before.spaceZoneBindings)
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(flush).not.toHaveBeenCalled()
})
it('loads the real Tab menu and toggles its exact foreign Group through the Store owner', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const restorePopover = installNativePopover(), host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const launcher = { ...createWorkbenchTab(tab.id, { kind: 'launcher', regionId: 'retained-region', workspaceId: 'resource' }), space: tab.space }
  useAppStore.setState({ tabs: { [tab.id]: launcher }, layouts: { resource: first, display: createWorkspaceLayout('foreign') } })
  try {
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: 'resource', visible: false,
      viewOwnership: 'projection', projectionTabId: tab.id, viewHostPrefix: 'binding-menu-test' })))
    const trigger = host.querySelector<HTMLElement>('.workbench-tab')!
    expect(trigger).not.toBeNull()
    await act(async () => trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })))
    const sub = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.startsWith('Link to Workspace / Group'))!
    expect(sub).toBeDefined()
    await act(async () => { sub.focus(); sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    const foreign = document.querySelector<HTMLElement>('[role="menuitemcheckbox"][title="display / foreign"]')!
    expect(foreign).not.toBeNull(); expect(foreign.getAttribute('aria-checked')).toBe('false')
    await act(async () => { foreign.focus(); foreign.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(useAppStore.getState().layouts.display!.groups[0]!.tabOrder).toEqual([tab.id])
    expect(document.querySelector('[role="menuitemcheckbox"][title="display / foreign"]')?.getAttribute('aria-checked')).toBe('true')
    const placed = useAppStore.getState().tabs[tab.id]
    await act(async () => { foreign.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(useAppStore.getState().layouts.display!.groups[0]!.tabOrder).toEqual([])
    expect(useAppStore.getState().tabs[tab.id]).toBe(placed)
  } finally {
    await act(async () => root.unmount()); host.remove(); restorePopover()
  }
})
