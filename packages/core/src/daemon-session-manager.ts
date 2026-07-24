import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as nodePty from 'node-pty'
import { AgentMuxError } from './errors.js'
import type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonCreateRequest,
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonSession
} from './daemon-protocol.js'

const MAX_REPLAY_BYTES_PER_SESSION = 256 * 1024
const MAX_SESSIONS_PER_DAEMON = 128
const STOP_GRACE_MS = 1_500
const STOP_FORCE_MS = 1_500

type ReplayChunk = {
  event: AgentMuxDaemonDataEvent
  bytes: number
}

type SessionRecord = {
  snapshot: AgentMuxDaemonSession
  pty: nodePty.IPty
  replay: ReplayChunk[]
  replayBytes: number
  exitPromise: Promise<void>
  resolveExit: () => void
  dataDisposable: nodePty.IDisposable
  exitDisposable: nodePty.IDisposable
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
  private readonly createOperations = new Map<string, string>()
  private readonly events = new EventEmitter()

  onEvent(listener: (event: AgentMuxDaemonEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  list(): AgentMuxDaemonSession[] {
    return [...this.sessions.values()].map((record) => cloneSession(record.snapshot))
  }

  create(input: AgentMuxDaemonCreateRequest): AgentMuxDaemonSession {
    const sessionId = safeIdentity(input.sessionId, 'session_id')
    const createOperationId = safeIdentity(input.createOperationId, 'create_operation_id')
    const previousSessionId = this.createOperations.get(createOperationId)
    if (previousSessionId) {
      if (previousSessionId !== sessionId) {
        throw new AgentMuxError('Create operation is already bound to another session.', 'CREATE_OPERATION_CONFLICT')
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
      AGENTMUX_SESSION_ID: sessionId,
      AGENTMUX_SESSION_INCARNATION_ID: incarnationId,
      AGENTMUX_CREATE_OPERATION_ID: createOperationId,
      AGENTMUX_SESSION_KIND: input.kind,
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
      cwd: input.cwd,
      pid: child.pid,
      state: 'running',
      cols,
      rows,
      createdAt,
      latestSequence: 0
    }
    const record = {
      snapshot,
      pty: child,
      replay: [],
      replayBytes: 0,
      exitPromise,
      resolveExit,
      dataDisposable: { dispose() {} },
      exitDisposable: { dispose() {} }
    } satisfies SessionRecord
    this.sessions.set(sessionId, record)
    this.createOperations.set(createOperationId, sessionId)
    record.dataDisposable = child.onData((data) => this.acceptData(sessionId, incarnationId, data))
    record.exitDisposable = child.onExit(({ exitCode, signal }) => {
      this.acceptExit(sessionId, incarnationId, exitCode, signal)
    })
    return cloneSession(snapshot)
  }

  attach(sessionId: string, afterSequence = 0): AgentMuxDaemonAttachResult {
    const record = this.requireSession(sessionId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new AgentMuxError('Attach cursor must be a non-negative integer.', 'INVALID_OUTPUT_CURSOR')
    }
    const replay = record.replay
      .filter((chunk) => chunk.event.sequence > afterSequence)
      .map((chunk) => ({ ...chunk.event }))
    const firstAvailableSequence = record.replay[0]?.event.sequence ?? record.snapshot.latestSequence + 1
    return {
      session: cloneSession(record.snapshot),
      replay,
      gap: afterSequence < firstAvailableSequence - 1
        ? { requestedAfterSequence: afterSequence, firstAvailableSequence }
        : null
    }
  }

  write(sessionId: string, data: string): void {
    const record = this.requireRunningSession(sessionId)
    if (!data) return
    record.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): { cols: number; rows: number } {
    const record = this.requireRunningSession(sessionId)
    const applied = validateDimensions(cols, rows)
    record.pty.resize(applied.cols, applied.rows)
    record.snapshot.cols = applied.cols
    record.snapshot.rows = applied.rows
    return applied
  }

  signal(sessionId: string, signal: string): void {
    const record = this.requireRunningSession(sessionId)
    if (!/^SIG[A-Z0-9]+$/.test(signal)) {
      throw new AgentMuxError('Invalid process signal.', 'INVALID_SIGNAL')
    }
    record.pty.kill(process.platform === 'win32' ? undefined : signal)
  }

  async stop(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId)
    if (record.snapshot.state === 'running') {
      record.pty.kill(process.platform === 'win32' ? undefined : 'SIGHUP')
      await Promise.race([record.exitPromise, delay(STOP_GRACE_MS)])
      if (record.snapshot.state === 'running') {
        record.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
        await Promise.race([record.exitPromise, delay(STOP_FORCE_MS)])
      }
      if (record.snapshot.state === 'running') {
        throw new AgentMuxError(`Session did not stop: ${sessionId}`, 'SESSION_STOP_TIMEOUT')
      }
    }
    this.deleteSession(record)
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map(async (sessionId) => await this.stop(sessionId)))
    for (const record of this.sessions.values()) this.deleteSession(record)
    this.events.removeAllListeners()
  }

  private acceptData(sessionId: string, incarnationId: string, data: string): void {
    const record = this.sessions.get(sessionId)
    if (!record || record.snapshot.incarnationId !== incarnationId || record.snapshot.state !== 'running') return
    const sequence = ++record.snapshot.latestSequence
    const event: AgentMuxDaemonDataEvent = { type: 'data', sessionId, incarnationId, sequence, data }
    const bytes = Buffer.byteLength(data)
    if (bytes <= MAX_REPLAY_BYTES_PER_SESSION) {
      record.replay.push({ event, bytes })
      record.replayBytes += bytes
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
      exitCode,
      ...(signal !== undefined ? { exitSignal: signal } : {}),
      observedAt
    }
    record.resolveExit()
    this.events.emit('event', event)
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new AgentMuxError(`Unknown daemon session: ${sessionId}`, 'UNKNOWN_DAEMON_SESSION')
    return record
  }

  private requireRunningSession(sessionId: string): SessionRecord {
    const record = this.requireSession(sessionId)
    if (record.snapshot.state !== 'running') {
      throw new AgentMuxError(`Session is not running: ${sessionId}`, 'SESSION_NOT_RUNNING')
    }
    return record
  }

  private deleteSession(record: SessionRecord): void {
    if (this.sessions.get(record.snapshot.sessionId) !== record) return
    record.dataDisposable.dispose()
    record.exitDisposable.dispose()
    this.sessions.delete(record.snapshot.sessionId)
    this.createOperations.delete(record.snapshot.createOperationId)
  }
}
