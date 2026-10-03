import { proto3, type AnyMessage } from '@bufbuild/protobuf'
import { cursorNativeType } from './cursor-native-schema.js'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { NativeSqliteHistoryReader, type NativeSqliteHistoryIdentity } from '../native-sqlite-history-reader.js'
import { observeNativeSqliteHistory } from '../native-sqlite-history-observer.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryObservationContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Workspace slug matching first-party ../utils/dist/workspace-paths.js:
 * Replaces non-ASCII-alphanumeric with '-', collapses consecutive '-', trims '-'.
 * Does not independently resolve or realpath the input.
 */
export function cursorWorkspaceSlug(workspacePath: string): string {
  return workspacePath
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Encodes conversation ID matching first-party ../utils/dist/workspace-paths.js:
 * encodeURIComponent, replace '%' with '_', capped at 200 UTF-16 code units.
 */
export function encodeCursorChatId(chatId: string): string {
  let t = encodeURIComponent(chatId).replace(/%/g, '_')
  return t.length > 200 ? t.slice(0, 200) : t
}

/**
 * Computes Cursor data root:
 * Returns nonblank CURSOR_DATA_DIR verbatim (preserving whitespace); if relative,
 * resolves against launch workspace. Defaults to ~/.cursor.
 */
export function cursorDataRoot(
  workspacePath?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const raw = cursorEnvironmentValue(env, 'CURSOR_DATA_DIR')
  if (raw !== undefined && raw.trim().length > 0) {
    if (isAbsolute(raw)) return raw
    return workspacePath ? resolve(workspacePath, raw) : resolve(raw)
  }
  return join(homedir(), '.cursor')
}

/**
 * Computes Cursor config root:
 * Returns nonblank CURSOR_CONFIG_DIR verbatim; otherwise checks XDG_CONFIG_HOME;
 * defaults to ~/.cursor.
 */
export function cursorConfigRoot(
  workspacePath?: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const raw = cursorEnvironmentValue(env, 'CURSOR_CONFIG_DIR')
  if (raw !== undefined && raw.trim().length > 0) {
    if (isAbsolute(raw)) return raw
    return workspacePath ? resolve(workspacePath, raw) : resolve(raw)
  }
  const xdg = cursorEnvironmentValue(env, 'XDG_CONFIG_HOME')
  if (xdg !== undefined && xdg.trim().length > 0) {
    if (isAbsolute(xdg)) return join(xdg, 'cursor')
    return join(workspacePath ? resolve(workspacePath, xdg) : resolve(xdg), 'cursor')
  }
  return join(homedir(), '.cursor')
}

// CLI invocations inherit ambient environment; explicit undefined removes a key.
function cursorEnvironmentValue(env: Readonly<Record<string, string | undefined>> | undefined, key: string): string | undefined {
  return env && Object.hasOwn(env, key) ? env[key] : process.env[key]
}

/**
 * Deterministic path to the native state SQLite store.db:
 * <configRoot>/chats/<md5(resolve(workspace))>/<nativeSessionId>/store.db
 */
export function resolveCursorStorePath(
  workspacePath: string,
  chatId: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const root = cursorConfigRoot(workspacePath, env)
  const bucket = createHash('md5').update(resolve(workspacePath)).digest('hex')
  return join(root, 'chats', bucket, chatId, 'store.db')
}

/**
 * Deterministic path to the supplementary session transcript JSONL:
 * <dataRoot>/projects/<slug>/agent-transcripts/<encodedId>/<encodedId>.jsonl
 */
export function resolveCursorTranscriptPath(
  workspacePath: string,
  chatId: string,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const root = cursorDataRoot(workspacePath, env)
  const slug = cursorWorkspaceSlug(workspacePath)
  const encodedId = encodeCursorChatId(chatId)
  return join(root, 'projects', slug, 'agent-transcripts', encodedId, `${encodedId}.jsonl`)
}

type CursorDecoded = {
  version: 2
  providerId: string
  nativeSessionId: string
  identity: NativeSqliteHistoryIdentity
  rootBlobId: string
  turnCut: number
  beforeTurn: number
  beforeRecord: number
}

function parseCursor(value: string, context: AgentProviderSessionHistoryContext): CursorDecoded {
  let raw: unknown
  try { raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch {}
  const cursor = asRecord(raw), identity = asRecord(cursor?.identity)
  if (!cursor || cursor.version !== 2 || !identity || typeof identity.path !== 'string' ||
    typeof identity.dev !== 'string' || !/^\d+$/.test(identity.dev) ||
    typeof identity.ino !== 'string' || !/^\d+$/.test(identity.ino) ||
    typeof cursor.rootBlobId !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.rootBlobId) ||
    !Number.isSafeInteger(cursor.turnCut) || !Number.isSafeInteger(cursor.beforeTurn) || !Number.isSafeInteger(cursor.beforeRecord) ||
    Number(cursor.turnCut) < 0 || Number(cursor.beforeTurn) < 0 || Number(cursor.beforeTurn) >= Number(cursor.turnCut) || Number(cursor.beforeRecord) < -1) {
    return invalid('Native history cursor is invalid; reopen the newest page.', 'INVALID_CURSOR')
  }
  if (cursor.providerId !== 'cursor' || cursor.nativeSessionId !== context.source.nativeSessionId) {
    return invalid('Native history cursor belongs to another source.', 'SOURCE_CHANGED')
  }
  return cursor as CursorDecoded
}

type Native = AnyMessage & Record<string, unknown>
function decodeNative(name: string, bytes: Uint8Array): Native {
  try { return cursorNativeType('agent.v1.' + name).fromBinary(bytes) as Native } catch {
    return invalid('Cursor native history contains an invalid ' + name + ' protobuf.')
  }
}
function blobHex(bytes: unknown): string {
  return bytes instanceof Uint8Array ? Buffer.from(bytes).toString('hex') : ''
}
function nativeTime(value: unknown): number | undefined {
  const time = typeof value === 'bigint' ? Number(value) : value
  return typeof time === 'number' && Number.isSafeInteger(time) && time > 0 ? time : undefined
}
function times(value: Record<string, unknown>): Pick<AgentSessionHistoryItem, 'startedAt' | 'completedAt'> {
  const startedAt = nativeTime(value.startedAtMs), completedAt = nativeTime(value.completedAtMs)
  return { ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }) }
}
function hasUnknown(value: AnyMessage): boolean {
  if (proto3.bin.listUnknownFields(value).length > 0) return true
  const raw = value as Native
  for (const field of value.getType().fields.list()) {
    if (field.kind === 'map' && field.V.kind === 'message') {
      for (const item of Object.values(asRecord(raw[field.localName]) ?? {})) {
        if (item && typeof (item as AnyMessage).getType === 'function' && hasUnknown(item as AnyMessage)) return true
      }
      continue
    }
    if (field.kind !== 'message') continue
    const selected = field.oneof ? (raw[field.oneof.localName] as { case?: string; value?: unknown }) : undefined
    const nested = field.oneof ? selected?.case === field.localName ? selected.value : undefined : raw[field.localName]
    for (const item of Array.isArray(nested) ? nested : [nested]) {
      if (item && typeof (item as AnyMessage).getType === 'function' && hasUnknown(item as AnyMessage)) return true
    }
  }
  return false
}
function preserveUnknown(message: Native, parts: AgentSessionHistoryContentPart[], original: Uint8Array): void {
  if (hasUnknown(message)) parts.push({ kind: 'resource', resourceType: 'other',
    reference: 'data:application/x-protobuf;base64,' + Buffer.from(original).toString('base64'), label: 'Original Cursor protobuf record' })
}
function nativeJson(message: unknown): string {
  return message && typeof (message as AnyMessage).toJson === 'function'
    ? JSON.stringify((message as AnyMessage).toJson()) : '{}'
}
async function userItem(reader: NativeSqliteHistoryReader, id: string, bytes: Uint8Array): Promise<AgentSessionHistoryItem> {
  const message = decodeNative('UserMessage', bytes), parts: AgentSessionHistoryContentPart[] = []
  let text = typeof message.text === 'string' ? message.text : ''
  const textBlob = blobHex(message.textBlobId)
  if (textBlob) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readBlob(reader, textBlob)) }
    catch (error) { if (error instanceof AgentMuxError) throw error; return invalid('Cursor native user text contains invalid UTF-8.') }
  }
  if (text) parts.push({ kind: 'text', text })
  const context = asRecord(message.selectedContext)
  for (const image of (context?.selectedImages ?? []) as Native[]) {
    const path = typeof image.path === 'string' && image.path ? image.path : undefined
    const data = image.data instanceof Uint8Array && image.data.length ? image.data : undefined
    const blobId = blobHex(image.blobId)
    const reference = path ?? (data ? `data:${typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}` :
      blobId ? `cursor-blob:${blobId}` : undefined)
    if (reference) parts.push({ kind: 'resource', resourceType: 'image', reference })
  }
  for (const file of (context?.files ?? []) as Native[]) {
    const reference = typeof file.path === 'string' && file.path ? file.path : typeof file.relativePath === 'string' ? file.relativePath : ''
    if (reference) parts.push({ kind: 'resource', resourceType: 'file', reference })
  }
  preserveUnknown(message, parts, bytes)
  if ((typeof message.richText === 'string' && message.richText) || blobHex(message.richTextBlobId)) parts.push({ kind: 'resource', resourceType: 'other',
    reference: 'data:application/x-protobuf;base64,' + Buffer.from(bytes).toString('base64'), label: 'Original Cursor rich input' })
  if (!parts.length) parts.push({ kind: 'text', text: nativeJson(message) })
  return { id, kind: message.isSimulatedMsg === true ? 'activity' : 'user-message', contentParts: parts,
    ...(message.isSimulatedMsg === true ? { title: 'Cursor simulated input' } : {}), ...times(message) }
}
function stepItem(id: string, bytes: Uint8Array): AgentSessionHistoryItem {
  const step = decodeNative('ConversationStep', bytes), selected = asRecord(step.message), message = asRecord(selected?.value)
  const parts: AgentSessionHistoryContentPart[] = []
  let kind: AgentSessionHistoryItem['kind'] = 'activity'
  if (selected?.case === 'assistantMessage' || selected?.case === 'thinkingMessage') {
    kind = 'assistant-message'
    if (typeof message?.text === 'string') parts.push({ kind: selected.case === 'thinkingMessage' ? 'reasoning' : 'text', text: message.text })
  } else if (selected?.case === 'toolCall' && message) {
    const tool = asRecord(message.tool), call = asRecord(tool?.value)
    if (typeof tool?.case === 'string' && call) {
      const name = tool.case.replace(/ToolCall$/, '').replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
      const callId = typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : undefined
      if (call.args) parts.push({ kind: 'tool-call', name, ...(callId ? { callId } : {}), input: nativeJson(call.args) })
      const result = asRecord(asRecord(call.result)?.result)
      if (typeof result?.case === 'string' && result.value) parts.push({ kind: 'tool-result', name, ...(callId ? { callId } : {}),
        output: nativeJson(result.value), failed: result.case !== 'success' || asRecord(result.value)?.isError === true ||
          (tool.case === 'shellToolCall' && typeof asRecord(result.value)?.exitCode === 'number' && asRecord(result.value)?.exitCode !== 0) })
    }
  }
  preserveUnknown(step, parts, bytes)
  if (!parts.length) parts.push({ kind: 'resource', resourceType: 'other', reference: 'data:application/x-protobuf;base64,' + Buffer.from(bytes).toString('base64'), label: 'Original Cursor protobuf step' })
  return { id, kind, contentParts: parts, ...(message ? times(message) : {}) }
}

