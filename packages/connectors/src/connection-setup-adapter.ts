import type { ConnectionApplication, ConnectionSetupChallenge, ConnectionSetupAccount, ConnectionSetupAuthenticationStage, ConnectionSetupReadSubject, ConnectionSetupReadSummary, ConnectionSetupCapability, ConnectionSetupPermissionPurpose, ConnectionSetupPermissionReview, ConnectionSetupMessageReceptionReview } from '@agentmux/core/connections'

export type SetupAdapterInput = Readonly<{ operationId: string; connectionId: string; attemptId: string; application: Readonly<ConnectionApplication> }>
export type SetupChallengeReceipt = { kind: 'challenge'; challenge: ConnectionSetupChallenge; privateState: string } | { kind: 'unknown' }
export type SetupAuthenticationReceipt = { kind: 'progress'; stage: ConnectionSetupAuthenticationStage; challenge: ConnectionSetupChallenge | null; account: ConnectionSetupAccount | null; privateState: string } | { kind: 'unknown' }
export type SetupReadReceipt = { kind: 'observed'; readResult: ConnectionSetupReadSummary; privateState: string } | { kind: 'unknown' }
export type SetupPermissionPlan = { review: ConnectionSetupPermissionReview; appScopeIDs: Array<string | number> }
/** Native intent stays opaque to the generic Host; the adapter alone owns its schema. */
export type SetupMessageReceptionPlan = { review: ConnectionSetupMessageReceptionReview; privateIntent: string | null }
export type SetupConfigurationReceipt = { kind: 'accepted'; privateState: string; requiresDataRangeConfiguration?: boolean | null } | { kind: 'unknown' }
export type SetupInspectionReceipt = { kind: 'observed'; applicationInfoReadPermission: 'confirmed' | 'unknown'; privateState: string } | { kind: 'unknown' }
export interface ConnectionSetupAdapter {
  /** Local implementation availability only, never exact-application management eligibility. */
  readonly domains: readonly string[]
  /** One native authentication init only. No poll, redirects, app creation or publication. */
  begin(input: SetupAdapterInput, signal?: AbortSignal): Promise<SetupChallengeReceipt>
  /** One HTTP request, including at most one redirect hop; the Host owns its durable claim. */
  advance(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupAuthenticationReceipt>
  /** Pure local conversion of an owner-qualified Enrollment snapshot; never an authentication or app request. */
  readonly enrollmentContinuation?: {
    readonly domains: readonly string[]
    resume(input: SetupAdapterInput & { privateState: string; account: ConnectionSetupAccount }): Promise<SetupAuthenticationReceipt>
  }
  /** Separate local implementation declaration; only an admitted current-auth action calls it. */
  readonly applicationConfiguration?: {
    readonly domains: readonly string[]
    /** Local interpretation of the exact already-bound raw bot read, with zero network effects. */
    messagingCapability(originalReadState: string): Promise<ConnectionSetupCapability>
    /** Local interpretation of the original raw event mode; missing native fields stay unknown. */
    eventTransportCapability(originalReadState: string): Promise<ConnectionSetupCapability>
    /** Pure interpretation of two exact original read snapshots; IDs remain native and private. */
    permissionPlan(catalogState: string, appliedState: string, purpose: ConnectionSetupPermissionPurpose): Promise<SetupPermissionPlan>
    messageReceptionPlan(catalogState: string, settingsState: string): Promise<SetupMessageReceptionPlan>
    /** One explicit message subscription addition carrying the checked delivery mode. */
    addMessageReception(input: SetupAdapterInput & { privateState: string; privateIntent: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt>
    /** One finite additive request; no privileges, subscriptions or publication. */
    addApplicationPermissions(input: SetupAdapterInput & { privateState: string; appScopeIDs: Array<string | number>; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt>
    /** Exactly one event transport scalar request; subscriptions and publication are separate. */
    usePersistentConnection(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt>
    /** Exactly one native enable-only request, never menu, modes or publication. */
    enableMessaging(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt>
  }
  readonly applicationInspection?: {
    readonly domains: readonly string[]
    inspect(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupInspectionReceipt>
    /** One frozen current-data subject, distinct from reported read permission. */
    read?(input: SetupAdapterInput & { privateState: string; subject: ConnectionSetupReadSubject }, signal?: AbortSignal): Promise<SetupReadReceipt>
  }
}
