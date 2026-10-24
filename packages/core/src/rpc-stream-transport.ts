import type { Readable, Writable } from 'node:stream'
import type { JSONRPCRequest } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { AgentMuxRpcLines, parseRpcRequest, parseRpcResponse, rpcEncode, rpcResponseError } from './public-rpc-frame.js'

type Reader = { dispose(): Promise<void> }
type Consumer = { receive(frame: unknown): void; end(error?: Error): void; subscriptionId?: string; dispose(): void }
type PendingWrite = { encoded: string; signal: AbortSignal | undefined; dispatch: (() => void) | undefined; resolve(): void; reject(error: Error): void; abort(): void }

/** Physical framing is shared; each original request and subscription retains its own reader. */
export class AgentMuxRpcStreamTransport {
  private readonly requests = new Map<string | number, Consumer>()
  private readonly subscriptions = new Map<string, Consumer>()
  private readonly writes = new Set<PendingWrite>()
  private waitingDrain = false
  private flushing = false
  private failure?: Error
  private readonly ready: Promise<void>
  private closed = false
  constructor(private readonly carrier: { input: Writable; output: Readable; close(): void },
    private readonly onClose: () => void,
    options: { ready?: Promise<void>; probe?: { request: JSONRPCRequest; validate(value: unknown): void }; budgetMs?: number;
      failure?(error: Error): Error } = {}) {
    const lines = new AgentMuxRpcLines(), probe = options.probe
    let established = false, resolveReady!: () => void, rejectReady!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    void this.ready.catch(() => {})
    const timer = options.budgetMs === undefined ? undefined : setTimeout(() => this.fail(new AgentMuxError(
      'RPC transport did not establish within its connection budget. Its owner and Runs were preserved.', 'CONTROL_TIMEOUT')), options.budgetMs)
    this.rejectReady = error => { clearTimeout(timer); rejectReady(error) }
    const establishedNow = () => { if (!this.closed) { established = true; clearTimeout(timer); resolveReady() } }
    const failed = (error: Error) => this.fail(options.failure?.(error) ?? new AgentMuxError(
      'RPC transport ended; business outcomes are unconfirmed.', 'CONTROL_CONNECTION_FAILED'))
    carrier.input.once('error', failed)
    if (!Object.is(carrier.output, carrier.input)) {
      carrier.output.once('error', failed)
      carrier.input.once('close', () => this.fail(new AgentMuxError('RPC transport input closed; business outcomes are unconfirmed.', 'CONTROL_CONNECTION_FAILED')))
    }
    carrier.input.on('drain', () => { this.waitingDrain = false; this.flushWrites() })
    carrier.output.once('end', () => {
      try { lines.end(); this.fail(new AgentMuxError('RPC transport ended; its owner and Runs were preserved.', 'CONTROL_CONNECTION_FAILED')) }
      catch { this.fail(new AgentMuxError('RPC transport ended with an incomplete frame.', 'CONTROL_PROTOCOL_ERROR')) }
    })
    carrier.output.once('close', () => this.fail(new AgentMuxError('RPC transport closed; business outcomes are unconfirmed.', 'CONTROL_CONNECTION_FAILED')))
    carrier.output.on('data', (chunk: Buffer) => {
      if (this.closed) return
      try { lines.accept(chunk, frame => {
        if (!established) {
          const response = parseRpcResponse(frame)
          if (!probe || response.id !== probe.request.id) throw new AgentMuxError('RPC establishment response belongs to another request.', 'CONTROL_PROTOCOL_ERROR')
          const error = rpcResponseError(response); if (error) throw error
          probe.validate(response.result)
          establishedNow(); return
        }
        if (frame && typeof frame === 'object' && Object.hasOwn(frame, 'id')) {
          const response = parseRpcResponse(frame), consumer = response.id === null ? undefined : this.requests.get(response.id)
          const result = response.result as { subscriptionId?: unknown } | undefined
          if (!consumer) {
            // A cancelled opening can establish later. Its returned lease still
            // belongs to this channel and must be released, without touching peers.
            if (!response.error && typeof result?.subscriptionId === 'string') void this.write({ jsonrpc: '2.0', method: 'system.subscription.cancel', params: { subscriptionId: result.subscriptionId } })
              .catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
            return
          }
          if (!response.error && typeof result?.subscriptionId === 'string') {
            consumer.subscriptionId = result.subscriptionId; this.subscriptions.set(result.subscriptionId, consumer)
          }
          consumer.receive(frame)
        } else {
          const notification = parseRpcRequest(frame)
          if (notification.id !== undefined || notification.method !== 'system.subscription.event') throw new AgentMuxError('RPC channel received an invalid notification.', 'CONTROL_PROTOCOL_ERROR')
          const id = (notification.params as { subscriptionId?: unknown } | undefined)?.subscriptionId
          if (typeof id !== 'string') throw new AgentMuxError('RPC notification lacks its reader identity.', 'CONTROL_PROTOCOL_ERROR')
          this.subscriptions.get(id)?.receive(frame)
        }
      }) } catch (error) { this.fail(error instanceof AgentMuxError ? error : new AgentMuxError('RPC framing failed.', 'CONTROL_PROTOCOL_ERROR')) }
    })
    void Promise.resolve(options.ready).then(() => {
      if (this.closed) return
      if (probe) return this.write(probe.request)
      else establishedNow()
    }).catch(error => this.fail(error))
  }
  private rejectReady: (error: Error) => void
  private async write(request: JSONRPCRequest, signal?: AbortSignal, dispatch?: () => void): Promise<void> {
    const encoded = rpcEncode(request)
    if (this.closed) throw this.failure!
    return await new Promise<void>((resolve, reject) => {
      const entry: PendingWrite = { encoded, signal, dispatch, resolve, reject, abort: () => {
        if (!this.writes.delete(entry)) return
        signal?.removeEventListener('abort', entry.abort)
        reject(new AgentMuxError('RPC reader was cancelled before dispatch.', 'CONTROL_CANCELLED'))
      } }
      this.writes.add(entry); signal?.addEventListener('abort', entry.abort, { once: true })
      if (signal?.aborted) entry.abort()
      this.flushWrites()
    })
  }
  private flushWrites(): void {
    if (this.closed || this.waitingDrain || this.flushing) return
    this.flushing = true
    try {
      for (const entry of this.writes) {
        this.writes.delete(entry); entry.signal?.removeEventListener('abort', entry.abort)
        try {
          entry.dispatch?.()
          if (entry.signal?.aborted) throw new AgentMuxError('RPC reader was cancelled before dispatch.', 'CONTROL_CANCELLED')
        } catch (error) { entry.reject(error instanceof Error ? error : new Error(String(error))); continue }
        try {
          this.waitingDrain = !this.carrier.input.write(entry.encoded)
          entry.resolve()
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); entry.reject(this.failure!); break }
        if (this.waitingDrain || this.closed) break
      }
    } finally { this.flushing = false }
  }
  fail(error: Error): void {
    if (this.closed) return; this.closed = true; this.failure = error
    for (const entry of this.writes) { entry.signal?.removeEventListener('abort', entry.abort); entry.reject(error) }
    this.writes.clear()
    this.rejectReady(error); this.onClose()
    this.carrier.close()
    for (const consumer of [...this.requests.values()]) consumer.end(error)
    this.requests.clear(); this.subscriptions.clear()
  }
  async open(request: JSONRPCRequest, receive: Consumer['receive'], end: Consumer['end'], signal: AbortSignal,
    onEstablished: () => void): Promise<Reader> {
    let abortWaiting!: () => void
    const cancelled = new Promise<never>((_, reject) => { abortWaiting = () => reject(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')) })
    signal.addEventListener('abort', abortWaiting, { once: true })
    try { if (signal.aborted) abortWaiting(); await Promise.race([this.ready, cancelled]) }
    finally { signal.removeEventListener('abort', abortWaiting) }
    if (this.closed) throw new AgentMuxError('RPC channel is unavailable.', 'CONTROL_UNAVAILABLE')
    const id = request.id!
    let disposed = false
    const dispose = () => {
      if (disposed) return; disposed = true; signal.removeEventListener('abort', abort)
      this.requests.delete(id)
      if (consumer.subscriptionId) {
        this.subscriptions.delete(consumer.subscriptionId)
        if (!this.closed) {
          void this.write({ jsonrpc: '2.0', method: 'system.subscription.cancel', params: { subscriptionId: consumer.subscriptionId } })
            .catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
        }
      }
    }
    const abort = () => { dispose(); end(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')) }
    const consumer: Consumer = { receive, end, dispose }
    this.requests.set(id, consumer); signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED') }
    try { await this.write(request, signal, onEstablished) } catch (error) { dispose(); throw error }
    return { dispose: async () => { dispose() } }
  }
  dispose(): void { this.fail(new AgentMuxError('RPC client was disposed.', 'CONTROL_CANCELLED')) }
}
