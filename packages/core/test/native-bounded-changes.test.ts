import { afterAll, afterEach, expect, it, vi } from 'vitest'

const privateEnvironment = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'amux-bounded-public-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_BOUNDED_')) delete process.env[key]
  Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'),
    CTXMUX_STATE_DIRECTORY: join(root, 'ctxmux') })
  return { root }
})

import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consumeConversationWindowPage, type ConversationChangesInput, type ConversationChangesPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '../src/conversation-changes.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

type Provider = 'pi' | 'claude'
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Private bounded fixture cleanup failed')
})
afterAll(async () => { await rm(privateEnvironment.root, { recursive: true, force: true }) })

const native = (provider: Provider, id: string, parent: string | null) => provider === 'pi'
  ? { type: 'message', id, parentId: parent, message: { role: 'user', content: [{ type: 'text', text: id }] } }
  : { type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content: id } }

async function fixture(provider: Provider = 'claude') {
  const f = await nativeHistoryFixture(provider, cwd => jsonl([
    ...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd }] : []), native(provider, 'outside-before', null)
  ]))
  const metadata = await f.store.loadMetadata()
  closes.push(async () => {
    try {
      expect(await f.store.loadMetadata()).toEqual(metadata)
      f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
    } finally { await f.close() }
  })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  closes.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  let parent = 'outside-before'
  return { ...f, ref, rpc,
    append: async (...ids: string[]) => {
      const rows = ids.map(id => { const row = native(provider, id, parent); parent = id; return row })
      await appendFile(f.path, jsonl(rows))
    },
    checkpoint: async () => (await f.client.conversationCheckpoint(ref)).checkpoint,
    captured: async (id: string) => { await f.store.applyTimelineMutation({ type: 'append', agentSessionId: ref.agentSessionId,
      item: { id, agentSessionId: ref.agentSessionId, kind: 'user_message', source: 'native-hook', status: 'complete',
        title: id, content: id, createdAt: 1, updatedAt: 1 } }) }
  }
}

function frame(page: ConversationChangesPage) {
  const accepted = consumeConversationWindowPage(page)
  expect(accepted.kind, 'The small original fixture must produce a complete, non-fragment frame').toBe('complete')
  if (accepted.kind !== 'complete') throw Error('The original bounded fixture exceeded one frame')
  return accepted.snapshot
}
const ids = (page: ConversationChangesPage) => frame(page).units.flatMap(unit => unit.records.map(record => record.original.item.id))
async function rejectedOriginalRead(reading: Promise<unknown>) {
  const result = await reading.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error }))
  expect(result.kind, 'The wrong original frontier must be explicitly rejected').toBe('rejected')
  if (result.kind === 'rejected') expect(result.error).toHaveProperty('code')
}

async function readAll(read: (input: ConversationChangesInput) => Promise<ConversationChangesPage>, input: ConversationChangesInput,
  betweenPages?: () => Promise<void>) {
  const pages: ConversationChangesPage[] = [], frames: ConversationWindowSnapshot[] = [], originals = new Set<string>()
  let cursor: string | undefined, checkpoint = input.checkpoint, assembly: ConversationWindowAssembly | undefined
  for (let i = 0; i < 64; i++) {
    const page = await read({ ...input, checkpoint, ...(cursor ? { cursor } : {}) })
    pages.push(page)
    const accepted = consumeConversationWindowPage(page, assembly)
    if (accepted.kind === 'pending') {
      assembly = accepted.pending
      expect(page.nextCursor, 'An incomplete wire frame must retain its original cursor').toBeTypeOf('string')
      cursor = page.nextCursor!
      continue
    }
    frames.push(accepted.snapshot)
    accepted.snapshot.units.flatMap(unit => unit.records).forEach(record => originals.add(record.original.item.id))
    if (!page.more) return { pages, frames, originals: [...originals] }
    // Source changes advance their original checkpoint. nextCursor only continues
    // this accepted frame, and is not the continuation of its native source.
    checkpoint = page.checkpoint; cursor = undefined; assembly = undefined
    if (frames.length === 1) await betweenPages?.()
  }
  throw Error('The finite bounded original source did not terminate')
}

