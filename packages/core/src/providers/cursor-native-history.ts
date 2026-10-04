import { Message, proto3, ScalarType } from '@bufbuild/protobuf'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { NativeSqliteHistoryReader, type NativeSqliteHistoryIdentity } from '../native-sqlite-history-reader.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import type {
  AgentProviderSessionHistoryContext,
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
 * Maintained protobuf schema for Cursor native conversation root structure.
 * Field 1: root_prompt_messages_json (repeated bytes, SHA-256 message blob IDs).
 * Field 13: summary_archives (repeated bytes, SHA-256 archive blob IDs).
 */
export class ConversationStateStructure extends Message<ConversationStateStructure> {
  rootPromptMessagesJson: Uint8Array[] = []
  summaryArchives: Uint8Array[] = []

  static readonly runtime: typeof proto3 = proto3
  static readonly typeName = 'ConversationStateStructure'
  static readonly fields = proto3.util.newFieldList(() => [
    { no: 1, name: 'root_prompt_messages_json', kind: 'scalar', T: ScalarType.BYTES, repeated: true },
    { no: 13, name: 'summary_archives', kind: 'scalar', T: ScalarType.BYTES, repeated: true }
  ])

  static fromBinary(bytes: Uint8Array): ConversationStateStructure {
    return new ConversationStateStructure().fromBinary(bytes)
  }
}

/**
 * Maintained protobuf schema for Cursor native summary archive.
 * Field 1: summarized_messages (repeated bytes, SHA-256 message blob IDs).
 */
export class ConversationSummaryArchive extends Message<ConversationSummaryArchive> {
  summarizedMessages: Uint8Array[] = []

  static readonly runtime: typeof proto3 = proto3
  static readonly typeName = 'ConversationSummaryArchive'
  static readonly fields = proto3.util.newFieldList(() => [
    { no: 1, name: 'summarized_messages', kind: 'scalar', T: ScalarType.BYTES, repeated: true }
  ])

  static fromBinary(bytes: Uint8Array): ConversationSummaryArchive {
    return new ConversationSummaryArchive().fromBinary(bytes)
  }
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
  version: 1
  providerId: string
  nativeSessionId: string
  identity: NativeSqliteHistoryIdentity
  rootBlobId: string
  cut: number
  before: number
}

