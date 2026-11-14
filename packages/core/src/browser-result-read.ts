import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export type BrowserResultReadInput = { sequence: number; offset?: number; maxBytes?: number }
export type BrowserResultReadProjection = {
  /** null means the optional observation could not identify its returned step. */
  sequence: number | null
  status: 'available' | 'not-recorded' | 'unavailable'
  chunk?: {
    reference: { kind: 'browser-result-artifact'; id: string; workspaceId: string; browserId: string; operationId: string; navigationId: string;
      format: 'json'; byteLength: number; capturedAt: number; maxReadBytes: number }
    encoding: 'base64'; data: string; offset: number; returnedBytes: number; totalBytes: number; nextOffset: number | null
    readCost: { metadataBytes: number; payloadBytes: number }
  }
  warning?: string
}
const fail = (): never => { throw new AgentMuxError('The original Browser step result is invalid or unavailable.', 'CONTROL_PROTOCOL_ERROR') }
const count = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail()
  return value
}
const id = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value) ? value : fail()
export function parseBrowserResultReadInput(value: unknown): BrowserResultReadInput {
  const row = rpcRecord(value, ['sequence', 'offset', 'maxBytes'], 'INVALID_CONTROL_REQUEST')
  try { return { sequence: count(row.sequence, 1), ...(row.offset === undefined ? {} : { offset: count(row.offset) }),
    ...(row.maxBytes === undefined ? {} : { maxBytes: count(row.maxBytes, 1, 65536) }) } }
  catch { throw new AgentMuxError('A result read requires a positive step, nonnegative offset and 1–65536 bytes.', 'INVALID_CONTROL_REQUEST') }
}
export function parseBrowserResultReadProjection(value: unknown, operationId: string, browserId?: string): BrowserResultReadProjection {
  const row = rpcRecord(value, ['sequence', 'status', 'chunk', 'warning'], 'CONTROL_PROTOCOL_ERROR')
  const sequence = row.sequence === null ? null : count(row.sequence, 1)
  if (row.status !== 'available' && row.status !== 'not-recorded' && row.status !== 'unavailable') return fail()
  const warning = row.warning === undefined ? undefined : id(row.warning)
  if (row.status !== 'available') {
    if (row.chunk !== undefined || row.status === 'not-recorded' && sequence === null) return fail()
    return { sequence, status: row.status, ...(warning ? { warning } : {}) }
  }
  if (sequence === null) return fail()
  const c = rpcRecord(row.chunk, ['reference', 'encoding', 'data', 'offset', 'returnedBytes', 'totalBytes', 'nextOffset', 'readCost'], 'CONTROL_PROTOCOL_ERROR')
  const r = rpcRecord(c.reference, ['kind', 'id', 'workspaceId', 'browserId', 'operationId', 'navigationId', 'format', 'byteLength', 'capturedAt', 'maxReadBytes'], 'CONTROL_PROTOCOL_ERROR')
  const cost = rpcRecord(c.readCost, ['metadataBytes', 'payloadBytes'], 'CONTROL_PROTOCOL_ERROR')
  if (r.kind !== 'browser-result-artifact' || r.format !== 'json' || r.maxReadBytes !== 65536 || r.operationId !== operationId ||
      browserId !== undefined && r.browserId !== browserId || c.encoding !== 'base64' || typeof c.data !== 'string' || c.data.length > 90000) return fail()
  const offset = count(c.offset), returnedBytes = count(c.returnedBytes, 0, 65536), totalBytes = count(c.totalBytes, 1, 8 * 1024 * 1024)
  const bytes = Buffer.from(c.data, 'base64'), end = offset + returnedBytes
  if (bytes.length !== returnedBytes || bytes.toString('base64') !== c.data || totalBytes !== r.byteLength || end > totalBytes || c.nextOffset !== (end < totalBytes ? end : null) || returnedBytes === 0 && offset !== totalBytes) return fail()
  return { sequence, status: 'available', chunk: {
    reference: { kind: r.kind, id: id(r.id), workspaceId: id(r.workspaceId), browserId: id(r.browserId), operationId, navigationId: id(r.navigationId), format: 'json',
      byteLength: totalBytes, capturedAt: count(r.capturedAt), maxReadBytes: 65536 }, encoding: 'base64', data: c.data, offset, returnedBytes, totalBytes,
    nextOffset: c.nextOffset as number | null, readCost: { metadataBytes: count(cost.metadataBytes), payloadBytes: count(cost.payloadBytes) }
  }, ...(warning ? { warning } : {}) }
}
