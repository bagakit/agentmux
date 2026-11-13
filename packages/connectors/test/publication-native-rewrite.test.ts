import { appendFile, readFile, writeFile } from 'node:fs/promises'
import * as core from '../../core/dist/index.js'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const assistant = (id: string, text: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const tool = (id: string, input: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-' + id, name: 'exec', input: { cmd: input } }] } }) + '\n'

async function fixture(unknownText?: string, running = false) {
  const f = await ingressFixture(running, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const dispatched: Array<{ key: string; text: string }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'rewrite-v1', supportedRenderVersions: ['rewrite-v1'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'rewrite-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: JSON.stringify({ text: operation.payload.kind === 'speech' ? operation.payload.text : null }) } }),
    dispatch: async (prepared, _target, _credential, _signal, mapping) => {
      const text = JSON.parse(prepared.request.body!).text
      if (text !== null) dispatched.push({ key: prepared.requestKey, text })
      if (text === unknownText) return { state: 'unknown', reason: 'effect-unconfirmed' }
      return { state: 'confirmed', mapping: mapping ?? { messageId: 'message-' + prepared.requestKey } }
    } }
  const port = createPublicationConversationPort(f.coreClients), changes = port.changes.bind(port)
  const reads: Array<{ through: unknown; cursor: unknown; rewrite: unknown }> = []
  port.changes = async (input, signal) => { reads.push({ through: structuredClone(input.through), cursor: input.cursor, rewrite: Reflect.get(input, 'rewrite') }); return await changes(input, signal) }
  const open = () => createConnectionServices({ directory: join(f.root, 'rewrite-recovery'),
    adapters: [{ adapterId: 'sample', publication: adapter, ingress: { adapterId: 'sample', verify: f.verifier }, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref), session: async ref => ref.hostId === 'local' ? f.client.agentSession(ref.agentSessionId) : null }, publication: port, ingress: { core: hostId => hostId === 'local' ? f.client : undefined } })
  let services = await open()
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'rewrite-credential', secret: 'private-rewrite-credential' })
  await services.connections.configure({ operationId: 'rewrite-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind(f.input, context)
  if (bound.state !== 'applied') throw Error('Original publication Binding required')
  expect(await services.bindings!.grant(f.grant, context)).toMatchObject({ state: 'applied' })
  const binding = bound.binding, input = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  let host = services.publication!
  await vi.waitFor(async () => expect((await host.list(input)).sourceObservation?.state).toBe('ready'), { timeout: 8000 })
  const idle = () => vi.waitFor(() => expect((Reflect.get(host, 'lanes') as Map<string, { work?: unknown }>).get(binding.bindingId)?.work).toBeUndefined())
  const speech = () => host.store.list(binding).filter(op => op.payload.kind === 'speech')
  /** Ordinary reads from the original scope through one frozen upper. */
  const recoveryReads = () => reads.filter(read => read.through !== undefined || read.rewrite !== undefined).length
  return { ...f, get host() { return host }, binding, input, dispatched, reads, idle, speech, recoveryReads, port, adapter,
    receiveCurrent: (body: string) => services.ingress!.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ body }) }) }, vi.fn()),
    currentIngress: () => services.ingress!,
    restart: async () => { await services.close(); services = await open(); host = services.publication! } }
}


const unavailable = async (f: Awaited<ReturnType<typeof fixture>>, code = 'AGENT_SESSION_HISTORY_REWRITTEN') => {
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation).toMatchObject({ state: 'unavailable', code, codeRecorded: true }), { timeout: 8000 })
  await f.idle()
}
const published = async (f: Awaited<ReturnType<typeof fixture>>, id: string, text: string) => {
  await appendFile(f.transcript, assistant(id, text)); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.payload.kind === 'speech' && op.payload.text === text && op.state === 'confirmed')).toBe(true), { timeout: 8000 }); await f.idle()
}

