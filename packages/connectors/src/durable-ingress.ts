import { grantAuthorReference } from './effective-grant.js'
import { parseExternalConversationReference, type AgentExternalAuthoritySource, type AgentExternalConversationAuthority, type AgentExternalConversationReference } from '@agentmux/core'
import { isDeepStrictEqual } from 'node:util'
import { ConversationActions, externalActionIntentDigest } from './conversation-actions.js'
import { parseConnectionQuestionAnswerSubmissions } from '@agentmux/core/connections'
import { mintObjectId, AgentMuxError, parseAgentExternalMessageAuthor, agentInteractionIntentDigest, type AgentInputCallContext, type AgentMuxClient, type AgentMuxMessageEnvelope } from '@agentmux/core'
import { CONNECTION_INGRESS_AUTHORITY_CODES, connectionDiagnosisIntakeCodes, parseConnectionActor, parseConnectionIngressRecord, parseIngressParams, parseIngressResult, type ConnectionConfig, type ConnectionIngressAuthority, type ConnectionIngressAuthorityCode, type ConnectionIngressInspection, type ConnectionIngressListInput, type ConnectionIngressMessage, type ConnectionIngressAction, type ConnectionIngressReadPort, type ConnectionIngressRecord, type RoomBinding, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { parseChannelTranscriptQuote, type ChannelQuoteRange, type ChannelTranscriptQuote, type AgentSessionHistorySource } from '@agentmux/core'
import { IngressContextPositions, unavailableChannelQuote } from './ingress-context.js'

/** Returned only by a Host-registered adapter after verifying the original transport proof. */
export type VerifiedIngressMessage = {
  kind?: never
  eventId: string; messageId: string; externalConversationId: string
  conversationKind?: 'direct' | 'group'
  actor: import('@agentmux/core/connections').ConnectionActor
  body: string
  /** Original platform addressing facts, not body matching. */
  selection: 'mention' | 'reply' | 'message'
  /** Frozen native parent identity; its presence alone never qualifies a bot reply. */
  replyToMessageId?: string
  /** No text projection exists; retain the complete raw event and refuse only this input. */
  unsupportedContent?: true
}
export type VerifiedIngressAction = Pick<import('@agentmux/core/connections').ConnectionIngressAction,
  'kind' | 'eventId' | 'actor' | 'externalConversationId' | 'sourceMessageId' | 'actionRef' | 'answers'>
export type VerifiedIngressEvent = VerifiedIngressMessage | VerifiedIngressAction
export type ConnectionQuestionFormInput = {
  connectionId: string; application: ConnectionConfig['application']; actor: NonNullable<ConnectionIngressAction['actor']>
  externalConversationId: string; sourceMessageId: string; actionRef: string
}
export type ConnectionQuestionForm = { questions: import('@agentmux/core').AgentSessionHistoryQuestion[]; status: 'pending' }
export interface IngressAuthenticator {
  readonly adapterId: string
  /** Own signature/token verification and issuer checks. Never expose this port over RPC. */
  verify(config: ConnectionConfig, raw: string, transportProof?: unknown): Promise<VerifiedIngressEvent>
  /** Read the exact parent after persistence/ACK, outside original Core input admission. */
  qualifyReply?(config: ConnectionConfig, event: Readonly<VerifiedIngressEvent>, raw: string, credential: string, signal: AbortSignal): Promise<'reply' | 'message' | 'unknown'>
  /** Native history is quoted data, never another authenticated input or grant. */
  readHistory?(config: ConnectionConfig, input: { externalConversationId: string; range: ChannelQuoteRange; knownThreadIds?: string[]; assertCurrent?(): void }, credential: string, signal: AbortSignal): Promise<ChannelTranscriptQuote>
}
export type DurableIngressCore = Pick<AgentMuxClient, 'recordExternalConversationMessage' | 'submitAgentMessage' | 'inspectAgentInput' | 'rejoinAgentInputWaiting'> & Partial<Pick<AgentMuxClient, 'agentSession' | 'onEvent' | 'respondAgentInteraction' | 'inspectAgentInteractionOperation' | 'replySessionQuestion' | 'inspectAgentPromptSubmission'>> & {
  readAgentSession(id: string, expectedRuntimeId?: string): ReturnType<AgentMuxClient['readAgentSession']>
  providers?: { get(id: string): { catalog: import('@agentmux/core').AgentCatalogEntry } }
}
export type DurableIngressOptions = {
  connections: ConnectionHost
  bindings: RoomBindingReadPort
  authenticators: readonly IngressAuthenticator[]
  /** Resolve only an authenticated, retained, unclaimed input before borrowing Core. */
  prepareInput?(record: ConnectionIngressMessage): Promise<{ state: 'ready' } | { state: 'refused'; code: string }>
  /** Optional publication feedback follows authorized intake, never owns Agent input. */
  queryReceived?(binding: RoomBinding, record: ConnectionIngressMessage): void
  /** Borrow original confirmed publication identities; never a second history or authority owner. */
  contextPublications?: Pick<import('./publication-store.js').PublicationStore, 'knownContextMessages'>
  /** Return the original executing Host's client; Region occupants and focus are not routes. */
  core(hostId: string, executionRuntimeId?: string): DurableIngressCore | undefined
  /** Existing confirmed configured-owner metadata only; never performs I/O before native ACK. */
  authoritySource?(hostId: string, executionRuntimeId?: string): AgentExternalAuthoritySource | undefined
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const intakeRows = 'SELECT sequence,connection_id,ingress_id,record_json FROM connection_ingress_message UNION ALL SELECT intake_sequence AS sequence,connection_id,ingress_id,record_json FROM connection_ingress_event WHERE record_json IS NOT NULL'
const unfinishedIntake = "(json_extract(record_json,'$.state')='received' OR (COALESCE(json_extract(record_json,'$.code'),'')!='INGRESS_CONTENT_UNSUPPORTED' AND json_extract(record_json,'$.group.target.agentSessionId') IS NOT NULL AND json_extract(record_json,'$.group.recorded') IS NULL AND COALESCE(json_extract(record_json,'$.group.recording.state'),'')!='refused'))"
function fail(code: string): never { throw new AgentMuxError('This external intake cannot use the original target or authority. Existing Agents and inputs are retained.', code) }
function verified(value: VerifiedIngressEvent): VerifiedIngressEvent {
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail('INVALID_CONNECTION_INGRESS'); return v as string }
  if (value.kind === 'action') return { kind: 'action', eventId: text(value.eventId),
    ...(value.actor === undefined ? {} : { actor: parseConnectionActor(value.actor) }),
    ...(value.externalConversationId === undefined ? {} : { externalConversationId: text(value.externalConversationId) }),
    ...(value.sourceMessageId === undefined ? {} : { sourceMessageId: text(value.sourceMessageId) }),
    ...(value.actionRef === undefined ? {} : { actionRef: text(value.actionRef) }),
    ...(value.answers === undefined ? {} : { answers: parseConnectionQuestionAnswerSubmissions(value.answers) }) }
  if (value.kind !== undefined || typeof value.body !== 'string' || !['mention', 'reply', 'message'].includes(value.selection)) fail('INVALID_CONNECTION_INGRESS')
  if (value.conversationKind !== undefined && !['direct', 'group'].includes(value.conversationKind)) fail('INVALID_CONNECTION_INGRESS')
  if (value.unsupportedContent !== undefined && value.unsupportedContent !== true) fail('INVALID_CONNECTION_INGRESS')
  return { eventId: text(value.eventId), messageId: text(value.messageId), externalConversationId: text(value.externalConversationId), actor: parseConnectionActor(value.actor), body: value.body, selection: value.selection, ...(value.conversationKind === undefined ? {} : { conversationKind: value.conversationKind }),
    ...(value.replyToMessageId === undefined ? {} : { replyToMessageId: text(value.replyToMessageId) }), ...(value.unsupportedContent ? { unsupportedContent: true } : {}) }
}

/** Durable transport admission only. The original Core queue owns all Agent input and delivery facts. */
export class DurableIngressHost implements ConnectionIngressReadPort {
  readonly permissions: ConversationActions
  /** Host-private read for a native modal; submitting still enters the original durable action owner. */
  questionForm(input: ConnectionQuestionFormInput): ConnectionQuestionForm | null { return this.permissions.questionForm(input) }
  private readonly database
  private readonly authenticators: Map<string, IngressAuthenticator>
  private readonly pending = new Map<string, Promise<ConnectionIngressInspection>>()
  private contextPositions: IngressContextPositions | undefined
  private readonly historyAbort = new AbortController()
  constructor(private readonly options: DurableIngressOptions) {
    this.permissions = new ConversationActions(options)
    this.database = options.connections.database
    this.authenticators = new Map(options.authenticators.map(port => [port.adapterId, port]))
    if (this.authenticators.size !== options.authenticators.length) fail('INGRESS_AUTHENTICATOR_CONFLICT')
    this.safe(() => this.database.exec(`
      CREATE TABLE IF NOT EXISTS connection_ingress_message (sequence INTEGER PRIMARY KEY AUTOINCREMENT, ingress_id TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL, connection_id TEXT NOT NULL, event_json TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(domain, app_id, message_id));
      CREATE TABLE IF NOT EXISTS connection_ingress_event (domain TEXT NOT NULL, app_id TEXT NOT NULL, event_id TEXT NOT NULL, ingress_id TEXT NOT NULL, event_json TEXT NOT NULL, raw_payload TEXT NOT NULL, PRIMARY KEY(domain, app_id, event_id));
      CREATE INDEX IF NOT EXISTS connection_ingress_query_input ON connection_ingress_message(json_extract(record_json,'$.input.hostId'),json_extract(record_json,'$.input.agentSessionId'),json_extract(record_json,'$.input.expectedRun.runId'),json_extract(record_json,'$.input.messageId'));
      CREATE INDEX IF NOT EXISTS connection_ingress_received ON connection_ingress_message(connection_id,sequence) WHERE json_extract(record_json,'$.state')='received';
      CREATE INDEX IF NOT EXISTS connection_ingress_direct_application ON connection_ingress_message(domain,app_id,sequence) WHERE json_extract(record_json,'$.conversationKind')='direct';
      CREATE UNIQUE INDEX IF NOT EXISTS connection_ingress_input_operation ON connection_ingress_message(json_extract(record_json,'$.input.operationId')) WHERE json_extract(record_json,'$.input.operationId') IS NOT NULL;
    `))
    // Action receipts belong to the original authenticated event, not a fabricated platform message.
    this.transaction(() => {
      const columns = this.database.prepare('PRAGMA table_info(connection_ingress_event)').all().map(column => column.name)
      for (const [name, type] of [['record_json', 'TEXT'], ['connection_id', 'TEXT'], ['intake_sequence', 'INTEGER']]) {
        if (!columns.includes(name)) this.database.exec(`ALTER TABLE connection_ingress_event ADD COLUMN ${name} ${type}`)
      }
      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS connection_ingress_action_sequence ON connection_ingress_event(intake_sequence) WHERE record_json IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS connection_ingress_action_identity ON connection_ingress_event(ingress_id) WHERE record_json IS NOT NULL; CREATE INDEX IF NOT EXISTS connection_ingress_action_connection ON connection_ingress_event(connection_id,intake_sequence) WHERE record_json IS NOT NULL; CREATE INDEX IF NOT EXISTS connection_ingress_message_connection ON connection_ingress_message(connection_id,sequence); CREATE INDEX IF NOT EXISTS connection_ingress_message_audience ON connection_ingress_message(domain,app_id,json_extract(record_json,'$.externalConversationId'),sequence); CREATE INDEX IF NOT EXISTS connection_ingress_event_audience ON connection_ingress_event(domain,app_id,json_extract(record_json,'$.externalConversationId'),intake_sequence) WHERE record_json IS NOT NULL;`)
      this.database.exec(`CREATE INDEX IF NOT EXISTS connection_ingress_unfinished_message ON connection_ingress_message(connection_id,sequence) WHERE ${unfinishedIntake}; CREATE INDEX IF NOT EXISTS connection_ingress_unfinished_action ON connection_ingress_event(connection_id,intake_sequence) WHERE record_json IS NOT NULL AND ${unfinishedIntake};`)
    })
    try { this.contextPositions = new IngressContextPositions(this.database) }
    catch { /* Each original preparation exposes this metadata observation gap. */ }
  }
  /** Cancels only optional original history observation, never an Agent or a Core input. */
  close(): void { this.historyAbort.abort() }
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
    return this.safe(() => { const row = this.database.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=? UNION ALL SELECT record_json FROM connection_ingress_event WHERE ingress_id=? AND record_json IS NOT NULL').get(ingressId, ingressId); return row ? parseConnectionIngressRecord(JSON.parse(String(row.record_json))) : null })
  }
  private nextSequence(): number {
    return Number(this.database.prepare('SELECT max(sequence) AS sequence FROM (SELECT max(sequence) AS sequence FROM connection_ingress_message UNION ALL SELECT max(intake_sequence) AS sequence FROM connection_ingress_event WHERE record_json IS NOT NULL)').get()!.sequence ?? 0) + 1
  }
  private write<T extends ConnectionIngressRecord>(record: T): T {
    const value = parseConnectionIngressRecord(record)
    this.database.prepare(value.kind === 'action' ? 'UPDATE connection_ingress_event SET record_json=? WHERE ingress_id=? AND record_json IS NOT NULL' : 'UPDATE connection_ingress_message SET record_json=? WHERE ingress_id=?').run(JSON.stringify(value), value.ingressId)
    return value as T
  }
  private assertService(connectionId: string): void {
    const connection = this.options.connections.readConfiguration(connectionId)
    if (!connection) fail('INGRESS_CONNECTION_UNAVAILABLE')
    try { this.options.connections.assertServiceEnabled(connection.config.adapterId) }
    catch (error) { fail(error instanceof AgentMuxError && error.code === 'CONNECTION_SERVICE_DISABLED' ? 'INGRESS_SERVICE_DISABLED' : 'INGRESS_SERVICE_UNCONFIRMED') }
  }
  /** Authenticate, retain the complete original event, then ACK. ACK certifies persistence alone. */
  async receive(input: { connectionId: string; raw: string; transportProof?: unknown }, acknowledge: () => void | Promise<void>): Promise<{ ingress: ConnectionIngressRecord; duplicate: 'event' | 'message' | null }> {
    input = { ...input }
    this.assertService(input.connectionId)
    const connection = this.options.connections.readConfiguration(input.connectionId)
    if (!connection?.config.enabled) fail('INGRESS_CONNECTION_UNAVAILABLE')
    const authenticator = this.authenticators.get(connection.config.adapterId)
    if (!authenticator || typeof input.raw !== 'string') fail('INGRESS_AUTHENTICATION_UNAVAILABLE')
    let event: VerifiedIngressEvent
    try { event = verified(await authenticator.verify(structuredClone(connection.config), input.raw, input.transportProof)) }
    catch { return fail('INGRESS_AUTHENTICATION_FAILED') }
    if (event.actor && !equal(event.actor.application, connection.config.application)) fail('INGRESS_ISSUER_MISMATCH')
    const saved = this.transaction(() => {
      this.assertService(input.connectionId)
      const current = this.options.connections.readConfiguration(input.connectionId)
      if (!current?.config.enabled || current.revision !== connection.revision) fail('INGRESS_CONNECTION_REVISED')
      const { domain, appId } = current.config.application, encoded = JSON.stringify(event)
      const originalEvent = this.database.prepare('SELECT ingress_id,event_json,raw_payload FROM connection_ingress_event WHERE domain=? AND app_id=? AND event_id=?').get(domain, appId, event.eventId)
      if (originalEvent) {
        if (String(originalEvent.event_json) !== encoded || event.kind === 'action' && String(originalEvent.raw_payload) !== input.raw) fail('INGRESS_EVENT_CONFLICT')
        return { ingress: this.read(String(originalEvent.ingress_id))!, duplicate: 'event' as const }
      }
      if (event.kind === 'action') {
        const ingress = parseConnectionIngressRecord({ ...event, ingressId: mintObjectId(), connectionId: input.connectionId,
          application: current.config.application, ...(this.permissions.supports(event) ? { state: 'received' } : { state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED' }) })
        this.database.prepare('INSERT INTO connection_ingress_event (domain,app_id,event_id,ingress_id,event_json,raw_payload,record_json,connection_id,intake_sequence) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(domain, appId, event.eventId, ingress.ingressId, encoded, input.raw, JSON.stringify(ingress), input.connectionId, this.nextSequence())
        return { ingress, duplicate: null }
      }
      const originalMessage = this.database.prepare('SELECT ingress_id,event_json FROM connection_ingress_message WHERE domain=? AND app_id=? AND message_id=?').get(domain, appId, event.messageId)
      // A platform message may be redelivered under another event, but cannot replace its original body or author.
      const messageFacts = ({ eventId: _eventId, ...facts }: VerifiedIngressMessage) => facts
      if (originalMessage && !equal(messageFacts(JSON.parse(String(originalMessage.event_json))), messageFacts(event))) fail('INGRESS_MESSAGE_CONFLICT')
      const ingress = originalMessage ? this.read(String(originalMessage.ingress_id))! : parseConnectionIngressRecord({
        ingressId: mintObjectId(), connectionId: input.connectionId, application: current.config.application,
        eventId: event.eventId, externalMessageId: event.messageId, externalConversationId: event.externalConversationId, actor: event.actor, body: event.body, ...(event.conversationKind === undefined ? {} : { conversationKind: event.conversationKind }),
        ...(event.conversationKind === 'group' ? { group: { target: this.freezeGroup(current.config.application, event.externalConversationId) } } : {}),
        ...(event.unsupportedContent ? { state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED' } : { state: 'received' })
      })
      if (!originalMessage) this.database.prepare('INSERT INTO connection_ingress_message (sequence,ingress_id,domain,app_id,message_id,connection_id,event_json,record_json) VALUES (?,?,?,?,?,?,?,?)').run(this.nextSequence(), ingress.ingressId, domain, appId, event.messageId, input.connectionId, encoded, JSON.stringify(ingress))
      this.database.prepare('INSERT INTO connection_ingress_event (domain,app_id,event_id,ingress_id,event_json,raw_payload) VALUES (?,?,?,?,?,?)').run(domain, appId, event.eventId, ingress.ingressId, encoded, input.raw)
      return { ingress, duplicate: originalMessage ? 'message' as const : null }
    })
    await acknowledge()
    // Let the transport finish its native ACK before optional profile I/O. A
    // failed/missing profile is never part of the original input admission.
    if (event.actor) setImmediate(() => { void this.options.connections.observeChannelActor(connection.config, event.actor!).catch(() => {}) })
    if (event.kind !== 'action' && event.conversationKind === 'group') setImmediate(() => { void this.options.connections.observeChannelConversation(connection.config, event.externalConversationId).catch(() => {}) })
    return saved
  }
  private freezeGroup(application: ConnectionConfig['application'], externalConversationId: string): NonNullable<ConnectionIngressMessage['group']>['target'] {
    const binding = this.options.bindings.findActiveAudience({ application, externalConversationId })
    const source = binding && (binding.executionHostId === 'local' || binding.executionRuntimeId)
      ? this.options.authoritySource?.(binding.executionHostId, binding.executionRuntimeId) : undefined
    return binding ? { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, ...(source ? { authoritySource: source } : {}) } : null
  }
  /** The original source owner resolves attribution; callers supply only its immutable ingress reference. */
  async recordAuthority(value: AgentExternalConversationReference): Promise<AgentExternalConversationAuthority> {
    const input = parseExternalConversationReference(value)
    let message: AgentExternalConversationAuthority['message'] = null
    try {
      return this.safe(() => {
        const record = this.read(input.ingressId), target = record?.kind !== 'action' ? record?.group?.target : undefined
        if (!record || record.kind === 'action' || !target || target.agentSessionId !== input.agentSessionId || record.code === 'INGRESS_CONTENT_UNSUPPORTED') return { message, authority: 'refused', code: 'INGRESS_BINDING_UNAVAILABLE' }
        if (!isDeepStrictEqual(input.authoritySource, target.authoritySource)) fail('INGRESS_AUTHORITY_REVISED')
        message = { agentSessionId: target.agentSessionId, ingressId: record.ingressId, ...(target.authoritySource ? { authoritySource: target.authoritySource } : {}), hostId: target.hostId, body: record.body,
          inputMetadata: { ingressId: record.ingressId, state: record.state, ...(record.code && connectionDiagnosisIntakeCodes.includes(record.code as never) ? { code: record.code as typeof connectionDiagnosisIntakeCodes[number] } : {}) }, author: {
          kind: 'external', connectionId: target.connectionId, actor: record.actor, externalConversationId: record.externalConversationId, externalMessageId: record.externalMessageId, bindingId: target.bindingId, bindingRevision: target.bindingRevision, ...(target.authoritySource ? { authoritySource: target.authoritySource } : {})
        } }
        this.assertService(record.connectionId)
        if (target.connectionId !== record.connectionId) this.assertService(target.connectionId)
        const binding = this.binding(record), current = binding && this.options.bindings.readCurrent(binding.bindingId)
        const connection = this.options.connections.readConfiguration(target.connectionId), receiver = this.options.connections.readConfiguration(record.connectionId)
        if (!binding || !current || current.state !== 'active' || current.revision !== binding.revision || binding.agentSessionId !== target.agentSessionId || binding.executionHostId !== target.hostId || binding.connectionId !== target.connectionId || binding.executionRuntimeId && binding.executionRuntimeId !== target.authoritySource?.executionRuntimeId) fail('INGRESS_BINDING_UNAVAILABLE')
        if (!connection?.config.enabled || !receiver?.config.enabled || !equal(connection.config.application, record.application) || !equal(receiver.config.application, record.application)) fail('INGRESS_CONNECTION_UNAVAILABLE')
        return { message, authority: 'current' }
      })
    } catch (error) {
      const code = error instanceof AgentMuxError ? error.code : 'INGRESS_STORAGE_UNCONFIRMED'
      return { message, authority: ['INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED'].includes(code) ? 'unavailable' : 'refused', code }
    }
  }
  private async recordGroup(record: ConnectionIngressMessage): Promise<ConnectionIngressMessage> {
    const target = record.group?.target
    if (!target) return record
    const client = this.options.core(target.hostId, target.authoritySource?.executionRuntimeId)
    if (!client) fail('INGRESS_CORE_UNAVAILABLE')
    if (this.options.authoritySource && target.hostId !== 'local' && !target.authoritySource) fail('INGRESS_TARGET_UNCONFIRMED')
    if (target.authoritySource && !isDeepStrictEqual(target.authoritySource, this.options.authoritySource?.(target.hostId, target.authoritySource.executionRuntimeId))) fail('INGRESS_TARGET_UNCONFIRMED')
    const receipt = await client.recordExternalConversationMessage({ agentSessionId: target.agentSessionId, ingressId: record.ingressId, ...(target.authoritySource ? { authoritySource: target.authoritySource } : {}) })
    return this.transaction(() => {
      const current = this.read(record.ingressId)
      if (!current || current.kind === 'action' || !current.group || !equal(current.group.target, target)) fail('INGRESS_AUTHORITY_REVISED')
      if (!current.group.recording && isDeepStrictEqual(current.group.recorded, receipt)) return current
      const { recording: _recording, ...group } = current.group
      return this.write({ ...current, group: { ...group, recorded: receipt } })
    })
  }
  private binding(record: ConnectionIngressMessage): RoomBinding | null {
    if (record.conversationKind === 'group') return record.group?.target ? this.options.bindings.readExact(record.group.target.bindingId, record.group.target.bindingRevision) : null
    return this.options.bindings.findActiveAudience({ application: record.application, externalConversationId: record.externalConversationId })
  }
  private authorize(record: ConnectionIngressMessage, expected?: ConnectionIngressMessage['input'], allowPendingReply = false) {
    this.assertService(record.connectionId)
    const connection = this.options.connections.readConfiguration(record.connectionId)
    const binding = expected ? this.options.bindings.readExact(expected.author.bindingId, expected.author.bindingRevision) : this.binding(record)
    const current = binding ? this.options.bindings.readCurrent(binding.bindingId) : null
    if (!current || current.state !== 'active' || current.revision !== binding?.revision) fail('INGRESS_BINDING_UNAVAILABLE')
    if (!connection?.config.enabled || !equal(connection.config.application, record.application)) fail('INGRESS_CONNECTION_UNAVAILABLE')
    if (!binding) fail('INGRESS_BINDING_UNAVAILABLE')
    const target = binding.connectionId === record.connectionId ? connection : this.options.connections.readConfiguration(binding.connectionId)
    if (!target?.config.enabled || !equal(target.config.application, record.application)) fail('INGRESS_CONNECTION_UNAVAILABLE')
    if (binding.connectionId !== record.connectionId) this.assertService(binding.connectionId)
    const grant = this.options.bindings.effectiveGrant(binding.bindingId, binding.revision, record.actor)
    if (!grant || grant.state !== 'active' || !grant.capabilities.includes('input') || !equal(grant.actor, record.actor)) fail('INGRESS_ACTOR_NOT_AUTHORIZED')
    const event = JSON.parse(String(this.database.prepare('SELECT event_json FROM connection_ingress_message WHERE ingress_id=?').get(record.ingressId)!.event_json)) as VerifiedIngressMessage
    const qualifiedReply = record.addressing?.state === 'confirmed' && record.addressing.selection === 'reply' && record.addressing.replyToMessageId === event.replyToMessageId
    if (binding.scope.input === 'mentions-and-replies' && event.selection === 'message' && !qualifiedReply) {
      if (!event.replyToMessageId || record.addressing?.state === 'confirmed') fail('INGRESS_INPUT_OUTSIDE_SCOPE')
      if (!allowPendingReply) fail('INGRESS_ADDRESSING_UNCONFIRMED')
    }
    const source = expected ? expected.author.authoritySource : record.group ? record.group.target?.authoritySource
      : binding.executionHostId === 'local' || binding.executionRuntimeId ? this.options.authoritySource?.(binding.executionHostId, binding.executionRuntimeId) : undefined
    if (this.options.authoritySource && binding.executionHostId !== 'local' && !source) fail('INGRESS_TARGET_UNCONFIRMED')
    if (source && !isDeepStrictEqual(source, this.options.authoritySource?.(binding.executionHostId, binding.executionRuntimeId))) fail('INGRESS_TARGET_UNCONFIRMED')
    const author = parseAgentExternalMessageAuthor({ kind: 'external', connectionId: binding.connectionId, actor: record.actor, externalConversationId: record.externalConversationId, externalMessageId: record.externalMessageId, bindingId: binding.bindingId, bindingRevision: binding.revision, ...grantAuthorReference(grant), ...(source ? { authoritySource: source } : {}) })
    if (expected?.admissionIntent) { const { expectedRun: _run, ...target } = expected.admissionIntent; if (!isDeepStrictEqual(target, binding.inputTarget ?? { kind: 'manual-actor' })) fail('INGRESS_AUTHORITY_REVISED') }
    if (expected && (expected.hostId !== binding.executionHostId || expected.agentSessionId !== binding.agentSessionId || !equal(expected.author, author))) fail('INGRESS_AUTHORITY_REVISED')
    return { binding, author, event }
  }
  private async qualifyReply(record: ConnectionIngressMessage, event: VerifiedIngressMessage): Promise<ConnectionIngressMessage> {
    if (record.addressing?.state === 'confirmed') return record
    const replyToMessageId = event.replyToMessageId!, connection = this.options.connections.readConfiguration(record.connectionId)
    if (!connection?.config.enabled || !equal(connection.config.application, record.application)) fail('INGRESS_CONNECTION_UNAVAILABLE')
    const authenticator = this.authenticators.get(connection.config.adapterId)
    let addressing: NonNullable<ConnectionIngressRecord['addressing']> = { replyToMessageId, state: 'unknown', reason: 'reply-unconfirmed' }
    if (!authenticator?.qualifyReply) addressing = { replyToMessageId, state: 'unavailable', reason: 'adapter-unavailable' }
    else {
      const raw = this.safe(() => String(this.database.prepare('SELECT raw_payload FROM connection_ingress_event WHERE domain=? AND app_id=? AND event_id=?').get(record.application.domain, record.application.appId, record.eventId)!.raw_payload))
      let timer: ReturnType<typeof setTimeout> | undefined
      const controller = new AbortController()
      try {
        const unknown = { replyToMessageId, state: 'unknown' as const, reason: 'reply-unconfirmed' as const }
        const timeout = new Promise<typeof addressing>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unknown) }, 5_000); timer.unref?.() })
        const observe = async (): Promise<typeof addressing> => {
          const credential = await this.options.connections.resolveCredential(record.connectionId)
          if (controller.signal.aborted) return unknown
          if (!credential) return { replyToMessageId, state: 'unavailable', reason: 'credential-missing' }
          this.assertService(record.connectionId)
          const selection = await authenticator.qualifyReply!(structuredClone(connection.config), structuredClone(event), raw, credential, controller.signal)
          return !controller.signal.aborted && (selection === 'reply' || selection === 'message') ? { replyToMessageId, state: 'confirmed', selection } : unknown
        }
        addressing = await Promise.race([observe(), timeout])
      } catch { /* A parent read failure is an observation gap, never an outside-scope verdict. */ }
      finally { if (timer) clearTimeout(timer); controller.abort() }
    }
    return this.transaction(() => {
      const current = this.read(record.ingressId)!
      if (current.kind === 'action') fail('INVALID_CONNECTION_INGRESS')
      if (current.state !== 'received' || current.addressing?.state === 'confirmed') return current
      return this.write({ ...current, addressing })
    })
  }
  private context(record: ConnectionIngressMessage): AgentInputCallContext {
    const ref = record.input!
    return { externalAuthor: { identity: ref.author, assertCurrent: intent => {
      if (intent.agentSessionId !== ref.agentSessionId || !equal(intent.expectedRun, ref.expectedRun) || intent.operationId !== ref.operationId || intent.messageId !== ref.messageId || intent.body !== record.body || !ref.admissionIntent || !isDeepStrictEqual(intent.admissionIntent, ref.admissionIntent) || !isDeepStrictEqual(intent.channelQuote, ref.channelQuote)) fail('INGRESS_INPUT_MISMATCH')
      this.safe(() => this.authorize(record, ref))
    } } }
  }
  private nativeContextSource(binding: RoomBinding, session: Awaited<ReturnType<DurableIngressCore['readAgentSession']>>): AgentSessionHistorySource | undefined {
    if (binding.inputTarget?.kind === 'native-conversation') return structuredClone(binding.inputTarget.source)
    const handle = session?.nativeHandle
    return handle?.kind === 'provider' && !session?.nativeSourceObservation
      ? { providerId: handle.providerId, nativeSessionId: handle.sessionId } : undefined
  }
  private async prepareQuote(record: ConnectionIngressMessage, binding: RoomBinding, client: DurableIngressCore,
    contextSource?: AgentSessionHistorySource, receiverSignal?: AbortSignal): Promise<ChannelTranscriptQuote> {
    let range: ChannelQuoteRange = { from: null, throughMessageId: record.externalMessageId, origin: 'first-observed' }
    try {
      this.contextPositions ??= new IngressContextPositions(this.database)
      if (this.contextPositions && contextSource) await this.contextPositions.reconcile({ bindingId: binding.bindingId,
        bindingRevision: binding.revision, hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, source: contextSource },
        operationId => client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: operationId }))
      if (this.contextPositions) range = this.contextPositions.range(record, binding, contextSource)
      else return unavailableChannelQuote(record, range, 'context-position-unavailable')
    } catch { return unavailableChannelQuote(record, range, 'context-position-unavailable') }
    const connection = this.options.connections.readConfiguration(record.connectionId)
    const reader = connection && this.authenticators.get(connection.config.adapterId)?.readHistory
    if (!connection || !reader) return unavailableChannelQuote(record, range, 'native-history-unsupported')
    let credential: string | null
    try { credential = await this.options.connections.resolveCredential(record.connectionId) }
    catch { return unavailableChannelQuote(record, range, 'native-history-credential-unavailable') }
    if (!credential) return unavailableChannelQuote(record, range, 'native-history-credential-missing')
    const signal = receiverSignal ? AbortSignal.any([this.historyAbort.signal, receiverSignal]) : this.historyAbort.signal
    const originalAuthor = this.authorize(record).author
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (this.options.connections.readConfiguration(record.connectionId)?.revision !== connection.revision || !isDeepStrictEqual(this.authorize(record).author, originalAuthor)) fail('INGRESS_AUTHORITY_REVISED')
    }
    try {
      assertCurrent()
      const adapter = this.authenticators.get(connection.config.adapterId)!
      const quote = parseChannelTranscriptQuote(await reader.call(adapter, connection.config,
        { externalConversationId: record.externalConversationId, range, assertCurrent }, credential, signal))
      if (!isDeepStrictEqual(quote.application, record.application) || quote.externalConversationId !== record.externalConversationId || !isDeepStrictEqual(quote.range, range)) return unavailableChannelQuote(record, range, 'native-history-target-unconfirmed')
      return quote
    } catch { return unavailableChannelQuote(record, range, this.historyAbort.signal.aborted ? 'native-history-cancelled' : 'native-history-unavailable') }
  }
  async dispatch(ingressId: string, receiverSignal?: AbortSignal): Promise<ConnectionIngressInspection> {
    const active = this.pending.get(ingressId)
    if (active) return await active
    const work = this.deliver(ingressId, receiverSignal).then(async result => {
      try {
        const record = this.read(ingressId)
        if (record && record.kind !== 'action' && record.group?.recorded) await this.recordGroup(record)
      } catch (error) {
        const recording = { state: 'unavailable' as const, code: error instanceof AgentMuxError ? error.code : 'EXTERNAL_RECORD_UNAVAILABLE' }
        try {
          this.transaction(() => {
            const current = this.read(ingressId)
            if (current && current.kind !== 'action' && current.group) this.write({ ...current, group: { ...current.group, recording } })
          })
        } catch { /* The returned original inspection retains this failed observation when storage cannot. */ }
        if (result.ingress && result.ingress.kind !== 'action' && result.ingress.group) return { ...result, ingress: { ...result.ingress, group: { ...result.ingress.group, recording } } }
      }
      return result
    }).finally(() => this.pending.delete(ingressId))
    this.pending.set(ingressId, work)
    return await work
  }
  private async deliver(ingressId: string, receiverSignal?: AbortSignal): Promise<ConnectionIngressInspection> {
    let intake = this.read(ingressId)
    if (!intake) fail('UNKNOWN_CONNECTION_INGRESS')
    if (intake.kind === 'action') return intake.state === 'received' ? await this.dispatchAction(intake) : await this.inspect({ ingressId })
    if (intake.state === 'received' && intake.conversationKind === 'group' && this.options.queryReceived) {
      // Receipt feedback needs only durable authenticated intake and the original addressed authority.
      // Pending reply qualification still follows the original path below; no Core record is fabricated.
      try { const original = this.authorize(intake); this.options.queryReceived(original.binding, intake) }
      catch { /* This optional feedback cannot decide or block original input; deliver records its own authority result below. */ }
    }
    if (intake.conversationKind === 'group' && intake.code !== 'INGRESS_CONTENT_UNSUPPORTED' && intake.group?.target && !intake.group.recorded && intake.group.recording?.state !== 'refused') {
      try { intake = await this.recordGroup(intake) }
      catch (error) {
        const code = error instanceof AgentMuxError ? error.code : 'EXTERNAL_RECORD_UNAVAILABLE'
        intake = this.transaction(() => {
          const current = this.read(ingressId)!
          if (current.kind === 'action' || !current.group) fail('INGRESS_EVENT_CONFLICT')
          return this.write({ ...current, group: { ...current.group, recording: { state: code === 'INGRESS_BINDING_UNAVAILABLE' ? 'refused' : 'unavailable', code } } })
        })
      }
    }
    if (intake.state !== 'received') return await this.inspect({ ingressId })
    if (this.options.prepareInput) {
      let preparation: Awaited<ReturnType<NonNullable<DurableIngressOptions['prepareInput']>>>
      try { preparation = await this.options.prepareInput(intake) }
      catch (error) {
        const code = error instanceof AgentMuxError ? error.code : 'INGRESS_PREPARATION_UNAVAILABLE'
        this.transaction(() => {
          const current = this.read(ingressId)!
          if (current.kind !== 'action' && current.state === 'received') this.write({ ...current, code })
        })
        // The original receiver still owns recovery; recording an observation never claims input.
        throw error
      }
      if (preparation.state === 'refused') {
        this.transaction(() => { const current = this.read(ingressId)!; if (current.kind !== 'action' && current.state === 'received') this.write({ ...current, state: 'refused', code: preparation.code }) })
        return await this.inspect({ ingressId })
      }
      intake = this.transaction(() => {
        const current = this.read(ingressId)!
        if (current.kind === 'action') fail('INGRESS_EVENT_CONFLICT')
        if (current.state !== 'received' || current.code === undefined) return current
        const { code: _resolvedPreparation, ...ready } = current
        return this.write(ready)
      })
    }
    let record: ConnectionIngressMessage = intake
    let original: ReturnType<DurableIngressHost['authorize']>
    try {
      original = this.safe(() => this.authorize(record!, undefined, true))
      if (original.binding.scope.input === 'mentions-and-replies' && original.event.selection === 'message' && original.event.replyToMessageId) {
        record = await this.qualifyReply(record, original.event)
        if (record.state !== 'received' || record.addressing?.state !== 'confirmed') return await this.inspect({ ingressId })
        original = this.safe(() => this.authorize(record!))
      }
    }
    catch (error) {
      if (error instanceof AgentMuxError && ['INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED'].includes(error.code)) return await this.inspect({ ingressId })
      if (!(error instanceof AgentMuxError) || error.code === 'INGRESS_STORAGE_UNCONFIRMED') throw error
      this.transaction(() => { const current = this.read(ingressId)!; if (current.kind !== 'action' && current.state === 'received') this.write({ ...current, state: 'refused', code: error.code }) })
      return await this.inspect({ ingressId })
    }
    this.options.queryReceived?.(original.binding, record)
    const client = this.options.core(original.binding.executionHostId, original.author.authoritySource?.executionRuntimeId)
    if (!client) fail('INGRESS_CORE_UNAVAILABLE')
    const exact = await client.readAgentSession(original.binding.agentSessionId, original.author.authoritySource?.executionRuntimeId)
    if (!exact || exact.agentSessionId !== original.binding.agentSessionId || exact.hostId !== original.binding.executionHostId) fail('INGRESS_TARGET_UNCONFIRMED')
    const expectedRun = { ...exact.run }
    const contextSource = this.nativeContextSource(original.binding, exact)
    let channelQuote = record.conversationKind === 'group' ? await this.prepareQuote(record, original.binding, client, contextSource, receiverSignal) : undefined
    let contextObservation: 'known-publications-unavailable' | undefined
    if (channelQuote && contextSource && this.options.contextPublications) {
      try {
        const known = this.options.contextPublications.knownContextMessages({ application: record.application,
          externalConversationId: record.externalConversationId, hostId: original.binding.executionHostId,
          agentSessionId: original.binding.agentSessionId, source: contextSource }, channelQuote.records.map(item => item.messageId))
        channelQuote = { ...channelQuote, records: channelQuote.records.filter(item => !known.has(item.messageId)) }
      } catch { contextObservation = 'known-publications-unavailable' }
    }
    if (this.historyAbort.signal.aborted || receiverSignal?.aborted) return await this.inspect({ ingressId })
    const currentTarget = channelQuote ? await client.readAgentSession(original.binding.agentSessionId, original.author.authoritySource?.executionRuntimeId) : exact
    if (!currentTarget || !isDeepStrictEqual(currentTarget.run, expectedRun) || !isDeepStrictEqual(this.nativeContextSource(original.binding, currentTarget), contextSource)) fail('INGRESS_TARGET_UNCONFIRMED')
    const claimed = this.transaction(() => {
      const current = this.read(ingressId)!
      if (current.kind === 'action') fail('INGRESS_EVENT_CONFLICT')
      if (current.state !== 'received') return { record: current, own: false as const }
      const channelProfile = this.options.connections.readChannelActor(current.connectionId, current.actor)
      const frozen = { hostId: original.binding.executionHostId, agentSessionId: original.binding.agentSessionId, expectedRun: expectedRun!, operationId: mintObjectId(), messageId: mintObjectId(), author: original.author, channelProfile, ...(channelQuote ? { channelQuote, ...(contextSource ? { contextSource } : {}), ...(contextObservation ? { contextObservation } : {}) } : {}), admissionIntent: { ...(original.binding.inputTarget ?? { kind: 'manual-actor' as const }), expectedRun } }
      this.authorize(current, frozen)
      const next = this.write({ ...current, state: 'claimed', input: frozen })
      this.contextPositions?.claimed(next)
      return { record: next, own: true as const }
    })
    if (!claimed.own) return await this.inspect({ ingressId })
    const ref = claimed.record.input!
    const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: ref.messageId, operationId: ref.operationId, createdAt: Date.now(),
      sender: ref.author, ...(ref.channelProfile ? { channelProfile: ref.channelProfile } : {}), ...(ref.channelQuote ? { channelQuote: ref.channelQuote } : {}), recipient: { kind: 'agent-session', agentSessionId: ref.agentSessionId }, threadId: JSON.stringify(['external', record.application.domain, record.application.appId, record.externalConversationId]), correlationId: JSON.stringify(['external', record.application.domain, record.application.appId, record.externalMessageId]), replyTo: null, workspaceId: null, senderSessionId: null, senderRunId: null, recipientSessionId: ref.agentSessionId, recipientRunId: ref.expectedRun.runId, body: record.body }
    try {
      await client.submitAgentMessage({ agentSessionId: ref.agentSessionId, envelope, admissionIntent: ref.admissionIntent!, execution: 'immediate', sourceChannel: 'agent-message' }, this.context(claimed.record))
    } catch { /* A Core call may have saved or dispatched input. Only inspect this original operation. */ }
    return await this.inspect({ ingressId })
  }
  private async dispatchAction(original: ConnectionIngressAction): Promise<ConnectionIngressInspection> {
    let claimed: ReturnType<ConversationActions['claim']> | undefined
    let client: DurableIngressCore | undefined
    this.transaction(() => {
      const record = this.read(original.ingressId)
      if (!record || record.kind !== 'action' || record.state !== 'received') return
      try {
        this.assertService(record.connectionId)
        const target = this.permissions.authorize(record)
        client = this.options.core(target.binding.executionHostId)
        // No Core call has started; retain received until this exact consumer is available.
        if (target.kind === 'question' ? !client?.replySessionQuestion : !client?.respondAgentInteraction) return
        claimed = this.permissions.claim(record); this.write(claimed.record)
      }
      catch (error) {
        // A service or storage observation gap cannot consume this already acknowledged original event.
        if (error instanceof AgentMuxError && ['INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED'].includes(error.code)) return
        if (!(error instanceof AgentMuxError) || !CONNECTION_INGRESS_AUTHORITY_CODES.includes(error.code as never)) throw error
        this.write({ ...record, state: 'refused', code: error.code as ConnectionIngressAuthorityCode })
      }
    })
    if (claimed?.own) {
      const input = claimed.input, record = claimed.record
      const assertCurrent = async (intent: import('./conversation-actions.js').ExternalActionInput) => {
            const authority = await this.authority({ operationId: input.operationId })
            if (authority.authority !== 'current' || externalActionIntentDigest(intent) !== record.input!.intentDigest || !isDeepStrictEqual(intent.externalAction, record.input!.author)) fail('INGRESS_AUTHORITY_REVISED')
      }
      try {
        if ('expectedRequest' in input) await client?.respondAgentInteraction?.(input, { externalAction: { identity: record.input!.author, assertCurrent } })
        else await client?.replySessionQuestion?.(input, { externalQuestion: { identity: record.input!.author, assertCurrent } })
      } catch { /* A Core response may be saved or written. Only inspect this exact operation. */ }
    }
    return await this.inspect({ ingressId: original.ingressId })
  }
  private inspectContext(ingress: ConnectionIngressMessage, receipt: import('@agentmux/core').AgentInputSubmissionReceipt | null): import('@agentmux/core/connections').ConnectionIngressContextObservation | undefined {
    const input = ingress.input, quote = input?.channelQuote
    if (!input || !quote) return undefined
    const summary = { coverage: quote.coverage, quotedMessages: quote.records.length, gapCount: quote.gaps.length,
      ...(input.contextObservation ? { code: input.contextObservation } : {}) }
    if (!this.contextPositions || !input.contextSource) return { ...summary, positionMessageId: null, observation: 'unavailable' }
    try {
      if (receipt) this.contextPositions.observe(ingress, receipt)
      const position = this.contextPositions.position({ bindingId: input.author.bindingId, bindingRevision: input.author.bindingRevision,
        hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.contextSource })
      return { ...summary, positionMessageId: position?.messageId ?? null, observation: 'observed' }
    } catch {
      return { ...summary, positionMessageId: null, observation: 'unavailable' }
    }
  }
  async inspect(value: { ingressId: string }): Promise<ConnectionIngressInspection> {
    const input = parseIngressParams('connection.ingress.inspect', value), ingress = this.read(input.ingressId)
    if (!ingress?.input) return { ingress, inputReceipt: null, observation: 'not-started' }
    if (ingress.kind === 'action') {
      try {
        const client = this.options.core(ingress.input.hostId)
        if (ingress.input.responseKind === 'question') {
          if (!client?.inspectAgentPromptSubmission) return { ingress, inputReceipt: null, observation: 'unavailable' }
          const key = { kind: 'prompt' as const, agentSessionId: ingress.input.agentSessionId, expectedRun: ingress.input.expectedRun, submissionId: ingress.input.operationId }
          const original = await client.inspectAgentPromptSubmission(key)
          if (original && !isDeepStrictEqual(original.admission?.intent?.message?.questionReply?.externalAction, ingress.input.author)) throw Error('Foreign original question receipt.')
          const question = original?.admission?.intent?.message?.questionReply, admission = original?.admission
          const questionReceipt = question && admission ? { agentSessionId: ingress.input.agentSessionId, expectedRun: ingress.input.expectedRun, operationId: ingress.input.operationId,
            source: question.source, recordId: question.recordId, questionIds: question.questionIds,
            outcome: admission.transport === 'native' ? admission.native.outcome === 'admitted' ? 'submitted' as const : admission.native.outcome === 'not-applied' ? 'not-applied' as const : 'unknown' as const : 'saved' as const } : null
          return parseIngressResult('connection.ingress.inspect', { ingress, inputReceipt: null, questionReceipt, observation: 'observed' }, input)
        }
        if (!client?.inspectAgentInteractionOperation) return { ingress, inputReceipt: null, interactionReceipt: null, observation: 'unavailable' }
        const receipt = await client.inspectAgentInteractionOperation({ agentSessionId: ingress.input.agentSessionId, operationId: ingress.input.operationId })
        if (receipt && (agentInteractionIntentDigest({ ...receipt, expectedRun: receipt.run }) !== ingress.input.intentDigest || !isDeepStrictEqual(receipt.externalAction, ingress.input.author))) throw new Error('Foreign original interaction receipt.')
        const interactionReceipt = receipt ? { operationId: receipt.operationId, agentSessionId: receipt.agentSessionId, run: receipt.run, delivery: receipt.delivery, nativeAdoption: receipt.nativeAdoption } : null
        return parseIngressResult('connection.ingress.inspect', { ingress, inputReceipt: null, interactionReceipt, observation: 'observed' }, input)
      } catch { return { ingress, inputReceipt: null, ...(ingress.input.responseKind === 'question' ? { questionReceipt: null } : { interactionReceipt: null }), observation: 'unavailable' } }
    }

    try {
      const client = this.options.core(ingress.input.hostId, ingress.input.author.authoritySource?.executionRuntimeId)
      if (!client) return { ingress, inputReceipt: null, observation: 'unavailable' }
      const inputReceipt = await client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: ingress.input.operationId })
      const context = this.inspectContext(ingress, inputReceipt)
      return parseIngressResult('connection.ingress.inspect', { ingress, inputReceipt, observation: 'observed', ...(context ? { context } : {}) }, input)
    } catch { return { ingress, inputReceipt: null, observation: 'unavailable' } }
  }
  /** Read only original DB authority. Calling Core here would cycle back into an executing input callback. */
  async authority(value: { operationId: string }): Promise<ConnectionIngressAuthority> {
    const input = parseIngressParams('connection.ingress.authority', value)
    let ingress: ConnectionIngressRecord | null = null
    try {
      return this.safe(() => {
        const row = this.database.prepare(`SELECT ingress_id FROM (${intakeRows}) WHERE json_extract(record_json,'$.input.operationId')=? ORDER BY sequence LIMIT 1`).get(input.operationId)
        ingress = row ? this.read(String(row.ingress_id)) : null
        if (!ingress?.input || ingress.state !== 'claimed') return { ingress: null, authority: 'refused', code: 'INGRESS_CLAIM_UNAVAILABLE' }
        if (ingress.kind === 'action') { this.assertService(ingress.connectionId); this.permissions.authorize(ingress); this.permissions.originalInput(ingress) }
        else this.authorize(ingress, ingress.input)
        return { ingress, authority: 'current' }
      })
    } catch (error) {
      const code: ConnectionIngressAuthorityCode = error instanceof AgentMuxError && CONNECTION_INGRESS_AUTHORITY_CODES.includes(error.code as never)
        ? error.code as ConnectionIngressAuthorityCode : 'INGRESS_STORAGE_UNCONFIRMED'
      return { ingress, authority: code === 'INGRESS_STORAGE_UNCONFIRMED' || code === 'INGRESS_SERVICE_UNCONFIRMED' || code === 'INGRESS_ADDRESSING_UNCONFIRMED' ? 'unavailable' : 'refused', code }
    }
  }
  /** Explicitly rejoin a positively saved original Core wait; unknown effects are read only. */
  async rejoin(ingressId: string): Promise<ConnectionIngressInspection> {
    const original = await this.inspect({ ingressId })
    if (original.ingress?.kind !== 'action' && original.ingress?.input && original.inputReceipt?.control.state === 'enabled') {
      const client = this.options.core(original.ingress.input.hostId, original.ingress.input.author.authoritySource?.executionRuntimeId)
      if (!client) fail('INGRESS_CORE_UNAVAILABLE')
      await client.rejoinAgentInputWaiting({ ref: original.inputReceipt.ref }, this.context(original.ingress))
    }
    return await this.inspect({ ingressId })
  }
  /** Read newest original group events, independently of local receiver aliases or claim success. */
  async listAudience(input: import('@agentmux/core/connections').ConnectionIngressAudienceInput): Promise<import('@agentmux/core/connections').ConnectionIngressAudiencePage> {
    const application = input.application, limit = input.limit ?? 5
    if (!application || ![application.domain, application.appId, input.externalConversationId].every(value => typeof value === 'string' && value.length > 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_CONNECTION_INGRESS')
    return this.safe(() => {
      const fields = [application.domain, application.appId, input.externalConversationId]
      const audienceRows = "SELECT sequence,ingress_id,record_json FROM connection_ingress_message WHERE domain=? AND app_id=? AND json_extract(record_json,'$.externalConversationId')=? UNION ALL SELECT intake_sequence AS sequence,ingress_id,record_json FROM connection_ingress_event WHERE domain=? AND app_id=? AND json_extract(record_json,'$.externalConversationId')=? AND record_json IS NOT NULL"
      const before = input.beforeIngressId ? this.database.prepare('SELECT sequence FROM (' + audienceRows + ') WHERE ingress_id=?').get(...fields, ...fields, input.beforeIngressId) : undefined
      if (input.beforeIngressId && !before) fail('INGRESS_CURSOR_MISMATCH')
      const rows = this.database.prepare('SELECT record_json FROM (' + audienceRows + ')' + (before ? ' WHERE sequence<?' : '') + ' ORDER BY sequence DESC LIMIT ?').all(...fields, ...fields, ...(before ? [Number(before.sequence)] : []), limit + 1)
      const ingresses = rows.slice(0, limit).map(row => parseConnectionIngressRecord(JSON.parse(String(row.record_json))))
      return { ingresses, nextBeforeIngressId: rows.length > limit ? ingresses.at(-1)!.ingressId : null }
    })
  }
  async list(value: ConnectionIngressListInput) {
    const input = parseIngressParams('connection.ingress.ls', value)
    return this.safe(() => {
      const after = input.afterIngressId ? this.database.prepare(`SELECT sequence FROM (${intakeRows}) WHERE ingress_id=? AND connection_id=?` + (input.bindingId ? " AND COALESCE(json_extract(record_json,'$.group.target.bindingId'),json_extract(record_json,'$.input.author.bindingId'))=?" : '')).get(input.afterIngressId, input.connectionId, ...(input.bindingId ? [input.bindingId] : [])) : undefined
      if (input.afterIngressId && !after) fail('INGRESS_CURSOR_MISMATCH')
      const rows = this.database.prepare(`SELECT record_json FROM (${intakeRows}) WHERE connection_id=? AND sequence>? ` + (input.bindingId ? "AND COALESCE(json_extract(record_json,'$.group.target.bindingId'),json_extract(record_json,'$.input.author.bindingId'))=? " : '') + 'ORDER BY sequence LIMIT ?').all(input.connectionId, Number(after?.sequence ?? 0), ...(input.bindingId ? [input.bindingId] : []), (input.limit ?? 25) + 1)
      const ingresses = rows.slice(0, input.limit ?? 25).map(row => parseConnectionIngressRecord(JSON.parse(String(row.record_json))))
      return { ingresses, nextAfterIngressId: rows.length > ingresses.length ? ingresses.at(-1)!.ingressId : null }
    })
  }
  /** Owner-private bounded observation; callers publish only a redacted diagnostic projection. */
  listDirect(application: ConnectionIngressMessage['application'], limit: number): { ingresses: ConnectionIngressMessage[]; more: boolean } {
    return this.safe(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_CONNECTION_INGRESS')
      const rows = this.database.prepare("SELECT record_json FROM connection_ingress_message WHERE domain=? AND app_id=? AND json_extract(record_json,'$.conversationKind')='direct' ORDER BY sequence DESC LIMIT ?")
        .all(application.domain, application.appId, limit + 1)
      const ingresses = rows.slice(0, limit).map(row => parseConnectionIngressRecord(JSON.parse(String(row.record_json))) as ConnectionIngressMessage)
      return { ingresses, more: rows.length > limit }
    })
  }
  /** Private recovery reader: unfinished observation or unclaimed input, bounded to this connection. */
  received(connectionId: string, afterIngressId?: string, limit = 25): { ingressIds: string[]; nextAfterIngressId: string | null } {
    return this.safe(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_CONNECTION_INGRESS')
      const after = afterIngressId ? this.database.prepare(`SELECT sequence FROM (${intakeRows}) WHERE connection_id=? AND ingress_id=?`).get(connectionId, afterIngressId) : undefined
      if (afterIngressId && !after) fail('INGRESS_CURSOR_MISMATCH')
      const rows = this.database.prepare(`SELECT ingress_id FROM (${intakeRows}) WHERE connection_id=? AND ${unfinishedIntake} AND sequence>? ORDER BY sequence LIMIT ?`)
        .all(connectionId, Number(after?.sequence ?? 0), limit + 1)
      const ingressIds = rows.slice(0, limit).map(row => String(row.ingress_id))
      return { ingressIds, nextAfterIngressId: rows.length > ingressIds.length ? ingressIds.at(-1)! : null }
    })
  }
}
