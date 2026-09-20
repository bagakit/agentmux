import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type ParsedBlocks = {
  parts: AgentSessionHistoryContentPart[]
  hasSpeech: boolean
}

function parseDocumentBlock(block: Record<string, unknown>): AgentSessionHistoryContentPart[] {
  const src = object(block.source)
  if (!src) return []
  const parts: AgentSessionHistoryContentPart[] = []
  const mediaType =
    typeof src.mediaType === 'string' && src.mediaType
      ? src.mediaType
      : typeof src.media_type === 'string' && src.media_type
        ? src.media_type
        : typeof src.mime === 'string' && src.mime
          ? src.mime
          : src.type === 'base64'
            ? 'application/pdf'
            : 'text/plain'

  if (typeof src.parsed_data === 'string' && src.parsed_data.length > 0) {
    parts.push({ kind: 'text', text: src.parsed_data })
  } else if (typeof src.parsedData === 'string' && src.parsedData.length > 0) {
    parts.push({ kind: 'text', text: src.parsedData })
  } else if (
    src.type === 'text' &&
    typeof src.data === 'string' &&
    src.data.length > 0
  ) {
    parts.push({ kind: 'text', text: src.data })
  }

  const name = typeof src.name === 'string' && src.name ? src.name : undefined
  const path = typeof src.path === 'string' && src.path ? src.path : undefined
  let reference: string | undefined
  if (path) {
    reference = path
  } else if (src.type === 'base64' && typeof src.data === 'string' && src.data.length > 0) {
    reference = `data:${mediaType};base64,${src.data}`
  } else if (src.type === 'text' && typeof src.data === 'string' && src.data.length > 0) {
    reference = `data:${mediaType};base64,${Buffer.from(src.data, 'utf8').toString('base64')}`
  }

  if (reference) {
    parts.push({
      kind: 'resource',
      resourceType: 'file',
      reference,
      ...(name !== undefined ? { label: name } : {})
    })
  }

  return parts
}

