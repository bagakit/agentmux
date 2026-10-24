import { AgentMuxError, type AgentPromptInputKey } from '@agentmux/core'
import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { conversationRecordAuthor, conversationRecordId, conversationInputKey, type ConversationSourceRecord, type ConversationCheckpoint, type ConversationContentRef, type ConversationUnit } from '@agentmux/core/conversation'
import type { PublicationImage, PublicationFile, PublicationMarkdown, ResolvedPublicationPart } from './publication-resource.js'
import type { ConnectionDeliveryGap, ConnectionDeliveryRelay, ConnectionOriginRepresentation, RoomBinding } from '@agentmux/core/connections'

export type PublicationContentPlan = {
  text: string
  pieces: Array<{ part: ConversationContentRef; text: string; image?: PublicationImage; file?: PublicationFile; segments?: PublicationMarkdown['segments']; contentEligibility?: 'public'; purpose?: 'conversation'; relay?: ConnectionDeliveryRelay['sources'][number]; publicInputKey?: AgentPromptInputKey }>
  relay?: ConnectionDeliveryRelay
  phase?: 'progress' | 'final'
  inputSubmission?: import('@agentmux/core').AgentInputSubmissionObservation
  gaps: ConnectionDeliveryGap[]
  origins: ConnectionOriginRepresentation[]
  excluded: ConversationContentRef[]
  /** Empty supported content can withdraw a previously delivered representation; a gap cannot. */
  complete: boolean
}
export type PublicationContentOptions = {
  resolved: ReadonlyMap<string, ResolvedPublicationPart>
  origin(recordId: string): ConnectionOriginRepresentation['origin'] | undefined
  selected?: ConversationContentRef
  /** A new operation carries original typed attribution separately from authored text. */
  attributed?: boolean
}
export const publicationPartKey = (part: Pick<ConversationContentRef, 'record' | 'selector'>) => {
  const selector = part.selector.kind === 'native-part' ? { kind: 'native-part', partIndex: part.selector.partIndex } : { kind: 'captured-field', field: part.selector.field }
  return JSON.stringify([conversationRecordId(part.record), selector])
}

/** Original message and per-part Provider purpose select sharing; bytes and presentation cannot. */
export function isConversationPublicationPart(record: ConversationSourceRecord, selector: ConversationContentRef['selector'], author: ConversationUnit['event']['author']): boolean {
  const { original } = record
  if (original.kind === 'captured') {
    const item = original.item
    return selector.kind === 'captured-field' && selector.field === 'content' &&
      (item.kind === 'user_message' || item.kind === 'assistant_message') &&
      !item.a2aNotificationId && !(item.kind === 'user_message' && item.authorAgentSessionId)
  }
  const item = original.item
  if (selector.kind !== 'native-part' ||
    item.collaboration || item.conversation?.adoptedInput?.purpose === 'a2a-notification' || item.kind === 'user-message' && author.kind === 'agent') return false
  const part = item.contentParts[selector.partIndex]
  if (!part || part.contentRole === 'tool' || part.contentRole === 'reasoning') return false
  // The Provider can give a typed artifact its own public purpose while keeping the raw tool result unconfirmed.
  if (item.kind === 'activity') return part.kind === 'resource' && part.contentEligibility === 'public' && (!part.content || part.content.kind === 'text' || part.content.kind === 'resource')
  if (!['user-message', 'assistant-message'].includes(item.kind)) return false
  // Typed question/answer projections can share their ordinary content without sending the raw tool envelope.
  if (part.kind === 'tool-call') return item.questionRequest !== undefined
  if (part.kind === 'tool-result') return !!item.questionAnswers?.length
  return part.kind === 'text' || part.kind === 'resource' && (!part.content || part.content.kind === 'text' || part.content.kind === 'resource')
}

