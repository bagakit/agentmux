import { effectiveGrantKey, effectiveGrantSource, grantAuthorReference } from './effective-grant.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { mintObjectId, AgentMuxError, agentPromptCondition, agentInteractionResponseUnavailableReason, agentQuestionReplyIntentDigest, agentInteractionIntentDigest, agentInteractionRequestDigest, agentInteractionRequestTarget, parseAgentExternalInteractionAuthor,
  type AgentMuxAgentInteractionInput, type AgentMuxSessionQuestionReplyInput, type AgentMuxPermissionRequest, type AgentMuxAgentSession, type AgentSessionHistoryQuestion } from '@agentmux/core'
import type { ConversationUnit } from '@agentmux/core/conversation'
import { CONNECTION_INGRESS_AUTHORITY_CODES, parseConnectionIngressRecord, type ConnectionGrant, type ConnectionEffectiveGrant, type ConnectionEffectiveGrants, type ConnectionIngressAction, type RoomBinding } from '@agentmux/core/connections'
import type { ConnectionQuestionForm, ConnectionQuestionFormInput, DurableIngressOptions } from './durable-ingress.js'
import type { PublicationPermissionsPort } from './publication-host.js'
import type { PermissionPublicationPayload, QuestionPublicationPayload, PublicationOperation, PublicationStore } from './publication-store.js'

type PermissionReference = { kind?: never; actionRef: string; projectionId: string; binding: RoomBinding; run: { runId: string }; request: AgentMuxPermissionRequest;
  decision: { outcome: 'selected'; optionId: string }; grants: Array<ConnectionGrant | ConnectionEffectiveGrant> }
type QuestionReference = { kind: 'question'; actionRef: string; projectionId: string; binding: RoomBinding; run: { runId: string }; grants: Array<ConnectionGrant | ConnectionEffectiveGrant>;
  target: Pick<AgentMuxSessionQuestionReplyInput, 'source' | 'turnId' | 'recordId' | 'afterSubmissionId'>; questions: AgentSessionHistoryQuestion[] }
type Reference = PermissionReference | QuestionReference
export type ExternalActionInput = AgentMuxAgentInteractionInput | AgentMuxSessionQuestionReplyInput
export const externalActionIntentDigest = (input: ExternalActionInput): string => 'expectedRequest' in input ? agentInteractionIntentDigest(input) : agentQuestionReplyIntentDigest(input)
const encode = JSON.stringify
const same = isDeepStrictEqual
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex')
const failure = (code: string): never => { throw new AgentMuxError('The original remote interaction target or authority is unavailable. Inspect its original operation; local responses remain available.', code) }

