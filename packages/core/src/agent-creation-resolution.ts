import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRunRef } from './types.js'

/** Explicit control over the original creation only. It never authorizes another Start or input. */
export type AgentMuxCreationResolveInput = {
  createOperationId: string
  agentSessionId?: string
  operationId: string
}
export type AgentMuxCreationInspectParams = { hostId: string; createOperationId: string; agentSessionId?: string }
export type AgentMuxCreationResolveParams = AgentMuxCreationResolveInput & { hostId: string }
export type AgentMuxCreationResolution = {
  operationId: string
  createOperationId: string
  agentSessionId: string
  originalCreationKey: string
  runtimeId: string
  admittedAt: number
  /** A retained observation never asserts that the request was saved before dispatch. */
  source: { kind: 'prepared-dispatch' } | { kind: 'observed-retained'; retainedRun: AgentMuxRunRef }
  /** This control never rewrites an old Start/input outcome as not_applied. */
  historicalEffect: 'unknown'
  /** Only the old creation's automatic initial input is held; new inputs remain independent. */
  initialInputContinuation: 'held'
} & ({ outcome: 'pending' } | { outcome: 'retained'; retainedRun: AgentMuxRunRef } | { outcome: 'fenced' })

const invalid = (): never => { throw new AgentMuxError('Creation recovery requires the exact original operation, optional Session, and a distinct control operation.', 'INVALID_CREATION_RESOLUTION') }
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 512 && !/[\0\r\n]/u.test(value)
export function parseCreationInspectParams(value: unknown): AgentMuxCreationInspectParams {
  const r = rpcRecord(value, ['hostId', 'createOperationId', 'agentSessionId'], 'INVALID_CREATION_RESOLUTION')
  if (!id(r.hostId) || !id(r.createOperationId) || r.agentSessionId !== undefined && !id(r.agentSessionId)) invalid()
  return structuredClone(r) as AgentMuxCreationInspectParams
}
export function parseCreationResolveInput(value: unknown): AgentMuxCreationResolveInput {
  const r = rpcRecord(value, ['createOperationId', 'agentSessionId', 'operationId'], 'INVALID_CREATION_RESOLUTION')
  if (!id(r.createOperationId) || !id(r.operationId) || r.operationId === r.createOperationId || r.agentSessionId !== undefined && !id(r.agentSessionId)) invalid()
  return structuredClone(r) as AgentMuxCreationResolveInput
}
export function parseCreationResolveParams(value: unknown): AgentMuxCreationResolveParams {
  const r = rpcRecord(value, ['hostId', 'createOperationId', 'agentSessionId', 'operationId'], 'INVALID_CREATION_RESOLUTION')
  const { hostId, ...request } = r
  if (!id(hostId)) invalid()
  return { ...parseCreationResolveInput(request), hostId: hostId as string }
}
export function parseCreationResolution(value: unknown): AgentMuxCreationResolution {
  const r = rpcRecord(value, ['operationId', 'createOperationId', 'agentSessionId', 'originalCreationKey', 'runtimeId', 'admittedAt',
    'source', 'historicalEffect', 'initialInputContinuation', 'outcome', 'retainedRun'], 'INVALID_CREATION_RESOLUTION')
  if (['operationId', 'createOperationId', 'agentSessionId', 'originalCreationKey', 'runtimeId'].some(key => !id(r[key])) ||
      !Number.isSafeInteger(r.admittedAt) || Number(r.admittedAt) < 0 || r.historicalEffect !== 'unknown' || r.initialInputContinuation !== 'held' ||
      !['pending', 'retained', 'fenced'].includes(String(r.outcome))) invalid()
  const source = rpcRecord(r.source, ['kind', 'retainedRun'], 'INVALID_CREATION_RESOLUTION')
  if (source.kind === 'observed-retained') {
    const run = rpcRecord(source.retainedRun, ['runId'], 'INVALID_CREATION_RESOLUTION')
    if (!id(run.runId) || r.outcome === 'fenced') invalid()
  } else if (source.kind !== 'prepared-dispatch' || source.retainedRun !== undefined) invalid()
  if (r.outcome === 'retained') {
    const run = rpcRecord(r.retainedRun, ['runId'], 'INVALID_CREATION_RESOLUTION')
    if (!id(run.runId) || source.kind === 'observed-retained' && (source.retainedRun as AgentMuxRunRef).runId !== run.runId) invalid()
  } else if (r.retainedRun !== undefined) invalid()
  return structuredClone(r) as AgentMuxCreationResolution
}
