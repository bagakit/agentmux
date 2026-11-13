import { afterEach, expect, it } from 'vitest'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { consumeConversationWindowPage, parseConversationChangesInput, type ConversationChangesPage, type ConversationCheckpoint } from '../src/conversation-changes.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

const assistant = (id: string, text: string) => ({ timestamp: '2000-01-01T00:00:01.000Z', type: 'response_item',
  payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } })
// Records without payload.id: Codex names them by byte position (codex-record:<offset>).
const call = (callId: string, args = '{}') => ({ timestamp: '2000-01-01T00:00:02.000Z', type: 'response_item',
  payload: { type: 'function_call', name: 'exec', arguments: args, call_id: callId } })
const output = (callId: string, text: string) => ({ timestamp: '2000-01-01T00:00:03.000Z', type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output: text } })

async function codex() {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }]))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  return { ...f, ref, checkpoint: async () => (await f.client.conversationCheckpoint(ref)).checkpoint }
}
const append = async (path: string, rows: unknown[]) => writeFile(path, Buffer.concat([await readFile(path), Buffer.from(jsonl(rows))]))
/** A complete window's records, newest first as the Core wire declares. */
const records = (page: ConversationChangesPage) => {
  const accepted = consumeConversationWindowPage(page)
  if (accepted.kind !== 'complete') throw Error('The small rewrite fixture must form one complete frame')
  return accepted.snapshot.units.flatMap(unit => unit.records)
}
const nativeCoverage = (page: ConversationChangesPage) => page.coverage.find(value => value.source.kind === 'native')!
async function consumed(f: Awaited<ReturnType<typeof codex>>, checkpoint: ConversationCheckpoint) {
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint, limit: 100 })
  return { page, records: records(page) }
}
/** What a durable consumer keeps, newest first: the Provider ID and the digest Core returned with the record. */
const anchorsOf = (rows: ReturnType<typeof records>) => rows.flatMap(record =>
  record.reference.source.kind === 'native' && record.order.kind === 'native-page' && record.order.recordDigest
    ? [{ recordId: record.reference.source.recordId, digest: record.order.recordDigest }] : [])
/** Record IDs in the order they were written. */
const ids = (page: ConversationChangesPage) => records(page).map(record => record.original.item.id).reverse()

/** Codex resumed an interrupted turn and rewrote the bytes after it on the same file. */
async function rewriteInPlace(path: string, keep: Buffer, suffix: unknown[]) {
  await writeFile(path, Buffer.concat([keep, Buffer.from(jsonl(suffix))]))
}

it('reports an in-place rewrite before the saved cut as REWRITTEN, never as a different source', async () => {
  const f = await codex(), start = await f.checkpoint()
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [call('call-lost'), output('call-lost', 'only in the old bytes')])
  const before = await consumed(f, start)
  expect(anchorsOf(before.records).length, 'every consumed native record carries its digest').toBe(before.records.length)
  await rewriteInPlace(f.path, kept, [assistant('msg-after-resume', 'first reply after resume'), assistant('msg-later', 'second reply')])
  const failed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100 })
  expect(nativeCoverage(failed).current).toBe('unavailable')
  expect(nativeCoverage(failed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
})

it('resumes just after the newest byte-identical consumed record and returns only later records', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-published', 'published before the interruption'), call('call-kept')])
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [output('call-kept', 'only in the old bytes')])
  const before = await consumed(f, start)
  await rewriteInPlace(f.path, kept, [assistant('msg-after-resume', 'first reply after resume'), assistant('msg-later', 'second reply')])

  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(resumed).gaps).toEqual([])
  // Neither the anchor (the kept call) nor anything before it is returned again.
  expect(ids(resumed)).toEqual(['msg-after-resume', 'msg-later'])

  // The returned cut is an ordinary cut: the next append continues without anchors.
  await append(f.path, [assistant('msg-next', 'appended after recovery')])
  expect(ids((await consumed(f, resumed.checkpoint)).page)).toEqual(['msg-next'])
})

it('does not let a position ID at the rewrite boundary stop the search for an older identical record', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-published', 'published before the interruption')])
  const kept = Buffer.from(await readFile(f.path))
  // Old: a position-named record at the boundary Y was read but never delivered.
  await append(f.path, [call('call-old', '{"old":true}')])
  const before = await consumed(f, start)
  // The consumer's anchors are its delivered records; the boundary record is not among them.
  const anchors = anchorsOf(before.records).filter(anchor => anchor.recordId === 'msg-published')
  expect(anchorsOf(before.records)[0]!.recordId).toMatch(/^codex-record:/u)
  // New: another position-named record starts at the same Y and reuses that ID.
  await rewriteInPlace(f.path, kept, [call('call-new', '{"new":true}'), assistant('msg-after-resume', 'reply after resume')])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors } })
  expect(nativeCoverage(resumed).gaps).toEqual([])
  // Recovery resumes after the older identical record; the new boundary record is new content.
  expect(ids(resumed)).toEqual([anchorsOf(before.records)[0]!.recordId, 'msg-after-resume'])
})

