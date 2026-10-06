import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { AgentTimelineItem, AgentTimelineSnapshot, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { RuntimeEvent, RuntimeSnapshot, SessionHistorySourcesObservation, RuntimeEndpointWarning } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
const { useAppStore } = await import(process.env.AGENTMUX_TEST_STORE_ENTRY ?? '../src/renderer/src/store') as typeof import('../src/renderer/src/store')
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const initial = useAppStore.getState()
const ids = ['quiet-a', 'busy-b']
const empty = (): RuntimeSnapshot => ({ sessions: [], recoveryCandidates: [], timelines: {} })
const complete = (): RuntimeSnapshot => ({ ...empty(), sessions: ids.map(id => composerSession(id)),
  timelines: Object.fromEntries(ids.map(id => [id, { agentSessionId: id, revision: 1, items: [] }])) })
const status = (id: string, observedAt: number, state: 'working' | 'done' = 'working'): RuntimeEvent => ({
  type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: id, state,
    evidence: { source: 'native-hook', observedAt } }
})
const reconnect = (): RuntimeEvent => ({ type: 'core', hostId: 'local', event: {
  type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 2) }
} })
const item = (id: string, revision: number): AgentTimelineItem => ({ id: `fact-${revision}`, agentSessionId: id,
  kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: revision, updatedAt: revision,
  title: `Original fact ${revision}`, content: `Kept history ${revision}` })
const timelineEvent = (revision: number): RuntimeEvent => ({ type: 'core', hostId: 'local', event: {
  type: 'agent-timeline', agentSessionId: ids[0]!, revision, mutation: { type: 'append', agentSessionId: ids[0]!, item: item(ids[0]!, revision) },
  evidence: { source: 'native-hook', observedAt: revision }
} })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function ticks() { for (let count = 0; count < 24; count++) await Promise.resolve() }
let directory: string, dispose: (() => void) | undefined, listener: (event: RuntimeEvent) => void
let releases: Array<() => void>, initializing: Promise<(() => void)> | undefined
let original: Pick<ReturnType<typeof useAppStore.getState>, 'tabs' | 'layouts' | 'agentFocus' | 'agentComposerDrafts'>
let recover: MockInstance<typeof api.sessions.recover>, stop: MockInstance<typeof api.sessions.stop>, send: MockInstance<typeof api.sessions.submitPrompt>
let input: HTMLTextAreaElement
let historyObservation: Promise<SessionHistorySourcesObservation>
async function readHistory(options: { observation: true }): Promise<SessionHistorySourcesObservation>
async function readHistory(): Promise<AgentSessionHistoryDescriptor[]>
async function readHistory(options?: { observation: true }): Promise<SessionHistorySourcesObservation | AgentSessionHistoryDescriptor[]> { return options ? historyObservation : [] }
beforeEach(async () => {
  releases = []; initializing = undefined; dispose = undefined
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  historyObservation = Promise.resolve({ sources: [], warnings: [] })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(readHistory)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(callback => { listener = callback; return () => {} })
  recover = vi.spyOn(api.sessions, 'recover'); stop = vi.spyOn(api.sessions, 'stop'); send = vi.spyOn(api.sessions, 'submitPrompt')
  directory = await mkdtemp(join(tmpdir(), 'agentmux-startup-progress-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(callback => spatial.subscribe(callback))
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    kind: 'agent', regionId: `region-${id}`, workspaceId: 'workspace', sessionId: id, phase: 'attached'
  })]))
  const spaceId = directoryIdentity('local', _hygiene_fixturePath("repo"))
  for (const tab of Object.values(tabs)) tab.space = { spaceId, zoneId: workspaceZoneId(spaceId, 'workspace') }
  original = { tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) },
    agentFocus: { execution: { sessionId: ids[0]!, history: [{ sessionId: ids[0]!, focusedAt: _reshape_fixtureEpoch(0, 0, 1) }] }, pmo: { sessionId: null } },
    agentComposerDrafts: { 'quiet-a': '原来的未发送草稿', 'busy-b': 'Original neighbor draft' } }
  useAppStore.setState({ restoredWorkbench: { tabs, layouts: original.layouts }, loading: true,
    agentFocus: original.agentFocus, agentComposerDrafts: original.agentComposerDrafts, activeWorkspaceId: 'workspace' })
  const state = useAppStore.getState()
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...state, config: composerConfig,
    tabs: Object.fromEntries(Object.values(tabs).map(tab => [tab.id, hydratePersistedTab(tab)])), layouts: original.layouts,
    sessions: ids.map(id => composerSession(id)) }, []) })
  input = document.createElement('textarea'); document.body.append(input)
  input.value = 'Original input under observation'; input.focus(); input.setSelectionRange(3, 12)
})
afterEach(async () => {
  // Restore ownership even when a deliberately loaded mutant fails an assertion.
  dispose?.()
  for (const release of releases) release()
  if (initializing) (await initializing)()
  await ticks()
  vi.useRealTimers(); input?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
function retained() {
  const state = useAppStore.getState()
  expect({ tabs: state.tabs, layouts: state.layouts, agentFocus: state.agentFocus, agentComposerDrafts: state.agentComposerDrafts }).toEqual(original)
  expect(input.value).toBe('Original input under observation')
  expect([input.selectionStart, input.selectionEnd, document.activeElement === input]).toEqual([3, 12, true])
  expect(recover).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
}
function storm(start = 100) { for (let index = 0; index < 257; index++) listener(status(ids[1]!, start + index)) }
async function boot(snapshot: RuntimeSnapshot = complete()) {
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(snapshot)
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  retained()
}

const publicationStep = 'Publishing control endpoint'
const publicationWarning: RuntimeEndpointWarning = { hostId: 'local', step: publicationStep, scope: 'observation', availability: 'connected', code: 'CONTROL_ENDPOINT_PUBLICATION_UNAVAILABLE', message: 'Original publication failure', recovery: 'The original owner retries automatically.' }
const metadataWarning: RuntimeEndpointWarning = { ...publicationWarning, step: 'Reading Provider catalog', code: 'CATALOG_OBSERVATION_FAILED' }
function publicationEvent(warning: RuntimeEndpointWarning | null): RuntimeEvent {
  const evidence = { source: 'agentmux' as const, observedAt: _reshape_fixtureEpoch(0, 0, 10) }
  return { type: 'core', hostId: 'local', event: warning
    ? { type: 'control-endpoint-state', state: 'unavailable', diagnostic: { code: warning.code, message: warning.message }, evidence }
    : { type: 'control-endpoint-state', state: 'available', evidence },
    endpointObservation: { step: publicationStep, warning } }
}

it('keeps the exact connection observation origin protocol receipt through normal ingress and buffered overflow without clearing the other boundary', async () => {
  const unknown: RuntimeEndpointWarning = { ...publicationWarning, step: 'Connection observation source unconfirmed',
    observationOrigin: null, availability: 'unverified', code: 'CONTROL_PROTOCOL_ERROR' }
  const native: RuntimeEndpointWarning = { ...unknown, step: 'Core to ctxmux connection',
    observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' } }
  const semantic: RuntimeEndpointWarning = { ...native, step: 'Core control connection',
    observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' } }
  const clear: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored',
    observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 10) } },
    endpointObservation: { step: native.step, warning: null, resolvedSteps: ['Connection observation source unconfirmed'] } }
  await boot({ ...complete(), runtimeEndpointWarnings: [unknown, native, semantic] })
  const read = deferred<RuntimeSnapshot>(), later = deferred<RuntimeSnapshot>()
  releases.push(() => read.resolve(complete()), () => later.resolve(complete()))
  vi.spyOn(api.sessions, 'snapshot').mockReturnValueOnce(read.promise).mockReturnValue(later.promise)
  listener(clear)
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([semantic])
  await ticks(); listener(clear); storm()
  read.resolve({ ...complete(), runtimeEndpointWarnings: [unknown, native, semantic] }); await ticks()
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([semantic])
  retained()
})

