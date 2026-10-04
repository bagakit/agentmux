import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { blake3 } from '@noble/hashes/blake3.js'
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

const GROK_CHAT_HISTORY_FILE = 'chat_history.jsonl'
const GROK_UPDATES_FILE = 'updates.jsonl'
const GROK_SUMMARY_FILE = 'summary.json'
const GROK_SESSION_ID_MAX_LENGTH = 128
const MAX_DIRNAME_BYTES = 255
const MAX_SUMMARY_BYTES = 1024 * 1024 // 1 MB upper bound for summary metadata

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isSafeGrokSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= GROK_SESSION_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(sessionId)
  )
}

/**
 * Strict RFC 3986 percent-encoding matching Rust `urlencoding::encode`.
 * Only ASCII alphanumeric [0-9a-zA-Z] and `- . _ ~` remain unescaped.
 * All other bytes (including `! ' ( ) *`) are encoded as `%XX` with uppercase hex.
 */
export function urlencodeRfc3986(str: string): string {
  const bytes = Buffer.from(str, 'utf8')
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2d || // -
      b === 0x2e || // .
      b === 0x5f || // _
      b === 0x7e    // ~
    ) {
      result += String.fromCharCode(b)
    } else {
      result += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return result
}

/**
 * Slugify matching xai-grok-config/src/paths.rs `slugify(input, max_len)`.
 */
export function slugify(input: string, maxLen: number): string {
  let result = ''
  let prevDash = false
  for (const char of input.toLowerCase()) {
    const code = char.charCodeAt(0)
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x61 && code <= 0x7a)    // a-z
    ) {
      result += char
      prevDash = false
    } else if (!prevDash) {
      result += '-'
      prevDash = true
    }
  }
  let start = 0
  let end = result.length
  while (start < end && result[start] === '-') start++
  while (end > start && result[end - 1] === '-') end--
  const trimmed = result.slice(start, end)
  return Array.from(trimmed).slice(0, maxLen).join('')
}

/**
 * Encode original UTF-8 cwd into native session directory component.
 * Matches xai_grok_config::paths::encode_cwd_dirname:
 * - If url_encoded.len() <= 255: exact RFC3986 encoding.
 * - If url_encoded.len() > 255: leaf slug (max 40) + '-' + first 16 hex chars of BLAKE3(cwd).
 *
 * Uses Node `basename(cwd)` on Darwin/Unix to match Rust's `Path::new(cwd).file_name()`.
 */
