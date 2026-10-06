import { randomUUID } from 'node:crypto'
import { AgentMuxError, parseAgentExternalMessageAuthor, type AgentInputCallContext, type AgentMuxClient, type AgentMuxMessageEnvelope } from '@agentmux/core'
import { parseConnectionActor, parseConnectionIngressRecord, parseIngressParams, parseIngressResult, type ConnectionConfig, type ConnectionIngressInspection, type ConnectionIngressListInput, type ConnectionIngressReadPort, type ConnectionIngressRecord, type RoomBinding, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'

/** Returned only by a Host-registered adapter after verifying the original transport proof. */
export type VerifiedIngressEvent = {
  eventId: string; messageId: string; externalConversationId: string
  actor: import('@agentmux/core/connections').ConnectionActor
  body: string
  /** Original platform addressing facts, not body matching. */
  selection: 'mention' | 'reply' | 'message'
}
export interface IngressAuthenticator {
  readonly adapterId: string
  /** Own signature/token verification and issuer checks. Never expose this port over RPC. */
  verify(config: ConnectionConfig, raw: string): Promise<VerifiedIngressEvent>
}
type Core = Pick<AgentMuxClient, 'metadata' | 'submitAgentMessage' | 'inspectAgentInput' | 'rejoinAgentInputWaiting'>
export type DurableIngressOptions = {
  connections: ConnectionHost
  bindings: RoomBindingReadPort
  authenticators: readonly IngressAuthenticator[]
  /** Return the original executing Host's client; Region occupants and focus are not routes. */
  core(hostId: string): Core | undefined
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fail(code: string): never { throw new AgentMuxError('This external intake cannot use the original target or authority. Existing Agents and inputs are retained.', code) }
function verified(value: VerifiedIngressEvent): VerifiedIngressEvent {
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail('INVALID_CONNECTION_INGRESS'); return v as string }
  if (typeof value.body !== 'string' || !['mention', 'reply', 'message'].includes(value.selection)) fail('INVALID_CONNECTION_INGRESS')
  return { eventId: text(value.eventId), messageId: text(value.messageId), externalConversationId: text(value.externalConversationId), actor: parseConnectionActor(value.actor), body: value.body, selection: value.selection }
}

/** Durable transport admission only. The original Core queue owns all Agent input and delivery facts. */
export class DurableIngressHost implements ConnectionIngressReadPort {
  private readonly database
  private readonly authenticators: Map<string, IngressAuthenticator>
  private readonly pending = new Map<string, Promise<ConnectionIngressInspection>>()
  constructor(private readonly options: DurableIngressOptions) {
    this.database = options.connections.database
    this.authenticators = new Map(options.authenticators.map(port => [port.adapterId, port]))
    if (this.authenticators.size !== options.authenticators.length) fail('INGRESS_AUTHENTICATOR_CONFLICT')
    this.safe(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS connection_ingress_message (sequence INTEGER PRIMARY KEY AUTOINCREMENT, ingress_id TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL, connection_id TEXT NOT NULL, event_json TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(domain, app_id, message_id));
      CREATE TABLE IF NOT EXISTS connection_ingress_event (domain TEXT NOT NULL, app_id TEXT NOT NULL, event_id TEXT NOT NULL, ingress_id TEXT NOT NULL, event_json TEXT NOT NULL, raw_payload TEXT NOT NULL, PRIMARY KEY(domain, app_id, event_id));
    `))
  }
  private safe<T>(read: () => T): T {
    try { return read() } catch (error) {
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('External intake storage is unconfirmed. Do not acknowledge or replay input; inspect the original intake. Existing Agents remain available.', 'INGRESS_STORAGE_UNCONFIRMED')
    }
  }
  private transaction<T>(run: () => T): T {
    return this.safe(() => {
      this.database.exec('BEGIN IMMEDIATE')
      try { const result = run(); this.database.exec('COMMIT'); return result }
      catch (error) { try { this.database.exec('ROLLBACK') } catch { /* A lost commit ACK keeps original intake identities. */ } throw error }
    })
  }
  private read(ingressId: string): ConnectionIngressRecord | null {
    return this.safe(() => { const row = this.database.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=?').get(ingressId); return row ? parseConnectionIngressRecord(JSON.parse(String(row.record_json))) : null })
  }
  private write(record: ConnectionIngressRecord): ConnectionIngressRecord {
    const value = parseConnectionIngressRecord(record)
    this.database.prepare('UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(JSON.stringify(value), value.ingressId)
    return value
  }
  /** Authenticate, retain the complete original event, then ACK. ACK certifies persistence alone. */
  async receive(input: { connectionId: string; raw: string }, acknowledge: () => void | Promise<void>): Promise<{ ingress: ConnectionIngressRecord; duplicate: 'event' | 'message' | null }> {
    input = { ...input }
    const connection = this.options.connections.readConfiguration(input.connectionId)
    if (!connection?.config.enabled) fail('INGRESS_CONNECTION_UNAVAILABLE')
    const authenticator = this.authenticators.get(connection.config.adapterId)
    if (!authenticator || typeof input.raw !== 'string') fail('INGRESS_AUTHENTICATION_UNAVAILABLE')
    let event: VerifiedIngressEvent
    try { event = verified(await authenticator.verify(structuredClone(connection.config), input.raw)) }
    catch { return fail('INGRESS_AUTHENTICATION_FAILED') }
    if (!equal(event.actor.application, connection.config.application)) fail('INGRESS_ISSUER_MISMATCH')
    const saved = this.transaction(() => {
      const current = this.options.connections.readConfiguration(input.connectionId)
      if (!current?.config.enabled || current.revision !== connection.revision) fail('INGRESS_CONNECTION_REVISED')
      const { domain, appId } = current.config.application, encoded = JSON.stringify(event)
      const originalEvent = this.database.prepare('SELECT ingress_id,event_json FROM connection_ingress_event WHERE domain=? AND app_id=? AND event_id=?').get(domain, appId, event.eventId)
      if (originalEvent) {
        if (String(originalEvent.event_json) !== encoded) fail('INGRESS_EVENT_CONFLICT')
        return { ingress: this.read(String(originalEvent.ingress_id))!, duplicate: 'event' as const }
      }
      const originalMessage = this.database.prepare('SELECT ingress_id,event_json FROM connection_ingress_message WHERE domain=? AND app_id=? AND message_id=?').get(domain, appId, event.messageId)
      // A platform message may be redelivered under another event, but cannot replace its original body or author.
      const messageFacts = ({ eventId: _eventId, ...facts }: VerifiedIngressEvent) => facts
      if (originalMessage && !equal(messageFacts(JSON.parse(String(originalMessage.event_json))), messageFacts(event))) fail('INGRESS_MESSAGE_CONFLICT')
      const ingress = originalMessage ? this.read(String(originalMessage.ingress_id))! : parseConnectionIngressRecord({
        ingressId: `ingress:${randomUUID()}`, connectionId: input.connectionId, application: current.config.application,
        eventId: event.eventId, externalMessageId: event.messageId, externalConversationId: event.externalConversationId, actor: event.actor, body: event.body, state: 'received'
      })
      if (!originalMessage) this.database.prepare('INSERT INTO connection_ingress_message (ingress_id,domain,app_id,message_id,connection_id,event_json,record_json) VALUES (?,?,?,?,?,?,?)').run(ingress.ingressId, domain, appId, event.messageId, input.connectionId, encoded, JSON.stringify(ingress))
      this.database.prepare('INSERT INTO connection_ingress_event (domain,app_id,event_id,ingress_id,event_json,raw_payload) VALUES (?,?,?,?,?,?)').run(domain, appId, event.eventId, ingress.ingressId, encoded, input.raw)
      return { ingress, duplicate: originalMessage ? 'message' as const : null }
    })
    await acknowledge()
    return saved
  }
  private binding(record: ConnectionIngressRecord): RoomBinding | null {
    return this.options.bindings.listActive({ connectionId: record.connectionId }).find(binding => equal(binding.application, record.application) && binding.externalConversationId === record.externalConversationId) ?? null
  }
  private authorize(record: ConnectionIngressRecord, expected?: ConnectionIngressRecord['input']) {
    const connection = this.options.connections.readConfiguration(record.connectionId), binding = this.binding(record)
    if (!connection?.config.enabled || !equal(connection.config.application, record.application)) fail('INGRESS_CONNECTION_UNAVAILABLE')
    if (!binding) fail('INGRESS_BINDING_UNAVAILABLE')
    const grant = this.options.bindings.findGrant({ connectionId: record.connectionId, externalConversationId: record.externalConversationId, actor: record.actor })
    if (!grant || grant.state !== 'active' || grant.bindingId !== binding.bindingId || grant.bindingRevision !== binding.revision || !grant.capabilities.includes('input') || !equal(grant.actor, record.actor)) fail('INGRESS_ACTOR_NOT_AUTHORIZED')
    const event = JSON.parse(String(this.database.prepare('SELECT event_json FROM connection_ingress_message WHERE ingress_id=?').get(record.ingressId)!.event_json)) as VerifiedIngressEvent
    if (binding.scope.input === 'mentions-and-replies' && event.selection === 'message') fail('INGRESS_INPUT_OUTSIDE_SCOPE')
    const author = parseAgentExternalMessageAuthor({ kind: 'external', connectionId: record.connectionId, actor: record.actor, externalConversationId: record.externalConversationId, externalMessageId: record.externalMessageId, bindingId: binding.bindingId, bindingRevision: binding.revision, grantId: grant.grantId, grantRevision: grant.revision })
    if (expected && (expected.hostId !== binding.executionHostId || expected.agentSessionId !== binding.agentSessionId || !equal(expected.author, author))) fail('INGRESS_AUTHORITY_REVISED')
    return { binding, author }
  }
  private context(record: ConnectionIngressRecord): AgentInputCallContext {
    const ref = record.input!
    return { externalAuthor: { identity: ref.author, assertCurrent: intent => {
      if (intent.agentSessionId !== ref.agentSessionId || !equal(intent.expectedRun, ref.expectedRun) || intent.operationId !== ref.operationId || intent.messageId !== ref.messageId || intent.body !== record.body) fail('INGRESS_INPUT_MISMATCH')
      this.safe(() => this.authorize(record, ref))
    } } }
  }
  async dispatch(ingressId: string): Promise<ConnectionIngressInspection> {
    const active = this.pending.get(ingressId)
    if (active) return await active
    const work = this.deliver(ingressId).finally(() => this.pending.delete(ingressId))
    this.pending.set(ingressId, work)
    return await work
  }
  private async deliver(ingressId: string): Promise<ConnectionIngressInspection> {
    const record = this.read(ingressId)
    if (!record) fail('UNKNOWN_CONNECTION_INGRESS')
    if (record.state !== 'received') return await this.inspect({ ingressId })
    let original: ReturnType<DurableIngressHost['authorize']>
    try { original = this.safe(() => this.authorize(record)) }
    catch (error) {
      if (!(error instanceof AgentMuxError) || error.code === 'INGRESS_STORAGE_UNCONFIRMED') throw error
      this.transaction(() => { const current = this.read(ingressId)!; if (current.state === 'received') this.write({ ...current, state: 'refused', code: error.code }) })
      return await this.inspect({ ingressId })
    }
    const client = this.options.core(original.binding.executionHostId)
    if (!client) fail('INGRESS_CORE_UNAVAILABLE')
    let expectedRun: { runId: string } | undefined
    await client.metadata.read(original.binding.agentSessionId, session => { if (session) expectedRun = { ...session.run } })
    if (!expectedRun) fail('INGRESS_TARGET_UNCONFIRMED')
    const claimed = this.transaction(() => {
      const current = this.read(ingressId)!
      if (current.state !== 'received') return { record: current, own: false }
      const frozen = { hostId: original.binding.executionHostId, agentSessionId: original.binding.agentSessionId, expectedRun: expectedRun!, operationId: `ingress-operation-${randomUUID()}`, messageId: `ingress-message-${randomUUID()}`, author: original.author }
      this.authorize(current, frozen)
      return { record: this.write({ ...current, state: 'claimed', input: frozen }), own: true }
    })
    if (!claimed.own) return await this.inspect({ ingressId })
    const ref = claimed.record.input!
    const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: ref.messageId, operationId: ref.operationId, createdAt: Date.now(),
      sender: ref.author, recipient: { kind: 'agent-session', agentSessionId: ref.agentSessionId }, threadId: JSON.stringify(['external', record.application.domain, record.application.appId, record.externalConversationId]), correlationId: JSON.stringify(['external', record.application.domain, record.application.appId, record.externalMessageId]), replyTo: null, workspaceId: null, senderSessionId: null, senderRunId: null, recipientSessionId: ref.agentSessionId, recipientRunId: ref.expectedRun.runId, body: record.body }
    try {
      await client.submitAgentMessage({ agentSessionId: ref.agentSessionId, envelope, admissionIntent: { kind: 'manual-actor', expectedRun: ref.expectedRun }, execution: 'immediate', sourceChannel: 'agent-message' }, this.context(claimed.record))
    } catch { /* A Core call may have saved or dispatched input. Only inspect this original operation. */ }
    return await this.inspect({ ingressId })
  }
  async inspect(value: { ingressId: string }): Promise<ConnectionIngressInspection> {
    const input = parseIngressParams('connection.ingress.inspect', value), ingress = this.read(input.ingressId)
    if (!ingress?.input) return { ingress, inputReceipt: null, observation: 'not-started' }
    try {
      const client = this.options.core(ingress.input.hostId)
      if (!client) return { ingress, inputReceipt: null, observation: 'unavailable' }
      const inputReceipt = await client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: ingress.input.operationId })
      return parseIngressResult('connection.ingress.inspect', { ingress, inputReceipt, observation: 'observed' }, input)
    } catch { return { ingress, inputReceipt: null, observation: 'unavailable' } }
  }
  /** Explicitly rejoin a positively saved original Core wait; unknown effects are read only. */
  async rejoin(ingressId: string): Promise<ConnectionIngressInspection> {
    const original = await this.inspect({ ingressId })
    if (original.ingress?.input && original.inputReceipt?.control.state === 'enabled') {
      const client = this.options.core(original.ingress.input.hostId)
      if (!client) fail('INGRESS_CORE_UNAVAILABLE')
      await client.rejoinAgentInputWaiting({ ref: original.inputReceipt.ref }, this.context(original.ingress))
    }
    return await this.inspect({ ingressId })
  }
  async list(value: ConnectionIngressListInput) {
    const input = parseIngressParams('connection.ingress.ls', value)
    return this.safe(() => {
      const after = input.afterIngressId ? this.database.prepare('SELECT sequence FROM connection_ingress_message WHERE ingress_id=? AND connection_id=?' + (input.bindingId ? " AND json_extract(record_json,'$.input.author.bindingId')=?" : '')).get(input.afterIngressId, input.connectionId, ...(input.bindingId ? [input.bindingId] : [])) : undefined
      if (input.afterIngressId && !after) fail('INGRESS_CURSOR_MISMATCH')
      const rows = this.database.prepare('SELECT record_json FROM connection_ingress_message WHERE connection_id=? AND sequence>? ' + (input.bindingId ? "AND json_extract(record_json,'$.input.author.bindingId')=? " : '') + 'ORDER BY sequence LIMIT ?').all(input.connectionId, Number(after?.sequence ?? 0), ...(input.bindingId ? [input.bindingId] : []), (input.limit ?? 25) + 1)
      const ingresses = rows.slice(0, input.limit ?? 25).map(row => parseConnectionIngressRecord(JSON.parse(String(row.record_json))))
      return { ingresses, nextAfterIngressId: rows.length > ingresses.length ? ingresses.at(-1)!.ingressId : null }
    })
  }
}
