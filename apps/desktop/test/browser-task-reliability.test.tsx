// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssets } from '../src/main/browser-task-assets'
import { getBrowserTaskReliability } from '../src/shared/browser-task-reliability'
import type { BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskAssetState } from '../src/shared/browser-task-assets'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { BrowserTaskReliability, useBrowserTaskReliabilityRefresh } from '../src/renderer/src/components/BrowserTaskReliability'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import { BrowserOperationStatus } from '../src/renderer/src/components/BrowserOperationSurface'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const asset = (): BrowserTaskAsset => ({ id: 'asset', browserId: 'browser', revision: 1, sourceRecordingId: 'recording', createdAt: 1, updatedAt: 1,
  draft: { name: 'Edited draft', url: 'https://example.test', parameters: [], steps: [] },
  versions: [1, 2].map(version => ({ version, savedAt: 1, name: `Immutable v${version}`, url: 'https://example.test', parameters: [],
    steps: [{ id: 'produce', kind: 'click' as const, url: 'https://example.test', reviewed: true,
      target: { role: 'button', name: 'Create artifact', ordinal: 1, count: 1 } }],
    completion: { criteria: [{ kind: 'download-readable' as const, stepId: 'produce', path: 'artifact.txt' }] } })) })
const run = (id = 'run', extra: Partial<BrowserTaskAssetRun> = {}): BrowserTaskAssetRun => ({ id, browserId: 'browser', assetId: 'asset', version: 1,
  status: 'completed', nextStep: 1, operationIds: [`operation-${id}`], humanCheckpoints: [], startedAt: 10, updatedAt: 20, ...extra })
const operation = (owner = run(), status: 'passed' | 'not-met' | 'unavailable' = 'passed'): BrowserOperation => {
  const id = `operation-${owner.id}`, context = { workspaceId: 'workspace', browserId: 'browser', operationId: id, navigationId: 'navigation' }
  const assetRun = { assetId: owner.assetId, runId: owner.id, version: owner.version }
  return { id, browserId: 'browser', phase: 'completed', operator: { id: 'person', name: 'Person' }, summary: 'Actual click', url: 'https://example.test',
    startedAt: 10, finishedAt: 20, steps: [{ sequence: 1, method: 'click', label: 'Create artifact', status: 'completed', startedAt: 10, finishedAt: 20 }],
    outcome: { registration: { context, assetRun, criteria: [{ kind: 'download-readable', path: 'artifact.txt', producer: { operationId: id, navigationId: 'navigation' } }] },
      evaluation: { context, assetRun, status, conditions: [{ criterion: { kind: 'download-readable', path: 'artifact.txt' }, status, reason: 'Retained original receipt' }] } } }
}
function read(runs: BrowserTaskAssetRun[] = [run()], operations: BrowserOperation[] = [operation()], override: Partial<BrowserTaskAssetState> = {}, version = 1) {
  return getBrowserTaskReliability({ browserId: 'browser', assetId: 'asset', version, state: { assets: [asset()], runs, selectedRunId: runs[0]?.id ?? null, ...override }, operations })
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); await act(async () => { root.render(element) })
  return { container, root, dispose: async () => { await act(async () => root.unmount()); container.remove() } }
}

