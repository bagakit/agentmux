import { createRequire } from 'node:module'
import { lstat, mkdir, open, readFile, readdir, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { AgentMuxFileAgentSessionStore } from './agent-session-store.js'
import { DurableAgentMuxMessageQueue } from './agent-global-message-queue.js'
import { AgentMuxSpatialStateStore } from './spatial-state.js'
import { AgentMuxStorageRecovery, recoveryDigest, restoreMissingRecoveryFile, type RecoveryRestoreMember, type RecoverySource } from './storage-recovery.js'
import { legacySessionRecoverySource, semanticRecoverySource, sessionRecoverySource } from './storage-recovery-sources.js'
import { AgentMuxControlServer } from './public-rpc-server.js'
import { STORAGE_RECOVERY_METHODS } from './storage-recovery-rpc.js'
import { inspectImmutableIdentity, readProtectedIdentityFile } from './immutable-identity-file.js'
import { parseOriginalCreationIdentity } from './agent-creation-authority.js'
import { inspectSemanticRuntimeIdentity, parseSemanticRuntimeIdentity, priorSemanticNamespace,
  semanticRuntimeAuthority, semanticRuntimeIdentityName, semanticRuntimeIdentityMembers, semanticRuntimeIdentityMaxBytes,
  type SemanticRuntimeLocation } from './semantic-runtime-identity.js'

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

const identityUnconfirmed = () => new AgentMuxError('The selected material does not confirm the original Runtime identity.', 'IDENTITY_SOURCE_UNCONFIRMED')
function targetUnconfirmed(cause?: unknown) {
  const error = new AgentMuxError('The existing Runtime identity records could not be confirmed. Their contents were retained.', 'IDENTITY_TARGET_UNCONFIRMED')
  error.cause = cause
  return error
}

async function verifySemanticIdentity(options: SemanticRuntimeLocation, bytes: string, expectedRuntimeId?: string) {
  const value = parseSemanticRuntimeIdentity(bytes, semanticRuntimeAuthority(options.stateDirectory, options.storePath))
  const seed = value.creationIdentity && parseOriginalCreationIdentity(JSON.stringify({
    schema: 'agentmux.agent-creation-authority.v1', ...value.creationIdentity
  }))
  const witness = await inspectImmutableIdentity(join(options.stateDirectory, 'agent-creation-identity.json'),
    parseOriginalCreationIdentity, { maxBytes: 16_384 }).catch(cause => { throw targetUnconfirmed(cause) })
  if (value.runtimeId !== (expectedRuntimeId ?? witness?.runtimeId) || witness && (witness.runtimeId !== value.runtimeId ||
    seed && !isDeepStrictEqual(seed, witness)))
    throw identityUnconfirmed()
  return value
}

function semanticIdentityValidator(options: SemanticRuntimeLocation, namespace: string) {
  return async (members: readonly RecoveryRestoreMember[]) => {
    const identities = members.filter(member => semanticRuntimeIdentityMembers.some(name => name === member.id))
    let first: Awaited<ReturnType<typeof verifySemanticIdentity>> | undefined
    for (const member of identities) {
      if (member.target !== join(options.stateDirectory, member.id)) throw identityUnconfirmed()
      const bytes = await readProtectedIdentityFile(member.file, semanticRuntimeIdentityMaxBytes)
      if (bytes === null || recoveryDigest(bytes) !== member.sha256) throw identityUnconfirmed()
      const identity = await verifySemanticIdentity(options, bytes, namespace)
      if (first && !isDeepStrictEqual(first, identity)) throw identityUnconfirmed()
      first = identity
    }
  }
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
    const namespace = [...identities][0]!
    const store = new AgentMuxFileAgentSessionStore(options.storePath)
    const semanticPaths = ['semantic-runtime.json', 'semantic-runtime.json.original', 'agent-creation-identity.json', 'agent-creation-identity.json.original', 'agent-creation-trusted-sources', 'agent-message-trusted-sources', 'host-executors.json'].map(name => join(options.stateDirectory, name))
    const external = options.recoverySources ?? []
    const recovery = new AgentMuxStorageRecovery(directory, namespace, [sessionRecoverySource(store), legacySessionRecoverySource(store.path),
      semanticRecoverySource(options.stateDirectory, directory, semanticPaths, semanticIdentityValidator(options, namespace)),
      ...[...enrolled.values()].filter(source => !external.some(owner => owner.id === source.id)), ...external], 5, { admit: input => store.admitRecoveryInputCut(input) })
    let closed = false
    return { recovery, async close() { if (closed) return; closed = true; try { await recovery.dispose() } finally { await lock.close() } } }
  } catch (error) { await lock.close(); throw error }
}

