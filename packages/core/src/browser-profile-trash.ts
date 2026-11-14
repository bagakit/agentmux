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
}
export type BrowserProfileRecycleReceipt = { revision: number; archive: BrowserProfileTrashEntry }
export type BrowserProfileRestoreReceipt = { revision: number; archiveId: string; profile: BrowserProfileControlProfile }
