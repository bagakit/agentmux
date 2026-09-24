import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import { resolveHermesHome } from './hermes.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

type HermesCursor = {
  version: 1
  providerId: 'hermes'
  nativeSessionId: string
  path: string
  dev: number
  ino: number
  beforeId: number
  anchorTimestamp: number
  anchorDigest: string
  sessionStartedAt: number
}

function computeAnchorDigest(
  role: string,
  timestamp: number | null,
  contentBlob: unknown,
  reasoningBlob?: unknown,
  reasoningContentBlob?: unknown,
  reasoningDetailsBlob?: unknown,
  toolCallsBlob?: unknown,
  finishReasonBlob?: unknown
): string {
  const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : 0
  const h = createHash('sha256').update(`${role}:${ts}:`)
  for (const b of [contentBlob, reasoningBlob, reasoningContentBlob, reasoningDetailsBlob, toolCallsBlob, finishReasonBlob]) {
    if (b instanceof Uint8Array || Buffer.isBuffer(b)) {
      h.update(b)
    }
    h.update(':')
  }
  return h.digest('hex').slice(0, 16)
}

function decodeCursor(cursorText: string): HermesCursor {
  try {
    const raw = JSON.parse(Buffer.from(cursorText, 'base64url').toString('utf8')) as HermesCursor
    if (
      !raw ||
      raw.version !== 1 ||
      raw.providerId !== 'hermes' ||
      typeof raw.nativeSessionId !== 'string' ||
      typeof raw.path !== 'string' ||
      !Number.isSafeInteger(raw.dev) ||
      !Number.isSafeInteger(raw.ino) ||
      !Number.isSafeInteger(raw.beforeId) ||
      raw.beforeId <= 0 ||
      typeof raw.anchorTimestamp !== 'number' ||
      !Number.isFinite(raw.anchorTimestamp) ||
      typeof raw.anchorDigest !== 'string' ||
      !raw.anchorDigest ||
      typeof raw.sessionStartedAt !== 'number' ||
      !Number.isFinite(raw.sessionStartedAt)
    ) {
      throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
    }
    return raw
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    throw new AgentMuxError('Native history cursor is invalid; reopen the newest page.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')
  }
}

function encodeCursor(cursor: HermesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

async function resolveRequiredWorkspacePath(inputPath: string, contextDescription: string): Promise<string> {
  const resolved = resolve(inputPath)
  try {
    return await realpath(resolved)
  } catch {
    const code = contextDescription === 'Workspace path'
      ? 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
      : 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    throw new AgentMuxError(`${contextDescription} is not accessible: ${inputPath}`, code)
  }
}

function decodeRawString(blob: unknown): string | null {
  if (blob instanceof Uint8Array || Buffer.isBuffer(blob)) {
    return Buffer.from(blob).toString('utf8')
  }
  return null
}

function decodeContentParts(rawContent: unknown): AgentSessionHistoryContentPart[] {
  if (typeof rawContent !== 'string') {
    return []
  }

  // Hermes encodes multimodal content lists / dicts using sentinel prefix \x00json:
  if (rawContent.startsWith('\x00json:')) {
    try {
      const parsed = JSON.parse(rawContent.slice(6)) as unknown
      if (Array.isArray(parsed)) {
        const parts: AgentSessionHistoryContentPart[] = []
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            const block = item as Record<string, unknown>
            if (block.type === 'text' && typeof block.text === 'string') {
              parts.push({ kind: 'text', text: block.text })
              continue
            }
            if (block.type === 'image_url' && block.image_url && typeof block.image_url === 'object') {
              const url = (block.image_url as Record<string, unknown>).url
              if (typeof url === 'string' && url) {
                parts.push({ kind: 'resource', resourceType: 'image', reference: url })
                continue
              }
            }
            if ((block.type === 'image' || block.type === 'input_image') && typeof block.data === 'string') {
              parts.push({ kind: 'resource', resourceType: 'image', reference: block.data })
              continue
            }
            if (block.type === 'file' && typeof block.path === 'string') {
              parts.push({
                kind: 'resource',
                resourceType: 'file',
                reference: block.path,
                ...(typeof block.name === 'string' ? { label: block.name } : {})
              })
              continue
            }
          }
          parts.push({ kind: 'text', text: typeof item === 'string' ? item : JSON.stringify(item) })
        }
        return parts
      } else if (parsed && typeof parsed === 'object') {
        const block = parsed as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') {
          return [{ kind: 'text', text: block.text }]
        }
        if (block.type === 'image_url' && block.image_url && typeof block.image_url === 'object') {
          const url = (block.image_url as Record<string, unknown>).url
          if (typeof url === 'string' && url) {
            return [{ kind: 'resource', resourceType: 'image', reference: url }]
          }
        }
        if ((block.type === 'image' || block.type === 'input_image') && typeof block.data === 'string') {
          return [{ kind: 'resource', resourceType: 'image', reference: block.data }]
        }
        if (block.type === 'file' && typeof block.path === 'string') {
          return [{
            kind: 'resource',
            resourceType: 'file',
            reference: block.path,
            ...(typeof block.name === 'string' ? { label: block.name } : {})
          }]
        }
        return [{ kind: 'text', text: JSON.stringify(parsed) }]
      }
    } catch {
      // Malformed json sentinel fallback
    }
  }

  return [{ kind: 'text', text: rawContent }]
}

