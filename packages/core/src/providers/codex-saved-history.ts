import { nativeConversationProvenance } from '../conversation-provenance.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../session-history-changes.js'
import { stat } from 'node:fs/promises'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader, readNativeConversationChanges, NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES } from '../native-jsonl-history-reader.js'
import { normalizeSessionHistoryMetrics, SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextStartsWith, type NativeHistoryContentPart, type NativeHistoryItem } from '../native-history-value.js'
import { codexTurnOutcome, codexTurnRecordId } from './codex-turn-outcome.js'
import { codexQuestionAnswers, codexQuestionRequest } from './codex-question.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage,
  AgentProviderSessionHistoryRecordContext, AgentSessionHistoryItem } from '../types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const text = (value: unknown) => isNativeText(value) ? value : value === undefined ? '' : nativeJsonStringify(value)

function metrics(record: Record<string, unknown>, payload: Record<string, unknown>, nativeSessionId: string): Pick<NativeHistoryItem, 'metrics' | 'metricsDiagnostic'> {
  if (record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) return payload.duration_ms === undefined ? {} : normalizeSessionHistoryMetrics({
    turnId: payload.turn_id,
    metrics: { scope: 'turn',
      ...(payload.duration_ms === undefined ? {} : { durationMs: payload.duration_ms }) }
  })
  if (record.type !== 'token_usage_record') return {}
  const sameSource = (payload.thread_id === undefined || payload.thread_id === nativeSessionId) &&
    (payload.session_id === undefined || payload.session_id === nativeSessionId)
  if (!sameSource) return { metricsDiagnostic: { code: 'NATIVE_HISTORY_METRICS_SOURCE_UNCONFIRMED',
    message: 'Native usage identifies another source. Its original record remains readable; usage is unknown for this conversation.' } }
  // This record reports a cumulative whole-turn snapshot. Keep each native snapshot,
  // never sum them or replace them with token_count.info.last_token_usage (one response).
  const usage = object(payload.turn_token_usage)
  return normalizeSessionHistoryMetrics({ turnId: payload.turn_id, metrics: { scope: 'turn', usage: {
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    cachedInputTokens: usage.cached_input_tokens, reasoningOutputTokens: usage.reasoning_output_tokens
  } } })
}

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

function contentParts(content: unknown, userInput = false): NativeHistoryContentPart[] {
  if (isNativeText(content)) return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: nativeJsonStringify(content), contentEligibility: 'unconfirmed' }]
  return content.map(value => {
    const part = object(value)
    if (['input_text', 'output_text', 'text', 'summary_text'].includes(String(part.type)) && isNativeText(part.text)) {
      return { kind: 'text', text: part.text }
    }
    if (part.type === 'input_image' && isNativeText(part.image_url)) return { kind: 'resource', resourceType: 'image', reference: part.image_url }
    if (userInput) {
      const reference = part.type === 'image' ? part.image_url : part.type === 'audio' ? part.audio_url : part.path
      const resourceType = part.type === 'image' || part.type === 'local_image' ? 'image'
        : part.type === 'audio' || part.type === 'local_audio' ? 'audio'
        : part.type === 'skill' || part.type === 'mention' ? 'file' : undefined
      if (resourceType && isNativeText(reference)) return { kind: 'resource', resourceType, reference,
        ...(typeof part.name === 'string' ? { label: part.name } : {}) }
    }
    return { kind: 'text', text: nativeJsonStringify(value), contentEligibility: 'unconfirmed' }
  })
}

/** Reading presentation only: original text and native actor facts remain independent. */
function collaborationContentParts(content: unknown, sender?: string, recipient?: string): NativeHistoryContentPart[] {
  return contentParts(content).map((part, index) => {
    if (part.kind !== 'text') return part
    const original = Array.isArray(content) ? object(content[index]) : {}
    if (original.type === 'encrypted_content' && isNativeText(original.encrypted_content) &&
      Object.keys(original).every(key => key === 'type' || key === 'encrypted_content')) {
      return { ...part, readingRange: { start: 0, end: 0 } }
    }
    // Only the leading native envelope with both exact native participants is
    // redundant for reading. Unknown wrappers and later body text stay intact.
    if (index === 0 && sender !== undefined && recipient !== undefined) {
      for (const type of ['MESSAGE', 'NEW_TASK', 'FINAL_ANSWER']) {
        const prefix = `Message Type: ${type}\nTask name: ${recipient}\nSender: ${sender}\nPayload:\n`
        if (nativeTextStartsWith(part.text, prefix)) return { ...part, readingRange: { start: prefix.length, end: part.text.length } }
      }
    }
    return part
  })
}

