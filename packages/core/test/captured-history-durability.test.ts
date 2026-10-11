import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ directory: '', directoryAck: false, syncPaths: [] as string[],
  blockedPath: '', entered: undefined as undefined | (() => void), releaseRead: undefined as undefined | Promise<void>,
  streams: [] as Array<{ destroyed: boolean; closed: boolean }>, lockPath: '', lockArmed: false,
  failLockClose: false, lockCloseHandles: [] as unknown[] }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, createReadStream(...args: Parameters<typeof fs.createReadStream>) {
    const stream = fs.createReadStream(...args)
    if (String(args[0]) === faults.blockedPath && faults.releaseRead) {
      const read = stream._read.bind(stream), released = faults.releaseRead
      let held = false
      faults.streams.push(stream)
      stream._read = (size: number) => {
        if (held) { read(size); return }
        held = true; faults.entered?.()
        void released.then(() => { if (!stream.destroyed) read(size) }).catch(error => stream.destroy(error))
      }
    }
    return stream
  } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args)
    return new Proxy(handle, { get(target, key) {
      if (key === 'close' && String(args[0]) === faults.lockPath) return async () => {
        if (faults.lockArmed) {
          faults.lockCloseHandles.push(target)
          if (faults.failLockClose) {
            faults.failLockClose = false
            throw Object.assign(new Error('Private original flock close failed once after COMMIT'), { code: 'EIO' })
          }
        }
        return await target.close()
      }
      if (key === 'sync') return async () => {
        if (String(args[0]) === faults.directory && faults.directoryAck) {
          faults.directoryAck = false
          throw Object.assign(new Error('Private captured directory ACK lost'), { code: 'EIO' })
        }
        const result = await target.sync()
        faults.syncPaths.push(String(args[0]))
        return result
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, AgentMuxSessionDurabilityError } from '../src/agent-session-store.js'
import { AgentMuxClient } from '../src/client.js'
import type { AgentCapturedTimelineRecord, AgentCapturedTimelineStream, AgentMuxStoredAgentSession, AgentTimelineItem } from '../src/types.js'
import { agentActivityTimelineItem } from '../src/agent-activity-state.js'
import { capturedStorageRecords, capturedStorageSession, capturedStorageSessionId as sid, collectCapturedStorage, writeCapturedLegacyFixture, capturedStorageSourcePath } from './helpers/captured-history-fixture.js'
import { messageJournalIo } from './helpers/message-journal-io.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const roots: string[] = [], children = new Set<ChildProcess>()
let probe: Awaited<ReturnType<typeof messageJournalIo>>
beforeAll(async () => { probe = await messageJournalIo() })
afterAll(async () => { await probe?.close() })
afterEach(async () => {
  vi.restoreAllMocks(); probe?.reset(); faults.directoryAck = false; faults.directory = ''; faults.syncPaths = []
  faults.blockedPath = ''; faults.entered = undefined; faults.releaseRead = undefined; faults.streams = []
  faults.lockPath = ''; faults.lockArmed = false; faults.failLockClose = false; faults.lockCloseHandles = []
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-captured-storage-'))); roots.push(root)
  const path = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(path), session = capturedStorageSession(root)
  await store.compareAndSwap(null, session)
  return { root, path, store, session }
}
async function append(store: Pick<AgentMuxFileAgentSessionStore, 'applyTimelineMutation'>, records: AgentTimelineItem[]) {
  for (const item of records) await store.applyTimelineMutation({ type: 'append', agentSessionId: item.agentSessionId, item })
}
async function exact(store: Pick<AgentMuxFileAgentSessionStore, 'readCapturedHistory'>, id: string) {
  const page = await store.readCapturedHistory(sid, { recordId: id })
  expect(page.records).toHaveLength(1)
  return { ...page.records[0]!, stream: page.stream }
}
function blockOriginalRead(path: string) {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  faults.blockedPath = path; faults.entered = entered
  faults.releaseRead = new Promise<void>(resolve => { release = resolve })
  return { entered: ready, release() { faults.blockedPath = ''; release() } }
}
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 3000) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(timer!) }
}

describe('original captured SQLite durability and bounded source consumption', () => {
  it('lets another Session commit while an actual cold import read is blocked and preserves same-Session order', async () => {
    const f = await fixture(), legacy = await writeCapturedLegacyFixture(f.path, capturedStorageRecords(2))
    const other = capturedStorageSession(f.root, 'independent-during-import')
    await f.store.compareAndSwap(null, other)
    const gate = blockOriginalRead(legacy.path)
    const first = f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: legacy.target.id, updatedAt: _historyFixtureEpoch(0, 21, 0), title: 'first exact update' })
    const second = f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: legacy.target.id, updatedAt: _historyFixtureEpoch(0, 21, 1), title: 'second exact update' })
    const settled = Promise.all([first, second]); void settled.catch(() => {})
    try {
      await bounded(gate.entered, 'Actual cold import never reached its read barrier')
      const independent = (async () => {
        await f.store.compareAndSwapMetadata(other, { ...other, updatedAt: _historyFixtureEpoch(0, 0, 2) })
        const item = capturedStorageRecords(1, 0, other.agentSessionId)[0]!
        return await f.store.applyTimelineMutation({ type: 'append', agentSessionId: other.agentSessionId, item })
      })()
      await expect(bounded(independent, 'Another Session was held by the cold import')).resolves.toMatchObject({ changed: true })
    } finally { gate.release(); await settled }
    expect((await second).revision).toBe((await first).revision + 1)
    expect((await exact(f.store, legacy.target.id)).item.title).toBe('second exact update')
  })

  it('revalidates original membership after cold import without recreating a removed Session', async () => {
    const f = await fixture(), legacy = await writeCapturedLegacyFixture(f.path, capturedStorageRecords(2))
    const gate = blockOriginalRead(legacy.path)
    const pending = f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: legacy.target.id, updatedAt: _historyFixtureEpoch(0, 21, 0), title: 'removed target update' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    void rejected.catch(() => {})
    try {
      await bounded(gate.entered, 'Actual cold import never reached its membership barrier')
      await f.store.compareAndSwap(f.session, null)
    } finally { gate.release() }
    await rejected
    expect(await f.store.readMetadata(sid)).toBeNull()
    const client = new AgentMuxClient({ store: f.store })
    try { await expect(client.sessionTimeline(sid)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' }) }
    finally { await client.dispose() }
    expect(await readFile(legacy.path)).toEqual(legacy.original)
  })

  it('aborts the actual cold import descriptor with no late mutation and retries the same original source', async () => {
    const f = await fixture(), legacy = await writeCapturedLegacyFixture(f.path, capturedStorageRecords(2))
    const gate = blockOriginalRead(legacy.path), controller = new AbortController()
    const pending = f.store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: legacy.target.id, updatedAt: _historyFixtureEpoch(0, 21, 0), title: 'cancelled late update' }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    void rejected.catch(() => {})
    try {
      await bounded(gate.entered, 'Actual cold import never reached its abort barrier')
      controller.abort()
      await bounded(rejected, 'Aborted import retained its active read')
      await vi.waitFor(() => expect(faults.streams.every(stream => stream.destroyed && stream.closed)).toBe(true))
      expect(faults.streams).toHaveLength(1)
      expect(await readFile(legacy.path)).toEqual(legacy.original)
      const db = new DatabaseSync(f.path)
      try {
        expect(db.prepare('SELECT state,sequence FROM captured_streams WHERE session_id=?').get(sid)).toMatchObject({ state: 'preparing', sequence: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM captured_record_versions WHERE session_id=?').get(sid)!.count).toBe(0)
      } finally { db.close() }
    } finally { gate.release() }
    const recovered = await collectCapturedStorage(new AgentMuxFileAgentSessionStore(f.path))
    expect(recovered.records.map(record => record.item)).toEqual([...legacy.expected].reverse())
    expect(await f.store.readMetadata(sid)).toEqual(f.session)
  })

  it.each(['memory', 'file'] as const)('%s refuses an unknown captured Session without inventing an empty stream', async kind => {
    const f = await fixture(), store = kind === 'file' ? f.store : new AgentMuxMemoryAgentSessionStore()
    if (kind === 'memory') await store.compareAndSwap(null, f.session)
    await expect(store.readCapturedHistory('unknown-captured-session'))
      .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    const known = await store.readCapturedHistory(sid)
    expect(known).toMatchObject({ agentSessionId: sid, records: [], stream: { sequence: 0, origin: 'beginning' } })
    expect(await store.readMetadata(sid)).toEqual(f.session)
  })

  it.each(['memory', 'file'] as const)('%s retains >600 records and updates an old ID at its original position/version', async kind => {
    const f = await fixture(), store = kind === 'file' ? f.store : new AgentMuxMemoryAgentSessionStore()
    if (kind === 'memory') await store.compareAndSwap(null, f.session)
    const originals = capturedStorageRecords()
    expect(originals).toHaveLength(603)
    await append(store, originals)
    const before = await collectCapturedStorage(store)
    expect(before.records.map(record => record.item)).toEqual([...originals].reverse())
    expect(new Set(before.records.map(record => record.firstSequence)).size).toBe(603)
    expect(before.stream).toMatchObject({ origin: 'beginning', gaps: [], sequence: 603, revision: 603 })
    const recent = await store.loadTimeline(sid)
    expect(recent.items).toHaveLength(600)
    expect(recent.stream?.epoch).toBe(before.stream.epoch)
    expect(recent.items.map(item => item.id)).not.toContain(originals[1]!.id)
    const prior = await exact(store, originals[1]!.id)
    const completed = { ...prior.item, createdAt: _historyFixtureEpoch(0, 10, 0), updatedAt: _historyFixtureEpoch(0, 20, 0), status: 'complete' as const, toolOutput: '  exact done 中🙂\n  ' }
    await expect(store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: completed }))
      .resolves.toMatchObject({ changed: true, revision: before.stream.revision + 1 })
    const current = await exact(store, prior.item.id)
    expect(current).toMatchObject({ firstSequence: prior.firstSequence, sequence: 604,
      item: { ...completed, createdAt: prior.item.createdAt }, stream: { epoch: before.stream.epoch, sequence: 604 } })
    expect(current.revision).not.toBe(prior.revision)
    const oldCut = await store.readCapturedHistory(sid, { epoch: before.stream.epoch, throughSequence: before.stream.sequence, recordId: prior.item.id })
    expect(oldCut.records).toEqual([{ item: prior.item, firstSequence: prior.firstSequence, sequence: prior.sequence, revision: prior.revision }])
    const oldVersion = await store.readCapturedHistory(sid, { recordId: prior.item.id, recordRevision: prior.revision })
    expect(oldVersion.records).toEqual(oldCut.records)
    const delta = await store.readCapturedHistory(sid, { epoch: before.stream.epoch, throughSequence: 604, afterSequence: 603, limit: 2 })
    expect(delta.records.map(record => [record.item.id, record.firstSequence, record.sequence])).toEqual([[prior.item.id, prior.firstSequence, 604]])
    const latest = await collectCapturedStorage(store)
    expect(latest.records.map(record => record.item.id)).toEqual(before.records.map(record => record.item.id))
    for (const item of [{ ...current.item, createdAt: _historyFixtureEpoch(0, 900, 0), updatedAt: _historyFixtureEpoch(0, 900, 1) }, prior.item]) {
      await expect(store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item })).resolves.toMatchObject({ changed: false, revision: 604 })
    }
    await expect(store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: current.item })).resolves.toMatchObject({ changed: false })
    await expect(store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { ...current.item, title: 'conflict' } }))
      .rejects.toMatchObject({ code: 'AGENT_TIMELINE_ID_CONFLICT' })
    await expect(store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: prior.item.id, updatedAt: _historyFixtureEpoch(0, 0, 1), status: 'failed' }))
      .rejects.toMatchObject({ code: 'STALE_AGENT_TIMELINE_ITEM' })
    const user = originals[0]!
    await store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: user.id, updatedAt: _historyFixtureEpoch(0, 20, 1), status: 'failed' })
    expect((await exact(store, user.id)).item.publicContent).toBe('confirmed')
    await store.applyTimelineMutation({ type: 'update', agentSessionId: sid, itemId: user.id, updatedAt: _historyFixtureEpoch(0, 20, 2), content: 'changed original field' })
    expect((await exact(store, user.id)).item).not.toHaveProperty('publicContent')
    const { content: _content, authorHuman: _author, publicContent: _public, sourceDevice: _device, ...replacement } = user
    await store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: { ...replacement, updatedAt: _historyFixtureEpoch(0, 20, 3) } })
    const replaced = await exact(store, user.id)
    for (const key of ['content', 'authorHuman', 'publicContent', 'sourceDevice']) expect(replaced.item).not.toHaveProperty(key)
    expect(replaced.firstSequence).toBe(before.records.find(record => record.item.id === user.id)!.firstSequence)
    await expect(store.readCapturedHistory(sid, { epoch: 'another-epoch', limit: 1 })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    if (kind === 'file') {
      const reopened = new AgentMuxFileAgentSessionStore(f.path)
      expect((await reopened.readCapturedHistory(sid, { recordId: prior.item.id, recordRevision: prior.revision })).records).toEqual(oldCut.records)
      expect(await reopened.readMetadata(sid)).toEqual(f.session)
    }
  }, 60000)

  it.each(['torn-tail', 'complete-without-newline'] as const)('imports every complete original fact through %s without changing its original file', async form => {
    const f = await fixture(), records = capturedStorageRecords()
    const legacy = await writeCapturedLegacyFixture(f.path, records, form === 'torn-tail' ? '{"type":"append"' : '', form === 'torn-tail')
    const page = await collectCapturedStorage(f.store)
    expect(page.records.map(record => record.item)).toEqual([...legacy.expected].reverse())
    expect(page.stream).toMatchObject({ origin: 'retained-prefix', revision: legacy.expectedRevision })
    if (form === 'torn-tail') expect(page.stream.gaps).toContainEqual(expect.objectContaining({ code: 'CAPTURED_ORIGINAL_RANGE_UNREAD' }))
    else expect(page.stream.gaps).toEqual([])
    expect(await readFile(legacy.path)).toEqual(legacy.original)
    const firstEpoch = page.stream.epoch
    const fresh = new AgentMuxFileAgentSessionStore(f.path)
    expect((await collectCapturedStorage(fresh)).records).toEqual(page.records)
    expect((await fresh.readCapturedHistory(sid, { limit: 1 })).stream.epoch).toBe(firstEpoch)
    expect(await fresh.readMetadata(sid)).toEqual(f.session)
    const db = new DatabaseSync(f.path)
    try {
      const row = db.prepare('SELECT state,source_witness,import_ack FROM captured_streams WHERE session_id=?').get(sid)!
      expect(row.state).toBe('ready'); expect(typeof row.source_witness).toBe('string'); expect(row.import_ack).toBeTruthy()
      expect(db.prepare('SELECT COUNT(*) AS count FROM captured_record_versions WHERE session_id=?').get(sid)!.count).toBe(604)
    } finally { db.close() }
  })

  it('keeps accepted SQLite facts writable and reports an old original changed after its handover', async () => {
    const f = await fixture(), legacy = await writeCapturedLegacyFixture(f.path, capturedStorageRecords(2))
    const before = await collectCapturedStorage(f.store)
    const late = { ...capturedStorageRecords(1)[0]!, id: 'original-file-after-ack-only', createdAt: _historyFixtureEpoch(0, 21, 0), updatedAt: _historyFixtureEpoch(0, 21, 0),
      content: 'Not accepted into the acknowledged SQLite stream' }
    await appendFile(legacy.path, JSON.stringify({ type: 'append', agentSessionId: sid, item: late }) + '\n')
    const changedOriginal = await readFile(legacy.path)
    const noticed = await collectCapturedStorage(new AgentMuxFileAgentSessionStore(f.path))
    expect(noticed.stream).toMatchObject({ epoch: before.stream.epoch, sequence: before.stream.sequence })
    expect(noticed.stream.gaps).toContainEqual(expect.objectContaining({ code: 'CAPTURED_ORIGINAL_CHANGED_AFTER_HANDOVER' }))
    expect(noticed.records).toEqual(before.records)
    expect(noticed.records.map(record => record.item.id)).not.toContain(late.id)
    const accepted = { ...late, id: 'sqlite-new-after-original-divergence', content: 'Accepted through original SQLite owner' }
    await expect(f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: accepted })).resolves.toMatchObject({ changed: true })
    const after = await collectCapturedStorage(f.store)
    expect(after.stream).toMatchObject({ epoch: before.stream.epoch, sequence: before.stream.sequence + 1 })
    expect(after.stream.gaps).toContainEqual(expect.objectContaining({ code: 'CAPTURED_ORIGINAL_CHANGED_AFTER_HANDOVER' }))
    expect(after.records.map(record => record.item.id)).toEqual([accepted.id, ...before.records.map(record => record.item.id)])
    expect(await readFile(legacy.path)).toEqual(changedOriginal)
    expect(await f.store.readMetadata(sid)).toEqual(f.session)
  })

  it('preserves an imported snapshot revision at its frozen cut after a later mutation', async () => {
    const f = await fixture(), originals = capturedStorageRecords(1)
    const seeded = await writeCapturedLegacyFixture(f.path, originals)
    const source = Buffer.from(JSON.stringify({ version: 3, agentSessionId: sid, revision: 31, items: originals }) + '\n')
    await writeFile(capturedStorageSourcePath(f.path), source)
    const before = await collectCapturedStorage(f.store)
    expect(before.stream).toMatchObject({ sequence: 3, revision: 31, origin: 'retained-prefix' })
    const next = { ...originals[1]!, updatedAt: _historyFixtureEpoch(0, 20, 0), status: 'complete' as const, toolOutput: 'new version after old snapshot' }
    await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: next })
    const old = await collectCapturedStorage(f.store, sid, { epoch: before.stream.epoch, throughSequence: before.stream.sequence })
    expect(old).toEqual(before)
    const current = await f.store.readCapturedHistory(sid, { recordId: next.id })
    expect(current.stream).toMatchObject({ sequence: 4, revision: 32, epoch: before.stream.epoch })
    expect(current.records[0]!.item).toEqual(next)
    expect(await readFile(seeded.path)).toEqual(source)
  })

  it('keeps captured history across real stop retirement and accepts only its exact preaccepted activity', async () => {
    const f = await fixture(), originals = capturedStorageRecords(1)
    await append(f.store, originals)
    const before = await collectCapturedStorage(f.store)
    const observation = { id: 'accepted-before-retirement', source: 'run-process' as const, createdAt: _historyFixtureEpoch(0, 0, 500),
      activityState: { run: f.session.run, state: 'done' as const, stateEnteredAt: _historyFixtureEpoch(0, 0, 500) } }
    const current = (await f.store.readMetadata(sid))!
    await f.store.compareAndSwapMetadata(current, { ...current, activityCommit: { latest: observation, latestCommitted: false }, updatedAt: _historyFixtureEpoch(0, 0, 500) })
    const stop = { kind: 'stop' as const, reservationId: 'captured-test-stop', ownerId: 'captured-test-owner', ownerPid: process.pid,
      agentSessionId: sid, expectedRun: f.session.run, operationId: 'captured-test-stop-operation', expiresAt: Date.now() + 60000,
      stopOperation: { daemonInstance: 'private-unconnected', operationKey: 'private-stop', runId: f.session.run.runId } }
    await f.store.reserveLifecycle(stop); await f.store.commitLifecycle(stop, null)
    const fresh = new AgentMuxFileAgentSessionStore(f.path)
    expect(await fresh.readMetadata(sid)).toBeNull()
    expect(await collectCapturedStorage(fresh)).toEqual(before)
    expect((await fresh.readHistorySource(sid))!.state).toBe('retired')
    const accepted = agentActivityTimelineItem(sid, observation)
    await expect(fresh.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: accepted })).resolves.toMatchObject({ changed: true })
    await expect(fresh.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: accepted })).resolves.toMatchObject({ changed: false })
    await expect(fresh.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { ...accepted, title: 'not the accepted observation' } }))
      .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    await expect(fresh.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: accepted })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    const after = await collectCapturedStorage(fresh)
    expect(after.stream.epoch).toBe(before.stream.epoch)
    expect(after.stream.sequence).toBe(before.stream.sequence + 1)
    expect(after.records.map(record => record.item)).toEqual([accepted, ...before.records.map(record => record.item)])
  })

  it('preserves a damaged original source and permits an ordinary exact Session save after its failed captured read', async () => {
    const f = await fixture(), records = capturedStorageRecords(2)
    const legacy = await writeCapturedLegacyFixture(f.path, records)
    const lines = legacy.original.toString('utf8').split('\n')
    lines.splice(2, 0, '{"bad-middle":')
    const damaged = Buffer.from(lines.join('\n')); await writeFile(legacy.path, damaged)
    const failedRead = await f.store.readCapturedHistory(sid).then(value => ({ value }), error => ({ error }))
    console.log('__CAPTURED_DAMAGED_READ__', JSON.stringify('error' in failedRead ? { code: failedRead.error?.code, message: failedRead.error?.message } : { value: failedRead.value }))
    expect(failedRead).toHaveProperty('error')
    expect(await readFile(legacy.path)).toEqual(damaged)
    const metadata = (await f.store.readMetadata(sid))!
    await expect(f.store.compareAndSwapMetadata(metadata, { ...metadata, updatedAt: _historyFixtureEpoch(0, 0, 2) })).resolves.toBeUndefined()
    expect((await f.store.readMetadata(sid))!.run).toEqual(f.session.run)
  })

  it('retains the same committed mutation after native COMMIT returned but its acknowledgement was lost', async () => {
    const f = await fixture(), target = capturedStorageRecords(1)[1]!
    await append(f.store, [target])
    const original = await exact(f.store, target.id), nativeExec = DatabaseSync.prototype.exec
    let lost = false
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      const isMutationCommit = sql === 'COMMIT' && !lost && this.prepare('SELECT sequence FROM captured_streams WHERE session_id=?').get(sid)?.sequence === original.stream.sequence + 1
      const value = nativeExec.call(this, sql)
      if (isMutationCommit) { lost = true; throw Object.assign(new Error('Private captured COMMIT ACK lost after apply'), { code: 'EIO' }) }
      return value
    })
    const changed = { ...target, status: 'complete' as const, updatedAt: _historyFixtureEpoch(0, 9, 0), toolOutput: 'exact durable completion' }
    const error = await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: changed }).catch(error => error)
    vi.restoreAllMocks()
    expect(lost).toBe(true); expect(error).toBeInstanceOf(AgentMuxSessionDurabilityError)
    expect(error).toMatchObject({ commitOutcome: 'unknown' })
    const recovered = await exact(new AgentMuxFileAgentSessionStore(f.path), target.id)
    expect(recovered).toMatchObject({ item: changed, firstSequence: original.firstSequence,
      sequence: original.sequence + 1, stream: { epoch: original.stream.epoch, sequence: original.stream.sequence + 1 } })
    faults.syncPaths = []; probe.target(f.path); probe.reset()
    await expect(f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: changed })).resolves.toMatchObject({ changed: false })
    expect(faults.syncPaths).toEqual(expect.arrayContaining([f.path, dirname(f.path)]))
    expect((await exact(f.store, target.id)).sequence).toBe(recovered.sequence)
    console.log('__CAPTURED_ACK_RECONFIRM__', JSON.stringify({ fault: 'commit-unknown', sequence: recovered.sequence, syncedOriginalFile: faults.syncPaths.includes(f.path), syncedOriginalDirectory: faults.syncPaths.includes(dirname(f.path)), sqlite: probe.stats() }))
    expect(await f.store.readMetadata(sid)).toEqual(f.session)
  })

  it('retains the original epoch and source witness after a ready-import COMMIT acknowledgement is lost', async () => {
    const f = await fixture(), legacy = await writeCapturedLegacyFixture(f.path, capturedStorageRecords(2))
    const nativeExec = DatabaseSync.prototype.exec
    let witnessed: { epoch: string; sequence: number; source_witness: string } | undefined
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      let ready: Record<string, unknown> | undefined
      if (sql === 'COMMIT' && !witnessed && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='captured_streams'").get()) {
        ready = this.prepare("SELECT epoch,sequence,source_witness FROM captured_streams WHERE session_id=? AND state='ready' AND import_ack IS NOT NULL").get(sid)
      }
      const value = nativeExec.call(this, sql)
      if (ready) {
        witnessed = { epoch: String(ready.epoch), sequence: Number(ready.sequence), source_witness: String(ready.source_witness) }
        throw Object.assign(new Error('Private original import ready ACK lost'), { code: 'EIO' })
      }
      return value
    })
    const first = await f.store.readCapturedHistory(sid).then(value => ({ value }), error => ({ error }))
    vi.restoreAllMocks()
    expect(witnessed).toBeDefined()
    if ('error' in first) expect(first.error).toBeInstanceOf(Error)
    const fresh = new AgentMuxFileAgentSessionStore(f.path), page = await collectCapturedStorage(fresh)
    expect(page.records.map(record => record.item)).toEqual([...legacy.expected].reverse())
    expect(page.stream).toMatchObject({ epoch: witnessed!.epoch, sequence: witnessed!.sequence })
    const db = new DatabaseSync(f.path)
    try {
      const row = db.prepare('SELECT epoch,source_witness FROM captured_streams WHERE session_id=?').get(sid)!
      expect(row).toMatchObject({ epoch: witnessed!.epoch, source_witness: witnessed!.source_witness })
      expect(db.prepare('SELECT COUNT(*) AS count FROM captured_record_versions WHERE session_id=?').get(sid)!.count).toBe(7)
    } finally { db.close() }
    expect(await readFile(legacy.path)).toEqual(legacy.original)
  })

  it('reports a lost directory ACK without losing the applied captured version or authorizing a second update', async () => {
    const f = await fixture(), target = capturedStorageRecords(1)[1]!
    await append(f.store, [target])
    const original = await exact(f.store, target.id)
    faults.directory = dirname(f.path); faults.directoryAck = true
    const changed = { ...target, status: 'complete' as const, updatedAt: _historyFixtureEpoch(0, 9, 1), toolOutput: 'exact directory-ack completion' }
    await expect(f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: changed }))
      .rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED', commitOutcome: 'applied' })
    expect(faults.directoryAck).toBe(false)
    const recovered = await exact(f.store, target.id)
    expect(recovered.item).toEqual(changed); expect(recovered.stream.epoch).toBe(original.stream.epoch)
    expect(recovered.sequence).toBe(original.sequence + 1)
    faults.syncPaths = []; probe.target(f.path); probe.reset()
    await expect(f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item: changed })).resolves.toMatchObject({ changed: false })
    expect(faults.syncPaths).toEqual(expect.arrayContaining([f.path, dirname(f.path)]))
    expect((await exact(f.store, target.id)).sequence).toBe(recovered.sequence)
    console.log('__CAPTURED_ACK_RECONFIRM__', JSON.stringify({ fault: 'directory-ack', sequence: recovered.sequence, syncedOriginalFile: faults.syncPaths.includes(f.path), syncedOriginalDirectory: faults.syncPaths.includes(dirname(f.path)), sqlite: probe.stats() }))
  })

  it('recovers the same original flock handle after one post-COMMIT close failure without poisoning committed capture', async () => {
    const f = await fixture(), item = capturedStorageRecords(1)[1]!
    const ready = await f.store.loadTimeline(sid)
    const lockBefore = await stat(f.path + '.lock'), nativeExec = DatabaseSync.prototype.exec
    faults.lockPath = f.path + '.lock'; faults.failLockClose = true
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const commit = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      const capturedMutation = sql === 'COMMIT' && !faults.lockArmed &&
        this.prepare('SELECT sequence FROM captured_streams WHERE session_id=?').get(sid)?.sequence === 1
      const value = nativeExec.call(this, sql)
      if (capturedMutation) faults.lockArmed = true
      return value
    })
    probe.target(f.path); probe.reset()
    let first: Awaited<ReturnType<typeof f.store.applyTimelineMutation>> | undefined
    let retry: Awaited<ReturnType<typeof f.store.applyTimelineMutation>> | undefined
    try {
      first = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })
      expect(first).toMatchObject({ changed: true, revision: 1 })
      expect(faults.lockArmed).toBe(true); expect(faults.failLockClose).toBe(false)
      expect(faults.lockCloseHandles).toHaveLength(1)
      expect(warning).toHaveBeenCalledWith(expect.any(String), { code: 'AGENT_SESSION_STORE_LOCK_RELEASE_FAILED' })
      const actual = await exact(f.store, item.id), io = probe.stats()
      expect(actual).toMatchObject({ item, stream: { epoch: ready.stream!.epoch, sequence: 1 } })
      expect(io.writes).toBeGreaterThan(0); expect(io.syncs).toBeGreaterThan(0)
    } finally {
      commit.mockRestore()
      faults.syncPaths = []
      // The same canonical mutation is also the bounded recovery of this test-owned handle.
      retry = await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item })
    }
    expect(retry).toMatchObject({ changed: false, revision: first!.revision })
    expect(faults.lockCloseHandles.length).toBeGreaterThanOrEqual(3)
    expect(faults.lockCloseHandles[1]).toBe(faults.lockCloseHandles[0])
    expect(faults.lockCloseHandles.at(-1)).not.toBe(faults.lockCloseHandles[0])
    expect(faults.syncPaths).toEqual(expect.arrayContaining([f.path, dirname(f.path)]))
    const after = await exact(f.store, item.id), lockAfter = await stat(f.path + '.lock')
    expect(after.stream).toMatchObject({ epoch: ready.stream!.epoch, sequence: 1 })
    expect(after.sequence).toBe(1)
    expect([lockAfter.dev, lockAfter.ino]).toEqual([lockBefore.dev, lockBefore.ino])
    console.log('__CAPTURED_LOCK_CLEANUP__', JSON.stringify({ originalHandleRetried: true, stableLockInode: true,
      sequence: after.sequence, syncedOriginalFile: faults.syncPaths.includes(f.path), syncedOriginalDirectory: faults.syncPaths.includes(dirname(f.path)) }))
  })

  it('reads the same >600-record Session and exact original version after real writer and reader processes exit/restart', async () => {
    const f = await fixture(), records = capturedStorageRecords(), file = join(f.root, 'original-records.json')
    await writeFile(file, JSON.stringify(records))
    const module = fileURLToPath(new URL('../dist/agent-session-store.js', import.meta.url))
    const script = `
      import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(module)};
      import {readFile} from 'node:fs/promises';import{createHash}from'node:crypto';
      const store=new AgentMuxFileAgentSessionStore(process.env.CAPTURED_STORE),sid=process.env.CAPTURED_SESSION;
      const rows=JSON.parse(await readFile(process.env.CAPTURED_RECORDS,'utf8'));
      if(process.env.CAPTURED_PHASE==='writer'){
        for(const item of rows)await store.applyTimelineMutation({type:'append',agentSessionId:sid,item});
        const original=(await store.readCapturedHistory(sid,{recordId:rows[1].id})).records[0];
        await store.applyTimelineMutation({type:'upsert',agentSessionId:sid,item:{...rows[1],updatedAt:20000,status:'complete',toolOutput:'exact process completion'}});
        await import('node:fs/promises').then(fs=>fs.writeFile(process.env.CAPTURED_PRIOR,JSON.stringify(original)));
      }
      const prior=JSON.parse(await readFile(process.env.CAPTURED_PRIOR,'utf8'));let stream,all=[],before;
      for(let n=0;n<100;n++){
        const page=await store.readCapturedHistory(sid,{limit:43,...(stream?{epoch:stream.epoch,throughSequence:stream.sequence}:{}),...(before===undefined?{}:{beforeFirstSequence:before})});
        if(stream&&JSON.stringify(stream)!==JSON.stringify(page.stream))throw Error('cut drift');stream??=page.stream;all.push(...page.records);
        if(!page.more)break;if(!page.records.length||page.nextBeforeFirstSequence===null)throw Error('no progress');before=page.nextBeforeFirstSequence;
      }
      const exact=await store.readCapturedHistory(sid,{recordId:prior.item.id,recordRevision:prior.revision});
      console.log(JSON.stringify({pid:process.pid,stream,count:all.length,ids:all.map(row=>row.item.id),digest:createHash('sha256').update(JSON.stringify(all)).digest('hex'),prior,exact:exact.records,metadata:await store.readMetadata(sid)}));`
    type ProcessSummary = { pid: number; stream: AgentCapturedTimelineStream; count: number; ids: string[]; digest: string; prior: AgentCapturedTimelineRecord; exact: AgentCapturedTimelineRecord[]; metadata: AgentMuxStoredAgentSession }
    const run = (phase: string) => new Promise<ProcessSummary>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
        CAPTURED_STORE: f.path, CAPTURED_SESSION: sid, CAPTURED_RECORDS: file, CAPTURED_PRIOR: join(f.root, 'prior-version.json'), CAPTURED_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child); let stdout = '', stderr = ''
      child.stdout!.on('data', value => { stdout += String(value) }); child.stderr!.on('data', value => { stderr += String(value) })
      child.once('error', reject); child.once('exit', code => {
        if (code !== 0) { reject(new Error(`Private captured child failed ${code}: ${stderr}`)); return }
        try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
      })
    })
    const writer = await run('writer'), reader = await run('reader')
    expect(writer.pid).not.toBe(reader.pid); expect(writer.pid).not.toBe(process.pid); expect(reader.pid).not.toBe(process.pid)
    const { pid: _writer, ...first } = writer, { pid: _reader, ...second } = reader
    expect(second).toEqual(first)
    expect(reader).toMatchObject({ count: 603, stream: { sequence: 604, revision: 604, origin: 'beginning' }, metadata: f.session })
    expect(reader.ids).toEqual([...records].reverse().map(item => item.id))
    expect(reader.exact).toEqual([reader.prior])
  }, 60000)

  it('bounds real SQLite page/hot-ID IO by the returned window rather than >16MiB history or unrelated Sessions', async () => {
    const samples: Array<{ own: number; others: number; read: ReturnType<typeof probe.stats>; write: ReturnType<typeof probe.stats> }> = []
    for (const [own, others] of [[4, 1], [201, 24]] as const) {
      const f = await fixture(), records = capturedStorageRecords(own, 48000)
      await append(f.store, records)
      for (let n = 0; n < others; n++) {
        const id = `unrelated-captured-${n}`
        await f.store.compareAndSwap(null, capturedStorageSession(f.root, id))
        await append(f.store, capturedStorageRecords(1, 16000, id))
      }
      probe.target(f.path); probe.reset()
      const page = await new AgentMuxFileAgentSessionStore(f.path).readCapturedHistory(sid, { limit: 2 })
      const read = probe.stats(); expect(page.records).toHaveLength(2); expect(read.failures).toBe(0); expect(read.readBytes).toBeGreaterThan(0)
      expect(read.readBytes).toBeLessThan(1024 * 1024)
      probe.reset()
      const item = { ...records[1]!, updatedAt: _historyFixtureEpoch(0, 30, 0), status: 'complete' as const, toolOutput: 'bounded old-ID completion' }
      await new AgentMuxFileAgentSessionStore(f.path).applyTimelineMutation({ type: 'upsert', agentSessionId: sid, item })
      const write = probe.stats(); expect(write.failures).toBe(0); expect(write.readBytes).toBeGreaterThan(0)
      expect(write.readBytes).toBeLessThan(1024 * 1024); expect(write.writeBytes).toBeLessThan(1024 * 1024)
      expect(write.syncs).toBeGreaterThan(0); expect(write.dirSyncs).toBeGreaterThan(0)
      expect((await exact(f.store, item.id)).firstSequence).toBe(2)
      samples.push({ own, others, read, write })
    }
    expect(samples[1]!.read.readBytes).toBeLessThan(samples[0]!.read.readBytes * 2 + 128 * 1024)
    expect(samples[1]!.write.readBytes).toBeLessThan(samples[0]!.write.readBytes * 2 + 128 * 1024)
    console.log('__CAPTURED_STORAGE_IO__', JSON.stringify(samples))
  }, 90000)
})
