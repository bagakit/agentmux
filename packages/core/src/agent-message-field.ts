import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { validateAgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { parseChannelTranscriptQuote } from './channel-quote.js'
import { decodeBase64, encodeBase64 } from './hosted-value.js'
import type { AgentMuxMessageReadRequest, AgentMuxMessageFieldPage, AgentMuxMessageFieldRead } from './agent-message-query.js'

export function validateMessageFieldRead(input: AgentMuxMessageReadRequest): void {
  if (input.field === undefined ? input.cursor !== undefined || input.maxBytes !== undefined
    : !['body', 'channelQuote'].includes(input.field) || input.notificationId !== undefined ||
      input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 131072) ||
      input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4096 || input.maxBytes > 4 * 1024 * 1024)) {
    throw new AgentMuxError('Select one original body or channelQuote field with its own cursor and read budget. Notification metadata belongs to full-message reads.', 'INVALID_CONTROL_REQUEST')
  }
}

/** Shared public/Hosted result validation; fragments are not interpreted as original content. */
export function parseMessageFieldPage(value: unknown, input: AgentMuxMessageFieldRead, callerSessionId?: string): AgentMuxMessageFieldPage {
  const fail = (): never => { throw new AgentMuxError('The message field page does not match its original source or selected range.', 'CONTROL_PROTOCOL_ERROR') }
  validateMessageFieldRead(input)
  const object = (v: unknown, keys: readonly string[]) => rpcRecord(v, keys, 'CONTROL_PROTOCOL_ERROR')
  const p = object(value, ['field', 'sequence', 'envelope', 'entry', 'budgetBytes', 'nextCursor'])
  if (p.field !== input.field || !Number.isSafeInteger(p.sequence) || Number(p.sequence) < 1 ||
    p.budgetBytes !== (input.maxBytes ?? 16 * 1024) || p.nextCursor !== null && (typeof p.nextCursor !== 'string' || !p.nextCursor || p.nextCursor.length > 131072)) return fail()
  const raw = object(p.envelope, ['schema', 'messageId', 'operationId', 'createdAt', 'sender', 'recipient', 'threadId', 'correlationId', 'replyTo', 'workspaceId', 'senderSessionId', 'senderRunId', 'recipientSessionId', 'recipientRunId'])
  const envelope = validateAgentMuxMessageEnvelope({ ...raw, body: '' })
  if ((input.messageId === undefined ? envelope.operationId !== input.operationId : envelope.messageId !== input.messageId) ||
    callerSessionId && envelope.senderSessionId !== callerSessionId && envelope.recipientSessionId !== callerSessionId) return fail()
  const entry = object(p.entry, ['kind', 'item', 'itemId', 'encoding', 'sha256', 'offsetBytes', 'totalBytes', 'dataBase64'])
  if (entry.kind === 'item') {
    if (Object.keys(entry).some(k => !['kind', 'item'].includes(k)) || p.nextCursor !== null || input.cursor !== undefined) return fail()
    if (input.field === 'body' ? typeof entry.item !== 'string' : entry.item !== null && !parseChannelTranscriptQuote(entry.item)) return fail()
    if (input.field === 'channelQuote' && entry.item !== null) {
      try { validateAgentMuxMessageEnvelope({ ...raw, body: '', channelQuote: entry.item }) } catch { return fail() }
    }
  } else {
    if (entry.kind !== 'fragment' || entry.item !== undefined || entry.itemId !== JSON.stringify([envelope.messageId, input.field]) ||
      entry.encoding !== 'json-utf8-base64' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.offsetBytes) || Number(entry.offsetBytes) < 0 || !Number.isSafeInteger(entry.totalBytes) || Number(entry.totalBytes) < 1 ||
      typeof entry.dataBase64 !== 'string') return fail()
    let chunk: Uint8Array
    try { chunk = decodeBase64(entry.dataBase64) } catch { return fail() }
    const end = Number(entry.offsetBytes) + chunk.length
    if (!chunk.length || encodeBase64(chunk) !== entry.dataBase64 || end > Number(entry.totalBytes) ||
      input.cursor === undefined && entry.offsetBytes !== 0 || (end < Number(entry.totalBytes)) !== (p.nextCursor !== null)) return fail()
  }
  if (new TextEncoder().encode(JSON.stringify(p)).length > Number(p.budgetBytes) - 1024) return fail()
  return p as unknown as AgentMuxMessageFieldPage
}
