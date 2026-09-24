import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeSqliteHistoryReader } from '../dist/native-sqlite-history-reader.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES, SESSION_HISTORY_TIMEOUT_MS } from '../src/session-history.js'

const probe = vi.hoisted(() => ({ root: '', opened: 0, closed: 0, reads: [] as Array<{ path: string; length: number; position: number }>,
  onReadStarted: undefined as undefined | (() => void), closeFailure: false,
  databaseClosed: 0, statements: new Set<number>(), virtualFiles: new Set<number>(),
  progressCount: 0, onProgress: undefined as undefined | (() => void) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args)
    if (String(args[0]).startsWith(probe.root)) {
      expect(Number(args[1]) & 3).toBe(0)
      probe.opened++
      const read = file.read.bind(file), close = file.close.bind(file)
      vi.spyOn(file, 'read').mockImplementation(async (...values) => {
        const request = values as readonly unknown[]
        probe.reads.push({ path: String(args[0]), length: Number(request[2]), position: Number(request[3]) })
        const pending = Reflect.apply(read, file, values)
        probe.onReadStarted?.()
        return pending
      })
      vi.spyOn(file, 'close').mockImplementation(async () => {
        if (probe.closeFailure) { probe.closeFailure = false; throw new Error('private injected close failure') }
        await close(); probe.closed++
      })
    }
    return file
  } }
})
vi.mock('wa-sqlite', async original => {
  const library = await original<typeof import('wa-sqlite')>()
  return { ...library, Factory: (...args: Parameters<typeof library.Factory>) => {
    const api = library.Factory(...args), register = api.vfs_register.bind(api), close = api.close.bind(api)
    const prepare = api.prepare_v2.bind(api), finalize = api.finalize.bind(api), progress = api.progress_handler.bind(api)
    api.prepare_v2 = async (...values) => { const result = await prepare(...values); if (result) probe.statements.add(result.stmt); return result }
    api.finalize = async statement => { const result = await finalize(statement); probe.statements.delete(statement); return result }
    api.close = async database => { const result = await close(database); probe.databaseClosed++; return result }
    api.progress_handler = (db, ops, handler, user) => progress(db, ops, data => { probe.progressCount++; probe.onProgress?.(); return handler(data) }, user)
    api.vfs_register = (vfs, ...values) => {
      const open = vfs.xOpen.bind(vfs), close = vfs.xClose.bind(vfs)
      vfs.xOpen = (...args) => { const result = open(...args); if (result === library.SQLITE_OK) probe.virtualFiles.add(args[1]); return result }
      vfs.xClose = id => { const result = close(id); probe.virtualFiles.delete(id); return result }
      return register(vfs, ...values)
    }
    return api
  } }
})
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.restoreAllMocks()
  Object.assign(probe, { root: '', opened: 0, closed: 0, reads: [], onReadStarted: undefined, closeFailure: false,
    databaseClosed: 0, progressCount: 0, onProgress: undefined })
  probe.statements.clear(); probe.virtualFiles.clear()
})

async function fixture(large = false) {
  const root = await mkdtemp(join(tmpdir(), 'amux-native-sqlite-owner-'))
  probe.root = root
  const path = join(root, 'store.db'), writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB)')
  if (large) writer.prepare('INSERT INTO blobs VALUES (?,?)').run('large-unrelated', Buffer.alloc(5 * 1024 * 1024, 71))
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const content = JSON.stringify({ role: 'assistant', content: [{ type: 'reasoning', text: 'reason' }, { type: 'text', text: 'committed WAL answer' }] })
  writer.prepare('INSERT INTO blobs VALUES (?,?)').run('native-message', Buffer.from(content))
  cleanup.push(async () => { writer.close(); await rm(root, { recursive: true, force: true }) })
  return { root, path, writer, content }
}

async function release(reader: NativeSqliteHistoryReader) {
  await reader.close()
  expect(probe.opened).toBeGreaterThan(0)
  expect(probe.closed).toBe(probe.opened)
  expect(probe.databaseClosed).toBe(1)
  expect([...probe.statements]).toEqual([])
  expect([...probe.virtualFiles]).toEqual([])
}

