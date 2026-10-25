import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
import { conversationInputAdoptionEdges, mergeConversationInputAdoptionContexts, conversationInputIdentity, type ConversationInputWitness, type ConversationUnit } from '@agentmux/core/conversation'
import type { PublicationBoundary, PublicationOperation, PublicationStore, QueryFeedbackPayload } from './publication-store.js'

const queryStages: readonly (readonly QueryFeedbackPayload['stage'][])[] = [
  ['received'], ['queued'], ['dispatched'], ['started'], ['completed', 'failed', 'interrupted']
]

export function queryFeedbackOperationId(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, ingressId: string, stage: QueryFeedbackPayload['stage']): string {
  return 'publication-query-feedback-' + createHash('sha256').update(JSON.stringify([boundary.bindingId, boundary.revision, ingressId, stage])).digest('base64url')
}

/** Retained phases stay readable; new feedback only advances from waiting to delivery. */
export function reconcileQueryFeedback(store: PublicationStore, original: PublicationOperation): void {
  if (!original.queryFeedback) return
  const boundary = { bindingId: original.bindingId, revision: original.bindingRevision }
  const stages = queryStages.flatMap((group, rank) => group.map(stage => ({ rank, operation: store.inspect(queryFeedbackOperationId(boundary, original.queryFeedback!.ingressId, stage)) })))
  const latest = stages.reduce((last, { operation, rank }) => operation ? Math.max(last, rank) : last, -1)
  const confirmed = stages.reduce((last, { operation, rank }) => operation?.state === 'confirmed' && operation.mapping?.reactionId ? Math.max(last, rank) : last, -1)
  for (const { rank, operation } of stages) {
    if (!operation) continue
    // A newer fact supersedes an unsent display only; original in-flight effects keep their identity.
    if (rank < latest && operation.state === 'pending' && operation.attempt === undefined && !operation.prepared) {
      const next: PublicationOperation = { ...operation, state: 'superseded' }
      store.database.prepare('UPDATE connector_publication_operation SET operation_json=?,state=? WHERE operation_id=?')
        .run(JSON.stringify(next), next.state, next.operationId)
    }
    if (rank >= confirmed || operation.state !== 'confirmed' || !operation.mapping?.reactionId) continue
    const digest = createHash('sha256').update(JSON.stringify([operation.operationId, 'withdraw'])).digest('base64url')
    const operationId = 'publication-query-feedback-' + digest
    const withdrawal = store.inspect(operationId)
    // A retained received Get and a new delivered Get can be the same native effect.
    if (stages.some(value => value.rank === confirmed && value.operation?.state === 'confirmed' &&
        isDeepStrictEqual(value.operation.mapping, operation.mapping))) {
      // An unsent or definitively unapplied old cleanup no longer describes an
      // obsolete marker. Keep its frozen request and receipts; never replay an unknown effect.
      if (withdrawal?.state === 'pending' && (withdrawal.attempt === undefined || withdrawal.receipt?.state === 'not-applied'))
        store.database.prepare('UPDATE connector_publication_operation SET operation_json=?,state=? WHERE operation_id=?')
          .run(JSON.stringify({ ...withdrawal, state: 'superseded' }), 'superseded', withdrawal.operationId)
      continue
    }
    if (withdrawal) continue
    const cleanup: PublicationOperation = {
      operationId, projectionId: operation.projectionId, sourceRevision: digest,
      bindingId: operation.bindingId, bindingRevision: operation.bindingRevision,
      reference: operation.reference, target: operation.target, ...(operation.publicationScope ? { publicationScope: operation.publicationScope } : {}),
      payload: operation.payload, queryFeedback: operation.queryFeedback!,
      effect: 'withdraw', predecessorOperationId: operation.operationId, fragment: { ordinal: 0, count: 1 }, state: 'pending'
    }
    store.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
      .run(operationId, cleanup.projectionId, digest, 0, cleanup.bindingId, cleanup.bindingRevision, JSON.stringify(cleanup), 'pending')
  }
}

