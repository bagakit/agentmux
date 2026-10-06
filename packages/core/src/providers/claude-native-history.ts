import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../conversation-changes.js'
// Native record/role interpretation follows Paseo's convertClaudeHistoryEntry / normalizeHistoryBlocks.
// Source: Paseo 3c6e4e39 (Apache-2.0, Copyright (c) 2025-present Mohamed Boudra). Modified for bounded, read-only pages,
// exact ordered content/resources, neutral unknown activities and native UUID identity.
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader, readNativeConversationChanges } from '../native-jsonl-history-reader.js'
import {
  isNativeText,
  nativeJsonStringify,
  nativeTextConcat,
  nativeTextJoin,
  type NativeTextValue,
  type NativeHistoryContentPart as AgentSessionHistoryContentPart,
  type NativeHistoryItem as AgentSessionHistoryItem
} from '../native-history-value.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage } from '../types.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function formatToolResultOutput(content: unknown): NativeTextValue {
  if (isNativeText(content)) return content
  if (Array.isArray(content)) {
    return nativeTextJoin(content.map((item) => {
      if (isNativeText(item)) return item
      if (item && typeof item === 'object') {
        const text = (item as Record<string, unknown>).text
        if (isNativeText(text)) return text
      }
      return nativeJsonStringify(item)
    }))
  }
  if (content === undefined || content === null) return ''
  return nativeJsonStringify(content)
}

function parts(content: unknown): AgentSessionHistoryContentPart[] {
  if (isNativeText(content)) return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: nativeJsonStringify(content) }]
  return content.flatMap((value): AgentSessionHistoryContentPart[] => {
    const block = object(value)
    if (!block) return [{ kind: 'text', text: nativeJsonStringify(value) }]
    if (block.type === 'text' && isNativeText(block.text)) return [{ kind: 'text', text: block.text }]
    if (block.type === 'thinking') {
      const text = isNativeText(block.thinking) ? block.thinking : isNativeText(block.text) ? block.text : ''
      return [{ kind: 'reasoning', text }]
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool'
      const input = isNativeText(block.input) ? block.input : (block.input === undefined || block.input === null ? '' : nativeJsonStringify(block.input))
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
      if (source?.type === 'base64' && isNativeText(source.data) && typeof source.media_type === 'string') {
        return [{ kind: 'resource', resourceType: 'image', reference: nativeTextConcat(`data:${source.media_type};base64,`, source.data) }]
      }
      if (source?.type === 'url' && isNativeText(source.url) && source.url) {
        return [{ kind: 'resource', resourceType: 'image', reference: source.url }]
      }
    }
    return [{ kind: 'text', text: nativeJsonStringify(block) }]
  })
}

function convert(record: Record<string, unknown>, start: number): AgentSessionHistoryItem {
  const message = object(record.message)
  const attachment = record.type === 'attachment' ? object(record.attachment) : undefined
  // Claude accepts mid-turn prompts as attachments, not additional user turns.
  // Queue logs and the rendered system wrapper do not establish accepted speech.
  const queuedInput = attachment?.type === 'queued_command' && attachment.commandMode === 'prompt' &&
    isNativeText(attachment.prompt)
  const content = queuedInput ? attachment.prompt : message?.content
  const blocks = Array.isArray(content) ? content : []

  // Generated records remain neutral even when they carry a prompt-shaped attachment.
  const isGenerated = record.isCompactSummary === true || record.isSynthetic === true || record.isMeta === true
  const isNeutralActivity = (!message && !queuedInput) || content === undefined ||
    isGenerated ||
    (!queuedInput && record.type !== 'user' && record.type !== 'assistant')

  let kind: AgentSessionHistoryItem['kind']
  if (record.type === 'system' && message && content !== undefined && !isGenerated) {
    kind = 'system-message'
  } else if (isNeutralActivity) {
    kind = 'activity'
  } else if (record.type === 'user' || queuedInput) {
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
      return obj?.type === 'text' && isNativeText(obj.text) && obj.text.length > 0
    }) || (isNativeText(content) && content.length > 0)
    kind = hasAssistantText ? 'assistant-message' : 'activity'
  }

  const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const turnId = typeof record.user_message_uuid === 'string' && record.user_message_uuid.length > 0
    ? record.user_message_uuid
    : undefined

  return {
    id: typeof record.uuid === 'string' && record.uuid ? record.uuid : `claude-record:${start}`,
    kind,
    contentParts: message || queuedInput && kind === 'user-message' ? parts(content) : [{ kind: 'text', text: nativeJsonStringify(record) }],
    ...(kind === 'system-message' ? { title: 'System instructions' } : queuedInput && kind === 'user-message' ? { title: '运行中追加' } :
      kind === 'activity' ? { title: typeof record.type === 'string' ? `Claude ${record.type}` : 'Claude activity' } : {}),
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
    return { source: context.source, items: await Promise.all(items.reverse().map(item => reader.materializeItem(item))), nextCursor, sourceSizeBytes: reader.sourceSizeBytes }
  } finally { await reader.close() }
}

/** Append paging uses the same Provider converter and physical JSONL owner as history reading. */
export async function readClaudeConversationChanges(context: ProviderConversationChangesContext): Promise<ProviderConversationChangesPage> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    return await readNativeConversationChanges(reader, context, (row, start) => {
      if (row.isSidechain === true) return null
      if (row.sessionId !== context.source.nativeSessionId) {
        if (row.sessionId === undefined && row.type !== 'user' && row.type !== 'assistant') return null
        throw new AgentMuxError('Claude transcript belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      return convert(row, start)
    })
  } finally { await reader.close() }
}
