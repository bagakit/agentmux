import { afterEach, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { access, symlink } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxClient as SourceClient } from '../src/client.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { messageObservationQuery } from '../src/agent-message-journal.js'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn((...args: Parameters<typeof fs.watch>) => { const watcher = Reflect.apply(fs.watch, fs, args) as FSWatcher; vi.spyOn(watcher, 'close'); return watcher }) }
})

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY ?? pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href
const candidate = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY ? await import(entry) : null
const Client: typeof SourceClient = candidate?.AgentMuxClient ?? SourceClient
const Queue: typeof SourceQueue = candidate?.DurableAgentMuxMessageQueue ?? SourceQueue
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  // Mutation failures still release only the exact watch objects this fixture created.
  for (const result of vi.mocked(watch).mock.results) if (result.type === 'return') (result.value as FSWatcher).close()
  vi.restoreAllMocks(); vi.mocked(watch).mockReset(); vi.unstubAllEnvs()
})
async function fixture() {
  const f = await rpcOwnerFixture(['reader']); closes.push(f.close)
  const events: AgentMuxClientEvent[] = [], release = f.client.onEvent(event => { events.push(event) }); closes.push(release)
  return { ...f, events, release, queue: new Queue(f.client.agentMessageQueuePath()),
    read: () => f.client.listMessages({ participantSessionId: 'reader', direction: 'incoming', limit: 25 }) }
}
async function writer(path: string, mode: string, id?: string, hold = false, module = entry) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures/message-journal-writer.mjs'), module, mode, path, ...(id ? [id] : [])],
    { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const exit = once(child, 'exit')
  if (hold) {
    await new Promise<void>((yes, no) => {
      const inspect = () => { if (stdout.includes('held\n')) { child.stdout.off('data', inspect); yes() } }
      child.stdout.on('data', inspect); inspect()
      child.once('exit', code => { no(new Error(`Private lease owner exited before its held boundary (${code}): ${stderr}`)) })
      child.once('error', no)
    })
    return async () => { child.stdin.end('release'); const [code] = await exit; expect(code, stderr).toBe(0) }
  }
  const [code] = await exit; expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({ mode, path })
  return async () => {}
}
const changed = (events: AgentMuxClientEvent[], id: string) => events.filter(event => event.type === 'agent-message-changed' && event.messageId === id)

