import type { ConnectionRecord } from './connections-contract.js'

/** Null joins an unconfirmed original startup observation; it never authorizes receiver replacement. */
export type ConnectionReceiverRecoverInput = { operationId: string; connectionId: string; expectedRevision: number; receiverRef: string | null }
/** The original action decision is distinct from the current receiver observation. */
export type ConnectionReceiverRecoveryOperation = {
  operationId: string; connectionId: string; configurationRevision: number; receiverRef: string | null
  disposition: 'already-ready' | 'joined' | 'scheduled' | 'not-current' | 'disabled' | 'unconfirmed'
}
export type ConnectionReceiverInspection = { operation: ConnectionReceiverRecoveryOperation | null; connection: ConnectionRecord | null }
export type ConnectionReceiverCallContext = {
  actor: { kind: 'user' | 'device'; id: string }
  assertCurrent?(): Promise<void>
}
export type ConnectionReceiverParamsMap = {
  'connection.receiver.recover': ConnectionReceiverRecoverInput
  'connection.receiver.inspect': { operationId: string }
}
export type ConnectionReceiverResultMap = {
  'connection.receiver.recover': ConnectionReceiverInspection & { operation: ConnectionReceiverRecoveryOperation }
  'connection.receiver.inspect': ConnectionReceiverInspection
}
export type ConnectionReceiverMethod = keyof ConnectionReceiverParamsMap
export interface ConnectionReceiverPort {
  recover(input: ConnectionReceiverRecoverInput, context: ConnectionReceiverCallContext): Promise<ConnectionReceiverResultMap['connection.receiver.recover']>
  inspect(input: { operationId: string }, context: ConnectionReceiverCallContext): Promise<ConnectionReceiverInspection>
}
