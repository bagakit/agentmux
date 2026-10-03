import type { BigIntStats } from 'node:fs'
export const SCRATCH_DIRECTORY_IDENTITY_PATH: string
export const SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH: string
export type DirectoryIdentityRecord = { version: 2; identityDirectoryName: string; identityPathHash: string }
export type DirectoryIdentityLeaf = { record: DirectoryIdentityRecord | { version: 1; identityDirectoryPath: string }; bytes: string; info: BigIntStats; needsUpgrade: boolean }
export type DirectoryIdentityInspection = {
  record: DirectoryIdentityRecord | { version: 1; identityDirectoryPath: string }
  current: DirectoryIdentityLeaf | null; pending: DirectoryIdentityLeaf | null;
  identityDirectoryPath: string; needsUpgrade: boolean; bytes: string; info: BigIntStats; parent: BigIntStats
}
export type DirectoryIdentityWriteOptions = { beforeWrite?: () => void | Promise<void>; beforeReplace?: () => void | Promise<void>; afterReplace?: () => void | Promise<void>; helperPath?: string; beforeCommit?: () => void | Promise<void>; afterClaim?: () => void | Promise<void>; beforeConfirm?: () => void | Promise<void>; publicationSyncFault?: boolean }
export function directoryIdentityRecord(original: string): DirectoryIdentityRecord
export class DirectoryIdentityUpgradeRequiredError extends Error { readonly code: 'DIRECTORY_IDENTITY_UPGRADE_REQUIRED'; readonly identityDirectoryPath: string; constructor(original: string) }
export function inspectDirectoryIdentity(directory: string, original: string): Promise<DirectoryIdentityInspection | null>
export function readDirectoryIdentity(directory: string, original: string): Promise<string | null>
export function normalizeDirectoryIdentity(directory: string, original: string, options?: DirectoryIdentityWriteOptions): Promise<{ state: 'unchanged' | 'upgraded' }>
export function retainDirectoryIdentity(directory: string, original: string, options?: DirectoryIdentityWriteOptions): Promise<DirectoryIdentityInspection | null>
