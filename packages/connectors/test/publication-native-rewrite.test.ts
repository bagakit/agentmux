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

async function fixture(unknownText?: string, running = false, snapshots = false, owner = context, provider: 'claude' | 'codex' = 'claude') {
  const f = await ingressFixture(running, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  if (provider === 'codex') {
    const record = (await f.store.load()).find(record => record.agentSessionId === f.session.agentSessionId)!
    await f.store.compareAndSwap(record, { ...record, providerId: 'codex', executorId: 'codex', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'ingress-native', transcriptPath: f.transcript }, updatedAt: record.updatedAt + 1 })
    await writeFile(f.transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'ingress-native', cwd: f.root, history_mode: 'paginated' } }) + '\n')
    await f.inner.registry.load('local')
  }
  const dispatched: Array<{ key: string; text: string; metadata?: unknown }> = [], wireEffects: Array<{ key: string; body: unknown }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'rewrite-v1', supportedRenderVersions: ['rewrite-v1'], fragmentBytes: 8192, replyMetadata: true,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'rewrite-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: JSON.stringify({ kind: operation.payload.kind, effect: operation.effect, text: operation.payload.kind === 'speech' ? operation.payload.text : null, metadata: operation.payload.kind === 'speech' ? operation.payload.replyMetadata : undefined }) } }),
    dispatch: async (prepared, _target, _credential, _signal, mapping) => {
      wireEffects.push({ key: prepared.requestKey, body: JSON.parse(prepared.request.body!) })
      const text = JSON.parse(prepared.request.body!).text
      if (text !== null) dispatched.push({ key: prepared.requestKey, text, ...(JSON.parse(prepared.request.body!).metadata ? { metadata: JSON.parse(prepared.request.body!).metadata } : {}) })
      if (text === unknownText) return { state: 'unknown', reason: 'effect-unconfirmed' }
      return { state: 'confirmed', mapping: mapping ?? { messageId: 'message-' + prepared.requestKey } }
    } }
  const port = createPublicationConversationPort(f.coreClients), changes = port.changes.bind(port)
  const reads: Array<{ through: unknown; cursor: unknown; rewrite: unknown; recover: boolean }> = []
  port.changes = async (input, signal) => { reads.push({ through: structuredClone(input.through), cursor: input.cursor, rewrite: Reflect.get(input, 'rewrite'), recover: !!input.recover }); return await changes(input, signal) }
  const open = () => createConnectionServices({ directory: join(f.root, 'rewrite-recovery'),
    adapters: [{ adapterId: 'sample', publication: adapter, ingress: { adapterId: 'sample', verify: f.verifier }, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint({ ...ref, ...(snapshots ? { nativeSnapshot: 'scope' as const } : {}) }), session: async ref => ref.hostId === 'local' ? f.client.agentSession(ref.agentSessionId) : null }, publication: port, ingress: { core: hostId => hostId === 'local' ? f.client : undefined } })
  let services = await open()
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'rewrite-credential', secret: 'private-rewrite-credential' })
  await services.connections.configure({ operationId: 'rewrite-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ ...f.input, expectedSource: { providerId: provider, nativeSessionId: 'ingress-native' } }, owner)
  if (bound.state !== 'applied') throw Error('Original publication Binding required')
  expect(await services.bindings!.grant(f.grant, owner)).toMatchObject({ state: 'applied' })
  const binding = bound.binding, input = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  let host = services.publication!
  await vi.waitFor(async () => expect((await host.list(input)).sourceObservation?.state).toBe('ready'), { timeout: 8000 })
  const idle = () => vi.waitFor(() => expect((Reflect.get(host, 'lanes') as Map<string, { work?: unknown }>).get(binding.bindingId)?.work).toBeUndefined(), { timeout: 15_000 })
  const speech = () => {
    const all = []; let after: string | undefined
    for (;;) {
      const page = host.store.list(binding, 100, after); all.push(...page)
      if (page.length < 100) break
      after = page.at(-1)!.operationId
    }
    return all.filter(op => op.payload.kind === 'speech')
  }
  /** Ordinary reads from the original scope through one frozen upper. */
  const recoveryReads = () => reads.filter(read => read.through !== undefined || read.rewrite !== undefined).length
  return { ...f, get host() { return host }, get connections() { return services.connections }, owner, binding, bindInput: f.input, input, dispatched, wireEffects, reads, idle, speech, recoveryReads, port, adapter,
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

it('automatically backfills independent public replies across an in-place rewrite from the exact original scope without resending confirmed replies', async () => {
  const f = await fixture(undefined, false, true)
  const prefix = await readFile(f.transcript)
  await published(f, 'already-published', 'Already delivered')
  await appendFile(f.transcript, tool('vanished-tool', 'old bytes '.repeat(100))); f.host.refresh(); await f.idle()
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('missed-before', 'Missed before old reply') + assistant('already-published', 'Already delivered') + assistant('missed-after', 'Missed after old reply'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.map(item => item.text).sort()).toEqual(['Already delivered', 'Missed before old reply', 'Missed after old reply'].sort()), { timeout: 8000 }); await f.idle()
  expect(f.dispatched.filter(item => item.text === 'Already delivered')).toHaveLength(1)
  expect(f.speech().every(operation => operation.state === 'confirmed')).toBe(true)
  const checkpoint = f.host.store.retainedCheckpoint(f.binding)
  await f.restart(); await f.idle()
  expect(f.dispatched).toHaveLength(3)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(checkpoint)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)
it('keeps the original unknown prepared effect while recovering an independent missed reply through the actual Core → Publication → adapter chain', async () => {
  const f = await fixture('Unknown original', false, true), prefix = await readFile(f.transcript)
  await appendFile(f.transcript, assistant('unknown-original', 'Unknown original')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'unknown')).toBe(true)); await f.idle()
  const original = structuredClone(f.speech()[0]!)
  await appendFile(f.transcript, tool('unknown-vanished', 'old bytes '.repeat(100))); f.host.refresh(); await f.idle()
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('unknown-original', 'Unknown original') + assistant('independent-missed', 'Independent missed reply'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'Independent missed reply')).toBe(true), { timeout: 8000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched.filter(item => item.text === 'Unknown original')).toHaveLength(1)
  await f.restart(); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched.filter(item => item.text === 'Unknown original')).toHaveLength(1)
}, 30_000)
it('prechecks old effect versions before the first recovered effect and preserves a newer confirmed representation', async () => {
  const f = await fixture(undefined, false, true), prefix = await readFile(f.transcript)
  await published(f, 'versioned-original', 'Version one')
  await published(f, 'versioned-original', 'Version two already delivered')
  const original = structuredClone(f.speech()), sent = [...f.dispatched]
  await appendFile(f.transcript, tool('obsolete-tail', 'old '.repeat(200))); f.host.refresh(); await f.idle()
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('independent-new', 'Independent recovered reply') + assistant('versioned-original', 'Version one'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'Independent recovered reply')).toBe(true), { timeout: 8000 }); await f.idle()
  expect(f.dispatched.filter(item => item.text === 'Version one')).toHaveLength(sent.filter(item => item.text === 'Version one').length)
  expect(f.speech().filter(op => original.some(old => old.operationId === op.operationId))).toEqual(original)
  expect(f.host.store.coverage(f.binding).gaps.some(gap => gap.code === 'CONVERSATION_RECOVERY_VERSION_UNCONFIRMED')).toBe(true)
  expect(f.speech().filter(op => op.payload.kind === 'speech' && op.payload.text === 'Version one')).toHaveLength(original.filter(op => op.payload.kind === 'speech' && op.payload.text === 'Version one').length)
}, 30_000)
it('retains an unknown prepared old version while a different frozen version stays a gap and independent content progresses', async () => {
  const f = await fixture('Unknown old version', false, true), prefix = await readFile(f.transcript)
  await appendFile(f.transcript, assistant('same-original', 'Unknown old version')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(op => op.state === 'unknown')).toBe(true)); await f.idle()
  const original = structuredClone(f.speech()[0]!)
  await appendFile(f.transcript, tool('unproven-tail', 'old '.repeat(200))); f.host.refresh(); await f.idle()
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('independent', 'Independent after unknown') + assistant('same-original', 'Unproven changed version'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'Independent after unknown')).toBe(true), { timeout: 8000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched.some(item => item.text === 'Unproven changed version')).toBe(false)
  expect(f.dispatched.filter(item => item.text === 'Unknown old version')).toHaveLength(1)
}, 30_000)

