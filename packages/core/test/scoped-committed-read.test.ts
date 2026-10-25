import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxFileAgentSessionStore, AgentMuxLifecycleReservation } from '../src/agent-session-store.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = {
  commit(signal?: AbortSignal): Promise<void>
  database?: DatabaseSync
  withReadDatabase<T>(read: (db: DatabaseSync) => T, rescue: (...args: never[]) => T, signal?: AbortSignal, committedOnly?: boolean): Promise<T>
}
const intent = { operationId: 'original-schedule', prompt: 'Retained 中🙂 prompt', active: true,
  message: { userContent: 'Retained 中🙂 prompt' } }
async function fixture() {
  const h = await rpcOwnerFixture(['reader', 'writer'])
  const original = (await h.store.readMetadata('reader'))!
  await h.store.compareAndSwap(original, { ...original, futurePromptIntents: { schedule: intent } })
  const reservation: AgentMuxLifecycleReservation = { kind: 'resume', agentSessionId: original.agentSessionId,
    expectedRun: original.run, reservationId: 'original-reservation', operationId: 'original-resume',
    ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000 }
  await h.store.reserveLifecycle(reservation)
  return { ...h, reservation }
}
const cases = {
  'Core history source': async (h: Awaited<ReturnType<typeof fixture>>) => {
    const value = await h.client.sessionHistorySources({ agentSessionId: 'reader' })
    expect(value).toHaveLength(1); expect(value[0]).toMatchObject({ agentSessionId: 'reader', state: 'active' })
  },
  'Core future intent': async (h: Awaited<ReturnType<typeof fixture>>) => {
    expect(await h.client.readAgentFuturePromptIntent('reader', 'schedule')).toEqual(intent)
  },
  'Core future page': async (h: Awaited<ReturnType<typeof fixture>>) => {
    const value = await h.client.listAgentFuturePromptIntents('reader')
    expect(value.intents).toEqual([{ intentId: 'schedule', intent }])
  },
  'continuity receipt absence': async (h: Awaited<ReturnType<typeof fixture>>) => {
    expect(await h.store.readContinuityControlReceipt('reader', 'unrecorded-operation')).toBeNull()
  },
  'original reservation': async (h: Awaited<ReturnType<typeof fixture>>) => {
    expect(await h.store.readLifecycleReservation('reader')).toEqual(h.reservation)
  },
  'original resume correlation': async (h: Awaited<ReturnType<typeof fixture>>) => {
    expect(await h.store.loadResumeCorrelation('reader', 'original-resume')).toEqual(h.reservation)
  }
}

it.each(Object.entries(cases))('%s reads an independent committed snapshot while an unrelated transaction is held', async (_name, consume) => {
  const h = await fixture(), owner = h.store as unknown as Owner
  const writer = (await h.store.readMetadata('writer'))!, entered = deferred(), release = deferred()
  vi.spyOn(owner, 'commit').mockImplementationOnce(async () => {
    entered.resolve(); await release.promise
    throw new Error('Private writer rollback')
  })
  let reading: Promise<void> | undefined
  const writing = h.store.compareAndSwapMetadata(writer, { ...writer, updatedAt: writer.updatedAt + 1 }).catch(error => error)
  try {
    await entered.promise
    const writerDb = owner.database!
    expect(writerDb.isTransaction).toBe(true)
    const originalRead = owner.withReadDatabase.bind(owner), snapshots: number[] = [], connections: DatabaseSync[] = []
    vi.spyOn(owner, 'withReadDatabase').mockImplementation((read, rescue, signal, committedOnly) => originalRead(db => {
      // Observe the same snapshot the actual public read consumes. The unrelated
      // writer has changed this row but has not committed it, and will roll back.
      snapshots.push(JSON.parse(String(db.prepare('SELECT json FROM sessions WHERE id=?').get('writer')!.json)).updatedAt)
      connections.push(db)
      return read(db)
    }, rescue, signal, committedOnly))
    let completed = false
    reading = consume(h).finally(() => { completed = true })
    void reading.catch(() => {})
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1500, interval: 10 })
    await reading
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots, 'the public read snapshot must exclude the uncommitted writer change').toEqual(snapshots.map(() => writer.updatedAt))
    expect(connections.every(db => db !== writerDb), 'public reads own a committed connection').toBe(true)
    release.resolve(); expect(await writing).toBeInstanceOf(Error)
    expect(await h.store.readMetadata('writer')).toEqual(writer)
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally {
    release.resolve(); await Promise.allSettled([writing, reading])
    vi.restoreAllMocks(); await h.close()
  }
})
