import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import { connectCodexNativeActor } from '@agentmux/providers/codex/native-rpc'
import { parseTerminalFrontendObservation, type AgentTerminalFrontendObservation, type AgentTerminalFrontendRecoveryRequest } from '../agent-terminal-frontend.js'
import { parseCodexConfigurationPacket, type CodexConfigurationPacket } from './codex-configuration-source.js'

export const CODEX_NATIVE_TOKEN_ENV = 'AGENTMUX_CODEX_ACTOR_TOKEN'
export const CODEX_ACTOR_ID_ENV = 'AGENTMUX_CODEX_ACTOR_ID'
export const CODEX_ACTOR_LIFECYCLE_ENV = 'AGENTMUX_CODEX_ACTOR_LIFECYCLE'
export const codexFrontendSocketPath = (token: string): string => '/tmp/amxf-' + createHash('sha256').update(token).digest('hex').slice(0, 32) + '.sock'
const unavailable = (message = 'The original managed frontend control is unconfirmed. The Session, backend and existing input remain available.') =>
  new AgentMuxError(message, 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED')
type Identity = { actorId: string; lifecycleOperationId: string; processId: number }
// Keep the declared native-session wire stable for already running actors.
// The new initialization action has its own frozen capability and target field.
type Request = Identity & { token: string; method: 'observe' | 'observe-configuration' | 'reconnect'; operationId?: string;
  expectedFrontendId?: string; nativeSessionId?: string; initializationOperationId?: string }

/** Private Provider control only. Runtime remains the sole Run/PTY/byte owner. */
export async function openCodexFrontendControl(token: string, identity: Identity, handlers: {
  current(): AgentTerminalFrontendObservation
  reconnect(request: AgentTerminalFrontendRecoveryRequest): Promise<AgentTerminalFrontendObservation>
  configuration?(nativeSessionId: string): Promise<CodexConfigurationPacket>
}) {
  const watchers = new Set<Socket>(), sockets = new Set<Socket>()
  const configurationWatchers = new Map<Socket, string>()
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => { watchers.delete(socket); configurationWatchers.delete(socket); sockets.delete(socket) })
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
          const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 512
          if (p.method === 'observe-configuration') {
            if (!handlers.configuration) throw new AgentMuxError('The original producer does not expose native configuration observation.', 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED')
            if (!id(p.nativeSessionId)) throw unavailable('The original native configuration target is invalid.')
            // Register before the original source read; its source sequence fences an interleaved push.
            configurationWatchers.set(socket, p.nativeSessionId!)
            const configuration = await handlers.configuration(p.nativeSessionId!)
            if (configuration.nativeSessionId !== p.nativeSessionId) throw unavailable('The original configuration source differs from this request.')
            socket.write(JSON.stringify({ configuration, configurationBarrier: true }) + '\n'); return
          }
          if (p.method !== 'reconnect' || !id(p.operationId) || !id(p.expectedFrontendId) ||
            (id(p.nativeSessionId) ? p.initializationOperationId !== undefined : !id(p.initializationOperationId) || p.nativeSessionId !== undefined)) throw unavailable('The original frontend recovery target is invalid.')
          const target: AgentTerminalFrontendRecoveryRequest['target'] = p.nativeSessionId
            ? { kind: 'native-session', nativeSessionId: p.nativeSessionId }
            : { kind: 'initialization', lifecycleOperationId: p.initializationOperationId! }
          const frontend = await handlers.reconnect({ operationId: p.operationId!, expectedFrontendId: p.expectedFrontendId!, target })
          socket.end(JSON.stringify({ frontend }) + '\n')
        } catch (error) { configurationWatchers.delete(socket); socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Original frontend control failed.',
          ...(error instanceof AgentMuxError ? { errorCode: error.code } : {}) }) + '\n') }
        finally { if (!watchers.has(socket) && !configurationWatchers.has(socket) && !socket.writableEnded) socket.destroy() }
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
    publishConfiguration(configuration: CodexConfigurationPacket): void {
      const bytes = JSON.stringify({ configuration }) + '\n'
      for (const [socket, nativeSessionId] of configurationWatchers) {
        if (configuration.nativeSessionId === nativeSessionId && !socket.write(bytes)) { configurationWatchers.delete(socket); socket.destroy() }
      }
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }
}