it('durably stages more than one source page before effects and resumes the same frozen range after Host recreation', async () => {
  const f = await fixture(undefined, false, true), prefix = await readFile(f.transcript)
  await published(f, 'old-confirmed', 'Original confirmed effect')
  const old = structuredClone(f.speech()[0]), original = f.host.store.retainedCheckpoint(f.binding)
  const changes = f.port.changes.bind(f.port); let frozenReads = 0, held = false
  f.port.changes = async (input, signal) => {
    if (input.through && input.limit === 100 && ++frozenReads === 2) {
      held = true
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return await changes(input, signal)
  }
  const wanted = Array.from({ length: 135 }, (_, n) => 'Recovered page reply ' + n)
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(wanted.map((text, n) => assistant('recovered-' + n, text)).join('') + assistant('old-confirmed', 'Original confirmed effect'))])); f.host.refresh()
  await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 })
  expect(f.host.store.nativeRecovery(f.binding)?.phase).toBe('scanning')
  expect(f.host.store.retainedCheckpoint(f.binding)?.frontier.cuts.find(c => c.kind === 'native')).toEqual(original?.frontier.cuts.find(c => c.kind === 'native'))
  expect(f.dispatched.filter(item => wanted.includes(item.text))).toHaveLength(0)
  await f.restart()
  await vi.waitFor(() => expect(f.dispatched.filter(item => wanted.includes(item.text))).toHaveLength(wanted.length), { timeout: 20_000 })
  await f.idle()
  expect(new Set(f.dispatched.map(item => item.key)).size).toBe(f.dispatched.length)
  expect(f.host.store.inspect(old.operationId)).toEqual(old)
  expect(f.host.store.nativeRecovery(f.binding)?.phase).toBe('complete')
}, 35_000)

