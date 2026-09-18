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

function formatToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') return text
      }
      return JSON.stringify(item)
    }).join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

function parts(content: unknown): AgentSessionHistoryContentPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: JSON.stringify(content) }]
  return content.flatMap((value): AgentSessionHistoryContentPart[] => {
    const block = object(value)
    if (!block) return [{ kind: 'text', text: JSON.stringify(value) }]
    if (block.type === 'text' && typeof block.text === 'string') return [{ kind: 'text', text: block.text }]
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : ''
      return [{ kind: 'reasoning', text }]
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool'
      const input = typeof block.input === 'string' ? block.input : (block.input === undefined || block.input === null ? '' : JSON.stringify(block.input))
      const callId = typeof block.id === 'string' && block.id ? block.id : undefined
      return [{ kind: 'tool-call', name, input, ...(callId ? { callId } : {}) }]
    }
    if (block.type === 'tool_result') {
      const callId = typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : undefined
      const failed = block.is_error === true ? true : undefined
      return [{ kind: 'tool-result', output: formatToolResultOutput(block.content), ...(callId ? { callId } : {}), ...(failed ? { failed } : {}) }]
    }
    if (block.type === 'image') {
      const source = object(block.source)
      if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        return [{ kind: 'resource', resourceType: 'image', reference: `data:${source.media_type};base64,${source.data}` }]
      }
      if (source?.type === 'url' && typeof source.url === 'string' && source.url) {
        return [{ kind: 'resource', resourceType: 'image', reference: source.url }]
      }
    }
    return [{ kind: 'text', text: JSON.stringify(block) }]
  })
}

function convert(record: Record<string, unknown>, start: number): AgentSessionHistoryItem {
  const message = object(record.message)
  const content = message?.content
  const blocks = Array.isArray(content) ? content : []

  // Synthetic, meta, compact summaries or non-user/assistant records are always neutral activities.
  const isNeutralActivity = !message || content === undefined ||
    record.isCompactSummary === true || record.isSynthetic === true || record.isMeta === true ||
    (record.type !== 'user' && record.type !== 'assistant')

  let kind: 'user-message' | 'assistant-message' | 'activity'
  if (isNeutralActivity) {
    kind = 'activity'
  } else if (record.type === 'user') {
    // Tool result turns in Claude are sent under role 'user', often with tool_use_result on the record
    // or containing only tool_result blocks. These are activities, never human user speech.
    const isToolResultTurn = Boolean(record.toolUseResult) || (
      blocks.length > 0 && blocks.every((b) => object(b)?.type === 'tool_result')
    )
    kind = isToolResultTurn ? 'activity' : 'user-message'
  } else {
    // record.type === 'assistant'
    // Keep pure tool/reasoning-only records as activity; mixed records with genuine assistant text are assistant-message.
    const hasAssistantText = blocks.some((b) => {
      const obj = object(b)
      return obj?.type === 'text' && typeof obj.text === 'string' && obj.text.length > 0
    }) || (typeof content === 'string' && content.length > 0)
    kind = hasAssistantText ? 'assistant-message' : 'activity'
  }

  const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const turnId = typeof record.user_message_uuid === 'string' && record.user_message_uuid.length > 0
    ? record.user_message_uuid
    : undefined

  return {
    id: typeof record.uuid === 'string' && record.uuid ? record.uuid : `claude-record:${start}`,
    kind,
    contentParts: message ? parts(content) : [{ kind: 'text', text: JSON.stringify(record) }],
    ...(kind === 'activity' ? { title: typeof record.type === 'string' ? `Claude ${record.type}` : 'Claude activity' } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(Number.isSafeInteger(time) && time >= 0 ? { startedAt: time } : {})
  }
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
