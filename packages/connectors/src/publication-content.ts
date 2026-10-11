import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { conversationRecordAuthor, conversationRecordId, type ConversationCheckpoint, type ConversationContentRef, type ConversationUnit } from '@agentmux/core/conversation'
import type { ConnectionDeliveryGap, ConnectionDeliveryRelay, ConnectionOriginRepresentation, RoomBinding } from '@agentmux/core/connections'

export type PublicationContentPlan = {
  text: string
  pieces: Array<{ part: ConversationContentRef; text: string; relay?: ConnectionDeliveryRelay['sources'][number] }>
  relay?: ConnectionDeliveryRelay
  phase?: 'progress' | 'final'
  gaps: ConnectionDeliveryGap[]
  origins: ConnectionOriginRepresentation[]
  excluded: ConversationContentRef[]
  /** Empty supported content can withdraw a previously delivered representation; a gap cannot. */
  complete: boolean
}
export type PublicationContentOptions = {
  resolved: ReadonlyMap<string, AgentSessionHistoryContentPart>
  origin(recordId: string): ConnectionOriginRepresentation['origin'] | undefined
  selected?: ConversationContentRef
}
export const publicationPartKey = (part: Pick<ConversationContentRef, 'record' | 'selector'>) => JSON.stringify([conversationRecordId(part.record), part.selector])

/** Platform representation only. Identity, role, author, order and relations are accepted Core facts. */
export function publicationContent(unit: ConversationUnit, binding: RoomBinding, frontier: ConversationCheckpoint, options: PublicationContentOptions): PublicationContentPlan {
  const records = new Map(unit.records.map(record => [record.id, record])), gaps: ConnectionDeliveryGap[] = [], origins: ConnectionOriginRepresentation[] = [], excluded: ConversationContentRef[] = []
  const event = { id: unit.event.id, revision: unit.event.revision }, sections: string[] = [], pieces: PublicationContentPlan['pieces'] = [], questions = new Set<string>()
  const narrow = binding.scope.publication === 'future-native-user-facing'
  let phase: 'progress' | 'final' | undefined
  for (const slot of unit.event.content) {
    const record = records.get(slot.recordId)!
    const part: ConversationContentRef = { record: record.reference!, recordRevision: record.revision, selector: slot.selector }
    const original = record.original, key = publicationPartKey(part)
    if (options.selected && publicationPartKey(options.selected) !== key) continue
    if (narrow && (original.kind !== 'native' || !['message', 'interaction'].includes(unit.event.role) || unit.event.author.kind !== 'agent')) { excluded.push(part); continue }
    const gap = (reason: ConnectionDeliveryGap['reason']) => gaps.push({ gapId: key, event, part,
      anchor: { record: part.record, revision: part.recordRevision, frontier }, reason })
    if (original.kind === 'captured') {
      const start = binding.sourceFrontier?.frontier.cuts.find(c => c.kind === 'captured')
      if (!start || start.kind !== 'captured' || record.order.kind !== 'captured-stream' || record.order.epoch !== start.epoch || record.order.firstSequence <= start.sequence) { gap('start-cut-unconfirmed'); continue }
    }
    // A native user record does not supply the qualified public input span. The
    // original captured writer explicitly does; attribution alone never does.
    if (original.kind === 'native' && original.item.kind === 'user-message' || original.kind === 'captured' && (original.item.kind === 'user_message' && original.item.publicContent !== 'confirmed' || original.item.kind === 'system_message' && original.item.source === 'agentmux')) { gap('public-content-unconfirmed'); continue }
    const external = original.kind === 'captured' ? original.item.authorExternal : undefined
    if (external && external.connectionId === binding.connectionId && external.externalConversationId === binding.externalConversationId && external.bindingId === binding.bindingId && external.bindingRevision === binding.revision) {
      const origin = options.origin(record.id)
      if (origin) { origins.push({ event, part, origin }); continue }
      gap('public-content-unconfirmed'); continue
    }
    let value: string | undefined
    if (original.kind === 'native' && slot.selector.kind === 'native-part') {
      const raw = original.item.contentParts[slot.selector.partIndex]!, body = options.resolved.get(key) ?? raw
      if (narrow && body.kind !== 'text' && !(body.kind === 'resource' && body.content?.kind === 'text')) { excluded.push(part); continue }
      phase ??= original.item.messagePhase
      switch (body.kind) {
        case 'text': value = body.text; break
        case 'reasoning': value = body.redacted ? '[Reasoning redacted by original source]' : body.text; break
        case 'tool-call': value = `${body.name}\n${body.input}`; break
        case 'tool-result': value = `${body.name ?? 'Tool result'}${body.failed === undefined ? '' : body.failed ? ' · failed' : ' · recorded result'}\n${body.output}`; break
        case 'resource': gap(body.content && body.content.kind !== 'resource' ? 'resource-unavailable' : 'transport-unsupported'); continue
      }
      // Question projection describes these same original parts. Its prompt is
      // emitted once, while every option and recorded answer remains complete.
      if (!questions.has(record.id) && original.item.questionRequest) {
        questions.add(record.id)
        const suffix = original.item.questionRequest.questions.map(q => [value?.includes(q.prompt) ? '' : q.prompt,
          ...q.options.map(option => `- ${option.label}`), q.acceptsText ? 'Free text is accepted by the original request.' : '',
          'Recorded question · read-only; use the original amux interaction.'].filter(Boolean).join('\n')).join('\n\n')
        value = [value, suffix].filter(Boolean).join('\n\n')
      }
      if (!questions.has(record.id + ':answers') && original.item.questionAnswers?.length) {
        questions.add(record.id + ':answers')
        value = [value, ...original.item.questionAnswers.map(answer => `Recorded answer (${answer.questionId})${value?.includes(answer.answer) ? '' : `: ${answer.answer}`}`)].filter(Boolean).join('\n\n')
      }
    } else if (original.kind === 'captured' && slot.selector.kind === 'captured-field') {
      value = original.item[slot.selector.field]
      if (slot.selector.field !== 'content') value = `${slot.selector.field === 'toolInput' ? 'Tool input' : 'Tool output'}\n${value ?? ''}`
    }
    if (value !== undefined) {
      const author = original.kind === 'captured' && original.item.kind === 'user_message' && slot.selector.kind === 'captured-field' && slot.selector.field === 'content'
        ? conversationRecordAuthor(record, unit.event.reference!.agentSessionId) : undefined
      const source = original.kind === 'native' ? 'Original conversation' : original.item.source
      const label = author ? `${({ human: 'Human user', unknown: 'Unknown author', agent: 'Agent input', external: 'External user', system: 'System' } as const)[author.kind]} · via amux\n`
        : narrow || unit.event.role === 'message' && unit.event.author.kind === 'agent' && slot.placement === 'body' ? ''
        : `[${unit.event.role} · ${source} · ${unit.event.author.kind}${original.kind === 'captured' ? ` · ${original.item.status}` : ''}${unit.event.role === 'message' ? ' · via amux' : ' · read-only'}]\n`
      const text = value ? label + value : ''
      pieces.push({ part, text, ...(author && author.kind !== 'system' ? { relay: { part, author } } : {}) })
      if (text) sections.push(text)
    }
  }
  return { text: sections.join('\n\n'), pieces, ...(phase ? { phase } : {}), gaps, origins, excluded, complete: gaps.length === 0 }
}
