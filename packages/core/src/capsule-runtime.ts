import { AgentMuxError, parseAgentMuxErrorData, type AgentMuxErrorData } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseCreationRuntime, type AgentMuxCreationRuntime } from './terminal-creation-retirement.js'

/** Core manages one service Run; the Capsule package alone owns page state. */
export const CAPSULE_RUNTIME_METHODS = {
  'capsule.runtime.inspect': 'short',
  'capsule.runtime.start': 'long',
  'capsule.runtime.stop': 'long',
} as const
export type CapsuleRuntimeMethod = keyof typeof CAPSULE_RUNTIME_METHODS
export type CapsuleRuntimeCommand = { operationId: string; expectedRevision: number }
export type CapsuleRuntimeRecoveryTarget = { revision: number; managementOperationId: string | null; createOperationId: string; launchDigest: string; runtime: AgentMuxCreationRuntime }
/** Older retained bindings may have no recorded Native lineage. null is unknown, never the current listener. */
export type CapsuleRuntimeRecoveryCandidate = Omit<CapsuleRuntimeRecoveryTarget, 'runtime'> & { runtime: AgentMuxCreationRuntime | null }
export type CapsuleRuntimeRecovery = { operationId: string; target: CapsuleRuntimeRecoveryTarget; phase: 'intent' | 'retired' | 'retained' | 'unknown' | 'not_applied';
  runtime?: AgentMuxCreationRuntime; run?: { runId: string } }
