import { describe, expect, it } from 'vitest'
import {
  BrowserOperationFileStore,
  BrowserOperationJournal,
  type BrowserOperationJournalDocument,
  type BrowserOperationJournalStore
} from '../src/main/browser-operation-journal.js'

class MemoryStore implements BrowserOperationJournalStore {
  document: BrowserOperationJournalDocument | null = null
  failLoad = false
  failSave = false

  async load(): Promise<BrowserOperationJournalDocument | null> {
    if (this.failLoad) throw new Error('load failed')
    return this.document ? JSON.parse(JSON.stringify(this.document)) as BrowserOperationJournalDocument : null
  }

  async save(document: BrowserOperationJournalDocument): Promise<void> {
    if (this.failSave) throw new Error('save failed')
    this.document = JSON.parse(JSON.stringify(document)) as BrowserOperationJournalDocument
  }
}

describe('BrowserOperationJournal', () => {
  it('gives one ordered identity to a run and redacts sensitive replay values', async () => {
    const store = new MemoryStore()
    let now = 100
    const journal = new BrowserOperationJournal(store, { now: () => now, id: () => 'op-1' })
    const operation = await journal.start({
      browserId: 'browser-1',
      operator: { id: 'agent-1', name: 'Research agent', providerId: 'codex' },
      summary: 'Open a result',
      url: 'https://example.test/path?secret=do-not-record#fragment'
    })
    expect(operation).toMatchObject({ id: 'op-1', phase: 'preparing', url: 'https://example.test/path' })
    now = 110
    const step = await journal.startStep('op-1', {
      method: 'fillInput',
      label: 'Fill account field',
      target: { role: 'textbox', name: 'Account', ordinal: 1, count: 1 },
      replay: {
        method: 'fillInput',
        url: 'https://example.test/path?tracking=1',
        args: ['private-value'],
        inputKey: 'account'
      }
    })
    expect(step?.sequence).toBe(1)
    now = 120
    await journal.finishStep('op-1', 1, { status: 'completed' })
    now = 130
    await journal.finish('op-1', 'completed', { summary: 'Done' })

    const events = await journal.events('op-1')
    expect(events.map((event) => event.type)).toEqual([
      'operation-started',
      'step-started',
      'step-finished',
      'operation-finished'
    ])
    expect((events[1] as { step: { replay?: { args: unknown[]; blockedReason?: string } } }).step.replay).toEqual({
      method: 'fillInput',
      url: 'https://example.test/path',
      args: [],
      inputKey: 'account',
      blockedReason: 'Requires a fresh value or explicit review before replay.'
    })
    expect(JSON.stringify(await journal.events())).not.toContain('private-value')
    expect((await journal.replayPlan('op-1'))?.steps).toEqual([
      expect.objectContaining({
        method: 'fillInput',
        blockedReason: expect.stringContaining('fresh value')
      })
    ])
  })

  it('recovers unfinished work as indeterminate after a restart', async () => {
    const store = new MemoryStore()
    let now = 1_000
    const first = new BrowserOperationJournal(store, { now: () => now, id: () => 'op-restart' })
    await first.start({
      browserId: 'browser-1',
      operator: { id: 'agent-1', name: 'Agent' },
      summary: 'Navigate',
      url: 'https://example.test'
    })
    await first.startStep('op-restart', { method: 'click', label: 'Submit' })
    now = 2_000
    const restarted = new BrowserOperationJournal(store, { now: () => now })
    await restarted.ready()
    await expect(restarted.get('op-restart')).resolves.toMatchObject({
      phase: 'indeterminate',
      finishedAt: 2_000,
      warning: expect.stringContaining('restarted'),
      steps: [expect.objectContaining({ status: 'stopped', finishedAt: 2_000 })]
    })
    await expect(restarted.events('op-restart')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'operation-recovered', operationId: 'op-restart' })
    ]))
    expect(store.document?.operations[0]?.phase).toBe('indeterminate')
  })

  it('keeps the semantic replay target learned during dispatch', async () => {
    const store = new MemoryStore()
    const journal = new BrowserOperationJournal(store, { id: () => 'op-target' })
    await journal.start({
      browserId: 'browser-1',
      operator: { id: 'agent-1', name: 'Agent' },
      summary: 'Open settings',
      url: 'https://example.test/settings'
    })
    await journal.startStep('op-target', {
      method: 'click',
      label: 'click',
      replay: { method: 'click', url: 'https://example.test/settings', args: [] }
    })
    await journal.finishStep('op-target', 1, {
      status: 'completed',
      target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 },
      replay: {
        method: 'click',
        url: 'https://example.test/settings',
        args: [],
        target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }
      }
    })
    await journal.finish('op-target', 'completed')

    await expect(journal.replayPlan('op-target')).resolves.toMatchObject({
      operationId: 'op-target',
      steps: [{
        method: 'click',
        target: { role: 'button', name: 'Open settings', ordinal: 1, count: 1 }
      }]
    })
  })

  it('bounds operations, steps, and events while retaining the newest facts', async () => {
    const store = new MemoryStore()
    let now = 1
    let nextId = 0
    const journal = new BrowserOperationJournal(store, {
      now: () => now++,
      id: () => `op-${nextId++}`,
      maxOperations: 2,
      maxEvents: 4,
      maxSteps: 2
    })
    for (let index = 0; index < 3; index += 1) {
      const operation = await journal.start({
        browserId: 'browser-1',
        operator: { id: 'agent-1', name: 'Agent' },
        summary: `Operation ${index}`,
        url: 'https://example.test'
      })
      await journal.startStep(operation.id, { method: 'snapshot', label: 'Snapshot' })
      await journal.finishStep(operation.id, 1, { status: 'completed' })
      await journal.finish(operation.id, 'completed')
    }
    const operations = await journal.list()
    expect(operations.map((operation) => operation.id)).toEqual(['op-1', 'op-2'])
    expect(operations.every((operation) => operation.steps.length <= 2)).toBe(true)
    expect((await journal.events()).length).toBeLessThanOrEqual(4)
  })

  it('keeps a live operation usable when persistence is unavailable', async () => {
    const store = new MemoryStore()
    store.failSave = true
    const journal = new BrowserOperationJournal(store, { id: () => 'op-live' })
    await expect(journal.start({
      browserId: 'browser-1',
      operator: { id: 'agent-1', name: 'Agent' },
      summary: 'Still run',
      url: 'https://example.test'
    })).resolves.toMatchObject({ id: 'op-live' })
    expect(journal.getPersistenceWarning()).toContain('could not be saved')
  })

  it('does not let a broken activity projection block a live run', async () => {
    const store = new MemoryStore()
    const journal = new BrowserOperationJournal(store, {
      id: () => 'op-projection',
      onEvent: () => { throw new Error('renderer unavailable') }
    })
    await expect(journal.start({
      browserId: 'browser-1',
      operator: { id: 'agent-1', name: 'Agent' },
      summary: 'Still run',
      url: 'https://example.test'
    })).resolves.toMatchObject({ id: 'op-projection' })
  })

  it('file store survives concurrent saves without producing partial JSON', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/agentmux-browser-operation-journal-${Date.now()}-${Math.random()}.json`
    const store = new BrowserOperationFileStore(path)
    const document: BrowserOperationJournalDocument = { version: 1, operations: [], events: [] }
    await Promise.all(Array.from({ length: 5 }, () => store.save(document)))
    await expect(store.load()).resolves.toEqual(document)
  })
})
