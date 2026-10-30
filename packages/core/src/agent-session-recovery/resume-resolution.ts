import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import type { AgentMuxRunRef } from '../types.js'

/** Safe correlation only. Native retirement never claims that the historical Start had no effects. */
export type AgentMuxResumeResolution = {
  operationId: string
  originalOperationId: string
  originalCreationKey: string
  runtimeId: string
  requestDigest: string
  admittedAt: number
  outcome: 'pending' | 'retained' | 'retired'
  retainedRun?: AgentMuxRunRef
  continuedBy?: { operationId: string; creationKey: string }
}

export function parseResumeResolution(value: unknown): AgentMuxResumeResolution {
  const code = 'INVALID_RESUME_RESOLUTION'
  const r = rpcRecord(value, ['operationId', 'originalOperationId', 'originalCreationKey', 'runtimeId', 'requestDigest', 'admittedAt', 'outcome', 'retainedRun', 'continuedBy'], code)
  const text = (value: unknown) => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value)
  const retained = r.retainedRun === undefined ? undefined : rpcRecord(r.retainedRun, ['runId'], code)
  const continued = r.continuedBy === undefined ? undefined : rpcRecord(r.continuedBy, ['operationId', 'creationKey'], code)
  if (![r.operationId, r.originalOperationId, r.originalCreationKey, r.runtimeId].every(text) ||
      typeof r.requestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(r.requestDigest) ||
      r.operationId === r.originalOperationId || !Number.isSafeInteger(r.admittedAt) || Number(r.admittedAt) < 0 ||
      r.outcome !== 'pending' && r.outcome !== 'retained' && r.outcome !== 'retired' ||
      (r.outcome === 'retained') !== !!retained || retained && !text(retained.runId) ||
      (r.outcome === 'retired') !== !!continued || continued &&
        (continued.operationId !== r.operationId || !text(continued.creationKey) || continued.creationKey === r.originalCreationKey)) {
    throw new AgentMuxError('The original resume resolution correlation is invalid.', code)
  }
  return structuredClone(r) as AgentMuxResumeResolution
}
