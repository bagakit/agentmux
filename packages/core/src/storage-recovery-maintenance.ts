import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readdir, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { AgentMuxFileAgentSessionStore } from './agent-session-store.js'
import { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import { AgentMuxSpatialStateStore } from './spatial-state.js'
import { AgentMuxStorageRecovery, type RecoverySource } from './storage-recovery.js'
import { legacySessionRecoverySource, semanticRecoverySource, sessionRecoverySource } from './storage-recovery-sources.js'
import { AgentMuxControlServer } from './public-rpc-server.js'
import { STORAGE_RECOVERY_METHODS } from './storage-recovery-rpc.js'

export type AgentMuxStorageMaintenanceOptions = {
  stateDirectory: string; storePath: string; recoverySources?: readonly RecoverySource[]
  /** Optional exact retained generation; namespace is always read from protected original data. */
  generationId?: string
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
async function lease(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'a+', 0o600)
  if (!native.tryLock(file.fd)) { await file.close(); throw new AgentMuxError('The original semantic owner is live. Use its existing storage endpoint.', 'RUNTIME_OWNER_BUSY') }
  return file
}
async function protectedJson(path: string): Promise<Record<string, unknown>> {
  const attributes = await lstat(path)
  if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new AgentMuxError('The original recovery identity is not a protected regular file.', 'IDENTITY_SOURCE_UNCONFIRMED')
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}
/** Pure data owner: no Client, signing identity initialization, Native activation or default Session creation. */
export async function openAgentMuxStorageRecovery(options: AgentMuxStorageMaintenanceOptions): Promise<{ recovery: AgentMuxStorageRecovery; close(): Promise<void> }> {
  if (!isAbsolute(options.stateDirectory) || !isAbsolute(options.storePath)) throw new AgentMuxError('Recovery requires the exact original configured directories.', 'STORAGE_RECOVERY_INVALID')
  const lock = await lease(join(options.stateDirectory, 'semantic-owner.lock'))
  try {
    const directory = join(options.stateDirectory, 'recovery'), identityPath = join(options.stateDirectory, 'semantic-runtime.json')
    const identities = new Set<string>()
    for (const path of [identityPath, identityPath + '.original']) {
      try { const value = await protectedJson(path); if (value.schema !== 'agentmux.semantic-runtime.v1' || typeof value.runtimeId !== 'string' || !value.runtimeId) throw new AgentMuxError('The original semantic identity is unreadable.', 'IDENTITY_SOURCE_UNCONFIRMED'); identities.add(value.runtimeId) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (options.generationId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/u.test(options.generationId)) throw new AgentMuxError('Select an exact original generation.', 'STORAGE_RECOVERY_INVALID')
    const names = options.generationId ? [options.generationId + '.json'] : (await readdir(join(directory, 'generations')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => /^[A-Za-z0-9_-]{1,100}\.json$/u.test(name))
    const enrolled = new Map<string, RecoverySource>()
    for (const name of names.sort().reverse()) {
      let value: Record<string, unknown>
      try {
        value = await protectedJson(join(directory, 'generations', name))
        if (value.schema !== 'agentmux.recovery-generation.v1' || typeof value.namespace !== 'string' || !value.namespace) throw new AgentMuxError('The retained recovery namespace is unreadable.', 'IDENTITY_SOURCE_UNCONFIRMED')
      } catch (error) {
        // An unrelated broken generation cannot hide a confirmed original
        // namespace. list/inspect still reports that exact generation's issue.
        if (options.generationId) throw error
        continue
      }
      identities.add(value.namespace)
      // Protected original manifests enroll original data owners, never a new
      // client, default document or caller-supplied path from an RPC request.
      if (Array.isArray(value.sources)) for (const source of value.sources) {
        if (!source || typeof source !== 'object' || !Array.isArray(source.members) || enrolled.has(source.id)) continue
        const original = source.members.find((member: { id?: string }) => member.id === (source.id === 'core.spatial' ? 'original' : 'journal'))
        if (!original || typeof original.target !== 'string' || !isAbsolute(original.target)) continue
        if (source.id === 'core.spatial') enrolled.set(source.id, new AgentMuxSpatialStateStore(original.target).storageRecoverySource())
        if (source.id === 'core.message-intents') {
          const mutex = source.members.find((member: { id?: string }) => member.id === 'mutex')
          if (mutex?.target === original.target + '.mutex.sqlite') enrolled.set(source.id, new DurableAgentMuxMessageQueue(original.target).storageRecoverySource())
        }
      }
    }
    if (identities.size === 0 && !names.length) {
      const roots = [options.storePath, options.storePath + '.sqlite-identity', options.storePath + '.sqlite-identity.original', join(options.stateDirectory, 'agent-creation-identity.json'), join(options.stateDirectory, 'agent-creation-identity.json.original'), ...(options.recoverySources ?? []).flatMap(source => source.ownedPaths ?? [])]
      let used = false
      for (const path of roots) try { await lstat(path); used = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!used) used = (await readdir(dirname(options.storePath))).some(name => name.startsWith(options.storePath.split('/').at(-1)! + '.original-'))
      if (!used) throw new AgentMuxError('No original durable namespace or recovery source has been created here.', 'RECOVERY_OWNER_NOT_CREATED')
    }
    if (identities.size !== 1) throw new AgentMuxError('The exact original namespace is missing or contradictory. All original sources were retained.', 'IDENTITY_SOURCE_UNCONFIRMED')
    const store = new AgentMuxFileAgentSessionStore(options.storePath)
    const semanticPaths = ['semantic-runtime.json', 'semantic-runtime.json.original', 'agent-creation-identity.json', 'agent-creation-identity.json.original', 'agent-creation-trusted-sources', 'agent-message-trusted-sources', 'host-executors.json'].map(name => join(options.stateDirectory, name))
    const external = options.recoverySources ?? []
    const recovery = new AgentMuxStorageRecovery(directory, [...identities][0]!, [sessionRecoverySource(store), legacySessionRecoverySource(store.path),
      semanticRecoverySource(options.stateDirectory, directory, semanticPaths), ...[...enrolled.values()].filter(source => !external.some(owner => owner.id === source.id)), ...external], 5, { admit: input => store.admitRecoveryInputCut(input) })
    let closed = false
    return { recovery, async close() { if (closed) return; closed = true; try { await recovery.dispose() } finally { await lock.close() } } }
  } catch (error) { await lock.close(); throw error }
}

/** Explicit maintenance endpoint remains reachable when normal semantic startup cannot read its original identity or DB. */
export async function startAgentMuxStorageRecovery(options: AgentMuxStorageMaintenanceOptions & { socketPath: string }) {
  const owner = await openAgentMuxStorageRecovery(options)
  let endpoint: FileHandle | undefined, server: AgentMuxControlServer | undefined
  try {
    endpoint = await lease(options.socketPath + '.owner.lock')
    server = new AgentMuxControlServer({ socketPath: options.socketPath, storageRecovery: owner.recovery, exposedMethods: new Set(Object.keys(STORAGE_RECOVERY_METHODS) as Array<keyof typeof STORAGE_RECOVERY_METHODS>) })
    await server.start()
    let stopped = false
    return { ...owner, server, socketPath: options.socketPath, async stop() { if (stopped) return; stopped = true; try { await server!.stop() } finally { try { await endpoint!.close() } finally { await owner.close() } } } }
  } catch (error) { await server?.stop().catch(() => {}); await endpoint?.close(); await owner.close(); throw error }
}
