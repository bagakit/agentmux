import { notificationEventRows, notificationTrigger, toggleNotificationCenter } from './helpers/notification-center'
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { AgentProviderRegistry } from '@agentmux/core'
import type { AgentSessionNameMetadata, AppConfig, RuntimeEndpointWarning, RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { useWorkbenchTabNameMetadata, useWorkbenchTabSessions } from '../src/renderer/src/lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../src/renderer/src/lib/workbench-tab-presentation'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { regionSurfaceLabel } from '../src/renderer/src/lib/region-display-name'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const initial = useAppStore.getState()
const ids = ['original-a', 'original-b']
const empty = (): RuntimeSnapshot => ({ sessions: [], recoveryCandidates: [], timelines: {} })
const complete = (): Omit<RuntimeSnapshot, 'sessions'> & { sessions: ReturnType<typeof composerSession>[] } => ({
  ...empty(), sessions: ids.map(id => composerSession(id)),
  timelines: Object.fromEntries(ids.map(id => [id, { agentSessionId: id, revision: 1, items: [] }]))
})
const unknownEvent = (): RuntimeEvent => ({ type: 'core', hostId: 'local', event: {
  type: 'agent-status', agentSessionId: 'unrelated-event', state: 'working',
  evidence: { source: 'native-hook', observedAt: 1 }
} })
function Notices() { return <GlobalSystemNotices /> }
let root: Root, element: HTMLDivElement, dispose: (() => void) | undefined, releasePending: (() => void) | undefined
let spatialDirectory: string, spatial: AgentMuxSpatialStateStore
function setHistorySources(sources: AgentSessionHistoryDescriptor[], warnings: RuntimeEndpointWarning[] = []) {
  vi.mocked(api.sessions.historySources).mockImplementation(historySourcesReader(sources, warnings))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources')
  setHistorySources([])
  spatialDirectory = await mkdtemp(join(tmpdir(), 'agentmux-startup-session-facts-'))
  spatial = new AgentMuxSpatialStateStore(join(spatialDirectory, 'spatial-state.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
async function saveOriginalWorkbench(config = composerConfig, execution = true, secondHost = 'local') {
  const state = useAppStore.getState(), original = state.restoredWorkbench!
  const graph = desktopSpatialGraph({ ...state, config,
    tabs: Object.fromEntries(Object.values(original.tabs).map(tab => [tab.id, hydratePersistedTab(tab)])), layouts: original.layouts,
    sessions: execution ? ids.map((id, index) => {
      const session = composerSession(id), hostId = index ? secondHost : 'local'
      return { ...session, hostId, control: { ...session.control, hostId } }
    }) : [] }, [])
  const saved = await spatial.commit({ expectedRevision: 0, graph })
  expect((await spatial.read())?.graph).toEqual(saved.graph)
  // The current Core projection supplies exact Space/Zone metadata. Preserve that
  // original receipt in the fixture rather than compare against a pre-Core Tab shape.
  const originalProjection = desktopWorkbenchFromSpatial(saved.graph)
  for (const tab of Object.values(original.tabs)) Object.assign(tab, { space: originalProjection.tabs[tab.id]!.space })
  expect(saved.graph.regions.map(region => region.agentSessionId)).toEqual(ids)
  expect(saved.graph.regions.map(region => region.execution?.hostId ?? null)).toEqual(execution ? ['local', secondHost] : [null, null])
}
async function missingReferencesFixture(catalogue: AgentSessionHistoryDescriptor[]) {
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    kind: 'agent', regionId: `region-${id}`, workspaceId: 'workspace', sessionId: id, phase: 'attached'
  })]))
  useAppStore.setState({ restoredWorkbench: { tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) } },
    loading: true, activeWorkspaceId: 'workspace' })
  await saveOriginalWorkbench()
  setHistorySources(catalogue)
  const unrelated = { ...empty(), sessions: [composerSession('healthy-neighbor')],
    timelines: { 'healthy-neighbor': { agentSessionId: 'healthy-neighbor', revision: 1, items: [] } } }
  let finish!: (snapshot: RuntimeSnapshot) => void
  const deferred = new Promise<RuntimeSnapshot>(resolve => { finish = resolve })
  releasePending = () => finish(unrelated)
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockResolvedValueOnce(unrelated).mockReturnValue(deferred)
  const recover = vi.spyOn(api.sessions, 'recover')
  await act(async () => { root.render(<Notices />); dispose = await useAppStore.getState().initialize() })
  await act(async () => { await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2)) })
  return { tabs, recover, settle: async () => { await act(async () => { finish(unrelated); await new Promise(done => setTimeout(done, 0)) }) } }
}

it('classifies original closed history before counting missing Runtime references and settles a removed reference', async () => {
  const f = await missingReferencesFixture([{ agentSessionId: ids[0]!, hostId: 'local', state: 'retired' }])
  expect(useAppStore.getState().error).toContain('1 saved Session reference(s) have no current Runtime facts')
  expect((element.querySelector('.notification-item[data-notice-id="current"] .notification-item__title')?.textContent ?? '')).toContain('1 saved Session')
  expect(element.querySelector('.notification-item[data-notice-id="current"] .notification-item__original')?.textContent).toContain('no current Runtime facts')
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds).toEqual([ids[1]])
  expect(useAppStore.getState().tabs).toEqual(f.tabs)
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(['healthy-neighbor'])
  expect(f.recover).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ tabs: { [`tab-${ids[0]}`]: f.tabs[`tab-${ids[0]}`]! } }))
  await f.settle()
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  expect(useAppStore.getState().tabs[`tab-${ids[0]}`]).toEqual(f.tabs[`tab-${ids[0]}`])
})

