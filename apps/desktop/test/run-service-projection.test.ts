import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it, vi } from 'vitest'
import type { AgentMuxNativeService, AgentMuxAgentSession } from '@agentmux/core'
import type { RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { projectRuntimeEvent, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { nativeSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint } from '../src/renderer/src/lib/use-service-notices'
import { createRunServiceProjection, runServiceProjection } from '../src/renderer/src/lib/run-service-projection'
import { initializeRunServiceProjection, useAppStore } from '../src/renderer/src/store'
import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode'

function service(revision: number): AgentMuxNativeService {
  return { revision, owner: { type: 'serving' }, output: { type: 'serving' },
    input: { phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0, writeBlocked: false,
      completedInputBytes: 5, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 }, terminalFault: null }
}
const agentCapabilities = { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } as const
function session(hostId = 'local', runId = 'original'): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return { kind: 'terminal', providerId: null, id: runId, hostId, workspacePath: _hygiene_fixturePath("repo"), label: 'Shell',
    createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running', latestOutputBytes: 12,
    status: { state: 'working', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, nativeService: service(1),
    control: { kind: 'terminal', hostId, runId, run: { runId } } }
}
function event(nativeService: AgentMuxNativeService, hostId = 'local', runId = 'original', agentSessionId?: string) {
  return { type: 'core' as const, hostId, event: { type: 'run-service' as const, run: { runId }, ...(agentSessionId ? { agentSessionId } : {}),
    nativeService, evidence: { source: 'run-process' as const, observedAt: nativeService.revision, run: { runId } } } }
}
function state(sessions: SessionSnapshot[]): SessionProjectionState {
  return { sessions, timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
}

it('retains every full revision without notifying health subscribers or replacing ordinary Sessions', () => {
  const owner = createRunServiceProjection(), original = session(), unrelated = session('remote', 'other')
  const projected = state([original, unrelated])
  owner.reconcile(projected.sessions)
  let local = 0, global = 0, other = 0
  owner.subscribe(original, () => ++local)
  owner.subscribe(unrelated, () => ++other)
  owner.subscribeAll(() => ++global)
  for (let revision = 2; revision <= 401; ++revision) {
    const progress = { ...service(revision), input: { ...service(revision).input, unsettledCommands: revision,
      unsettledRequestBytes: revision * 10, completedInputBytes: revision * 20,
      currentSize: { cols: 191, rows: 50 }, activeConfirmedBytes: revision, writeBlocked: revision % 2 === 0 } }
    owner.apply(event(progress))
    expect(owner.read(original)).toBe(progress)
    expect(projectRuntimeEvent(projected, event(progress)).state).toBe(projected)
  }
  expect([local, global, other]).toEqual([0, 0, 0])
  expect(owner.read(original)?.revision).toBe(401)
  expect(original.nativeService?.revision).toBe(1)
  expect(owner.read(unrelated)).toBe(unrelated.nativeService)
})

it('preserves ordered pressure, fault, reason and recovery facts in existing service windows without gating input', () => {
  const owner = createRunServiceProjection(), original = session(), unrelated = session('local', 'other')
  owner.reconcile([original, unrelated])
  const seen: (AgentMuxNativeService | null)[] = []
  let other = 0
  owner.subscribe(original, () => seen.push(owner.read(original)))
  owner.subscribe(unrelated, () => ++other)
  const pressured = { ...service(2), output: { type: 'backpressured' as const } }
  const failed = { ...pressured, revision: 3, input: { ...pressured.input,
    phase: { type: 'unavailable' as const, reason: 'write_failed' as const }, completedInputBytes: null },
    terminalFault: { stage: 'export' as const, throughByte: 12 } }
  const movedFault = { ...failed, revision: 4, terminalFault: { ...failed.terminalFault, throughByte: 15 } }
  const changedReason = { ...movedFault, revision: 5, input: { ...failed.input,
    phase: { type: 'unavailable' as const, reason: 'control_closed' as const } } }
  const recovered = service(6)
  for (const fact of [pressured, failed, movedFault, changedReason, recovered]) owner.apply(event(fact))
  expect(seen).toEqual([pressured, failed, movedFault, changedReason, recovered])
  expect(other).toBe(0)
  const terminal = serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(original, pressured)))
  expect(terminal?.kind).toBe('process-degraded')
  expect(terminal?.notice.mode).toContain('resource pressure')
  expect(terminal?.notice.mode).toContain('input was last observed open')
  expect(terminal?.notice.restore).toContain('do not resend unconfirmed input')
  const faultNotice = sessionServiceNotices(original, [], undefined, undefined, movedFault)[0]!
  expect(faultNotice.notice.notice.mode).toContain('terminal view export at byte 15')
  expect(faultNotice.notice.notice.mode).toContain('input unavailable')
  expect(serviceNoticeFingerprint(faultNotice)).toBe(serviceNoticeFingerprint(
    sessionServiceNotices(original, [], undefined, undefined, { ...movedFault, revision: 100 })[0]!))
  expect(sessionServiceNotices(original, [], undefined, undefined, recovered)).toEqual([])
  const agent: SessionSnapshot = { ...original, kind: 'agent', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), providerId: 'codex', executorId: 'codex', capabilities: agentCapabilities,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  expect(sessionServiceNotices(agent, [], undefined, undefined, pressured)[0]?.notice).toEqual(terminal)
  expect(composerSubmitMode(agent)).toMatchObject({ canType: true, canSubmit: true })
  expect(original.control.run.runId).toBe('original')
  expect(original.processState).toBe('running')
})

it('rejects wrong Host, Agent and Run, stale/equal events and stale membership seeds', () => {
  const owner = createRunServiceProjection()
  const original: Extract<SessionSnapshot, { kind: 'agent' }> = { ...session(), kind: 'agent', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), id: 'presentation', providerId: 'codex', executorId: 'codex',
    capabilities: agentCapabilities, control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  owner.reconcile([original])
  const current = service(10)
  owner.apply(event(current, 'local', 'original', 'agent'))
  const failure = { ...service(11), owner: { type: 'stopped' as const, reason: 'owner_unwound' as const } }
  for (const rejected of [event(failure, 'remote', 'original', 'agent'), event(failure, 'local', 'other', 'agent'),
    event(failure, 'local', 'original', 'other'), event(failure),
    event({ ...failure, revision: 9 }, 'local', 'original', 'agent'),
    event({ ...failure, revision: 10 }, 'local', 'original', 'agent')]) owner.apply(rejected)
  owner.reconcile([{ ...original, nativeService: service(2) }])
  owner.reconcile([{ ...original, nativeService: null }])
  expect(owner.read(original)).toBe(current)
  owner.reconcile([{ ...original, nativeService: failure }])
  expect(owner.read(original)).toBe(failure)
})

it('retires the previous Run projection and its reference, retaining the same semantic Agent and original layout', () => {
  const owner = createRunServiceProjection()
  const failed = { ...service(20), terminalFault: { stage: 'export' as const, throughByte: 12 } }
  const original: Extract<SessionSnapshot, { kind: 'agent' }> = { ...session(), kind: 'agent', id: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: agentCapabilities, agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), nativeService: failed,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  const before = state([original])
  owner.reconcile(before.sessions)
  const resumed: AgentMuxAgentSession = { kind: 'agent', agentSessionId: 'agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2),
    run: { runId: 'resumed' }, retiredRuns: [{ runId: 'original' }] }
  const moved = projectRuntimeEvent(before, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: resumed } }).state
  owner.reconcile(moved.sessions)
  const current = moved.sessions[0]!
  expect(current.id).toBe('agent')
  expect(current.nativeService).toBeNull()
  expect(moved.tabs).toBe(before.tabs)
  expect(moved.layouts).toBe(before.layouts)
  expect(owner.read(original)).toBeNull()
  owner.apply(event(failed, 'local', 'original', 'agent'))
  const healthy = service(1)
  owner.apply(event(healthy, 'local', 'resumed', 'agent'))
  expect(owner.read(current)).toBe(healthy)
  let calls = 0
  const stop = owner.subscribe(current, () => ++calls)
  stop()
  owner.clear()
  owner.apply(event(failed, 'local', 'resumed', 'agent'))
  expect(owner.read(current)).toBeNull()
  expect(calls).toBe(0)
})

