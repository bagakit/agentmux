import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { blake3 } from '@noble/hashes/blake3.js'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import {
  NativeJsonlHistoryReader,
  NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES,
  type NativeJsonlHistoryRecord,
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
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import type { ProviderConversationChangesContext, ProviderConversationChangesPage } from '../session-history-changes.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryObservationContext,
  AgentProviderSessionHistoryPage,
  AgentProviderSessionHistoryRecordContext,
  AgentSessionHistoryItem as MaterializedHistoryItem,
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
type GrokTextGroup = {
  first: NativeJsonlHistoryRecord
  last: NativeJsonlHistoryRecord
  prompt: string
  texts: NativeTextValue[]
  sources: NativeTextValue[]
  inlineBytes: number
  beginningKnown: boolean
  hasSpeech: boolean
  final?: { at?: number }
}
function recordedTime(record: Record<string, unknown>): number | undefined {
  const value = record.timestamp
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000)
    ? value * 1000 : undefined
}
function publicChunk(row: Update): { prompt: string; text: NativeTextValue } | undefined {
  const prompt = promptId(row.params), content = row.update.content
  return row.method === 'session/update' && row.kind === 'agent_message_chunk' && prompt && !hostTurn(row.update)
    && isRecord(content) && content.type === 'text' && isNativeText(content.text) ? { prompt, text: content.text } : undefined
}
function knownGroupBoundary(row: Update): boolean {
  return row.method === 'session/update' && ['user_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(row.kind)
    || row.method === '_x.ai/session/update' && row.kind === 'turn_completed'
}
function successfulTerminal(row: Update, prompt: string): boolean {
  return row.method === '_x.ai/session/update' && row.kind === 'turn_completed' && row.update.prompt_id === prompt
    && (promptId(row.params) === undefined || promptId(row.params) === prompt)
    && row.update.stop_reason === 'end_turn' && row.update.error_kind == null
}
function groupItem(group: GrokTextGroup): AgentSessionHistoryItem | undefined {
  if (!group.hasSpeech) return undefined
  const text = nativeTextJoin(group.inlineBytes > SESSION_HISTORY_MAX_PAGE_BYTES / 2 ? group.sources : group.texts, '')
  const startedAt = recordedTime(group.first.value)
  return { id: `grok-update:${group.first.start}`, kind: 'assistant-message', turnId: group.prompt,
    messagePhase: group.final ? 'final' : 'progress', contentParts: [{ kind: 'text', text, contentEligibility: 'public' }],
    ...(startedAt === undefined ? {} : { startedAt }), ...(group.final?.at === undefined ? {} : { completedAt: group.final.at }) }
}

/** Grok's Text and Narration channels both produce public ACP message chunks.
 * The Provider combines that original stream; tools and thoughts remain separate records.
 * Source: grok-build 2bdd1d6a, sampling_events.rs and updates.rs. This is a read-local
 * accumulator, never a second durable conversation or a Runtime state detector. */
class GrokMessageProjection {
  private readonly groups = new Map<number, GrokTextGroup>()
  private active: GrokTextGroup | undefined
  constructor(private readonly reader: NativeJsonlHistoryReader, private readonly sessionId: string) {}
  private row(entry: NativeJsonlHistoryRecord): Update { return updateRecord(entry.value, this.sessionId) }
  private source(row: Update, text: NativeTextValue): NativeTextValue {
    return this.reader.sourceText(row.update.content as Record<string, unknown>, 'text') ?? text
  }
  private inlineBytes(text: NativeTextValue): number {
    return typeof text === 'string' ? Buffer.byteLength(JSON.stringify(text)) : SESSION_HISTORY_MAX_PAGE_BYTES
  }
  private async prefix(entry: NativeJsonlHistoryRecord): Promise<GrokTextGroup> {
    const row = this.row(entry), chunk = publicChunk(row)!
    const entries = [entry], texts = [chunk.text], sources = [this.source(row, chunk.text)]
    let first = entry, beginningKnown = first.start === 0
    while (first.start > 0) {
      const previous = await this.reader.readBefore(first.start)
      if (!previous) { beginningKnown = true; break }
      const row = this.row(previous), associated = promptId(row.params), prior = publicChunk(row)
      if (associated !== undefined && associated !== chunk.prompt) { beginningKnown = true; break }
      if (prior?.prompt === chunk.prompt) { entries.push(previous); texts.push(prior.text); sources.push(this.source(row, prior.text)); first = previous; continue }
      if (groupMetadata(row)) { first = previous; continue }
      beginningKnown = knownGroupBoundary(row)
      break
    }
    if (first.start === 0) beginningKnown = true
    const group: GrokTextGroup = { first: entries.at(-1)!, last: entry, prompt: chunk.prompt, texts: texts.reverse(), sources: sources.reverse(),
      inlineBytes: texts.reduce((bytes, text) => bytes + this.inlineBytes(text), 0), beginningKnown, hasSpeech: texts.some(nativeTextHasSpeech) }
    for (const member of entries) this.groups.set(member.start, group)
    return group
  }
  private append(group: GrokTextGroup, entry: NativeJsonlHistoryRecord, text: NativeTextValue): void {
    group.texts.push(text); group.sources.push(this.source(this.row(entry), text)); group.inlineBytes += this.inlineBytes(text)
    group.hasSpeech ||= nativeTextHasSpeech(text); group.last = entry; this.groups.set(entry.start, group)
  }
  async before(terminal: NativeJsonlHistoryRecord): Promise<GrokTextGroup | undefined> {
    const boundary = this.row(terminal), prompt = extractString(boundary.update.prompt_id)
    if (!prompt || !successfulTerminal(boundary, prompt)) return undefined
    let position = terminal.start
    while (position > 0) {
      const entry = await this.reader.readBefore(position)
      if (!entry) break
      position = entry.start
      const row = this.row(entry), associated = promptId(row.params)
      if (associated !== undefined && associated !== prompt) break
      if (groupMetadata(row)) continue
      if (publicChunk(row)?.prompt !== prompt) break
      const group = this.groups.get(entry.start) ?? await this.prefix(entry)
      if (!group.beginningKnown) return undefined
      group.final = { ...(recordedTime(terminal.value) === undefined ? {} : { at: recordedTime(terminal.value)! }) }
      return group
    }
    return undefined
  }
  async complete(entry: NativeJsonlHistoryRecord): Promise<GrokTextGroup> {
    const cached = this.groups.get(entry.start)
    if (cached) return cached
    const group = await this.prefix(entry)
    let next = group.last.end
    for (let after = await this.reader.readAt(next); after; after = await this.reader.readAt(next)) {
      const row = this.row(after), associated = promptId(row.params), chunk = publicChunk(row)
      if (associated !== undefined && associated !== group.prompt) break
      if (chunk?.prompt === group.prompt) this.append(group, after, chunk.text)
      else if (!groupMetadata(row)) {
        if (group.beginningKnown && successfulTerminal(row, group.prompt)) group.final = { ...(recordedTime(after.value) === undefined ? {} : { at: recordedTime(after.value)! }) }
        break
      }
      next = after.end
    }
    return group
  }
  async history(entry: NativeJsonlHistoryRecord): Promise<AgentSessionHistoryItem | null> {
    const row = this.row(entry), chunk = publicChunk(row)
    if (chunk) {
      // A non-first speech member contributes no history item. Inspect only its
      // adjoining predecessor before assembling a body this page will not return.
      if (!this.groups.has(entry.start) && nativeTextHasSpeech(chunk.text)) {
        let position = entry.start
        for (let prior = await this.reader.readBefore(position); prior; prior = await this.reader.readBefore(position)) {
          const previous = this.row(prior), associated = promptId(previous.params)
          if (associated !== undefined && associated !== chunk.prompt) break
          if (publicChunk(previous)?.prompt === chunk.prompt) return null
          if (!groupMetadata(previous)) break
          position = prior.start
        }
      }
      const group = await this.complete(entry)
      if (!group.hasSpeech) return rawRecord(entry, row)
      return group.first.start === entry.start ? groupItem(group)! : null
    }
    if (row.kind === 'turn_completed' && (await this.before(entry))?.hasSpeech) return null
    return rawRecord(entry, row)
  }
  async change(): Promise<GrokProjectionChange | null> {
    const entry = await this.reader.readNext()
    if (!entry) return null
    const row = this.row(entry), chunk = publicChunk(row)
    if (chunk) {
      let group = this.active
      if (!group || group.prompt !== chunk.prompt) group = await this.prefix(entry)
      else this.append(group, entry, chunk.text)
      this.active = group
      // Coalesce a contiguous batch before materializing. Work follows original
      // bytes, not every growing prefix or the number of unrelated Sessions.
      for (let next = await this.reader.readNext(); next; next = await this.reader.readNext()) {
        const nextChunk = publicChunk(this.row(next))
        if (nextChunk?.prompt !== group.prompt) { this.reader.repeatNext(); break }
        this.append(group, next, nextChunk.text)
      }
      return groupChange(group) ?? originalChange(rawRecord(entry, row))
    }
    const final = row.kind === 'turn_completed' ? await this.before(entry) : undefined
    if (!groupMetadata(row) || promptId(row.params) !== undefined && promptId(row.params) !== this.active?.prompt) this.active = undefined
    return final && groupChange(final) || originalChange(rawRecord(entry, row))
  }
}
function groupItemIfPresent(group: GrokTextGroup | undefined): AgentSessionHistoryItem | undefined { return group && groupItem(group) }

type GrokProjectionChange = { id: string; value(): AgentSessionHistoryItem }
function originalChange(item: AgentSessionHistoryItem): GrokProjectionChange { return { id: item.id, value: () => item } }
/** Keep a versioned slice of the read-local accumulator, not a copied growing body. */
function groupChange(group: GrokTextGroup): GrokProjectionChange | undefined {
  if (!group.hasSpeech) return undefined
  const { texts, sources, final, ...fields } = group, count = texts.length
  return { id: `grok-update:${group.first.start}`, value: () => groupItem({ ...fields, texts: texts.slice(0, count), sources: sources.slice(0, count), ...(final ? { final } : {}) })! }
}


/** Exact non-group originals remain readable at their original physical IDs. */
function rawRecord(entry: NativeJsonlHistoryRecord, row: Update): AgentSessionHistoryItem {
  const { update, kind, method } = row, id = `grok-update:${entry.start}`, timestamp = recordedTime(entry.value)
  const time = timestamp === undefined ? {} : { startedAt: timestamp }
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
    contentParts: [{ kind: 'text', text: nativeJsonStringify(entry.value), contentEligibility: 'unconfirmed' }] }
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
    const items: AgentSessionHistoryItem[] = [], projection = new GrokMessageProjection(reader, context.source.nativeSessionId)
    while (items.length < context.limit) {
      const entry = await reader.readPrevious()
      if (!entry) break
      const item = await projection.history(entry)
      if (item) items.push(item)
    }
    const nextCursor = await reader.nextCursor()
    return { source: context.source, items: await Promise.all(items.reverse().map(item => reader.materializeItem(item))), nextCursor,
      changesCursor: await reader.historyChangesCursor(), replayCursor: await reader.historyReplayCursor(), sourceSizeBytes: reader.sourceSizeBytes }
  } finally { await reader.close() }
}
export async function readGrokConversationChanges(context: ProviderConversationChangesContext): Promise<ProviderConversationChangesPage> {
  const reader = await openGrokReader(context)
  try {
    if (context.head && (context.after !== undefined || context.tail)) throw new AgentMuxError('A beginning checkpoint cannot include another source position.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
    await reader.seekChanges(context.after, context.tail === true)
    const initialCursor = await reader.changesCursor(), projection = new GrokMessageProjection(reader, context.source.nativeSessionId)
    const steps: { change: GrokProjectionChange; cursor: string }[] = [], ids = new Set<string>()
    if (!context.tail && !context.head) while (ids.size < context.limit) {
      const change = await projection.change()
      if (!change) break
      ids.add(change.id); steps.push({ change, cursor: await reader.changesCursor() })
    }
    const cache = new Map<GrokProjectionChange, MaterializedHistoryItem>()
    const materialize = async (count: number) => {
      const latest = new Map<string, GrokProjectionChange>()
      for (const step of steps.slice(0, count)) latest.set(step.change.id, step.change)
      const items: MaterializedHistoryItem[] = []
      for (const change of latest.values()) {
        let item = cache.get(change)
        if (!item) { item = await reader.materializeItem(change.value()); cache.set(change, item) }
        items.push(item)
      }
      return { items, bytes: Buffer.byteLength(JSON.stringify(items)) }
    }
    const budget = SESSION_HISTORY_MAX_PAGE_BYTES - NATIVE_CONVERSATION_CHANGES_PAGE_RESERVE_BYTES
    let count = steps.length, page = await materialize(count)
    if (page.bytes > budget) {
      // Every retained cursor precedes exactly the following original step. Pick a
      // fitting prefix without rescanning source bytes or dropping its later updates.
      let lower = 0, upper = count - 1
      while (lower < upper) {
        const candidate = Math.ceil((lower + upper) / 2), rendered = await materialize(candidate)
        if (rendered.bytes <= budget) lower = candidate; else upper = candidate - 1
      }
      count = lower
      if (!count) throw new AgentMuxError('The original change cannot fit its materialized page.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
      page = await materialize(count)
    }
    return { source: context.source, items: page.items, cursor: steps[count - 1]?.cursor ?? initialCursor,
      more: count < steps.length || !(context.tail || context.head) && await reader.hasMoreChanges() }
  } finally { await reader.close() }
}

/** Locate the original byte identity, then read only its own adjoining text group. */
export async function readGrokSessionHistoryRecord(context: AgentProviderSessionHistoryRecordContext): Promise<MaterializedHistoryItem> {
  const reader = await openGrokReader({ ...context, limit: 1 })
  try {
    const match = /^grok-update:(0|[1-9][0-9]*)$/u.exec(context.recordId), start = match ? Number(match[1]) : NaN
    const entry = Number.isSafeInteger(start) ? await reader.readAt(start) : null
    if (!entry) throw new AgentMuxError('The original Grok record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
    const row = updateRecord(entry.value, context.source.nativeSessionId), projection = new GrokMessageProjection(reader, context.source.nativeSessionId)
    let item = rawRecord(entry, row)
    if (publicChunk(row)) {
      const group = await projection.complete(entry)
      if (group.first.start === entry.start) item = groupItem(group) ?? item
    } else if (row.kind === 'turn_completed') {
      const originalFinal = groupItemIfPresent(await projection.before(entry))
      if (originalFinal) {
        const { startedAt: _startedAt, completedAt: _completedAt, ...reply } = originalFinal, time = recordedTime(entry.value)
        item = { ...reply, id: context.recordId, ...(time === undefined ? {} : { startedAt: time }) }
      }
    }
    if (context.turnId !== undefined && item.turnId !== context.turnId) throw new AgentMuxError('The original Grok record is unavailable.', 'UNKNOWN_AGENT_SESSION_HISTORY_RECORD')
    await reader.verifyUnchanged()
    return await reader.materializeItem(item)
  } finally { await reader.close() }
}
