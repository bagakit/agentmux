import type { ConnectionRequestTrace, ConnectionRequestTraceSelector } from './connection-request-trace.js'
import type { ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'

/** A finite platform-management intent, distinct from application creation and local save. */
export type ConnectionSetupProfileDesired = import('./connection-profile-contract.js').DesiredConnectionProfile
export type ConnectionSetupProfileSummary = { name?: string; description?: string; avatarSha256?: string }
export type ConnectionSetupGoal = { kind: 'agent-conversation'; interaction: 'messages' | 'cards' } | { kind: 'profile-update'; desired: ConnectionSetupProfileDesired; publication: { notes: string } }
export type ConnectionSetupOperationGoal = Extract<ConnectionSetupGoal, { kind: 'agent-conversation' }> | { kind: 'profile-update'; desired: ConnectionSetupProfileSummary; publication: { notes: string } }
export type ConnectionSetupEnrollmentSource = { kind: 'enrollment'; operationId: string; expectedRevision: number }
/** Explicit creation consent: configure the original application's conversation capabilities and submit its first creator-only version. */
export type ConnectionSetupInitialPublication = { version: string; notes: string }
export type ConnectionSetupBegin = { operationId: string; connectionId: string; expectedConnectionRevision: number; goal: ConnectionSetupGoal; source?: ConnectionSetupEnrollmentSource; initialPublication?: ConnectionSetupInitialPublication }
export type ConnectionSetupInitialProgress = {
  stage: 'authentication' | 'messaging' | 'event-transport' | 'permissions' | 'message-reception' | 'callback-transport' | 'card-actions' | 'publication-create' | 'publication-submit' | 'publication-status'
  state: 'pending' | 'running' | 'attention' | 'approval-required' | 'complete'
  versionId?: string
}
export type ConnectionSetupProfileAction = { kind: 'continue-profile-update' | 'refresh-publication-checks' | 'recover-configuration-effect'; actionId: string; expectedRevision: number }
export type ConnectionSetupProfileProgress = { stage: 'authentication' | 'profile-preflight' | 'avatar-upload' | 'profile-write' | 'profile-readback' | 'publication-create' | 'publication-submit' | 'publication-status'; state: ConnectionSetupInitialProgress['state']; versionId?: string; actions: ConnectionSetupProfileAction[]; blockedBy?: { kind: 'profile-operation'; operationId: string; connectionId: string }; publicationDraft?: Extract<ConnectionSetupPublicationDraft, { kind: 'create-version' }> }
export type ConnectionSetupRequestDiagnostic = { code?: 'transport-unconfirmed' | 'cancelled' | 'http-status' | 'platform-error' | 'invalid-json' | 'invalid-response'; httpStatus?: number; nativeCode?: number }
export type ConnectionSetupInput = { operationId: string }
/** Local child selection only. It never requests the platform or repairs a secure ACK. */
export type ConnectionSetupInspect = ConnectionSetupInput & { requestTrace?: ConnectionRequestTraceSelector; applicationInspection?: { selectedStepId?: string; cursor?: string; limit?: number; versionId?: string }; applicationConfiguration?: ConnectionSetupConfigurationSelector }
export type ConnectionSetupAdvance = ConnectionSetupInput & { expectedRevision: number; decision: { actionId: string; value: 'continue' | 'confirm' | 'renew' }; versionId?: string; publicationDraft?: ConnectionSetupPublicationDraft }
export type ConnectionSetupList = { connectionId: string; cursor?: string; limit?: number }
/** Local implementation discovery for this exact revision, never platform authority or readiness. */
export type ConnectionSetupSupport = { connectionRevision: number; capabilities: Array<'management-authentication' | 'application-inspection' | 'messaging-capability' | 'persistent-event-transport' | 'application-permissions' | 'message-reception' | 'card-actions' | 'application-publication' | 'enrollment-continuation' | 'initial-setup' | 'profile-update'> }
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
  'application-permissions': 'read-application-permissions',
  'event-catalog': 'read-event-catalog',
  'publication-pending': 'read-publication-pending',
  'publication-versions': 'read-publication-versions',
  'publication-visibility': 'read-publication-visibility',
  'publication-sharing': 'read-publication-sharing',
  'publication-features': 'read-publication-features'
} as const
export type ConnectionSetupReadSubject = keyof typeof CONNECTION_SETUP_READ_ACTIONS | 'publication-version'
export type ConnectionSetupVersionStatus = 'draft' | 'reviewing' | 'approved' | 'rejected' | 'awaiting-release' | 'unknown'
export type ConnectionSetupReadSummary =
  | { subject: 'application-details'; name: string | null; description: string | null }
  | { subject: 'event-settings'; transport: 'persistent-connection' | 'webhook' | 'function' | 'unknown' }
  | { subject: 'publication-version'; versionId: string; status: ConnectionSetupVersionStatus }
  | { subject: Exclude<ConnectionSetupReadSubject, 'application-details' | 'event-settings' | 'publication-version'> }