it('keeps unknown viability explicit and historical service closure quiet', () => {
  const current = { ...session(), processState: 'interrupted' as const, nativeService: {
    ...service(2), owner: { type: 'stopped' as const, reason: 'owner_unwound' as const } } }
  expect(classifyServiceNotice(nativeSessionServiceOutcome(current)).kind).toBe('indeterminate')
  const historical = { ...current, nativeService: { ...current.nativeService,
    owner: { type: 'stopped' as const, reason: 'historical' as const } } }
  expect(classifyServiceNotice(nativeSessionServiceOutcome(historical)).kind).toBe('healthy')
})

it('retains actual service evidence separately from a later connection loss without inventing Native revisions or health wakeups', () => {
  const owner = createRunServiceProjection(), original = session()
  owner.reconcile([original])
  expect(owner.evidence(original)).toBeNull()
  const receive = vi.fn(), stop = owner.subscribe(original, receive)
  const seen = event(service(2))
  owner.apply(seen)
  expect(owner.evidence(original)).toBe(seen.event.evidence)
  expect(receive).not.toHaveBeenCalled()
  owner.apply({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'lost',
    observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 100) } } })
  owner.reconcile([{ ...original, nativeService: null }])
  expect(owner.read(original)).toBe(seen.event.nativeService)
  expect(owner.evidence(original)).toBe(seen.event.evidence)
  expect(receive).not.toHaveBeenCalled()
  stop()
})

