import {
  closeSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import type { AgentMuxDaemonSession } from './daemon-protocol.js'

const JOURNAL_VERSION = 2
const MAX_JOURNAL_BYTES = 1024 * 1024

type SessionJournalDocument = {
  version: typeof JOURNAL_VERSION
  sessions: AgentMuxDaemonSession[]
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseSession(value: unknown): AgentMuxDaemonSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Daemon session journal contains an invalid session.', 'INVALID_DAEMON_JOURNAL')
  }
  const session = value as Record<string, unknown>
  if (
    typeof session.sessionId !== 'string' ||
    typeof session.incarnationId !== 'string' ||
    typeof session.createOperationId !== 'string' ||
    (session.kind !== 'terminal' && session.kind !== 'agent') ||
    (session.agentId !== null && typeof session.agentId !== 'string') ||
    (session.agentSessionId !== null && typeof session.agentSessionId !== 'string') ||
    typeof session.cwd !== 'string' ||
    !isNumber(session.pid) ||
    (session.processStartedAt !== undefined && !isNumber(session.processStartedAt)) ||
    (session.state !== 'running' && session.state !== 'exited' && session.state !== 'lost') ||
    !isNumber(session.cols) ||
    !isNumber(session.rows) ||
    !isNumber(session.createdAt) ||
    !isNumber(session.latestSequence) ||
    !isNumber(session.acceptedInputSequence)
  ) {
    throw new AgentMuxError('Daemon session journal contains an invalid session.', 'INVALID_DAEMON_JOURNAL')
  }
  return session as AgentMuxDaemonSession
}

export function loadAgentMuxDaemonSessionJournal(path: string): AgentMuxDaemonSession[] {
  try {
    if (statSync(path).size > MAX_JOURNAL_BYTES) {
      throw new AgentMuxError('Daemon session journal exceeds its size limit.', 'INVALID_DAEMON_JOURNAL')
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AgentMuxError('Daemon session journal is invalid.', 'INVALID_DAEMON_JOURNAL')
    }
    const document = parsed as Record<string, unknown>
    if (document.version !== JOURNAL_VERSION || !Array.isArray(document.sessions)) {
      throw new AgentMuxError('Daemon session journal version is unsupported.', 'INVALID_DAEMON_JOURNAL')
    }
    return document.sessions.map(parseSession)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (error instanceof AgentMuxError) throw error
    throw new AgentMuxError(
      `Could not read daemon session journal: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_DAEMON_JOURNAL'
    )
  }
}

export function writeAgentMuxDaemonSessionJournal(
  path: string,
  sessions: readonly AgentMuxDaemonSession[]
): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  const document: SessionJournalDocument = {
    version: JOURNAL_VERSION,
    sessions: sessions.map((session) => ({ ...session }))
  }
  const encoded = `${JSON.stringify(document)}\n`
  if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) {
    throw new AgentMuxError('Daemon session journal exceeds its size limit.', 'DAEMON_JOURNAL_LIMIT')
  }
  try {
    writeFileSync(temporaryPath, encoded, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    const file = openSync(temporaryPath, 'r')
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporaryPath, path)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (process.platform !== 'win32') {
    const directoryHandle = openSync(directory, 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  }
}
