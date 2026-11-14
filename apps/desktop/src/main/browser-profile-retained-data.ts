import { constants } from 'node:fs'
import { open, opendir, lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { browserProfilePartition, type BrowserProfileRetainedPartition } from './browser-profile-store.js'

export class BrowserProfileDataUnavailable extends Error {
  readonly code = 'BROWSER_PROFILE_DATA_UNAVAILABLE'
  constructor(cause?: unknown) { super('The original Profile data or its ownership could not be confirmed. The original Profile and data are kept; repair source access and retry.', { cause }) }
}
/** The native Session supplies the original path; no public caller supplies a data directory. */
export function describeRetainedPartition(sessionRoot: string, profileId: string, nativePath: string | null): BrowserProfileRetainedPartition {
  if (!nativePath) throw new BrowserProfileDataUnavailable()
  const path = relative(resolve(sessionRoot), resolve(nativePath))
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).some(part => !part || part === '..' || part === '.')) throw new BrowserProfileDataUnavailable()
  return { partition: browserProfilePartition(profileId), relativePath: path }
}
export function retainedPartitionPath(sessionRoot: string, data: BrowserProfileRetainedPartition): string {
  const root = resolve(sessionRoot), path = resolve(root, data.relativePath), rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/u).some(part => part === '..' || part === '.')) throw new BrowserProfileDataUnavailable()
  return path
}
/** Verify readability without moving, copying, filtering or claiming a native immutable checkpoint. */
export async function inspectRetainedPartition(sessionRoot: string, data: BrowserProfileRetainedPartition): Promise<void> {
  try {
    async function inspect(path: string): Promise<void> {
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Retained data contains an ownership link')
      if (info.isDirectory()) {
        const directory = await opendir(path)
        for await (const entry of directory) await inspect(resolve(path, entry.name))
      } else if (info.isFile()) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { if (!(await file.stat()).isFile()) throw new Error('Retained source changed') } finally { await file.close() }
      } else throw new Error('Retained source is not a regular data file or directory')
    }
    await inspect(retainedPartitionPath(sessionRoot, data))
  } catch (cause) { throw cause instanceof BrowserProfileDataUnavailable ? cause : new BrowserProfileDataUnavailable(cause) }
}
