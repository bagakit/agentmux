import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { AgentProviderRegistry, type AgentProvider } from './agent-provider.js'
import { LocalExecutionHost } from './execution-host.js'
import { AgentMuxError } from './errors.js'
import {
  AGENTMUX_DAEMON_MAX_FRAME_BYTES,
  AGENTMUX_DAEMON_PROTOCOL_VERSION,
  encodeAgentMuxDaemonFrame,
  parseAgentMuxDaemonFrame,
  type AgentMuxDaemonAttachResult,
  type AgentMuxDaemonCreateRequest,
  type AgentMuxDaemonEvent,
  type AgentMuxDaemonHello,
  type AgentMuxDaemonMethod,
  type AgentMuxDaemonResponseFrame,
  type AgentMuxDaemonSession
} from './daemon-protocol.js'
import { defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import type { AgentId } from './types.js'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const MAX_PENDING_REQUESTS = 256
const MAX_CLIENT_WRITE_BUFFER_BYTES = 1024 * 1024

type CreateBase = {
  sessionId?: string
  createOperationId?: string
  cwd: string
  cols?: number
  rows?: number
  env?: Readonly<Record<string, string>>
}

export type AgentMuxTerminalCreateInput = CreateBase

export type AgentMuxAgentCreateInput = CreateBase & {
  agentId: AgentId
  prompt?: string
  args?: readonly string[]
  commandOverride?: string
}

export type AgentMuxClientOptions = {
  socketPath?: string
  providers?: readonly AgentProvider[]
}

export class AgentMuxClient {
  readonly socketPath: string
  readonly providers: AgentProviderRegistry
  private readonly events = new EventEmitter()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly messageQueue: string[] = []
  private readonly localHost = new LocalExecutionHost()
  private socket: Socket | null = null
  private input = ''
  private queuedMessageBytes = 0
  private processingMessages = false

  constructor(options: AgentMuxClientOptions = {}) {
    this.socketPath = options.socketPath ?? defaultAgentMuxDaemonSocketPath()
    this.providers = new AgentProviderRegistry(options.providers)
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    const socket = createConnection(this.socketPath)
    socket.setEncoding('utf8')
    this.socket = socket
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          socket.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          socket.off('connect', onConnect)
          reject(error)
        }
        socket.once('connect', onConnect)
        socket.once('error', onError)
      })
    } catch (error) {
      socket.destroy()
      if (this.socket === socket) this.socket = null
      throw error
    }
    socket.on('data', (data: string) => this.acceptData(data))
    socket.on('error', (error) => this.failConnection(error))
    socket.on('close', () => this.failConnection(new AgentMuxError('Daemon connection closed.', 'DAEMON_DISCONNECTED')))
    const hello = await this.request('hello', {}) as AgentMuxDaemonHello
    if (hello.protocolVersion !== AGENTMUX_DAEMON_PROTOCOL_VERSION) {
      this.disconnect()
      throw new AgentMuxError(
        `Daemon protocol mismatch: expected ${AGENTMUX_DAEMON_PROTOCOL_VERSION}, received ${hello.protocolVersion}.`,
        'DAEMON_PROTOCOL_MISMATCH'
      )
    }
  }

  disconnect(): void {
    const socket = this.socket
    this.socket = null
    socket?.destroy()
    this.input = ''
    this.messageQueue.length = 0
    this.queuedMessageBytes = 0
    this.failPending(new AgentMuxError('Daemon client disconnected.', 'DAEMON_DISCONNECTED'))
  }

  onEvent(listener: (event: AgentMuxDaemonEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  async listSessions(): Promise<AgentMuxDaemonSession[]> {
    return await this.request('list', {}) as AgentMuxDaemonSession[]
  }

  async createTerminal(input: AgentMuxTerminalCreateInput): Promise<AgentMuxDaemonSession> {
    const request: AgentMuxDaemonCreateRequest = {
      sessionId: input.sessionId ?? randomUUID(),
      createOperationId: input.createOperationId ?? randomUUID(),
      kind: 'terminal',
      agentId: null,
      cwd: input.cwd,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      env: { ...input.env }
    }
    return await this.request('create', request) as AgentMuxDaemonSession
  }

  async createAgent(input: AgentMuxAgentCreateInput): Promise<AgentMuxDaemonSession> {
    const provider = this.providers.get(input.agentId)
    if (!(await provider.detect(this.localHost, input.commandOverride))) {
      throw new AgentMuxError(`${provider.label} is not installed on this host.`, 'AGENT_NOT_FOUND')
    }
    const plan = provider.buildLaunch({
      workspacePath: input.cwd,
      prompt: input.prompt ?? '',
      args: input.args ?? [],
      env: input.env ?? {},
      ...(input.commandOverride !== undefined ? { commandOverride: input.commandOverride } : {})
    })
    const request: AgentMuxDaemonCreateRequest = {
      sessionId: input.sessionId ?? randomUUID(),
      createOperationId: input.createOperationId ?? randomUUID(),
      kind: 'agent',
      agentId: provider.id,
      cwd: input.cwd,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      env: plan.env,
      command: plan.command,
      args: plan.args
    }
    return await this.request('create', request) as AgentMuxDaemonSession
  }

  async attach(sessionId: string, afterSequence = 0): Promise<AgentMuxDaemonAttachResult> {
    return await this.request('attach', { sessionId, afterSequence }) as AgentMuxDaemonAttachResult
  }

  async detach(sessionId: string): Promise<void> {
    await this.request('detach', { sessionId })
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.request('write', { sessionId, data })
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
    return await this.request('resize', { sessionId, cols, rows }) as { cols: number; rows: number }
  }

  async signal(sessionId: string, signal: string): Promise<void> {
    await this.request('signal', { sessionId, signal })
  }

  async stop(sessionId: string): Promise<void> {
    await this.request('stop', { sessionId })
  }

  private async request(method: AgentMuxDaemonMethod, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
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
    if (socket.writableLength + Buffer.byteLength(encoded) > MAX_CLIENT_WRITE_BUFFER_BYTES) {
      this.pending.delete(id)
      throw new AgentMuxError('Daemon client write buffer is full.', 'DAEMON_CLIENT_BACKPRESSURE')
    }
    socket.write(encoded)
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
        this.failConnection(new AgentMuxError('Daemon response exceeds the maximum frame size.', 'DAEMON_FRAME_TOO_LARGE'))
        return
      }
      this.messageQueue.push(line)
      this.queuedMessageBytes += Buffer.byteLength(line)
      if (this.queuedMessageBytes > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
        this.failConnection(new AgentMuxError('Daemon event queue exceeds the maximum size.', 'DAEMON_EVENT_QUEUE_FULL'))
        return
      }
    }
    if (Buffer.byteLength(this.input) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
      this.failConnection(new AgentMuxError('Daemon response exceeds the maximum frame size.', 'DAEMON_FRAME_TOO_LARGE'))
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
        this.events.emit('event', frame.event)
      } else if (frame.type === 'response') {
        this.acceptResponse(frame)
      }
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error(String(error)))
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

  private failConnection(error: Error): void {
    this.socket?.destroy()
    this.socket = null
    this.input = ''
    this.messageQueue.length = 0
    this.queuedMessageBytes = 0
    this.failPending(error)
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}

export type {
  AgentMuxDaemonAttachResult,
  AgentMuxDaemonDataEvent,
  AgentMuxDaemonEvent,
  AgentMuxDaemonExitEvent,
  AgentMuxDaemonSession
} from './daemon-protocol.js'
