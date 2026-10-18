// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { resolveWorkbenchZone } from '../src/renderer/src/lib/workbench-projection'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'

const initial = useAppStore.getState()
const config = { ...composerConfig, executors: {} }
const closed = composerSession('closed-agent'), healthy = composerSession('healthy-agent')
const originalTab = createWorkbenchTab('closed-tab', { kind: 'agent', regionId: 'closed-region', phase: 'attached', workspaceId: 'workspace', sessionId: closed.id })
const survivor = addWorkbenchRegion(createWorkbenchTab('survivor-tab', { kind: 'agent', regionId: 'healthy-region', phase: 'attached', workspaceId: 'workspace', sessionId: healthy.id }),
  'healthy-region', 'right', { kind: 'file', regionId: 'file-region', workspaceId: 'workspace', path: 'retained.md' })
let directory: string, owner: AgentMuxSpatialStateStore, dispose: (() => void) | undefined
let snapshot: RuntimeSnapshot

function removed(runId = closed.control.run.runId, hostId = 'local'): RuntimeEvent {
  return { type: 'core', hostId, event: { type: 'run-removed', agentSessionId: closed.id,
    run: { runId }, evidence: { source: 'user', observedAt: Date.now(), run: { runId } } } }
}
function retire() {
  snapshot = { ...snapshot, sessions: snapshot.sessions.filter(session => session.id !== closed.id) }
  useAppStore.getState().applyEvent(removed())
}
beforeEach(async () => {
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  directory = await mkdtemp(join(tmpdir(), 'agentmux-closed-tabs-'))
  owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(input => owner.retainDisplayLabels(input))
  const tabs = { [originalTab.id]: originalTab, [survivor.id]: survivor }
  const layouts = { workspace: createWorkspaceLayout('group', Object.keys(tabs)) }
  snapshot = { sessions: [closed, healthy], recoveryCandidates: [], timelines: Object.fromEntries([closed, healthy].map(session =>
    [session.id, { agentSessionId: session.id, revision: 1, items: [] }])) }
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => snapshot)
  vi.spyOn(api.sessions, 'recover').mockImplementation(async control => ({ kind: 'reattachable', session: control.kind === 'agent' && control.agentSessionId === closed.id ? closed : healthy }))
  vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...initial, config, tabs, layouts, sessions: snapshot.sessions }, []) })
  useAppStore.setState({ loading: true, restoredWorkbench: { tabs, layouts }, activeWorkspaceId: 'workspace',
    agentComposerDrafts: { [closed.id]: 'Closed original draft', [healthy.id]: 'Healthy original draft' } })
  dispose = await useAppStore.getState().initialize()
  await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledTimes(2))
  await useAppStore.getState().retryWorkbenchSave()
  expect(useAppStore.getState().workbenchSaveWarning).toBeNull()
})
afterEach(async () => {
  dispose?.(); dispose = undefined
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
  await rm(directory, { recursive: true, force: true })
})
async function expectClosed(expectedLayout = survivor.layout) {
  await useAppStore.getState().retryWorkbenchSave()
  const saved = (await owner.readForLayout())!
  expect(saved.graph.tabs.map(tab => tab.tabId)).toEqual([survivor.id])
  expect(saved.graph.regions.map(region => region.regionId).sort()).toEqual(['file-region', 'healthy-region'])
  expect(saved.graph.resources).not.toHaveProperty('tab:closed-tab')
  expect(saved.graph.resources).not.toHaveProperty('region:closed-region')
  expect(saved.graph.tabLayouts).not.toHaveProperty(originalTab.id)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([survivor.id])
  expect(useAppStore.getState().tabs[survivor.id]?.regions).toEqual(survivor.regions)
  expect(useAppStore.getState().tabs[survivor.id]?.layout).toEqual(expectedLayout)
  expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder).toEqual([survivor.id])
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ [closed.id]: 'Closed original draft', [healthy.id]: 'Healthy original draft' })
  expect(useAppStore.getState().sessions.find(session => session.id === healthy.id)?.control).toEqual(healthy.control)
  expect(useAppStore.getState().workbenchSaveWarning).toBeNull()
  const zoneId = saved.graph.tabs.find(tab => tab.tabId === survivor.id)!.zoneId!
  const state = useAppStore.getState()
  const projection = resolveWorkbenchZone(zoneId, { ...saved.graph, locations: [] }, state.layouts, state.tabs,
    'closed-agent-zone', [], () => {})
  // Space navigation composes retained unplaced entities into a separate column.
  // A closed entity must not reappear there when the user returns to this Zone.
  expect(projection?.composition?.groups.map(group => ({ id: group.id, tabs: group.tabOrder }))).toEqual([{ id: 'group', tabs: [survivor.id] }])
}

