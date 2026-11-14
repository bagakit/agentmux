import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ImageActor } from './public-rpc-image.js'
export const CAPTURE_SEQUENCE_METHODS = { 'capture.sequence.open': 'short', 'capture.sequence.inspect': 'short', 'capture.sequence.stop': 'long', 'capture.sequence.read': 'long' } as const
export type CaptureSequenceMethod = keyof typeof CAPTURE_SEQUENCE_METHODS
export type CaptureSequenceMode = 'scroll' | 'gif'
type Ref = { hostId: string; operationId: string }
export type CaptureSequenceParams = { 'capture.sequence.open': Ref & { mode: CaptureSequenceMode }; 'capture.sequence.inspect': Ref; 'capture.sequence.stop': Ref; 'capture.sequence.read': Ref & { offsetBytes?: number; maxBytes?: number } }
export type CaptureSequenceResult = Ref & { mode: CaptureSequenceMode | null; state: 'selecting' | 'ready' | 'recording' | 'stopping' | 'review' | 'completed' | 'cancelled' | 'failed' | 'unknown'; frameCount: number; issue: string | null; artifact?: { mimeType: 'image/gif' | 'image/png'; data: string; offsetBytes: number; totalBytes: number; nextOffsetBytes: number | null; sha256: string } }
export type CaptureSequenceResults = { [M in CaptureSequenceMethod]: CaptureSequenceResult }
export type CaptureSequenceContext = { actor: ImageActor; signal?: AbortSignal; assertCurrent?(): void | Promise<void> }
export interface CaptureSequencePort { call(method: CaptureSequenceMethod, input: CaptureSequenceParams[CaptureSequenceMethod], context: CaptureSequenceContext): Promise<CaptureSequenceResult> }
export function isCaptureSequenceMethod(method: unknown): method is CaptureSequenceMethod { return typeof method === 'string' && Object.hasOwn(CAPTURE_SEQUENCE_METHODS, method) }
export function parseCaptureSequenceParams<M extends CaptureSequenceMethod>(method: M, value: unknown): CaptureSequenceParams[M] {
  const p = rpcRecord(value, method === 'capture.sequence.open' ? ['hostId', 'operationId', 'mode'] : method === 'capture.sequence.read' ? ['hostId', 'operationId', 'offsetBytes', 'maxBytes'] : ['hostId', 'operationId'], 'INVALID_CONTROL_REQUEST')
  if (![p.hostId, p.operationId].every(v => typeof v === 'string' && v.trim() && !/[\u0000-\u001f\u007f]/u.test(v)) || method === 'capture.sequence.open' && !['scroll', 'gif'].includes(String(p.mode))) throw new AgentMuxError('Capture sequences need an exact Host, original operation ID and supported mode.', 'INVALID_CONTROL_REQUEST')
  if (method === 'capture.sequence.read' && (p.offsetBytes !== undefined && (!Number.isSafeInteger(p.offsetBytes) || Number(p.offsetBytes) < 0) || p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || Number(p.maxBytes) < 1 || Number(p.maxBytes) > 8 * 1024 * 1024))) throw new AgentMuxError('Read a non-negative byte offset and at most 8 MiB per artifact page.', 'INVALID_CONTROL_REQUEST')
  return p as CaptureSequenceParams[M]
}
export function parseCaptureSequenceResult(value: unknown, input: CaptureSequenceParams[CaptureSequenceMethod]): CaptureSequenceResult {
  const p = rpcRecord(value, ['hostId', 'operationId', 'mode', 'state', 'frameCount', 'issue', 'artifact'], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== input.hostId || p.operationId !== input.operationId || ![null, 'scroll', 'gif'].includes(p.mode as null) || !['selecting', 'ready', 'recording', 'stopping', 'review', 'completed', 'cancelled', 'failed', 'unknown'].includes(String(p.state)) || !Number.isSafeInteger(p.frameCount) || Number(p.frameCount) < 0 || p.issue !== null && typeof p.issue !== 'string' || 'mode' in input && p.mode !== input.mode) throw new AgentMuxError('The sequence receipt changed its original identity or state.', 'CONTROL_PROTOCOL_ERROR')
  if (p.state === 'completed' && (!p.frameCount || p.mode === null)) throw new AgentMuxError('A completed sequence needs actual frames.', 'CONTROL_PROTOCOL_ERROR')
  if (p.artifact !== undefined) {
    const a = rpcRecord(p.artifact, ['mimeType', 'data', 'offsetBytes', 'totalBytes', 'nextOffsetBytes', 'sha256'], 'CONTROL_PROTOCOL_ERROR')
    if (p.state !== 'completed' || a.mimeType !== (p.mode === 'gif' ? 'image/gif' : 'image/png') || !['image/gif', 'image/png'].includes(String(a.mimeType)) || typeof a.data !== 'string' || !a.data.length || Buffer.from(a.data, 'base64').toString('base64') !== a.data) throw new AgentMuxError('The sequence artifact is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const ref = input as CaptureSequenceParams['capture.sequence.read'], bytes = Buffer.from(a.data as string, 'base64').length
    if (a.offsetBytes !== (ref.offsetBytes ?? 0) || !Number.isSafeInteger(a.totalBytes) || Number(a.totalBytes) <= 0 || bytes > (ref.maxBytes ?? 8 * 1024 * 1024) || Number(a.offsetBytes) + bytes > Number(a.totalBytes) || a.nextOffsetBytes !== (Number(a.offsetBytes) + bytes < Number(a.totalBytes) ? Number(a.offsetBytes) + bytes : null) || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new AgentMuxError('The original artifact byte window is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return p as CaptureSequenceResult
}