it.each(['shifted', 'same-offset'] as const)('retains the original cut when a %s identical anchor cannot exclude new records before it', async shape => {
  const f = await fixture(), header = await readFile(f.transcript)
  const oldTool = tool('old-long', 'x'.repeat(500)), stable = assistant('published-anchor', 'Already delivered')
  await appendFile(f.transcript, oldTool + stable + tool('vanished-after', 'old'.repeat(80))); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'confirmed')).toBe(true)); await f.idle()
  const cut = f.host.store.retainedCheckpoint(f.binding), original = structuredClone(f.speech()), sent = f.dispatched.length
  const inserted = assistant('inserted-before', 'Authorized new record before identical anchor')
  const padding = Buffer.byteLength(oldTool) - Buffer.byteLength(tool('new-tool', '') + inserted)
  const replacement = tool('new-tool', shape === 'shifted' ? 'short' : 'x'.repeat(padding)) + inserted
  if (shape === 'same-offset') expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(oldTool))
  else expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(oldTool))
  await writeFile(f.transcript, Buffer.concat([header, Buffer.from(replacement + stable + assistant('new-after', 'New record after anchor'))])); f.host.refresh()
  await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  expect(f.speech()).toEqual(original); expect(f.dispatched).toHaveLength(sent)
  expect(f.recoveryReads()).toBe(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not change an older published identity reused after more than 64 consumed records', async () => {
  const f = await fixture()
  await published(f, 'old-identity', 'Original reply')
  await appendFile(f.transcript, Array.from({ length: 70 }, (_, i) => tool('later-tool-' + i, 'input')).join('')); f.host.refresh(); await f.idle()
  const kept = await readFile(f.transcript)
  await appendFile(f.transcript, tool('vanished', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  const cut = f.host.store.retainedCheckpoint(f.binding), before = structuredClone(f.speech()), sent = f.dispatched.length
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('old-identity', 'Reused identity must not update original') + assistant('new-tail', 'Unconfirmed tail'))])); f.host.refresh()
  await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut); expect(f.speech()).toEqual(before)
  expect(f.dispatched).toHaveLength(sent); expect(f.recoveryReads()).toBe(0)
})

it('retains the exact unknown request, prepared bytes and original cut across source recovery and durable Publication reopen', async () => {
  const text = 'Unknown original effect', f = await fixture(text)
  await appendFile(f.transcript, assistant('unknown-original', text)); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'unknown')).toBe(true)); await f.idle()
  const original = structuredClone(f.speech()), kept = await readFile(f.transcript)
  expect(original[0]!.prepared).toBeDefined()
  await appendFile(f.transcript, tool('unknown-vanished', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  const cut = f.host.store.retainedCheckpoint(f.binding)
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('unknown-new', 'No guessed new request'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource(f.input, context); await f.idle(); await unavailable(f)
  await f.restart(); await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut); expect(f.speech()).toEqual(original)
  expect(f.dispatched.filter(item => item.text === text)).toHaveLength(1)
  expect(f.recoveryReads()).toBe(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps independent captured publication and its cut progressing while the native source is rewritten', async () => {
  const f = await fixture()
  await published(f, 'native-original', 'Native original')
  const kept = await readFile(f.transcript)
  await appendFile(f.transcript, tool('native-vanished', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  const before = f.host.store.retainedCheckpoint(f.binding)!, native = before.frontier.cuts.find(c => c.kind === 'native')
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('native-unconfirmed', 'Native continuity not proven'))])); f.host.refresh(); await unavailable(f)
  const sent = f.dispatched.length
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.binding.agentSessionId, item: { id: 'captured-independent', agentSessionId: f.binding.agentSessionId,
    kind: 'user_message', publicContent: 'confirmed', authorHuman: true, title: 'Captured input', source: 'user', status: 'complete', createdAt: 100, updatedAt: 100, content: 'Captured source remains usable' } })
  f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.slice(sent).map(item => item.text)).toContain('Captured source remains usable'), { timeout: 8000 }); await f.idle()
  const after = f.host.store.retainedCheckpoint(f.binding)!
  expect(after.frontier.cuts.find(c => c.kind === 'native')).toEqual(native)
  expect(after.frontier.cuts.find(c => c.kind === 'captured')).not.toEqual(before.frontier.cuts.find(c => c.kind === 'captured'))
  await unavailable(f)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it.each(['AGENT_SESSION_HISTORY_BUSY', 'AGENT_SESSION_HISTORY_TIMEOUT'])('retries ordinary source reads after transient %s without changing the original boundary', async code => {
  const f = await fixture()
  await published(f, 'transient-original', 'Original transient reply')
  const reader = f.client as unknown as { nativeHistoryChangesPage(...args: unknown[]): Promise<unknown> }
  const read = reader.nativeHistoryChangesPage.bind(reader), cut = f.host.store.retainedCheckpoint(f.binding)
  let failing = true
  vi.spyOn(reader, 'nativeHistoryChangesPage').mockImplementation(async (...args) => {
    if (failing && (args[1] as { checkpoint?: unknown }).checkpoint) throw new core.AgentMuxError('Controlled transient source failure', code)
    return await read(...args)
  })
  await appendFile(f.transcript, assistant('transient-new', 'After transient clears')); f.host.refresh(); await unavailable(f, code)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  failing = false; f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.map(item => item.text)).toContain('After transient clears'), { timeout: 8000 }); await f.idle()
  expect((await f.host.list(f.input)).sourceObservation?.state).toBe('ready')
  expect(f.recoveryReads()).toBe(0)
})

