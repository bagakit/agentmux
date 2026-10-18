import { conversationRecordId, type ConversationItemRef, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import type { ConversationConsumerQuery } from '@agentmux/core/control'
import type { ConversationConsumerObservation, ConversationConsumerSample } from '../../../shared/conversation-consumer-observation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import type { ConversationProcessMember } from '@agentmux/client-ui/components/ConversationRecordSequence'

// Mounted callbacks only. Bodies, frames and transport state stay in their original owners.
const consumers = new Map<string, (query: ConversationConsumerQuery) => ConversationConsumerSample | null>()
export function registerConversationConsumer(id: string, read: (query: ConversationConsumerQuery) => ConversationConsumerSample | null): () => void {
  consumers.set(id, read)
  return () => { if (consumers.get(id) === read) consumers.delete(id) }
}
export function inspectConversationConsumers(query: ConversationConsumerQuery): ConversationConsumerObservation {
  const reads = query.consumerId ? [consumers.get(query.consumerId)].filter(value => value !== undefined) : consumers.values()
  return { schema: 'agentmux.conversation-consumer-observation.v1', query,
    consumers: [...reads].flatMap(read => { const sample = read(query); return sample ? [sample] : [] }) }
}
export function conversationFrameObservation(snapshot: ConversationWindowSnapshot | null, records: readonly ConversationItemRef[] = []): ConversationConsumerSample['accepted'] {
  if (!snapshot) return null
  const membership = new Map<string, string[]>()
  for (const unit of snapshot.units) for (const record of unit.records) {
    if (!record.reference) continue
    const key = conversationRecordId(record.reference), roles = membership.get(key) ?? []
    if (!roles.includes(unit.event.role)) roles.push(unit.event.role)
    membership.set(key, roles)
  }
  return { id: snapshot.window.id, revision: snapshot.window.revision, sourceHostId: snapshot.sourceHostId,
    scope: { sources: [...snapshot.scope.sources] }, checkpoint: snapshot.window.checkpoint,
    unitCount: snapshot.units.length, recordCount: snapshot.units.reduce((count, unit) => count + unit.records.length, 0),
    coverage: snapshot.coverage.map(row => ({ source: row.source, current: row.current, readExtent: row.readExtent,
      gaps: row.gaps.map(gap => ({ code: gap.code, ...(gap.record ? { record: gap.record } : {}) })) })),
    membership: records.map(record => ({ record, present: snapshot.sourceHostId === null ? null : membership.has(conversationRecordId(record)),
      roles: membership.get(conversationRecordId(record)) ?? [] })) }
}
export function conversationRenderedObservation(viewport: HTMLElement | null, sessionId: string, records: readonly ConversationItemRef[] = [], sourceHostId?: string | null): ConversationConsumerSample['rendered'] {
  // Scan the original DOM once. A retained card and an exposed card are different facts.
  const messages = new Map<string, HTMLElement[]>(), disclosures = new Map<string, HTMLElement>(), processes = new Set<string>()
  for (const node of viewport?.querySelectorAll<HTMLElement>('[data-message-source-key]') ?? []) {
    const key = node.dataset.messageSourceKey!
    if (node.classList.contains('log-turn')) {
      const originals = messages.get(key) ?? []; originals.push(node); messages.set(key, originals)
    }
    if (node.classList.contains('conversation-original-record') || node.classList.contains('conversation-submission-record') || node.classList.contains('conversation-submission') || node.classList.contains('conversation-reply-observation')) disclosures.set(key, node)
  }
  for (const node of viewport?.querySelectorAll<HTMLElement>('[data-conversation-process-members]') ?? []) {
    for (const member of JSON.parse(node.dataset.conversationProcessMembers!) as ConversationProcessMember[]) {
      for (const source of member.sources) processes.add(conversationRecordId(source))
    }
  }
  const exposed = (node: HTMLElement): boolean => {
    if (!node.isConnected) return false
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.tagName === 'DETAILS' && !(ancestor as HTMLDetailsElement).open) return false
      const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor)
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
    }
    return true
  }
  return records.map(record => {
    if (!viewport || record.agentSessionId !== sessionId || record.hostId !== sourceHostId) return { record, message: false, messageExposed: false, process: false, disclosure: false, open: null }
    const sourceKey = conversationMessageSourceKey(sessionId, record.source)
    const cards = sourceKey ? messages.get(sourceKey) ?? [] : [], original = sourceKey ? disclosures.get(sourceKey) : undefined
    const details = original?.tagName === 'DETAILS' ? original as HTMLDetailsElement : original?.querySelector('details')
    const disclosure = Boolean(original)
    const open = details ? details.open : original ? original.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true' : null
    const process = processes.has(conversationRecordId(record))
    return { record, message: cards.length > 0, messageExposed: cards.some(exposed), process, disclosure, open }
  })
}
export function conversationInspectionError(error: Error | null): ConversationConsumerSample['error'] {
  return error ? { name: error.name, code: typeof (error as { code?: unknown }).code === 'string' ? (error as Error & { code: string }).code : null, message: error.message } : null
}
