import { AgentMuxError } from './errors.js'

/** JSON preserves ordered bytes and optional tuple arguments; text is never re-encoded as output. */
export function encodeHostedValue(value: unknown): unknown {
  if (value === undefined) return { $agentmuxValue: 'undefined' }
  if (value instanceof Uint8Array) {
    return { $agentmuxValue: 'bytes', data: encodeBase64(value) }
  }
  if (Array.isArray(value)) return value.map(encodeHostedValue)
  if (value && typeof value === 'object') {
    // A valid SDK dictionary can contain our marker key. Escape that ordinary record
    // once so its data cannot be mistaken for an undefined/bytes transport value.
    if (Object.hasOwn(value, '$agentmuxValue')) {
      return { $agentmuxValue: 'record', entries: Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]) }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeHostedValue(item)]))
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
    typeof value === 'number' && !Number.isFinite(value)) {
    throw new AgentMuxError('This SDK argument cannot cross a public RPC connection.', 'INVALID_CONTROL_REQUEST')
  }
  return value
}

export function decodeHostedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeHostedValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.$agentmuxValue === 'record' && Object.keys(record).length === 2 && Array.isArray(record.entries)) {
      return Object.fromEntries(record.entries.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new AgentMuxError('RPC record entries are malformed.', 'CONTROL_PROTOCOL_ERROR')
        }
        return [entry[0], decodeHostedValue(entry[1])]
      }))
    }
    if (record.$agentmuxValue === 'undefined' && Object.keys(record).length === 1) return undefined
    if (record.$agentmuxValue === 'bytes' && Object.keys(record).length === 2 && typeof record.data === 'string') {
      try {
        return decodeBase64(record.data)
      } catch { throw new AgentMuxError('RPC bytes are not valid base64.', 'CONTROL_PROTOCOL_ERROR') }
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeHostedValue(item)]))
  }
  return value
}

import type { AgentMuxHostedTransferChunk } from './hosted-client-contract.js'

export const AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES = 48 * 1024
export const AGENTMUX_HOSTED_TRANSFER_MAX_BYTES = 32 * 1024 * 1024
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
function isBase64(data: string): boolean {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  // A flat scan keeps budget-sized images from exhausting the RegExp call stack.
  return data.length % 4 === 0 && !/[^A-Za-z0-9+/]/u.test(data.slice(0, data.length - padding))
}
export function decodeBase64(data: string): Uint8Array {
  if (!isBase64(data)) {
    throw new AgentMuxError('RPC bytes are not valid base64.', 'CONTROL_PROTOCOL_ERROR')
  }
  const binary = atob(data)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
/** An observation carrier, never a replay ledger or a byte authority. */
export function hostedTransfer(value: unknown, transferId: string): AgentMuxHostedTransferChunk[] {
  const bytes = new TextEncoder().encode(JSON.stringify(encodeHostedValue(value)))
  if (bytes.length > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES) throw new AgentMuxError(
    'This observation exceeds its reader budget; the original Run remains live.', 'RUNTIME_READER_BUDGET_EXCEEDED')
  const chunks: AgentMuxHostedTransferChunk[] = []
  for (let offset = 0; offset < bytes.length; offset += AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES)
    chunks.push({ transferId, index: chunks.length, dataBase64: encodeBase64(bytes.subarray(offset, end)), final: end === bytes.length })
  }
  return chunks
}
export class AgentMuxHostedTransferReader {
  private id: string | null = null
  private index = 0
  private length = 0
  private chunks: Uint8Array[] = []
  accept(chunk: AgentMuxHostedTransferChunk): unknown | undefined {
    parseHostedTransferChunk(chunk)
    if (this.id === null) { this.id = chunk.transferId; this.index = 0 }
    if (this.id !== chunk.transferId || chunk.index !== this.index++) throw new AgentMuxError(
      'Runtime transfer sequence does not match this reader.', 'CONTROL_PROTOCOL_ERROR')
    const bytes = decodeBase64(chunk.dataBase64)
    if (bytes.length > AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES || (this.length += bytes.length) > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES) {
      throw new AgentMuxError('Runtime transfer exceeds its reader budget.', 'CONTROL_PROTOCOL_ERROR')
    }
    this.chunks.push(bytes)
    if (!chunk.final) return undefined
    const value = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.chunks) { value.set(part, offset); offset += part.length }
    this.id = null; this.index = 0; this.length = 0; this.chunks = []
    return decodeHostedValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)))
  }
}

function wireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new AgentMuxError('Runtime DTO is malformed.', 'CONTROL_PROTOCOL_ERROR')
  }
  return value as Record<string, unknown>
}
function wireString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AgentMuxError('Runtime identity is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function wireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AgentMuxError('Runtime identity count is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
export function parseHostedRuntimeOwnerIdentity(value: unknown): import('./hosted-client-contract.js').AgentMuxRuntimeOwnerIdentity {
  const p = wireRecord(value, ['runtimeId', 'ownerInstanceId', 'protocolVersion', 'processId', 'ctxmux', 'availability'])
  wireString(p.runtimeId); wireString(p.ownerInstanceId); wireCount(p.processId)
  if (p.protocolVersion !== 1 || p.availability !== 'connected' && p.availability !== 'unverified') throw new AgentMuxError(
    'Runtime owner identity is malformed.', 'CONTROL_PROTOCOL_ERROR')
  const native = wireRecord(p.ctxmux, ['hostId', 'instanceId', 'processId', 'buildIdentity', 'protocolVersion', 'ownership'])
  wireString(native.hostId); wireString(native.instanceId); wireString(native.buildIdentity); wireCount(native.protocolVersion)
  if (native.processId !== null) wireCount(native.processId)
  if (native.ownership !== undefined && native.ownership !== 'owned' && native.ownership !== 'unverified') throw new AgentMuxError(
    'Native Runtime ownership is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return p as unknown as import('./hosted-client-contract.js').AgentMuxRuntimeOwnerIdentity
}
export function parseHostedTransferChunk(value: unknown): AgentMuxHostedTransferChunk {
  const p = wireRecord(value, ['transferId', 'index', 'dataBase64', 'final'])
  wireString(p.transferId); wireCount(p.index)
  if (typeof p.final !== 'boolean' || typeof p.dataBase64 !== 'string' ||
    !isBase64(p.dataBase64)) throw new AgentMuxError(
      'Runtime transfer frame is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return p as AgentMuxHostedTransferChunk
}
export function parseHostedBootstrap(value: unknown): import('./hosted-client-contract.js').AgentMuxHostedBootstrap {
  const p = wireRecord(value, ['owner', 'identity', 'storePath', 'hostProcessId', 'catalog', 'sessions', 'messageQueuePath'])
  parseHostedRuntimeOwnerIdentity(p.owner); wireCount(p.hostProcessId); wireString(p.messageQueuePath)
  if (p.storePath !== null) wireString(p.storePath)
  if (!Array.isArray(p.sessions) || !Array.isArray(p.catalog) || !p.identity || typeof p.identity !== 'object') throw new AgentMuxError(
    'Runtime bootstrap is malformed.', 'CONTROL_PROTOCOL_ERROR')
  return p as unknown as import('./hosted-client-contract.js').AgentMuxHostedBootstrap
}