for (const field of ['phase', 'metrics'] as const) it(`retains the admitted old ${field} version of the same public text during recovery`, async () => {
  const f = await fixture(undefined, false, true), prefix = await readFile(f.transcript)
  const row = (phase: string, outputTokens: number) => JSON.stringify({ sessionId: 'ingress-native', uuid: 'same-metadata', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Same authored body' }], stop_reason: phase, usage: { input_tokens: 8, output_tokens: outputTokens } } }) + '\n'
  await appendFile(f.transcript, row('end_turn', 22)); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(operation => operation.state === 'confirmed')).toBe(true)); await f.idle()
  const original = structuredClone(f.speech()[0]); expect(original.payload).toMatchObject({ phase: 'final', replyMetadata: { metrics: { usage: { outputTokens: 22 } } } })
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(row(field === 'phase' ? 'tool_use' : 'end_turn', field === 'metrics' ? 7 : 22) + assistant('independent-metadata', 'Independent metadata recovery'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(value => value.text === 'Independent metadata recovery')).toBe(true), { timeout: 8000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.speech().filter(value => value.reference.source.kind === 'native' && value.reference.source.recordId === 'same-metadata')).toEqual([original])
  expect((await f.host.list(f.input)).coverage?.gaps.some(gap => gap.code === 'CONVERSATION_RECOVERY_VERSION_UNCONFIRMED')).toBe(true)
})

it('keeps the event loop and unrelated binding responsive while qualifying an 18k-record 69 MB source', async () => {
  const f = await fixture(undefined, false, true), other = await fixture(), prefix = await readFile(f.transcript)
  await published(f, 'old-large-confirmed', 'Original large-source effect')
  const beforeOther = other.reads.length, original = structuredClone(f.speech()[0])
  const rows = Array.from({ length: 18_000 }, (_, n) => tool('large-private-' + n, 'x'.repeat(3650))).join('')
  let ticks = 0, largestDelay = 0, last = performance.now()
  const timer = setInterval(() => { const now = performance.now(); largestDelay = Math.max(largestDelay, now - last); last = now; ticks++ }, 5)
  const started = performance.now()
  try {
    await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(rows + assistant('old-large-confirmed', 'Original large-source effect') + assistant('new-large-tail', 'Recovered after large private history'))])); f.host.refresh()
    await vi.waitFor(() => expect(f.dispatched.some(value => value.text === 'Recovered after large private history')).toBe(true), { timeout: 150_000, interval: 100 })
    await f.idle()
  } finally { clearInterval(timer) }
  expect(ticks).toBeGreaterThan(10); expect(largestDelay).toBeLessThan(1000)
  expect(other.reads.length).toBeLessThanOrEqual(beforeOther + 1)
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  console.info('NATIVE_RECOVERY_COST', JSON.stringify({ records: 18_000, bytes: Buffer.byteLength(rows), ms: Math.round(performance.now() - started), ticks, largestDelay: Math.round(largestDelay), unrelatedReads: other.reads.length - beforeOther }))
}, 165_000)

it('qualifies every original effect beyond 100 identities before admitting a recovered record', async () => {
  const f = await fixture(undefined, false, true), prefix = await readFile(f.transcript)
  const replies = Array.from({ length: 110 }, (_, n) => assistant('original-many-' + n, 'Confirmed original ' + n))
  await appendFile(f.transcript, replies.join('')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().filter(value => value.state === 'confirmed')).toHaveLength(110), { timeout: 15_000 }); await f.idle()
  const originals = structuredClone(f.speech())
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('new-many-before', 'New before complete effect inventory') + replies.slice(0, 109).join('') + assistant('original-many-109', 'Unconfirmed changed last identity') + assistant('new-many-after', 'New after complete effect inventory'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(value => value.text === 'New after complete effect inventory')).toBe(true), { timeout: 15_000 }); await f.idle()
  for (const original of originals) expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched.some(value => value.text === 'Unconfirmed changed last identity')).toBe(false)
  expect(f.dispatched.filter(value => value.text.startsWith('Confirmed original '))).toHaveLength(110)
}, 35_000)


