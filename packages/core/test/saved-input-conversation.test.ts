import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import * as core from '../src/index.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const key = (submissionId: string): core.AgentPromptInputKey => ({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId })
const input = (operationId: string) => ({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId,
  prompt: 'Exact original public input 中文🙂', authorHuman: true, sourceChannel: 'message-tool' as const,
  agentMuxNote: 'PRIVATE generated context', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const })
const reference = { hostId: 'local', agentSessionId: 'recipient' }
function records(page: core.AgentConversationReadPage) { return page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : []) }
function inputs(page: core.AgentConversationReadPage) { return records(page).filter(record => record.original.kind === 'captured' && record.original.item.kind === 'user_message') }
async function owner() {
  const f = await rpcOwnerFixture(['recipient', 'other'], core); cleanup.push(f.close)
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  vi.spyOn(f.client.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  return f
}

it('saved waiting input reaches original public Conversation and compiled CLI before any native dispatch', async () => {
  const f = await owner(), receipt = await f.client.submitAgentPrompt(input('original-wait'))
  expect(receipt).toMatchObject({ persistence: 'confirmed', status: 'waiting' })
  const page = await f.client.readAgentConversation(reference)
  expect(core.parseConversationReadPage(page, reference)).toEqual(page)
  const captured = records(page).filter(record => record.original.kind === 'captured')
  expect(captured).toHaveLength(1)
  expect(captured[0]!.original.item).toMatchObject({ id: 'prompt:original-wait', kind: 'user_message', status: 'recorded',
    content: input('original-wait').prompt, authorHuman: true, publicContent: 'confirmed', inputRef: key('original-wait'),
    inputOrigin: { queueId: expect.any(String), sequence: expect.any(Number) }, inputSubmission: { status: 'waiting' } })
  expect(captured[0]!.original.item.content).not.toContain('PRIVATE')
  expect(page.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'captured')).toMatchObject({ inputJournal: { sequence: expect.any(Number) } })
  const rpc = new core.AgentMuxRpcService({ coreClients: f.coreClients }); cleanup.push(() => rpc.dispose())
  expect(await rpc.call('agent.conversation.inspect', reference)).toMatchObject({ items: expect.any(Array) })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'saved-input.sock'), coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const env = objectCliEnvironment(f.root)
  for (const args of [['agent', 'conversation', 'inspect', '--host', 'local', '--session', 'recipient'],
    ['agent', 'input', 'ls', '--host-id', 'local', '--session', 'recipient']]) {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], env, JSON.stringify(reference))
    expect(result.code, result.stderr + result.stdout).toBe(0)
    expect(JSON.stringify(JSON.parse(result.stdout).result)).toContain('waiting')
  }
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('stop, rejoin and terminal ACK update the same original record and keep admission separate from completion', async () => {
  const f = await owner(), saved = await f.client.submitAgentPrompt(input('same-original')) as core.AgentInputSubmissionReceipt
  const before = await f.client.readAgentConversation(reference), original = inputs(before)[0]!
  await f.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'stop-original' })
  let page = await f.client.readAgentConversation(reference)
  expect(inputs(page)).toHaveLength(1)
  expect(inputs(page)[0]!.original.item).toMatchObject({ inputSubmission: { status: 'stopped' } })
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  await f.client.rejoinAgentInputWaiting({ ref: saved.ref })
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: key('same-original') }))?.status).toBe('terminal-confirmed'))
  await vi.waitFor(async () => {
    page = await f.client.readAgentConversation(reference)
    expect(inputs(page)).toHaveLength(1)
    expect(inputs(page)[0]!.original.item).toMatchObject({ status: 'recorded', inputSubmission: { status: 'terminal-confirmed', observation: 'closed' } })
  })
  expect(inputs(page)[0]!.id).toBe(original.id)
  expect(inputs(page)[0]!.order).toEqual(original.order)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data).toContain('PRIVATE generated context')
})

