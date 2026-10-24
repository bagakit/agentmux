import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRun, AgentMuxRunRef } from './types.js'

/** Recovery addresses an original raw Run, never a durable Agent Session. */
export type AgentMuxTerminalRecoveryInput = {
  expectedRun: AgentMuxRunRef
  runtimeId: string
  workspacePath: string
  operationId: string
  /** Ordinary reentry only observes an uncertain Start. Continue explicitly fences it. */
  action?: 'recover' | 'inspect' | 'continue'
}
export type AgentMuxTerminalRecoveryResult = {
  expectedRun: AgentMuxRunRef
  runtimeId: string
  /** Canonical original intent, including after a new caller or Core process reenters. */
  operationId: string
} & ({ kind: 'reattachable' | 'recovered'; run: AgentMuxRun } |
  { kind: 'pending'; phase: 'prepared' | 'dispatched' | 'not_applied' | 'retained'; message: string; replacementRun?: AgentMuxRunRef })

const id = (v: unknown): v is string => typeof v === 'string' && !!v && !/[\0\r\n]/u.test(v)
function service(value: unknown): void {
  if (value === null) return
  const record = (v: unknown, keys: string[]) => rpcRecord(v, keys, 'CONTROL_PROTOCOL_ERROR')
  const fail = (): never => { throw new AgentMuxError('Malformed Terminal Native service observation.', 'CONTROL_PROTOCOL_ERROR') }
  const count = (v: unknown) => { if (!Number.isSafeInteger(v) || Number(v) < 0) fail() }
  const failure = (v: unknown) => {
    if (['owner_stopped', 'owner_unwound', 'read_failed', 'write_failed', 'historical', 'control_closed'].includes(String(v))) return
    const error = record(record(v, ['ownerIoFailed']).ownerIoFailed, ['stage', 'osError'])
    if (!['poll', 'wake_drain'].includes(String(error.stage)) || error.osError !== null && !Number.isSafeInteger(error.osError)) fail()
  }
  const lane = (v: unknown, types: string[], failed: string) => {
    const r = record(v, ['type', 'reason'])
    if (r.type === failed) failure(r.reason)
    else if (!types.includes(String(r.type)) || r.reason !== undefined) fail()
  }
  const r = record(value, ['revision', 'owner', 'output', 'input', 'terminalFault'])
  count(r.revision); lane(r.owner, ['starting', 'serving', 'draining'], 'stopped'); lane(r.output, ['pending', 'serving', 'backpressured', 'closed'], 'unavailable')
  const input = record(r.input, ['phase', 'unsettledCommands', 'unsettledRequestBytes', 'writeBlocked', 'completedInputBytes', 'currentSize', 'activeConfirmedBytes'])
  lane(input.phase, ['open', 'closed'], 'unavailable')
  for (const key of ['unsettledCommands', 'unsettledRequestBytes', 'activeConfirmedBytes']) count(input[key])
  if (typeof input.writeBlocked !== 'boolean') fail()
  if (input.completedInputBytes !== null) count(input.completedInputBytes)
  if (input.currentSize !== null) { const size = record(input.currentSize, ['cols', 'rows']); count(size.cols); count(size.rows); if (!size.cols || !size.rows) fail() }
  if (r.terminalFault !== null) { const fault = record(r.terminalFault, ['stage', 'throughByte']); if (!['process', 'resize', 'export', 'recovery'].includes(String(fault.stage))) fail(); count(fault.throughByte) }
}
export function parseTerminalRecoveryInput(value: unknown): AgentMuxTerminalRecoveryInput {
  const r = rpcRecord(value, ['expectedRun', 'runtimeId', 'workspacePath', 'operationId', 'action'])
  const run = rpcRecord(r.expectedRun, ['runId'])
  if (![run.runId, r.runtimeId, r.operationId].every(id) || !id(r.workspacePath) || !isAbsolute(r.workspacePath) ||
      r.action !== undefined && !['recover', 'inspect', 'continue'].includes(String(r.action)))
    throw new AgentMuxError('Terminal recovery requires its exact original Run, Runtime, directory and operation.', 'INVALID_CONTROL_REQUEST')
  return structuredClone(r) as AgentMuxTerminalRecoveryInput
}
export function parseTerminalRecoveryResult(value: unknown, input: AgentMuxTerminalRecoveryInput): AgentMuxTerminalRecoveryResult {
  const r = rpcRecord(value, ['expectedRun', 'runtimeId', 'operationId', 'kind', 'run', 'phase', 'message', 'replacementRun'], 'CONTROL_PROTOCOL_ERROR')
  const run = rpcRecord(r.expectedRun, ['runId'], 'CONTROL_PROTOCOL_ERROR')
  const fail = (): never => { throw new AgentMuxError('Terminal recovery returned another original target or malformed receipt.', 'CONTROL_PROTOCOL_ERROR') }
  if (run.runId !== input.expectedRun.runId || r.runtimeId !== input.runtimeId || !id(r.operationId)) fail()
  if (r.kind === 'pending') {
    if (!['prepared', 'dispatched', 'not_applied', 'retained'].includes(String(r.phase)) || typeof r.message !== 'string' || r.run !== undefined) fail()
    if (r.replacementRun !== undefined && !id(rpcRecord(r.replacementRun, ['runId'], 'CONTROL_PROTOCOL_ERROR').runId)) fail()
  } else {
    if (r.kind !== 'reattachable' && r.kind !== 'recovered' || r.phase !== undefined || r.message !== undefined || r.replacementRun !== undefined) fail()
    const current = rpcRecord(r.run, ['runId', 'kind', 'providerId', 'executorId', 'agentSessionId', 'workspacePath', 'pid', 'state', 'cols', 'rows', 'observedAt', 'latestOutputBytes', 'acceptedInputBytes', 'nativeService', 'exitCode', 'exitSignal', 'exitReason', 'interruptionReason'], 'CONTROL_PROTOCOL_ERROR')
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
    if (!id(current.runId) || current.kind !== 'terminal' || current.providerId !== null || current.executorId !== null || current.agentSessionId !== null || current.workspacePath !== input.workspacePath || current.state !== 'running' ||
        !count(current.observedAt) || !count(current.latestOutputBytes) || current.acceptedInputBytes !== null && !count(current.acceptedInputBytes) ||
        current.pid !== null && (!count(current.pid) || Number(current.pid) < 1) ||
        [current.cols, current.rows].some(size => size !== null && (!count(size) || Number(size) < 1)) ||
        r.kind === 'reattachable' && current.runId !== input.expectedRun.runId) fail()
    service(current.nativeService)
  }
  return structuredClone(r) as AgentMuxTerminalRecoveryResult
}
