import { describe, expect, it } from 'vitest'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, type BrowserTaskAssetHost } from '../src/main/browser-task-assets'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../src/main/browser-operation-journal'
import { runBrowserScript } from '../src/main/browser-script-runner'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskAssetState } from '../src/shared/browser-task-assets'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = 'https://page.test/'
const click = (id: string) => ({ id, kind: 'click' as const, url, reviewed: true, target: { role: 'button', name: id, ordinal: 1, count: 1 } })
function asset(branch = true, answer = true): BrowserTaskAsset {
  const steps = branch ? [{ id: 'choose', kind: 'branch' as const, url, reviewed: true,
    branch: { condition: { kind: 'page-url-is' as const, url: answer ? url : 'https://other.test/' }, onTrue: 'produce', onFalse: 'other' } },
    { ...click('produce'), nextStepId: null }, click('other')] : [click('before'), click('produce')]
  const content = { name: 'Original selected path', url, parameters: [], steps,
    completion: { criteria: [{ kind: 'download-readable' as const, stepId: 'produce', path: 'artifact.txt' }] } }
  return { id: 'asset', browserId: 'browser', sourceRecordingId: 'recording', revision: 1, createdAt: 1, updatedAt: 1,
    draft: content, versions: [{ ...content, version: 1, savedAt: 1 }] }
}
async function fixture(a = asset(), options: { failFirstObservation?: boolean; failAction?: boolean; wrongProducer?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-reliability-branch-test-'))
  const assetStore = new BrowserTaskAssetFileStore(join(directory, 'assets.json'))
  await assetStore.save({ version: 1, assets: [a], runs: [], selectedRuns: [] })
  const tasks = new BrowserTaskAssets(assetStore, { id: () => 'run' })
  const journalStore = new BrowserOperationFileStore(join(directory, 'journal.json'))
  let serial = 0
  const journal = new BrowserOperationJournal(journalStore, { id: () => `operation-${++serial}` })
  let control: 'human' | 'agent' = 'agent', observationFailed = false
  const calls: { stepId: string; operationId: string; method: string }[] = []
  const host: BrowserTaskAssetHost = {
    onRunPrepared: () => {}, control: () => control, navigationId: () => 'navigation', yieldControl: () => { control = 'human' },
    runScript: async (browserId, code, execution) => {
      const operation = await journal.start({ browserId, operator: { id: 'person', name: 'Person' }, summary: execution.stepId, url })
      expect(await tasks.bindOperation(execution, operation.id)).toBe(true)
      const isProducer = execution.stepId === 'produce' || options.wrongProducer && execution.stepId === 'other'
      const context = { workspaceId: 'workspace', browserId, operationId: operation.id, navigationId: 'navigation' }
      const assetRun = { assetId: execution.assetId, runId: execution.runId, version: execution.version }
      if (isProducer) expect((await journal.registerOutcome(operation.id, { context, assetRun,
        criteria: [{ kind: 'download-readable', path: 'artifact.txt', producer: { operationId: operation.id, navigationId: 'navigation' } }] }))?.saved).toBe(true)
      const result = await runBrowserScript({ code, timeoutMs: 3000, onPageCall: async method => {
        calls.push({ stepId: execution.stepId, operationId: operation.id, method })
        const step = (await journal.startStep(operation.id, { method, label: method }))!
        try {
          if (execution.stepId === 'choose' && options.failFirstObservation && !observationFailed) { observationFailed = true; throw new Error('Read-only page identity unavailable') }
          if (options.failAction && (method === 'download' || method === 'click')) throw new Error('Actual page action failed')
          let value: unknown
          if (method === 'pageInfo') value = { browserId, navigationId: 'navigation', url }
          else if (method === 'snapshot') value = { nodes: ['before', 'produce', 'other'].map(id => ({ ref: id, role: 'button', name: id })), missingFrames: [],
            observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] } }
          else if (method === 'click' || method === 'download') value = { dispatched: true }
          else throw new Error(`Unexpected original SDK method: ${method}`)
          await journal.finishStep(operation.id, step.sequence, { status: 'completed' }); return value
        } catch (error) { await journal.finishStep(operation.id, step.sequence, { status: 'failed' }); throw error }
      } })
      const finished = (await journal.finish(operation.id, result.completed ? 'completed' : 'failed'))!
      if (isProducer && result.completed) expect((await journal.recordOutcome(operation.id, { context, assetRun, status: 'passed',
        conditions: [{ criterion: { kind: 'download-readable', path: 'artifact.txt' }, status: 'passed', reason: 'Source fixture retained outcome' }] }))?.saved).toBe(true)
      return { logs: result.logs, result: result.completed ? result.value : undefined,
        outcome: result.completed ? { kind: 'completed' as const } : { kind: 'script-failed' as const, message: result.failure.kind },
        runOperation: (await journal.get(finished.id))! }
    }
  }
  const start = async (runId?: string) => {
    const run = await tasks.run({ browserId: 'browser', assetId: 'asset', version: 1, parameters: {}, ...(runId ? { runId } : {}) }, host)
    console.log('ACTUAL_RELIABILITY_RUN', JSON.stringify({ status: run.status, nextStep: run.nextStep, operationIds: run.operationIds,
      stepExecutions: run.stepExecutions, branchDecisions: run.branchDecisions }))
    return run
  }
  const read = async (alterState?: (state: BrowserTaskAssetState) => void, alterOperation?: (operation: BrowserOperation) => void) => {
    const owner = {
      getTaskAssets: async (browserId: string) => { const state = await tasks.state(browserId); alterState?.(state); return state },
      getOperation: async (id: string) => { const operation = await journal.get(id); if (operation) alterOperation?.(operation); return operation },
      runControlledTaskBatch: async () => { throw new Error('Read-only test must never run a batch') },
      stopTaskBatch: async () => { throw new Error('Read-only test must never stop a batch') },
      runControlledTaskAsset: async () => { throw new Error('Read-only test must never run another task') },
      stopTaskAsset: async () => { throw new Error('Read-only test must never stop a task') }
    }
    const result = await executeBrowserTaskControl({ operation: 'browser.task.reliability', browserId: 'browser', assetId: 'asset', version: 1 }, owner, false)
    if (!('reliability' in result)) throw new Error('The actual public result parser did not return reliability')
    console.log('ACTUAL_PUBLIC_RELIABILITY_RESULT', JSON.stringify(result.reliability))
    return result.reliability
  }
  return { tasks, journal, calls, start, read, returnControl: () => { control = 'agent' },
    restored: async () => new BrowserTaskAssets(assetStore).state('browser'), dispose: () => rm(directory, { recursive: true }) }
}