function invalid(message: string, code = 'INVALID_TRANSCRIPT'): never {
  throw new AgentMuxError(message, `AGENT_SESSION_HISTORY_${code}`)
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const record = asRecord(value)
    if (record) return record
  } catch {}
  return invalid('Cursor native history contains an invalid JSON record.')
}

async function metadataValue(reader: NativeSqliteHistoryReader): Promise<Record<string, unknown>> {
  const row = await reader.get('SELECT value FROM meta WHERE key = ?', ['0'])
  const value = row?.[0]
  if (typeof value !== 'string' || !value || value.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(value)) {
    return invalid('Cursor native Session metadata is missing or invalid.')
  }
  return decodeJson(Buffer.from(value, 'hex'))
}
function assertMetadata(metadata: Record<string, unknown>, nativeSessionId: string): void {
  if (metadata.agentId !== nativeSessionId) return invalid('Cursor native metadata belongs to another Session.', 'SOURCE_CHANGED')
  if (typeof metadata.latestRootBlobId !== 'string' || (metadata.latestRootBlobId && !/^[a-f0-9]{64}$/.test(metadata.latestRootBlobId))) {
    return invalid('Cursor native root identity is missing or invalid.')
  }
}
export async function readCursorStoreMetadata(reader: NativeSqliteHistoryReader, nativeSessionId: string): Promise<Record<string, unknown>> {
  const metadata = await metadataValue(reader)
  assertMetadata(metadata, nativeSessionId)
  await reader.verifyUnchanged()
  return metadata
}