it('continues on the original Binding when the original physical prefix becomes verifiable again', async () => {
  const f = await fixture()
  await published(f, 'restore-original', 'Original before source repair')
  const original = await readFile(f.transcript)
  await appendFile(f.transcript, tool('restore-tail', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  const exactSource = await readFile(f.transcript), cut = f.host.store.retainedCheckpoint(f.binding)
  await writeFile(f.transcript, Buffer.concat([original, Buffer.from(assistant('ambiguous', 'Unconfirmed replacement'))])); f.host.refresh(); await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  // Restore the exact original source on the same file, then normal changes are valid again.
  await writeFile(f.transcript, Buffer.concat([exactSource, Buffer.from(assistant('verified-later', 'Ordinary recovery on original source'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.map(item => item.text)).toContain('Ordinary recovery on original source'), { timeout: 8000 }); await f.idle()
  expect(f.dispatched.filter(item => item.text === 'Original before source repair')).toHaveLength(1)
  expect((await f.host.list(f.input)).sourceObservation?.state).toBe('ready')
  expect(f.host.store.retainedCheckpoint(f.binding)).not.toEqual(cut)
  expect(f.recoveryReads()).toBe(0)
})

it('measures repeated original-cut observations on the same large source without rescanning history or adding effects', async () => {
  const f = await fixture()
  const bytes = 'x'.repeat(64 * 1024)
  await appendFile(f.transcript, Array.from({ length: 128 }, (_, i) => tool('large-' + i, bytes)).join(''))
  const firstCut = f.host.store.retainedCheckpoint(f.binding)
  f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.retainedCheckpoint(f.binding)).not.toEqual(firstCut), { timeout: 8000 }); await f.idle()
  const exactSource = await readFile(f.transcript), cut = f.host.store.retainedCheckpoint(f.binding)
  expect(exactSource.byteLength).toBeGreaterThan(8 * 1024 * 1024)
  const { NativeJsonlHistoryReader } = await import('../../core/dist/native-jsonl-history-reader.js')
  const originalRead = Reflect.get(NativeJsonlHistoryReader.prototype, 'read') as (start: number, length: number) => Promise<Buffer>
  let readBytes = 0
  vi.spyOn(NativeJsonlHistoryReader.prototype as never, 'read' as never).mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const value = await originalRead.apply(this, args as [number, number]); readBytes += value.byteLength; return value
  } as never)
  const measure = async () => {
    readBytes = 0
    const start = performance.now(); f.host.refresh(); await f.idle()
    return { bytes: readBytes, ms: Math.round((performance.now() - start) * 100) / 100 }
  }
  const ordinary = []
  for (let i = 0; i < 3; i++) ordinary.push(await measure())
  // Keep source identity and shared beginning; change only bytes before its retained cut.
  const rewritten = Buffer.from(exactSource); rewritten[rewritten.length - 8] = rewritten[rewritten.length - 8] === 120 ? 121 : 120
  await writeFile(f.transcript, rewritten)
  const rewrittenSamples = []
  for (let i = 0; i < 3; i++) rewrittenSamples.push(await measure())
  await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  expect(f.dispatched).toHaveLength(0)
  expect(ordinary.every(sample => sample.bytes > 0)).toBe(true)
  expect(rewrittenSamples.every(sample => sample.bytes > 0)).toBe(true)
  // Both checks read the fixed fingerprints/block, never the 8 MiB history.
  expect(Math.max(...ordinary.map(sample => sample.bytes), ...rewrittenSamples.map(sample => sample.bytes))).toBeLessThan(128 * 1024)
  console.log('REWRITE_OBSERVATION_COST', JSON.stringify({ sourceBytes: exactSource.byteLength, ordinary, rewritten: rewrittenSamples }))
}, 30_000)

it('a real authenticated intake reaches the original Core terminal while Publication retains a native rewrite gap', async () => {
  const f = await fixture(undefined, true)
  await published(f, 'healthy-input-original', 'Original before independent input')
  const kept = await readFile(f.transcript)
  await appendFile(f.transcript, tool('healthy-input-lost', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('healthy-input-new', 'Unconfirmed native range'))])); f.host.refresh(); await unavailable(f)
  const run = f.client.agentSession(f.binding.agentSessionId).run, native = f.host.store.retainedCheckpoint(f.binding)!.frontier.cuts.find(c => c.kind === 'native')
  const body = 'Input remains available during a native publication gap'
  const accepted = await f.receiveCurrent(body)
  const sent = await f.currentIngress().dispatch(accepted.ingress.ingressId)
  expect(sent.ingress?.state).toBe('claimed')
  await vi.waitFor(async () => {
    const observed = await f.currentIngress().inspect({ ingressId: accepted.ingress.ingressId })
    expect(observed.inputReceipt?.status).toBe('terminal-confirmed')
  }, { timeout: 8000 })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.inner.kernel.input.mock.calls[0])).toContain(body)
  expect(f.client.agentSession(f.binding.agentSessionId).run).toEqual(run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  f.host.refresh(); await unavailable(f)
  expect(f.host.store.retainedCheckpoint(f.binding)!.frontier.cuts.find(c => c.kind === 'native')).toEqual(native)
}, 30_000)

