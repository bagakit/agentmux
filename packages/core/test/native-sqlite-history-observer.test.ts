import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeSqliteHistoryReader } from '../src/native-sqlite-history-reader.js'
import { observeNativeSqliteHistory } from '../src/native-sqlite-history-observer.js'
import type { AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext } from '../src/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-sqlite-observe-')), path = join(root, 'store.db')
  const writer = new DatabaseSync(path)
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('revision','first'); PRAGMA wal_checkpoint(TRUNCATE)")
  cleanup.push(async () => { writer.close(); await rm(root, { recursive: true, force: true }) })
  const control = new AbortController(), events: AgentProviderSessionHistoryObservation[] = []
  let reads = 0
  const context: AgentProviderSessionHistoryObservationContext = { source: { providerId: 'cursor', nativeSessionId: 'session' }, command: 'cursor-agent', args: [], env: {}, workspacePath: root, signal: control.signal, onChange: event => events.push(event) }
  const readRevision = async () => {
    reads++
    const reader = await NativeSqliteHistoryReader.open(path, control.signal)
    try {
      const row = await reader.get("SELECT value FROM meta WHERE key='revision'")
      await reader.verifyUnchanged()
      return String(row![0])
    } finally { await reader.close() }
  }
  const commit = (value: string) => writer.prepare("UPDATE meta SET value=? WHERE key='revision'").run(value)
  return { root, path, writer, control, context, events, readRevision, commit, reads: () => reads }
}

it('observes actual WAL commits through the read-only native reader; uncommitted bytes and checkpoint are not new conversation revisions', async () => {
  const f = await fixture(), handle = await observeNativeSqliteHistory(f.context, f.path, f.readRevision)
  cleanup.push(async () => handle.dispose()); await settle()
  f.writer.exec('BEGIN IMMEDIATE'); f.commit('uncommitted'); await settle()
  expect(f.events.filter(e => e.kind === 'invalidated')).toEqual([])
  f.writer.exec('COMMIT')
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(await f.readRevision()).toBe('uncommitted')
  expect(f.events.filter(e => e.kind === 'invalidated')).toHaveLength(1)
  f.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)'); await settle()
  expect(f.events.filter(e => e.kind === 'invalidated')).toHaveLength(1)
  expect(f.reads()).toBeGreaterThan(1)
})

it('does no revision query or publication for unrelated sibling files', async () => {
  const f = await fixture(), handle = await observeNativeSqliteHistory(f.context, f.path, f.readRevision)
  cleanup.push(async () => handle.dispose()); await settle()
  const before = f.reads(); await writeFile(join(f.root, 'unrelated.db-wal'), 'other session'); await settle()
  expect(f.reads()).toBe(before); expect(f.events).toEqual([])
})

it('fences a database replacement before asking the Provider to interpret a foreign source', async () => {
  const f = await fixture(), handle = await observeNativeSqliteHistory(f.context, f.path, f.readRevision)
  cleanup.push(async () => handle.dispose()); await settle()
  const before = f.reads(); await rename(f.path, join(f.root, 'original.db')); await writeFile(f.path, 'foreign')
  await expect.poll(() => f.events.some(e => e.kind === 'unavailable' && e.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')).toBe(true)
  expect(f.reads()).toBe(before)
  expect(f.events.filter(e => e.kind === 'invalidated')).toEqual([])
})

it('keeps the exact watch after a bounded revision read fails and recovers on the next native commit', async () => {
  const f = await fixture(); let fail = false
  const handle = await observeNativeSqliteHistory(f.context, f.path, async () => {
    if (fail) { fail = false; throw new Error('controlled transient native read') }
    return f.readRevision()
  })
  cleanup.push(async () => handle.dispose()); await settle()
  fail = true; f.commit('second')
  await expect.poll(() => f.events.some(e => e.kind === 'unavailable')).toBe(true)
  f.commit('third')
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.events.some(e => e.kind === 'invalidated')).toBe(true)
})

it('confirms a native revision changed between the initial read and installing the exact file watch', async () => {
  const f = await fixture(); let first = true
  const handle = await observeNativeSqliteHistory(f.context, f.path, async () => {
    const revision = await f.readRevision()
    if (first) { first = false; f.commit('in setup gap') }
    return revision
  })
  cleanup.push(async () => handle.dispose())
  await expect.poll(() => f.events.filter(e => e.kind === 'invalidated').length).toBe(1)
})

it('disposal and abort release the watch and discard an already pending native revision', async () => {
  const f = await fixture(); let first = true, resolve!: (value: string) => void
  let entered = false
  const pending = new Promise<string>(done => { resolve = done })
  const handle = await observeNativeSqliteHistory(f.context, f.path, () => {
    if (first) { first = false; return f.readRevision() }
    entered = true; return pending
  })
  await expect.poll(() => entered).toBe(true)
  handle.dispose(); f.control.abort(); resolve('late'); f.commit('after hidden'); await settle()
  expect(f.events).toEqual([])
  expect(f.reads()).toBe(1)
})
