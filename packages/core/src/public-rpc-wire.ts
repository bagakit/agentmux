import { JSONRPCServer, JSONRPCErrorCode, createJSONRPCErrorResponse,
  type JSONRPCRequest, type JSONRPCResponse, type JSONRPCID } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, agentMuxControlTimeoutMs } from './control.js'
import { rpcRecord } from './rpc-business-codec.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS,
  isAgentMuxRpcStream, isAgentMuxRpcMethod, type AgentMuxRpcMethod, type AgentMuxRpcParams,
  type AgentMuxRpcStreamMethod, type AgentMuxRpcStreamEvent } from './public-rpc.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext } from './public-rpc-service.js'

export type AgentMuxRpcFrame = JSONRPCResponse | JSONRPCRequest
export const AGENTMUX_RPC_MAX_MESSAGE_BYTES = AGENTMUX_CONTROL_MAX_MESSAGE_BYTES
export class AgentMuxRpcError extends AgentMuxError {
  constructor(message: string, code: string, readonly rpcCode: number,
    readonly details?: unknown, readonly candidates?: unknown) { super(message, code) }
}
export function rpcFailure(id: JSONRPCID, error: unknown): JSONRPCResponse {
  const source = error instanceof Error ? error as Error & { code?: string; details?: unknown; candidates?: unknown } : null
  const code = source?.code ?? 'CONTROL_FAILED'
  const numeric = code === 'INVALID_CONTROL_REQUEST' ? JSONRPCErrorCode.InvalidParams
    : code === 'RPC_METHOD_NOT_FOUND' ? JSONRPCErrorCode.MethodNotFound : -32000
  return createJSONRPCErrorResponse(id, numeric, source?.message ?? 'Public service failed.', {
    code, ...(source?.details === undefined ? {} : { details: source.details }),
    ...(source?.candidates === undefined ? {} : { candidates: source.candidates })
  })
}
function validId(value: unknown): value is JSONRPCID {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
}
export function parseRpcRequest(value: unknown): JSONRPCRequest {
  const source = rpcRecord(value, ['jsonrpc', 'id', 'method', 'params'], 'CONTROL_PROTOCOL_ERROR')
  if (source.jsonrpc !== '2.0' || typeof source.method !== 'string' || !source.method ||
    Object.hasOwn(source, 'id') && !validId(source.id)) {
    throw new AgentMuxError('Expected a JSON-RPC 2.0 request.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (source.params !== undefined && (!source.params || typeof source.params !== 'object')) {
    throw new AgentMuxError('RPC parameters must be structured.', 'INVALID_CONTROL_REQUEST')
  }
  return source as unknown as JSONRPCRequest
}
export function parseRpcResponse(value: unknown): JSONRPCResponse {
  const source = rpcRecord(value, ['jsonrpc', 'id', 'result', 'error'], 'CONTROL_PROTOCOL_ERROR')
  if (source.jsonrpc !== '2.0' || !Object.hasOwn(source, 'id') || !validId(source.id) ||
    Object.hasOwn(source, 'result') === Object.hasOwn(source, 'error')) {
    throw new AgentMuxError('Invalid JSON-RPC response.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (Object.hasOwn(source, 'error')) {
    const error = rpcRecord(source.error, ['code', 'message', 'data'], 'CONTROL_PROTOCOL_ERROR')
    if (!Number.isInteger(error.code) || typeof error.message !== 'string') {
      throw new AgentMuxError('Invalid JSON-RPC error.', 'CONTROL_PROTOCOL_ERROR')
    }
    if (error.data !== undefined) {
      const data = rpcRecord(error.data, ['code', 'details', 'candidates'], 'CONTROL_PROTOCOL_ERROR')
      if (typeof data.code !== 'string') throw new AgentMuxError('Invalid typed RPC error.', 'CONTROL_PROTOCOL_ERROR')
      if (data.code === 'MESSAGE_TARGET_NOT_UNIQUE') {
        if (!Array.isArray(data.candidates) || !data.candidates.length) throw new AgentMuxError('Ambiguous target lacks candidates.', 'CONTROL_PROTOCOL_ERROR')
        const ids = new Set<string>()
        for (const item of data.candidates) {
          const candidate = rpcRecord(item, ['agentSessionId', 'regionIds'], 'CONTROL_PROTOCOL_ERROR')
          if (typeof candidate.agentSessionId !== 'string' || !candidate.agentSessionId || ids.has(candidate.agentSessionId) ||
            !Array.isArray(candidate.regionIds) || !candidate.regionIds.length || candidate.regionIds.some(id => typeof id !== 'string' || !id) ||
            new Set(candidate.regionIds).size !== candidate.regionIds.length) throw new AgentMuxError('Invalid message target candidates.', 'CONTROL_PROTOCOL_ERROR')
          ids.add(candidate.agentSessionId)
        }
      }
    }
  }
  return source as unknown as JSONRPCResponse
}
export function rpcResponseError(response: JSONRPCResponse): AgentMuxRpcError | null {
  if (!response.error) return null
  const data = response.error.data as { code?: string; details?: unknown; candidates?: unknown } | undefined
  return new AgentMuxRpcError(response.error.message, data?.code ??
    (response.error.code === -32601 ? 'RPC_METHOD_NOT_FOUND' : 'CONTROL_PROTOCOL_ERROR'),
    response.error.code, data?.details, data?.candidates)
}
export function rpcEncode(frame: unknown): string {
  const json = JSON.stringify(frame)
  if (Buffer.byteLength(json) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('RPC message exceeds its bounded frame budget.', 'CONTROL_PROTOCOL_ERROR')
  return json + '\n'
}
/** A single strict decoder preserves UTF-8 across arbitrary transport chunks. */
export class AgentMuxRpcLines {
  private pending = Buffer.alloc(0)
  accept(chunk: Uint8Array, onValue: (value: unknown) => void): void {
    this.pending = Buffer.concat([this.pending, chunk])
    let newline: number
    while ((newline = this.pending.indexOf(10)) >= 0) {
      if (newline > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('RPC message exceeds its bounded frame budget.', 'CONTROL_PROTOCOL_ERROR')
      const line = this.pending.subarray(0, newline); this.pending = this.pending.subarray(newline + 1)
      if (!line.length) throw new AgentMuxError('Empty RPC frame.', 'CONTROL_PROTOCOL_ERROR')
      onValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))
    }
    if (this.pending.length > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('RPC message exceeds its bounded frame budget.', 'CONTROL_PROTOCOL_ERROR')
  }
  end(): void {
    if (this.pending.length) throw new AgentMuxError('RPC stream ended with an incomplete frame.', 'CONTROL_PROTOCOL_ERROR')
  }
}
export type AgentMuxRpcConnection = {
  signal: AbortSignal
  stream: boolean
  send(frame: AgentMuxRpcFrame): void | Promise<void>
  activate(subscriptionId: string, method: AgentMuxRpcStreamMethod, dispose: () => void | Promise<void>): void
  cancel(subscriptionId: string): Promise<boolean>
  afterResponse: Array<() => void | Promise<void>>
}

/** The maintained library owns dispatch and JSON-RPC errors; this edge enforces our business DTO. */
export class AgentMuxRpcDispatcher {
  private readonly server = new JSONRPCServer<AgentMuxRpcConnection>({ errorListener: () => {} })
  constructor(private readonly service: AgentMuxRpcService) {
    this.server.mapErrorToJSONRPCErrorResponse = (id, error) => rpcFailure(id, error) as import('json-rpc-2.0').JSONRPCErrorResponse
    for (const method of [...Object.keys(AGENTMUX_RPC_CONTROL_METHODS), ...Object.keys(AGENTMUX_RPC_NATIVE_METHODS)] as AgentMuxRpcMethod[]) {
      this.server.addMethodAdvanced(method, async (request, channel) => {
        try {
          const { caller, ...params } = rpcRecord(request.params ?? {})
          const context: AgentMuxRpcCallContext = { signal: channel.signal,
            ...(caller === undefined ? {} : { caller: rpcRecord(caller, ['agentSessionId', 'capability']) as NonNullable<AgentMuxRpcCallContext['caller']> }) }
          let result: unknown
          if (method === 'system.subscription.cancel') result = { disposed: await channel.cancel(String(params.subscriptionId ?? '')) }
          else if (isAgentMuxRpcStream(method, params)) {
            if (!channel.stream || !Object.hasOwn(request, 'id')) throw new AgentMuxError('A subscription requires a streaming request with an ID.', 'INVALID_CONTROL_REQUEST')
            const subscriptionId = crypto.randomUUID()
            let opened = false, sequence = 0, pendingBytes = 0
            let pendingFailure: AgentMuxError | undefined, draining: Promise<void> | undefined
            const pending: Array<{ event: AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>; bytes: number; resolve?: () => void }> = []
            const clear = () => { for (const item of pending.splice(0)) item.resolve?.(); pendingBytes = 0 }
            const drain = (): Promise<void> => {
              if (draining) return draining
              const task = (async () => {
                try {
                  while (pending.length && !channel.signal.aborted && !pendingFailure) {
                    const item = pending.shift()!
                    try { await channel.send({ jsonrpc: '2.0', method: 'system.subscription.event',
                      params: { subscriptionId, method, sequence: ++sequence, event: item.event } }) }
                    finally { pendingBytes = Math.max(0, pendingBytes - item.bytes); item.resolve?.() }
                  }
                  if (pendingFailure && !channel.signal.aborted) {
                    await channel.send({ jsonrpc: '2.0', method: 'system.subscription.event', params: { subscriptionId, method,
                      sequence: ++sequence, event: { type: 'error', error: { code: pendingFailure.code, message: pendingFailure.message } } } })
                    await channel.cancel(subscriptionId)
                  }
                } finally { if (channel.signal.aborted || pendingFailure) clear() }
              })()
              draining = task
              const settled = () => {
                if (draining !== task) return
                draining = undefined
                if (opened && pending.length && !channel.signal.aborted && !pendingFailure) {
                  void drain().catch(() => channel.cancel(subscriptionId))
                }
              }
              void task.then(settled, settled)
              return task
            }
            const progress = (event: AgentMuxRpcStreamEvent<AgentMuxRpcStreamMethod>): void | Promise<void> => {
              if (channel.signal.aborted || pendingFailure) return
              // All replay and live events share one bounded reader queue. A
              // synchronous journal may publish while an earlier write awaits drain.
              if (event.type === 'snapshot' && pending.at(-1)?.event.type === 'snapshot') {
                const previous = pending.pop()!; pendingBytes -= previous.bytes; previous.resolve?.()
              }
              const bytes = Buffer.byteLength(JSON.stringify(event)); pendingBytes += bytes
              if (pendingBytes > AGENTMUX_RPC_MAX_MESSAGE_BYTES) {
                pendingFailure = new AgentMuxError('Subscription exceeds its bounded reader budget. Reconnect from the last confirmed cursor.', 'CONTROL_PROTOCOL_ERROR')
                clear(); if (opened) void drain().catch(() => channel.cancel(subscriptionId)); return
              }
              let resolve: (() => void) | undefined
              const flushed = opened ? new Promise<void>(yes => { resolve = yes }) : undefined
              pending.push({ event, bytes, ...(resolve ? { resolve } : {}) })
              if (opened) void drain().catch(() => channel.cancel(subscriptionId))
              return flushed
            }
            const sub = await this.service.subscribe(method, params, progress, context)
            if (channel.signal.aborted || pendingFailure) { await sub.dispose(); if (pendingFailure) throw pendingFailure; return null }
            try { rpcEncode({ jsonrpc: '2.0', id: request.id!, result: { subscriptionId, method, initial: sub.initial } }) }
            catch (error) { await sub.dispose(); throw error }
            channel.activate(subscriptionId, method, () => sub.dispose())
            result = { subscriptionId, method, initial: sub.initial }
            channel.afterResponse.push(async () => { opened = true
              await drain()
              if (!pendingFailure && !channel.signal.aborted) await sub.start?.()
            })
          } else result = await this.service.call(method, params as AgentMuxRpcParams<typeof method>, context)
          const response = Object.hasOwn(request, 'id') ? { jsonrpc: '2.0' as const, id: request.id!, result } : null
          if (response) rpcEncode(response)
          return response
        } catch (error) { return Object.hasOwn(request, 'id') ? rpcFailure(request.id!, error) : null }
      })
    }
  }
  async receive(value: unknown, channel: AgentMuxRpcConnection): Promise<JSONRPCResponse | JSONRPCResponse[] | null> {
    if (Array.isArray(value)) {
      if (!value.length) return createJSONRPCErrorResponse(null, -32600, 'Empty RPC batch.')
      // The library collapses a single batch response. Retain the spec's array shape.
      const results = await Promise.all(value.map(item => this.receiveOne(item, { ...channel, stream: false })))
      const responses = results.filter((item): item is JSONRPCResponse => item !== null)
      return responses.length ? responses : null
    }
    return await this.receiveOne(value, channel)
  }
  private async receiveOne(value: unknown, channel: AgentMuxRpcConnection): Promise<JSONRPCResponse | null> {
    let request: JSONRPCRequest
    try { request = parseRpcRequest(value) } catch (error) {
      const numeric = error instanceof AgentMuxError && error.code === 'INVALID_CONTROL_REQUEST' ? -32602 : -32600
      const id = value && typeof value === 'object' && 'id' in value && validId(value.id) ? value.id : null
      return createJSONRPCErrorResponse(id, numeric, error instanceof Error ? error.message : 'Invalid RPC request.')
    }
    if (!isAgentMuxRpcMethod(request.method)) return Object.hasOwn(request, 'id')
      ? createJSONRPCErrorResponse(request.id!, -32601, 'Method not found.') : null
    // Bound only the response/reader handshake. Cancellation never rolls back a business Run.
    const controller = new AbortController()
    let reject!: (error: AgentMuxError) => void
    const ended = new Promise<never>((_, no) => { reject = no })
    const abort = () => { controller.abort(); reject(new AgentMuxError('RPC reader was cancelled.', 'CONTROL_CANCELLED')) }
    channel.signal.addEventListener('abort', abort, { once: true })
    const method = request.method
    const duration = Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, method)
      ? agentMuxControlTimeoutMs(AGENTMUX_RPC_CONTROL_METHODS[method as keyof typeof AGENTMUX_RPC_CONTROL_METHODS])
      : AGENTMUX_RPC_NATIVE_METHODS[method as keyof typeof AGENTMUX_RPC_NATIVE_METHODS] === 'long' ? 60_000 : 2_000
    const deadline = setTimeout(() => { controller.abort(); reject(new AgentMuxError('RPC response timed out; the business outcome is unconfirmed.', 'CONTROL_TIMEOUT')) }, duration)
    try {
      if (channel.signal.aborted) abort()
      return await Promise.race([this.server.receive(request, { ...channel, signal: controller.signal }), ended])
    } catch (error) { return Object.hasOwn(request, 'id') ? rpcFailure(request.id!, error) : null }
    finally { clearTimeout(deadline); channel.signal.removeEventListener('abort', abort) }
  }
}