it('onEvent alone never initializes or scans an unused message journal', async () => {
  const read = vi.spyOn(Queue.prototype, 'messageChanges'), f = await fixture()
  await expect(access(f.queue.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(read).not.toHaveBeenCalled(); expect(f.events).toEqual([])
})

it('an actual pre-observation writer populates only future positions and the real delta plan uses range/point lookups', async () => {
  const f = await fixture()
  await writer(f.queue.path, 'append', 'before-observation')
  const cut = (await f.queue.messageChanges()).cut
  const { stdout: oldSource } = await promisify(execFile)('git', ['show', '6fcc032e44:packages/core/src/agent-global-message-queue.ts'], { cwd: resolve(import.meta.dirname, '../../..') })
  expect(oldSource).not.toContain('messageChanges(')
  const oldModule = join(f.root, 'old-message-writer.mjs'), { build } = await import('esbuild')
  await symlink(resolve(import.meta.dirname, '../node_modules'), join(f.root, 'node_modules'), 'dir')
  await build({ stdin: { contents: oldSource, resolveDir: resolve(import.meta.dirname, '../src'), sourcefile: 'pre-observation-queue.ts', loader: 'ts' },
    outfile: oldModule, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error' })
  await writer(f.queue.path, 'append', 'old-writer-new-record', false, pathToFileURL(oldModule).href)
  expect((await f.queue.messageChanges(cut)).changes).toMatchObject([{ messageId: 'old-writer-new-record' }])
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.queue.path, { readOnly: true })
  try {
    expect(db.prepare('SELECT sequence FROM message_observation_records ORDER BY sequence').all().map(row => row.sequence)).toEqual([2])
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + messageObservationQuery).all(1, 2).map(row => String(row.detail))
    expect(plan.some(detail => detail.includes('SEARCH position USING INTEGER PRIMARY KEY'))).toBe(true)
    expect(plan.some(detail => /SCAN (?:records|r|original)\b/u.test(detail))).toBe(false)
    console.log(JSON.stringify({ oldWriterCommit: '6fcc032e44', oldWriterSha256: createHash('sha256').update(oldSource).digest('hex'), plan }))
  } finally { db.close() }
})

it('observes committed cross-process firstsave and delivery metadata without Runtime, body, ack or history replay', async () => {
  const f = await fixture()
  await writer(f.queue.path, 'append', 'historical')
  expect((await f.read()).messages).toHaveLength(1)
  expect(changed(f.events, 'historical')).toHaveLength(0)
  await writer(f.queue.path, 'append', 'new-undelivered')
  await vi.waitFor(() => expect(changed(f.events, 'new-undelivered')).toHaveLength(1))
  expect(changed(f.events, 'new-undelivered')[0]).toEqual({ type: 'agent-message-changed', sequence: 2, messageId: 'new-undelivered', senderSessionId: 'sender', recipientSessionId: 'reader' })
  await writer(f.queue.path, 'delivery', 'new-undelivered')
  await vi.waitFor(() => expect(changed(f.events, 'new-undelivered')).toHaveLength(2))
  expect(JSON.stringify(f.events)).not.toContain('Original private body')
  expect((await f.queue.readByMessageId('new-undelivered'))!.envelope.recipientRunId).toBeNull()
  expect((await f.queue.readJournal()).some(record => record.kind === 'consumer-check' || record.kind === 'consumer-ack')).toBe(false)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('closes the initial-cut/subscription gap and shares one original path across SDK consumers', async () => {
  const f = await fixture(), other = new Client({ store: f.store }); closes.push(() => other.dispose())
  const events: AgentMuxClientEvent[] = [], release = other.onEvent(event => { events.push(event) }); closes.push(release)
  const read = Queue.prototype.messageChanges
  let seed = true
  vi.spyOn(Queue.prototype, 'messageChanges').mockImplementation(async function (this: SourceQueue, after) {
    const cut = await read.call(this, after)
    if (seed && after === undefined) { seed = false; await writer(this.path, 'append', 'setup-gap') }
    return cut
  })
  await f.read()
  await other.listMessages({ participantSessionId: 'reader', direction: 'incoming', limit: 1 })
  await vi.waitFor(() => expect(changed(f.events, 'setup-gap')).toHaveLength(1))
  expect(changed(events, 'setup-gap').length).toBeLessThanOrEqual(1)
  const calls = vi.mocked(Queue.prototype.messageChanges).mock.calls.filter(([cut]) => cut === undefined)
  expect(calls).toHaveLength(1)
  f.release(); await writer(f.queue.path, 'append', 'only-second')
  await vi.waitFor(() => expect(changed(events, 'only-second')).toHaveLength(1))
  expect(changed(f.events, 'only-second')).toHaveLength(0)
  release(); const before = vi.mocked(Queue.prototype.messageChanges).mock.calls.length
  for (const result of vi.mocked(watch).mock.results) if (result.type === 'return') expect(result.value.close).toHaveBeenCalled()
  await writer(f.queue.path, 'append', 'after-dispose')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(vi.mocked(Queue.prototype.messageChanges).mock.calls).toHaveLength(before)
})

it('reads a writer commit in the initial gap when a listener joins an already-used reader without another list', async () => {
  const f = await fixture(); f.release(); await f.read()
  const read = Queue.prototype.messageChanges
  let first = true
  vi.spyOn(Queue.prototype, 'messageChanges').mockImplementation(async function (this: SourceQueue, after, signal) {
    const result = await read.call(this, after, signal)
    if (first && after === undefined) { first = false; await writer(this.path, 'append', 'late-listener-gap') }
    return result
  })
  const events: AgentMuxClientEvent[] = [], release = f.client.onEvent(event => { events.push(event) }); closes.push(release)
  // No list/read follows this registration: incidental file events from a later SDK read
  // cannot stand in for the owner's explicit initial cut → subscription reconciliation.
  await vi.waitFor(() => expect(changed(events, 'late-listener-gap')).toHaveLength(1))
})

it('keeps a successful original list independent of a failed OS observation resource', async () => {
  const f = await fixture()
  vi.mocked(watch).mockImplementation(() => { throw Object.assign(new Error('Private OS watch unavailable'), { code: 'EACCES' }) })
  expect((await f.read()).messages).toEqual([])
  expect(f.events.some(event => event.type === 'agent-message-observation' && event.state === 'unavailable' && event.code === 'EACCES')).toBe(true)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an observation schema failure leaves the original read and independent writer available', async () => {
  const f = await fixture(); await writer(f.queue.path, 'append', 'retained-before-schema-error')
  vi.spyOn(Queue.prototype, 'messageChanges').mockRejectedValue(new Error('Private observation schema unavailable'))
  expect((await f.read()).messages.map(message => message.envelope.messageId)).toEqual(['retained-before-schema-error'])
  expect(f.events.some(event => event.type === 'agent-message-observation' && event.state === 'unavailable')).toBe(true)
  await writer(f.queue.path, 'append', 'independent-after-schema-error')
  expect((await f.read()).messages.map(message => message.envelope.messageId)).toEqual(['independent-after-schema-error', 'retained-before-schema-error'])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('shares one new original cut when concurrent explicit reads recover an unavailable observer', async () => {
  const f = await fixture(), read = Queue.prototype.messageChanges
  let unavailable = true, initializations = 0
  vi.spyOn(Queue.prototype, 'messageChanges').mockImplementation(async function (this: SourceQueue, after, signal) {
    if (after === undefined) {
      initializations++
      if (unavailable) throw new Error('Private initial observation unavailable')
    }
    return read.call(this, after, signal)
  })
  await f.read()
  await vi.waitFor(() => expect(f.events.filter(event => event.type === 'agent-message-observation' && event.state === 'unavailable').length).toBeGreaterThanOrEqual(2))
  unavailable = false; const attempted = initializations
  await Promise.all([f.read(), f.read()])
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent-message-observation' && event.state === 'available')).toBe(true))
  expect(initializations - attempted).toBe(1)
  await writer(f.queue.path, 'append', 'after-observation-recovery')
  await vi.waitFor(() => expect(changed(f.events, 'after-observation-recovery')).toHaveLength(1))
})

it('waits asynchronously for the original mutex before reading, and executes the operation once', async () => {
  const f = await fixture(); await f.read()
  const cut = (await f.queue.messageChanges()).cut
  const release = await writer(f.queue.path, 'hold', 'held-commit', true); closes.push(release)
  let reads = 0
  const read = f.queue.readByMessageId('held-commit', async () => { reads++ })
  let observed = false
  const snapshot = f.queue.messageChanges(cut).then(value => { observed = true; return value })
  await new Promise(resolve => setTimeout(resolve, 30)); expect(reads).toBe(0); expect(observed).toBe(false)
  closes.pop(); await release()
  expect((await read)!.envelope.messageId).toBe('held-commit'); expect(reads).toBe(1)
  expect((await snapshot).changes).toMatchObject([{ messageId: 'held-commit' }])
  await vi.waitFor(() => expect(changed(f.events, 'held-commit')).toHaveLength(1))
})

it('cancels only an observation waiting on the original mutex and releases its handle', async () => {
  const f = await fixture(), cut = (await f.queue.messageChanges()).cut
  const release = await writer(f.queue.path, 'hold', 'before-cancel', true); closes.push(release)
  const controller = new AbortController(), pending = f.queue.messageChanges(cut, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 25)); controller.abort()
  await expect(pending).rejects.toMatchObject({ cause: { name: 'AbortError' } })
  closes.pop(); await release()
  await writer(f.queue.path, 'append', 'after-cancel')
  expect((await f.queue.messageChanges(cut)).changes.map(item => item.messageId)).toEqual(['before-cancel', 'after-cancel'])
})

it('serializes this candidate’s concurrent cross-process writers and high-frequency observation without retrying effects', async () => {
  const f = await fixture(); await f.read()
  const started = performance.now()
  await Promise.all(Array.from({ length: 3 }, (_, index) => writer(f.queue.path, 'burst', `writer-${index}`)))
  await vi.waitFor(() => expect(f.events.filter(event => event.type === 'agent-message-changed')).toHaveLength(36), { timeout: 5000 })
  const original = (await f.queue.readJournal()).filter(record => record.kind === 'message')
  expect(original).toHaveLength(36); expect(new Set(original.map(record => record.envelope.messageId)).size).toBe(36)
  expect(f.events.filter(event => event.type === 'agent-message-observation' && event.state === 'unavailable')).toEqual([])
  console.log(JSON.stringify({ writers: 3, messages: 36, applicationRetries: 0, elapsedMs: performance.now() - started }))
})

it.each(['replace', 'rollback'])('keeps original observation unknown after a cross-process %s', async mode => {
  const f = await fixture(); await f.read(); await writer(f.queue.path, 'append', 'before-source-change')
  await vi.waitFor(() => expect(changed(f.events, 'before-source-change')).toHaveLength(1))
  await writer(f.queue.path, mode)
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent-message-observation' && event.state === 'unavailable' && event.code === 'AGENT_MESSAGE_SOURCE_CHANGED')).toBe(true))
  expect(changed(f.events, 'before-source-change')).toHaveLength(1)
  if (mode === 'replace') {
    await writer(f.queue.path, 'restore'); await writer(f.queue.path, 'append', 'original-restored')
    await vi.waitFor(() => expect(changed(f.events, 'original-restored')).toHaveLength(1))
  }
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('carries the same cross-process change through the actual Hosted events consumer', async () => {
  const f = await fixture(), service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client)); closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'events.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); closes.push(() => hosted.dispose())
  const events: AgentMuxClientEvent[] = [], release = hosted.onEvent(event => { events.push(event) }); closes.push(release)
  await hosted.listMessages({ participantSessionId: 'reader', direction: 'incoming', limit: 1 })
  await writer(f.queue.path, 'append', 'hosted-undelivered')
  await vi.waitFor(() => expect(changed(events, 'hosted-undelivered')).toHaveLength(1))
  expect((await hosted.readMessage({ messageId: 'hosted-undelivered' }))!.envelope.body).toContain('<reminder>authored</reminder>')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
}, 15_000)
