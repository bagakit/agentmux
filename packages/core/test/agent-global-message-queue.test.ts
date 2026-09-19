import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  DurableAgentMuxMessageQueue,
  validateAgentMuxMessageEnvelope,
  type AgentMuxMessageAppendInput
} from '../src/agent-global-message-queue.js'
import { defaultAgentMuxMessageQueuePath, defaultAgentMuxRuntimeDirectory } from '../src/runtime-paths.js'

const roots: string[] = []
const exec = promisify(execFile)
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
  it('saves one first prompt condition in the existing journal across competing instances and restart', async () => {
    const first = await queue()
    const message = await first.append(input({ messageId: 'prompt-intent' }))
    expect(message.promptCondition).toBeNull()
    const capture = vi.fn(async () => ({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'predecessor' }))
    const other = new DurableAgentMuxMessageQueue(first.path)
    const later = vi.fn(async () => ({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'later-admission' }))
    expect(await Promise.all([first.preparePrompt(message.messageId, capture), other.preparePrompt(message.messageId, later)]))
      .toEqual([{ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'predecessor' },
        { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'predecessor' }])
    expect(capture).toHaveBeenCalledOnce()
    expect(later).toHaveBeenCalledOnce()
    later.mockClear()
    await first.recordDeliveryIssue(message.messageId, 'Control ACK lost', 200)
    const reopened = new DurableAgentMuxMessageQueue(first.path)
    expect(await reopened.preparePrompt(message.messageId, later)).toEqual({
      expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'predecessor' })
    expect(later).not.toHaveBeenCalled()
    const journal = await reopened.readJournal()
    expect(journal.map(record => record.kind)).toEqual(['message', 'prompt-condition', 'delivery-issue'])
    expect((await reopened.listAfter())[0]).toMatchObject({ envelope: message.envelope,
      promptCondition: { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'predecessor' } })
  })

  it('does not prepare a historical message with no proof that it preceded the first RPC', async () => {
    const durable = await queue()
    const message = await durable.append(input({ messageId: 'historical' }))
    const records = await durable.readJournal()
    const first = records[0]
    expect(first?.kind).toBe('message')
    if (first?.kind !== 'message') throw new Error('Expected the actual original message record')
    const { promptCondition: _condition, ...historical } = first
    await writeFile(durable.path, JSON.stringify(historical) + '\n')
    const reopened = new DurableAgentMuxMessageQueue(durable.path)
    const capture = vi.fn(async () => ({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null }))
    await expect(reopened.preparePrompt(message.messageId, capture)).rejects.toMatchObject({
      code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', detail: 'unknown' })
    expect(capture).not.toHaveBeenCalled()
    expect(await reopened.readJournal()).toEqual([historical])
    expect((await reopened.listAfter())[0]?.envelope).toEqual(message.envelope)
  })

  it('retains an unprepared message when capture fails before any possible RPC', async () => {
    const durable = await queue()
    const message = await durable.append(input({ messageId: 'not-dispatched' }))
    await expect(durable.preparePrompt(message.messageId, async () => { throw new Error('Snapshot unavailable') }))
      .rejects.toThrow('Snapshot unavailable')
    expect((await durable.listAfter())[0]?.promptCondition).toBeNull()
    expect(await durable.readJournal()).toHaveLength(1)
    expect(await durable.preparePrompt(message.messageId, async () => ({
      expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null
    }))).toEqual({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null })
    expect((await durable.readJournal()).map(record => record.kind)).toEqual(['message', 'prompt-condition'])
  })

  it('keeps unrelated writes available during observation and preserves the first saved condition', async () => {
    const durable = await queue(), peer = new DurableAgentMuxMessageQueue(durable.path)
    const message = await durable.append(input({ messageId: 'slow-target' }))
    let release!: () => void, observed!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { observed = resolve })
    const first = durable.preparePrompt(message.messageId, async () => {
      observed(); await gate
      return { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'earlier-read' }
    })
    await started
    let accepted = false
    const other = peer.append(input({ messageId: 'unrelated-message', operationId: 'unrelated-operation' })).then(receipt => {
      accepted = true; return receipt
    })
    try {
      await vi.waitFor(() => expect(accepted).toBe(true))
      const winner = { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: 'first-saved' }
      expect(await peer.preparePrompt(message.messageId, async () => winner)).toEqual(winner)
      release()
      expect(await first).toEqual(winner)
      const records = await durable.readJournal()
      expect(records.filter(record => record.kind === 'prompt-condition')).toEqual([
        expect.objectContaining({ messageId: message.messageId, condition: winner })])
      expect((await durable.listAfter()).map(record => record.envelope.messageId)).toEqual(['slow-target', 'unrelated-message'])
    } finally { release(); await Promise.allSettled([first, other]) }
  })

  it('preserves original intent and the last proven state across unknown Control outcomes', async () => {
    const durable = await queue()
    const message = await durable.append(input({ messageId: 'control-uncertain' }))
    const condition = await durable.preparePrompt(message.messageId, async () => ({ expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null }))
    await durable.recordDeliveryIssue(message.messageId, 'Control ACK missing', 100)
    await durable.recordDeliveryIssue(message.messageId, 'Retry result unknown\nControl reply closed', 200)
    const reopened = new DurableAgentMuxMessageQueue(durable.path)
    expect(await reopened.listAfter()).toEqual([{ sequence: message.sequence, envelope: message.envelope,
      promptCondition: condition, delivery: { state: 'queued', at: message.envelope.createdAt, reason: 'Retry result unknown\nControl reply closed' } }])
    expect((await reopened.readJournal()).filter(record => record.kind === 'delivery-issue')).toEqual([
      { kind: 'delivery-issue', sequence: 3, messageId: message.messageId, at: 100, reason: 'Control ACK missing' },
      { kind: 'delivery-issue', sequence: 4, messageId: message.messageId, at: 200, reason: 'Retry result unknown\nControl reply closed' }
    ])
    const queuedBytes = await readFile(durable.path, 'utf8')
    await expect(reopened.recordDeliveryIssue(message.messageId, 'Invalid diagnostic time', Number.NaN)).rejects.toMatchObject({
      code: 'MESSAGE_ENVELOPE_INVALID' })
    expect(await readFile(durable.path, 'utf8')).toBe(queuedBytes)
    const delivered = await reopened.recordDelivery(message.messageId, 'delivered', 300)
    expect(delivered.delivery).toEqual({ state: 'delivered', at: 300 })
    const before = await readFile(durable.path, 'utf8')
    expect(await durable.recordDeliveryIssue(message.messageId, 'Late failed Control response', 400)).toEqual(delivered)
    expect(await durable.recordDelivery(message.messageId, 'delivered', 500)).toEqual(delivered)
    expect(await readFile(durable.path, 'utf8')).toBe(before)
    expect((await durable.listAfter())[0]?.promptCondition).toEqual(condition)
  })

  it('refuses an invalid delivery transition before changing the durable journal', async () => {
    const durable = await queue()
    const message = await durable.append(input({ messageId: 'terminal-delivery' }))
    await durable.recordDelivery(message.messageId, 'failed', 100, 'A proven terminal failure')
    const before = await readFile(durable.path, 'utf8')
    await expect(durable.recordDelivery(message.messageId, 'delivered', 200)).rejects.toMatchObject({
      code: 'AGENT_DELIVERY_STATE_INVALID' })
    expect(await readFile(durable.path, 'utf8')).toBe(before)
    expect(await new DurableAgentMuxMessageQueue(durable.path).listAfter()).toEqual(await durable.listAfter())
  })

  it('uses a durable Core state location separate from the ctxmux artifact endpoint by default', () => {
    expect(defaultAgentMuxMessageQueuePath()).not.toContain(defaultAgentMuxRuntimeDirectory())
    expect(defaultAgentMuxMessageQueuePath()).toMatch(/global-messages\.ndjson$/u)
  })

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

  it('reopens the original receipt when a retry uses a new operation and timestamp', async () => {
    const durable = await queue()
    const first = await durable.append(input({ messageId: 'stable-message', operationId: 'first-op', createdAt: 100 }))
    const retry = await durable.append(input({ messageId: 'stable-message', operationId: 'retry-op', createdAt: 999 }))
    expect(retry.receiptId).toBe(first.receiptId)
    expect(await durable.readJournal()).toHaveLength(1)
  })

  it('reclaims a malformed stale lock after a writer crash', async () => {
    const durable = await queue()
    const lockPath = `${durable.path}.lock`
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, 'dead writer metadata')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    await expect(durable.append(input({ messageId: 'after-crash' }))).resolves.toMatchObject({ sequence: 1 })
  })

  it('replays an unacked non-empty batch and fences stale acknowledgements', async () => {
    const durable = await queue()
    await durable.append(input({ messageId: 'message-1' }))
    await durable.append(input({ operationId: 'request-2', messageId: 'message-2', body: 'second' }))
    const reader = { consumerId: 'recipient', readerRun: { runId: 'reader-run' } }
    const authorize = async () => {}
    const batch = await durable.check({ ...reader, limit: 1 }, authorize)
    expect(batch.messages).toHaveLength(1)
    expect(batch.generation).toBe(1)
    const reopened = new DurableAgentMuxMessageQueue(durable.path)
    const replay = await reopened.check({ ...reader, limit: 99 }, authorize)
    expect(replay.messages.map((item) => item.envelope.messageId)).toEqual(['message-1'])
    await expect(reopened.ack({ ...reader, generation: replay.generation + 1 }, authorize)).rejects.toMatchObject({ code: 'AGENT_DELIVERY_GENERATION_STALE' })
    await reopened.ack({ ...reader, generation: replay.generation }, authorize)
    await expect(reopened.ack({ ...reader, generation: replay.generation }, authorize)).rejects.toMatchObject({ code: 'AGENT_DELIVERY_GENERATION_STALE' })
    const next = await reopened.check({ ...reader, limit: 99 }, authorize)
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

  it('serializes concurrent queue instances on one durable path with one global sequence', async () => {
    const first = await queue()
    const second = new DurableAgentMuxMessageQueue(first.path)
    const [left, right] = await Promise.all([
      first.append(input({ operationId: 'concurrent-left-op', messageId: 'concurrent-left' })),
      second.append(input({ operationId: 'concurrent-right-op', messageId: 'concurrent-right' }))
    ])
    expect(new Set([left.sequence, right.sequence])).toEqual(new Set([1, 2]))
    const reopened = new DurableAgentMuxMessageQueue(first.path)
    expect((await reopened.listAfter(0)).map((item) => item.sequence)).toEqual([1, 2])
  })


  it('serializes concurrent OS processes on one durable path', async () => {
    const first = await queue()
    const modulePath = fileURLToPath(new URL('../dist/agent-global-message-queue.js', import.meta.url))
    const script = `import { DurableAgentMuxMessageQueue } from ${JSON.stringify(modulePath)}; const q = new DurableAgentMuxMessageQueue(process.env.QUEUE_PATH); await q.append(JSON.parse(process.env.QUEUE_INPUT));`
    const launch = (suffix: string) => exec(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, QUEUE_PATH: first.path, QUEUE_INPUT: JSON.stringify(input({ operationId: `process-${suffix}-op`, messageId: `process-${suffix}` })) }
    })
    await Promise.all([launch('left'), launch('right')])
    expect((await new DurableAgentMuxMessageQueue(first.path).listAfter(0)).map((item) => item.sequence)).toEqual([1, 2])
  })

  it('reclaims one stale lock safely before sixteen independent writers append', async () => {
    const first = await queue()
    const lockPath = `${first.path}.lock`
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, acquiredAt: Date.now() - 60_000 }))
    const modulePath = fileURLToPath(new URL('../dist/agent-global-message-queue.js', import.meta.url))
    const script = `import { DurableAgentMuxMessageQueue } from ${JSON.stringify(modulePath)}; const q = new DurableAgentMuxMessageQueue(process.env.QUEUE_PATH); await q.append(JSON.parse(process.env.QUEUE_INPUT));`
    const launch = (index: number) => exec(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, QUEUE_PATH: first.path, QUEUE_INPUT: JSON.stringify(input({ operationId: `stale-${index}-op`, messageId: `stale-${index}`, sender: { kind: 'agent-session', agentSessionId: `sender-${index}` } })) }
    })
    await Promise.all(Array.from({ length: 16 }, (_, index) => launch(index)))
    const records = await new DurableAgentMuxMessageQueue(first.path).listAfter(0)
    expect(records).toHaveLength(16)
    expect(records.map((item) => item.sequence)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
    expect(new Set(records.map((item) => item.envelope.sender.kind === 'agent-session' ? item.envelope.sender.agentSessionId : '')).size).toBe(16)
  })

  it('rejects requestId masquerading as messageId and malformed envelope fields', () => {
    expect(() => validateAgentMuxMessageEnvelope({ ...input(), schema: 'agentmux.a2a.v1', messageId: 'request-1' })).toThrow('Control request id')
    expect(() => validateAgentMuxMessageEnvelope({ ...input(), schema: 'agentmux.a2a.v1', messageId: 'message-2', body: undefined })).toThrow('Message body')
  })
})