it('keeps a publication clear through startup overflow without clearing the older metadata warning', async () => {
  const first = deferred<RuntimeSnapshot>(), second = deferred<RuntimeSnapshot>(), background = deferred<RuntimeSnapshot>()
  releases.push(() => first.resolve(complete()), () => second.resolve(complete()), () => background.resolve(complete()))
  vi.spyOn(api.sessions, 'snapshot').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValue(background.promise)
  initializing = useAppStore.getState().initialize()
  await ticks()
  listener(publicationEvent(publicationWarning)); storm()
  first.resolve({ ...complete(), runtimeEndpointWarnings: [metadataWarning, publicationWarning] }); await ticks()
  await vi.waitFor(() => expect(api.sessions.snapshot).toHaveBeenCalledTimes(2))
  listener(publicationEvent(null)); storm(500)
  second.resolve({ ...complete(), runtimeEndpointWarnings: [metadataWarning, publicationWarning] })
  dispose = await initializing; await ticks()
  expect(useAppStore.getState().runtimeEndpointWarnings, 'the buffered clear must remove only the publication step').toEqual([metadataWarning])
  retained()
})

it('keeps a publication clear through background membership overflow without clearing another observation', async () => {
  await boot({ ...complete(), runtimeEndpointWarnings: [metadataWarning] })
  listener(publicationEvent(publicationWarning))
  expect(useAppStore.getState().runtimeEndpointWarnings).toEqual([metadataWarning, publicationWarning])
  const read = deferred<RuntimeSnapshot>(), later = deferred<RuntimeSnapshot>()
  releases.push(() => read.resolve(complete()), () => later.resolve(complete()))
  vi.spyOn(api.sessions, 'snapshot').mockReturnValueOnce(read.promise).mockReturnValue(later.promise)
  listener(reconnect()); await ticks()
  listener(publicationEvent(null)); storm()
  read.resolve({ ...complete(), runtimeEndpointWarnings: [metadataWarning, publicationWarning] }); await ticks()
  expect(useAppStore.getState().runtimeEndpointWarnings, 'the latest exact-step clear must survive the membership buffer').toEqual([metadataWarning])
  retained()
})
