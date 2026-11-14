import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createRelayMeshIdentity, parseRelayMeshConfiguration, type RelayMeshIdentity } from '@agentmux/relay/gateway'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { defaultMeshNetworkConfiguration, parseMeshNetworkConfiguration, meshConfigurationNotApplied, type MeshNetworkConfiguration, type MeshNetworkParams,
  type MeshNetworkSettings, type MeshOwner, type MeshPublicIdentity, type MeshSaveOperation } from './mesh-network.js'

type State = { schema: 'agentmux.mesh-network.v1'; runtimeId: string; revision: string; configuration: MeshNetworkConfiguration; operationId: string | null }
type Operation = { runtimeId: string; input: MeshNetworkParams['settings.mesh.configure']; result: MeshSaveOperation }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (message: string, code: string): never => { throw new AgentMuxError(message, code) }

/** Durable settings/key owner only. The existing CoreRelayGateway owns the live network. */
export class MeshNetworkState {
  private readonly file: string
  private readonly identityFile: string
  private readonly identityAnchor: string
  private tail: Promise<unknown> = Promise.resolve()
  private stateObserved = false
  private key: RelayMeshIdentity | undefined
  private identityLoad: Promise<void> | undefined
  private epochReservation: Promise<RelayMeshIdentity> | undefined
  private originalIdentity: Pick<RelayMeshIdentity, 'peerId' | 'publicKey'> | undefined
  private identityAttempted = false
  private readonly mutations = new Set<Promise<void>>()
  private epochIntent: { next: RelayMeshIdentity; reservationId: string } | undefined
  constructor(readonly options: { directory: string; owner: MeshOwner; signal?: AbortSignal; write?: typeof durableWriteFile;
    validate(configuration: MeshNetworkConfiguration): void | Promise<void>
    adopt(state: { revision: string; configuration: MeshNetworkConfiguration }): void
  }) { this.file = join(options.directory, 'mesh-network.json'); this.identityFile = join(options.directory, 'mesh-network-peer.json'); this.identityAnchor = join(options.directory, 'mesh-network-identity.json') }
  publicIdentity(): MeshPublicIdentity | null { return this.key ? { peerId: this.key.peerId, publicKey: this.key.publicKey, epoch: this.key.epoch } : null }
  private write(path: string, value: unknown): Promise<void> {
    this.options.signal?.throwIfAborted()
    const work = (this.options.write ?? durableWriteFile)(path, JSON.stringify(value) + '\n', { requireDirectorySync: true, ...(this.options.signal ? { signal: this.options.signal } : {}) })
    this.mutations.add(work)
    void work.then(() => this.mutations.delete(work), () => this.mutations.delete(work))
    return work
  }
  /** Keep the semantic writer lease until dispatched rename/fsync work settles.
   * Lazy reads and unacquired Host resources are not mutations and are not joined. */
  async drainMutations(): Promise<void> { await Promise.allSettled([...this.mutations]) }
  /** Called by Core startup, never by passive mesh.inspect. Corrupt original keys are retained. */
  initializeIdentity(): Promise<void> { return this.identityLoad ??= (async () => {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    this.options.signal?.throwIfAborted()
    let stored: Record<string, unknown>
    const createIfMissing = !this.identityAttempted; this.identityAttempted = true
    let anchor: { peerId: string; publicKey: string } | undefined
    try {
      const value = rpcRecord(JSON.parse(await readFile(this.identityAnchor, 'utf8')), ['schema', 'peerId', 'publicKey'])
      if (value.schema !== 'agentmux.mesh-identity.v1') throw new Error('Wrong original Mesh identity anchor')
      anchor = { peerId: rpcString(value.peerId, 'Original Mesh peer'), publicKey: rpcString(value.publicKey, 'Original Mesh public key') }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure('The original Mesh public identity record is unavailable. Preserve its original files.', 'MESH_IDENTITY_UNCONFIRMED') }
    try { stored = rpcRecord(JSON.parse(await readFile(this.identityFile, { encoding: 'utf8', ...(this.options.signal ? { signal: this.options.signal } : {}) })), ['schema', 'peerId', 'publicKey', 'secretKey', 'epoch', 'reservationId']) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createIfMissing || anchor) failure('The original Mesh identity is unreadable. Preserve its key file; other Core services remain available.', 'MESH_IDENTITY_UNCONFIRMED')
      const previous = await readFile(this.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      const operations = await readdir(join(this.options.directory, 'mesh-network-operations')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      if (previous || operations.length) failure('The original configured Mesh key is missing. Preserve its settings and operations; no replacement identity was created.', 'MESH_IDENTITY_UNCONFIRMED')
      this.options.signal?.throwIfAborted()
      this.identityAttempted = true
      stored = { schema: 'agentmux.mesh-peer.v1', ...createRelayMeshIdentity(), epoch: 0, reservationId: null }
      this.originalIdentity = { peerId: stored.peerId as string, publicKey: stored.publicKey as string }
      await this.write(this.identityFile, stored)
    }
    if (stored.schema !== 'agentmux.mesh-peer.v1' || !Number.isSafeInteger(stored.epoch) || Number(stored.epoch) < 0 || stored.reservationId !== null && typeof stored.reservationId !== 'string') failure('The original Mesh identity is unconfirmed. Preserve its original bytes.', 'MESH_IDENTITY_UNCONFIRMED')
    const checked = parseRelayMeshConfiguration({ networkId: 'identity-validation', identity: { peerId: stored.peerId, publicKey: stored.publicKey, secretKey: stored.secretKey, epoch: Math.max(1, Number(stored.epoch)) }, members: [{ peerId: stored.peerId, publicKey: stored.publicKey }], peers: [] })
    if (anchor && (anchor.peerId !== checked.identity.peerId || anchor.publicKey !== checked.identity.publicKey)) failure('The private Mesh key differs from its retained original public identity.', 'MESH_IDENTITY_UNCONFIRMED')
    if (this.originalIdentity && (this.originalIdentity.peerId !== checked.identity.peerId || this.originalIdentity.publicKey !== checked.identity.publicKey)) failure('The original Mesh identity changed. Preserve its original key.', 'MESH_IDENTITY_UNCONFIRMED')
    if (!anchor) await this.write(this.identityAnchor, { schema: 'agentmux.mesh-identity.v1', peerId: checked.identity.peerId, publicKey: checked.identity.publicKey })
    this.identityAttempted = true; this.originalIdentity = { peerId: checked.identity.peerId, publicKey: checked.identity.publicKey }
    this.key = { ...checked.identity, epoch: Number(stored.epoch) }
  })().catch(() => { this.identityLoad = undefined; return failure('The original Mesh key or durability is unconfirmed. Preserve its file and inspect storage; Unix Core and Sessions remain available.', 'MESH_IDENTITY_UNCONFIRMED') }) }
  /** One immutable reservation per owner lifetime. Explicit adoption may reconfirm
   * its same bytes after an unknown ACK; it never allocates a replacement epoch. */
  reserveEpoch(): Promise<RelayMeshIdentity> { return this.epochReservation ??= (async () => {
    await this.initializeIdentity()
    this.epochIntent ??= { next: { ...this.key!, epoch: this.key!.epoch + 1 }, reservationId: mintObjectId() }
    const { next, reservationId } = this.epochIntent
    if (!Number.isSafeInteger(next.epoch)) failure('The original Mesh epoch cannot be reserved.', 'MESH_EPOCH_UNCONFIRMED')
    try {
      const disk = rpcRecord(JSON.parse(await readFile(this.identityFile, 'utf8')), ['schema', 'peerId', 'publicKey', 'secretKey', 'epoch', 'reservationId'])
      if (disk.schema !== 'agentmux.mesh-peer.v1' || disk.peerId !== next.peerId || disk.publicKey !== next.publicKey || disk.secretKey !== next.secretKey ||
          disk.epoch !== this.key!.epoch && !(disk.epoch === next.epoch && disk.reservationId === reservationId)) failure('The original Mesh epoch source changed. Preserve its file before recovery.', 'MESH_EPOCH_UNCONFIRMED')
      await this.write(this.identityFile, { schema: 'agentmux.mesh-peer.v1', ...next, reservationId })
    }
    catch { this.epochReservation = undefined; return failure('The original Mesh boot epoch has an unknown disk acknowledgement. It was not published; preserve the key and reservation.', 'MESH_EPOCH_UNCONFIRMED') }
    this.key = next
    return structuredClone(next)
  })().catch(error => { this.epochReservation = undefined; throw error }) }
  async desired(): Promise<{ revision: string; configuration: MeshNetworkConfiguration; confirmed: boolean } | null> { const state = await this.state(); if (state.operationId === null) return null; const operation = await this.operation(state.operationId); return { revision: state.revision, configuration: state.configuration, confirmed: operation?.result.status === 'confirmed' } }
  private async state(): Promise<State> {
    try {
      const p = rpcRecord(JSON.parse(await readFile(this.file, 'utf8')), ['schema', 'runtimeId', 'revision', 'configuration', 'operationId'])
      if (p.schema !== 'agentmux.mesh-network.v1' || p.runtimeId !== this.options.owner.runtimeId) throw new Error('Wrong Mesh settings owner')
      this.stateObserved = true
      return { schema: p.schema, runtimeId: p.runtimeId, revision: rpcString(p.revision, 'Original Mesh revision'), configuration: parseMeshNetworkConfiguration(p.configuration), operationId: p.operationId === null ? null : rpcString(p.operationId, 'Original Mesh save') }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.stateObserved && !(await readdir(join(this.options.directory, 'mesh-network-operations')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).length) return { schema: 'agentmux.mesh-network.v1', runtimeId: this.options.owner.runtimeId, revision: digest(['mesh-network', this.options.owner.runtimeId]), configuration: defaultMeshNetworkConfiguration(), operationId: null }
      return failure('The original Mesh settings are unavailable. Preserve their file and original operations; healthy Core services remain available.', 'MESH_SETTINGS_UNAVAILABLE')
    }
  }
  private operationPath(id: string) { return join(this.options.directory, 'mesh-network-operations', digest(id) + '.json') }
  private async operation(id: string): Promise<Operation | null> {
    try {
      const value = JSON.parse(await readFile(this.operationPath(id), 'utf8')) as Operation
      if (value.runtimeId !== this.options.owner.runtimeId || value.input.operationId !== id || value.result.operationId !== id || value.result.status !== 'unknown' && value.result.status !== 'confirmed') throw new Error('Wrong Mesh operation')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return failure('This original Mesh save record is unavailable. Preserve its operation ID; it was not replayed.', 'MESH_OPERATION_UNAVAILABLE') }
  }
  private settings(state: State, operation: MeshSaveOperation | null): MeshNetworkSettings { return { owner: this.options.owner, identity: this.publicIdentity(), revision: state.revision, configuration: structuredClone(state.configuration), operation } }
  private async inspectOriginal(operationId?: string, current: () => Promise<void> = async () => {}): Promise<MeshNetworkSettings> {
    const state = await this.state(), id = operationId ?? state.operationId, original = id ? await this.operation(id) : null
    if (id && state.operationId === id && !original) failure('The saved Mesh configuration names an unavailable original operation. Restore that record; do not replay the save.', 'MESH_OPERATION_UNAVAILABLE')
    if (original?.result.status === 'unknown' && state.operationId === id && state.revision === original.result.revision && isDeepStrictEqual(state.configuration, original.input.configuration)) {
      try {
        // Reconfirm only the exact already replaced bytes, never reapply an old configuration.
        await current(); await this.write(this.file, state)
        const result = { ...original.result, status: 'confirmed' as const, updatedAt: Date.now() }; delete result.cause
        await this.write(this.operationPath(id!), { ...original, result }); original.result = result
        this.options.adopt({ revision: state.revision, configuration: state.configuration })
      } catch { /* Original unknown durability remains visible; no new save or network action. */ }
    }
    return this.settings(state, original?.result ?? null)
  }
  inspect(operationId?: string, current: () => Promise<void> = async () => {}): Promise<MeshNetworkSettings> {
    // Reconfirmation writes belong to the same serial owner as every CAS save.
    const work = this.tail.then(async () => { await current(); return await this.inspectOriginal(operationId, current) })
    this.tail = work.then(() => {}, () => {})
    return work
  }
  configure(input: MeshNetworkParams['settings.mesh.configure'], current: () => Promise<void>): Promise<{ settings: MeshNetworkSettings; diskDurability: 'confirmed' | 'unknown' }> {
    let configurationDispatched = false
    const work = this.tail.then(async () => {
      await current()
      const state = await this.state(), previous = await this.operation(input.operationId)
      if (previous) {
        if (!isDeepStrictEqual(previous.input, input)) failure('This Mesh operation ID belongs to another original configuration.', 'MESH_OPERATION_MISMATCH')
        const settings = await this.inspectOriginal(input.operationId, current)
        return { settings, diskDurability: settings.operation!.status }
      }
      if (state.revision !== input.expectedRevision) failure('Mesh settings changed. Preserve your edits and read this original Core again.', 'MESH_REVISION_CHANGED')
      const configuration = parseMeshNetworkConfiguration(input.configuration)
      await this.options.validate(configuration); await current()
      const revision = mintObjectId(), operation: Operation = { runtimeId: this.options.owner.runtimeId, input: structuredClone(input), result: { operationId: input.operationId, expectedRevision: input.expectedRevision, revision, status: 'unknown', updatedAt: Date.now() } }
      const next: State = { ...state, revision, configuration, operationId: input.operationId }
      await mkdir(join(this.options.directory, 'mesh-network-operations'), { recursive: true, mode: 0o700 })
      await current(); configurationDispatched = true
      await this.write(this.operationPath(input.operationId), operation)
      try {
        await this.write(this.file, next)
        operation.result = { ...operation.result, status: 'confirmed', updatedAt: Date.now() }
        await this.write(this.operationPath(input.operationId), operation)
        this.options.adopt({ revision, configuration })
      } catch { operation.result = { ...operation.result, status: 'unknown', cause: { code: 'MESH_SAVE_UNCONFIRMED', message: 'This original save has an unknown durability acknowledgement. Inspect its operation ID; do not replay it.' } } }
      return { settings: this.settings(await this.state(), operation.result), diskDurability: operation.result.status }
    }).catch(error => { if (!configurationDispatched) throw meshConfigurationNotApplied(error); throw error })
    this.tail = work.then(() => {}, () => {})
    return work
  }
}
