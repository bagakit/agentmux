import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  LocalAgentMuxDaemonConnector,
  type AgentMuxDaemonConnector
} from './daemon-connector.js'
import { AgentMuxError } from './errors.js'
import {
  AGENTMUX_DAEMON_MAX_FRAME_BYTES,
  AGENTMUX_DAEMON_PROTOCOL_VERSION,
  encodeAgentMuxDaemonFrame,
  parseAgentMuxDaemonFrame,
  type AgentMuxDaemonAttachResult,
  type AgentMuxDaemonAppliedSize,
  type AgentMuxDaemonCreateRequest,
  type AgentMuxDaemonEvent,
  type AgentMuxDaemonHello,
  type AgentMuxDaemonInputAck,
  type AgentMuxDaemonMethod,
  type AgentMuxDaemonOutputAck,
  type AgentMuxDaemonResponseFrame,
  type AgentMuxDaemonSession,
  type AgentMuxDaemonSessionRef
} from './daemon-protocol.js'
import { defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import type { AgentId } from './types.js'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type ClientSessionState = {
  ref: AgentMuxDaemonSessionRef
  nextInputSequence: number
}

const MAX_PENDING_REQUESTS = 256
const MAX_CLIENT_WRITE_BUFFER_BYTES = 1024 * 1024

type CreateBase = {
  sessionId: string
  createOperationId: string
  cwd: string
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

export type AgentMuxDaemonTerminalCreateInput = CreateBase

export type AgentMuxDaemonAgentCreateInput = CreateBase & {
  semanticSessionId: string
  agentId: AgentId
  command: string
  args: readonly string[]
}

export type AgentMuxDaemonClientOptions = {
  socketPath?: string
  connector?: AgentMuxDaemonConnector
  expectedHostId?: string
  expectedBuildIdentity?: string
}

export class AgentMuxDaemonClient {
  private readonly connector: AgentMuxDaemonConnector
  private readonly expectedHostId: string | undefined
  private readonly expectedBuildIdentity: string | undefined
  private readonly events = new EventEmitter()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly messageQueue: string[] = []
  private readonly sessionStates = new Map<string, ClientSessionState>()
  private readonly inputTails = new Map<string, Promise<void>>()
  private connection: Duplex | null = null
  private connecting: Promise<void> | null = null
  private input = ''
  private queuedMessageBytes = 0
  private processingMessages = false
  private hello: AgentMuxDaemonHello | null = null

  constructor(options: AgentMuxDaemonClientOptions = {}) {
    if (options.socketPath && options.connector) {
      throw new AgentMuxError('Choose either a local socket path or a daemon connector.', 'INVALID_CLIENT_TRANSPORT')
    }
    this.connector = options.connector ?? new LocalAgentMuxDaemonConnector(
      options.socketPath ?? defaultAgentMuxDaemonSocketPath()
    )
    this.expectedHostId = options.expectedHostId ?? this.connector.expectedHostId
    this.expectedBuildIdentity = options.expectedBuildIdentity ?? this.connector.expectedBuildIdentity
  }

  async connect(): Promise<void> {
    if (this.hello && this.connection && !this.connection.destroyed) return
    if (this.connecting) return await this.connecting
    const attempt = this.openConnection()
    this.connecting = attempt
    try {
      await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = null
    }
  }

  private async openConnection(): Promise<void> {
    const connection = await this.connector.connect()
    connection.setEncoding('utf8')
    this.connection = connection
    try {
      if (connection.destroyed) throw new AgentMuxError('Daemon connection closed.', 'DAEMON_DISCONNECTED')
    } catch (error) {
      connection.destroy()
      if (this.connection === connection) this.connection = null
      throw error
    }
    connection.on('data', (data: string) => {
      if (this.connection === connection) this.acceptData(data)
    })
    connection.on('error', (error) => this.failConnection(
      connection,
      error instanceof AgentMuxError
        ? error
        : new AgentMuxError(`Daemon connection failed: ${error.message}`, 'DAEMON_DISCONNECTED')
    ))
    connection.on('close', () => this.failConnection(
      connection,
      new AgentMuxError('Daemon connection closed.', 'DAEMON_DISCONNECTED')
    ))
    const hello = await this.request('hello', {}) as AgentMuxDaemonHello
    if (hello.protocolVersion !== AGENTMUX_DAEMON_PROTOCOL_VERSION) {
      this.disconnect()
      throw new AgentMuxError(
        `Daemon protocol mismatch: expected ${AGENTMUX_DAEMON_PROTOCOL_VERSION}, received ${hello.protocolVersion}.`,
        'DAEMON_PROTOCOL_MISMATCH'
      )
    }
    if (
      typeof hello.buildIdentity !== 'string' || !hello.buildIdentity ||
      typeof hello.hostId !== 'string' || !hello.hostId ||
      typeof hello.daemonInstanceId !== 'string' || !hello.daemonInstanceId ||
      !Number.isInteger(hello.daemonPid) || hello.daemonPid < 1
    ) {
      this.disconnect()
      throw new AgentMuxError('Daemon returned an invalid identity.', 'INVALID_DAEMON_RESPONSE')
    }
    if (this.expectedBuildIdentity !== undefined && hello.buildIdentity !== this.expectedBuildIdentity) {
      this.disconnect()
      throw new AgentMuxError(
        `Daemon build mismatch: expected ${this.expectedBuildIdentity}, received ${hello.buildIdentity}.`,
        'DAEMON_BUILD_MISMATCH'
      )
    }
    if (this.expectedHostId !== undefined && hello.hostId !== this.expectedHostId) {
      this.disconnect()
      throw new AgentMuxError(
        `Daemon host mismatch: expected ${this.expectedHostId}, received ${hello.hostId}.`,
        'DAEMON_HOST_MISMATCH'
      )
    }
    this.hello = hello
  }

  disconnect(): void {
    const connection = this.connection
    this.connection = null
    this.connecting = null
    connection?.destroy()
    this.input = ''
    this.messageQueue.length = 0
    this.queuedMessageBytes = 0
    this.hello = null
    this.sessionStates.clear()
    this.inputTails.clear()
    this.failPending(new AgentMuxError('Daemon client disconnected.', 'DAEMON_DISCONNECTED'))
  }

  onEvent(listener: (event: AgentMuxDaemonEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  isConnected(): boolean {
    return this.hello !== null && this.connection !== null && !this.connection.destroyed
  }

  async listSessions(): Promise<AgentMuxDaemonSession[]> {
    return await this.request('list', {}) as AgentMuxDaemonSession[]
  }

  daemonIdentity(): AgentMuxDaemonHello {
    if (!this.hello) throw new AgentMuxError('Daemon client is not connected.', 'DAEMON_DISCONNECTED')
    return { ...this.hello }
  }

  async findCreateOperation(createOperationId: string): Promise<AgentMuxDaemonSession | null> {
    return await this.request('find-create-operation', { createOperationId }) as AgentMuxDaemonSession | null
  }

  async probeExecutable(executable: string): Promise<boolean> {
    return await this.request('probe-executable', { executable }) as boolean
  }

  async createTerminal(input: AgentMuxDaemonTerminalCreateInput): Promise<AgentMuxDaemonSession> {
    const request: AgentMuxDaemonCreateRequest = {
      sessionId: input.sessionId,
      createOperationId: input.createOperationId,
      kind: 'terminal',
      agentId: null,
      semanticSessionId: null,
      cwd: input.cwd,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      env: { ...input.env }
    }
    const session = await this.request('create', request) as AgentMuxDaemonSession
    this.rememberSession(session)
    return session
  }

  async createAgent(input: AgentMuxDaemonAgentCreateInput): Promise<AgentMuxDaemonSession> {
    const request: AgentMuxDaemonCreateRequest = {
      sessionId: input.sessionId,
      createOperationId: input.createOperationId,
      kind: 'agent',
      agentId: input.agentId,
      semanticSessionId: input.semanticSessionId,
      cwd: input.cwd,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      env: { ...input.env },
      command: input.command,
      args: [...input.args]
    }
    const session = await this.request('create', request) as AgentMuxDaemonSession
    this.rememberSession(session)
    return session
  }

  async attach(sessionId: string, afterSequence = 0): Promise<AgentMuxDaemonAttachResult> {
    const attached = await this.request('attach', { sessionId, afterSequence }) as AgentMuxDaemonAttachResult
    this.rememberSession(attached.session)
    return attached
  }

  async detach(ref: AgentMuxDaemonSessionRef): Promise<void> {
    await this.request('detach', ref)
  }

  async write(ref: AgentMuxDaemonSessionRef, data: string): Promise<AgentMuxDaemonInputAck> {
    const key = this.sessionKey(ref)
    const previous = this.inputTails.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const state = this.requireSessionState(ref)
      try {
        const ack = await this.request('write', {
          ...ref,
          startSequence: state.nextInputSequence,
          data
        }) as AgentMuxDaemonInputAck
        const current = this.sessionStates.get(ref.sessionId)
        if (current?.ref.incarnationId === ref.incarnationId) current.nextInputSequence = ack.acceptedThrough
        return ack
      } catch (error) {
        if (error instanceof AgentMuxError && error.code === 'INPUT_CURSOR_MISMATCH') this.forgetSession(ref)
        throw error
      }
    })
    const tail = operation.then(() => {}, () => {})
    this.inputTails.set(key, tail)
    void tail.finally(() => {
      if (this.inputTails.get(key) === tail) this.inputTails.delete(key)
    })
    return await operation
  }

  async resize(ref: AgentMuxDaemonSessionRef, cols: number, rows: number): Promise<AgentMuxDaemonAppliedSize> {
    this.requireSessionState(ref)
    return await this.request('resize', { ...ref, cols, rows }) as AgentMuxDaemonAppliedSize
  }

  async acknowledgeOutput(ref: AgentMuxDaemonSessionRef, sequence: number): Promise<AgentMuxDaemonOutputAck> {
    this.requireSessionState(ref)
    return await this.request('ack', { ...ref, sequence }) as AgentMuxDaemonOutputAck
  }

  async signal(ref: AgentMuxDaemonSessionRef, signal: string): Promise<void> {
    this.requireSessionState(ref)
    await this.request('signal', { ...ref, signal })
  }

  async stop(ref: AgentMuxDaemonSessionRef): Promise<void> {
    this.requireSessionState(ref)
    await this.request('stop', ref)
    this.forgetSession(ref)
  }

  private async request(method: AgentMuxDaemonMethod, params: unknown): Promise<unknown> {
    const connection = this.connection
    if (!connection || connection.destroyed) {
      throw new AgentMuxError('Daemon client is not connected.', 'DAEMON_DISCONNECTED')
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new AgentMuxError('Daemon client request limit reached.', 'DAEMON_REQUEST_LIMIT')
    }
    const id = randomUUID()
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    const encoded = encodeAgentMuxDaemonFrame({ type: 'request', id, method, params })
    if (Buffer.byteLength(encoded) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
      this.pending.delete(id)
      throw new AgentMuxError('Daemon request exceeds the maximum frame size.', 'DAEMON_FRAME_TOO_LARGE')
    }
    if (connection.writableLength + Buffer.byteLength(encoded) > MAX_CLIENT_WRITE_BUFFER_BYTES) {
      this.pending.delete(id)
      throw new AgentMuxError('Daemon client write buffer is full.', 'DAEMON_CLIENT_BACKPRESSURE')
    }
    connection.write(encoded)
    return await response
  }

  private acceptData(data: string): void {
    this.input += data
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) break
      const line = this.input.slice(0, newline)
      this.input = this.input.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
        this.failConnection(this.connection, new AgentMuxError(
          'Daemon response exceeds the maximum frame size.',
          'DAEMON_FRAME_TOO_LARGE'
        ))
        return
      }
      this.messageQueue.push(line)
      this.queuedMessageBytes += Buffer.byteLength(line)
      if (this.queuedMessageBytes > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
        this.failConnection(this.connection, new AgentMuxError(
          'Daemon event queue exceeds the maximum size.',
          'DAEMON_EVENT_QUEUE_FULL'
        ))
        return
      }
    }
    if (Buffer.byteLength(this.input) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
      this.failConnection(this.connection, new AgentMuxError(
        'Daemon response exceeds the maximum frame size.',
        'DAEMON_FRAME_TOO_LARGE'
      ))
      return
    }
    this.processNextMessage()
  }

  private processNextMessage(): void {
    if (this.processingMessages) return
    const line = this.messageQueue.shift()
    if (!line) return
    this.queuedMessageBytes -= Buffer.byteLength(line)
    this.processingMessages = true
    try {
      const frame = parseAgentMuxDaemonFrame(line)
      if (frame.type === 'event') {
        const state = this.sessionStates.get(frame.event.sessionId)
        if (!state || state.ref.incarnationId === frame.event.incarnationId) this.events.emit('event', frame.event)
      } else if (frame.type === 'response') {
        this.acceptResponse(frame)
      }
    } catch (error) {
      this.failConnection(this.connection, error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.processingMessages = false
      queueMicrotask(() => this.processNextMessage())
    }
  }

  private acceptResponse(frame: AgentMuxDaemonResponseFrame): void {
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new AgentMuxError(frame.error.message, frame.error.code))
  }

  private failConnection(connection: Duplex | null, error: Error): void {
    if (!connection || this.connection !== connection) return
    connection.destroy()
    this.connection = null
    this.input = ''
    this.messageQueue.length = 0
    this.queuedMessageBytes = 0
    this.hello = null
    this.sessionStates.clear()
    this.inputTails.clear()
    this.failPending(error)
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private rememberSession(session: AgentMuxDaemonSession): void {
    this.sessionStates.set(session.sessionId, {
      ref: { sessionId: session.sessionId, incarnationId: session.incarnationId },
      nextInputSequence: session.acceptedInputSequence
    })
  }

  private requireSessionState(ref: AgentMuxDaemonSessionRef): ClientSessionState {
    const state = this.sessionStates.get(ref.sessionId)
    if (!state || state.ref.incarnationId !== ref.incarnationId) {
      throw new AgentMuxError(`Session is not attached to this client: ${ref.sessionId}`, 'SESSION_NOT_ATTACHED')
    }
    return state
  }

  private forgetSession(ref: AgentMuxDaemonSessionRef): void {
    const state = this.sessionStates.get(ref.sessionId)
    if (state?.ref.incarnationId === ref.incarnationId) this.sessionStates.delete(ref.sessionId)
    this.inputTails.delete(this.sessionKey(ref))
  }

  private sessionKey(ref: AgentMuxDaemonSessionRef): string {
    return `${ref.sessionId}\u0000${ref.incarnationId}`
  }
}

export type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonAppliedSize,
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonHookEvent,
  AgentMuxDaemonHello,
  AgentMuxDaemonInputAck,
  AgentMuxDaemonOutputAck,
  AgentMuxReplayGap,
  AgentMuxDaemonSession,
  AgentMuxDaemonSessionState,
  AgentMuxDaemonSessionRef
} from './daemon-protocol.js'
