// Native record/role interpretation follows Paseo's convertClaudeHistoryEntry / normalizeHistoryBlocks.
// Source: Paseo 3c6e4e39 (Apache-2.0, Copyright (c) 2025-present Mohamed Boudra). Modified for bounded, read-only pages,
// exact ordered content/resources, neutral unknown activities and native UUID identity.
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart, AgentSessionHistoryItem } from '../types.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parts(content: unknown): AgentSessionHistoryContentPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: JSON.stringify(content) }]
  return content.flatMap((value): AgentSessionHistoryContentPart[] => {
    const block = object(value)
    if (!block) return [{ kind: 'text', text: JSON.stringify(value) }]
    if (block.type === 'text' && typeof block.text === 'string') return [{ kind: 'text', text: block.text }]
    if (block.type === 'thinking' && typeof block.thinking === 'string') return [{ kind: 'text', text: block.thinking }]
    if (block.type === 'image') {
      const source = object(block.source)
      if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        return [{ kind: 'resource', resourceType: 'image', reference: `data:${source.media_type};base64,${source.data}` }]
      }
      if (source?.type === 'url' && typeof source.url === 'string' && source.url) {
        return [{ kind: 'resource', resourceType: 'image', reference: source.url }]
      }
    }
    if (block.type === 'tool_result') return parts(block.content)
    return [{ kind: 'text', text: JSON.stringify(block) }]
  })
}

function convert(record: Record<string, unknown>, start: number): AgentSessionHistoryItem {
  const message = object(record.message)
  const content = message?.content
  const blocks = Array.isArray(content) ? content : []
  // Tool results, reasoning and mixed tool records are activities, never invented human speech.
  const activity = !message || content === undefined || record.isCompactSummary === true ||
    record.isSynthetic === true || record.isMeta === true || Boolean(record.toolUseResult) || blocks.some((value) => {
    const type = object(value)?.type
    return type !== 'text' && type !== 'image'
  })
  const kind = !activity && record.type === 'user' ? 'user-message'
    : !activity && record.type === 'assistant' ? 'assistant-message' : 'activity'
  const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return { id: typeof record.uuid === 'string' && record.uuid ? record.uuid : `claude-record:${start}`,
    kind, contentParts: message ? parts(content) : [{ kind: 'text', text: JSON.stringify(record) }],
    ...(kind === 'activity' ? { title: typeof record.type === 'string' ? `Claude ${record.type}` : 'Claude activity' } : {}),
    ...(Number.isSafeInteger(time) && time >= 0 ? { startedAt: time } : {}) }
}

export async function readClaudeSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    const items: AgentSessionHistoryItem[] = []
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      if (entry.value.isSidechain === true) continue
      if (entry.value.sessionId !== context.source.nativeSessionId) {
        // Claude bookkeeping can lack a Session ID. Such records have no main-conversation identity.
        if (entry.value.sessionId === undefined && entry.value.type !== 'user' && entry.value.type !== 'assistant') continue
        throw new AgentMuxError('Claude transcript belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      items.push(convert(entry.value, entry.start))
    }
    const nextCursor = await reader.nextCursor()
    return { source: context.source, items: items.reverse(), nextCursor }
  } finally { await reader.close() }
}
