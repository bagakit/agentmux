import { rpcRecord } from './rpc-data.js'
import { parseConversationRef } from './session-history-changes.js'
import { AgentMuxError } from './errors.js'
import type { ConversationRef } from './conversation.js'
import type { AgentSessionHistorySource } from './types.js'
export type ConversationSnapshotInput = ConversationRef & { source: AgentSessionHistorySource; after?: string; limit?: number }
export type ConversationSnapshotReleaseInput = ConversationRef & { source: AgentSessionHistorySource; reference: string }
export type ConversationSnapshotPage = ConversationRef & { source: AgentSessionHistorySource; snapshots: { reference: string; purpose: 'scope' | 'range'; start: number; end: number; createdAt: number; released: boolean }[]; next: string | null }
export type ConversationSnapshotReleaseResult = ConversationRef & { source: AgentSessionHistorySource; reference: string; released: true }
const text = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 16_384) throw new AgentMuxError('An exact original snapshot identity is required.', 'INVALID_CONTROL_REQUEST'); return value }
export function parseConversationSnapshotInput(value: unknown, release = false): ConversationSnapshotInput | ConversationSnapshotReleaseInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', ...(release ? ['reference'] : ['after', 'limit'])]), s = rpcRecord(p.source, ['providerId', 'nativeSessionId'])
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId }), source = { providerId: text(s.providerId), nativeSessionId: text(s.nativeSessionId) }
  if (release) return { ...ref, source, reference: text(p.reference) }
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) throw new AgentMuxError('Snapshot listing requires a limit from 1 to 100.', 'INVALID_CONTROL_REQUEST')
  return { ...ref, source, ...(p.after === undefined ? {} : { after: text(p.after) }), ...(p.limit === undefined ? {} : { limit: Number(p.limit) }) }
}
export function parseConversationSnapshotResult(value: unknown, input: ConversationSnapshotInput | ConversationSnapshotReleaseInput): ConversationSnapshotPage | ConversationSnapshotReleaseResult {
  const release = 'reference' in input, p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', ...(release ? ['reference', 'released'] : ['snapshots', 'next'])], 'CONTROL_PROTOCOL_ERROR')
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || !p.source || typeof p.source !== 'object' || rpcRecord(p.source, ['providerId', 'nativeSessionId']).providerId !== input.source.providerId || rpcRecord(p.source, ['providerId', 'nativeSessionId']).nativeSessionId !== input.source.nativeSessionId) throw new AgentMuxError('The snapshot receipt belongs to another source.', 'CONTROL_PROTOCOL_ERROR')
  if (release) { if (p.reference !== input.reference || p.released !== true) throw new AgentMuxError('The exact snapshot release was not confirmed.', 'CONTROL_PROTOCOL_ERROR'); return p as ConversationSnapshotReleaseResult }
  if (!Array.isArray(p.snapshots) || p.snapshots.length > (input.limit ?? 30) || p.next !== null && typeof p.next !== 'string') throw new AgentMuxError('The snapshot page is malformed.', 'CONTROL_PROTOCOL_ERROR')
  for (const value of p.snapshots) { const s = rpcRecord(value, ['reference', 'purpose', 'start', 'end', 'createdAt', 'released'], 'CONTROL_PROTOCOL_ERROR'); if (typeof s.reference !== 'string' || !['scope', 'range'].includes(String(s.purpose)) || ![s.start, s.end, s.createdAt].every(n => Number.isSafeInteger(n) && Number(n) >= 0) || Number(s.end) < Number(s.start) || typeof s.released !== 'boolean') throw new AgentMuxError('The snapshot metadata is malformed.', 'CONTROL_PROTOCOL_ERROR') }
  return p as ConversationSnapshotPage
}
