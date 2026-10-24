import type { AgentMuxClientEvent, AgentMuxLifecycleDiagnosticSource, AgentMuxRunRef } from './types.js'
import type { AgentMuxLifecycleReservation } from './agent-session-store.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Pick only the original public identity; prepared launch data and credentials stay with their owner. */
type PreparedLifecycle = Extract<AgentMuxLifecycleReservation, { kind: 'create' | 'resume' | 'reopen' }>
export function lifecycleDiagnosticSource(reservation: PreparedLifecycle,
  phase: AgentMuxLifecycleDiagnosticSource['phase'] = 'prepared-run'): AgentMuxLifecycleDiagnosticSource {
  const expectedRun = reservation.kind === 'resume' ? reservation.expectedRun
    : reservation.kind === 'reopen' ? reservation.expectedRetirement.run : undefined
  const operationId = reservation.kind === 'create' ? reservation.preparedCreation?.creation?.createOperationId
    : reservation.kind === 'reopen' ? reservation.callerOperationId
      : reservation.restart?.request.operationId ?? reservation.preparedSession?.continuity?.operationId
  return { kind: reservation.kind, lifecycleOperationId: reservation.operationId, phase, ...(operationId ? { operationId } : {}),
    ...(expectedRun ? { expectedRun: { ...expectedRun } } : {}) }
}

export function lifecycleObserved(reservation: PreparedLifecycle, run?: AgentMuxRunRef,
  phase?: AgentMuxLifecycleDiagnosticSource['phase']): Extract<AgentMuxClientEvent, { type: 'agent-lifecycle-observed' }> {
  return { type: 'agent-lifecycle-observed', agentSessionId: reservation.agentSessionId,
    lifecycle: lifecycleDiagnosticSource(reservation, phase), evidence: { source: 'agentmux', observedAt: Date.now(), ...(run ? { run: { ...run } } : {}) } }
}

/** A damaged auxiliary diagnostic must not become another operation's identity. */
export function parseLifecycleDiagnosticEvent(event: AgentMuxClientEvent): void {
  if (event.type !== 'agent-lifecycle-observed' && (event.type !== 'agent-error' || event.lifecycle === undefined)) return
  const bad = (): never => { throw new AgentMuxError('The original lifecycle diagnostic identity is malformed.', 'CONTROL_PROTOCOL_ERROR') }
  const id = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/u.test(value)) bad() }
  id(event.agentSessionId)
  if (event.evidence.source !== 'agentmux' || !Number.isSafeInteger(event.evidence.observedAt) || event.evidence.observedAt < 0) bad()
  const source = rpcRecord(event.lifecycle, ['kind', 'lifecycleOperationId', 'operationId', 'phase', 'expectedRun'], 'CONTROL_PROTOCOL_ERROR')
  if (!['create', 'resume', 'reopen'].includes(source.kind as string) || !['prepared-run', 'restart-accounting'].includes(source.phase as string)) bad()
  id(source.lifecycleOperationId)
  if (source.operationId !== undefined) id(source.operationId)
  if (source.phase === 'restart-accounting' && source.kind !== 'resume') bad()
  if (source.expectedRun !== undefined) {
    const run = rpcRecord(source.expectedRun, ['runId'], 'CONTROL_PROTOCOL_ERROR'); id(run.runId)
  }
  if (source.kind === 'create' ? source.expectedRun !== undefined : source.expectedRun === undefined) bad()
}
