import { stat } from 'node:fs/promises'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import { isNativeText, nativeJsonStringify, type NativeHistoryContentPart, type NativeHistoryItem } from '../native-history-value.js'
import { codexQuestionAnswers } from './codex-question.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage,
  AgentProviderSessionHistoryRecordContext, AgentSessionHistoryItem } from '../types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const text = (value: unknown) => isNativeText(value) ? value : value === undefined ? '' : nativeJsonStringify(value)

function systemMessage(payload: Record<string, unknown>): { kind: 'system-message'; title: string } | undefined {
  if (payload.role === 'system' || payload.role === 'developer') return { kind: 'system-message', title: 'System instructions' }
  if (payload.role !== 'user') return undefined
  // Only the native structured content kinds identify injected context. Textual
  // wrappers and unknown/mixed metadata remain original user speech.
  const kinds = object(payload.internal_chat_message_metadata_passthrough).content_item_kinds
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(kind =>
    kind === 'environments.environment_context' || kind === 'agents_md.instructions')) return undefined
  return { kind: 'system-message', title: kinds.includes('agents_md.instructions') ? 'System instructions' : 'Runtime context' }
}

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
  let kind: NativeHistoryItem['kind'] = 'activity', parts: NativeHistoryContentPart[], title: string | undefined
  if (record.type === 'response_item' && type === 'message') {
    const system = systemMessage(payload)
    title = system?.title
    kind = system?.kind ?? (payload.role === 'user' ? 'user-message' : payload.role === 'assistant' ? 'assistant-message' : 'activity')
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
  // The saved rollout spells the native text part input_text. Reuse the same
  // complete-reply protocol as indexed history without changing original parts.
  const questionAnswers = kind === 'user-message' ? codexQuestionAnswers(Array.isArray(payload.content)
    ? payload.content.map(part => object(part).type === 'input_text' ? { ...object(part), type: 'text' } : part)
    : payload.content) : undefined
  const timestamp = Date.parse(String(record.timestamp)), id = typeof payload.id === 'string' && payload.id ? payload.id : `codex-record:${start}`
  return { id, kind, contentParts: parts,
    ...(questionAnswers === undefined ? {} : { questionAnswers }),
    ...(typeof payload.turn_id === 'string' ? { turnId: payload.turn_id } : {}),
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    ...(title ? { title } : kind === 'activity' ? { title: String(type ?? record.type) } : {}) }
}

/** Optional answer details cannot make the original saved history exceed its existing read budget. */
function fitQuestionAnswerProjection(context: AgentProviderSessionHistoryContext, items: AgentSessionHistoryItem[], nextCursor: string | null): AgentSessionHistoryItem[] {
  if (!items.some(item => item.questionAnswers !== undefined)) return items
  const projected = [...items]
  // Match the Provider page envelope checked by normalizeSessionHistoryPage.
  let pageBytes = Buffer.byteLength(JSON.stringify({ source: context.source, items, nextCursor }))
  if (pageBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) return items
  const diagnostic = { code: 'CODEX_QUESTION_ANSWER_DETAILS_UNAVAILABLE',
    message: 'Answer details did not fit this history page’s existing byte budget. The original reply remains complete and readable/copyable.' }
  const candidates = items.flatMap((item, index) => {
    if (item.questionAnswers === undefined) return []
    const { questionAnswers: _answers, ...original } = item
    const originalBytes = Buffer.byteLength(JSON.stringify(original))
    return [{ index, original, originalBytes, savedBytes: Buffer.byteLength(JSON.stringify(item)) - originalBytes }]
  }).sort((a, b) => b.savedBytes - a.savedBytes)
  const withdrawn: typeof candidates = []
  // First preserve as many answers as fit; diagnostics cannot displace another answer.
  for (const candidate of candidates) {
    projected[candidate.index] = candidate.original
    pageBytes -= candidate.savedBytes
    withdrawn.push(candidate)
    if (pageBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) break
  }
  const unreported: string[] = []
  for (const candidate of withdrawn) {
    const value = { ...candidate.original, questionDiagnostic: diagnostic }
    const addedBytes = Buffer.byteLength(JSON.stringify(value)) - candidate.originalBytes
    if (pageBytes + addedBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) {
      projected[candidate.index] = value
      pageBytes += addedBytes
    } else unreported.push(candidate.original.id)
  }
  if (unreported.length) console.warn('Codex history answer details and their diagnostic did not fit the existing page budget. Original reply content is preserved.',
    { source: context.source, recordIds: unreported })
  return projected
}

async function open(context: AgentProviderSessionHistoryContext): Promise<NativeJsonlHistoryReader> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    const metadata = await reader.readFirst(), payload = object(metadata?.payload)
    if (metadata?.type !== 'session_meta' || payload.id !== context.source.nativeSessionId || typeof payload.cwd !== 'string') {
      throw new AgentMuxError('The saved Codex transcript belongs to another native conversation or directory.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    if (payload.cwd !== context.workspacePath) {
      // Compare the original Host's physical directory identity. Provider and
      // Core may retain different aliases; neither saved path is rewritten.
      let sameDirectory: boolean
      try {
        const [native, original] = await Promise.all([stat(payload.cwd, { bigint: true }), stat(context.workspacePath, { bigint: true })])
        sameDirectory = native.isDirectory() && original.isDirectory() && native.dev === original.dev && native.ino === original.ino
      } catch {
        throw new AgentMuxError('The original execution directory identity is unconfirmed. The saved source and Agent are retained.', 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
      }
      if (!sameDirectory) throw new AgentMuxError('The saved Codex transcript belongs to another native conversation or directory.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
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
    const materialized = await Promise.all(items.reverse().map(value => reader.materializeItem(value)))
    return { source: context.source, items: fitQuestionAnswerProjection(context, materialized, nextCursor),
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
        return fitQuestionAnswerProjection({ ...context, limit: 1 }, [await reader.materializeItem(converted)], null)[0]!
      }
    }
    throw new AgentMuxError('The original saved Codex record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
  } finally { await reader.close() }
}
