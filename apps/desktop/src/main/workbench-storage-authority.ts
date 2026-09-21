import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Session } from 'electron'
import type { DesktopWorkbenchStorageObservation } from '../shared/client-observation.js'

/** Observe the current window's Chromium owner. Directory presence is not a disk-write ACK. */
export async function observeWorkbenchStorageAuthority(
  session: Pick<Session, 'getStoragePath'>,
  configured: { userData: string; sessionData: string }
): Promise<DesktopWorkbenchStorageObservation> {
  const base = { userData: configured.userData, sessionData: configured.sessionData, directory: null as string | null }
  let directory: string | null
  try { directory = session.getStoragePath() }
  catch { return { ...base, localStorage: 'unconfirmed', detail: 'The Chromium storage owner could not be read.' } }
  if (directory === null) return { ...base, localStorage: 'unconfirmed', detail: 'This Chromium Session has no persistent storage directory.' }
  base.directory = directory
  if (resolve(directory) !== resolve(configured.sessionData)) {
    return { ...base, localStorage: 'unconfirmed', detail: 'The current Chromium storage owner and configured workbench root do not match.' }
  }
  // Inspect Chromium's database directory, not a particular LevelDB generation or log file. Missing and
  // unreadable storage are local qualification gaps, never Agent death or proven database corruption.
  try {
    const metadata = await stat(join(directory, 'Local Storage', 'leveldb'))
    return metadata.isDirectory()
      ? { ...base, localStorage: 'present', detail: null }
      : { ...base, localStorage: 'unconfirmed', detail: 'The local storage directory could not be confirmed.' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ...base, localStorage: 'missing', detail: 'The current Chromium local storage database directory is absent.' }
      : { ...base, localStorage: 'unconfirmed', detail: 'The current Chromium local storage database directory could not be read.' }
  }
}

/** Failure only cancels the unsafe presentation transition; it grants no Run lifecycle authority. */
export function requireWorkbenchStorageAuthority(observation: DesktopWorkbenchStorageObservation): void {
  if (observation.localStorage !== 'present') throw new Error(
    `Saving the workbench is unconfirmed. ${observation.detail ?? 'The current storage owner is unavailable.'}`
  )
}