async function readBlob(reader: NativeSqliteHistoryReader, id: string): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/.test(id)) return invalid('Cursor native history has an invalid blob identity.')
  const row = await reader.get('SELECT data FROM blobs WHERE id = ?', [id])
  if (!(row?.[0] instanceof Uint8Array)) return invalid('Cursor native history snapshot no longer contains its referenced blob.', 'SOURCE_CHANGED')
  const bytes = row[0]
  if (createHash('sha256').update(bytes).digest('hex') !== id) return invalid('Cursor native history blob changed under its immutable identity.', 'SOURCE_CHANGED')
  return bytes
}

function historyPath(context: AgentProviderSessionHistoryContext | AgentProviderSessionHistoryObservationContext): string {
  context.signal.throwIfAborted()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context.source.nativeSessionId)) {
    return invalid('Cursor native Session identity has not been established.', 'LOCATOR_UNAVAILABLE')
  }
  const path = resolveCursorStorePath(context.workspacePath, context.source.nativeSessionId, context.env)
  if (context.transcriptPath && (!isAbsolute(context.transcriptPath) ||
    (resolve(context.transcriptPath) !== path && resolve(context.transcriptPath) !== resolveCursorTranscriptPath(context.workspacePath, context.source.nativeSessionId, context.env)))) {
    return invalid('Cursor transcript locator belongs to another native Session.', 'SOURCE_CHANGED')
  }
  return path
}

