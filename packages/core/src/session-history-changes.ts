import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { normalizeSessionHistoryPage, SESSION_HISTORY_MAX_PAGE_BYTES } from './session-history.js'
import type { AgentProviderSessionHistoryContext, AgentSessionHistoryItem, AgentSessionHistorySource } from './types.js'
import type { ConversationRef } from './conversation.js'

/** A read continuation in one exact original source; never an input or sharing capability. */
export type NativeConversationCheckpoint = {
  agentSessionId: string
  source: AgentSessionHistorySource
  cursor: string
}
export type NativeConversationCheckpointPage = ConversationRef & { checkpoint: NativeConversationCheckpoint }
export type NativeConversationChangesInput = ConversationRef & { checkpoint: NativeConversationCheckpoint; limit?: number }
export type NativeConversationChangesPage = ConversationRef & {
  source: AgentSessionHistorySource
  items: AgentSessionHistoryItem[]
  checkpoint: NativeConversationCheckpoint
  more: boolean
}
export type ProviderConversationChangesContext = Omit<AgentProviderSessionHistoryContext, 'cursor'> & {
  after?: string
  tail?: true
  /** Cut-only at the original source beginning, without consuming its first record. Not combined with after/tail. */
  head?: true
}
export type ProviderConversationChangesPage = { source: AgentSessionHistorySource; items: AgentSessionHistoryItem[]; cursor: string; more: boolean }

function rpcString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new AgentMuxError(`${label} requires bounded original identity.`, 'INVALID_CONTROL_REQUEST')
  return value
}

export function parseConversationRef(value: unknown): ConversationRef {
  const p = rpcRecord(value, ['hostId', 'agentSessionId'])
  return { hostId: rpcString(p.hostId, 'Host ID'), agentSessionId: rpcString(p.agentSessionId, 'Session ID') }
}
export function parseNativeConversationCheckpoint(value: unknown): NativeConversationCheckpoint {
  const p = rpcRecord(value, ['agentSessionId', 'source', 'cursor']), source = rpcRecord(p.source, ['providerId', 'nativeSessionId'])
  return { agentSessionId: rpcString(p.agentSessionId, 'Session ID'),
    source: { providerId: rpcString(source.providerId, 'Provider ID'), nativeSessionId: rpcString(source.nativeSessionId, 'Native Session ID') },
    cursor: rpcString(p.cursor, 'Source cursor') }
}
export function parseNativeConversationChangesInput(value: unknown): NativeConversationChangesInput {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'checkpoint', 'limit'])
  const ref = parseConversationRef({ hostId: p.hostId, agentSessionId: p.agentSessionId }), checkpoint = parseNativeConversationCheckpoint(p.checkpoint)
  if (checkpoint.agentSessionId !== ref.agentSessionId || !Number.isSafeInteger(p.limit ?? 30) || Number(p.limit ?? 30) < 1 || Number(p.limit ?? 30) > 100) {
    throw new AgentMuxError('Changes require the original Session checkpoint and a limit from 1 to 100.', 'INVALID_CONTROL_REQUEST')
  }
  return { ...ref, checkpoint, ...(p.limit === undefined ? {} : { limit: p.limit as number }) }
}
export function parseNativeConversationChangesPage(value: unknown, input: NativeConversationChangesInput): NativeConversationChangesPage {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'source', 'items', 'checkpoint', 'more'], 'CONTROL_PROTOCOL_ERROR')
  const checkpoint = parseNativeConversationCheckpoint(p.checkpoint)
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || checkpoint.agentSessionId !== input.agentSessionId ||
      checkpoint.source.providerId !== input.checkpoint.source.providerId || checkpoint.source.nativeSessionId !== input.checkpoint.source.nativeSessionId || typeof p.more !== 'boolean') {
    throw new AgentMuxError('Conversation changes belong to another source or original Session.', 'CONTROL_PROTOCOL_ERROR')
  }
  const page = normalizeSessionHistoryPage(input.checkpoint.source, { source: p.source, items: p.items, nextCursor: null }, input.limit ?? 30)
  const result = { hostId: input.hostId, agentSessionId: input.agentSessionId, source: page.source, items: page.items, checkpoint, more: p.more }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SESSION_HISTORY_MAX_PAGE_BYTES) throw new AgentMuxError('Conversation changes exceed the bounded wire page.', 'CONTROL_PROTOCOL_ERROR')
  return result
}

export function parseNativeConversationCheckpointPage(value: unknown, input: ConversationRef): NativeConversationCheckpointPage {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'checkpoint'], 'CONTROL_PROTOCOL_ERROR'), checkpoint = parseNativeConversationCheckpoint(p.checkpoint)
  if (p.hostId !== input.hostId || p.agentSessionId !== input.agentSessionId || checkpoint.agentSessionId !== input.agentSessionId)
    throw new AgentMuxError('Conversation checkpoint belongs to another original Session.', 'CONTROL_PROTOCOL_ERROR')
  return { ...input, checkpoint }
}
