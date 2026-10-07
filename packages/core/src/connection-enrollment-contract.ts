import type { ConnectionApplication, ConnectionOperation } from './connections-contract.js'

export type ConnectionEnrollmentReason = 'adapter-unavailable' | 'secure-storage-unavailable' | 'storage-unconfirmed' | 'begin-unconfirmed' | 'poll-unconfirmed' | 'credential-unconfirmed' | 'configuration-unconfirmed' | 'connection-conflict' | 'authority-unavailable' | 'platform-denied' | 'platform-expired' | 'platform-not-applied'
/** Local implementation availability, never remote account eligibility or granted scopes. */
export type ConnectionEnrollmentCapability = { adapterId: string; domain: string; label: string; availability: 'available' | 'unavailable' | 'unknown'; reason?: 'adapter-unavailable' | 'secure-storage-unavailable' }
export type ConnectionEnrollmentChallenge = { verificationUrl: string; userCode?: string; expiresAt: number | null; nextPollAt: number }
export type ConnectionEnrollmentBeginInput = { operationId: string; connectionId: string; adapterId: string; domain: string; label: string; preset?: { name: string; description?: string } }
export type ConnectionEnrollmentOperation = ConnectionEnrollmentBeginInput & {
  revision: number
  authorization: 'not-started' | 'pending' | 'authorized' | 'denied' | 'expired' | 'unknown'
  credential: 'not-started' | 'storing' | 'stored' | 'unknown'
  configuration: 'not-started' | 'saving' | 'configured' | 'unknown' | 'refused'
  application: ConnectionApplication | null
  challenge: ConnectionEnrollmentChallenge | null
  /** The immutable original configuration receipt, separate from current connection health. */
  configured: ConnectionOperation | null
  reason?: ConnectionEnrollmentReason
}
export type ConnectionEnrollmentOperationInput = { operationId: string }
export type ConnectionEnrollmentListInput = { cursor?: string; limit?: number }
export type ConnectionEnrollmentListResult = { operations: ConnectionEnrollmentOperation[]; next: string | null; capabilities: ConnectionEnrollmentCapability[] }
/** Supplied only by the executing transport owner, never by JSON. */
export type ConnectionEnrollmentCallContext = { actor: { kind: 'user' | 'device'; id: string }; assertCurrent?(): void | Promise<void>; signal?: AbortSignal }
export interface ConnectionEnrollmentPort {
  begin(input: ConnectionEnrollmentBeginInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionEnrollmentOperation>
  advance(input: ConnectionEnrollmentOperationInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionEnrollmentOperation>
  inspect(input: ConnectionEnrollmentOperationInput): Promise<{ operation: ConnectionEnrollmentOperation | null }>
  list(input: ConnectionEnrollmentListInput): Promise<ConnectionEnrollmentListResult>
}
export type ConnectionEnrollmentParamsMap = { 'connection.enrollment.begin': ConnectionEnrollmentBeginInput; 'connection.enrollment.advance': ConnectionEnrollmentOperationInput; 'connection.enrollment.inspect': ConnectionEnrollmentOperationInput; 'connection.enrollment.ls': ConnectionEnrollmentListInput }
export type ConnectionEnrollmentResultMap = { 'connection.enrollment.begin': ConnectionEnrollmentOperation; 'connection.enrollment.advance': ConnectionEnrollmentOperation; 'connection.enrollment.inspect': { operation: ConnectionEnrollmentOperation | null }; 'connection.enrollment.ls': ConnectionEnrollmentListResult }
export type ConnectionEnrollmentMethod = keyof ConnectionEnrollmentParamsMap