async function connect(context: Pick<Parameters<NonNullable<AgentProvider['observeTerminalFrontend']>>[0], 'nativeActor' | 'processId' | 'signal'>, method: Request['method'],
  extra: Partial<Request>, onPacket: (value: { frontend?: unknown; configuration?: unknown; configurationBarrier?: unknown }) => void | boolean, onUnavailable: (message: string) => void) {
  context.signal.throwIfAborted()
  const socket = createConnection(codexFrontendSocketPath(context.nativeActor.token))
  let closed = false, buffer = '', ready = false, rejectInitial: ((error: unknown) => void) | undefined
  const dispose = (): void => { if (closed) return; closed = true; context.signal.removeEventListener('abort', dispose); socket.destroy()
    if (!ready) rejectInitial?.(context.signal.aborted ? context.signal.reason : unavailable()) }
  context.signal.addEventListener('abort', dispose, { once: true })
  const initial = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(unavailable()), 10_000)
    rejectInitial = error => { clearTimeout(timer); reject(error) }
    const fail = (error: unknown) => { clearTimeout(timer); if (!ready) reject(error); else if (!closed) onUnavailable(error instanceof Error ? error.message : String(error)) }
    socket.on('error', fail); socket.on('close', () => { if (!closed) fail(unavailable()) })
    socket.on('data', bytes => {
      try {
        buffer += bytes.toString('utf8'); if (buffer.length > 16_384) throw unavailable()
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break
          const packet = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
          if (packet.error) {
            if (method === 'observe-configuration' && packet.errorCode === 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED') throw new AgentMuxError(
              packet.error, 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED')
            throw unavailable(packet.error)
          }
          if (onPacket(packet) === false) continue
          ready = true; clearTimeout(timer); resolve()
        }
      } catch (error) { fail(error); dispose() }
    })
  })
  socket.once('connect', () => socket.write(JSON.stringify({ ...extra, method, token: context.nativeActor.token,
    actorId: context.nativeActor.actorId, lifecycleOperationId: context.nativeActor.lifecycleOperationId, processId: context.processId }) + '\n'))
  try { await initial; return { dispose } } catch (error) { dispose(); throw error }
}
export const observeCodexTerminalFrontend: NonNullable<AgentProvider['observeTerminalFrontend']> = async context =>
  await connect(context, 'observe', {}, packet => context.onFrontend(parseTerminalFrontendObservation(packet.frontend)), context.onUnavailable)

export async function observeCodexConfigurationControl(context: Pick<Parameters<NonNullable<AgentProvider['observeTerminalFrontend']>>[0], 'nativeActor' | 'processId' | 'signal'>,
  nativeSessionId: string, onConfiguration: (value: CodexConfigurationPacket) => void, onUnavailable: (message: string) => void) {
  return await connect(context, 'observe-configuration', { nativeSessionId }, packet => {
    const value = parseCodexConfigurationPacket(packet.configuration)
    if (!value || value.nativeSessionId !== nativeSessionId) throw unavailable('The original native configuration packet is invalid.')
    onConfiguration(value)
  }, onUnavailable)
}

/** A current-value barrier on the original producer, using its existing fixed observation method. */
export async function readCodexConfigurationControl(context: Parameters<typeof observeCodexConfigurationControl>[0],
  nativeSessionId: string): Promise<CodexConfigurationPacket> {
  let result: CodexConfigurationPacket | undefined
  const handle = await connect(context, 'observe-configuration', { nativeSessionId }, packet => {
    // An earlier push may arrive while the requested source read is pending.
    if (packet.configurationBarrier !== true) return false
    const value = parseCodexConfigurationPacket(packet.configuration)
    if (!value || value.nativeSessionId !== nativeSessionId) throw unavailable('The original native configuration barrier is invalid.')
    result = value
  }, () => {})
  handle.dispose()
  if (!result || result.state !== 'confirmed') throw unavailable('The original producer could not confirm the current configuration ordering.')
  return result
}

