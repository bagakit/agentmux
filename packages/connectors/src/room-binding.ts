import { effectiveRoomGrant } from './effective-grant.js'
import type { ConnectionMemberAccess, ConnectionEffectiveGrant, ConnectionEffectiveGrants, RoomBindingInheritInput } from '@agentmux/core/connections'
import { AgentMuxError } from '@agentmux/core'
import { parseConversationCheckpointPage, type ConversationCheckpointPage, type ConversationRef } from '@agentmux/core/conversation'
import { readRoomPublicationBinding, sameRoomPublication, parseConnectionActor, parseConnectionGrant, parseRoomBinding, parseRoomBindingAuthority, parseRoomBindingOperation, parseRoomBindingParams, type ConnectionGrant, type RoomBinding, type RoomBindingAuthority, type RoomBindingBindInput, type RoomBindingCallContext, type RoomBindingGrantInput, type RoomBindingInspectInput, type RoomBindingListInput, type RoomBindingOperation, type RoomBindingPauseInput, type RoomBindingReadPort, type RoomBindingRelinkInput, type RoomBindingNoticeEvent, type RoomBindingNotice, type RoomBindingsPort, type RoomPublicationAuthority } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { readRoomTarget, type RoomTargetOwner } from './room-target.js'

export type RoomBindingHostOptions = {
  connections: ConnectionHost
  /** Synchronous enqueue joins this original Binding transaction; no network effects. */
  lifecycle?: { queueBindingNotice(operationId: string, binding: RoomBinding, event: RoomBindingNoticeEvent, synchronization: boolean | null): string; retireBindingPending(binding: RoomBinding): void }
  spatial: RoomTargetOwner['spatial']
  session?: NonNullable<RoomTargetOwner['session']>
  /** Metadata already confirmed by the original target read; no additional discovery. */
  executionRuntimeId?(hostId: string): string | undefined
  /** Borrow the original Core client for the exact Host, never a new Runtime or focused occupant. */
  checkpoint(reference: ConversationRef): Promise<ConversationCheckpointPage>
}
type Action = RoomBindingOperation['action']
type Input = RoomBindingBindInput | RoomBindingRelinkInput | RoomBindingPauseInput | RoomBindingGrantInput | RoomBindingInheritInput
type Saved = { intent: string; operation: RoomBindingOperation }
class Refusal extends Error { constructor(readonly code: string) { super(code) } }
function refuse(code: string): never { throw new Refusal(code) }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const method = { bind: 'connection.bind', relink: 'connection.binding.relink', pause: 'connection.binding.pause', resume: 'connection.binding.resume', detach: 'connection.binding.detach', grant: 'connection.grant', inherit: 'connection.binding.member.inherit' } as const

