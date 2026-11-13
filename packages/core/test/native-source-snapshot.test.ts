import { afterEach, expect, it } from 'vitest'
import { mkdtemp, open, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSourceSnapshots } from '../src/native-source-snapshot.js'
import { cloneNativeFile, nativeDataGeneration } from '../src/native-file-clone.js'
import { createRequire } from 'node:module'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-source-snapshot-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native.jsonl'); await writeFile(path, '{"id":"old"}\n')
  const source = await open(path, 'r+'); cleanups.push(() => source.close())
  const context = { directory: join(root, 'private'), secret: 'private-session-secret', agentSessionId: 'session-original', source: { providerId: 'provider', nativeSessionId: 'native-original' }, sourcePath: path }
  const store = new NativeSourceSnapshots(context), signal = new AbortController().signal
  const capture = () => store.capture(source, 'scope', signal, async (_fd, size) => ({ start: size, end: size }))
  return { root, path, source, context, store, signal, capture }
}
it('uses the held original FD after pathname replacement, with actual immutable descriptor clone', async () => {
  const f = await fixture(); await rename(f.path, f.path + '.old'); await writeFile(f.path, 'unrelated replacement')
  const receipt = await f.capture(); await f.source.write('CHANGED', 0)
  const lease = await f.store.open(receipt.reference)
  try { expect(await lease.file.readFile('utf8')).toBe('{"id":"old"}\n'); expect(lease.manifest.origin.ino).toBe(String((await f.source.stat()).ino)) }
  finally { await lease.close() }
  expect(await readFile(f.path, 'utf8')).toBe('unrelated replacement')
})
it('survives store recreation and rejects another source or a read capability used as release', async () => {
  const f = await fixture(), receipt = await f.capture()
  const reopened = new NativeSourceSnapshots(f.context), lease = await reopened.open(receipt.reference)
  await lease.close()
  await expect(new NativeSourceSnapshots({ ...f.context, agentSessionId: 'another' }).open(receipt.reference)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.store.release(receipt.reference)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect((await stat(f.store.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(lease.path)).mode & 0o777).toBe(0o600)
})
it('keeps active readers and makes explicit release idempotent across recreation', async () => {
  const f = await fixture(), receipt = await f.capture(), lease = await f.store.open(receipt.reference)
  await expect(f.store.release(receipt.release)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' })
  expect(await lease.file.readFile('utf8')).toContain('old'); await lease.close()
  expect(await f.store.release(receipt.release)).toEqual({ released: true })
  expect(await new NativeSourceSnapshots(f.context).release(receipt.release)).toEqual({ released: true })
  await expect(f.store.open(receipt.reference)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE' })
  expect(await readFile(f.path, 'utf8')).toContain('old')
})
it('does not publish cancelled or invalid candidates and preserves ordinary source reads', async () => {
  const f = await fixture(), abort = new AbortController()
  await expect(f.store.capture(f.source, 'range', abort.signal, async (_fd, size) => { abort.abort(); return { start: 0, end: size } })).rejects.toThrow()
  await expect(f.store.capture(f.source, 'range', f.signal, async (_fd, size) => ({ start: size + 1, end: size }))).rejects.toThrow()
  expect(await f.store.collectAbandoned()).toBe(0)
  expect(await readFile(f.path, 'utf8')).toContain('old')
})
it('reports real destination filesystem failure without consuming or changing the source', async () => {
  const f = await fixture(); const unavailable = join(f.root, 'not-directory'); await writeFile(unavailable, 'occupied')
  const broken = new NativeSourceSnapshots({ ...f.context, directory: unavailable })
  await expect(broken.capture(f.source, 'range', f.signal, async (_fd, size) => ({ start: 0, end: size }))).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe('{"id":"old"}\n')
})
it('isolates completed snapshot bytes from later original-source writes and leaves ordinary input/read ownership alone', async () => {
  const f = await fixture(), dst = join(f.root, 'race'); await mkdir(dst)
  // Hold the exact FD across the native worker call; mutating after clone can never
  // change already acquired snapshot bytes (the source remains writable).
  await cloneNativeFile(f.source, dst, 'source.jsonl', f.signal)
  await f.source.truncate(0); await f.source.writeFile('new source')
  expect(await readFile(join(dst, 'source.jsonl'), 'utf8')).toBe('{"id":"old"}\n')
  expect(await readFile(f.path, 'utf8')).toBe('new source')
})


it.runIf(process.platform === 'darwin')('qualifies the actual held-FD data generation, including ABA writes and unknown mmap data', async () => {
  const f = await fixture(); await f.source.truncate(4096)
  const before = nativeDataGeneration(f.source)!
  await f.source.write(Buffer.from('B'), 0, 1, 0); const changed = nativeDataGeneration(f.source)!
  await f.source.write(Buffer.from('{'), 0, 1, 0); const restored = nativeDataGeneration(f.source)!
  expect(changed).toBeGreaterThan(before); expect(restored).toBeGreaterThan(changed)
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi'), library = koffi.load('/usr/lib/libSystem.B.dylib')
  const mmap = library.func('void *mmap(void *address, size_t size, int protection, int flags, int fd, int64_t offset)')
  const munmap = library.func('int munmap(void *address, size_t size)')
  const mapped = mmap(null, 4096, 3, 1, f.source.fd, 0)
  try {
    expect(() => nativeDataGeneration(f.source)).toThrowError(expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE' }))
    await expect(f.capture()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SNAPSHOT_UNAVAILABLE' })
    expect((await readFile(f.path))[0]).toBe(123)
  } finally { expect(munmap(mapped, 4096)).toBe(0) }
  const receipt = await f.capture(), lease = await f.store.open(receipt.reference); await lease.close()
})
it.runIf(process.env.AGENTMUX_GENERATION_INTERLEAVE === '1')('rejects a real ABA writer after the native clone settles and before its generation ACK', async () => {
  const f = await fixture()
  const hooks = globalThis as typeof globalThis & { [key: symbol]: ((source: import('node:fs/promises').FileHandle) => Promise<void>) | undefined }
  let writes = 0
  hooks[Symbol.for('native-capture-interleave')] = async source => {
    await source.write(Buffer.from('B'), 0, 1, 0)
    await source.write(Buffer.from('{'), 0, 1, 0); writes++
  }
  try { await expect(f.capture()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' }); expect(writes).toBe(1) }
  finally { delete hooks[Symbol.for('native-capture-interleave')] }
  expect(await f.store.list(undefined, 10)).toEqual({ snapshots: [], next: null })
  expect(await readFile(f.path, 'utf8')).toBe('{"id":"old"}\n')
})
it('captures an active 69 MB source without rescanning all its bytes and preserves its accepted image', async () => {
  const f = await fixture(), { appendFile } = await import('node:fs/promises')
  await f.source.truncate(69_400_547)
  let writing: Promise<void> = Promise.resolve(), appends = 0
  const timer = setInterval(() => { writing = writing.then(async () => { await appendFile(f.path, 'active-append\n'); appends++ }) }, 4)
  const started = performance.now(); let accepted: Awaited<ReturnType<typeof f.capture>> | undefined
  try {
    for (let attempt = 0; attempt < 100 && !accepted; attempt++) {
      try { accepted = await f.capture() } catch (error) { expect(error).toMatchObject({ code: 'AGENT_SESSION_HISTORY_BUSY' }) }
    }
  } finally { clearInterval(timer); await writing }
  expect(accepted).toBeDefined(); expect(performance.now() - started).toBeLessThan(4000)
  const lease = await f.store.open(accepted!.reference)
  try { const size = (await lease.file.stat()).size; await appendFile(f.path, 'after-accept\n'); expect((await lease.file.stat()).size).toBe(size) }
  finally { await lease.close() }
  expect((await f.source.stat()).size).toBeGreaterThan(69_400_547)
})

import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
const message = (id: string, text: string) => ({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } })
for (const provider of ['codex', 'claude'] as const) it(`actual ${provider} Core checkpoint → frozen changes uses the same immutable original observation`, async () => {
  const rows = provider === 'codex'
    ? [{ type: 'session_meta', payload: { id: 'native-main' } }, message('first', 'original bytes'), message('second', 'second bytes')]
    : ['first', 'second'].map(uuid => ({ type: 'assistant', uuid, sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'text', text: uuid + ' original bytes' }] } }))
  const f = await nativeHistoryFixture(provider, root => jsonl(rows.map(row => row.type === 'session_meta' ? { ...row, payload: { ...row.payload, cwd: root } } : row))); cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const start = await f.client.conversationCheckpoint({ ...ref, nativePosition: 'beginning', nativeSnapshot: 'range' })
  expect(start.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  expect(start.checkpoint.frontier.cuts.find(c => c.kind === 'native')?.checkpoint.cursor).toMatch(/^nsc1\./u)
  await rm(f.path)
  let after = start.checkpoint; const ids: string[] = []
  for (let n = 0; n < 10; n++) {
    const page = await f.client.readConversationChanges({ ...ref, checkpoint: after, limit: 1 })
    expect(page.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
    const result = consumeConversationWindowPage(page); expect(result.kind).toBe('complete')
    if (result.kind === 'complete') ids.push(...result.snapshot.units.flatMap(u => u.records.map(r => r.original.item.id)))
    after = page.checkpoint; if (!page.more) break
  }
  expect(ids).toContain('first'); expect(ids).toContain('second')
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})
it('a captured scope checkpoint continues live appends without rereading the captured clone', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, message('private-before', 'private')])); cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const start = await f.client.conversationCheckpoint({ ...ref, nativeSnapshot: 'scope' })
  const { appendFile } = await import('node:fs/promises'); await appendFile(f.path, jsonl([message('public-after', 'public')]))
  const page = await f.client.readConversationChanges({ ...ref, checkpoint: start.checkpoint })
  expect(page.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  const result = consumeConversationWindowPage(page); expect(result.kind).toBe('complete')
  if (result.kind === 'complete') expect(result.snapshot.units.flatMap(u => u.records.map(r => r.original.item.id))).toEqual(['public-after'])
})

import { AgentMuxRpcService } from '../src/public-rpc-service.js'
it('the actual public RPC exposes original custody receipts and explicitly releases only the exact snapshot', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'reply', sessionId: 'native-main', message: { role: 'assistant', content: 'hello' } }])); cleanups.push(f.close)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); cleanups.push(() => service.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, source = { providerId: 'claude', nativeSessionId: 'native-main' }
  const cut = await service.call('agent.conversation.checkpoint', { ...ref, nativeSnapshot: 'scope' })
  expect(cut.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  const page = await service.call('agent.conversation.snapshot.ls', { ...ref, source, limit: 1 })
  expect(page.snapshots).toHaveLength(1); expect(page.snapshots[0]).toMatchObject({ purpose: 'scope', released: false })
  expect(await service.call('agent.conversation.snapshot.release', { ...ref, source, reference: page.snapshots[0]!.reference }, { principal: { kind: 'user', id: 'fixture-owner' } })).toMatchObject({ released: true })
  expect((await service.call('agent.conversation.snapshot.ls', { ...ref, source })).snapshots[0]?.released).toBe(true)
  expect((await f.client.readAgentConversation(ref)).items.length).toBeGreaterThan(0)
})
it('collects a sealed but unoffered candidate after the producer lease ends, preserving offered cuts', async () => {
  const f = await fixture(), orphan = await f.capture()
  expect(await f.store.collectAbandoned()).toBe(1)
  await expect(f.store.open(orphan.reference)).rejects.toThrow()
  const retained = await f.capture(), lease = await f.store.open(retained.reference)
  await f.store.retain(lease); await lease.close()
  expect(await f.store.collectAbandoned()).toBe(0)
  expect((await f.store.list(undefined, 10)).snapshots.map(s => s.reference)).toEqual([retained.reference])
})

