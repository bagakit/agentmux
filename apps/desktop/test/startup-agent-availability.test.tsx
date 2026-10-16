// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { desktopWorkbenchObservationSchema } from '../src/shared/client-observation'
import type { AppConfig, ExecutorDetection, RuntimeSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'

const initial = useAppStore.getState()
let config: AppConfig, directory: string, dispose: (() => void) | undefined
let releases: Array<() => void>
let checks: Record<string, ReturnType<typeof deferred<ExecutorDetection>>>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function ticks() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function result(id: string, availability: 'available' | 'missing' | 'check-failed' = 'available'): ExecutorDetection {
  const executor = config.executors[id]!
  return { input: { executorId: id, providerId: executor.providerId, command: executor.command, host: config.hosts[0]! },
    executable: executor.command, availability,
    ...(availability === 'check-failed' ? { cause: { code: 'PROBE_IO', message: 'Original executable check failed' } } : {}) }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  releases = []; dispose = undefined
  config = { ...structuredClone(composerConfig), executors: {
    ...structuredClone(composerConfig.executors),
    custom: { label: 'Custom Agent', providerId: 'claude', command: 'private-agent', args: [], env: {}, injectAgentMuxGuide: true }
  } }
  checks = Object.fromEntries(Object.keys(config.executors).map(id => [id, deferred<ExecutorDetection>()]))
  releases.push(() => { for (const [id, check] of Object.entries(checks)) check.resolve(result(id)) })
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockImplementation(async () => config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [composerSession()], recoveryCandidates: [], timelines: {} })
  vi.spyOn(api.executors, 'detect').mockImplementation(id => checks[id]!.promise)
  vi.spyOn(api.sessions, 'stop'); vi.spyOn(api.sessions, 'recover'); vi.spyOn(api.sessions, 'submitPrompt')
  directory = await mkdtemp(join(tmpdir(), 'agentmux-startup-agents-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(value => spatial.retainDisplayLabels(value))
  const tab = createWorkbenchTab('original-tab', { kind: 'launcher', regionId: 'original-region', workspaceId: 'workspace' })
  useAppStore.setState({ loading: true, config, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) } },
    agentComposerDrafts: { 'agent-1': 'Keep the original draft' } })
})
afterEach(async () => {
  dispose?.()
  for (const release of releases) release()
  await ticks()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
async function boot() { dispose = await useAppStore.getState().initialize(); await ticks() }
function originalWorkface() {
  const state = useAppStore.getState()
  expect(state.loading).toBe(false)
  expect(state.tabs['original-tab']?.layout.activeRegionId).toBe('original-region')
  expect(state.agentComposerDrafts['agent-1']).toBe('Keep the original draft')
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(api.sessions.recover).not.toHaveBeenCalled()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
}

it('starts both Agent checks without mounting a Launcher and publishes the durable workface while other readers remain pending', async () => {
  const snapshot = deferred<RuntimeSnapshot>(), catalog = deferred<void>()
  releases.push(() => { snapshot.resolve({ sessions: [composerSession()], recoveryCandidates: [], timelines: {} }); catalog.resolve() })
  vi.mocked(api.sessions.snapshot).mockReturnValue(snapshot.promise)
  vi.mocked(api.providers.list).mockImplementation((async () => { await catalog.promise; return { catalog: [], warnings: [] } }) as typeof api.providers.list)
  await boot()
  expect(api.executors.detect).toHaveBeenCalledTimes(2)
  expect(api.sessions.snapshot).toHaveBeenCalled()
  expect(useAppStore.getState().startupAgentAvailability).toEqual({ hostId: 'local', current: 0, total: 2, pending: true })
  originalWorkface()
  checks.codex!.resolve(result('codex')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability?.current).toBe(1)
  expect(useAppStore.getState().startupAgentAvailability?.pending).toBe(true)
  checks.custom!.resolve(result('custom', 'missing')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ current: 2, pending: false })
  originalWorkface()
  const observed = await useAppStore.getState().executeControl({ operation: 'inspect.client' })
  expect(observed.operation).toBe('inspect.client')
  if (observed.operation !== 'inspect.client') throw new Error('Wrong observation owner')
  expect(desktopWorkbenchObservationSchema.parse(observed.observation).startupAgentAvailability).toMatchObject({ current: 2, total: 2, pending: false })
})

it.each([undefined, false, true])('historical startup preference %s cannot gate or skip observation', async value => {
  if (value !== undefined) config.startup = { skipAgentAvailabilityCheckWait: value }
  await boot()
  expect(api.executors.detect).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ pending: true })
  originalWorkface()
  checks.codex!.resolve(result('codex')); checks.custom!.resolve(result('custom')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ current: 2, pending: false })
  originalWorkface()
})

