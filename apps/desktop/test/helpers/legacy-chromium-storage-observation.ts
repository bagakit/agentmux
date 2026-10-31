import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Session } from 'electron'
import type { DesktopWorkbenchStorageObservation } from '../../src/shared/client-observation.js'

/** Fixture-only raw older-producer observation. It never qualifies a save or installation. */
export async function observeLegacyChromiumStorage(
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
