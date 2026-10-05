import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal, type BrowserOperationJournalChanges, type BrowserOperationJournalDocument } from '../src/main/browser-operation-journal.js'
import type { BrowserOperation } from '../src/shared/browser-operation.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const operation = (id: string, count = 0): BrowserOperation => ({ id, browserId: `browser-${id}`,
  operator: { id: 'person', name: 'Person' }, phase: 'completed', startedAt: 1, finishedAt: 2,
  summary: 'Original facts', url: 'https://example.invalid/', steps: Array.from({ length: count }, (_, index) => ({
    sequence: index + 1, method: 'pressKey', label: 'Original key', startedAt: 1, finishedAt: 2,
    status: 'completed' as const, replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] }
  })) })
async function fixture(operations: BrowserOperation[]) {
  const root = await mkdtemp(join(tmpdir(), 'amx-browser-journal-incremental-')); roots.push(root)
  const path = join(root, 'original.json'), original = JSON.stringify({ version: 1, operations, events: [] })
  await writeFile(path, original)
  const store = new BrowserOperationFileStore(path)
  const journal = new BrowserOperationJournal(store)
  await journal.ready()
  return { root, path, original, store, journal }
}

describe('Browser operation writes only original related facts', () => {
  it('does not visit 100000 unrelated retained steps while starting and finishing one current step', async () => {
    const f = await fixture([operation('unrelated', 100_000), operation('current')])
    const document = (f.journal as unknown as { document: BrowserOperationJournalDocument }).document
    Object.defineProperty(document.operations[0]!, 'steps', { get() { throw new Error('Unrelated history was visited by a current step') } })
    expect(await f.journal.startStep('current', { method: 'pressKey', label: 'Current key' })).toMatchObject({ sequence: 1 })
    expect(await f.journal.finishStep('current', 1, { status: 'completed' })).toMatchObject({ sequence: 1, status: 'completed' })
    const saved = (await f.store.load())!
    expect(saved.operations[0]!.steps).toHaveLength(100_000)
    expect(saved.operations[1]!.steps).toMatchObject([{ sequence: 1, status: 'completed' }])
    const archive = (await readdir(f.root)).find(name => name.includes('.original-'))!
    expect(createHash('sha256').update(await readFile(join(f.root, archive))).digest('hex'))
      .toBe(createHash('sha256').update(f.original).digest('hex'))
  })

  it('uses a loaded max-sequence and step index past 150000 retained current steps', async () => {
    const f = await fixture([operation('current', 150_000)])
    const retained = (f.journal as unknown as { document: BrowserOperationJournalDocument }).document.operations[0]!.steps
    Object.defineProperty(retained[0]!, 'sequence', { get() { throw new Error('Existing step sequence was rescanned') } })
    expect(await f.journal.startStep('current', { method: 'pressKey', label: 'New key' })).toMatchObject({ sequence: 150_001 })
    expect(await f.journal.finishStep('current', 150_001, { status: 'completed' })).toMatchObject({ status: 'completed' })
    const saved = (await new BrowserOperationFileStore(f.path).load())!
    expect(saved.operations[0]!.steps).toHaveLength(150_001)
    expect(saved.operations[0]!.steps.at(-1)).toMatchObject({ sequence: 150_001, status: 'completed' })
  })

  it('a delayed older save cannot overwrite newer metadata or a finished step', async () => {
    const f = await fixture([operation('current')])
    let delay = true, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (delay) { delay = false; entered(); await held }
      await f.store.save(changes)
    } }, { maxEvents: 2 })
    const first = journal.startStep('current', { method: 'pressKey', label: 'Current key' })
    await started
    await journal.finishStep('current', 1, { status: 'completed' })
    await journal.setPhase('current', 'waiting', { summary: 'Later authoritative phase' })
    release(); await first
    const saved = (await f.store.load())!.operations[0]!
    expect(saved).toMatchObject({ phase: 'waiting', summary: 'Later authoritative phase', steps: [{ status: 'completed' }] })
    expect((await f.store.load())!.events.map(event => event.type)).toEqual(['step-finished', 'phase-changed'])
  })

  it('does not make another operation flush a pending unrelated ACK', async () => {
    const f = await fixture([operation('waiting'), operation('healthy')])
    let hold = true, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const healthy: BrowserOperationJournalChanges[] = []
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (hold) { hold = false; entered(); await held }
      else healthy.push(changes)
      await f.store.save(changes)
    } })
    const first = journal.startStep('waiting', { method: 'click', label: 'Awaiting optional storage ACK' })
    await started
    await journal.startStep('healthy', { method: 'snapshot', label: 'Independent healthy observation' })
    expect(healthy).toHaveLength(1)
    expect(healthy[0]!.operations.map(changed => changed.metadata.id)).toEqual(['healthy'])
    expect(healthy[0]!.events.map(changed => changed.event.operationId)).toEqual(['healthy'])
    expect((await f.store.load())!.operations.find(operation => operation.id === 'waiting')!.steps).toEqual([])
    release(); await first
    expect((await f.store.load())!.operations.map(operation => operation.steps.length)).toEqual([1, 1])
  })

  it('retains failed immutable deltas and deduplicates an uncertain committed save without repeating Browser actions', async () => {
    const f = await fixture([operation('current')])
    let uncertain = true
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      await f.store.save(changes)
      if (uncertain) { uncertain = false; throw new Error('Commit ACK unavailable') }
    } })
    await journal.startStep('current', { method: 'pressKey', label: 'Already acted once' })
    expect(journal.getPersistenceWarning()).toContain('Commit ACK unavailable')
    await journal.finishStep('current', 1, { status: 'completed' })
    const saved = (await f.store.load())!
    expect(saved.operations[0]!.steps).toHaveLength(1)
    expect(saved.events.map(event => event.type)).toEqual(['step-started', 'step-finished'])
  })

  it('retries an uncommitted original step and event after a storage failure', async () => {
    const f = await fixture([operation('current')])
    let fail = true
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (fail) { fail = false; throw new Error('Before commit storage failure') }
      await f.store.save(changes)
    } })
    await journal.startStep('current', { method: 'pressKey', label: 'Original action' })
    await journal.finishStep('current', 1, { status: 'completed' })
    const saved = (await f.store.load())!
    expect(saved.operations[0]!.steps).toMatchObject([{ sequence: 1, status: 'completed' }])
    expect(saved.events.map(event => event.type)).toEqual(['step-started', 'step-finished'])
  })

  it('does not replace a temporarily missing original store and saves pending facts after its return', async () => {
    const f = await fixture([operation('original', 3), operation('current')])
    await rename(f.path, `${f.path}.held`)
    await f.journal.startStep('current', { method: 'pressKey', label: 'Healthy live action' })
    expect(f.journal.getPersistenceWarning()).toContain('temporarily missing')
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await rename(`${f.path}.held`, f.path)
    await f.journal.finishStep('current', 1, { status: 'completed' })
    const saved = (await f.store.load())!
    expect(saved.operations[0]!.steps).toEqual(operation('original', 3).steps)
    expect(saved.operations[1]!.steps).toMatchObject([{ sequence: 1, status: 'completed' }])
    expect(saved.events.map(event => event.type)).toEqual(['step-started', 'step-finished'])
  })

  it('never overwrites damaged original history while healthy live operations continue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-browser-journal-damage-')); roots.push(root)
    const path = join(root, 'original.json'), original = '{original unreadable history'
    await writeFile(path, original)
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
    await journal.start({ id: 'live', browserId: 'browser-live', operator: { id: 'person', name: 'Person' }, summary: 'Healthy Browser', url: 'https://example.invalid/' })
    await journal.startStep('live', { method: 'snapshot', label: 'Still observing' })
    expect(await journal.get('live')).toMatchObject({ id: 'live', steps: [{ sequence: 1 }] })
    expect(journal.getPersistenceWarning()).toContain('Original Browser history is unreadable')
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
