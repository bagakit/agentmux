import { AgentMuxError } from '@agentmux/core'
import { parseRoomBindingAuthority, parseRoomProvisioningOperation, parseRoomProvisioningParams, type ConnectionConfig, type RoomProvisioningCallContext, type RoomCreateInput, type RoomCreationState, type RoomProvisioningInspectInput, type RoomProvisioningOperation, type RoomProvisioningPort, type RoomProvisioningRefusal } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type { RoomBindingHostOptions } from './room-binding.js'
import type { RoomProvisioningAdapter } from './room-provisioning-adapter.js'
import { RoomProvisioningStore } from './room-provisioning-store.js'
import { readRoomTarget } from './room-target.js'

export type RoomProvisioningHostOptions = { connections: ConnectionHost; spatial: RoomBindingHostOptions['spatial'] }
type Prepared = { adapter: RoomProvisioningAdapter; credential: string; config: ConnectionConfig } | { refusal: RoomProvisioningRefusal }

/** One original Host owner; inspect and recovered dispatching operations never call the adapter. */
export class RoomProvisioningHost implements RoomProvisioningPort {
  private readonly store: RoomProvisioningStore
  private readonly pending = new Map<string, Promise<RoomProvisioningOperation>>()
  constructor(private readonly options: RoomProvisioningHostOptions) { this.store = new RoomProvisioningStore(options.connections) }
  async inspect(value: RoomProvisioningInspectInput): Promise<{ operation: RoomProvisioningOperation | null }> {
    const input = parseRoomProvisioningParams('connection.room.inspect', value)
    return { operation: this.store.read(input.operationId) }
  }
  async create(value: RoomCreateInput, context: RoomProvisioningCallContext): Promise<RoomProvisioningOperation> {
    const input = parseRoomProvisioningParams('connection.room.create', value), actor = parseRoomBindingAuthority(context.actor)
    try { await context.assertCurrent?.() } catch { throw new AgentMuxError('Room creation requires its original current human authority. Existing Agents remain available.', 'CONTROL_PERMISSION_DENIED') }
    const operation = this.store.admit(input, actor)
    if (operation.creation.state !== 'pending' && !(operation.creation.state === 'created' && operation.membership.state === 'pending')) return operation
    const active = this.pending.get(input.operationId)
    if (active) return await active
    const work = this.run(operation, context).finally(() => { this.pending.delete(input.operationId) })
    this.pending.set(input.operationId, work)
    return await work
  }
  private connection(operation: RoomProvisioningOperation): RoomProvisioningRefusal | null {
    const current = this.options.connections.readConfiguration(operation.input.connectionId)
    if (!current?.config.enabled) return 'connection-unavailable'
    return current.revision !== operation.input.expectedConnectionRevision || current.config.adapterId !== operation.adapterId || JSON.stringify(current.config.application) !== JSON.stringify(operation.application) ? 'connection-revised' : null
  }
  private async target(operation: RoomProvisioningOperation): Promise<RoomProvisioningRefusal | null> {
    try { return await readRoomTarget(this.options.spatial, operation.input) ? null : 'target-changed' }
    catch { return 'target-unavailable' }
  }
  private async prepare(operation: RoomProvisioningOperation, context: RoomProvisioningCallContext): Promise<Prepared> {
    let refusal = this.connection(operation) ?? await this.target(operation)
    if (refusal) return { refusal }
    const adapter = this.options.connections.roomAdapter(operation.input.connectionId)
    if (!adapter) return { refusal: 'adapter-unavailable' }
    let credential: string | null
    try { credential = await this.options.connections.resolveCredential(operation.input.connectionId) }
    catch { credential = null }
    if (!credential) return { refusal: 'credential-unavailable' }
    try { await context.assertCurrent?.() } catch { return { refusal: 'authority-unavailable' } }
    refusal = await this.target(operation) ?? this.connection(operation)
    return refusal ? { refusal } : { adapter, credential, config: this.options.connections.readConfiguration(operation.input.connectionId)!.config }
  }
  private async run(original: RoomProvisioningOperation, context: RoomProvisioningCallContext): Promise<RoomProvisioningOperation> {
    let operation = original
    if (operation.creation.state === 'pending') {
      const prepared = await this.prepare(operation, context)
      if ('refusal' in prepared) return this.store.refusePending(operation.operationId, 'creation', prepared.refusal)
      const claimed = this.store.claim(operation.operationId, 'creation', () => this.connection(operation))
      operation = claimed.operation
      if (!claimed.claimed || operation.creation.state !== 'dispatching') return operation
      const attemptId = operation.creation.attemptId
      let receipt: RoomCreationState = { state: 'unknown', attemptId }
      try {
        const effect = await prepared.adapter.create({ operationId: operation.operationId, attemptId, config: structuredClone(prepared.config), name: operation.input.name }, prepared.credential, context.signal)
        if (effect.kind === 'created') receipt = { state: 'created', attemptId, externalConversationId: effect.externalConversationId }
        else if (effect.kind === 'not-applied') receipt = { state: 'not-applied', attemptId, reason: 'platform-not-applied' }
        const membership = receipt.state === 'not-applied' && operation.membership.state === 'pending' ? { state: 'not-applied', reason: receipt.reason } : operation.membership
        receipt = parseRoomProvisioningOperation({ ...operation, creation: receipt, membership }).creation
      } catch { receipt = { state: 'unknown', attemptId } } // No raw adapter error or credential enters a receipt.
      operation = this.store.settle(operation.operationId, 'creation', receipt as Exclude<RoomCreationState, { state: 'pending' }>)
    }
    if (operation.creation.state !== 'created' || operation.membership.state !== 'pending') return operation
    const prepared = await this.prepare(operation, context)
    if ('refusal' in prepared) return this.store.refusePending(operation.operationId, 'membership', prepared.refusal)
    const claimed = this.store.claim(operation.operationId, 'membership', () => this.connection(operation))
    operation = claimed.operation
    if (!claimed.claimed || operation.creation.state !== 'created' || operation.membership.state !== 'dispatching') return operation
    const attemptId = operation.membership.attemptId
    const results = operation.input.members.map(member => ({ member: { ...member }, state: 'unknown' as const }))
    try {
      const effect = await prepared.adapter.addMembers({ operationId: operation.operationId, attemptId, config: structuredClone(prepared.config), externalConversationId: operation.creation.externalConversationId, members: operation.input.members.map(member => ({ ...member })) }, prepared.credential, context.signal)
      const validated = parseRoomProvisioningOperation({ ...operation, membership: { state: 'settled', attemptId, results: effect.results } }).membership
      if (validated.state === 'settled') return this.store.settle(operation.operationId, 'membership', validated)
    } catch { /* Preserve uncertainty for the original exact members; no implicit member retry. */ }
    return this.store.settle(operation.operationId, 'membership', { state: 'settled', attemptId, results })
  }
}
