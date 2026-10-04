import { afterEach, expect, it, vi } from 'vitest'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function fixture() {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  return { ...f, queue: new DurableAgentMuxMessageQueue(join(f.root, 'messages.ndjson')) }
}
function input(index: number, body = 'Original message 中🙂', recipient = 'archive'): AgentMuxMessageAppendInput {
  return { messageId: `m-${index}`, operationId: `op-${index}`, createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: 'caller' },
    recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: recipient,
    recipientRunId: `run-${recipient}`, threadId: 'original-thread', correlationId: `correlation-${index}`,
    replyTo: null, workspaceId: null, body }
}

it('completed message history does not bar new admission, idempotent retry or cold receipt reads', async () => {
  const f = await fixture()
  const first = await f.queue.append(input(0))
  for (const [index, state] of ['delivered', 'accepted', 'replied'].entries()) {
    await f.queue.recordDelivery(first.messageId, state as 'delivered' | 'accepted' | 'replied', 101 + index)
  }
  // Expand the actual owner's valid lifecycle. No active work or large individual envelope is required.
  const template = await f.queue.readJournal()
  const records = Array.from({ length: 2048 }, (_, index) => template.map((record, offset) => record.kind === 'message'
    ? { ...record, sequence: index * 4 + offset + 1, envelope: { schema: 'agentmux.a2a.v1', ...input(index) } }
    : { ...record, sequence: index * 4 + offset + 1, messageId: `m-${index}` })).flat()
  await writeFile(f.queue.path, records.map(value => JSON.stringify(value)).join('\n') + '\n')
  const owner = new DurableAgentMuxMessageQueue(f.queue.path)
  const added = await owner.append(input(2048))
  const reopened = new DurableAgentMuxMessageQueue(f.queue.path)
  expect(await reopened.append(input(2048))).toEqual(added)
  await expect(reopened.append(input(2048, 'Different original body'))).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  const restored = await reopened.listAfter()
  expect(restored).toHaveLength(2049)
  expect(restored[0]).toMatchObject({ envelope: first.envelope, delivery: { state: 'replied', at: 103 } })
  expect(restored.at(-1)).toMatchObject({ envelope: added.envelope })
  expect((await reopened.readJournal()).filter(record => record.kind === 'message')).toHaveLength(2049)
})

it('a large retained journal still records terminal facts, public send, consumption and Dispatch', async () => {
  const f = await fixture(), count = 700, oldBudget = 16 * 1024 * 1024
  await f.queue.append(input(0, '', 'recipient'))
  const template = (await f.queue.readJournal())[0]!
  if (template.kind !== 'message') throw new Error('Expected actual owner message record')
  const records = Array.from({ length: count }, (_, index) => ({ ...template, sequence: index + 1,
    envelope: { schema: 'agentmux.a2a.v1', ...input(index, '', index === 0 ? 'recipient' : 'archive') } }))
  const headers = Buffer.byteLength(records.map(value => JSON.stringify(value)).join('\n') + '\n')
  const textBytes = oldBudget - 50 - headers, each = Math.floor(textBytes / count)
  const journal = records.map((record, index) => JSON.stringify({ ...record, envelope: { ...record.envelope,
    body: 'x'.repeat(each + (index === count - 1 ? textBytes % count : 0)) } })).join('\n') + '\n'
  expect(each).toBeLessThan(64 * 1024)
  expect(Buffer.byteLength(journal)).toBe(oldBudget - 50)
  await writeFile(f.queue.path, journal)
  await f.queue.recordDelivery('m-0', 'delivered', 101)
  await f.queue.recordDelivery('m-0', 'accepted', 102)
  await f.queue.recordDelivery('m-0', 'replied', 103)
  expect((await stat(f.queue.path)).size).toBeGreaterThan(oldBudget)

  // The real RPC admission/author/receipt path consumes the same queue. Only Native Input is a fixture.
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockResolvedValue(undefined)
  const service = new AgentMuxRpcService({ coreClients: f.coreClients }); cleanups.push(() => service.dispose())
  const sent = await service.call('agent.send', { operationId: 'after-old-byte-cap', messageId: 'new-public',
    target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: 'New original message 中🙂' }, { caller: f.credentials })
  expect(sent).toMatchObject({ messageId: 'new-public', delivery: { state: 'delivered' },
    envelope: { body: 'New original message 中🙂', senderSessionId: 'caller', recipientSessionId: 'recipient' } })
  expect(submit).toHaveBeenCalledOnce()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: f.coreClients })
  await server.start(); cleanups.push(() => server.stop())
  const run = async (agentSessionId: string, args: string[]) => {
    const result = await runCompiledObjectCli(args, objectCliEnvironment(f.root, { AGENTMUX_ENV: '1',
      AGENTMUX_AGENT_SESSION_ID: agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.capability }))
    expect(result.code, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout); expect(receipt.ok).toBe(true)
    return receipt.result
  }
  const batch = await run('recipient', ['message', 'inbox', 'check', '--limit', '5'])
  expect(batch.messages.map((item: { envelope: { messageId: string } }) => item.envelope.messageId)).toEqual(['m-0', 'new-public'])
  const ack = await run('recipient', ['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId])
  expect(ack.acknowledgedMessageIds).toEqual(['m-0', 'new-public'])
  const opened = await run('caller', ['message', 'dispatch', 'open', '--source-message', 'm-0'])
  expect(opened).toMatchObject({ sourceMessageId: 'm-0', ownerAgentSessionId: 'caller', workerAgentSessionId: 'recipient', originAwaits: true })
  await service.call('agent.send', { operationId: 'large-journal-done', messageId: 'done-public',
    target: { kind: 'agent-session', agentSessionId: 'caller' }, text: 'Explicit done', replyTo: 'm-0', threadId: 'original-thread' },
  { caller: { agentSessionId: 'recipient', capability: f.capability } })
  const done = await run('recipient', ['message', 'dispatch', 'report', '--source-message', 'm-0', '--reply-message', 'done-public', '--kind', 'worker_done'])
  expect(done).toMatchObject({ sourceMessageId: 'm-0', originAwaits: false, events: [{ replyMessageId: 'done-public', kind: 'worker_done' }] })
  const reopened = new DurableAgentMuxMessageQueue(f.queue.path), restored = await reopened.listAfter()
  expect(restored).toHaveLength(702)
  expect(restored[0]).toMatchObject({ envelope: { messageId: 'm-0', body: 'x'.repeat(each) }, delivery: { state: 'replied', at: 103 } })
  expect((await reopened.check({ consumerId: 'recipient', readerRun: { runId: 'run-recipient' }, limit: 5 }, async () => {})).messages).toEqual([])
  expect(await readFile(f.queue.path, 'utf8')).toContain('New original message 中🙂')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 30_000)
