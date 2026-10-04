import { dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader, type NativeHistoryReadBudget } from '../native-jsonl-history-reader.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

const ANTIGRAVITY_TRANSCRIPT_FILE = 'transcript.jsonl'
const ANTIGRAVITY_SYSTEM_DIR = '.system_generated'
const ANTIGRAVITY_LOGS_DIR = 'logs'

export function antigravityConversationIdFromTranscriptPath(filePath: string): string | null {
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  const transcriptIndex = segments.length - 1
  if (
    segments[transcriptIndex] !== ANTIGRAVITY_TRANSCRIPT_FILE ||
    segments[transcriptIndex - 1] !== ANTIGRAVITY_LOGS_DIR ||
    segments[transcriptIndex - 2] !== ANTIGRAVITY_SYSTEM_DIR
  ) {
    return null
  }
  return segments[transcriptIndex - 3] ?? null
}

function extractAntigravityUserRequest(content: string): string {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  if (startIndex === -1) {
    return content.trim()
  }
  const bodyStart = startIndex + opener.length
  const endIndex = content.indexOf('</USER_REQUEST>', bodyStart)
  const body = endIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, endIndex)
  return body.trim()
}

function parseRecordParts(
  record: Record<string, unknown>,
  fullRecord: Record<string, unknown> | undefined,
  fullState: { unavailable?: boolean; budgetExceeded?: boolean }
): {
  kind: AgentSessionHistoryItem['kind']
  title?: string
  contentParts: AgentSessionHistoryContentPart[]
} {
  const source = typeof record.source === 'string' ? record.source : ''
  const type = typeof record.type === 'string' ? record.type : ''

  const truncatedFields = Array.isArray(record.truncated_fields)
    ? (record.truncated_fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : []

  const unrecoveredFields: string[] = []
  const effectiveRecord: Record<string, unknown> = { ...record }

  for (const field of truncatedFields) {
    if (fullRecord && fullRecord[field] !== undefined) {
      effectiveRecord[field] = fullRecord[field]
    } else {
      unrecoveredFields.push(field)
    }
  }

  const content = effectiveRecord.content
  const thinking = effectiveRecord.thinking
  const toolCalls = effectiveRecord.tool_calls
  const media = effectiveRecord.media

  const omissionNotice = (): AgentSessionHistoryContentPart | null => {
    if (unrecoveredFields.length === 0) return null
    const reason = fullState.budgetExceeded
      ? 'full transcript budget exceeded'
      : fullState.unavailable
        ? 'full transcript unavailable'
        : 'truncated fields'
    return {
      kind: 'text',
      text: `[Antigravity ${reason}: omitted fields ${unrecoveredFields.join(', ')}]`
    }
  }

  // 1. User message (source USER_EXPLICIT and type USER_INPUT per agy specification)
  if (source === 'USER_EXPLICIT' && type === 'USER_INPUT') {
    const parts: AgentSessionHistoryContentPart[] = []
    const text = typeof content === 'string'
      ? extractAntigravityUserRequest(content)
      : JSON.stringify(content ?? '')
    if (text) {
      parts.push({ kind: 'text', text })
    }

    if (Array.isArray(media)) {
      for (const item of media) {
        if (item && typeof item === 'object' && typeof (item as { uri?: unknown }).uri === 'string') {
          const uri = (item as { uri: string }).uri
          const mimeType = typeof (item as { mime_type?: unknown }).mime_type === 'string'
            ? (item as { mime_type: string }).mime_type
            : ''
          const resourceType = mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('audio/')
              ? 'audio'
              : 'file'
          parts.push({ kind: 'resource', resourceType, reference: uri })
        }
      }
    }

    const notice = omissionNotice()
    if (notice) {
      parts.push(notice)
    }

    return {
      kind: 'user-message',
      contentParts: parts.length > 0 ? parts : [{ kind: 'text', text: '' }]
    }
  }

  // 2. MODEL / PLANNER_RESPONSE
  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const parts: AgentSessionHistoryContentPart[] = []
    const hasAssistantText = typeof content === 'string' && content.trim().length > 0

    // Source order per embedded specification: thinking -> content -> tool_calls -> media
    if (typeof thinking === 'string' && thinking.trim().length > 0) {
      parts.push({ kind: 'reasoning', text: thinking })
    }

    if (hasAssistantText) {
      parts.push({ kind: 'text', text: content })
    }

    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (call && typeof call === 'object') {
          const callObj = call as Record<string, unknown>
          if (typeof callObj.name === 'string' && callObj.name.length > 0) {
            const name = callObj.name
            const args = callObj.args !== undefined
              ? (typeof callObj.args === 'string' ? callObj.args : JSON.stringify(callObj.args))
              : ''
            const callId = typeof callObj.id === 'string' && callObj.id.length > 0
              ? callObj.id
              : undefined

            parts.push({
              kind: 'tool-call',
              name,
              input: args,
              ...(callId !== undefined ? { callId } : {})
            })
          }
        }
      }
    }

    if (Array.isArray(media)) {
      for (const item of media) {
        if (item && typeof item === 'object' && typeof (item as { uri?: unknown }).uri === 'string') {
          const uri = (item as { uri: string }).uri
          const mimeType = typeof (item as { mime_type?: unknown }).mime_type === 'string'
            ? (item as { mime_type: string }).mime_type
            : ''
          const resourceType = mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('audio/')
              ? 'audio'
              : 'file'
          parts.push({ kind: 'resource', resourceType, reference: uri })
        }
      }
    }

    // A1: status === 'ERROR' preservation
    if (effectiveRecord.status === 'ERROR') {
      const errorMsg = typeof effectiveRecord.error === 'string' && effectiveRecord.error.trim().length > 0
        ? `[Antigravity error: ${effectiveRecord.error.trim()}]`
        : '[Antigravity status: ERROR]'
      parts.push({ kind: 'text', text: errorMsg })
    }

    const notice = omissionNotice()
    if (notice) {
      parts.push(notice)
    }

    // Genuine assistant text keeps speaker ('assistant-message'); pure thinking/tools remain 'activity'
    const kind = hasAssistantText ? 'assistant-message' : 'activity'
    return {
      kind,
      ...(kind === 'activity' ? { title: 'Antigravity PLANNER_RESPONSE' } : {}),
      contentParts: parts.length > 0 ? parts : [{ kind: 'text', text: '' }]
    }
  }

  // 3. Other steps remain activity preserving raw content
  const title = type ? `Antigravity ${type}` : source ? `Antigravity ${source}` : 'Antigravity activity'
  const parts: AgentSessionHistoryContentPart[] = []

  const text = typeof content === 'string' ? content : JSON.stringify(effectiveRecord, null, 2)
  parts.push({ kind: 'text', text })

  if (effectiveRecord.status === 'ERROR') {
    const errorMsg = typeof effectiveRecord.error === 'string' && effectiveRecord.error.trim().length > 0
      ? `[Antigravity error: ${effectiveRecord.error.trim()}]`
      : '[Antigravity status: ERROR]'
    parts.push({ kind: 'text', text: errorMsg })
  }

  const notice = omissionNotice()
  if (notice) {
    parts.push(notice)
  }

  return {
    kind: 'activity',
    title,
    contentParts: parts
  }
}