function mcpFileParts(payload: Record<string, unknown>, nativeItem: Record<string, unknown>): NativeHistoryContentPart[] | undefined {
  const result = object(nativeItem.result)
  if (!Array.isArray(result.content)) return undefined
  const parts: NativeHistoryContentPart[] = []
  const content = result.content.map(value => {
    const block = object(value), resource = object(block.resource), mime = resource.mimeType
    if (block.type !== 'resource' || typeof resource.uri !== 'string' || !resource.uri ||
      !isNativeText(resource.blob) || !resource.blob.length || typeof mime !== 'string' || !mime ||
      mime.toLowerCase().startsWith('image/') || mime.toLowerCase().startsWith('audio/')) return value
    parts.push({ kind: 'resource', resourceType: 'file', contentEligibility: 'public', reference: nativeTextConcat(`data:${mime};base64,`, resource.blob),
      ...(typeof resource.name === 'string' ? { label: resource.name } : {}) })
    // Preserve the original metadata without serializing the same payload twice.
    const { blob: _blob, ...metadata } = resource
    return { ...block, resource: metadata }
  })
  if (!parts.length) return undefined
  parts.push({ kind: 'tool-result', contentEligibility: 'unconfirmed', callId: nativeItem.id as string,
    output: nativeJsonStringify({ ...payload, item: { ...nativeItem, result: { ...result, content } } }),
    ...(nativeItem.status === 'failed' || result.isError === true ? { failed: true } : {}) })
  return parts
}

