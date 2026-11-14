import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createMoteWorkThreadFixture, openMoteWorkThread } from './helpers/mote-work-thread.js'
import { MoteDialogueStore } from '../src/mote/dialogue-store.js'
import type { MoteSupervisionPage } from '../src/mote/dialogue.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await createMoteWorkThreadFixture(); cleanup.push(f.close)
  const work = await openMoteWorkThread(f)
  await f.cli(['space', 'mote', 'dialogue', 'link', '--input', '-'], { ...work.linkInput, operationId: 'same-source-another-link' })
  return { ...f, work }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const read = (f: Fixture, extra = {}): Promise<MoteSupervisionPage> => f.cli(
  ['space', 'mote', 'dialogue', 'supervision', 'read', '--input', '-'], { target: f.target, ...extra })
async function anotherSource(f: Fixture) {
  const messageId = 'another-original-work'
  await f.cli(['agent', 'send', '--to-session', f.work.opened.agent.agentSessionId, '--text', 'Another scoped outcome',
    '--message-id', messageId, '--operation-id', 'another-original-send', '--thread', 'another-original-thread'])
  await f.cli(['message', 'dispatch', 'open', '--source-message', messageId])
  await f.cli(['space', 'mote', 'dialogue', 'link', '--input', '-'], { ...f.work.linkInput, operationId: 'another-original-link',
    source: { kind: 'work', messageHostId: 'local', messageId } })
  return messageId
}

it('the public CLI shares pending source reads while retaining every original link and independent message', async () => {
  const f = await fixture(), other = await anotherSource(f), original = f.client.readDispatch.bind(f.client)
  const writes = f.writes.length, launches = f.launches.length
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reads = vi.spyOn(f.client, 'readDispatch').mockImplementation(async input => { await gate; return original(input) })
  const pending = read(f)
  try { await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10000 }) }
  finally { release() }
  const page = await pending
  expect(page.links).toHaveLength(3)
  expect(page.links.map(link => link.operationId)).toEqual(['another-original-link', 'same-source-another-link', 'link-first-work'])
  expect(reads.mock.calls.map(([input]) => input.sourceMessageId).sort()).toEqual([other, f.work.messageId].sort())
  expect(page.observations.every(row => row.communication && row.issue === null)).toBe(true)
  expect(page.observations.map(row => row.sequence)).toEqual(page.links.map(link => link.sequence))
  expect(page.observations.filter(row => row.communication?.replyMessageIds.includes('first-work-result'))).toHaveLength(2)
  expect(reads.mock.calls.every(([input]) => input.caller?.agentSessionId === 'primary')).toBe(true)
  expect(f.writes).toHaveLength(writes); expect(f.launches).toHaveLength(launches)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a synchronous source failure is shared only for this request and does not hide other original work', async () => {
  const f = await fixture(), other = await anotherSource(f), original = f.client.readDispatch.bind(f.client)
  const reads = vi.spyOn(f.client, 'readDispatch').mockImplementation(input => {
    if (input.sourceMessageId === f.work.messageId) throw new Error('Original source temporarily unreadable')
    return original(input)
  })
  const page = await read(f)
  expect(reads.mock.calls.map(([input]) => input.sourceMessageId).sort()).toEqual([other, f.work.messageId].sort())
  expect(page.observations.filter(row => row.communication === null)).toHaveLength(2)
  expect(page.observations.filter(row => row.issue === 'Original source temporarily unreadable')).toHaveLength(2)
  expect(page.observations[0].communication).not.toBeNull()
  reads.mockImplementation(original); reads.mockClear()
  const recovered = await read(f)
  expect(recovered.links).toEqual(page.links)
  expect(recovered.observations.every(row => row.communication && row.issue === null)).toBe(true)
  expect(reads).toHaveBeenCalledTimes(2)
})

