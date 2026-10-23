import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const fixtures: Array<{ f: Awaited<ReturnType<typeof nativeHistoryFixture>>; metadata: unknown; native: Buffer }> = []
afterEach(async () => {
  for (const { f, metadata, native } of fixtures.splice(0)) {
    try {
      expect(await f.store.loadMetadata()).toEqual(metadata)
      expect((await f.bytes()).native).toEqual(native)
      expect(f.controls).toHaveLength(6)
      f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
    } finally { await f.close() }
  }
})

const message = (id: string, parentId: string | null, content = 'Same original native body.') =>
  ({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: content }] } })
async function fixture(entries: unknown[]) {
  const f = await nativeHistoryFixture('pi', cwd => jsonl([{ type: 'session', version: 3, id: 'native-main', cwd }, ...entries]))
  const owner = { f, metadata: await f.store.loadMetadata(), native: f.before.native }
  fixtures.push(owner)
  return { ...f, ref: { hostId: 'local', agentSessionId: f.session.agentSessionId },
    append: async (data: string) => { await appendFile(f.path, data); owner.native = Buffer.concat([owner.native, Buffer.from(data)]) },
    replace: async (data: string) => { await rename(f.path, f.path + '.original'); await writeFile(f.path, data); owner.native = Buffer.from(data) } }
}
function originalIds(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const accepted = consumeConversationWindowPage(page)
  expect(accepted.kind).toBe('complete')
  if (accepted.kind !== 'complete') throw new Error('This original small branch must fit one complete frame.')
  return accepted.snapshot.units.flatMap(unit => unit.records.map(record => record.original.item.id))
}

it('Pi changes continue the original physical leaf through bounded pages with equal bodies and unknown times', async () => {
  const f = await fixture([message('root', null)])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await f.append(jsonl([message('same-body-new', 'root'), message('untimed-new', 'same-body-new')]))
  const first = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 1 })
  expect(first.items.map(item => item.id)).toEqual(['same-body-new'])
  expect(first.more).toBe(true)
  expect(first.source).toEqual(checkpoint.source)
  const second = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: first.checkpoint, limit: 1 })
  expect(second.items.map(item => item.id)).toEqual(['untimed-new'])
  expect(second.more).toBe(false)
  expect(second.items[0]!.contentParts).toEqual(first.items[0]!.contentParts)
  for (const item of [...first.items, ...second.items]) expect(item).not.toHaveProperty('startedAt')
  const settled = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: second.checkpoint })
  expect(settled).toMatchObject({ items: [], more: false, checkpoint: second.checkpoint })
  const replay = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 1 })
  expect(replay).toEqual(first)
})

it.each([false, true])('Pi rejects a flat physical branch union and keeps its original accepted cut, reconnect: %s', async reconnect => {
  const f = await fixture([message('root', null), message('accepted', 'root')])
  const initial = await f.client.readAgentConversation(f.ref)
  expect(originalIds(initial)).toEqual(['accepted', 'root'])
  const head = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  await f.append(jsonl([message('linked', 'accepted'), message('sibling', 'root'),
    ...(reconnect ? [message('last-durable', 'linked')] : [])]))
  const nativeCut = initial.window.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')
  expect(nativeCut?.kind).toBe('native')
  if (nativeCut?.kind !== 'native') throw new Error('The original Pi page must establish its own native cut.')
  const outcome = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: nativeCut.checkpoint })
    .then(value => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }))
  expect(outcome, 'A physical branch union must not be accepted at the original native cut')
    .toMatchObject({ kind: 'rejected', error: { code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' } })
  const changed = await f.client.readConversationChanges({ ...f.ref, checkpoint: initial.window.checkpoint, view: initial.window.view! })
  expect(originalIds(changed)).toEqual(['accepted', 'root'])
  expect(changed.window.checkpoint.frontier.cuts).toEqual(initial.window.checkpoint.frontier.cuts)
  expect(changed.coverage.find(coverage => coverage.source.kind === 'native')?.gaps)
    .toEqual([expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })])
  const older = await f.client.sessionHistoryPage(f.session.agentSessionId, { cursor: head.nextCursor!, limit: 1 })
  expect(older.items.map(item => item.id)).toEqual(['root'])
  expect(older.changesCursor).toBe(head.changesCursor)
  const current = await f.client.readAgentConversation(f.ref)
  expect(originalIds(current)).toEqual(reconnect ? ['last-durable', 'linked', 'accepted', 'root'] : ['sibling', 'root'])
  await f.append(jsonl([message('after-current', reconnect ? 'last-durable' : 'sibling')]))
  const resumed = await f.client.readConversationChanges({ ...f.ref, checkpoint: current.window.checkpoint, view: current.window.view! })
  expect(originalIds(resumed)).toEqual(['after-current', ...originalIds(current)])
  expect(resumed.coverage.find(coverage => coverage.source.kind === 'native')?.gaps).toEqual([])
})

