import { expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentTimelineSnapshot, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { reduceAgentMembershipSnapshot, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'

function original() {
  const observedAt = fixtureTime(), alias = 'original-renderer-alias', sid = 'original-canonical-session'
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id: alias, kind: 'agent', hostId: 'local', workspacePath: fixturePath('membership-project'),
    providerId: 'codex', executorId: 'codex', label: 'Original Agent', createdAt: observedAt,
    updatedAt: observedAt, agentSessionUpdatedAt: observedAt, latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'original-run' } }
  }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'original-project', sessionId: alias })
  const page: AgentTimelineSnapshot = { agentSessionId: sid, revision: 2, items: [{
    id: 'original-item', agentSessionId: sid, kind: 'lifecycle', status: 'complete', source: 'user',
    title: 'Original history', createdAt: observedAt, updatedAt: observedAt
  }] }
  const state: SessionProjectionState = { sessions: [session], timelines: {}, pendingAgentLaunches: {},
    tabs: { [tab.id]: tab }, layouts: { 'original-project': createWorkspaceLayout('original-group', [tab.id]) },
    viewModes: { [alias]: 'activity' } }
  const snapshot: RuntimeSnapshot = { sessions: [session], timelines: { [alias]: page }, recoveryCandidates: [] }
  return { alias, sid, session, page, state, snapshot }
}

it('the actual membership reducer adopts a canonical Timeline into the original saved renderer alias', () => {
  const f = original(), next = reduceAgentMembershipSnapshot(f.state, f.snapshot)
  expect(next.sessions).toEqual([f.session])
  expect(next.sessions[0]).not.toHaveProperty('timelineObservation')
  expect(next.timelines[f.alias]).toBe(f.page)
  expect(next.timelines[f.sid]).toBeUndefined()
  expect(next.sessions[0]?.control).toBe(f.session.control)
  expect(next.tabs).toBe(f.state.tabs); expect(next.layouts).toBe(f.state.layouts); expect(next.viewModes).toBe(f.state.viewModes)
})

it.each(['original-renderer-alias', 'another-canonical-session'])('keeps original history when Timeline body names the wrong Core identity %s', wrongId => {
  const f = original(), retained = { ...f.page, revision: 1 }
  f.state.timelines[f.alias] = retained
  f.snapshot.timelines[f.alias] = { ...f.page, agentSessionId: wrongId }
  const next = reduceAgentMembershipSnapshot(f.state, f.snapshot)
  expect(next.timelines[f.alias]).toBe(retained)
  expect(next.sessions[0]).toMatchObject({ id: f.alias, control: f.session.control, timelineObservation: {
    code: 'TIMELINE_IDENTITY_MISMATCH', run: f.session.control.run
  } })
  expect(next.tabs).toBe(f.state.tabs); expect(next.layouts).toBe(f.state.layouts)
})

it('keeps the original endpoint Host boundary without taking a missing read as Agent retirement', () => {
  const f = original(), retained = { ...f.page, revision: 1 }
  f.state.timelines[f.alias] = retained
  f.snapshot.runtimeEndpointWarnings = [{ hostId: 'local', step: 'snapshot', code: 'READ_UNAVAILABLE',
    message: 'The original endpoint read is unavailable.', recovery: 'Inspect the original Host.' }]
  const next = reduceAgentMembershipSnapshot(f.state, f.snapshot)
  expect(next.timelines[f.alias]).toBe(retained)
  expect(next.sessions[0]).toMatchObject({ id: f.alias, processState: 'running', control: f.session.control })
  expect(next.tabs).toBe(f.state.tabs); expect(next.layouts).toBe(f.state.layouts)
  f.snapshot.runtimeEndpointWarnings[0]!.hostId = 'another-host'
  expect(reduceAgentMembershipSnapshot(f.state, f.snapshot).timelines[f.alias]).toBe(f.page)
})

it('admits a missing Timeline observation only for the exact original Run', () => {
  const f = original(), faulted = { ...f.session, timelineObservation: {
    code: 'ORIGINAL_READ_UNKNOWN', message: 'Read remains unconfirmed.', run: f.session.control.run
  } }
  const matching = reduceAgentMembershipSnapshot(f.state, { ...f.snapshot, sessions: [faulted], timelines: {} })
  expect(matching.sessions[0]).toEqual(faulted)
  const changedRun = { ...faulted, timelineObservation: { ...faulted.timelineObservation, run: { runId: 'another-run' } } }
  const unconfirmed = reduceAgentMembershipSnapshot(f.state, { ...f.snapshot, sessions: [changedRun], timelines: {} })
  expect(unconfirmed.sessions[0]).toMatchObject({ id: f.alias, control: f.session.control, timelineObservation: {
    code: 'TIMELINE_OBSERVATION_FAILED', run: f.session.control.run
  } })
  expect(unconfirmed.tabs).toBe(f.state.tabs); expect(unconfirmed.layouts).toBe(f.state.layouts)
})