/** Platform representation only. Identity, role, author, order and relations are accepted Core facts. */
export function publicationContent(unit: ConversationUnit, binding: Pick<RoomBinding, 'bindingId' | 'connectionId' | 'externalConversationId' | 'scope' | 'sourceFrontier'>, frontier: ConversationCheckpoint, options: PublicationContentOptions): PublicationContentPlan {
  if (unit.records.some(record => !isCompleteConversationRecord(record))) throw new AgentMuxError('Publication requires complete original records; read the same checkpoint without deferred process details.', 'PUBLICATION_COMPLETE_RECORDS_REQUIRED')
  const records = new Map(unit.records.map(record => [record.id, record])), gaps: ConnectionDeliveryGap[] = [], origins: ConnectionOriginRepresentation[] = [], excluded: ConversationContentRef[] = []
  const event = { id: unit.event.id, revision: unit.event.revision }, sections: string[] = [], pieces: PublicationContentPlan['pieces'] = [], questions = new Set<string>()
  const narrow = binding.scope.publication === 'future-native-user-facing'
  let phase: 'progress' | 'final' | undefined
  for (const slot of unit.event.content) {
    const record = records.get(slot.recordId)!
    const part: ConversationContentRef = { record: record.reference!, recordRevision: record.revision, selector: slot.selector }
    if (!isCompleteConversationRecord(record)) continue // Complete originals were required before planning or mutation.
    const original = record.original, key = publicationPartKey(part)
    if (options.selected && publicationPartKey(options.selected) !== key) continue
    if (narrow && (original.kind !== 'native' || !['message', 'interaction'].includes(unit.event.role) || unit.event.author.kind !== 'agent')) { excluded.push(part); continue }
    if (!isConversationPublicationPart(record, slot.selector, unit.event.author)) { excluded.push(part); continue }
    const gap = (reason: ConnectionDeliveryGap['reason']) => gaps.push({ gapId: key, event, part,
      anchor: { record: part.record, revision: part.recordRevision, frontier }, reason })
    if (original.kind === 'captured') {
      const start = binding.sourceFrontier?.frontier.cuts.find(c => c.kind === 'captured')
      if (!start || start.kind !== 'captured' || record.order.kind !== 'captured-stream' || record.order.epoch !== start.epoch || record.order.firstSequence <= start.sequence) { gap('start-cut-unconfirmed'); continue }
      const inputOrigin = original.item.inputOrigin
      if (inputOrigin && (!start.inputJournal || inputOrigin.queueId !== start.inputJournal.queueId || inputOrigin.incarnation !== start.inputJournal.incarnation || inputOrigin.sequence <= start.inputJournal.sequence)) { gap('start-cut-unconfirmed'); continue }
    }
    if (original.kind === 'native') {
      if (original.item.kind === 'user-message' && original.item.conversation?.adoptedInput && unit.event.author.kind === 'unknown') {
        gap('public-content-unconfirmed'); continue
      }
      const eligibility = slot.selector.kind === 'native-part' ? original.item.contentParts[slot.selector.partIndex]?.contentEligibility : undefined
      if (eligibility === 'private') { excluded.push(part); continue }
      if (eligibility !== 'public') { gap('public-content-unconfirmed'); continue }
    }
    if (original.kind === 'captured' && slot.selector.kind === 'captured-field' && slot.selector.field === 'content') {
      const eligibility = original.item.contentEligibility
      if (eligibility === 'private') { excluded.push(part); continue }
      if (eligibility === 'unconfirmed') { gap('public-content-unconfirmed'); continue }
    }
    // Captured writers retain their own explicit public input contract. Native
    // parts above carry the original Provider purpose independently of display kind.
    if (original.kind === 'captured' && (original.item.kind === 'user_message' && original.item.publicContent !== 'confirmed' || original.item.kind === 'system_message' && original.item.source === 'agentmux')) { gap('public-content-unconfirmed'); continue }
    const external = original.kind === 'captured' ? original.item.authorExternal : undefined
    if (external && external.connectionId === binding.connectionId && external.externalConversationId === binding.externalConversationId && external.bindingId === binding.bindingId) {
      const origin = options.origin(record.id)
      if (origin) { origins.push({ event, part, origin }); continue }
      gap('public-content-unconfirmed'); continue
    }
    let value: string | undefined, segments: PublicationMarkdown['segments'] | undefined
    if (original.kind === 'native' && slot.selector.kind === 'native-part') {
      const raw = original.item.contentParts[slot.selector.partIndex]!, body = options.resolved.get(key) ?? raw
      if (narrow && body.kind !== 'text' && body.kind !== 'markdown' && !(body.kind === 'resource' && body.content?.kind === 'text')) { excluded.push(part); continue }
      phase ??= original.item.messagePhase
      if ((body.kind === 'image-unavailable' || body.kind === 'file-unavailable')) { gap('resource-unavailable'); continue }
      if (body.kind === 'image') { pieces.push({ part, text: '', image: body.image, contentEligibility: 'public', purpose: 'conversation' }); continue }
      if (body.kind === 'file') { pieces.push({ part, text: '', file: body.file, contentEligibility: 'public', purpose: 'conversation' }); continue }
      switch (body.kind) {
        case 'text': value = body.text; break
        case 'markdown':
          value = body.text; segments = [...body.segments]
          if (!body.complete) gap('resource-unavailable')
          break
        case 'tool-call': case 'tool-result': break // Only the typed question/answer below is shared.
        case 'reasoning': excluded.push(part); continue
        case 'resource': gap(body.content && body.content.kind !== 'resource' ? 'resource-unavailable' : 'transport-unsupported'); continue
      }
      // Question projection describes these same original parts. Its prompt is
      // emitted once, while every option and recorded answer remains complete.
      if (!questions.has(record.id) && original.item.questionRequest) {
        questions.add(record.id)
        const suffix = original.item.questionRequest.questions.map(q => [value?.includes(q.prompt) ? '' : q.prompt,
          ...q.options.map(option => `- ${option.label}`), q.acceptsText ? 'Free text is accepted by the original request.' : '',
          'Original recorded question.'].filter(Boolean).join('\n')).join('\n\n')
        value = [value, suffix].filter(Boolean).join('\n\n')
      }
      if (!questions.has(record.id + ':answers') && original.item.questionAnswers?.length) {
        questions.add(record.id + ':answers')
        value = [value, ...original.item.questionAnswers.map(answer => `Recorded answer (${answer.questionId})${value?.includes(answer.answer) ? '' : `: ${answer.answer}`}`)].filter(Boolean).join('\n\n')
      }
      if (body.kind === 'markdown' && value && value.length > body.text.length) segments!.push({ text: value.slice(body.text.length) })
    } else if (original.kind === 'captured' && slot.selector.kind === 'captured-field') {
      value = original.item[slot.selector.field]
    }
    if (value !== undefined) {
      const author = original.kind === 'captured' && original.item.kind === 'user_message' && slot.selector.kind === 'captured-field' && slot.selector.field === 'content'
        ? conversationRecordAuthor(record, unit.event.reference!.agentSessionId) : undefined
      const source = original.kind === 'native' ? 'Original conversation' : original.item.source
      const label = options.attributed ? '' : author ? `${({ human: 'Human user', unknown: 'Unknown author', agent: 'Agent input', external: 'External user', system: 'System' } as const)[author.kind]} · via amux\n`
        : narrow || unit.event.role === 'message' && unit.event.author.kind === 'agent' && slot.placement === 'body' ? ''
        : `[${unit.event.role} · ${source} · ${unit.event.author.kind}${original.kind === 'captured' ? ` · ${original.item.status}` : ''}${unit.event.role === 'message' ? ' · via amux' : ' · read-only'}]\n`
      const text = value ? label + value : ''
      pieces.push({ part, text, ...(segments ? { segments: label ? [{ text: label }, ...segments] : segments } : {}), purpose: 'conversation', ...(original.kind === 'native' ? { contentEligibility: 'public' as const } : {}),
        ...(original.kind === 'captured' && original.item.kind === 'user_message' && conversationInputKey(record) ? { publicInputKey: original.item.inputRef! } : {}),
        ...(author && author.kind !== 'system' ? { relay: { part, author } } : {}) })
      if (text) sections.push(text)
    }
  }
  const inputs = unit.records.flatMap(record => record.original.kind === 'captured' && record.original.item.inputOrigin && record.original.item.inputSubmission && record.original.item.authorHuman === true
    ? [{ key: record.original.item.inputRef, observation: record.original.item.inputSubmission }] : [])
  const inputSubmission = inputs.length && new Set(inputs.map(value => JSON.stringify(value.key))).size === 1 ? inputs[0]!.observation : undefined
  return { text: sections.join('\n\n'), pieces, ...(phase ? { phase } : {}), ...(inputSubmission ? { inputSubmission } : {}), gaps, origins, excluded, complete: gaps.length === 0 }
}
