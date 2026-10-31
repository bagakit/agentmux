// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { inspectDesktopClient, observeWorkbenchUserState } from '../src/main/client-observation'
import { parseDesktopClientObservation } from '../src/shared/client-observation'
import { requireOutgoingWorkbenchStorage } from '../scripts/package-runtime-upgrade.mjs'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

let root: string, dispose: (() => void) | undefined
beforeEach(async () => { vi.resetModules(); window.localStorage.clear(); root = await mkdtemp(join(tmpdir(), 'amux-storage-observation-')) })
afterEach(async () => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }) })
const request = { schemaVersion: 5, requestId: 'original-observation', operation: 'inspect.client' } as const

async function fixture() {
  const { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private inspection' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Private inspection', hostId: 'local', path: root, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: 'original-agent', kind: 'agent', providerId: 'codex', executorId: 'original-executor',
    hostId: 'local', workspacePath: root, label: 'Original Agent', createdAt: 1, updatedAt: 1, processState: 'running', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
    status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'original-workspace', sessionId: session.id })
  store.setState({ config, tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('original-group', [tab.id]) },
    sessions: [session], activeWorkspaceId: 'original-workspace', agentComposerDrafts: {} })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial-state.json'))
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  const user = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  window.localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ state: { agentComposerDrafts: { 'original-region': 'PRIVATE original unsent draft' } }, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  dispose = await store.getState().initialize()
  await prepareRendererUpdate('quit')
  const renderer = { kind: 'bundled', id: 'b'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-runtime' } } as const
  const inspect = async () => {
    const result = await inspectDesktopClient(request, { pid: 123, package: null, renderer: () => renderer,
      generation: () => 1, runtimes: () => [], execute: value => store.getState().executeControl(value),
      storage: async () => ({ ...await observeWorkbenchUserState(user), spatialRevision: (await spatial.readForLayout().catch(() => null))?.revision ?? null }) })
    if (result.operation !== 'inspect.client') throw Error('Unexpected operation')
    return parseDesktopClientObservation(result.observation)
  }
  return { store, api, user, spatial, inspect, prepareRendererUpdate, createWorkbenchTab }
}

it('storage inspection exposes safe owner receipts and current Renderer/Core alignment through the actual product consumer', async () => {
  const f = await fixture(), before = f.store.getState(), writes = vi.mocked(f.api.ui.writeWorkbenchState).mock.calls.length
  const observed = await f.inspect()
  expect(observed.main.storage?.userState).toMatchObject({ path: f.user.path, availability: 'present', diskDurability: 'unconfirmed',
    confirmedAt: null, lastConfirmedWrite: { diskDurability: 'confirmed' } })
  expect(observed.workbench.persistence).toMatchObject({ userStatePending: false,
    userStateContentDigest: observed.main.storage?.userState?.contentDigest,
    spatial: { revision: observed.main.storage?.spatialRevision, aligned: true } })
  expect(() => requireOutgoingWorkbenchStorage(observed)).not.toThrow()
  expect(JSON.stringify(observed)).not.toContain('PRIVATE')
  expect(f.api.ui.writeWorkbenchState).toHaveBeenCalledTimes(writes)
  expect(f.store.getState()).toBe(before)
})

it('storage inspection keeps absent older facts unknown and refuses only this outgoing installation', async () => {
  const f = await fixture(), observed = await f.inspect()
  const legacy = structuredClone(observed)
  legacy.main.storage = { userData: root, sessionData: root, directory: root, localStorage: 'present', detail: null }
  delete legacy.workbench.persistence
  expect(parseDesktopClientObservation(legacy).workbench.persistence).toBeUndefined()
  expect(() => requireOutgoingWorkbenchStorage(legacy)).toThrow('existing interface and Runs were kept')
  expect(f.store.getState().sessions[0]).toMatchObject({ processState: 'running', control: { run: { runId: 'original-run' } } })
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})

