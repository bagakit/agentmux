import { JSONRPCErrorCode, createJSONRPCErrorResponse, type JSONRPCRequest, type JSONRPCResponse, type JSONRPCID } from 'json-rpc-2.0'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
export { rpcRecord } from './rpc-data.js'
export type { JSONRPCRequest, JSONRPCResponse, JSONRPCID } from 'json-rpc-2.0'

export type AgentMuxRpcFrame = JSONRPCResponse | JSONRPCRequest
export const AGENTMUX_RPC_MAX_MESSAGE_BYTES = 256 * 1024
export class AgentMuxRpcError extends AgentMuxError {
  constructor(message: string, code: string, readonly rpcCode: number,
    readonly details?: unknown, readonly candidates?: unknown, detail?: string) { super(message, code, detail) }
}
export function rpcFailure(id: JSONRPCID, error: unknown): JSONRPCResponse {
  const source = error instanceof Error ? error as Error & { code?: string; detail?: string; details?: unknown; candidates?: unknown } : null
  const code = source?.code ?? 'CONTROL_FAILED'
  const numeric = code === 'INVALID_CONTROL_REQUEST' ? JSONRPCErrorCode.InvalidParams
    : code === 'RPC_METHOD_NOT_FOUND' ? JSONRPCErrorCode.MethodNotFound : -32000
  return createJSONRPCErrorResponse(id, numeric, source?.message ?? 'Public service failed.', {
    code, ...(source?.detail === undefined ? {} : { detail: source.detail }),
    ...(source?.details === undefined ? {} : { details: source.details }),
    ...(source?.candidates === undefined ? {} : { candidates: source.candidates })
  })
}
export function isRpcId(value: unknown): value is JSONRPCID {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
}
export function parseRpcRequest(value: unknown): JSONRPCRequest {
  const source = rpcRecord(value, ['jsonrpc', 'id', 'method', 'params'], 'CONTROL_PROTOCOL_ERROR')
  if (source.jsonrpc !== '2.0' || typeof source.method !== 'string' || !source.method ||
    Object.hasOwn(source, 'id') && !isRpcId(source.id)) {
    throw new AgentMuxError('Expected a JSON-RPC 2.0 request.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (source.params !== undefined && (!source.params || typeof source.params !== 'object')) {
    throw new AgentMuxError('RPC parameters must be structured.', 'INVALID_CONTROL_REQUEST')
  }
  return source as unknown as JSONRPCRequest
}
export function parseRpcResponse(value: unknown): JSONRPCResponse {
  const source = rpcRecord(value, ['jsonrpc', 'id', 'result', 'error'], 'CONTROL_PROTOCOL_ERROR')
  if (source.jsonrpc !== '2.0' || !Object.hasOwn(source, 'id') || !isRpcId(source.id) ||
    Object.hasOwn(source, 'result') === Object.hasOwn(source, 'error')) {
    throw new AgentMuxError('Invalid JSON-RPC response.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (Object.hasOwn(source, 'error')) {
    const error = rpcRecord(source.error, ['code', 'message', 'data'], 'CONTROL_PROTOCOL_ERROR')
    if (!Number.isInteger(error.code) || typeof error.message !== 'string') {
      throw new AgentMuxError('Invalid JSON-RPC error.', 'CONTROL_PROTOCOL_ERROR')
    }
    if (error.data !== undefined) {
      const data = rpcRecord(error.data, ['code', 'detail', 'details', 'candidates'], 'CONTROL_PROTOCOL_ERROR')
      if (typeof data.code !== 'string' || data.detail !== undefined && typeof data.detail !== 'string') throw new AgentMuxError('Invalid typed RPC error.', 'CONTROL_PROTOCOL_ERROR')
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
  const data = response.error.data as { code?: string; detail?: string; details?: unknown; candidates?: unknown } | undefined
  return new AgentMuxRpcError(response.error.message, data?.code ??
    (response.error.code === -32601 ? 'RPC_METHOD_NOT_FOUND' : 'CONTROL_PROTOCOL_ERROR'),
    response.error.code, data?.details, data?.candidates, data?.detail)
}
export function rpcEncode(frame: unknown): string {
  const json = JSON.stringify(frame)
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('RPC message exceeds its bounded frame budget.', 'CONTROL_PROTOCOL_ERROR')
  return json + '\n'
}
/** One bounded UTF-8 frame decoder, shared by local and remote clients. */
export class AgentMuxRpcLines {
  private readonly pending: Uint8Array[] = []
  private pendingBytes = 0
  accept(chunk: Uint8Array, onValue: (value: unknown) => void): void {
    let offset = 0
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.byteLength : newline
      const part = chunk.subarray(offset, end)
      const size = this.pendingBytes + part.byteLength
      if (size > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('RPC message exceeds its bounded frame budget.', 'CONTROL_PROTOCOL_ERROR')
      if (newline < 0) {
        this.pending.push(part.slice()); this.pendingBytes = size
        return
      }
      if (!size) throw new AgentMuxError('Empty RPC frame.', 'CONTROL_PROTOCOL_ERROR')
      let line = part
      if (this.pending.length) {
        line = new Uint8Array(size); let position = 0
        for (const piece of this.pending) { line.set(piece, position); position += piece.byteLength }
        line.set(part, position)
      }
      this.pending.length = 0; this.pendingBytes = 0
      onValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))
      offset = newline + 1
    }
  }
  end(): void {
    if (this.pendingBytes) throw new AgentMuxError('RPC stream ended with an incomplete frame.', 'CONTROL_PROTOCOL_ERROR')
  }
}