/** Loaded membership and a same-object resume receipt are separate native facts. */
export async function joinCodexNativeFrontend(connection: Pick<Awaited<ReturnType<typeof connectCodexNativeActor>>, 'request'>,
  target: { sessionId: string; runtimeSessionId?: string }, assertCurrent: () => void | Promise<void>): Promise<void> {
  const loaded = await connection.request('thread/read', { threadId: target.sessionId, includeTurns: false })
  if (loaded?.thread?.id !== target.sessionId || loaded.thread.canAcceptDirectInput !== true ||
      typeof loaded.thread.sessionId !== 'string' || !loaded.thread.sessionId ||
      target.runtimeSessionId !== undefined && loaded.thread.sessionId !== target.runtimeSessionId) throw unavailable()
  await assertCurrent()
  const joined = await connection.request('thread/resume', { threadId: target.sessionId, excludeTurns: true })
  if (joined?.thread?.id !== target.sessionId || joined.thread.sessionId !== loaded.thread.sessionId ||
      joined.thread.canAcceptDirectInput !== true) throw unavailable()
}

export const reconnectCodexTerminalFrontend: NonNullable<AgentProvider['reconnectTerminalFrontend']> = async (context, request) => {
  if (request.target.kind === 'initialization' && !context.nativeActor.initializationControl) throw unavailable('The original Run did not declare native initialization control. Its Session and existing channels are kept.')
  if (request.target.kind === 'native-session') {
    const target = context.nativeHandle
    if (context.nativeActor.protocolId !== 'codex-app-server-v2-0.163' || target?.kind !== 'provider' ||
        target.providerId !== 'codex' || target.sessionId !== request.target.nativeSessionId) throw unavailable('The original native recovery target is unconfirmed. No frontend was dispatched.')
    const { processId, nativeActor, signal } = context
    const birth = await nativeProcessBirth(processId, signal)
    const listeners = await nativeProcessTcpListeners(processId, signal)
    if (listeners.length !== 1) throw unavailable()
    const listener = listeners[0]!, listenerBirth = await nativeProcessBirth(listener.processId, signal)
    const connection = await connectCodexNativeActor(listener.endpoint, nativeActor.token, signal, 'agentmux_frontend_reconnect')
    try {
      // Loaded membership does not prove that the original TUI can resume. Join
      // the same Native object before dispatch; do not alter its configuration.
      // A missing source leaves this operation pending, without spawning a doomed
      // frontend or consuming the actor's original reconnect operation.
      await joinCodexNativeFrontend(connection, target, context.assertCurrent)
      const after = await nativeProcessTcpListeners(processId, signal)
      if (await nativeProcessBirth(processId, signal) !== birth || await nativeProcessBirth(listener.processId, signal) !== listenerBirth ||
          after.length !== 1 || after[0]!.processId !== listener.processId || after[0]!.endpoint !== listener.endpoint) throw unavailable()
    } catch (error) {
      if (error instanceof AgentMuxError) throw error
      const failure = unavailable(`The original native frontend join is unconfirmed. The backend and input remain available. ${error instanceof Error ? error.message : String(error)}`)
      Object.defineProperty(failure, 'cause', { value: error }); throw failure
    } finally { connection.dispose() }
  }
  await context.assertCurrent()
  let result: AgentTerminalFrontendObservation | undefined
  const wire = { operationId: request.operationId, expectedFrontendId: request.expectedFrontendId,
    ...(request.target.kind === 'native-session' ? { nativeSessionId: request.target.nativeSessionId }
      : { initializationOperationId: request.target.lifecycleOperationId }) }
  const handle = await connect(context, 'reconnect', wire, packet => { result = parseTerminalFrontendObservation(packet.frontend) }, () => {})
  handle.dispose()
  if (!result) throw unavailable()
  return result
}