describe('Native SQLite physical read owner', () => {
  it('reads a real WAL-only typed record from a >4MiB database through sparse bounded physical I/O and releases SQL/VFS/files', async () => {
    const f = await fixture(true), before = await readFile(f.path), wal = await readFile(`${f.path}-wal`)
    const stalePath = join(f.root, 'main-only.db'); await writeFile(stalePath, before)
    const stale = new DatabaseSync(stalePath, { readOnly: true })
    try { expect(stale.prepare("SELECT id FROM blobs WHERE id='native-message'").all()).toEqual([]) } finally { stale.close() }
    expect(f.writer.prepare("SELECT id FROM blobs WHERE id='native-message'").all()).toEqual([{ id: 'native-message' }])
    const budget = { bytesRead: 0, startedAt: Date.now() }
    probe.onReadStarted = () => expect(budget.bytesRead).toBe(probe.reads.reduce((total, read) => total + read.length, 0))
    const reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000), budget)
    const row = await reader.get('SELECT data FROM blobs WHERE id = ?', ['native-message'])
    expect(row).toHaveLength(1)
    expect(Buffer.from(row![0] as Uint8Array).toString()).toBe(f.content)
    await reader.verifyUnchanged()
    expect(before.length).toBeGreaterThan(SESSION_HISTORY_MAX_PAGE_BYTES)
    expect(probe.reads.map(r => r.path.endsWith('-wal'))).toContain(true)
    expect(reader.budget.bytesRead).toBe(probe.reads.reduce((sum, read) => sum + read.length, 0))
    expect(reader.budget.bytesRead).toBeGreaterThan(0)
    expect(reader.budget.bytesRead).toBeLessThan(SESSION_HISTORY_MAX_PAGE_BYTES)
    const readCount = probe.reads.length
    expect(await reader.get('SELECT data FROM blobs WHERE id = ?', ['native-message'])).toEqual(row)
    expect(probe.reads).toHaveLength(readCount)
    await release(reader)
    expect(await readFile(f.path)).toEqual(before)
    expect(await readFile(`${f.path}-wal`)).toEqual(wal)
  }, 20_000)

  it('reserves the shared budget before the real read and refuses exhausted budget before any data I/O', async () => {
    const f = await fixture(), budget = { bytesRead: SESSION_HISTORY_MAX_PAGE_BYTES - 1, startedAt: Date.now() }
    await expect(NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000), budget)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TOO_LARGE' })
    expect(budget.bytesRead).toBe(SESSION_HISTORY_MAX_PAGE_BYTES - 1)
    expect(probe.reads).toEqual([])
    expect(probe.opened).toBeGreaterThan(0)
    expect(probe.closed).toBe(probe.opened)
  })

  it('honors cancellation before opening any native file', async () => {
    const f = await fixture(), control = new AbortController(); control.abort()
    await expect(NativeSqliteHistoryReader.open(f.path, control.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(probe.opened).toBe(0); expect(probe.reads).toEqual([])
  })

  it('aborts while an actual native FileHandle.read is awaited and begins no further native reads', async () => {
    const f = await fixture(), control = new AbortController()
    probe.onReadStarted = () => control.abort()
    await expect(NativeSqliteHistoryReader.open(f.path, control.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(probe.reads).toHaveLength(1)
    expect(probe.reads[0]!.length).toBeGreaterThan(0)
    expect(probe.closed).toBe(probe.opened)
  })

  it('interrupts CPU-only query work with the real SQLite progress callback and deadline', async () => {
    const f = await fixture(), reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    const clock = vi.spyOn(Date, 'now')
    probe.onProgress = () => clock.mockReturnValue(reader.budget.startedAt + SESSION_HISTORY_TIMEOUT_MS + 1)
    await expect(reader.get('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
    expect(probe.progressCount).toBeGreaterThan(0)
    clock.mockRestore()
    await release(reader)
  })

  it('lets the mature SQLite engine ignore real spilled but uncommitted WAL frames', async () => {
    const f = await fixture(), committedSize = (await stat(`${f.path}-wal`)).size
    f.writer.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE')
    for (let index = 0; index < 4; index++) {
      f.writer.prepare('INSERT INTO blobs VALUES (?,?)').run(`uncommitted-${index}`, Buffer.alloc(256 * 1024, index + 1))
    }
    expect((await stat(`${f.path}-wal`)).size).toBeGreaterThan(committedSize)
    const oracle = new DatabaseSync(f.path, { readOnly: true })
    try { expect(oracle.prepare('SELECT id FROM blobs ORDER BY id').all()).toEqual([{ id: 'native-message' }]) } finally { oracle.close() }
    const before = await readFile(f.path), wal = await readFile(`${f.path}-wal`)
    const reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    expect(await reader.get('SELECT id FROM blobs WHERE id=?', ['uncommitted-0'])).toBeUndefined()
    expect(await reader.get('SELECT id FROM blobs WHERE id=?', ['native-message'])).toEqual(['native-message'])
    await reader.verifyUnchanged(); await release(reader)
    expect(await readFile(f.path)).toEqual(before); expect(await readFile(`${f.path}-wal`)).toEqual(wal)
    f.writer.exec('ROLLBACK')
  })

  it('rejects a WAL commit begun while an actual native read is still pending', async () => {
    const f = await fixture()
    let changed = false
    probe.onReadStarted = () => {
      if (!changed) { changed = true; f.writer.prepare('INSERT INTO blobs VALUES (?,?)').run('during-native-read', Buffer.from('new commit')) }
    }
    const reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    expect(changed).toBe(true)
    await expect(reader.verifyUnchanged()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    await release(reader)
  })

  it('detects a WAL commit after query and rejects the mixed source snapshot', async () => {
    const f = await fixture(), reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    expect(await reader.get('SELECT id FROM blobs WHERE id=?', ['native-message'])).toEqual(['native-message'])
    f.writer.prepare('INSERT INTO blobs VALUES (?,?)').run('next-commit', Buffer.from('next'))
    await expect(reader.verifyUnchanged()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    await release(reader)
  })

  it('detects main pathname replacement even when its old descriptor still names a valid DB', async () => {
    const f = await fixture(), reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    expect(await reader.get('SELECT id FROM blobs WHERE id=?', ['native-message'])).toEqual(['native-message'])
    const bytes = await readFile(f.path)
    await rename(f.path, `${f.path}.old`); await writeFile(f.path, bytes)
    await expect(reader.verifyUnchanged()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    await release(reader)
  })

  it('does not ignore or delete a nonempty rollback journal', async () => {
    const f = await fixture(), journal = Buffer.from('nonempty unsafe rollback journal')
    await writeFile(`${f.path}-journal`, journal)
    await expect(NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    expect(probe.opened).toBe(0); expect(probe.reads).toEqual([])
    expect(await readFile(`${f.path}-journal`)).toEqual(journal)
  })

  it('rejects writes through the mature readonly engine without modifying native files', async () => {
    const f = await fixture(), before = await readFile(f.path), wal = await readFile(`${f.path}-wal`)
    const reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    await expect(reader.get("INSERT INTO blobs VALUES ('forbidden', 'write')")).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT' })
    await release(reader)
    expect(await readFile(f.path)).toEqual(before); expect(await readFile(`${f.path}-wal`)).toEqual(wal)
  })

  it('reports incomplete cleanup, keeps the failed descriptor for retry, and does not declare it closed', async () => {
    const f = await fixture(), reader = await NativeSqliteHistoryReader.open(f.path, AbortSignal.timeout(10_000))
    probe.closeFailure = true
    await expect(reader.close()).rejects.toThrow('cleanup remains incomplete')
    expect(probe.closed).toBe(probe.opened - 1)
    expect(probe.databaseClosed).toBe(1)
    await reader.close()
    expect(probe.closed).toBe(probe.opened)
    expect([...probe.virtualFiles]).toEqual([]); expect([...probe.statements]).toEqual([])
  })
})
