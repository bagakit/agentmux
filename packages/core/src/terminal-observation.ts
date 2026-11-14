import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'
import type { AgentMuxRun, AgentMuxRunReplayGap } from './types.js'

export type TerminalTarget = { hostId: string; runtimeId: string; run: { runId: string } }
export type TerminalInspection = { runtime: AgentMuxCreationRuntime; run: AgentMuxRun; firstAvailableByte: number }
export type TerminalInspectResult = TerminalInspection & { target: TerminalTarget }
export type TerminalOutputParams = { target: TerminalTarget; afterByte?: number; follow?: boolean }
export type TerminalOutputInitial = TerminalInspectResult & { gap: AgentMuxRunReplayGap | null }
export type TerminalListCursor = { runtimeId: string; ownerInstanceId: string; afterRunId: string }
export type TerminalListParams = { hostId: string; cursor?: TerminalListCursor; limit?: number }
export type TerminalListResult = { hostId: string; runtime: AgentMuxCreationRuntime; items: TerminalInspectResult[];
  nextCursor: TerminalListCursor | null; coverage: 'live-page' }
const fail = () => { throw new AgentMuxError('The original raw Terminal target or observation is invalid.', 'CONTROL_PROTOCOL_ERROR') }
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\0\r\n]/u.test(v)
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
export function parseTerminalListParams(value: unknown): TerminalListParams {
  const r = rpcRecord(value, ['hostId', 'cursor', 'limit'])
  if (!id(r.hostId) || r.limit !== undefined && (!count(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 1000))
    throw new AgentMuxError('Terminal listing needs an exact Host and a page limit from 1 to 1000.', 'INVALID_CONTROL_REQUEST')
  if (r.cursor !== undefined) {
    const cursor = rpcRecord(r.cursor, ['runtimeId', 'ownerInstanceId', 'afterRunId'])
    if (![cursor.runtimeId, cursor.ownerInstanceId, cursor.afterRunId].every(id))
      throw new AgentMuxError('Keep the complete original Terminal page cursor.', 'INVALID_CONTROL_REQUEST')
  }
  return structuredClone(r) as TerminalListParams
}
export function parseTerminalListResult(value: unknown, input: TerminalListParams): TerminalListResult {
  const r = rpcRecord(value, ['hostId', 'runtime', 'items', 'nextCursor', 'coverage'], 'CONTROL_PROTOCOL_ERROR')
  const runtime = parseCreationRuntime(r.runtime)
  if (r.hostId !== input.hostId || r.coverage !== 'live-page' || !Array.isArray(r.items) || r.items.length > (input.limit ?? 100) ||
    input.cursor && (input.cursor.runtimeId !== runtime.runtimeId || input.cursor.ownerInstanceId !== runtime.instanceId)) fail()
  const seen = new Set<string>()
  for (const item of r.items as unknown[]) {
    const target = parseTerminalTarget(rpcRecord(item, undefined, 'CONTROL_PROTOCOL_ERROR').target)
    if (target.hostId !== input.hostId || target.runtimeId !== runtime.runtimeId || seen.has(target.run.runId) ||
      input.cursor && target.run.runId <= input.cursor.afterRunId) fail()
    seen.add(target.run.runId); parseTerminalInspection(item, target)
  }
  if (r.nextCursor !== null) {
    const cursor = rpcRecord(r.nextCursor, ['runtimeId', 'ownerInstanceId', 'afterRunId'], 'CONTROL_PROTOCOL_ERROR')
    if (cursor.runtimeId !== runtime.runtimeId || cursor.ownerInstanceId !== runtime.instanceId || !id(cursor.afterRunId) ||
      input.cursor && cursor.afterRunId <= input.cursor.afterRunId || [...seen].some(runId => runId > String(cursor.afterRunId))) fail()
  }
  return structuredClone(r) as TerminalListResult
}
function serviceFailure(value: unknown): void {
  if (typeof value === 'string' && ['owner_stopped', 'owner_unwound', 'read_failed', 'write_failed', 'historical', 'control_closed'].includes(value)) return
  const r = rpcRecord(value, ['ownerIoFailed'], 'CONTROL_PROTOCOL_ERROR')
  const failure = rpcRecord(r.ownerIoFailed, ['stage', 'osError'], 'CONTROL_PROTOCOL_ERROR')
  if (!['poll', 'wake_drain'].includes(String(failure.stage)) || failure.osError !== null && !Number.isSafeInteger(failure.osError)) fail()
}
function service(value: unknown): void {
  if (value === null) return
  const r = rpcRecord(value, ['revision', 'owner', 'output', 'input', 'terminalFault'], 'CONTROL_PROTOCOL_ERROR')
  if (!count(r.revision)) fail()
  for (const [key, states, failed] of [
    ['owner', ['starting', 'serving', 'draining', 'stopped'], 'stopped'],
    ['output', ['pending', 'serving', 'backpressured', 'closed', 'unavailable'], 'unavailable']
  ] as const) {
    const lane = rpcRecord(r[key], ['type', 'reason'], 'CONTROL_PROTOCOL_ERROR')
    if (!(states as readonly unknown[]).includes(lane.type)) fail()
    if (lane.type === failed) serviceFailure(lane.reason)
    else if (Object.hasOwn(lane, 'reason')) fail()
  }
  const input = rpcRecord(r.input, ['phase', 'unsettledCommands', 'unsettledRequestBytes', 'writeBlocked', 'completedInputBytes', 'currentSize', 'activeConfirmedBytes'], 'CONTROL_PROTOCOL_ERROR')
  const phase = rpcRecord(input.phase, ['type', 'reason'], 'CONTROL_PROTOCOL_ERROR')
  if (!['open', 'closed', 'unavailable'].includes(String(phase.type))) fail()
  if (phase.type === 'unavailable') serviceFailure(phase.reason)
  else if (Object.hasOwn(phase, 'reason')) fail()
  if (![input.unsettledCommands, input.unsettledRequestBytes, input.activeConfirmedBytes].every(count) || typeof input.writeBlocked !== 'boolean' ||
    input.completedInputBytes !== null && !count(input.completedInputBytes)) fail()
  if (input.currentSize !== null) {
    const size = rpcRecord(input.currentSize, ['cols', 'rows'], 'CONTROL_PROTOCOL_ERROR')
    if (![size.cols, size.rows].every(v => count(v) && Number(v) > 0)) fail()
  }
  if (r.terminalFault !== null) {
    const fault = rpcRecord(r.terminalFault, ['stage', 'throughByte'], 'CONTROL_PROTOCOL_ERROR')
    if (!['process', 'resize', 'export', 'recovery'].includes(String(fault.stage)) || !count(fault.throughByte)) fail()
  }
}

export function parseTerminalTarget(value: unknown): TerminalTarget {
  const r = rpcRecord(value, ['hostId', 'runtimeId', 'run'])
  const run = rpcRecord(r.run, ['runId'])
  if (![r.hostId, r.runtimeId, run.runId].every(id)) throw new AgentMuxError('Use the complete original Host, persistent Runtime and raw Run.', 'INVALID_CONTROL_REQUEST')
  return { hostId: r.hostId as string, runtimeId: r.runtimeId as string, run: { runId: run.runId as string } }
}
export function parseTerminalOutputParams(value: unknown): TerminalOutputParams {
  const r = rpcRecord(value, ['target', 'afterByte', 'follow'])
  const target = parseTerminalTarget(r.target)
  if (r.afterByte !== undefined && !count(r.afterByte) || r.follow !== undefined && typeof r.follow !== 'boolean')
    throw new AgentMuxError('Terminal output needs a nonnegative byte cursor and boolean follow.', 'INVALID_CONTROL_REQUEST')
  return { ...r, target } as TerminalOutputParams
}
/** The same public raw Run validation for current observations and original creation ACKs. */
export function parseRawTerminalRun(value: unknown, runId: string): AgentMuxRun {
  if (!id(runId)) fail()
  const run = rpcRecord(value, ['runId', 'kind', 'providerId', 'executorId', 'agentSessionId', 'workspacePath', 'pid', 'state', 'cols', 'rows', 'observedAt', 'latestOutputBytes', 'acceptedInputBytes', 'nativeService', 'exitCode', 'exitSignal', 'exitReason', 'interruptionReason'], 'CONTROL_PROTOCOL_ERROR')
  if (run.runId !== runId || run.kind !== 'terminal' || run.agentSessionId !== null || run.providerId !== null || run.executorId !== null ||
    typeof run.workspacePath !== 'string' || !['running', 'exited', 'interrupted'].includes(String(run.state)) || !count(run.latestOutputBytes) ||
    !count(run.observedAt) ||
    run.acceptedInputBytes !== null && !count(run.acceptedInputBytes) ||
    [run.pid, run.cols, run.rows].some(v => v !== null && (!Number.isSafeInteger(v) || Number(v) < 1))) fail()
  service(run.nativeService)
  if (run.exitCode !== undefined && !Number.isSafeInteger(run.exitCode) ||
    [run.exitSignal, run.interruptionReason].some(v => v !== undefined && typeof v !== 'string')) fail()
  return structuredClone(run) as AgentMuxRun
}
export function parseTerminalInspection(value: unknown, target: TerminalTarget, output?: { afterByte?: number }): TerminalInspectResult | TerminalOutputInitial {
  const r = rpcRecord(value, output ? ['target', 'runtime', 'run', 'firstAvailableByte', 'gap'] : ['target', 'runtime', 'run', 'firstAvailableByte'], 'CONTROL_PROTOCOL_ERROR')
  const actual = parseTerminalTarget(r.target), runtime = parseCreationRuntime(r.runtime)
  if (actual.hostId !== target.hostId || actual.runtimeId !== target.runtimeId || actual.run.runId !== target.run.runId || runtime.runtimeId !== target.runtimeId) fail()
  const run = parseRawTerminalRun(r.run, target.run.runId)
  if (!count(r.firstAvailableByte) || Number(r.firstAvailableByte) > run.latestOutputBytes) fail()
  if (output) {
    if (r.gap !== null) {
      const gap = rpcRecord(r.gap, ['requestedAfterByte', 'firstAvailableByte'], 'CONTROL_PROTOCOL_ERROR')
      if (gap.requestedAfterByte !== (output.afterByte ?? 0) || gap.firstAvailableByte !== r.firstAvailableByte ||
        !count(gap.firstAvailableByte) || Number(gap.firstAvailableByte) <= Number(gap.requestedAfterByte)) fail()
    } else if ((output.afterByte ?? 0) < Number(r.firstAvailableByte)) fail()
  }
  return structuredClone({ ...r, runtime }) as TerminalInspectResult | TerminalOutputInitial
}
