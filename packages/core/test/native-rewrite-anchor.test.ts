import { afterEach, expect, it } from 'vitest'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { consumeConversationWindowPage, parseConversationChangesInput, type ConversationChangesInput, type ConversationChangesPage, type ConversationCheckpoint } from '../src/conversation-changes.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

const assistant = (id: string, text: string) => ({ timestamp: '2026-11-02T16:04:26.304Z', type: 'response_item',
  payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] } })
const unterminatedCall = { timestamp: '2026-11-02T16:34:37.631Z', type: 'response_item',
  payload: { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'call-lost' } }
const rewrittenTool = { timestamp: '2026-11-02T16:34:40.932Z', type: 'response_item',
  payload: { type: 'function_call_output', call_id: 'call-lost', output: 'only in the old bytes' } }

async function codex() {
  const f = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }]))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  return { ...f, ref, checkpoint: async () => (await f.client.conversationCheckpoint(ref)).checkpoint }
}
const append = async (path: string, rows: unknown[]) => writeFile(path, Buffer.concat([await readFile(path), Buffer.from(jsonl(rows))]))
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
const anchorOf = (record: ReturnType<typeof records>[number]) => {
  if (record.reference.source.kind !== 'native') throw Error('The anchor must be an original native record')
  return { recordId: record.reference.source.recordId, revision: record.revision }
}

/** Codex resumed an interrupted turn and rewrote the bytes after it on the same file. */
async function rewriteInPlace(path: string, keep: Buffer, suffix: unknown[]) {
  await writeFile(path, Buffer.concat([keep, Buffer.from(jsonl(suffix))]))
}

it('reports an in-place rewrite before the saved cut as REWRITTEN, never as a different source', async () => {
  const f = await codex(), start = await f.checkpoint()
  const published = Buffer.from(await readFile(f.path))
  await append(f.path, [unterminatedCall, rewrittenTool])
  const before = await consumed(f, start)
  expect(before.records.map(record => record.original.item.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^codex-record:/u)]))
  // Same inode and beginning; the interrupted turn's later bytes are replaced and the file grows.
  await rewriteInPlace(f.path, published, [assistant('msg-after-resume', 'first public reply after resume'), assistant('msg-later', 'second reply')])
  const failed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100 })
  expect(nativeCoverage(failed).current).toBe('unavailable')
  expect(nativeCoverage(failed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
})

it('resumes at the newest unchanged consumed record and returns only records after it', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-published', 'published before the interruption'), unterminatedCall])
  // The rewrite keeps the interrupted turn's beginning and replaces what followed it.
  const kept = Buffer.from(await readFile(f.path))
  await append(f.path, [rewrittenTool])
  const before = await consumed(f, start)
  const anchors = [...before.records].reverse().map(anchorOf)
  expect(anchors.map(anchor => anchor.recordId)).toEqual(expect.arrayContaining(['msg-published']))
  await rewriteInPlace(f.path, kept, [assistant('msg-after-resume', 'first public reply after resume'), assistant('msg-later', 'second reply')])

  const input: ConversationChangesInput = { ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors } }
  const resumed = await f.client.readConversationChanges(input)
  expect(nativeCoverage(resumed).gaps).toEqual([])
  const ids = records(resumed).map(record => record.original.item.id)
  // The vanished consumed records are not re-read; earlier history is never re-read.
  expect(ids).toEqual(expect.arrayContaining(['msg-after-resume', 'msg-later']))
  // Neither the anchor (the kept call) nor anything before it is returned again.
  expect(ids).not.toContain('msg-published')
  expect(ids.some(id => id.startsWith('codex-record:'))).toBe(false)

  // The returned cut is an ordinary cut: the next append continues without anchors.
  await writeFile(f.path, Buffer.concat([await readFile(f.path), Buffer.from(jsonl([assistant('msg-next', 'appended after recovery')]))]))
  const next = await consumed(f, resumed.checkpoint)
  expect(next.records.map(record => record.original.item.id)).toEqual(['msg-next'])
})

it('refuses an anchor whose record ID now names different content', async () => {
  const f = await codex(), start = await f.checkpoint()
  const published = Buffer.from(await readFile(f.path))
  await append(f.path, [unterminatedCall, rewrittenTool])
  const before = await consumed(f, start)
  const positional = before.records.filter(record => record.original.item.id.startsWith('codex-record:')).map(anchorOf)
  expect(positional.length).toBeGreaterThan(0)
  // The same byte offsets now start different records: a position-based ID collision.
  await rewriteInPlace(f.path, published, [{ ...unterminatedCall, payload: { ...unterminatedCall.payload, arguments: '{"other":1}' } }, { ...rewrittenTool, payload: { ...rewrittenTool.payload, output: 'ONLY IN THE NEW BYTES' } }])
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors: [...positional].reverse() } })
  expect(nativeCoverage(resumed).current).toBe('unavailable')
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
  expect(records(resumed)).toEqual([])
})

it('keeps a replaced file a different source even with valid anchors', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-one', 'one'), assistant('msg-two', 'two')])
  const before = await consumed(f, start)
  const anchors = [...before.records].reverse().map(anchorOf)
  // A new inode with identical bytes is still another physical source.
  await writeFile(f.path + '.next', await readFile(f.path)); await rename(f.path + '.next', f.path)
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors } })
  expect(nativeCoverage(resumed).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(records(resumed)).toEqual([])
})

it('validates rewrite anchors at the public input boundary', async () => {
  const f = await codex(), checkpoint = await f.checkpoint(), base = { ...f.ref, checkpoint }
  const valid = { recordId: 'msg-published', revision: 'a'.repeat(64) }
  expect(parseConversationChangesInput({ ...base, rewrite: { anchors: [valid] } }).rewrite?.anchors).toEqual([valid])
  for (const rewrite of [{ anchors: [] }, { anchors: [{ ...valid, revision: 'short' }] }, { anchors: Array(65).fill(valid) }, { anchors: [valid], extra: 1 }])
    expect(() => parseConversationChangesInput({ ...base, rewrite })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  expect(() => parseConversationChangesInput({ ...base, through: checkpoint, rewrite: { anchors: [valid] } })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
})

it('keeps a rewritten beginning a different source even when an anchor record still matches', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('msg-one', 'one'), assistant('msg-two', 'two')])
  const before = await consumed(f, start)
  const anchors = [...before.records].reverse().map(anchorOf)
  // Same inode and creation time, but the file's first bytes (its session header) were rewritten.
  const lines = (await readFile(f.path, 'utf8')).split('\n')
  await writeFile(f.path, [JSON.stringify({ timestamp: '2026-11-03T00:00:00.000Z', ...JSON.parse(lines[0]!) }), ...lines.slice(1)].join('\n'))
  const plain = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100 })
  expect(nativeCoverage(plain).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  const anchored = await f.client.readConversationChanges({ ...f.ref, checkpoint: before.page.checkpoint, limit: 100, rewrite: { anchors } })
  expect(nativeCoverage(anchored).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect(records(anchored)).toEqual([])
})
