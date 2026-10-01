import { constants, lstat, mkdir, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scratchTopicDirectoryName, scratchTopicIdFromDirectoryName, scratchTopicStorageRoots } from '../shared/scratch-topics.js'

export const SCRATCH_DIRECTORY_IDENTITY_PATH = '.agentmux/directory-identity.json'

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

export async function ensureScratchStorageRoot(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Topic storage root is not a regular directory.')
}

async function regularRoot(path: string, legacy = false): Promise<string | null> {
  try {
    const info = legacy ? await stat(path) : await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Topic storage root is not a regular directory.')
    return await realpath(path)
  } catch (error) { if (missing(error)) return null; throw error }
}

/** Only exact entity directories and the explicitly retained legacy alias share an identity. */
export async function resolveScratchTopicDirectory(scratchRoot: string, topicId: string): Promise<string | null> {
  const name = scratchTopicDirectoryName(topicId)
  const roots = scratchTopicStorageRoots(scratchRoot)
  const rootLocations = await Promise.all([...new Set(Object.values(roots))].map(async path => ({ path, root: await regularRoot(path, path === roots.legacy) })))
  const physical = new Set<string>()
  let alias: string | undefined
  for (const { path, root } of rootLocations) {
    if (!root) continue
    const directory = join(root, name)
    let info
    try { info = await lstat(directory) } catch (error) { if (missing(error)) continue; throw error }
    if (info.isSymbolicLink()) {
      if (path !== roots.legacy) throw new Error('A canonical Topic directory cannot be a symbolic link.')
      const target = resolve(root, await readlink(directory))
      if (!rootLocations.some(candidate => candidate.path !== roots.legacy && candidate.root &&
        [join(candidate.root, name), resolve(candidate.path, name)].includes(target)))
        throw new Error('The legacy Topic alias escapes its canonical home.')
      alias = await realpath(directory)
    } else {
      if (!info.isDirectory()) throw new Error('The Topic path is not a regular directory.')
      const resolved = await realpath(directory)
      if (resolved !== join(root, name)) throw new Error('The Topic directory escapes its storage root.')
      physical.add(resolved)
    }
  }
  if (physical.size > 1 || alias && !physical.has(alias))
    throw new Error('Topic directory locations conflict. Preserve both directories and resolve the conflict before retrying.')
  return physical.values().next().value ?? null
}

export async function scratchDirectoryIdentity(scratchRoot: string, topicId: string, physical: string): Promise<string> {
  const original = join(scratchRoot, scratchTopicDirectoryName(topicId))
  try {
    const metadata = await lstat(join(physical, '.agentmux'))
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Directory identity metadata is not a regular directory.')
    const handle = await open(join(physical, SCRATCH_DIRECTORY_IDENTITY_PATH), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 4096) throw new Error('Directory identity metadata is not a bounded regular file.')
      const value = JSON.parse(await handle.readFile('utf8'))
      if (!value || value.version !== 1 || value.identityDirectoryPath !== original ||
        Object.keys(value).sort().join(',') !== 'identityDirectoryPath,version')
        throw new Error('Directory identity is unconfirmed. Repair the original identity record before retrying.')
      return value.identityDirectoryPath
    } finally { await handle.close() }
  } catch (error) {
    if (!missing(error)) throw error
    try {
      if ((await lstat(original)).isSymbolicLink()) throw new Error('The relocated directory identity record is missing. Restore its original record before retrying.')
    } catch (originalError) { if (!missing(originalError)) throw originalError }
    return physical
  }
}

/** Keep the configured ancestor address while resolving and confining all actual IO above. */
export async function scratchDirectoryAddress(scratchRoot: string, topicId: string, physical: string): Promise<string> {
  const name = scratchTopicDirectoryName(topicId)
  for (const path of new Set(Object.values(scratchTopicStorageRoots(scratchRoot)))) {
    const root = await regularRoot(path, path === scratchRoot)
    if (root && join(root, name) === physical) return join(path, name)
  }
  throw new Error('The Topic physical address changed while reading its original directory.')
}

export async function scratchStorageTopicIds(scratchRoot: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const path of new Set(Object.values(scratchTopicStorageRoots(scratchRoot)))) {
    const root = await regularRoot(path, path === scratchRoot)
    if (!root) continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const id = scratchTopicIdFromDirectoryName(entry.name)
      if (id && (entry.isDirectory() || entry.isSymbolicLink())) ids.add(id)
    }
  }
  return [...ids].sort()
}