export function encodeCwdDirname(cwd: string): string {
  const urlEncoded = urlencodeRfc3986(cwd)
  if (Buffer.byteLength(urlEncoded, 'ascii') <= MAX_DIRNAME_BYTES) {
    return urlEncoded
  }
  const hashBytes = blake3(Buffer.from(cwd, 'utf8'))
  const hex = Buffer.from(hashBytes).toString('hex').toLowerCase()
  const hash16 = hex.slice(0, 16)

  const leaf = basename(cwd) || 'workspace'
  let slug = slugify(leaf, 40)
  if (!slug) {
    slug = 'workspace'
  }
  return `${slug}-${hash16}`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

export async function resolveGrokChatHistoryPath(
  context: AgentProviderSessionHistoryContext
): Promise<string> {
  const givenPath = context.transcriptPath
  if (givenPath) {
    if (!isAbsolute(givenPath)) {
      throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
    }
    const fileBase = basename(givenPath)
    if (fileBase === GROK_CHAT_HISTORY_FILE) {
      return givenPath
    }
    if (fileBase === GROK_UPDATES_FILE) {
      return join(dirname(givenPath), GROK_CHAT_HISTORY_FILE)
    }
    // Arbitrary paths or prefixed paths like prefix-chat_history.jsonl are rejected
    throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  }

  const sessionId = context.source.nativeSessionId
  if (!isSafeGrokSessionId(sessionId)) {
    throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  }

  const workspacePath = context.workspacePath
  const encodedGroup = encodeCwdDirname(workspacePath)

  const grokHome = context.env.GROK_HOME ? resolve(context.env.GROK_HOME) : join(homedir(), '.grok')
  const candidate = join(grokHome, 'sessions', encodedGroup, sessionId, GROK_CHAT_HISTORY_FILE)

  try {
    const s = await stat(candidate)
    if (!s.isFile()) {
      throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
    }
  } catch (err: unknown) {
    if (err instanceof AgentMuxError) throw err
    throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  }

  return candidate
}

async function verifySummaryIdentity(
  sessionDir: string,
  context: AgentProviderSessionHistoryContext,
  budget: NativeHistoryReadBudget
): Promise<void> {
  context.signal.throwIfAborted()
  const summaryPath = join(sessionDir, GROK_SUMMARY_FILE)

  let file
  try {
    file = await open(summaryPath, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Summary absence is ONLY valid when sessionDir is the exact native directory:
      // <grokHome>/sessions/<encoded_cwd>/<nativeSessionId>
      const grokHome = context.env.GROK_HOME ? resolve(context.env.GROK_HOME) : join(homedir(), '.grok')
      const encodedGroup = encodeCwdDirname(context.workspacePath)
      const expectedNativeDir = resolve(join(grokHome, 'sessions', encodedGroup, context.source.nativeSessionId))
      if (resolve(sessionDir) !== expectedNativeDir) {
        throw new AgentMuxError('Grok session directory does not match expected native identity.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
      }
      return
    }
    throw new AgentMuxError('Grok summary metadata is inaccessible.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }

  try {
    context.signal.throwIfAborted()
    const st = await file.stat()
    context.signal.throwIfAborted()
    if (!st.isFile()) {
      throw new AgentMuxError('Grok summary is not a regular file.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    }
    if (st.size > MAX_SUMMARY_BYTES) {
      throw new AgentMuxError('Grok summary exceeds maximum allowed size.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    }

    const buf = await readNativeHistoryBytes(file, 0, st.size, context.signal, budget)

    let parsed: unknown
    try {
      parsed = JSON.parse(buf.toString('utf8'))
    } catch {
      throw new AgentMuxError('Grok summary contains invalid JSON metadata.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    }

    if (!isRecord(parsed)) {
      throw new AgentMuxError('Grok summary contains non-object metadata.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    }

    const info = isRecord(parsed.info) ? parsed.info : undefined
    if (!info) {
      throw new AgentMuxError('Grok summary does not contain required info object.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
    }

    const id = extractString(info.id)
    if (!id || id !== context.source.nativeSessionId) {
      throw new AgentMuxError('Grok transcript belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }

    const cwd = extractString(info.cwd)
    if (!cwd || cwd !== context.workspacePath) {
      throw new AgentMuxError('Grok transcript belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
  } finally {
    await file.close()
  }
}

function parseContentParts(content: unknown): AgentSessionHistoryContentPart[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : []
  }
  if (Array.isArray(content)) {
    const parts: AgentSessionHistoryContentPart[] = []
    for (const item of content) {
      if (typeof item === 'string') {
        if (item.length > 0) parts.push({ kind: 'text', text: item })
      } else if (isRecord(item)) {
        const itemType = extractString(item.type)
        if (itemType === 'text') {
          const text = extractString(item.text)
          if (text) parts.push({ kind: 'text', text })
        } else if (itemType === 'image') {
          const url = extractString(item.url)
          if (url) parts.push({ kind: 'resource', resourceType: 'image', reference: url })
        }
      }
    }
    return parts
  }
  return []
}

function convertGrokRecord(
  record: Record<string, unknown>,
  start: number
): AgentSessionHistoryItem | null {
  const type = extractString(record.type)
  if (!type) return null

  // Byte offset id is honest for native Grok records
  const id = `grok-record:${start}`

  if (type === 'user') {
    const syntheticReason = extractString(record.synthetic_reason)
    const isHuman = !syntheticReason || syntheticReason === 'human'
    const contentParts = parseContentParts(record.content)

    if (!isHuman) {
      return {
        id,
        kind: 'activity',
        title: `Grok ${syntheticReason}`,
        contentParts
      }
    }

    return {
      id,
      kind: 'user-message',
      contentParts
    }
  }

  if (type === 'assistant') {
    const contentParts: AgentSessionHistoryContentPart[] = []
    const textContent = extractString(record.content)

    if (textContent && textContent.length > 0) {
      contentParts.push({ kind: 'text', text: textContent })
    }

    if (Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        if (!isRecord(call)) continue
        const name = extractString(call.name) ?? 'tool'
        const callId = extractString(call.id)
        const input = typeof call.arguments === 'string' ? call.arguments : stringifyValue(call.arguments)
        contentParts.push({
          kind: 'tool-call',
          name,
          input,
          ...(callId ? { callId } : {})
        })
      }
    }

    const hasText = contentParts.some((p) => p.kind === 'text' && p.text.trim().length > 0)
    const kind = hasText ? 'assistant-message' : 'activity'

    return {
      id,
      kind,
      ...(kind === 'activity' ? { title: 'Grok tool_calls' } : {}),
      contentParts
    }
  }

  if (type === 'reasoning') {
    const contentParts: AgentSessionHistoryContentPart[] = []

    const summary = Array.isArray(record.summary)
      ? record.summary
          .map((s) => (isRecord(s) && s.type === 'summary_text' ? extractString(s.text) : null))
          .filter(Boolean)
          .join('\n')
      : null

    const contentText = Array.isArray(record.content)
      ? record.content
          .map((c) => (isRecord(c) && c.type === 'text' ? extractString(c.text) : null))
          .filter(Boolean)
          .join('\n')
      : null

    const parts = [summary, contentText].filter(Boolean)
    const text = parts.length > 0 ? parts.join('\n') : (extractString(record.text) ?? '')

    if (text) {
      contentParts.push({ kind: 'reasoning', text })
    }

    const encrypted = extractString(record.encrypted_content)
    if (encrypted) {
      contentParts.push({
        kind: 'resource',
        resourceType: 'other',
        reference: encrypted,
        label: 'Encrypted reasoning'
      })
    }

    if (contentParts.length === 0) {
      contentParts.push({ kind: 'reasoning', text: '' })
    }

    return {
      id,
      kind: 'activity',
      title: 'Grok reasoning',
      contentParts
    }
  }

  if (type === 'backend_tool_call') {
    const kindRecord = isRecord(record.kind) ? record.kind : undefined
    const name = extractString(kindRecord?.tool_type) ?? 'backend_tool'
    const callId = extractString(kindRecord?.id) ?? extractString(record.id)
    const input = JSON.stringify(kindRecord ?? record)

    return {
      id,
      kind: 'activity',
      title: 'Grok backend_tool_call',
      contentParts: [
        {
          kind: 'tool-call',
          name,
          input,
          ...(callId ? { callId } : {})
        }
      ]
    }
  }

  if (type === 'tool_result') {
    const toolCallId = extractString(record.tool_call_id)
    const output = typeof record.content === 'string' ? record.content : stringifyValue(record.content)

    const contentParts: AgentSessionHistoryContentPart[] = [
      {
        kind: 'tool-result',
        output,
        ...(toolCallId ? { callId: toolCallId } : {})
      }
    ]

    if (Array.isArray(record.images)) {
      for (const img of record.images) {
        if (!isRecord(img)) continue
        const url = extractString(img.url)
        if (url) {
          contentParts.push({ kind: 'resource', resourceType: 'image', reference: url })
        }
      }
    }

    return {
      id,
      kind: 'activity',
      title: 'Grok tool_result',
      contentParts
    }
  }

  if (type === 'system') {
    const text = typeof record.content === 'string' ? record.content : stringifyValue(record.content)
    return {
      id,
      kind: 'activity',
      title: 'Grok system',
      contentParts: [{ kind: 'text', text }]
    }
  }

  return {
    id,
    kind: 'activity',
    title: `Grok ${type}`,
    contentParts: [{ kind: 'text', text: JSON.stringify(record) }]
  }
}

export async function readGrokSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const chatHistoryPath = await resolveGrokChatHistoryPath(context)
  await verifySummaryIdentity(dirname(chatHistoryPath), context, budget)

  const reader = await NativeJsonlHistoryReader.open({
    ...context,
    transcriptPath: chatHistoryPath
  }, budget)

  try {
    const items: AgentSessionHistoryItem[] = []
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      const item = convertGrokRecord(entry.value, entry.start)
      if (item) {
        items.push(item)
      }
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