it.each(['pi', 'claude'] as const)('%s actual native reader reaches Core and public changes with exact after/through and stable paging', async provider => {
  const f = await fixture(provider), lower = await f.checkpoint()
  await f.append('inside-one', 'inside-two', 'inside-three')
  const upper = await f.checkpoint()
  await f.append('outside-after')
  const input = { ...f.ref, checkpoint: lower, through: upper, limit: 1 }
  const bounded = await readAll(value => f.rpc.call('agent.conversation.changes', value), input,
    () => f.append('outside-between-pages'))
  expect(bounded.pages.length).toBeGreaterThan(1)
  expect(bounded.originals.sort()).toEqual(['inside-one', 'inside-three', 'inside-two'])
  for (const snapshot of bounded.frames) {
    const records = snapshot.units.flatMap(unit => unit.records)
    expect(records.length).toBeGreaterThan(0)
    expect(records.every(record => record.original.kind === 'native' && record.reference.source.kind === 'native' &&
      record.reference.source.providerId === provider && record.reference.source.nativeSessionId === 'native-main')).toBe(true)
    expect(snapshot.coverage.find(value => value.source.kind === 'native')?.gaps).toEqual([])
  }
  const sdk = await readAll(value => f.client.readConversationChanges(value), { ...input, limit: 2 })
  expect(sdk.originals.sort()).toEqual(bounded.originals.sort())
  const unbounded = await readAll(value => f.rpc.call('agent.conversation.changes', value), { ...f.ref, checkpoint: lower, limit: 2 })
  expect(unbounded.originals).toEqual(expect.arrayContaining(['inside-one', 'inside-two', 'inside-three', 'outside-after', 'outside-between-pages']))
  expect(unbounded.originals).not.toContain('outside-before')
})

it('a public continuation cannot change or drop its frozen through frontier', async () => {
  const f = await fixture('pi'), lower = await f.checkpoint()
  await f.append('inside-one', 'inside-two', 'inside-three')
  await f.captured('captured-inside')
  const upper = await f.checkpoint()
  await f.append('outside-after')
  const later = await f.checkpoint(), input = { ...f.ref, checkpoint: lower, through: upper, limit: 1 }
  const first = await f.rpc.call('agent.conversation.changes', input)
  expect(first.more).toBe(true); expect(first.nextCursor).toBeTypeOf('string')
  const opening = consumeConversationWindowPage(first)
  expect(opening.kind).toBe('pending')
  if (opening.kind !== 'pending') throw Error('The mixed source frame must exercise a real wire continuation')
  for (const through of [undefined, later]) {
    const changed = { ...input, through, cursor: first.nextCursor! }
    await rejectedOriginalRead(f.rpc.call('agent.conversation.changes', changed))
  }
  const replay = await f.rpc.call('agent.conversation.changes', { ...input, cursor: first.nextCursor! })
  const accepted = consumeConversationWindowPage(replay, opening.pending)
  expect(accepted.kind).toBe('complete')
  if (accepted.kind !== 'complete') throw Error('The mixed original frame must finish with its own cursor')
  expect(accepted.snapshot.units.flatMap(unit => unit.records.map(record => record.original.item.id))).not.toContain('outside-after')
})

