import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxClient, AgentMuxMemoryAgentSessionStore, DurableAgentMuxMessageQueue,
  hashAgentCapability, issueAgentCapability, loadAgentSessions,
  type AgentMuxMessageAppendInput
} from '../dist/index.js'

const roots: string[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private Dispatch fixture cleanup failed.')
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

type Internals = {
  connected: boolean
  kernel: { isConnected(): boolean }
  registry: { load(hostId: string): Promise<void> }
  messageQueue: DurableAgentMuxMessageQueue
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function message(id: string, sender = 'owner', recipient = 'worker', replyTo: string | null = null): AgentMuxMessageAppendInput {
  return { messageId: id, operationId: `operation-${id}`, createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: `${sender}-run`, recipientSessionId: recipient, recipientRunId: `${recipient}-run`,
    threadId: 'synthetic-thread', correlationId: `correlation-${id}`, replyTo, workspaceId: '/synthetic', body: `Synthetic ${id}` }
}
async function publicFixture() {
  const root = await mkdtemp('/tmp/amux-dispatch-'); roots.push(root)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  const store = new AgentMuxMemoryAgentSessionStore(), capabilities = new Map<string, string>()
  for (const id of ['owner', 'worker', 'stranger']) {
    const capability = issueAgentCapability(); capabilities.set(id, capability)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'traex', executorId: 'traex',
      hostId: 'local', workspacePath: root, run: { runId: `${id}-run` }, retiredRuns: [],
      hookBindingId: `binding-${id}`, hookToken: `synthetic-token-${id}`, capabilityHash: hashAgentCapability(capability),
      createdAt: 100, updatedAt: 100 })
  }
  const queuePath = join(root, 'global-messages.ndjson')
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', queuePath)
  const client = new AgentMuxClient({ store }), inner = client as unknown as Internals
  inner.connected = true; inner.kernel.isConnected = () => true; await inner.registry.load('local')
  cleanups.push(async () => await client.dispose())
  const queue = new DurableAgentMuxMessageQueue(queuePath)
  const input = (id: string) => ({ capability: capabilities.get(id)!, callerAgentSessionId: id })
  return { root, store, client, inner, queue, capabilities, input }
}

