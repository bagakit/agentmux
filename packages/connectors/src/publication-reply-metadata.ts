import type { AgentSessionHistoryMetrics, AgentTurnOutcome } from '@agentmux/core'
import { isCompleteConversationRecord, type ConversationItemRef, type ConversationSourceRecord } from '@agentmux/core/conversation'

/** A delivery snapshot. Original source and revision witnesses stay in Publication decisions. */
export type ReplyPublicationMetadata = {
  agentSessionId: string
  outcome?: AgentTurnOutcome['status']
  metrics?: AgentSessionHistoryMetrics
}
export type ReplyFact = {
  kind: 'reply-fact'
  record: ConversationItemRef
  recordKey: string
  revision: string
  order?: Extract<ConversationSourceRecord['order'], { kind: 'native-page' }>
  turnKey?: string
  metrics?: AgentSessionHistoryMetrics
  outcome?: AgentTurnOutcome['status']
}
export type ReplyProjection = {
  kind: 'reply-projection'
  projectionId: string
  record: ConversationItemRef
  recordKey: string
  revision: string
  order?: Extract<ConversationSourceRecord['order'], { kind: 'native-page' }>
  turnKey?: string
}

/** Neither a Session latest value nor an adjacent record establishes this relation. */
export function replyRecord(record: ConversationSourceRecord, hostId: string, agentSessionId: string): Omit<ReplyFact, 'kind' | 'metrics' | 'outcome'> | undefined {
  const reference = record.reference
  if (!isCompleteConversationRecord(record) || record.original.kind !== 'native' || reference?.source.kind !== 'native' ||
    reference.hostId !== hostId || reference.agentSessionId !== agentSessionId) return
  const source = [reference.hostId, reference.agentSessionId, reference.source.providerId, reference.source.nativeSessionId]
  return { record: reference, recordKey: JSON.stringify([...source, reference.source.recordId]), revision: record.revision, ...(record.order.kind === 'native-page' ? { order: record.order } : {}),
    ...(record.original.item.turnId ? { turnKey: JSON.stringify([...source, record.original.item.turnId]) } : {}) }
}

/** A field needs comparable native positions, or agreeing values. Arrival order is not source order. */
export function replyMetadata(projection: ReplyProjection, facts: readonly ReplyFact[]): { metadata: ReplyPublicationMetadata; witnesses: Array<Pick<ReplyFact, 'record' | 'revision' | 'turnKey' | 'order'> & { field: 'outcome' | 'duration' | 'usage' | 'response' }> } {
  const select = (candidates: ReplyFact[], value: (fact: ReplyFact) => unknown): ReplyFact | undefined => {
    if (candidates.length <= 1) return candidates[0]
    const page = candidates[0]!.order?.pageWitness
    if (page && candidates.every(fact => fact.order?.pageWitness === page))
      return [...candidates].sort((a, b) => a.order!.indexInPage - b.order!.indexInPage).at(-1)
    // Repeated equal native values are useful without inventing precedence between pages.
    return candidates.every(fact => JSON.stringify(value(fact)) === JSON.stringify(value(candidates[0]!))) ? candidates[0] : undefined
  }
  const turns = facts.filter(fact => projection.turnKey && fact.turnKey === projection.turnKey)
  const outcomeFact = select(turns.filter(fact => fact.outcome !== undefined), fact => fact.outcome)
  const durationFact = select(turns.filter(fact => fact.metrics?.scope === 'turn' && fact.metrics.durationMs !== undefined), fact => fact.metrics!.durationMs)
  const usageFact = select(turns.filter(fact => fact.metrics?.scope === 'turn' && fact.metrics.usage !== undefined), fact => fact.metrics!.usage)
  const responseFact = facts.find(fact => fact.recordKey === projection.recordKey && fact.revision === projection.revision && fact.metrics?.scope === 'response')
  // Usage is a cumulative snapshot, never a sum. Response values keep their original scope.
  const metrics = responseFact?.metrics ?? (durationFact || usageFact ? { scope: 'turn' as const,
    ...(durationFact ? { durationMs: durationFact.metrics!.durationMs! } : {}), ...(usageFact ? { usage: usageFact.metrics!.usage! } : {}) } : undefined)
  const selected = [['outcome', outcomeFact], ...(responseFact ? [['response', responseFact] as const] : [['duration', durationFact] as const, ['usage', usageFact] as const])] as const
  return { metadata: { agentSessionId: projection.record.agentSessionId, ...(outcomeFact ? { outcome: outcomeFact.outcome! } : {}), ...(metrics ? { metrics } : {}) },
    witnesses: selected.flatMap(([field, fact]) => fact ? [{ field, record: fact.record, revision: fact.revision, ...(fact.turnKey ? { turnKey: fact.turnKey } : {}), ...(fact.order ? { order: fact.order } : {}) }] : []) }
}
