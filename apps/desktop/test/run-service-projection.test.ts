import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import type { AgentMuxNativeService, AgentMuxAgentSession } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { projectRuntimeEvent, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { nativeSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint } from '../src/renderer/src/lib/use-service-notices'
import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode'

function service(revision: number): AgentMuxNativeService {
  return { revision, owner: { type: 'serving' }, output: { type: 'serving' },
    input: { phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0, writeBlocked: false,
      completedInputBytes: 5, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 }, terminalFault: null }
}
function session(hostId = 'local', runId = 'original'): SessionSnapshot {
  return { kind: 'terminal', id: runId, hostId, runId, workspacePath: _hygiene_fixturePath("repo"), label: 'Shell',
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 12,
    status: { state: 'working', source: 'run-process', observedAt: 1 }, nativeService: service(1),
    control: { kind: 'terminal', hostId, runId, run: { runId } } }
}
it('shows output pressure in Terminal and Activity without changing input or identity, then clears only on current Serving', () => {
  const original = session(), other = session('local', 'other')
  const state: SessionProjectionState = { sessions: [original, other], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const pressured = { ...service(2), output: { type: 'backpressured' as const } }
  const event = { type: 'core' as const, hostId: 'local', event: { type: 'run-service' as const,
    run: { runId: 'original' }, nativeService: pressured,
    evidence: { source: 'run-process' as const, observedAt: 2, run: { runId: 'original' } } } }
  const reduced = projectRuntimeEvent(state, event).state
  const current = reduced.sessions[0]!
  expect(current.control).toBe(original.control)
  expect(current.processState).toBe('running')
  expect(current.nativeService?.input).toEqual(original.nativeService?.input)
  expect(reduced.sessions[1]).toBe(other); expect(reduced.tabs).toBe(state.tabs); expect(reduced.layouts).toBe(state.layouts)
  const terminal = serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(current)))
  expect(terminal?.kind).toBe('process-degraded')
  expect(terminal?.notice.mode).toContain('resource pressure')
  expect(terminal?.notice.mode).toContain('input is open')
  expect(terminal?.notice.mode).not.toContain('disk is full')
  expect(terminal?.notice.restore).toContain('do not resend unconfirmed input')
  const unknown = serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome({ ...current, processState: 'interrupted' })))
  expect(unknown?.kind).toBe('indeterminate')
  expect(unknown?.notice.step).toContain('resource pressure')
  expect(unknown?.notice.mode).toContain('can’t confirm')
  const inputFailed = { ...current, nativeService: { ...pressured, input: { ...pressured.input,
    phase: { type: 'unavailable' as const, reason: 'write_failed' as const }, completedInputBytes: null } } }
  expect(nativeSessionServiceOutcome(inputFailed)).toMatchObject({ completed: false, step: { degradedMode: expect.stringContaining('input unavailable') } })
  expect(nativeSessionServiceOutcome(inputFailed)).toMatchObject({ completed: false, step: { degradedMode: expect.stringContaining('output under resource pressure') } })
  const remainingFault = { ...current, nativeService: { ...service(4), terminalFault: { stage: 'export' as const, throughByte: 12 } } }
  expect(sessionServiceNotices(remainingFault)[0]?.notice.notice.mode).toContain('terminal view export')
  expect(sessionServiceNotices(remainingFault)[0]?.notice.notice.mode).not.toContain('resource pressure')
  const agent: SessionSnapshot = { ...current, kind: 'agent', providerId: 'codex', executorId: 'codex', capabilities: {},
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  const activity = sessionServiceNotices(agent)
  expect(activity.map(item => item.id)).toEqual(['native-service'])
  expect(activity[0]?.notice).toEqual(terminal)
  expect(composerSubmitMode(agent)).toMatchObject({ canType: true, canSubmit: true })
  const notices = sessionServiceNotices(current)
  expect(notices).toHaveLength(1)
  expect(serviceNoticeFingerprint(sessionServiceNotices({ ...current, nativeService: { ...pressured, revision: 3 } })[0]!))
    .toBe(serviceNoticeFingerprint(notices[0]!))
  expect(serviceNoticeFingerprint(sessionServiceNotices(inputFailed)[0]!)).not.toBe(serviceNoticeFingerprint(notices[0]!))
  expect(sessionServiceNotices(other)).toEqual([])
  const stale = projectRuntimeEvent(reduced, { ...event, event: { ...event.event, nativeService: service(1) } }).state
  expect(sessionServiceNotices(stale.sessions[0]!)).toHaveLength(1)
  const recovered = projectRuntimeEvent(stale, { ...event, event: { ...event.event, nativeService: service(4) } }).state
  expect(sessionServiceNotices(recovered.sessions[0]!)).toEqual([])
  expect(serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(recovered.sessions[0]!)))).toBeNull()
})
it('projects one Run-local service revision into the existing service window without changing process, layout or other Runs', () => {
  const original = session(), otherRun = session('local', 'other'), otherHost = session('remote')
  const state: SessionProjectionState = {
    sessions: [original, otherRun, otherHost], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {}
  }
  const failed = { ...service(2), input: { ...service(2).input, phase: { type: 'unavailable' as const, reason: 'write_failed' as const }, completedInputBytes: null },
    terminalFault: { stage: 'export' as const, throughByte: 12 } }
  const event = { type: 'core' as const, hostId: 'local', event: { type: 'run-service' as const,
    run: { runId: 'original' }, nativeService: failed,
    evidence: { source: 'run-process' as const, observedAt: 2, run: { runId: 'original' } } } }
  const reduced = projectRuntimeEvent(state, event).state
  expect(reduced.sessions[0]).toEqual({ ...original, nativeService: failed })
  expect(reduced.sessions[1]).toBe(otherRun); expect(reduced.sessions[2]).toBe(otherHost)
  expect(reduced.tabs).toBe(state.tabs); expect(reduced.layouts).toBe(state.layouts)
  const rendered = serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(reduced.sessions[0]!)))
  expect(rendered?.kind).toBe('process-degraded')
  expect(rendered?.notice.mode).toContain('input unavailable')
  expect(rendered?.notice.mode).toContain('terminal view export at byte 12')
  expect(rendered?.notice.restore).toContain('do not resend unconfirmed input')
  const old = projectRuntimeEvent(reduced, { ...event, event: { ...event.event, nativeService: service(1) } }).state
  expect(old.sessions[0]).toBe(reduced.sessions[0])
  const recovered = projectRuntimeEvent(old, { ...event, event: { ...event.event, nativeService: service(3) } }).state
  expect(serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(recovered.sessions[0]!)))).toBeNull()
})