export type CapsuleRuntimeParamsMap = {
  'capsule.runtime.inspect': { operationId?: string }
  'capsule.runtime.start': CapsuleRuntimeCommand & { recovery?: CapsuleRuntimeRecoveryTarget }
  'capsule.runtime.stop': CapsuleRuntimeCommand & { expectedRun: { runId: string } | null }
}
export type CapsuleRuntimeOperation = {
  operationId: string
  kind: 'start' | 'stop'
  phase: 'pending' | 'confirmed' | 'unknown' | 'superseded' | 'not_applied'
  failure?: AgentMuxErrorData
  firstFailure?: AgentMuxErrorData
}
export type CapsuleRuntimeObservation = {
  revision: number
  desired: 'unconfigured' | 'running' | 'stopped'
  phase: 'unconfigured' | 'running' | 'starting' | 'stopping' | 'stopped' | 'unknown' | 'unavailable'
  stateDirectory: string
  socketPath: string
  run: { hostId: 'local'; runId: string } | null
  runtime: { runtimeId: string; ownerInstanceId: string; pid: number } | null
  operation: CapsuleRuntimeOperation | null
  issue: { code: string; message: string; recovery: string; retry?: 'start' | 'stop' } | null
  recoveryTarget?: CapsuleRuntimeRecoveryCandidate
  recovery?: CapsuleRuntimeRecovery
}
export type CapsuleRuntimeResultMap = { [M in CapsuleRuntimeMethod]: CapsuleRuntimeObservation }
export interface CapsuleRuntimePort {
  call<M extends CapsuleRuntimeMethod>(method: M, params: CapsuleRuntimeParamsMap[M]): Promise<CapsuleRuntimeResultMap[M]>
}
export function isCapsuleRuntimeMethod(method: string): method is CapsuleRuntimeMethod {
  return Object.hasOwn(CAPSULE_RUNTIME_METHODS, method)
}
export function parseCapsuleRuntimeParams<M extends CapsuleRuntimeMethod>(method: M, value: unknown): CapsuleRuntimeParamsMap[M] {
  const p = rpcRecord(value, method.endsWith('.inspect') ? ['operationId'] : method.endsWith('.stop')
    ? ['operationId', 'expectedRevision', 'expectedRun'] : ['operationId', 'expectedRevision', 'recovery'])
  if (p.operationId !== undefined && (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(p.operationId)))
    throw new AgentMuxError('Capsule runtime inspection requires an exact original operation ID.', 'INVALID_CONTROL_REQUEST')
  if (method !== 'capsule.runtime.inspect') {
    if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(p.operationId) ||
      !Number.isSafeInteger(p.expectedRevision) || Number(p.expectedRevision) < 0)
      throw new AgentMuxError('Capsule runtime management requires an original operation ID and revision.', 'INVALID_CONTROL_REQUEST')
    if (method === 'capsule.runtime.stop' && p.expectedRun !== null) {
      const run = rpcRecord(p.expectedRun, ['runId'])
      if (typeof run.runId !== 'string' || !run.runId || /[\0\r\n]/u.test(run.runId))
        throw new AgentMuxError('Stop requires the exact observed service Run.', 'INVALID_CONTROL_REQUEST')
    }
    if (method === 'capsule.runtime.start' && p.recovery !== undefined) parseCapsuleRuntimeRecoveryTarget(p.recovery)
  }
  return structuredClone(p) as CapsuleRuntimeParamsMap[M]
}
export function parseCapsuleRuntimeRecoveryTarget(value: unknown): CapsuleRuntimeRecoveryTarget {
  return parseCapsuleRuntimeRecoveryCandidate(value, true) as CapsuleRuntimeRecoveryTarget
}
function parseCapsuleRuntimeRecoveryCandidate(value: unknown, requireRuntime = false): CapsuleRuntimeRecoveryCandidate {
  const p = rpcRecord(value, ['revision', 'managementOperationId', 'createOperationId', 'launchDigest', 'runtime'])
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(v)
  if (!Number.isSafeInteger(p.revision) || Number(p.revision) < 1 || p.managementOperationId !== null && !id(p.managementOperationId) ||
    !id(p.createOperationId) || typeof p.launchDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.launchDigest))
    throw new AgentMuxError('Recovery requires the exact original Capsule service creation target.', 'INVALID_CONTROL_REQUEST')
  if (requireRuntime || p.runtime !== null) parseCreationRuntime(p.runtime)
  return structuredClone(p) as CapsuleRuntimeRecoveryCandidate
}
export function parseCapsuleRuntimeRecovery(value: unknown): CapsuleRuntimeRecovery {
  const p = rpcRecord(value, ['operationId', 'target', 'phase', 'runtime', 'run'])
  const target = parseCapsuleRuntimeRecoveryTarget(p.target)
  if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(p.operationId) || !['intent', 'retired', 'retained', 'unknown', 'not_applied'].includes(String(p.phase))) throw new AgentMuxError('The original retirement phase is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (p.runtime !== undefined) {
    const runtime = parseCreationRuntime(p.runtime)
    if (runtime.runtimeId !== target.runtime.runtimeId) throw new AgentMuxError('The original retirement receipt belongs to another persistent Runtime.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (p.run !== undefined) { const r = rpcRecord(p.run, ['runId']); if (typeof r.runId !== 'string' || !r.runId || /[\0\r\n]/u.test(r.runId)) throw new AgentMuxError('The retained retirement Run is invalid.', 'CONTROL_PROTOCOL_ERROR') }
  if (p.phase === 'retained' && p.run === undefined || p.phase === 'retired' && p.run !== undefined ||
    ['retired', 'retained'].includes(String(p.phase)) && p.runtime === undefined) throw new AgentMuxError('The original retirement receipt is incomplete.', 'CONTROL_PROTOCOL_ERROR')
  return structuredClone(p) as CapsuleRuntimeRecovery
}
export function parseCapsuleRuntimeResult(value: unknown): CapsuleRuntimeObservation {
  const code = 'CONTROL_PROTOCOL_ERROR', fail = (): never => { throw new AgentMuxError('The Capsule runtime observation is invalid.', code) }
  const p = rpcRecord(value, ['revision', 'desired', 'phase', 'stateDirectory', 'socketPath', 'run', 'runtime', 'operation', 'issue', 'recoveryTarget', 'recovery'], code)
  const str = (v: unknown) => typeof v === 'string' && !!v && !/[\0\r\n]/u.test(v)
  if (['revision', 'desired', 'phase', 'stateDirectory', 'socketPath', 'run', 'runtime', 'operation', 'issue'].some(key => !Object.hasOwn(p, key)) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0 ||
    !['unconfigured', 'running', 'stopped'].includes(String(p.desired)) ||
    !['unconfigured', 'running', 'starting', 'stopping', 'stopped', 'unknown', 'unavailable'].includes(String(p.phase)) ||
    !str(p.stateDirectory) || !str(p.socketPath)) fail()
  if (p.run !== null) { const r = rpcRecord(p.run, ['hostId', 'runId'], code); if (r.hostId !== 'local' || !str(r.runId)) fail() }
  if (p.runtime !== null) { const r = rpcRecord(p.runtime, ['runtimeId', 'ownerInstanceId', 'pid'], code)
    if (!str(r.runtimeId) || !str(r.ownerInstanceId) || !Number.isSafeInteger(r.pid) || Number(r.pid) <= 0) fail() }
  if (p.operation !== null) { const r = rpcRecord(p.operation, ['operationId', 'kind', 'phase', 'failure', 'firstFailure'], code)
    if (!str(r.operationId) || !['start', 'stop'].includes(String(r.kind)) || !['pending', 'confirmed', 'unknown', 'superseded', 'not_applied'].includes(String(r.phase))) fail()
    if (r.failure !== undefined) parseAgentMuxErrorData(r.failure)
    if (r.firstFailure !== undefined) parseAgentMuxErrorData(r.firstFailure)
    if (r.phase === 'not_applied' && r.failure === undefined) fail() }
  if (p.issue !== null) { const r = rpcRecord(p.issue, ['code', 'message', 'recovery', 'retry'], code); if (!str(r.code) || !str(r.message) || !str(r.recovery) || r.retry !== undefined && !['start', 'stop'].includes(String(r.retry))) fail() }
  if (p.recoveryTarget !== undefined) parseCapsuleRuntimeRecoveryCandidate(p.recoveryTarget)
  if (p.recovery !== undefined) parseCapsuleRuntimeRecovery(p.recovery)
  return structuredClone(p) as CapsuleRuntimeObservation
}
