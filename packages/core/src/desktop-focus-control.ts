import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { AgentMuxError } from './errors.js'
import { defaultAgentMuxDesktopFocusSocketPath } from './runtime-paths.js'
import type {
  AgentMuxDesktopFocusControl,
  AgentMuxResolvedViewFocus,
  AgentMuxViewFocusTarget
} from './runtime.js'

const MAX_MESSAGE_BYTES = 8 * 1024
const REQUEST_TIMEOUT_MS = 2_000

type FocusRequest = {
  version: 1
  target: AgentMuxViewFocusTarget
}

type FocusResponse =
  | { ok: true; result: AgentMuxResolvedViewFocus }
  | { ok: false; code: string; message: string }

function target(value: unknown): AgentMuxViewFocusTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Desktop focus target is invalid.', 'INVALID_DESKTOP_FOCUS_REQUEST')
  }
  const source = value as Record<string, unknown>
  const id = source.kind === 'terminal-view' ? source.viewId : source.agentSessionId
  if (
    (source.kind !== 'terminal-view' && source.kind !== 'agent-session') ||
    typeof id !== 'string' ||
    !id ||
    Buffer.byteLength(id) > 512 ||
    /[\0\r\n]/u.test(id)
  ) {
    throw new AgentMuxError('Desktop focus target is invalid.', 'INVALID_DESKTOP_FOCUS_REQUEST')
  }
  return source.kind === 'terminal-view'
    ? { kind: source.kind, viewId: id }
    : { kind: source.kind, agentSessionId: id }
}

function request(value: unknown): FocusRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Desktop focus request is invalid.', 'INVALID_DESKTOP_FOCUS_REQUEST')
  }
  const source = value as Record<string, unknown>
  if (source.version !== 1) {
    throw new AgentMuxError('Desktop focus request version is invalid.', 'INVALID_DESKTOP_FOCUS_REQUEST')
  }
  return { version: 1, target: target(source.target) }
}

function result(value: unknown): AgentMuxResolvedViewFocus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentMuxError('Desktop focus response is invalid.', 'DESKTOP_FOCUS_PROTOCOL_ERROR')
  }
  const source = value as Record<string, unknown>
  if (
    typeof source.viewId !== 'string' ||
    (source.kind !== 'terminal' && source.kind !== 'agent')
  ) {
    throw new AgentMuxError('Desktop focus response is invalid.', 'DESKTOP_FOCUS_PROTOCOL_ERROR')
  }
  return { viewId: source.viewId, kind: source.kind }
}

async function readMessage(socket: Socket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let content = ''
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onError)
    }
    const parse = (): void => {
      cleanup()
      try {
        resolve(JSON.parse(content) as unknown)
      } catch {
        reject(new AgentMuxError('Desktop focus message is invalid JSON.', 'DESKTOP_FOCUS_PROTOCOL_ERROR'))
      }
    }
    const onData = (value: Buffer): void => {
      content += value.toString('utf8')
      if (Buffer.byteLength(content) > MAX_MESSAGE_BYTES) {
        cleanup()
        reject(new AgentMuxError('Desktop focus message is too large.', 'DESKTOP_FOCUS_PROTOCOL_ERROR'))
        return
      }
      const newline = content.indexOf('\n')
      if (newline < 0) return
      const trailing = content.slice(newline + 1)
      content = content.slice(0, newline)
      if (trailing.trim()) {
        cleanup()
        reject(new AgentMuxError('Desktop focus message has trailing data.', 'DESKTOP_FOCUS_PROTOCOL_ERROR'))
        return
      }
      parse()
    }
    const onEnd = (): void => parse()
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onError)
  })
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'DESKTOP_FOCUS_FAILED'
}

async function socketIsActive(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new AgentMuxError('Desktop focus endpoint probe timed out.', 'DESKTOP_FOCUS_UNAVAILABLE'))
    }, 250)
    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      socket.destroy()
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

export class AgentMuxDesktopFocusServer {
  private server: Server | null = null

  constructor(
    private readonly control: AgentMuxDesktopFocusControl,
    readonly path = defaultAgentMuxDesktopFocusSocketPath()
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.path), 0o700)
    try {
      const metadata = await lstat(this.path)
      const uid = typeof process.getuid === 'function' ? process.getuid() : metadata.uid
      if (!metadata.isSocket() || metadata.uid !== uid || await socketIsActive(this.path)) {
        throw new AgentMuxError('Another Desktop focus owner occupies the endpoint.', 'DESKTOP_FOCUS_BUSY')
      }
      await rm(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => void this.handle(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.path, () => resolve())
      })
      await chmod(this.path, 0o600)
      this.server = server
    } catch (error) {
      server.close()
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.path, { force: true })
  }

  private async handle(socket: Socket): Promise<void> {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy())
    let response: FocusResponse
    try {
      const message = request(await readMessage(socket))
      const focused = await this.control.focus(message.target)
      response = { ok: true, result: { viewId: focused.viewId, kind: focused.kind } }
    } catch (error) {
      response = {
        ok: false,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error)
      }
    }
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`)
  }
}

export async function requestAgentMuxDesktopFocus(
  value: AgentMuxViewFocusTarget,
  path = defaultAgentMuxDesktopFocusSocketPath()
): Promise<AgentMuxResolvedViewFocus> {
  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy(new AgentMuxError('Desktop focus request timed out.', 'DESKTOP_FOCUS_TIMEOUT'))
    })
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: 1, target: value })}\n`))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error instanceof AgentMuxError) reject(error)
      else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new AgentMuxError('Desktop focus owner is unavailable.', 'DESKTOP_FOCUS_UNAVAILABLE'))
      } else reject(error)
    })
    void readMessage(socket).then(resolve, reject)
  })
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new AgentMuxError('Desktop focus response is invalid.', 'DESKTOP_FOCUS_PROTOCOL_ERROR')
  }
  const source = response as Record<string, unknown>
  if (source.ok === true) return result(source.result)
  if (source.ok === false && typeof source.code === 'string' && typeof source.message === 'string') {
    throw new AgentMuxError(source.message, source.code)
  }
  throw new AgentMuxError('Desktop focus response is invalid.', 'DESKTOP_FOCUS_PROTOCOL_ERROR')
}
