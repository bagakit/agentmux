import { constants, existsSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import {
  NativeJsonlHistoryReader,
  readNativeHistoryBytes,
  type NativeHistoryReadBudget
} from '../native-jsonl-history-reader.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

function failure(code: string, message: string): never {
  throw new AgentMuxError(message, `AGENT_SESSION_HISTORY_${code}`)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function resolveKimiHome(env?: Readonly<Record<string, string | undefined>>): string {
  const override = env?.KIMI_CODE_HOME?.trim() || process.env.KIMI_CODE_HOME?.trim()
  if (override) return resolve(override)
  return join(homedir(), '.kimi-code')
}

const MAX_INDEX_SCAN_BYTES = 4 * 1024 * 1024

/**
 * Authoritative index lookup: find the exact requested session in append-only session_index.jsonl
 * with bounded, byte-aware cancellable reverse reading, checking workspace and latest deletion tombstone.
 * Scans raw Buffer chunks and cuts only on newline bytes (10) to prevent multibyte UTF-8 corruption.
 * Checks the authentic first-party key `sessionId` (MoonshotAI/kimi-code sessionLifecycleService.ts).
 */
export async function findLatestSessionIndexEntry(
  indexPath: string,
  targetSessionId: string,
  signal: AbortSignal,
  workspacePath?: string,
  budget?: NativeHistoryReadBudget
): Promise<{ sessionDir: string; workDir?: string | undefined; deleted?: boolean | undefined } | null> {
  signal.throwIfAborted()
  const activeBudget = budget ?? { bytesRead: 0, startedAt: Date.now() }
  let file: FileHandle
  try {
    file = await open(indexPath, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return null
  }

  try {
    const fileStat = await file.stat()
    if (!fileStat.isFile()) return null

    let position = fileStat.size
    let chunks: Buffer[] = []
    let cacheStart = 0
    let cache: Buffer = Buffer.alloc(0)

    const readBlockEndingAt = async (end: number): Promise<Buffer> => {
      signal.throwIfAborted()
      if (end > cacheStart && end <= cacheStart + cache.length) {
        return cache.subarray(0, end - cacheStart)
      }
      cacheStart = Math.max(0, end - 64 * 1024)
      const len = end - cacheStart
      cache = await readNativeHistoryBytes(file, cacheStart, len, signal, activeBudget)
      return cache
    }

    const decoder = new TextDecoder('utf-8', { fatal: true })
    let isFirstEofLine = true

    while (position > 0) {
      signal.throwIfAborted()
      let at = position
      let block = await readBlockEndingAt(at)
      const terminated = block[block.length - 1] === 10
      const isPhysicalEofWithoutLf = isFirstEofLine && !terminated
      isFirstEofLine = false
      if (terminated) {
        at--
        block = block.subarray(0, -1)
      }
      chunks = []
      while (true) {
        const newline = block.lastIndexOf(10)
        if (newline >= 0) {
          position = cacheStart + newline + 1
          chunks.unshift(block.subarray(newline + 1))
          break
        }
        chunks.unshift(block)
        at = cacheStart
        if (at === 0) {
          position = 0
          break
        }
        block = await readBlockEndingAt(at)
      }
      const lineData = Buffer.concat(chunks)
      if (lineData.length === 0) continue

      let lineText: string
      try {
        lineText = decoder.decode(lineData)
      } catch {
        if (isPhysicalEofWithoutLf) continue
        failure('INVALID_TRANSCRIPT', 'Kimi session index contains malformed UTF-8.')
      }

      const trimmed = lineText.trim()
      if (!trimmed) continue

      let record: unknown
      try {
        record = JSON.parse(trimmed)
      } catch {
        if (isPhysicalEofWithoutLf) continue
        failure('INVALID_TRANSCRIPT', 'Kimi session index contains an invalid complete JSON record.')
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        if (isPhysicalEofWithoutLf) continue
        failure('INVALID_TRANSCRIPT', 'Kimi session index contains a non-object record.')
      }

      const rec = record as Record<string, unknown>
      // Authentic first-party disk key is strictly `sessionId` (MoonshotAI/kimi-code sessionLifecycleService.ts)
      const sessionId = extractString(rec.sessionId)
      if (sessionId === targetSessionId) {
        if (rec.deleted === true) {
          return { sessionDir: '', deleted: true }
        }
        const sessionDir = extractString(rec.sessionDir)
        if (!sessionDir) {
          failure('LOCATOR_UNAVAILABLE', `Kimi session ${targetSessionId} entry is missing sessionDir.`)
        }
        const workDir = extractString(rec.workDir)
        if (workDir && workspacePath && resolve(workDir) !== resolve(workspacePath)) {
          failure('SOURCE_CHANGED', `Kimi session ${targetSessionId} belongs to another workspace.`)
        }
        return { sessionDir, workDir, deleted: false }
      }
    }
  } finally {
    await file.close()
  }

  return null
}

/**
 * Locate the primary agent's `wire.jsonl` transcript for a given Kimi native session.
 * Main agent is fixed to `main` (agentLifecycle.ts:13).
 */
export async function resolveKimiWirePath(
  context: AgentProviderSessionHistoryContext,
  budget: NativeHistoryReadBudget
): Promise<string> {
  const kimiHome = resolveKimiHome(context.env)
  const sessionId = context.source.nativeSessionId
  const indexPath = join(kimiHome, 'session_index.jsonl')

  if (!existsSync(indexPath)) {
    return failure('LOCATOR_UNAVAILABLE', `Kimi session index missing at ${indexPath}.`)
  }

  const entry = await findLatestSessionIndexEntry(indexPath, sessionId, context.signal, context.workspacePath, budget)
  if (!entry) {
    return failure('LOCATOR_UNAVAILABLE', `Could not locate Kimi session transcript for ${sessionId}.`)
  }
  if (entry.deleted) {
    return failure('LOCATOR_UNAVAILABLE', `Kimi session ${sessionId} has been deleted.`)
  }

  const provenWirePath = join(entry.sessionDir, 'agents', 'main', 'wire.jsonl')

  const directPath = context.transcriptPath
  if (directPath) {
    if (!isAbsolute(directPath)) {
      return failure('LOCATOR_UNAVAILABLE', 'Native transcript path must be an absolute path.')
    }
    if (resolve(directPath) !== resolve(provenWirePath)) {
      return failure('INVALID_TRANSCRIPT', 'Kimi explicit transcript path must match the authoritative primary wire path.')
    }
    return directPath
  }

  return provenWirePath
}

export function parseContentBlocks(content: unknown): AgentSessionHistoryContentPart[] {
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content }]
  }
  if (!Array.isArray(content)) {
    return []
  }
  const parts: AgentSessionHistoryContentPart[] = []
  for (const block of content) {
    const obj = object(block)
    if (!obj) continue
    if (obj.type === 'text' && typeof obj.text === 'string') {
      parts.push({ kind: 'text', text: obj.text })
      continue
    }
    if (obj.type === 'think' && typeof obj.think === 'string') {
      parts.push({ kind: 'reasoning', text: obj.think })
      continue
    }
    if (obj.type === 'image_url') {
      const url = extractString(object(obj.imageUrl)?.url)
      if (url) {
        parts.push({ kind: 'resource', resourceType: 'image', reference: url })
        continue
      }
    }
    // Resource fallback for media with url; unknown non-text is not converted to fake assistant speech
    const url = extractString(obj.url) ?? extractString(obj.reference)
    if (url) {
      parts.push({ kind: 'resource', resourceType: 'other', reference: url })
    }
  }
  return parts
}