async function recoveryFixture() {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, message('private-before', 'Private prefix '.repeat(100))])); cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, prefix = await readFile(f.path)
  const scope = (await f.client.conversationCheckpoint({ ...ref, nativeSnapshot: 'scope' })).checkpoint
  const { appendFile } = await import('node:fs/promises'); await appendFile(f.path, jsonl([message('old-tail', 'old tail '.repeat(100))]))
  const old = await f.client.readConversationChanges({ ...ref, checkpoint: scope, limit: 100 })
  expect(old.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  return { ...f, ref, prefix, scope, after: old.checkpoint }
}
it('validates the complete frozen range before recovering, excludes private-prefix IDs copied after the original scope, and resumes later live appends', async () => {
  const f = await recoveryFixture()
  await writeFile(f.path, Buffer.concat([f.prefix, Buffer.from(jsonl([message('new-before', 'missed before'), message('private-before', 'Private prefix '.repeat(100)), message('new-after', 'missed after')]))]))
  const ordinary = await f.client.readConversationChanges({ ...f.ref, checkpoint: f.after })
  expect(ordinary.coverage.find(c => c.source.kind === 'native')?.gaps.length).toBeGreaterThan(0)
  let checkpoint = f.after; const ids: string[] = []
  for (let n = 0; n < 10; n++) {
    const page = await f.client.readConversationChanges({ ...f.ref, checkpoint, ...(n === 0 ? { recover: f.scope } : {}), limit: 1 })
    expect(page.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
    const result = consumeConversationWindowPage(page); if (result.kind !== 'complete') throw Error('Expected a complete page')
    ids.push(...result.snapshot.units.flatMap(unit => unit.records.map(r => r.original.item.id))); checkpoint = page.checkpoint
    if (n === 0) await writeFile(f.path, 'source replaced during frozen continuation\n')
    if (!page.more) break
  }
  expect(ids).toEqual(['new-before', 'new-after'])
  // Reinstall precisely the qualified source, then append. No gap-time append is
  // skipped by replacing the frozen end with a newly observed live tail.
  await writeFile(f.path, Buffer.concat([f.prefix, Buffer.from(jsonl([message('new-before', 'missed before'), message('private-before', 'Private prefix '.repeat(100)), message('new-after', 'missed after'), message('later-live', 'later')]))]))
  const live = await f.client.readConversationChanges({ ...f.ref, checkpoint })
  expect(live.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  expect(consumeConversationWindowPage(live)).toMatchObject({ kind: 'complete', snapshot: { units: [expect.objectContaining({ records: [expect.objectContaining({ original: expect.objectContaining({ item: expect.objectContaining({ id: 'later-live' }) }) })] })] } })
})
it('rejects an interior original-scope change even when the sampled old head and tail match', async () => {
  const f = await recoveryFixture(), changed = Buffer.from(f.prefix)
  changed[500] = changed[500] === 65 ? 66 : 65
  await writeFile(f.path, Buffer.concat([changed, Buffer.from(jsonl([message('new', 'must not be authorized')]))]))
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint: f.after, recover: f.scope })
  expect(page.coverage.find(c => c.source.kind === 'native')?.gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_REPAIR_REQUIRED')
  expect(page.checkpoint.frontier.cuts.find(c => c.kind === 'native')).toEqual(f.after.frontier.cuts.find(c => c.kind === 'native'))
})
it('rejects a conflicting stable identity on a later source page before emitting the first recovered public record', async () => {
  const f = await recoveryFixture()
  await writeFile(f.path, Buffer.concat([f.prefix, Buffer.from(jsonl([message('same-id', 'first version'), ...Array.from({ length: 105 }, (_, n) => message('between-' + n, 'middle')), message('same-id', 'conflicting late version')]))]))
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint: f.after, recover: f.scope, limit: 1 })
  expect(page.coverage.find(c => c.source.kind === 'native')?.gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_REPAIR_REQUIRED')
  expect(consumeConversationWindowPage(page)).toMatchObject({ kind: 'complete', snapshot: { units: [] } })
})
it('does not recover through a replaced native file even when the whole sharing prefix is identical', async () => {
  const f = await recoveryFixture(); await rename(f.path, f.path + '.original')
  await writeFile(f.path, Buffer.concat([f.prefix, Buffer.from(jsonl([message('replacement', 'different file')]))]))
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint: f.after, recover: f.scope })
  expect(page.coverage.find(c => c.source.kind === 'native')?.gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(consumeConversationWindowPage(page)).toMatchObject({ kind: 'complete', snapshot: { units: [] } })
})
for (const provider of ['codex', 'claude'] as const) it(`recovers independent stable ${provider} public messages despite unrelated positional/private bookkeeping and tool protocol`, async () => {
  const f = await nativeHistoryFixture(provider, root => provider === 'codex'
    ? jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, { type: 'compacted', payload: {}, message: 'private context '.repeat(100) }, { type: 'event_msg', payload: { type: 'agent_message', message: 'activity copy' } }])
    : jsonl([{ type: 'system', sessionId: 'native-main', message: { role: 'system', content: 'private bookkeeping '.repeat(100) } }])); cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, prefix = await readFile(f.path)
  const scope = (await f.client.conversationCheckpoint({ ...ref, nativeSnapshot: 'scope' })).checkpoint
  const oldMessage = provider === 'codex' ? message('old', 'old '.repeat(200)) : { type: 'assistant', uuid: 'old', sessionId: 'native-main', message: { role: 'assistant', content: 'old '.repeat(200) } }
  const { appendFile } = await import('node:fs/promises'); await appendFile(f.path, jsonl([oldMessage]))
  const after = (await f.client.readConversationChanges({ ...ref, checkpoint: scope })).checkpoint
  const tool = provider === 'codex'
    ? [{ type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'unrelated-call' } }, { type: 'response_item', payload: { type: 'function_call_output', output: 'done', call_id: 'unrelated-call' } }, { type: 'event_msg', payload: { type: 'agent_message', message: 'process copy' } }]
    : [{ type: 'assistant', uuid: 'tool-record', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'unrelated-call', name: 'exec', input: {} }] } }, { type: 'user', sessionId: 'native-main', uuid: 'tool-result-record', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unrelated-call', content: 'done' }] } }]
  const reply = provider === 'codex' ? message('independent-public', 'Independent public reply') : { type: 'assistant', uuid: 'independent-public', sessionId: 'native-main', message: { role: 'assistant', content: 'Independent public reply' } }
  await writeFile(f.path, Buffer.concat([prefix, Buffer.from(jsonl([...tool, reply]))]))
  const page = await f.client.readConversationChanges({ ...ref, checkpoint: after, recover: scope, limit: 100 })
  expect(page.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
  const accepted = consumeConversationWindowPage(page); if (accepted.kind !== 'complete') throw Error('Complete fixture expected')
  expect(accepted.snapshot.units.flatMap(unit => unit.records).some(record => record.original.item.id === 'independent-public' && record.order.kind === 'native-page' && record.order.recordIdentity === 'protocol')).toBe(true)
})

