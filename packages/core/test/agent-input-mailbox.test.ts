import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { AgentMuxClient } from '../src/client.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import { AgentMuxError } from '../src/errors.js'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readRoutedInputMailbox, DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAgentInputMailboxPage, consumeAgentInputMailboxEntry } from '../src/agent-input-mailbox-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ingressFixture } from '../../connectors/test/fixtures/ingress.js'
import { messageJournalIo } from './helpers/message-journal-io.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function owner() {
  const h = await rpcOwnerFixture(['recipient', 'other']); cleanup.push(h.close)
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  return { ...h, queue }
}
function input(operationId: string, prompt = 'Same original body') { return { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId, prompt,
  admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true, sourceChannel: 'message-tool' as const } }
function key(submissionId: string) { return { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId } }

it('reads real local inputs, original wait generations and immutable distinct keys without dispatch on reading', async () => {
  const h = await owner()
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const first = await h.client.submitAgentPrompt(input('first'))
  const second = await h.client.submitAgentPrompt(input('second'))
  expect(first).toMatchObject({ key: key('first'), status: 'waiting' }); expect(second).toMatchObject({ key: key('second') })
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', limit: 1 })
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'item', item: { kind: 'controlled', intent: { key: key('second'), source: { prompt: 'Same original body', sourceChannel: 'message-tool' } }, receipt: { status: 'waiting', ref: { waitGeneration: 1 } } } })
  expect(page.nextCursor).toBeTruthy(); expect(page.coverage.unrecorded).toBe('unconfirmed')
  const next = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', limit: 1, cursor: page.nextCursor! })
  expect(next.items).toHaveLength(1); expect(next.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: key('first') } } }); expect(next.nextCursor).toBeNull()
  await h.client.stopAgentInputWaiting({ ref: (first as AgentInputSubmissionReceipt).ref, cancelOperationId: 'stop-original' })
  const stopped = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(stopped.items[1]).toMatchObject({ kind: 'item', item: { receipt: { key: key('first'), ref: { waitGeneration: 1 }, status: 'stopped' } } })
  const more = await h.client.submitAgentPrompt(input('later'))
  expect(more).toMatchObject({ status: 'waiting' })
  const frozen = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', cursor: page.nextCursor! })
  expect(frozen.items).toHaveLength(1); expect(frozen.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: key('first') }, receipt: { status: 'stopped' } } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('rejects foreign recipient, journal and tampered continuations while the original input stays usable', async () => {
  const h = await owner()
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await expect(h.client.readAgentInputMailbox({ agentSessionId: 'missing-recipient' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await h.client.submitAgentPrompt(input('A')); await h.client.submitAgentPrompt(input('B'))
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', limit: 1 })
  await h.client.submitAgentPrompt({ ...input('other-original'), agentSessionId: 'other', expectedRun: { runId: 'run-other' } })
  await expect(h.client.readAgentInputMailbox({ agentSessionId: 'other', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_CURSOR' })
  const foreign = new DurableAgentMuxMessageQueue(join(h.root, 'another-journal'))
  await expect(foreign.readInputMailbox({ agentSessionId: 'recipient', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_CURSOR' })
  await expect(h.client.readAgentInputMailbox({ agentSessionId: 'recipient', cursor: page.nextCursor!.slice(0, -2) + 'xx' })).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_CURSOR' })
  expect((await h.client.inspectAgentInput({ key: key('A') }))?.status).toBe('waiting')
  const db = new DatabaseSync(h.client.agentMessageQueuePath())
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT intent_sequence FROM input_intents WHERE recipient_id=? AND intent_sequence<? ORDER BY intent_sequence DESC LIMIT ?').all('recipient', 100000, 2)
    expect(JSON.stringify(plan)).toContain('input_recipient_order')
  } finally { db.close() }
})

it('keeps DurableIngress and local prompt in the same authoritative mailbox over public RPC with original external identity and unknown receipt', async () => {
  const f = await ingressFixture(false); cleanup.push(f.close)
  const received = await f.receive(), dispatched = await f.ingress.dispatch(received.ingress.ingressId)
  const ingress = dispatched.ingress!
  if (ingress.kind === 'action' || !ingress.input) throw new Error('The actual inbound message was not accepted as a message input')
  const original = ingress.input
  expect(dispatched.inputReceipt?.key.kind).toBe('message')
  await f.client.submitAgentPrompt({ ...input('local-input', f.event().body), agentSessionId: f.input.agentSessionId, expectedRun: f.session.run })
  const rpc = new AgentMuxRpcService({ coreClients: f.coreClients })
  const response = await rpc.call('agent.input.ls', { hostId: 'local', agentSessionId: f.input.agentSessionId }, { principal: { kind: 'user', id: 'reader' } }).then(page => ({ page, error: null }), error => ({ page: null, error }))
  expect(response.error).toBeNull()
  const page = response.page!
  expect(page.items).toHaveLength(2)
  expect(page.items[1]).toMatchObject({ kind: 'item', item: { kind: 'controlled', intent: { key: { kind: 'message', messageId: original.messageId, expectedRun: f.session.run }, source: { originalControlOperationId: original.operationId } }, sourceChannel: 'agent-message', message: { body: f.event().body, sender: original.author }, receipt: { originalControlOperationId: original.operationId, status: 'waiting' } } })
  expect(original.messageId).not.toBe(original.operationId)
  const before = f.inner.kernel.input as ReturnType<typeof vi.fn>; expect(before).not.toHaveBeenCalled()
  const restarted = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  const stored = await restarted.readInputMailbox({ agentSessionId: f.input.agentSessionId })
  expect(stored.items).toHaveLength(2); expect(stored.items[1]).toMatchObject({ intent: { key: dispatched.inputReceipt!.key } })
  await f.ingress.dispatch(received.ingress.ingressId)
  expect((await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })).items).toHaveLength(2)
  expect(before).not.toHaveBeenCalled()
})

it('uses strict response identity and does not turn forged input attempts into another message', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await h.client.submitAgentPrompt(input('strict'))
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(parseAgentInputMailboxPage(page, { agentSessionId: 'recipient' })).toEqual(page)
  const reordered: any = structuredClone(page)
  reordered.items[0].item.intent.key = Object.fromEntries(Object.entries(reordered.items[0].item.intent.key).reverse())
  reordered.items[0].item.receipt.ref.key = Object.fromEntries(Object.entries(reordered.items[0].item.receipt.ref.key).reverse())
  expect(parseAgentInputMailboxPage(reordered, { agentSessionId: 'recipient' })).toEqual(page)
  for (const alter of [
    (p: any) => { p.agentSessionId = 'other' },
    (p: any) => { p.items[0].item.intent.key.submissionId = 'another-message' },
    (p: any) => { p.items[0].item.receipt.ref = { ...p.items[0].item.receipt.ref, waitGeneration: p.items[0].item.receipt.ref.waitGeneration + 1 } },
    (p: any) => { p.items[0].item.receipt.status = 'admitted' },
    (p: any) => { p.items[0].item.intent.environment = {} },
    (p: any) => { p.items.push(p.items[0]) }
  ]) {
    const forged = structuredClone(page); alter(forged)
    expect(() => parseRpcNativeResult('agent.input.ls', { ...forged, hostId: 'local' }, { hostId: 'local', agentSessionId: 'recipient' })).toThrow()
  }
})

it('records a newly accepted exact-condition claim as read-only and never turns it into manual waiting', async () => {
  const h = await owner()
  const exact = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'exact-original', afterSubmissionId: null, prompt: 'Exact original input', execution: 'immediate' as const, allowUncertainTurn: true }
  await h.client.submitAgentPrompt(exact)
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ kind: 'item', item: { kind: 'submission', key: key('exact-original'), record: { admission: { inputKey: key('exact-original'), intent: { admissionIntent: { kind: 'exact-condition' } } } } } })
  expect(await h.client.inspectAgentInput({ key: key('exact-original') })).toBeNull()
  const writes = (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length
  await h.client.submitAgentPrompt(exact)
  await expect(h.client.submitAgentPrompt(input('exact-original', exact.prompt))).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  expect((await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
})

it('retains producer ownership across controlled and read-only variants without inventing a replacement claim', async () => {
  const h = await owner(), original = key('recorded-original')
  await h.queue.recordInputSubmission(original, 1)
  await h.queue.recordInputSubmission(original, 1)
  await expect(h.queue.recordInputSubmission({ kind: 'message', agentSessionId: original.agentSessionId, expectedRun: original.expectedRun, messageId: original.submissionId }, 2)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  await expect(h.queue.inspectInput({ key: { kind: 'message', agentSessionId: original.agentSessionId, expectedRun: original.expectedRun, messageId: original.submissionId } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await h.queue.savePromptInput({ key: original, admissionIntent: { kind: 'manual-actor', expectedRun: original.expectedRun }, execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', prompt: 'Retained input' } })).toBeNull()
  await expect(h.client.submitAgentPrompt(input(original.submissionId, 'Retained input'))).rejects.toMatchObject({ code: 'AGENT_INPUT_READ_UNCONFIRMED' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(page.items[0]).toMatchObject({ kind: 'item', item: { kind: 'submission', key: original, record: null, failure: { code: 'AGENT_INPUT_READ_UNCONFIRMED' } } })
})

it('preserves other rows and original content when one exact admission observation is unavailable', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await h.client.submitAgentPrompt(input('unavailable')); await h.client.submitAgentPrompt(input('available'))
  const read = h.client.inspectAgentPromptSubmission.bind(h.client)
  vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockImplementation(async key => {
    if (key.kind === 'prompt' && key.submissionId === 'unavailable') throw new AgentMuxError('Only this original observation failed', 'PRIVATE_OBSERVATION_UNAVAILABLE')
    return await read(key)
  })
  const page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(page.items).toHaveLength(2)
  expect(page.items[0]).toMatchObject({ kind: 'item', item: { receipt: { status: 'waiting' } } })
  expect(page.items[1]).toMatchObject({ kind: 'item', item: { intent: { key: key('unavailable'), source: { prompt: 'Same original body' } }, receipt: null, failure: { code: 'PRIVATE_OBSERVATION_UNAVAILABLE' } } })
  expect(parseAgentInputMailboxPage(page, { agentSessionId: 'recipient' })).toEqual(page)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('reuses exact JSON fragments for a legal full-size input and rejects mixing a changed original receipt', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const body = '\0'.repeat(65535) + 'x', saved = await h.client.submitAgentPrompt(input('full-size', body))
  // The membership cut does not freeze a mutable receipt. Begin the complete
  // byte read after the original owner's first waiting observation is durable.
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('full-size') }))?.control.waiting?.phase).toBe('runtime')
  let cursor: string | undefined, pending: import('../src/json-read-fragments.js').JsonReadAssembly | undefined
  let complete: import('../src/agent-input-mailbox.js').AgentInputMailboxItem | undefined, fragments = 0
  do {
    const request = { agentSessionId: 'recipient', maxBytes: 4096, ...(cursor ? { cursor } : {}) }
    const page = parseAgentInputMailboxPage(await h.client.readAgentInputMailbox(request), request)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    for (const entry of page.items) {
      expect(entry.kind).toBe('fragment'); fragments++
      const consumed = consumeAgentInputMailboxEntry({ hostId: 'local', page, entry, ...(pending ? { pending } : {}) })
      if (consumed.kind === 'pending') pending = consumed.pending
      else { complete = consumed.value; pending = undefined }
    }
    cursor = page.nextCursor ?? undefined
    expect(fragments).toBeLessThan(500)
  } while (cursor)
  expect(fragments).toBeGreaterThan(1)
  expect(complete).toMatchObject({ kind: 'controlled', intent: { key: key('full-size'), source: { prompt: body } } })
  expect(pending).toBeUndefined()
  const first = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', maxBytes: 4096 })
  expect(first.nextCursor).toBeTruthy()
  await h.client.stopAgentInputWaiting({ ref: (saved as AgentInputSubmissionReceipt).ref, cancelOperationId: 'stop-during-read' })
  await expect(h.client.readAgentInputMailbox({ agentSessionId: 'recipient', maxBytes: 4096, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'AGENT_INPUT_READ_CHANGED' })
  expect((await h.client.inspectAgentInput({ key: key('full-size') }))?.status).toBe('stopped')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('binds public continuations to the selected route, original queue and cut without rewriting source cursors', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await h.client.submitAgentPrompt(input('route-A')); await h.client.submitAgentPrompt(input('route-B'))
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'route-one', client: h.client }, { hostId: 'route-two', client: h.client }] })
  const context = { principal: { kind: 'user' as const, id: 'reader' } }
  const first = await service.call('agent.input.ls', { hostId: 'route-one', agentSessionId: 'recipient', limit: 1 }, context)
  expect(first.nextCursor).toBeTruthy()
  const next = await service.call('agent.input.ls', { hostId: 'route-one', agentSessionId: 'recipient', cursor: first.nextCursor!, limit: 1 }, context)
  expect(next.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: key('route-A') } } })
  await expect(service.call('agent.input.ls', { hostId: 'route-two', agentSessionId: 'recipient', cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_CURSOR' })
  await expect(readRoutedInputMailbox({ hostId: 'route-one', agentSessionId: 'recipient', cursor: first.nextCursor! }, async read => ({ ...await h.client.readAgentInputMailbox(read), queueId: 'another-queue' }))).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('reads saved inputs through the actual Hosted SDK while general observation fails, without wire author injection', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await h.client.submitAgentPrompt(input('hosted-original'))
  const path = join(h.root, 'hosted-mailbox.sock')
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client)); cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('General Runtime observation is unavailable'))
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  const page = await hosted.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: key('hosted-original') }, receipt: { status: 'waiting' } } })
  await expect(hosted.readAgentInputMailbox({ agentSessionId: 'recipient', extra: true } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps byte-ACK uncertainty and a recording failure separate from the accepted claim without replay or backfill', async () => {
  const h = await owner(), queue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const events: unknown[] = []; cleanup.push(h.client.onEvent(event => { events.push(event) }))
  const record = vi.spyOn(queue, 'recordInputSubmission').mockRejectedValueOnce(new Error('Original journal recording ACK unavailable'))
  const exact = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'accepted-no-row', afterSubmissionId: null, prompt: 'Retained original', execution: 'immediate' as const, allowUncertainTurn: true }
  await h.client.submitAgentPrompt(exact)
  const admission = await h.client.inspectAgentPromptSubmission(key(exact.operationId))
  expect(admission?.admission?.acknowledged).toBe(true)
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent-error', code: 'AGENT_INPUT_RECORDING_UNCONFIRMED' })]))
  expect((await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(0)
  const before = (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length
  record.mockRestore(); await h.client.submitAgentPrompt(exact)
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(before)
  const gap = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(gap.items).toHaveLength(0); expect(gap.coverage.unrecorded).toBe('unconfirmed')
  const write = h.inner.kernel.input as (...args: any[]) => Promise<unknown>
  const unknown = vi.fn(async (...args: any[]) => { await write(...args); throw new AgentMuxError('Original byte result is unknown', 'PRIVATE_ACK_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  h.inner.kernel.input = unknown
  await h.client.submitAgentPrompt(input('unknown-input'))
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key('unknown-input') }))?.status).toBe('unknown')
  await h.client.dispose() // The old dispatch owner is finished before independent read-only recovery.
  const reader = new AgentMuxClient({ store: h.store }); cleanup.push(() => reader.dispose())
  const count = unknown.mock.calls.length
  for (let i = 0; i < 2; i++) {
    const page = await reader.readAgentInputMailbox({ agentSessionId: 'recipient' })
    expect(page.items[0]).toMatchObject({ kind: 'item', item: { intent: { key: key('unknown-input') }, receipt: { status: 'unknown' } } })
  }
  expect(unknown).toHaveBeenCalledTimes(count)
})

it('keeps actual journal read I/O bounded by the recipient page after unrelated input history grows', async () => {
  const h = await owner(); h.inner.connected = false; h.inner.kernel.isConnected = () => false
  await h.client.submitAgentPrompt(input('measured-original'))
  const io = await messageJournalIo(); cleanup.push(() => io.close()); io.target(await realpath(h.client.agentMessageQueuePath()))
  io.reset(); const first = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', limit: 1 }); const before = io.stats()
  for (let i = 0; i < 120; i++) await h.queue.savePromptInput({ key: { kind: 'prompt', agentSessionId: 'other', expectedRun: { runId: 'run-other' }, submissionId: 'unrelated-' + i }, admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'run-other' } }, execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', prompt: 'Unrelated input body '.repeat(200) } })
  io.reset(); const second = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient', limit: 1 }); const after = io.stats()
  expect(first.items).toHaveLength(1); expect(second.items).toEqual(first.items)
  expect(after.readBytes).toBeGreaterThan(0); expect(after.readBytes).toBeLessThanOrEqual(before.readBytes * 2 + 65536)
  expect(after.writes).toBe(0); expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it.runIf(process.env.AGENTMUX_MAILBOX_COMPILED === '1')('compiled SDK and CLI consume the same DurableIngress and local mailbox, including an independent process reopening the original journal', async () => {
  const f = await ingressFixture(false); cleanup.push(f.close)
  const received = await f.receive(), dispatched = await f.ingress.dispatch(received.ingress.ingressId)
  if (!dispatched.inputReceipt || dispatched.inputReceipt.key.kind !== 'message') throw new Error('Original external input was not recorded')
  await f.client.submitAgentPrompt({ ...input('compiled-local'), agentSessionId: f.input.agentSessionId, expectedRun: f.session.run })
  await expect.poll(async () => (await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })).items.every(entry =>
    entry.kind === 'item' && entry.item.kind === 'controlled' && entry.item.receipt?.control.waiting?.phase === 'runtime')).toBe(true)
  const sdk = await f.client.readAgentInputMailbox({ agentSessionId: f.input.agentSessionId })
  expect(sdk.items).toHaveLength(2)
  expect(sdk.items[1]).toMatchObject({ kind: 'item', item: { intent: { key: dispatched.inputReceipt.key }, receipt: { status: 'waiting', originalControlOperationId: expect.any(String) } } })
  const path = join(f.root, 'mailbox.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const publicPage = await rpc.call('agent.input.ls', { hostId: 'local', agentSessionId: f.input.agentSessionId })
  expect(publicPage.items).toEqual(sdk.items); expect(publicPage.cut).toEqual(sdk.cut)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'agent', 'input', 'ls', '--host-id', 'local', '--session', f.input.agentSessionId], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.items).toEqual(sdk.items)
  const discovery = await runCompiledObjectCli(['agent', '--skill'], objectCliEnvironment(f.root))
  expect(discovery.code, discovery.stderr).toBe(0); expect(discovery.stdout).toContain('agent input ls')
  const entry = new URL('../dist/index.js', import.meta.url).href
  const script = `const core = await import(${JSON.stringify(entry)}); const client = new core.AgentMuxClient({store:new core.AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE)}); try { console.log(JSON.stringify(await client.readAgentInputMailbox({agentSessionId:${JSON.stringify(f.input.agentSessionId)}}))); } finally { await client.dispose(); }`
  const independent = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { env: objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_STORE: f.store.path, AGENTMUX_MESSAGE_QUEUE_PATH: f.client.agentMessageQueuePath() }), timeout: 15_000 })
  const reopened = JSON.parse(independent.stdout)
  const originalFacts = (items: any[]) => items.map(entry => {
    const copy = structuredClone(entry)
    if (copy.kind === 'item' && copy.item.receipt) delete copy.item.receipt.observation
    return copy
  })
  expect(originalFacts(reopened.items)).toEqual(originalFacts([...sdk.items]))
  expect(reopened.items.map((entry: any) => entry.item.receipt.observation)).toEqual(['rejoin-needed', 'rejoin-needed'])
  expect(reopened.queueId).toBe(sdk.queueId); expect(reopened.cut).toEqual(sdk.cut)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