it('storage inspection reports pending current user input before its native ACK and qualifies it after saving', async () => {
  const f = await fixture()
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { started = resolve })
  vi.mocked(f.api.ui.writeWorkbenchState).mockImplementationOnce(async value => { started(); await held; return f.user.write(value) })
  f.store.getState().setAgentComposerDraft('original-region', 'PRIVATE latest input')
  const saving = f.prepareRendererUpdate('quit')
  try {
    await ready
    const pending = await f.inspect()
    expect(pending.workbench.persistence?.userStatePending).toBe(true)
    expect(() => requireOutgoingWorkbenchStorage(pending)).toThrow('existing interface and Runs were kept')
  } finally { release(); await saving }
  const saved = await f.inspect()
  expect(() => requireOutgoingWorkbenchStorage(saved)).not.toThrow()
})

it('storage inspection does not let missing or externally replaced native bytes borrow a prior ACK', async () => {
  const f = await fixture(), original = await readFile(f.user.path, 'utf8')
  await unlink(f.user.path)
  const missing = await f.inspect()
  expect(missing.main.storage?.userState?.availability).toBe('missing')
  expect(() => requireOutgoingWorkbenchStorage(missing)).toThrow('existing interface and Runs were kept')
  const replaced = JSON.stringify({ state: { agentComposerDrafts: { 'original-region': 'PRIVATE external replacement' } }, version: 1 })
  await writeFile(f.user.path, replaced)
  const different = await f.inspect()
  expect(different.main.storage?.userState?.lastConfirmedWrite?.contentDigest).not.toBe(different.main.storage?.userState?.contentDigest)
  expect(() => requireOutgoingWorkbenchStorage(different)).toThrow('existing interface and Runs were kept')
  expect(await readFile(f.user.path, 'utf8')).toBe(replaced)
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  await writeFile(f.user.path, original)
})

it('storage inspection refuses a missing current Core file even when the Renderer still retains its graph', async () => {
  const f = await fixture()
  await unlink(f.spatial.path)
  const observed = await f.inspect()
  expect(observed.main.storage?.spatialRevision).toBeNull()
  expect(observed.workbench.persistence?.spatial.revision).toBeGreaterThan(0)
  expect(() => requireOutgoingWorkbenchStorage(observed)).toThrow('existing interface and Runs were kept')
  expect(f.store.getState().tabs['original-tab']).toBeDefined()
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})

it('storage inspection retains healthy workfaces and bounded failure metadata when the original file cannot be read', async () => {
  const f = await fixture(), original = await readFile(f.user.path, 'utf8'), corrupt = '{PRIVATE truncated original input'
  try {
    await writeFile(f.user.path, corrupt)
    const observed = await f.inspect()
    expect(observed.main.storage?.userState).toMatchObject({ availability: 'unconfirmed', diskDurability: 'unconfirmed',
      lastFailure: { operation: 'read', code: 'WORKBENCH_USER_STATE_INVALID' } })
    expect(JSON.stringify(observed)).not.toContain('PRIVATE')
    expect(observed.workbench.tabs[0]?.regions[0]).toMatchObject({ processState: 'running', control: { run: { runId: 'original-run' } } })
    expect(() => requireOutgoingWorkbenchStorage(observed)).toThrow('existing interface and Runs were kept')
    expect(await readFile(f.user.path, 'utf8')).toBe(corrupt)
    expect(f.api.sessions.stop).not.toHaveBeenCalled()
  } finally { await writeFile(f.user.path, original); await f.user.flushDiagnostics() }
})

it('storage inspection does not call an equal current graph aligned while its original write remains in flight', async () => {
  const f = await fixture(), tabs = f.store.getState().tabs
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { started = resolve })
  vi.mocked(f.api.spatial.commit).mockImplementationOnce(async () => { started(); await held; throw Error('Original spatial ACK unavailable') })
  const tab = f.createWorkbenchTab('new-tab', { regionId: 'new-region', kind: 'launcher', workspaceId: 'original-workspace' })
  try {
    f.store.setState({ tabs: { ...tabs, [tab.id]: tab } })
    await ready
    f.store.setState({ tabs })
    const observed = await f.inspect()
    expect(observed.workbench.persistence?.spatial.aligned).toBe(false)
    expect(() => requireOutgoingWorkbenchStorage(observed)).toThrow('existing interface and Runs were kept')
  } finally {
    release()
    await vi.waitFor(() => expect(f.store.getState().workbenchSaveWarning).toContain('Original spatial ACK unavailable'))
    await f.prepareRendererUpdate('quit')
  }
})
