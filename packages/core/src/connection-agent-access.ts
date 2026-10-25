import { AgentMuxError } from './errors.js'
import type { ConnectionPort, ConnectionMethod, ConnectionParamsMap } from './connections-contract.js'
import type { ConnectionDelivery, ConnectionDeliveryParamsMap, ConnectionDeliveryResultMap } from './connection-delivery-contract.js'
import type { RoomBinding } from './room-binding-contract.js'

type DeliveryReadMethod = 'connection.delivery.ls' | 'connection.delivery.inspect'
/** Read the original receipt under its immutable audience, independently of bot administration. */
export async function readAgentConnectionDelivery<M extends DeliveryReadMethod>(owner: ConnectionPort, method: M,
  input: ConnectionDeliveryParamsMap[M], session: { hostId: string; agentSessionId: string }): Promise<ConnectionDeliveryResultMap[M]> {
  const deny = (): never => { throw new AgentMuxError('Delivery reads require this authenticated Host and Session on the exact original binding and audience.', 'CONTROL_PERMISSION_DENIED') }
  if (!owner.delivery || !owner.bindings) throw new AgentMuxError('Original delivery or binding inspection is unavailable. Existing Agent capabilities remain available.', 'CONTROL_UNAVAILABLE')
  const binding = async (bindingId: string, revision: number, connectionId: string): Promise<RoomBinding> => {
    const original = (await owner.bindings!.inspect({ bindingId, revision })).binding
    if (!original || original.bindingId !== bindingId || original.revision !== revision || original.connectionId !== connectionId ||
      original.executionHostId !== session.hostId || original.agentSessionId !== session.agentSessionId) deny()
    return original!
  }
  const receipt = (delivery: ConnectionDelivery, original: RoomBinding) => {
    // Native/captured source namespaces can differ from the authenticated execution route.
    // An absent historical source witness does not revoke an original receipt's read authority.
    const sourceHostId = delivery.reference.source.kind === 'native' || delivery.reference.source.kind === 'captured'
      ? original.sourceFrontier?.sourceHostId : original.executionHostId
    if (sourceHostId !== undefined && delivery.reference.hostId !== sourceHostId || delivery.reference.agentSessionId !== session.agentSessionId ||
      delivery.bindingId !== original.bindingId || delivery.bindingRevision !== original.revision ||
      delivery.target.connectionId !== original.connectionId || delivery.target.application.domain !== original.application.domain ||
      delivery.target.application.appId !== original.application.appId || delivery.target.externalConversationId !== original.externalConversationId) deny()
  }
  if (method === 'connection.delivery.inspect') {
    const result = await owner.delivery.inspect(input as ConnectionDeliveryParamsMap['connection.delivery.inspect'])
    if (result.delivery) receipt(result.delivery, await binding(result.delivery.bindingId, result.delivery.bindingRevision, result.delivery.target.connectionId))
    return result as ConnectionDeliveryResultMap[M]
  }
  const request = input as ConnectionDeliveryParamsMap['connection.delivery.ls']
  const original = await binding(request.bindingId, request.bindingRevision, request.connectionId)
  const result = await owner.delivery.list(request)
  for (const delivery of result.deliveries) receipt(delivery, original)
  return result as ConnectionDeliveryResultMap[M]
}

const denied = (): never => { throw new AgentMuxError('Managed Agents can create and continue their own bot setup, then operate only that enrolled Connection and their own Session binding. Use the original human or device for existing bot operations and global administration.', 'CONTROL_PERMISSION_DENIED') }
/** Authorization reads only original business owners. No cached grant, actor substitution or display inference. */
export async function assertAgentConnectionAccess(owner: ConnectionPort, method: ConnectionMethod,
  input: ConnectionParamsMap[ConnectionMethod], agentSessionId: string): Promise<void> {
  const p = input as unknown as Record<string, unknown>
  const connection = async (id: unknown) => {
    if (typeof id !== 'string' || !await owner.ownsEnrollmentConnection?.(id, agentSessionId)) denied()
  }
  const self = (value: { agentSessionId: string; authorizedBy?: { kind: string; id: string } }) => {
    if (value.agentSessionId !== agentSessionId || value.authorizedBy &&
      (value.authorizedBy.kind !== 'agent' || value.authorizedBy.id !== agentSessionId)) denied()
  }
  if (method.startsWith('connection.enrollment.')) return // Original enrollment owner checks exact actor, including private inspection.
  if (method === 'connection.setup.inspect' || method === 'connection.setup.advance') return // Original setup owner checks exact actor.
  if (method === 'connection.ls') return // Service filters original discovery records by ownership.
  if (method === 'connection.inspect') {
    const original = await owner.inspect(input as ConnectionParamsMap['connection.inspect'])
    if (original.connection) await connection(original.connection.config.connectionId)
    if (original.operation) await connection(original.operation.connection.config.connectionId)
    return
  }
  if (['connection.setup.begin', 'connection.setup.ls', 'connection.test', 'connection.profile.get', 'connection.profile.ls',
    'connection.metadata.get', 'connection.metadata.ls', 'connection.metadata.refresh', 'connection.metadata.clear',
    'connection.room.ls', 'connection.room.search', 'connection.room.get', 'connection.room.members', 'connection.room.link.create'].includes(method)) {
    await connection(p.connectionId); return
  }
  if (method === 'connection.profile.inspect') {
    const original = await owner.profile?.inspect({ operationId: p.operationId as string }, { actor: { kind: 'agent', id: agentSessionId } })
    if (original?.operation) await connection(original.operation.connectionId)
    return
  }
  if (method === 'connection.room.create' || method === 'connection.bind' || method === 'connection.binding.relink') {
    self(p as unknown as { agentSessionId: string }); await connection(p.connectionId)
    if (method !== 'connection.room.create') {
      const existing = await owner.bindings?.inspect({ bindingId: p.bindingId as string })
      if (existing?.current) self(existing.current)
    }
    return
  }
  if (method === 'connection.room.inspect') {
    const original = await owner.rooms?.inspect?.({ operationId: p.operationId as string })
    if (original?.operation) { self({ ...original.operation.input, authorizedBy: original.operation.authorizedBy }); await connection(original.operation.input.connectionId) }
    return
  }
  if (method === 'connection.room.link.inspect') {
    const original = await owner.rooms?.inspectLink?.({ operationId: p.operationId as string })
    if (original?.operation) {
      if (original.operation.authorizedBy.kind !== 'agent' || original.operation.authorizedBy.id !== agentSessionId) denied()
      await connection(original.operation.input.connectionId)
    }
    return
  }
  if (method === 'connection.binding.ls') {
    if (p.agentSessionId !== agentSessionId) denied()
    if (p.connectionId !== undefined) await connection(p.connectionId)
    return
  }
  if (method === 'connection.binding.inspect' || method === 'connection.binding.pause' || method === 'connection.binding.resume' || method === 'connection.binding.detach') {
    const original = await owner.bindings?.inspect(method !== 'connection.binding.inspect'
      ? { bindingId: p.bindingId as string } : input as ConnectionParamsMap['connection.binding.inspect'])
    const binding = original?.binding ?? original?.current
    if (binding) { self(binding); await connection(binding.connectionId) }
    return
  }
  denied()
}
