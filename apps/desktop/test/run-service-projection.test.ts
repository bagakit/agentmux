import { expect, it } from 'vitest'
import type { AgentMuxNativeService } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'
import { projectRuntimeEvent, runtimeDiagnosticNotice, type SessionProjectionState } from '../src/renderer/src/lib/session-state.js'

const service: AgentMuxNativeService = {
  revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
  input: { phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0,
    writeBlocked: false, completedInputBytes: 0, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 },
  terminalFault: null
}
function terminal(id: string): SessionSnapshot {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/private/work', label: id,
    createdAt: 1, updatedAt: 1, processState: 'running', nativeService: service,
    status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 20,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
function state(): SessionProjectionState {
  return { sessions: [terminal('target'), terminal('other')], timelines: {}, pendingAgentLaunches: {},
    tabs: {}, layouts: {}, viewModes: {} }
}
function event(nativeService: AgentMuxNativeService, runId = 'target', hostId = 'local'): RuntimeEvent {
  return { type: 'core', hostId, event: { type: 'run-service', run: { runId }, nativeService,
    evidence: { source: 'run-process', observedAt: 2, run: { runId } } } }
}

it('updates only the exact Run service without terminating its child or waking the unrelated Session', () => {
  const before = state(), fault = { ...service, revision: 2, terminalFault: { stage: 'resize' as const, throughByte: 20 } }
  const after = projectRuntimeEvent(before, event(fault)).state
  expect(after.sessions).toHaveLength(2)
  expect(after.sessions[0]!.nativeService).toEqual(fault)
  expect(after.sessions[0]!.processState).toBe('running')
  expect(after.sessions[0]!.status).toBe(before.sessions[0]!.status)
  expect(after.sessions[0]!.control).toBe(before.sessions[0]!.control)
  expect(after.sessions[1]).toBe(before.sessions[1])
  expect(after.tabs).toBe(before.tabs)
  expect(after.timelines).toBe(before.timelines)
})

it('rejects stale revisions, foreign hosts and retired Run events without changing any Session', () => {
  const before = state()
  expect(before.sessions.map(row => row.id)).toEqual(['target', 'other'])
  expect(projectRuntimeEvent(before, event(service)).state).toBe(before)
  expect(projectRuntimeEvent(before, event({ ...service, revision: 2 }, 'target', 'remote')).state).toBe(before)
  expect(projectRuntimeEvent(before, event({ ...service, revision: 2 }, 'retired')).state).toBe(before)
})

it('keeps derived failure disclosure attached to the current Run while its child continues running', () => {
  const before = state(), notice: RuntimeEvent = { type: 'core', hostId: 'local', event: {
    type: 'agent-error', code: 'CTXMUX_TERMINAL_SERVICE_FAILED', message: 'Terminal resize derivation failed; raw transport remains available.',
    evidence: { source: 'terminal-output', observedAt: 2, run: { runId: 'target' } } } }
  const diagnostic = runtimeDiagnosticNotice(before, notice)
  expect(diagnostic?.subject).toEqual(before.sessions[0]!.control)
  expect(diagnostic?.message).toContain('Run state: running')
  expect(projectRuntimeEvent(before, notice).state).toBe(before)
})
