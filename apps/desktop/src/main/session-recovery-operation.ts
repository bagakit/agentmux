import { isAgentMuxRpcReplyUnconfirmed } from '@agentmux/core'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import type { SessionRecoveryResult } from '../shared/contracts'
import type { SessionRecoveryOperationReply } from '../shared/session-recovery-result'

/** The transport owner, rather than a message/code heuristic, identifies a lost Core reply. */
export async function sessionRecoveryOperationResult(operation: () => Promise<SessionRecoveryResult>): Promise<SessionRecoveryOperationReply> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    const failure = deliveryFailure(error)
    const reply = isAgentMuxRpcReplyUnconfirmed(error) ? 'unconfirmed' : 'received'
    const source = error instanceof Error ? error as Error & { moteMainRollover?: import('@agentmux/core/mote-dialogue').MoteMainRolloverDecision } : null
    return { ok: false, reply,
      error: { ...failure, code: failure.code ?? 'SESSION_RECOVERY_FAILED',
        ...(reply === 'received' && source?.moteMainRollover ? { moteMainRollover: source.moteMainRollover } : {}) } }
  }
}
