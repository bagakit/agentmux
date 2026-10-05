import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, type NativeHistoryContentPart, type NativeHistoryItem } from '../native-history-value.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage,
  AgentProviderSessionHistoryRecordContext, AgentSessionHistoryItem } from '../types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const text = (value: unknown) => isNativeText(value) ? value : value === undefined ? '' : nativeJsonStringify(value)

function contentParts(content: unknown): NativeHistoryContentPart[] {
  if (isNativeText(content)) return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: nativeJsonStringify(content) }]
  return content.map(value => {
    const part = object(value)
    if (['input_text', 'output_text', 'text', 'summary_text'].includes(String(part.type)) && isNativeText(part.text)) {
      return { kind: 'text', text: part.text }
    }
    if (part.type === 'input_image' && isNativeText(part.image_url)) return { kind: 'resource', resourceType: 'image', reference: part.image_url }
    return { kind: 'text', text: nativeJsonStringify(value) }
  })
}

function item(record: Record<string, unknown>, start: number): NativeHistoryItem | null {
  const payload = object(record.payload), type = payload.type
  if (record.type === 'session_meta' || record.type === 'turn_context') return null
  let kind: NativeHistoryItem['kind'] = 'activity', parts: NativeHistoryContentPart[]
  if (record.type === 'response_item' && type === 'message') {
    kind = payload.role === 'user' ? 'user-message' : payload.role === 'assistant' ? 'assistant-message' : 'activity'
    parts = contentParts(payload.content)
  } else if (record.type === 'response_item' && type === 'reasoning') {
    parts = contentParts(payload.summary).map(part => part.kind === 'text' ? { kind: 'reasoning', text: part.text } : part)
  } else if (record.type === 'response_item' && (type === 'function_call' || type === 'custom_tool_call')) {
    parts = [{ kind: 'tool-call', name: typeof payload.name === 'string' ? payload.name : 'tool',
      input: text(type === 'function_call' ? payload.arguments : payload.input),
      ...(typeof payload.call_id === 'string' ? { callId: payload.call_id } : {}) }]
  } else if (record.type === 'response_item' && (type === 'function_call_output' || type === 'custom_tool_call_output')) {
    parts = [{ kind: 'tool-result', output: text(payload.output), ...(typeof payload.call_id === 'string' ? { callId: payload.call_id } : {}) }]
  } else if (record.type === 'event_msg' && (type === 'user_message' || type === 'agent_message')) {
    // Native event copies are activity, so the corresponding original response_item is not duplicated as speech.
    parts = [{ kind: 'text', text: text(payload.message) }]
  } else if (record.type === 'event_msg' && type === 'token_count') return null
  else if (record.type === 'compacted' && isNativeText(payload.message)) parts = [{ kind: 'text', text: payload.message }]
  else parts = [{ kind: 'text', text: nativeJsonStringify(payload) }]
  const timestamp = Date.parse(String(record.timestamp)), id = typeof payload.id === 'string' && payload.id ? payload.id : `codex-record:${start}`
  return { id, kind, contentParts: parts,
    ...(typeof payload.turn_id === 'string' ? { turnId: payload.turn_id } : {}),
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    ...(kind === 'activity' ? { title: String(type ?? record.type) } : {}) }
}

async function open(context: AgentProviderSessionHistoryContext): Promise<NativeJsonlHistoryReader> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    const metadata = await reader.readFirst(), payload = object(metadata?.payload)
    if (metadata?.type !== 'session_meta' || payload.id !== context.source.nativeSessionId || payload.cwd !== context.workspacePath) {
      throw new AgentMuxError('The saved Codex transcript belongs to another native conversation or directory.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    return reader
  } catch (error) { await reader.close(); throw error }
}

/** Exact saved rollout is a native source, independent of the availability of an indexed CLI read helper. */
export async function readCodexSavedSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const reader = await open(context)
  try {
    const items: NativeHistoryItem[] = []
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      const converted = item(entry.value, entry.start)
      if (converted) items.push(converted)
    }
    const nextCursor = await reader.nextCursor()
    return { source: context.source, items: await Promise.all(items.reverse().map(value => reader.materializeItem(value))),
      nextCursor, sourceSizeBytes: reader.sourceSizeBytes }
  } finally { await reader.close() }
}

export async function readCodexSavedSessionHistoryRecord(context: AgentProviderSessionHistoryRecordContext): Promise<AgentSessionHistoryItem> {
  const reader = await open({ ...context, limit: 1 })
  try {
    for (let entry = await reader.readPrevious(); entry; entry = await reader.readPrevious()) {
      const converted = item(entry.value, entry.start)
      if (converted?.id === context.recordId && (context.turnId === undefined || converted.turnId === context.turnId)) {
        await reader.verifyUnchanged()
        return await reader.materializeItem(converted)
      }
    }
    throw new AgentMuxError('The original saved Codex record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
  } finally { await reader.close() }
}
