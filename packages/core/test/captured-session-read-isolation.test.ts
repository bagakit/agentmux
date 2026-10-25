import { afterEach, expect, it, vi } from 'vitest'
import { readFile, appendFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentMuxFileAgentSessionStore, AgentMuxLifecycleReservation } from '../src/agent-session-store.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { capturedStorageRecords, writeCapturedLegacyFixture } from './helpers/captured-history-fixture.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function pauseCommits(store: AgentMuxFileAgentSessionStore, count = 1) {
  const owner = store as unknown as { commit(signal?: AbortSignal): Promise<void> }
  const original = owner.commit.bind(owner), gates = Array.from({ length: count }, deferred), entered = gates.map(() => deferred())
  let index = 0
  vi.spyOn(owner, 'commit').mockImplementation(async signal => {
    const current = index++
    if (gates[current]) { entered[current]!.resolve(); await gates[current]!.promise }
    await original(signal)
  })
  return gates.map((gate, index) => ({ entered: entered[index]!.promise, release: gate.resolve }))
}
async function fixture(ready = true) {
  const h = await rpcOwnerFixture(['captured-reader', 'unrelated-writer'])
  closes.push(h.close)
  const sid = 'captured-reader', session = (await h.store.readMetadata(sid))!, writer = (await h.store.readMetadata('unrelated-writer'))!
  const legacy = await writeCapturedLegacyFixture(h.store.path, capturedStorageRecords(2, 12, sid))
  const cut = { queueId: 'original-input-queue', incarnation: 'original-input-generation', sequence: 1 }
  const expected = [...legacy.expected].reverse()
  const page = ready ? await h.store.readCapturedHistory(sid) : undefined
  if (ready) await h.store.recordInputConversationProjection(sid, cut)
  return { ...h, sid, session, writer, legacy, expected, cut, page }
}
function retainsOriginal(f: Awaited<ReturnType<typeof fixture>>, page: Awaited<ReturnType<AgentMuxFileAgentSessionStore['readCapturedHistory']>>) {
  expect(page.agentSessionId).toBe(f.sid)
  expect(page.records.length).toBeGreaterThan(0)
  expect(page.records.map(record => record.item)).toEqual(f.expected)
  if (f.page) expect(page.stream).toEqual(f.page.stream)
}

it('ready actual Core timeline/history and FileStore page/projection finish before an unrelated writer commits', async () => {
  const f = await fixture(), [pause] = pauseCommits(f.store), pending: Promise<unknown>[] = []
  try {
    pending.push(f.store.compareAndSwapMetadata(f.writer, { ...f.writer, updatedAt: f.writer.updatedAt + 1 }))
    await pause!.entered
    let done = false
    const reads = Promise.all([
      f.client.sessionTimeline(f.sid),
      f.client.readAgentSessionHistory({ hostId: 'local', agentSessionId: f.sid, source: 'captured', limit: 20 }),
      f.store.readCapturedHistory(f.sid),
      f.store.readInputConversationProjection(f.sid)
    ]).then(result => { done = true; return result })
    pending.push(reads)
    await vi.waitFor(() => expect(done, 'the real ready captured chain must not join an unrelated writer').toBe(true), { timeout: 1200, interval: 10 })
    const [timeline, publicHistory, page, projection] = await reads
    expect(timeline.items.length).toBeGreaterThan(0)
    expect([...timeline.items].reverse()).toEqual(f.expected)
    expect(timeline.stream?.epoch).toBe(f.page!.stream.epoch)
    expect(publicHistory.items).toEqual(f.expected.map(item => ({ kind: 'item', item })))
    retainsOriginal(f, page)
    expect(projection).toEqual({ cut: f.cut, pending: [], next: null })
    expect(await readFile(f.legacy.path)).toEqual(f.legacy.original)
    expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { pause!.release(); await Promise.allSettled(pending) }
})

it('an original pending projection write still holds its exact Session reader through commit', async () => {
  const f = await fixture(), [pause] = pauseCommits(f.store), pending: Promise<unknown>[] = []
  const next = { ...f.cut, sequence: 2 }
  try {
    pending.push(f.store.recordInputConversationProjection(f.sid, next)); await pause!.entered
    let done = false
    const read = f.store.readInputConversationProjection(f.sid).then(value => { done = true; return value }); pending.push(read)
    await delay(40); expect(done, 'the original projection write must remain in its Session barrier').toBe(false)
    pause!.release()
    expect(await read).toEqual({ cut: next, pending: [], next: null })
    retainsOriginal(f, await f.store.readCapturedHistory(f.sid))
  } finally { pause!.release(); await Promise.allSettled(pending) }
})

it('actual Core timeline waits for both original ordered mutations without waiting on its own preparation', async () => {
  const f = await fixture(), pauses = pauseCommits(f.store, 2), pending: Promise<unknown>[] = []
  const first = f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.sid, itemId: f.legacy.target.id,
    updatedAt: f.legacy.completed.updatedAt + 1, toolOutput: 'first exact result' })
  pending.push(first); await pauses[0]!.entered
  const second = f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.sid, itemId: f.legacy.target.id,
    updatedAt: f.legacy.completed.updatedAt + 2, toolOutput: 'second exact result' })
  pending.push(second)
  let done = false
  const read = f.client.sessionTimeline(f.sid).then(value => { done = true; return value }); pending.push(read)
  try {
    await delay(30); expect(done).toBe(false)
    pauses[0]!.release(); await first; await pauses[1]!.entered
    await delay(30); expect(done).toBe(false)
    pauses[1]!.release()
    const timeline = await read, accepted = await second
    expect(timeline.items.find(item => item.id === f.legacy.target.id)?.toolOutput).toBe('second exact result')
    expect(timeline.stream?.epoch).toBe(f.page!.stream.epoch)
    expect(timeline.stream?.sequence).toBe(accepted.stream.sequence)
    expect((await second).revision).toBe((await first).revision + 1)
  } finally { for (const pause of pauses) pause.release(); await Promise.allSettled(pending) }
})

