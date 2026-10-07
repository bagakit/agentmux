import { AgentMuxError } from '@agentmux/core'
import { parseConversationCheckpointPage, type ConversationCheckpoint, type ConversationCheckpointPage, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import { parseConnectionActor, parseConnectionGrant, parseRoomBinding, parseRoomBindingAuthority, parseRoomBindingOperation, parseRoomBindingParams, type ConnectionGrant, type RoomBinding, type RoomBindingAuthority, type RoomBindingBindInput, type RoomBindingCallContext, type RoomBindingGrantInput, type RoomBindingInspectInput, type RoomBindingListInput, type RoomBindingOperation, type RoomBindingPauseInput, type RoomBindingReadPort, type RoomBindingRelinkInput, type RoomBindingsPort, type RoomPublicationAuthority } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { readRoomTarget } from './room-target.js'

export type RoomBindingHostOptions = {
  connections: ConnectionHost
  spatial: { read(): Promise<AgentMuxSpatialState | null> }
  /** Borrow the original Core client for the exact Host, never a new Runtime or focused occupant. */
  checkpoint(reference: ConversationRef): Promise<ConversationCheckpointPage>
}
type Action = RoomBindingOperation['action']
type Input = RoomBindingBindInput | RoomBindingRelinkInput | RoomBindingPauseInput | RoomBindingGrantInput
type Saved = { intent: string; operation: RoomBindingOperation }
class Refusal extends Error { constructor(readonly code: string) { super(code) } }
function refuse(code: string): never { throw new Refusal(code) }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const method = { bind: 'connection.bind', relink: 'connection.binding.relink', pause: 'connection.binding.pause', grant: 'connection.grant' } as const

/** Binding, grant and operation snapshots belong to the original connector database. No topology is copied. */
export class RoomBindingHost implements RoomBindingsPort, RoomBindingReadPort {
  private readonly database
  private readonly pending = new Map<string, Promise<RoomBindingOperation>>()
  constructor(private readonly options: RoomBindingHostOptions) {
    this.database = options.connections.database
    this.safe(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS room_binding_revision (binding_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(binding_id, revision));
      CREATE TABLE IF NOT EXISTS room_binding_head (binding_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, connection_id TEXT NOT NULL, domain TEXT NOT NULL, app_id TEXT NOT NULL, room_id TEXT NOT NULL, host_id TEXT NOT NULL, session_id TEXT NOT NULL, UNIQUE(domain, app_id, room_id), UNIQUE(connection_id, host_id, session_id));
      CREATE TABLE IF NOT EXISTS room_binding_operation (operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_grant_revision (grant_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(grant_id, revision));
      CREATE TABLE IF NOT EXISTS room_grant_head (grant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, binding_id TEXT NOT NULL, connection_id TEXT NOT NULL, room_id TEXT NOT NULL, actor_json TEXT NOT NULL, UNIQUE(connection_id, room_id, actor_json));
    `))
  }
  private safe<T>(read: () => T): T {
    try { return read() } catch (error) {
      if (error instanceof Refusal || error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Binding storage cannot confirm the original operation. Inspect the same operation before retrying. Existing Agents are retained.', 'ROOM_BINDING_STORAGE_UNCONFIRMED')
    }
  }
  private transaction<T>(run: () => T): T {
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try { const value = run(); this.database.exec('COMMIT'); return value }
      catch (error) { try { this.database.exec('ROLLBACK') } catch { /* An uncertain commit is reconciled by the original operation. */ } throw error }
    })
  }
  readExact(bindingId: string, revision: number): RoomBinding | null {
    return this.safe(() => { const row = this.database.prepare('SELECT snapshot_json FROM room_binding_revision WHERE binding_id=? AND revision=?').get(bindingId, revision); return row ? parseRoomBinding(JSON.parse(String(row.snapshot_json))) : null })
  }
  readCurrent(bindingId: string): RoomBinding | null {
    return this.safe(() => { const row = this.database.prepare('SELECT revision FROM room_binding_head WHERE binding_id=?').get(bindingId); return row ? this.readExact(bindingId, Number(row.revision)) : null })
  }
  private matching(column: 'audience' | 'session', input: RoomBindingBindInput): RoomBinding | null {
    const connection = this.options.connections.readConfiguration(input.connectionId)
    if (!connection) return null
    const row = column === 'audience'
      ? this.database.prepare('SELECT binding_id FROM room_binding_head WHERE domain=? AND app_id=? AND room_id=?').get(connection.config.application.domain, connection.config.application.appId, input.externalConversationId)
      : this.database.prepare('SELECT binding_id FROM room_binding_head WHERE connection_id=? AND host_id=? AND session_id=?').get(input.connectionId, input.executionHostId, input.agentSessionId)
    return row ? this.readCurrent(String(row.binding_id)) : null
  }
  private heads(input: RoomBindingListInput, activeOnly: boolean): RoomBinding[] {
    const p = parseRoomBindingParams('connection.binding.ls', input), columns = { connectionId: 'connection_id', executionHostId: 'host_id', agentSessionId: 'session_id' } as const
    const entries = Object.entries(p) as [keyof typeof columns, string][]
    return this.safe(() => this.database.prepare('SELECT binding_id FROM room_binding_head' + (entries.length ? ' WHERE ' + entries.map(([key]) => columns[key] + '=?').join(' AND ') : '') + ' ORDER BY binding_id').all(...entries.map(([, value]) => value)).map(row => this.readCurrent(String(row.binding_id))!).filter(b => !activeOnly || b.state === 'active'))
  }
  listActive(input: RoomBindingListInput = {}): RoomBinding[] { return this.heads(input, true) }
  async list(input: RoomBindingListInput): Promise<{ bindings: RoomBinding[] }> { return { bindings: this.heads(input, false) } }
  publicationAuthority(bindingId: string, revision: number): RoomPublicationAuthority {
    const binding = this.readExact(bindingId, revision), current = this.readCurrent(bindingId)
    const result = (reason: NonNullable<RoomPublicationAuthority['reason']>): RoomPublicationAuthority => ({ binding, authorized: false, reason })
    if (!binding || !current) return result('missing')
    if (current.revision !== revision) return result('binding-revised')
    if (binding.state !== 'active') return result('paused')
    const connection = this.options.connections.readConfiguration(binding.connectionId)
    if (!connection?.config.enabled || !equal(connection.config.application, binding.application)) return result('connection-disabled')
    if (binding.scope.publication !== 'future-native-user-facing' || !['user', 'device'].includes(binding.authorizedBy.kind)) return result('publication-not-granted')
    return { binding, authorized: true }
  }
  readGrant(grantId: string, revision?: number): ConnectionGrant | null {
    return this.safe(() => {
      const row = revision === undefined
        ? this.database.prepare('SELECT snapshot_json FROM room_grant_revision WHERE grant_id=? ORDER BY revision DESC LIMIT 1').get(grantId)
        : this.database.prepare('SELECT snapshot_json FROM room_grant_revision WHERE grant_id=? AND revision=?').get(grantId, revision)
      return row ? parseConnectionGrant(JSON.parse(String(row.snapshot_json))) : null
    })
  }
  findGrant(input: { connectionId: string; externalConversationId: string; actor: ConnectionGrant['actor'] }): ConnectionGrant | null {
    return this.safe(() => { const row = this.database.prepare("SELECT h.grant_id FROM room_grant_head h JOIN room_binding_head b ON b.binding_id=h.binding_id JOIN room_grant_revision r ON r.grant_id=h.grant_id AND r.revision=h.revision WHERE h.connection_id=? AND h.room_id=? AND h.actor_json=? AND b.connection_id=h.connection_id AND b.room_id=h.room_id AND b.revision=json_extract(r.snapshot_json,'$.bindingRevision')").get(input.connectionId, input.externalConversationId, JSON.stringify(parseConnectionActor(input.actor))); return row ? this.readGrant(String(row.grant_id)) : null })
  }
  private grants(binding: RoomBinding | null): ConnectionGrant[] {
    if (!binding) return []
    return this.safe(() => this.database.prepare('SELECT grant_id FROM room_grant_head WHERE binding_id=?').all(binding.bindingId).map(row => this.readGrant(String(row.grant_id))!).filter(grant => grant.bindingRevision === binding.revision))
  }
  private saved(operationId: string): Saved | null {
    const row = this.database.prepare('SELECT intent_json, result_json FROM room_binding_operation WHERE operation_id=?').get(operationId)
    return row ? { intent: String(row.intent_json), operation: parseRoomBindingOperation(JSON.parse(String(row.result_json))) } : null
  }
  async inspect(value: RoomBindingInspectInput) {
    const input = parseRoomBindingParams('connection.binding.inspect', value)
    return this.safe(() => {
      const operation = input.operationId ? this.saved(input.operationId)?.operation ?? null : null
      const binding = input.bindingId ? input.revision === undefined ? this.readCurrent(input.bindingId) : this.readExact(input.bindingId, input.revision) : operation?.state === 'applied' ? operation.binding : null
      return { binding, current: binding ? this.readCurrent(binding.bindingId) : null, operation, grants: this.grants(binding) }
    })
  }
  private writeBinding(binding: RoomBinding): void {
    const b = parseRoomBinding(binding)
    this.database.prepare('INSERT INTO room_binding_revision (binding_id,revision,snapshot_json) VALUES (?,?,?)').run(b.bindingId, b.revision, JSON.stringify(b))
    this.database.prepare('INSERT INTO room_binding_head (binding_id,revision,connection_id,domain,app_id,room_id,host_id,session_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET revision=excluded.revision,connection_id=excluded.connection_id,domain=excluded.domain,app_id=excluded.app_id,room_id=excluded.room_id,host_id=excluded.host_id,session_id=excluded.session_id').run(b.bindingId, b.revision, b.connectionId, b.application.domain, b.application.appId, b.externalConversationId, b.executionHostId, b.agentSessionId)
  }
  private finish(operation: RoomBindingOperation): RoomBindingOperation {
    this.database.prepare('UPDATE room_binding_operation SET result_json=? WHERE operation_id=?').run(JSON.stringify(parseRoomBindingOperation(operation)), operation.operationId)
    return operation
  }
  private async operate(action: Action, value: Input, context: RoomBindingCallContext, run: (input: Input, actor: RoomBindingAuthority) => Promise<RoomBindingOperation>): Promise<RoomBindingOperation> {
    const input = parseRoomBindingParams(method[action], value), actor = parseRoomBindingAuthority(context.actor)
    await context.assertCurrent?.()
    const intent = JSON.stringify({ action, input, actor })
    const original = this.transaction(() => {
      const saved = this.saved(input.operationId)
      if (saved) {
        if (saved.intent !== intent) throw new AgentMuxError('The original binding operation has different input or authority. Inspect it without replacing its identity.', 'ROOM_BINDING_OPERATION_CONFLICT')
        return saved.operation
      }
      const preparing: RoomBindingOperation = { operationId: input.operationId, action, state: 'preparing' }
      this.database.prepare('INSERT INTO room_binding_operation (operation_id,intent_json,result_json) VALUES (?,?,?)').run(input.operationId, intent, JSON.stringify(preparing))
      return preparing
    })
    if (original.state !== 'preparing') return original
    const pending = this.pending.get(input.operationId)
    if (pending) return await pending
    const work = (async () => {
      try { return await run(input, actor) }
      catch (error) {
        if (error instanceof Refusal) return this.transaction(() => {
          const saved = this.saved(input.operationId)!.operation
          return saved.state === 'preparing' ? this.finish({ operationId: input.operationId, action, state: 'refused', code: error.code }) : saved
        })
        // No exception payload crosses this owner: Core/provider/storage errors can contain private paths.
        throw new AgentMuxError('The original binding operation is unconfirmed. Inspect the same operation and retain its identity. Existing Agents remain available.', 'ROOM_BINDING_OPERATION_UNCONFIRMED')
      }
    })().finally(() => { this.pending.delete(input.operationId) })
    this.pending.set(input.operationId, work)
    return await work
  }
  private connection(input: RoomBindingBindInput) {
    const current = this.options.connections.readConfiguration(input.connectionId)
    if (!current || !current.config.enabled) refuse('ROOM_BINDING_CONNECTION_UNAVAILABLE')
    if (current.revision !== input.expectedConnectionRevision) refuse('ROOM_BINDING_CONNECTION_REVISED')
    return current
  }
  private async region(input: RoomBindingBindInput): Promise<number> {
    const target = await readRoomTarget(this.options.spatial, input)
    if (!target) refuse('ROOM_BINDING_TARGET_CHANGED')
    return target.revision
  }
  private async cut(input: RoomBindingBindInput): Promise<ConversationCheckpoint[]> {
    const ref = { hostId: input.executionHostId, agentSessionId: input.agentSessionId }
    let page: ConversationCheckpointPage
    try { page = parseConversationCheckpointPage(await this.options.checkpoint(ref), ref) }
    catch { return refuse('ROOM_BINDING_SOURCE_UNAVAILABLE') }
    if (!equal(page.checkpoint.source, input.expectedSource)) refuse('ROOM_BINDING_SOURCE_CHANGED')
    return [page.checkpoint]
  }
  private conflicts(input: RoomBindingBindInput, bindingId: string): void {
    if ([this.matching('audience', input), this.matching('session', input)].some(b => b && b.bindingId !== bindingId)) refuse('ROOM_BINDING_MAPPING_CONFLICT')
  }
  async bind(value: RoomBindingBindInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('bind', value, context, async (raw, authority) => {
      const input = raw as RoomBindingBindInput, spatialRevision = await this.region(input)
      this.safe(() => this.connection(input))
      const existing = this.safe(() => this.readCurrent(input.bindingId) ?? this.matching('session', input))
      const cut = existing ? existing.sourceCheckpoints : await this.cut(input)
      await context.assertCurrent?.()
      if (await this.region(input) !== spatialRevision) refuse('ROOM_BINDING_TARGET_CHANGED')
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const connection = this.connection(input), current = this.readCurrent(input.bindingId) ?? this.matching('session', input)
        if (current) {
          if (current.state !== 'active') refuse('ROOM_BINDING_PAUSED')
          if (current.connectionId !== input.connectionId || current.executionHostId !== input.executionHostId || current.agentSessionId !== input.agentSessionId || current.externalConversationId !== input.externalConversationId || !equal(current.scope, input.scope) || current.sourceCheckpoints.some(c => !equal(c.source, input.expectedSource))) refuse('ROOM_BINDING_MAPPING_CONFLICT')
          return this.finish({ operationId: input.operationId, action: 'bind', state: 'applied', binding: current, reused: true })
        }
        this.conflicts(input, input.bindingId)
        const binding: RoomBinding = { bindingId: input.bindingId, revision: 1, state: 'active', connectionId: input.connectionId, application: connection.config.application, externalConversationId: input.externalConversationId, scope: input.scope, executionHostId: input.executionHostId, agentSessionId: input.agentSessionId, regionAnchor: input.regionAnchor, sourceCheckpoints: cut, authorizedBy: authority }
        this.writeBinding(binding)
        return this.finish({ operationId: input.operationId, action: 'bind', state: 'applied', binding })
      })
    })
  }
  async relink(value: RoomBindingRelinkInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('relink', value, context, async (raw, authority) => {
      const input = raw as RoomBindingRelinkInput, spatialRevision = await this.region(input)
      this.safe(() => this.connection(input))
      const cut = await this.cut(input)
      await context.assertCurrent?.()
      if (await this.region(input) !== spatialRevision) refuse('ROOM_BINDING_TARGET_CHANGED')
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const connection = this.connection(input), current = this.readCurrent(input.bindingId)
        if (!current || current.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        this.conflicts(input, input.bindingId)
        const binding: RoomBinding = { ...current, revision: current.revision + 1, state: 'active', connectionId: input.connectionId, application: connection.config.application, externalConversationId: input.externalConversationId, scope: input.scope, executionHostId: input.executionHostId, agentSessionId: input.agentSessionId, regionAnchor: input.regionAnchor, sourceCheckpoints: cut, authorizedBy: authority }
        this.writeBinding(binding)
        return this.finish({ operationId: input.operationId, action: 'relink', state: 'applied', binding })
      })
    })
  }
  async pause(value: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('pause', value, context, async (raw, authority) => {
      const input = raw as RoomBindingPauseInput
      await context.assertCurrent?.()
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const current = this.readCurrent(input.bindingId)
        if (!current || current.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        const binding: RoomBinding = { ...current, state: 'paused', revision: current.revision + 1 }
        this.writeBinding(binding)
        return this.finish({ operationId: input.operationId, action: 'pause', state: 'applied', binding })
      })
    })
  }
  async grant(value: RoomBindingGrantInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('grant', value, context, async (raw, authority) => {
      const input = raw as RoomBindingGrantInput
      await context.assertCurrent?.()
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const binding = this.readCurrent(input.bindingId), current = this.readGrant(input.grantId)
        if (!binding || binding.revision !== input.expectedBindingRevision || binding.state !== 'active') refuse('ROOM_BINDING_REVISION_CONFLICT')
        if (!equal(binding.application, input.actor.application)) refuse('ROOM_GRANT_ACTOR_MISMATCH')
        if ((current?.revision ?? null) !== input.expectedRevision) refuse('ROOM_GRANT_REVISION_CONFLICT')
        if (current && (current.bindingId !== binding.bindingId || !equal(current.actor, input.actor))) refuse('ROOM_GRANT_ACTOR_MISMATCH')
        const other = this.findGrant({ connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, actor: input.actor })
        if (other && other.grantId !== input.grantId) refuse('ROOM_GRANT_ACTOR_CONFLICT')
        const grant: ConnectionGrant = { grantId: input.grantId, revision: (current?.revision ?? 0) + 1, bindingId: binding.bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId, actor: input.actor, externalConversationId: binding.externalConversationId, state: input.state, capabilities: input.capabilities }
        this.database.prepare('INSERT INTO room_grant_revision (grant_id,revision,snapshot_json) VALUES (?,?,?)').run(grant.grantId, grant.revision, JSON.stringify(grant))
        // This head is an audience routing projection. Immutable revisions retain each grant's latest identity.
        // A stale route can be replaced only by this explicit authorization in the same transaction.
        this.database.prepare('DELETE FROM room_grant_head WHERE connection_id=? AND room_id=? AND actor_json=? AND grant_id<>?').run(grant.connectionId, grant.externalConversationId, JSON.stringify(grant.actor), grant.grantId)
        this.database.prepare('INSERT INTO room_grant_head (grant_id,revision,binding_id,connection_id,room_id,actor_json) VALUES (?,?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET revision=excluded.revision,binding_id=excluded.binding_id,connection_id=excluded.connection_id,room_id=excluded.room_id,actor_json=excluded.actor_json').run(grant.grantId, grant.revision, grant.bindingId, grant.connectionId, grant.externalConversationId, JSON.stringify(grant.actor))
        return this.finish({ operationId: input.operationId, action: 'grant', state: 'applied', binding, grant })
      })
    })
  }
}