import { AgentMuxClient } from '../src/client.js'
it('retains frozen cursors and signed large resources across Run Hook rotation and Core recreation', async () => {
  const text = 'Original frozen text 😀 '.repeat(110_000)
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'large', sessionId: 'native-main', message: { role: 'assistant', content: text } }])); cleanups.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const cut = await f.client.conversationCheckpoint({ ...ref, nativePosition: 'beginning', nativeSnapshot: 'range' })
  const page = await f.client.readConversationChanges({ ...ref, checkpoint: cut.checkpoint, maxBytes: 4 * 1024 * 1024 })
  const result = consumeConversationWindowPage(page); if (result.kind !== 'complete') throw Error('One complete frame expected')
  const item = result.snapshot.units.flatMap(unit => unit.records).find(record => record.original.item.id === 'large')!.original.item
  if (!('contentParts' in item)) throw Error('Native original required')
  const part = item.contentParts[0]!; expect(part.kind).toBe('resource'); if (part.kind !== 'resource') throw Error('Expected exact deferred resource')
  const current = (await f.store.load())[0]!
  await f.store.compareAndSwap(current, { ...current, hookToken: 'rotated-run-hook-secret', updatedAt: current.updatedAt + 1 })
  await writeFile(f.path, 'rewritten live native source\n')
  const reopened = new AgentMuxClient({ store: f.store }); cleanups.push(() => reopened.dispose())
  const resource = await reopened.sessionHistoryResource(ref.agentSessionId, { source: { providerId: 'claude', nativeSessionId: 'native-main' }, recordId: 'large', partIndex: 0, expectedReference: part.reference, maxBytes: 4096 })
  expect(resource.result.status).toBe('fragment')
  if (resource.result.status === 'fragment') expect(Buffer.from(resource.result.dataBase64, 'base64').toString('utf8')).toContain('Original frozen text')
  const again = await reopened.readConversationChanges({ ...ref, checkpoint: cut.checkpoint, maxBytes: 4 * 1024 * 1024 })
  expect(again.coverage.find(c => c.source.kind === 'native')?.gaps).toEqual([])
})

