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

  it('only clears a save failure after every affected operation has an exact ACK', async () => {
    const f = await fixture([operation('failed'), operation('healthy')])
    let fail = true
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (fail) { fail = false; throw new Error('Original failed operation remains pending') }
      await f.store.save(changes)
    } })
    await journal.startStep('failed', { method: 'snapshot', label: 'Pending fact' })
    expect(journal.getPersistenceWarning()).toContain('remains pending')
    await journal.startStep('healthy', { method: 'snapshot', label: 'Unrelated healthy fact' })
    expect(journal.getPersistenceWarning()).toContain('remains pending')
    await journal.finishStep('failed', 1, { status: 'completed' })
    expect(journal.getPersistenceWarning()).toBeUndefined()
  })

  it('an older late ACK does not clear a newer failed operation warning', async () => {
    const f = await fixture([operation('older'), operation('failed')])
    let call = 0, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (++call === 1) { entered(); await held }
      else if (call === 2) throw new Error('Newer operation save failed')
      await f.store.save(changes)
    } })
    const first = journal.startStep('older', { method: 'snapshot', label: 'Delayed ACK' })
    await started
    await journal.startStep('failed', { method: 'snapshot', label: 'Newer pending fact' })
    release(); await first
    expect(journal.getPersistenceWarning()).toContain('Newer operation save failed')
    await journal.finishStep('failed', 1, { status: 'completed' })
    expect(journal.getPersistenceWarning()).toBeUndefined()
  })

  it('an obsolete failure cannot resurrect a warning after a newer snapshot was fully acknowledged', async () => {
    const f = await fixture([operation('current')])
    let first = true, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (first) { first = false; entered(); await held; throw new Error('Obsolete snapshot failed') }
      await f.store.save(changes)
    } })
    const pending = journal.startStep('current', { method: 'snapshot', label: 'First original fact' })
    await started
    await journal.finishStep('current', 1, { status: 'completed' })
    release(); await pending
    expect(journal.getPersistenceWarning()).toBeUndefined()
  })

  it.each([true, false])('an older failure cannot replace a newer operation warning (original ACK=%s)', async acknowledged => {
    const f = await fixture([operation('older'), operation('newer')])
    let call = 0, entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (++call === 1) { entered(); await held; throw new Error('Obsolete older save failed') }
      if (changes.operations.some(value => value.metadata.id === 'newer') && call <= 3) throw new Error('Newer original save failed')
      await f.store.save(changes)
    } })
    const older = journal.startStep('older', { method: 'snapshot', label: 'Original delayed save' })
    await started
    if (acknowledged) await journal.finishStep('older', 1, { status: 'completed' })
    await journal.startStep('newer', { method: 'snapshot', label: 'Newer pending save' })
    expect(journal.getPersistenceWarning()).toContain('Newer original save failed')
    release(); await older
    expect(journal.getPersistenceWarning()).toContain('Newer original save failed')
  })

  it('a confirmed older failure cannot blame unrelated facts that are still saving', async () => {
    const f = await fixture([operation('older'), operation('saving')])
    let call = 0, enterOlder!: () => void, releaseOlder!: () => void, enterSaving!: () => void, releaseSaving!: () => void
    const olderEntered = new Promise<void>(resolve => { enterOlder = resolve }), olderHeld = new Promise<void>(resolve => { releaseOlder = resolve })
    const savingEntered = new Promise<void>(resolve => { enterSaving = resolve }), savingHeld = new Promise<void>(resolve => { releaseSaving = resolve })
    const journal = new BrowserOperationJournal({ load: () => f.store.load(), async save(changes) {
      if (++call === 1) { enterOlder(); await olderHeld; throw new Error('Confirmed original snapshot failed late') }
      if (call === 3) { enterSaving(); await savingHeld }
      await f.store.save(changes)
    } })
    const older = journal.startStep('older', { method: 'snapshot', label: 'Delayed original save' })
    await olderEntered
    await journal.finishStep('older', 1, { status: 'completed' })
    const saving = journal.startStep('saving', { method: 'snapshot', label: 'Still saving without a failure' })
    await savingEntered
    releaseOlder(); await older
    expect(journal.getPersistenceWarning()).toBeUndefined()
    releaseSaving(); await saving
    expect(journal.getPersistenceWarning()).toBeUndefined()
  })

  it('a live save ACK cannot claim the unknown original history was loaded', async () => {
    const journal = new BrowserOperationJournal({ async load() { return null }, async save() {} })
    await journal.start({ id: 'live', browserId: 'browser-live', operator: { id: 'person', name: 'Person' }, summary: 'Healthy live facts', url: 'https://example.invalid/' })
    expect(journal.getPersistenceWarning()).toContain('history is unavailable')
    expect(await journal.get('live')).toMatchObject({ id: 'live' })
  })
})
