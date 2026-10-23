/** Observe the real Node backup, with small batches only for the close-overlap oracle. */
import { backup as nativeBackup } from 'node:sqlite'
export { DatabaseSync } from 'node:sqlite'
export const backupProgress: { current?: (value: { remainingPages: number; totalPages: number }) => void } = {}
export const backup: typeof nativeBackup = (source, path, options) => nativeBackup(source, path, backupProgress.current ? {
  ...options, rate: 1, progress(value) { options?.progress?.(value); backupProgress.current?.(value) }
} : options ?? {})