it('keeps a foreign Host or merely active history descriptor out of closed-reference classification', async () => {
  const f = await missingReferencesFixture([
    { agentSessionId: ids[0]!, hostId: 'foreign-host', state: 'retired' },
    { agentSessionId: ids[1]!, hostId: 'local', state: 'active' }
  ])
  expect(useAppStore.getState().error).toContain('2 saved Session reference(s) have no current Runtime facts')
  await f.settle()
  expect(useAppStore.getState().error).toContain('2 saved Session reference(s) have no current Runtime facts')
  expect(useAppStore.getState().tabs).toEqual(f.tabs)
  expect(f.recover).not.toHaveBeenCalled()
})

it('settles retained closed references from their own later Core catalogue without washing away another startup failure', async () => {
  vi.mocked(api.providers.list).mockRejectedValue(new Error('Unrelated Provider discovery failure'))
  const f = await missingReferencesFixture([])
  expect(useAppStore.getState().error).toContain('2 saved Session reference(s) have no current Runtime facts')
  setHistorySources(ids.map(agentSessionId => ({ agentSessionId, hostId: 'local', state: 'retired' })))
  await f.settle()
  expect(useAppStore.getState().error).toContain('Unrelated Provider discovery failure')
  expect(useAppStore.getState().error).not.toContain('no current Runtime facts')
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect((element.querySelector('.notification-item[data-notice-id="current"] .notification-item__title')?.textContent ?? '')).toContain('Startup checks')
  expect((element.querySelector('.notification-item[data-notice-id="current"] .notification-item__title')?.textContent ?? '')).not.toContain('saved Session')
  expect(element.querySelector('.notification-item[data-notice-id="current"] .notification-item__original')?.textContent).toContain('Unrelated Provider discovery failure')
  expect(useAppStore.getState().tabs).toEqual(f.tabs)
  expect(f.recover).not.toHaveBeenCalled()
})
afterEach(async () => {
  await act(async () => {
    // An assertion may fail before releasing the deferred read; it must not become the next case's owner.
    releasePending?.(); releasePending = undefined; await new Promise(done => setTimeout(done, 0))
    dispose?.(); dispose = undefined; root.unmount()
  })
  element.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(spatialDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
})
async function fixture(bufferedEvent = false, overflow?: 'complete' | 'partial', options: {
  foreignHost?: boolean; movedDisplay?: boolean; secondExecutionHost?: string; spatial?: 'absent' | 'missing-execution'; initialSnapshot?: RuntimeSnapshot | Error
} = {}) {
  const config: AppConfig = options.foreignHost || options.movedDisplay ? { ...composerConfig,
    hosts: [...composerConfig.hosts, { id: 'foreign-host', kind: 'ssh', label: 'Other Host', hostname: 'private.invalid', user: 'fixture' }],
    workspaces: [...composerConfig.workspaces, { id: 'foreign-display', name: 'Other display', hostId: 'foreign-host', path: _hygiene_fixturePath("display"), kind: 'folder' }]
  } : composerConfig
  vi.mocked(api.config.get).mockResolvedValue(config)
  const workspaceId = options.movedDisplay ? 'foreign-display' : 'workspace'
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    kind: 'agent', regionId: `region-${id}`, workspaceId, sessionId: id, phase: 'attached'
  })]))
  const original = { tabs, layouts: Object.fromEntries(config.workspaces.map(workspace => [workspace.id,
    createWorkspaceLayout(workspace.id === workspaceId ? 'original-group' : `original-empty-${workspace.id}`,
      workspace.id === workspaceId ? Object.keys(tabs) : [])])),
    agentFocus: { execution: { sessionId: ids[0]!, history: [{ sessionId: ids[0]!, focusedAt: 1 }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'original-a': '原来的未发送草稿', 'original-b': 'Original neighbor draft' } }
  useAppStore.setState({ restoredWorkbench: { tabs, layouts: original.layouts }, loading: true,
    agentFocus: original.agentFocus, agentComposerDrafts: original.agentComposerDrafts, activeWorkspaceId: workspaceId })
  if (options.spatial !== 'absent') await saveOriginalWorkbench(config, options.spatial !== 'missing-execution', options.secondExecutionHost)
  else {
    // Resource metadata is derived from the original configuration, not an execution
    // confirmation. This case still leaves the durable Core graph absent.
    const resource = desktopWorkbenchFromSpatial(desktopSpatialGraph({ ...useAppStore.getState(), config,
      tabs, layouts: original.layouts, sessions: [] }, []))
    for (const tab of Object.values(tabs)) Object.assign(tab, { space: resource.tabs[tab.id]!.space })
  }
  let listener: (event: RuntimeEvent) => void = () => {}
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(callback => { listener = callback; return () => {} })
  let resolve!: (snapshot: RuntimeSnapshot) => void, reject!: (error: Error) => void
  const pending = new Promise<RuntimeSnapshot>((yes, no) => { resolve = yes; reject = no })
  releasePending = () => resolve(empty())
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementationOnce(async () => {
    if (overflow) for (let index = 0; index < 257; index += 1) listener(unknownEvent())
    else if (bufferedEvent) listener(unknownEvent())
    if (options.initialSnapshot instanceof Error) throw options.initialSnapshot
    return options.initialSnapshot ?? empty()
  })
  if (overflow) snapshot.mockResolvedValueOnce(overflow === 'complete'
    ? complete() : { ...complete(), sessions: complete().sessions.slice(0, 1) })
  snapshot.mockReturnValue(pending)
  await act(async () => { root.render(<Notices />); dispose = await useAppStore.getState().initialize() })
  // Startup publishes the durable workface before its optional Runtime observation.
  // Wait for the original cut, including its bounded retry, before resolving the deferred next cut.
  if (!options.initialSnapshot || options.initialSnapshot instanceof Error || options.initialSnapshot.sessions.length === 0) {
    await act(async () => { await vi.waitFor(() => expect(snapshot.mock.calls.length).toBeGreaterThanOrEqual(overflow === 'partial' ? 3 : 2)) })
  } else await act(async () => { await new Promise(done => setTimeout(done, 0)) })
  expect(useAppStore.getState().loading).toBe(false)
  if (overflow === 'complete') {
    expect(useAppStore.getState().errorNoticeContext).toBeNull()
    expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  } else if (!useAppStore.getState().errorNoticeContext?.startupSessionSnapshot && options.initialSnapshot && !(options.initialSnapshot instanceof Error) && options.initialSnapshot.sessions.length > 0) {
    if (useAppStore.getState().error) expect(element.querySelector('.notification-item[data-notice-id="current"]')!.textContent).toContain('Provider catalog lookup did not complete')
    else expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  } else {
    expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds).toEqual(overflow === 'partial' ? [ids[1]] : ids)
    expect(element.querySelectorAll('.notification-item[data-notice-id="current"]')).toHaveLength(1)
    expect(element.querySelector('.notification-item[data-notice-id="current"] .notification-item__original')!.textContent).toContain(useAppStore.getState().error)
  }
  const warning = useAppStore.getState().error!
  const settle = async (result: RuntimeSnapshot | Error) => {
    // A complete first cut can finish the optional reader. Request another canonical cut
    // through the original Runtime event consumer before resolving its deferred receipt.
    if (options.initialSnapshot && !(options.initialSnapshot instanceof Error) && options.initialSnapshot.sessions.length > 0 && snapshot.mock.calls.length < 2) {
      await act(async () => { listener(unknownEvent()) })
    }
    await act(async () => { result instanceof Error ? reject(result) : resolve(result); await new Promise(done => setTimeout(done, 0)) })
  }
  const retained = () => {
    expect(useAppStore.getState().tabs).toEqual(original.tabs)
    expect(useAppStore.getState().layouts).toEqual(original.layouts)
    expect(useAppStore.getState().agentFocus).toEqual(original.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(original.agentComposerDrafts)
  }
  retained()
  return { settle, retained, warning, snapshot, restore: () => listener({ type: 'core', hostId: 'local', event: {
    type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: 2 }
  } }) }
}
const candidates = () => complete().sessions.map(session => ({ ...session, agentSessionId: session.id, run: session.control.run }))

