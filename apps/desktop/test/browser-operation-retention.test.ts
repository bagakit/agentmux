import { applyJournalChanges } from './browser-operation-memory-store.js'
import { describe, expect, it } from 'vitest'
import { BrowserOperationJournal, type BrowserOperationJournalDocument, type BrowserOperationJournalChanges, type BrowserOperationJournalStore } from '../src/main/browser-operation-journal.js'

class MemoryStore implements BrowserOperationJournalStore {
  document: BrowserOperationJournalDocument | null = null
  async load() { return this.document ? structuredClone(this.document) : null }
  async save(changes: BrowserOperationJournalChanges) { this.document = applyJournalChanges(this.document, changes) }
}
const start = (journal: BrowserOperationJournal, id: string) => journal.start({ id, browserId: `browser-${id}`,
  operator: { id: 'owner', name: 'Agent' }, summary: 'Original work', url: 'https://example.invalid/' })

describe('durable Browser operation identity and replay completeness', () => {
  it('keeps active and unknown operations past the display window, including after recovery', async () => {
    const store = new MemoryStore(), journal = new BrowserOperationJournal(store)
    for (let index = 0; index < 65; index++) await start(journal, `live-${index}`)
    await journal.finish('live-0', 'indeterminate')
    expect((await journal.list()).map(operation => operation.id)).toEqual(Array.from({ length: 65 }, (_, index) => `live-${index}`))
    expect(store.document?.operations).toHaveLength(65)
    const restarted = new BrowserOperationJournal(store)
    expect((await restarted.list()).map(operation => operation.id)).toEqual(Array.from({ length: 65 }, (_, index) => `live-${index}`))
    expect(await restarted.get('live-0')).toMatchObject({ id: 'live-0', phase: 'indeterminate' })
    expect(await restarted.finish('live-0', 'completed')).toMatchObject({ id: 'live-0', phase: 'completed' })
    expect(store.document?.operations).toHaveLength(65)
  })

  it('windows terminal presentation without deleting exact durable lookup or replay steps', async () => {
    const store = new MemoryStore(), journal = new BrowserOperationJournal(store, { maxOperations: 2, maxEvents: 4 })
    await start(journal, 'original')
    for (let index = 1; index <= 129; index++) {
      const step = await journal.startStep('original', { method: 'pressKey', label: `Key ${index}`,
        replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
      expect(step?.sequence).toBe(index)
      await journal.finishStep('original', index, { status: 'completed' })
    }
    await journal.finish('original', 'completed')
    for (const id of ['later-1', 'later-2']) { await start(journal, id); await journal.finish(id, 'completed') }
    expect((await journal.list()).map(operation => operation.id)).toEqual(['later-1', 'later-2'])
    expect((await journal.get('original'))?.steps.map(step => step.sequence)).toEqual(Array.from({ length: 129 }, (_, index) => index + 1))
    expect((await journal.replayPlan('original'))?.steps).toHaveLength(129)
    const restarted = new BrowserOperationJournal(store, { maxOperations: 2 })
    expect((await restarted.get('original'))?.steps).toHaveLength(129)
    expect((await restarted.replayPlan('original'))?.steps).toHaveLength(129)
    expect(await journal.events()).toHaveLength(4)
  })

  it.each([[2, 3], [1, 3]])('refuses legacy incomplete sequence %j without inventing missing facts', async (...sequences) => {
    const store = new MemoryStore(), first = new BrowserOperationJournal(store)
    await start(first, 'legacy')
    for (let index = 1; index <= 3; index++) {
      await first.startStep('legacy', { method: 'pressKey', label: 'Observed key', replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
      await first.finishStep('legacy', index, { status: 'completed' })
    }
    await first.finish('legacy', 'completed')
    store.document!.operations[0]!.steps = store.document!.operations[0]!.steps.filter(step => sequences.includes(step.sequence))
    const retained = structuredClone(store.document!.operations[0]!.steps)
    const restarted = new BrowserOperationJournal(store)
    await expect(restarted.replayPlan('legacy')).rejects.toThrow(/incomplete.*No full or single-step replay/)
    expect((await restarted.get('legacy'))?.steps).toEqual(retained)
    expect(await restarted.getPersistenceWarning()).toBeUndefined()
  })

  it('keeps failed, unrecorded and stopped steps in their positions as explicit review barriers', async () => {
    const store = new MemoryStore(), journal = new BrowserOperationJournal(store)
    await start(journal, 'review')
    for (const [method, status, replay] of [
      ['pressKey', 'completed', { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] }],
      ['click', 'failed', { method: 'click', url: 'https://example.invalid/', args: ['@old'] }],
      ['snapshot', 'completed', undefined]
    ] as const) {
      const step = await journal.startStep('review', { method, label: method, ...(replay ? { replay: { ...replay, args: [...replay.args] } } : {}) })
      await journal.finishStep('review', step!.sequence, { status })
    }
    await journal.finish('review', 'failed')
    const plan = await journal.replayPlan('review')
    expect(plan?.steps.map(step => step.method)).toEqual(['pressKey', 'click', 'snapshot'])
    expect(plan?.steps[0]?.blockedReason).toBeUndefined()
    expect(plan?.steps[1]?.blockedReason).toContain('failed')
    expect(plan?.steps[2]?.blockedReason).toContain('no safe replay contribution')
    await journal.finish('review', 'stopped')
    expect((await journal.replayPlan('review'))?.steps.map(step => Boolean(step.blockedReason))).toEqual([true, true, true])
  })
})
