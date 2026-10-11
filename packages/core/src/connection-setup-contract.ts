import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

/** A finite platform-management intent, distinct from application creation and local save. */
export type ConnectionSetupGoal = { kind: 'agent-conversation'; interaction: 'messages' | 'cards' }
export type ConnectionSetupEnrollmentSource = { kind: 'enrollment'; operationId: string; expectedRevision: number }
export type ConnectionSetupBegin = { operationId: string; connectionId: string; expectedConnectionRevision: number; goal: ConnectionSetupGoal; source?: ConnectionSetupEnrollmentSource }
export type ConnectionSetupInput = { operationId: string }
/** Local child selection only. It never requests the platform or repairs a secure ACK. */
export type ConnectionSetupInspect = ConnectionSetupInput & { applicationInspection?: { selectedStepId?: string; cursor?: string; limit?: number }; applicationConfiguration?: ConnectionSetupConfigurationSelector }
export type ConnectionSetupAdvance = ConnectionSetupInput & { expectedRevision: number; decision: { actionId: string; value: 'continue' | 'confirm' | 'renew' } }
export type ConnectionSetupList = { connectionId: string; cursor?: string; limit?: number }
/** Local implementation discovery for this exact revision, never platform authority or readiness. */
export type ConnectionSetupSupport = { connectionRevision: number; capabilities: Array<'management-authentication' | 'application-inspection' | 'messaging-capability' | 'persistent-event-transport' | 'application-permissions' | 'enrollment-continuation'> }
export type ConnectionSetupListing = { operations: ConnectionSetupOperation[]; next: string | null; support: ConnectionSetupSupport | null }
export type ConnectionSetupReason = 'adapter-unavailable' | 'secure-storage-unavailable' | 'request-unconfirmed' | 'challenge-unconfirmed'
export type ConnectionSetupAuthenticationStage = 'waiting' | 'scanned' | 'handoff' | 'account' | 'confirmed' | 'expired' | 'unknown'
export type ConnectionSetupAccount = { userId: string; tenantId: string; userName?: string; tenantName?: string }
export type ConnectionSetupAuthenticationAction = { actionId: string; expectedRevision: number; kind: 'continue' | 'confirm-account' | 'renew' }
/** Read subjects are independent observations, never a combined configuration snapshot. */
export const CONNECTION_SETUP_READ_ACTIONS = {
  'application-details': 'read-application-details',
  'event-settings': 'read-event-settings',
  'callback-settings': 'read-callback-settings',
  'bot-settings': 'read-bot-settings',
  'permission-catalog': 'read-permission-catalog',
  'application-permissions': 'read-application-permissions'
} as const
export type ConnectionSetupReadSubject = keyof typeof CONNECTION_SETUP_READ_ACTIONS
export type ConnectionSetupReadSummary =
  | { subject: 'application-details'; name: string | null; description: string | null }
  | { subject: 'event-settings'; transport: 'persistent-connection' | 'webhook' | 'function' | 'unknown' }
  | { subject: 'callback-settings' | 'bot-settings' | 'permission-catalog' | 'application-permissions' }
