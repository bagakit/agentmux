/** The Host enumerates and reads entries from the same authorized original file source. */
export interface ArchiveEntry { path: string; size: number }
export interface ArchiveSource {
  entries(signal?: AbortSignal): Promise<ArchiveEntry[]>
  loadEntry(path: string, signal?: AbortSignal): Promise<Uint8Array>
}
