import type { ConnectionApplication } from '@agentmux/core/connections'
import type { WritableSecretPort } from './connection-host.js'

export interface EnrollmentSecrets extends WritableSecretPort {
  assertAvailable(): void | Promise<void>
  inspect(operationId: string): Promise<{ credentialRef: string } | null>
}
export type EnrollmentAdapterInput = Readonly<{ operationId: string; connectionId: string; attemptId: string; domain: string; label: string; preset?: Readonly<{ name: string; description?: string }> }>
export type EnrollmentChallengeReceipt = {
  kind: 'pending'
  verificationUrl: string
  userCode?: string
  /** Remaining original lifetime; a pending poll must not restart the challenge lifetime. */
  expiresInMs: number | null
  pollIntervalMs: number
  /** Private opaque state; encrypted by the Host, never public JSON or diagnostics. */
  privateState: string
}
export type EnrollmentBeginReceipt = EnrollmentChallengeReceipt | { kind: 'not-applied' } | { kind: 'unknown' }
export type EnrollmentPollReceipt = EnrollmentChallengeReceipt | { kind: 'authorized'; application: ConnectionApplication; secret: string } | { kind: 'denied' | 'expired' | 'unknown' }
export interface ConnectionEnrollmentAdapter {
  readonly domains: readonly Readonly<{ domain: string; label: string }>[]
  /** One request only; no internal loop or issuer switching. */
  begin(input: EnrollmentAdapterInput, signal?: AbortSignal): Promise<EnrollmentBeginReceipt>
  /** One preclaimed request. Brand mismatch cannot change the frozen application domain. */
  poll(input: EnrollmentAdapterInput & Readonly<{ privateState: string }>, signal?: AbortSignal): Promise<EnrollmentPollReceipt>
}
