import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { AGENTMUX_DISPLAY_LABEL_RESOURCE, displayLabel, displayLabelDocument, type AgentMuxNameContext,
  type AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph'
import { acknowledgedNameProjection } from '../src/renderer/src/lib/name-authority'
import { DesktopSpatialPersistence, reconcileSpatialGraphs } from '../src/renderer/src/lib/desktop-spatial-state'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
// The registered vertical gate consumes the existing named-owner suite as well.
import './name-change-owners.test'
// The already-installed build tool belongs to Core; Desktop does not acquire a
// product dependency merely for this isolated source-counterfactual proof.
const { build } = createRequire(resolve(import.meta.dirname, '../../../packages/core/package.json'))('esbuild') as typeof import('../../../packages/core/node_modules/esbuild')

const directoryFault = vi.hoisted(() => ({ directory: null as string | null, operationId: null as string | null, calls: 0, failAt: 1,
  beforeFailure: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]) !== directoryFault.directory || args[1] !== 'r') return handle
    return new Proxy(handle, { get(object, key) {
      if (key === 'sync') return async () => {
        // The joined Desktop may flush an unrelated layout before renaming.
        // Fail only after this exact name record replaced its owning document;
        // the previous-document sync and other writes cannot consume the fault.
        const state = JSON.parse(await actual.readFile(join(directoryFault.directory!, 'spatial.json'), 'utf8'))
        const record = state.graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE]?.records?.at(-1)
        if (!directoryFault.operationId || record?.id !== directoryFault.operationId) { await object.sync(); return }
        if (++directoryFault.calls === directoryFault.failAt) {
          await directoryFault.beforeFailure?.()
          throw new Error('Private post-replace directory sync failed')
        }
        await object.sync()
      }
      const value = Reflect.get(object, key, object); return typeof value === 'function' ? value.bind(object) : value
    } })
  } }
})

