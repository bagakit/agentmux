import type { AgentSessionUserMessage, AgentSessionHistoryContentPart } from '@agentmux/core'
import { readSessionHistoryTextResource, type SessionHistoryResourceReader } from '@agentmux/core/session-history-content'
import { sessionUserMessageText } from '@agentmux/core/session-user-messages'

/** Read the original text parts, never a list preview/title or inferred terminal input. */
export async function inputHistoryText(message: AgentSessionUserMessage, read?: SessionHistoryResourceReader,
  signal?: AbortSignal): Promise<{ text: string; attachments: boolean }> {
  const parts: AgentSessionHistoryContentPart[] = []
  let attachments = false
  for (const [index, original] of message.contentParts.entries()) {
    signal?.throwIfAborted()
    let part = original
    if (part.kind === 'resource' && part.resourceType === 'text') {
      if (!read || message.source.kind !== 'native') throw new Error('完整正文暂不可读。原记录和草稿已保留。')
      part = await readSessionHistoryTextResource(part, index, { source: { providerId: message.source.providerId,
        nativeSessionId: message.source.nativeSessionId }, recordId: message.source.recordId,
        ...(message.turnId ? { turnId: message.turnId } : {}) }, read, signal)
    }
    parts.push(part)
    if (part.kind !== 'text') attachments = true
  }
  signal?.throwIfAborted()
  const text = sessionUserMessageText(parts, message.questionAnswers)
  if (!text.trim()) throw new Error('这条记录没有可回填的正文。附件仍可在原记录中查看。')
  return { text, attachments }
}
