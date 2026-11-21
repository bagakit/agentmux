import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { readCurrentSessionDatabase } from './agent-session-database.js'
import { AgentMuxError } from './errors.js'
import { inspectImmutableIdentity } from './immutable-identity-file.js'
import { defaultAgentMuxHookPort, defaultCtxmuxSocketPath, defaultCtxmuxStateDirectory } from './runtime-paths.js'

export const semanticRuntimeIdentityName = 'semantic-runtime.json'
export const semanticRuntimeIdentityMembers = [semanticRuntimeIdentityName, `${semanticRuntimeIdentityName}.original`] as const
// The record contains an ID, an authority digest and at most two short signing keys.
export const semanticRuntimeIdentityMaxBytes = 16 * 1024
export type SemanticRuntimeLocation = { stateDirectory: string; storePath: string }
type CreationIdentity = { runtimeId: string; publicKey: string; privateKey: string }
type SemanticRuntimeIdentity = {
  schema: 'agentmux.semantic-runtime.v1'; runtimeId: string; authority: string; creationIdentity?: CreationIdentity
}

export function semanticRuntimeAuthority(stateDirectory: string, storePath: string | null, environment?: Readonly<Record<string, string | undefined>>): string {
  return createHash('sha256').update(JSON.stringify({ stateDirectory, storePath,
    ctxmuxSocket: defaultCtxmuxSocketPath(environment), ctxmuxState: defaultCtxmuxStateDirectory(environment), hookPort: defaultAgentMuxHookPort(environment) })).digest('hex')
}

export function parseSemanticRuntimeIdentity(bytes: string, authority: string): SemanticRuntimeIdentity {
  let value: Partial<SemanticRuntimeIdentity> | null
  try { value = JSON.parse(bytes) } catch { throw new AgentMuxError('The original semantic identity is unreadable.', 'RUNTIME_AUTHORITY_MISMATCH') }
  if (value?.schema !== 'agentmux.semantic-runtime.v1' || typeof value.runtimeId !== 'string' || !value.runtimeId || value.authority !== authority)
    throw new AgentMuxError('Durable semantic Runtime authority does not match this Store/Hook/ctxmux binding. Existing Runs were preserved.', 'RUNTIME_AUTHORITY_MISMATCH')
  const seed = value.creationIdentity
  if (seed !== undefined && (!seed || seed.runtimeId !== value.runtimeId || typeof seed.publicKey !== 'string' || typeof seed.privateKey !== 'string' ||
    !/^[A-Za-z0-9_-]{1,512}$/u.test(seed.publicKey) || !/^[A-Za-z0-9_-]{1,512}$/u.test(seed.privateKey)))
    throw new AgentMuxError('The original namespace signing preparation is unreadable.', 'RUNTIME_AUTHORITY_MISMATCH')
  return { schema: value.schema, runtimeId: value.runtimeId, authority,
    ...(seed ? { creationIdentity: { runtimeId: seed.runtimeId, publicKey: seed.publicKey, privateKey: seed.privateKey } } : {}) }
}

/** A replacement may require the primary so it need not publish one after shutting down the live Host. */
export async function inspectSemanticRuntimeIdentity(location: SemanticRuntimeLocation,
  options: { requirePrimary?: boolean; environment?: Readonly<Record<string, string | undefined>> } = {}): Promise<string | null> {
  const authority = semanticRuntimeAuthority(location.stateDirectory, location.storePath, options.environment)
  const identity = await inspectImmutableIdentity(join(location.stateDirectory, semanticRuntimeIdentityName),
    bytes => parseSemanticRuntimeIdentity(bytes, authority), { ...options, maxBytes: semanticRuntimeIdentityMaxBytes })
  return identity?.runtimeId ?? null
}

export async function retainedSessionRecovery(stateDirectory: string, storePath: string): Promise<boolean> {
  const directory = join(stateDirectory, 'recovery', 'generations')
  let names: string[]
  try { names = await readdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  for (const name of names.filter(name => /^[A-Za-z0-9_-]{1,100}\.json$/u.test(name))) {
    const path = join(directory, name), attributes = await lstat(path)
    if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new AgentMuxError('The retained original recovery namespace is unconfirmed.', 'AGENT_SESSION_STORE_UNAVAILABLE')
    let manifest: { schema?: unknown; sources?: Array<{ id?: string; members?: Array<{ id?: string; target?: string }> }> }
    try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch { throw new AgentMuxError('The retained original recovery namespace is unreadable.', 'AGENT_SESSION_STORE_UNAVAILABLE') }
    if (manifest.schema !== 'agentmux.recovery-generation.v1' || !Array.isArray(manifest.sources)) throw new AgentMuxError('The retained original recovery namespace is unconfirmed.', 'AGENT_SESSION_STORE_UNAVAILABLE')
    if (manifest.sources.some(source => source.id === 'core.sessions' && source.members?.some(member => member.id === 'database' && member.target === storePath))) return true
  }
  return false
}
export async function priorSemanticNamespace(stateDirectory: string, storePath: string): Promise<boolean> {
  for (const path of [join(stateDirectory, 'agent-creation-identity.json'), join(stateDirectory, 'agent-creation-identity.json.original')]) {
    try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const database = await readCurrentSessionDatabase(storePath, { readOnly: true })
  if (database) try {
    // An empty catalog created by first-launch observation is not a previous
    // semantic Runtime. Existing user/lifecycle facts are a different case.
    for (const table of ['sessions', 'retired_sessions', 'reservations', 'prompt_admissions']) {
      if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue
      if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true
    }
  } finally { database.close() }
  if (!database) {
    // A retained original import is positive evidence of a used namespace,
    // never permission to import it again or silently initialize an empty one.
    try { if ((await readdir(dirname(storePath))).some(name => name.startsWith(basename(storePath) + '.original-'))) return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return await retainedSessionRecovery(stateDirectory, storePath)
}