it('uses the actual Store ingress and seed lifecycle, including pre-receipt launch events and disposal', () => {
  const before = useAppStore.getState(), original = session()
  useAppStore.setState({ sessions: [original], pendingAgentLaunches: {} })
  const dispose = initializeRunServiceProjection()
  let ordinaryNotifications = 0
  const stop = useAppStore.subscribe(() => ++ordinaryNotifications)
  try {
    const currentState = useAppStore.getState()
    const progress = { ...service(8), input: { ...service(8).input, completedInputBytes: 800 } }
    currentState.applyEvent(event(progress))
    expect(runServiceProjection.read(original)).toBe(progress)
    expect(useAppStore.getState()).toBe(currentState)
    expect(ordinaryNotifications).toBe(0)
    // A later, older snapshot cannot overwrite an already observed live revision.
    useAppStore.setState({ sessions: [{ ...original, nativeService: service(2) }] })
    expect(runServiceProjection.read(original)).toBe(progress)
    const agent: SessionSnapshot = { ...original, kind: 'agent', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), id: 'new-agent', providerId: 'codex', executorId: 'codex',
      capabilities: agentCapabilities, control: { kind: 'agent', hostId: 'local', agentSessionId: 'new-agent', run: { runId: 'new-run' } } }
    useAppStore.setState({ pendingAgentLaunches: { 'new-agent': { events: [], overflowed: false } } })
    const latest = { ...service(12), terminalFault: { stage: 'export' as const, throughByte: 15 } }
    useAppStore.getState().applyEvent(event(latest, 'local', 'new-run', 'new-agent'))
    expect(useAppStore.getState().pendingAgentLaunches['new-agent']?.events).toHaveLength(1)
    useAppStore.setState({ sessions: [agent], pendingAgentLaunches: {} })
    expect(runServiceProjection.read(agent)).toBe(latest)
    expect(runServiceProjection.read(original)).toBeNull()
    dispose()
    useAppStore.setState({ sessions: [{ ...agent, nativeService: service(13) }] })
    useAppStore.getState().applyEvent(event(service(13), 'local', 'new-run', 'new-agent'))
    expect(runServiceProjection.read(agent)).toBeNull()
  } finally {
    stop(); dispose()
    useAppStore.setState(before, true)
  }
})