import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
it.runIf(process.env.AGENTMUX_CONTINUITY_COMPILED === '1')('the compiled CLI creates a frozen original checkpoint, lists custody, and reads it after live source rewrite', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'cli-original', sessionId: 'native-main', message: { role: 'assistant', content: 'CLI frozen original' } }])); cleanups.push(f.close)
  const compiled = await import('../dist/index.js'), client = new compiled.AgentMuxClient({ store: new compiled.AgentMuxFileAgentSessionStore(f.storePath) }); cleanups.push(() => client.dispose())
  const server = new compiled.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] }); await server.start(); cleanups.push(() => server.stop())
  const cut = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', 'local', '--session', f.session.agentSessionId, '--native-position', 'beginning', '--native-snapshot', 'range'], objectCliEnvironment(f.root))
  expect(cut.code, cut.stderr).toBe(0)
  const checkpoint = JSON.parse(cut.stdout).result.checkpoint
  await writeFile(f.path, 'live file rewritten\n')
  const changed = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ hostId: 'local', agentSessionId: f.session.agentSessionId, checkpoint }))
  expect(changed.code, changed.stderr).toBe(0); expect(changed.stdout).toContain('CLI frozen original')
  const listed = await runCompiledObjectCli(['agent', 'conversation', 'snapshot', 'ls', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ hostId: 'local', agentSessionId: f.session.agentSessionId, source: { providerId: 'claude', nativeSessionId: 'native-main' } }))
  expect(listed.code, listed.stderr).toBe(0); expect(JSON.parse(listed.stdout).result.snapshots).toHaveLength(1)
}, 30_000)
