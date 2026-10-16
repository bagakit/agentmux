import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation } from '../agent-terminal-frontend.js'

export const CODEX_ACTOR_ID_ENV = 'AGENTMUX_CODEX_ACTOR_ID'
export const CODEX_ACTOR_LIFECYCLE_ENV = 'AGENTMUX_CODEX_ACTOR_LIFECYCLE'
export const codexFrontendSocketPath = (token: string): string => '/tmp/amxf-' + createHash('sha256').update(token).digest('hex').slice(0, 32) + '.sock'
const unavailable = (message = 'The original managed frontend control is unconfirmed. The Session, backend and existing input remain available.') =>
  new AgentMuxError(message, 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
type Identity = { actorId: string; lifecycleOperationId: string; processId: number }
type Request = Identity & { token: string; method: 'observe' | 'reconnect'; operationId?: string; expectedFrontendId?: string; nativeSessionId?: string }

/** Private Provider control only. Runtime remains the sole Run/PTY/byte owner. */
export async function openCodexFrontendControl(token: string, identity: Identity, handlers: {
  current(): AgentTerminalFrontendObservation
  reconnect(request: Required<Pick<Request, 'operationId' | 'expectedFrontendId' | 'nativeSessionId'>>): Promise<AgentTerminalFrontendObservation>
}) {
  const watchers = new Set<Socket>(), sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => { watchers.delete(socket); sockets.delete(socket) })
    socket.on('error', () => socket.destroy())
    let buffer = '', admitted = false
    socket.setTimeout(10_000, () => { if (!admitted) socket.destroy() })
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8')
      if (buffer.length > 16_384 || admitted) { socket.destroy(); return }
      const newline = buffer.indexOf('\n'); if (newline < 0) return
      admitted = true; socket.setTimeout(0)
      void (async () => {
        try {
          const p = JSON.parse(buffer.slice(0, newline)) as Request
          const actual = Buffer.from(p.token ?? ''), expected = Buffer.from(token)
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
            p.actorId !== identity.actorId || p.lifecycleOperationId !== identity.lifecycleOperationId || p.processId !== identity.processId) return
          if (p.method === 'observe') { watchers.add(socket); socket.write(JSON.stringify({ frontend: handlers.current() }) + '\n'); return }
          if (p.method !== 'reconnect' || ![p.operationId, p.expectedFrontendId, p.nativeSessionId].every(v => typeof v === 'string' && v.length > 0 && v.length < 512)) return
          const frontend = await handlers.reconnect(p as Required<Request>)
          socket.end(JSON.stringify({ frontend }) + '\n')
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Original frontend control failed.' }) + '\n') }
        finally { if (!watchers.has(socket) && !socket.writableEnded) socket.destroy() }
      })()
    })
  })
  const path = codexFrontendSocketPath(token), listening = once(server, 'listening')
  server.listen(path); await listening; await chmod(path, 0o600)
  return {
    publish(frontend: AgentTerminalFrontendObservation): void {
      const bytes = JSON.stringify({ frontend }) + '\n'
      for (const socket of watchers) if (!socket.write(bytes)) { watchers.delete(socket); socket.destroy() }
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }
}

async function connect(context: Parameters<NonNullable<AgentProvider['observeTerminalFrontend']>>[0], method: Request['method'],
  extra: Partial<Request>, onFrontend: (value: AgentTerminalFrontendObservation) => void, onUnavailable: (message: string) => void) {
  context.signal.throwIfAborted()
  const socket = createConnection(codexFrontendSocketPath(context.nativeActor.token))
  let closed = false, buffer = '', ready = false
  const dispose = (): void => { if (closed) return; closed = true; context.signal.removeEventListener('abort', dispose); socket.destroy() }
  context.signal.addEventListener('abort', dispose, { once: true })
  const initial = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(unavailable()), 10_000)
    const fail = (error: unknown) => { clearTimeout(timer); if (!ready) reject(error); else if (!closed) onUnavailable(error instanceof Error ? error.message : String(error)) }
    socket.on('error', fail); socket.on('close', () => { if (!closed) fail(unavailable()) })
    socket.on('data', bytes => {
      try {
        buffer += bytes.toString('utf8'); if (buffer.length > 16_384) throw unavailable()
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break
          const packet = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
          if (packet.error) throw unavailable(packet.error)
          onFrontend(parseTerminalFrontendObservation(packet.frontend)); ready = true; clearTimeout(timer); resolve()
        }
      } catch (error) { fail(error); dispose() }
    })
  })
  socket.once('connect', () => socket.write(JSON.stringify({ ...extra, method, token: context.nativeActor.token,
    actorId: context.nativeActor.actorId, lifecycleOperationId: context.nativeActor.lifecycleOperationId, processId: context.processId }) + '\n'))
  try { await initial; return { dispose } } catch (error) { dispose(); throw error }
}
export const observeCodexTerminalFrontend: NonNullable<AgentProvider['observeTerminalFrontend']> = async context =>
  await connect(context, 'observe', {}, context.onFrontend, context.onUnavailable)
export const reconnectCodexTerminalFrontend: NonNullable<AgentProvider['reconnectTerminalFrontend']> = async (context, request) => {
  let result: AgentTerminalFrontendObservation | undefined
  const handle = await connect({ ...context, onFrontend() {}, onUnavailable() {} }, 'reconnect', request, value => { result = value }, () => {})
  handle.dispose()
  if (!result) throw unavailable()
  return result
}