it('owner-reviewed frozen legacy range sends nothing before exact approval and resumes automatic live delivery', async () => {
  const f = await fixture(), prefix = await readFile(f.transcript)
  await published(f, 'review-old', 'Already represented review reply')
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('review-before', 'Missed before owner review') + tool('review-private', 'PRIVATE TOOL BODY') + assistant('review-old', 'Already represented review reply') + assistant('review-after', 'Missed after owner review'))])); f.host.refresh(); await unavailable(f)
  const original = structuredClone(f.speech()[0]), cut = f.host.store.retainedCheckpoint(f.binding)
  const action = { ...f.input, review: { action: 'prepare' as const, operationId: 'review-original' } }
  await f.host.recoverSource(action, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'review-original')?.state).toBe('ready'), { timeout: 15_000 })
  const reviewed = await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: 'review-original', limit: 100 } }, f.owner)
  expect(reviewed.review).toMatchObject({ publicRecords: 3, excludedRecords: 2, unmappedEffects: 0 })
  expect(JSON.stringify(reviewed.review)).not.toContain('PRIVATE TOOL BODY')
  expect(reviewed.review?.items.map(item => item.disposition)).toContain('existing-effect')
  expect(f.dispatched.filter(item => item.text.startsWith('Missed'))).toHaveLength(0)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  const digest = reviewed.review!.digest!
  await expect(f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'review-original', digest: '0'.repeat(64) } }, f.owner)).rejects.toMatchObject({ code: 'PUBLICATION_SOURCE_CONFLICT' })
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'review-original', digest } }, f.owner)
  await vi.waitFor(() => expect(f.dispatched.filter(item => item.text.startsWith('Missed'))).toHaveLength(2), { timeout: 15_000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  await f.restart()
  expect((await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'review-original', digest } }, f.owner)).review?.acceptedDigest).toBe(digest)
  const reviewedBytes = await readFile(f.transcript)
  await published(f, 'review-live', 'Live after reviewed legacy repair')
  await writeFile(f.transcript, Buffer.concat([reviewedBytes, Buffer.from(assistant('future-before', 'Automatic future gap before prior reply') + assistant('review-live', 'Live after reviewed legacy repair') + assistant('future-after', 'Automatic future gap after prior reply'))])); f.host.refresh()
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'Automatic future gap after prior reply')).toBe(true), { timeout: 15_000 }); await f.idle()
  expect(f.dispatched.filter(item => item.text === 'Live after reviewed legacy repair')).toHaveLength(1)
  expect(f.dispatched.filter(item => item.text.startsWith('Missed'))).toHaveLength(2)
}, 35_000)

