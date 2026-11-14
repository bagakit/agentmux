import { mkdir, open, readFile, readdir, rename, rm, rmdir, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRelayMeshIdentity, meshCanonical, meshInteger, meshObject, meshString, parseRelayMeshConfiguration, type RelayMeshIdentity } from './mesh-protocol.js'
import { acquireMeshStateGuard } from './mesh-state-guard.js'

type State = { schema: 'agentmux.relay-mesh-state.v1'; identity: Omit<RelayMeshIdentity, 'epoch'>; epoch: number; operationId: string }
type Owner = { ownerId: string; pid: number; guardPid: number; operationId: string; proposedEpoch?: number; baseEpoch?: number; baseOperationId?: string; peerId?: string; publicKey?: string; createdFrom?: string }
export interface RelayMeshStateInspection {
  schema: 'agentmux.relay-mesh-state-inspection.v1'
  directory: string
  state: 'observed' | 'unavailable'
  identity: { peerId: string; publicKey: string; epoch: number; operationId: string } | null
  owner: Owner | null
}
function stateFailure(code: string, operationId: string): Error {
  return Object.assign(new Error(code === 'MESH_STATE_DURABILITY_UNKNOWN'
    ? 'The original Mesh epoch save is unconfirmed. Keep its key, state, owner lock and operation; inspect before explicit recovery.'
    : 'The original Mesh identity/state owner is unavailable or already held. Retain its private state and any healthy incumbent; no key was replaced.'), { code, operationId })
}
async function syncDirectory(path: string) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function atomic(path: string, directory: string, value: unknown, operationId: string) {
  const temporary = join(directory, '.mesh-state-' + operationId + '.tmp')
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
  await rename(temporary, path); await syncDirectory(directory)
}
async function syncCreatedParents(directory: string, firstCreated: string | undefined) {
  if (!firstCreated) return
  let current = directory
  // fsync every new directory's entry in its parent, including recursive mkdir.
  for (;;) {
    const parent = dirname(current)
    await syncDirectory(parent)
    if (current === firstCreated) return
    if (parent === current) throw new Error('Original Mesh directory ancestry is unconfirmed.')
    current = parent
  }
}
function parseState(value: unknown): State {
  const p = meshObject(value, ['schema', 'identity', 'epoch', 'operationId'])
  if (p.schema !== 'agentmux.relay-mesh-state.v1') throw Error('Unknown Mesh state schema')
  const i = meshObject(p.identity, ['peerId', 'publicKey', 'secretKey'])
  const identity = { peerId: meshString(i.peerId), publicKey: meshString(i.publicKey), secretKey: meshString(i.secretKey) }
  const epoch = meshInteger(p.epoch, 0)
  parseRelayMeshConfiguration({ networkId: 'identity-validation', identity: { ...identity, epoch: Math.max(1, epoch) }, members: [{ peerId: identity.peerId, publicKey: identity.publicKey }], peers: [] })
  return { schema: 'agentmux.relay-mesh-state.v1', identity, epoch, operationId: meshString(p.operationId) }
}
function parseOwner(value: unknown): Owner {
  const p = meshObject(value, ['ownerId', 'pid', 'guardPid', 'operationId', 'proposedEpoch', 'baseEpoch', 'baseOperationId', 'peerId', 'publicKey', 'createdFrom'])
  return { ownerId: meshString(p.ownerId), pid: meshInteger(p.pid), guardPid: meshInteger(p.guardPid), operationId: meshString(p.operationId),
    ...(p.proposedEpoch === undefined ? {} : { proposedEpoch: meshInteger(p.proposedEpoch) }),
    ...(p.baseEpoch === undefined ? {} : { baseEpoch: meshInteger(p.baseEpoch, 0) }),
    ...(p.baseOperationId === undefined ? {} : { baseOperationId: meshString(p.baseOperationId) }),
    ...(p.peerId === undefined ? {} : { peerId: meshString(p.peerId) }), ...(p.publicKey === undefined ? {} : { publicKey: meshString(p.publicKey) }),
    ...(p.createdFrom === undefined ? {} : { createdFrom: meshString(p.createdFrom) }) }
}
async function privateDirectory(directory: string) {
  if (!isAbsolute(directory)) throw Error('Mesh state directory must be absolute.')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw Error('Mesh state directory is unconfirmed.')
}
async function readState(directory: string) {
  const path = join(directory, 'identity.json'), info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw Error('Original Mesh key file is unconfirmed.')
  return parseState(JSON.parse(await readFile(path, 'utf8')))
}
/** Passive public read: never creates an identity, checks PID health or acquires a lease. */
export async function inspectRelayMeshState(directory: string): Promise<RelayMeshStateInspection> {
  await privateDirectory(directory)
  let state: State | undefined, owner: Owner | null = null, observed = true
  try { state = await readState(directory) } catch { observed = false }
  try { owner = parseOwner(JSON.parse(await readFile(join(directory, 'owner.lock', 'owner.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') observed = false }
  return { schema: 'agentmux.relay-mesh-state-inspection.v1', directory, state: observed && state ? 'observed' : 'unavailable',
    identity: state ? { peerId: state.identity.peerId, publicKey: state.identity.publicKey, epoch: state.epoch, operationId: state.operationId } : null, owner }
}
/** Explicit readback under the same OS guard used by serve/init. Does not replay
 * a save, mint a key, increment an epoch, kill a process or reconstruct its ACK. */
export async function reconcileRelayMeshState(directory: string, expected: RelayMeshStateInspection) {
  await privateDirectory(directory)
  const recoveryOperationId = randomBytes(18).toString('base64url')
  const guard = await acquireMeshStateGuard(directory, recoveryOperationId)
  try {
    const current = await inspectRelayMeshState(directory)
    if (current.state !== 'observed' || !current.identity || !current.owner || meshCanonical(current) !== meshCanonical(expected))
      throw stateFailure('MESH_STATE_RECOVERY_CONFLICT', recoveryOperationId)
    const original = current.owner
    if (original.proposedEpoch === undefined || original.baseEpoch === undefined || original.baseOperationId === undefined ||
      original.proposedEpoch !== original.baseEpoch + 1 || original.peerId !== current.identity.peerId || original.publicKey !== current.identity.publicKey ||
      !(current.identity.epoch === original.proposedEpoch && current.identity.operationId === original.operationId || current.identity.epoch === original.baseEpoch && current.identity.operationId === original.baseOperationId))
      throw stateFailure('MESH_STATE_RECOVERY_CONFLICT', recoveryOperationId)
    // An OS guard held by a child cannot fence a still-live Node writer's pending
    // rename/unlink. Offline recovery additionally requires that exact local
    // writer to be absent. PID reuse, EPERM and unknown all refuse; never kill it.
    let absent = false
    try { process.kill(original.pid, 0) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH' }
    if (!absent) throw stateFailure('MESH_STATE_WRITER_ACTIVE_OR_UNCONFIRMED', original.operationId)
    const file = await open(join(directory, 'identity.json'), 'r')
    try { await file.sync() } finally { await file.close() }
    await syncDirectory(directory)
    const createdFrom = current.owner?.createdFrom
    if (createdFrom !== undefined && (!isAbsolute(createdFrom) || directory !== createdFrom && !directory.startsWith(createdFrom + '/'))) throw stateFailure('MESH_STATE_RECOVERY_CONFLICT', recoveryOperationId)
    await syncCreatedParents(directory, createdFrom); guard.current()
    if (current.owner) {
      const lock = join(directory, 'owner.lock')
      const owner = parseOwner(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')))
      if (meshCanonical(owner) !== meshCanonical(current.owner)) throw stateFailure('MESH_STATE_RECOVERY_CONFLICT', recoveryOperationId)
      guard.current(); await rm(join(lock, 'owner.json')); await rmdir(lock); await syncDirectory(directory)
    }
    return { operation: 'state.reconcile', recoveryOperationId, originalOperationId: current.owner?.operationId ?? current.identity.operationId,
      identity: current.identity, originalSaveAcknowledgement: 'not-reconstructed', readbackDurability: 'confirmed', ownerReleased: true }
  } finally { await guard.release() }
}
/** Standalone assembly only. Core supplies its own reserved durable identity. */
export async function acquireRelayMeshIdentity(directory: string, requestedOperationId?: string) {
  const operationId = requestedOperationId ?? randomBytes(18).toString('base64url')
  if (!isAbsolute(directory) || !/^[A-Za-z0-9_-]+$/u.test(operationId)) throw stateFailure('MESH_STATE_UNCONFIRMED', operationId)
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 })
  await privateDirectory(directory)
  const guard = await acquireMeshStateGuard(directory, operationId)
  const lock = join(directory, 'owner.lock'), ownerId = randomBytes(24).toString('base64url')
  try { await mkdir(lock, { mode: 0o700 }) } catch { await guard.release(); throw stateFailure('MESH_STATE_IN_USE_OR_UNCONFIRMED', operationId) }
  let acknowledged = false, epochWriteStarted = false
  const owner: Owner = { ownerId, pid: process.pid, guardPid: guard.pid, operationId, ...(firstCreated === undefined ? {} : { createdFrom: firstCreated }) }
  const releaseMarker = async () => {
    guard.current()
    const current = parseOwner(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')))
    if (current.ownerId !== ownerId || current.operationId !== operationId) throw stateFailure('MESH_STATE_OWNER_CHANGED', operationId)
    guard.current(); await rm(join(lock, 'owner.json')); await rmdir(lock); await syncDirectory(directory)
  }
  try {
    await atomic(join(lock, 'owner.json'), lock, owner, operationId); await syncDirectory(directory)
    let prior: State
    try { prior = await readState(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (firstCreated === undefined || (await readdir(directory)).some(name => !['owner.lock', 'owner.guard'].includes(name))) throw stateFailure('MESH_STATE_UNCONFIRMED', operationId)
      prior = { schema: 'agentmux.relay-mesh-state.v1', identity: createRelayMeshIdentity(), epoch: 0, operationId }
    }
    const epoch = prior.epoch + 1; meshInteger(epoch)
    owner.proposedEpoch = epoch
    owner.baseEpoch = prior.epoch; owner.baseOperationId = prior.operationId; owner.peerId = prior.identity.peerId; owner.publicKey = prior.identity.publicKey
    await atomic(join(lock, 'owner.json'), lock, owner, operationId)
    const next: State = { ...prior, epoch, operationId }
    epochWriteStarted = true
    await atomic(join(directory, 'identity.json'), directory, next, operationId)
    await syncCreatedParents(directory, firstCreated)
    guard.current(); acknowledged = true
    return { identity: { ...next.identity, epoch }, operationId, ownerLost: guard.lost,
      async release() {
        try { if (!acknowledged) throw stateFailure('MESH_STATE_DURABILITY_UNKNOWN', operationId); await releaseMarker(); acknowledged = false }
        finally { await guard.release() }
      } }
  } catch (error) {
    if (!epochWriteStarted) { try { await releaseMarker() } catch { /* Retain any unconfirmed original marker. */ } }
    await guard.release()
    if ((error as { code?: string }).code === 'MESH_STATE_OWNER_LOST') throw error
    throw stateFailure(epochWriteStarted ? 'MESH_STATE_DURABILITY_UNKNOWN' : 'MESH_STATE_UNCONFIRMED', operationId)
  }
}