/** These effects use the existing Outbox. No separate input state, retry queue or Runtime. */
export function queueQueryFeedback(store: PublicationStore, boundary: PublicationBoundary, query: ConnectionIngressMessage, stage: 'received' | 'dispatched', directBinding?: import('@agentmux/core/connections').RoomBinding): void {
  // Later direct milestones can only borrow this exact query's original received target.
  const anchor = query.conversationKind === 'direct' && stage !== 'received' ? store.queryReceived(boundary, query.ingressId) : null
  const direct = query.conversationKind === 'direct' ? stage === 'received' ? directBinding : anchor ? {
    bindingId: anchor.bindingId, revision: anchor.bindingRevision, connectionId: anchor.target.connectionId,
    executionHostId: anchor.reference.hostId, agentSessionId: anchor.reference.agentSessionId,
    application: anchor.target.application, externalConversationId: anchor.target.externalConversationId
  } : undefined : undefined
  const target = query.conversationKind === 'group' ? query.group?.target : direct ? {
    bindingId: direct.bindingId, bindingRevision: direct.revision, connectionId: direct.connectionId,
    hostId: direct.executionHostId, agentSessionId: direct.agentSessionId
  } : undefined
  if (query.state === 'refused' || !target || direct && (!isDeepStrictEqual(direct.application, query.application) || direct.externalConversationId !== query.externalConversationId) ||
    !store.publicationMember(boundary, target.bindingId, target.bindingRevision) || target.connectionId !== boundary.connectionId ||
    target.hostId !== boundary.executionHostId || target.agentSessionId !== boundary.agentSessionId ||
    query.connectionId !== boundary.connectionId || query.externalConversationId !== boundary.externalConversationId || !isDeepStrictEqual(query.application, boundary.application)) return
  const operationId = queryFeedbackOperationId(boundary, query.ingressId, stage)
  const projectionId = operationId.slice('publication-'.length)
  if (store.inspect(operationId)) return
  const payload: QueryFeedbackPayload = { kind: 'query-feedback', stage, messageId: query.externalMessageId }
  const operation: PublicationOperation = {
    operationId, projectionId, sourceRevision: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    bindingId: boundary.bindingId, bindingRevision: boundary.revision, reference: { hostId: target.hostId, agentSessionId: target.agentSessionId, source: { kind: 'ingress', ingressId: query.ingressId } },
    target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
    publicationScope: boundary.scope.publication, payload, queryFeedback: { stage, ingressId: query.ingressId, messageId: query.externalMessageId },
    ...(stage === 'received' ? { queryPending: true as const } : {}),
    effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending'
  }
  store.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
    .run(operationId, projectionId, operation.sourceRevision, 0, boundary.bindingId, boundary.revision, JSON.stringify(operation), 'pending')
}

/** Consumes the original Core window and qualified adoption relation, never rendered reply text. */
export function projectQueryFeedback(store: PublicationStore, boundary: PublicationBoundary, units: readonly ConversationUnit[], authorized?: (query: ConnectionIngressMessage) => boolean): void {
  const records = units.flatMap(unit => unit.records).filter(isCompleteConversationRecord)
  const context = mergeConversationInputAdoptionContexts(units.map(unit => ({ records: unit.records.filter(isCompleteConversationRecord), context: unit.event.inputAdoption })))
  const edges = conversationInputAdoptionEdges(records, context)
  const byInput = store.database.prepare(`SELECT record_json FROM connection_ingress_message
    WHERE json_extract(record_json,'$.input.hostId')=? AND json_extract(record_json,'$.input.agentSessionId')=?
      AND json_extract(record_json,'$.input.expectedRun.runId')=? AND json_extract(record_json,'$.input.messageId')=?`)
  const queryFor = (witness: ConversationInputWitness): ConnectionIngressMessage | undefined => {
    const key = witness.key
    if (key?.kind !== 'message' || witness.record.hostId !== boundary.executionHostId || key.agentSessionId !== boundary.agentSessionId) return
    const row = byInput.get(boundary.executionHostId, key.agentSessionId, key.expectedRun.runId, key.messageId)
    if (!row) return
    const query = JSON.parse(String(row.record_json)) as ConnectionIngressMessage
    return query.state === 'claimed' && (!authorized || authorized(query)) && query.input && conversationInputIdentity(query.input.hostId,
      { kind: 'message', agentSessionId: query.input.agentSessionId, expectedRun: query.input.expectedRun, messageId: query.input.messageId }) === conversationInputIdentity(witness.record.hostId, key) ? query : undefined
  }
  // Captured input may precede native adoption. Recovery can still create the original received effect.
  for (const record of records) {
    if (record.original.kind !== 'captured' || record.original.item.inputRef?.kind !== 'message') continue
    const key = record.original.item.inputRef
    const row = byInput.get(boundary.executionHostId, key.agentSessionId, key.expectedRun.runId, key.messageId)
    if (row) { const query = JSON.parse(String(row.record_json)) as ConnectionIngressMessage; if (query.state === 'claimed' && (!authorized || authorized(query))) queueQueryFeedback(store, boundary, query, 'received') }
  }
  if (!edges.unconfirmed) for (const [key, witnesses] of edges.byKey) {
    if (edges.unconfirmedKeys.has(key) || edges.ambiguous.has(key) || witnesses.length !== 1) continue
    const witness = witnesses[0]!, query = queryFor(witness)
    if (!query) continue
    queueQueryFeedback(store, boundary, query, 'received')
  }
}
