import type {
  AgentProviderId,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryPage,
  AgentSessionUserMessage,
  AgentSessionUserMessageAuthor,
  AgentSessionUserMessageSource,
  AgentTimelineSnapshot
} from './types.js'

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

function extractUserMessageText(contentParts: readonly AgentSessionHistoryContentPart[]): string {
  const texts = contentParts
    .filter((part): part is Extract<AgentSessionHistoryContentPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
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
      if (item.kind !== 'user-message') continue
      const stableId = buildNativeMessageStableId(
        historyPage.source.providerId,
        historyPage.source.nativeSessionId,
        item.id
      )
      if (seenNativeIds.has(stableId)) continue
      seenNativeIds.add(stableId)

      const content = extractUserMessageText(item.contentParts) || item.title || ''
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
        author,
        content,
        contentParts: [...item.contentParts],
        ...(item.startedAt !== undefined ? { recordedAt: item.startedAt } : {})
      })
    }
  }

  // 2. Process captured timeline items (if timeline supplied)
  if (timeline && timeline.items) {
    for (const item of timeline.items) {
      if (item.kind !== 'user_message') continue
      if (item.agentSessionId !== agentSessionId) continue
      const rawId = item.id
      if (seenCapturedIds.has(rawId)) continue
      seenCapturedIds.add(rawId)

      const author: AgentSessionUserMessageAuthor = item.authorAgentSessionId !== undefined
        ? { kind: 'agent', agentSessionId: item.authorAgentSessionId }
        : { kind: 'unknown' }

      const source: AgentSessionUserMessageSource = {
        kind: 'captured',
        submissionId: item.id
      }

      const deliveryStatus = item.status === 'complete'
        ? 'complete'
        : item.status === 'failed'
          ? 'failed'
          : 'unverified'

      result.push({
        id: `captured:${item.id}`,
        rawId,
        agentSessionId,
        source,
        author,
        content: item.content ?? '',
        contentParts: [{ kind: 'text', text: item.content ?? '' }],
        recordedAt: item.createdAt,
        deliveryStatus
      })
    }
  }

  return result
}
