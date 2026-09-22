import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../session-history.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

export const MAX_PARTS_PER_MESSAGE = 512

function resolveOpenCodeDatabasePath(context: AgentProviderSessionHistoryContext): string {
  if (context.transcriptPath && context.transcriptPath.trim().length > 0) {
    return resolve(context.transcriptPath.trim())
  }
  const xdgData = context.env.XDG_DATA_HOME?.trim() || process.env.XDG_DATA_HOME?.trim()
  const dataDir = xdgData
    ? join(resolve(xdgData), 'opencode')
    : join(homedir(), '.local', 'share', 'opencode')

  const rawDb = context.env.OPENCODE_DB?.trim() || process.env.OPENCODE_DB?.trim()
  if (rawDb) {
    if (rawDb === ':memory:') {
      throw new AgentMuxError(
        'In-memory OpenCode database does not persist history.',
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
      )
    }
    return isAbsolute(rawDb) ? resolve(rawDb) : join(dataDir, rawDb)
  }

  return join(dataDir, 'opencode.db')
}

function workspacesMatch(dirA: string, dirB: string): boolean {
  if (dirA === dirB) return true
  try {
    const statA = statSync(dirA)
    const statB = statSync(dirB)
    return statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

function computeAnchorDigest(timeCreated: number, dataBlob: Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(String(timeCreated) + ':')
  hash.update(dataBlob)
  return hash.digest('hex').slice(0, 16)
}

export async function readOpenCodeSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  context.signal.throwIfAborted()

  const dbPath = resolveOpenCodeDatabasePath(context)
  if (!existsSync(dbPath)) {
    throw new AgentMuxError(
      `OpenCode database file not found at ${dbPath}.`,
      'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
    )
  }

  const stat = statSync(dbPath)
  if (!stat.isFile()) {
    throw new AgentMuxError(
      `OpenCode database path is not a regular file: ${dbPath}.`,
      'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
    )
  }
  const physicalDbToken = `${stat.dev.toString(16)}_${stat.ino.toString(16)}`

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON;')
    db.exec('PRAGMA busy_timeout = 2000;')
    db.exec('BEGIN DEFERRED;')

    const requiredTables = ['session', 'message', 'part']
    for (const table of requiredTables) {
      const exists = Boolean(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
      )
      if (!exists) {
        throw new AgentMuxError(
          `OpenCode database lacks required ${table} table.`,
          'AGENT_SESSION_HISTORY_UNSUPPORTED'
        )
      }
    }

    context.signal.throwIfAborted()

    const sessionRow = db
      .prepare('SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?')
      .get(context.source.nativeSessionId) as
      | { id: string; directory: string; title: string; time_created: number; time_updated: number }
      | undefined

    if (!sessionRow) {
      throw new AgentMuxError(
        `OpenCode session not found in database: ${context.source.nativeSessionId}`,
        'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE'
      )
    }

    if (!workspacesMatch(sessionRow.directory, context.workspacePath)) {
      throw new AgentMuxError(
        `OpenCode session belongs to another workspace: ${sessionRow.directory} !== ${context.workspacePath}`,
        'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      )
    }

    context.signal.throwIfAborted()

    let accumulatedInvocationBytes = 0
    let cursorFilter = ''
    const cursorParams: (number | string)[] = []

    if (context.cursor) {
      const match = /^before:([^:]+):(\d+):(\d+):([0-9a-f]+):(.+)$/.exec(context.cursor)
      if (!match) {
        throw new AgentMuxError('Invalid pagination cursor.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
      }
      const [, cursorDbToken, cursorEpochStr, cursorAnchorTimeStr, cursorAnchorDigest, cursorAnchorId] = match
      if (cursorDbToken !== physicalDbToken) {
        throw new AgentMuxError(
          'Native history source changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      if (Number(cursorEpochStr) !== sessionRow.time_created) {
        throw new AgentMuxError(
          'Native history source changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      const cursorAnchorTime = Number(cursorAnchorTimeStr)

      // Check SQLite LENGTH(CAST(data AS BLOB)) metadata BEFORE retrieving anchor payload
      const anchorMeta = db
        .prepare('SELECT time_created, LENGTH(CAST(data AS BLOB)) AS data_bytes FROM message WHERE id = ? AND session_id = ?')
        .get(cursorAnchorId!, context.source.nativeSessionId) as
        | { time_created: number; data_bytes: number }
        | undefined

      if (!anchorMeta || anchorMeta.time_created !== cursorAnchorTime) {
        throw new AgentMuxError(
          'Native history source changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      accumulatedInvocationBytes += anchorMeta.data_bytes
      if (accumulatedInvocationBytes > SESSION_HISTORY_MAX_PAGE_BYTES) {
        throw new AgentMuxError(
          'Native history page exceeds its byte budget.',
          'AGENT_SESSION_HISTORY_TOO_LARGE'
        )
      }

      // Retrieve anchor payload only after byte length verification
      const anchorRow = db
        .prepare('SELECT CAST(data AS BLOB) AS data_blob FROM message WHERE id = ? AND session_id = ?')
        .get(cursorAnchorId!, context.source.nativeSessionId) as
        | { data_blob: Uint8Array }
        | undefined

      if (!anchorRow) {
        throw new AgentMuxError(
          'Native history source changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      const actualAnchorDigest = computeAnchorDigest(anchorMeta.time_created, anchorRow.data_blob)
      if (actualAnchorDigest !== cursorAnchorDigest) {
        throw new AgentMuxError(
          'Native history source changed while reading; reopen its newest page.',
          'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
        )
      }

      cursorFilter = 'AND (time_created < ? OR (time_created = ? AND id < ?))'
      cursorParams.push(cursorAnchorTime, cursorAnchorTime, cursorAnchorId!)
    }

    const limit = Math.max(1, context.limit)

    // Discover message metadata and byte length without querying the complete data text into JS memory
    const messageMetaQuery = `
      SELECT id, session_id, time_created, time_updated, LENGTH(CAST(data AS BLOB)) AS data_bytes
      FROM message
      WHERE session_id = ? ${cursorFilter}
      ORDER BY time_created DESC, id DESC
      LIMIT ?
    `

    const rawMessageMeta = db
      .prepare(messageMetaQuery)
      .all(context.source.nativeSessionId, ...cursorParams, limit + 1) as Array<{
      id: string
      session_id: string
      time_created: number
      time_updated: number
      data_bytes: number
    }>

    const hasMore = rawMessageMeta.length > limit
    const pageMessageMeta = hasMore ? rawMessageMeta.slice(0, limit) : rawMessageMeta

    const partMetaStmt = db.prepare(`
      SELECT id, message_id, session_id, time_created, time_updated, LENGTH(CAST(data AS BLOB)) AS data_bytes
      FROM part
      WHERE message_id = ? AND session_id = ?
      ORDER BY time_created ASC, id ASC
      LIMIT ?
    `)

    // Bounded discovery check BEFORE allocating any full data payload
    for (const msgMeta of pageMessageMeta) {
      context.signal.throwIfAborted()

      accumulatedInvocationBytes += msgMeta.data_bytes
      if (accumulatedInvocationBytes > SESSION_HISTORY_MAX_PAGE_BYTES) {
        throw new AgentMuxError(
          'Native history page exceeds its byte budget.',
          'AGENT_SESSION_HISTORY_TOO_LARGE'
        )
      }

      const partRows = partMetaStmt.all(
        msgMeta.id,
        context.source.nativeSessionId,
        MAX_PARTS_PER_MESSAGE + 1
      ) as Array<{
        id: string
        message_id: string
        session_id: string
        time_created: number
        time_updated: number
        data_bytes: number
      }>

      context.signal.throwIfAborted()

      if (partRows.length > MAX_PARTS_PER_MESSAGE) {
        throw new AgentMuxError(
          'Native history message exceeds allowed part count.',
          'AGENT_SESSION_HISTORY_TOO_LARGE'
        )
      }

      for (const p of partRows) {
        accumulatedInvocationBytes += p.data_bytes
        if (accumulatedInvocationBytes > SESSION_HISTORY_MAX_PAGE_BYTES) {
          throw new AgentMuxError(
            'Native history page exceeds its byte budget.',
            'AGENT_SESSION_HISTORY_TOO_LARGE'
          )
        }
      }
    }

    context.signal.throwIfAborted()

    const oldestInPage = hasMore && pageMessageMeta.length > 0 ? pageMessageMeta[pageMessageMeta.length - 1]! : null
    let oldestInPageData: string | null = null

    // Now fetch selected bounded payloads
    const msgDataStmt = db.prepare('SELECT data FROM message WHERE id = ? AND session_id = ?')
    const partDataStmt = db.prepare('SELECT id, data FROM part WHERE message_id = ? AND session_id = ? ORDER BY time_created ASC, id ASC')

    const reversedItems: AgentSessionHistoryItem[] = []

    for (const msgMeta of pageMessageMeta) {
      context.signal.throwIfAborted()

      const msgDataRow = msgDataStmt.get(msgMeta.id, context.source.nativeSessionId) as
        | { data: string }
        | undefined

      context.signal.throwIfAborted()

      if (!msgDataRow) {
        throw new AgentMuxError('Message payload missing during read.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
      }

      if (oldestInPage && msgMeta.id === oldestInPage.id) {
        oldestInPageData = msgDataRow.data
      }

      let messageData: Record<string, unknown>
      try {
        messageData = JSON.parse(msgDataRow.data) as Record<string, unknown>
      } catch {
        throw new AgentMuxError('Malformed JSON message payload.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
      }

      const role = messageData.role
      const partDataRows = partDataStmt.all(msgMeta.id, context.source.nativeSessionId) as Array<{
        id: string
        data: string
      }>

      context.signal.throwIfAborted()

      const contentParts: AgentSessionHistoryContentPart[] = []
      let hasGenuineHumanSpeech = false
      let isCompaction = false

      for (const partRow of partDataRows) {
        context.signal.throwIfAborted()

        let partData: Record<string, unknown>
        try {
          partData = JSON.parse(partRow.data) as Record<string, unknown>
        } catch {
          throw new AgentMuxError('Malformed JSON part payload.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
        }

        const type = partData.type
        if (type === 'text') {
          if (typeof partData.text !== 'string') {
            throw new AgentMuxError('Text part missing text string.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
          }
          contentParts.push({ kind: 'text', text: partData.text })
          if (partData.text.trim().length > 0 && partData.synthetic !== true && partData.ignored !== true) {
            hasGenuineHumanSpeech = true
          }
        } else if (type === 'reasoning') {
          if (typeof partData.text !== 'string') {
            throw new AgentMuxError('Reasoning part missing text string.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
          }
          contentParts.push({ kind: 'reasoning', text: partData.text })
        } else if (type === 'tool') {
          if (
            typeof partData.tool !== 'string' ||
            !partData.tool ||
            typeof partData.callID !== 'string' ||
            !partData.callID
          ) {
            throw new AgentMuxError('Invalid OpenCode tool part structure.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
          }

          const state =
            partData.state && typeof partData.state === 'object'
              ? (partData.state as Record<string, unknown>)
              : null

          const inputVal = state?.input
          const inputStr = typeof inputVal === 'string' ? inputVal : JSON.stringify(inputVal ?? {})

          contentParts.push({
            kind: 'tool-call',
            name: partData.tool,
            input: inputStr,
            callId: partData.callID
          })

          if (state && (state.status === 'completed' || state.status === 'error')) {
            const isFailed = state.status === 'error'
            const rawOutput = isFailed ? (state.error ?? '') : (state.output ?? '')
            const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)

            contentParts.push({
              kind: 'tool-result',
              name: partData.tool,
              output: outputStr,
              callId: partData.callID,
              ...(isFailed ? { failed: true } : {})
            })
          }

          if (state && Array.isArray(state.attachments)) {
            for (const att of state.attachments) {
              if (att && typeof att === 'object' && typeof att.url === 'string' && att.url) {
                const mime = typeof att.mime === 'string' ? att.mime : ''
                const resourceType: 'image' | 'audio' | 'file' | 'other' = mime.startsWith('image/')
                  ? 'image'
                  : mime.startsWith('audio/')
                    ? 'audio'
                    : 'file'

                contentParts.push({
                  kind: 'resource',
                  resourceType,
                  reference: att.url,
                  ...(typeof att.filename === 'string' && att.filename ? { label: att.filename } : {})
                })
              }
            }
          }
        } else if (type === 'file') {
          if (
            typeof partData.url !== 'string' ||
            !partData.url ||
            typeof partData.mime !== 'string' ||
            !partData.mime
          ) {
            throw new AgentMuxError('Invalid OpenCode file part structure.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
          }

          const resourceType: 'image' | 'audio' | 'file' | 'other' = partData.mime.startsWith('image/')
            ? 'image'
            : partData.mime.startsWith('audio/')
              ? 'audio'
              : 'file'

          contentParts.push({
            kind: 'resource',
            resourceType,
            reference: partData.url,
            ...(typeof partData.filename === 'string' && partData.filename ? { label: partData.filename } : {})
          })
        } else if (type === 'compaction') {
          contentParts.push({ kind: 'text', text: 'What did we do so far?' })
          isCompaction = true
        } else {
          contentParts.push({ kind: 'text', text: JSON.stringify(partData) })
        }
      }

      let kind: AgentSessionHistoryItem['kind'] = 'activity'
      if (role === 'user') {
        kind = hasGenuineHumanSpeech ? 'user-message' : 'activity'
      } else if (role === 'assistant') {
        kind = hasGenuineHumanSpeech ? 'assistant-message' : 'activity'
      }

      const title =
        kind === 'activity'
          ? isCompaction || role === 'compaction'
            ? 'OpenCode compaction'
            : typeof messageData.summary === 'object' &&
                messageData.summary &&
                typeof (messageData.summary as Record<string, unknown>).title === 'string'
              ? ((messageData.summary as Record<string, unknown>).title as string)
              : 'OpenCode activity'
          : undefined

      const timeObj =
        messageData.time && typeof messageData.time === 'object'
          ? (messageData.time as Record<string, unknown>)
          : undefined

      const startedAt =
        typeof timeObj?.created === 'number' &&
        Number.isSafeInteger(timeObj.created) &&
        timeObj.created >= 0
          ? timeObj.created
          : typeof msgMeta.time_created === 'number' &&
              Number.isSafeInteger(msgMeta.time_created) &&
              msgMeta.time_created >= 0
            ? msgMeta.time_created
            : undefined

      const completedAt =
        typeof timeObj?.completed === 'number' &&
        Number.isSafeInteger(timeObj.completed) &&
        timeObj.completed >= 0
          ? timeObj.completed
          : undefined

      const item: AgentSessionHistoryItem = {
        id: msgMeta.id,
        turnId: msgMeta.id,
        kind,
        contentParts,
        ...(title ? { title } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {})
      }

      reversedItems.push(item)
    }

    let nextCursor: string | null = null
    if (oldestInPage && oldestInPageData !== null) {
      context.signal.throwIfAborted()
      const anchorDigest = computeAnchorDigest(oldestInPage.time_created, Buffer.from(oldestInPageData, 'utf-8'))
      nextCursor = `before:${physicalDbToken}:${sessionRow.time_created}:${oldestInPage.time_created}:${anchorDigest}:${oldestInPage.id}`
    }

    const items = reversedItems.reverse()
    const pageResult: AgentProviderSessionHistoryPage = {
      source: { ...context.source },
      items,
      nextCursor
    }

    return pageResult
  } finally {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // rollback best-effort
    }
    db.close()
  }
}