function extractReasoning(row: {
  reasoning_blob: unknown
  reasoning_content_blob: unknown
  reasoning_details_blob: unknown
}): string | undefined {
  const reasoning = decodeRawString(row.reasoning_blob)
  if (reasoning && reasoning.trim()) {
    if (reasoning.startsWith('{')) {
      try {
        const obj = JSON.parse(reasoning) as Record<string, unknown>
        if (typeof obj?.summary === 'string' && obj.summary.trim()) return obj.summary.trim()
      } catch {}
    }
    return reasoning.trim()
  }

  const reasoningContent = decodeRawString(row.reasoning_content_blob)
  if (reasoningContent && reasoningContent.trim()) {
    return reasoningContent.trim()
  }

  const detailsRaw = decodeRawString(row.reasoning_details_blob)
  if (detailsRaw && detailsRaw.trim()) {
    try {
      const parsed = JSON.parse(detailsRaw) as unknown
      if (Array.isArray(parsed)) {
        const summaries: string[] = []
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            const block = item as Record<string, unknown>
            const s = block.summary ?? block.thinking ?? block.text
            if (typeof s === 'string' && s.trim()) summaries.push(s.trim())
          }
        }
        if (summaries.length > 0) return summaries.join('\n\n')
      } else if (parsed && typeof parsed === 'object') {
        const block = parsed as Record<string, unknown>
        const s = block.summary ?? block.text
        if (typeof s === 'string' && s.trim()) return s.trim()
      }
    } catch {}
  }

  return undefined
}

function parseToolCalls(rawToolCalls: unknown): Array<{ name: string; input: string; callId?: string }> {
  if (typeof rawToolCalls !== 'string' || !rawToolCalls.trim()) return []
  try {
    const parsed = JSON.parse(rawToolCalls) as unknown
    if (!Array.isArray(parsed)) return []
    const results: Array<{ name: string; input: string; callId?: string }> = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const call = item as Record<string, unknown>
      const func = call.function && typeof call.function === 'object' ? (call.function as Record<string, unknown>) : undefined
      const name = typeof func?.name === 'string' && func.name
        ? func.name
        : (typeof call.name === 'string' && call.name ? call.name : undefined)
      if (!name) continue
      const rawArgs = func ? func.arguments : call.arguments
      const input = typeof rawArgs === 'string'
        ? rawArgs
        : (rawArgs !== undefined && rawArgs !== null ? JSON.stringify(rawArgs) : '')
      const callId = typeof call.id === 'string' && call.id ? call.id : undefined
      results.push({ name, input, ...(callId ? { callId } : {}) })
    }
    return results
  } catch {
    return []
  }
}

type MessageRow = {
  id: number
  role: string
  content_blob: unknown
  reasoning_blob: unknown
  reasoning_content_blob: unknown
  reasoning_details_blob: unknown
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  finish_reason: string | null
  timestamp: number | null
}

