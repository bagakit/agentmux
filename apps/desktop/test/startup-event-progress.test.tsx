// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

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
  type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: 2 }
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
let recover: ReturnType<typeof vi.spyOn>, stop: ReturnType<typeof vi.spyOn>, send: ReturnType<typeof vi.spyOn>
let input: HTMLTextAreaElement
beforeEach(async () => {
  releases = []; initializing = undefined; dispose = undefined
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
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
  original = { tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) },
    agentFocus: { execution: { sessionId: ids[0]!, history: [{ sessionId: ids[0]!, focusedAt: 1 }] }, pmo: { sessionId: null } },
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

it('publishes the durable workface after one compensating read even when every completed startup read overflows', async () => {
  const secondRead = deferred<void>(), background = deferred<RuntimeSnapshot>()
  releases.push(() => background.resolve(complete()))
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementationOnce(async () => { storm(); return complete() })
    .mockImplementationOnce(async () => { storm(500); secondRead.resolve(); return complete() })
    .mockReturnValue(background.promise)
  initializing = useAppStore.getState().initialize()
  await secondRead.promise; await ticks()
  expect(useAppStore.getState().loading, 'continuous events must not keep the original workface behind a third read').toBe(false)
  expect(snapshot).toHaveBeenCalledTimes(3)
  retained()
  dispose = await initializing
  // A compensation-only observation cannot broaden startup recovery authorization.
  // This later canonical cut would qualify for the existing recent-done resume policy.
  const now = Date.now()
  vi.mocked(api.sessions.recover).mockRejectedValue(new Error('Observation must not request execution'))
  background.resolve({ ...complete(), sessions: [
    { ...composerSession(ids[0]!), processState: 'exited',
      status: { state: 'done', source: 'native-hook', observedAt: now },
      semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now } },
    composerSession(ids[1]!)
  ] })
  await ticks()
  expect(useAppStore.getState().sessions.find(session => session.id === ids[0])!.processState).toBe('exited')
  retained()
})

it('adopts each overflowing background pass and compensates quiet history while a neighbor remains busy', async () => {
  await boot()
  vi.useFakeTimers()
  const read = deferred<RuntimeSnapshot>(), later = deferred<RuntimeSnapshot>()
  releases.push(() => read.resolve(complete()), () => later.resolve(complete()))
  const snapshot = vi.mocked(api.sessions.snapshot).mockReturnValueOnce(read.promise).mockReturnValue(later.promise)
  const history: AgentTimelineSnapshot = { agentSessionId: ids[0]!, revision: 3, items: [item(ids[0]!, 2), item(ids[0]!, 3)] }
  const timeline = vi.spyOn(api.sessions, 'timeline').mockResolvedValue(history)
  listener(reconnect())
  listener(status(ids[0]!, 50, 'done')); listener(timelineEvent(2)); listener(timelineEvent(3)); storm()
  read.resolve(complete()); await ticks()
  const quiet = useAppStore.getState().sessions.find(session => session.id === ids[0])!
  expect(quiet.status).toMatchObject({ state: 'done', observedAt: 50 })
  expect(useAppStore.getState().sessions.find(session => session.id === ids[1])!.status.observedAt).toBe(356)
  expect(timeline).toHaveBeenCalledWith(composerSession(ids[0]!).control)
  expect(useAppStore.getState().timelines[ids[0]!]).toEqual(history)
  expect(snapshot).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(49); expect(snapshot).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); expect(snapshot).toHaveBeenCalledTimes(3)
  retained()
})

it('rechecks overflow after history metadata awaits and keeps the scoped notice until a loss-free canonical cut', async () => {
  const canonical = deferred<RuntimeSnapshot>(), metadata = deferred<Awaited<ReturnType<typeof api.sessions.historySources>>>()
  const repair = deferred<RuntimeSnapshot>()
  releases.push(() => canonical.resolve(complete()), () => metadata.resolve([]), () => repair.resolve(complete()))
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockResolvedValueOnce(empty()).mockReturnValueOnce(canonical.promise).mockReturnValue(repair.promise)
  vi.mocked(api.sessions.historySources).mockReturnValue(metadata.promise)
  dispose = await useAppStore.getState().initialize()
  const notice = useAppStore.getState().errorNoticeContext
  expect(notice?.startupSessionSnapshot?.sessionIds).toEqual(ids)
  vi.useFakeTimers()
  canonical.resolve(complete()); await ticks()
  expect(api.sessions.historySources).toHaveBeenCalledTimes(1)
  listener(status(ids[0]!, 60, 'done')); storm()
  metadata.resolve([]); await ticks()
  expect(useAppStore.getState().sessions.find(session => session.id === ids[0])!.status.state).toBe('done')
  expect(useAppStore.getState().errorNoticeContext, 'truncated metadata wait is not a complete observation').toBe(notice)
  expect(snapshot).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(50); expect(snapshot).toHaveBeenCalledTimes(3)
  repair.resolve(complete()); await ticks()
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
  retained()
})

it('uses a single in-flight read and capped backoff under successive pressured cuts, then cancels on disposal', async () => {
  await boot()
  vi.useFakeTimers()
  const reads = Array.from({ length: 4 }, () => deferred<RuntimeSnapshot>())
  releases.push(...reads.map(read => () => read.resolve(complete())))
  let index = 0, inFlight = 0, maximum = 0
  const snapshot = vi.mocked(api.sessions.snapshot).mockImplementation(() => {
    inFlight++; maximum = Math.max(maximum, inFlight)
    return reads[index++]!.promise.finally(() => { inFlight-- })
  })
  listener(reconnect())
  for (let pass = 0; pass < 3; pass++) {
    for (let count = 0; count < 12; count++) listener(reconnect())
    storm(1000 + pass * 1000)
    expect(inFlight).toBe(1)
    reads[pass]!.resolve(complete()); await ticks()
    expect(useAppStore.getState().sessions.find(session => session.id === ids[1])!.status.observedAt).toBe(1256 + pass * 1000)
    const delay = 50 * 2 ** pass
    await vi.advanceTimersByTimeAsync(delay - 1); expect(index).toBe(pass + 1)
    await vi.advanceTimersByTimeAsync(1); expect(index).toBe(pass + 2)
  }
  expect(maximum).toBe(1)
  const before = useAppStore.getState().sessions
  dispose!(); dispose = undefined
  reads[3]!.resolve({ ...complete(), sessions: complete().sessions.map(session => ({ ...session, label: 'stale disposed read' })) })
  await ticks(); await vi.advanceTimersByTimeAsync(5000)
  expect(useAppStore.getState().sessions).toBe(before)
  expect(snapshot).toHaveBeenCalledTimes(5)
  retained()
})