it('startup observation shrinks an initially empty cut to the remaining exact original reference', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), sessions: complete().sessions.slice(0, 1) })
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds,
    'A partial canonical cut must reduce the original unknown count').toEqual([ids[1]])
  expect(element.querySelector('.notification-item[data-notice-id="current"] .notification-item__title')?.textContent).toContain('1 saved Session')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([ids[0]])
  f.retained()
})
it('startup observation confirms exact pending identities without inventing a running Agent or executing recovery', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture()
  await f.settle({ ...empty(), recoveryCandidates: candidates() })
  expect(useAppStore.getState().error, 'Known pending Session identity is not a Runtime observation failure').toBeNull()
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().sessions.every(session => session.processState !== 'running')).toBe(true)
  expect(useAppStore.getState().sessions.flatMap(session => session.kind === 'agent' ? [session.capabilities] : [])).toEqual(candidates().map(session => session.capabilities))
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation automatically re-reads the original Provider catalog and preserves another startup failure', async () => {
  const catalog = new AgentProviderRegistry().catalog()
  const providers = vi.mocked(api.providers.list).mockRejectedValueOnce(new Error('RPC ended before its response.')).mockImplementation(providerCatalogReader(catalog))
  vi.mocked(api.demands.list).mockRejectedValue(new Error('Independent Demand failure'))
  const f = await fixture()
  expect(f.warning).toContain('Provider catalog lookup did not complete')
  await f.settle(complete())
  expect(providers).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().providerCatalog, 'The complete actual catalog and its capabilities must survive retry').toEqual(catalog)
  expect(useAppStore.getState().error).toBeNull()
  expect(notificationEventRows(element).map(row => row.textContent).join('\n')).toContain('Independent Demand failure')
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  f.retained()
})
it('startup observation settles an original rejected Runtime read on the later canonical cut', async () => {
  const f = await fixture(false, undefined, { initialSnapshot: new Error('RPC ended before its response.') })
  await f.settle(complete())
  expect(useAppStore.getState().error, 'The original failed Runtime observation must settle without restarting').toBeNull()
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  f.retained()
})
it('startup observation rechecks quiet successful empty cuts until exact original facts appear without an event', async () => {
  const recover = vi.spyOn(api.sessions, 'recover'), providers = vi.mocked(api.providers.list)
  const f = await fixture()
  f.snapshot.mockResolvedValueOnce(empty()).mockResolvedValue(complete())
  await f.settle(empty())
  expect(useAppStore.getState().error).toBe(f.warning)
  await vi.waitFor(() => expect(useAppStore.getState().error,
    'A quiet original observation must settle when its later canonical facts become readable').toBeNull())
  expect(f.snapshot).toHaveBeenCalledTimes(4)
  expect(providers).toHaveBeenCalledTimes(1)
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation yields finitely for quiet persistent unknown facts then preserves the original surface', async () => {
  const f = await fixture()
  await f.settle(empty())
  await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledTimes(4))
  await new Promise(done => setTimeout(done, 100))
  expect(f.snapshot).toHaveBeenCalledTimes(4)
  expect(useAppStore.getState().error).toBe(f.warning)
  f.retained()
})
it('startup observation retries Provider failures with a bounded yield and renews only after connection restoration', async () => {
  const providers = vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider RPC is unavailable'))
  const f = await fixture()
  await f.settle(complete())
  await vi.waitFor(() => expect(providers).toHaveBeenCalledTimes(5))
  const reads = f.snapshot.mock.calls.length
  await new Promise(done => setTimeout(done, 100))
  expect(providers).toHaveBeenCalledTimes(5)
  expect(f.snapshot).toHaveBeenCalledTimes(reads)
  expect(useAppStore.getState().error).toContain('Provider RPC is unavailable')
  expect(useAppStore.getState().errorNoticeContext?.startupProviderCatalog).toBeDefined()
  const catalog = new AgentProviderRegistry().catalog()
  providers.mockImplementation(providerCatalogReader(catalog))
  await act(async () => { f.restore(); await new Promise(done => setTimeout(done, 0)) })
  expect(useAppStore.getState().error, 'Connection recovery must settle the original Provider producer without restarting').toBeNull()
  expect(useAppStore.getState().providerCatalog).toEqual(catalog)
  f.retained()
})
it('startup observation retains Provider retry after Runtime facts settle but preserves a later diagnostic', async () => {
  const providers = vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider RPC is unavailable'))
  const f = await fixture()
  await f.settle(complete())
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect(useAppStore.getState().errorNoticeContext?.startupProviderCatalog).toBeDefined()
  const originalContext = useAppStore.getState().errorNoticeContext
  await act(async () => useAppStore.getState().reportError('Later original document save failed', { kind: 'process-degraded' }))
  expect(useAppStore.getState().errorNoticeContext).toBe(originalContext)
  providers.mockImplementation(providerCatalogReader(new AgentProviderRegistry().catalog()))
  await new Promise(done => setTimeout(done, 100))
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  expect(notificationEventRows(element).map(row => row.textContent).join('\n')).toContain('Later original document save failed')
  f.retained()
})
it('startup observation cancels an outstanding Provider retry with the original reader', async () => {
  const providers = vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider RPC is unavailable'))
  const f = await fixture()
  await f.settle(complete())
  const reads = f.snapshot.mock.calls.length, catalogs = providers.mock.calls.length
  dispose?.(); dispose = undefined
  await new Promise(done => setTimeout(done, 100))
  expect(providers).toHaveBeenCalledTimes(catalogs)
  expect(f.snapshot).toHaveBeenCalledTimes(reads)
  f.retained()
})
it('startup observation retries a rejected Runtime observation finitely and recovers on its own connection event', async () => {
  const f = await fixture(false, undefined, { initialSnapshot: new Error('Initial Runtime RPC ended') })
  await f.settle(new Error('Runtime remains unavailable'))
  await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalledTimes(4))
  expect(useAppStore.getState().error).toContain('Initial Runtime RPC ended')
  const reads = f.snapshot.mock.calls.length
  await new Promise(done => setTimeout(done, 100))
  expect(f.snapshot).toHaveBeenCalledTimes(reads)
  f.snapshot.mockResolvedValue(complete())
  await act(async () => { f.restore(); await new Promise(done => setTimeout(done, 0)) })
  expect(useAppStore.getState().error).toBeNull()
  f.retained()
})
it('startup observation retries a Provider-only failure without manufacturing a missing Runtime notice', async () => {
  const catalog = new AgentProviderRegistry().catalog()
  vi.mocked(api.providers.list).mockRejectedValueOnce(new Error('Provider-only RPC ended')).mockImplementation(providerCatalogReader(catalog))
  const f = await fixture(false, undefined, { initialSnapshot: complete() })
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  await f.settle(complete())
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().providerCatalog).toEqual(catalog)) })
  expect(useAppStore.getState().error).toBeNull()
  f.retained()
})
it.each(['foreign-host', 'unavailable-host', 'missing-execution'] as const)('startup observation keeps a %s candidate genuinely unknown', async mode => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, mode === 'missing-execution' ? { spatial: 'missing-execution' } : undefined)
  const snapshot: RuntimeSnapshot = { ...empty(), recoveryCandidates: candidates().map(candidate => mode === 'foreign-host'
    ? { ...candidate, hostId: 'foreign-host' } : candidate), ...(mode === 'unavailable-host' ? { runtimeEndpointWarnings: [{
      hostId: 'local', step: 'Reading Runtime state', code: 'RUNTIME_UNAVAILABLE', availability: 'unverified',
      message: 'Original Runtime is unconfirmed', recovery: 'Wait for the original connection'
    }] } : {}) }
  await f.settle(snapshot)
  expect(useAppStore.getState().error).toBe(f.warning)
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation classifies retired history from original execution Host after a display move', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { movedDisplay: true })
  setHistorySources(ids.map(agentSessionId => ({ agentSessionId, hostId: 'local', state: 'retired' })))
  await f.settle(empty())
  expect(useAppStore.getState().error, 'Retirement belongs to the original execution Host, not the display Host').toBeNull()
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation keeps metadata failures visible without taking known healthy or pending capabilities', async () => {
  const f = await fixture()
  const warning = { hostId: 'local', scope: 'observation' as const, step: 'Reading Provider catalog', code: 'PROVIDER_READ_FAILED',
    availability: 'unverified' as const, message: 'Original catalog lookup is unconfirmed', recovery: 'The directory will be read again' }
  await f.settle({ ...empty(), sessions: [complete().sessions[0]!], recoveryCandidates: [candidates()[1]!],
    timelines: complete().timelines, runtimeEndpointWarnings: [warning] })
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  expect(useAppStore.getState().sessions[0]?.status.state, 'A metadata read failure cannot disconnect a confirmed healthy Agent').toBe('running')
  expect(useAppStore.getState().sessions[1]?.processState).not.toBe('running')
  f.retained()
})
it('startup observation reads partial Provider diagnostics after publishing the complete original workface', async () => {
  const catalog = new AgentProviderRegistry().catalog()
  const providers = vi.mocked(api.providers.list).mockImplementation(providerCatalogReader(catalog))
  const recover = vi.spyOn(api.sessions, 'recover'), stop = vi.spyOn(api.sessions, 'stop'), input = vi.spyOn(api.sessions, 'write')
  const f = await fixture(false, undefined, { initialSnapshot: complete(), foreignHost: true })
  expect(useAppStore.getState().loading, 'The background diagnostic cut must not hold the original workface').toBe(false)
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])
  const warning: RuntimeEndpointWarning = { hostId: 'foreign-host', scope: 'observation', availability: 'unverified',
    step: 'Reading Provider catalog', code: 'PROVIDER_READ_FAILED', message: 'Other Host catalog did not complete', recovery: 'Read this catalog again' }
  await f.settle({ ...complete(), runtimeEndpointWarnings: [warning] })
  expect(useAppStore.getState().runtimeEndpointWarnings, 'A partial successful catalog must expose its exact failed Host diagnostic').toEqual([warning])
  await act(async () => root.render(<Notices />))
  expect(element.textContent, 'The actual service window must consume this observation').toContain('Other Host: Reading Provider catalog')
  expect(useAppStore.getState().providerCatalog).toEqual(catalog)
  expect(providers).toHaveBeenCalledTimes(1)
  expect(recover).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation settles exact retired metadata only on successful Hosts in a partial history receipt', async () => {
  const f = await fixture(false, undefined, { foreignHost: true, secondExecutionHost: 'foreign-host' })
  const warning: RuntimeEndpointWarning = { hostId: 'foreign-host', scope: 'observation', availability: 'unverified',
    step: 'Reading retained History sources', code: 'HISTORY_READ_FAILED', message: 'Other history owner unavailable', recovery: 'Re-read that original history' }
  setHistorySources([{ agentSessionId: ids[0]!, hostId: 'local', state: 'retired' }], [warning])
  await f.settle(empty())
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds,
    'A partial metadata read must not confirm another failed Host').toEqual([ids[1]])
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  f.retained()
})
it('startup observation metadata notice cannot hide a separate Session connection failure', async () => {
  const f = await fixture()
  await f.settle(complete())
  const warning: RuntimeEndpointWarning = { hostId: 'local', scope: 'observation', availability: 'unverified',
    step: 'Reading Provider catalog', code: 'PROVIDER_READ_FAILED', message: 'Catalog owner did not answer', recovery: 'Read the catalog again' }
  useAppStore.setState({ runtimeEndpointWarnings: [warning], sessions: [{ ...complete().sessions[0]!,
    status: { state: 'disconnected', source: 'run-process', observedAt: 10, detail: 'Actual Session connection is unconfirmed' } }] })
  await act(async () => root.render(<Notices />))
  expect(element.textContent, 'A metadata warning must not hide the original Session connection notice').toContain('Reconnecting to this Agent')
  expect(useAppStore.getState().sessions[0]!.status.detail).toBe('Actual Session connection is unconfirmed')
  expect(element.textContent).toContain('Reading Provider catalog')
  f.retained()
})
it('startup observation re-reads only a restored Host Provider producer then reads its current diagnostic cut', async () => {
  const catalog = new AgentProviderRegistry().catalog(), providers = vi.mocked(api.providers.list).mockImplementation(providerCatalogReader(catalog))
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { initialSnapshot: complete() })
  const warning: RuntimeEndpointWarning = { hostId: 'local', scope: 'observation', availability: 'unverified',
    step: 'Reading Provider catalog', code: 'PROVIDER_READ_FAILED', message: 'Catalog did not complete', recovery: 'Read the catalog again' }
  await f.settle({ ...complete(), runtimeEndpointWarnings: [warning] })
  let refreshed = false
  providers.mockImplementation(providerCatalogReader(catalog, [], () => { refreshed = true }))
  f.snapshot.mockImplementation(async () => ({ ...complete(), runtimeEndpointWarnings: refreshed ? [] : [warning] }))
  await act(async () => { f.restore(); await new Promise(done => setTimeout(done, 80)) })
  expect(providers).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().runtimeEndpointWarnings, 'A successful metadata re-read needs its later canonical diagnostic cut').toEqual([])
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('startup observation preserves a partial Provider query cut across quiet snapshots and retries it finitely', async () => {
  const catalog = new AgentProviderRegistry().catalog()
  const warning: RuntimeEndpointWarning = { hostId: 'local', scope: 'observation', availability: 'unverified', step: 'Reading Provider catalog',
    code: 'EXECUTOR_HOST_CHANGED', message: 'The queried original Host was replaced before this catalog completed', recovery: 'Read the current owner catalog' }
  const providers = vi.mocked(api.providers.list).mockImplementation(providerCatalogReader(catalog, [warning]))
  const f = await fixture(false, undefined, { initialSnapshot: complete() })
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([warning])
  await f.settle(complete())
  await vi.waitFor(() => expect(providers).toHaveBeenCalledTimes(5))
  await new Promise(done => setTimeout(done, 500))
  expect(providers).toHaveBeenCalledTimes(5)
  expect(useAppStore.getState().runtimeEndpointWarnings,
    'A snapshot without a metadata warning must not erase an unresolved producer cut').toEqual([warning])
  providers.mockImplementation(providerCatalogReader(catalog))
  await act(async () => { f.restore(); await new Promise(done => setTimeout(done, 0)) })
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([])) })
  f.retained()
})
it('startup observation re-reads retained History after restore even when original Runtime facts were complete', async () => {
  const f = await fixture(false, undefined, { initialSnapshot: complete() })
  const warning: RuntimeEndpointWarning = { hostId: 'local', scope: 'observation', availability: 'unverified', step: 'Reading retained History sources',
    code: 'HISTORY_READ_FAILED', message: 'This history producer was not read', recovery: 'Re-read the same original history owner' }
  await f.settle({ ...complete(), runtimeEndpointWarnings: [warning] })
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  setHistorySources([])
  const reads = vi.mocked(api.sessions.historySources).mock.calls.length
  await act(async () => { f.restore(); await new Promise(done => setTimeout(done, 0)) })
  expect(api.sessions.historySources).toHaveBeenCalledTimes(reads + 1)
  expect(useAppStore.getState().runtimeEndpointWarnings,
    'Restored History metadata needs its own real read, independently of Runtime membership').toEqual([])
  f.retained()
})
it.each([false, true])('startup observation metadata diagnosis preserves explicit input and blocks background work only for unavailable Runtime (%s)', async unavailable => {
  const f = await fixture()
  const observation: RuntimeEndpointWarning = { hostId: 'local', scope: 'observation', availability: 'unverified',
    step: 'Reading retained History sources', code: 'HISTORY_READ_FAILED', message: 'History metadata did not complete', recovery: 'Read the history again' }
  const warnings = [observation, ...(unavailable ? [{ hostId: 'local', availability: 'unverified' as const,
    step: 'Reading Runtime sessions', code: 'RUNTIME_UNAVAILABLE', message: 'Original Runtime unavailable', recovery: 'Reconnect the original Runtime' }] : [])]
  // The observed history receipt preserves this same diagnostic; its metadata
  // warning does not acquire Runtime authority merely by sharing the Host.
  setHistorySources([], [observation])
  await f.settle({ ...complete(), runtimeEndpointWarnings: warnings })
  const condition = { expectedRun: complete().sessions[0]!.control.run, afterSubmissionId: null }
  useAppStore.setState({ agentSteerQueues: { [ids[0]!]: [{ operationId: 'original-explicit', text: 'Actual original input',
    runId: condition.expectedRun.runId, status: 'queued', promptCondition: condition }] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  await act(async () => useAppStore.getState().flushAgentSteerQueue(ids[0]!, unavailable ? undefined : 'original-explicit'))
  if (unavailable) {
    expect(submit).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBe(f.warning)
    expect(useAppStore.getState().agentSteerQueues[ids[0]!]![0]!.operationId).toBe('original-explicit')
  } else {
    expect(submit, 'A failed metadata observation must not take an existing healthy input capability').toHaveBeenCalledExactlyOnceWith(
      complete().sessions[0]!.control, 'Actual original input', 'original-explicit', condition, { allowUncertainTurn: true }, false, undefined, undefined, undefined, undefined, undefined)
  }
  f.retained()
})
it('initialization publishes complete overflow facts before the background diagnostic read', async () => {
  const f = await fixture(false, 'complete')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(2)
  f.retained()
})
it('partial overflow keeps the remaining original identity until later complete facts arrive', async () => {
  const f = await fixture(false, 'partial')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([ids[0]])
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toEqual({ sessionIds: [ids[1]], remainingMessage: null })
  expect(f.warning).toContain('1 saved Session reference(s) have no current Runtime facts')
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(3)
  f.retained()
})
it.each([false, true])('settles only the adopted complete original facts (buffered entry: %s)', async buffered => {
  const f = await fixture(buffered)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  f.retained()
})
it.each(['empty', 'unavailable-host', 'rejected'] as const)('keeps unresolved %s facts visible', async mode => {
  const f = await fixture()
  let snapshot: RuntimeSnapshot | Error = complete()
  if (mode === 'empty') snapshot = empty()
  if (mode === 'unavailable-host') snapshot = { ...complete(), runtimeEndpointWarnings: [{
    hostId: 'local', step: 'Reading Runtime sessions', code: 'CONTROL_UNAVAILABLE',
    message: 'The original endpoint has not confirmed its current Session facts.',
    recovery: 'Restore the original endpoint and refresh its observation.', availability: 'unverified'
  }] }
  if (mode === 'rejected') snapshot = new Error('Canonical read refused')
  await f.settle(snapshot)
  const current = useAppStore.getState().error
  expect(current).toContain(f.warning)
  if (mode === 'rejected') expect(current).toContain('Canonical read refused')
  expect(useAppStore.getState().lastError).toBe(current)
  expect(element.querySelectorAll('.notification-item[data-notice-id="current"]')).toHaveLength(1)
  expect(element.querySelector('.notification-item[data-notice-id="current"]')!.textContent).toContain(f.warning)
  f.retained()
})

it('confirms original Session membership while retaining each missing Timeline as a scoped observation', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), timelines: {} })
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect(useAppStore.getState().sessions.map(session => session.kind === 'agent' ? [session.id, session.timelineObservation?.code] : null))
    .toEqual(ids.map(id => [id, 'TIMELINE_OBSERVATION_FAILED']))
  f.retained()
})
it('settles observed original Session facts while keeping unverified Native ownership as its separate notice', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), runtimeOwnershipWarnings: ['local'] })
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['local'])
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  f.retained()
})
it('keeps same-ID facts from a foreign Host from settling the original saved Session notice', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { foreignHost: true })
  await f.settle({ ...complete(), sessions: complete().sessions.map(session => ({ ...session, hostId: 'foreign-host',
    control: { ...session.control, hostId: 'foreign-host' } })) })
  expect(useAppStore.getState().error, 'Another Host cannot confirm the original same-ID Session facts').toBe(f.warning)
  expect(useAppStore.getState().lastError).toBe(f.warning)
  expect(element.querySelectorAll('.notification-item[data-notice-id="current"]')).toHaveLength(1)
  expect(useAppStore.getState().sessions.every(session => !ids.includes(session.id) || session.control.hostId === 'local'),
    'A foreign same-ID Session must never lend its input control to the original Region').toBe(true)
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it.each(['initial', 'background'] as const)('startup observation rejects configured foreign same-ID fresh native recovery on the %s cut', async cut => {
  const now = Date.now(), foreign = { ...empty(), recoveryCandidates: candidates().map(candidate => ({ ...candidate,
    hostId: 'foreign-host', control: { ...candidate.control, hostId: 'foreign-host' },
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now } })) }
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { foreignHost: true, ...(cut === 'initial' ? { initialSnapshot: foreign } : {}) })
  if (cut === 'background') await f.settle(foreign)
  expect(recover, 'A configured foreign same-ID native fact cannot authorize original recovery').not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions.some(session => ids.includes(session.id)),
    'The original Region must retain unknown identity rather than adopt a foreign candidate').toBe(false)
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds).toEqual(ids)
  f.retained()
})
it('startup observation keeps original input controls and Regions beside an unrelated healthy fact after rejecting a foreign same-ID cut', async () => {
  const f = await fixture(false, undefined, { foreignHost: true })
  const original = complete().sessions
  useAppStore.setState({ sessions: original })
  const neighbor = composerSession('unrelated-healthy')
  await f.settle({ ...empty(), sessions: [neighbor, ...original.map(session => ({ ...session, hostId: 'foreign-host',
    control: { ...session.control, hostId: 'foreign-host' } }))], timelines: { ...complete().timelines,
    [neighbor.id]: { agentSessionId: neighbor.id, revision: 1, items: [] } } })
  expect(useAppStore.getState().sessions.slice(0, 2).map(session => session.control),
    'A rejected saved fact is not a missing or retired original Session').toEqual(original.map(session => session.control))
  expect(useAppStore.getState().sessions[2]?.id).toBe(neighbor.id)
  expect(useAppStore.getState().error).toBe(f.warning)
  f.retained()
})
it('startup observation excludes foreign same-ID native Timeline from the initial original workface', async () => {
  const foreign: RuntimeSnapshot = { ...complete(), sessions: complete().sessions.map(session => ({ ...session, hostId: 'foreign-host',
    control: { ...session.control, hostId: 'foreign-host' } })), timelines: Object.fromEntries(ids.map(agentSessionId => [agentSessionId, {
      agentSessionId, revision: 3, items: [{ id: 'foreign-native-fact', agentSessionId, kind: 'assistant_message', status: 'complete',
        source: 'native-hook', createdAt: 3, updatedAt: 3, title: 'Other Host reply', content: 'Foreign reply cannot settle original input' }]
    }])) }
  const f = await fixture(false, undefined, { foreignHost: true, initialSnapshot: foreign })
  expect(ids.some(id => useAppStore.getState().timelines[id] !== undefined),
    'An unowned same-ID Timeline must never enter original startup conversation or delivery receipts').toBe(false)
  expect(useAppStore.getState().sessions.some(session => ids.includes(session.id))).toBe(false)
  f.retained()
})
it('settles the original execution Host facts after a cross-Host display move', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { movedDisplay: true })
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.hostId)).toEqual(['local', 'local'])
  expect(useAppStore.getState(), 'Display placement cannot replace the original execution Host').toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it.each(['absent', 'missing-execution'] as const)('keeps original execution Host unknown when Core spatial facts are %s', async mode => {
  const f = await fixture(false, undefined, { spatial: mode })
  await f.settle(complete())
  expect(useAppStore.getState().error).toBe(f.warning)
  expect(element.querySelectorAll('.notification-item[data-notice-id="current"]')).toHaveLength(1)
  f.retained()
})
it('does not let an unrelated Host warning hold this resolved notice', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), runtimeOwnershipWarnings: ['unrelated-host'] })
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['unrelated-host'])
  expect(useAppStore.getState().error).toBeNull()
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  f.retained()
})
it.each([false, true])('keeps remaining startup issues after acknowledging the original notice (acknowledged: %s)', async dismissed => {
  vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider discovery unavailable'))
  vi.mocked(api.demands.list).mockRejectedValue(new Error('Demand filesystem unavailable'))
  const f = await fixture()
  const remainder = useAppStore.getState().errorNoticeContext!.startupSessionSnapshot!.remainingMessage
  expect(remainder).toContain('Provider discovery unavailable')
  expect(notificationEventRows(element).map(row => row.textContent).join('\n')).toContain('Demand filesystem unavailable')
  if (dismissed) { await toggleNotificationCenter(element, 'open'); await toggleNotificationCenter(element, 'closed') }
  await f.settle(complete())
  expect(useAppStore.getState()).toMatchObject({ error: remainder, lastError: remainder, errorDismissed: false })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).not.toBeNull()
  expect(notificationTrigger(element).getAttribute('aria-expanded')).toBe('false')
  await toggleNotificationCenter(element, 'open')
  expect(element.querySelector('.notification-item[data-notice-id="current"]')!.textContent).toContain(remainder)
  expect(element.querySelector('.notification-item[data-notice-id="current"]')!.textContent).not.toContain('returned no Session facts')
  f.retained()
})
it.each(['same-text', 'different-text'] as const)('settles the original startup owner without clearing a later %s event', async mode => {
  const f = await fixture()
  const originalContext = useAppStore.getState().errorNoticeContext
  const message = mode === 'same-text' ? f.warning : 'Later document save failed'
  await act(async () => useAppStore.getState().reportError(new Error(message), { kind: 'process-degraded' }))
  expect(useAppStore.getState().errorNoticeContext).toBe(originalContext)
  expect(useAppStore.getState()).toMatchObject({ error: f.warning, lastError: f.warning })
  expect(useAppStore.getState().notificationEvents[0]?.context).toEqual({ kind: 'process-degraded' })
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(notificationEventRows(element)).toHaveLength(1)
  expect(notificationEventRows(element)[0]!.textContent).toContain(message)
  f.retained()
})
it('removes a current issue only after its owner confirms resolution', async () => {
  const f = await fixture()
  await toggleNotificationCenter(element, 'open'); await toggleNotificationCenter(element, 'closed')
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).not.toBeNull()
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null })
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).toBeNull()
  f.retained()
})
it.each([false, true])('an acknowledged startup notice cannot swallow a later ordinary same-text error (explicit kind: %s)', async explicitKind => {
  const f = await fixture()
  await toggleNotificationCenter(element, 'open'); await toggleNotificationCenter(element, 'closed')
  expect(element.querySelector('.notification-item[data-notice-id="current"]')).not.toBeNull()
  const originalContext = useAppStore.getState().errorNoticeContext
  await act(async () => useAppStore.getState().reportError(new Error(f.warning), explicitKind ? { kind: 'indeterminate' } : undefined))
  expect(useAppStore.getState().errorNoticeContext).toBe(originalContext)
  expect(notificationEventRows(element)).toHaveLength(1)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
  expect(notificationEventRows(element)[0]!.textContent).toContain(f.warning)
  f.retained()
})


