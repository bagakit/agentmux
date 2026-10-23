import type { SessionInputOperationResult, SessionRecoveryResult } from './contracts'
import { unwrapSessionInputOperationResult } from './session-input-result'

export type SessionRecoveryOperationReply =
  | Extract<SessionInputOperationResult<SessionRecoveryResult>, { ok: true }>
  | (Extract<SessionInputOperationResult<SessionRecoveryResult>, { ok: false }> & { reply: 'received' | 'unconfirmed' })

const unconfirmedRecoveryReplies = new WeakSet<Error>()
export function isSessionRecoveryReplyUnconfirmed(error: unknown): boolean {
  return error instanceof Error && unconfirmedRecoveryReplies.has(error)
}

/** A transport lost the reply; it did not certify whether the original recovery applied. */
export function sessionRecoveryReplyUnconfirmed(cause: unknown): Error {
  const error = Object.assign(new Error('The original recovery reply is unconfirmed. Inspect this same Session and operation.', { cause }), {
    code: 'SESSION_RECOVERY_REPLY_UNCONFIRMED', controlFailure: { disposition: 'unknown' as const, confirmedInputBytes: null }
  })
  unconfirmedRecoveryReplies.add(error)
  return error
}

/** Keep an owner refusal separate from failure to receive its IPC envelope. */
export async function readSessionRecoveryReply(invoke: () => Promise<SessionRecoveryOperationReply>): Promise<SessionRecoveryResult> {
  let reply: SessionRecoveryOperationReply
  try { reply = await invoke() }
  catch (cause) { throw sessionRecoveryReplyUnconfirmed(cause) }
  if (!reply.ok && reply.reply === 'unconfirmed') {
    let cause: unknown
    try { unwrapSessionInputOperationResult(reply) } catch (error) { cause = error }
    throw sessionRecoveryReplyUnconfirmed(cause)
  }
  return unwrapSessionInputOperationResult(reply)
}