it('drains an already admitted pending operation under a source gap using its original operation and content', async () => {
  const f = await fixture(), prepare = f.adapter.prepare.bind(f.adapter)
  let blocked = true
  f.adapter.prepare = operation => { if (blocked && operation.payload.kind === 'speech') throw Error('Controlled preparation temporarily unavailable'); return prepare(operation) }
  await appendFile(f.transcript, assistant('admitted-pending', 'Admitted before source rewrite')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'pending')).toBe(true)); await f.idle()
  const operation = structuredClone(f.speech()[0]!), kept = await readFile(f.transcript)
  await appendFile(f.transcript, tool('pending-vanished', 'old'.repeat(100))); f.host.refresh(); await f.idle()
  const cut = f.host.store.retainedCheckpoint(f.binding)
  await writeFile(f.transcript, Buffer.concat([kept, Buffer.from(assistant('pending-new', 'Unconfirmed newer range'))])); f.host.refresh(); await unavailable(f)
  expect(f.host.store.inspect(operation.operationId)?.payload).toEqual(operation.payload)
  blocked = false; f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.inspect(operation.operationId)?.state).toBe('confirmed'), { timeout: 8000 }); await f.idle()
  expect(f.dispatched).toEqual([{ key: operation.operationId, text: 'Admitted before source rewrite' }])
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  await unavailable(f)
}, 30_000)