it('commits exact Core retirement before a spatial save can restore the removed Tab', async () => {
  retire()
  await expectClosed()
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('Stop & Close persists the deletion when run-removed arrives before the stop reply', async () => {
  vi.mocked(api.sessions.stop).mockImplementation(async () => { retire(); await Promise.resolve() })
  expect(await useAppStore.getState().closeTab('workspace', 'group', originalTab.id)).toBe(true)
  await expectClosed()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(closed.control)
})

it('buffered retirement during reconnect commits the same spatial deletion', async () => {
  let release!: (value: RuntimeSnapshot) => void
  const pending = new Promise<RuntimeSnapshot>(resolve => { release = resolve })
  vi.mocked(api.sessions.snapshot).mockReturnValueOnce(pending)
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: Date.now() } } })
  try {
    retire(); release(snapshot)
    await vi.waitFor(() => expect(useAppStore.getState().sessions.map(session => session.id)).not.toContain(closed.id))
    await expectClosed()
  } finally { release(snapshot) }
})

it('an exact retired recovery result removes the original workface durably', async () => {
  vi.mocked(api.sessions.recover).mockResolvedValueOnce({ kind: 'retired', agentSessionId: closed.id, previousRun: closed.control.run, evidence: { kind: 'user-retired', observedAt: Date.now() } })
  await useAppStore.getState().recoverSession(closed.id)
  await expectClosed()
})

it('a late retired recovery reply cannot persist deletion of the same Session on a newer Run', async () => {
  let release!: (value: Awaited<ReturnType<typeof api.sessions.recover>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof api.sessions.recover>>>(resolve => { release = resolve })
  vi.mocked(api.sessions.recover).mockReturnValueOnce(pending)
  const recovery = useAppStore.getState().recoverSession(closed.id)
  const replacement = { ...closed, control: { ...closed.control, run: { runId: 'replacement-run' } } }
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === closed.id ? replacement : session) }))
  release({ kind: 'retired', agentSessionId: closed.id, previousRun: closed.control.run, evidence: { kind: 'user-retired', observedAt: Date.now() } })
  await recovery
  await useAppStore.getState().retryWorkbenchSave()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([originalTab.id, survivor.id])
  expect(useAppStore.getState().sessions.find(session => session.id === closed.id)?.control).toEqual(replacement.control)
  expect(useAppStore.getState().tabs[originalTab.id]?.regions['closed-region']).toEqual(originalTab.regions['closed-region'])
  expect(useAppStore.getState().agentComposerDrafts[closed.id]).toBe('Closed original draft')
  expect(useAppStore.getState().sessions.find(session => session.id === healthy.id)?.control).toEqual(healthy.control)
  expect((await owner.readForLayout())!.graph.tabs.map(tab => tab.tabId)).toEqual([originalTab.id, survivor.id])
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('retirement removes only its Region from a shared Tab and preserves the surviving original topology', async () => {
  const mixed = addWorkbenchRegion(survivor, 'healthy-region', 'down', { ...originalTab.regions['closed-region']!, regionId: 'closed-shared-region' })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [survivor.id]: mixed } }))
  await useAppStore.getState().retryWorkbenchSave()
  retire()
  await expectClosed({ activeRegionId: 'healthy-region', root: { type: 'split', direction: 'horizontal', ratio: 2 / 3,
    first: { type: 'leaf', regionId: 'healthy-region' }, second: { type: 'leaf', regionId: 'file-region' } } })
})

it('wrong Run, wrong Host, empty inventory and unknown recovery retain the original workfaces', async () => {
  useAppStore.getState().applyEvent(removed('another-run'))
  useAppStore.getState().applyEvent(removed(closed.control.run.runId, 'another-host'))
  vi.mocked(api.sessions.recover).mockResolvedValueOnce({ kind: 'unavailable', agentSessionId: closed.id, previousRun: closed.control.run, reason: 'unknown-session', evidence: { kind: 'unknown-session' } })
  await useAppStore.getState().recoverSession(closed.id)
  snapshot = { sessions: [], timelines: {}, recoveryCandidates: [] }
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: Date.now() } } })
  await useAppStore.getState().retryWorkbenchSave()
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([originalTab.id, survivor.id])
  expect((await owner.readForLayout())!.graph.tabs.map(tab => tab.tabId)).toEqual([originalTab.id, survivor.id])
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('Keep Session & Close remains closed through membership refresh and explicit reopening preserves its Run', async () => {
  expect(await useAppStore.getState().closeTab('workspace', 'group', originalTab.id, { keepAgentSessions: true })).toBe(true)
  const refreshed = { ...closed, updatedAt: closed.updatedAt + 1 }
  snapshot = { ...snapshot, sessions: [refreshed, healthy] }
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: Date.now() } } })
  await vi.waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === closed.id)?.updatedAt).toBe(refreshed.updatedAt))
  await expectClosed()
  expect(useAppStore.getState().sessions.find(session => session.id === closed.id)?.control).toEqual(closed.control)
  expect(useAppStore.getState().selectSession(closed.id)).toBe(true)
  await useAppStore.getState().retryWorkbenchSave()
  const regions = (await owner.readForLayout())!.graph.regions.filter(region => region.agentSessionId === closed.id)
  expect(regions).toHaveLength(1)
  expect(regions[0]!.runId).toBe(closed.control.run.runId)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})
