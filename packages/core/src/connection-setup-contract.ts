import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

/** A finite platform-management intent, distinct from application creation and local save. */
export type ConnectionSetupGoal = { kind: 'agent-conversation'; interaction: 'messages' | 'cards' }
export type ConnectionSetupBegin = { operationId: string; connectionId: string; expectedConnectionRevision: number; goal: ConnectionSetupGoal }
export type ConnectionSetupInput = { operationId: string }
export type ConnectionSetupAdvance = ConnectionSetupInput & { expectedRevision: number; decision: { actionId: string; value: 'continue' | 'confirm' | 'renew' } }
export type ConnectionSetupList = { connectionId: string; cursor?: string; limit?: number }
/** Local implementation discovery for this exact revision, never platform authority or readiness. */
export type ConnectionSetupSupport = { connectionRevision: number; capabilities: Array<'management-authentication'> }
export type ConnectionSetupListing = { operations: ConnectionSetupOperation[]; next: string | null; support: ConnectionSetupSupport | null }
export type ConnectionSetupReason = 'adapter-unavailable' | 'secure-storage-unavailable' | 'request-unconfirmed' | 'challenge-unconfirmed'
export type ConnectionSetupAuthenticationStage = 'waiting' | 'scanned' | 'handoff' | 'account' | 'confirmed' | 'expired' | 'unknown'
export type ConnectionSetupAccount = { userId: string; tenantId: string; userName?: string; tenantName?: string }
export type ConnectionSetupAction = { actionId: string; expectedRevision: number; kind: 'continue' | 'confirm-account' | 'renew' }
export type ConnectionSetupStepReceipt = { actionId: string; stepId: string; state: 'dispatching' | 'confirmed' | 'unknown' }
/** Safe durable facts only. Discovery and historical summaries never contain a scan payload. */
export type ConnectionSetupOperation = ConnectionSetupBegin & {
  revision: number
  adapterId: string
  application: ConnectionApplication
  request: { state: 'not-dispatched' | 'dispatching' | 'confirmed' | 'unknown' | 'refused'; attemptId: string | null }
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
  reason?: ConnectionSetupReason
  authentication?: {
    attemptId: string
    stepId: string
    stage: ConnectionSetupAuthenticationStage
    request: 'dispatching' | 'confirmed' | 'unknown'
    secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
  }
}
/** Active confirmation material; never a URL or evidence of login, grants or setup completion. */
export type ConnectionSetupChallenge = { qrPayload: string; expiresAt: number | null; nextPollAt: number }
export type ConnectionSetupView = {
  operation: ConnectionSetupOperation | null
  challenge: ConnectionSetupChallenge | null
  reason?: 'connection-revised' | 'challenge-unavailable'
  /** Original actor only. Account identity is never ordinary discovery/history data. */
  continuation?: { stage: ConnectionSetupAuthenticationStage; account: ConnectionSetupAccount | null; actions: ConnectionSetupAction[] }
  /** Exact admitted advance result, distinct from today's current continuation. */
  receipt?: ConnectionSetupStepReceipt
}
export interface ConnectionSetupPort {
  begin(input: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  advance(input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  inspect(input: ConnectionSetupInput, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  list(input: ConnectionSetupList): Promise<ConnectionSetupListing>
}
export type ConnectionSetupParamsMap = { 'connection.setup.begin': ConnectionSetupBegin; 'connection.setup.advance': ConnectionSetupAdvance; 'connection.setup.inspect': ConnectionSetupInput; 'connection.setup.ls': ConnectionSetupList }
export type ConnectionSetupResultMap = { 'connection.setup.begin': ConnectionSetupView; 'connection.setup.advance': ConnectionSetupView; 'connection.setup.inspect': ConnectionSetupView; 'connection.setup.ls': ConnectionSetupListing }
export type ConnectionSetupMethod = keyof ConnectionSetupParamsMap
