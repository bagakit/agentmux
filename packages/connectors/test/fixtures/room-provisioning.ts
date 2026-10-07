import { vi } from 'vitest'
import type { RoomCreateInput } from '@agentmux/core/connections'
import type { RoomProvisioningAdapter } from '../../src/room-provisioning-adapter.js'
import { RoomProvisioningHost } from '../../src/room-provisioning.js'
import { config, context, roomBindingFixture, core } from './room-binding.js'

export async function roomProvisioningFixture(options: { create?: RoomProvisioningAdapter['create']; addMembers?: RoomProvisioningAdapter['addMembers']; resolve?: (reference: string) => Promise<string | null>; managedCaller?: boolean } = {}) {
  const create = vi.fn<RoomProvisioningAdapter['create']>(options.create ?? (async () => ({ kind: 'created', externalConversationId: 'created-room' })))
  const addMembers = vi.fn<RoomProvisioningAdapter['addMembers']>(options.addMembers ?? (async input => ({ results: input.members.map(member => ({ member, state: 'joined' })) })))
  const rooms = { create, addMembers }, adapter = { adapterId: 'sample', rooms, test: async () => ({ authentication: { state: 'unknown' as const, reason: 'not-tested' as const }, transport: { state: 'unknown' as const, reason: 'not-tested' as const }, intake: { state: 'unknown' as const, reason: 'not-started' as const }, delivery: { state: 'unknown' as const, reason: 'not-started' as const } }) }
  const resolve = vi.fn(options.resolve ?? (async () => 'private-fixture-credential'))
  const original = await roomBindingFixture(true, { adapters: [adapter], secrets: { resolve }, ...(options.managedCaller ? { managedCaller: true } : {}) })
  const provisioning = new RoomProvisioningHost({ connections: original.connections, spatial: original.spatial })
  original.connections.rooms = provisioning
  const createInput: RoomCreateInput = { operationId: 'create-original', connectionId: config.connectionId, expectedConnectionRevision: 1,
    executionHostId: original.input.executionHostId, agentSessionId: original.input.agentSessionId, regionAnchor: original.input.regionAnchor,
    name: 'Original Agent room', members: [{ idType: 'account_id', userId: 'member/甲' }, { idType: 'account_id', userId: 'member/乙' }] }
  return { ...original, createInput, provisioning, adapter, create, addMembers, resolve }
}
export { config, context, core }