describe('public durable Dispatch authority', () => {
  it('persists open and report facts before replaying them through a fresh journal owner', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('question', 'worker', 'owner', 'source'))
    const opened = await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    expect((await f.queue.readJournal()).map(record => record.kind)).toEqual(['message', 'message', 'dispatch-open'])
    f.inner.messageQueue = new DurableAgentMuxMessageQueue(f.queue.path)
    await expect(f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).resolves.toEqual(opened)
    const reported = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'question' })
    expect((await f.queue.readJournal()).map(record => record.kind))
      .toEqual(['message', 'message', 'dispatch-open', 'dispatch-event'])
    f.inner.messageQueue = new DurableAgentMuxMessageQueue(f.queue.path)
    await expect(f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).resolves.toEqual(reported)
  })

  it('uses the source/reply identity, keeps separate questions and settles only explicit worker_done', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    for (const id of ['question-one', 'question-two', 'escalation', 'done']) await f.queue.append(message(id, 'worker', 'owner', 'source'))
    await f.queue.append(message('cleanup', 'owner', 'worker', 'source'))
    const opened = await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    expect(opened).toEqual({ sourceMessageId: 'source', ownerAgentSessionId: 'owner', workerAgentSessionId: 'worker',
      threadId: 'synthetic-thread', openedAt: expect.any(Number), originAwaits: true, events: [] })
    expect(await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).toEqual(opened)
    const first = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question-one', kind: 'question' })
    expect(await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question-one', kind: 'question' })).toEqual(first)
    const second = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question-two', kind: 'question' })
    expect(second.events).toEqual([expect.objectContaining({ replyMessageId: 'question-one', kind: 'question' }),
      expect.objectContaining({ replyMessageId: 'question-two', kind: 'question' })])
    await f.queue.recordDelivery('question-one', 'delivered', 200)
    const batch = await f.client.checkDeliveries({ ...f.input('owner'), limit: 1 })
    expect(batch.messages.map(item => item.envelope.messageId)).toEqual(['question-one'])
    await f.client.ackDeliveryBatch({ ...f.input('owner'), readerRun: batch.readerRun, generation: batch.generation })
    expect((await f.client.showDispatch({ ...f.input('worker'), sourceMessageId: 'source' })).originAwaits).toBe(true)
    const escalation = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'escalation', kind: 'escalation' })
    expect(escalation.originAwaits).toBe(true)
    const cleanup = await f.client.recordDispatchEvent({ ...f.input('owner'), sourceMessageId: 'source', replyMessageId: 'cleanup', kind: 'cleanup' })
    expect(cleanup.originAwaits).toBe(true)
    const done = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'done', kind: 'worker_done' })
    expect(done.originAwaits).toBe(false)
    expect(done.ownerAgentSessionId).toBe('owner')
    expect(await f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).toEqual(done)
    expect((await f.queue.readJournal()).filter(record => record.kind === 'dispatch-open')).toHaveLength(1)
    expect((await f.queue.readJournal()).filter(record => record.kind === 'dispatch-event')).toHaveLength(5)
  })

  it('rejects forged callers, wrong participants, conflicting reply kinds and human sources without appending', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('question', 'worker', 'owner', 'source'))
    await f.queue.append({
      ...message('human'), sender: { kind: 'human', principal: 'local-cli' }, senderSessionId: null, senderRunId: null
    })
    await f.queue.append({ ...message('misaligned-source'), recipient: { kind: 'agent-session', agentSessionId: 'stranger' } })
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    const beforeUnauthorizedReport = await readFile(f.queue.path)
    await expect(f.client.recordDispatchEvent({ ...f.input('owner'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'question' }))
      .rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
    expect(await readFile(f.queue.path)).toEqual(beforeUnauthorizedReport)
    await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'question' })
    const before = await readFile(f.queue.path)
    await expect(f.client.openDispatch({ ...f.input('worker'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
    await expect(f.client.showDispatch({ ...f.input('stranger'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
    await expect(f.client.showDispatch({ ...f.input('owner'), capability: f.capabilities.get('worker')!, sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    await expect(f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'human' })).rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_INVALID' })
    await expect(f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'misaligned-source' })).rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_INVALID' })
    await expect(f.client.recordDispatchEvent({ ...f.input('owner'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'worker_done' })).rejects.toMatchObject({ code: 'DISPATCH_PARTICIPANT_MISMATCH' })
    await expect(f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'worker_done' })).rejects.toMatchObject({ code: 'DISPATCH_EVENT_CONFLICT' })
    expect(await readFile(f.queue.path)).toEqual(before)
  })

  it('checks exact replyTo, thread and resolved participant Run facts from the real journal', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    const invalid = [
      { ...message('wrong-source', 'worker', 'owner', 'other') },
      { ...message('wrong-thread', 'worker', 'owner', 'source'), threadId: 'other-thread' },
      { ...message('wrong-sender', 'stranger', 'owner', 'source') },
      { ...message('unretained-run', 'worker', 'owner', 'source'), senderRunId: 'unretained-worker-run' },
      { ...message('unretained-recipient-run', 'worker', 'owner', 'source'), recipientRunId: 'unretained-owner-run' }
    ]
    for (const envelope of invalid) await f.queue.append(envelope)
    const before = await readFile(f.queue.path)
    for (const [index, envelope] of invalid.entries()) {
      await expect(f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source',
        replyMessageId: envelope.messageId!, kind: 'question' })).rejects.toMatchObject({
        code: index >= 3 ? 'DISPATCH_IDENTITY_UNAVAILABLE' : 'DISPATCH_MESSAGE_INVALID'
      })
    }
    expect(await readFile(f.queue.path)).toEqual(before)
    expect((await f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).events).toEqual([])
  })

  it('allows the current capability to supervise its retained historical Run and reports unavailable identity honestly', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('question', 'worker', 'owner', 'source'))
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    const original = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'owner')!
    const newCapability = issueAgentCapability()
    const replacement = { ...original, run: { runId: 'owner-new-run' }, retiredRuns: [original.run],
      capabilityHash: hashAgentCapability(newCapability), updatedAt: 200 }
    await f.store.compareAndSwap(original, replacement); f.capabilities.set('owner', newCapability)
    const report = await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'question', kind: 'question' })
    expect(await f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).toEqual(report)
    const before = await readFile(f.queue.path)
    await f.store.compareAndSwap(replacement, { ...replacement, retiredRuns: [], updatedAt: 300 })
    await expect(f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_IDENTITY_UNAVAILABLE' })
    await expect(f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_IDENTITY_UNAVAILABLE' })
    expect(await readFile(f.queue.path)).toEqual(before)
    const batch = await f.client.checkDeliveries({ ...f.input('owner'), limit: 3 })
    expect(batch.messages.map(item => item.envelope.messageId)).toEqual(['question'])
  })

  it.each([
    { label: 'rotated capability', rotateCapability: true, code: 'AGENT_CAPABILITY_INVALID' },
    { label: 'same capability with a replacement Run', rotateCapability: false, code: 'AGENT_CAPABILITY_STALE_RUN' }
  ])('rechecks the caller inside the actual held journal lock: $label', async ({ rotateCapability, code }) => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('cleanup', 'owner', 'worker', 'source'))
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    const locked = deferred<void>(), release = deferred<void>(), reached = deferred<void>()
    const holder = f.queue.showDispatch({ callerAgentSessionId: 'owner', sourceMessageId: 'source' }, async () => {
      locked.resolve(); await release.promise
    })
    cleanups.push(async () => { release.resolve(); await holder })
    await locked.promise
    const method = f.inner.messageQueue.recordDispatchEvent.bind(f.inner.messageQueue)
    vi.spyOn(f.inner.messageQueue, 'recordDispatchEvent').mockImplementation(async (...args) => {
      reached.resolve(); return await method(...args)
    })
    const oldCaller = f.client.recordDispatchEvent({ ...f.input('owner'), sourceMessageId: 'source', replyMessageId: 'cleanup', kind: 'cleanup' })
      .then(result => ({ result }), error => ({ error }))
    cleanups.push(async () => { release.resolve(); await oldCaller })
    await reached.promise
    const before = await readFile(f.queue.path)
    const current = (await loadAgentSessions(f.store)).find(session => session.agentSessionId === 'owner')!
    const capability = rotateCapability ? issueAgentCapability() : f.capabilities.get('owner')!
    await f.store.compareAndSwap(current, { ...current, run: { runId: 'replacement-owner-run' },
      retiredRuns: [current.run], capabilityHash: hashAgentCapability(capability), updatedAt: 200 })
    release.resolve(); await holder
    expect(await oldCaller).toMatchObject({ error: { code } })
    expect(await readFile(f.queue.path)).toEqual(before)
    f.capabilities.set('owner', capability)
    expect((await f.client.recordDispatchEvent({ ...f.input('owner'), sourceMessageId: 'source', replyMessageId: 'cleanup', kind: 'cleanup' })).events)
      .toEqual([expect.objectContaining({ kind: 'cleanup', replyMessageId: 'cleanup' })])
  })

  it('keeps unrelated mail readable when a referenced source body is unavailable instead of recreating an empty Dispatch', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('reply', 'worker', 'owner', 'source'))
    await f.queue.append(message('unrelated', 'stranger', 'worker'))
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'reply', kind: 'question' })
    // A private retained-journal fixture expresses missing referenced data; this is not a new
    // production eviction/migration policy and does not touch any existing user's messages.
    const retained = (await f.queue.readJournal()).filter(record => record.kind !== 'message' || record.envelope.messageId !== 'source')
    await writeFile(f.queue.path, retained.map(record => JSON.stringify(record)).join('\n') + '\n')
    await expect(f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_UNAVAILABLE' })
    await expect(f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })).rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_UNAVAILABLE' })
    const batch = await f.client.checkDeliveries({ ...f.input('worker'), limit: 3 })
    expect(batch.messages.map(item => item.envelope.messageId)).toEqual(['unrelated'])
    expect((await f.queue.readJournal()).filter(record => record.kind === 'dispatch-event'))
      .toEqual([expect.objectContaining({ sourceMessageId: 'source', replyMessageId: 'reply', eventKind: 'question' })])
  })

  it('reports an unavailable retained reply without losing the source or unrelated incoming mail', async () => {
    const f = await publicFixture()
    await f.queue.append(message('source'))
    await f.queue.append(message('reply', 'worker', 'owner', 'source'))
    await f.queue.append(message('unrelated', 'stranger', 'worker'))
    await f.client.openDispatch({ ...f.input('owner'), sourceMessageId: 'source' })
    await f.client.recordDispatchEvent({ ...f.input('worker'), sourceMessageId: 'source', replyMessageId: 'reply', kind: 'question' })
    const retained = (await f.queue.readJournal()).filter(record => record.kind !== 'message' || record.envelope.messageId !== 'reply')
    await writeFile(f.queue.path, retained.map(record => JSON.stringify(record)).join('\n') + '\n')
    await expect(f.client.showDispatch({ ...f.input('owner'), sourceMessageId: 'source' }))
      .rejects.toMatchObject({ code: 'DISPATCH_MESSAGE_UNAVAILABLE' })
    expect((await f.client.checkDeliveries({ ...f.input('worker'), limit: 3 })).messages.map(item => item.envelope.messageId))
      .toEqual(['source', 'unrelated'])
  })
})