describe('immutable-version reliability from retained owner facts', () => {
  it('joins the complete original outcome and deduplicates repeated run and operation ACKs', () => {
    const r = run(), o = operation(r)
    const result = read([r, structuredClone(r)], [o, structuredClone(o)])
    expect(result.population).toEqual({ retainedRuns: 1, terminalRuns: 1, pendingRuns: 0, firstStartedAt: 10, lastUpdatedAt: 20 })
    expect(result.counts.passed).toBe(1); expect(result.passRate).toBe(1)
    expect(result.samples).toEqual([{ runId: 'run', result: 'passed', reason: 'All original conditions from the bound retained outcome.' }])
  })
  it('separates versions and gives zero samples no rate even when another version passed', () => {
    const result = read([run()], [operation()], {}, 2)
    expect(result.population.retainedRuns).toBe(0); expect(result.samples).toEqual([])
    expect(result.passRate).toBeNull(); expect(result.counts.passed).toBe(0)
    expect(result.selectedRunId).toBeNull()
  })
  it('uses one explicit retained terminal population and keeps pending, failures and evidence gaps distinct', () => {
    const runs = ['pass', 'not-met', 'unavailable', 'failed', 'stopped', 'interrupted', 'pending'].map(id => run(id,
      { status: id === 'pending' ? 'waiting-human' : ['failed', 'stopped', 'interrupted'].includes(id) ? id as BrowserTaskAssetRun['status'] : 'completed' }))
    const result = read(runs, [operation(runs[0]!), operation(runs[1]!, 'not-met'), operation(runs[2]!, 'unavailable')])
    expect(result.population).toEqual({ retainedRuns: 7, terminalRuns: 6, pendingRuns: 1, firstStartedAt: 10, lastUpdatedAt: 20 })
    expect(result.counts).toEqual({ passed: 1, 'not-met': 1, unavailable: 1, unknown: 0, failed: 1, stopped: 1, interrupted: 1 })
    expect(result.passRate).toBe(1 / 6)
  })
  it('does not equate script completion without a declared outcome to business success', () => {
    const a = asset(); delete a.versions[0]!.completion
    const result = read([run()], [operation()], { assets: [a] })
    expect(result.scriptCompleted).toBe(1); expect(result.counts.unknown).toBe(1); expect(result.counts.passed).toBe(0)
  })
  it('refuses empty, partial, wrong-version, wrong-context and inconsistent original outcome evidence', () => {
    const corruptions = [
      (o: BrowserOperation) => { o.outcome!.evaluation!.conditions = [] },
      (o: BrowserOperation) => { o.outcome!.registration.criteria = [] },
      (o: BrowserOperation) => { o.outcome!.evaluation!.assetRun!.version = 2 },
      (o: BrowserOperation) => { o.outcome!.registration.assetRun!.runId = 'another-run' },
      (o: BrowserOperation) => { o.outcome!.evaluation!.context.operationId = 'another-operation' },
      (o: BrowserOperation) => { o.outcome!.registration.criteria[0] = { kind: 'download-readable', path: 'other.txt', producer: { operationId: o.id, navigationId: 'navigation' } } },
      (o: BrowserOperation) => { o.outcome!.evaluation!.conditions[0]!.status = 'not-met' },
      (o: BrowserOperation) => { o.steps = [] },
      (o: BrowserOperation) => { o.steps[0]!.status = 'failed' }
    ]
    expect(corruptions.length).toBeGreaterThan(0)
    for (const corrupt of corruptions) { const o = operation(); corrupt(o); expect(read([run()], [o]).counts.unavailable).toBe(1) }
    expect(read([run()], []).counts.unavailable).toBe(1)
  })
  it('requires every original criterion, not a passing subset', () => {
    const a = asset(); a.versions[0]!.steps.push({ id: 'confirm', kind: 'checkpoint', url: a.draft.url, reviewed: true })
    a.versions[0]!.completion!.criteria.push({ kind: 'human-checkpoint', checkpointId: 'confirm' })
    expect(read([run('run', { nextStep: 2 })], [operation()], { assets: [a] }).counts.unavailable).toBe(1)
  })
  it('does not turn an early passing evaluation into success when later execution failed or is missing', () => {
    const r = run('run', { status: 'failed' })
    expect(read([r], [operation(r)]).counts).toMatchObject({ failed: 1, passed: 0 })
    const a = asset(); a.versions[0]!.steps.push({ ...a.versions[0]!.steps[0]!, id: 'later' })
    expect(read([run('run', { nextStep: 2 })], [operation()], { assets: [a] }).counts.unavailable).toBe(1)
  })
  it('requires the original declared producing step and navigation, not another completed operation in the same run', () => {
    const a = asset(); a.versions[0]!.steps.unshift({ ...a.versions[0]!.steps[0]!, id: 'first' })
    const r = run('run', { nextStep: 2, operationIds: ['operation-run', 'actual-producer'] })
    const first = operation(r), producer = { ...operation(r), id: 'actual-producer' }; delete producer.outcome
    expect(read([r], [first, producer], { assets: [a] }).counts.unavailable).toBe(1)
    const wrongNav = operation(); wrongNav.outcome!.registration.criteria[0] = { kind: 'download-readable', path: 'artifact.txt', producer: { operationId: wrongNav.id, navigationId: 'foreign-navigation' } }
    expect(read([run()], [wrongNav]).counts.unavailable).toBe(1)
  })
  it('keeps conflicting duplicate facts and read warnings unavailable rather than choosing the green ACK', () => {
    const r = run(), conflicting = operation(); conflicting.outcome!.evaluation!.status = 'not-met'
    expect(read([r], [operation(), conflicting]).counts.unavailable).toBe(1)
    expect(read([r, { ...r, nextStep: 0 }], [operation()]).counts.unavailable).toBe(1)
    expect(read([r], [operation()], { warning: 'Actual source read failed' }).counts.unavailable).toBe(1)
    expect(read([r], [operation()], { assets: [] }).counts.unavailable).toBe(1)
  })
  it('counts only bound, trusted original human facts once, never a waiting cursor alone', () => {
    const a = asset(); a.versions[0]!.steps.push({ id: 'confirm', kind: 'checkpoint', url: a.draft.url, reviewed: true })
    const fact = { browserId: 'browser', runId: 'run', assetId: 'asset', version: 1, checkpointId: 'confirm', origin: 'trusted-ui' as const,
      controlBefore: 'human' as const, confirmedAt: 15, pendingCursor: 2 }
    const r = run('run', { status: 'waiting-human', nextStep: 2, humanCheckpoints: [fact, fact, { ...fact, runId: 'wrong' }] })
    expect(read([r], [], { assets: [a] }).humanInterventions).toBe(1)
    expect(read([{ ...r, humanCheckpoints: [] }], [], { assets: [a] }).humanInterventions).toBe(0)
  })
  it('reads selected-old-run directly from the actual durable Main state, including a second owner', async () => {
    const older = run('older', { status: 'ready', startedAt: 10 }), newer = run('newer', { startedAt: 30 })
    const document: BrowserTaskAssetDocument = { version: 1, assets: [asset()], runs: [older, newer], selectedRuns: [{ browserId: 'browser', runId: 'older' }] }
    const store = { load: async () => structuredClone(document), save: async () => {} }
    const first = await new BrowserTaskAssets(store).state('browser'), restored = await new BrowserTaskAssets(store).state('browser')
    expect(first.selectedRunId).toBe('older'); expect(restored.selectedRunId).toBe('older')
    expect(getBrowserTaskReliability({ browserId: 'browser', assetId: 'asset', version: 1, state: restored, operations: [operation(newer)] })).toMatchObject({ selectedRunId: 'older', selectedRunStatus: 'ready' })
  })
  it('ignores unrelated Browser/version operations and never mutates the original source facts', () => {
    const r = run(), o = operation(), before = JSON.stringify([r, o])
    const unrelated = operation(run('unrelated', { version: 2 })); unrelated.browserId = 'other-browser'
    expect(read([r], [o, unrelated]).counts.passed).toBe(1)
    expect(JSON.stringify([r, o])).toBe(before)
  })
})