it('Pi changes carry label and compaction parents through bounded continuation and replacement Client replay', async () => {
  const f = await fixture([message('root', null)])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await f.append(jsonl([
    { type: 'label', id: 'label', parentId: 'root', targetId: 'root', label: 'Original label' },
    { type: 'compaction', id: 'compact', parentId: 'label', summary: 'Original compacted context', firstKeptEntryId: 'root', tokensBefore: 90 },
    message('after-compact', 'compact')
  ]))
  const first = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 1 })
  expect(first.items.map(item => [item.id, item.kind])).toEqual([['label', 'activity']])
  expect(first.more).toBe(true)
  await f.client.dispose()
  const replacement = new AgentMuxClient({ store: f.store })
  const kernel = Reflect.get(replacement, 'kernel')
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  try {
    expect(await replacement.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 1 })).toEqual(first)
    const second = await replacement.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: first.checkpoint, limit: 1 })
    expect(second.items.map(item => [item.id, item.kind])).toEqual([['compact', 'activity']])
    expect(second.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Original compacted context', contentEligibility: 'private' }])
    expect(second.more).toBe(true)
    const third = await replacement.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: second.checkpoint, limit: 1 })
    expect(third.items.map(item => item.id)).toEqual(['after-compact'])
    expect(third.more).toBe(false)
    expect(await replacement.sessionHistoryPage(f.session.agentSessionId)).toMatchObject({
      items: [expect.objectContaining({ id: 'root' }), expect.objectContaining({ id: 'label' }),
        expect.objectContaining({ id: 'compact' }), expect.objectContaining({ id: 'after-compact' })]
    })
    expect(controls).toHaveLength(6)
    controls.forEach(control => expect(control).not.toHaveBeenCalled())
  } finally { await replacement.dispose() }
})

it('Pi older page replay retains its original parent selection and same-page cut after a foreign branch append', async () => {
  const f = await fixture([message('root', null), message('main', 'root'), message('abandoned', 'root'), message('tip', 'main')])
  const first = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  expect(first.items.map(item => item.id)).toEqual(['tip'])
  expect(first.changesCursor).toBeTypeOf('string')
  await f.append(jsonl([message('new-branch', 'root')]))
  const older = await f.client.sessionHistoryPage(f.session.agentSessionId, { cursor: first.nextCursor!, limit: 1 })
  expect(older.items.map(item => item.id)).toEqual(['main'])
  expect(older.changesCursor).toBe(first.changesCursor)
  expect(older.sourceSizeBytes).toBe(f.before.native.byteLength)
  expect(older.replayCursor).toBeTypeOf('string')
  const replay = await f.client.sessionHistoryPage(f.session.agentSessionId, { cursor: older.replayCursor!, limit: 1 })
  expect(replay).toEqual(older)
  expect((await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })).items.map(item => item.id)).toEqual(['new-branch'])
})

it('Pi original public page cut admits an append recorded immediately after its history snapshot returns', async () => {
  const f = await fixture([message('root', null)])
  const original = f.client['readSessionHistoryPage']
  let appended = false
  const read = vi.fn(async function (this: AgentMuxClient, ...args: Parameters<typeof original>) {
    expect(this).toBe(f.client)
    expect(args[2]).toEqual({ providerId: 'pi', nativeSessionId: 'native-main' })
    const page = await original.apply(this, args)
    if (!appended) {
      appended = true
      await f.append(jsonl([message('after-page', 'root')]))
    }
    return page
  })
  f.client['readSessionHistoryPage'] = read
  try {
    const initial = await f.client.readAgentConversation(f.ref)
    expect(originalIds(initial)).toEqual(['root'])
    expect(read).toHaveBeenCalledOnce()
    const changed = await f.client.readConversationChanges({ ...f.ref, checkpoint: initial.window.checkpoint, view: initial.window.view! })
    expect(originalIds(changed)).toEqual(['after-page', 'root'])
    expect(read, 'A same-source append must not reread cumulative history').toHaveBeenCalledOnce()
  } finally { f.client['readSessionHistoryPage'] = original }
})

it('Pi empty checkpoint excludes an unfinished append and admits the exact record after its delimiter arrives', async () => {
  const f = await fixture([])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  await f.append(JSON.stringify(message('first', null)))
  expect(await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint }))
    .toMatchObject({ items: [], more: false, checkpoint })
  await f.append('\n')
  const complete = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint })
  expect(complete.items.map(item => item.id)).toEqual(['first'])
  expect(complete.more).toBe(false)
})

it('Pi changes repeat a byte-budget deferred record without advancing the original branch witness', async () => {
  const f = await fixture([message('root', null)])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  const content = '中'.repeat(500_000)
  await f.append(jsonl([message('large-one', 'root', content), message('large-two', 'large-one', content), message('large-three', 'large-two', content)]))
  const first = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, limit: 100 })
  expect(first.items.map(item => item.id)).toEqual(['large-one', 'large-two'])
  expect(first.more).toBe(true)
  const second = await f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint: first.checkpoint, limit: 100 })
  expect(second.items.map(item => item.id)).toEqual(['large-three'])
  expect(second.items[0]!.contentParts).toEqual([{ kind: 'text', text: content, contentEligibility: 'public' }])
  expect(second.more).toBe(false)
})

it('Pi changes reject a replaced original file and cancellation without touching the original Session or Run', async () => {
  const f = await fixture([message('root', null)])
  const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId)
  const controller = new AbortController()
  controller.abort(new Error('Original Pi read cancelled'))
  await expect(f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint, signal: controller.signal }))
    .rejects.toThrow('Original Pi read cancelled')
  await f.replace(await readFile(f.path, 'utf8'))
  await expect(f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint }))
    .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})