function parseCursor(cursorStr: string, context: AgentProviderSessionHistoryContext): CursorDecoded {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursorStr, 'base64url').toString('utf8'))
  } catch {
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  const c = decoded as Record<string, unknown>
  if (c.version !== 1 || typeof c.providerId !== 'string' || typeof c.nativeSessionId !== 'string' || typeof c.rootBlobId !== 'string' || !c.rootBlobId) {
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  if (c.providerId !== 'cursor' || c.nativeSessionId !== context.source.nativeSessionId) {
    throw new AgentMuxError('Native history cursor belongs to another source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }

  if (typeof c.before !== 'number' || typeof c.cut !== 'number' || !Number.isSafeInteger(c.before) || !Number.isSafeInteger(c.cut)) {
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  const identity = asRecord(c.identity)
  if (!identity || typeof identity.path !== 'string' || typeof identity.dev !== 'string' || typeof identity.ino !== 'string' || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino) || !/^[a-f0-9]{64}$/.test(c.rootBlobId)) {
    throw new AgentMuxError('Native history cursor has an invalid source binding.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  if (c.before < 0 || c.before > c.cut || c.cut < 0) {
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }

  return c as CursorDecoded
}

function convertNativeSqliteRecord(record: Record<string, unknown>, id: string): AgentSessionHistoryItem {
  const parts: AgentSessionHistoryContentPart[] = []
  const role = typeof record.role === 'string' ? record.role : undefined
  const content = record.content
  const isSummary = asRecord(asRecord(record.providerOptions)?.cursor)?.isSummary === true

  let hasGenuineText = false

  if (typeof content === 'string' && content.length > 0) {
    parts.push({ kind: 'text', text: content })
    hasGenuineText = true
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item)
      if (!block) { parts.push({ kind: 'text', text: JSON.stringify(item) }); continue }
      const type = block.type
      if (type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push({ kind: 'text', text: block.text })
        hasGenuineText = true
      } else if (type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push({ kind: 'reasoning', text: block.text })
      } else if (type === 'redacted-reasoning') {
        parts.push({ kind: 'reasoning', text: '[REDACTED]' })
      } else if (type === 'tool-call' || type === 'tool_use') {
        const name = typeof block.name === 'string' && block.name.length > 0
          ? block.name
          : (typeof block.toolName === 'string' && block.toolName.length > 0 ? block.toolName : '')
        if (name) {
          const input = typeof block.input === 'string'
            ? block.input
            : (typeof block.args === 'string' ? block.args : JSON.stringify(block.input ?? block.args ?? {}))
          const callId = typeof block.id === 'string' ? block.id : (typeof block.toolCallId === 'string' ? block.toolCallId : (typeof block.toolUseId === 'string' ? block.toolUseId : undefined))
          parts.push({ kind: 'tool-call', name, input, ...(callId ? { callId } : {}) })
        } else parts.push({ kind: 'text', text: JSON.stringify(block) })
      } else if (type === 'tool-result' || type === 'tool_result') {
        const output = typeof block.output === 'string'
          ? block.output
          : (typeof block.content === 'string' ? block.content : (block.output !== undefined || block.content !== undefined ? JSON.stringify(block.output ?? block.content) : ''))
        const name = typeof block.name === 'string' && block.name.length > 0 ? block.name
          : (typeof block.toolName === 'string' && block.toolName.length > 0 ? block.toolName : undefined)
        const callId = typeof block.callId === 'string' ? block.callId : (typeof block.toolCallId === 'string' ? block.toolCallId : (typeof block.toolUseId === 'string' ? block.toolUseId : undefined))
        const failed = typeof block.failed === 'boolean'
          ? block.failed
          : (typeof block.is_error === 'boolean' ? block.is_error : (block.status === 'error' || block.status === 'failed' ? true : undefined))
        parts.push({ kind: 'tool-result', output, ...(name ? { name } : {}), ...(callId ? { callId } : {}), ...(failed !== undefined ? { failed } : {}) })
      } else if (type === 'image') {
        let reference = ''
        if (typeof block.url === 'string' && block.url) {
          reference = block.url
        } else if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          reference = `data:${block.mimeType};base64,${block.data}`
        } else {
          const source = asRecord(block.source)
          if (source?.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
            reference = `data:${source.media_type};base64,${source.data}`
          } else if (typeof source?.url === 'string' && source.url) {
            reference = source.url
          }
        }
        if (reference) {
          parts.push({ kind: 'resource', resourceType: 'image', reference })
        } else {
          parts.push({ kind: 'text', text: JSON.stringify(block) })
        }
      } else if (type === 'file') {
        const reference = typeof block.filePath === 'string' && block.filePath
          ? block.filePath
          : (typeof block.path === 'string' && block.path
            ? block.path
            : (typeof block.uri === 'string' && block.uri
              ? block.uri
              : (typeof block.url === 'string' && block.url
                ? block.url
                : (typeof block.data === 'string' && block.data
                  ? block.data
                  : (typeof block.filename === 'string' && block.filename ? block.filename : '')))))
        if (reference) {
          parts.push({
            kind: 'resource',
            resourceType: 'file',
            reference,
            ...(typeof block.filename === 'string' && block.filename.length > 0 ? { label: block.filename } : {})
          })
        } else {
          parts.push({ kind: 'text', text: JSON.stringify(block) })
        }
      } else {
        // Unknown block preserved neutrally at its exact native position
        parts.push({ kind: 'text', text: JSON.stringify(block) })
      }
    }
  }

  // Determine kind from genuine native speech before neutral fallback
  let kind: 'user-message' | 'assistant-message' | 'activity' = 'activity'
  if (role === 'user' && !isSummary && (hasGenuineText || parts.length > 0)) {
    kind = 'user-message'
  } else if (role === 'assistant' && parts.length > 0) {
    kind = 'assistant-message'
  } else {
    kind = 'activity'
  }

  if (parts.length === 0) {
    parts.push({ kind: 'text', text: JSON.stringify(record) })
  }

  // Identity is the native record position plus its verified content address;
  // identical bodies at two native positions remain two distinct inputs.
  const itemId = id

  const title = kind === 'activity'
    ? (isSummary ? 'Cursor summary' : role ? `Cursor ${role}` : 'Cursor activity')
    : undefined

  return {
    id: itemId,
    kind,
    contentParts: parts,
    ...(title ? { title } : {})
  }
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

async function readBlob(reader: NativeSqliteHistoryReader, id: string): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/.test(id)) return invalid('Cursor native history has an invalid blob identity.')
  const row = await reader.get('SELECT data FROM blobs WHERE id = ?', [id])
  if (!(row?.[0] instanceof Uint8Array)) return invalid('Cursor native history snapshot no longer contains its referenced blob.', 'SOURCE_CHANGED')
  const bytes = row[0]
  if (createHash('sha256').update(bytes).digest('hex') !== id) return invalid('Cursor native history blob changed under its immutable identity.', 'SOURCE_CHANGED')
  return bytes
}