function item(record: Record<string, unknown>, start: number, nativeSessionId: string, paginated: boolean, projectQuestion = true): NativeHistoryItem | null {
  const payload = object(record.payload), type = payload.type
  if (record.type === 'session_meta' || record.type === 'turn_context') return null
  const nativeItem = object(payload.item)
  // The declared paginated format records user speech as a completed TurnItem;
  // ResponseItems retain model context. Legacy sources keep their own contract.
  const canonicalUser = paginated && record.type === 'event_msg' && type === 'item_completed' &&
    payload.thread_id === nativeSessionId && typeof payload.turn_id === 'string' && payload.turn_id.length > 0 &&
    nativeItem.type === 'UserMessage' && typeof nativeItem.id === 'string' && nativeItem.id.length > 0 && Array.isArray(nativeItem.content)
  const mcpParts = paginated && record.type === 'event_msg' && type === 'item_completed' &&
    payload.thread_id === nativeSessionId && typeof payload.turn_id === 'string' && payload.turn_id.length > 0 &&
    nativeItem.type === 'McpToolCall' && typeof nativeItem.id === 'string' && nativeItem.id.length > 0 &&
    (nativeItem.status === 'completed' || nativeItem.status === 'failed') ? mcpFileParts(payload, nativeItem) : undefined
  const asyncQuestion = record.type === 'event_msg' && type === 'item_completed' &&
    payload.thread_id === nativeSessionId && typeof payload.turn_id === 'string' && payload.turn_id.length > 0 &&
    nativeItem.type === 'AgentMessage' && nativeItem.delivery === 'async'
  let questionRequest: AgentSessionHistoryItem['questionRequest']
  let questionDiagnostic: AgentSessionHistoryItem['questionDiagnostic']
  if (asyncQuestion && projectQuestion) {
    try { questionRequest = codexQuestionRequest(nativeItem) } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'INVALID_AGENT_SESSION_HISTORY_PAGE') throw error
      questionDiagnostic = { code: error.code, message: error.message }
    }
  }
  let kind: NativeHistoryItem['kind'] = 'activity', parts: NativeHistoryContentPart[], title: string | undefined
  let collaboration: NativeHistoryItem['collaboration'], conversationDiagnostic: NativeHistoryItem['conversationDiagnostic']
  let contentEligibility: AgentSessionHistoryItem['contentParts'][number]['contentEligibility'] = 'unconfirmed'
  if (asyncQuestion) {
    contentEligibility = 'public'
    kind = 'assistant-message'
    parts = questionRequest === undefined ? [{ kind: 'text', text: nativeJsonStringify(payload), contentEligibility: 'unconfirmed' }]
      : contentParts(Array.isArray(nativeItem.content) ? nativeItem.content.map(value => {
      const part = object(value)
      return part.type === 'Text' ? { ...part, type: 'text' } : value
    }) : nativeItem.content)
  } else if (canonicalUser) {
    kind = 'user-message'
    parts = contentParts(nativeItem.content, true)
  } else if (mcpParts) {
    // Only the typed tool result's file purpose is known; metadata stays unconfirmed.
    parts = mcpParts
  } else if (record.type === 'response_item' && type === 'agent_message') {
    // The native actor paths belong to this source, not to AgentMux's Session registry.
    contentEligibility = 'public'
    const validActor = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
      value.length <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(value)
    collaboration = { kind: 'message', source: { providerId: 'codex', nativeSessionId },
      ...(validActor(payload.author) ? { sender: payload.author } : {}),
      ...(validActor(payload.recipient) ? { recipient: payload.recipient } : {}) }
    parts = collaborationContentParts(payload.content, collaboration.sender, collaboration.recipient)
    if (payload.author !== undefined && !validActor(payload.author) || payload.recipient !== undefined && !validActor(payload.recipient)) {
      conversationDiagnostic = { code: 'NATIVE_COLLABORATION_ATTRIBUTION_UNCONFIRMED',
        message: 'Optional native collaboration attribution is unknown. The original message and reported attribution remain readable.' }
      // Native values may be lazy source text. Preserve them through the existing
      // bounded content/resource materializer rather than serializing metadata eagerly.
      parts.push({ kind: 'text', text: nativeJsonStringify({ author: payload.author, recipient: payload.recipient }), contentEligibility: 'unconfirmed' })
    }
  } else if (record.type === 'response_item' && type === 'message') {
    const system = systemMessage(payload)
    contentEligibility = system || payload.role === 'user' && paginated ? 'private'
      : payload.role === 'assistant' ? 'public' : 'unconfirmed'
    title = system?.title
    kind = system?.kind ?? (payload.role === 'user' ? (paginated ? 'activity' : 'user-message') : payload.role === 'assistant' ? 'assistant-message' : 'activity')
    if (!system && paginated && payload.role === 'user') title = 'Model context'
    parts = contentParts(payload.content)
  } else if (record.type === 'response_item' && type === 'reasoning') {
    contentEligibility = 'public'
    parts = contentParts(payload.summary).map(part => part.kind === 'text' ? { ...part, kind: 'reasoning' } : part)
  } else if (record.type === 'response_item' && (type === 'function_call' || type === 'custom_tool_call')) {
    contentEligibility = 'public'
    parts = [{ kind: 'tool-call', name: typeof payload.name === 'string' ? payload.name : 'tool',
      input: text(type === 'function_call' ? payload.arguments : payload.input),
      ...(typeof payload.call_id === 'string' ? { callId: payload.call_id } : {}) }]
  } else if (record.type === 'response_item' && (type === 'function_call_output' || type === 'custom_tool_call_output')) {
    contentEligibility = 'public'
    parts = [{ kind: 'tool-result', output: text(payload.output), ...(typeof payload.call_id === 'string' ? { callId: payload.call_id } : {}) }]
  } else if (record.type === 'event_msg' && (type === 'user_message' || type === 'agent_message')) {
    contentEligibility = type === 'user_message' ? 'unconfirmed' : 'public'
    // Native event copies are activity, so the corresponding original response_item is not duplicated as speech.
    parts = [{ kind: 'text', text: text(payload.message) }]
  } else if (record.type === 'event_msg' && type === 'token_count') return null
  else if (record.type === 'compacted' && isNativeText(payload.message)) { parts = [{ kind: 'text', text: payload.message }]; contentEligibility = 'private' }
  else parts = [{ kind: 'text', text: nativeJsonStringify(payload) }]
  // The saved rollout spells the native text part input_text. Reuse the same
  // complete-reply protocol as indexed history without changing original parts.
  const userContent = canonicalUser ? nativeItem.content : payload.content
  const questionAnswers = kind === 'user-message' ? codexQuestionAnswers(Array.isArray(userContent)
    ? userContent.map(part => object(part).type === 'input_text' ? { ...object(part), type: 'text' } : part)
    : userContent) : undefined
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const id = codexTurnRecordId(record, start)
  const turnOutcome = codexTurnOutcome(record, nativeSessionId)
  const directTurnId = typeof payload.turn_id === 'string' && payload.turn_id.length > 0 ? payload.turn_id : undefined
  const metadata = record.type === 'response_item' && (type === 'message' || type === 'agent_message') ? object(payload.internal_chat_message_metadata_passthrough) : {}
  const messageTurnId = typeof metadata.turn_id === 'string' && metadata.turn_id.length > 0 ? metadata.turn_id : undefined
  // Conflicting native facts cannot assign this original record to either turn.
  const turnId = directTurnId && messageTurnId && directTurnId !== messageTurnId ? undefined : directTurnId ?? messageTurnId
  const input = canonicalUser && typeof nativeItem.client_id === 'string' && nativeItem.client_id.length > 0
    ? { source: { providerId: 'codex', nativeSessionId }, semanticItemId: nativeItem.id as string, turnId: payload.turn_id as string, clientCorrelation: nativeItem.client_id } : undefined
  const invocation = nativeConversationProvenance(parts, { providerId: 'codex', nativeSessionId })
  const conversation = input ? { ...invocation, nativeInput: input } : invocation
  return { id, kind, contentParts: parts.map(part => ({ ...part, contentEligibility: mcpParts ? part.contentEligibility ?? 'unconfirmed'
      : contentEligibility === 'public' ? part.contentEligibility ?? 'public' : contentEligibility })),
    ...(conversation ? { conversation } : {}),
    ...(collaboration === undefined ? {} : { collaboration }),
    ...(conversationDiagnostic === undefined ? {} : { conversationDiagnostic }),
    ...metrics(record, payload, nativeSessionId),
    ...(turnOutcome ? { turnOutcome } : {}),
    ...(kind === 'assistant-message' && (asyncQuestion ? nativeItem.phase : payload.phase) === 'final_answer' ? { messagePhase: 'final' as const }
      : kind === 'assistant-message' && (asyncQuestion ? nativeItem.phase : payload.phase) === 'commentary' ? { messagePhase: 'progress' as const } : {}),
    ...(questionRequest === undefined ? {} : { questionRequest }),
    ...(questionDiagnostic === undefined ? {} : { questionDiagnostic }),
    ...(questionAnswers === undefined ? {} : { questionAnswers }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(Number.isSafeInteger(timestamp) && timestamp >= 0 ? { startedAt: timestamp } : {}),
    ...(title ? { title } : kind === 'activity' ? { title: String(type ?? record.type) } : {}) }
}

