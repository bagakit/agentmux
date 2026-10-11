import type { ConnectionApplication, ConnectionSetupChallenge, ConnectionSetupAccount, ConnectionSetupAuthenticationStage, ConnectionSetupReadSubject, ConnectionSetupReadSummary } from '@agentmux/core/connections'

export type SetupAdapterInput = Readonly<{ operationId: string; connectionId: string; attemptId: string; application: Readonly<ConnectionApplication> }>
export type SetupChallengeReceipt = { kind: 'challenge'; challenge: ConnectionSetupChallenge; privateState: string } | { kind: 'unknown' }
export type SetupAuthenticationReceipt = { kind: 'progress'; stage: ConnectionSetupAuthenticationStage; challenge: ConnectionSetupChallenge | null; account: ConnectionSetupAccount | null; privateState: string } | { kind: 'unknown' }
export type SetupReadReceipt = { kind: 'observed'; readResult: ConnectionSetupReadSummary; privateState: string } | { kind: 'unknown' }
export type SetupInspectionReceipt = { kind: 'observed'; applicationInfoReadPermission: 'confirmed' | 'unknown'; privateState: string } | { kind: 'unknown' }
export interface ConnectionSetupAdapter {
  /** Local implementation availability only, never exact-application management eligibility. */
  readonly domains: readonly string[]
  /** One native authentication init only. No poll, redirects, app creation or publication. */
  begin(input: SetupAdapterInput, signal?: AbortSignal): Promise<SetupChallengeReceipt>
  /** One HTTP request, including at most one redirect hop; the Host owns its durable claim. */
  advance(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupAuthenticationReceipt>
  /** Separate local implementation declaration; only an admitted current-auth action calls it. */
  readonly applicationInspection?: {
    readonly domains: readonly string[]
    inspect(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupInspectionReceipt>
    /** One frozen current-data subject, distinct from reported read permission. */
    read?(input: SetupAdapterInput & { privateState: string; subject: ConnectionSetupReadSubject }, signal?: AbortSignal): Promise<SetupReadReceipt>
  }
}
