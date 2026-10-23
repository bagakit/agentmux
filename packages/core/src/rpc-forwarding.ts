import { createHash, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { JSONRPCClient, type JSONRPCRequest } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { mintObjectId } from './object-id.js'
import { observeRead } from './observation-read.js'
import { AgentMuxRpcLines, parseRpcRequest, parseRpcResponse, rpcEncode, rpcFailure, rpcResponseError, rpcRecord, type AgentMuxRpcFrame } from './public-rpc-frame.js'
import type { AgentMuxRpcPrincipal } from './public-rpc.js'

// Private Unix transport messages. They are deliberately absent from business
// method discovery and the public dispatcher (including HTTP and Relay).
export const RPC_FORWARD = { target: 'rpc.forward.target', call: 'rpc.forward.call', claim: 'rpc.forward.claim',
  current: 'rpc.forward.current', ended: 'rpc.forward.reader-ended' } as const
export type RpcForwardingReference = { reference: string; sourceInstanceId: string }
export type RpcForwardingSource = (request: JSONRPCRequest, destination: { path: string; instanceId: string }) => Promise<RpcForwardingReference & { dispose(): void }>
export type RpcForwardingContext = { principal?: AgentMuxRpcPrincipal; signal?: AbortSignal; assertCurrent?(): void | Promise<void> }
export type RpcForwardingPeer = {
  /** Configured by the original composition root, never read from a request. */
  authoritySocketPath: string
  /** The original Host may rebind its own verified device to its durable authority. */
  bindAuthority?(principal: AgentMuxRpcPrincipal): Promise<{ assertCurrent(): void | Promise<void> } | undefined> | { assertCurrent(): void | Promise<void> } | undefined
}
type Grant = { fingerprint: string; destination: string; context: RpcForwardingContext; claimed: boolean }
const fingerprint = (request: JSONRPCRequest) => createHash('sha256').update(rpcEncode(request)).digest('hex')
const unavailable = () => new AgentMuxError('The original forwarding authority is unavailable. Keep the original operation; no local identity was substituted.', 'CONTROL_UNAVAILABLE')
const denied = () => new AgentMuxError('The forwarded call does not match its original authority, request or receiving owner.', 'CONTROL_PERMISSION_DENIED')
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0')) throw denied(); return value }
function principal(value: unknown): AgentMuxRpcPrincipal {
  const p = rpcRecord(value, ['kind', 'id'], 'CONTROL_PROTOCOL_ERROR')
  if (p.kind !== 'device' && p.kind !== 'user') throw denied()
  return { kind: p.kind, id: text(p.id) }
}

/** Only in-flight call closures live here. Device policy and state stay at their original owner. */
export class RpcForwardingAuthority {
  readonly instanceId = mintObjectId()
  private readonly grants = new Map<string, Grant>()
  async lend(context: RpcForwardingContext, request: JSONRPCRequest, destination: { path: string; instanceId: string }) {
    if (!context.principal || context.principal.kind === 'device' && !context.assertCurrent) throw unavailable()
    context.signal?.throwIfAborted(); await observeRead(Promise.resolve().then(() => context.assertCurrent?.()), context.signal); context.signal?.throwIfAborted()
    const reference = randomBytes(32).toString('hex')
    const grant: Grant = { fingerprint: fingerprint(request), destination: destination.instanceId, context: { ...context, principal: { ...context.principal } }, claimed: false }
    this.grants.set(reference, grant)
    return { reference, sourceInstanceId: this.instanceId, dispose: () => {
      // Once claimed, the receiving business call/reader owns the borrowed
      // callback. Ending the sending reply reader cannot revoke that authority.
      if (!grant.claimed && this.grants.get(reference) === grant) this.grants.delete(reference)
    } }
  }
  async claim(value: unknown, socket: Socket, send: (frame: AgentMuxRpcFrame) => void | Promise<void>): Promise<(() => Promise<void>) & { principal: AgentMuxRpcPrincipal }> {
    const p = rpcRecord(value, ['reference', 'sourceInstanceId', 'destinationInstanceId', 'fingerprint'])
    const reference = text(p.reference), grant = this.grants.get(reference)
    if (p.sourceInstanceId !== this.instanceId || !grant || grant.claimed ||
      grant.destination !== p.destinationInstanceId || grant.fingerprint !== p.fingerprint) throw denied()
    grant.claimed = true
    const release = () => { grant.context.signal?.removeEventListener('abort', ended); if (this.grants.get(reference) === grant) this.grants.delete(reference) }
    const ended = () => { void Promise.resolve(send({ jsonrpc: '2.0', method: RPC_FORWARD.ended, params: {} })).catch(() => socket.destroy()) }
    socket.once('close', release)
    try {
      grant.context.signal?.throwIfAborted(); await grant.context.assertCurrent?.(); grant.context.signal?.throwIfAborted()
      if (socket.destroyed) throw unavailable()
      grant.context.signal?.addEventListener('abort', ended, { once: true })
      return Object.assign(async () => {
        if (socket.destroyed || this.grants.get(reference) !== grant) throw unavailable()
        // This is current *authorization*, independently of the original reader.
        await grant.context.assertCurrent?.()
        if (socket.destroyed || this.grants.get(reference) !== grant) throw unavailable()
      }, { principal: grant.context.principal! })
    } catch (error) { release(); throw error }
  }
}

/** Authenticate a forwarded request with the preconfigured original Unix owner. */
export async function receiveForwardedCall(peer: RpcForwardingPeer, value: unknown, destinationInstanceId: string, openingSignal: AbortSignal) {
  const p = rpcRecord(value, ['reference', 'sourceInstanceId', 'destinationInstanceId', 'request'])
  if (p.destinationInstanceId !== destinationInstanceId) throw denied()
  const request = parseRpcRequest(p.request)
  const reader = new AbortController(), socket = createConnection({ path: peer.authoritySocketPath })
  const lines = new AgentMuxRpcLines()
  let closed = false
  const pending = new Set<string>()
  const client = new JSONRPCClient(frame => {
    if (closed) return Promise.reject(unavailable())
    socket.write(rpcEncode(frame)); return Promise.resolve()
  })
  const close = (error?: Error) => {
    if (closed) return; closed = true
    if (error) reader.abort(error)
    socket.destroy()
    for (const id of pending) client.receive(rpcFailure(id, unavailable()))
    pending.clear()
  }
  const cancelOpening = () => close(new AgentMuxError('The forwarding reader ended before admission.', 'CONTROL_CANCELLED'))
  openingSignal.addEventListener('abort', cancelOpening, { once: true })
  socket.on('error', () => close(unavailable())); socket.once('close', () => close(unavailable()))
  socket.on('data', chunk => {
    try { lines.accept(chunk, frame => {
      if (frame && typeof frame === 'object' && (frame as { method?: unknown }).method === RPC_FORWARD.ended) {
        const notification = parseRpcRequest(frame)
        if (notification.id !== undefined || Object.keys(rpcRecord(notification.params, [])).length) throw denied()
        reader.abort(new AgentMuxError('The original forwarded request reader ended.', 'CONTROL_CANCELLED')); return
      }
      client.receive(parseRpcResponse(frame))
    }) } catch { close(unavailable()) }
  })
  const call = async (method: string, params: Record<string, unknown>) => {
    if (closed) throw unavailable()
    const id = mintObjectId(); pending.add(id)
    try {
      const response = await client.requestAdvanced({ jsonrpc: '2.0', id, method, params })
      const failure = rpcResponseError(response); if (failure) throw failure
      return response.result
    } finally { pending.delete(id) }
  }
  try {
    openingSignal.throwIfAborted()
    const claimed = rpcRecord(await call(RPC_FORWARD.claim, { reference: text(p.reference), sourceInstanceId: text(p.sourceInstanceId),
      destinationInstanceId, fingerprint: fingerprint(request) }), ['principal'])
    const actor = principal(claimed.principal)
    const local = await observeRead(Promise.resolve().then(() => peer.bindAuthority?.(actor)), openingSignal)
    openingSignal.throwIfAborted()
    if (closed) throw unavailable()
    return { request, principal: actor, signal: reader.signal,
      assertCurrent: local ? () => local.assertCurrent() : async () => { await call(RPC_FORWARD.current, {}) }, dispose: () => close() }
  } catch (error) { close(); throw error }
  finally { openingSignal.removeEventListener('abort', cancelOpening) }
}

/** Original Unix framing, optionally borrowing authenticated authority before dispatch. */
export async function openForwardedUnixRequest(path: string, request: JSONRPCRequest, source: RpcForwardingSource,
  onFrame: (value: unknown) => void, onEnd: (error?: Error) => void, signal: AbortSignal) {
  const socket = createConnection({ path, signal }), lines = new AgentMuxRpcLines()
  let closed = false, sent = false, opening = false, grant: Awaited<ReturnType<RpcForwardingSource>> | undefined
  const finish = (error?: Error) => { if (closed) return; closed = true; signal.removeEventListener('abort', abort); socket.destroy(); grant?.dispose(); onEnd(error) }
  const abort = () => finish(new AgentMuxError('The forwarding reader was cancelled; an admitted operation may still complete.', 'CONTROL_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  const handshakeId = mintObjectId()
  socket.once('connect', () => socket.write(rpcEncode({ jsonrpc: '2.0', id: handshakeId, method: RPC_FORWARD.target, params: {} })))
  socket.on('error', error => finish(new AgentMuxError(error.message, 'CONTROL_UNAVAILABLE', undefined,
    { disposition: sent ? 'unknown' : 'not_applied', confirmedInputBytes: null })))
  socket.once('end', () => { try { lines.end(); finish() } catch (error) { finish(error as Error) } })
  socket.once('close', () => finish())
  socket.on('data', chunk => {
    try { lines.accept(chunk, value => {
      if (sent) { onFrame(value); return }
      if (opening) throw denied()
      opening = true
      const response = parseRpcResponse(value)
      if (response.id !== handshakeId) throw denied()
      const failure = rpcResponseError(response); if (failure) throw failure
      const target = rpcRecord(response.result, ['instanceId'])
      void source(request, { path, instanceId: text(target.instanceId) }).then(issued => {
        grant = issued
        if (closed || signal.aborted) { issued.dispose(); return }
        sent = true
        socket.write(rpcEncode({ jsonrpc: '2.0', id: request.id!, method: RPC_FORWARD.call,
          params: { reference: issued.reference, sourceInstanceId: issued.sourceInstanceId, destinationInstanceId: target.instanceId, request } }))
      }).catch(error => finish(error instanceof Error ? error : unavailable()))
    }) } catch (error) { finish(error as Error) }
  })
  if (signal.aborted) abort()
  return { dispose: async () => { if (closed) return; closed = true; signal.removeEventListener('abort', abort); socket.destroy(); grant?.dispose() } }
}