export type ConnectionSetupInspectionAction = { actionId: string; expectedRevision: number; kind: 'inspect-application' | 'recover-application-inspection' | typeof CONNECTION_SETUP_READ_ACTIONS[ConnectionSetupReadSubject] }
export type ConnectionSetupScalarEffect = 'enable-messaging' | 'use-persistent-connection'
export type ConnectionSetupConfigurationEffect = ConnectionSetupScalarEffect | 'add-application-permissions'
/** Current explicit purpose, never inferred from a saved application's presentation. */
export type ConnectionSetupPermissionPurpose = 'agent-conversation' | 'mote-profile-sync'
/** Stable owner-generated machine identifier; unrelated to presentation labels. */
export function connectionSetupPermissionActionPurpose(actionId: string): ConnectionSetupPermissionPurpose | null {
  return (['agent-conversation', 'mote-profile-sync'] as const).find(purpose => actionId.startsWith('setup-permissions:' + purpose + ':')) ?? null
}
export type ConnectionSetupPermissionReview = {
  permissions: Array<{ name: string; group: 'messages' | 'groups' | 'identity'; state: 'requested' | 'missing' | 'unknown' }>
  reason?: 'catalog-unconfirmed' | 'applied-unconfirmed' | 'scope-unavailable' | 'scope-ambiguous' | 'unsupported-scope-id'
}
export type ConnectionSetupConfigurationSelector = { selectedStepId?: string; cursor?: string; limit?: number } & (
  | { effect: ConnectionSetupScalarEffect }
  | { effect: 'add-application-permissions'; purpose: ConnectionSetupPermissionPurpose }
)
export function connectionSetupConfigurationSubject(effect: ConnectionSetupScalarEffect): 'bot-settings' | 'event-settings' {
  return effect === 'enable-messaging' ? 'bot-settings' : 'event-settings'
}
export type ConnectionSetupConfigurationAction = { actionId: string; expectedRevision: number; kind: ConnectionSetupConfigurationEffect | 'recover-configuration-effect' }
export type ConnectionSetupCapability = 'enabled' | 'disabled' | 'unknown'
/** One explicit scalar desired-state request, separate from today's capability and secure ACK. */
export type ConnectionSetupConfigurationReceipt = {
  stepId: string; input: ConnectionSetupAdvance
  request: 'dispatching' | 'confirmed' | 'unknown'
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
} & (
  | { effect: ConnectionSetupScalarEffect; sourceStepId: string }
  | { effect: 'add-application-permissions'; purpose: ConnectionSetupPermissionPurpose; sourceStepIds: { catalog: string; applied: string }; scopeNames: string[]; requiresDataRangeConfiguration: boolean | null }
)
export type ConnectionSetupAction = ConnectionSetupAuthenticationAction | ConnectionSetupInspectionAction | ConnectionSetupConfigurationAction
/** Effect selection belongs to the offered kind, never to the shared decision string. */
export function connectionSetupDecisionForAction(action: ConnectionSetupAction): ConnectionSetupAdvance['decision']['value'] {
  const decisions = { continue: 'continue', 'confirm-account': 'confirm', renew: 'renew', 'inspect-application': 'continue', 'recover-application-inspection': 'continue', 'read-application-details': 'continue', 'read-event-settings': 'continue', 'read-callback-settings': 'continue', 'read-bot-settings': 'continue', 'read-permission-catalog': 'continue', 'read-application-permissions': 'continue', 'enable-messaging': 'confirm', 'use-persistent-connection': 'confirm', 'add-application-permissions': 'confirm', 'recover-configuration-effect': 'continue' } as const satisfies Record<ConnectionSetupAction['kind'], ConnectionSetupAdvance['decision']['value']>
  return decisions[action.kind]
}
export type ConnectionSetupInspectionReceipt = {
  /** Absence is the permission observation; data subjects carry their own exact identity. */
  subject?: ConnectionSetupReadSubject
  stepId: string
  input: ConnectionSetupAdvance
  request: 'dispatching' | 'confirmed' | 'unknown'
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
}
export type ConnectionSetupStepReceipt = { actionId: string; stepId: string; state: 'dispatching' | 'confirmed' | 'unknown' }
/** Safe durable facts only. Discovery and historical summaries never contain a scan payload. */
export type ConnectionSetupOperation = ConnectionSetupBegin & {
  revision: number
  adapterId: string
  application: ConnectionApplication
  /** With kind=enrollment-handoff this is a local begin receipt, never a QR-init acknowledgement. */
  request: { kind?: 'enrollment-handoff'; state: 'not-dispatched' | 'dispatching' | 'confirmed' | 'unknown' | 'refused'; attemptId: string | null }
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
  continuation?: { stage: ConnectionSetupAuthenticationStage; account: ConnectionSetupAccount | null; actions: ConnectionSetupAuthenticationAction[] }
  /** Original actor only; stale children retain safe receipts, never current permission. */
  applicationInspection?: { observations: ConnectionSetupInspectionReceipt[]; next: string | null; selected: ConnectionSetupInspectionReceipt | null; applicationInfoReadPermission: 'confirmed' | 'unknown'; readResult?: ConnectionSetupReadSummary; actions: ConnectionSetupInspectionAction[] }
  /** Original finite effects only; current capability is not an ACK or online/chat readiness. */
  applicationConfiguration?: {
    effects: ConnectionSetupConfigurationReceipt[]; next: string | null; selected: ConnectionSetupConfigurationReceipt | null
    capability: ConnectionSetupCapability
    actions: ConnectionSetupConfigurationAction[]
    /** Original actor's local unresolved request, including an alias/new setup entry. */
    unresolved?: { operationId: string; connectionId: string; stepId: string }
    reason?: 'source-unconfirmed' | 'adapter-unavailable' | 'original-effect-unconfirmed'
  } & (
    | { effect: ConnectionSetupScalarEffect; subject: 'bot-settings' | 'event-settings'; source: ConnectionSetupInspectionReceipt | null }
    | { effect: 'add-application-permissions'; subject: 'application-permissions'; purpose: ConnectionSetupPermissionPurpose; sources: { catalog: ConnectionSetupInspectionReceipt | null; applied: ConnectionSetupInspectionReceipt | null }; review: ConnectionSetupPermissionReview | null }
  )
  /** Exact admitted advance result, distinct from today's current continuation. */
  receipt?: ConnectionSetupStepReceipt
}
export interface ConnectionSetupPort {
  begin(input: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  advance(input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  inspect(input: ConnectionSetupInspect, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  list(input: ConnectionSetupList): Promise<ConnectionSetupListing>
}
export type ConnectionSetupParamsMap = { 'connection.setup.begin': ConnectionSetupBegin; 'connection.setup.advance': ConnectionSetupAdvance; 'connection.setup.inspect': ConnectionSetupInspect; 'connection.setup.ls': ConnectionSetupList }
export type ConnectionSetupResultMap = { 'connection.setup.begin': ConnectionSetupView; 'connection.setup.advance': ConnectionSetupView; 'connection.setup.inspect': ConnectionSetupView; 'connection.setup.ls': ConnectionSetupListing }
export type ConnectionSetupMethod = keyof ConnectionSetupParamsMap
