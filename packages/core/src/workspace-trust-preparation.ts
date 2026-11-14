import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** One original lifecycle's preparation receipt, never proof of native initialization or input readiness. */
export type AgentWorkspaceTrustPreparation = {
  lifecycleOperationId: string
  workspacePath: string
  step: 'home-identity' | 'trust-record'
  status: 'trusted' | 'already-trusted' | 'not-applicable' | 'unconfirmed'
  trustKey: string | null
  code: string
  issue?: string
  observedAt: number
}

export function parseWorkspaceTrustPreparation(value: unknown): AgentWorkspaceTrustPreparation {
  const p = rpcRecord(value, ['lifecycleOperationId', 'workspacePath', 'step', 'status', 'trustKey', 'code', 'issue', 'observedAt'])
  const text = (v: unknown, maximum: number) => typeof v === 'string' && !!v && v.length <= maximum && !/[\0\r\n]/u.test(v)
  if (!text(p.lifecycleOperationId, 512) || !text(p.workspacePath, 16384) || !text(p.code, 512) ||
      !['home-identity', 'trust-record'].includes(String(p.step)) ||
      !['trusted', 'already-trusted', 'not-applicable', 'unconfirmed'].includes(String(p.status)) ||
      !(p.trustKey === null || text(p.trustKey, 16384)) ||
      p.issue !== undefined && (typeof p.issue !== 'string' || p.issue.length > 4096) ||
      !Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0 ||
      p.step === 'home-identity' && p.status !== 'unconfirmed') throw new AgentMuxError(
        'The original workspace trust preparation receipt is invalid.', 'INVALID_AGENT_SESSION_STORE')
  return structuredClone(p) as AgentWorkspaceTrustPreparation
}