function parseContentBlocks(content: unknown): ParsedBlocks {
  if (typeof content === 'string') {
    return {
      parts: [{ kind: 'text', text: content }],
      hasSpeech: content.trim().length > 0
    }
  }

  if (!Array.isArray(content)) {
    return { parts: [], hasSpeech: false }
  }

  const parts: AgentSessionHistoryContentPart[] = []
  let hasSpeech = false

  for (const item of content) {
    if (typeof item === 'string') {
      parts.push({ kind: 'text', text: item })
      if (item.trim().length > 0) hasSpeech = true
      continue
    }

    const block = object(item)
    if (!block) {
      parts.push({ kind: 'text', text: JSON.stringify(item) })
      continue
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ kind: 'text', text: block.text })
      if (block.text.trim().length > 0) hasSpeech = true
      continue
    }

    if (
      (block.type === 'thinking' || block.type === 'redacted_thinking') &&
      typeof (block.thinking ?? block.data) === 'string'
    ) {
      parts.push({
        kind: 'reasoning',
        text: (block.thinking ?? block.data) as string
      })
      const meta: Record<string, unknown> = {}
      if (block.signature !== undefined) meta.signature = block.signature
      if (block.signatureProvider !== undefined) meta.signatureProvider = block.signatureProvider
      if (block.durationMs !== undefined) meta.durationMs = block.durationMs
      if (Object.keys(meta).length > 0) {
        parts.push({ kind: 'text', text: JSON.stringify(meta) })
      }
      continue
    }

    if (block.type === 'tool_use' || block.type === 'tool_call') {
      const rawName = typeof block.name === 'string' ? block.name : 'tool'
      const name = rawName === 'MultiEdit' ? 'Edit' : rawName
      const input =
        typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input ?? block.arguments ?? block.tool_input ?? {})
      const callId = typeof block.id === 'string' && block.id ? block.id : undefined
      parts.push({
        kind: 'tool-call',
        name,
        input,
        ...(callId !== undefined ? { callId } : {})
      })
      const meta: Record<string, unknown> = {}
      if (block.namespace !== undefined) meta.namespace = block.namespace
      if (block.thought_signature !== undefined) meta.thought_signature = block.thought_signature
      if (block.thoughtSignature !== undefined) meta.thoughtSignature = block.thoughtSignature
      if (block.script_execution !== undefined) meta.script_execution = block.script_execution
      if (block.scriptExecution !== undefined) meta.scriptExecution = block.scriptExecution
      if (Object.keys(meta).length > 0) {
        parts.push({ kind: 'text', text: JSON.stringify(meta) })
      }
      continue
    }

    if (block.type === 'tool_result') {
      const callId =
        typeof block.tool_use_id === 'string' && block.tool_use_id
          ? block.tool_use_id
          : typeof block.toolUseId === 'string' && block.toolUseId
            ? block.toolUseId
            : undefined
      const failed =
        typeof block.is_error === 'boolean'
          ? block.is_error
          : typeof block.isError === 'boolean'
            ? block.isError
            : undefined
      const name = typeof block.name === 'string' && block.name ? block.name : undefined

      let emittedToolResult = false

      if (typeof block.content === 'string') {
        parts.push({
          kind: 'tool-result',
          output: block.content,
          ...(callId !== undefined ? { callId } : {}),
          ...(failed !== undefined ? { failed } : {}),
          ...(name !== undefined ? { name } : {})
        })
        emittedToolResult = true
      } else if (Array.isArray(block.content)) {
        for (const sub of block.content) {
          const subObj = object(sub)
          if (typeof sub === 'string') {
            parts.push({
              kind: 'tool-result',
              output: sub,
              ...(callId !== undefined ? { callId } : {}),
              ...(failed !== undefined ? { failed } : {}),
              ...(name !== undefined ? { name } : {})
            })
            emittedToolResult = true
          } else if (subObj?.type === 'text' && typeof subObj.text === 'string') {
            parts.push({
              kind: 'tool-result',
              output: subObj.text,
              ...(callId !== undefined ? { callId } : {}),
              ...(failed !== undefined ? { failed } : {}),
              ...(name !== undefined ? { name } : {})
            })
            emittedToolResult = true
          } else if (subObj?.type === 'image') {
            const src = object(subObj.source)
            if (src?.type === 'base64' && typeof src.data === 'string') {
              const mediaType =
                typeof src.media_type === 'string'
                  ? src.media_type
                  : typeof src.mediaType === 'string'
                    ? src.mediaType
                    : 'image/png'
              parts.push({
                kind: 'resource',
                resourceType: 'image',
                reference: `data:${mediaType};base64,${src.data}`
              })
            }
          } else if (subObj?.type === 'document') {
            const docParts = parseDocumentBlock(subObj)
            for (const docPart of docParts) {
              if (docPart.kind === 'text') {
                parts.push({
                  kind: 'tool-result',
                  output: docPart.text,
                  ...(callId !== undefined ? { callId } : {}),
                  ...(failed !== undefined ? { failed } : {}),
                  ...(name !== undefined ? { name } : {})
                })
                emittedToolResult = true
              } else {
                parts.push(docPart)
              }
            }
          } else if (sub !== undefined) {
            parts.push({ kind: 'text', text: JSON.stringify(sub) })
          }
        }
      } else if (block.content !== undefined) {
        parts.push({
          kind: 'tool-result',
          output: JSON.stringify(block.content),
          ...(callId !== undefined ? { callId } : {}),
          ...(failed !== undefined ? { failed } : {}),
          ...(name !== undefined ? { name } : {})
        })
        emittedToolResult = true
      }

      // Tool failure remains independent of resource-only results
      if (!emittedToolResult) {
        parts.push({
          kind: 'tool-result',
          output: '',
          ...(callId !== undefined ? { callId } : {}),
          ...(failed !== undefined ? { failed } : {}),
          ...(name !== undefined ? { name } : {})
        })
      }
      continue
    }

    if (block.type === 'document') {
      const docParts = parseDocumentBlock(block)
      if (docParts.length > 0) {
        parts.push(...docParts)
        if (docParts.some((p) => p.kind === 'text')) {
          hasSpeech = true
        }
        continue
      }
    }

    if (block.type === 'image') {
      const src = object(block.source)
      if (src?.type === 'base64' && typeof src.data === 'string') {
        const mediaType =
          typeof src.media_type === 'string'
            ? src.media_type
            : typeof src.mediaType === 'string'
              ? src.mediaType
              : 'image/png'
        parts.push({
          kind: 'resource',
          resourceType: 'image',
          reference: `data:${mediaType};base64,${src.data}`
        })
        continue
      }
      if (src?.type === 'url' && typeof src.url === 'string') {
        parts.push({ kind: 'resource', resourceType: 'image', reference: src.url })
        continue
      }
    }

    // Preserved neutral unknown serialized data; per DROID-08 never treated as assistant speech.
    parts.push({ kind: 'text', text: JSON.stringify(block) })
  }

  return { parts, hasSpeech }
}