it('owner review refuses another actor and a managed Agent before capturing or exposing an offered range', async () => {
  const f = await fixture(), checkpoint = vi.spyOn(f.port, 'checkpoint')
  for (const actor of [{ kind: 'agent' as const, id: f.owner.actor.id }, { kind: 'user' as const, id: 'another-owner' }, { kind: 'device' as const, id: f.owner.actor.id }]) {
    await expect(f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'forbidden-review' } }, { actor })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(checkpoint).not.toHaveBeenCalled()
  expect(f.host.store.nativeReview(f.binding, 'forbidden-review')).toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('owner review retains inspectable immutable evidence after the original Binding is paused and refuses approval', async () => {
  const f = await fixture(), prefix = await readFile(f.transcript)
  await published(f, 'pause-old', 'Confirmed before owner review pause')
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('pause-new', 'No publication after authority pause') + assistant('pause-old', 'Confirmed before owner review pause'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'paused-range-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'paused-range-review')?.state).toBe('ready'), { timeout: 15_000 })
  const cut = f.host.store.retainedCheckpoint(f.binding), sent = f.dispatched.length
  const review = f.host.store.nativeReview(f.binding, 'paused-range-review')!
  expect(await f.connections.bindings!.pause({ operationId: 'pause-review-authority', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision }, f.owner)).toMatchObject({ state: 'applied' }); f.host.refresh()
  expect(await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: review.operationId, digest: review.digest! } }, f.owner)).toMatchObject({ disposition: 'disabled' })
  const inspected = await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: review.operationId, limit: 100 } }, f.owner)
  expect(inspected.review?.digest).toBe(review.digest)
  expect(inspected.review?.items.some(item => item.text === 'No publication after authority pause')).toBe(true)
  const foreign = structuredClone(review.from); foreign.agentSessionId = 'foreign-agent'; foreign.frontier.agentSessionId = 'foreign-agent'; for (const cut of foreign.frontier.cuts) if (cut.kind === 'native') cut.checkpoint.agentSessionId = 'foreign-agent'
  await expect(f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: review.operationId, after: foreign } }, f.owner)).rejects.toMatchObject({ code: 'PUBLICATION_SOURCE_CONFLICT' })
  expect((await f.host.recoverSource({ ...f.input, review: { action: 'cancel', operationId: review.operationId, digest: review.digest! } }, f.owner)).review?.state).toBe('cancelled')
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  expect(f.host.store.nativeReview(f.binding, review.operationId)?.acceptedDigest).toBeUndefined()
  expect(f.dispatched).toHaveLength(sent)
})
it('owner review cancellation keeps the original cut, exact offer and independent source capability', async () => {
  const f = await fixture(), checkpoint = f.host.store.retainedCheckpoint(f.binding)
  const original = f.port.changes.bind(f.port); let release!: () => void, held = false
  const wait = new Promise<void>(done => { release = done })
  f.port.changes = async (input, signal) => { if (input.through) { held = true; await wait }; return await original(input, signal) }
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'cancel-original' } }, f.owner)
  await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 })
  expect((await f.host.recoverSource({ ...f.input, review: { action: 'cancel', operationId: 'cancel-original' } }, f.owner)).review?.state).toBe('cancelled')
  release(); await f.idle()
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(checkpoint)
  expect((await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'cancel-original' } }, f.owner)).review?.state).toBe('cancelled')
  expect(f.dispatched).toHaveLength(0)
  await published(f, 'cancel-live', 'Independent live after review cancellation')
})
it('owner review never treats an unmapped legacy unknown effect as absent or replays it after a new range grant', async () => {
  const f = await fixture('Original unmapped unknown'), prefix = await readFile(f.transcript)
  await appendFile(f.transcript, assistant('unknown-unmapped', 'Original unmapped unknown')); f.host.refresh()
  await vi.waitFor(() => expect(f.speech()[0]?.state).toBe('unknown')); await f.idle()
  const original = structuredClone(f.speech()[0]!)
  // Synthetic old-format owner record: it predates complete membership proofs.
  const database = Reflect.get(f.host.store, 'database') as import('node:sqlite').DatabaseSync
  const legacy = { ...original }; delete legacy.sourceProofs
  database.prepare('UPDATE connector_publication_operation SET operation_json=? WHERE operation_id=?').run(JSON.stringify(legacy), original.operationId)
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('could-be-related', 'Ambiguous legacy candidate') + assistant('unknown-unmapped', 'Original unmapped unknown'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'legacy-unmapped-review' } }, f.owner)
  await vi.waitFor(() => expect(['ready', 'blocked']).toContain(f.host.store.nativeReview(f.binding, 'legacy-unmapped-review')?.state), { timeout: 15_000 })
  const offered = await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: 'legacy-unmapped-review', limit: 100 } }, f.owner)
  const receipt = await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'legacy-unmapped-review', digest: offered.review!.digest! } }, f.owner)
  await f.idle(); await f.restart(); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(legacy)
  expect(f.dispatched.filter(item => item.text === 'Original unmapped unknown')).toHaveLength(1)
  expect(f.dispatched.some(item => item.text === 'Ambiguous legacy candidate')).toBe(false)
  expect(receipt.review?.state).toBe('blocked')
  expect(offered.review).toMatchObject({ unmappedEffects: 1, unmappedOperations: [original.operationId] })
  expect(offered.review?.items.every(item => item.disposition === 'unconfirmed')).toBe(true)
}, 35_000)
it('owner-reviewed history keeps its exact immutable range and establishes a new future cut rather than a zero historical scope', async () => {
  const f = await fixture(), prefix = await readFile(f.transcript)
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('range-only', 'Explicitly reviewed history'))])); f.host.refresh(); await f.idle()
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'future-boundary-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'future-boundary-review')?.state).toBe('ready'), { timeout: 15_000 })
  const offered = f.host.store.nativeReview(f.binding, 'future-boundary-review')!
  const observed = await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: 'future-boundary-review', limit: 1 } }, f.owner)
  expect(observed.review?.next).not.toBeNull()
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'future-boundary-review', digest: offered.digest! } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeRecovery(f.binding)?.phase).toBe('complete'), { timeout: 15_000 }); await f.idle()
  const known = f.dispatched.length
  // This newly visible earlier history was not in the approved immutable range.
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('unreviewed-earlier', 'Unreviewed historical insertion') + assistant('range-only', 'Explicitly reviewed history'))])); f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation?.code === 'AGENT_SESSION_HISTORY_SOURCE_REPAIR_REQUIRED' || f.dispatched.some(item => item.text === 'Unreviewed historical insertion')).toBe(true), { timeout: 15_000 }); await f.idle()
  expect(f.dispatched).toHaveLength(known)
  expect((await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: 'future-boundary-review', limit: 100 } }, f.owner)).review?.items.some(item => item.text.includes('Unreviewed historical insertion'))).toBe(false)
}, 35_000)