/** Typed native history only. Supplementary transcript paths are identity locators, never body fallback. */
export async function readCursorSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  context.signal.throwIfAborted()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context.source.nativeSessionId)) {
    return invalid('Cursor native Session identity has not been established.', 'LOCATOR_UNAVAILABLE')
  }
  const path = resolveCursorStorePath(context.workspacePath, context.source.nativeSessionId, context.env)
  if (context.transcriptPath && (!isAbsolute(context.transcriptPath) ||
    (resolve(context.transcriptPath) !== path && resolve(context.transcriptPath) !== resolveCursorTranscriptPath(context.workspacePath, context.source.nativeSessionId, context.env)))) {
    return invalid('Cursor transcript locator belongs to another native Session.', 'SOURCE_CHANGED')
  }
  const cursor = context.cursor === undefined ? undefined : parseCursor(context.cursor, context)
  if (cursor && cursor.identity.path !== path) return invalid('Cursor native history path changed.', 'SOURCE_CHANGED')
  const reader = await NativeSqliteHistoryReader.open(path, context.signal)
  try {
    const identity = reader.identity
    if (cursor && (cursor.identity.dev !== identity.dev || cursor.identity.ino !== identity.ino)) {
      return invalid('Cursor native history database was replaced; reopen its newest page.', 'SOURCE_CHANGED')
    }
    const metadataRow = await reader.get('SELECT value FROM meta WHERE key = ?', ['0'])
    const hex = metadataRow?.[0]
    if (typeof hex !== 'string' || !hex || hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) {
      return invalid('Cursor native Session metadata is missing or invalid.')
    }
    const metadata = decodeJson(Buffer.from(hex, 'hex'))
    if (metadata.agentId !== context.source.nativeSessionId) return invalid('Cursor native metadata belongs to another Session.', 'SOURCE_CHANGED')
    await reader.verifyUnchanged()
    const rootBlobId = cursor?.rootBlobId ?? metadata.latestRootBlobId
    if (typeof rootBlobId !== 'string') return invalid('Cursor native root identity is missing.')
    let root: ConversationStateStructure
    try { root = ConversationStateStructure.fromBinary(await readBlob(reader, rootBlobId)) } catch (error) {
      if (error instanceof AgentMuxError || context.signal.aborted) throw error
      return invalid('Cursor native history root protobuf is invalid.')
    }
    const ids: string[] = []
    for (const archiveId of root.summaryArchives) {
      let archive: ConversationSummaryArchive
      try { archive = ConversationSummaryArchive.fromBinary(await readBlob(reader, Buffer.from(archiveId).toString('hex'))) } catch (error) {
        if (error instanceof AgentMuxError || context.signal.aborted) throw error
        return invalid('Cursor native history archive protobuf is invalid.')
      }
      for (const id of archive.summarizedMessages) ids.push(Buffer.from(id).toString('hex'))
    }
    for (const id of root.rootPromptMessagesJson) ids.push(Buffer.from(id).toString('hex'))
    if (cursor && cursor.cut !== ids.length) return invalid('Cursor pinned native history root changed.', 'SOURCE_CHANGED')
    const cut = cursor?.cut ?? ids.length, before = cursor?.before ?? cut
    const from = Math.max(0, before - context.limit)
    const items: AgentSessionHistoryItem[] = []
    let materializedBytes = Buffer.byteLength(JSON.stringify({ source: context.source, items: [], nextCursor: null }))
    for (let index = from; index < before; index++) {
      const id = ids[index]!
      const item = convertNativeSqliteRecord(decodeJson(await readBlob(reader, id)), `${index}:${id}`)
      materializedBytes += Buffer.byteLength(JSON.stringify(item)) + 1
      if (materializedBytes > SESSION_HISTORY_MAX_PAGE_BYTES) return invalid('Cursor native history page exceeds its materialized byte limit.', 'TOO_LARGE')
      items.push(item)
    }
    await reader.verifyUnchanged()
    context.signal.throwIfAborted()
    const nextCursor = from > 0 ? Buffer.from(JSON.stringify({ version: 1, providerId: context.source.providerId,
      nativeSessionId: context.source.nativeSessionId, identity, rootBlobId, cut, before: from })).toString('base64url') : null
    const page = { source: context.source, items, nextCursor }
    if (Buffer.byteLength(JSON.stringify(page)) > SESSION_HISTORY_MAX_PAGE_BYTES) return invalid('Cursor native history page exceeds its materialized byte limit.', 'TOO_LARGE')
    return page
  } finally {
    await reader.close()
  }
}
