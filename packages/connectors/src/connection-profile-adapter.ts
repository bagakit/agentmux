import type { ConnectionConfig, ConnectionProfileDiagnostic, ConnectionProfileObservation, ConnectionProfileReason, DesiredConnectionProfile } from '@agentmux/core/connections'

/** Private serialized native request, frozen in the original journal before its effect. */
export type ProfilePreparedRequest = { format: string; body: string; language?: string }
export type ProfileEffect = { state: 'confirmed' } | { state: 'not-dispatched' | 'refused' | 'unknown'; reason: ConnectionProfileReason; diagnostic?: ConnectionProfileDiagnostic }
export type ProfileUploadEffect = { state: 'confirmed'; avatarUrl: string } | Exclude<ProfileEffect, { state: 'confirmed' }>
export interface ConnectionProfileAdapter {
  prepareUpload(config: ConnectionConfig, pngDataUrl: string): ProfilePreparedRequest | Promise<ProfilePreparedRequest>
  upload(config: ConnectionConfig, request: ProfilePreparedRequest, credential: string, signal?: AbortSignal): Promise<ProfileUploadEffect>
  preparePatch(config: ConnectionConfig, desired: Omit<DesiredConnectionProfile, 'avatar'>, avatarUrl: string | undefined, credential: string, signal?: AbortSignal): ProfilePreparedRequest | Promise<ProfilePreparedRequest>
  patch(config: ConnectionConfig, request: ProfilePreparedRequest, credential: string, signal?: AbortSignal): Promise<ProfileEffect>
  get(config: ConnectionConfig, revision: number, credential: string, signal?: AbortSignal): Promise<ConnectionProfileObservation>
}

export class ProfilePreparationError extends Error { constructor(readonly reason: ConnectionProfileReason, readonly diagnostic?: ConnectionProfileDiagnostic) { super('The original profile request could not be prepared.') } }