describe('actual built dispatch CLI', () => {
  it('opens, reports and shows the same durable message across independent CLI processes', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/dispatch-private-runtime.mjs', import.meta.url))
    const fixtureEnvironment = { ...process.env }
    for (const name of Object.keys(fixtureEnvironment)) {
      if (name.startsWith('AGENTMUX_') || name.startsWith('CTXMUX_') || name === 'NODE_OPTIONS') delete fixtureEnvironment[name]
    }
    const { stdout } = await promisify(execFile)(process.execPath, [fixture, '--scenario', 'cli'], {
      maxBuffer: 4 * 1024 * 1024, env: fixtureEnvironment
    })
    const proof = JSON.parse(stdout)
    expect(proof.scenario).toBe('cli')
    expect(proof.report.messageIds).toEqual(['question-one', 'question-two', 'done'])
    expect(proof.report.dispatch.sourceMessageId).toBe('source')
    expect(proof.report.dispatch.events.map((event: { replyMessageId: string }) => event.replyMessageId))
      .toEqual(['question-one', 'question-two', 'done'])
    expect(proof.report.dispatch.originAwaits).toBe(false)
    expect(proof.cleanup.ownedAgentPids).toHaveLength(2)
    expect(proof.cleanup.allOwnedProcessesGone).toBe(true)
    expect(proof.cleanup.privateRootRemoved).toBe(true)
    expect(proof.inputs.after).toEqual(proof.inputs.before)
  }, 90_000)
})
