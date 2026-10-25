import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const probe = vi.hoisted(() => ({ observing: false, proveReadonly: false, rejectedWrite: false, queries: [] as string[] }))
vi.mock('node:sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args)
      if (probe.proveReadonly) {
        try { this.exec('CREATE TABLE forbidden_reader_write (id INTEGER)'); probe.rejectedWrite = false }
        catch (error) { probe.rejectedWrite = (error as { errcode?: number }).errcode === 8 }
      }
    }
    override prepare(sql: string) { if (probe.observing) probe.queries.push(sql); return super.prepare(sql) }
  } }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const guard = <T extends (...args: any[]) => any>(fn: T): T => ((...args: Parameters<T>) => {
    if (probe.observing) throw new Error('A retained reader tried a filesystem writer operation')
    return fn(...args)
  }) as T
  return { ...actual, mkdir: guard(actual.mkdir), open: guard(actual.open), chmod: guard(actual.chmod) }
})
import { AgentExecutionJournal, type AgentExecutionOperationKey } from '../src/agent-execution-journal.js'

const roots: string[] = []
const target = (nativeRequestId: string | number = 0): AgentExecutionOperationKey => ({ bindingId: 'original-binding', streamGeneration: 'original-generation', nativeRequestId })
afterEach(async () => { probe.observing = false; probe.proveReadonly = false; probe.rejectedWrite = false; probe.queries = []; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(phase: 'prepared' | 'dispatched' | 'completed' = 'prepared') {
  const root = await mkdtemp(join(tmpdir(), 'retained-execution-')); roots.push(root)
  const directory = join(root, 'journal'), journal = await AgentExecutionJournal.open(directory)
  const original = await journal.prepare(target(), 'private-native-request')
  if (phase !== 'prepared') await journal.dispatch(target(), original.payloadDigest)
  if (phase === 'completed') await journal.complete(target(), original.payloadDigest, 'private-native-result')
  const operation = await journal.inspect(target()), identity = journal.identity
  await journal.close()
  return { root, directory, path: join(directory, 'operations.sqlite'), marker: join(directory, 'operations.identity'), operation, identity }
}

it('opens genuinely read-only and returns only primary-key metadata without filesystem writes', async () => {
  const f = await fixture('completed'), before = await readFile(f.path), beforeStat = await stat(f.path), names = await readdir(f.directory)
  probe.observing = true; probe.proveReadonly = true
  const retained = await AgentExecutionJournal.inspectRetained(f.directory, target(), f.identity)
  expect(probe.rejectedWrite).toBe(true)
  expect(retained).toEqual(f.operation)
  expect(JSON.stringify(retained)).not.toContain('private-native-')
  expect(retained).not.toHaveProperty('result')
  const selects = probe.queries.filter(sql => sql.includes(' FROM operations '))
  expect(selects).toHaveLength(1)
  expect(selects[0]).toContain('WHERE binding_id=? AND stream_generation=? AND request_id=?')
  expect(selects[0]).not.toMatch(/\bresult\b/u)
  expect(await readFile(f.path)).toEqual(before)
  const after = await stat(f.path)
  expect([after.mode, after.mtimeMs, after.ctimeMs]).toEqual([beforeStat.mode, beforeStat.mtimeMs, beforeStat.ctimeMs])
  expect(await readdir(f.directory)).toEqual(names)
})

it.each(['prepared', 'dispatched'] as const)('never rewrites a retained %s phase or revision', async phase => {
  const f = await fixture(phase)
  probe.observing = true
  expect(await AgentExecutionJournal.inspectRetained(f.directory, target())).toEqual(f.operation)
  expect(await AgentExecutionJournal.inspectRetained(f.directory, target())).toEqual(f.operation)
})

it('distinguishes a valid absent primary key from an unavailable journal and freezes requested identity', async () => {
  const f = await fixture(), mutable = target()
  const reading = AgentExecutionJournal.inspectRetained(f.directory, mutable)
  mutable.bindingId = 'different'; mutable.nativeRequestId = '0'
  expect(await reading).toEqual(f.operation)
  for (const key of [target('0'), { ...target(), bindingId: 'another' }, { ...target(), streamGeneration: 'another' }]) expect(await AgentExecutionJournal.inspectRetained(f.directory, key)).toBeNull()
  await expect(AgentExecutionJournal.inspectRetained(f.directory, { ...target(), nativeRequestId: 1.5 })).rejects.toMatchObject({ code: 'INVALID_EXECUTION_OPERATION' })
})

it('does not create absent directories, databases or missing identity markers', async () => {
  const f = await fixture(), missing = join(f.root, 'absent')
  await expect(AgentExecutionJournal.inspectRetained(missing, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  await unlink(f.path)
  await expect(AgentExecutionJournal.inspectRetained(f.directory, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const g = await fixture(); await unlink(g.marker)
  await expect(AgentExecutionJournal.inspectRetained(g.directory, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  await expect(stat(g.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['application', 'version', 'identity', 'marker', 'expectedIdentity'])('refuses mismatched %s without repair or an empty success', async kind => {
  const f = await fixture()
  if (kind === 'marker') await writeFile(f.marker, 'another-identity')
  else if (kind !== 'expectedIdentity') {
    const db = new DatabaseSync(f.path)
    try {
      if (kind === 'application') db.exec('PRAGMA application_id=0')
      else if (kind === 'version') db.exec('PRAGMA user_version=2')
      else db.prepare('UPDATE identity SET id=?').run('another-identity')
    } finally { db.close() }
  }
  const before = await readFile(f.path)
  probe.observing = true
  await expect(AgentExecutionJournal.inspectRetained(f.directory, target(), kind === 'expectedIdentity' ? 'another-identity' : f.identity)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  expect(await readFile(f.path)).toEqual(before)
})

it('refuses an invalid primary-key schema before reading operation rows', async () => {
  const f = await fixture(), db = new DatabaseSync(f.path)
  try { db.exec('ALTER TABLE operations RENAME TO old_operations; CREATE TABLE operations AS SELECT * FROM old_operations; DROP TABLE old_operations') } finally { db.close() }
  probe.observing = true
  await expect(AgentExecutionJournal.inspectRetained(f.directory, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  expect(probe.queries.filter(sql => sql.includes(' FROM operations '))).toEqual([])
})

it('reports locked or unreadable storage as unknown without changing an operation', async () => {
  const f = await fixture('dispatched'), writer = new DatabaseSync(f.path)
  try {
    writer.exec('BEGIN EXCLUSIVE')
    await expect(AgentExecutionJournal.inspectRetained(f.directory, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  } finally { writer.exec('ROLLBACK'); writer.close() }
  expect(await AgentExecutionJournal.inspectRetained(f.directory, target())).toEqual(f.operation)
  await writeFile(f.path, 'corrupt-private-journal')
  probe.observing = true
  await expect(AgentExecutionJournal.inspectRetained(f.directory, target())).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_READ_UNCONFIRMED' })
  expect(await readFile(f.path, 'utf8')).toBe('corrupt-private-journal')
})
