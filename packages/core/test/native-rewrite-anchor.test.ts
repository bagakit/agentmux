import { afterEach, expect, it, vi } from 'vitest'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AgentMuxError } from '../src/errors.js'
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

it('rejects every record-anchor recovery request at the public boundary, including well-formed anchors', async () => {
  const f = await codex(), checkpoint = await f.checkpoint(), base = { ...f.ref, checkpoint }
  for (const rewrite of [{ anchors: [{ recordId: 'valid-id', digest: 'a'.repeat(64) }] }, { anchors: [] }, { anchors: [{ recordId: '', digest: 'short' }] }]) {
    expect(() => parseConversationChangesInput({ ...base, rewrite })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    await expect(f.client.readConversationChanges({ ...base, rewrite } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
})

it('ordinary changes from the original scope through a frozen upper includes records before an unchanged anchor', async () => {
  const f = await codex(), start = await f.checkpoint()
  const header = await readFile(f.path)
  await append(f.path, [assistant('anchor', 'Published'), call('old-tail')])
  const old = await consumed(f, start)
  await rewriteInPlace(f.path, header, [assistant('new-before', 'New before'), assistant('anchor', 'Published'), assistant('new-after', 'New after')])
  const through = await f.checkpoint()
  await append(f.path, [assistant('beyond-upper', 'Not in this range')])
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint: start, through, limit: 100 })
  expect(nativeCoverage(page).gaps).toEqual([])
  expect(ids(page)).toEqual(['new-before', 'anchor', 'new-after'])
  expect(nativeCoverage(await f.client.readConversationChanges({ ...f.ref, checkpoint: old.page.checkpoint })).gaps[0]?.code).toBe('AGENT_SESSION_HISTORY_REWRITTEN')
})

it('rejects an invalid rewrite before an unavailable source can mask the caller error', async () => {
  const f = await codex(), checkpoint = await f.checkpoint()
  const unavailable = vi.spyOn(f.client as never, 'conversationReader' as never)
    .mockRejectedValue(new AgentMuxError('The controlled original source is busy.', 'AGENT_SESSION_HISTORY_BUSY') as never)
  try {
    await expect(f.client.readConversationChanges({ ...f.ref, checkpoint, rewrite: { anchors: [{ recordId: '', digest: 'a'.repeat(64) }] } }))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(unavailable).not.toHaveBeenCalled()
    expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
  } finally { unavailable.mockRestore() }
})

it('reads a Claude message resent before any reply as appended history, never as a rewrite', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([
    { type: 'user', uuid: 'prompt-before', parentUuid: null, sessionId: 'native-main', message: { role: 'user', content: 'Earlier question' } },
    { type: 'assistant', uuid: 'reply-before', parentUuid: 'prompt-before', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] } }
  ]))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const start = (await f.client.conversationCheckpoint(ref)).checkpoint
  // Esc on a message nothing has answered, then the same text again: two equal prompts under one parent.
  const sent = { type: 'user', parentUuid: 'reply-before', sessionId: 'native-main', message: { role: 'user', content: 'Check the build' } }
  await append(f.path, [{ ...sent, uuid: 'prompt-unanswered' },
    { type: 'user', uuid: 'interrupt-line', parentUuid: 'prompt-unanswered', sessionId: 'native-main', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }])
  const before = await f.client.readConversationChanges({ ...ref, checkpoint: start, limit: 100 })
  await append(f.path, [{ ...sent, uuid: 'prompt-resent' }])
  const after = await f.client.readConversationChanges({ ...ref, checkpoint: before.checkpoint, limit: 100 })
  expect(nativeCoverage(after).gaps).toEqual([])
  expect(nativeCoverage(after).current).not.toBe('unavailable')
  expect(ids(after)).toEqual(['prompt-resent'])
  // The interrupted prompt stays in the conversation beside the resent one.
  const whole = await f.client.readConversationChanges({ ...ref, checkpoint: start, limit: 100 })
  expect(nativeCoverage(whole).gaps).toEqual([])
  expect(ids(whole).filter(id => id.startsWith('prompt-'))).toEqual(['prompt-unanswered', 'prompt-resent'])
})

it('retains native ordering but updates the digest with a newer original version', async () => {
  const f = await codex()
  const initial = await f.client.readAgentConversation(f.ref)
  await append(f.path, [assistant('same-original', 'first version')])
  const first = await f.client.readConversationChanges({ ...f.ref, checkpoint: initial.window.checkpoint, view: initial.window.view! })
  const firstRecord = records(first).find(row => row.original.item.id === 'same-original')!
  expect(firstRecord.order.kind).toBe('native-page')
  await append(f.path, [assistant('same-original', 'second version')])
  const next = await f.client.readConversationChanges({ ...f.ref, checkpoint: first.window.checkpoint, view: first.window.view! })
  const current = records(next).find(row => row.original.item.id === 'same-original')!
  expect(current.order.kind).toBe('native-page')
  if (firstRecord.order.kind !== 'native-page' || current.order.kind !== 'native-page') throw Error('Native records required')
  expect(current.original.item.contentParts).not.toEqual(firstRecord.original.item.contentParts)
  expect(current.order.recordDigest).toBe(createHash('sha256').update(jsonl([assistant('same-original', 'second version')]).trimEnd()).digest('hex'))
  expect(current.order.recordDigest).not.toBe(firstRecord.order.recordDigest)
})

it('reports a changed upper frontier continuation as an invalid cursor, not a replaced source', async () => {
  const f = await codex(), start = await f.checkpoint()
  await append(f.path, [assistant('new-large', 'a'.repeat(100_000))])
  const through = await f.checkpoint()
  const page = await f.client.readConversationChanges({ ...f.ref, checkpoint: start, through, maxBytes: 16384 })
  expect(page.nextCursor).toBeTruthy()
  await expect(f.client.readConversationChanges({ ...f.ref, checkpoint: start, cursor: page.nextCursor!, maxBytes: 16384 }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_CURSOR' })
})

it.each([['codex', 1], ['codex', 100], ['claude', 1], ['claude', 100]] as const)('keeps both %s versions on separate changes pages at limit %s', async (provider, limit) => {
  const f = provider === 'codex' ? await codex() : await (async () => {
    const source = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'start', sessionId: 'native-main', message: { role: 'user', content: 'Before the cut' } }]))
    closes.push(source.close)
    const ref = { hostId: 'local', agentSessionId: source.session.agentSessionId }
    return { ...source, ref, checkpoint: async () => (await source.client.conversationCheckpoint(ref)).checkpoint }
  })(), start = await f.checkpoint()
  const version = (text: string) => provider === 'codex' ? assistant('versioned', text) : { type: 'assistant', uuid: 'versioned', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  await append(f.path, [version('First'), version('Second')])
  let checkpoint = start, more = true
  const versions: string[] = []
  while (more) {
    const page = await f.client.readConversationChanges({ ...f.ref, checkpoint, limit })
    expect(nativeCoverage(page).gaps).toEqual([])
    for (const record of records(page)) versions.push(JSON.stringify(record.original.item.contentParts))
    expect(page.checkpoint).not.toEqual(checkpoint)
    checkpoint = page.checkpoint; more = page.more
  }
  expect(versions).toHaveLength(2)
  expect(versions[0]).toContain('First'); expect(versions[1]).toContain('Second')
})