it('keeps unknown viability explicit and historical service closure quiet', () => {
  const current = { ...session(), processState: 'interrupted' as const, nativeService: {
    ...service(2), owner: { type: 'stopped' as const, reason: 'owner_unwound' as const } } }
  expect(classifyServiceNotice(nativeSessionServiceOutcome(current)).kind).toBe('indeterminate')
  const historical = { ...current, nativeService: { ...current.nativeService,
    owner: { type: 'stopped' as const, reason: 'historical' as const } } }
  expect(classifyServiceNotice(nativeSessionServiceOutcome(historical)).kind).toBe('healthy')
})

it('keeps the AgentSession on semantic resume while discarding only the previous Run service revision and rejecting its late events', () => {
  const failed = { ...service(20), terminalFault: { stage: 'export' as const, throughByte: 12 } }
  const original: SessionSnapshot = { ...session(), kind: 'agent', id: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: {}, agentSessionUpdatedAt: 1, nativeService: failed,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'agent', run: { runId: 'original' } } }
  const state: SessionProjectionState = { sessions: [original], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const resumed: AgentMuxAgentSession = { kind: 'agent', agentSessionId: 'agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), createdAt: 1, updatedAt: 2, run: { runId: 'resumed' }, retiredRuns: [{ runId: 'original' }] }
  const sameRunUpdate = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: {
    type: 'agent-session', session: { ...resumed, run: { runId: 'original' } } } }).state
  expect(sameRunUpdate.sessions[0]?.nativeService).toBe(failed)
  const moved = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: resumed } }).state
  expect(moved.sessions[0]?.id).toBe('agent')
  expect(moved.sessions[0]?.control.run.runId).toBe('resumed')
  expect(moved.sessions[0]?.nativeService).toBeNull()
  expect(moved.tabs).toBe(state.tabs); expect(moved.layouts).toBe(state.layouts)
  const event = { type: 'core' as const, hostId: 'local', event: { type: 'run-service' as const, agentSessionId: 'agent',
    run: { runId: 'resumed' }, nativeService: service(1), evidence: { source: 'run-process' as const, observedAt: 3, run: { runId: 'resumed' } } } }
  const healthy = projectRuntimeEvent(moved, event).state
  expect(healthy.sessions[0]?.nativeService?.revision).toBe(1)
  expect(classifyServiceNotice(nativeSessionServiceOutcome(healthy.sessions[0]!)).kind).toBe('healthy')
  const late = projectRuntimeEvent(healthy, { ...event, event: { ...event.event, run: { runId: 'original' }, nativeService: failed } }).state
  expect(late.sessions[0]).toBe(healthy.sessions[0])
})