const directories: string[] = []
const initialAppState = useAppStore.getState(), disposeClients: (() => void)[] = []
afterEach(async () => { directoryFault.directory = null; directoryFault.operationId = null; directoryFault.calls = 0
  for (const dispose of disposeClients.splice(0)) dispose(); vi.restoreAllMocks(); useAppStore.setState(initialAppState, true)
  directoryFault.beforeFailure = null
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const ui: AgentMuxNameContext = { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
  entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } }
const launcher: AgentMuxNameContext = { ...ui, source: 'launch' }
const target = { kind: 'agent-session', id: 'private-original-session' }
function graph(): AgentMuxSpatialGraph {
  return { spaces: [], zones: [], bindings: [], layouts: {},
    tabs: [{ tabId: 'private-tab', workspaceId: 'private-workspace', zoneId: null, name: null, regionIds: ['private-region'] }],
    regions: [{ regionId: 'private-region', tabId: 'private-tab', kind: 'agent', agentSessionId: target.id,
      runId: 'private-original-run', execution: { hostId: 'private-host', cwd: _hygiene_fixturePath("private-execution") } }],
    tabLayouts: { 'private-tab': { root: { type: 'leaf', regionId: 'private-region' }, activeRegionId: 'private-region' } },
    resources: { 'region:private-region': { unsentDraft: 'keep this thought' } } }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-name-authority-')); directories.push(directory)
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  await owner.commit({ expectedRevision: 0, graph: graph() })
  return owner
}
function change(owner: AgentMuxSpatialStateStore, operationId: string, value: string | null, revision: number,
  source: 'manual' | 'launch' | 'derived' = 'manual') {
  return owner.mutateDisplayLabel({ target, operationId, value, expectedNameRevision: revision, source }, source === 'manual' ? ui : launcher)
}
async function appFixture(startup?: { observation: 'watch' | 'ack'; cleared?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-name-client-')); directories.push(directory)
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const config: AppConfig = { version: 9, hosts: [{ id: 'private-host', kind: 'local', label: 'Private' }],
    workspaces: [{ id: 'private-workspace', name: 'Private project', hostId: 'private-host', path: directory, kind: 'folder' }],
    executors: { private: { label: 'Private', providerId: 'codex', command: '/bin/cat', args: [], env: {}, injectAgentMuxGuide: false } },
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
      viewport: true, saveBookmark: true, more: true } } }
  const launcher = createWorkbenchTab('private-tab', { regionId: initialWorkbenchRegionId('private-tab'), kind: 'launcher', workspaceId: 'private-workspace' })
  const work = { config, sessions: [], tabs: { [launcher.id]: launcher }, layouts: { 'private-workspace': createWorkspaceLayout('private-group', [launcher.id]) },
    spaceZoneBindings: {}, spatialRequests: {} }
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(work, []) })
  if (startup?.cleared) await owner.mutateDisplayLabel({ target: { kind: 'agent-session', id: 'legacy-session' },
    operationId: 'original-manual-clear', value: null, source: 'manual', expectedNameRevision: 0 }, ui)
  const baseline = startup ? await owner.readForLayout() : null
  let observed: Awaited<ReturnType<typeof owner.readForLayout>> = null
  if (startup) {
    await owner.retainDisplayLabels([{ target: { kind: 'agent-session', id: 'unrelated-session' }, value: 'Unrelated saved name' }])
    observed = startup.observation === 'ack'
      ? (await owner.mutateDisplayLabel({ target: { kind: 'agent-session', id: 'unrelated-session' },
        operationId: 'unrelated-name-ack', value: 'Unrelated new name', source: 'manual', expectedNameRevision: 1 }, ui)).state
      : await owner.readForLayout()
  }
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  if (startup) vi.mocked(api.spatial.read).mockResolvedValueOnce(startup.observation === 'ack' ? await owner.readForLayout() : baseline)
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => {
    if (directoryFault.directory === directory) directoryFault.operationId = input.operationId
    return owner.mutateDisplayLabel(input, { ...ui, source: input.source === 'manual' ? 'desktop-ui' : input.source })
  })
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'confirmNameCommit').mockImplementation(operationId => owner.confirmNameCommit(operationId))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => {
    // A commit between the first read and subscription, or its same-revision
    // producer ACK, can arrive while initialize awaits bootstrap.
    if (observed) queueMicrotask(() => listener(observed!))
    return owner.subscribe(listener)
  })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: [], recoveryCandidates: [] })
  useAppStore.setState({ ...work, activeWorkspaceId: 'private-workspace', agentNames: { 'legacy-session': 'Preserved original alias' },
    surveyExplorationNames: startup ? { 'legacy-zone': 'Original exploration' } : {},
    nameLabels: {}, nameAuthorityRevision: 0, loading: false, error: null,
    restoredWorkbench: { tabs: startup ? { [launcher.id]: { ...launcher, name: 'Original saved tab' } } : work.tabs, layouts: work.layouts } })
  disposeClients.push(await useAppStore.getState().initialize())
  // Finish the real client's initial topology save before arming a name fault
  // or capturing the revision used by the watch-before-ACK ordering assertion.
  await useAppStore.getState().retryWorkbenchSave()
  return { owner, launcher, directory }
}
describe('name authority at its durable boundary and real projection consumers', () => {
  it.each(['watch', 'ack'] as const)('retains hydrated names before the startup %s replaces their projection', async observation => {
    const { owner, launcher } = await appFixture({ observation })
    const state = useAppStore.getState(), saved = (await owner.read())!
    expect(state.agentNames['legacy-session']).toBe('Preserved original alias')
    expect(state.surveyExplorationNames['legacy-zone']).toBe('Original exploration')
    expect(state.tabs[launcher.id]?.name).toBe('Original saved tab')
    expect(displayLabel(saved.graph, { kind: 'agent-session', id: 'legacy-session' })).toMatchObject({ value: 'Preserved original alias', source: 'retained' })
    expect(displayLabel(saved.graph, { kind: 'zone', id: 'legacy-zone' })?.value).toBe('Original exploration')
    expect(displayLabel(saved.graph, { kind: 'tab', id: launcher.id })?.value).toBe('Original saved tab')
    expect(saved.graph.tabs.find(tab => tab.tabId === launcher.id)?.name).toBe('Original saved tab')
    expect(displayLabel(saved.graph, { kind: 'agent-session', id: 'unrelated-session' })?.value).toBe(observation === 'ack' ? 'Unrelated new name' : 'Unrelated saved name')
    expect(useAppStore.persist.getOptions().partialize!(state)).not.toHaveProperty('agentNames')
  })
  it('preserves an authoritative manual clear over the captured old startup alias', async () => {
    const { owner } = await appFixture({ observation: 'watch', cleared: true })
    expect(useAppStore.getState().agentNames['legacy-session']).toBeUndefined()
    expect(displayLabel((await owner.read())!.graph, { kind: 'agent-session', id: 'legacy-session' })).toMatchObject({
      value: null, source: 'manual', nameRevision: 1, operationId: 'original-manual-clear' })
    expect((await owner.queryNameChanges({ target: { kind: 'agent-session', id: 'legacy-session' } })).records.map(record => record.id)).toEqual(['original-manual-clear'])
  })
  it('retains the existing durable Tab name instead of an older client handoff', async () => {
    const owner = await fixture(), original = (await owner.read())!
    original.graph.tabs[0]!.name = 'Original durable tab'
    const other = new AgentMuxSpatialStateStore(join(await mkdtemp(join(tmpdir(), 'amux-original-tab-')), 'spatial.json'))
    directories.push(resolve(other.path, '..'))
    await other.commit({ expectedRevision: 0, graph: original.graph })
    const saved = await other.retainDisplayLabels([{ target: { kind: 'tab', id: 'private-tab' }, value: 'Stale client tab' }])
    expect(saved.graph.tabs[0]?.name).toBe('Original durable tab')
    expect(displayLabel(saved.graph, { kind: 'tab', id: 'private-tab' })?.value).toBe('Original durable tab')
    expect((await other.queryNameChanges({ target: { kind: 'tab', id: 'private-tab' } })).records).toEqual([])
    const layout = structuredClone(saved.graph)
    layout.resources['region:private-region'] = { unsentDraft: 'Later layout save' }
    await other.commit({ expectedRevision: saved.revision, graph: layout })
    const server = new AgentMuxControlServer({ spatialState: other, socketPath: other.path + '.sock' })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const inspected = await rpc.call('space.inspect', { target: { tabId: 'private-tab' } })
      expect(inspected.catalog.tabs.find(tab => tab.tabId === 'private-tab')?.name).toBe('Original durable tab')
    } finally { await rpc.dispose(); await server.stop() }
  })
  it('protects later manual set and clear against delayed launch and derived writers without touching the original Run', async () => {
    const owner = await fixture(), original = (await owner.read())!.graph.regions
    const manual = await change(owner, 'manual-set', 'Chosen name', 0)
    expect(manual.applied).toBe(true)
    const late = await change(owner, 'delayed-launch', 'Launch name', 0, 'launch')
    expect(late.applied).toBe(false); expect(late.label?.value).toBe('Chosen name')
    const clear = await change(owner, 'manual-clear', null, manual.label!.nameRevision)
    expect(clear.label).toMatchObject({ source: 'manual', value: null, nameRevision: 2 })
    expect((await change(owner, 'later-derived', 'Default name', 2, 'derived')).applied).toBe(false)
    expect((await change(owner, 'old-launch-after-clear', 'Launch name', 0, 'launch')).applied).toBe(false)
    const reopened = new AgentMuxSpatialStateStore(owner.path)
    expect(displayLabel((await reopened.read())!.graph, target)).toEqual(clear.label)
    expect((await reopened.read())!.graph.regions).toEqual(original)
    const page = await reopened.queryNameChanges({ target, limit: 2 })
    expect(page.records.map(record => record.id)).toEqual(['manual-set', 'delayed-launch'])
    expect(page.nextCursor).toBe('delayed-launch')
    expect((await reopened.queryNameChanges({ target, afterId: page.nextCursor!, limit: 100 })).records).toHaveLength(3)
  })
  it('gives only one concurrent editor the exact name revision and does not replay a completed earlier operation', async () => {
    const owner = await fixture(), other = new AgentMuxSpatialStateStore(owner.path)
    const outcomes = await Promise.all([change(owner, 'editor-a', 'A', 0), change(other, 'editor-b', 'B', 0)])
    expect(outcomes.map(result => result.applied).sort()).toEqual([false, true])
    const winner = outcomes.find(result => result.applied)!
    await change(owner, 'later-editor', 'Later', winner.label!.nameRevision)
    await change(owner, winner.record.id, winner.record.requested, 0)
    expect(displayLabel((await owner.read())!.graph, target)?.value).toBe('Later')
    const records = await owner.queryNameChanges({ target, limit: 100 })
    expect(records.records.filter(record => record.id === winner.record.id)).toHaveLength(1)
  })
  it('does not let a lower derived writer replace an acknowledged launch name at the matching revision', async () => {
    const owner = await fixture()
    expect((await change(owner, 'initial-launch', 'Launch choice', 0, 'launch')).applied).toBe(true)
    expect((await change(owner, 'lower-derived', 'Derived choice', 1, 'derived')).applied).toBe(false)
    expect(displayLabel((await owner.read())!.graph, target)?.value).toBe('Launch choice')
  })
  it('keeps unknown original aliases but cannot turn a layout commit into a name writer or forge records', async () => {
    const owner = await fixture()
    const retained = await owner.retainDisplayLabels([{ target, value: 'Original alias' }])
    expect(displayLabel(retained.graph, target)?.source).toBe('retained')
    expect((await change(owner, 'default-namer', 'Default', 1, 'launch')).applied).toBe(false)
    const layout = await owner.readForLayout()
    expect(displayLabelDocument(layout!.graph)).toMatchObject({ history: 'query-only', records: [] })
    const forged = structuredClone(layout!.graph)
    const document = displayLabelDocument(forged)
    Object.values(document.labels)[0]!.value = 'Forged'
    forged.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE] = document as never
    await expect(owner.commit({ expectedRevision: layout!.revision, graph: forged })).rejects.toMatchObject({ code: 'NAME_AUTHORITY_CONFLICT' })
    const saved = await owner.commit({ expectedRevision: layout!.revision, graph: layout!.graph })
    expect(displayLabelDocument(saved.graph).history).toBe('query-only')
    expect((await owner.queryNameChanges({ target })).records).toHaveLength(1)
    expect(displayLabel((await owner.read())!.graph, target)?.value).toBe('Original alias')
  })
  it('records external-owner intent/results without changing its name and exposes pending after a process boundary', async () => {
    const owner = await fixture(), external = { kind: 'toolkit', id: 'private-tool' }
    const input = { operationId: 'private-tool-edit', target: external, before: 'Old tool', requested: 'New tool', context: ui }
    const intent = await owner.beginNameChange(input)
    expect(intent).toMatchObject({ status: 'pending', replayed: false, actual: null, before: 'Old tool' })
    const reopened = new AgentMuxSpatialStateStore(owner.path)
    expect((await reopened.beginNameChange(input)).replayed).toBe(true)
    expect((await reopened.queryNameChanges({ target: external })).records[0]).toMatchObject({ status: 'pending' })
    const result = await reopened.settleNameChange({ id: intent.id, status: 'unknown', reason: 'Owner result is unconfirmed.' })
    expect(result.context).toEqual(ui); expect(result.before).toBe('Old tool'); expect(result.requested).toBe('New tool'); expect(result.actual).toBeNull()
    expect(displayLabel((await reopened.read())!.graph, external)).toBeNull()
    expect(JSON.parse(await readFile(owner.path, 'utf8')).graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE].records[0]).not.toHaveProperty('replayed')
  })
  it('cannot reuse a removed named Tab identity through two actual public graph commits', async () => {
    const owner = await fixture(), server = new AgentMuxControlServer({ spatialState: owner, socketPath: owner.path + '.sock' })
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const named = await rpc.call('space.rename', { tabId: 'private-tab', name: 'Original choice', expectedNameRevision: 0 })
      expect(named.nameRevision).toBe(1)
      const state = (await rpc.call('space.state', {})).state!
      const removed = structuredClone(state.graph)
      removed.tabs = []; removed.regions = []; removed.tabLayouts = {}
      const deleted = (await rpc.call('space.commit', { graph: removed, expectedRevision: state.revision, allowEntityRemoval: true })).state
      const reused = structuredClone(state.graph); reused.tabs[0]!.name = 'Overwritten through reused ID'
      await expect(rpc.call('space.commit', { graph: reused, expectedRevision: deleted.revision })).rejects.toMatchObject({ code: 'NAME_AUTHORITY_CONFLICT' })
      const records = await rpc.call('name.history', { target: { kind: 'tab', id: 'private-tab' } })
      expect(records.records).toHaveLength(1)
      expect(records.records[0]).toMatchObject({ before: null, requested: 'Original choice', actual: 'Original choice',
        context: { entryPoint: 'space.rename', transport: 'unix', actor: { kind: 'device', id: `local-user:${process.getuid?.() ?? 'current'}`, verified: true } } })
      await expect(rpc.call('space.rename', { tabId: 'private-tab', name: 'Self-reported actor', expectedNameRevision: 1,
        actor: { kind: 'user', id: 'untrusted-human', verified: true } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect(displayLabel((await owner.read())!.graph, { kind: 'tab', id: 'private-tab' })?.value).toBe('Original choice')
    } finally { await rpc.dispose(); await server.stop() }
  })
  it('retains an unclaimed legacy Tab name across actual public deletion and refuses reused-ID name forgery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-legacy-name-')); directories.push(directory)
    const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json')), original = graph()
    original.tabs[0]!.name = 'Legacy observed choice'
    await owner.commit({ expectedRevision: 0, graph: original })
    const server = new AgentMuxControlServer({ spatialState: owner, socketPath: owner.path + '.sock' }); await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const state = (await rpc.call('space.state', {})).state!, removed = structuredClone(state.graph)
      expect(removed.resources).not.toHaveProperty(AGENTMUX_DISPLAY_LABEL_RESOURCE)
      removed.tabs = []; removed.regions = []; removed.tabLayouts = {}
      const deleted = (await rpc.call('space.commit', { graph: removed, expectedRevision: state.revision, allowEntityRemoval: true })).state
      expect(displayLabel(deleted.graph, { kind: 'tab', id: 'private-tab' })).toMatchObject({ value: 'Legacy observed choice', source: 'retained', nameRevision: 1 })
      const reused = structuredClone(deleted.graph)
      reused.tabs = structuredClone(state.graph.tabs); reused.regions = structuredClone(state.graph.regions); reused.tabLayouts = structuredClone(state.graph.tabLayouts)
      reused.tabs[0]!.name = 'Forged after deleting legacy identity'
      await expect(rpc.call('space.commit', { graph: reused, expectedRevision: deleted.revision })).rejects.toMatchObject({ code: 'NAME_AUTHORITY_CONFLICT' })
      expect((await rpc.call('name.history', { target: { kind: 'tab', id: 'private-tab' } })).records).toEqual([])
    } finally { await rpc.dispose(); await server.stop() }
  })
  it('keeps fresh name projections and unrelated local edits when old layout/hydration consumers finish late', async () => {
    const owner = await fixture(), baseline = (await owner.readForLayout())!
    const local = structuredClone(baseline.graph)
    local.resources['region:private-region'] = { unsentDraft: 'later thought' }
    const tabTarget = { kind: 'tab', id: 'private-tab' }
    const named = await owner.mutateDisplayLabel({ target: tabTarget, operationId: 'tab-edit', value: 'New tab', source: 'manual', expectedNameRevision: 0 }, ui)
    const namedAgent = await change(owner, 'agent-edit', 'New agent', 0)
    const merged = reconcileSpatialGraphs(baseline.graph, local, namedAgent.state.graph)
    expect(merged.tabs[0]!.name).toBe('New tab')
    expect(merged.resources['region:private-region']).toEqual({ unsentDraft: 'later thought' })
    const projection = acknowledgedNameProjection(namedAgent.state, 0)!
    expect(projection.agentNames[target.id]).toBe('New agent')
    expect(acknowledgedNameProjection(named.state, projection.nameAuthorityRevision)).toBeNull()
    await owner.commit({ expectedRevision: namedAgent.state.revision, graph: merged })
    expect((await owner.queryNameChanges()).records).toHaveLength(2)
  })
  it('renames registered targets despite unrelated layout failure and keeps new targets behind registration', async () => {
    const { owner } = await appFixture()
    const regions = useAppStore.getState().tabs['private-tab']!.regions
    const warning = 'Unrelated layout unavailable'
    vi.spyOn(DesktopSpatialPersistence.prototype, 'flush').mockRejectedValue(new Error(warning))
    useAppStore.setState({ workbenchSaveWarning: warning })
    expect(await useAppStore.getState().renameTab('private-tab', 'Chosen tab', 0)).toBe(true)
    expect(await useAppStore.getState().renameAgent('legacy-session', 'Chosen Agent', 1)).toBe(true)
    expect(displayLabel((await owner.read())!.graph, { kind: 'tab', id: 'private-tab' })?.value).toBe('Chosen tab')
    expect(displayLabel((await owner.read())!.graph, { kind: 'agent-session', id: 'legacy-session' })?.value).toBe('Chosen Agent')
    expect(useAppStore.getState().tabs['private-tab']!.regions).toBe(regions)
    expect(useAppStore.getState().workbenchSaveWarning).toBe(warning)
    const newTab = createWorkbenchTab('unregistered-tab', { regionId: initialWorkbenchRegionId('unregistered-tab'),
      kind: 'launcher', workspaceId: 'private-workspace' })
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [newTab.id]: newTab } }))
    const writes = vi.mocked(api.spatial.renameLabel).mock.calls.length
    expect(await useAppStore.getState().renameTab(newTab.id, 'Unregistered choice', 0)).toBe(false)
    expect(vi.mocked(api.spatial.renameLabel).mock.calls).toHaveLength(writes)
    expect((await owner.read())!.graph.tabs.some(tab => tab.tabId === newTab.id)).toBe(false)
    expect(useAppStore.getState().nameEditFailure?.message).toContain(warning)
  })
  it('uses the actual Desktop Store for durable manual clear, stale hydration, failed save and a deliberate retry', async () => {
    const { owner } = await appFixture()
    expect(useAppStore.getState().agentNames['legacy-session']).toBe('Preserved original alias')
    expect(displayLabel((await owner.read())!.graph, { kind: 'agent-session', id: 'legacy-session' })?.source).toBe('retained')
    expect(await useAppStore.getState().renameAgent('legacy-session', 'My edit', 1)).toBe(true)
    expect(await useAppStore.getState().renameAgent('legacy-session', null, 2)).toBe(true)
    const acknowledged = useAppStore.getState()
    const merged = useAppStore.persist.getOptions().merge!({ agentNames: { 'legacy-session': 'Late old Chromium name' },
      surveyExplorationNames: { stale: 'Late old exploration' } }, acknowledged)
    expect(merged.agentNames['legacy-session']).toBeUndefined(); expect(merged.nameLabels).toEqual(acknowledged.nameLabels)
    expect(useAppStore.persist.getOptions().partialize!(acknowledged)).not.toHaveProperty('agentNames')
    const before = (await owner.read())!, originalSurface = acknowledged.tabs['private-tab']!.regions
    const rename = vi.spyOn(api.spatial, 'renameLabel').mockRejectedValueOnce(new Error('Private disk unavailable'))
    expect(await useAppStore.getState().renameAgent('legacy-session', 'Keep this draft', 3)).toBe(false)
    const failed = useAppStore.getState().nameEditFailure!
    expect(failed.message).toContain('Private disk unavailable')
    expect((await owner.read())!.revision).toBe(before.revision)
    expect(useAppStore.getState().tabs['private-tab']!.regions).toBe(originalSurface)
    await useAppStore.getState().retryWorkbenchSave()
    expect(useAppStore.getState().nameEditFailure).toEqual(failed)
    await useAppStore.getState().reviewNameEdit()
    expect(useAppStore.getState().nameEditFailure).toMatchObject({ operationId: failed.operationId,
      message: expect.stringContaining('Reading does not confirm the earlier edit') })
    rename.mockImplementation(input => owner.mutateDisplayLabel(input, ui))
    expect(await useAppStore.getState().renameAgent('legacy-session', 'Keep this draft', 3)).toBe(true)
    expect(useAppStore.getState().agentNames['legacy-session']).toBe('Keep this draft')
    expect(useAppStore.getState().nameEditFailure).toBeNull()
    expect((await owner.queryNameChanges({ target: { kind: 'agent-session', id: 'legacy-session' } })).records.map(row => row.requested)).toEqual(['My edit', null, 'Keep this draft'])
  })
  it('keeps a manual clear when the actual asynchronous launch returns its captured default names late', async () => {
    const { owner, launcher, directory } = await appFixture()
    let release!: (result: Awaited<ReturnType<typeof api.sessions.launchAgent>>) => void
    let captured!: Parameters<typeof api.sessions.launchAgent>[0]
    vi.spyOn(api.sessions, 'launchAgent').mockImplementation(input => { captured = input; return new Promise(done => { release = done }) })
    const launching = useAppStore.getState().launchAgent('private', '', 'private-group',
      { tabId: launcher.id, regionId: launcher.layout.activeRegionId }, undefined, { agentName: 'Captured Agent default', tabName: 'Captured Tab default' })
    await vi.waitFor(() => expect(captured?.agentSessionId).toBeTruthy())
    expect(await useAppStore.getState().renameAgent(captured.agentSessionId!, null, 0)).toBe(true)
    expect(await useAppStore.getState().renameTab(launcher.id, null, 0)).toBe(true)
    const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: captured.agentSessionId!, kind: 'agent', providerId: 'codex', executorId: 'private',
      hostId: 'private-host', workspacePath: directory, label: 'Private', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
      capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      control: { kind: 'agent', hostId: 'private-host', agentSessionId: captured.agentSessionId!, run: { runId: 'private-created-run' } } }
    release({ created: agentCreationFixture(session), projectionFailures: [], session, timeline: { agentSessionId: session.id, revision: 0, items: [] } })
    await launching
    expect(useAppStore.getState().agentNames[session.id]).toBeUndefined()
    expect(useAppStore.getState().tabs[launcher.id]!.name).toBeUndefined()
    expect(useAppStore.getState().tabs[launcher.id]!.regions[launcher.layout.activeRegionId]).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: session.id })
    expect(displayLabel((await owner.read())!.graph, { kind: 'agent-session', id: session.id })).toMatchObject({ value: null, source: 'manual', nameRevision: 1 })
    expect((await owner.queryNameChanges({ target: { kind: 'agent-session', id: session.id } })).records.at(-1)).toMatchObject({ requested: 'Captured Agent default', status: 'failed' })
    expect((await owner.queryNameChanges({ target: { kind: 'tab', id: launcher.id } })).records.at(-1)).toMatchObject({ requested: 'Captured Tab default', status: 'failed' })
    expect(useAppStore.getState().nameEditFailure).toBeNull()
  })
  it('keeps the applied name and an independent warning after a real file replacement loses its directory ACK', async () => {
    const { owner, directory } = await appFixture(), originalRegions = useAppStore.getState().tabs['private-tab']!.regions
    directoryFault.directory = directory; directoryFault.calls = 0
    expect(await useAppStore.getState().renameAgent('legacy-session', 'Applied but unconfirmed', 1)).toBe(false)
    expect(directoryFault.calls).toBe(1)
    const pending = useAppStore.getState().nameSaveUnconfirmed!
    expect(pending).toMatchObject({ target: { kind: 'agent-session', id: 'legacy-session' }, message: expect.stringContaining('disk confirmation failed') })
    expect(useAppStore.getState().agentNames['legacy-session']).toBe('Applied but unconfirmed')
    expect(useAppStore.getState().tabs['private-tab']!.regions).toBe(originalRegions)
    const record = (await owner.queryNameChanges({ target: pending.target })).records.at(-1)!
    expect(record).toMatchObject({ id: pending.operationId, status: 'applied', actual: 'Applied but unconfirmed', ownerRevision: 2 })
    // An unrelated Chromium/layout flush must not sign the name confirmation.
    await useAppStore.getState().retryWorkbenchSave()
    expect(useAppStore.getState().nameSaveUnconfirmed).toEqual(pending)
    directoryFault.directory = null
    await owner.mutateDisplayLabel({ operationId: 'newer-client-edit', target: pending.target, value: 'Newer current name',
      source: 'manual', expectedNameRevision: 2 }, ui)
    await useAppStore.getState().confirmNameSave()
    expect(useAppStore.getState().nameSaveUnconfirmed).toBeNull()
    expect(useAppStore.getState().agentNames['legacy-session']).toBe('Newer current name')
    expect((await owner.queryNameChanges({ target: pending.target })).records.map(row => row.id)).toEqual([pending.operationId, 'newer-client-edit'])
    directoryFault.directory = directory; directoryFault.calls = 0
    let refused!: Awaited<ReturnType<typeof owner.mutateDisplayLabel>>
    vi.spyOn(api.spatial, 'renameLabel').mockImplementation(async input => {
      directoryFault.operationId = input.operationId
      refused = await owner.mutateDisplayLabel(input, ui); return refused
    })
    expect(await useAppStore.getState().renameAgent('legacy-session', 'Must not appear', 1)).toBe(false)
    expect(refused).toMatchObject({ applied: false, diskDurability: 'unconfirmed', label: { value: 'Newer current name' },
      record: { status: 'failed', actual: 'Newer current name' }, issue: expect.stringContaining('was refused; its record was replaced') })
    expect(useAppStore.getState().agentNames['legacy-session']).toBe('Newer current name')
    expect(useAppStore.getState().nameEditFailure?.message).toContain('was refused; its record was replaced')
    expect(useAppStore.getState().nameSaveUnconfirmed).toBeNull()
  })
  it('delivers the real public partial ACK after a same-revision watch read, and never promotes replay/read to disk confirmation', async () => {
    const { owner, directory } = await appFixture()
    const baseline = (await owner.read())!, frames: import('../../../packages/core/src/spatial-graph').AgentMuxSpatialState[] = []
    disposeClients.push(owner.subscribe(state => frames.push(state)))
    const server = new AgentMuxControlServer({ spatialState: owner, socketPath: owner.path + '.sock' }); await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      directoryFault.directory = directory; directoryFault.calls = 0
      directoryFault.beforeFailure = async () => {
        await vi.waitFor(() => expect(frames.some(state => state.revision === baseline.revision + 1 && !state.nameCommit)).toBe(true))
      }
      const params = { operationId: 'public-unconfirmed-name', tabId: 'private-tab', name: 'Public applied name', expectedNameRevision: 0 }
      directoryFault.operationId = params.operationId
      const partial = await rpc.call('space.rename', params)
      expect(directoryFault.calls).toBe(1)
      expect(partial).toMatchObject({ outcome: 'partial', override: 'Public applied name', nameRevision: 1,
        save: { diskDurability: 'unconfirmed' }, record: { id: params.operationId, status: 'applied', actual: 'Public applied name' } })
      expect(frames.filter(state => state.revision === baseline.revision + 1).map(state => state.nameCommit?.diskDurability ?? 'read')).toEqual(['read', 'unconfirmed'])
      expect(useAppStore.getState().nameSaveUnconfirmed?.operationId).toBe(params.operationId)
      expect(useAppStore.getState().tabs['private-tab']!.name).toBe('Public applied name')
      expect((await owner.readForLayout())!.nameCommit).toBeUndefined()
      expect(JSON.parse(await readFile(owner.path, 'utf8'))).not.toHaveProperty('nameCommit')
      directoryFault.directory = null; directoryFault.beforeFailure = null
      const replay = await rpc.call('space.rename', params)
      expect(replay).toMatchObject({ changed: false, override: 'Public applied name', save: { diskDurability: 'unconfirmed' } })
      expect((await owner.read())!.revision).toBe(baseline.revision + 1)
      const history = await rpc.call('name.history', { target: { kind: 'tab', id: params.tabId } })
      expect(history).toMatchObject({ diskAcknowledgement: 'not-observed', records: [{ id: params.operationId, status: 'applied' }] })
      await rpc.call('space.rename', { operationId: 'later-public-edit', tabId: params.tabId, name: 'Later current name', expectedNameRevision: 1 })
      const confirmed = await rpc.call('name.confirm', { operationId: params.operationId })
      expect(confirmed.state.nameCommit).toMatchObject({ operationId: params.operationId, diskDurability: 'confirmed' })
      expect(useAppStore.getState().nameSaveUnconfirmed).toBeNull()
      expect(useAppStore.getState().tabs['private-tab']!.name).toBe('Later current name')
      expect((await rpc.call('name.history', { target: { kind: 'tab', id: params.tabId } })).records).toHaveLength(2)
    } finally { await rpc.dispose(); await server.stop() }
  })
  it('loads each necessary owner/rebase counterfactual and requires Assertion RED then exact-source GREEN', async () => {
    const root = resolve(import.meta.dirname, '../../..')
    const output = join(root, ".local/state/session-status-diagnosis-fixture/name-implementation")
    await mkdir(output, { recursive: true })
    await symlink(join(root, 'packages/core/node_modules'), join(output, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
    const cases = [
      { id: 'manual-clear-priority', path: 'packages/core/src/spatial-state.ts',
        old: "const rejected = conflict || (input.source !== 'manual' && protectedIntent);", next: 'const rejected = conflict;' },
      { id: 'public-bulk-tab-authority', path: 'packages/core/src/spatial-state.ts',
        old: 'if ((owned && owned.value !== tab.name) || (old && old.name !== tab.name))', next: 'if (false)' },
      { id: 'renderer-name-rebase', path: 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
        old: "if (field === 'tabs' && current.has(id)) {", next: 'if (false) {' },
      { id: 'post-replace-unknown-ack', path: 'packages/core/src/spatial-state.ts',
        old: "if (!(error instanceof DurableWriteError) || error.path !== this.path || error.phase !== 'after-replace') throw error;", next: 'throw error;' },
      { id: 'public-name-revision-envelope', path: 'packages/core/src/space-control-parser.ts',
        old: "'tabId', 'name', 'expectedNameRevision', 'fromLocation'", next: "'tabId', 'name', 'fromLocation'" }
    ]
    const hashes: Record<string, string> = {}, rows: { id: string; red: boolean; restored: boolean; green: boolean; loaded: string[]; bridge?: string }[] = []
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const harness = `import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AgentMuxSpatialStateStore} from './packages/core/src/spatial-state.ts';
import {reconcileSpatialGraphs} from './apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts';
import {AgentMuxControlServer} from './packages/core/src/public-rpc-server.ts';import {connectAgentMuxRpc} from './packages/core/src/public-rpc-client.ts';
const dir=await mkdtemp(join(tmpdir(),'amux-name-mutant-'));const owner=new AgentMuxSpatialStateStore(join(dir,'state.json'));
try {await owner.commit({expectedRevision:0,graph:${JSON.stringify(graph())}});
const ctx=${JSON.stringify(ui)},target=${JSON.stringify(target)};
await owner.mutateDisplayLabel({operationId:'clear',target,value:null,source:'manual',expectedNameRevision:0},ctx);
const late=await owner.mutateDisplayLabel({operationId:'late',target,value:'Default',source:'launch',expectedNameRevision:1},ctx);
assert.equal(late.applied,false,'manual clear must remain authoritative');
const before=await owner.readForLayout(),local=structuredClone(before.graph);local.tabs[0].name='Old local edit';local.resources['region:private-region']={unsentDraft:'local thought'};
const named=await owner.mutateDisplayLabel({operationId:'tab-name',target:{kind:'tab',id:'private-tab'},value:'Current choice',source:'manual',expectedNameRevision:0},ctx);
const forged=structuredClone(named.state.graph);forged.tabs[0].name='Full graph bypass';let refused=false;
try {await owner.commit({expectedRevision:named.state.revision,graph:forged})} catch(e) {if(e.code==='NAME_AUTHORITY_CONFLICT')refused=true;else throw e}
assert.equal(refused,true,'ordinary public graph owner must reject label bypass');
let merged=null;try {merged=reconcileSpatialGraphs(before.graph,local,named.state.graph)} catch {}
assert.equal(merged?.tabs[0]?.name,'Current choice','Renderer rebase must keep current remote label');
assert.equal(merged?.resources['region:private-region']?.unsentDraft,'local thought');console.log('NAME_MUTATION_GREEN');
globalThis.__NAME_FAIL_PATH=owner.path;let partial=null;try {partial=await owner.mutateDisplayLabel({operationId:'partial',target,value:'Applied unknown',source:'manual',expectedNameRevision:1},ctx)}catch{}
assert.equal(partial?.applied,true,'post-replace application must remain visible');assert.equal(partial?.diskDurability,'unconfirmed','post-replace must not claim durable ACK');
delete globalThis.__NAME_FAIL_PATH;await owner.confirmNameCommit('partial');assert.equal((await owner.queryNameChanges({target})).records.at(-1).actual,'Applied unknown');
const server=new AgentMuxControlServer({spatialState:owner,socketPath:owner.path+'.sock'});await server.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});
try {let report=null;try {report=await rpc.call('space.rename',{tabId:'private-tab',name:'Actual public choice',expectedNameRevision:1})}catch{}
assert.equal(report?.override,'Actual public choice','public rename must admit the exact name revision through the real envelope');assert.equal(report.record.context.actor.kind,'device');}
finally{await rpc.dispose();await server.stop();}
}finally{await rm(dir,{recursive:true,force:true})}`
    const run = async (id: string, mutation?: typeof cases[number]) => {
      const file = join(output, id + '.mjs')
      const bundle = await build({ stdin: { contents: harness, resolveDir: root, sourcefile: 'name-authority-loaded-caller.mjs' },
        outfile: file, bundle: true, platform: 'node', format: 'esm', metafile: true, logLevel: 'silent',
        banner: { js: "import { createRequire as createNameProofRequire } from 'node:module'; const require = createNameProofRequire(import.meta.url);" },
        define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, plugins: [{ name: 'one-loaded-name-counterfactual', setup(plugin) {
          plugin.onLoad({ filter: /\.(?:ts|tsx)$/ }, async args => {
            if (args.path === resolve(root, 'packages/core/src/durable-write.ts')) {
              const source = await readFile(args.path, 'utf8'), anchor = 'await syncDirectory(dirname(path), options.requireDirectorySync === true)'
              expect(source.split(anchor)).toHaveLength(2)
              return { contents: source.replace(anchor, "if (globalThis.__NAME_FAIL_PATH === path) throw new Error('Private directory ACK failed'); " + anchor), loader: 'ts' }
            }
            if (!mutation) return
            if (args.path !== resolve(root, mutation.path)) return
            const source = await readFile(args.path, 'utf8'); expect(source.split(mutation.old)).toHaveLength(2)
            return { contents: source.replace(mutation.old, mutation.next), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
          })
        } }] })
      const loaded = Object.keys(bundle.metafile!.inputs)
      expect(loaded).toContain(mutation?.path ?? 'packages/core/src/spatial-state.ts')
      const execution = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 20000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS')) })
      const log = execution.stdout + execution.stderr
      await writeFile(join(output, id + '.log'), log); await writeFile(join(output, id + '-inputs.json'), JSON.stringify(bundle.metafile))
      return { loaded, green: execution.status === 0 && log.includes('NAME_MUTATION_GREEN'), red: execution.status !== 0 && log.includes('AssertionError') }
    }
    const prior = await readFile(join(output, 'label-proof.json'), 'utf8').then(value => JSON.parse(value)).catch(() => null)
    expect((await run('loaded-baseline')).green).toBe(true)
    for (const item of cases) {
      const original = await readFile(resolve(root, item.path), 'utf8'); hashes[item.path] = hash(original)
      const recorded = prior?.mutations?.find((row: typeof rows[number]) => row.id === item.id)
      // Existing counterfactuals are reused only at their identical production
      // bytes. The newly found public parser boundary always runs a fresh RED.
      if (item.id !== 'public-name-revision-envelope' && recorded?.red && recorded.restored && recorded.green &&
          recorded.loaded.includes(item.path) && prior.sourceHashes[item.path] === hashes[item.path]) {
        rows.push({ ...recorded, bridge: 'Exact production bytes match the previously executed loaded RED/restore/GREEN.' })
        continue
      }
      const red = await run(item.id + '-red', item); expect(red.red, item.id).toBe(true)
      const restored = hash(await readFile(resolve(root, item.path), 'utf8')) === hashes[item.path]; expect(restored).toBe(true)
      const green = await run(item.id + '-green'); expect(green.green, item.id).toBe(true)
      rows.push({ id: item.id, red: true, restored, green: true, loaded: red.loaded })
    }
    const callers = [
      ['packages/core/src/public-rpc-service.ts', 'this.spatial.mutateDisplayLabel'],
      ['apps/desktop/src/main/ipc.ts', 'spatialState.mutateDisplayLabel'],
      ['apps/desktop/src/renderer/src/store.ts', 'api.spatial.renameLabel'],
      ['apps/desktop/src/renderer/src/store.ts', 'acknowledgedNameProjection(saved'],
      ['apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'reconcileSpatialGraphs(']
    ]
    for (const [path, anchor] of callers) {
      const source = await readFile(resolve(root, path!), 'utf8'); expect(source).toContain(anchor!); hashes[path!] = hash(source)
    }
    expect(rows).toHaveLength(5); expect(callers.length).toBeGreaterThan(0)
    await writeFile(join(output, 'label-proof.json'), JSON.stringify({ passed: true, sourceHashes: hashes, mutations: rows, callers,
      userRuntimeTouched: false, cleanup: { exactSourceUntouched: true, privateFixturesRemoved: true },
      scope: 'Loaded isolated source bundles exercise actual Spatial owner and Renderer rebase; compiled public/UI callers and process restart are independently covered by GUI receipt.' }, null, 2))
  }, 60000)
})

it.each(['launch', 'derived'] as const)('actual launch keeps %s name provenance for both Session and Tab', async source => {
  const { owner, launcher, directory } = await appFixture()
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: input.agentSessionId!, kind: 'agent', providerId: 'codex', executorId: 'private',
      hostId: 'private-host', workspacePath: directory, label: 'Private', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running',
      status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
      capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
      control: { kind: 'agent', hostId: 'private-host', agentSessionId: input.agentSessionId!, run: { runId: 'private-created-run' } } }
    return { created: agentCreationFixture(session), projectionFailures: [], session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
  })
  await useAppStore.getState().launchAgent('private', '', 'private-group', { tabId: launcher.id, regionId: launcher.layout.activeRegionId }, undefined,
    { agentName: 'Report recovery · PMO', tabName: 'Report recovery · PMO', ...(source === 'derived' ? { nameSource: source } : {}) })
  const state = useAppStore.getState(), surface = state.tabs[launcher.id]!.regions[launcher.layout.activeRegionId]!
  expect(surface).toMatchObject({ kind: 'agent', phase: 'attached' })
  if (surface.kind !== 'agent') throw new Error('The actual launch must attach its original Agent')
  const saved = (await new AgentMuxSpatialStateStore(owner.path).readForLayout())!
  expect(displayLabel(saved.graph, { kind: 'agent-session', id: surface.sessionId })).toMatchObject({ value: 'Report recovery · PMO', source, nameRevision: 1 })
  expect(displayLabel(saved.graph, { kind: 'tab', id: launcher.id })).toMatchObject({ value: 'Report recovery · PMO', source, nameRevision: 1 })
  expect(state.agentNames[surface.sessionId]).toBe('Report recovery · PMO')
  expect(state.tabs[launcher.id]!.name).toBe('Report recovery · PMO')
  await prepareRendererUpdate()
})

it('a failed PMO preparation retains a readable launcher name in the original durable name owner', async () => {
  const { owner, directory } = await appFixture(), before = useAppStore.getState()
  const goal = { id: 'original-goal', title: 'Report recovery', description: 'Discuss the original outcome', status: 'backlog' as const,
    priority: 'normal' as const, projectId: null, projectName: null, sessionIds: [], createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), source: 'default-topic' as const }
  const launch = vi.fn(), prepare = vi.spyOn(api.scratch, 'ensureTopic').mockRejectedValue(new Error('Private preparation unavailable'))
  useAppStore.setState({ config: { ...before.config!, workspaces: [...before.config!.workspaces,
    { id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', path: join(directory, 'scratch'), hostId: 'private-host', kind: 'scratch' }] },
    demands: { [goal.id]: goal }, demandPmoTabIds: {}, launchAgent: launch })
  const tabId = await useAppStore.getState().requestDemandPmoTask(goal.id, 'grill')
  await vi.waitFor(async () => expect(displayLabel((await owner.readForLayout())!.graph, { kind: 'tab', id: tabId }))
    .toMatchObject({ value: 'Report recovery · PMO', source: 'derived', nameRevision: 1 }))
  const state = useAppStore.getState(), tab = state.tabs[tabId]!
  expect(tab.regions[tab.layout.activeRegionId]).toMatchObject({ kind: 'launcher' })
  expect(tab.name).toBe('Report recovery · PMO')
  expect(state.agentComposerDrafts[tab.layout.activeRegionId]).toBe('Clarify goal')
  expect(state.agentComposerNotes[tab.layout.activeRegionId]).toContain('collect the original delegated reports')
  expect(state.demands[goal.id]).toEqual(goal)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(launch).not.toHaveBeenCalled()
  await prepareRendererUpdate()
})