it('refuses rather than give a delivered position ID new bytes at the rewrite boundary', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-published', 'published before the interruption')])
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [call('call-old', '{"old":true}')])
  const before = await consumed(f, start)
  // Both records were delivered, so both are anchors; the boundary one's ID is reused for new bytes.
  await rewriteInPlace(f.path, kept, [call('call-new', '{"new":true}'), assistant('msg-after-resume', 'reply after resume')])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
  expect(records(resumed)).toEqual([])
})

it('refuses when a consumed position ID names other bytes after the found anchor, so delivered content keeps its identity', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-published', 'published before the interruption')])
  const kept = Buffer.from(await readFile(f.path))
  // Old suffix: a position-named record P and a later stable record, both consumed.
  await append(f.path, [output('call-a', 'old output at P'), assistant('msg-old-later', 'old later reply')])
  const before = await consumed(f, start)
  const positional = before.records.find(record => record.original.item.id.startsWith('codex-record:'))!
  // The consumer keeps only the stable record as its anchor; P was consumed but is not an anchor.
  const anchors = anchorsOf(before.records).filter(anchor => anchor.recordId === 'msg-published' || anchor.recordId === positional.original.item.id)
  // New suffix: different bytes at P reuse its consumed ID; the found anchor is the older stable one.
  await rewriteInPlace(f.path, kept, [output('call-a', 'NEW output at the same position'), assistant('msg-after-resume', 'reply after resume')])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors } })
  expect(nativeCoverage(resumed).current).toBe('unavailable')
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
  expect(records(resumed)).toEqual([])
})

it('matches an unchanged record that carries a large signed resource across reads', async () => {
  const f = await codex(), start = await f.checkpoint()
  // A string over half the page budget is read as a signed resource whose reference embeds read state.
  await append(f.path, [assistant('msg-large', 'x'.repeat(2_200_000))])
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [call('call-lost')])
  const before = await consumed(f, start)
  // The file grows before recovery, so the resource reference differs; the physical bytes do not.
  await rewriteInPlace(f.path, kept, [assistant('msg-after-resume', 'reply after resume')])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(resumed).gaps).toEqual([])
  expect(ids(resumed)).toEqual(['msg-after-resume'])
})

it('refuses as a rewrite, not a different source, when no consumed record remains in the same file', async () => {
  const f = await codex(), start = await f.checkpoint()
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [assistant('msg-old-a', 'first consumed reply'), assistant('msg-old-b', 'second consumed reply')])
  const before = await consumed(f, start)
  // Every consumed record is gone and no new record reuses a consumed ID.
  await rewriteInPlace(f.path, kept, [assistant('msg-new', 'reply after resume')])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
  expect(records(resumed)).toEqual([])
})

it('keeps a replaced file a different source even with valid anchors', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-one', 'one'), assistant('msg-two', 'two')])
  const before = await consumed(f, start)
  // A new inode with identical bytes is still another physical source.
  await writeFile(f.path + '.next', await readFile(f.path)); await rename(f.path + '.next', f.path)
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(records(resumed)).toEqual([])
})

it('keeps a rewritten beginning a different source even when an anchor record still matches', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-one', 'one'), assistant('msg-two', 'two')])
  const before = await consumed(f, start)
  // Same inode and creation time, but the file's first bytes (its session header) were rewritten.
  const lines = (await readFile(f.path, 'utf8')).split('\n')
  await writeFile(f.path, [JSON.stringify({ timestamp: '2000-01-01T00:00:04.000Z', ...JSON.parse(lines[0]!) }), ...lines.slice(1)].join('\n'))
  const plain = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100 })
  expect(nativeCoverage(plain).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  const anchored = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: anchorsOf(before.records) } })
  expect(nativeCoverage(anchored).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(records(anchored)).toEqual([])
})

it('validates rewrite anchors at the public input boundary', async () => {
  const f = await codex(), checkpoint = await f.checkpoint(), base = { ...f.ref, checkpoint }
  const valid = { recordId: 'msg-published', digest: 'a'.repeat(64) }
  expect(parseConversationChangesInput({ ...base, rewrite: { anchors: [valid] } }).rewrite?.anchors).toEqual([valid])
  for (const rewrite of [{ anchors: [] }, { anchors: [{ ...valid, digest: 'short' }] }, { anchors: [{ recordId: 'x', revision: 'a'.repeat(64) }] }, { anchors: Array(65).fill(valid) }, { anchors: [valid], extra: 1 }])
    expect(() => parseConversationChangesInput({ ...base, rewrite })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  expect(() => parseConversationChangesInput({ ...base, through: checkpoint, rewrite: { anchors: [valid] } })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
})