const requestBudgetDiagnostic = { code: 'CODEX_QUESTION_REQUEST_DETAILS_UNAVAILABLE',
  message: 'Structured question details did not fit this page. The original body is kept; read a smaller history page or the original record for complete question details.' }

/** Optional question/answer details cannot make original content exceed its existing read budget. */
function fitQuestionAnswerProjection(context: AgentProviderSessionHistoryContext, items: AgentSessionHistoryItem[], nextCursor: string | null, changesCursor?: string, replayCursor?: string): AgentSessionHistoryItem[] {
  if (!items.some(item => item.questionAnswers !== undefined || item.questionRequest !== undefined)) return items
  const projected = [...items]
  // Match the Provider page envelope checked by normalizeSessionHistoryPage.
  let pageBytes = Buffer.byteLength(JSON.stringify({ source: context.source, items, nextCursor, changesCursor, replayCursor }))
  if (pageBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) return items
  const diagnostic = { code: 'CODEX_QUESTION_ANSWER_DETAILS_UNAVAILABLE',
    message: 'Answer details did not fit this history page’s existing byte budget. The original reply remains complete and readable/copyable.' }
  const candidates = items.flatMap((item, index) => {
    if (item.questionAnswers === undefined && item.questionRequest === undefined) return []
    const { questionAnswers: _answers, questionRequest: _request, ...original } = item
    const originalBytes = Buffer.byteLength(JSON.stringify(original))
    return [{ index, original, originalBytes, diagnostic: item.questionRequest ? requestBudgetDiagnostic : diagnostic,
      savedBytes: Buffer.byteLength(JSON.stringify(item)) - originalBytes }]
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
    const value = { ...candidate.original, questionDiagnostic: candidate.diagnostic }
    const addedBytes = Buffer.byteLength(JSON.stringify(value)) - candidate.originalBytes
    if (pageBytes + addedBytes <= SESSION_HISTORY_MAX_PAGE_BYTES) {
      projected[candidate.index] = value
      pageBytes += addedBytes
    } else unreported.push(candidate.original.id)
  }
  if (unreported.length) console.warn('Codex history question/answer details and their diagnostic did not fit the existing page budget. Original content is preserved.',
    { source: context.source, recordIds: unreported })
  return projected
}

/** One stable per-record decision keeps page, exact resource and changes parts identical. */
async function materializeSavedItem(reader: NativeJsonlHistoryReader, context: AgentProviderSessionHistoryContext,
  record: Record<string, unknown>, start: number, converted: NativeHistoryItem, paginated: boolean): Promise<AgentSessionHistoryItem> {
  const value = await reader.materializeItem(converted)
  if (!value.questionRequest) return value
  // Reuse the original changes envelope reserve; optional details must also fit
  // when this exact record is consumed through durable catch-up.
  const maximum = SESSION_HISTORY_MAX_PAGE_BYTES - NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES
  const bytes = (item: AgentSessionHistoryItem) => Buffer.byteLength(JSON.stringify({ source: context.source, items: [item], nextCursor: null }))
  if (bytes(value) <= maximum) return value
  const original = await reader.materializeItem(item(record, start, context.source.nativeSessionId, paginated, false)!)
  const diagnosed = { ...original, questionDiagnostic: { code: requestBudgetDiagnostic.code,
    message: 'Structured question details exceed this record’s reading budget. The complete original native record remains readable and copyable.' } }
  return bytes(diagnosed) <= maximum ? diagnosed : original
}

async function open(context: AgentProviderSessionHistoryContext): Promise<{ reader: NativeJsonlHistoryReader; paginated: boolean }> {
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
    // The first metadata is canonical, including forks with copied later metadata.
    // Reuse the identity read; tail pages need no additional scan or format cache.
    const paginated = payload.history_mode === 'paginated'
    return { reader, paginated }
  } catch (error) { await reader.close(); throw error }
}

