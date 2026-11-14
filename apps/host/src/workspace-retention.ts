import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from './mote-topic-model.js'
import { resolveScratchTopicDirectory, scratchConfirmedDirectoryPaths } from './mote-directories.js'
import type { WorkspaceRecord } from './content-types.js'

/** The original Files retention rule shared by Host and Desktop adapters. */
export async function assertPrimaryMoteRetained(workspace: WorkspaceRecord, target: string,
  primaryWorkspace?: () => Promise<WorkspaceRecord | undefined>): Promise<void> {
  const primary = await primaryWorkspace?.()
  if (!primary || primary.hostId !== workspace.hostId) return
  // Resolve aliases, including a missing final component of an overwrite destination.
  const canonical = async (path: string): Promise<string> => {
    try { return await realpath(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
      return resolve(await canonical(dirname(path)), basename(path))
    }
  }
  // Delete unlinks a leaf symlink; resolve only its parent, matching the actual worker operation.
  const address = resolve(await canonical(dirname(target)), basename(target))
  const primaryName = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
  const physicalPrimary = await resolveScratchTopicDirectory(primary.path, PMO_TEAMS_TOPIC_ID)
  const protectedAddress = physicalPrimary ?? resolve(await canonical(primary.path), primaryName)
  let protectedEntry = address === protectedAddress || protectedAddress.startsWith(address + sep)
  if (physicalPrimary) for (const path of await scratchConfirmedDirectoryPaths(primary.path, PMO_TEAMS_TOPIC_ID, physicalPrimary)) {
    const entry = resolve(await canonical(dirname(path)), basename(path))
    if (address === entry || entry.startsWith(address + sep)) protectedEntry = true
  }
  // The original config path must also remain reachable if it uses a backing-root alias.
  for (let entry = resolve(primary.path, primaryName); !protectedEntry && dirname(entry) !== entry; entry = dirname(entry)) {
    protectedEntry = address === resolve(await canonical(dirname(entry)), basename(entry))
  }
  if (protectedEntry) {
    throw Object.assign(new Error('The primary Mote cannot be deleted, moved or replaced. Its title and files inside it can still be managed.'), {
      code: 'PRIMARY_MOTE_PROTECTED', definitelyUnchanged: true
    })
  }
}
