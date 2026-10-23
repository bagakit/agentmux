import type {
  ConnectionApplication,
  ConnectionEnrollmentAccount,
  ConnectionEnrollmentChallenge,
  ConnectionEnrollmentDiagnostic
} from '@agentmux/core/connections'
import type { WritableSecretPort } from './connection-host.js'
export interface EnrollmentSecrets extends WritableSecretPort {
  assertAvailable(): void | Promise<void>
  inspect(operationId: string): Promise<{
    credentialRef: string
  } | null>
}
/** The callback checks the original Host claim immediately before the native request. */
export type EnrollmentAdapterInput = Readonly<{
  operationId: string
  connectionId: string
  attemptId: string
  domain: string
  label: string
  /** Adapter-owned immutable protocol selection, frozen when the original intent is admitted. */
  protocolId?: string
  assertCurrent(): void
}>
export type EnrollmentUnknownReceipt = {
  kind: 'unknown'
  diagnostic: ConnectionEnrollmentDiagnostic
}
/** Issuer state stays in the original private Host credential store, never in public JSON. */
export type EnrollmentAuthenticationReceipt =
  | {
      kind: 'authentication'
      stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired'
      challenge: ConnectionEnrollmentChallenge | null
      account: ConnectionEnrollmentAccount | null
      privateState: string
    }
  | EnrollmentUnknownReceipt
export type EnrollmentUploadReceipt =
  | {
      kind: 'uploaded'
      privateState: string
    }
  | EnrollmentUnknownReceipt
export type EnrollmentCreateReceipt =
  | {
      kind: 'created'
      application: ConnectionApplication
      privateState: string
    }
  | EnrollmentUnknownReceipt
export type EnrollmentCredentialReceipt =
  | {
      kind: 'credential'
      secret: string
      privateState: string
    }
  | EnrollmentUnknownReceipt
export interface ConnectionEnrollmentAdapter {
  readonly protocolId?: string
  readonly domains: readonly Readonly<{
    domain: string
    label: string
  }>[]
  /** Each method performs at most one HTTP request, with no loop, fallback or issuer switch. */
  begin(
    input: EnrollmentAdapterInput,
    signal?: AbortSignal
  ): Promise<EnrollmentAuthenticationReceipt>
  advance(
    input: EnrollmentAdapterInput &
      Readonly<{
        privateState: string
      }>,
    signal?: AbortSignal
  ): Promise<EnrollmentAuthenticationReceipt>
  upload(
    input: EnrollmentAdapterInput &
      Readonly<{
        privateState: string
        pngDataUrl: string
      }>,
    signal?: AbortSignal
  ): Promise<EnrollmentUploadReceipt>
  create(
    input: EnrollmentAdapterInput &
      Readonly<{
        privateState: string
        preset: Readonly<{
          name: string
          description?: string
        }>
      }>,
    signal?: AbortSignal
  ): Promise<EnrollmentCreateReceipt>
  credential(
    input: EnrollmentAdapterInput &
      Readonly<{
        privateState: string
        application: Readonly<ConnectionApplication>
      }>,
    signal?: AbortSignal
  ): Promise<EnrollmentCredentialReceipt>
}
