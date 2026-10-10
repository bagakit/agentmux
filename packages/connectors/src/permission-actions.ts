import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError, agentInteractionIntentDigest, agentInteractionRequestDigest, agentInteractionRequestTarget, parseAgentExternalInteractionAuthor,
  type AgentMuxAgentInteractionInput, type AgentMuxPermissionRequest } from '@agentmux/core'
import { parseConnectionIngressRecord, type ConnectionGrant, type ConnectionIngressAction, type RoomBinding } from '@agentmux/core/connections'
import type { DurableIngressOptions, VerifiedIngressAction } from './durable-ingress.js'
import type { PublicationPermissionsPort } from './publication-host.js'
import type { PermissionPublicationPayload, PublicationOperation, PublicationStore } from './publication-store.js'

type Reference = { actionRef: string; projectionId: string; binding: RoomBinding; run: { runId: string }; request: AgentMuxPermissionRequest;
  decision: { outcome: 'selected'; optionId: string }; grants: ConnectionGrant[] }
const encode = JSON.stringify
const same = isDeepStrictEqual
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')
const failure = (code: string): never => { throw new AgentMuxError('The original remote permission target or authority is unavailable. Inspect its original operation; local responses remain available.', code) }

/** Finite references and intent links of the original ingress owner. No responder, queue or question state. */
export class PermissionActions implements PublicationPermissionsPort {
  private initialized = false
  constructor(private readonly options: DurableIngressOptions) {}
  private initialize(): void {
    if (this.initialized) return
    this.options.connections.database.exec(`
      CREATE TABLE IF NOT EXISTS connection_ingress_action_reference (action_ref TEXT PRIMARY KEY, projection_id TEXT NOT NULL, binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, reference_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS connection_ingress_action_audience ON connection_ingress_action_reference(binding_id,binding_revision,projection_id);
      CREATE TABLE IF NOT EXISTS connection_ingress_action_intent (operation_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS connection_ingress_action_original ON connection_ingress_event(json_extract(record_json,'$.input.author.actionRef'),json_extract(record_json,'$.input.author.actor'),json_extract(record_json,'$.input.author.grantRevision'),intake_sequence) WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.state')='claimed';
      CREATE INDEX IF NOT EXISTS connection_ingress_action_operation ON connection_ingress_event(json_extract(record_json,'$.input.operationId')) WHERE record_json IS NOT NULL AND json_extract(record_json,'$.input.operationId') IS NOT NULL;
    `)
    this.initialized = true
  }
  private reference(actionRef: string): Reference | null {
    this.initialize()
    const row = this.options.connections.database.prepare('SELECT reference_json FROM connection_ingress_action_reference WHERE action_ref=?').get(actionRef)
    return row ? JSON.parse(String(row.reference_json)) as Reference : null
  }
  supports(event: VerifiedIngressAction): boolean {
    if (!event.actor || !event.actionRef || !event.externalConversationId || !event.sourceMessageId) return false
    return !!this.reference(event.actionRef)
  }
  observe(binding: RoomBinding, wake: () => void): () => void {
    const core = this.options.core(binding.executionHostId)
    if (!core?.onEvent) return failure('INGRESS_CORE_UNAVAILABLE')
    return core.onEvent(event => { if (event.type === 'agent-session' && event.session.agentSessionId === binding.agentSessionId) wake() })
  }
  private grants(binding: RoomBinding): ConnectionGrant[] {
    return (this.options.bindings.grants?.(binding.bindingId, binding.revision) ?? [])
      .filter(grant => grant.state === 'active' && grant.capabilities.includes('permission') && grant.bindingRevision === binding.revision)
      .sort((a, b) => a.grantId.localeCompare(b.grantId))
  }
  private current(reference: Reference): ConnectionGrant[] {
    const binding = this.options.bindings.readCurrent(reference.binding.bindingId)
    if (!binding || binding.revision !== reference.binding.revision || binding.state !== 'active' || !same(binding.application, reference.binding.application) || binding.externalConversationId !== reference.binding.externalConversationId) return []
    return this.grants(binding).filter(grant => reference.grants.some(original => original.grantId === grant.grantId && original.revision === grant.revision && same(original.actor, grant.actor)))
  }
  project(binding: RoomBinding, store: PublicationStore): string[] {
    this.initialize()
    const core = this.options.core(binding.executionHostId)
    if (!core?.agentSession) return failure('INGRESS_CORE_UNAVAILABLE')
    const session = core.agentSession(binding.agentSessionId), pending = session.pendingInteraction
    const requests = pending ? [pending.request, ...(pending.additionalRequests ?? [])] : []
    const grants = this.grants(binding)
    // Only an actually open original Hook can create an actionable projection. Readability alone is insufficient.
    for (const request of requests) if (request.kind === 'permission' && request.permissionHook && !request.permissionHook.closed &&
        !request.permissionHook.nativeTurnEnded && !request.permissionHook.response && !request.responseUnavailableReason && grants.length) {
      const target = agentInteractionRequestTarget(request) as AgentMuxPermissionRequest
      const projectionId = 'permission-' + digest([binding.bindingId, binding.revision, session.run, agentInteractionRequestDigest(target), grants.map(grant => [grant.grantId, grant.revision])])
      const prior = this.options.connections.database.prepare('SELECT 1 FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(binding.bindingId, binding.revision, projectionId)
      if (!prior) {
        const database = this.options.connections.database
        database.exec('BEGIN IMMEDIATE')
        try {
          if (!database.prepare('SELECT 1 FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(binding.bindingId, binding.revision, projectionId)) for (const option of target.options) {
            const reference: Reference = { actionRef: randomUUID(), projectionId, binding: structuredClone(binding), run: { ...session.run }, request: target,
              decision: { outcome: 'selected', optionId: option.id }, grants: structuredClone(grants) }
            database.prepare('INSERT INTO connection_ingress_action_reference VALUES (?,?,?,?,?)')
              .run(reference.actionRef, projectionId, binding.bindingId, binding.revision, encode(reference))
          }
          database.exec('COMMIT')
        } catch (error) { try { database.exec('ROLLBACK') } catch { /* Inspect the same original references after an unconfirmed commit. */ }; throw error }
      }
    }
    const rows = this.options.connections.database.prepare('SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? ORDER BY rowid')
      .all(binding.bindingId, binding.revision)
    const groups = new Map<string, Reference[]>()
    for (const row of rows) { const ref = JSON.parse(String(row.reference_json)) as Reference; const group = groups.get(ref.projectionId) ?? []; group.push(ref); groups.set(ref.projectionId, group) }
    for (const [projectionId, refs] of groups) {
      const ref = refs[0]!, request = requests.find(value => value.kind === 'permission' &&
        agentInteractionRequestDigest(value) === agentInteractionRequestDigest(ref.request)) as AgentMuxPermissionRequest | undefined
      const shareable = session.run.runId === ref.run.runId && !!request && this.current(ref).length > 0
      const response = request?.permissionHook?.response
      const actionable = shareable && !!request?.permissionHook && !request.permissionHook.closed && !request.permissionHook.nativeTurnEnded && !request.responseUnavailableReason && !response
      const payload: PermissionPublicationPayload = shareable
        ? { kind: 'permission', disclosure: 'shared', title: ref.request.title,
          ...(!ref.request.toolName && !ref.request.toolInput ? {} : { context: [ref.request.toolName, ref.request.toolInput].filter(value => value !== undefined).join('\n') }),
          status: actionable ? 'pending' : response?.delivery === 'connection-written' ? 'response-sent' : response ? 'unconfirmed' : 'unavailable',
          options: actionable ? refs.map(value => ({ actionRef: value.actionRef, label: value.request.options.find(option => option.id === value.decision.optionId)!.label })) : [] }
        : { kind: 'permission', disclosure: 'redacted', title: 'Review this permission in amux', status: 'unavailable', options: [] }
      // Revocation can redact an already known card, but cannot create an old private request for a new audience.
      if (!shareable && !store.confirmedMapping(projectionId)) continue
      store.commitPermission(binding, projectionId, { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId,
        source: { kind: 'interaction', runId: ref.run.runId, requestId: ref.request.id, requestDigest: agentInteractionRequestDigest(ref.request) } }, payload)
    }
    return [...groups.keys()]
  }
  authorized(operation: PublicationOperation): boolean {
    if (operation.payload.kind !== 'permission') return true
    const row = this.options.connections.database.prepare('SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(operation.bindingId, operation.bindingRevision, operation.projectionId)
    if (!row) return false
    // A redaction never contains old tool context or actions. It still uses the exact original audience and Mod policy.
    if (operation.payload.disclosure === 'redacted' && !operation.payload.context && !operation.payload.options.length) return true
    return this.current(JSON.parse(String(row.reference_json))).length > 0
  }
  authorize(record: ConnectionIngressAction): Reference {
    this.options.connections.assertServiceEnabled()
    if (!record.actor || !record.actionRef || !record.sourceMessageId || !record.externalConversationId) failure('INGRESS_ACTOR_NOT_AUTHORIZED')
    const ref = this.reference(record.actionRef!)
    if (!ref || ref.binding.connectionId !== record.connectionId || !same(ref.binding.application, record.application) || ref.binding.externalConversationId !== record.externalConversationId) failure('INGRESS_AUTHORITY_REVISED')
    const connection = this.options.connections.readConfiguration(record.connectionId)
    if (!connection?.config.enabled || !same(connection.config.application, record.application)) failure('INGRESS_CONNECTION_UNAVAILABLE')
    const grant = this.current(ref!).find(value => same(value.actor, record.actor))
    if (!grant) failure('INGRESS_ACTOR_NOT_AUTHORIZED')
    const mapping = this.options.connections.database.prepare("SELECT operation_json FROM connector_publication_operation WHERE projection_id=? AND state='confirmed' ORDER BY ordinal DESC LIMIT 1").get(ref!.projectionId)
    if (!mapping || JSON.parse(String(mapping.operation_json)).mapping?.messageId !== record.sourceMessageId) failure('INGRESS_AUTHORITY_REVISED')
    if (record.input && (record.input.hostId !== ref!.binding.executionHostId || record.input.agentSessionId !== ref!.binding.agentSessionId || record.input.expectedRun.runId !== ref!.run.runId ||
        record.input.author.bindingId !== ref!.binding.bindingId || record.input.author.bindingRevision !== ref!.binding.revision || record.input.author.grantId !== grant!.grantId || record.input.author.grantRevision !== grant!.revision)) failure('INGRESS_AUTHORITY_REVISED')
    return ref!
  }
  /** Called inside the original ingress transaction, before the first possible Core call. */
  claim(record: ConnectionIngressAction): { record: ConnectionIngressAction; input: AgentMuxAgentInteractionInput; own: boolean } {
    const ref = this.authorize(record), grant = this.current(ref).find(value => same(value.actor, record.actor))!
    const database = this.options.connections.database
    const existing = database.prepare("SELECT record_json FROM connection_ingress_event WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.state')='claimed' AND json_extract(record_json,'$.input.author.actionRef')=? AND json_extract(record_json,'$.input.author.actor')=? AND json_extract(record_json,'$.input.author.grantRevision')=? ORDER BY intake_sequence LIMIT 1")
      .get(ref.actionRef, encode(record.actor), grant.revision)
    if (existing) {
      const original = parseConnectionIngressRecord(JSON.parse(String(existing.record_json))) as ConnectionIngressAction
      const intent = database.prepare('SELECT intent_json FROM connection_ingress_action_intent WHERE operation_id=?').get(original.input!.operationId)
      return { record: { ...record, state: 'claimed', input: original.input! }, input: JSON.parse(String(intent!.intent_json)), own: false }
    }
    const author = parseAgentExternalInteractionAuthor({ kind: 'external-action', connectionId: record.connectionId, actor: record.actor,
      externalConversationId: record.externalConversationId, sourceMessageId: record.sourceMessageId, actionRef: record.actionRef,
      bindingId: ref.binding.bindingId, bindingRevision: ref.binding.revision, grantId: grant.grantId, grantRevision: grant.revision })
    const input: AgentMuxAgentInteractionInput = { agentSessionId: ref.binding.agentSessionId, expectedRun: ref.run,
      operationId: `permission-response:${randomUUID()}`, expectedRequest: ref.request,
      response: { kind: 'permission', requestId: ref.request.id, decision: ref.decision }, externalAction: author }
    database.prepare('INSERT INTO connection_ingress_action_intent VALUES (?,?)').run(input.operationId, encode(input))
    return { record: { ...record, state: 'claimed', input: { hostId: ref.binding.executionHostId, agentSessionId: input.agentSessionId,
      expectedRun: input.expectedRun, operationId: input.operationId, intentDigest: agentInteractionIntentDigest(input), author } }, input, own: true }
  }
  originalInput(record: ConnectionIngressAction): AgentMuxAgentInteractionInput {
    const row = record.input && this.options.connections.database.prepare('SELECT intent_json FROM connection_ingress_action_intent WHERE operation_id=?').get(record.input.operationId)
    if (!row) return failure('INGRESS_CLAIM_UNAVAILABLE')
    const input = JSON.parse(String(row.intent_json)) as AgentMuxAgentInteractionInput
    if (agentInteractionIntentDigest(input) !== record.input!.intentDigest || !same(input.externalAction, record.input!.author)) failure('INGRESS_AUTHORITY_REVISED')
    return input
  }
}
