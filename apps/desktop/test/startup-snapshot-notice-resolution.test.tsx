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
import type { AgentSessionNameMetadata, AppConfig, RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { useWorkbenchTabNameMetadata, useWorkbenchTabSessions } from '../src/renderer/src/lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../src/renderer/src/lib/workbench-tab-presentation'
import { regionSurfaceLabel } from '../src/renderer/src/lib/region-display-name'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'

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
function Notices() {
  const state = useAppStore()
  return <TransientErrorNotice error={state.error} dismissed={state.errorDismissed} lastError={state.lastError}
    summary={state.errorNoticeContext?.summary} onDismiss={state.dismissError} onReopen={state.reopenError} kind={state.errorNoticeContext?.kind ?? 'indeterminate'} />
}
let root: Root, element: HTMLDivElement, dispose: (() => void) | undefined, releasePending: (() => void) | undefined
let spatialDirectory: string, spatial: AgentMuxSpatialStateStore
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  spatialDirectory = await mkdtemp(join(tmpdir(), 'agentmux-startup-session-facts-'))
  spatial = new AgentMuxSpatialStateStore(join(spatialDirectory, 'spatial-state.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
async function saveOriginalWorkbench(config = composerConfig, execution = true) {
  const state = useAppStore.getState(), original = state.restoredWorkbench!
  const graph = desktopSpatialGraph({ ...state, config,
    tabs: Object.fromEntries(Object.values(original.tabs).map(tab => [tab.id, hydratePersistedTab(tab)])), layouts: original.layouts,
    sessions: execution ? ids.map(id => composerSession(id)) : [] }, [])
  const saved = await spatial.commit({ expectedRevision: 0, graph })
  expect((await spatial.read())?.graph).toEqual(saved.graph)
  // The current Core projection supplies exact Space/Zone metadata. Preserve that
  // original receipt in the fixture rather than compare against a pre-Core Tab shape.
  const originalProjection = desktopWorkbenchFromSpatial(saved.graph)
  for (const tab of Object.values(original.tabs)) Object.assign(tab, { space: originalProjection.tabs[tab.id]!.space })
  expect(saved.graph.regions.map(region => region.agentSessionId)).toEqual(ids)
  expect(saved.graph.regions.map(region => region.execution?.hostId ?? null)).toEqual(execution ? ['local', 'local'] : [null, null])
}
async function missingReferencesFixture(catalogue: AgentSessionHistoryDescriptor[]) {
  const tabs = Object.fromEntries(ids.map(id => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    kind: 'agent', regionId: `region-${id}`, workspaceId: 'workspace', sessionId: id, phase: 'attached'
  })]))
  useAppStore.setState({ restoredWorkbench: { tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) } },
    loading: true, activeWorkspaceId: 'workspace' })
  await saveOriginalWorkbench()
  vi.mocked(api.sessions.historySources).mockResolvedValue(catalogue)
  const unrelated = { ...empty(), sessions: [composerSession('healthy-neighbor')],
    timelines: { 'healthy-neighbor': { agentSessionId: 'healthy-neighbor', revision: 1, items: [] } } }
  let finish!: (snapshot: RuntimeSnapshot) => void
  const deferred = new Promise<RuntimeSnapshot>(resolve => { finish = resolve })
  releasePending = () => finish(unrelated)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValueOnce(unrelated).mockReturnValue(deferred)
  const recover = vi.spyOn(api.sessions, 'recover')
  await act(async () => { root.render(<Notices />); dispose = await useAppStore.getState().initialize() })
  return { tabs, recover, settle: async () => { await act(async () => { finish(unrelated); await new Promise(done => setTimeout(done, 0)) }) } }
}

