// Native record and role interpretation preserves the upstream conversion and block normalization.
// Source: Paseo 3c6e4e39 (Apache-2.0, Copyright (c) 2025-present Mohamed Boudra). Modified for bounded, read-only pages,
// exact ordered content/resources, neutral unknown activities and native UUID identity.
import type { NativeHistoryItem, NativeHistoryPart, NativeHistoryReaderContext, NativeHistoryTarget,
  NativeHistoryText, NativeJsonlHistoryReader, NativeJsonlHistoryServices } from '../jsonl-history-services.js'

type HistoryContext = NativeHistoryTarget & { limit: number }
type ClaudeHistoryReader<Text, Item> = NativeJsonlHistoryReader<Text, Item> & {
  sourceSizeBytes: number
  historyChangesCursor(): Promise<string>
  historyReplayCursor(): Promise<string>
}

export function createClaudeNativeHistory<Text extends { length: number }, Context extends HistoryContext, Item,
  Changes extends Context, ChangesPage, Reader extends ClaudeHistoryReader<Text, Item>>(
  services: Omit<NativeJsonlHistoryServices<Text, Context, Item>, 'NativeJsonlHistoryReader'> & {
    NativeJsonlHistoryReader: { open(context: NativeHistoryReaderContext<Context>): Promise<Reader> }
    nativeTextJoin(values: readonly NativeHistoryText<Text>[], separator?: string): NativeHistoryText<Text>
    nativeInputCorrelationKey(value: string): object | null
    nativeConversationProvenance(parts: readonly NativeHistoryPart<Text>[], source: NativeHistoryTarget['source']): object | undefined
    normalizeSessionHistoryMetrics(value: { metrics: unknown }): object
    readNativeConversationChanges(reader: Reader, context: Changes,
      convert: (record: Record<string, unknown>, start: number) => NativeHistoryItem<Text> | null,
      identify: (record: Record<string, unknown>, start: number) => string | null,
      stable: (record: Record<string, unknown>) => boolean): Promise<ChangesPage>
  }
) {
  const { AgentMuxError, NativeJsonlHistoryReader, isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextJoin,
    nativeConversationProvenance, nativeInputCorrelationKey, normalizeSessionHistoryMetrics, readNativeConversationChanges } = services

  type RecordContext = Omit<Context, 'cursor' | 'limit' | 'transcriptPath'> & { transcriptPath?: string; recordId: string; turnId?: string }

  function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  }

  function queuedCommand(record: Record<string, unknown>): Record<string, unknown> | undefined {
    const attachment = record.type === 'attachment' ? object(record.attachment) : undefined
    return attachment?.type === 'queued_command' && attachment.commandMode === 'prompt' && isNativeText(attachment.prompt)
      ? attachment : undefined
  }

  function queuedCorrelation(record: Record<string, unknown>): string | undefined {
    const attachment = queuedCommand(record), correlation = attachment?.source_uuid
    return record.isSynthetic !== true && record.isCompactSummary !== true && record.isApiErrorMessage !== true &&
      typeof correlation === 'string' && nativeInputCorrelationKey(correlation) ? correlation : undefined
  }

  function formatToolResultOutput(content: unknown): NativeHistoryText<Text> {
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

  function parts(content: unknown): NativeHistoryPart<Text>[] {
    if (isNativeText(content)) return [{ kind: 'text', text: content }]
    if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: nativeJsonStringify(content), contentEligibility: 'unconfirmed' }]
    return content.flatMap((value): NativeHistoryPart<Text>[] => {
      const block = object(value)
      if (!block) return [{ kind: 'text', text: nativeJsonStringify(value), contentEligibility: 'unconfirmed' }]
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
        return [{ kind: 'tool-result', contentEligibility: 'public', output: formatToolResultOutput(block.content), ...(callId ? { callId } : {}), ...(failed ? { failed } : {}) }]
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
      return [{ kind: 'text', text: nativeJsonStringify(block), contentEligibility: 'unconfirmed' }]
    })
  }

  function convert(record: Record<string, unknown>, start: number): NativeHistoryItem<Text> {
    const message = object(record.message)
    const attachment = queuedCommand(record)
    // Claude accepts mid-turn prompts as attachments, not additional user turns.
    // Queue logs and the rendered system wrapper do not establish accepted speech.
    const queuedInput = attachment !== undefined
    const correlatedQueue = queuedCorrelation(record) !== undefined
    const content = queuedInput ? attachment.prompt : message?.content
    const blocks = Array.isArray(content) ? content : []
    const messageParts = message ? parts(content) : undefined

    // Generated records remain neutral even when they carry a prompt-shaped attachment.
    const isGenerated = record.isCompactSummary === true || record.isSynthetic === true || record.isMeta === true || record.isApiErrorMessage === true
    const isNeutralActivity = (!message && !queuedInput) || content === undefined ||
      isGenerated ||
      (!queuedInput && record.type !== 'user' && record.type !== 'assistant')

    const isToolResultTurn = Boolean(record.toolUseResult) || (
      blocks.length > 0 && blocks.every((b) => object(b)?.type === 'tool_result')
    )
    // Claude records the producer of a user-role turn. A background task notification is
    // written by Claude itself (origin task-notification, promptSource system), not typed
    // by a person, so it is a system record of the conversation, not the user's speech.
    const originKind = object(record.origin)?.kind
    const queuedOrigin = object(attachment?.origin)?.kind
    const queuedPeer = queuedInput && (attachment.isMeta === true || attachment.humanTurn === false ||
      typeof queuedOrigin === 'string' && queuedOrigin !== 'human')
    const systemOriginInput = record.type === 'user' && !queuedInput && !isToolResultTurn && !isGenerated &&
      (record.promptSource === 'system' || typeof originKind === 'string' && originKind !== 'human')
    let kind: NativeHistoryItem<Text>['kind']
    if ((record.type === 'system' || systemOriginInput) && message && content !== undefined && !isGenerated) {
      kind = 'system-message'
    } else if (isNeutralActivity || queuedPeer || correlatedQueue) {
      kind = 'activity'
    } else if (record.type === 'user' || queuedInput) {
      // Tool result turns in Claude are sent under role 'user', often with tool_use_result on the record
      // or containing only tool_result blocks. These are activities, never human user speech.
      kind = isToolResultTurn ? 'activity' : 'user-message'
    } else {
      // record.type === 'assistant'
      // A native image is conversation content even without a text caption.
      // Pure tool/reasoning records retain their activity purpose.
      const hasAssistantContent = messageParts?.some(part => part.contentEligibility !== 'unconfirmed' &&
        (part.kind === 'text' && part.text.length > 0 || part.kind === 'resource' && part.resourceType === 'image'))
      kind = hasAssistantContent ? 'assistant-message' : 'activity'
    }

    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    const turnId = typeof record.user_message_uuid === 'string' && record.user_message_uuid.length > 0
      ? record.user_message_uuid
      : undefined
    const contentEligibility = record.isCompactSummary === true || record.type === 'system' ? 'private'
      : isGenerated ? 'unconfirmed'
      : record.type === 'assistant' && message && content !== undefined ? 'public' : 'unconfirmed'
    // Claude stamps the response's stop reason onto its original content-block records.
    // A missing reason (including an interrupted stream) cannot establish a phase.
    const messagePhase = kind === 'assistant-message' && record.isAbortedMidStream !== true
      ? message?.stop_reason === 'tool_use' ? 'progress' as const
        : message?.stop_reason === 'end_turn' ? 'final' as const : undefined
      : undefined

    return {
      id: typeof record.uuid === 'string' && record.uuid ? record.uuid : `claude-record:${start}`,
      kind,
      ...(messagePhase === undefined ? {} : { messagePhase }),
      contentParts: (messageParts ?? (queuedInput && (kind === 'user-message' || correlatedQueue) ? parts(content) : [{ kind: 'text' as const, text: nativeJsonStringify(record) }]))
        .map(part => ({ ...part, contentEligibility: contentEligibility === 'private' || isGenerated ? contentEligibility : part.contentEligibility ?? contentEligibility })),
      // Native message.usage covers this response, even when several responses share a turn.
      // Claude does not report one total_tokens value here; preserve that absence.
      ...(record.type === 'assistant' && message?.usage !== undefined ? normalizeSessionHistoryMetrics({
        metrics: { scope: 'response', usage: {
          inputTokens: object(message.usage)?.input_tokens,
          outputTokens: object(message.usage)?.output_tokens,
          totalTokens: object(message.usage)?.total_tokens,
          cachedInputTokens: object(message.usage)?.cache_read_input_tokens
        } }
      }) : {}),
      ...(kind === 'system-message' ? { title: systemOriginInput ? originKind === 'task-notification' ? 'Task notification' : 'Claude system input' : 'System instructions' }
        : queuedInput && kind === 'user-message' ? { title: '运行中追加' } :
        kind === 'activity' ? { title: typeof record.type === 'string' ? `Claude ${record.type}` : 'Claude activity' } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(Number.isSafeInteger(time) && time >= 0 ? { startedAt: time } : {})
    }
  }

  function mainRecord(record: Record<string, unknown>, start: number, nativeSessionId: string): NativeHistoryItem<Text> | null {
    if (record.isSidechain === true) return null
    if (record.sessionId !== nativeSessionId) {
      // Claude bookkeeping can lack a Session ID. Such records have no main-conversation identity.
      if (record.sessionId === undefined && record.type !== 'user' && record.type !== 'assistant') return null
      throw new AgentMuxError('Claude transcript belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    const item = convert(record, start)
    const source = { providerId: 'claude', nativeSessionId }
    const correlation = item.turnId === undefined && typeof record.uuid === 'string' && record.uuid ? queuedCorrelation(record) : undefined
    const invocation = nativeConversationProvenance(item.contentParts, source)
    const conversation = correlation ? { ...invocation, nativeInput: { source, semanticItemId: record.uuid as string,
      queuedSubmissionId: correlation, clientCorrelation: correlation } } : invocation
    return { ...item, ...(conversation ? { conversation } : {}) }
  }

  async function readClaudeSessionHistoryPage(context: Context) {
    const reader = await NativeJsonlHistoryReader.open(context)
    try {
      const items: NativeHistoryItem<Text>[] = []
      while (items.length < context.limit) {
        const entry = await reader.readPrevious()
        if (!entry) break
        const item = mainRecord(entry.value, entry.start, context.source.nativeSessionId)
        if (item) items.push(item)
      }
      const nextCursor = await reader.nextCursor()
      return { source: context.source, items: await Promise.all(items.reverse().map(item => reader.materializeItem(item))), nextCursor,
        changesCursor: await reader.historyChangesCursor(), replayCursor: await reader.historyReplayCursor(), sourceSizeBytes: reader.sourceSizeBytes }
    } finally { await reader.close() }
  }

  /** Locate the original resource-bearing record using the same source rules as page reading. */
  async function readClaudeSessionHistoryRecord(context: RecordContext): Promise<Item> {
    const reader = await NativeJsonlHistoryReader.open({ ...context, limit: 1 })
    try {
      for (let entry = await reader.readPrevious(); entry; entry = await reader.readPrevious()) {
        const item = mainRecord(entry.value, entry.start, context.source.nativeSessionId)
        if (item?.id === context.recordId && (context.turnId === undefined || item.turnId === context.turnId)) {
          await reader.verifyUnchanged()
          return await reader.materializeItem(item)
        }
      }
      throw new AgentMuxError('The original Claude record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
    } finally { await reader.close() }
  }

  /** Append paging uses the same Provider converter and physical JSONL owner as history reading. */
  async function readClaudeConversationChanges(context: Changes): Promise<ChangesPage> {
    const reader = await NativeJsonlHistoryReader.open(context)
    try {
      return await readNativeConversationChanges(reader, context, (row, start) => mainRecord(row, start, context.source.nativeSessionId),
        (row, start) => { try { return mainRecord(row, start, context.source.nativeSessionId)?.id ?? null } catch { return null } }, row => (row.type === 'assistant' || row.type === 'user') && typeof row.uuid === 'string' && !!row.uuid)
    } finally { await reader.close() }
  }

  return { readClaudeSessionHistoryPage, readClaudeSessionHistoryRecord, readClaudeConversationChanges }
}
