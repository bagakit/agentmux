import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

/** A finite platform-management intent, distinct from application creation and local save. */
export type ConnectionSetupGoal = { kind: 'agent-conversation'; interaction: 'messages' | 'cards' }
export type ConnectionSetupBegin = { operationId: string; connectionId: string; expectedConnectionRevision: number; goal: ConnectionSetupGoal }
export type ConnectionSetupInput = { operationId: string }
export type ConnectionSetupList = { connectionId: string; cursor?: string; limit?: number }
export type ConnectionSetupReason = 'adapter-unavailable' | 'secure-storage-unavailable' | 'request-unconfirmed' | 'challenge-unconfirmed'
/** Safe durable facts only. Discovery and historical summaries never contain a scan payload. */
export type ConnectionSetupOperation = ConnectionSetupBegin & {
  revision: number
  adapterId: string
  application: ConnectionApplication
  request: { state: 'not-dispatched' | 'dispatching' | 'confirmed' | 'unknown' | 'refused'; attemptId: string | null }
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
  reason?: ConnectionSetupReason
}
/** Active confirmation material; never a URL or evidence of login, grants or setup completion. */
export type ConnectionSetupChallenge = { qrPayload: string; expiresAt: number | null; nextPollAt: number }
export type ConnectionSetupView = { operation: ConnectionSetupOperation | null; challenge: ConnectionSetupChallenge | null; reason?: 'connection-revised' | 'challenge-unavailable' }
export interface ConnectionSetupPort {
  begin(input: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  inspect(input: ConnectionSetupInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  list(input: ConnectionSetupList): Promise<{ operations: ConnectionSetupOperation[]; next: string | null }>
}
export type ConnectionSetupParamsMap = { 'connection.setup.begin': ConnectionSetupBegin; 'connection.setup.inspect': ConnectionSetupInput; 'connection.setup.ls': ConnectionSetupList }
export type ConnectionSetupResultMap = { 'connection.setup.begin': ConnectionSetupView; 'connection.setup.inspect': ConnectionSetupView; 'connection.setup.ls': { operations: ConnectionSetupOperation[]; next: string | null } }
export type ConnectionSetupMethod = keyof ConnectionSetupParamsMap
