import type { ConnectionApplication, ConnectionSetupChallenge } from '@agentmux/core/connections'

export type SetupAdapterInput = Readonly<{ operationId: string; connectionId: string; attemptId: string; application: Readonly<ConnectionApplication> }>
export type SetupChallengeReceipt = { kind: 'challenge'; challenge: ConnectionSetupChallenge; privateState: string } | { kind: 'unknown' }
export interface ConnectionSetupAdapter {
  /** Local implementation availability only, never exact-application management eligibility. */
  readonly domains: readonly string[]
  /** One native authentication init only. No poll, redirects, app creation or publication. */
  begin(input: SetupAdapterInput, signal?: AbortSignal): Promise<SetupChallengeReceipt>
}