describe('original runner, journal and public reliability selected path', () => {
  it('passes the real selected branch path without requiring its unselected arm and survives durable owner reload', async () => {
    const f = await fixture()
    try {
      const run = await f.start()
      expect(run.status).toBe('completed'); expect(run.nextStep).toBe(3)
      expect(run.stepExecutions?.map(item => item.stepId)).toEqual(['choose', 'produce'])
      expect(f.calls.map(item => item.method)).toEqual(['pageInfo', 'pageInfo', 'pageInfo', 'snapshot', 'download'])
      expect((await f.read()).counts).toEqual({ passed: 1, 'not-met': 0, unavailable: 0, unknown: 0, failed: 0, stopped: 0, interrupted: 0 })
      expect((await f.restored()).runs[0]?.stepExecutions).toEqual(run.stepExecutions)
    } finally { await f.dispose() }
  })
  it('retains the original failed read-only observation, then counts only the later known decision and completed action', async () => {
    const f = await fixture(asset(), { failFirstObservation: true })
    try {
      const first = await f.start()
      expect(first.status).toBe('ready'); expect(first.branchDecisions?.[0]?.result).toBe('unknown')
      const pending = await f.read(); expect(pending.population.pendingRuns).toBe(1); expect(pending.samples).toEqual([])
      f.returnControl()
      const completed = await f.start(first.id)
      expect(completed.stepExecutions?.map(item => item.stepId)).toEqual(['choose', 'choose', 'produce'])
      expect((await f.journal.get(first.operationIds[0]!))?.phase).toBe('failed')
      expect(completed.branchDecisions?.[0]?.operationId).toBe(completed.operationIds[1])
      expect((await f.read()).counts.passed).toBe(1)
      const unsafe = await f.read(undefined, operation => { if (operation.id === first.operationIds[0]) operation.steps[0]!.method = 'click' })
      expect(unsafe.counts.unavailable).toBe(1); expect(unsafe.counts.passed).toBe(0)
    } finally { await f.dispose() }
  })
  it('joins the latest original branch operation, known navigation and exact forward destination instead of accepting arbitrary completed operations', async () => {
    const f = await fixture(asset(), { failFirstObservation: true })
    try {
      const first = await f.start(); f.returnControl(); await f.start(first.id)
      const corruptions: ((run: BrowserTaskAssetRun) => void)[] = [
        run => { run.branchDecisions![0]!.operationId = run.operationIds[0]! },
        run => { run.branchDecisions![0]!.navigationId = '' },
        run => { run.branchDecisions![0]!.result = 'unknown'; delete run.branchDecisions![0]!.nextStepId },
        run => { run.branchDecisions![0]!.nextStepId = 'other' },
        run => { run.stepExecutions![2]!.stepId = 'other' },
        run => { run.stepExecutions!.reverse() },
        run => { run.branchDecisions!.push({ ...run.branchDecisions![0]! }) },
        run => { delete run.stepExecutions }
      ]
      expect(corruptions.length).toBe(8)
      for (const corrupt of corruptions) {
        const result = await f.read(state => corrupt(state.runs[0]!)); expect(result.counts.unavailable).toBe(1); expect(result.passRate).toBe(0)
      }
    } finally { await f.dispose() }
  })
  it('keeps a declared but skipped producer unavailable even if another actual operation registers an apparently passed outcome', async () => {
    const f = await fixture(asset(true, false), { wrongProducer: true })
    try {
      const run = await f.start()
      expect(run.stepExecutions?.map(item => item.stepId)).toEqual(['choose', 'other'])
      const result = await f.read()
      expect(result.counts.unavailable).toBe(1); expect(result.counts.passed).toBe(0)
      expect(result.samples[0]?.reason).toBe('The declared outcome producing step was not executed on this path.')
    } finally { await f.dispose() }
  })
  it('preserves the original fully joined linear capability and requires mappings for explicit forward edges', async () => {
    const linear = await fixture(asset(false))
    try {
      const run = await linear.start(); expect(run.stepExecutions?.map(item => item.stepId)).toEqual(['before', 'produce'])
      expect((await linear.read(state => { delete state.runs[0]!.stepExecutions })).counts.passed).toBe(1)
    } finally { await linear.dispose() }
    const a = asset(false); a.versions[0]!.steps[0]!.nextStepId = 'produce'; a.draft.steps[0]!.nextStepId = 'produce'
    const explicit = await fixture(a)
    try {
      expect((await explicit.start()).status).toBe('completed')
      expect((await explicit.read()).counts.passed).toBe(1)
      expect((await explicit.read(state => { delete state.runs[0]!.stepExecutions })).counts.unavailable).toBe(1)
    } finally { await explicit.dispose() }
  })
  it('never ignores a failed real action or a missing bound journal when counting a completed path', async () => {
    const f = await fixture(asset(), { failAction: true })
    try {
      const run = await f.start(); expect(run.status).toBe('failed')
      expect((await f.read()).counts.failed).toBe(1)
      const failed = (await f.journal.get(run.operationIds.at(-1)!))!, registration = failed.outcome!.registration
      // Even a retained passing assessment cannot hide the original failed action.
      expect((await f.journal.recordOutcome(failed.id, { context: registration.context, assetRun: registration.assetRun!,
        status: 'passed', conditions: [{ criterion: { kind: 'download-readable', path: 'artifact.txt' }, status: 'passed', reason: 'Earlier passing assessment' }] }))?.saved).toBe(true)
      const corrupt = await f.read(state => { state.runs[0]!.status = 'completed'; state.runs[0]!.nextStep = 3 })
      expect(corrupt.counts.unavailable).toBe(1); expect(corrupt.counts.passed).toBe(0)
    } finally { await f.dispose() }
    const completed = await fixture()
    try {
      await completed.start()
      expect((await completed.read(undefined, operation => { if (operation.id === 'operation-2') operation.steps = [] })).counts.unavailable).toBe(1)
    } finally { await completed.dispose() }
  })
})