/** Binding, grant and operation snapshots belong to the original connector database. No topology is copied. */
export class RoomBindingHost implements RoomBindingsPort, RoomBindingReadPort {
  private readonly database
  private readonly pending = new Map<string, Promise<RoomBindingOperation>>()
  constructor(private readonly options: RoomBindingHostOptions) {
    this.database = options.connections.database
    this.safe(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS room_binding_revision (binding_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(binding_id, revision));
      CREATE TABLE IF NOT EXISTS room_binding_head (binding_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, connection_id TEXT NOT NULL, domain TEXT NOT NULL, app_id TEXT NOT NULL, room_id TEXT NOT NULL, host_id TEXT NOT NULL, session_id TEXT NOT NULL, UNIQUE(domain, app_id, room_id), UNIQUE(connection_id, host_id, session_id));
      CREATE INDEX IF NOT EXISTS room_binding_session ON room_binding_head(host_id,session_id,binding_id);
      CREATE TABLE IF NOT EXISTS room_binding_operation (operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_grant_revision (grant_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(grant_id, revision));
      CREATE INDEX IF NOT EXISTS room_grant_subject ON room_grant_revision(json_extract(snapshot_json,'$.bindingId'));
      CREATE TABLE IF NOT EXISTS room_grant_head (grant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, binding_id TEXT NOT NULL, connection_id TEXT NOT NULL, room_id TEXT NOT NULL, actor_json TEXT NOT NULL, UNIQUE(connection_id, room_id, actor_json));
      CREATE INDEX IF NOT EXISTS room_grant_binding_actor ON room_grant_head(binding_id,actor_json);
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
    return this.safe(() => { const row = this.database.prepare('SELECT max(revision) AS revision FROM room_binding_revision WHERE binding_id=?').get(bindingId); return row?.revision ? this.readExact(bindingId, Number(row.revision)) : null })
  }
  private audience(input: { application: RoomBinding['application']; externalConversationId: string }): RoomBinding | null {
    const row = this.database.prepare('SELECT binding_id FROM room_binding_head WHERE domain=? AND app_id=? AND room_id=?').get(input.application.domain, input.application.appId, input.externalConversationId)
    return row ? this.readCurrent(String(row.binding_id)) : null
  }
  findActiveAudience(input: { application: RoomBinding['application']; externalConversationId: string }): RoomBinding | null {
    return this.safe(() => { const binding = this.audience(input); return binding?.state === 'active' ? binding : null })
  }
  private matching(column: 'audience' | 'session', input: RoomBindingBindInput): RoomBinding | null {
    const connection = this.options.connections.readConfiguration(input.connectionId)
    if (!connection) return null
    if (column === 'audience') return this.audience({ application: connection.config.application, externalConversationId: input.externalConversationId })
    const row = this.database.prepare('SELECT binding_id FROM room_binding_head WHERE connection_id=? AND host_id=? AND session_id=?').get(input.connectionId, input.executionHostId, input.agentSessionId)
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
    if (!sameRoomPublication(binding, current)) return result('binding-revised')
    if (current.state !== 'active') return result('paused')
    const connection = this.options.connections.readConfiguration(binding.connectionId)
    if (!connection?.config.enabled || !equal(connection.config.application, binding.application)) return result('connection-disabled')
    if (!this.options.connections.automaticTrafficEnabled(connection.config.adapterId)) return result('service-disabled')
    if (!['future-native-user-facing', 'future-shared-conversation'].includes(binding.scope.publication) || !['user', 'device', 'agent'].includes(binding.authorizedBy.kind) || binding.authorizedBy.kind === 'agent' && binding.authorizedBy.id !== binding.agentSessionId) return result('publication-not-granted')
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
    return this.safe(() => {
      const row = this.database.prepare('SELECT grant_id,binding_id FROM room_grant_head WHERE connection_id=? AND room_id=? AND actor_json=?').get(input.connectionId, input.externalConversationId, JSON.stringify(parseConnectionActor(input.actor)))
      const grant = row ? this.readGrant(String(row.grant_id)) : null, binding = row ? this.readCurrent(String(row.binding_id)) : null
      return grant && binding && this.grantBelongs(binding, grant) ? grant : null
    })
  }
  grants(bindingId: string, revision: number): ConnectionGrant[] { return this.bindingGrants(this.readExact(bindingId, revision)) }
  private grantBelongs(binding: RoomBinding, grant: ConnectionGrant): boolean {
    const original = grant.bindingRevision <= binding.revision ? this.readExact(grant.bindingId, grant.bindingRevision) : null
    return !!original && sameRoomPublication(original, binding)
  }
  private publication(binding: RoomBinding): RoomBinding | null {
    return readRoomPublicationBinding(this, binding)
  }
  private bindingGrants(binding: RoomBinding | null): ConnectionGrant[] {
    if (!binding) return []
    return this.safe(() => this.database.prepare('SELECT grant_id FROM room_grant_head WHERE connection_id=? AND room_id=? AND binding_id=?').all(binding.connectionId, binding.externalConversationId, binding.bindingId).map(row => this.readGrant(String(row.grant_id))!).filter(grant => this.grantBelongs(binding, grant)))
  }
  /** Head is authority; immutable history only explains a prior explicit decision. */
  private localHeads(binding: RoomBinding, actor?: ConnectionGrant['actor']): ConnectionGrant[] {
    return this.safe(() => this.database.prepare('SELECT r.snapshot_json FROM room_grant_head h JOIN room_grant_revision r ON r.grant_id=h.grant_id AND r.revision=h.revision WHERE h.binding_id=?' + (actor ? ' AND h.actor_json=?' : '')).all(binding.bindingId, ...(actor ? [JSON.stringify(parseConnectionActor(actor))] : []))
      .map(row => parseConnectionGrant(JSON.parse(String(row.snapshot_json))))
      .filter(g => { const original = this.readExact(g.bindingId, g.bindingRevision); return !!original && this.sameGrantSubject(original, binding) }))
  }
  private localDecision(binding: RoomBinding, actor: ConnectionGrant['actor']): ConnectionGrant | null {
    const heads = this.localHeads(binding, actor).sort((a, b) => b.bindingRevision - a.bindingRevision)
    if (heads.length > 1 && heads[1]!.bindingRevision === heads[0]!.bindingRevision) throw new AgentMuxError('The original member decision has conflicting heads. Inspect this member before explicitly saving; existing Agents remain available.', 'ROOM_GRANT_DECISION_UNCONFIRMED')
    return heads[0] ?? null
  }
  effectiveGrant(bindingId: string, revision: number, actor: ConnectionGrant['actor']): ConnectionEffectiveGrant | null {
    const binding = this.readCurrent(bindingId)
    if (!binding || binding.revision !== revision || !equal(binding.application, actor.application)) return null
    const local = this.localDecision(binding, actor)
    if (local) return this.grantBelongs(binding, local) || local.state === 'revoked' ? effectiveRoomGrant(local) : null
    const grant = this.options.connections.applicationAccess.grants(binding.connectionId, actor)[0]
    return grant ? { actor: grant.actor, state: grant.state, capabilities: grant.capabilities, source: { kind: 'application', grantId: grant.grantId, revision: grant.revision } } : null
  }
  effectiveGrants(bindingId: string, revision: number): ConnectionEffectiveGrants {
    const binding = this.readCurrent(bindingId)
    if (!binding || binding.revision !== revision) return { grants: [], issue: null }
    const local = this.localHeads(binding), actors = new Map(local.map(g => [JSON.stringify(g.actor), g.actor]))
    const grants: ConnectionEffectiveGrant[] = []
    for (const actor of actors.values()) { const grant = this.localDecision(binding, actor)!; if (this.grantBelongs(binding, grant) || grant.state === 'revoked') grants.push(effectiveRoomGrant(grant)) }
    try {
      for (const g of this.options.connections.applicationAccess.grants(binding.connectionId)) if (!actors.has(JSON.stringify(g.actor))) grants.push({ actor: g.actor, state: g.state, capabilities: g.capabilities, source: { kind: 'application', grantId: g.grantId, revision: g.revision } })
      return { grants, issue: null }
    } catch { return { grants, issue: 'application-unconfirmed' } }
  }
  private memberAccess(binding: RoomBinding): ConnectionMemberAccess[] {
    const actors = new Map<string, { actor: ConnectionGrant['actor']; previousDecision: boolean }>()
    const remember = (actor: ConnectionGrant['actor'], previousDecision: boolean) => { const key = JSON.stringify(actor); actors.set(key, { actor, previousDecision: previousDecision || actors.get(key)?.previousDecision === true }) }
    for (const grant of this.localHeads(binding)) remember(grant.actor, true)
    for (const row of this.database.prepare("SELECT snapshot_json FROM room_grant_revision WHERE json_extract(snapshot_json,'$.bindingId')=?").all(binding.bindingId)) {
      const g = parseConnectionGrant(JSON.parse(String(row.snapshot_json))), original = this.readExact(g.bindingId, g.bindingRevision)
      if (original && this.sameGrantSubject(original, binding)) remember(g.actor, true)
    }
    for (const g of this.options.connections.applicationAccess.grants(binding.connectionId)) remember(g.actor, false)
    return [...actors.values()].map(({ actor, previousDecision }) => {
      const grant = this.localDecision(binding, actor), effective = this.effectiveGrant(binding.bindingId, binding.revision, actor)
      return { actor, local: grant ? { kind: this.grantBelongs(binding, grant) ? 'override' as const : 'review-required' as const, grant } : { kind: 'none' as const, previousDecision }, effective }
    })
  }
  readOperation(operationId: string): RoomBindingOperation | null { return this.safe(() => this.saved(operationId)?.operation ?? null) }
  private saved(operationId: string): Saved | null {
    const row = this.database.prepare('SELECT intent_json, result_json FROM room_binding_operation WHERE operation_id=?').get(operationId)
    return row ? { intent: String(row.intent_json), operation: parseRoomBindingOperation(JSON.parse(String(row.result_json))) } : null
  }
  async inspect(value: RoomBindingInspectInput) {
    const input = parseRoomBindingParams('connection.binding.inspect', value)
    return this.safe(() => {
      const operation = input.operationId ? this.saved(input.operationId)?.operation ?? null : null
      const binding = input.bindingId ? input.revision === undefined ? this.readCurrent(input.bindingId) : this.readExact(input.bindingId, input.revision) : operation?.state === 'applied' ? operation.binding : null
      return { binding, current: binding ? this.readCurrent(binding.bindingId) : null, operation, grants: this.bindingGrants(binding), ...(binding && input.bindingId && input.revision === undefined ? { access: this.memberAccess(binding) } : {}) }
    })
  }
  private writeBinding(binding: RoomBinding): void {
    const b = parseRoomBinding(binding)
    this.database.prepare('INSERT INTO room_binding_revision (binding_id,revision,snapshot_json) VALUES (?,?,?)').run(b.bindingId, b.revision, JSON.stringify(b))
    if (b.state === 'detached') { this.database.prepare('DELETE FROM room_binding_head WHERE binding_id=?').run(b.bindingId); return }
    this.database.prepare('INSERT INTO room_binding_head (binding_id,revision,connection_id,domain,app_id,room_id,host_id,session_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET revision=excluded.revision,connection_id=excluded.connection_id,domain=excluded.domain,app_id=excluded.app_id,room_id=excluded.room_id,host_id=excluded.host_id,session_id=excluded.session_id').run(b.bindingId, b.revision, b.connectionId, b.application.domain, b.application.appId, b.externalConversationId, b.executionHostId, b.agentSessionId)
  }
  private notices(operationId: string, entries: Array<{ binding: RoomBinding; event: RoomBindingNoticeEvent }>): RoomBindingNotice[] | undefined {
    if (!this.options.lifecycle) return undefined
    return entries.map(({ binding, event }) => {
      let synchronization: boolean | null = null
      try {
        const connection = this.options.connections.readConfiguration(binding.connectionId)
        if (connection) synchronization = this.options.connections.automaticTrafficEnabled(connection.config.adapterId)
      } catch { /* Notification describes the observation gap; it cannot block ending this relationship. */ }
      return { event, deliveryOperationId: this.options.lifecycle!.queueBindingNotice(operationId, binding, event, synchronization) }
    })
  }
  private sameGrantSubject(left: RoomBinding, right: RoomBinding): boolean {
    return equal(left.application, right.application) && left.externalConversationId === right.externalConversationId && left.executionHostId === right.executionHostId && left.executionRuntimeId === right.executionRuntimeId && left.agentSessionId === right.agentSessionId && equal(left.inputTarget, right.inputTarget)
  }
  private carryGrants(previous: RoomBinding, binding: RoomBinding): void {
    if (!this.sameGrantSubject(previous, binding)) return
    for (const original of this.bindingGrants(previous)) {
      const grant = { ...original, revision: original.revision + 1, bindingRevision: binding.revision, connectionId: binding.connectionId }
      this.database.prepare('INSERT INTO room_grant_revision (grant_id,revision,snapshot_json) VALUES (?,?,?)').run(grant.grantId, grant.revision, JSON.stringify(grant))
      this.database.prepare('DELETE FROM room_grant_head WHERE connection_id=? AND room_id=? AND actor_json=? AND grant_id<>?').run(grant.connectionId, grant.externalConversationId, JSON.stringify(grant.actor), grant.grantId)
      this.database.prepare('UPDATE room_grant_head SET revision=?,connection_id=? WHERE grant_id=?').run(grant.revision, grant.connectionId, grant.grantId)
    }
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
  private async region(input: RoomBindingBindInput): Promise<void> {
    if (!await readRoomTarget(this.options, input)) refuse('ROOM_BINDING_TARGET_CHANGED')
  }
  private async cut(input: Pick<RoomBinding, 'executionHostId' | 'agentSessionId' | 'scope'> & { expectedSource: RoomBindingBindInput['expectedSource'] }): Promise<Pick<RoomBinding, 'sourceCheckpoints' | 'sourceFrontier'>> {
    const ref = { hostId: input.executionHostId, agentSessionId: input.agentSessionId }
    let page: ConversationCheckpointPage
    try { page = parseConversationCheckpointPage(await this.options.checkpoint(ref), ref) }
    catch { return refuse('ROOM_BINDING_SOURCE_UNAVAILABLE') }
    const native = page.checkpoint.frontier.cuts.filter(c => c.kind === 'native')
    if (!native.length) refuse('ROOM_BINDING_SOURCE_UNAVAILABLE')
    if (native.length !== 1 || !equal(native[0]!.checkpoint.source, input.expectedSource)) refuse('ROOM_BINDING_SOURCE_CHANGED')
    const sourceFrontier = input.scope.publication === 'future-shared-conversation' ? page.checkpoint : {
      ...page.checkpoint, frontier: { ...page.checkpoint.frontier,
        scope: { sources: page.scope.sources.filter(s => s.kind === 'native') }, cuts: native }
    }
    return { sourceCheckpoints: native.map(c => c.checkpoint), sourceFrontier }
  }
  private conflicts(input: RoomBindingBindInput, bindingId: string): void {
    if ([this.matching('audience', input), this.matching('session', input)].some(b => b && b.bindingId !== bindingId)) refuse('ROOM_BINDING_MAPPING_CONFLICT')
  }
  async bind(value: RoomBindingBindInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('bind', value, context, async (raw, authority) => {
      const input = raw as RoomBindingBindInput
      await this.region(input)
      const executionRuntimeId = this.options.executionRuntimeId?.(input.executionHostId)
      this.safe(() => this.connection(input))
      const existing = this.safe(() => this.readCurrent(input.bindingId) ?? this.matching('session', input))
      const cut = existing ? { sourceCheckpoints: existing.sourceCheckpoints, ...(existing.sourceFrontier ? { sourceFrontier: existing.sourceFrontier } : {}) } : await this.cut(input)
      await context.assertCurrent?.()
      await this.region(input)
      if (this.options.executionRuntimeId?.(input.executionHostId) !== executionRuntimeId) refuse('ROOM_BINDING_TARGET_CHANGED')
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const connection = this.connection(input), current = this.readCurrent(input.bindingId) ?? this.matching('session', input)
        if (current) {
          if (current.executionRuntimeId && current.executionRuntimeId !== executionRuntimeId) refuse('ROOM_BINDING_TARGET_CHANGED')
          if (current.state !== 'active') refuse(current.state === 'detached' ? 'ROOM_BINDING_DETACHED' : 'ROOM_BINDING_PAUSED')
          if (current.connectionId !== input.connectionId || current.executionHostId !== input.executionHostId || current.agentSessionId !== input.agentSessionId || current.externalConversationId !== input.externalConversationId || !equal(current.scope, input.scope) || !equal(current.inputTarget, input.inputTarget) || current.sourceCheckpoints.some(c => !equal(c.source, input.expectedSource))) refuse('ROOM_BINDING_MAPPING_CONFLICT')
          return this.finish({ operationId: input.operationId, action: 'bind', state: 'applied', binding: current, reused: true })
        }
        this.conflicts(input, input.bindingId)
        const binding: RoomBinding = { bindingId: input.bindingId, revision: 1, state: 'active', connectionId: input.connectionId, application: connection.config.application, externalConversationId: input.externalConversationId, scope: input.scope, ...(input.inputTarget ? { inputTarget: input.inputTarget } : {}), executionHostId: input.executionHostId, ...(executionRuntimeId ? { executionRuntimeId } : {}), agentSessionId: input.agentSessionId, ...(input.regionAnchor ? { regionAnchor: input.regionAnchor } : {}), ...cut, authorizedBy: authority }
        this.writeBinding(binding)
        const notices = this.notices(input.operationId, [{ binding, event: 'connected' }])
        return this.finish({ operationId: input.operationId, action: 'bind', state: 'applied', binding, ...(notices ? { notices } : {}) })
      })
    })
  }
  async relink(value: RoomBindingRelinkInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('relink', value, context, async (raw, authority) => {
      const input = raw as RoomBindingRelinkInput
      await this.region(input)
      const executionRuntimeId = this.options.executionRuntimeId?.(input.executionHostId)
      this.safe(() => this.connection(input))
      const before = this.readCurrent(input.bindingId)
      if (before?.executionHostId === input.executionHostId && before.executionRuntimeId && !executionRuntimeId) refuse('ROOM_BINDING_TARGET_UNCONFIRMED')
      const connection = this.connection(input)
      const { executionRuntimeId: _runtime, inputTarget: _inputTarget, ...previousSubject } = before ?? {}
      const candidate = before ? { ...previousSubject, connectionId: input.connectionId, application: connection.config.application,
        externalConversationId: input.externalConversationId, executionHostId: input.executionHostId, ...(executionRuntimeId ? { executionRuntimeId } : {}),
        agentSessionId: input.agentSessionId, scope: input.scope, ...(input.inputTarget ? { inputTarget: input.inputTarget } : {}) } as RoomBinding : null
      const continuous = !!before && before.state === 'active' && !before.publicationOrigin && before.scope.publication === 'future-shared-conversation' &&
        sameRoomPublication(before, candidate!) && before.sourceCheckpoints.every(c => equal(c.source, input.expectedSource))
      const original = continuous ? this.publication(before!) : null
      if (continuous && !original) refuse('ROOM_BINDING_PUBLICATION_UNCONFIRMED')
      const observedCut = await this.cut(input)
      const cut = original ? { sourceCheckpoints: original.sourceCheckpoints, ...(original.sourceFrontier ? { sourceFrontier: original.sourceFrontier } : {}) } : observedCut
      await context.assertCurrent?.()
      await this.region(input)
      if (this.options.executionRuntimeId?.(input.executionHostId) !== executionRuntimeId) refuse('ROOM_BINDING_TARGET_CHANGED')
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const connection = this.connection(input), current = this.readCurrent(input.bindingId)
        if (!current || current.state === 'detached' || current.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        this.conflicts(input, input.bindingId)
        const { inputTarget: _previousInputTarget, regionAnchor: _previousRegionAnchor, executionRuntimeId: _previousRuntime, publicationBoundary: _previousBoundary, ...previous } = current
        const binding: RoomBinding = { ...previous, revision: current.revision + 1, state: 'active', connectionId: input.connectionId, application: connection.config.application, externalConversationId: input.externalConversationId, scope: input.scope, ...(input.inputTarget ? { inputTarget: input.inputTarget } : {}), executionHostId: input.executionHostId, ...(executionRuntimeId ? { executionRuntimeId } : {}), agentSessionId: input.agentSessionId, ...(input.regionAnchor ? { regionAnchor: input.regionAnchor } : {}), ...cut, ...(original ? { publicationBoundary: { revision: original.revision } } : {}), authorizedBy: authority }
        this.writeBinding(binding)
        if (!original) { const previousPublication = this.publication(current); if (previousPublication) this.options.lifecycle?.retireBindingPending(previousPublication); this.carryGrants(current, binding) }
        const sameRoute = equal(current.application, binding.application) && current.externalConversationId === binding.externalConversationId && current.agentSessionId === binding.agentSessionId && current.executionHostId === binding.executionHostId && current.executionRuntimeId === binding.executionRuntimeId
        const notices = this.notices(input.operationId, sameRoute ? [{ binding, event: current.state === 'paused' ? 'resumed' : 'updated' }] : [{ binding: current, event: 'disconnected' }, { binding, event: 'connected' }])
        return this.finish({ operationId: input.operationId, action: 'relink', state: 'applied', binding, ...(notices ? { notices } : {}) })
      })
    })
  }
  async resume(value: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('resume', value, context, async raw => {
      const input = raw as RoomBindingPauseInput, previous = this.readCurrent(input.bindingId)
      if (!previous || previous.state !== 'paused' || previous.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
      const cut = await this.cut({ ...previous, expectedSource: previous.sourceCheckpoints[0]!.source })
      await context.assertCurrent?.()
      if (previous.executionRuntimeId && this.options.executionRuntimeId?.(previous.executionHostId) !== previous.executionRuntimeId) refuse('ROOM_BINDING_TARGET_CHANGED')
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const current = this.readCurrent(input.bindingId)
        if (!current || current.state !== 'paused' || current.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        const connection = this.options.connections.readConfiguration(current.connectionId)
        if (!connection?.config.enabled || !equal(connection.config.application, current.application)) refuse('ROOM_BINDING_CONNECTION_UNAVAILABLE')
        const { publicationBoundary: _previousBoundary, ...previous } = current
        const binding: RoomBinding = { ...previous, state: 'active', revision: current.revision + 1, ...cut }
        this.writeBinding(binding); this.carryGrants(current, binding)
        const notices = this.notices(input.operationId, [{ binding, event: 'resumed' }])
        return this.finish({ operationId: input.operationId, action: 'resume', state: 'applied', binding, ...(notices ? { notices } : {}) })
      })
    })
  }
  async pause(value: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> { return this.end('pause', value, context) }
  async detach(value: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> { return this.end('detach', value, context) }
  private async end(action: 'pause' | 'detach', value: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate(action, value, context, async raw => {
      const input = raw as RoomBindingPauseInput
      await context.assertCurrent?.()
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const current = this.readCurrent(input.bindingId)
        if (!current || current.state === 'detached' || current.revision !== input.expectedRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        const binding: RoomBinding = { ...current, state: action === 'pause' ? 'paused' : 'detached', revision: current.revision + 1 }
        this.writeBinding(binding)
        const previousPublication = this.publication(current)
        if (previousPublication) this.options.lifecycle?.retireBindingPending(previousPublication)
        if (action === 'pause') this.carryGrants(current, binding)
        const notices = this.notices(input.operationId, [{ binding, event: action === 'pause' ? 'paused' : 'disconnected' }])
        return this.finish({ operationId: input.operationId, action, state: 'applied', binding, ...(notices ? { notices } : {}) })
      })
    })
  }
  async inherit(value: RoomBindingInheritInput, context: RoomBindingCallContext): Promise<RoomBindingOperation> {
    return this.operate('inherit', value, context, async raw => {
      const input = raw as RoomBindingInheritInput
      await context.assertCurrent?.()
      return this.transaction(() => {
        const saved = this.saved(input.operationId)!.operation
        if (saved.state !== 'preparing') return saved
        const binding = this.readCurrent(input.bindingId)
        if (!binding || binding.state !== 'active' || binding.revision !== input.expectedBindingRevision) refuse('ROOM_BINDING_REVISION_CONFLICT')
        if (!equal(binding.application, input.actor.application)) refuse('ROOM_GRANT_ACTOR_MISMATCH')
        const current = this.localDecision(binding, input.actor)
        if (!current || current.grantId !== input.expectedGrant.grantId || current.revision !== input.expectedGrant.revision) refuse('ROOM_GRANT_REVISION_CONFLICT')
        const grants = this.localHeads(binding, input.actor).map(g => ({ grantId: g.grantId, revision: g.revision }))
        for (const g of grants) this.database.prepare('DELETE FROM room_grant_head WHERE grant_id=? AND revision=?').run(g.grantId, g.revision)
        return this.finish({ operationId: input.operationId, action: 'inherit', state: 'applied', binding, inherited: { actor: input.actor, grants } })
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
