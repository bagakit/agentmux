import { authorProfileFields } from './author-profile.js'
import type {
  AgentProviderId,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryPage,
  AgentSessionHistoryQuestionAnswer,
  AgentSessionUserMessage,
  AgentSessionUserMessageAuthor,
  AgentSessionUserMessageSource,
  AgentTimelineSnapshot
} from './types.js'
import { recordedConversationAuthor } from './conversation-author.js'

function inputConversation(conversation: AgentSessionUserMessage['conversation']): Pick<AgentSessionUserMessage, 'conversation'> {
  if (!conversation) return {}
  const { sameEvent, nativeInput, adoptedInput } = conversation
  return sameEvent || nativeInput || adoptedInput ? { conversation: {
    ...(sameEvent ? { sameEvent } : {}), ...(nativeInput ? { nativeInput } : {}), ...(adoptedInput ? { adoptedInput } : {})
  } } : {}
}

function encodeSegment(s: string): string {
  return s.replace(/%/g, '%25').replace(/:/g, '%3A')
}

function buildNativeMessageStableId(
  providerId: AgentProviderId,
  nativeSessionId: string,
  recordId: string
): string {
  return `native:${providerId}:${encodeSegment(nativeSessionId)}:${encodeSegment(recordId)}`
}

/** Providers interpret native wrappers once; clients read the exact span and copy the original text. */
export function sessionHistoryTextForReading(part: Extract<AgentSessionHistoryContentPart, { kind: 'text' }>): string {
  return part.readingRange === undefined ? part.text : part.text.slice(part.readingRange.start, part.readingRange.end)
}

export function sessionUserMessageText(contentParts: readonly AgentSessionHistoryContentPart[], questionAnswers?: readonly AgentSessionHistoryQuestionAnswer[]): string {
  const texts: string[] = []
  const answerText = questionAnswers?.length ? questionAnswers.map(answer => answer.answer).join('\n\n') : undefined
  let answersPlaced = false
  for (const part of contentParts) {
    if (part.kind !== 'text') continue
    if (answerText !== undefined && !answersPlaced) {
      texts.push(answerText)
      answersPlaced = true
    } else {
      texts.push(sessionHistoryTextForReading(part))
    }
  }
  if (answerText !== undefined && !answersPlaced) texts.unshift(answerText)
  return texts.join('\n')
}

export function projectSessionUserMessages(params: {
  agentSessionId: string
  historyPage?: AgentSessionHistoryPage | undefined
  timeline?: AgentTimelineSnapshot | undefined
}): AgentSessionUserMessage[] {
  const { agentSessionId, historyPage, timeline } = params
  const result: AgentSessionUserMessage[] = []
  const seenNativeIds = new Set<string>()
  const seenCapturedIds = new Set<string>()

  // 1. Process native user messages from historyPage (only if matching the target agentSessionId)
  if (historyPage && historyPage.items && historyPage.agentSessionId === agentSessionId) {
    for (const item of historyPage.items) {
      if (item.kind !== 'user-message' || item.conversation?.adoptedInput?.purpose === 'a2a-notification') continue
      const stableId = buildNativeMessageStableId(
        historyPage.source.providerId,
        historyPage.source.nativeSessionId,
        item.id
      )
      if (seenNativeIds.has(stableId)) continue
      seenNativeIds.add(stableId)

      const content = sessionUserMessageText(item.contentParts, item.questionAnswers) || item.title || ''
      const author: AgentSessionUserMessageAuthor = { kind: 'unknown' }
      const source: AgentSessionUserMessageSource = {
        kind: 'native',
        providerId: historyPage.source.providerId,
        nativeSessionId: historyPage.source.nativeSessionId,
        recordId: item.id
      }

      result.push({
        id: stableId,
        rawId: item.id,
        agentSessionId,
        ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
        source,
        ...inputConversation(item.conversation),
        author,
        publicContent: 'unknown',
        content,
        contentParts: [...item.contentParts],
        ...(item.questionAnswers === undefined ? {} : { questionAnswers: item.questionAnswers }),
        ...(item.questionDiagnostic === undefined ? {} : { questionDiagnostic: item.questionDiagnostic }),
        ...(item.startedAt !== undefined ? { recordedAt: item.startedAt } : {})
      })
    }
  }

  // 2. Process captured timeline items (if timeline supplied)
  if (timeline && timeline.items) {
    const positions = new Map(timeline.stream?.positions.map(position => [position.id, position]) ?? [])
    for (const item of timeline.items) {
      if (item.kind !== 'user_message') continue
      if (item.agentSessionId !== agentSessionId) continue
      const rawId = item.id
      if (seenCapturedIds.has(rawId)) continue
      seenCapturedIds.add(rawId)

      const author = recordedConversationAuthor(item)

      const source: AgentSessionUserMessageSource = {
        kind: 'captured',
        submissionId: item.id,
        ...(item.sourceChannel === undefined ? {} : { channel: item.sourceChannel }),
        ...(item.sourceDevice ? { device: { ...item.sourceDevice } } : {})
      }

      const deliveryStatus = item.status === 'complete'
        ? 'complete'
        : item.status === 'failed'
          ? 'failed'
          : 'unverified'

      result.push({
        id: `captured:${item.id}`,
        ...authorProfileFields(item.authorProfile),
        ...(item.inputImages === undefined ? {} : { inputImages: structuredClone(item.inputImages) }),
        ...(item.inputContext ? { inputContext: structuredClone(item.inputContext), ...(item.inputContextSource ? { inputContextSource: item.inputContextSource, ...(item.inputContextCaptureProof ? { inputContextCaptureProof: item.inputContextCaptureProof } : {}) } : {}) } : {}),
        rawId,
        agentSessionId,
        source,
        ...inputConversation(item.conversation),
        ...(item.source === 'user' && item.publicContent === 'confirmed' && item.inputRef ? { inputRef: item.inputRef } : {}),
        ...(item.inputSubmission ? { inputSubmission: item.inputSubmission } : {}),
        ...(timeline.sourceHostId && positions.get(item.id)?.revision ? { sourceRecord: {
          record: { hostId: timeline.sourceHostId, agentSessionId, source: { kind: 'captured' as const, recordId: item.id } },
          revision: positions.get(item.id)!.revision
        } } : {}),
        author,
        publicContent: item.publicContent === 'confirmed' ? 'confirmed' : 'unknown',
        content: item.content ?? '',
        contentParts: [{ kind: 'text', text: item.content ?? '' }],
        recordedAt: item.createdAt,
        deliveryStatus
      })
    }
  }

  return result
}