/** Exact committed native root changes only; no body scan or provider timer. */
export async function observeCursorSessionHistory(context: AgentProviderSessionHistoryObservationContext) {
  const path = historyPath(context)
  return observeNativeSqliteHistory(context, path, async () => {
    const reader = await NativeSqliteHistoryReader.open(path, context.signal)
    try {
      const metadata = await readCursorStoreMetadata(reader, context.source.nativeSessionId)
      return JSON.stringify([metadata.agentId, metadata.latestRootBlobId])
    } finally { await reader.close() }
  })
}

/** Typed native history only. Supplementary transcript paths are identity locators, never body fallback. */
export async function readCursorSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const path = historyPath(context)
  const cursor = context.cursor === undefined ? undefined : parseCursor(context.cursor, context)
  if (cursor && cursor.identity.path !== path) return invalid('Cursor native history path changed.', 'SOURCE_CHANGED')
  const reader = await NativeSqliteHistoryReader.open(path, context.signal)
  try {
    const identity = reader.identity
    if (cursor && (cursor.identity.dev !== identity.dev || cursor.identity.ino !== identity.ino)) {
      return invalid('Cursor native history database was replaced; reopen its newest page.', 'SOURCE_CHANGED')
    }
    const metadata = await readCursorStoreMetadata(reader, context.source.nativeSessionId)
    const rootBlobId = cursor?.rootBlobId ?? metadata.latestRootBlobId
    if (typeof rootBlobId !== 'string') return invalid('Cursor native root identity is missing.')
    if (rootBlobId === '') return { source: context.source, items: [], nextCursor: null }
    const root = decodeNative('ConversationStateStructure', await readBlob(reader, rootBlobId))
    const turns = root.turns as Uint8Array[]
    if (cursor && cursor.turnCut !== turns.length) return invalid('Cursor pinned native history root changed.', 'SOURCE_CHANGED')
    const items: AgentSessionHistoryItem[] = []
    let materializedBytes = Buffer.byteLength(JSON.stringify({ source: context.source, items: [], nextCursor: null }))
    let turnIndex = cursor?.beforeTurn ?? turns.length - 1
    let beforeRecord = cursor?.beforeRecord === -1 ? undefined : cursor?.beforeRecord
    while (turnIndex >= 0 && items.length < context.limit) {
      const turnBytes = await readBlob(reader, blobHex(turns[turnIndex]))
      const turn = decodeNative('ConversationTurnStructure', turnBytes)
      const selected = asRecord(turn.turn), structure = asRecord(selected?.value)
      const agent = selected?.case === 'agentConversationTurn'
      const steps = agent ? structure?.steps as Uint8Array[] : []
      const count = agent ? 1 + steps.length : 1
      const before = beforeRecord ?? count
      if (before > count) return invalid('Cursor continuation record is outside its pinned turn.', 'INVALID_CURSOR')
      let recordIndex = before - 1
      while (recordIndex >= 0 && items.length < context.limit) {
        let item: AgentSessionHistoryItem
        if (agent && structure) {
          item = recordIndex === 0
            ? await userItem(reader, `${turnIndex}:user`, await readBlob(reader, blobHex(structure.userMessage)))
            : stepItem(`${turnIndex}:step:${recordIndex - 1}`, await readBlob(reader, blobHex(steps[recordIndex - 1])))
        } else {
          const parts: AgentSessionHistoryContentPart[] = []
          if (selected?.case === 'shellConversationTurn' && structure) {
            const command = decodeNative('ShellCommand', await readBlob(reader, blobHex(structure.shellCommand)))
            const result = decodeNative('ShellOutput', await readBlob(reader, blobHex(structure.shellOutput)))
            parts.push({ kind: 'tool-call', name: 'shell', input: nativeJson(command) },
              { kind: 'tool-result', name: 'shell', output: nativeJson(result), ...(result.exitCode !== 0 ? { failed: true } : {}) })
          }
          preserveUnknown(turn, parts, turnBytes)
          if (!parts.length) parts.push({ kind: 'resource', resourceType: 'other', reference: 'data:application/x-protobuf;base64,' + Buffer.from(turnBytes).toString('base64'), label: 'Original Cursor protobuf turn' })
          item = { id: `${turnIndex}:turn`, kind: 'activity', contentParts: parts }
        }
        materializedBytes += Buffer.byteLength(JSON.stringify(item)) + 1
        if (materializedBytes > SESSION_HISTORY_MAX_PAGE_BYTES) return invalid('Cursor native history page exceeds its materialized byte limit.', 'TOO_LARGE')
        items.unshift(item); recordIndex--
      }
      beforeRecord = recordIndex + 1
      if (beforeRecord === 0) { turnIndex--; beforeRecord = undefined }
    }
    await reader.verifyUnchanged()
    context.signal.throwIfAborted()
    const nextCursor = turnIndex >= 0 ? Buffer.from(JSON.stringify({ version: 2, providerId: context.source.providerId,
      nativeSessionId: context.source.nativeSessionId, identity, rootBlobId, turnCut: turns.length,
      beforeTurn: turnIndex, beforeRecord: beforeRecord ?? -1 })).toString('base64url') : null
    const page = { source: context.source, items, nextCursor }
    if (Buffer.byteLength(JSON.stringify(page)) > SESSION_HISTORY_MAX_PAGE_BYTES) return invalid('Cursor native history page exceeds its materialized byte limit.', 'TOO_LARGE')
    return page
  } finally {
    await reader.close()
  }
}
