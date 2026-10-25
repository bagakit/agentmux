import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Readable, Writable } from 'node:stream'
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws'
import { agentControlFailureCode, AgentExecutionRpcFrontend, type AgentExecutionRelayContext } from './agent-execution-rpc-relay.js'
import { createExecutionFrameChannel } from './agent-execution-channel.js'

const DEFAULT_FRAME_BYTES = 32 * 1024 * 1024
type NativeId = string | number
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nativeId = (value: unknown): value is NativeId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

export interface AgentExecutionFrontendOptions {
  input: Readable
  output: Writable
  onError: (error: Error) => void
  maxFrameBytes?: number
  agentSessionId?: string
  /** Maximum unresolved native requests per original socket. */
  maxPendingRequests?: number
}

export interface AgentExecutionFrontend {
  /** Capability URL. Send only on the private machine channel, never to logs. */
  url: string
  /** Explicit helper owner shutdown; reader detach must not call this. */
  close(): Promise<void>
}

/**
 * Loopback endpoint for the ordinary native CLI. A durable helper Run owns this
 * process and its dedicated JSONL pipes. It is not a Runtime or recovery owner.
 * Every response names the exact original socket generation; a reconnect never
 * inherits pending IDs, even if the new native peer reuses the same request ID.
 */
export async function runAgentExecutionFrontend(options: AgentExecutionFrontendOptions): Promise<AgentExecutionFrontend> {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_FRAME_BYTES
  const maxPendingRequests = options.maxPendingRequests ?? 256
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 256 || !Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) throw new TypeError('Invalid native frontend limits')
  const report = (error: unknown): void => options.onError(error instanceof Error ? error : new Error(String(error)))
  const capabilityPath = `/${randomBytes(32).toString('hex')}`
  let relay: AgentExecutionRpcFrontend | undefined
  const http = createServer((request, response) => {
    if (!relay || request.socket.remoteAddress !== '127.0.0.1' || request.method !== 'POST' || request.url !== capabilityPath + '/invocation') {
      response.writeHead(404); response.end(); return
    }
    void (async () => {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const value of request) {
        const chunk = Buffer.from(value); bytes += chunk.length
        if (bytes > 16384) throw new Error('Invocation registration exceeds its limit')
        chunks.push(chunk)
      }
      const token = await relay!.register(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ token }))
    })().catch(error => { response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: agentControlFailureCode(error) })) })
  })
  // ws enforces its native 1009 frame-size boundary before JSON decoding. That
  // protocol failure affects this socket only, not other sockets or the Run.
  const server = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: false })
  const connections = new Map<string, { socket: WebSocket; pending: Map<NativeId, number>; pendingBytes: number; initializations: Set<NativeId>; controlStarted: boolean; claim: AgentExecutionRelayContext | undefined; registrationFailure: string | undefined }>()
  let closing = false
  const sendNative = async (socket: WebSocket, payload: unknown): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) return
    const data = JSON.stringify(payload)
    if (Buffer.byteLength(data) > maxFrameBytes) throw new Error('Native response exceeds the connection frame limit')
    await new Promise<void>((resolve, reject) => socket.send(data, error => error ? reject(error) : resolve()))
  }
  const channel = createExecutionFrameChannel({
    input: options.input,
    output: options.output,
    maxFrameBytes,
    onError: report,
    onFrame: async frame => {
      try { if (await relay?.receive(frame)) return } catch { report(new Error('Agent control frame was refused')); return }
      if (!object(frame) || frame.type !== 'response' || typeof frame.generation !== 'string' || !object(frame.payload)) {
        report(new Error('Invalid native frontend response frame'))
        return
      }
      const connection = connections.get(frame.generation)
      // A late frame belongs to its vanished original socket. Never retarget it.
      if (!connection || connection.socket.readyState !== WebSocket.OPEN) return
      const payload = frame.payload
      const response = !Object.hasOwn(payload, 'method') && (Object.hasOwn(payload, 'result') || Object.hasOwn(payload, 'error'))
      if (response && (!nativeId(payload.id) || !connection.pending.has(payload.id))) return
      try {
        if (response && nativeId(payload.id) && connection.initializations.delete(payload.id) && Object.hasOwn(payload, 'result') && !connection.controlStarted) {
          connection.controlStarted = true
          await relay?.begin(frame.generation, !!connection.claim, connection.registrationFailure)
        }
        await sendNative(connection.socket, payload)
        if (response && nativeId(payload.id)) {
          connection.pendingBytes -= connection.pending.get(payload.id) ?? 0
          connection.pending.delete(payload.id)
        }
      } catch (error) { report(error) }
    },
  })
  if (options.agentSessionId) relay = new AgentExecutionRpcFrontend({ agentSessionId: options.agentSessionId, send: frame => channel.send(frame), onError: report })
  const claims = new WeakMap<WebSocket, AgentExecutionRelayContext>()
  const registrationFailures = new WeakMap<WebSocket, string>()
  http.on('upgrade', (request, socket, head) => {
    const supplied = Buffer.from(request.url ?? '')
    const expected = Buffer.from(capabilityPath)
    const token = request.url?.startsWith(capabilityPath + '/') ? request.url.slice(capabilityPath.length + 1) : undefined
    const failure = token?.startsWith('unverified/') && /^[A-Z][A-Z0-9_]{0,79}$/u.test(token.slice(11)) ? token.slice(11) : undefined
    const ordinary = supplied.length === expected.length && timingSafeEqual(supplied, expected)
    if (closing || request.socket.remoteAddress !== '127.0.0.1' || !(ordinary || failure && relay || token && relay?.available(token))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    server.handleUpgrade(request, socket, head, connection => {
      if (failure) registrationFailures.set(connection, failure)
      else if (token) claims.set(connection, relay!.claim(token, randomUUID()))
      server.emit('connection', connection, request)
    })
  })
  server.on('connection', socket => {
    const claim = claims.get(socket)
    const generation = claim?.generation ?? randomUUID()
    const connection = { socket, pending: new Map<NativeId, number>(), pendingBytes: 0, initializations: new Set<NativeId>(), controlStarted: false, claim, registrationFailure: registrationFailures.get(socket) }
    connections.set(generation, connection)
    const stream = createWebSocketStream(socket, { readableObjectMode: true, readableHighWaterMark: 1 })
    stream.on('error', report)
    socket.once('close', () => {
      connections.delete(generation)
      if (!closing) void channel.send({ type: 'closed', generation }).catch(report)
    })
    void (async () => {
      if (claim) await channel.send({ type: 'agent-rpc-context', ...claim })
      // ws pauses its socket when the stream cannot accept more messages. Await
      // the machine pipe and socket callbacks rather than accumulating payloads.
      for await (const bytes of stream) {
        let payload: unknown
        try { payload = JSON.parse(String(bytes)) } catch {
          report(new Error('Invalid native JSON; no request ID is available'))
          continue
        }
        if (!object(payload)) {
          report(new Error('Expected a native JSON-RPC object; no request ID is available'))
          continue
        }
        const request = typeof payload.method === 'string' && Object.hasOwn(payload, 'id')
        const frame = { type: 'request', generation, payload }
        // The machine envelope adds bytes to the native WS payload. Reject a
        // known, not-yet-enqueued request locally rather than leaving it pending
        // after the channel's frame-size check rejects that larger envelope.
        if (Buffer.byteLength(JSON.stringify(frame)) > maxFrameBytes) {
          if (request && nativeId(payload.id)) await sendNative(socket, { id: payload.id, error: { code: -32001, message: 'Native request exceeds the execution channel frame limit; request was not forwarded' } })
          else report(new Error('Native message exceeds the execution channel frame limit'))
          continue
        }
        if (request) {
          if (!nativeId(payload.id)) {
            report(new Error('Invalid native request ID'))
            continue
          }
          const idBytes = typeof payload.id === 'string' ? Buffer.byteLength(payload.id) : 8
          if (connection.pending.has(payload.id)) {
            // Reusing an in-flight ID cannot create a second operation. A reply
            // with that ID could falsely complete the first, so report only.
            report(new Error('Native peer reused an in-flight request ID'))
            continue
          }
          if (connection.pending.size >= maxPendingRequests || connection.pendingBytes + idBytes > maxFrameBytes) {
            await sendNative(socket, { id: payload.id, error: { code: -32001, message: 'Native execution request capacity reached; request was not forwarded' } })
            continue
          }
          connection.pending.set(payload.id, idBytes)
          if (payload.method === 'initialize') connection.initializations.add(payload.id)
          connection.pendingBytes += idBytes
        }
        try { await channel.send(frame) } catch (error) {
          // A partial pipe write is not proof that the operation was rejected.
          // Retain pending identity for the original response/recovery query.
          report(error)
        }
      }
    })().catch(report)
  })
  server.on('error', report)
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  http.on('error', report)
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Native frontend listener has no TCP address')
  const url = `ws://127.0.0.1:${address.port}${capabilityPath}`
  const close = async (): Promise<void> => {
      if (closing) return
      closing = true
      relay?.close()
      channel.close()
      // Only explicit helper owner shutdown terminates native connections.
      for (const { socket } of connections.values()) socket.terminate()
      connections.clear()
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())),
      ])
  }
  try { await channel.send({ type: 'ready', url }) } catch (error) { await close(); throw error }
  return { url, close }
}