it('journal-first capture failure recovers original membership before a new cut without replay or public-content inference', async () => {
  const f = await owner(), failure = vi.spyOn(f.store, 'applyTimelineMutation').mockRejectedValue(new Error('Capture write unavailable'))
  const saved = await f.client.submitAgentPrompt(input('before-later-cut')) as core.AgentInputSubmissionReceipt
  expect(saved.status).toBe('waiting'); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
  await f.client.dispose(); failure.mockRestore()
  const store = new core.AgentMuxFileAgentSessionStore(f.store.path), reader = new core.AgentMuxClient({ store })
  cleanup.push(() => reader.dispose())
  const unavailable = vi.spyOn(store, 'applyTimelineMutation').mockRejectedValue(new Error('Capture still unavailable after replacement'))
  const cut = await reader.conversationCheckpoint(reference)
  unavailable.mockRestore()
  const item = records(await reader.readAgentConversation(reference))[0]!
  expect(item.original.item).toMatchObject({ inputRef: key('before-later-cut'), inputSubmission: { status: 'waiting', observation: 'rejoin-needed' } })
  const capturedCut = cut.checkpoint.frontier.cuts.find(c => c.kind === 'captured')!
  expect(capturedCut.kind === 'captured' && capturedCut.inputJournal!.sequence).toBeGreaterThanOrEqual(item.original.kind === 'captured' ? item.original.item.inputOrigin!.sequence : Infinity)
  expect(capturedCut.kind === 'captured' && item.order.kind === 'captured-stream' && capturedCut.sequence < item.order.firstSequence).toBe(true)
  expect((await reader.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('an input projection failure preserves unrelated captured reading and never turns an unqualified caller into human speech', async () => {
  const f = await owner()
  await f.client.submitAgentPrompt({ ...input('unknown-author'), authorHuman: undefined })
  expect(records(await f.client.readAgentConversation(reference))).toHaveLength(0)
  const saved = await f.client.submitAgentPrompt(input('qualified-original')) as core.AgentInputSubmissionReceipt
  const broken = vi.spyOn(f.store, 'readInputConversationProjection').mockRejectedValue(new Error('Projection index unavailable'))
  const page = await f.client.readAgentConversation(reference)
  expect(records(page).map(record => record.original.item.id)).toContain('prompt:qualified-original')
  expect(page.coverage.flatMap(source => source.gaps).some(gap => gap.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED')).toBe(true)
  expect((await f.client.inspectAgentInput({ key: saved.key }))?.status).toBe('waiting')
  broken.mockRestore(); expect((await f.client.readAgentConversation(reference)).coverage.flatMap(source => source.gaps).some(gap => gap.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED')).toBe(false)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('current Send and stop do not recover historical inputs, and unchanged public reads do not manufacture revisions', async () => {
  const f = await owner(), queue = Reflect.get(f.client, 'messageQueue') as core.DurableAgentMuxMessageQueue
  const older = Array.from({ length: 260 }, (_, i) => 'older-' + (i % 2 ? 'a' : 'A') + Math.floor(i / 2))
  for (const [i, id] of older.entries()) await queue.savePromptInput({ key: key(id), admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'run-recipient' } },
    execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', authorHuman: true, prompt: 'Older saved input ' + i } })
  const recovery = vi.spyOn(queue, 'readConversationInputPage'), mutations = vi.spyOn(f.store, 'applyTimelineMutation')
  const saved = await f.client.submitAgentPrompt(input('current-bounded')) as core.AgentInputSubmissionReceipt
  await f.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'bounded-stop' })
  expect(recovery).not.toHaveBeenCalled()
  expect(new Set(mutations.mock.calls.map(([mutation]) => mutation.type === 'update' ? mutation.itemId : mutation.item.id))).toEqual(new Set(['prompt:current-bounded']))
  const first = await f.store.readCapturedHistory('recipient'), revision = first.stream.revision
  await f.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'bounded-stop' })
  expect((await f.store.readCapturedHistory('recipient')).stream.revision).toBe(revision)
  await f.client.readAgentConversation(reference)
  expect(recovery.mock.calls.length).toBeGreaterThan(1)
  const recovered = (await f.store.readCapturedHistory('recipient')).stream.revision
  const writes = mutations.mock.calls.length
  await f.client.readAgentConversation(reference)
  expect((await f.store.readCapturedHistory('recipient')).stream.revision).toBe(recovered)
  expect(mutations).toHaveBeenCalledTimes(writes)
  const memory = new core.AgentMuxMemoryAgentSessionStore()
  await memory.compareAndSwap(null, await f.store.readMetadata('recipient'))
  let beforeFirstSequence: number | undefined
  for (;;) {
    const page = await f.store.readCapturedHistory('recipient', { limit: 200, ...(beforeFirstSequence === undefined ? {} : { beforeFirstSequence }) })
    for (const record of page.records) await memory.applyTimelineMutation({ type: 'append', agentSessionId: 'recipient', item: record.item })
    if (!page.more) break
    beforeFirstSequence = page.nextBeforeFirstSequence!
  }
  await memory.recordInputConversationProjection('recipient', await queue.readConversationInputCut('recipient'))
  const pages = vi.spyOn(memory, 'readInputConversationProjection'), memoryClient = new core.AgentMuxClient({ store: memory })
  cleanup.push(() => memoryClient.dispose())
  const publicPage = await memoryClient.readAgentConversation(reference)
  expect(core.parseConversationReadPage(publicPage, reference)).toEqual(publicPage)
  const seen = new Set((await Promise.all(pages.mock.results.map(result => result.value))).flatMap(page => page.pending.map(row => row.key.kind === 'prompt' ? row.key.submissionId : '')))
  expect(seen).toEqual(new Set(older))
  expect(pages.mock.calls.length).toBeGreaterThan(2)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('unknown original input bytes remain unknown without rejoin replay and retain readable public content', async () => {
  const f = await owner(); f.inner.connected = true; f.inner.kernel.isConnected = () => true
  const original = f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>
  const lost = vi.fn(async (...args: unknown[]) => { await original(...args); throw new core.AgentMuxError('Original byte acknowledgment was lost', 'INPUT_ACK_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  f.inner.kernel.input = lost
  await f.client.submitAgentPrompt(input('unknown-original'))
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: key('unknown-original') }))?.status).toBe('unknown'))
  const receipt = (await f.client.inspectAgentInput({ key: key('unknown-original') }))!
  await f.client.rejoinAgentInputWaiting({ ref: receipt.ref })
  const page = await f.client.readAgentConversation(reference)
  expect(inputs(page)).toHaveLength(1)
  expect(inputs(page)[0]!.original.item).toMatchObject({ inputSubmission: { status: 'unknown', observation: 'closed' }, content: input('unknown-original').prompt })
  expect(lost).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.SAVED_INPUT_SCENE_DIRECTORY) {
    await mkdir(process.env.SAVED_INPUT_SCENE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.SAVED_INPUT_SCENE_DIRECTORY, 'unknown-scene.json'), JSON.stringify(page, null, 2))
  }
})


it('a generic content mutation cannot corrupt the saved original input across File commit and reopening', async () => {
  const f = await owner()
  await f.client.submitAgentPrompt({ ...input('immutable-original'), agentMuxNote: undefined })
  const initial = await f.store.readCapturedHistory('recipient'), original = initial.records[0]!
  await expect(f.store.applyTimelineMutation({ type: 'update', agentSessionId: 'recipient', itemId: original.item.id,
    updatedAt: original.item.updatedAt + 1, content: 'A replacement must never inherit the original input witness' }))
    .rejects.toMatchObject({ code: 'AGENT_TIMELINE_ID_CONFLICT' })
  expect(await f.store.readCapturedHistory('recipient')).toEqual(initial)
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: 'recipient', itemId: original.item.id,
    updatedAt: original.item.updatedAt + 2, content: original.item.content })
  expect(await f.store.readCapturedHistory('recipient')).toEqual(initial)
  await f.client.readAgentConversation(reference)
  await f.client.dispose()
  const store = new core.AgentMuxFileAgentSessionStore(f.store.path), reader = new core.AgentMuxClient({ store })
  cleanup.push(() => reader.dispose())
  const originalInput = vi.spyOn(Reflect.get(reader, 'messageQueue') as core.DurableAgentMuxMessageQueue, 'inspectInput').mockResolvedValue(null)
  const unavailable = await reader.readAgentConversation(reference)
  expect(inputs(unavailable)).toHaveLength(1)
  expect(unavailable.coverage.flatMap(source => source.gaps).some(gap => gap.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED')).toBe(true)
  originalInput.mockRestore()
  const page = await reader.readAgentConversation(reference)
  expect(page.coverage.flatMap(source => source.gaps).some(gap => gap.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED')).toBe(false)
  expect(core.parseConversationReadPage(page, reference)).toEqual(page)
  expect(inputs(page)).toHaveLength(1)
  expect(inputs(page)[0]!.original.item).toMatchObject({ content: input('immutable-original').prompt,
    publicContent: 'confirmed', inputRef: key('immutable-original'), inputOrigin: original.item.inputOrigin,
    inputSubmission: { status: 'waiting', observation: 'rejoin-needed' } })
  expect((await reader.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
  const inner = Reflect.get(reader, 'kernel')
  for (const method of ['status', 'input', 'identity', 'observeOutput', 'attach', 'detach', 'stop']) inner[method] = f.inner.kernel[method]
  inner.isConnected = () => true; Reflect.set(reader, 'connected', true)
  await Reflect.get(reader, 'registry').load('local')
  vi.spyOn(reader.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const observed = vi.fn(), unrelated = vi.fn()
  const watch = await reader.observeConversation(reference, observed), other = await reader.observeConversation({ ...reference, agentSessionId: 'other' }, unrelated)
  cleanup.push(() => { watch.dispose(); other.dispose() }); observed.mockClear(); unrelated.mockClear()
  const notifications: Array<Extract<core.AgentMuxClientEvent, { type: 'agent-error' }>> = [], expectedInvalidations: core.AgentMuxClientEvent[] = []
  cleanup.push(reader.onEvent(event => {
    if (event.type === 'agent-error' && event.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED') notifications.push(event)
    if (event.type === 'agent-input' ? event.receipt.key.agentSessionId === 'recipient' : (event.type === 'agent-timeline' || event.type === 'agent-error' && event.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED') && event.agentSessionId === 'recipient') expectedInvalidations.push(event)
  }))
  const originalRecord = Reflect.get(reader, 'recordPromptMessageAfterSideEffect').bind(reader)
  const afterEffect = vi.spyOn(reader as unknown as { recordPromptMessageAfterSideEffect(...args: unknown[]): Promise<void> }, 'recordPromptMessageAfterSideEffect')
    .mockImplementation(async (...args) => {
      const lookup = vi.spyOn(Reflect.get(reader, 'messageQueue') as core.DurableAgentMuxMessageQueue, 'inspectInput').mockRejectedValueOnce(new Error('Saved-input projection lookup unavailable after the native ACK'))
      try { await originalRecord(...args) } finally { lookup.mockRestore() }
    })
  const failedReceipt = vi.spyOn(store, 'applyTimelineMutation').mockRejectedValue(new Error('Receipt projection unavailable after reader warmup'))
  const saved = (await reader.inspectAgentInput({ key: key('immutable-original') }))!
  await reader.rejoinAgentInputWaiting({ ref: saved.ref })
  await vi.waitFor(async () => expect((await reader.inspectAgentInput({ key: saved.key }))?.status).toBe('terminal-confirmed'))
  await vi.waitFor(() => expect(notifications.some(event => event.message?.includes('after the native ACK'))).toBe(true))
  await vi.waitFor(() => expect(failedReceipt.mock.calls.some(([mutation]) => mutation.type !== 'update' && mutation.item.inputSubmission?.status === 'terminal-confirmed')).toBe(true))
  expect(afterEffect).toHaveBeenCalledOnce(); afterEffect.mockRestore()
  await vi.waitFor(() => expect(observed.mock.calls.filter(([value]) => value.kind === 'invalidated' && value.source.kind === 'captured')).toHaveLength(expectedInvalidations.length))
  expect(expectedInvalidations.length).toBeGreaterThanOrEqual(2); expect(expectedInvalidations.length).toBeLessThan(10)
  expect(unrelated).not.toHaveBeenCalled()
  const beforeFailedRead = observed.mock.calls.length
  for (let retry = 0; retry < 2; retry++) expect((await reader.readAgentConversation(reference)).coverage.flatMap(source => source.gaps).some(gap => gap.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED')).toBe(true)
  expect(observed).toHaveBeenCalledTimes(beforeFailedRead)
  failedReceipt.mockRestore()
  const recovered = await reader.readAgentConversation(reference)
  expect(inputs(recovered)).toHaveLength(1)
  expect(inputs(recovered)[0]!.id).toBe(inputs(page)[0]!.id)
  expect(inputs(recovered)[0]!.original.item).toMatchObject({ content: input('immutable-original').prompt,
    inputSubmission: { status: 'terminal-confirmed', observation: 'closed' } })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
