// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

let root: string
let dispose: (() => void) | undefined
beforeEach(async () => { vi.resetModules(); window.localStorage.clear(); root = await mkdtemp(join(tmpdir(), 'amux-user-state-consumer-')) })
afterEach(async () => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function fixture(initial = 'Original unsent draft') {
  const { useAppStore: store } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private storage proof' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Private proof', hostId: 'local', path: root, kind: 'folder' }],
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
  window.localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ state: { agentComposerDrafts: { 'original-region': initial } }, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  dispose = await store.getState().initialize()
  return { store, api, user, spatial, session }
}

it('actual Desktop hydration and user editing use the host file and preserve original spatial and Run identities', async () => {
  const f = await fixture()
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(window.localStorage.getItem('agentmux-workbench-v1')).toBeNull()
  f.store.getState().setAgentComposerDraft('original-region', 'Latest original draft')
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  const saved = JSON.parse(await readFile(join(root, 'workbench-user-state.json'), 'utf8'))
  expect(saved.state.agentComposerDrafts['original-region']).toBe('Latest original draft')
  expect(saved.state.restoredWorkbench).toBeUndefined()
  expect((await f.spatial.read())!.graph.regions.find(region => region.regionId === 'original-region')).toMatchObject({ agentSessionId: 'original-agent', runId: 'original-run' })
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  expect(f.user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
})

it('a failed native user save leaves the latest draft and healthy original Agent available for retry', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  f.store.getState().setAgentComposerDraft('original-region', 'Retain after save failure')
  vi.mocked(f.api.ui.writeWorkbenchState).mockRejectedValueOnce(Error('Private native write unconfirmed'))
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Private native write unconfirmed')
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Retain after save failure')
  expect(f.store.getState().sessions.find(session => session.id === 'original-agent')?.processState).toBe('running')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  await prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Retain after save failure')
})

it('an explicit checkpoint resaves current user content after the original host file disappears', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  await unlink(f.user.path)
  await prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})

it('native user persistence waiting does not block an exactly bound healthy prompt', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  let release!: () => void
  vi.mocked(f.api.ui.writeWorkbenchState).mockImplementationOnce(() => new Promise<null>(resolve => { release = () => resolve(null) }))
  vi.spyOn(f.api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  try {
    expect(f.store.getState().send('original-agent', 'Exact original input')).toBe(true)
    await vi.waitFor(() => expect(f.api.sessions.submitPrompt).toHaveBeenCalledOnce())
    expect(vi.mocked(f.api.sessions.submitPrompt).mock.calls[0]!.slice(0, 3)).toEqual([f.session.control, 'Exact original input', expect.any(String)])
    expect(f.api.sessions.stop).not.toHaveBeenCalled()
  } finally {
    release?.()
    await prepareRendererUpdate('quit')
  }
})

it('unrelated Session output updates do not submit native user or spatial writes', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  vi.mocked(f.api.ui.writeWorkbenchState).mockClear()
  vi.mocked(f.api.spatial.commit).mockClear()
  const unrelated = Array.from({ length: 500 }, (_, index) => ({ ...f.session, id: 'unrelated-' + index,
    control: { ...f.session.control, agentSessionId: 'unrelated-' + index } }))
  for (let tick = 1; tick <= 100; tick++) {
    f.store.setState({ sessions: [f.session, ...unrelated.map(session => ({ ...session, latestOutputBytes: tick }))] })
  }
  await new Promise(resolve => setTimeout(resolve, 450))
  expect(f.api.ui.writeWorkbenchState).not.toHaveBeenCalled()
  expect(f.api.spatial.commit).not.toHaveBeenCalled()
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
})
