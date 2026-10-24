import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { blake3 } from '@noble/hashes/blake3.js'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import {
  NativeJsonlHistoryReader,
  readNativeConversationChanges,
  readNativeHistoryBytes,
  type NativeHistoryReadBudget
} from '../native-jsonl-history-reader.js'
import {
  isNativeText,
  nativeJsonStringify,
  nativeTextJoin,
  nativeTextHasSpeech,
  type NativeTextValue,
  type NativeHistoryContentPart as AgentSessionHistoryContentPart,
  type NativeHistoryItem as AgentSessionHistoryItem
} from '../native-history-value.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../session-history-changes.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryObservationContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryObservationHandle
} from '../types.js'

type GrokHistorySourceContext = Pick<AgentProviderSessionHistoryContext,
  'source' | 'transcriptPath' | 'env' | 'workspacePath' | 'signal'>

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

function extractText(value: unknown): NativeTextValue | undefined { return isNativeText(value) ? value : undefined }

export async function resolveGrokUpdatesPath(
  context: GrokHistorySourceContext,
  allowMissing = false
): Promise<string> {
  const givenPath = context.transcriptPath
  if (givenPath) {
    if (!isAbsolute(givenPath)) {
      throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
    }
    const fileBase = basename(givenPath)
    if (fileBase === GROK_UPDATES_FILE) return givenPath
    if (fileBase === 'chat_history.jsonl') {
      throw new AgentMuxError('The original raw-model source is not the native conversation stream.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
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
  const candidate = join(grokHome, 'sessions', encodedGroup, sessionId, GROK_UPDATES_FILE)

  try {
    const s = await stat(candidate)
    if (!s.isFile()) {
      throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
    }
  } catch (err: unknown) {
    // Observation can await the first write to this exact native source.
    if (allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return candidate
    if (err instanceof AgentMuxError) throw err
    throw new AgentMuxError('Native transcript path has not been established.', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE')
  }

  return candidate
}

async function verifySummaryIdentity(
  sessionDir: string,
  context: GrokHistorySourceContext,
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

// updates.jsonl is Grok's durable conversation owner. Raw model inputs are not a
// fallback: compaction and replay can replace chat_history.jsonl independently.
type Update = { params: Record<string, unknown>; update: Record<string, unknown>; kind: string; method: string }
function updateRecord(record: Record<string, unknown>, sessionId: string): Update {
  const params = isRecord(record.params) ? record.params : undefined
  const update = params && isRecord(params.update) ? params.update : undefined
  if (!params || !update || typeof update.sessionUpdate !== 'string' ||
      !['session/update', '_x.ai/session/update'].includes(String(record.method))) {
    throw new AgentMuxError('Grok native update is malformed.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
  }
  if (params.sessionId !== sessionId) {
    throw new AgentMuxError('Grok update belongs to another native Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
  if (update.sessionUpdate === 'rewind_marker') {
    throw new AgentMuxError('Grok native conversation branch changed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
  return { params, update, kind: update.sessionUpdate, method: record.method as string }
}
function promptId(params: Record<string, unknown>): string | undefined {
  return isRecord(params._meta) ? extractString(params._meta.promptId) : undefined
}
function hostTurn(update: Record<string, unknown>): boolean {
  return isRecord(update._meta) && update._meta.hostTurn === true
}
function textPart(content: unknown, eligibility: 'public' | 'private' | 'unconfirmed'): AgentSessionHistoryContentPart[] {
  if (!isRecord(content)) return []
  if (content.type === 'text') {
    const meta = isRecord(content._meta) ? content._meta : undefined
    const text = extractText(meta?.displayText) ?? extractText(content.text)
    return text === undefined ? [] : [{ kind: 'text', text, contentEligibility: eligibility }]
  }
  return [{ kind: 'text', text: nativeJsonStringify(content), contentEligibility: 'unconfirmed' }]
}
// These are non-speech protocol variants, never evidence of an additional author
// or message boundary. Persisted hook_annotation/current_mode_update can follow
// final chunks. Unknown variants stop assembly instead of joining unrelated text.
function groupMetadata(row: Update): boolean {
  return row.method === 'session/update' ? row.kind === 'current_mode_update'
    : ['hook_annotation', 'hook_run_started', 'hook_execution', 'turn_usage', 'response_completed'].includes(row.kind)
}
async function finalText(reader: NativeJsonlHistoryReader, start: number, sessionId: string, terminalPrompt: string): Promise<NativeTextValue | undefined> {
  const chunks: NativeTextValue[] = []
  let position = start
  while (position > 0) {
    const previous = await reader.readBefore(position)
    if (!previous) break
    position = previous.start
    const row = updateRecord(previous.value, sessionId)
    const associated = promptId(row.params)
    if (associated !== undefined && associated !== terminalPrompt) break
    if (groupMetadata(row)) continue
    if (row.method === 'session/update' && row.kind === 'agent_message_chunk') {
      const content = isRecord(row.update.content) ? row.update.content : undefined
      // An unknown or incomplete member cannot prove where the public group
      // begins. Do not publish only the suffix as a complete answer.
      if (associated !== terminalPrompt || hostTurn(row.update) || content?.type !== 'text' || !isNativeText(content.text)) return undefined
      chunks.push(content.text)
      continue
    }
    if (row.method === 'session/update' && ['user_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(row.kind) ||
        row.method === '_x.ai/session/update' && row.kind === 'turn_completed') break
    return undefined
  }
  const text = nativeTextJoin(chunks.reverse(), '')
  return nativeTextHasSpeech(text) ? text : undefined
}

async function convertGrokRecord(reader: NativeJsonlHistoryReader, record: Record<string, unknown>, start: number, sessionId: string): Promise<AgentSessionHistoryItem> {
  const row = updateRecord(record, sessionId), { params, update, kind, method } = row
  const id = `grok-update:${start}`
  const timestamp = typeof record.timestamp === 'number' && Number.isSafeInteger(record.timestamp) && record.timestamp >= 0
    && Number.isSafeInteger(record.timestamp * 1000) ? record.timestamp * 1000 : undefined
  const time = timestamp === undefined ? {} : { startedAt: timestamp }
  if (method === '_x.ai/session/update' && kind === 'turn_completed') {
    const turnId = extractString(update.prompt_id)
    // agent_result is null for success in the native producer, and may contain
    // backend error details for failure. Only the original text group is speech.
    const text = turnId && (promptId(params) === undefined || promptId(params) === turnId) && update.stop_reason === 'end_turn' && update.error_kind == null
      ? await finalText(reader, start, sessionId, turnId) : undefined
    if (text !== undefined) return { id, kind: 'assistant-message', turnId: turnId!, messagePhase: 'final', ...time,
      contentParts: [{ kind: 'text', text, contentEligibility: 'public' }] }
  }
  if (method === 'session/update') {
    if (kind === 'user_message_chunk') return { id, kind: hostTurn(update) ? 'activity' : 'user-message', ...time,
      contentParts: textPart(update.content, hostTurn(update) ? 'private' : 'unconfirmed') }
    if (kind === 'agent_message_chunk') return { id, kind: 'activity', title: 'Grok text chunk', ...time,
      contentParts: textPart(update.content, hostTurn(update) ? 'private' : 'unconfirmed') }
    if (kind === 'agent_thought_chunk') {
      const content = isRecord(update.content) ? update.content : undefined
      return { id, kind: 'activity', title: 'Grok thought', ...time,
        contentParts: content?.type === 'text' && isNativeText(content.text)
          ? [{ kind: 'reasoning', text: content.text, contentEligibility: 'private' }] : [] }
    }
    if (kind === 'tool_call') return { id, kind: 'activity', title: 'Grok tool call', ...time,
      contentParts: [{ kind: 'tool-call', name: extractString(update.title) ?? 'tool',
        ...(extractString(update.toolCallId) ? { callId: update.toolCallId as string } : {}),
        input: nativeJsonStringify(update.rawInput ?? {}), contentEligibility: 'unconfirmed' }] }
    if (kind === 'tool_call_update') return { id, kind: 'activity', title: 'Grok tool result', ...time,
      contentParts: [{ kind: 'tool-result', ...(extractString(update.toolCallId) ? { callId: update.toolCallId as string } : {}),
        output: nativeJsonStringify(update.rawOutput ?? update.content ?? []), contentEligibility: 'unconfirmed' }] }
  }
  return { id, kind: 'activity', title: `Grok ${kind}`, ...time,
    contentParts: [{ kind: 'text', text: nativeJsonStringify(record), contentEligibility: 'unconfirmed' }] }
}

async function openGrokReader(context: AgentProviderSessionHistoryContext): Promise<NativeJsonlHistoryReader> {
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const transcriptPath = await resolveGrokUpdatesPath(context)
  await verifySummaryIdentity(dirname(transcriptPath), context, budget)
  return NativeJsonlHistoryReader.open({ ...context, transcriptPath }, budget)
}

/** Observe the same verified native updates file as history and changes. */
export async function observeGrokSessionHistory(context: AgentProviderSessionHistoryObservationContext): Promise<AgentSessionHistoryObservationHandle> {
  const budget: NativeHistoryReadBudget = { bytesRead: 0, startedAt: Date.now() }
  const transcriptPath = await resolveGrokUpdatesPath(context, true)
  await verifySummaryIdentity(dirname(transcriptPath), context, budget)
  return observeNativeJsonlHistory({ ...context, transcriptPath })
}
export async function readGrokSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const reader = await openGrokReader(context)
  try {
    const items: AgentSessionHistoryItem[] = []
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      items.push(await convertGrokRecord(reader, entry.value, entry.start, context.source.nativeSessionId))
    }
    const nextCursor = await reader.nextCursor()
    return { source: context.source, items: await Promise.all(items.reverse().map(item => reader.materializeItem(item))), nextCursor,
      changesCursor: await reader.historyChangesCursor(), replayCursor: await reader.historyReplayCursor(), sourceSizeBytes: reader.sourceSizeBytes }
  } finally { await reader.close() }
}
export async function readGrokConversationChanges(context: ProviderConversationChangesContext): Promise<ProviderConversationChangesPage> {
  const reader = await openGrokReader(context)
  try {
    return await readNativeConversationChanges(reader, context,
      (record, start) => convertGrokRecord(reader, record, start, context.source.nativeSessionId))
  } finally { await reader.close() }
}