it('classifies original closed history before counting missing Runtime references and settles a removed reference', async () => {
  const f = await missingReferencesFixture([{ agentSessionId: ids[0]!, hostId: 'local', state: 'retired' }])
  expect(useAppStore.getState().error).toContain('1 saved Session reference(s) have no current Runtime facts')
  expect((element.querySelector('.error-notice__summary')?.textContent ?? '')).toContain('1 saved Session')
  expect(element.querySelector('.error-notice__original')?.textContent).toContain('no current Runtime facts')
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
  vi.mocked(api.sessions.historySources).mockResolvedValue(ids.map(agentSessionId => ({ agentSessionId, hostId: 'local', state: 'retired' })))
  await f.settle()
  expect(useAppStore.getState().error).toContain('Unrelated Provider discovery failure')
  expect(useAppStore.getState().error).not.toContain('no current Runtime facts')
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect((element.querySelector('.error-notice__summary')?.textContent ?? '')).toContain('Startup checks')
  expect((element.querySelector('.error-notice__summary')?.textContent ?? '')).not.toContain('saved Session')
  expect(element.querySelector('.error-notice__original')?.textContent).toContain('Unrelated Provider discovery failure')
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
  foreignHost?: boolean; movedDisplay?: boolean; spatial?: 'absent' | 'missing-execution'; initialSnapshot?: RuntimeSnapshot
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
  if (options.spatial !== 'absent') await saveOriginalWorkbench(config, options.spatial !== 'missing-execution')
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
    return options.initialSnapshot ?? empty()
  })
  if (overflow) snapshot.mockResolvedValueOnce(overflow === 'complete'
    ? complete() : { ...complete(), sessions: complete().sessions.slice(0, 1) })
  snapshot.mockReturnValue(pending)
  await act(async () => { root.render(<Notices />); dispose = await useAppStore.getState().initialize() })
  expect(useAppStore.getState().loading).toBe(false)
  expect(snapshot).toHaveBeenCalledTimes(overflow === 'partial' ? 3 : 2)
  if (overflow === 'complete') {
    expect(useAppStore.getState().errorNoticeContext).toBeNull()
    expect(element.querySelector('.error-notice')).toBeNull()
  } else {
    expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot?.sessionIds).toEqual(ids)
    expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
    expect(element.querySelector('.error-notice')!.textContent).toContain('Runtime Session snapshot returned no Session facts')
  }
  const warning = useAppStore.getState().error!
  const settle = async (result: RuntimeSnapshot | Error) => {
    await act(async () => { result instanceof Error ? reject(result) : resolve(result); await new Promise(done => setTimeout(done, 0)) })
  }
  const retained = () => {
    expect(useAppStore.getState().tabs).toEqual(original.tabs)
    expect(useAppStore.getState().layouts).toEqual(original.layouts)
    expect(useAppStore.getState().agentFocus).toEqual(original.agentFocus)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(original.agentComposerDrafts)
  }
  retained()
  return { settle, retained, warning, snapshot }
}
it('initialization consumes complete overflow facts without another read', async () => {
  const f = await fixture(false, 'complete')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(2)
  f.retained()
})
it('partial overflow keeps the original scope until later complete facts arrive', async () => {
  const f = await fixture(false, 'partial')
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual([ids[0]])
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toEqual({ sessionIds: ids, remainingMessage: null })
  expect(f.warning).not.toContain('saved Session reference(s) have no current Runtime facts')
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  expect(f.snapshot).toHaveBeenCalledTimes(3)
  f.retained()
})
it.each([false, true])('settles only the adopted complete original facts (buffered entry: %s)', async buffered => {
  const f = await fixture(buffered)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  f.retained()
})
it.each(['empty', 'partial', 'candidate', 'unavailable-host', 'rejected', 'invalid-timeline'] as const)('keeps unresolved %s facts visible', async mode => {
  const f = await fixture()
  let snapshot: RuntimeSnapshot | Error = complete()
  if (mode === 'empty') snapshot = empty()
  if (mode === 'partial') snapshot = { ...complete(), sessions: complete().sessions.slice(0, 1) }
  if (mode === 'candidate') snapshot = { ...empty(), recoveryCandidates: complete().sessions.map(session => ({
    ...session, agentSessionId: session.id, providerId: 'codex', executorId: 'codex', run: session.control.run
  })) }
  if (mode === 'unavailable-host') snapshot = { ...complete(), runtimeEndpointWarnings: [{
    hostId: 'local', step: 'Reading Runtime sessions', code: 'CONTROL_UNAVAILABLE',
    message: 'The original endpoint has not confirmed its current Session facts.',
    recovery: 'Restore the original endpoint and refresh its observation.', availability: 'unverified'
  }] }
  if (mode === 'rejected') snapshot = new Error('Canonical read refused')
  if (mode === 'invalid-timeline') snapshot = { ...complete(), timelines: {} }
  await f.settle(snapshot)
  expect(useAppStore.getState().error).toBe(f.warning)
  expect(useAppStore.getState().lastError).toBe(f.warning)
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  expect(element.querySelector('.error-notice')!.textContent).toContain(f.warning)
  f.retained()
})
it('settles observed original Session facts while keeping unverified Native ownership as its separate notice', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), runtimeOwnershipWarnings: ['local'] })
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['local'])
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  f.retained()
})
it('keeps same-ID facts from a foreign Host from settling the original saved Session notice', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { foreignHost: true })
  await f.settle({ ...complete(), sessions: complete().sessions.map(session => ({ ...session, hostId: 'foreign-host',
    control: { ...session.control, hostId: 'foreign-host' } })) })
  expect(useAppStore.getState().error, 'Another Host cannot confirm the original same-ID Session facts').toBe(f.warning)
  expect(useAppStore.getState().lastError).toBe(f.warning)
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it('settles the original execution Host facts after a cross-Host display move', async () => {
  const recover = vi.spyOn(api.sessions, 'recover')
  const f = await fixture(false, undefined, { movedDisplay: true })
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.hostId)).toEqual(['local', 'local'])
  expect(useAppStore.getState(), 'Display placement cannot replace the original execution Host').toMatchObject({ error: null, lastError: null, errorNoticeContext: null })
  expect(element.querySelector('.error-notice')).toBeNull()
  expect(recover).not.toHaveBeenCalled()
  f.retained()
})
it.each(['absent', 'missing-execution'] as const)('keeps original execution Host unknown when Core spatial facts are %s', async mode => {
  const f = await fixture(false, undefined, { spatial: mode })
  await f.settle(complete())
  expect(useAppStore.getState().error).toBe(f.warning)
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  f.retained()
})
it('does not let an unrelated Host warning hold this resolved notice', async () => {
  const f = await fixture()
  await f.settle({ ...complete(), runtimeOwnershipWarnings: ['unrelated-host'] })
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().runtimeOwnershipWarnings).toEqual(['unrelated-host'])
  expect(useAppStore.getState().error).toBeNull()
  expect(element.querySelector('.error-notice')).toBeNull()
  f.retained()
})
it.each([false, true])('keeps other startup text and its dismissal (dismissed: %s)', async dismissed => {
  vi.mocked(api.providers.list).mockRejectedValue(new Error('Provider discovery unavailable'))
  vi.mocked(api.demands.list).mockRejectedValue(new Error('Demand filesystem unavailable'))
  const f = await fixture()
  const remainder = useAppStore.getState().errorNoticeContext!.startupSessionSnapshot!.remainingMessage
  expect(remainder).toContain('Provider discovery unavailable')
  expect(remainder).toContain('Demand filesystem unavailable')
  if (dismissed) await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  await f.settle(complete())
  expect(useAppStore.getState()).toMatchObject({ error: remainder, lastError: remainder, errorDismissed: dismissed })
  expect(element.querySelector('.error-notice') === null).toBe(dismissed)
  if (dismissed) {
    expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
    await act(async () => element.querySelector<HTMLButtonElement>('.error-notice__reopen')!.click())
  }
  expect(element.querySelector('.error-notice')!.textContent).toContain(remainder)
  expect(element.querySelector('.error-notice')!.textContent).not.toContain('returned no Session facts')
  f.retained()
})
it.each(['same-text', 'different-text'] as const)('does not let the old read clear a later %s error', async mode => {
  const f = await fixture()
  const message = mode === 'same-text' ? f.warning : 'Later document save failed'
  await act(async () => useAppStore.getState().reportError(new Error(message), { kind: 'process-degraded' }))
  const laterContext = useAppStore.getState().errorNoticeContext
  expect(laterContext).toEqual({ kind: 'process-degraded' })
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState().errorNoticeContext).toBe(laterContext)
  expect(useAppStore.getState()).toMatchObject({ error: message, lastError: message })
  expect(element.querySelector('.error-notice')!.textContent).toContain(message)
  f.retained()
})
it('removes the resolved last notice after the user dismissed it', async () => {
  const f = await fixture()
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null })
  expect(element.querySelector('.error-notice__reopen')).toBeNull()
  f.retained()
})
it.each([false, true])('a dismissed startup notice cannot swallow a later ordinary same-text error (explicit kind: %s)', async explicitKind => {
  const f = await fixture()
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click())
  expect(element.querySelector('.error-notice__reopen')).not.toBeNull()
  await act(async () => useAppStore.getState().reportError(new Error(f.warning), explicitKind ? { kind: 'indeterminate' } : undefined))
  expect(useAppStore.getState().errorNoticeContext?.startupSessionSnapshot).toBeUndefined()
  expect(element.querySelectorAll('.error-notice')).toHaveLength(1)
  await f.settle(complete())
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  expect(useAppStore.getState()).toMatchObject({ error: f.warning, lastError: f.warning, errorDismissed: false })
  expect(element.querySelector('.error-notice')!.textContent).toContain(f.warning)
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
