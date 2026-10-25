// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@agentmux/core'
import type { AgentSessionRecoveryCandidate, AppConfig, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentProviderRegistry } from '@agentmux/core'
import { agentContinuityAdmission, normalizeAgentContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const now = _historyFixtureEpoch(2, 27200, 0)
const done = (stateEnteredAt: number): AgentStatus => ({ state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt })
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private policy fixture' }], executors: {},
  workspaces: [{ id: 'workspace', name: 'Private', hostId: 'local', path: _hygiene_fixturePath("private/policy"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function candidate(id: string, semanticStatus?: AgentStatus): AgentSessionRecoveryCandidate {
  return { agentSessionId: id, hostId: 'local', workspacePath: _hygiene_fixturePath("private/policy"), providerId: 'codex', executorId: 'probe',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    label: id, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: now, run: { runId: `run-${id}` }, ...(semanticStatus ? { semanticStatus } : {}) }
}
function projected(id: string, processState: SessionSnapshot['processState'], semanticStatus?: AgentStatus): SessionSnapshot {
  const value = candidate(id, semanticStatus)
  return { ...value, id, kind: 'agent', processState, latestOutputBytes: 0,
    status: { state: processState === 'exited' ? 'exited' : 'running', source: 'run-process', observedAt: now },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: value.run } }
}

let store: typeof import('../src/renderer/src/store.js').useAppStore
let api: typeof import('../src/renderer/src/lib/api.js').api
let dispose: (() => void) | undefined
let spatial: AgentMuxSpatialStateStore
let directory: string
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  directory = await mkdtemp(join(tmpdir(), 'amux-continuity-consumer-'))
  spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store.js')).useAppStore
  api = (await import('../src/renderer/src/lib/api.js')).api
  vi.spyOn(store.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(input => spatial.retainDisplayLabels(input))
})
afterEach(async () => { dispose?.(); dispose = undefined; vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })
async function seed(ids: string[]) {
  const tabs = Object.fromEntries(ids.map((id) => [`tab-${id}`, createWorkbenchTab(`tab-${id}`, {
    regionId: `region-${id}`, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: id
  })]))
  const spaceId = directoryIdentity('local', _hygiene_fixturePath("private/policy"))
  for (const tab of Object.values(tabs)) tab.space = { spaceId, zoneId: workspaceZoneId(spaceId, 'workspace') }
  const layouts = { workspace: createWorkspaceLayout('private-group', Object.keys(tabs)) }
  const focus = { execution: { sessionId: ids[0]!, history: ids.map((id, index) => ({ sessionId: id, focusedAt: now - index })) }, pmo: { sessionId: null } }
  const drafts = Object.fromEntries(ids.map(id => [id, `Original draft ${id}`]))
  store.setState({ config, sessions: ids.map(id => projected(id, 'interrupted')), tabs, layouts, loading: true, restoredWorkbench: { tabs, layouts }, agentFocus: focus, agentComposerDrafts: drafts, activeWorkspaceId: 'workspace' })
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  return { tabs, layouts, focus, drafts }
}
async function initialize() {
  const snapshot = vi.mocked(api.sessions.snapshot), reader = snapshot.getMockImplementation()!
  snapshot.mockImplementation(async (...args) => {
    const observed = await reader(...args)
    return { ...observed, timelines: Object.fromEntries(observed.sessions.map(session => [session.id,
      observed.timelines[session.id] ?? { agentSessionId: session.id, revision: 0, items: [] }])) }
  })
  dispose = await store.getState().initialize(); expect(store.getState().loading).toBe(false)
  await vi.waitFor(() => expect(store.getState().loading).toBe(false))
  await new Promise(resolve => setTimeout(resolve, 100))
}
function assertWorkbench(original: ReturnType<typeof seed>) {
  const state = store.getState()
  expect(state.tabs).toEqual(original.tabs)
  expect(state.layouts.workspace).toEqual(original.layouts.workspace)
  expect(state.agentFocus).toEqual(original.focus)
  expect(state.agentComposerDrafts).toEqual(original.drafts)
}

describe('actual Store cold start', () => {
  it('submits every saved ended/working candidate to Core and consumes its decision without changing the workface', async () => {
    const ids = ['healthy', 'ended-old', 'ended-unknown', 'missing-old', 'missing-working']
    const original = await seed(ids)
    const healthy = projected('healthy', 'running', done(_historyFixtureEpoch(0, 0, 1)))
    const candidates = [candidate('missing-old', done(_historyFixtureEpoch(0, 0, 1))), candidate('missing-working', { state: 'working', source: 'native-hook', observedAt: now })]
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [healthy, projected('ended-old', 'exited', done(_historyFixtureEpoch(0, 0, 1))), projected('ended-unknown', 'exited')], timelines: {}, recoveryCandidates: candidates })
    const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (control, _workspace, operationId, request) => {
      if (control.kind !== 'agent') throw new Error('Expected Agent')
      const live = store.getState().sessions.find(value => value.id === control.agentSessionId)!
      if (live.kind !== 'agent') throw new Error('Expected original Agent')
      const authoritative = candidates.find(candidate => candidate.agentSessionId === live.id) ?? live
      const session = { kind: 'agent' as const, agentSessionId: live.id, providerId: live.providerId, executorId: live.executorId,
        hostId: live.hostId, workspacePath: live.workspacePath, run: control.run, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: now,
        ...(authoritative.semanticStatus ? { semanticStatus: authoritative.semanticStatus } : {}) }
      if (live.processState === 'running') return { kind: 'reattachable', session: live }
      const policy = normalizeAgentContinuityPolicy(), trigger = request?.trigger ?? 'manual'
      const decision = agentContinuityAdmission({ session, policy, trigger, admittedAt: now, now })
      if (decision.kind === 'resume') return { kind: 'resumed', session: { ...live, processState: 'running' as const } }
      return { kind: 'pending', agentSessionId: live.id, previousRun: control.run, reason: decision.reason, evidence: { kind: 'run-missing', observedAt: now },
        continuity: { operationId: operationId!, agentSessionId: live.id, trigger, policy, admittedAt: now, observedAt: now, rechecks: 0,
          previousRun: control.run, kind: 'pending', reason: decision.reason, evidence: { kind: 'run-missing', observedAt: now } } }
    })
    const write = vi.spyOn(api.sessions, 'write')
    await initialize(); assertWorkbench(original)
    expect(recover.mock.calls.map(([control]) => control.kind === 'agent' ? control.agentSessionId : '')).toEqual(['missing-old', 'missing-working', 'healthy', 'ended-old', 'ended-unknown'])
    expect(recover.mock.calls.map(([, , , request]) => request?.trigger)).toEqual(['startup', 'startup', 'startup', 'startup', 'startup'])
    expect(store.getState().sessions.find(value => value.id === 'missing-working')?.processState).toBe('running')
    expect(store.getState().sessions.find(value => value.id === 'missing-old')?.status.detail).toContain('idle window has expired')
    store.getState().setAgentComposerDraft('missing-old', 'Drafting never resumes')
    expect(store.getState().agentComposerDrafts['missing-old']).toBe('Drafting never resumes')
    expect(write).not.toHaveBeenCalled()
  })
  it.each(['manual', 'delay'] as const)('restores parked interrupted working for the first new manual input (%s)', async mode => {
    const id = 'working-user', authored = 'New user instruction after restart'
    const workface = await seed([id]), previous = { ...projected(id, 'interrupted'),
      semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: now } }
    let current = previous
    store.setState({ sessions: [previous] })
    const policy = mode === 'manual' ? { activeRecovery: 'manual' as const } : { activeRecoveryDelayMs: 60000 }
    vi.spyOn(api.config, 'get').mockResolvedValue({ ...config, continuity: policy })
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => ({ sessions: [current], timelines: {}, recoveryCandidates: [] }))
    for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'durable'))
    vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(directory, 'sessions.json'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
    const sessionStore = new AgentMuxMemoryAgentSessionStore()
    await sessionStore.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'probe', hostId: 'local',
      workspacePath: previous.workspacePath, run: previous.control.run, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: now,
      semanticStatus: previous.semanticStatus, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'same-native' },
      hookBindingId: 'private-binding'.padEnd(43, 'A'), hookToken: 'private-token'.padEnd(43, 'B') })
    const client = new AgentMuxClient({ store: sessionStore }), core = client as any
    await core.registry.load('local'); core.connected = true
    const nativeRun = (runId: string, running: boolean) => ({ nativeService: null, runId, lifecycleOperationId: null,
      program: 'codex', args: [], workspacePath: previous.workspacePath, pid: running ? 4242 : null,
      state: running ? { type: 'running' } : { type: 'exited', code: 0, signal: null }, cols: 80, rows: 24,
      latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
    core.kernel.isConnected = () => true
    core.kernel.status = async (runId: string) => nativeRun(runId, runId === 'new-run')
    const start = vi.fn(async (_spec: { args: string[] }) => nativeRun('new-run', true)); core.kernel.start = start
    core.probePreparedAgent = async () => ({ providerId: 'codex', executable: 'codex', installed: true,
      capabilities: new AgentProviderRegistry().get('codex').catalog.capabilities })
    core.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
    core.hookServer.isRunning = () => true
    core.hookServer.createBinding = () => ({ bindingId: 'new-binding'.padEnd(43, 'C'),
      endpoint: { url: 'http://127.0.0.1:0', token: 'new-token'.padEnd(43, 'D') }, bindRun: async () => {}, close: async () => {} })
    const continuity: Array<Awaited<ReturnType<AgentMuxClient['ensureAgentContinuity']>>> = []
    const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (control, _cwd, operationId, request) => {
      if (control.kind !== 'agent') throw new Error('Expected original Agent')
      const result = await client.ensureAgentContinuity({ agentSessionId: control.agentSessionId, expectedRun: control.run,
        operationId: operationId!, ...request, policy })
      continuity.push(result)
      if (result.kind !== 'resumed' && result.kind !== 'reattachable') return result
      current = { ...previous, processState: 'running', runUnobserved: false,
        control: { ...previous.control, run: result.session.run }, continuity: result.continuity, continuityOperations: result.session.continuityOperations,
        promptSubmissionPredecessor: null, status: { state: 'running', source: 'run-process', observedAt: now } }
      return { kind: result.kind, session: current }
    })
    vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
    const submitted = vi.spyOn(api.sessions, 'submitPrompt')
    try {
      await initialize()
      expect(continuity[0]).toMatchObject({ kind: 'pending', reason: mode === 'manual' ? 'active-manual' : 'active-delay' })
      expect(start).not.toHaveBeenCalled()
      const reject = vi.fn()
      expect(store.getState().send(id, authored, reject, 'manual', undefined, { execution: 'immediate' })).toBe(true)
      await vi.waitFor(() => expect(store.getState().agentSteerQueues[id]?.[0]?.resumeInputReceipt?.state).toBe('launch-carried'))
      expect(reject).not.toHaveBeenCalled()
      expect(recover.mock.calls.map(([, , , request]) => request?.trigger)).toEqual(['startup', 'input'])
      expect(continuity[1]).toMatchObject({ kind: 'resumed', continuity: { trigger: 'input', recoveryInputs: { reminder: '', continuation: '' } } })
      expect(submitted).not.toHaveBeenCalled()
      const launchInput = continuity[1]?.continuity?.launchInput
      expect(launchInput).toBeDefined()
      expect(launchInput!.input.prompt).toBe(authored)
      expect(launchInput!.message.userContent).toBe(authored)
      expect(launchInput!.prompt.trim()).not.toBe('')
      expect(start.mock.calls[0]![0].args).toContain(launchInput!.prompt)
      expect(start).toHaveBeenCalledTimes(1)
      expect(store.getState().agentComposerDrafts).toEqual(workface.drafts)
      expect(store.getState().agentSteerQueues[id]?.filter(entry => entry.text === authored)).toMatchObject([{ archived: true,
        operationId: recover.mock.calls[1]?.[2], resumeInputReceipt: { key: { expectedRun: { runId: 'new-run' } }, state: 'launch-carried' } }])
    } finally { await client.dispose() }
  })
  it('consumes the native epoch through both ended and missing recovery paths', async () => {
    const ids = ['ended-recent', 'missing-recent']; const original = await seed(ids)
    let snapshot: RuntimeSnapshot = { sessions: [projected(ids[0]!, 'exited', done(now - 86_400_000))], timelines: {}, recoveryCandidates: [candidate(ids[1]!, done(now - 7_200_000))] }
    vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => snapshot)
    const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
      const session = projected(control.kind === 'agent' ? control.agentSessionId : '', 'running')
      snapshot = { ...snapshot, sessions: [...snapshot.sessions.filter(value => value.id !== session.id), session], recoveryCandidates: snapshot.recoveryCandidates.filter(value => value.agentSessionId !== session.id) }
      return { kind: 'resumed', session }
    })
    await initialize(); assertWorkbench(original)
    expect(recover.mock.calls.map(([control]) => control)).toEqual([
      { kind: 'agent', hostId: 'local', agentSessionId: 'missing-recent', run: { runId: 'run-missing-recent' } },
      { kind: 'agent', hostId: 'local', agentSessionId: 'ended-recent', run: { runId: 'run-ended-recent' } }
    ])
    expect(store.getState().sessions.map(value => [value.id, value.processState])).toEqual([['missing-recent', 'running'], ['ended-recent', 'running']])
  })
  it.each(['rejected', 'empty', 'unverified'] as const)('does not turn %s observation into missing/spawn or lost focus', async mode => {
    const original = await seed(['unknown'])
    const snapshot = vi.spyOn(api.sessions, 'snapshot')
    if (mode === 'rejected') snapshot.mockRejectedValue(new Error('Runtime observation timed out'))
    else snapshot.mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: mode === 'unverified' ? [candidate('unknown', done(now))] : [], ...(mode === 'unverified' ? { runtimeEndpointWarnings: [{ hostId: 'local', availability: 'unverified', step: 'Confirming Host identity', code: 'CONTROL_PROTOCOL_ERROR', message: 'The semantic Host identity is unconfirmed.', recovery: 'Reconnect the original Host.' }] } : {}) })
    const recover = vi.spyOn(api.sessions, 'recover')
    await initialize(); assertWorkbench(original); expect(recover).not.toHaveBeenCalled()
  })
  it('keeps a refused recent ended Session once and removes only an explicit retirement', async () => {
    await seed(['refused', 'retired'])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [projected('refused', 'exited', done(now)), projected('retired', 'exited', done(now))], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'recover').mockImplementation(async control => control.kind === 'agent' && control.agentSessionId === 'retired'
      ? { kind: 'retired', agentSessionId: 'retired', previousRun: control.run, evidence: { kind: 'user-retired', observedAt: now } }
      : { kind: 'unavailable', reason: 'native-handle-unavailable', agentSessionId: 'refused', previousRun: control.run, evidence: { kind: 'run-ended', state: 'exited', observedAt: now } })
    await initialize()
    expect(store.getState().sessions.map(value => value.id)).toEqual(['refused'])
    expect(store.getState().tabs['tab-refused']?.regions['region-refused']).toMatchObject({ kind: 'agent', sessionId: 'refused' })
    expect(store.getState().sessions[0]?.status.continuityReason).toBe('native-handle-unavailable')
    expect(store.getState().sessions[0]?.processState).toBe('exited')
  })
})
