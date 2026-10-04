import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { JSONRPCRequest } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { parseRpcNativeResult } from './rpc-native-codec.js'
import { AgentMuxRpcLines, parseRpcRequest, parseRpcResponse, rpcEncode, rpcResponseError,
  AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-wire.js'

type Reader = { dispose(): Promise<void> }
type Consumer = { receive(frame: unknown): void; end(error?: Error): void; subscriptionId?: string; dispose(): void }
export const AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS = 30_000

/** Diagnose the exact superseded endpoint receipt without admitting it to the client. */
function validateEndpoint(value: unknown, socketPath?: string): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>
    const endpoint = result.endpoint as Record<string, unknown> | undefined
    if (Object.keys(result).sort().join(',') === 'endpoint,framing,protocol' &&
        result.protocol === 'jsonrpc-2.0' && result.framing === 'json-lines' &&
        endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint) &&
        Object.keys(endpoint).sort().join(',') === 'path,transport' && endpoint.transport === 'unix' &&
        typeof endpoint.path === 'string' && endpoint.path.startsWith('/') &&
        (socketPath === undefined || endpoint.path === socketPath)) {
      // The current validator checks every other field. This synthetic receipt is
      // diagnostic only: the original response is always refused below.
      parseRpcNativeResult('system.endpoint', { ...result, connection: 'responded' }, {})
      throw new AgentMuxError('The remote Core uses an older endpoint interface without a confirmed connection receipt. Update this service in its connection settings.',
        'REMOTE_CORE_UPGRADE_REQUIRED')
    }
  }
  parseRpcNativeResult('system.endpoint', value, {})
}

/** A transport channel only. The existing JSONRPCClient/dispatcher retain RPC ownership. */
export class AgentMuxRpcSshTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly requests = new Map<string | number, Consumer>()
  private readonly subscriptions = new Map<string, Consumer>()
  private readonly ready: Promise<void>
  private closed = false
  constructor(args: string[], private readonly onClose: () => void, socketPath?: string) {
    this.child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = new AgentMuxRpcLines(), probeId = randomUUID()
    let established = false, resolveReady!: () => void, rejectReady!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    // An unused client can be disposed while its transport is still establishing.
    void this.ready.catch(() => {})
    const timer = setTimeout(() => this.finish(new AgentMuxError('SSH RPC transport did not establish within its connection budget. Its owner and Runs were preserved.', 'CONTROL_TIMEOUT')), AGENTMUX_RPC_SSH_TRANSPORT_BUDGET_MS)
    const failed = (error: Error) => { clearTimeout(timer); rejectReady(error) }
    this.rejectReady = failed
    this.child.stderr.resume()
    this.child.once('error', () => this.finish(new AgentMuxError('SSH RPC transport could not start.', 'CONTROL_UNAVAILABLE')))
    this.child.stdin.once('error', () => this.finish(new AgentMuxError('SSH RPC transport input ended; business outcomes are unconfirmed.', 'CONTROL_UNAVAILABLE')))
    this.child.stdout.once('error', () => this.finish(new AgentMuxError('SSH RPC transport output ended; business outcomes are unconfirmed.', 'CONTROL_UNAVAILABLE')))
    this.child.once('exit', () => this.finish(new AgentMuxError('SSH RPC transport exited; its owner and Runs were preserved.', 'CONTROL_UNAVAILABLE')))
    this.child.stdout.once('end', () => {
      try { lines.end(); this.finish(new AgentMuxError('SSH RPC transport ended; its owner and Runs were preserved.', 'CONTROL_UNAVAILABLE')) }
      catch { this.finish(new AgentMuxError('SSH RPC transport ended with an incomplete frame.', 'CONTROL_PROTOCOL_ERROR')) }
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return
      try { lines.accept(chunk, frame => {
        if (!established) {
          const response = parseRpcResponse(frame)
          if (response.id !== probeId) throw new AgentMuxError('SSH RPC establishment response belongs to another request.', 'CONTROL_PROTOCOL_ERROR')
          const error = rpcResponseError(response); if (error) throw error
          validateEndpoint(response.result, socketPath)
          established = true; clearTimeout(timer); resolveReady(); return
        }
        if (frame && typeof frame === 'object' && Object.hasOwn(frame, 'id')) {
          const response = parseRpcResponse(frame), consumer = response.id === null ? undefined : this.requests.get(response.id)
          const result = response.result as { subscriptionId?: unknown } | undefined
          if (!consumer) {
            // A cancelled opening can establish later. Its returned lease still
            // belongs to this channel and must be released, without touching peers.
            if (!response.error && typeof result?.subscriptionId === 'string') this.write({ jsonrpc: '2.0', method: 'system.subscription.cancel', params: { subscriptionId: result.subscriptionId } })
            return
          }
          if (!response.error && typeof result?.subscriptionId === 'string') {
            consumer.subscriptionId = result.subscriptionId; this.subscriptions.set(result.subscriptionId, consumer)
          }
          consumer.receive(frame)
        } else {
          const notification = parseRpcRequest(frame)
          if (notification.id !== undefined || notification.method !== 'system.subscription.event') throw new AgentMuxError('SSH RPC channel received an invalid notification.', 'CONTROL_PROTOCOL_ERROR')
          const id = (notification.params as { subscriptionId?: unknown } | undefined)?.subscriptionId
          if (typeof id !== 'string') throw new AgentMuxError('SSH RPC notification lacks its reader identity.', 'CONTROL_PROTOCOL_ERROR')
          this.subscriptions.get(id)?.receive(frame)
        }
      }) } catch (error) { this.finish(error instanceof AgentMuxError ? error : new AgentMuxError('SSH RPC framing failed.', 'CONTROL_PROTOCOL_ERROR')) }
    })
    this.write({ jsonrpc: '2.0', id: probeId, method: 'system.endpoint', params: {} })
  }
  private rejectReady: (error: Error) => void
  private write(request: JSONRPCRequest): void {
    const encoded = rpcEncode(request)
    if (this.child.stdin.writableLength + Buffer.byteLength(encoded) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('SSH RPC input exceeded its bounded transport budget; this intent is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
    this.child.stdin.write(encoded)
  }
  private finish(error: Error): void {
    if (this.closed) return; this.closed = true
    this.rejectReady(error); this.onClose()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
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
    if (this.closed) throw new AgentMuxError('SSH RPC channel is unavailable.', 'CONTROL_UNAVAILABLE')
    const id = request.id!
    let disposed = false
    const dispose = () => {
      if (disposed) return; disposed = true; signal.removeEventListener('abort', abort)
      this.requests.delete(id)
      if (consumer.subscriptionId) {
        this.subscriptions.delete(consumer.subscriptionId)
        if (!this.closed) {
          try { this.write({ jsonrpc: '2.0', method: 'system.subscription.cancel', params: { subscriptionId: consumer.subscriptionId } }) }
          catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))) }
        }
      }
    }
    const abort = () => { dispose(); end(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')) }
    const consumer: Consumer = { receive, end, dispose }
    this.requests.set(id, consumer); signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); throw new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED') }
    try { onEstablished(); this.write(request) } catch (error) { dispose(); throw error }
    return { dispose: async () => { dispose() } }
  }
  dispose(): void { this.finish(new AgentMuxError('RPC client was disposed.', 'CONTROL_CANCELLED')) }
}