it('replays in-flight service facts only after the exact resync membership has admitted the new Run', async () => {
  const before = useAppStore.getState()
  const original: Extract<SessionSnapshot, { kind: 'agent' }> = { ...session(), kind: 'agent', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), id: 'agent',
    providerId: 'codex', executorId: 'codex', capabilities: agentCapabilities,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  const resumed: SessionSnapshot = { ...original, agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 2), updatedAt: _reshape_fixtureEpoch(0, 0, 2),
    control: { ...original.control, run: { runId: 'resumed' } } }
  let finish!: (snapshot: RuntimeSnapshot) => void
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useAppStore.setState({ sessions: [original], pendingAgentLaunches: {}, tabs: {}, errorNoticeContext: null, runtimeEndpointWarnings: [] })
  const dispose = initializeRunServiceProjection()
  try {
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'restored',
      evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) } } })
    expect(snapshot).toHaveBeenCalledOnce()
    const latest = { ...service(9), terminalFault: { stage: 'resize' as const, throughByte: 12 } }
    useAppStore.getState().applyEvent(event(latest, 'local', 'resumed', 'agent'))
    expect(runServiceProjection.read(resumed)).toBeNull()
    finish({ sessions: [resumed], timelines: { agent: { agentSessionId: 'agent', revision: 1, items: [] } }, recoveryCandidates: [] })
    await vi.waitFor(() => expect(runServiceProjection.read(resumed)).toBe(latest))
    expect(runServiceProjection.read(original)).toBeNull()
  } finally {
    dispose(); snapshot.mockRestore()
    useAppStore.setState(before, true)
  }
})

it('resyncs an unknown Agent through the existing canonical owner, while rejecting known wrong Host and retired Run events', async () => {
  const before = useAppStore.getState()
  const original: Extract<SessionSnapshot, { kind: 'agent' }> = { ...session(), kind: 'agent', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), id: 'agent',
    providerId: 'codex', executorId: 'codex', capabilities: agentCapabilities,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  const discovered: SessionSnapshot = { ...original, id: 'discovered', nativeService: service(10),
    control: { ...original.control, agentSessionId: 'discovered', run: { runId: 'discovered-run' } } }
  let finish!: (snapshot: RuntimeSnapshot) => void
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useAppStore.setState({ sessions: [original], pendingAgentLaunches: {}, tabs: {}, errorNoticeContext: null, runtimeEndpointWarnings: [] })
  const dispose = initializeRunServiceProjection()
  try {
    useAppStore.getState().applyEvent(event(service(9), 'local', 'retired-run', 'agent'))
    useAppStore.getState().applyEvent(event(service(9), 'remote', 'original', 'agent'))
    expect(snapshot).not.toHaveBeenCalled()
    expect(runServiceProjection.read(original)).toBe(original.nativeService)
    useAppStore.getState().applyEvent(event(service(10), 'local', 'discovered-run', 'discovered'))
    expect(snapshot).toHaveBeenCalledOnce()
    expect(runServiceProjection.read(discovered)).toBeNull()
    const latest = service(11)
    useAppStore.getState().applyEvent(event(latest, 'local', 'discovered-run', 'discovered'))
    finish({ sessions: [original, discovered], timelines: {
      agent: { agentSessionId: 'agent', revision: 1, items: [] },
      discovered: { agentSessionId: 'discovered', revision: 1, items: [] }
    }, recoveryCandidates: [] })
    await vi.waitFor(() => expect(runServiceProjection.read(discovered)).toBe(latest))
    expect(useAppStore.getState().sessions.some(item => item.id === 'discovered')).toBe(true)
    expect(snapshot).toHaveBeenCalledOnce()
  } finally {
    dispose(); snapshot.mockRestore()
    useAppStore.setState(before, true)
  }
})