it('retained same-message foreign Hosts and malformed links cannot borrow a valid sibling observation', async () => {
  const f = await fixture(), link = f.work.linked.links[0]
  if (link.kind !== 'work') throw Error('The original fixture must retain its work link')
  const { sequence: _sequence, operationId: _operation, identity, ...source } = link
  const store = new MoteDialogueStore(join(f.root, 'work-dialogue.sqlite'))
  // Retained-history counterexamples: public linking still rejects these tuples.
  await store.append(identity, 'retained-foreign-host', '"retained-foreign-host"', [
    { ...source, main: { ...source.main, hostId: 'another-original-host' }, origin: { ...source.origin, hostId: 'another-original-host' } }
  ])
  await store.append(identity, 'retained-wrong-thread', '"retained-wrong-thread"', [
    { ...source, origin: { ...source.origin, threadId: 'another-original-thread' } }
  ])
  const reads = vi.spyOn(f.client, 'readDispatch'), page = await read(f)
  expect(page.links).toHaveLength(4)
  const rows = new Map(page.links.map((item, index) => [item.operationId, page.observations[index]]))
  expect(rows.get('retained-foreign-host')?.communication).toBeNull()
  expect(rows.get('retained-foreign-host')?.issue).toBeTruthy()
  expect(rows.get('retained-wrong-thread')?.communication).toBeNull()
  expect(rows.get('retained-wrong-thread')?.issue).toContain('another original work source')
  expect(rows.get('same-source-another-link')?.communication?.replyMessageIds).toEqual(['first-work-result'])
  expect(rows.get('link-first-work')?.communication?.replyMessageIds).toEqual(['first-work-result'])
  expect(reads).toHaveBeenCalledTimes(1)
})

it('new replies, cursor pages and independent callers always re-read the original source without a new work link', async () => {
  const f = await fixture(), reads = vi.spyOn(f.client, 'readDispatch')
  const before = await read(f)
  reads.mockClear()
  const reply = 'later-original-question', capability = f.launches[0].env.AGENTMUX_AGENT_CAPABILITY
  await f.cli(['agent', 'send', '--to-session', 'primary', '--text', 'A later original question', '--reply-to', f.work.messageId,
    '--thread', f.work.source!.envelope.threadId, '--message-id', reply, '--operation-id', 'later-question-send'], undefined,
  f.work.opened.agent.agentSessionId, capability)
  const unreported = await read(f)
  expect(unreported.links).toEqual(before.links); expect(unreported.throughSequence).toBe(before.throughSequence)
  for (const row of unreported.observations) {
    expect(row.communication?.replyMessageIds).toContain(reply)
    expect(row.communication?.events.some(event => event.replyMessageId === reply)).toBe(false)
  }
  await f.cli(['message', 'dispatch', 'report', '--source-message', f.work.messageId, '--reply-message', reply, '--kind', 'question'],
    undefined, f.work.opened.agent.agentSessionId, capability)
  reads.mockClear()
  const [current, person] = await Promise.all([read(f), f.rpc.call('space.mote.dialogue.supervision.read', { target: f.target })])
  expect(reads).toHaveBeenCalledTimes(2)
  expect(reads.mock.calls.some(([input]) => input.caller?.agentSessionId === 'primary')).toBe(true)
  expect(reads.mock.calls.some(([input]) => input.caller === undefined)).toBe(true)
  expect(current.links).toEqual(before.links); expect(current.throughSequence).toBe(before.throughSequence)
  for (const page of [current, person]) for (const row of page.observations) {
    expect(row.communication?.replyMessageIds).toContain(reply)
    expect(row.communication?.events).toContainEqual({ kind: 'question', replyMessageId: reply })
  }
  reads.mockClear()
  const first = await read(f, { limit: 1 })
  expect(first.next).not.toBeNull()
  const next = await read(f, { limit: 1, cursor: first.next })
  expect(reads).toHaveBeenCalledTimes(2)
  expect(next.next).toBeNull()
  expect(next.throughSequence).toBe(first.throughSequence)
  expect(next.links[0].sequence).toBeLessThan(first.links[0].sequence)
  expect(next.observations[0].communication?.replyMessageIds).toContain(reply)
})
