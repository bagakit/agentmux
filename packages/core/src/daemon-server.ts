import { chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { AgentMuxError } from './errors.js'
import { inspectAgentMuxDaemonRuntime } from './daemon-diagnostics.js'
import { AgentHookServer } from './hook-server.js'
import {
  AGENTMUX_DAEMON_PROTOCOL_VERSION,
  AGENTMUX_DAEMON_MAX_FRAME_BYTES,
  AGENTMUX_DAEMON_BUILD_IDENTITY,
  AGENTMUX_LOCAL_HOST_ID,
  encodeAgentMuxDaemonFrame,
  parseAgentMuxDaemonFrame,
  type AgentMuxDaemonCreateRequest,
  type AgentMuxDaemonAttachResult,
  type AgentMuxDaemonEvent,
  type AgentMuxDaemonRequestFrame,
  type AgentMuxDaemonResponseFrame,
  type AgentMuxDaemonSessionRef
} from './daemon-protocol.js'
import { AgentMuxDaemonSessionManager } from './daemon-session-manager.js'
import { agentMuxDaemonStatePath, defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import type { NativeHookEnvelope } from './types.js'

const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024
const MAX_CLIENTS_PER_DAEMON = 64
const MAX_IN_FLIGHT_REQUESTS_PER_CLIENT = 256
const MAX_UNACKNOWLEDGED_OUTPUT_BYTES = 512 * 1024
const MAX_CREATE_ARGUMENTS = 256
const MAX_CREATE_ARGUMENT_BYTES = 256 * 1024
const MAX_CREATE_ENVIRONMENT_ENTRIES = 256
const MAX_CREATE_ENVIRONMENT_BYTES = 256 * 1024

type ClientAttachment = {
  ref: AgentMuxDaemonSessionRef
  acknowledgedThrough: number
  deliveredThrough: number
}

type ConnectedClient = {
  socket: Socket
  attachments: Map<string, ClientAttachment>
  input: string
  inFlightRequests: number
}

type SocketIdentity = { dev: number; ino: number }

export type AgentMuxDaemonServerOptions = {
  socketPath?: string
  statePath?: string
  hostId?: string
  buildIdentity?: string
  sessions?: AgentMuxDaemonSessionManager
}

function isAgentMuxError(error: unknown): error is AgentMuxError {
  return error instanceof AgentMuxError
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Daemon request params must be an object.', 'INVALID_DAEMON_REQUEST')
  }
  return value as Record<string, unknown>
}

function readString(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string') throw new AgentMuxError(`Missing string param: ${name}`, 'INVALID_DAEMON_REQUEST')
  return value
}

function boundedCreateString(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > maxBytes ||
    /\0/.test(value)
  ) {
    throw new AgentMuxError(`Invalid create param: ${name}`, 'INVALID_DAEMON_CREATE')
  }
  return value
}

function readCreateArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CREATE_ARGUMENTS) {
    throw new AgentMuxError('Invalid Agent argument list.', 'INVALID_DAEMON_CREATE')
  }
  let bytes = 0
  return value.map((argument) => {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new AgentMuxError('Invalid Agent argument.', 'INVALID_DAEMON_CREATE')
    }
    bytes += Buffer.byteLength(argument)
    if (bytes > MAX_CREATE_ARGUMENT_BYTES) {
      throw new AgentMuxError('Agent arguments exceed the size limit.', 'DAEMON_CREATE_LIMIT')
    }
    return argument
  })
}

