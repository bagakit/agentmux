import { sha256 } from '@noble/hashes/sha2.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import { AgentMuxError } from './errors.js'

/** Temporary bytes for one scoped read unit. Never render or acknowledge an incomplete unit. */
export type JsonReadAssembly = {
  scopeKey: string
  itemId: string
  sha256: string
  totalBytes: number
  receivedBytes: number
  bytes: Uint8Array
}
export type JsonReadEntry<T = unknown> = { kind: 'item'; item: T } | {
  kind: 'fragment'; itemId: string; encoding: 'json-utf8-base64'; sha256: string
  offsetBytes: number; totalBytes: number; dataBase64: string
}
/** Scope is the exact accepted Host/Session/source/cut, not an event association key.
 * The caller supplies its original protocol's assembly bound and parses the complete DTO.
 * This only verifies original transport bytes; it confers no author/input/delivery authority.
 */
export function consumeJsonReadEntry<T>(input: {
  scopeKey: string; entry: JsonReadEntry<T>; pending?: JsonReadAssembly; maxTotalBytes: number
}): { kind: 'pending'; pending: JsonReadAssembly } | { kind: 'complete'; value: T } {
  const bad = (): never => { throw new AgentMuxError('Original JSON read fragments changed scope, version, order or integrity. Retain the original cursor/cut and retry its read.', 'CONTROL_PROTOCOL_ERROR') }
  const { entry, pending, scopeKey, maxTotalBytes } = input
  if (!scopeKey || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) return bad()
  if (entry.kind === 'item') { if (pending) return bad(); return { kind: 'complete', value: entry.item } }
  if (entry.kind !== 'fragment' || entry.encoding !== 'json-utf8-base64' || !entry.itemId || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 1 || entry.totalBytes > maxTotalBytes ||
    !Number.isSafeInteger(entry.offsetBytes) || entry.offsetBytes < 0) return bad()
  let chunk: Uint8Array
  try { chunk = decodeBase64(entry.dataBase64) } catch { return bad() }
  if (!chunk.length || encodeBase64(chunk) !== entry.dataBase64 || entry.offsetBytes + chunk.length > entry.totalBytes) return bad()
  if (pending && (pending.scopeKey !== scopeKey || pending.itemId !== entry.itemId || pending.sha256 !== entry.sha256 ||
    pending.totalBytes !== entry.totalBytes || pending.bytes.byteLength !== entry.totalBytes || pending.receivedBytes !== entry.offsetBytes)) return bad()
  if (!pending && entry.offsetBytes !== 0) return bad()
  const assembly = pending ?? { scopeKey, itemId: entry.itemId, sha256: entry.sha256, totalBytes: entry.totalBytes,
    receivedBytes: 0, bytes: new Uint8Array(entry.totalBytes) }
  assembly.bytes.set(chunk, entry.offsetBytes)
  const receivedBytes = entry.offsetBytes + chunk.length
  if (receivedBytes < entry.totalBytes) return { kind: 'pending', pending: { ...assembly, receivedBytes } }
  const digest = Array.from(sha256(assembly.bytes), byte => byte.toString(16).padStart(2, '0')).join('')
  if (digest !== entry.sha256) return bad()
  try { return { kind: 'complete', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assembly.bytes)) as T } } catch { return bad() }
}