function convertMessageRow(row: MessageRow): AgentSessionHistoryItem {
  const timestampMs = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) && row.timestamp > 0
    ? Math.round(row.timestamp * 1000)
    : undefined
  const timeFields = timestampMs !== undefined ? { startedAt: timestampMs } : {}
  const rawContent = decodeRawString(row.content_blob)
  const decodedParts = decodeContentParts(rawContent)

  if (row.role === 'user') {
    const parts = decodedParts.length > 0 ? [...decodedParts] : [{ kind: 'text' as const, text: '' }]
    return {
      id: `hermes-msg-${row.id}`,
      kind: 'user-message',
      contentParts: parts,
      ...timeFields
    }
  }

  if (row.role === 'assistant') {
    const parts: AgentSessionHistoryContentPart[] = []

    const reasoningText = extractReasoning(row)
    if (reasoningText) {
      parts.push({ kind: 'reasoning', text: reasoningText })
    }

    const toolCalls = parseToolCalls(row.tool_calls)
    for (const call of toolCalls) {
      parts.push({
        kind: 'tool-call',
        name: call.name,
        input: call.input,
        ...(call.callId ? { callId: call.callId } : {})
      })
    }

    for (const p of decodedParts) {
      parts.push(p)
    }

    if (row.finish_reason && row.finish_reason !== 'stop' && row.finish_reason !== 'tool_calls') {
      parts.push({ kind: 'text', text: `[${row.finish_reason}]` })
    }

    const hasTextOrResource = decodedParts.some(p => (p.kind === 'text' && p.text.length > 0) || p.kind === 'resource')
    const kind: AgentSessionHistoryItem['kind'] = hasTextOrResource ? 'assistant-message' : 'activity'
    if (parts.length === 0) {
      parts.push({ kind: 'text', text: '' })
    }

    return {
      id: `hermes-msg-${row.id}`,
      kind,
      contentParts: parts,
      ...(kind === 'activity' ? { title: 'Hermes activity' } : {}),
      ...timeFields
    }
  }

  if (row.role === 'tool') {
    const name = typeof row.tool_name === 'string' && row.tool_name ? row.tool_name : undefined
    const callId = typeof row.tool_call_id === 'string' && row.tool_call_id ? row.tool_call_id : undefined
    const parts: AgentSessionHistoryContentPart[] = []
    let emittedToolResult = false

    for (const p of decodedParts) {
      if (p.kind === 'text' && !emittedToolResult) {
        parts.push({
          kind: 'tool-result',
          output: p.text,
          ...(name ? { name } : {}),
          ...(callId ? { callId } : {})
        })
        emittedToolResult = true
      } else {
        parts.push(p)
      }
    }

    if (!emittedToolResult) {
      parts.unshift({
        kind: 'tool-result',
        output: '',
        ...(name ? { name } : {}),
        ...(callId ? { callId } : {})
      })
    }

    return {
      id: `hermes-msg-${row.id}`,
      kind: 'activity',
      title: name ? `Tool: ${name}` : 'Tool result',
      contentParts: parts,
      ...timeFields
    }
  }

  const parts = decodedParts.length > 0 ? [...decodedParts] : [{ kind: 'text' as const, text: '' }]

  return {
    id: `hermes-msg-${row.id}`,
    kind: 'activity',
    title: typeof row.role === 'string' && row.role ? `Hermes ${row.role}` : 'Hermes activity',
    contentParts: parts,
    ...timeFields
  }
}

/**
 * Reads bounded chronological history pages directly from Hermes canonical SQLite state.db.
 */
