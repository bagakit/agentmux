import type { BrowserProfileControlProfile } from './browser-profile-control.js'

/** Observed original native owners. An unavailable observation never means zero use. */
export type BrowserProfileNativeUse = {
  status: 'idle' | 'in-use' | 'unknown'
  pages: number | null
  workers: number | null
  requests: number | null
  downloads: number | null
  reason?: string
}
/** The original partition stays with this entry; no copy, immutable backup or disk release is claimed. */
export type BrowserProfileTrashEntry = {
  id: string
  revision: string
  archivedAt: number
  profile: BrowserProfileControlProfile
  dataOwner: 'original-partition'
  /** Absent means keep indefinitely; only the person can approve an expiry for this entry. */
  retention?: { purgeId: string; deleteAfter: number; approvedAt: number }
  purge?: BrowserProfilePurgeReceipt
}
export type BrowserProfilePurgeStatus = 'waiting-for-restart' | 'preparing' | 'deleting-data' | 'erasing-backup' | 'failed' | 'unknown' | 'deleted' | 'restored'
/** Original action identity and confirmed progress; paths, safety-copy bytes and secrets stay in Main. */
export type BrowserProfilePurgeReceipt = {
  purgeId: string; archiveId: string; profileId: string; status: BrowserProfilePurgeStatus
  requestedAt: number; updatedAt: number; warning?: string | undefined
  credentialCleanup?: 'pending' | 'confirmed' | 'unknown' | undefined
  permissionCleanup?: 'pending' | 'confirmed' | 'unknown' | undefined
}
export type BrowserProfilePurgeResult = { revision: number; purge: BrowserProfilePurgeReceipt }
export type BrowserProfileRecycleReceipt = { revision: number; archive: BrowserProfileTrashEntry }
export type BrowserProfileRestoreReceipt = { revision: number; archiveId: string; profile: BrowserProfileControlProfile }