it('restores names before Runtime facts using original execution Host even after display moved', async () => {
  const metadata: AgentSessionNameMetadata[] = ids.map((agentSessionId,index) => ({agentSessionId,hostId:'local',providerId:'codex',executorId:'codex',workspacePath:_hygiene_fixturePath("repo"),label:index ? 'Retired · Project' : 'Codex · Project',state:index ? 'retired' : 'active'}))
  metadata.push({...metadata[0]!,hostId:'foreign-host',label:'Wrong Host'})
  const f = await fixture(false,undefined,{movedDisplay:true,initialSnapshot:{...empty(),sessionNameMetadata:metadata}})
  let commits = 0
  function OriginalNames() {
    const tab = useAppStore(state => state.tabs['tab-original-a'])!
    const sessions = useWorkbenchTabSessions(tab), names = useWorkbenchTabNameMetadata(tab)
    commits += 1
    return <div data-original-names>{workbenchTabDisplayName(tab,sessions,{}, {},names)} / {regionSurfaceLabel(tab.regions['region-original-a']!,sessions,names)}</div>
  }
  await act(async () => root.render(<OriginalNames />))
  expect(element.querySelector('[data-original-names]')?.textContent).toBe('Codex · Project / Codex · Project')
  expect(useAppStore.getState().sessions).toEqual([])
  expect(useAppStore.getState().recoveryCandidates).toEqual([])
  expect(useAppStore.getState().errorNoticeContext).not.toBeNull()
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(persisted).not.toHaveProperty('sessionNameMetadata')
  expect(persisted).not.toHaveProperty('sessionNameMetadataWarning')
  const before = commits
  await act(async () => useAppStore.setState({sessions:[composerSession('unrelated')]}))
  expect(commits).toBe(before)
  await f.settle({...complete(),sessionNameMetadata:metadata,sessions:[{...composerSession(ids[0]),label:'Canonical · Project'}]})
  expect(element.querySelector('[data-original-names]')?.textContent).toBe('Canonical · Project / Canonical · Project')
})