describe('actual version UI and async public-read ownership', () => {
  it('keeps the real results surface readable when finite source timestamps exceed the Date range', async () => {
    const result = read([run('run', { startedAt: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER })])
    let failure: unknown, mounted: Awaited<ReturnType<typeof mount>> | undefined
    try { mounted = await mount(createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 1, refreshKey: 'one', load: async () => result })) }
    catch (error) { failure = error }
    expect(failure).toBeUndefined()
    expect(mounted!.container.textContent).toContain('1/1 outcomes passed')
    expect(mounted!.container.textContent).toContain('Sample window: unavailable – unavailable')
    await mounted!.dispose()
  })
  it('refreshes the exact older version public read after Verify even when current activity belongs to another operation', async () => {
    const older = run('older'), notMet = operation(older, 'not-met'), passed = operation(older)
    let currentOperation = notMet, verify!: (result: NonNullable<BrowserOperation['outcome']>['evaluation']) => void
    const load = vi.fn(async (_input: { browserId: string; assetId: string; version: number }) => read([older], [currentOperation], { selectedRunId: 'older' }))
    function OriginalVersionRead() {
      const refresh = useBrowserTaskReliabilityRefresh('browser')
      verify = result => { if (result) refresh.markVerified(result) }
      return createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 1,
        refreshKey: String(refresh.revisionFor('asset', 1)), load })
    }
    const mounted = await mount(createElement(OriginalVersionRead))
    expect(mounted.container.textContent).toContain('0/1 outcomes passed'); expect(load).toHaveBeenCalledTimes(1)
    currentOperation = passed
    await act(async () => { verify({ ...passed.outcome!.evaluation!, assetRun: { assetId: 'asset', runId: 'unrelated', version: 2 } }) })
    expect(load).toHaveBeenCalledTimes(1)
    const actualVerify = deferred<NonNullable<NonNullable<BrowserOperation['outcome']>['evaluation']>>()
    const verifying = actualVerify.promise.then(verify)
    await act(async () => { actualVerify.resolve(passed.outcome!.evaluation!); await verifying })
    expect(load).toHaveBeenCalledTimes(2); expect(load.mock.calls[1]![0]).toEqual({ browserId: 'browser', assetId: 'asset', version: 1 })
    expect(mounted.container.textContent).toContain('1/1 outcomes passed'); expect(mounted.container.textContent).toContain('Owner-selected run: older')
    await mounted.dispose()
  })
  it('loads the editor-selected immutable version and rejects a late earlier version result', async () => {
    const one = deferred<ReturnType<typeof read>>(), two = deferred<ReturnType<typeof read>>()
    const load = vi.fn(input => input.version === 1 ? one.promise : two.promise)
    const mounted = await mount(createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 1, refreshKey: 'one', load }))
    await act(async () => { mounted.root.render(createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 2, refreshKey: 'two', load })) })
    await act(async () => { two.resolve(read([], [], {}, 2)) })
    expect(mounted.container.textContent).toContain('No terminal samples')
    await act(async () => { one.resolve(read()) })
    expect(mounted.container.textContent).toContain('No terminal samples'); expect(mounted.container.textContent).not.toContain('100%')
    expect(load.mock.calls.map(([input]) => input.version)).toEqual([1, 2])
    await mounted.dispose()
  })
  it('renders exact unknown/empty outcomes and keeps read failure visible without erasing the work surface', async () => {
    const load = vi.fn(async () => { throw new Error('Actual read unavailable') })
    const mounted = await mount(createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 1, refreshKey: 'one', load }))
    expect(mounted.container.textContent).toContain('Original Browser work remains')
    expect(mounted.container.querySelector('[data-reliability-version="1"]')).not.toBeNull()
    await mounted.dispose()
  })
  it('rejects an apparently green result belonging to another requested version', async () => {
    const mounted = await mount(createElement(BrowserTaskReliability, { browserId: 'browser', assetId: 'asset', version: 2, refreshKey: 'one', load: async () => read() }))
    expect(mounted.container.textContent).toContain('exact version read is unavailable'); expect(mounted.container.textContent).not.toContain('100%')
    await mounted.dispose()
  })
  it('mounts reliability through the original editor version selection and preserves its original draft', async () => {
    const a = asset(), save = vi.fn()
    const mounted = await mount(createElement(BrowserTaskAssetEditor, { asset: a, recording: null, onImport: () => {}, onSaveDraft: save,
      onSaveVersion: save, onLocateStep: () => {}, onRun: async () => {}, onStop: () => {}, renderReliability: version => createElement('span', { 'data-real-version': version }, `Read v${version}`) }))
    expect(mounted.container.querySelector('[data-real-version="2"]')).not.toBeNull()
    const select = mounted.container.querySelector<HTMLSelectElement>('select[aria-label="Task asset version"]')!
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(mounted.container.querySelector('[data-real-version="1"]')).not.toBeNull(); expect(save).not.toHaveBeenCalled()
    await mounted.dispose()
  })
  it('projects the older Main-selected ready run rather than a newer terminal run in the real operation control', async () => {
    const a = asset(), older = run('older', { status: 'ready', startedAt: 5 }), newer = run('newer', { startedAt: 30 })
    const mounted = await mount(createElement(BrowserOperationStatus, { browserId: 'browser', activity: { operation: null, control: 'human' },
      taskAssets: { assets: [a], runs: [older, newer], selectedRunId: 'older' } }))
    expect(mounted.container.querySelector('[data-task-run-id="older"]')).not.toBeNull()
    await mounted.dispose()
  })
})