/** Finite references and intent links of the original ingress owner. No responder, queue or question state. */
export class ConversationActions implements PublicationPermissionsPort {
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
  /** Routing and full-answer validation are separate; no Core work belongs in the native ACK. */
  intakeCode(record: ConnectionIngressAction): ConnectionIngressAction['code'] {
    if (!record.actor || !record.actionRef || !record.externalConversationId || !record.sourceMessageId) return 'INGRESS_ACTION_UNSUPPORTED'
    const ref = this.reference(record.actionRef)
    if (!ref) return 'INGRESS_ACTION_UNSUPPORTED'
    if (ref.kind !== 'question' || this.completeQuestionAnswers(ref, record)) return undefined
    try {
      // Only a known invalid form needs immediate local feedback. Valid actions keep deferred admission.
      this.authorize(record)
      return this.questionClaimed(ref.actionRef) ? 'INGRESS_AUTHORITY_REVISED' : 'INGRESS_QUESTION_ANSWER_INVALID'
    } catch (error) {
      if (error instanceof AgentMuxError && CONNECTION_INGRESS_AUTHORITY_CODES.includes(error.code as never) &&
          !['INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED'].includes(error.code)) return error.code as ConnectionIngressAction['code']
      return undefined // An observation gap retains the original received event for existing recovery.
    }
  }
  private questionClaimed(actionRef: string): boolean {
    return !!this.options.connections.database.prepare("SELECT 1 FROM connection_ingress_event WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.input.author.actionRef')=? AND json_extract(record_json,'$.state')='claimed' LIMIT 1").get(actionRef)
  }
  observe(binding: RoomBinding, wake: () => void): () => void {
    const core = this.options.core(binding.executionHostId)
    if (!core?.onEvent) return failure('INGRESS_CORE_UNAVAILABLE')
    return core.onEvent(event => { if (event.type === 'agent-session' && event.session.agentSessionId === binding.agentSessionId) wake() })
  }
  private grants(binding: RoomBinding, capability: 'permission' | 'answer' = 'permission', reading?: ConnectionEffectiveGrants): ConnectionEffectiveGrant[] {
    const current = this.options.bindings.readCurrent(binding.bindingId)
    return (reading ?? this.options.bindings.effectiveGrants(binding.bindingId, current?.revision ?? binding.revision)).grants
      .filter(grant => grant.state === 'active' && grant.capabilities.includes(capability))
      .sort((a, b) => a.source.kind.localeCompare(b.source.kind) || a.source.grantId.localeCompare(b.source.grantId))
  }
  private current(reference: Reference, actor?: ConnectionGrant['actor'], unavailable?: () => void): ConnectionEffectiveGrant[] {
    const binding = this.options.bindings.readCurrent(reference.binding.bindingId)
    if (!binding || !this.options.bindings.publicationAuthority(reference.binding.bindingId, reference.binding.revision).authorized || binding.state !== 'active' || !same(binding.application, reference.binding.application) || binding.externalConversationId !== reference.binding.externalConversationId) return []
    return reference.grants.filter(g => !actor || same(g.actor, actor)).flatMap(original => {
      try {
        const current = this.options.bindings.effectiveGrant(binding.bindingId, binding.revision, original.actor)
        return current?.state === 'active' && current.capabilities.includes(reference.kind === 'question' ? 'answer' : 'permission') && same(current.source, effectiveGrantSource(original)) ? [current] : []
      } catch (error) { if (actor) throw error; unavailable?.(); return [] }
    })
  }
  project(binding: RoomBinding, store: PublicationStore, supported = { permission: true, question: true }, unavailable?: () => void): string[] {
    this.initialize()
    const core = this.options.core(binding.executionHostId)
    if (!core?.agentSession) return failure('INGRESS_CORE_UNAVAILABLE')
    const session = core.agentSession(binding.agentSessionId), pending = session.pendingInteraction
    const requests = pending ? [pending.request, ...(pending.additionalRequests ?? [])] : []
    const reading = this.options.bindings.effectiveGrants(binding.bindingId, this.options.bindings.readCurrent(binding.bindingId)?.revision ?? binding.revision)
    if (reading.issue) unavailable?.()
    const grants = this.grants(binding, 'permission', reading)
    const questionProjections: string[] = []
    for (const request of requests) if (supported.question && request.kind === 'question') {
      const projectionId = 'live-question-' + digest([binding.bindingId, binding.revision, session.run, agentInteractionRequestDigest(request)])
      const shareable = this.grants(binding, 'answer', reading).length > 0
      if (!shareable && (!store.confirmedMapping(projectionId) || reading.issue)) continue
      const reason = pending ? agentInteractionResponseUnavailableReason(pending) : request.responseUnavailableReason
      const payload: QuestionPublicationPayload = { kind: 'question',
        text: shareable ? request.questions.map(question => [question.prompt, ...question.options.map(option => `- ${option.label}`)].join('\n')).join('\n\n') : 'Review the original question in AgentMux.',
        questions: shareable ? request.questions.map(question => ({ ...question, acceptsText: false })) : [],
        ...(reason ? { unavailableReason: reason } : {}),
        status: pending?.response ? pending.response.acknowledged ? 'response-sent' : 'unconfirmed' : 'unavailable' }
      store.commitInteraction(binding, projectionId, { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId,
        source: { kind: 'interaction', runId: session.run.runId, requestId: request.id, requestDigest: agentInteractionRequestDigest(request) } }, payload)
      questionProjections.push(projectionId)
    }
    // Only an actually open original Hook can create an actionable projection. Readability alone is insufficient.
    for (const request of requests) if (supported.permission && request.kind === 'permission' && request.permissionHook && !request.permissionHook.closed &&
        !request.permissionHook.nativeTurnEnded && !request.permissionHook.response && !request.responseUnavailableReason && grants.length) {
      const target = agentInteractionRequestTarget(request) as AgentMuxPermissionRequest
      if (reading.issue) {
        const known = this.options.connections.database.prepare("SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND json_extract(reference_json,'$.kind') IS NULL").all(binding.bindingId, binding.revision)
          .some(row => { const ref = JSON.parse(String(row.reference_json)) as PermissionReference; return same(ref.run, session.run) && agentInteractionRequestDigest(ref.request) === agentInteractionRequestDigest(target) })
        if (known) continue // Unknown app membership cannot replace or duplicate this original request.
      }
      const projectionId = 'permission-' + digest([binding.bindingId, binding.revision, session.run, agentInteractionRequestDigest(target), grants.map(effectiveGrantKey)])
      const prior = this.options.connections.database.prepare('SELECT 1 FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(binding.bindingId, binding.revision, projectionId)
      if (!prior) {
        const database = this.options.connections.database
        database.exec('BEGIN IMMEDIATE')
        try {
          if (!database.prepare('SELECT 1 FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(binding.bindingId, binding.revision, projectionId)) for (const option of target.options) {
            const reference: Reference = { actionRef: mintObjectId(), projectionId, binding: structuredClone(binding), run: { ...session.run }, request: target,
              decision: { outcome: 'selected', optionId: option.id }, grants: structuredClone(grants) }
            database.prepare('INSERT INTO connection_ingress_action_reference VALUES (?,?,?,?,?)')
              .run(reference.actionRef, projectionId, binding.bindingId, binding.revision, encode(reference))
          }
          database.exec('COMMIT')
        } catch (error) { try { database.exec('ROLLBACK') } catch { /* Inspect the same original references after an unconfirmed commit. */ }; throw error }
      }
    }
    const rows = supported.permission ? this.options.connections.database.prepare("SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND json_extract(reference_json,'$.kind') IS NULL ORDER BY rowid")
      .all(binding.bindingId, binding.revision) : []
    const groups = new Map<string, PermissionReference[]>()
    for (const row of rows) { const ref = JSON.parse(String(row.reference_json)) as PermissionReference; const group = groups.get(ref.projectionId) ?? []; group.push(ref); groups.set(ref.projectionId, group) }
    for (const [projectionId, refs] of groups) {
      const ref = refs[0]!, request = requests.find(value => value.kind === 'permission' &&
        agentInteractionRequestDigest(value) === agentInteractionRequestDigest(ref.request)) as AgentMuxPermissionRequest | undefined
      let currentUnavailable = false
      const current = this.current(ref, undefined, () => { currentUnavailable = true; unavailable?.() })
      if (currentUnavailable && !current.length) continue
      const shareable = session.run.runId === ref.run.runId && !!request && current.length > 0
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
      store.commitInteraction(binding, projectionId, { hostId: binding.executionHostId, agentSessionId: binding.agentSessionId,
        source: { kind: 'interaction', runId: ref.run.runId, requestId: ref.request.id, requestDigest: agentInteractionRequestDigest(ref.request) } }, payload)
    }
    return [...groups.keys(), ...questionProjections]
  }
  authorized(operation: PublicationOperation): boolean {
    if (operation.payload.kind === 'question') {
      if (!operation.payload.actionRef) return true
      const ref = this.reference(operation.payload.actionRef)
      return !!ref && ref.kind === 'question' && (operation.payload.status !== 'pending' || this.current(ref).length > 0)
    }
    if (operation.payload.kind !== 'permission') return true
    const row = this.options.connections.database.prepare('SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND projection_id=? LIMIT 1').get(operation.bindingId, operation.bindingRevision, operation.projectionId)
    if (!row) return false
    // A redaction never contains old tool context or actions. It still uses the exact original audience and Mod policy.
    if (operation.payload.disclosure === 'redacted' && !operation.payload.context && !operation.payload.options.length) return true
    return this.current(JSON.parse(String(row.reference_json))).length > 0
  }
  authorize(record: ConnectionIngressAction): Reference {
    const original = this.options.connections.readConfiguration(record.connectionId)
    if (!original?.config.enabled || !same(original.config.application, record.application)) return failure('INGRESS_CONNECTION_UNAVAILABLE')
    this.options.connections.assertServiceEnabled(original.config.adapterId)
    if (!record.actor || !record.actionRef || !record.sourceMessageId || !record.externalConversationId) failure('INGRESS_ACTOR_NOT_AUTHORIZED')
    const ref = this.reference(record.actionRef!)
    if (!ref || ref.binding.connectionId !== record.connectionId || !same(ref.binding.application, record.application) || ref.binding.externalConversationId !== record.externalConversationId) failure('INGRESS_AUTHORITY_REVISED')
    const grant = this.current(ref!, record.actor).find(value => same(value.actor, record.actor))
    if (!grant) failure('INGRESS_ACTOR_NOT_AUTHORIZED')
    const mapping = ref!.kind === 'question'
      ? this.options.connections.database.prepare("SELECT operation_json FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.actionRef')=? AND state='confirmed' ORDER BY ordinal DESC LIMIT 1").get(ref!.binding.bindingId, ref!.binding.revision, ref!.actionRef)
      : this.options.connections.database.prepare("SELECT operation_json FROM connector_publication_operation WHERE projection_id=? AND state='confirmed' ORDER BY ordinal DESC LIMIT 1").get(ref!.projectionId)
    if (!mapping || JSON.parse(String(mapping.operation_json)).mapping?.messageId !== record.sourceMessageId) failure('INGRESS_AUTHORITY_REVISED')
    if (record.input && (record.input.hostId !== ref!.binding.executionHostId || record.input.agentSessionId !== ref!.binding.agentSessionId || record.input.expectedRun.runId !== ref!.run.runId ||
        record.input.author.bindingId !== ref!.binding.bindingId || record.input.author.bindingRevision !== ref!.binding.revision || !same({ kind: record.input.author.grantSource ?? 'room', grantId: record.input.author.grantId, revision: record.input.author.grantRevision }, grant!.source))) failure('INGRESS_AUTHORITY_REVISED')
    return ref!
  }
  questionForm(input: ConnectionQuestionFormInput): ConnectionQuestionForm | null {
    try {
      const ref = this.authorize({ ...input, kind: 'action', ingressId: 'question-form-read', eventId: 'question-form-read', state: 'received' })
      if (ref.kind !== 'question') return null
      const core = this.options.core(ref.binding.executionHostId), session = core?.agentSession?.(ref.binding.agentSessionId)
      if (!session || session.run.runId !== ref.run.runId || session.nativeHandle?.kind !== 'provider' ||
          !same({ providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, ref.target.source) ||
          agentPromptCondition(session).afterSubmissionId !== ref.target.afterSubmissionId ||
          core?.providers?.get(ref.target.source.providerId).catalog.capabilities.asyncQuestionReply !== 'native-input') return null
      if (this.questionClaimed(ref.actionRef)) return null
      return { questions: structuredClone(ref.questions), status: 'pending' }
    } catch { return null }
  }
  /** Called inside the original ingress transaction, before the first possible Core call. */
  claim(record: ConnectionIngressAction): { record: ConnectionIngressAction; input: ExternalActionInput; own: boolean } {
    const ref = this.authorize(record), grant = this.current(ref, record.actor).find(value => same(value.actor, record.actor))!
    const database = this.options.connections.database
    const existing = database.prepare("SELECT record_json FROM connection_ingress_event WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.state')='claimed' AND json_extract(record_json,'$.input.author.actionRef')=? AND json_extract(record_json,'$.input.author.actor')=? AND json_extract(record_json,'$.input.author.grantRevision')=? AND json_extract(record_json,'$.input.author.grantId')=? AND coalesce(json_extract(record_json,'$.input.author.grantSource'),'room')=? ORDER BY intake_sequence LIMIT 1")
      .get(ref.actionRef, encode(record.actor), grant.source.revision, grant.source.grantId, grant.source.kind)
    if (existing) {
      const original = parseConnectionIngressRecord(JSON.parse(String(existing.record_json))) as ConnectionIngressAction
      const intent = database.prepare('SELECT intent_json FROM connection_ingress_action_intent WHERE operation_id=?').get(original.input!.operationId)
      const input = JSON.parse(String(intent!.intent_json)) as ExternalActionInput
      if (ref.kind === 'question' && !same(this.questionAnswers(ref, record), (input as AgentMuxSessionQuestionReplyInput).answers)) failure('INGRESS_AUTHORITY_REVISED')
      return { record: { ...record, state: 'claimed', input: original.input! }, input, own: false }
    }
    const author = parseAgentExternalInteractionAuthor({ kind: 'external-action', connectionId: record.connectionId, actor: record.actor,
      externalConversationId: record.externalConversationId, sourceMessageId: record.sourceMessageId, actionRef: record.actionRef,
      bindingId: ref.binding.bindingId, bindingRevision: ref.binding.revision, ...grantAuthorReference(grant) })
    const input: ExternalActionInput = ref.kind === 'question' ? { ...ref.target, agentSessionId: ref.binding.agentSessionId, expectedRun: ref.run,
      operationId: mintObjectId(), answers: this.questionAnswers(ref, record), externalAction: author } : { agentSessionId: ref.binding.agentSessionId, expectedRun: ref.run,
      operationId: mintObjectId(), expectedRequest: ref.request,
      response: { kind: 'permission', requestId: ref.request.id, decision: ref.decision }, externalAction: author }
    database.prepare('INSERT INTO connection_ingress_action_intent VALUES (?,?)').run(input.operationId, encode(input))
    return { record: { ...record, state: 'claimed', input: { hostId: ref.binding.executionHostId, agentSessionId: input.agentSessionId,
      expectedRun: input.expectedRun, operationId: input.operationId, intentDigest: externalActionIntentDigest(input), author, ...(ref.kind === 'question' ? { responseKind: 'question' as const } : {}) } }, input, own: true }
  }
  originalInput(record: ConnectionIngressAction): ExternalActionInput {
    const row = record.input && this.options.connections.database.prepare('SELECT intent_json FROM connection_ingress_action_intent WHERE operation_id=?').get(record.input.operationId)
    if (!row) return failure('INGRESS_CLAIM_UNAVAILABLE')
    const input = JSON.parse(String(row.intent_json)) as ExternalActionInput
    if (externalActionIntentDigest(input) !== record.input!.intentDigest || !same(input.externalAction, record.input!.author)) failure('INGRESS_AUTHORITY_REVISED')
    return input
  }
  private questionAnswers(ref: QuestionReference, record: ConnectionIngressAction): AgentMuxSessionQuestionReplyInput['answers'] {
    return this.completeQuestionAnswers(ref, record) ?? failure(this.questionClaimed(ref.actionRef) ? 'INGRESS_AUTHORITY_REVISED' : 'INGRESS_QUESTION_ANSWER_INVALID')
  }
  private completeQuestionAnswers(ref: QuestionReference, record: ConnectionIngressAction): AgentMuxSessionQuestionReplyInput['answers'] | null {
    if (!record.answers || record.answers.length !== ref.questions.length) return null
    const answers: AgentMuxSessionQuestionReplyInput['answers'] = []
    for (const question of ref.questions) {
      const answer = record.answers.find(answer => answer.questionId === question.id)
      if (!answer) return null
      if (answer.text !== undefined) {
        if (!question.acceptsText) return null
        answers.push({ questionId: question.id, answer: answer.text })
      } else {
        const options = answer.optionIds?.map(id => question.options.find(option => option.id === id))
        if (!options?.length || options.some(value => !value)) return null
        answers.push({ questionId: question.id, answer: options.map(option => option!.label).join('\n') })
      }
    }
    return answers
  }
  questions(binding: RoomBinding, units: readonly ConversationUnit[]): ReadonlyMap<string, QuestionPublicationPayload> {
    this.initialize()
    let core: ReturnType<DurableIngressOptions['core']>, session: AgentMuxAgentSession | undefined
    try { core = this.options.core(binding.executionHostId); session = core?.agentSession?.(binding.agentSessionId) } catch { /* Keep public questions readable without granting a response route. */ }
    const result = new Map<string, QuestionPublicationPayload>(), reading = this.options.bindings.effectiveGrants(binding.bindingId, this.options.bindings.readCurrent(binding.bindingId)?.revision ?? binding.revision), grants = this.grants(binding, 'answer', reading)
    for (const unit of units) for (const record of unit.records) {
      if (record.original.kind !== 'native' || !record.original.item.questionRequest || record.reference?.source.kind !== 'native') continue
      const item = record.original.item, questions = item.questionRequest!.questions
      const payload: QuestionPublicationPayload = { kind: 'question', text: '', questions, status: 'unavailable' }
      result.set(record.id, payload)
      if (!session || !item.turnId) continue
      try { if (core?.providers?.get(record.reference.source.providerId).catalog.capabilities.asyncQuestionReply !== 'native-input') continue }
      catch { continue } // An unavailable responder never blocks independently qualified public content.
      let condition: ReturnType<typeof agentPromptCondition>
      try { condition = agentPromptCondition(session) } catch { continue }
      const source = { providerId: record.reference.source.providerId, nativeSessionId: record.reference.source.nativeSessionId }
      if (session.nativeHandle?.kind !== 'provider' || !same({ providerId: session.nativeHandle.providerId, nativeSessionId: session.nativeHandle.sessionId }, source)) continue
      const existing = reading.issue ? this.options.connections.database.prepare("SELECT reference_json FROM connection_ingress_action_reference WHERE binding_id=? AND binding_revision=? AND json_extract(reference_json,'$.kind')='question' ORDER BY rowid DESC").all(binding.bindingId, binding.revision)
        .map(row => JSON.parse(String(row.reference_json)) as QuestionReference).find(ref => same(ref.run, session!.run) && same(ref.target, { source, turnId: item.turnId, recordId: item.id, afterSubmissionId: condition.afterSubmissionId }) && same(ref.questions, questions)) : undefined
      if (!grants.length) {
        if (existing) {
          const prior = this.options.connections.database.prepare("SELECT operation_json FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.actionRef')=? ORDER BY ordinal DESC LIMIT 1").get(binding.bindingId, binding.revision, existing.actionRef)
          if (prior) Object.assign(payload, JSON.parse(String(prior.operation_json)).payload)
        }
        continue
      }
      const projectionId = existing?.projectionId ?? 'question-' + digest([binding.bindingId, binding.revision, session.run, source, item.id, record.revision, grants.map(effectiveGrantKey)])
      const prior = this.options.connections.database.prepare('SELECT reference_json FROM connection_ingress_action_reference WHERE projection_id=? LIMIT 1').get(projectionId)
      const ref: QuestionReference = prior ? JSON.parse(String(prior.reference_json)) : { kind: 'question', actionRef: mintObjectId(), projectionId, binding: structuredClone(binding), run: { ...session.run }, grants: structuredClone(grants),
        target: { source, turnId: item.turnId, recordId: item.id, afterSubmissionId: condition.afterSubmissionId }, questions: structuredClone(questions) }
      if (!prior) this.options.connections.database.prepare('INSERT INTO connection_ingress_action_reference VALUES (?,?,?,?,?)').run(ref.actionRef, projectionId, binding.bindingId, binding.revision, encode(ref))
      payload.actionRef = ref.actionRef
      const claimed = this.options.connections.database.prepare("SELECT 1 FROM connection_ingress_event WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.input.author.actionRef')=? AND json_extract(record_json,'$.state')='claimed' LIMIT 1").get(ref.actionRef)
      if (claimed) {
        const represented = this.options.connections.database.prepare("SELECT operation_json FROM connector_publication_operation WHERE json_extract(operation_json,'$.payload.actionRef')=? ORDER BY ordinal DESC LIMIT 1").get(ref.actionRef)
        const priorPayload = represented ? JSON.parse(String(represented.operation_json)).payload as QuestionPublicationPayload : undefined
        payload.status = priorPayload?.status === 'response-sent' ? 'response-sent' : 'unconfirmed'
        if (priorPayload?.answers) payload.answers = priorPayload.answers
      } else payload.status = condition.afterSubmissionId === ref.target.afterSubmissionId ? 'pending' : 'unavailable'
    }
    return result
  }
  async refreshQuestions(binding: RoomBinding, store: PublicationStore): Promise<void> {
    this.initialize()
    const core = this.options.core(binding.executionHostId), session = core?.agentSession?.(binding.agentSessionId)
    if (!session) return
    const database = this.options.connections.database
    const rows = database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.kind')='question' AND ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? GROUP BY projection_id) AND json_extract(operation_json,'$.payload.status') IN ('pending','unconfirmed') ORDER BY ordinal LIMIT 100")
      .all(binding.bindingId, binding.revision, binding.bindingId, binding.revision)
    for (const row of rows) {
      const operation = { ...JSON.parse(String(row.operation_json)), state: row.state } as PublicationOperation
      if (operation.payload.kind !== 'question' || !operation.payload.actionRef) continue
      const ref = this.reference(operation.payload.actionRef)
      if (!ref || ref.kind !== 'question') continue
      const prior = database.prepare("SELECT record_json FROM connection_ingress_event WHERE json_extract(record_json,'$.kind')='action' AND json_extract(record_json,'$.input.author.actionRef')=? AND json_extract(record_json,'$.state')='claimed' ORDER BY intake_sequence LIMIT 1").get(ref.actionRef)
      let status: QuestionPublicationPayload['status'] = 'unavailable'
      let answers: QuestionPublicationPayload['answers']
      if (prior) {
        status = 'unconfirmed'
        const record = parseConnectionIngressRecord(JSON.parse(String(prior.record_json))) as ConnectionIngressAction
        try {
          const intent = this.originalInput(record)
          if (!('expectedRequest' in intent)) answers = intent.answers.map(({ questionId, answer }) => ({ questionId, answer }))
          const receipt = await core?.inspectAgentPromptSubmission?.({ kind: 'prompt', agentSessionId: binding.agentSessionId, expectedRun: record.input!.expectedRun, submissionId: record.input!.operationId })
          const original = receipt?.admission?.intent?.message?.questionReply
          if (receipt?.admission?.transport === 'native' && receipt.admission.native.outcome === 'admitted' && original && same(original.externalAction, record.input!.author)) status = 'response-sent'
        } catch { /* Only the original Core receipt can establish this answer's submission. */ }
      } else {
        let unavailable = false
        const current = this.current(ref, undefined, () => { unavailable = true })
        if (unavailable && !current.length && session.run.runId === ref.run.runId) continue
        if (current.length && session.run.runId === ref.run.runId) {
          try { if (agentPromptCondition(session).afterSubmissionId === ref.target.afterSubmissionId) status = 'pending' } catch { status = 'unconfirmed' }
        }
      }
      store.updateQuestion(operation, { ...operation.payload, status, ...(answers ? { answers } : {}) })
    }
  }
}