function readCreateEnvironment(value: unknown): Record<string, string> {
  const source = asObject(value)
  const entries = Object.entries(source)
  if (entries.length > MAX_CREATE_ENVIRONMENT_ENTRIES) {
    throw new AgentMuxError('Agent environment exceeds the entry limit.', 'DAEMON_CREATE_LIMIT')
  }
  let bytes = 0
  const environment: Record<string, string> = {}
  for (const [name, entry] of entries) {
    if (!name || Buffer.byteLength(name) > 1024 || /[=\0\r\n]/.test(name) || typeof entry !== 'string' || entry.includes('\0')) {
      throw new AgentMuxError('Invalid Agent environment entry.', 'INVALID_DAEMON_CREATE')
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(entry)
    if (bytes > MAX_CREATE_ENVIRONMENT_BYTES) {
      throw new AgentMuxError('Agent environment exceeds the size limit.', 'DAEMON_CREATE_LIMIT')
    }
    environment[name] = entry
  }
  return environment
}

function readCreateRequest(params: Record<string, unknown>): AgentMuxDaemonCreateRequest {
  const kind = params.kind
  const common = {
    sessionId: boundedCreateString(params.sessionId, 'sessionId', 256),
    createOperationId: boundedCreateString(params.createOperationId, 'createOperationId', 256),
    cwd: boundedCreateString(params.cwd, 'cwd', 16 * 1024),
    cols: readNumber(params, 'cols'),
    rows: readNumber(params, 'rows'),
    env: readCreateEnvironment(params.env)
  }
  if (kind === 'terminal') {
    if (params.agentId !== null || params.agentSessionId !== null || params.command !== undefined || params.args !== undefined) {
      throw new AgentMuxError('Raw Terminal create request carries Agent fields.', 'INVALID_DAEMON_CREATE')
    }
    return { ...common, kind, agentId: null, agentSessionId: null }
  }
  if (kind === 'agent') {
    return {
      ...common,
      kind,
      agentId: boundedCreateString(params.agentId, 'agentId', 256),
      agentSessionId: boundedCreateString(params.agentSessionId, 'agentSessionId', 256),
      command: boundedCreateString(params.command, 'command', 4 * 1024),
      args: readCreateArguments(params.args)
    }
  }
  throw new AgentMuxError('Invalid Session kind.', 'INVALID_DAEMON_CREATE')
}

function safeExecutable(value: string): string {
  const executable = value.trim()
  if (!executable || Buffer.byteLength(executable) > 4 * 1024 || /[\0\r\n]/.test(executable)) {
    throw new AgentMuxError('Executable probe value is invalid.', 'INVALID_EXECUTABLE_PROBE')
  }
  return executable
}

async function probeExecutable(executable: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'where.exe' : 'sh'
  const args = process.platform === 'win32'
    ? [executable]
    : ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'agentmux-probe', executable]
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = (found: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(found)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, 8_000)
    timer.unref()
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}

function readNumber(params: Record<string, unknown>, name: string, fallback?: number): number {
  const value = params[name]
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number') throw new AgentMuxError(`Missing number param: ${name}`, 'INVALID_DAEMON_REQUEST')
  return value
}

function readSessionRef(params: Record<string, unknown>): AgentMuxDaemonSessionRef {
  return {
    sessionId: readString(params, 'sessionId'),
    incarnationId: readString(params, 'incarnationId')
  }
}

async function endpointAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const finish = (reachable: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(250, () => finish(false))
  })
}

export class AgentMuxDaemonServer {
  readonly socketPath: string
  readonly sessions: AgentMuxDaemonSessionManager
  private readonly clients = new Set<ConnectedClient>()
  private readonly unsubscribeSessionEvents: () => void
  private readonly daemonInstanceId = randomUUID()
  private readonly hostId: string
  private readonly buildIdentity: string
  private readonly hookServer: AgentHookServer
  private server: Server | null = null
  private socketIdentity: SocketIdentity | null = null

  constructor(options: AgentMuxDaemonServerOptions = {}) {
    this.socketPath = options.socketPath ?? defaultAgentMuxDaemonSocketPath()
    this.hostId = options.hostId ?? AGENTMUX_LOCAL_HOST_ID
    this.buildIdentity = options.buildIdentity ?? AGENTMUX_DAEMON_BUILD_IDENTITY
    if (!this.hostId.trim() || !this.buildIdentity.trim()) {
      throw new AgentMuxError('Daemon host and build identities are required.', 'INVALID_DAEMON_IDENTITY')
    }
    this.sessions = options.sessions ?? new AgentMuxDaemonSessionManager({
      journalPath: options.statePath ?? agentMuxDaemonStatePath(this.socketPath)
    })
    this.hookServer = new AgentHookServer((event) => this.acceptHookEvent(event))
    this.unsubscribeSessionEvents = this.sessions.onEvent((event) => this.publishEvent(event))
  }

