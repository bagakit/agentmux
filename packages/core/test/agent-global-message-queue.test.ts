import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DurableAgentMuxMessageQueue,
  validateAgentMuxMessageEnvelope,
  type AgentMuxMessageAppendInput
} from '../src/agent-global-message-queue.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })) ) })

function input(overrides: Partial<AgentMuxMessageAppendInput> = {}): AgentMuxMessageAppendInput {
  return {
    operationId: 'request-1',
    createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: 'sender' },
    recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    threadId: 'thread-1',
    correlationId: 'correlation-1',
    replyTo: null,
    workspaceId: 'workspace-1',
    senderSessionId: 'sender',
    senderRunId: 'run-sender',
    recipientSessionId: 'recipient',
    recipientRunId: 'run-recipient',
    body: '<amux from="sender">keep this exact body</amux>',
    ...overrides
  }
}

async function queue(options: ConstructorParameters<typeof DurableAgentMuxMessageQueue>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-global-message-'))
  roots.push(root)
  return new DurableAgentMuxMessageQueue(join(root, 'state', 'messages.ndjson'), options)
}

describe('Core-owned durable A2A global message queue', () => {
  it('keeps sender and recipient facts directional, distinct from requestId, and preserves body on reopen', async () => {
    const first = await queue()
    const left = await first.append(input())
    const right = await first.append(input({ operationId: 'request-2', sender: { kind: 'agent-session', agentSessionId: 'recipient' }, recipient: { kind: 'agent-session', agentSessionId: 'sender' } }))

    expect(left.messageId).not.toBe(left.envelope.operationId)
    expect(left.envelope.sender).toEqual({ kind: 'agent-session', agentSessionId: 'sender' })
    expect(left.envelope.recipient).toEqual({ kind: 'agent-session', agentSessionId: 'recipient' })
    expect(right.envelope.sender).toEqual({ kind: 'agent-session', agentSessionId: 'recipient' })
    expect(right.envelope.recipient).toEqual({ kind: 'agent-session', agentSessionId: 'sender' })
    expect(left.envelope.body).toBe('<amux from="sender">keep this exact body</amux>')

    const reopened = new DurableAgentMuxMessageQueue(first.path)
    const replay = await reopened.listAfter(0)
    expect(replay).toHaveLength(2)
    expect(replay.map((item) => item.sequence)).toEqual([1, 2])
    expect(replay[0]!.envelope.body).toBe(left.envelope.body)
  })

  it('is idempotent for the same operation and rejects a conflicting message id', async () => {
    const durable = await queue()
    const first = await durable.append(input({ messageId: 'message-1' }))
    const retry = await durable.append(input({ messageId: 'message-1' }))
    expect(retry).toMatchObject({ queueId: first.queueId, receiptId: first.receiptId, messageId: 'message-1', sequence: 1 })
    await expect(durable.append(input({ messageId: 'message-2' }))).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    expect(await durable.listAfter(0)).toHaveLength(1)
  })

  it('replays an unacked non-empty batch and fences stale acknowledgements', async () => {
    const durable = await queue()
    await durable.append(input({ messageId: 'message-1' }))
    await durable.append(input({ operationId: 'request-2', messageId: 'message-2', body: 'second' }))
    const batch = await durable.check('consumer-1', 1)
    expect(batch.messages).toHaveLength(1)
    expect(batch.generation).toBe(1)
    const reopened = new DurableAgentMuxMessageQueue(durable.path)
    const replay = await reopened.check('consumer-1', 99)
    expect(replay.messages.map((item) => item.envelope.messageId)).toEqual(['message-1'])
    await expect(reopened.ack('consumer-1', replay.generation + 1)).rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
    await reopened.ack('consumer-1', replay.generation)
    await expect(reopened.ack('consumer-1', replay.generation)).rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
    const next = await reopened.check('consumer-1', 99)
    expect(next.messages.map((item) => item.envelope.messageId)).toEqual(['message-2'])
  })

  it('refuses a bounded append before writing a record', async () => {
    const durable = await queue({ maxMessages: 1, maxBytes: 10_000 })
    await durable.append(input())
    await expect(durable.append(input({ operationId: 'request-2' }))).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_BACKPRESSURE' })
    expect(await durable.listAfter(0)).toHaveLength(1)
  })

  it('keeps delivery failures and their reasons in the append-only audit after reopen', async () => {
    const durable = await queue()
    const appended = await durable.append(input())
    await durable.recordDelivery(appended.messageId, 'failed', 120, 'recipient session stopped')
    const reopened = new DurableAgentMuxMessageQueue(durable.path)
    const journal = await reopened.readJournal()
    expect(journal.map((record) => record.sequence)).toEqual([1, 2])
    expect(journal[1]).toMatchObject({ kind: 'delivery', messageId: appended.messageId, state: 'failed', reason: 'recipient session stopped' })
    expect((await reopened.listAfter(0))[0]!.delivery).toMatchObject({ state: 'failed', reason: 'recipient session stopped' })
  })

  it('rejects requestId masquerading as messageId and malformed envelope fields', () => {
    expect(() => validateAgentMuxMessageEnvelope({ ...input(), schema: 'agentmux.a2a.v1', messageId: 'request-1' })).toThrow('Control request id')
    expect(() => validateAgentMuxMessageEnvelope({ ...input(), schema: 'agentmux.a2a.v1', messageId: 'message-2', body: undefined })).toThrow('Message body')
  })
})
