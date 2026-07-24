import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as nodePty from 'node-pty'
import {
  loadAgentMuxDaemonSessionJournal,
  writeAgentMuxDaemonSessionJournal
} from './daemon-session-journal.js'
import { AgentMuxError } from './errors.js'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups.js'
import {
  posixProcessIdentityIsAlive,
  recordPosixProcessIdentity
} from './posix-process-identity.js'
import type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonCreateRequest,
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonAppliedSize,
  AgentMuxDaemonInputAck,
  AgentMuxDaemonOutputAck,
  AgentMuxDaemonSession,
  AgentMuxDaemonSessionRef
} from './daemon-protocol.js'

const MAX_REPLAY_BYTES_PER_SESSION = 256 * 1024
const MAX_SESSIONS_PER_DAEMON = 128
const MAX_CREATE_OPERATION_RECEIPTS = 4_096
const STOP_GRACE_MS = 1_500
const STOP_FORCE_MS = 1_500

type ReplayChunk = {
  event: AgentMuxDaemonDataEvent
  bytes: number
}

type SessionRecord = {
  snapshot: AgentMuxDaemonSession
  pty: nodePty.IPty | null
  replay: ReplayChunk[]
  replayBytes: number
  exitPromise: Promise<void> | null
  resolveExit: (() => void) | null
  dataDisposable: nodePty.IDisposable | null
  exitDisposable: nodePty.IDisposable | null
}

type CreateOperationReceipt = {
  sessionId: string
  state: 'active' | 'retired'
}

export type AgentMuxDaemonSessionManagerOptions = {
  journalPath?: string
}

function cloneSession(session: AgentMuxDaemonSession): AgentMuxDaemonSession {
  return { ...session }
}

function safeIdentity(value: string, name: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new AgentMuxError(
      `${name} must contain only letters, numbers, underscore, or dash.`,
      `INVALID_${name.toUpperCase()}`
    )
  }
  return normalized
}

function validateDimensions(cols: number, rows: number): { cols: number; rows: number } {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1_000 || rows > 1_000) {
    throw new AgentMuxError('Terminal dimensions must be integers from 1 to 1000.', 'INVALID_TERMINAL_SIZE')
  }
  return { cols, rows }
}

function processEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]])
    ),
    ...overrides
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AgentMuxDaemonSessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly createOperations = new Map<string, CreateOperationReceipt>()
  private readonly createOperationOrder: string[] = []
  private readonly events = new EventEmitter()

  constructor(private readonly options: AgentMuxDaemonSessionManagerOptions = {}) {
    if (!options.journalPath) return
    const loaded = loadAgentMuxDaemonSessionJournal(options.journalPath)
    if (loaded.length > MAX_SESSIONS_PER_DAEMON) {
      throw new AgentMuxError('Daemon session journal exceeds the session limit.', 'DAEMON_SESSION_LIMIT')
    }
    const lostAt = Date.now()
    for (const persisted of loaded) {
      const sessionId = safeIdentity(persisted.sessionId, 'session_id')
      const createOperationId = safeIdentity(persisted.createOperationId, 'create_operation_id')
      safeIdentity(persisted.incarnationId, 'incarnation_id')
      if (this.sessions.has(sessionId) || this.createOperations.has(createOperationId)) {
        throw new AgentMuxError('Daemon session journal contains duplicate identities.', 'INVALID_DAEMON_JOURNAL')
      }
      const snapshot: AgentMuxDaemonSession = persisted.state === 'running'
        ? { ...persisted, state: 'lost', lostAt, lostReason: 'daemon-crash' }
        : { ...persisted }
      this.sessions.set(sessionId, {
        snapshot,
        pty: null,
        replay: [],
        replayBytes: 0,
        exitPromise: null,
        resolveExit: null,
        dataDisposable: null,
        exitDisposable: null
      })
      this.createOperations.set(createOperationId, { sessionId, state: 'active' })
      this.createOperationOrder.push(createOperationId)
    }
  }

  activate(): void {
    this.persistJournal()
  }

  onEvent(listener: (event: AgentMuxDaemonEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  list(): AgentMuxDaemonSession[] {
    return [...this.sessions.values()].map((record) => cloneSession(record.snapshot))
  }

  inspect(sessionId: string): AgentMuxDaemonSession | null {
    const record = this.sessions.get(safeIdentity(sessionId, 'session_id'))
    return record ? cloneSession(record.snapshot) : null
  }

  findByCreateOperation(createOperationId: string): AgentMuxDaemonSession | null {
    const operationId = safeIdentity(createOperationId, 'create_operation_id')
    const receipt = this.createOperations.get(operationId)
    if (!receipt || receipt.state === 'retired') return null
    const record = this.sessions.get(receipt.sessionId)
    return record ? cloneSession(record.snapshot) : null
  }

  create(input: AgentMuxDaemonCreateRequest): AgentMuxDaemonSession {
    const sessionId = safeIdentity(input.sessionId, 'session_id')
    const createOperationId = safeIdentity(input.createOperationId, 'create_operation_id')
    const agentSessionId = input.kind === 'agent'
      ? safeIdentity(input.agentSessionId ?? '', 'agent_session_id')
      : null
    if (input.kind === 'terminal' && input.agentSessionId !== null) {
      throw new AgentMuxError('Raw Terminal cannot carry an Agent Session id.', 'INVALID_AGENT_SESSION')
    }
    const previousReceipt = this.createOperations.get(createOperationId)
    if (previousReceipt) {
      if (previousReceipt.sessionId !== sessionId) {
        throw new AgentMuxError('Create operation is already bound to another session.', 'CREATE_OPERATION_CONFLICT')
      }
      if (previousReceipt.state === 'retired') {
        throw new AgentMuxError('Create operation already completed and cannot spawn again.', 'CREATE_OPERATION_RETIRED')
      }
      const previous = this.sessions.get(sessionId)
      if (!previous) {
        throw new AgentMuxError('Create operation refers to a session that is no longer available.', 'CREATE_OPERATION_EXPIRED')
      }
      return cloneSession(previous.snapshot)
    }
    if (this.sessions.has(sessionId)) {
      throw new AgentMuxError(`Session already exists: ${sessionId}`, 'DUPLICATE_SESSION')
    }
    if (this.sessions.size >= MAX_SESSIONS_PER_DAEMON) {
      throw new AgentMuxError('AgentMux daemon session limit reached.', 'DAEMON_SESSION_LIMIT')
    }
    const { cols, rows } = validateDimensions(input.cols, input.rows)
    const incarnationId = randomUUID()
    const command = input.kind === 'terminal'
      ? (process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined) || '/bin/sh')
      : input.command?.trim()
    if (!command) {
      throw new AgentMuxError('Agent launch command is required.', 'INVALID_AGENT_COMMAND')
    }
    const args = input.kind === 'terminal'
      ? (process.platform === 'win32' ? [] : ['-l'])
      : [...(input.args ?? [])]
    const terminalName = input.env.TERM || 'xterm-256color'
    const env = processEnvironment({
      ...input.env,
      TERM: terminalName,
      COLORTERM: input.env.COLORTERM || 'truecolor',
      TERM_PROGRAM: 'AgentMux',
      AGENTMUX_RUN_ID: sessionId,
      AGENTMUX_RUN_INCARNATION_ID: incarnationId,
      AGENTMUX_CREATE_OPERATION_ID: createOperationId,
      AGENTMUX_SESSION_KIND: input.kind,
      ...(agentSessionId ? { AGENTMUX_AGENT_SESSION_ID: agentSessionId } : {}),
      ...(input.agentId ? { AGENTMUX_AGENT_ID: input.agentId } : {})
    })
    const child = nodePty.spawn(command, args, {
      name: terminalName,
      cols,
      rows,
      cwd: input.cwd,
      env
    })
    const createdAt = Date.now()
    const processIdentity = recordPosixProcessIdentity(child.pid)
    let resolveExit = (): void => {}
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const snapshot: AgentMuxDaemonSession = {
      sessionId,
      incarnationId,
      createOperationId,
      kind: input.kind,
      agentId: input.agentId,
      agentSessionId,
      cwd: input.cwd,
      pid: child.pid,
      ...(processIdentity ? { processStartedAt: processIdentity.startedAtMs } : {}),
      state: 'running',
      cols,
      rows,
      createdAt,
      latestSequence: 0,
      acceptedInputSequence: 0
    }
    const record: SessionRecord = {
      snapshot,
      pty: child,
      replay: [],
      replayBytes: 0,
      exitPromise,
      resolveExit,
      dataDisposable: null,
      exitDisposable: null
    }
    this.sessions.set(sessionId, record)
    this.createOperations.set(createOperationId, { sessionId, state: 'active' })
    this.createOperationOrder.push(createOperationId)
    this.pruneCreateOperationReceipts()
    try {
      record.dataDisposable = child.onData((data) => this.acceptData(sessionId, incarnationId, data))
      record.exitDisposable = child.onExit(({ exitCode, signal }) => {
        this.acceptExit(sessionId, incarnationId, exitCode, signal)
      })
      this.persistJournal()
    } catch (error) {
      record.dataDisposable?.dispose()
      record.exitDisposable?.dispose()
      this.sessions.delete(sessionId)
      this.createOperations.delete(createOperationId)
      const operationIndex = this.createOperationOrder.indexOf(createOperationId)
      if (operationIndex >= 0) this.createOperationOrder.splice(operationIndex, 1)
      try {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
      } catch {
        // The child may have exited between spawn and transaction rollback.
      }
      throw error
    }
    return cloneSession(snapshot)
  }

  attach(sessionId: string, afterSequence = 0): AgentMuxDaemonAttachResult {
    const record = this.requireSessionById(sessionId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new AgentMuxError('Attach cursor must be a non-negative integer.', 'INVALID_OUTPUT_CURSOR')
    }
    if (afterSequence > record.snapshot.latestSequence) {
      throw new AgentMuxError('Attach cursor is ahead of daemon output.', 'INVALID_OUTPUT_CURSOR')
    }
    const firstAvailableSequence = record.replay[0]?.event.startSequence ?? record.snapshot.latestSequence
    const isTruncated = afterSequence < firstAvailableSequence
    const isBoundary =
      afterSequence === 0 ||
      afterSequence === record.snapshot.latestSequence ||
      record.replay.some((chunk) => chunk.event.endSequence === afterSequence)
    if (!isTruncated && !isBoundary) {
      throw new AgentMuxError('Attach cursor does not align with an output boundary.', 'INVALID_OUTPUT_CURSOR')
    }
    const replay = record.replay
      .filter((chunk) => isTruncated || chunk.event.endSequence > afterSequence)
      .map((chunk) => ({ ...chunk.event }))
    return {
      session: cloneSession(record.snapshot),
      replay,
      gap: isTruncated
        ? { requestedAfterSequence: afterSequence, firstAvailableSequence }
        : null
    }
  }

  write(ref: AgentMuxDaemonSessionRef, startSequence: number, data: string): AgentMuxDaemonInputAck {
    const record = this.requireRunningSession(ref)
    const pty = record.pty
    if (!pty) throw new AgentMuxError(`Session process is unavailable: ${ref.sessionId}`, 'SESSION_NOT_RUNNING')
    if (!Number.isSafeInteger(startSequence) || startSequence < 0) {
      throw new AgentMuxError('Input cursor must be a non-negative integer.', 'INVALID_INPUT_CURSOR')
    }
    const bytes = Buffer.byteLength(data)
    const endSequence = startSequence + bytes
    if (!Number.isSafeInteger(endSequence)) {
      throw new AgentMuxError('Input cursor exceeds the safe integer range.', 'INVALID_INPUT_CURSOR')
    }
    if (endSequence <= record.snapshot.acceptedInputSequence) {
      return { ...ref, acceptedThrough: record.snapshot.acceptedInputSequence, duplicate: true }
    }
    if (startSequence !== record.snapshot.acceptedInputSequence) {
      throw new AgentMuxError(
        `Input cursor mismatch: expected ${record.snapshot.acceptedInputSequence}, received ${startSequence}.`,
        'INPUT_CURSOR_MISMATCH'
      )
    }
    if (!data) return { ...ref, acceptedThrough: startSequence, duplicate: false }
    pty.write(data)
    record.snapshot.acceptedInputSequence = endSequence
    return { ...ref, acceptedThrough: endSequence, duplicate: false }
  }

  resize(ref: AgentMuxDaemonSessionRef, cols: number, rows: number): AgentMuxDaemonAppliedSize {
    const record = this.requireRunningSession(ref)
    const pty = record.pty
    if (!pty) throw new AgentMuxError(`Session process is unavailable: ${ref.sessionId}`, 'SESSION_NOT_RUNNING')
    const applied = validateDimensions(cols, rows)
    pty.resize(applied.cols, applied.rows)
    record.snapshot.cols = pty.cols
    record.snapshot.rows = pty.rows
    return { ...ref, cols: record.snapshot.cols, rows: record.snapshot.rows }
  }

  acknowledgeOutput(ref: AgentMuxDaemonSessionRef, sequence: number): AgentMuxDaemonOutputAck {
    const record = this.requireSession(ref)
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > record.snapshot.latestSequence) {
      throw new AgentMuxError('Output acknowledgement is outside the available range.', 'INVALID_OUTPUT_ACK')
    }
    return { ...ref, acknowledgedThrough: sequence }
  }

  signal(ref: AgentMuxDaemonSessionRef, signal: string): void {
    const record = this.requireRunningSession(ref)
    if (!/^SIG[A-Z0-9]+$/.test(signal)) {
      throw new AgentMuxError('Invalid process signal.', 'INVALID_SIGNAL')
    }
    record.pty?.kill(process.platform === 'win32' ? undefined : signal)
  }

  async stop(ref: AgentMuxDaemonSessionRef): Promise<void> {
    const record = this.requireSession(ref)
    const pty = record.pty
    if (record.snapshot.state === 'lost' && !pty && record.snapshot.processStartedAt !== undefined) {
      const identity = { pid: record.snapshot.pid, startedAtMs: record.snapshot.processStartedAt }
      if (posixProcessIdentityIsAlive(identity)) {
        forceKillPosixPtyProcessGroups(identity.pid, () => process.kill(identity.pid, 'SIGKILL'))
        const deadline = Date.now() + STOP_FORCE_MS
        while (Date.now() < deadline && posixProcessIdentityIsAlive(identity)) await delay(25)
        if (posixProcessIdentityIsAlive(identity)) {
          throw new AgentMuxError(`Lost session process did not stop: ${ref.sessionId}`, 'SESSION_STOP_TIMEOUT')
        }
      }
    }
    if (record.snapshot.state === 'running' && pty && record.exitPromise) {
      pty.kill(process.platform === 'win32' ? undefined : 'SIGHUP')
      await Promise.race([record.exitPromise, delay(STOP_GRACE_MS)])
      if (record.snapshot.state === 'running') {
        forceKillPosixPtyProcessGroups(pty.pid, () => pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL'))
        await Promise.race([record.exitPromise, delay(STOP_FORCE_MS)])
      }
      if (record.snapshot.state === 'running') {
        throw new AgentMuxError(`Session did not stop: ${ref.sessionId}`, 'SESSION_STOP_TIMEOUT')
      }
    }
    this.deleteSession(record)
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].filter((record) => record.pty !== null).map(async (record) => await this.stop({
        sessionId: record.snapshot.sessionId,
        incarnationId: record.snapshot.incarnationId
      }))
    )
    this.events.removeAllListeners()
    this.persistJournal()
  }

  private acceptData(sessionId: string, incarnationId: string, data: string): void {
    const record = this.sessions.get(sessionId)
    if (!record || record.snapshot.incarnationId !== incarnationId || record.snapshot.state !== 'running') return
    const bytes = Buffer.byteLength(data)
    if (bytes === 0) return
    const startSequence = record.snapshot.latestSequence
    const endSequence = startSequence + bytes
    if (!Number.isSafeInteger(endSequence)) {
      record.pty?.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
      return
    }
    record.snapshot.latestSequence = endSequence
    const event: AgentMuxDaemonDataEvent = {
      type: 'data',
      sessionId,
      incarnationId,
      startSequence,
      endSequence,
      data
    }
    const retainedBytes = Buffer.byteLength(JSON.stringify(event))
    if (retainedBytes <= MAX_REPLAY_BYTES_PER_SESSION) {
      record.replay.push({ event, bytes: retainedBytes })
      record.replayBytes += retainedBytes
      while (record.replayBytes > MAX_REPLAY_BYTES_PER_SESSION) {
        const removed = record.replay.shift()
        if (!removed) break
        record.replayBytes -= removed.bytes
      }
    } else {
      record.replay = []
      record.replayBytes = 0
    }
    this.events.emit('event', event)
  }

  private acceptExit(sessionId: string, incarnationId: string, exitCode: number, signal?: number): void {
    const record = this.sessions.get(sessionId)
    if (!record || record.snapshot.incarnationId !== incarnationId || record.snapshot.state === 'exited') return
    const observedAt = Date.now()
    record.snapshot.state = 'exited'
    record.snapshot.exitedAt = observedAt
    record.snapshot.exitCode = exitCode
    if (signal !== undefined) record.snapshot.exitSignal = signal
    const event: AgentMuxDaemonExitEvent = {
      type: 'exit',
      sessionId,
      incarnationId,
      pid: record.snapshot.pid,
      exitCode,
      ...(signal !== undefined ? { exitSignal: signal } : {}),
      observedAt
    }
    record.resolveExit?.()
    this.events.emit('event', event)
    try {
      this.persistJournal()
    } catch {
      // The live snapshot remains authoritative; a later crash will conservatively
      // recover the last durable state as lost rather than claim it is running.
    }
  }

  private requireSession(ref: AgentMuxDaemonSessionRef): SessionRecord {
    const record = this.requireSessionById(ref.sessionId)
    if (record.snapshot.incarnationId !== ref.incarnationId) {
      throw new AgentMuxError(`Stale daemon session incarnation: ${ref.sessionId}`, 'STALE_SESSION_INCARNATION')
    }
    return record
  }

  private requireSessionById(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new AgentMuxError(`Unknown daemon session: ${sessionId}`, 'UNKNOWN_DAEMON_SESSION')
    return record
  }

  private requireRunningSession(ref: AgentMuxDaemonSessionRef): SessionRecord {
    const record = this.requireSession(ref)
    if (record.snapshot.state !== 'running' || !record.pty) {
      throw new AgentMuxError(`Session is not running: ${ref.sessionId}`, 'SESSION_NOT_RUNNING')
    }
    return record
  }

  private deleteSession(record: SessionRecord): void {
    if (this.sessions.get(record.snapshot.sessionId) !== record) return
    record.dataDisposable?.dispose()
    record.exitDisposable?.dispose()
    this.sessions.delete(record.snapshot.sessionId)
    const receipt = this.createOperations.get(record.snapshot.createOperationId)
    if (receipt?.sessionId === record.snapshot.sessionId) receipt.state = 'retired'
    this.pruneCreateOperationReceipts()
    this.persistJournal()
  }

  private pruneCreateOperationReceipts(): void {
    while (this.createOperations.size > MAX_CREATE_OPERATION_RECEIPTS) {
      const operationId = this.createOperationOrder.shift()
      if (!operationId) return
      const receipt = this.createOperations.get(operationId)
      if (receipt?.state === 'retired') this.createOperations.delete(operationId)
      else this.createOperationOrder.push(operationId)
      if (this.createOperationOrder.length <= this.sessions.size) return
    }
  }

  private persistJournal(): void {
    if (!this.options.journalPath) return
    writeAgentMuxDaemonSessionJournal(
      this.options.journalPath,
      [...this.sessions.values()].map((record) => record.snapshot)
    )
  }
}
