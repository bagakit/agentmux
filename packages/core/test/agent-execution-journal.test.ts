import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, unlink, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { messageJournalIo } from './helpers/message-journal-io.js'

const faults = vi.hoisted(() => ({ remaining: 0, syncs: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      faults.syncs++
      if (faults.remaining > 0 && --faults.remaining === 0) throw Object.assign(new Error('Injected storage acknowledgement loss'), { code: 'EIO' })
      return sync()
    }
    return handle
  } }
})
import { AgentExecutionJournal, type AgentExecutionOperationKey } from '../src/agent-execution-journal.js'

let io: Awaited<ReturnType<typeof messageJournalIo>>
beforeAll(async () => { io = await messageJournalIo() }, 30_000)
afterAll(async () => { await io.close() })
const roots: string[] = [], journals: AgentExecutionJournal[] = []
const target = (nativeRequestId: string | number = 0): AgentExecutionOperationKey => ({ bindingId: 'binding-a', streamGeneration: 'original-stream', nativeRequestId })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-execution-journal-')))
  roots.push(root)
  const directory = join(root, 'binding')
  io.target(join(directory, 'operations.sqlite'))
  const journal = await AgentExecutionJournal.open(directory)
  journals.push(journal)
  return { root, directory, journal }
}
afterEach(async () => {
  faults.remaining = 0
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('original native tool operation journal', () => {
  it('admits exactly one dispatch and refuses conflicting original bytes without revealing payloads', async () => {
    const { journal } = await fixture(), body = 'private-command-token'
    const first = await journal.prepare(target(), body)
    expect(await journal.prepare(target(), body)).toEqual(first)
    expect(JSON.stringify(first)).not.toContain(body)
    expect(first).toMatchObject({ phase: 'prepared', outcome: 'not-dispatched', revision: 1 })
    await expect(journal.prepare(target(), 'different')).rejects.toMatchObject({ code: 'AGENT_EXECUTION_OPERATION_CONFLICT' })
    const replies = await Promise.all([journal.dispatch(target(), first.payloadDigest), journal.dispatch(target(), first.payloadDigest)])
    expect(replies.map(reply => reply.dispatch)).toEqual([true, false])
    expect(replies[0]!.operation).toMatchObject({ phase: 'dispatched', outcome: 'unknown' })
    expect(await journal.markUnknown(target(), first.payloadDigest)).toMatchObject({ phase: 'unknown', outcome: 'unknown' })
    expect((await journal.dispatch(target(), first.payloadDigest)).dispatch).toBe(false)
    expect(await journal.readResult(target(), first.payloadDigest)).toBeNull()
  })

  it('keeps stream, binding and string/numeric request identities distinct, freezing queued input', async () => {
    const { journal } = await fixture(), mutable = target()
    const pending = journal.prepare(mutable, 'original')
    mutable.bindingId = 'changed'; mutable.streamGeneration = 'changed'; mutable.nativeRequestId = 'changed'
    const first = await pending
    expect(first).toMatchObject(target())
    expect(await journal.inspect(mutable)).toBeNull()
    for (const other of [target('0'), { ...target(), streamGeneration: 'next-stream' }, { ...target(), bindingId: 'other-binding' }]) {
      expect(await journal.inspect(other)).toBeNull()
      expect((await journal.prepare(other, 'distinct')).phase).toBe('prepared')
      await expect(journal.readResult(other, first.payloadDigest)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_OPERATION_CONFLICT' })
    }
    await expect(journal.markUnknown(target(), first.payloadDigest)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_OPERATION_CONFLICT' })
    await expect(journal.complete(target(), first.payloadDigest, 'unsolicited')).rejects.toMatchObject({ code: 'AGENT_EXECUTION_OPERATION_CONFLICT' })
  })

  it('retains exact private response bytes atomically across a second process with no repeat dispatch', async () => {
    const { root, directory, journal } = await fixture()
    const original = await journal.prepare(target(), 'input-secret')
    await journal.dispatch(target(), original.payloadDigest)
    const response = Buffer.from([0, 255, 10, 123, 125]), saved = Buffer.from(response)
    const completion = journal.complete(target(), original.payloadDigest, response)
    response.fill(42)
    const completed = await completion
    expect(completed).toMatchObject({ phase: 'completed', outcome: 'response-recorded', resultBytes: 5 })
    expect(Object.keys(completed)).not.toContain('result')
    expect(Buffer.from((await journal.readResult(target(), original.payloadDigest))!)).toEqual(saved)
    expect(await journal.complete(target(), original.payloadDigest, saved)).toEqual(completed)
    await expect(journal.complete(target(), original.payloadDigest, 'changed')).rejects.toMatchObject({ code: 'AGENT_EXECUTION_OPERATION_CONFLICT' })
    await journal.close()

    const modulePath = join(root, 'journal.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../src/agent-execution-journal.ts', import.meta.url))], outfile: modulePath, bundle: true, platform: 'node', format: 'esm' })
    const source = `const {AgentExecutionJournal}=await import(process.argv[1]);
      const journal=await AgentExecutionJournal.open(process.argv[2],process.argv[3]);
      const key=JSON.parse(process.argv[4]), digest=process.argv[5];
      const operation=await journal.inspect(key), dispatch=await journal.dispatch(key,digest);
      const result=await journal.readResult(key,digest);
      await journal.close();
      process.stdout.write(JSON.stringify({operation,dispatch:dispatch.dispatch,result:Buffer.from(result).toString('base64')}));`
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(modulePath).href, directory, journal.identity, JSON.stringify(target()), original.payloadDigest])
    const reopened = JSON.parse(child.stdout) as { operation: unknown; dispatch: boolean; result: string }
    expect(reopened.operation).toEqual(completed)
    expect(reopened.dispatch).toBe(false)
    expect(Buffer.from(reopened.result, 'base64')).toEqual(saved)
    expect((await stat(join(directory, 'operations.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'operations.identity'))).mode & 0o777).toBe(0o600 & ~process.umask())
    expect(await readFile(join(directory, 'operations.identity'), 'utf8')).toBe(journal.identity)
  })

  it('retains one original operation through seeded real SQLite IO failures and lost dispatch replies', async () => {
    const { directory, journal: initial } = await fixture()
    let journal = initial, seed = 0x5eed
    for (let index = 0; index < 16; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const key = target(index), prepared = await journal.prepare(key, 'request-' + index)
      io.reset(); io.fault(seed % 2 ? 'write' : 'sync', seed % 3)
      await expect(journal.dispatch(key, prepared.payloadDigest)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_WRITE_UNCONFIRMED' })
      expect(io.stats().failures).toBe(1)
      await journal.close()
      journal = await AgentExecutionJournal.open(directory, initial.identity); journals.push(journal)
      const observed = await journal.inspect(key)
      expect(observed?.payloadDigest).toBe(prepared.payloadDigest)
      // If SQLite rolled back, a caller may explicitly admit the never-sent original.
      // If committed/unknown, no native effect is inferred and dispatch is never replayed.
      const first = await journal.dispatch(key, prepared.payloadDigest)
      expect(first.dispatch).toBe(observed?.phase === 'prepared')
      // Deliberately discard that receipt before reconnecting, as a broken transport does.
      await journal.close()
      journal = await AgentExecutionJournal.open(directory, initial.identity); journals.push(journal)
      for (let retry = 0; retry < (seed % 5) + 1; retry++) expect((await journal.dispatch(key, prepared.payloadDigest)).dispatch).toBe(false)
      expect(await journal.readResult(key, prepared.payloadDigest)).toBeNull()
      await journal.complete(key, prepared.payloadDigest, 'response-' + index)
      expect(Buffer.from((await journal.readResult(key, prepared.payloadDigest))!).toString()).toBe('response-' + index)
    }
  })

  it('acknowledges SQLite EXTRA durability without duplicating file/directory fsync on every mutation', async () => {
    const { journal } = await fixture(), explicitSyncs = faults.syncs
    io.reset()
    await journal.prepare(target(), 'durable')
    expect(io.stats()).toMatchObject({ syncs: 3, dirSyncs: 1, failures: 0 })
    expect(faults.syncs).toBe(explicitSyncs)
  })

  it('refuses a locked writer without dispatch and retains the prepared operation for an explicit later call', async () => {
    const { directory, journal } = await fixture(), prepared = await journal.prepare(target(), 'input')
    const concurrent = new DatabaseSync(join(directory, 'operations.sqlite'))
    try {
      concurrent.exec('BEGIN IMMEDIATE')
      await expect(journal.dispatch(target(), prepared.payloadDigest)).rejects.toMatchObject({ transactionOutcome: 'not-committed' })
      expect(await journal.inspect(target())).toMatchObject({ phase: 'prepared' })
      concurrent.exec('ROLLBACK')
      expect((await journal.dispatch(target(), prepared.payloadDigest)).dispatch).toBe(true)
    } finally { concurrent.close() }
  })

  it('does not replace missing acknowledged history or accept a different journal identity', async () => {
    const { directory, journal } = await fixture(), identity = journal.identity
    await journal.prepare(target(), 'input'); await journal.close()
    await expect(AgentExecutionJournal.open(directory, 'wrong-identity')).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_INVALID' })
    await unlink(join(directory, 'operations.sqlite'))
    await expect(AgentExecutionJournal.open(directory)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_MISSING' })
    await unlink(join(directory, 'operations.identity'))
    await expect(AgentExecutionJournal.open(directory, identity)).rejects.toMatchObject({ code: 'AGENT_EXECUTION_JOURNAL_MISSING' })
    await expect(stat(join(directory, 'operations.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses keyed reads with stable work as unrelated bindings grow and never flushes read-only duplicates', async () => {
    const { directory, journal } = await fixture(), original = await journal.prepare(target(), 'input')
    await journal.dispatch(target(), original.payloadDigest)
    const db = new DatabaseSync(join(directory, 'operations.sqlite'))
    const timings: { unrelated: number; p50Ms: number; p95Ms: number }[] = []
    try {
      const insert = db.prepare("INSERT INTO operations VALUES (?, 'unused', '0', ?, 1, 'prepared', 1, NULL, NULL, NULL)")
      for (const unrelated of [0, 100, 10_000]) {
        db.exec('BEGIN IMMEDIATE')
        for (let index = unrelated === 10_000 ? 100 : 0; index < unrelated; index++) insert.run('unrelated-' + index, original.payloadDigest)
        db.exec('COMMIT')
        const syncs = faults.syncs, samples: number[] = []
        for (let repeat = 0; repeat < 300; repeat++) {
          const start = performance.now()
          expect((await journal.inspect(target()))?.payloadDigest).toBe(original.payloadDigest)
          samples.push(performance.now() - start)
        }
        expect((await journal.dispatch(target(), original.payloadDigest)).dispatch).toBe(false)
        expect(faults.syncs).toBe(syncs)
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT phase FROM operations WHERE binding_id=? AND stream_generation=? AND request_id=?').all('binding-a', 'original-stream', '0')
        expect(plan).toHaveLength(1)
        expect(plan[0]!.detail).toMatch(/SEARCH operations USING PRIMARY KEY/u)
        samples.sort((a, b) => a - b)
        timings.push({ unrelated, p50Ms: samples[150]!, p95Ms: samples[285]! })
      }
      // Report observations, not a machine-specific latency promise. The primary-key plan is the cost gate.
      console.info('execution journal keyed lookup observations', timings)
    } finally { db.close() }
  })
})
