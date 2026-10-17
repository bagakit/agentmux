import { AgentMuxError } from './errors.js'
import type { ConnectionPort, ConnectionMethod, ConnectionParamsMap } from './connections-contract.js'

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
  if (method === 'connection.binding.inspect' || method === 'connection.binding.pause') {
    const original = await owner.bindings?.inspect(method === 'connection.binding.pause'
      ? { bindingId: p.bindingId as string } : input as ConnectionParamsMap['connection.binding.inspect'])
    const binding = original?.binding ?? original?.current
    if (binding) { self(binding); await connection(binding.connectionId) }
    return
  }
  denied()
}
