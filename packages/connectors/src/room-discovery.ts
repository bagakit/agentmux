import { AgentMuxError } from '@agentmux/core'
import { parseRoomDiscoveryParams, parseRoomDiscoveryResult, parseRoomLinkOperation, parseRoomBindingAuthority, type RoomDiscoveryPort, type RoomDiscoveryMethod, type RoomDiscoveryParamsMap, type RoomDiscoveryResultMap, type RoomLinkOperation, type RoomDiscoveryReason } from '@agentmux/core/connections'
import type { ConnectionHost, SecretPort } from './connection-host.js'

type ReadMethod = Exclude<RoomDiscoveryMethod, 'connection.room.link.create' | 'connection.room.link.inspect'>
/** An original ConnectionHost fragment. Only the explicit link effect has a same-database journal. */
export function createRoomDiscovery(connections: Pick<ConnectionHost, 'database' | 'readConfiguration' | 'registeredAdapter'>, secrets: SecretPort): { port: RoomDiscoveryPort; close(): void } {
  const life = new AbortController(), active = new Set<string>()
  const database = connections.database
  function storage<T>(call: () => T): T {
    try { return call() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('The original room operation is unconfirmed. Inspect the same operation; existing Agents remain available.', 'ROOM_STORAGE_UNCONFIRMED')
    }
  }
  function original(operationId: string): RoomLinkOperation | null {
    return storage(() => {
      const row = database.prepare('SELECT operation_json FROM connection_room_link_operation WHERE operation_id=?').get(operationId)
      if (!row) return null
      const saved = parseRoomLinkOperation(JSON.parse(String(row.operation_json)))
      return saved.state === 'dispatching' && !active.has(operationId) ? { ...saved, state: 'unknown' } : saved
    })
  }
  function save(operation: RoomLinkOperation): void {
    storage(() => database.prepare('INSERT INTO connection_room_link_operation(operation_id,operation_json) VALUES (?,?) ON CONFLICT(operation_id) DO UPDATE SET operation_json=excluded.operation_json').run(operation.operationId, JSON.stringify(parseRoomLinkOperation(operation))))
  }
  async function read<M extends ReadMethod>(method: M, value: RoomDiscoveryParamsMap[M]): Promise<RoomDiscoveryResultMap[M]> {
    const input = parseRoomDiscoveryParams(method, value)
    let record: ReturnType<typeof connections.readConfiguration> = null
    const empty = (reason: RoomDiscoveryReason, unknown = false) => parseRoomDiscoveryResult(method, {
      connectionId: input.connectionId, connectionRevision: input.expectedConnectionRevision, application: record?.config.application ?? null,
      observation: { state: unknown ? 'unknown' : 'unavailable', reason },
      ...(method === 'connection.room.get' ? { room: null } : method === 'connection.room.members' ? { externalConversationId: (input as RoomDiscoveryParamsMap['connection.room.members']).externalConversationId, members: [], next: null } : { rooms: [], next: null })
    }, input)
    try {
      if (life.signal.aborted) return empty('connection-unavailable')
      record = connections.readConfiguration(input.connectionId)
      if (!record?.config.enabled) return empty('connection-unavailable')
      if (record.revision !== input.expectedConnectionRevision) return empty('connection-revised')
      const adapter = connections.registeredAdapter(record.config.adapterId)?.roomDiscovery
      if (!adapter) return empty('adapter-unavailable')
      const credential = await secrets.resolve(record.config.credentialRef)
      if (!credential) return empty('credential-unavailable')
      if (life.signal.aborted || connections.readConfiguration(input.connectionId)?.revision !== record.revision) return empty('connection-revised')
      const native = { ...input, config: record.config }
      const result = method === 'connection.room.ls' ? await adapter.list(native, credential, life.signal)
        : method === 'connection.room.search' ? await adapter.search(native as RoomDiscoveryParamsMap['connection.room.search'] & { config: typeof record.config }, credential, life.signal)
        : method === 'connection.room.get' ? await adapter.get(native as RoomDiscoveryParamsMap['connection.room.get'] & { config: typeof record.config }, credential, life.signal)
        : await adapter.members(native as RoomDiscoveryParamsMap['connection.room.members'] & { config: typeof record.config }, credential, life.signal)
      if (life.signal.aborted || connections.readConfiguration(input.connectionId)?.revision !== record.revision) return empty('connection-revised')
      return parseRoomDiscoveryResult(method, { ...result, connectionId: input.connectionId, connectionRevision: record.revision, application: record.config.application,
        ...(method === 'connection.room.members' ? { externalConversationId: (input as RoomDiscoveryParamsMap['connection.room.members']).externalConversationId } : {}) }, input)
    } catch { return empty('response-unconfirmed', true) }
  }
  const port: RoomDiscoveryPort = {
    list: input => read('connection.room.ls', input), search: input => read('connection.room.search', input), get: input => read('connection.room.get', input), members: input => read('connection.room.members', input),
    inspectLink: async value => {
      const input = parseRoomDiscoveryParams('connection.room.link.inspect', value)
      return { operation: original(input.operationId) }
    },
    createLink: async (value, context) => {
      const input = parseRoomDiscoveryParams('connection.room.link.create', value), authorizedBy = parseRoomBindingAuthority(context.actor)
      const existing = original(input.operationId)
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new AgentMuxError('The original link operation has another target. Inspect it without replacing its identity.', 'ROOM_OPERATION_CONFLICT')
        return existing
      }
      let application: RoomLinkOperation['application'] = null
      const refused = (reason: RoomDiscoveryReason): RoomLinkOperation => ({ operationId: input.operationId, input, application, authorizedBy, state: 'refused', reason })
      const refuse = (reason: RoomDiscoveryReason): RoomLinkOperation => {
        if (life.signal.aborted) throw new AgentMuxError('The original room owner is closed. Existing Agent input is retained.', 'CONTROL_UNAVAILABLE')
        return storage(() => {
          database.exec('BEGIN IMMEDIATE')
          try {
            const prior = original(input.operationId)
            if (prior && JSON.stringify(prior.input) !== JSON.stringify(input)) throw new AgentMuxError('The original link operation has another target.', 'ROOM_OPERATION_CONFLICT')
            const operation = prior ?? refused(reason)
            if (!prior) save(operation)
            database.exec('COMMIT'); return operation
          } catch (error) { try { database.exec('ROLLBACK') } catch { /* Read the original operation. */ } throw error }
        })
      }
      const currentAuthority = async () => {
        try { await context.assertCurrent?.(); return !life.signal.aborted && !context.signal?.aborted } catch { return false }
      }
      if (!await currentAuthority()) return refuse('authority-unavailable')
      const record = connections.readConfiguration(input.connectionId)
      application = record?.config.application ?? null
      if (!record?.config.enabled) return refuse('connection-unavailable')
      if (record.revision !== input.expectedConnectionRevision) return refuse('connection-revised')
      if (!connections.registeredAdapter(record.config.adapterId)?.roomDiscovery) return refuse('adapter-unavailable')
      let credential: string | null
      try { credential = await secrets.resolve(record.config.credentialRef) } catch { return refuse('credential-unavailable') }
      if (!credential) return refuse('credential-unavailable')
      if (!await currentAuthority()) return refuse('authority-unavailable')
      const adapter = connections.registeredAdapter(record.config.adapterId)!.roomDiscovery!
      const claim = storage(() => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const prior = original(input.operationId)
          if (prior) {
            if (JSON.stringify(prior.input) !== JSON.stringify(input)) throw new AgentMuxError('The original link operation has another target.', 'ROOM_OPERATION_CONFLICT')
            database.exec('COMMIT'); return { operation: prior, claimed: false }
          }
          const current = connections.readConfiguration(input.connectionId)
          const operation: RoomLinkOperation = current?.config.enabled && current.revision === input.expectedConnectionRevision
            ? { operationId: input.operationId, input, application, authorizedBy, state: 'dispatching' } : refused('connection-revised')
          save(operation); database.exec('COMMIT')
          return { operation, claimed: operation.state === 'dispatching' }
        } catch (error) { try { database.exec('ROLLBACK') } catch { /* Original commit remains inspectable. */ } throw error }
      })
      if (!claim.claimed) return claim.operation
      active.add(input.operationId)
      const signal = context.signal ? AbortSignal.any([context.signal, life.signal]) : life.signal
      let settled: RoomLinkOperation
      try {
        const receipt = await adapter.createLink({ config: record.config, externalConversationId: input.externalConversationId }, credential, signal)
        settled = parseRoomLinkOperation({ ...claim.operation, state: receipt.kind === 'confirmed' ? 'confirmed' : receipt.kind === 'refused' ? 'refused' : 'unknown',
          ...(receipt.kind === 'confirmed' ? { link: receipt.link } : receipt.kind === 'refused' ? { reason: receipt.reason } : {}) })
      } catch { settled = { ...claim.operation, state: 'unknown' } }
      finally { active.delete(input.operationId) }
      if (life.signal.aborted) return { ...claim.operation, state: 'unknown' }
      save(settled)
      return settled
    }
  }
  return { port, close: () => { life.abort(); active.clear() } }
}
