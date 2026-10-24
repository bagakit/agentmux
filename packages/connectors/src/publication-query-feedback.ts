import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
import { conversationInputAdoptionEdges, conversationInputIdentity, type ConversationInputWitness, type ConversationUnit } from '@agentmux/core/conversation'
import type { PublicationBoundary, PublicationOperation, PublicationStore, QueryFeedbackPayload } from './publication-store.js'

/** These effects use the existing Outbox. No separate input state, retry queue or Runtime. */
export function queueQueryFeedback(store: PublicationStore, boundary: PublicationBoundary, query: ConnectionIngressMessage, stage: QueryFeedbackPayload['stage'], witness?: ConversationInputWitness, completion?: PublicationOperation['queryCompletion']): void {
  const target = query.group?.target
  if (query.conversationKind !== 'group' || query.state === 'refused' || !target ||
    !store.publicationMember(boundary, target.bindingId, target.bindingRevision) || target.connectionId !== boundary.connectionId ||
    target.hostId !== boundary.executionHostId || target.agentSessionId !== boundary.agentSessionId ||
    query.connectionId !== boundary.connectionId || query.externalConversationId !== boundary.externalConversationId || !isDeepStrictEqual(query.application, boundary.application)) return
  const identity = [boundary.bindingId, boundary.revision, query.ingressId, stage]
  const projectionId = 'query-feedback-' + createHash('sha256').update(JSON.stringify(identity)).digest('base64url')
  const operationId = 'publication-' + projectionId
  if (store.inspect(operationId)) return
  const payload: QueryFeedbackPayload = { kind: 'query-feedback', stage, messageId: query.externalMessageId }
  const operation: PublicationOperation = {
    operationId, projectionId, sourceRevision: createHash('sha256').update(JSON.stringify([payload, witness, completion])).digest('hex'),
    bindingId: boundary.bindingId, bindingRevision: boundary.revision, reference: { hostId: target.hostId, agentSessionId: target.agentSessionId, source: { kind: 'ingress', ingressId: query.ingressId } },
    target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
    publicationScope: boundary.scope.publication, payload, queryFeedback: { stage, ingressId: query.ingressId, messageId: query.externalMessageId },
    ...(witness ? { queryTurn: witness } : {}), ...(completion ? { queryCompletion: completion } : {}), effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending'
  }
  store.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
    .run(operationId, projectionId, operation.sourceRevision, 0, boundary.bindingId, boundary.revision, JSON.stringify(operation), 'pending')
}

/** Consumes the original Core window and qualified adoption relation, never rendered reply text. */
export function projectQueryFeedback(store: PublicationStore, boundary: PublicationBoundary, units: readonly ConversationUnit[]): void {
  const records = units.flatMap(unit => unit.records).filter(isCompleteConversationRecord)
  const context = { witnesses: units.flatMap(unit => unit.event.inputAdoption?.witnesses ?? []),
    ...(units.some(unit => unit.event.inputAdoption?.unconfirmed) ? { unconfirmed: true as const } : {}) }
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
    return query.state === 'claimed' && query.input && conversationInputIdentity(query.input.hostId,
      { kind: 'message', agentSessionId: query.input.agentSessionId, expectedRun: query.input.expectedRun, messageId: query.input.messageId }) === conversationInputIdentity(witness.record.hostId, key) ? query : undefined
  }
  // Captured input may precede native adoption. Recovery can still create the original received effect.
  for (const record of records) {
    if (record.original.kind !== 'captured' || record.original.item.inputRef?.kind !== 'message') continue
    const key = record.original.item.inputRef
    const row = byInput.get(boundary.executionHostId, key.agentSessionId, key.expectedRun.runId, key.messageId)
    if (row) { const query = JSON.parse(String(row.record_json)) as ConnectionIngressMessage; if (query.state === 'claimed') queueQueryFeedback(store, boundary, query, 'received') }
  }
  if (!edges.unconfirmed) for (const [key, witnesses] of edges.byKey) {
    if (edges.ambiguous.has(key) || witnesses.length !== 1) continue
    const witness = witnesses[0]!, query = queryFor(witness)
    if (!query) continue
    queueQueryFeedback(store, boundary, query, 'received')
    queueQueryFeedback(store, boundary, query, 'started', witness)
  }
  // Only the exact original native turn completion can advance a previously qualified query.
  // The partial index keeps this lookup proportional to this turn, not historical Sessions.
  const started = store.database.prepare(`SELECT operation_json FROM connector_publication_operation
    WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.kind')='query-feedback'
      AND json_extract(operation_json,'$.payload.stage')='started'
      AND json_extract(operation_json,'$.queryTurn.record.source.providerId')=?
      AND json_extract(operation_json,'$.queryTurn.record.source.nativeSessionId')=?
      AND json_extract(operation_json,'$.queryTurn.turnId')=?`)
  for (const record of records) {
    const ref = record.reference
    if (record.original.kind !== 'native' || ref?.source.kind !== 'native' || ref.hostId !== boundary.executionHostId || ref.agentSessionId !== boundary.agentSessionId) continue
    const item = record.original.item
    if (!item.turnId || item.metrics?.scope !== 'turn' || item.metrics.status !== 'completed') continue
    for (const row of started.all(boundary.bindingId, boundary.revision, ref.source.providerId, ref.source.nativeSessionId, item.turnId)) {
      const original = JSON.parse(String(row.operation_json)) as PublicationOperation, witness = original.queryTurn
      if (!witness?.key) continue
      const accepted = conversationInputAdoptionEdges(records, { ...context, witnesses: [...context.witnesses, witness] })
      const key = conversationInputIdentity(witness.record.hostId, witness.key)
      if (accepted.unconfirmed || accepted.ambiguous.has(key) || accepted.byKey.get(key)?.length !== 1) continue
      const query = queryFor(witness)
      if (query) queueQueryFeedback(store, boundary, query, 'completed', witness, { record: ref, revision: record.revision })
    }
  }
}