function convertDroidRecord(
  record: Record<string, unknown>,
  start: number
): AgentSessionHistoryItem {
  const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const startedAt = Number.isSafeInteger(time) && time >= 0 ? time : undefined
  const id =
    (typeof record.id === 'string' && record.id && record.type !== 'session_start' ? record.id : undefined) ??
    (typeof record.uuid === 'string' && record.uuid ? record.uuid : undefined) ??
    (typeof record.messageId === 'string' && record.messageId ? record.messageId : undefined) ??
    (typeof record.type === 'string' && record.type
      ? `droid-${record.type.replace(/_/g, '-')}:${start}`
      : `droid-record:${start}`)

  if (record.type === 'session_start') {
    return {
      id: `droid-session-start:${start}`,
      kind: 'activity',
      title: 'Droid session start',
      contentParts: [
        {
          kind: 'text',
          text:
            typeof record.title === 'string' && record.title
              ? `Session started: ${record.title}`
              : 'Session started'
        }
      ],
      ...(startedAt !== undefined ? { startedAt } : {})
    }
  }

  if (record.type === 'agent_turn_outcome') {
    const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
    const turnId = typeof record.turnId === 'string' && record.turnId ? record.turnId : undefined
    const parts: AgentSessionHistoryContentPart[] = [{ kind: 'text', text: `Outcome: ${reason}` }]

    const meta: Record<string, unknown> = {}
    if (record.resultKind !== undefined) meta.resultKind = record.resultKind
    if (record.result !== undefined) meta.result = record.result
    if (record.schemaFingerprint !== undefined) meta.schemaFingerprint = record.schemaFingerprint

    if (Object.keys(meta).length > 0) {
      parts.push({
        kind: 'text',
        text: JSON.stringify(meta, null, 2)
      })
    }

    return {
      id: `droid-outcome:${start}`,
      kind: 'activity',
      title: 'Droid turn outcome',
      ...(turnId !== undefined ? { turnId } : {}),
      contentParts: parts,
      ...(startedAt !== undefined ? { startedAt } : {})
    }
  }

  if (record.type === 'compaction_state') {
    const summaryText =
      typeof record.summaryText === 'string' && record.summaryText
        ? record.summaryText
        : 'Compaction state'
    return {
      id: typeof record.id === 'string' && record.id ? record.id : `droid-compaction:${start}`,
      kind: 'activity',
      title: 'Droid compaction',
      contentParts: [{ kind: 'text', text: summaryText }],
      ...(startedAt !== undefined ? { startedAt } : {})
    }
  }

  if (record.type === 'message') {
    const messageObj = object(record.message)
    if (!messageObj) {
      return {
        id,
        kind: 'activity',
        title: 'Droid message',
        contentParts: [{ kind: 'text', text: JSON.stringify(record, null, 2) }],
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    const role = typeof messageObj.role === 'string' ? messageObj.role : undefined
    if (role !== 'user' && role !== 'assistant') {
      return {
        id,
        kind: 'activity',
        title: 'Droid message',
        contentParts: [{ kind: 'text', text: JSON.stringify(record, null, 2) }],
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    const rawContent = messageObj.content
    const hasToolResult =
      Array.isArray(rawContent) &&
      rawContent.some((b) => object(b)?.type === 'tool_result')
    const isHook =
      messageObj.visibility === 'user_only' ||
      typeof messageObj.hookEventName === 'string'
    const isLlmOnly = messageObj.visibility === 'llm_only'

    const { parts, hasSpeech } = parseContentBlocks(rawContent)

    // Prepend reasoning metadata if present on native message
    const reasoningText =
      typeof messageObj.chatCompletionReasoningContent === 'string' &&
      messageObj.chatCompletionReasoningContent
        ? messageObj.chatCompletionReasoningContent
        : typeof messageObj.openaiReasoningSummary === 'string' &&
            messageObj.openaiReasoningSummary
          ? messageObj.openaiReasoningSummary
          : undefined
    if (reasoningText) {
      parts.unshift({ kind: 'reasoning', text: reasoningText })
    }

    // Preserve hook execution results if hook content was empty
    if (isHook && parts.length === 0) {
      if (Array.isArray(messageObj.hookResults) && messageObj.hookResults.length > 0) {
        const resultsText = messageObj.hookResults
          .map((r: unknown) => {
            const res = object(r)
            if (!res) return ''
            return (
              (typeof res.stdout === 'string' ? res.stdout : '') ||
              (typeof res.stderr === 'string' ? res.stderr : '') ||
              (typeof res.exitCode === 'number' ? `exit code ${res.exitCode}` : '')
            )
          })
          .filter(Boolean)
          .join('\n')
        parts.push({
          kind: 'text',
          text: resultsText || `Hook ${messageObj.hookEventName ?? 'event'}`
        })
      } else {
        parts.push({
          kind: 'text',
          text: `Hook ${messageObj.hookEventName ?? 'event'}`
        })
      }
    }

    if (role === 'assistant') {
      const kind = hasSpeech ? 'assistant-message' : 'activity'
      return {
        id,
        kind,
        contentParts: parts.length > 0 ? parts : [{ kind: 'text', text: JSON.stringify(record) }],
        ...(kind === 'activity' ? { title: 'Droid tool' } : {}),
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    // role === 'user'
    if (hasToolResult) {
      return {
        id,
        kind: 'activity',
        title: 'Droid tool result',
        contentParts: parts,
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    if (isHook) {
      const eventName =
        typeof messageObj.hookEventName === 'string' ? messageObj.hookEventName : undefined
      return {
        id,
        kind: 'activity',
        title: eventName ? `Droid hook · ${eventName}` : 'Droid hook',
        contentParts: parts,
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    if (isLlmOnly) {
      return {
        id,
        kind: 'activity',
        title: 'Droid injected context',
        contentParts: parts,
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    if (parts.length === 0) {
      return {
        id,
        kind: 'activity',
        title: 'Droid message',
        contentParts: [{ kind: 'text', text: JSON.stringify(record) }],
        ...(startedAt !== undefined ? { startedAt } : {})
      }
    }

    return {
      id,
      kind: 'user-message',
      contentParts: parts,
      ...(startedAt !== undefined ? { startedAt } : {})
    }
  }

  // Fallback for unexpected or flat stream records (preserved as neutral activity without role/completion inference)
  return {
    id,
    kind: 'activity',
    title: typeof record.type === 'string' ? `Droid ${record.type}` : 'Droid activity',
    contentParts: [{ kind: 'text', text: JSON.stringify(record, null, 2) }],
    ...(startedAt !== undefined ? { startedAt } : {})
  }
}

export async function readDroidSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    const header = await reader.readFirst()
    if (
      !header ||
      header.type !== 'session_start' ||
      typeof header.id !== 'string' ||
      header.id !== context.source.nativeSessionId
    ) {
      throw new AgentMuxError(
        'Droid transcript missing or invalid native session_start header.',
        'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      )
    }

    const items: AgentSessionHistoryItem[] = []
    while (items.length < context.limit) {
      const record = await reader.readPrevious()
      if (!record) break
      const val = record.value

      const streamSessionId =
        typeof val.session_id === 'string'
          ? val.session_id
          : typeof val.sessionId === 'string'
            ? val.sessionId
            : undefined
      if (streamSessionId && streamSessionId !== context.source.nativeSessionId) {
        throw new AgentMuxError(
          'Droid transcript belongs to another native Session.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }
      if (
        val.type === 'session_start' &&
        typeof val.id === 'string' &&
        val.id !== context.source.nativeSessionId
      ) {
        throw new AgentMuxError(
          'Droid transcript belongs to another native Session.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      items.push(convertDroidRecord(val, record.start))
    }

    const nextCursor = await reader.nextCursor()
    return {
      source: context.source,
      items: items.reverse(),
      nextCursor
    }
  } finally {
    await reader.close()
  }
}
