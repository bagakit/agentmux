import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal, type BrowserOperationSequencedEvent,
  type BrowserOperationJournalDocument } from '../../../src/main/browser-operation-journal'
import type { BrowserOutcomeEvaluation, BrowserOutcomeRegistration } from '../../../src/shared/browser-outcome-criteria'

// Source-only regression: real Journal and FileStore; only the store acknowledgement is held.
// No Electron, GUI, Browser input, Store seeding, or replacement Journal implementation.
const context = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const registration: BrowserOutcomeRegistration = { context, criteria: [{ kind: 'field-equals', key: 'result', expected: 0,
  producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: 1,
    request: { fields: [{ key: 'result', type: 'number', source: { selector: '#result', read: 'text' } }] } } }] }
const result = (status: 'passed' | 'not-met', reason: string): BrowserOutcomeEvaluation => ({ context, status,
  conditions: [{ criterion: { kind: 'field-equals', key: 'result', expected: 0 }, status, reason }] })
const first = result('passed', 'The first check matched.'), second = result('not-met', 'The second check did not match.')
const facts: unknown[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
afterAll(async () => {
  if (process.env.AGENTMUX_CHECKED_STREAM_FACTS) {
    await writeFile(process.env.AGENTMUX_CHECKED_STREAM_FACTS, JSON.stringify(facts, null, 2) + '\n')
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amux-checked-stream-ack-'))
  const fileStore = new BrowserOperationFileStore(join(directory, 'journal.json'))
  const saves: BrowserOperationJournalDocument[] = []
  const pending: Promise<unknown>[] = [], disposers: Array<() => void> = []
  const holds: Array<{ entered: boolean; fail: boolean; release: () => void; ack: Promise<void> }> = []
  let nextHold: (typeof holds)[number] | undefined
  const journal = new BrowserOperationJournal({ load: () => fileStore.load(), async save(document) {
    saves.push(structuredClone(document))
    const hold = nextHold; nextHold = undefined
    if (hold) { hold.entered = true; await hold.ack; if (hold.fail) throw new Error('Private optional store failure') }
    await fileStore.save(document)
  } })
  cleanups.push(async () => {
    for (const hold of holds) hold.release()
    await Promise.allSettled(pending)
    for (const dispose of disposers) dispose()
    await rm(directory, { recursive: true, force: true })
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    facts.push({ test: 'fixture-cleanup', pendingChecks: pending.length, directoryRemoved: true })
  })
  await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' },
    summary: 'Check field', url: 'https://generic.invalid/form' })
  expect((await journal.registerOutcome(context.operationId, registration))?.saved).toBe(true)
  await journal.startStep(context.operationId, { method: 'extractStructured', label: 'Observe field' })
  await journal.finishStep(context.operationId, 1, { status: 'completed' })
  await journal.finish(context.operationId, 'completed')
  expect((await journal.events(context.operationId)).map(event => event.type)).toEqual([
    'operation-started', 'step-started', 'step-finished', 'operation-finished'
  ])
  return { journal, saves, pending, disposers, arm(fail = false) {
    let release!: () => void
    const ack = new Promise<void>(resolve => { release = resolve })
    const hold = { entered: false, fail, release, ack }; holds.push(hold); nextHold = hold; return hold
  } }
}

it('does not expose a checked event in a new backlog before its save acknowledgement', async () => {
  const f = await fixture(), hold = f.arm(true), beforeSaves = f.saves.length
  const checking = f.journal.recordOutcome(context.operationId, first); f.pending.push(checking)
  await vi.waitFor(() => expect(hold.entered).toBe(true), { timeout: 1000 })
  const live: BrowserOperationSequencedEvent[] = []
  const subscription = await f.journal.subscribe(context.operationId, 4, event => live.push(event)); f.disposers.push(subscription.dispose)
  facts.push({ test: 'before-ack-backlog', backlog: subscription.backlog, liveBeforeAck: structuredClone(live), savesBeforeAck: f.saves.length - beforeSaves })
  expect(f.saves.length - beforeSaves).toBe(1)
  expect(subscription.backlog, 'A result without the optional save acknowledgement entered backlog').toEqual([])
})

it('delivers a late subscriber exactly one checked event after a failed save with its accurate notice', async () => {
  const f = await fixture(), hold = f.arm(true), beforeSaves = f.saves.length
  const checking = f.journal.recordOutcome(context.operationId, first); f.pending.push(checking)
  await vi.waitFor(() => expect(hold.entered).toBe(true), { timeout: 1000 })
  const live: BrowserOperationSequencedEvent[] = []
  const subscription = await f.journal.subscribe(context.operationId, 4, event => live.push(event)); f.disposers.push(subscription.dispose)
  hold.release(); const reply = await checking
  const all = [...subscription.backlog, ...live]
  facts.push({ test: 'backlog-live-overlap', backlog: subscription.backlog, live, reply, saves: f.saves.length - beforeSaves })
  expect(reply?.saved).toBe(false)
  expect(f.saves.length - beforeSaves).toBe(1)
  expect(all.map(item => [item.sequence, item.event.type]), 'Backlog and live repeated the same checked fact').toEqual([[5, 'operation-checked']])
  const checked = all[0]!.event
  if (checked.type !== 'operation-checked') throw new Error('Expected checked event')
  expect(checked.operation.outcome?.evaluation?.warning).toContain('could not be saved')
})

it('keeps later events of the same operation ordered while another operation stays immediate', async () => {
  const f = await fixture(), own: BrowserOperationSequencedEvent[] = [], other: BrowserOperationSequencedEvent[] = []
  f.disposers.push((await f.journal.subscribe(context.operationId, 4, event => own.push(event))).dispose)
  f.disposers.push((await f.journal.subscribe('operation-b', undefined, event => other.push(event))).dispose)
  const hold = f.arm(), checking = f.journal.recordOutcome(context.operationId, first); f.pending.push(checking)
  await vi.waitFor(() => expect(hold.entered).toBe(true), { timeout: 1000 })
  await f.journal.setPhase(context.operationId, 'human')
  await f.journal.start({ id: 'operation-b', browserId: 'browser-b', operator: { id: 'person', name: 'Person' },
    summary: 'Healthy other operation', url: 'https://generic.invalid/other' })
  const ownBefore = structuredClone(own), otherBefore = structuredClone(other)
  hold.release(); await checking
  facts.push({ test: 'per-operation-order', ownBefore, otherBefore, ownAfter: own, otherAfter: other })
  expect(otherBefore.map(item => [item.sequence, item.event.type])).toEqual([[7, 'operation-started']])
  expect(own.map(item => [item.sequence, item.event.type]), 'A later phase overtook the pending checked sequence').toEqual([
    [5, 'operation-checked'], [6, 'phase-changed']
  ])
  expect(ownBefore, 'Same-operation events overtook the pending acknowledgement').toEqual([])
})

it('keeps each overlapping check snapshot and failed-save notice with its own original sequence', async () => {
  const f = await fixture(), live: BrowserOperationSequencedEvent[] = []
  f.disposers.push((await f.journal.subscribe(context.operationId, 4, event => live.push(event))).dispose)
  const holdA = f.arm(true), checkA = f.journal.recordOutcome(context.operationId, first); f.pending.push(checkA)
  await vi.waitFor(() => expect(holdA.entered).toBe(true), { timeout: 1000 })
  const holdB = f.arm(), checkB = f.journal.recordOutcome(context.operationId, second); f.pending.push(checkB)
  await vi.waitFor(() => expect(holdB.entered).toBe(true), { timeout: 1000 })
  holdB.release(); await checkB
  const beforeA = structuredClone(live)
  holdA.release(); await checkA
  const values = live.map(item => {
    if (item.event.type !== 'operation-checked') throw new Error('Expected checked event')
    const evaluation = item.event.operation.outcome?.evaluation
    return { sequence: item.sequence, status: evaluation?.status, reason: evaluation?.conditions[0]?.reason,
      hasNotice: evaluation?.warning?.includes('could not be saved') ?? false }
  })
  facts.push({ test: 'overlapping-check-snapshot', beforeA, live, values, current: await f.journal.get(context.operationId) })
  expect(values, 'Older checked sequence was replaced with the newer evaluation or delivered out of order').toEqual([
    { sequence: 5, status: 'passed', reason: first.conditions[0]!.reason, hasNotice: true },
    { sequence: 6, status: 'not-met', reason: second.conditions[0]!.reason, hasNotice: false }
  ])
  expect(beforeA, 'Second result overtook the first acknowledgement').toEqual([])
  expect((await f.journal.get(context.operationId))?.outcome?.evaluation).toEqual(second)
})