function convert(
  record: Record<string, unknown>,
  start: number,
  nativeSessionId: string,
  fullRecord: Record<string, unknown> | undefined,
  fullState: { unavailable?: boolean; budgetExceeded?: boolean }
): AgentSessionHistoryItem {
  const { kind, title, contentParts } = parseRecordParts(record, fullRecord, fullState)
  const id = typeof record.id === 'string' && record.id
    ? record.id
    : record.step_index !== undefined
      ? `${nativeSessionId}:${record.step_index}`
      : `antigravity-record:${start}`

  const time = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN
  const startedAt = Number.isSafeInteger(time) && time >= 0 ? time : undefined

  return {
    id,
    kind,
    contentParts,
    ...(title ? { title } : {}),
    ...(startedAt !== undefined ? { startedAt } : {})
  }
}

export async function readAntigravitySessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  if (context.transcriptPath) {
    const pathConversationId = antigravityConversationIdFromTranscriptPath(context.transcriptPath)
    if (pathConversationId !== null && pathConversationId !== context.source.nativeSessionId) {
      throw new AgentMuxError(
        'Antigravity transcript belongs to another native Session.',
        'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      )
    }
  }

  const compactReader = await NativeJsonlHistoryReader.open(context, budget)
  try {
    const rawEntries: Array<{ record: Record<string, unknown>; start: number }> = []
    const neededFullSteps = new Map<number, Record<string, unknown>>()

    while (rawEntries.length < context.limit) {
      const entry = await compactReader.readPrevious()
      if (!entry) break
      if (!entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue
      const record = entry.value as Record<string, unknown>
      rawEntries.push({ record, start: entry.start })

      const truncated = Array.isArray(record.truncated_fields) && record.truncated_fields.length > 0
      const stepIndex = typeof record.step_index === 'number' ? record.step_index : undefined
      if (truncated && stepIndex !== undefined) {
        neededFullSteps.set(stepIndex, record)
      }
    }

    const resolvedFull = new Map<number, Record<string, unknown>>()
    let fullUnavailable = false
    let fullBudgetExceeded = false
    let nextFullCursor: string | null | undefined

    if (context.transcriptPath && neededFullSteps.size > 0) {
      const fullPath = join(dirname(context.transcriptPath), 'transcript_full.jsonl')
      const fullCursor = compactReader.continuation

      // Explicitly strip outer cursor so compact cursor is never passed to fullReader
      const { cursor: _outerCursor, ...baseContext } = context
      const fullContext: AgentProviderSessionHistoryContext = {
        ...baseContext,
        transcriptPath: fullPath,
        ...(fullCursor ? { cursor: fullCursor } : {})
      }

      let fullReader: NativeJsonlHistoryReader | undefined
      try {
        fullReader = await NativeJsonlHistoryReader.open(fullContext, budget)
      } catch (error) {
        context.signal.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          fullUnavailable = true
        } else if (error instanceof AgentMuxError && error.code === 'AGENT_SESSION_HISTORY_TOO_LARGE') {
          fullBudgetExceeded = true
        } else {
          throw error
        }
      }

      if (fullReader) {
        try {
          const minNeededStep = Math.min(...neededFullSteps.keys())

          while (resolvedFull.size < neededFullSteps.size) {
            context.signal.throwIfAborted()
            let fullEntry: { value: Record<string, unknown>; start: number } | null
            try {
              fullEntry = await fullReader.readPrevious()
            } catch (readError) {
              context.signal.throwIfAborted()
              if (readError instanceof AgentMuxError && readError.code === 'AGENT_SESSION_HISTORY_TOO_LARGE') {
                fullBudgetExceeded = true
                break
              }
              throw readError
            }
            if (!fullEntry) break

            const stepIndex = typeof fullEntry.value.step_index === 'number' ? fullEntry.value.step_index : undefined
            if (stepIndex !== undefined && neededFullSteps.has(stepIndex)) {
              const compact = neededFullSteps.get(stepIndex)!
              if (fullEntry.value.source === compact.source && fullEntry.value.type === compact.type) {
                resolvedFull.set(stepIndex, fullEntry.value)
              } else {
                throw new AgentMuxError(
                  'Antigravity full transcript step does not match compact transcript identity.',
                  'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
                )
              }
            }

            if (stepIndex !== undefined && stepIndex < minNeededStep && resolvedFull.size === neededFullSteps.size) {
              break
            }
          }

          if (!fullBudgetExceeded) {
            try {
              nextFullCursor = await fullReader.nextCursor()
            } catch (cursorError) {
              context.signal.throwIfAborted()
              if (cursorError instanceof AgentMuxError && cursorError.code === 'AGENT_SESSION_HISTORY_TOO_LARGE') {
                fullBudgetExceeded = true
              } else {
                throw cursorError
              }
            }
          }
        } finally {
          await fullReader.close()
        }
      }
    }

    const fullState = {
      unavailable: fullUnavailable,
      budgetExceeded: fullBudgetExceeded
    }

    const items: AgentSessionHistoryItem[] = []
    for (const { record, start } of rawEntries) {
      const stepIndex = typeof record.step_index === 'number' ? record.step_index : undefined
      const fullRecord = stepIndex !== undefined ? resolvedFull.get(stepIndex) : undefined
      items.push(convert(record, start, context.source.nativeSessionId, fullRecord, fullState))
    }

    let continuationToSave = compactReader.continuation
    if (neededFullSteps.size > 0) {
      if (fullBudgetExceeded) {
        continuationToSave = undefined
      } else if (nextFullCursor !== undefined) {
        continuationToSave = nextFullCursor ?? undefined
      }
    }

    const nextCursor = await compactReader.nextCursor(continuationToSave)

    return {
      source: context.source,
      items: items.reverse(),
      nextCursor
    }
  } finally {
    await compactReader.close()
  }
}
