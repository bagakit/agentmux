import { lstat, mkdir, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName, scratchTopicStorageRoots } from '../shared/scratch-topics.js'
import { inspectDirectoryIdentity, readDirectoryIdentity, moteDirectoryName, type DirectoryIdentityContext } from './scratch-directory-identity.mjs'
export { SCRATCH_DIRECTORY_IDENTITY_PATH } from './scratch-directory-identity.mjs'

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
export async function ensureScratchStorageRoot(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
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
export async function scratchIdentityContext(scratchRoot: string, topicId?: string, original?: string): Promise<DirectoryIdentityContext> {
  const roots = scratchTopicStorageRoots(scratchRoot)
  const issues: string[] = []
  const values = await Promise.all([roots.legacy, roots.topics, roots.motes].map(async path => {
    try { return [...new Set([path, await regularRoot(path, path === roots.legacy)].filter((v): v is string => v !== null))] }
    catch (error) { issues.push(`${basename(path)} root is unconfirmed: ${error instanceof Error ? error.message : String(error)} Existing objects and healthy Agent work are kept; repair that original root.`); return [] }
  }))
  return { ...(topicId ? { topicId } : {}), ...(original ? { original } : {}), roots: { scratch: values[0]!, topics: values[1]!, motes: values[2]! }, ...(issues.length ? { issues } : {}) }
}
async function mote(directory: string, id: string): Promise<boolean> {
  if (id === PMO_TEAMS_TOPIC_ID) return true
  try { const info = await lstat(join(directory, 'SOUL.md')); return info.isFile() && !info.isSymbolicLink() }
  catch (error) { if (missing(error)) return false; throw error }
}

/** One owner confirms the bounded original addresses and actual physical object. */
export async function resolveScratchTopicDirectory(scratchRoot: string, topicId: string): Promise<string | null> {
  const context = await scratchIdentityContext(scratchRoot, topicId)
  const long = scratchTopicDirectoryName(topicId), short = moteDirectoryName(topicId)
  const candidates = [...new Set([...context.roots.scratch, ...context.roots.topics, ...context.roots.motes].map(root => join(root, long))
    .concat(context.roots.motes.map(root => join(root, short))))]
  const physical = new Set<string>(), aliases: string[] = []
  for (const directory of candidates) {
    let info
    try { info = await lstat(directory) } catch (error) { if (missing(error)) continue; throw error }
    if (info.isSymbolicLink()) {
      const target = resolve(directory, '..', await readlink(directory))
      if (!candidates.includes(target) || target === directory) throw new Error('The retained Topic alias escapes its confirmed object addresses.')
      aliases.push(directory)
    } else {
      if (!info.isDirectory()) throw new Error('The Topic path is not a regular directory.')
      const actual = await realpath(directory)
      if (basename(directory) === short) {
        const saved = await inspectDirectoryIdentity(actual, context)
        if (!saved || saved.topicId !== topicId) throw new Error('The short Mote directory has no confirmed full content ID. Its existing bytes are kept; repair its original record.')
      }
      physical.add(actual)
    }
  }
  if (physical.size > 1) throw new Error('Topic directory locations conflict. Preserve both directories and resolve the conflict before retrying.')
  const object = [...physical][0]
  for (const alias of aliases) if (!object || await realpath(alias) !== object) throw new Error('The retained alias does not reach the same confirmed Topic object.')
  if (!object && context.issues?.length) throw new Error(context.issues.join(' · '))
  return object ?? null
}

export async function scratchDirectoryIdentity(scratchRoot: string, topicId: string, physical: string): Promise<string> {
  const context = await scratchIdentityContext(scratchRoot, topicId)
  const saved = await readDirectoryIdentity(physical, context)
  if (saved) return saved
  if (basename(physical) === moteDirectoryName(topicId)) throw new Error('The short Mote original identity record is missing. Its original workface is kept; repair the same object.')
  const name = scratchTopicDirectoryName(topicId)
  for (const root of [...context.roots.scratch, ...context.roots.topics, ...context.roots.motes]) {
    try { if ((await lstat(join(root, name))).isSymbolicLink()) throw new Error('The relocated directory identity record is missing. Restore its original record before retrying.') }
    catch (error) { if (!missing(error)) throw error }
  }
  return physical
}
export async function scratchDirectoryAddress(scratchRoot: string, topicId: string, physical: string): Promise<string> {
  const roots = scratchTopicStorageRoots(scratchRoot), context = await scratchIdentityContext(scratchRoot, topicId)
  for (const [role, path] of [['scratch', roots.legacy], ['topics', roots.topics], ['motes', roots.motes]] as const) {
    if (context.roots[role].some(root => [scratchTopicDirectoryName(topicId), ...(role === 'motes' ? [moteDirectoryName(topicId)] : [])].some(name => join(root, name) === physical))) return join(path, basename(physical))
  }
  throw new Error('The Topic physical address changed while reading its original directory.')
}
export async function scratchConfirmedDirectoryPaths(scratchRoot: string, topicId: string, physical: string): Promise<string[]> {
  const context = await scratchIdentityContext(scratchRoot, topicId), paths: string[] = []
  for (const [role, roots] of Object.entries(context.roots)) for (const root of roots) for (const name of [scratchTopicDirectoryName(topicId), ...(role === 'motes' ? [moteDirectoryName(topicId)] : [])]) {
    const path = join(root, name)
    try { if (await realpath(path) === physical) paths.push(path) } catch (error) { if (!missing(error)) throw error }
  }
  // Reconfirm the whole original object; an arbitrary alias cannot add authority.
  if (await resolveScratchTopicDirectory(scratchRoot, topicId) !== physical) throw new Error('The object changed while confirming its retained addresses.')
  return [...new Set(paths)]
}
export type ScratchStorageIds = string[] & { issues?: string[] }
export async function scratchStorageTopicIds(scratchRoot: string): Promise<ScratchStorageIds> {
  const ids = new Set<string>(), issues: string[] = [], roots = scratchTopicStorageRoots(scratchRoot)
  const context = await scratchIdentityContext(scratchRoot)
  issues.push(...context.issues ?? [])
  for (const [role, path] of [['scratch', roots.legacy], ['topics', roots.topics], ['motes', roots.motes]] as const) {
    if (!context.roots[role].length) continue
    const root = await regularRoot(path, path === roots.legacy)
    if (!root) continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const id = scratchTopicIdFromDirectoryName(entry.name)
      if (id && (entry.isDirectory() || entry.isSymbolicLink())) ids.add(id)
      else if (path === roots.motes && /^[0-9a-f]{16}$/.test(entry.name)) {
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('The short Mote path is not a regular object.')
          const directory = join(root, entry.name), saved = await inspectDirectoryIdentity(directory, context)
          if (!saved?.topicId || moteDirectoryName(saved.topicId) !== entry.name || !await mote(directory, saved.topicId)) throw new Error('The short Mote full content ID is missing or unconfirmed.')
          ids.add(saved.topicId)
        } catch (error) { issues.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)} Existing files and bound workfaces are kept; retry original directory repair.`) }
      }
    }
  }
  const result: ScratchStorageIds = [...ids].sort()
  if (issues.length) result.issues = issues
  return result
}