it('ready captured readers join an original cross-Session lifecycle settlement and retain their source', async () => {
  const f = await fixture(), pending: Promise<unknown>[] = []
  const reservation: AgentMuxLifecycleReservation = { kind: 'resume', agentSessionId: f.writer.agentSessionId, expectedRun: f.writer.run,
    reservationId: 'original-cross-reservation', operationId: 'original-cross-resume', ownerId: 'original-cross-owner',
    ownerPid: process.pid, expiresAt: Date.now() + 60_000 }
  await f.store.reserveLifecycle(reservation)
  const [pause] = pauseCommits(f.store)
  try {
    pending.push(f.store.releaseLifecycle(reservation)); await pause!.entered
    let done = false
    const reads = Promise.all([f.client.sessionTimeline(f.sid), f.store.readCapturedHistory(f.sid), f.store.readInputConversationProjection(f.sid)])
      .then(value => { done = true; return value }); pending.push(reads)
    await delay(40); expect(done).toBe(false)
    pause!.release()
    const [timeline, page, projection] = await reads
    retainsOriginal(f, page)
    expect(timeline.stream?.epoch).toBe(page.stream.epoch)
    expect(projection.cut).toEqual(f.cut)
    expect(await f.store.readLifecycleReservation(f.writer.agentSessionId)).toBeNull()
  } finally { pause!.release(); await Promise.allSettled(pending) }
})

it('cold original preparation/import/ready writes are scoped and hand over complete bytes in order', async () => {
  const f = await fixture(false), pauses = pauseCommits(f.store, 3), pending: Promise<unknown>[] = []
  const handover = f.store.readCapturedHistory(f.sid); pending.push(handover)
  try {
    for (let stage = 0; stage < pauses.length; stage++) {
      await pauses[stage]!.entered
      let done = false
      const source = f.client.sessionHistorySources({ agentSessionId: f.sid }).then(value => { done = true; return value }); pending.push(source)
      await delay(35); expect(done, `original captured preparation stage ${stage} must own its Session write`).toBe(false)
      pauses[stage]!.release()
    }
    const page = await handover
    retainsOriginal(f, page)
    expect(page.stream.epoch).toBeTypeOf('string')
    expect(await readFile(f.legacy.path)).toEqual(f.legacy.original)
    expect(await f.store.readCapturedHistory(f.sid)).toEqual(page)
  } finally { for (const pause of pauses) pause.release(); await Promise.allSettled(pending) }
})

it('cancelling a captured mutation waiting on its own writer leaves that original writer and source intact', async () => {
  const f = await fixture(), [pause] = pauseCommits(f.store), pending: Promise<unknown>[] = []
  const controller = new AbortController()
  try {
    pending.push(f.store.compareAndSwapMetadata(f.session, { ...f.session, updatedAt: f.session.updatedAt + 1 })); await pause!.entered
    const mutation = f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.sid, itemId: f.legacy.target.id,
      updatedAt: f.legacy.completed.updatedAt + 1, toolOutput: 'must not be applied' }, controller.signal)
    const rejected = expect(mutation).rejects.toMatchObject({ name: 'AbortError' }); pending.push(rejected)
    controller.abort(); await rejected
    pause!.release()
    retainsOriginal(f, await f.store.readCapturedHistory(f.sid))
  } finally { pause!.release(); await Promise.allSettled(pending) }
})

it('ready captured source changes retain original accepted records with the existing explicit gap', async () => {
  const f = await fixture()
  await appendFile(f.legacy.path, '\n')
  const page = await f.store.readCapturedHistory(f.sid)
  expect(page.records.map(record => record.item)).toEqual(f.expected)
  expect(page.stream.epoch).toBe(f.page!.stream.epoch)
  expect(page.stream.gaps).toContainEqual(expect.objectContaining({ code: 'CAPTURED_ORIGINAL_CHANGED_AFTER_HANDOVER' }))
})
