// @vitest-environment happy-dom
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

const workspaceId = 'checkpoint-project'
const sessionId = 'original-checkpoint-agent'
const runId = 'original-checkpoint-run'
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private checkpoint fixture' }], executors: {},
  workspaces: [{ id: workspaceId, kind: 'folder', hostId: 'local', name: 'Private project', path: fixturePath('checkpoint/project') }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'private', hostId: 'local',
  workspacePath: config.workspaces[0]!.path, label: 'Original Agent', createdAt: 1, updatedAt: 1,
  processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: sessionId, run: { runId } }
}
const agentTab = (id: string) => createWorkbenchTab(id, {
  regionId: id + '-region', kind: 'agent', phase: 'attached', workspaceId, sessionId
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

let directory: string
let owner: AgentMuxSpatialStateStore
let store: typeof import('../src/renderer/src/store').useAppStore
let checkpoint: typeof import('../src/renderer/src/store').checkpointSpatialWorkbench
let api: typeof import('../src/renderer/src/lib/api').api
let disposers: Array<() => void>

beforeEach(async () => {
  vi.resetModules()
  disposers = []
  directory = await mkdtemp(join(tmpdir(), 'agentmux-spatial-checkpoint-'))
  owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const module = await import('../src/renderer/src/store')
  store = module.useAppStore
  checkpoint = module.checkpointSpatialWorkbench
  api = (await import('../src/renderer/src/lib/api')).api
  const tab = agentTab('original-tab')
  store.setState({ config, loading: true, sessions: [session], tabs: { [tab.id]: tab },
    layouts: { [workspaceId]: createWorkspaceLayout('original-group', [tab.id]) },
    agentComposerDrafts: { [sessionId]: 'Keep the original unsent text' }, restoredWorkbench: null,
    scratchTopicSnapshots: {}, spaceZoneBindings: {}, topicCategories: [], projectGroups: [], documents: {} })
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  vi.spyOn(store.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(store.getState(), 'detectExecutors').mockResolvedValue()
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})

afterEach(async () => {
  // Assertions above observe runtime saves before this cleanup-only checkpoint.
  // Let their existing writer finish before removing its private filesystem root.
  await checkpoint().catch(() => undefined)
  for (const dispose of disposers) dispose()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

async function initialize() {
  const dispose = await store.getState().initialize()
  disposers.push(dispose)
  expect(store.getState().loading).toBe(false)
  return dispose
}

function addWorkface(id: string) {
  const tab = agentTab(id)
  store.setState(state => ({ tabs: { ...state.tabs, [id]: tab },
    layouts: { ...state.layouts, [workspaceId]: createWorkspaceLayout('original-group', [...Object.keys(state.tabs), id]) } }))
}

async function expectDurableWorkface(id: string) {
  // Read the actual Core file via a distinct owner, without flushing or seeding it.
  const reader = new AgentMuxSpatialStateStore(owner.path)
  await vi.waitFor(async () => {
    const saved = (await reader.read())!
    expect(saved.graph.tabs.some(tab => tab.tabId === id)).toBe(true)
    expect(saved.graph.regions.find(region => region.regionId === id + '-region')).toMatchObject({
      agentSessionId: sessionId, runId, execution: { hostId: 'local', cwd: session.workspacePath }
    })
    expect(saved.graph.layouts[workspaceId]!.groups[0]!.tabOrder).toContain(id)
  })
  const disk = JSON.parse(await readFile(owner.path, 'utf8'))
  expect(disk.graph.tabs.some((tab: { tabId: string }) => tab.tabId === id)).toBe(true)
}

it.each(['before-observer', 'after-observer'] as const)('keeps spatial saving after initialization fails %s', async stage => {
  if (stage === 'before-observer') vi.mocked(api.config.get).mockRejectedValueOnce(new Error('Original config observation failed'))
  else vi.spyOn(api.ui, 'spatialLinksReady').mockImplementationOnce(() => { throw new Error('Original ready callback failed') })
  await initialize()
  expect(store.getState().error).toContain(stage === 'before-observer' ? 'Original config observation failed' : 'Original ready callback failed')
  addWorkface('after-startup-failure')
  await expectDurableWorkface('after-startup-failure')
  expect(store.getState().agentComposerDrafts[sessionId]).toBe('Keep the original unsent text')
  expect(store.getState().sessions.find(value => value.id === sessionId)?.control.run.runId).toBe(runId)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('a stale initialization disposer cannot detach the current spatial observer', async () => {
  const disposeOriginal = await initialize()
  await initialize()
  disposeOriginal()
  disposeOriginal()
  addWorkface('after-stale-disposal')
  await expectDurableWorkface('after-stale-disposal')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('checkpoint captures current workfaces even when the change observer was detached', async () => {
  const dispose = await initialize()
  dispose()
  addWorkface('checkpoint-only-tab')
  expect((await owner.read())!.graph.tabs.some(tab => tab.tabId === 'checkpoint-only-tab')).toBe(false)
  await checkpoint()
  await expectDurableWorkface('checkpoint-only-tab')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('checkpoint rejects owner replacement while retaining the original work and Run', async () => {
  const dispose = await initialize()
  dispose()
  const entered = deferred(), release = deferred()
  let pause = true
  vi.mocked(api.spatial.read).mockImplementation(async () => {
    if (pause) { pause = false; entered.resolve(); await release.promise }
    return owner.readForLayout()
  })
  addWorkface('in-flight-original-tab')
  const outcome = checkpoint().then(() => null, error => error as Error)
  await entered.promise
  await initialize()
  release.resolve()
  expect((await outcome)?.message).toContain('owner changed while saving')
  await expectDurableWorkface('in-flight-original-tab')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('failed checkpoint retains edits and retries through the same file owner without touching input', async () => {
  const dispose = await initialize()
  dispose()
  addWorkface('retained-unsaved-tab')
  vi.mocked(api.spatial.commit).mockRejectedValue(new Error('Original storage write is unconfirmed'))
  await expect(checkpoint()).rejects.toThrow('Original storage write is unconfirmed')
  expect(store.getState().tabs['retained-unsaved-tab']!.regions['retained-unsaved-tab-region']).toMatchObject({ sessionId })
  expect(store.getState().agentComposerDrafts[sessionId]).toBe('Keep the original unsent text')
  vi.mocked(api.spatial.commit).mockImplementation(input => owner.commit(input))
  await checkpoint()
  await expectDurableWorkface('retained-unsaved-tab')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('checkpoint without an original owner rejects only saving and retains healthy input facts', async () => {
  await expect(checkpoint()).rejects.toThrow('original Core spatial owner is unavailable')
  expect(store.getState().sessions[0]!.control.run.runId).toBe(runId)
  expect(store.getState().agentComposerDrafts[sessionId]).toBe('Keep the original unsent text')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})