export type ConnectionSetupInspectionAction = { actionId: string; expectedRevision: number } & (
  | { kind: 'inspect-application' | 'recover-application-inspection' | typeof CONNECTION_SETUP_READ_ACTIONS[keyof typeof CONNECTION_SETUP_READ_ACTIONS] }
  | { kind: 'read-publication-version'; versionId: string }
)
export type ConnectionSetupScalarEffect = 'enable-messaging' | 'use-persistent-connection' | 'use-persistent-callback' | 'add-card-actions'
export type ConnectionSetupPublicationEffect = 'create-application-version' | 'submit-application-version'
export type ConnectionSetupProfileEffect = 'upload-profile-avatar' | 'update-application-profile'
export type ConnectionSetupConfigurationEffect = ConnectionSetupScalarEffect | 'add-application-permissions' | 'add-message-reception' | ConnectionSetupPublicationEffect | ConnectionSetupProfileEffect
export type ConnectionSetupPublicationDraft =
  | { kind: 'create-version'; version: string; notes: string; visibility: 'current' | 'creator-only'; desktopEntry?: string; mobileEntry?: string; reason?: string }
  | { kind: 'submit-version'; versionId: string; fullRelease: boolean }
export type ConnectionSetupPublicationAudience = { all: boolean; departments: Array<string | number>; people: Array<string | number>; groups: Array<string | number> }
export type ConnectionSetupPublicationReview = {
  versions: Array<{ versionId: string; version: string; status: ConnectionSetupVersionStatus }>
  selectedVersion: { versionId: string; version: string; status: ConnectionSetupVersionStatus; notes: string | null } | null
  changes: Array<{ category: 'events' | 'callbacks' | 'permissions' | 'data-access' | 'extensions' | 'refresh-tokens' | 'sharing'; details: string[] }>
  audience: { include: ConnectionSetupPublicationAudience; exclude: ConnectionSetupPublicationAudience } | null
  proposedAudience: { include: ConnectionSetupPublicationAudience; exclude: ConnectionSetupPublicationAudience } | null
  entries: { desktop: { current: string | null; choices: string[] } | null; mobile: { current: string | null; choices: string[] } | null } | null
  sharing: { kind: 'combined'; enabled: boolean } | { kind: 'split'; groups: boolean; direct: boolean; directReview: boolean } | null
  reasonRequired: boolean | null
  creatorAudienceAvailable: boolean
  issues: string[]
}
export type ConnectionSetupPublicationSources = { pending?: string; versions?: string; visibility?: string; sharing?: string; features?: string; version?: string }
export function connectionSetupPublicationSubjects(effect: ConnectionSetupPublicationEffect) {
  return effect === 'create-application-version'
    ? ['publication-pending', 'publication-versions', 'publication-visibility', 'publication-sharing', 'publication-features'] as const
    : ['publication-version', 'publication-versions', 'publication-features'] as const
}
export type ConnectionSetupSubmissionResponse = { outcome: 'accepted' | 'action-required' | 'unknown'; issues: Array<'entry-conflict' | 'application-avatar-required' | 'response-unconfirmed'> }
export type ConnectionSetupMessageReceptionReview = {
  reception: 'subscribed' | 'missing' | 'unknown'
  transport: 'persistent-connection' | 'webhook' | 'function' | 'unknown'
  reason?: 'catalog-unconfirmed' | 'settings-unconfirmed' | 'event-unavailable' | 'event-ambiguous'
}
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
  | { effect: ConnectionSetupProfileEffect }
  | { effect: 'add-message-reception' }
  | { effect: 'add-application-permissions'; purpose: ConnectionSetupPermissionPurpose }
  | { effect: 'create-application-version'; draft?: Extract<ConnectionSetupPublicationDraft, { kind: 'create-version' }> }
  | { effect: 'submit-application-version'; draft?: Extract<ConnectionSetupPublicationDraft, { kind: 'submit-version' }> }
)
export function connectionSetupConfigurationSubject(effect: ConnectionSetupScalarEffect): 'bot-settings' | 'event-settings' | 'callback-settings' {
  return effect === 'enable-messaging' ? 'bot-settings' : effect === 'use-persistent-connection' ? 'event-settings' : 'callback-settings'
}
export type ConnectionSetupConfigurationAction = { actionId: string; expectedRevision: number; kind: ConnectionSetupConfigurationEffect | 'recover-configuration-effect' }
export type ConnectionSetupCapability = 'enabled' | 'disabled' | 'unknown'
/** One explicit finite request, separate from current configuration and its secure ACK. */
export type ConnectionSetupConfigurationReceipt = {
  stepId: string; input: ConnectionSetupAdvance
  request: 'dispatching' | 'confirmed' | 'unknown'
  /** Saves this child's private evidence; a stored continuation does not confirm its platform request. */
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
  diagnostic?: ConnectionSetupRequestDiagnostic
} & (
  | { effect: ConnectionSetupScalarEffect; sourceStepId: string }
  | { effect: 'add-application-permissions'; purpose: ConnectionSetupPermissionPurpose; sourceStepIds: { catalog: string; applied: string }; scopeNames: string[]; requiresDataRangeConfiguration: boolean | null }
  | { effect: 'add-message-reception'; sourceStepIds: { catalog: string; settings: string }; transport: 'persistent-connection' }
  | { effect: ConnectionSetupPublicationEffect; sourceStepIds: ConnectionSetupPublicationSources; profileReadbackStepId?: string; versionId: string | null; submission: ConnectionSetupSubmissionResponse | null }
  | { effect: ConnectionSetupProfileEffect; sourceStepId: string; avatarStepId?: string }
)
export type ConnectionSetupAction = ConnectionSetupAuthenticationAction | ConnectionSetupInspectionAction | ConnectionSetupConfigurationAction | ConnectionSetupProfileAction
/** Effect selection belongs to the offered kind, never to the shared decision string. */
export function connectionSetupDecisionForAction(action: ConnectionSetupAction): ConnectionSetupAdvance['decision']['value'] {
  const decisions = { continue: 'continue', 'confirm-account': 'confirm', renew: 'renew', 'inspect-application': 'continue', 'recover-application-inspection': 'continue', 'read-application-details': 'continue', 'read-event-settings': 'continue', 'read-callback-settings': 'continue', 'read-bot-settings': 'continue', 'read-permission-catalog': 'continue', 'read-application-permissions': 'continue', 'read-event-catalog': 'continue', 'read-publication-pending': 'continue', 'read-publication-versions': 'continue', 'read-publication-visibility': 'continue', 'read-publication-sharing': 'continue', 'read-publication-features': 'continue', 'read-publication-version': 'continue', 'upload-profile-avatar': 'confirm', 'update-application-profile': 'confirm', 'continue-profile-update': 'continue', 'refresh-publication-checks': 'continue', 'enable-messaging': 'confirm', 'use-persistent-connection': 'confirm', 'use-persistent-callback': 'confirm', 'add-card-actions': 'confirm', 'add-application-permissions': 'confirm', 'add-message-reception': 'confirm', 'create-application-version': 'confirm', 'submit-application-version': 'confirm', 'recover-configuration-effect': 'continue' } as const satisfies Record<ConnectionSetupAction['kind'], ConnectionSetupAdvance['decision']['value']>
  return decisions[action.kind]
}
export type ConnectionSetupInspectionReceipt = {
  /** Absence is the permission observation; data subjects carry their own exact identity. */
  subject?: ConnectionSetupReadSubject
  versionId?: string
  stepId: string
  input: ConnectionSetupAdvance
  request: 'dispatching' | 'confirmed' | 'unknown'
  /** Saves this child's private evidence; a stored continuation does not confirm its platform request. */
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown'
}
export type ConnectionSetupStepReceipt = { actionId: string; stepId: string; state: 'dispatching' | 'confirmed' | 'unknown' }
/** Safe durable facts only. Discovery and historical summaries never contain a scan payload. */
export type ConnectionSetupOperation = Omit<ConnectionSetupBegin, 'goal'> & {
  goal: ConnectionSetupOperationGoal
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
  profileUpdate?: ConnectionSetupProfileProgress
  /** Local projection of original reads/effects; complete does not assert connection or message readiness. */
  initialSetup?: ConnectionSetupInitialProgress
  requestTrace?: ConnectionRequestTrace
  operation: ConnectionSetupOperation | null
  challenge: ConnectionSetupChallenge | null
  /** Exact live display source only; never authenticates the pending step or authorizes an action. */
  challengeSource?: { attemptId: string; stepId: string }
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
    unresolvedProfile?: { operationId: string; connectionId: string }
    reason?: 'source-unconfirmed' | 'adapter-unavailable' | 'original-effect-unconfirmed'
  } & (
    | { effect: ConnectionSetupScalarEffect; subject: 'bot-settings' | 'event-settings' | 'callback-settings'; source: ConnectionSetupInspectionReceipt | null }
    | { effect: ConnectionSetupProfileEffect; subject: 'application-details'; source: ConnectionSetupInspectionReceipt | null }
    | { effect: 'add-application-permissions'; subject: 'application-permissions'; purpose: ConnectionSetupPermissionPurpose; sources: { catalog: ConnectionSetupInspectionReceipt | null; applied: ConnectionSetupInspectionReceipt | null }; review: ConnectionSetupPermissionReview | null }
    | { effect: 'add-message-reception'; subject: 'event-settings'; sources: { catalog: ConnectionSetupInspectionReceipt | null; settings: ConnectionSetupInspectionReceipt | null }; review: ConnectionSetupMessageReceptionReview | null }
    | { effect: ConnectionSetupPublicationEffect; subject: 'publication-pending' | 'publication-version'; sources: Partial<Record<keyof ConnectionSetupPublicationSources, ConnectionSetupInspectionReceipt>>; requiredSubjects: ConnectionSetupReadSubject[]; draft: ConnectionSetupPublicationDraft | null; review: ConnectionSetupPublicationReview | null }
  )
  /** Exact admitted advance result, distinct from today's current continuation. */
  receipt?: ConnectionSetupStepReceipt
}
export interface ConnectionSetupPort {
  begin(input: ConnectionSetupBegin, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  advance(input: ConnectionSetupAdvance, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  inspect(input: ConnectionSetupInspect, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView>
  list(input: ConnectionSetupList, context?: ConnectionEnrollmentCallContext): Promise<ConnectionSetupListing>
}
export type ConnectionSetupParamsMap = { 'connection.setup.begin': ConnectionSetupBegin; 'connection.setup.advance': ConnectionSetupAdvance; 'connection.setup.inspect': ConnectionSetupInspect; 'connection.setup.ls': ConnectionSetupList }
export type ConnectionSetupResultMap = { 'connection.setup.begin': ConnectionSetupView; 'connection.setup.advance': ConnectionSetupView; 'connection.setup.inspect': ConnectionSetupView; 'connection.setup.ls': ConnectionSetupListing }
export type ConnectionSetupMethod = keyof ConnectionSetupParamsMap
