import type { ConnectionApplication, ConnectionOperation } from './connections-contract.js'
export type ConnectionEnrollmentReason =
  | 'adapter-unavailable'
  | 'secure-storage-unavailable'
  | 'storage-unconfirmed'
  | 'begin-unconfirmed'
  | 'poll-unconfirmed'
  | 'credential-unconfirmed'
  | 'configuration-unconfirmed'
  | 'connection-conflict'
  | 'authority-unavailable'
  | 'platform-denied'
  | 'platform-expired'
  | 'platform-not-applied'
/** Local implementation availability, never remote account eligibility or granted scopes. */
export type ConnectionEnrollmentCapability = {
  adapterId: string
  domain: string
  label: string
  availability: 'available' | 'unavailable' | 'unknown'
  reason?: 'adapter-unavailable' | 'secure-storage-unavailable'
}
/** Private, original-actor login material; absent from durable operation summaries and lists. */
export type ConnectionEnrollmentChallenge = {
  qrPayload: string
  expiresAt: number | null
  nextPollAt: number
}
export type ConnectionEnrollmentAccount = {
  userId: string
  tenantId: string
  userName?: string
  tenantName?: string
}
/** Observed failure stage only; never permission to replay an unknown request. */
export type ConnectionEnrollmentDiagnostic =
  | {
      stage: 'request'
      code: 'transport-unconfirmed' | 'cancelled'
    }
  | {
      stage: 'response'
      code: 'http-status' | 'platform-error' | 'invalid-json' | 'invalid-response'
      httpStatus?: number
    }
  | {
      stage: 'challenge'
      code: 'missing-verification' | 'unsafe-verification' | 'invalid-challenge'
    }
  | {
      stage: 'authentication'
      code: 'native-unconfirmed'
    }
  | {
      stage: 'preparation'
      code: 'invalid-state' | 'invalid-image' | 'unsupported-domain' | 'invalid-application'
    }
  | {
      stage: 'adapter'
      code: 'receipt-unconfirmed'
    }
  | {
      stage: 'journal'
      code: 'claim-unconfirmed' | 'receipt-unconfirmed'
    }
  | {
      stage: 'secure-storage'
      code: 'challenge-unconfirmed' | 'credential-unconfirmed' | 'asset-unconfirmed'
    }
export type ConnectionEnrollmentPreset = {
  name: string
  description?: string
  avatar: {
    pngDataUrl: string
  }
}
export type ConnectionEnrollmentPresetSummary = {
  name: string
  description?: string
  avatarSha256?: string
  width?: number
  height?: number
}
export type ConnectionEnrollmentBeginInput = {
  operationId: string
  connectionId: string
  adapterId: string
  domain: string
  label: string
  preset: ConnectionEnrollmentPreset
}
export type ConnectionEnrollmentOperation = Omit<ConnectionEnrollmentBeginInput, 'preset'> & {
  preset?: ConnectionEnrollmentPresetSummary
  revision: number
  /** Original application facts. Account confirmation alone never authorizes an application. */
  authorization: 'not-started' | 'pending' | 'authorized' | 'denied' | 'expired' | 'unknown'
  credential: 'not-started' | 'storing' | 'stored' | 'unknown'
  configuration: 'not-started' | 'saving' | 'configured' | 'unknown' | 'refused'
  application: ConnectionApplication | null
  /** Absent on original records that never contained account-login facts. */
  authentication?: {
    attemptId: string
    stage:
      | 'not-started'
      | 'waiting'
      | 'scanned'
      | 'handoff'
      | 'account'
      | 'confirmed'
      | 'expired'
      | 'unknown'
  }
  creation?: {
    upload: 'not-started' | 'dispatching' | 'confirmed' | 'unknown'
    create: 'not-started' | 'dispatching' | 'confirmed' | 'unknown'
  }
  /** The immutable original configuration receipt, separate from current connection health. */
  configured: ConnectionOperation | null
  reason?: ConnectionEnrollmentReason
  diagnostic?: ConnectionEnrollmentDiagnostic
}
export type ConnectionEnrollmentActionKind =
  | 'continue-authentication'
  | 'confirm-account'
  | 'renew-authentication'
  | 'create'
  | 'read-credential'
  | 'recover-local'
export type ConnectionEnrollmentAction = {
  actionId: string
  ownRevision: number
  kind: ConnectionEnrollmentActionKind
}
export type ConnectionEnrollmentReceipt = ConnectionEnrollmentAction & {
  stepId: string
  state: 'dispatching' | 'confirmed' | 'unknown'
}
export type ConnectionEnrollmentOperationInput = {
  operationId: string
}
export type ConnectionEnrollmentAdvanceInput = ConnectionEnrollmentOperationInput & {
  ownRevision: number
  decision: {
    actionId: string
    kind: ConnectionEnrollmentActionKind
  }
}
export type ConnectionEnrollmentView = {
  operation: ConnectionEnrollmentOperation | null
  challenge: ConnectionEnrollmentChallenge | null
  account: ConnectionEnrollmentAccount | null
  actions: ConnectionEnrollmentAction[]
  receipt?: ConnectionEnrollmentReceipt
}
export type ConnectionEnrollmentListInput = {
  cursor?: string
  limit?: number
}
export type ConnectionEnrollmentListResult = {
  operations: ConnectionEnrollmentOperation[]
  next: string | null
  capabilities: ConnectionEnrollmentCapability[]
}
/** Supplied only by the executing transport owner, never by JSON. */
export type ConnectionEnrollmentCallContext = {
  actor: {
    kind: 'user' | 'device'
    id: string
  }
  assertCurrent?(): void | Promise<void>
  signal?: AbortSignal
}
export interface ConnectionEnrollmentPort {
  begin(
    input: ConnectionEnrollmentBeginInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView>
  advance(
    input: ConnectionEnrollmentAdvanceInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView>
  inspect(
    input: ConnectionEnrollmentOperationInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView>
  list(input: ConnectionEnrollmentListInput): Promise<ConnectionEnrollmentListResult>
}
export type ConnectionEnrollmentParamsMap = {
  'connection.enrollment.begin': ConnectionEnrollmentBeginInput
  'connection.enrollment.advance': ConnectionEnrollmentAdvanceInput
  'connection.enrollment.inspect': ConnectionEnrollmentOperationInput
  'connection.enrollment.ls': ConnectionEnrollmentListInput
}
export type ConnectionEnrollmentResultMap = {
  'connection.enrollment.begin': ConnectionEnrollmentView
  'connection.enrollment.advance': ConnectionEnrollmentView
  'connection.enrollment.inspect': ConnectionEnrollmentView
  'connection.enrollment.ls': ConnectionEnrollmentListResult
}
export type ConnectionEnrollmentMethod = keyof ConnectionEnrollmentParamsMap