export async function readHermesSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  context.signal.throwIfAborted()

  // 1. Resolve canonical database path
  const dbPath = context.transcriptPath && isAbsolute(context.transcriptPath)
    ? resolve(context.transcriptPath)
    : join(resolveHermesHome(context.env), 'state.db')

  // 2. Stat database file to verify physical existence and inode identity
  let fileStat
  try {
    fileStat = await stat(dbPath)
  } catch {
    throw new AgentMuxError(`Hermes state database not found: ${dbPath}`, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
  }

  if (!fileStat.isFile()) {
    throw new AgentMuxError('Hermes state database is not a regular file.', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT')
  }

  // 3. Verify cursor if provided
  let cursor: HermesCursor | undefined
  if (context.cursor !== undefined) {
    cursor = decodeCursor(context.cursor)
    if (
      cursor.path !== dbPath ||
      cursor.providerId !== context.source.providerId ||
      cursor.nativeSessionId !== context.source.nativeSessionId
    ) {
      throw new AgentMuxError('Native history cursor belongs to another source.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    if (cursor.dev !== fileStat.dev || cursor.ino !== fileStat.ino) {
      throw new AgentMuxError('Hermes database was replaced; reopen its newest page.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
  }

  context.signal.throwIfAborted()

  // 4. Open read-only SQLite database connection in consistent read transaction
  const { DatabaseSync } = await import('node:sqlite')
  context.signal.throwIfAborted()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    context.signal.throwIfAborted()
    db.exec('PRAGMA query_only = ON;')
    db.exec('BEGIN;')

    try {
      const colRows = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      const columns = new Set(colRows.map((r) => r.name))
      const hasReasoningDetails = columns.has('reasoning_details')
      const reasoningDetailsExpr = hasReasoningDetails ? 'COALESCE(LENGTH(CAST(reasoning_details AS BLOB)), 0)' : '0'
      const reasoningDetailsCol = hasReasoningDetails ? 'CAST(reasoning_details AS BLOB) AS reasoning_details_blob' : 'NULL AS reasoning_details_blob'

      // 5. Verify exact session existence and workspace match (symlink-aware, no blanket fallback)
      const sessionRow = db
        .prepare('SELECT id, cwd, started_at, model FROM sessions WHERE id = ?')
        .get(context.source.nativeSessionId) as { id: string; cwd: string | null; started_at: number; model: string | null } | undefined

      if (!sessionRow) {
        throw new AgentMuxError(
          `Hermes state database has no session matching nativeSessionId: ${context.source.nativeSessionId}`,
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      const expectedCwd = await resolveRequiredWorkspacePath(context.workspacePath, 'Workspace path')
      if (sessionRow.cwd) {
        const actualCwd = await resolveRequiredWorkspacePath(sessionRow.cwd, 'Hermes session cwd')
        if (expectedCwd !== actualCwd) {
          throw new AgentMuxError(
            `Hermes native session workspace mismatch: session in ${sessionRow.cwd}, requested in ${context.workspacePath}`,
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }
      }

      context.signal.throwIfAborted()

      // Discover authoritative compression continuation chain starting from context.source.nativeSessionId
      const lineageSessionIds: string[] = [context.source.nativeSessionId]
      let currentSessionId = context.source.nativeSessionId
      const visited = new Set<string>([currentSessionId])

      const continuationStmt = db.prepare(`
        SELECT child.id, child.cwd
        FROM sessions parent
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE parent.id = ?
          AND parent.end_reason = 'compression'
          AND json_extract(COALESCE(child.model_config, '{}'), '$._branched_from') IS NULL
          AND json_extract(COALESCE(child.model_config, '{}'), '$._delegate_from') IS NULL
          AND COALESCE(child.source, '') != 'tool'
        LIMIT 2
      `)

      for (let depth = 0; depth <= 100; depth++) {
        context.signal.throwIfAborted()
        const children = continuationStmt.all(currentSessionId) as Array<{
          id: unknown
          cwd: string | null
        }>

        if (children.length === 0) {
          break
        }

        if (children.length > 1) {
          throw new AgentMuxError(
            'Hermes compression continuation is ambiguous: multiple eligible continuation children found.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        const child = children[0]!

        if (typeof child.id !== 'string' || !child.id.trim()) {
          throw new AgentMuxError('Hermes continuation session ID is malformed.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }

        if (visited.has(child.id)) {
          throw new AgentMuxError('Hermes continuation session cycle detected.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
        }

        if (child.cwd) {
          const actualChildCwd = await resolveRequiredWorkspacePath(child.cwd, 'Hermes continuation session cwd')
          if (expectedCwd !== actualChildCwd) {
            throw new AgentMuxError(
              `Hermes native session workspace mismatch: session in ${child.cwd}, requested in ${context.workspacePath}`,
              'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
            )
          }
        }

        if (depth === 100) {
          throw new AgentMuxError(
            'Hermes compression continuation chain exceeds maximum depth budget.',
            'AGENT_SESSION_HISTORY_TOO_LARGE'
          )
        }

        visited.add(child.id)
        lineageSessionIds.push(child.id)
        currentSessionId = child.id
      }

      const lineagePlaceholders = lineageSessionIds.map(() => '?').join(', ')

      context.signal.throwIfAborted()

      // 6. Verify native session snapshot and cursor anchor integrity
      let consumedAnchorBytes = 0
      if (cursor !== undefined) {
        if (sessionRow.started_at !== cursor.sessionStartedAt) {
          throw new AgentMuxError(
            'Hermes native session snapshot was mutated; reopen its newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        // Query anchor metadata and native byte length BEFORE allocating any BLOB
        const anchorMeta = db
          .prepare(`SELECT id, role, timestamp, active,
                           (COALESCE(LENGTH(CAST(content AS BLOB)), 0) +
                            COALESCE(LENGTH(CAST(reasoning AS BLOB)), 0) +
                            COALESCE(LENGTH(CAST(reasoning_content AS BLOB)), 0) +
                            ${reasoningDetailsExpr} +
                            COALESCE(LENGTH(CAST(tool_calls AS BLOB)), 0) +
                            COALESCE(LENGTH(CAST(tool_name AS BLOB)), 0) +
                            COALESCE(LENGTH(CAST(tool_call_id AS BLOB)), 0) +
                            COALESCE(LENGTH(CAST(finish_reason AS BLOB)), 0)) AS anchor_bytes
                    FROM messages WHERE id = ? AND session_id IN (${lineagePlaceholders})`)
          .get(cursor.beforeId, ...lineageSessionIds) as {
            id: number
            role: string
            timestamp: number
            active: number
            anchor_bytes: number
          } | undefined

        if (!anchorMeta) {
          throw new AgentMuxError(
            'Native history cursor anchor was deleted; reopen the newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        if (anchorMeta.active !== 1) {
          throw new AgentMuxError(
            'Native history cursor anchor was rewound or deactivated; reopen the newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        if (Math.round(anchorMeta.timestamp * 1000) !== Math.round(cursor.anchorTimestamp * 1000)) {
          throw new AgentMuxError(
            'Native history cursor anchor timestamp was modified; reopen the newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        if (anchorMeta.anchor_bytes > SESSION_HISTORY_MAX_PAGE_BYTES) {
          throw new AgentMuxError('Native history cursor anchor exceeds byte budget.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
        }

        context.signal.throwIfAborted()

        // Fetch anchor payload to verify content integrity
        const anchorPayload = db
          .prepare(`SELECT id, role, timestamp, active,
                           CAST(content AS BLOB) AS content_blob,
                           CAST(reasoning AS BLOB) AS reasoning_blob,
                           CAST(reasoning_content AS BLOB) AS reasoning_content_blob,
                           ${reasoningDetailsCol},
                           CAST(tool_calls AS BLOB) AS tool_calls_blob,
                           CAST(finish_reason AS BLOB) AS finish_reason_blob
                    FROM messages WHERE id = ? AND session_id IN (${lineagePlaceholders})`)
          .get(cursor.beforeId, ...lineageSessionIds) as {
            id: number
            role: string
            timestamp: number
            active: number
            content_blob: unknown
            reasoning_blob: unknown
            reasoning_content_blob: unknown
            reasoning_details_blob: unknown
            tool_calls_blob: unknown
            finish_reason_blob: unknown
          } | undefined

        if (!anchorPayload) {
          throw new AgentMuxError(
            'Native history cursor anchor was deleted; reopen the newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        const actualDigest = computeAnchorDigest(
          anchorPayload.role,
          anchorPayload.timestamp,
          anchorPayload.content_blob,
          anchorPayload.reasoning_blob,
          anchorPayload.reasoning_content_blob,
          anchorPayload.reasoning_details_blob,
          anchorPayload.tool_calls_blob,
          anchorPayload.finish_reason_blob
        )

        if (actualDigest !== cursor.anchorDigest) {
          throw new AgentMuxError(
            'Native history cursor anchor content was modified; reopen the newest page.',
            'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
          )
        }

        consumedAnchorBytes = anchorMeta.anchor_bytes
      }

      context.signal.throwIfAborted()

      // 7. Bounded candidate discovery: measure actual BLOB byte lengths for every variable payload
      // Anchor and selected page share ONE 4 MiB budget
      const remainingBudget = SESSION_HISTORY_MAX_PAGE_BYTES - consumedAnchorBytes
      const beforeId = cursor?.beforeId
      const candQuery = beforeId !== undefined
        ? `SELECT id, role, timestamp,
             (COALESCE(LENGTH(CAST(content AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(tool_calls AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(reasoning AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(reasoning_content AS BLOB)), 0) +
              ${reasoningDetailsExpr} +
              COALESCE(LENGTH(CAST(tool_name AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(tool_call_id AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(finish_reason AS BLOB)), 0) + 256) AS estimated_bytes
           FROM messages
           WHERE session_id IN (${lineagePlaceholders}) AND active = 1 AND id < ?
           ORDER BY id DESC
           LIMIT ?`
        : `SELECT id, role, timestamp,
             (COALESCE(LENGTH(CAST(content AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(tool_calls AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(reasoning AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(reasoning_content AS BLOB)), 0) +
              ${reasoningDetailsExpr} +
              COALESCE(LENGTH(CAST(tool_name AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(tool_call_id AS BLOB)), 0) +
              COALESCE(LENGTH(CAST(finish_reason AS BLOB)), 0) + 256) AS estimated_bytes
           FROM messages
           WHERE session_id IN (${lineagePlaceholders}) AND active = 1
           ORDER BY id DESC
           LIMIT ?`

      const candParams = beforeId !== undefined
        ? [...lineageSessionIds, beforeId, context.limit]
        : [...lineageSessionIds, context.limit]

      const candidates = db.prepare(candQuery).all(...candParams) as Array<{
        id: number
        role: string
        timestamp: number
        estimated_bytes: number
      }>

      context.signal.throwIfAborted()

      let accumulatedBytes = 0
      const selectedCandidateIds: number[] = []

      for (const cand of candidates) {
        context.signal.throwIfAborted()
        const estBytes = cand.estimated_bytes || 0
        if (estBytes > remainingBudget) {
          if (selectedCandidateIds.length === 0) {
            throw new AgentMuxError('Native history page exceeds its byte budget.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
          }
          break
        }
        if (accumulatedBytes + estBytes > remainingBudget) {
          break
        }
        accumulatedBytes += estBytes
        selectedCandidateIds.push(cand.id)
      }

      let rows: MessageRow[] = []
      if (selectedCandidateIds.length > 0) {
        const minId = selectedCandidateIds[selectedCandidateIds.length - 1]!
        const maxId = selectedCandidateIds[0]!
        // Select ONLY content_blob without redundant duplicate content text column allocation
        const payloadQuery = `
          SELECT id, role, timestamp, finish_reason,
                 CAST(content AS BLOB) AS content_blob,
                 CAST(reasoning AS BLOB) AS reasoning_blob,
                 CAST(reasoning_content AS BLOB) AS reasoning_content_blob,
                 ${reasoningDetailsCol},
                 tool_call_id, tool_calls, tool_name
          FROM messages
          WHERE session_id IN (${lineagePlaceholders}) AND active = 1 AND id >= ? AND id <= ?
          ORDER BY id DESC
        `
        rows = db.prepare(payloadQuery).all(...lineageSessionIds, minId, maxId) as MessageRow[]
      }

      context.signal.throwIfAborted()

      // 8. Calculate next cursor bound to the oldest returned row and its anchor digest
      let nextCursor: string | null = null
      if (rows.length > 0) {
        const oldestRow = rows[rows.length - 1]!
        const olderRow = db
          .prepare(`SELECT id FROM messages WHERE session_id IN (${lineagePlaceholders}) AND active = 1 AND id < ? ORDER BY id DESC LIMIT 1`)
          .get(...lineageSessionIds, oldestRow.id) as { id: number } | undefined

        if (olderRow) {
          const anchorDigest = computeAnchorDigest(
            oldestRow.role,
            oldestRow.timestamp,
            oldestRow.content_blob,
            oldestRow.reasoning_blob,
            oldestRow.reasoning_content_blob,
            oldestRow.reasoning_details_blob,
            oldestRow.tool_calls ? Buffer.from(oldestRow.tool_calls) : null,
            oldestRow.finish_reason ? Buffer.from(oldestRow.finish_reason) : null
          )
          nextCursor = encodeCursor({
            version: 1,
            providerId: 'hermes',
            nativeSessionId: context.source.nativeSessionId,
            path: dbPath,
            dev: fileStat.dev,
            ino: fileStat.ino,
            beforeId: oldestRow.id,
            anchorTimestamp: typeof oldestRow.timestamp === 'number' ? oldestRow.timestamp : 0,
            anchorDigest,
            sessionStartedAt: sessionRow.started_at
          })
        }
      }

      // 9. Convert rows to AgentSessionHistoryItem and reverse for chronological order
      const items = rows.map(convertMessageRow).reverse()

      db.exec('COMMIT;')

      return {
        source: { ...context.source },
        items,
        nextCursor
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback failure on read-only rollback
      }
      throw err
    }
  } finally {
    db.close()
  }
}