export type SemanticIdentityRecoveryResult = { state: 'unchanged' | 'restored' | 'deferred' } | { state: 'needs-backup' | 'blocked'; code: string }

/** Missing identity only. Desktop and headless maintenance use the same storage owner and lease. */
export async function restoreMissingSemanticIdentity(options: SemanticRuntimeLocation, selectedOriginal?: string): Promise<SemanticIdentityRecoveryResult> {
  if (!isAbsolute(options.stateDirectory) || !isAbsolute(options.storePath) || selectedOriginal !== undefined && !isAbsolute(selectedOriginal))
    throw new AgentMuxError('Recovery requires the exact original configured paths.', 'STORAGE_RECOVERY_INVALID')
  const inspectOriginal = () => inspectSemanticRuntimeIdentity(options).catch(cause => { throw targetUnconfirmed(cause) })
  if (await inspectOriginal()) return { state: 'unchanged' }
  if (selectedOriginal !== undefined) {
    const lock = await lease(join(options.stateDirectory, 'semantic-owner.lock'))
    try {
      if (await inspectOriginal()) return { state: 'unchanged' }
      const bytes = await readProtectedIdentityFile(selectedOriginal, semanticRuntimeIdentityMaxBytes)
      if (bytes === null) throw identityUnconfirmed()
      await verifySemanticIdentity(options, bytes)
      const outcome = await restoreMissingRecoveryFile(selectedOriginal, join(options.stateDirectory, semanticRuntimeIdentityName), recoveryDigest(bytes))
      if (outcome === 'conflict') throw targetUnconfirmed()
      return { state: 'restored' }
    } finally { await lock.close() }
  }
  let owner: Awaited<ReturnType<typeof openAgentMuxStorageRecovery>>
  try { owner = await openAgentMuxStorageRecovery(options) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'RUNTIME_OWNER_BUSY') return { state: 'deferred' }
    if (code === 'RECOVERY_OWNER_NOT_CREATED') return { state: 'unchanged' }
    if (code === 'IDENTITY_SOURCE_UNCONFIRMED' && !await priorSemanticNamespace(options.stateDirectory, options.storePath)) return { state: 'unchanged' }
    throw error
  }
  try {
    if (await inspectOriginal()) return { state: 'unchanged' }
    const sourceId = 'core.semantic'
    let found = false
    for (const { generationId, manifestHash, coverage } of await owner.recovery.list()) {
      const selectors = (coverage ?? []).filter(member => member.sourceId === sourceId &&
        semanticRuntimeIdentityMembers.some(name => name === member.memberId)).map(({ sourceId, memberId }) => ({ sourceId, memberId }))
      if (!selectors.length) continue
      found = true
      const operationBase = 'semantic-bootstrap-' + recoveryDigest(JSON.stringify({ generationId, manifestHash, selectors }))
      const inspect = async (operationId: string) => await owner.recovery.restoreInspect(operationId).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      let operationId = operationBase, prior = await inspect(operationId)
      for (let attempt = 1; prior?.state === 'complete'; attempt++) {
        // A fresh confirmed loss may use the same good source. An unresolved prior
        // operation keeps its own identity and is never bypassed.
        if (await inspectOriginal()) return { state: 'unchanged' }
        operationId = `${operationBase}-${attempt}`
        prior = await inspect(operationId)
      }
      let prepared = prior
      if (!prepared) {
        // Preflight has made no identity writes. An invalid or missing backup
        // must not prevent another still-verifiable generation from being used.
        try { prepared = await owner.recovery.restorePreflight({ operationId, generationId, manifestHash, selectors }) }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'STORAGE_RECOVERY_INVALID') continue
          throw error
        }
      }
      if (prepared.state === 'unknown' || prepared.state === 'unavailable') return { state: 'needs-backup', code: 'IDENTITY_RECOVERY_UNCONFIRMED' }
      const applied = await owner.recovery.restoreApply(operationId)
      return applied.state === 'complete' && await inspectOriginal()
        ? { state: 'restored' } : { state: 'needs-backup', code: 'IDENTITY_RECOVERY_UNCONFIRMED' }
    }
    return { state: 'needs-backup', code: found ? 'IDENTITY_RECOVERY_UNCONFIRMED' : 'IDENTITY_SOURCE_MISSING' }
  } finally { await owner.close() }
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
