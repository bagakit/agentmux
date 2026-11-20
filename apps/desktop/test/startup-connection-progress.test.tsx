// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { RuntimeEndpointWarning, RuntimeEvent } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { StartupLoadingSurface } from '../src/renderer/src/components/StartupLoadingSurface'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const initial = useAppStore.getState()
const session = composerSession('retained-startup-session')
const nativeStep = 'Core to ctxmux connection'
const pending = (message: string, hostId = 'local', step = nativeStep): RuntimeEndpointWarning => ({
  hostId, step, scope: 'observation', availability: 'connected', code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING', message,
  observationOrigin: { kind: 'runtime-connection', boundary: step === nativeStep ? 'core-ctxmux' : 'consumer-core' },
  evidence: { source: 'run-process', observedAt: 1 }, recovery: 'Observe the original Host again; retain its Session and Run.'
})
const observed = (warning: RuntimeEndpointWarning | null, hostId = warning?.hostId ?? 'local', step = warning?.step ?? nativeStep): RuntimeEvent => ({
  type: 'core', hostId, endpointObservation: { step, warning }, event: {
    type: 'connection-state', state: 'restored', observationOrigin: {
      kind: 'runtime-connection', boundary: step === nativeStep ? 'core-ctxmux' : 'consumer-core'
    }, ...(warning ? { diagnostic: { code: warning.code, message: warning.message } } : {}),
    evidence: { source: 'run-process', observedAt: 1 }
  }
})
function Loading() {
  const progress = useAppStore(state => state.startupProgress)
  const warnings = useAppStore(state => state.runtimeEndpointWarnings)
  return <StartupLoadingSurface progress={progress} runtimeEndpointWarnings={warnings} />
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let root: Root, element: HTMLDivElement, directory: string, listener: (event: RuntimeEvent) => void
let initializing: Promise<() => void> | undefined, release: (() => void) | undefined
let endpointCut: ReturnType<typeof deferred<RuntimeEndpointWarning[]>>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], recoveryCandidates: [], timelines: {} })
  endpointCut = deferred<RuntimeEndpointWarning[]>()
  vi.spyOn(api.sessions, 'endpointWarnings').mockReturnValue(endpointCut.promise)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(callback => { listener = callback; return () => {} })
  vi.spyOn(api.sessions, 'recover'); vi.spyOn(api.sessions, 'stop'); vi.spyOn(api.sessions, 'submitPrompt')
  directory = await mkdtemp(join(tmpdir(), 'agentmux-startup-connection-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const tab = createWorkbenchTab('original-startup-tab', {
    kind: 'agent', regionId: 'original-startup-region', workspaceId: 'workspace', sessionId: session.id, phase: 'attached'
  })
  const tabs = { [tab.id]: tab }, layouts = { workspace: createWorkspaceLayout('original-startup-group', [tab.id]) }
  useAppStore.setState({ loading: true, sessions: [session], restoredWorkbench: { tabs, layouts },
    agentComposerDrafts: { [session.id]: 'Original unsent draft' }, activeWorkspaceId: 'workspace' })
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...useAppStore.getState(), config: composerConfig, tabs, layouts }, []) })
  const retained = await spatial.read(), waiting = deferred<typeof retained>()
  release = () => { waiting.resolve(retained); endpointCut.resolve([]) }
  vi.spyOn(api.spatial, 'read').mockReturnValue(waiting.promise)
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(callback => spatial.subscribe(callback))
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => { root.render(<Loading />); initializing = useAppStore.getState().initialize() })
  await vi.waitFor(() => expect(api.spatial.read).toHaveBeenCalledOnce())
})
afterEach(async () => {
  await act(async () => { release?.(); if (initializing) (await initializing)(); root.unmount() })
  release = undefined; initializing = undefined; element.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

it('shows current Core progress during the spatial read while retaining buffered Session facts and the original draft', async () => {
  const first = pending('Run observation is not yet confirmed. Original Native input remains available.')
  await act(async () => {
    listener(observed(first))
    listener({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: session.id,
      state: 'done', evidence: { source: 'native-hook', observedAt: 100 } } })
  })
  expect(useAppStore.getState().loading).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([session])
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([first])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')?.textContent).toContain(first.message)
  expect(element.textContent).toContain(`local: ${nativeStep}`)
  const next = pending('Hook restoration is not yet confirmed. Original Native input remains available.')
  await act(async () => listener(observed(next)))
  await act(async () => endpointCut.resolve([first]))
  expect(element.textContent).toContain(next.message)
  expect(element.textContent).not.toContain(first.message)
  await act(async () => listener(observed(null, 'local', 'Core control connection')))
  await act(async () => listener(observed(null, 'remote-host')))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([next])
  expect(element.textContent).toContain(next.message)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent draft')
  expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.stop).not.toHaveBeenCalled(); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  await act(async () => listener(observed(null)))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')).toBeNull()
  expect(useAppStore.getState().loading).toBe(true)
  await act(async () => { release?.(); await initializing })
  expect(useAppStore.getState().loading).toBe(false)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original-startup-tab'])
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original unsent draft')
})