it('a failed check settles the startup observation and preserves its cause and healthy work', async () => {
  await boot()
  checks.codex!.resolve(result('codex'))
  checks.custom!.resolve(result('custom', 'check-failed')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ current: 2, pending: false })
  expect(useAppStore.getState().executorDetections['local\0custom']).toMatchObject({ state: 'error', detail: 'PROBE_IO: Original executable check failed' })
  originalWorkface()
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(<GlobalSystemNotices />))
    expect(container.textContent).toContain('Agent availability check needs attention')
    expect(container.textContent).toContain('PROBE_IO: Original executable check failed')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check Agents again')!
    expect(retry).toBeDefined()
    checks = Object.fromEntries(Object.keys(config.executors).map(id => [id, deferred<ExecutorDetection>()]))
    await act(async () => retry.click())
    expect(api.executors.detect).toHaveBeenCalledTimes(4)
    expect(useAppStore.getState().executorDetections['local\0custom']?.state).toBe('checking')
    expect(container.textContent).toContain('PROBE_IO: Original executable check failed')
    await act(async () => { checks.codex!.resolve(result('codex')); checks.custom!.resolve(result('custom')); await ticks() })
    expect(container.textContent).not.toContain('Agent availability check needs attention')
    originalWorkface()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('joining an already running check waits for its original result without probing twice', async () => {
  const joined = useAppStore.getState().detectExecutors('local')
  await boot()
  expect(api.executors.detect).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().startupAgentAvailability?.pending).toBe(true)
  checks.codex!.resolve(result('codex')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability?.pending).toBe(true)
  checks.custom!.resolve(result('custom')); await joined; await ticks()
  expect(useAppStore.getState().startupAgentAvailability?.pending).toBe(false)
})

it('disposing the startup observer prevents late progress from mutating its replacement', async () => {
  await boot(); dispose?.(); dispose = undefined
  const replacement = { hostId: 'replacement', current: 0, total: null, pending: true }
  useAppStore.setState({ startupAgentAvailability: replacement })
  checks.codex!.resolve(result('codex')); checks.custom!.resolve(result('custom')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toBe(replacement)
})

it('remote discovery shares its original in-flight observation and keeps an unknown total until the Host replies', async () => {
  const host = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.example' } as const
  config.hosts = [host]; config.workspaces[0]!.hostId = host.id
  const inventory = deferred<Awaited<ReturnType<typeof api.executors.discover>>>()
  releases.push(() => inventory.resolve({ routeHostId: host.id, runtimeId: 'private-runtime', executors: [] }))
  const discover = vi.spyOn(api.executors, 'discover').mockReturnValue(inventory.promise)
  const existing = useAppStore.getState().detectExecutors(host.id)
  await boot()
  expect(discover).toHaveBeenCalledTimes(1)
  expect(api.executors.detect).not.toHaveBeenCalled()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ hostId: host.id, total: null, pending: true })
  inventory.resolve({ routeHostId: host.id, runtimeId: 'private-runtime', executors: [] })
  await existing; await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ total: 0, current: 0, pending: false })
})

it('a retained choice in another display Workspace cannot redirect the visible initial Host check', async () => {
  const remoteHost = { id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.example' } as const
  config.hosts.push(remoteHost)
  config.workspaces.push({ ...config.workspaces[0]!, id: 'other-workspace', hostId: remoteHost.id })
  const state = useAppStore.getState(), original = state.restoredWorkbench!
  const remoteTab = createWorkbenchTab('remote-tab', { kind: 'launcher', regionId: 'remote-region', workspaceId: 'other-workspace' })
  useAppStore.setState({ restoredWorkbench: { tabs: { ...original.tabs, [remoteTab.id]: remoteTab }, layouts: {
    ...original.layouts, 'other-workspace': createWorkspaceLayout('remote-group', [remoteTab.id])
  } }, workbenchSpaceSelection: { workspaceId: 'other-workspace', groupId: 'remote-group', tabId: remoteTab.id,
    regionId: 'remote-region', spaceId: null, zoneId: null, topicId: null } })
  const discover = vi.spyOn(api.executors, 'discover')
  await boot()
  expect(discover).not.toHaveBeenCalled()
  expect(api.executors.detect).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().startupAgentAvailability?.hostId).toBe('local')
})

it('startup progress retains its captured command set when later configuration adds an unrelated command', async () => {
  await boot()
  useAppStore.setState({ config: { ...config, executors: { ...config.executors, later: {
    label: 'Later command', providerId: 'codex', command: 'later-command', args: [], env: {}, injectAgentMuxGuide: true
  } } } })
  checks.codex!.resolve(result('codex')); checks.custom!.resolve(result('custom')); await ticks()
  expect(useAppStore.getState().startupAgentAvailability).toMatchObject({ current: 2, total: 2, pending: false })
})