import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
it.runIf(process.env.AGENTMUX_SOURCE_REVIEW_COMPILED === '1')('owner review uses the compiled CLI, original public RPC and Hosted forwarding with the same exact receipt', async () => {
  const owner = { actor: { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` } }
  const f = await fixture(undefined, false, false, owner), prefix = await readFile(f.transcript)
  await published(f, 'rpc-original', 'Original RPC effect')
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('rpc-backfill', 'Reviewed through compiled CLI') + assistant('rpc-original', 'Original RPC effect'))])); f.host.refresh(); await unavailable(f)
  const runtime = new core.AgentMuxHostedRuntimeService(f.client, null, () => ({ runtimeId: 'review-runtime', ownerInstanceId: 'review-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); cleanup.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'review.sock'), coreClients: f.coreClients, connections: f.connections, hostedRuntime: () => runtime }); await server.start(); cleanup.push(() => server.stop())
  const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => user.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); cleanup.push(() => managed.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc: user, waitForReady: false, forwardRpc: (method, params, call = {}) => user.call(method, params, call) }); cleanup.push(() => hosted.dispose())
  const request = { ...f.input, review: { action: 'prepare' as const, operationId: 'compiled-original-review' } }
  await expect(managed.call('connection.delivery.source.recover', request)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const prepared = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'source', 'recover', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(request))
  expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0)
  expect(JSON.parse(prepared.stdout).result.review.operationId).toBe(request.review.operationId)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, request.review.operationId)?.state).toBe('ready'), { timeout: 15_000 })
  const relinked = await f.connections.bindings!.relink({ ...f.bindInput, operationId: 'review-trigger-only', expectedRevision: f.binding.revision, scope: { ...f.bindInput.scope, input: 'all-messages' } }, f.owner)
  expect(relinked).toMatchObject({ state: 'applied', binding: { publicationBoundary: { revision: f.binding.revision } } })
  if (relinked.state !== 'applied') throw Error('Current trigger revision required')
  request.bindingRevision = relinked.binding.revision
  const inspected = await hosted.forwardRpc!('connection.delivery.source.recover', { ...request, review: { ...request.review, action: 'inspect', limit: 100 } })
  expect(inspected.review?.target.bindingRevision).toBe(f.binding.revision)
  expect(inspected.review?.items.find(item => item.text === 'Reviewed through compiled CLI')?.disposition).toBe('candidate')
  expect(inspected.review?.items.find(item => item.text === 'Original RPC effect')?.disposition).toBe('existing-effect')
  const approve = { ...request, review: { ...request.review, action: 'approve' as const, digest: inspected.review!.digest! } }
  // Drop this confirmed owner's response. Inspection/repetition retain its one receipt.
  await hosted.forwardRpc!('connection.delivery.source.recover', approve)
  await vi.waitFor(() => expect(f.dispatched.filter(item => item.text === 'Reviewed through compiled CLI')).toHaveLength(1), { timeout: 15_000 })
  const repeated = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'source', 'recover', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(approve))
  expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0)
  expect(JSON.parse(repeated.stdout).result.review.acceptedDigest).toBe(approve.review.digest)
  await f.idle(); expect(f.dispatched.filter(item => item.text === 'Reviewed through compiled CLI')).toHaveLength(1)
  const custody = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { providerId: 'claude', nativeSessionId: 'ingress-native' } }
  const before = new Set((await hosted.listConversationSnapshots(custody)).snapshots.map(snapshot => snapshot.reference))
  await hosted.conversationCheckpoint({ hostId: custody.hostId, agentSessionId: custody.agentSessionId, nativeSnapshot: 'scope', nativeSource: custody.source })
  const created = (await hosted.listConversationSnapshots(custody)).snapshots.find(snapshot => !before.has(snapshot.reference))!
  expect(created).toBeDefined()
  expect(await hosted.releaseConversationSnapshot({ ...custody, reference: created.reference })).toMatchObject({ released: true })
}, 45_000)

it('owner review rejects a different current native source and preserves the original publication frontier', async () => {
  const f = await fixture(), original = f.host.store.retainedCheckpoint(f.binding)
  const current = (await f.store.load()).find(record => record.agentSessionId === f.session.agentSessionId)!
  const path = join(f.root, 'current-source-b.jsonl')
  await writeFile(path, JSON.stringify({ sessionId: 'different-native', uuid: 'source-b', type: 'assistant', message: { role: 'assistant', content: 'Other source must not enter old audience' } }) + '\n')
  await f.store.compareAndSwap(current, { ...current, previousNativeHandle: current.nativeHandle, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'different-native', transcriptPath: path }, updatedAt: current.updatedAt + 1 })
  await f.inner.registry.load('local')
  const checkpoint = f.port.checkpoint.bind(f.port)
  f.port.checkpoint = async (input, signal) => {
    expect(input.nativeSource).toEqual({ providerId: 'claude', nativeSessionId: 'ingress-native' })
    // Precisely simulate a lower client returning the current source despite the
    // requested original selection; the Publication owner must reject this reply.
    return await checkpoint({ ...input, nativeSource: { providerId: 'claude', nativeSessionId: 'different-native' } }, signal)
  }
  await expect(f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'wrong-source-review' } }, f.owner)).rejects.toThrow()
  expect(f.host.store.nativeReview(f.binding, 'wrong-source-review')).toBeNull()
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(original)
  expect(f.host.store.nativeRecovery(f.binding)).toBeNull()
  expect(f.dispatched.some(item => item.text.includes('Other source'))).toBe(false)
})
it('owner review preserves the real T2 schema, staged pages and Outbox across a storage upgrade', async () => {
  const f = await fixture(undefined, false, true), prefix = await readFile(f.transcript)
  await published(f, 'schema-old', 'Confirmed before schema upgrade')
  const original = structuredClone(f.speech()[0]!), changes = f.port.changes.bind(f.port)
  let frozenReads = 0, held = false
  f.port.changes = async (input, signal) => {
    if (input.through && input.limit === 100 && ++frozenReads === 2) {
      held = true
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return await changes(input, signal)
  }
  const wanted = Array.from({ length: 135 }, (_, n) => 'Schema recovered ' + n)
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(wanted.map((text, n) => assistant('schema-new-' + n, text)).join('') + assistant('schema-old', 'Confirmed before schema upgrade'))])); f.host.refresh()
  await vi.waitFor(() => expect(held).toBe(true), { timeout: 15_000 })
  const database = Reflect.get(f.host.store, 'database') as import('node:sqlite').DatabaseSync
  const before = database.prepare('SELECT COUNT(*) AS n FROM connector_publication_native_recovery_record').get()!.n
  expect(Number(before)).toBeGreaterThan(0)
  // This is precisely the committed T2 table shape and an original in-flight phase.
  database.exec('ALTER TABLE connector_publication_native_recovery_record DROP COLUMN identity_qualified; DROP TABLE connector_publication_native_review')
  await f.restart()
  const reopened = Reflect.get(f.host.store, 'database') as import('node:sqlite').DatabaseSync
  expect(reopened.prepare('PRAGMA table_info(connector_publication_native_recovery_record)').all().some(column => column.name === 'identity_qualified')).toBe(true)
  expect(Number(reopened.prepare('SELECT COUNT(*) AS n FROM connector_publication_native_recovery_record').get()!.n)).toBeGreaterThanOrEqual(Number(before))
  await vi.waitFor(() => expect(f.dispatched.filter(item => wanted.includes(item.text))).toHaveLength(wanted.length), { timeout: 20_000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
}, 40_000)

it('owner review preserves newer confirmed reply metadata when an older nonpublic activity is reordered into the frozen range', async () => {
  const f = await fixture(undefined, false, false, context, 'codex'), prefix = await readFile(f.transcript)
  const message = (id: string, text: string, turn = 'metadata-turn') => JSON.stringify({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', phase: 'final_answer', turn_id: turn, content: [{ type: 'output_text', text }] } }) + '\n'
  const usage = (output: number) => JSON.stringify({ type: 'token_usage_record', payload: { id: 'same-usage-fact', turn_id: 'metadata-turn', thread_id: 'ingress-native', turn_token_usage: { input_tokens: 10, output_tokens: output, total_tokens: output + 10 } } }) + '\n'
  await appendFile(f.transcript, message('metadata-answer', 'Answer with newer metrics') + usage(22)); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(operation => operation.payload.kind === 'speech' && operation.payload.replyMetadata?.metrics?.usage?.outputTokens === 22 && operation.state === 'confirmed')).toBe(true), { timeout: 15_000 }); await f.idle()
  const originals = structuredClone(f.speech()), originalDispatch = f.dispatched.filter(item => item.text === 'Answer with newer metrics').length
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(usage(7) + message('metadata-answer', 'Answer with newer metrics') + message('metadata-new', 'Independent recovered metadata body', 'other-turn'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'auxiliary-metadata-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'auxiliary-metadata-review')?.state).toBe('ready'), { timeout: 15_000 })
  const offered = f.host.store.nativeReview(f.binding, 'auxiliary-metadata-review')!
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: offered.operationId, digest: offered.digest! } }, f.owner)
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'Independent recovered metadata body')).toBe(true), { timeout: 15_000 }); await f.idle()
  expect(f.dispatched.filter(item => item.text === 'Answer with newer metrics')).toHaveLength(originalDispatch)
  expect(f.dispatched.some(item => (item.metadata as { metrics?: { usage?: { outputTokens?: number } } })?.metrics?.usage?.outputTokens === 7)).toBe(false)
  for (const original of originals) expect(f.host.store.inspect(original.operationId)).toEqual(original)
}, 40_000)
it('owner review retains the exact response metadata across frozen large-resource capability changes', async () => {
  const f = await fixture(); Reflect.set(f.adapter, 'fragmentBytes', 128 * 1024)
  const prefix = await readFile(f.transcript), text = 'Frozen resource body 😀 '.repeat(95_000)
  const original = () => JSON.stringify({ sessionId: 'ingress-native', uuid: 'large-response', type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 8, output_tokens: 22 } } }) + '\n'
  await appendFile(f.transcript, original()); f.host.refresh()
  await vi.waitFor(() => expect(f.speech().some(operation => operation.state === 'confirmed' && operation.payload.kind === 'speech' && operation.payload.replyMetadata?.metrics?.usage?.outputTokens === 22)).toBe(true), { timeout: 30_000 }); await f.idle()
  const effects = structuredClone(f.speech()), sent = f.dispatched.length
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('resource-new', 'New body before original large resource') + original())])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'large-resource-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'large-resource-review')?.state).toBe('ready'), { timeout: 15_000 })
  const preview = await f.host.recoverSource({ ...f.input, review: { action: 'inspect', operationId: 'large-resource-review', limit: 100 } }, f.owner)
  expect(preview.review?.items.some(item => item.resources.length > 0)).toBe(true)
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: 'large-resource-review', digest: preview.review!.digest! } }, f.owner)
  await vi.waitFor(() => expect(f.dispatched.some(item => item.text === 'New body before original large resource')).toBe(true), { timeout: 30_000 }); await f.idle()
  expect(f.dispatched).toHaveLength(sent + 1)
  for (const original of effects) expect(f.host.store.inspect(original.operationId)).toEqual(original)
}, 90_000)

const reviewPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
const reviewMedia = (id: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 22 }, content: [
  { type: 'text', text: 'Confirmed text beside reviewed image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: reviewPng } }
] } }) + '\n'
it('owner review preserves confirmed speech metadata when the final original fragment is media', async () => {
  const f = await fixture(), prefix = await readFile(f.transcript)
  Reflect.set(f.adapter, 'images', { maxBytes: 1024 * 1024, accepts: () => true, upload: async () => ({ state: 'confirmed', imageKey: 'reviewed-image-key' }) })
  await appendFile(f.transcript, reviewMedia('text-media')); f.host.refresh()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).filter(op => op.reference.source.kind === 'native' && op.state === 'confirmed')).toHaveLength(2), { timeout: 15_000 }); await f.idle()
  const originals = structuredClone(f.host.store.list(f.binding)), effects = structuredClone(f.wireEffects)
  expect(originals.find(op => op.payload.kind === 'speech')?.payload).toMatchObject({ replyMetadata: { metrics: { usage: { outputTokens: 22 } } } })
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('media-new', 'Independent reply after media review') + reviewMedia('text-media'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'media-metadata-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'media-metadata-review')?.state).toBe('ready'), { timeout: 15_000 })
  const review = f.host.store.nativeReview(f.binding, 'media-metadata-review')!
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: review.operationId, digest: review.digest! } }, f.owner)
  await vi.waitFor(() => expect(f.dispatched.some(op => op.text === 'Independent reply after media review')).toBe(true), { timeout: 15_000 }); await f.idle()
  expect(f.wireEffects).toHaveLength(effects.length + 1)
  expect(f.wireEffects.slice(0, effects.length)).toEqual(effects)
  for (const original of originals) expect(f.host.store.inspect(original.operationId)).toEqual(original)
}, 35_000)
it('owner review retains recovery context for a pre-existing resource gap until its late original body completes', async () => {
  const f = await fixture(), prefix = await readFile(f.transcript)
  Reflect.set(f.adapter, 'images', { maxBytes: 1024 * 1024, accepts: () => true, upload: async () => ({ state: 'confirmed', imageKey: 'late-review-image-key' }) })
  const resource = f.port.resource.bind(f.port); let release!: () => void, held = false
  const wait = new Promise<void>(done => { release = done }); cleanup.push(() => release())
  f.port.resource = async (...args) => { const response = await resource(...args); if (args[1].recordId === 'late-media') { held = true; await wait }; return response }
  await appendFile(f.transcript, reviewMedia('late-media')); f.host.refresh()
  await vi.waitFor(() => { expect(held).toBe(true); expect(f.speech().some(op => op.state === 'confirmed' && op.payload.kind === 'speech' && op.payload.replyMetadata?.metrics?.usage?.outputTokens === 22)).toBe(true) }, { timeout: 15_000 }); await f.idle()
  const original = structuredClone(f.speech()[0]!), gap = f.host.store.coverage(f.binding).gaps.find(gap => gap.reason === 'resource-unavailable')!
  expect(gap).toBeDefined()
  await writeFile(f.transcript, Buffer.concat([prefix, Buffer.from(assistant('late-media-new', 'Independent reply beside pending original image') + reviewMedia('late-media'))])); f.host.refresh(); await unavailable(f)
  await f.host.recoverSource({ ...f.input, review: { action: 'prepare', operationId: 'late-media-review' } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeReview(f.binding, 'late-media-review')?.state).toBe('ready'), { timeout: 15_000 })
  const review = f.host.store.nativeReview(f.binding, 'late-media-review')!
  await f.host.recoverSource({ ...f.input, review: { action: 'approve', operationId: review.operationId, digest: review.digest! } }, f.owner)
  await vi.waitFor(() => expect(f.host.store.nativeRecovery(f.binding)?.phase).toBe('complete'), { timeout: 15_000 }); await f.idle()
  const database = Reflect.get(f.host.store, 'database') as import('node:sqlite').DatabaseSync
  const retained = database.prepare("SELECT decision_json FROM connector_publication_decision WHERE json_extract(decision_json,'$.gap.gapId')=? AND json_extract(decision_json,'$.state')='unresolved'").get(gap.gapId)!
  expect(JSON.parse(String(retained.decision_json)).nativeRecoveryId).toBe(f.host.store.nativeRecovery(f.binding)!.id)
  release()
  await vi.waitFor(() => expect(f.host.store.list(f.binding).some(op => op.payload.kind === 'image' && op.state === 'confirmed')).toBe(true), { timeout: 15_000 }); await f.idle()
  expect(f.host.store.inspect(original.operationId)).toEqual(original)
  expect(f.dispatched.filter(op => op.text === 'Confirmed text beside reviewed image')).toHaveLength(1)
  expect(f.dispatched.some(op => op.text === 'Independent reply beside pending original image')).toBe(true)
}, 45_000)
