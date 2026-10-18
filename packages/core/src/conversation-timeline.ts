import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from './types.js'
import type { ConversationRef, ConversationItemRef } from './conversation.js'
import { conversationRecordId, conversationRevision, conversationSourceKey, projectConversationStream, projectConversationStreamFacts,
  type ConversationSourceRecord, type ConversationSourceOrder, type ConversationSourceRef, type ConversationSourceCoverage,
  type ConversationInputAdoptionContext, type ConversationStreamInput, type ConversationTimeline } from './conversation-stream.js'

export type ConversationProjectionInput = {
  agentSessionId: string
  executionHostId?: string | undefined
  historyPage?: AgentSessionHistoryPage | undefined
  timeline?: AgentTimelineSnapshot | undefined
  sourceOrders?: ReadonlyMap<string, ConversationSourceOrder>
  coverage?: readonly ConversationSourceCoverage[]
  inputAdoption?: ConversationInputAdoptionContext
}

/** Adapt source-shaped SDK input once. Reader-owned records enter the stream directly. */
function sourceRecords(input: ConversationProjectionInput): ConversationStreamInput {
  const { agentSessionId, executionHostId } = input
  const page = input.historyPage?.agentSessionId === agentSessionId ? input.historyPage : undefined
  const timeline = input.timeline?.agentSessionId === agentSessionId ? input.timeline : undefined
  const nativeHost = page?.sourceHostId ?? executionHostId, capturedHost = timeline?.sourceHostId ?? executionHostId
  const conflictingHosts = page !== undefined && timeline !== undefined && nativeHost !== undefined && capturedHost !== undefined && nativeHost !== capturedHost
  const sourceHost = page ? nativeHost : capturedHost
  const reference: ConversationRef | null = sourceHost && !conflictingHosts ? { hostId: sourceHost, agentSessionId } : null
  const capturedPositions = new Map(timeline?.stream?.positions.map(position => [position.id, position]) ?? [])
  const make = (original: ConversationSourceRecord['original'], order: ConversationSourceOrder): ConversationSourceRecord => {
    const source: ConversationItemRef['source'] = original.kind === 'native'
      ? { kind: 'native', ...page!.source, recordId: original.item.id } : { kind: 'captured', recordId: original.item.id }
    const hostId = original.kind === 'native' ? nativeHost : capturedHost
    const id = conversationRecordId({ ...(hostId ? { hostId } : {}), agentSessionId, source })
    const position = original.kind === 'captured' ? capturedPositions.get(original.item.id) : undefined
    const sourceOrder = position && timeline?.stream ? { kind: 'captured-stream' as const, epoch: timeline.stream.epoch, firstSequence: position.firstSequence } : order
    return { id, reference: hostId ? { hostId, agentSessionId, source } : null, revision: position?.revision ?? conversationRevision(original.item), order: input.sourceOrders?.get(id) ?? sourceOrder, original }
  }
  const unique = (rows: ConversationSourceRecord[]) => [...new Map(rows.map(row => [row.id, row])).values()]
  const native = unique(page?.items.map((item, indexInPage) => make({ kind: 'native', item }, { kind: 'native-page', source: page.source, indexInPage })) ?? [])
  const captured = unique(timeline?.items.flatMap((item, indexInWindow) => item.agentSessionId === agentSessionId ? [make({ kind: 'captured', item }, { kind: 'captured-window', revision: timeline.revision, indexInWindow })] : []) ?? [])
  const sources: ConversationSourceRef[] = [
    ...(page ? [{ kind: 'native' as const, ...page.source }] : []),
    ...(timeline ? [{ kind: 'captured' as const, ...(timeline.stream ? { epoch: timeline.stream.epoch } : {}) }] : [])
  ]
  for (const value of input.coverage ?? []) if (!sources.some(source => conversationSourceKey(source) === conversationSourceKey(value.source))) sources.push(value.source)
  const coverageBySource = new Map(sources.map(source => [conversationSourceKey(source), {
    source, origin: source.kind === 'captured' ? timeline?.stream?.origin ?? 'unknown' as const : 'unknown' as const,
    readExtent: { through: source.kind === 'native' ? 'accepted-page' : `accepted-window:${timeline?.revision ?? 0}` },
    earlier: source.kind === 'native' && page?.nextCursor ? 'more' as const : 'unknown-before' as const,
    current: 'partial' as const, gaps: source.kind === 'captured' ? timeline?.stream?.gaps ?? [] : []
  } as ConversationSourceCoverage]))
  for (const value of input.coverage ?? []) coverageBySource.set(conversationSourceKey(value.source), value)
  return { agentSessionId, reference, records: [...native, ...captured], scope: { sources }, coverage: [...coverageBySource.values()],
    ...(page ? { nativeSource: page.source } : {}), ...(conflictingHosts ? { sourceHostConflict: true } : {}),
    ...(input.inputAdoption ? { inputAdoption: input.inputAdoption } : {}) }
}

/** Source-shaped convenience API over the same pure semantic stream. */
export function projectConversationTimeline(input: ConversationProjectionInput): ConversationTimeline {
  return projectConversationStream(sourceRecords(input))
}

/** Version-free summary shares event policy while retaining original record versions. */
export function projectConversationEventFacts(input: ConversationProjectionInput) {
  return projectConversationStreamFacts(sourceRecords(input))
}
