import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import type { DurableAgentMuxMessage } from './agent-global-message-queue.js'
import type { AgentMuxMessageFieldRead, AgentMuxMessageFieldPage } from './agent-message-query.js'
import { validateMessageFieldRead } from './agent-message-field.js'

/** A bounded projection of one immutable journal row. Nothing is consumed or copied to another store. */
export function readMessageField(message: DurableAgentMuxMessage, input: AgentMuxMessageFieldRead, journal: { queueId: string; incarnation: string }): AgentMuxMessageFieldPage {
  validateMessageFieldRead(input)
  const { body, channelQuote, channelProfile: _profile, ...envelope } = message.envelope
  const item = input.field === 'body' ? body : channelQuote ?? null
  const bytes = Buffer.from(JSON.stringify(item)), sha256 = createHash('sha256').update(bytes).digest('hex')
  const source = { ...journal, identity: createHash('sha256').update(JSON.stringify(envelope)).digest('hex'), messageId: envelope.messageId, operationId: envelope.operationId, sequence: message.sequence, field: input.field, sha256 }
  let offset = 0
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      const { offset: saved, ...scope } = cursor
      if (JSON.stringify(scope) !== JSON.stringify(source) || !Number.isSafeInteger(saved) || saved < 1 || saved >= bytes.length) throw Error('changed cursor')
      offset = saved
    } catch { throw new AgentMuxError('Keep this original MID, field, Host and continuation together. The retained message is unchanged.', 'INVALID_MESSAGE_FIELD_CURSOR') }
  }
  const next = (end: number): string | null => end === bytes.length ? null : Buffer.from(JSON.stringify({ ...source, offset: end })).toString('base64url')
  const base = { field: input.field, sequence: message.sequence, envelope, budgetBytes: input.maxBytes ?? 16 * 1024 }
  const fits = (entry: AgentMuxMessageFieldPage['entry'], nextCursor: string | null) => Buffer.byteLength(JSON.stringify({ ...base, entry, nextCursor })) <= base.budgetBytes - 1024
  if (!offset && fits({ kind: 'item', item }, null)) return { ...base, entry: { kind: 'item', item }, nextCursor: null }
  const fragment = (length: number): AgentMuxMessageFieldPage['entry'] => ({ kind: 'fragment', itemId: JSON.stringify([envelope.messageId, input.field]),
    encoding: 'json-utf8-base64', sha256, offsetBytes: offset, totalBytes: bytes.length, dataBase64: bytes.subarray(offset, offset + length).toString('base64') })
  let low = 0, high = bytes.length - offset
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(fragment(middle), next(offset + middle))) low = middle
    else high = middle - 1
  }
  if (!low) throw new AgentMuxError('The original field identity cannot fit this read budget. Increase maxBytes; the original message remains readable.', 'MESSAGE_FIELD_READ_BUDGET')
  return { ...base, entry: fragment(low), nextCursor: next(offset + low) }
}
