import { dirname, join } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader, type NativeHistoryReadBudget } from '../native-jsonl-history-reader.js'
import {
  isNativeText,
  nativeJsonStringify,
  nativeTextConcat,
  nativeTextHasSpeech,
  nativeTextTrim,
  type NativeTextValue,
  type NativeHistoryContentPart as AgentSessionHistoryContentPart,
  type NativeHistoryItem as AgentSessionHistoryItem
} from '../native-history-value.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
} from '../types.js'

import { nativeTextBetween } from '../native-history-source.js'

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

export function assertAntigravityHistorySource(context: Pick<AgentProviderSessionHistoryContext, 'transcriptPath' | 'source'>): void {
  if (context.transcriptPath && antigravityConversationIdFromTranscriptPath(context.transcriptPath) !== context.source.nativeSessionId) {
    throw new AgentMuxError('Antigravity transcript does not establish this exact native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
}

async function extractAntigravityUserRequest(content: NativeTextValue, signal: AbortSignal): Promise<NativeTextValue> {
  return nativeTextTrim(await nativeTextBetween(content, '<USER_REQUEST>', '</USER_REQUEST>', signal))
}

async function parseRecordParts(
  record: Record<string, unknown>,
  fullRecord: Record<string, unknown> | undefined,
  fullState: { unavailable?: boolean; budgetExceeded?: boolean },
  signal: AbortSignal
): Promise<{
  kind: AgentSessionHistoryItem['kind']
  title?: string
  contentParts: AgentSessionHistoryContentPart[]
}> {
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
    const text = isNativeText(content)
      ? await extractAntigravityUserRequest(content, signal)
      : nativeJsonStringify(content ?? '')
    if (text.length) {
      parts.push({ kind: 'text', text })
    }

    if (Array.isArray(media)) {
      for (const item of media) {
        if (item && typeof item === 'object' && isNativeText((item as { uri?: unknown }).uri)) {
          const uri = (item as { uri: NativeTextValue }).uri
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
    const hasAssistantText = isNativeText(content) && nativeTextHasSpeech(content)

    // Source order per embedded specification: thinking -> content -> tool_calls -> media
    if (isNativeText(thinking) && nativeTextHasSpeech(thinking)) {
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
              ? (isNativeText(callObj.args) ? callObj.args : nativeJsonStringify(callObj.args))
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
        if (item && typeof item === 'object' && isNativeText((item as { uri?: unknown }).uri)) {
          const uri = (item as { uri: NativeTextValue }).uri
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
      const errorMsg = isNativeText(effectiveRecord.error) && nativeTextHasSpeech(effectiveRecord.error)
        ? nativeTextConcat('[Antigravity error: ', nativeTextTrim(effectiveRecord.error), ']')
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

  const text = isNativeText(content) ? content : nativeJsonStringify(effectiveRecord, null, 2)
  parts.push({ kind: 'text', text })

  if (effectiveRecord.status === 'ERROR') {
    const errorMsg = isNativeText(effectiveRecord.error) && nativeTextHasSpeech(effectiveRecord.error)
      ? nativeTextConcat('[Antigravity error: ', nativeTextTrim(effectiveRecord.error), ']')
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

async function convert(
  record: Record<string, unknown>,
  start: number,
  nativeSessionId: string,
  fullRecord: Record<string, unknown> | undefined,
  fullState: { unavailable?: boolean; budgetExceeded?: boolean },
  signal: AbortSignal
): Promise<AgentSessionHistoryItem> {
  const { kind, title, contentParts } = await parseRecordParts(record, fullRecord, fullState, signal)
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
  assertAntigravityHistorySource(context)

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
      items.push(await convert(record, start, context.source.nativeSessionId, fullRecord, fullState, context.signal))
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
      items: await Promise.all(items.reverse().map(item => compactReader.materializeItem(item))),
      nextCursor
    }
  } finally {
    await compactReader.close()
  }
}
