import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal'
import type { BrowserOutcomeEvaluation, BrowserOutcomeRegistration } from '../src/shared/browser-outcome-criteria'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const context = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a' }
const declaration: BrowserOutcomeRegistration = { context, criteria: [{ kind: 'field-equals', key: 'result', expected: false,
  producer: { operationId: context.operationId, navigationId: context.navigationId, sequence: 1,
    request: { fields: [{ key: 'result', type: 'boolean', source: { selector: '#result', read: 'checked' } }] } } }] }
const result: BrowserOutcomeEvaluation = { context, status: 'passed', conditions: [
  { criterion: { kind: 'field-equals', key: 'result', expected: false }, status: 'passed', reason: 'The registered field equals the declared value.' }
] }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-outcome-journal-')); roots.push(root)
  const path = join(root, 'journal.json'), journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' }, summary: 'Check field', url: 'https://generic.invalid/form' })
  return { path, journal }
}

describe('completion conditions use the original durable operation owner', () => {
  it('persists registration before the producer and retains the exact result across ordinary store restart', async () => {
    const f = await fixture()
    expect((await f.journal.registerOutcome(context.operationId, declaration))?.saved).toBe(true)
    const before = JSON.parse(await readFile(f.path, 'utf8'))
    expect(before.operations).toHaveLength(1)
    expect(before.operations[0].steps).toEqual([])
    expect(before.operations[0].outcome).toEqual({ registration: declaration })
    await f.journal.startStep(context.operationId, { method: 'extractStructured', label: 'Observe field' })
    await f.journal.finishStep(context.operationId, 1, { status: 'completed' })
    await f.journal.finish(context.operationId, 'completed')
    expect((await f.journal.recordOutcome(context.operationId, result))?.saved).toBe(true)
    const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(f.path))
    expect((await restarted.get(context.operationId))?.outcome).toEqual({ registration: declaration, evaluation: result })
    expect((await restarted.list()).map(op => op.id)).toEqual([context.operationId])
  })

  it('cannot register after a producer or replace the original declaration', async () => {
    const f = await fixture()
    await f.journal.startStep(context.operationId, { method: 'extractStructured', label: 'Observe field' })
    expect(await f.journal.registerOutcome(context.operationId, declaration)).toBeNull()
    const second = await fixture()
    await second.journal.registerOutcome(context.operationId, declaration)
    expect(await second.journal.registerOutcome(context.operationId, { ...declaration, criteria: [{ kind: 'human-checkpoint', checkpointId: 'unrelated' }] })).toBeNull()
    expect((await second.journal.get(context.operationId))?.outcome?.registration).toEqual(declaration)
  })

  it.each(['foreign-context', 'different-condition', 'empty-success', 'unavailable-as-passed', 'raw-observed-value'] as const)
    ('rejects %s without removing the healthy original operation', async kind => {
      const f = await fixture()
      await f.journal.registerOutcome(context.operationId, declaration)
      const bad = structuredClone(result) as BrowserOutcomeEvaluation & { observed?: string }
      if (kind === 'foreign-context') bad.context.operationId = 'operation-other'
      if (kind === 'different-condition') bad.conditions[0]!.criterion = { kind: 'field-equals', key: 'result', expected: true }
      if (kind === 'empty-success') bad.conditions = []
      if (kind === 'unavailable-as-passed') bad.conditions[0]!.status = 'unavailable'
      if (kind === 'raw-observed-value') bad.observed = 'page-secret'
      expect(await f.journal.recordOutcome(context.operationId, bad)).toBeNull()
      expect((await f.journal.get(context.operationId))?.phase).toBe('preparing')
      expect((await f.journal.get(context.operationId))?.outcome).toEqual({ registration: declaration })
    })

  it('keeps unreadable completion history visibly unavailable while preserving the operation on recovery', async () => {
    const f = await fixture()
    await f.journal.finish(context.operationId, 'completed')
    const document = JSON.parse(await readFile(f.path, 'utf8'))
    expect(document.operations).toHaveLength(1)
    document.operations[0].outcome = { registration: { ...declaration, criteria: [] }, evaluation: result }
    await writeFile(f.path, JSON.stringify(document))
    const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(f.path))
    const operation = await restarted.get(context.operationId)
    expect(operation?.id).toBe(context.operationId)
    expect(operation?.phase).toBe('completed')
    expect(operation?.outcome).toBeUndefined()
    expect(operation?.warning).toContain('completion conditions are unreadable')
  })

  it('reports this save attempt separately from an older warning; a healthy subsequent save can recover', async () => {
    const base = new BrowserOperationFileStore(join((await fixture()).path, '..', 'faults.json'))
    let fail = false
    const journal = new BrowserOperationJournal({ load: () => base.load(), save: value => {
      if (fail) return Promise.reject(new Error('disk unavailable'))
      return base.save(value)
    } })
    await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' }, summary: 'Check field', url: 'https://generic.invalid/form' })
    fail = true
    expect((await journal.registerOutcome(context.operationId, declaration))?.saved).toBe(false)
    expect(journal.getPersistenceWarning()).toContain('could not be saved')
    fail = false
    expect((await journal.recordOutcome(context.operationId, result))?.saved).toBe(true)
    const restarted = new BrowserOperationJournal(base)
    expect((await restarted.get(context.operationId))?.outcome?.evaluation).toEqual(result)
  })

  it('retains the current result-save notice in get and list until a subsequent successful check', async () => {
    const base = new BrowserOperationFileStore(join((await fixture()).path, '..', 'result-faults.json'))
    let failResult = false
    const journal = new BrowserOperationJournal({ load: () => base.load(), save: value => {
      if (failResult) return Promise.reject(new Error('disk unavailable'))
      return base.save(value)
    } })
    await journal.start({ id: context.operationId, browserId: context.browserId, operator: { id: 'person', name: 'Person' }, summary: 'Check field', url: 'https://generic.invalid/form' })
    expect((await journal.registerOutcome(context.operationId, declaration))?.saved).toBe(true)
    await journal.finish(context.operationId, 'completed')
    failResult = true
    const failed = await journal.recordOutcome(context.operationId, result)
    expect(failed?.saved).toBe(false)
    expect(failed?.operation.outcome?.evaluation?.warning).toContain('result was checked but could not be saved')
    expect((await journal.get(context.operationId))?.outcome?.evaluation).toEqual(failed?.operation.outcome?.evaluation)
    expect((await journal.list()).map(op => op.outcome?.evaluation)).toEqual([failed?.operation.outcome?.evaluation])
    expect((await journal.get(context.operationId))?.phase).toBe('completed')
    expect((await new BrowserOperationJournal(base).get(context.operationId))?.outcome).toEqual({ registration: declaration })
    failResult = false
    expect((await journal.recordOutcome(context.operationId, result))?.saved).toBe(true)
    expect((await journal.get(context.operationId))?.outcome?.evaluation).toEqual(result)
    expect((await new BrowserOperationJournal(base).get(context.operationId))?.outcome?.evaluation).toEqual(result)
  })
})
