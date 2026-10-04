import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { AgentSessionRecoveryCandidate, RuntimeEndpointWarning, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { Root } from 'react-dom/client'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const initial = useAppStore.getState(), id = 'original-session'
const endpoint: RuntimeEndpointWarning = { hostId: 'local', availability: 'unverified', step: 'Confirming semantic Host',
  code: 'CONTROL_PROTOCOL_ERROR', message: 'The original Host identity is unconfirmed.', recovery: 'Reconnect the original Host.' }
const empty = (): RuntimeSnapshot => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: ['local'] })
function recent(): Extract<SessionSnapshot, { kind: 'agent' }> {
  const now = Date.now()
  return { ...composerSession(id), processState: 'exited', status: { state: 'done', source: 'native-hook', observedAt: now },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now - 10_000 } }
}
function candidate(): AgentSessionRecoveryCandidate {
  const session = recent(); return { ...session, agentSessionId: session.id, run: session.control.run }
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes }), resolve: (value: T) => resolve(value) } }
async function ticks() { for (let index = 0; index < 40; index++) await Promise.resolve() }
let directory: string, dispose: (() => void) | undefined, root: Root | undefined, container: HTMLDivElement
let releases: Array<() => void>
let original: Pick<ReturnType<typeof useAppStore.getState>, 'tabs' | 'layouts' | 'agentComposerDrafts'>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useAppStore.setState(initial, true); releases = []
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader()); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: id, source: { providerId: 'codex', nativeSessionId: 'fixture-native' }, items: [], nextCursor: null })
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: id, revision: 0, items: [] })
  directory = await mkdtemp(join(tmpdir(), 'agentmux-owner-warning-'))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(callback => spatial.subscribe(callback))
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'workspace', sessionId: id })
  const spaceId = directoryIdentity('local', _hygiene_fixturePath("repo")); tab.space = { spaceId, zoneId: workspaceZoneId(spaceId, 'workspace') }
  original = { tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, agentComposerDrafts: { [id]: 'Keep original unsent draft' } }
  useAppStore.setState({ config: composerConfig, loading: true, restoredWorkbench: { tabs: original.tabs, layouts: original.layouts },
    agentComposerDrafts: original.agentComposerDrafts, activeWorkspaceId: 'workspace' })
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...useAppStore.getState(), config: composerConfig,
    tabs: { [tab.id]: hydratePersistedTab(tab) }, layouts: original.layouts, sessions: [recent()] }, []) })
  container = document.createElement('div'); document.body.append(container)
})
afterEach(async () => {
  dispose?.(); dispose = undefined; releases.forEach(release => release()); await ticks()
  if (root) { await act(async () => root!.unmount()); root = undefined }
  container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})
function retained() {
  const state = useAppStore.getState()
  expect(state.tabs).toEqual(original.tabs); expect(state.layouts).toEqual(original.layouts)
  expect(state.agentComposerDrafts).toEqual(original.agentComposerDrafts)
  expect(state.runtimeOwnershipWarnings).toEqual(['local'])
}
async function mount() { root ??= createClientUiRoot(container); await act(async () => root!.render(<><SessionPane sessionId={id} surfaceKind="agent"
  interactiveResize={false} visible linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} /><GlobalSystemNotices /></>)); await ticks() }