it('foreign Host/SID or native source scope cannot supply an upper frontier for the original public read', async () => {
  const f = await fixture(), lower = await f.checkpoint()
  await f.append('inside-one')
  const upper = await f.checkpoint()
  const foreign = structuredClone(upper)
  foreign.frontier.scope.sources = foreign.frontier.scope.sources.map(source => source.kind === 'native'
    ? { ...source, nativeSessionId: 'another-native-source' } : source)
  foreign.frontier.cuts = foreign.frontier.cuts.map(cut => cut.kind === 'native'
    ? { ...cut, checkpoint: { ...cut.checkpoint, source: { ...cut.checkpoint.source, nativeSessionId: 'another-native-source' } } } : cut)
  for (const through of [{ ...upper, hostId: 'another-host' }, { ...upper, agentSessionId: 'another-session' }, foreign]) {
    await rejectedOriginalRead(f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: lower, through }))
    await rejectedOriginalRead(f.client.readConversationChanges({ ...f.ref, checkpoint: lower, through }))
  }
  expect(ids(await f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: lower, through: upper }))).toEqual(['inside-one'])
})

it.each(['foreign-file', 'replaced-prefix'] as const)('native %s cut fails as an explicit coverage gap without losing the original source', async kind => {
  const f = await fixture(), lower = await f.checkpoint()
  await f.append('inside-one')
  let upper = await f.checkpoint()
  if (kind === 'foreign-file') {
    const another = await fixture()
    await another.append('foreign-record')
    const otherUpper = await another.checkpoint()
    upper = { ...upper, frontier: { ...upper.frontier, cuts: upper.frontier.cuts.map(cut => cut.kind === 'native'
      ? otherUpper.frontier.cuts.find(value => value.kind === 'native')! : cut) } }
  } else {
    const bytes = await readFile(f.path)
    await rename(f.path, f.path + '.original'); await writeFile(f.path, bytes)
  }
  const result = await f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: lower, through: upper })
  const nativeCoverage = result.coverage.find(value => value.source.kind === 'native')!
  expect(nativeCoverage.current).toBe('unavailable')
  expect(nativeCoverage.gaps.length).toBeGreaterThan(0)
  expect(ids(result)).toEqual([])
  expect(result.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')).toEqual(lower.frontier.cuts.find(cut => cut.kind === 'native'))
})

it('captured appends use their independent ordered upper cut instead of the latest native or captured stream', async () => {
  const f = await fixture(), lower = await f.checkpoint()
  await f.captured('captured-inside-one'); await f.captured('captured-inside-two')
  await f.append('native-inside')
  const upper = await f.checkpoint()
  await f.captured('captured-outside'); await f.append('native-outside')
  const bounded = await readAll(input => f.rpc.call('agent.conversation.changes', input), { ...f.ref, checkpoint: lower, through: upper, limit: 1 })
  expect(bounded.originals.sort()).toEqual(['captured-inside-one', 'captured-inside-two', 'native-inside'])
  const unbounded = await readAll(input => f.rpc.call('agent.conversation.changes', input), { ...f.ref, checkpoint: lower })
  expect(unbounded.originals).toEqual(expect.arrayContaining(['captured-outside', 'native-outside']))
})

it('a captured revision after through cannot enter the bounded projection under its older record identity', async () => {
  const f = await fixture(), lower = await f.checkpoint()
  await f.captured('captured-inside')
  const upper = await f.checkpoint()
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.ref.agentSessionId, itemId: 'captured-inside',
    content: 'outside-later-revision', updatedAt: 2 })
  const bounded = await readAll(input => f.rpc.call('agent.conversation.changes', input), { ...f.ref, checkpoint: lower, through: upper })
  const records = bounded.frames.flatMap(snapshot => snapshot.units.flatMap(unit => unit.records)
    .flatMap(record => record.original.kind === 'captured' ? [record.original.item] : []))
  expect(records.map(record => record.content).join('\n')).not.toContain('outside-later-revision')
  if (records.some(record => record.id === 'captured-inside')) {
    expect(records.find(record => record.id === 'captured-inside')!.content).toBe('captured-inside')
  } else {
    expect(bounded.pages.flatMap(page => page.coverage.filter(value => value.source.kind === 'captured').flatMap(value => value.gaps)).length,
      'An unavailable old revision needs an explicit coverage gap, never silent loss').toBeGreaterThan(0)
  }
})