type AssistantStepAccumulator = {
  uuid: string | undefined
  startedAt: number | undefined
  completedAt: number | undefined
  finishReason: string | undefined
  startOffset: number
  parts: AgentSessionHistoryContentPart[]
}

/**
 * Bounded group-aware reverse paging for native Kimi `wire.jsonl` transcript.
 * Employs NativeJsonlHistoryReader to read only the requested slice of bytes from EOF backwards,
 * ensuring no unbounded work or full-file memory buffering.
 */
export async function readKimiSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  context.signal.throwIfAborted()

  if (context.source.providerId !== 'kimi') {
    return failure('SOURCE_CHANGED', 'Native history source must be Kimi.')
  }

  const wirePath = await resolveKimiWirePath(context, budget)
  context.signal.throwIfAborted()

  const readerContext: AgentProviderSessionHistoryContext = {
    ...context,
    transcriptPath: wirePath
  }

  const reader = await NativeJsonlHistoryReader.open(readerContext, budget)
  try {
    const items: AgentSessionHistoryItem[] = []
    let currentStep: AssistantStepAccumulator | null = null

    const flushStep = () => {
      if (!currentStep) return
      if (currentStep.parts.length > 0) {
        const hasText = currentStep.parts.some((p) => p.kind === 'text')
        // Pure reasoning or tool steps are activity, genuine assistant text is assistant-message
        const kind = hasText ? 'assistant-message' : 'activity'
        const id = currentStep.uuid || `kimi-record:${currentStep.startOffset}`
        items.push({
          id,
          kind,
          contentParts: currentStep.parts,
          ...(currentStep.startedAt !== undefined ? { startedAt: currentStep.startedAt } : {}),
          ...(currentStep.completedAt !== undefined ? { completedAt: currentStep.completedAt } : {})
        })
      }
      currentStep = null
    }

    while (items.length < context.limit) {
      context.signal.throwIfAborted()
      const recordEntry = await reader.readPrevious()
      if (!recordEntry) break

      const record = recordEntry.value
      const start = recordEntry.start

      const type = record.type

      if (type === 'context.append_loop_event') {
        const event = object(record.event)
        if (!event) continue
        const eventType = event.type
        const time = typeof record.time === 'number' && Number.isSafeInteger(record.time) ? record.time : undefined

        if (eventType === 'step.end') {
          flushStep()
          if (items.length >= context.limit) {
            reader.repeatPrevious()
            break
          }
          const finishReason = extractString(event.finishReason)
          const isSuccess = finishReason === 'end_turn' || finishReason === 'stop'
          currentStep = {
            uuid: extractString(event.uuid),
            finishReason,
            completedAt: isSuccess && time !== undefined ? time : undefined,
            startedAt: undefined,
            startOffset: start,
            parts: []
          }
          continue
        }

        if (eventType === 'tool.result') {
          if (!currentStep) {
            currentStep = {
              uuid: undefined,
              finishReason: undefined,
              completedAt: undefined,
              startedAt: undefined,
              startOffset: start,
              parts: []
            }
          } else {
            currentStep.startOffset = start
          }
          const res = object(event.result)
          const output = typeof res?.output === 'string' ? res.output : JSON.stringify(res?.output ?? '')
          const callId = extractString(event.toolCallId)
          const failed = res?.isError === true ? true : undefined
          currentStep.parts.unshift({
            kind: 'tool-result',
            output,
            ...(callId ? { callId } : {}),
            ...(failed ? { failed: true } : {})
          })
          continue
        }

        if (eventType === 'tool.call') {
          if (!currentStep) {
            currentStep = {
              uuid: undefined,
              finishReason: undefined,
              completedAt: undefined,
              startedAt: undefined,
              startOffset: start,
              parts: []
            }
          } else {
            currentStep.startOffset = start
          }
          const name = extractString(event.name) || 'tool'
          const input = typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {})
          const callId = extractString(event.toolCallId)
          currentStep.parts.unshift({
            kind: 'tool-call',
            name,
            input,
            ...(callId ? { callId } : {})
          })
          continue
        }

        if (eventType === 'content.part') {
          if (!currentStep) {
            currentStep = {
              uuid: undefined,
              finishReason: undefined,
              completedAt: undefined,
              startedAt: undefined,
              startOffset: start,
              parts: []
            }
          } else {
            currentStep.startOffset = start
          }
          const part = object(event.part)
          if (part?.type === 'think' && typeof part.think === 'string') {
            if (currentStep.parts.length > 0 && currentStep.parts[0]!.kind === 'reasoning') {
              currentStep.parts[0]!.text = part.think + currentStep.parts[0]!.text
            } else {
              currentStep.parts.unshift({ kind: 'reasoning', text: part.think })
            }
          } else if (part?.type === 'text' && typeof part.text === 'string') {
            if (currentStep.parts.length > 0 && currentStep.parts[0]!.kind === 'text') {
              currentStep.parts[0]!.text = part.text + currentStep.parts[0]!.text
            } else {
              currentStep.parts.unshift({ kind: 'text', text: part.text })
            }
          } else if (part?.type === 'image_url') {
            const url = extractString(object(part.imageUrl)?.url)
            if (url) {
              currentStep.parts.unshift({ kind: 'resource', resourceType: 'image', reference: url })
            }
          }
          continue
        }

        if (eventType === 'step.begin') {
          if (currentStep) {
            if (time !== undefined) currentStep.startedAt = time
            if (event.uuid && !currentStep.uuid) {
              currentStep.uuid = extractString(event.uuid)
            }
            currentStep.startOffset = start
            flushStep()
            if (items.length >= context.limit) break
          }
          continue
        }
      }

      if (type === 'context.append_message') {
        flushStep()
        if (items.length >= context.limit) {
          reader.repeatPrevious()
          break
        }
        const message = object(record.message)
        if (!message) continue
        const role = message.role
        const origin = object(message.origin)
        const time = typeof record.time === 'number' && Number.isSafeInteger(record.time) ? record.time : undefined
        const id = extractString(record.uuid) || extractString(message.id) || `kimi-record:${start}`

        if (role === 'user') {
          if (origin?.kind === 'user') {
            // Proven human message
            const contentParts = parseContentBlocks(message.content)
            items.push({
              id,
              kind: 'user-message',
              contentParts,
              ...(time !== undefined ? { startedAt: time } : {})
            })
          } else if (origin?.kind === 'system_trigger') {
            // Stop-hook continuation or internal system trigger — neutral activity
            const name = extractString(origin.name)
            const contentParts = parseContentBlocks(message.content)
            items.push({
              id,
              kind: 'activity',
              title: name ? `System trigger (${name})` : 'System trigger',
              contentParts,
              ...(time !== undefined ? { startedAt: time } : {})
            })
          } else if (origin?.kind === 'injection') {
            // Synthetic system injection
            const variant = extractString(origin.variant)
            const contentParts = parseContentBlocks(message.content)
            items.push({
              id,
              kind: 'activity',
              title: variant ? `System reminder (${variant})` : 'System reminder',
              contentParts,
              ...(time !== undefined ? { startedAt: time } : {})
            })
          } else {
            // Unproven origin
            const contentParts = parseContentBlocks(message.content)
            items.push({
              id,
              kind: 'activity',
              title: 'User activity',
              contentParts,
              ...(time !== undefined ? { startedAt: time } : {})
            })
          }
          if (items.length >= context.limit) break
        } else if (role === 'assistant') {
          const contentParts = parseContentBlocks(message.content)
          items.push({
            id,
            kind: 'assistant-message',
            contentParts,
            ...(time !== undefined ? { startedAt: time } : {})
          })
          if (items.length >= context.limit) break
        }
      }
    }

    // Flush any remaining active step
    flushStep()

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