describe('actual canonical restore consumers with cleanup provenance warning', () => {
  it('cold start resumes recent native done facts and keeps the cleanup warning and exact workface', async () => {
    let snapshot: RuntimeSnapshot = { ...empty(), sessions: [recent()] }
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => snapshot)
    const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
      const session = composerSession(id); snapshot = { ...snapshot, sessions: [session] }; return { kind: 'resumed', session }
    })
    const stop = vi.spyOn(api.sessions, 'stop'), input = vi.spyOn(api.sessions, 'write')
    dispose = await useAppStore.getState().initialize(); retained()
    expect(recover).toHaveBeenCalledExactlyOnceWith(recent().control, _hygiene_fixturePath("repo"))
    expect(useAppStore.getState().sessions[0]?.processState).toBe('running')
    expect(stop).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled()
  })

  it('a late canonical cut projects honest pending detail and requests original recovery despite cleanup warning', async () => {
    const later = deferred<RuntimeSnapshot>(), recovery = deferred<Awaited<ReturnType<typeof api.sessions.recover>>>()
    releases.push(() => later.resolve(empty()), () => recovery.resolve({ kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: id, previousRun: { runId: `run-${id}` }, evidence: { kind: 'run-ended', state: 'exited', observedAt: Date.now() } }))
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValueOnce(empty()).mockReturnValue(later.promise)
    const recover = vi.spyOn(api.sessions, 'recover').mockReturnValue(recovery.promise)
    dispose = await useAppStore.getState().initialize()
    expect(recover).not.toHaveBeenCalled()
    later.resolve({ ...empty(), recoveryCandidates: [candidate()] }); await ticks()
    const projected = useAppStore.getState().sessions.find(session => session.id === id)!
    expect(projected.status.detail).not.toContain('Runtime identity is unverified')
    expect(projected.status.detail).toContain('The Agent is not running')
    expect(recover).toHaveBeenCalledOnce(); expect(recover.mock.calls[0]![0]).toEqual(recent().control)
    expect(recover.mock.calls[0]![1]).toBe(_hygiene_fixturePath("repo")); retained()
    recovery.resolve({ kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: id, previousRun: recent().control.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: Date.now() } }); await ticks()
    expect(useAppStore.getState().sessions[0]?.status.continuityReason).toBe('native-handle-unavailable')
    expect(useAppStore.getState().sessions[0]?.control).toEqual(recent().control)
  })

  it.each(['initial', 'late'] as const)('does not auto resume with an actually unverified Host on the %s cut', async cut => {
    const recover = vi.spyOn(api.sessions, 'recover')
    const unavailable = { ...empty(), recoveryCandidates: [candidate()], runtimeEndpointWarnings: [endpoint] }
    if (cut === 'initial') vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(unavailable)
    else { const later = deferred<RuntimeSnapshot>(); releases.push(() => later.resolve(unavailable)); vi.spyOn(api.sessions, 'snapshot').mockResolvedValueOnce(empty()).mockReturnValue(later.promise); dispose = await useAppStore.getState().initialize(); later.resolve(unavailable); await ticks() }
    if (cut === 'initial') dispose = await useAppStore.getState().initialize()
    await ticks(); expect(recover).not.toHaveBeenCalled(); retained()
    expect(useAppStore.getState().sessions[0]?.status.detail).toBe(endpoint.message)
  })

  it('SessionPane uses actual Host availability for detail while its manual Resume invokes original Store recovery independently', async () => {
    useAppStore.setState({ loading: false, sessions: [recent()], tabs: original.tabs, layouts: original.layouts,
      runtimeOwnershipWarnings: ['local'], runtimeEndpointWarnings: [], recoveryCandidates: [], timelines: {} })
    const recover = vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: id, previousRun: recent().control.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: Date.now() } })
    const read = vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...empty(), sessions: [recent()] })
    await mount()
    expect(container.textContent).not.toContain('Runtime identity is unverified')
    expect(container.textContent).toContain('The Agent is not running')
    expect(container.textContent).toContain('Runtime launch record is unavailable')
    expect(recover).not.toHaveBeenCalled()
    const resume = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Restore original')
    expect(resume, 'actual manual Resume action remains mounted').toBeDefined()
    await act(async () => resume!.click())
    expect(recover).toHaveBeenCalledOnce(); expect(recover.mock.calls[0]![0]).toEqual(recent().control)
    expect(recover.mock.calls[0]![1]).toBe(_hygiene_fixturePath("repo")); expect(read).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]?.status.continuityReason).toBe('native-handle-unavailable')
  })

  it('SessionPane keeps the real endpoint-unverified explanation and manual action without claiming Host confirmation', async () => {
    useAppStore.setState({ loading: false, sessions: [recent()], tabs: original.tabs, layouts: original.layouts,
      runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [endpoint], recoveryCandidates: [], timelines: {} })
    const recover = vi.spyOn(api.sessions, 'recover')
    await mount(); expect(container.textContent).toContain('Runtime identity is unverified')
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent?.trim() === 'Restore original')).toBe(true)
    expect(recover).not.toHaveBeenCalled()
  })
})
