import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFile, DurableWriteError } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
async function optional(path: string): Promise<string | null> {
  try {
    const attributes = await lstat(path)
    if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new AgentMuxError(
      'The original private identity is not a protected regular file. Its bytes were retained.', 'IDENTITY_SOURCE_UNCONFIRMED')
    return await readFile(path, 'utf8')
  } catch (error) { if (missing(error)) return null; throw error }
}

/** Publish a complete immutable identity without replacing another writer's original. */
async function publish(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const candidate = `${path}.${mintObjectId()}.identity-candidate`
  let published = false
  try {
    await durableWriteFile(candidate, bytes, { mode: 0o600, requireDirectorySync: true })
    try { await link(candidate, path); published = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    // EEXIST is not permission to overwrite. Confirm the winning object below,
    // and never infer a failed directory ACK meant publication did not happen.
    for (const target of [path, dirname(path)]) {
      const handle = await open(target, 'r')
      try { await handle.sync() } catch (error) { throw new DurableWriteError(path, 'after-replace', error) }
      finally { await handle.close() }
    }
  } catch (error) {
    if (published && !(error instanceof DurableWriteError)) throw new DurableWriteError(path, 'after-replace', error)
    throw error
  } finally { await unlink(candidate).catch(error => { if (!missing(error)) throw error }) }
}

export type ImmutableIdentityRecovery = { status: 'available' } | { status: 'unavailable'; code: string }

/**
 * One owner's immutable identity and its protected recovery original. The copy
 * grants no independent control authority: disagreement is never merged, and
 * only an absent primary can be repaired. New custody is committed before the
 * primary is exposed, so a crash cannot require inventing a replacement key.
 */
export async function immutableIdentityFile<T>(path: string, options: {
  parse(bytes: string): T
  create(): T
  recover?: () => Promise<T | null>
  encode(value: T): string
  priorIdentity?: () => Promise<boolean>
  onRecoveryIssue?: (issue: Extract<ImmutableIdentityRecovery, { status: 'unavailable' }>) => void
}): Promise<T> {
  const custody = path + '.original'
  const primary = await optional(path)
  if (primary !== null) {
    const value = options.parse(primary)
    try {
      let original = await optional(custody)
      if (original === null) { await publish(custody, primary); original = await optional(custody) }
      if (original === null || !isDeepStrictEqual(options.parse(original), value)) throw new AgentMuxError(
        'The immutable identity contradicts its original recovery source. Keep both sources and inspect this owner.', 'IDENTITY_SOURCE_CONFLICT')
    } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'IDENTITY_SOURCE_CONFLICT') throw error
      // Auxiliary custody failure cannot revoke an already readable canonical
      // identity. It remains a visible recovery gap, never a fresh identity.
      const code = (error as NodeJS.ErrnoException)?.code
      options.onRecoveryIssue?.({ status: 'unavailable', code: typeof code === 'string' ? code : 'IDENTITY_RECOVERY_UNAVAILABLE' })
    }
    return value
  }
  let original = await optional(custody)
  if (original === null) {
    const recovered = await options.recover?.()
    if (!recovered && await options.priorIdentity?.()) throw new AgentMuxError(
      'This used namespace lost its original identity. Restore the original recovery source; no new identity was created.', 'IDENTITY_SOURCE_MISSING')
    const proposed = options.encode(recovered ?? options.create())
    options.parse(proposed)
    await publish(custody, proposed)
    original = await optional(custody)
  }
  if (original === null) throw new AgentMuxError('Original identity custody is unconfirmed. Keep this namespace and retry the same initialization.', 'IDENTITY_SOURCE_UNCONFIRMED')
  const value = options.parse(original)
  await publish(path, original)
  const actual = await optional(path)
  if (actual === null || !isDeepStrictEqual(options.parse(actual), value)) throw new AgentMuxError(
    'The original identity changed during publication. Both sources were retained.', 'IDENTITY_SOURCE_CONFLICT')
  return value
}