/** Exact saved rollout is a native source, independent of the availability of an indexed CLI read helper. */
export async function readCodexSavedSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const { reader, paginated } = await open(context)
  try {
    const items: Array<{ record: Record<string, unknown>; start: number; converted: NativeHistoryItem }> = []
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      const converted = item(entry.value, entry.start, context.source.nativeSessionId, paginated)
      if (converted) items.push({ record: entry.value, start: entry.start, converted })
    }
    const nextCursor = await reader.nextCursor()
    const materialized = await Promise.all(items.reverse().map(value => materializeSavedItem(reader, context, value.record, value.start, value.converted, paginated)))
    const changesCursor = await reader.historyChangesCursor(), replayCursor = await reader.historyReplayCursor()
    return { source: context.source, items: fitQuestionAnswerProjection(context, materialized, nextCursor, changesCursor, replayCursor),
      nextCursor, changesCursor, replayCursor, sourceSizeBytes: reader.sourceSizeBytes }
  } finally { await reader.close() }
}

export async function readCodexSavedSessionHistoryRecord(context: AgentProviderSessionHistoryRecordContext): Promise<AgentSessionHistoryItem> {
  const { reader, paginated } = await open({ ...context, limit: 1 })
  try {
    const byteIdentity = /^codex-record:(0|[1-9]\d*)$/u.exec(context.recordId)
    if (byteIdentity) {
      const entry = await reader.readAt(Number(byteIdentity[1]))
      const converted = entry && item(entry.value, entry.start, context.source.nativeSessionId, paginated)
      if (!entry || !converted || converted.id !== context.recordId || context.turnId !== undefined && converted.turnId !== context.turnId) throw new AgentMuxError(
        'The original saved Codex record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
      await reader.verifyUnchanged()
      return fitQuestionAnswerProjection({ ...context, limit: 1 }, [await materializeSavedItem(reader, { ...context, limit: 1 }, entry.value, entry.start, converted, paginated)], null)[0]!
    }
    for (let entry = await reader.readPrevious(); entry; entry = await reader.readPrevious()) {
      const converted = item(entry.value, entry.start, context.source.nativeSessionId, paginated)
      if (converted?.id === context.recordId && (context.turnId === undefined || converted.turnId === context.turnId)) {
        await reader.verifyUnchanged()
        return fitQuestionAnswerProjection({ ...context, limit: 1 }, [await materializeSavedItem(reader, { ...context, limit: 1 }, entry.value, entry.start, converted, paginated)], null)[0]!
      }
    }
    throw new AgentMuxError('The original saved Codex record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
  } finally { await reader.close() }
}

/** Resume the same saved rollout and original record converter after a durable cut. */
export async function readCodexSavedConversationChanges(context: ProviderConversationChangesContext): Promise<ProviderConversationChangesPage> {
  const { reader, paginated } = await open(context)
  try { return await readNativeConversationChanges(reader, context, async (record, start) => {
    const converted = item(record, start, context.source.nativeSessionId, paginated)
    return converted ? await materializeSavedItem(reader, context, record, start, converted, paginated) : null
  }) }
  finally { await reader.close() }
}