it('shows the original endpoint warning before membership is readable and clears only that Host', async () => {
  const warning: RuntimeEndpointWarning = { hostId: 'remote-host', step: 'Connecting to Runtime',
    availability: 'unverified', code: 'RUNTIME_UNAVAILABLE', message: 'The original endpoint is still connecting.', recovery: 'Reconnect the original Host.' }
  await act(async () => listener({ type: 'core', hostId: warning.hostId, event: observed(null, warning.hostId).event, endpointWarning: warning }))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')?.textContent).toContain(warning.message)
  expect(element.textContent).toContain('remote-host: Connecting to Runtime')
  await act(async () => listener({ type: 'core', hostId: 'local', event: observed(null).event, endpointWarning: null }))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  await act(async () => listener({ type: 'core', hostId: warning.hostId, event: observed(null, warning.hostId).event, endpointWarning: null }))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')).toBeNull()
  expect(useAppStore.getState().sessions).toEqual([session])
})

it('shows the cached Main observation before spatial and Session reads complete even with no new event', async () => {
  const cached = pending('The original Native connection is not yet confirmed. Durable identities remain readable.')
  expect(api.sessions.endpointWarnings).toHaveBeenCalledOnce()
  expect(api.sessions.onEvent).toHaveBeenCalledOnce()
  expect(api.sessions.snapshot).not.toHaveBeenCalled()
  await act(async () => endpointCut.resolve([cached]))
  expect(useAppStore.getState().loading).toBe(true)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([cached])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')?.textContent).toContain(cached.message)
  expect(api.sessions.snapshot).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([session])
  await act(async () => listener(observed(null)))
  expect(element.querySelector('[aria-label="Runtime startup observations"]')).toBeNull()
})

it('groups live startup activity without dropping distinct messages or original diagnostics', async () => {
  const connecting = pending('The endpoint is connecting. Existing Sessions remain unverified.')
  const warnings = [
    { ...connecting, hostId: 'remote-b', step: 'Reading Session directory', message: 'The complete Session directory is not confirmed.' },
    { ...connecting, hostId: 'remote-a', step: 'Reading Session directory', message: 'The complete Session directory is not confirmed.' },
    { ...connecting, hostId: 'remote-a', step: 'Connecting to Runtime' },
    { ...connecting, hostId: 'remote-c', step: 'Connecting to Runtime' },
    { ...connecting, hostId: 'remote-d', step: 'Connecting to Runtime', message: 'Authorization for this endpoint is still being checked.' }
  ]
  await act(async () => endpointCut.resolve(warnings))

  const activity = element.querySelector('[aria-label="Runtime startup observations"]')!
  const groups = [...activity.querySelectorAll('.startup-activity__group')]
  expect(activity.querySelector('.startup-activity__heading')?.textContent).toBe('Current activity4 endpoints · 2 steps')
  expect(groups).toHaveLength(2)
  expect(groups[0]?.querySelector('h3')?.textContent).toBe('Reading Session directory')
  expect(groups[0]?.querySelector('.startup-activity__count')?.textContent).toBe('2 endpoints')
  expect(groups[0]?.querySelectorAll('.startup-activity__message')).toHaveLength(1)
  expect(groups[1]?.querySelector('h3')?.textContent).toBe('Connecting to Runtime')
  expect(groups[1]?.querySelector('.startup-activity__count')?.textContent).toBe('3 endpoints')
  expect(groups[1]?.querySelectorAll('.startup-activity__message')).toHaveLength(2)
  expect(activity.textContent).not.toContain('remote-a')
  expect(element.textContent).toContain('Reading your saved workspace.')

  const details = element.querySelector('details')!
  const definitions = [...details.querySelectorAll('dt')].map(node => node.textContent)
  expect(definitions).toEqual([
    'remote-b: Reading Session directory',
    'remote-a: Reading Session directory',
    'remote-a: Connecting to Runtime',
    'remote-c: Connecting to Runtime',
    'remote-d: Connecting to Runtime'
  ])
  const diagnostics = [...details.querySelectorAll('dd')].map(node => node.textContent)
  expect(diagnostics).toHaveLength(5)
  for (const [index, warning] of warnings.entries()) {
    expect(diagnostics[index]).toContain(warning.code)
    expect(diagnostics[index]).toContain(warning.recovery)
  }
})

it('does not resurrect an already restored boundary when its earlier Main cut arrives late', async () => {
  const cached = pending('The original Native connection is not yet confirmed.')
  await act(async () => listener(observed(null)))
  await act(async () => endpointCut.resolve([cached]))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  expect(element.querySelector('[aria-label="Runtime startup observations"]')).toBeNull()
  expect(useAppStore.getState().loading).toBe(true)
})