  async start(): Promise<void> {
    if (this.server) return
    await this.hookServer.start()
    let server: Server | null = null
    try {
      await this.prepareEndpoint()
      this.sessions.activate()
      const startedServer = createServer((socket) => this.acceptClient(socket))
      server = startedServer
      this.server = startedServer
      await new Promise<void>((resolve, reject) => {
        startedServer.once('error', reject)
        startedServer.listen(this.socketPath, () => {
          startedServer.off('error', reject)
          resolve()
        })
      })
      if (process.platform !== 'win32') {
        await chmod(this.socketPath, 0o600)
        const info = await lstat(this.socketPath)
        this.socketIdentity = { dev: info.dev, ino: info.ino }
      }
    } catch (error) {
      this.server = null
      server?.close()
      await this.hookServer.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    await this.sessions.dispose()
    this.unsubscribeSessionEvents()
    await this.hookServer.stop()
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await this.unlinkOwnedSocket()
  }

  private async prepareEndpoint(): Promise<void> {
    if (process.platform === 'win32') return
    const directory = dirname(this.socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const directoryInfo = await stat(directory)
    if ((directoryInfo.mode & 0o077) !== 0) {
      throw new AgentMuxError('Daemon socket directory must be accessible only by the current user.', 'INSECURE_DAEMON_DIRECTORY')
    }
    if (typeof process.getuid === 'function' && directoryInfo.uid !== process.getuid()) {
      throw new AgentMuxError('Daemon socket directory is owned by another user.', 'INSECURE_DAEMON_DIRECTORY')
    }
    let existing
    try {
      existing = await lstat(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!existing.isSocket()) {
      throw new AgentMuxError('Daemon endpoint path exists and is not a Unix socket.', 'INVALID_DAEMON_ENDPOINT')
    }
    if (await endpointAcceptsConnections(this.socketPath)) {
      throw new AgentMuxError('An AgentMux daemon is already running.', 'DAEMON_ALREADY_RUNNING')
    }
    await unlink(this.socketPath)
  }

  private acceptClient(socket: Socket): void {
    if (this.clients.size >= MAX_CLIENTS_PER_DAEMON) {
      socket.destroy()
      return
    }
    const client: ConnectedClient = { socket, attachments: new Map(), input: '', inFlightRequests: 0 }
    this.clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', (data: string) => this.acceptData(client, data))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      client.attachments.clear()
      this.clients.delete(client)
    })
  }

  private acceptData(client: ConnectedClient, data: string): void {
    client.input += data
    while (true) {
      const newline = client.input.indexOf('\n')
      if (newline < 0) break
      const line = client.input.slice(0, newline)
      client.input = client.input.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
        client.socket.destroy(new Error('AgentMux daemon frame exceeds the maximum size.'))
        return
      }
      try {
        const frame = parseAgentMuxDaemonFrame(line)
        if (frame.type !== 'request') throw new AgentMuxError('Expected a daemon request frame.', 'INVALID_DAEMON_REQUEST')
        if (client.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS_PER_CLIENT) {
          throw new AgentMuxError('Daemon client has too many in-flight requests.', 'DAEMON_REQUEST_LIMIT')
        }
        client.inFlightRequests += 1
        void this.handleRequest(client, frame).finally(() => {
          client.inFlightRequests -= 1
        })
      } catch (error) {
        client.socket.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
    if (Buffer.byteLength(client.input) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
      client.socket.destroy(new Error('AgentMux daemon frame exceeds the maximum size.'))
    }
  }

  private async handleRequest(client: ConnectedClient, request: AgentMuxDaemonRequestFrame): Promise<void> {
    try {
      const params = asObject(request.params)
      let result: unknown
      switch (request.method) {
        case 'hello':
          result = {
            protocolVersion: AGENTMUX_DAEMON_PROTOCOL_VERSION,
            buildIdentity: this.buildIdentity,
            hostId: this.hostId,
            daemonPid: process.pid,
            daemonInstanceId: this.daemonInstanceId
          }
          break
        case 'diagnose':
          result = await inspectAgentMuxDaemonRuntime()
          break
        case 'list':
          result = this.sessions.list()
          break
        case 'find-create-operation':
          result = this.sessions.findByCreateOperation(readString(params, 'createOperationId'))
          break
        case 'probe-executable':
          result = await probeExecutable(safeExecutable(readString(params, 'executable')))
          break
        case 'create': {
          const endpoint = this.hookServer.getEndpoint()
          if (!endpoint) throw new AgentMuxError('Daemon hook ingress is unavailable.', 'HOOK_SERVER_NOT_RUNNING')
          const requested = readCreateRequest(params)
          const create: AgentMuxDaemonCreateRequest = requested.kind === 'agent'
            ? {
                ...requested,
                env: {
                  ...requested.env,
                  AGENTMUX_HOOK_URL: endpoint.url,
                  AGENTMUX_HOOK_TOKEN: endpoint.token
                }
              }
            : requested
          const session = this.sessions.create(create)
          result = session
          client.attachments.set(session.sessionId, {
            ref: { sessionId: session.sessionId, incarnationId: session.incarnationId },
            acknowledgedThrough: session.latestSequence,
            deliveredThrough: session.latestSequence
          })
          break
        }
        case 'attach': {
          const sessionId = readString(params, 'sessionId')
          const afterSequence = readNumber(params, 'afterSequence', 0)
          const attached = this.sessions.attach(sessionId, afterSequence)
          result = attached
          client.attachments.set(sessionId, this.attachmentForAttach(attached, afterSequence))
          break
        }
        case 'detach': {
          const ref = readSessionRef(params)
          const attachment = client.attachments.get(ref.sessionId)
          if (attachment?.ref.incarnationId === ref.incarnationId) client.attachments.delete(ref.sessionId)
          result = null
          break
        }
        case 'write':
          result = this.sessions.write(
            readSessionRef(params),
            readNumber(params, 'startSequence'),
            readString(params, 'data')
          )
          break
        case 'resize':
          result = this.sessions.resize(
            readSessionRef(params),
            readNumber(params, 'cols'),
            readNumber(params, 'rows')
          )
          break
        case 'ack': {
          const ref = readSessionRef(params)
          const sequence = readNumber(params, 'sequence')
          const attachment = client.attachments.get(ref.sessionId)
          if (!attachment || attachment.ref.incarnationId !== ref.incarnationId) {
            throw new AgentMuxError(`Client is not attached to session: ${ref.sessionId}`, 'SESSION_NOT_ATTACHED')
          }
          if (sequence < attachment.acknowledgedThrough) {
            throw new AgentMuxError('Output acknowledgement cannot move backwards.', 'OUTPUT_ACK_REGRESSION')
          }
          if (sequence > attachment.deliveredThrough) {
            throw new AgentMuxError('Output acknowledgement exceeds delivered output.', 'INVALID_OUTPUT_ACK')
          }
          result = this.sessions.acknowledgeOutput(ref, sequence)
          attachment.acknowledgedThrough = sequence
          break
        }
        case 'signal':
          this.sessions.signal(readSessionRef(params), readString(params, 'signal'))
          result = null
          break
        case 'stop': {
          const ref = readSessionRef(params)
          await this.sessions.stop(ref)
          for (const connected of this.clients) {
            const attachment = connected.attachments.get(ref.sessionId)
            if (attachment?.ref.incarnationId === ref.incarnationId) connected.attachments.delete(ref.sessionId)
          }
          result = null
          break
        }
        default:
          throw new AgentMuxError(`Unsupported daemon method: ${String(request.method)}`, 'INVALID_DAEMON_REQUEST')
      }
      this.write(client, { type: 'response', id: request.id, ok: true, result })
    } catch (error) {
      const response: AgentMuxDaemonResponseFrame = {
        type: 'response',
        id: request.id,
        ok: false,
        error: {
          code: isAgentMuxError(error) ? error.code : 'DAEMON_REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      this.write(client, response)
    }
  }

  private publishEvent(event: AgentMuxDaemonEvent): void {
    for (const client of this.clients) {
      const attachment = client.attachments.get(event.sessionId)
      if (!attachment || attachment.ref.incarnationId !== event.incarnationId) continue
      if (event.type === 'data') {
        if (event.startSequence !== attachment.deliveredThrough) {
          client.socket.destroy(new Error('AgentMux daemon output sequence diverged.'))
          continue
        }
        attachment.deliveredThrough = event.endSequence
        if (attachment.deliveredThrough - attachment.acknowledgedThrough > MAX_UNACKNOWLEDGED_OUTPUT_BYTES) {
          client.socket.destroy(new Error('AgentMux daemon client did not acknowledge output.'))
          continue
        }
      }
      this.write(client, { type: 'event', event })
    }
  }

  private acceptHookEvent(envelope: NativeHookEnvelope): void {
    const session = this.sessions.inspect(envelope.runId)
    if (
      !session ||
      session.kind !== 'agent' ||
      session.incarnationId !== envelope.incarnationId ||
      session.agentSessionId !== envelope.agentSessionId ||
      session.agentId !== envelope.agentId
    ) {
      return
    }
    this.publishEvent({
      type: 'hook',
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      agentSessionId: envelope.agentSessionId,
      agentId: envelope.agentId,
      ...(envelope.eventName !== undefined ? { eventName: envelope.eventName } : {}),
      ...(envelope.payload !== undefined ? { payload: envelope.payload } : {})
    })
  }

  private attachmentForAttach(attached: AgentMuxDaemonAttachResult, afterSequence: number): ClientAttachment {
    return {
      ref: {
        sessionId: attached.session.sessionId,
        incarnationId: attached.session.incarnationId
      },
      acknowledgedThrough: Math.max(afterSequence, attached.gap?.firstAvailableSequence ?? afterSequence),
      deliveredThrough: attached.session.latestSequence
    }
  }

  private write(client: ConnectedClient, frame: AgentMuxDaemonResponseFrame | { type: 'event'; event: AgentMuxDaemonEvent }): void {
    if (client.socket.destroyed) return
    const encoded = encodeAgentMuxDaemonFrame(frame)
    if (client.socket.writableLength + Buffer.byteLength(encoded) > MAX_CLIENT_BUFFER_BYTES) {
      client.socket.destroy(new Error('AgentMux daemon client is not consuming output.'))
      return
    }
    client.socket.write(encoded)
  }

  private async unlinkOwnedSocket(): Promise<void> {
    if (process.platform === 'win32' || !this.socketIdentity) return
    const owned = this.socketIdentity
    this.socketIdentity = null
    try {
      const current = await lstat(this.socketPath)
      if (current.dev === owned.dev && current.ino === owned.ino) await unlink(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
