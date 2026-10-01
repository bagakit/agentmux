import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, runBrowserTaskAsset, type BrowserTaskAssetStore, type BrowserTaskAssetHost } from '../src/main/browser-task-assets'
import { runBrowserTaskBatch, validateBrowserTaskBatchValues } from '../src/main/browser-task-batch'
import type { BrowserTaskBatchHost, BrowserTaskRunBudget } from '../src/main/browser-task-batch'
import type { BrowserTaskAssetDocument, BrowserTaskAssetRunInput, BrowserTaskContent, BrowserTaskBatchInput, BrowserTaskStepExecution } from '../src/shared/browser-task-assets'

class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value) }
}
const browserId = 'batch-original-browser', url = 'https://fixture.invalid/form'
async function fixture(options: { checkpoint?: boolean; branch?: boolean; steps?: number } = {}) {
  const store = new MemoryStore(); let id = 0, time = 1, operation = 0, control: 'agent' | 'human' = 'agent'
  const assets = new BrowserTaskAssets(store, { id: () => `actual-task-${++id}`, now: () => time++ })
  const imported = await assets.importRecording({ id: 'original-recording', browserId, navigationId: 'actual-nav', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const content: BrowserTaskContent = { ...imported.draft, name: 'Bounded original items', parameters: [{ key: 'value', label: 'Item value', secret: false }], steps: [
    ...(options.checkpoint ? [{ id: 'person', kind: 'checkpoint' as const, url, reviewed: true }] : []),
    ...(options.branch ? [{ id: 'condition', kind: 'branch' as const, url, reviewed: true, branch: { condition: { kind: 'page-url-is' as const, url }, onTrue: 'fill-0', onFalse: null } }] : []),
    ...Array.from({ length: options.steps ?? 1 }, (_, index) => ({ id: `fill-${index}`, kind: 'fill' as const, url, reviewed: true, parameterKey: 'value', target: { role: 'text input', name: 'Item value', ordinal: 1, count: 1 } }))
  ] }
  const draft = await assets.edit(imported.id, imported.revision, content), asset = await assets.saveVersion(draft.id, draft.revision)
  const writes: unknown[][] = [], executions: BrowserTaskStepExecution[] = []; let boundAssets = assets
  let observerKnown = true, throwAfterDispatch = false
  const host: BrowserTaskAssetHost = { onRunPrepared: vi.fn(), control: () => control, yieldControl: () => { control = 'human' }, navigationId: () => 'actual-nav',
    runScript: vi.fn(async (id, code, execution) => {
      executions.push({ ...execution }); const operationId = `original-op-${++operation}`
      expect(await boundAssets.bindOperation(execution, operationId)).toBe(true)
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', code)(
        async () => ({ url, navigationId: observerKnown ? 'actual-nav' : undefined }),
        async () => ({ observation: { scope: { kind: 'page', document: null }, fullObserved: 1, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [{ ref: '@e1', role: 'text input', name: 'Item value' }] }),
        async (...args: unknown[]) => { writes.push(args); if (throwAfterDispatch) throw Error('Result unknown after dispatch') })
      return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: operationId, browserId: id } } as never
    }) }
  const input: BrowserTaskBatchInput = { browserId, assetId: asset.id, version: 1, parameters: {}, items: [{ id: 'first', parameters: { value: 'value-one' } }, { id: 'second', parameters: { value: 'value-two' } }] }
  const runTask = vi.fn((item: BrowserTaskAssetRunInput, budget: BrowserTaskRunBudget) => runBrowserTaskAsset(assets, item, host, budget))
  const batchHost = { runTask }
  return { assets, asset, store, input, host, batchHost, writes, executions, runTask, bindTo: (owner: BrowserTaskAssets) => { boundAssets = owner }, known: (value: boolean) => { observerKnown = value }, returnControl: () => { control = 'agent' }, uncertain: () => { throwAfterDispatch = true } }
}

describe('bounded batches consume original item runs and their original durable authority', () => {
  it('runs each explicit item exactly once and stores only original item IDs/run facts', async () => {
    const f = await fixture(), result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
    expect(result).toMatchObject({ status: 'completed', nextItem: 2, operationCount: 2, items: [{ id: 'first' }, { id: 'second' }] })
    expect(f.writes).toEqual([['@e1', 'value-one'], ['@e1', 'value-two']]); expect(f.runTask).toHaveBeenCalledTimes(2)
    const state = await f.assets.state(browserId); expect(state.runs.map(run => run.id)).toEqual(result.items.map(item => item.runId))
    expect(state.runs.map(run => run.stepExecutions)).toEqual([[{ stepId: 'fill-0', operationId: 'original-op-1' }], [{ stepId: 'fill-0', operationId: 'original-op-2' }]])
    expect(JSON.stringify(f.store.document)).not.toContain('value-one'); expect(JSON.stringify(result)).not.toContain('value-two')
  })
  it('unknown condition retains the original item cursor and stops before the next item', async () => {
    const f = await fixture({ branch: true }); f.known(false)
    const result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
    expect(result).toMatchObject({ status: 'ready', nextItem: 0, items: [{ id: 'first', runId: expect.any(String) }, { id: 'second' }] })
    expect(f.runTask).toHaveBeenCalledOnce(); expect(f.writes).toEqual([])
    f.returnControl(); f.known(true)
    const done = await runBrowserTaskBatch(f.assets, { ...f.input, batchId: result.id }, f.batchHost)
    expect(done.status).toBe('completed'); expect(done.items[0]?.runId).toBe(result.items[0]?.runId)
    expect(f.writes).toEqual([['@e1', 'value-one'], ['@e1', 'value-two']])
  })
  it('does not count or auto-approve a human checkpoint as a completed item', async () => {
    const f = await fixture({ checkpoint: true }), result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
    expect(result).toMatchObject({ status: 'waiting-human', nextItem: 0 }); expect(f.writes).toEqual([])
    expect((await f.assets.state(browserId)).runs).toMatchObject([{ status: 'waiting-human', pendingCheckpointId: 'person', humanCheckpoints: [] }])
    expect(f.runTask).toHaveBeenCalledOnce()
  })
  it('an original grouped run cannot be continued outside its declared batch budget', async () => {
    const f = await fixture({ branch: true }); f.known(false)
    const result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost); f.returnControl()
    const before = await f.assets.state(browserId)
    await expect(runBrowserTaskAsset(f.assets, { browserId, assetId: f.asset.id, version: 1, runId: result.items[0]!.runId!, parameters: { value: 'outside-batch' } }, f.host)).rejects.toThrow('original batch')
    expect(await f.assets.state(browserId)).toEqual(before); expect(f.writes).toEqual([]); expect(f.runTask).toHaveBeenCalledOnce()
  })
  it('Stop during preparation cancels the group before any original item action', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void
    const prepared = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const host = { runTask: vi.fn(async (item: BrowserTaskAssetRunInput, budget: BrowserTaskRunBudget) => { entered(); await waiting; return f.batchHost.runTask(item, budget) }) }
    const promise = runBrowserTaskBatch(f.assets, f.input, host); await prepared
    const preparation = await f.assets.state(browserId), original = preparation.batches![0]!
    expect(preparation.activeBatchId).toBe(original.id); expect(preparation.selectedRunId).toBeNull()
    expect(await f.assets.stopBatch(browserId, original.id)).toMatchObject({ status: 'stopped', nextItem: 0 })
    release(); expect(await promise).toMatchObject({ id: original.id, status: 'stopped', nextItem: 0 })
    expect(f.writes).toEqual([]); expect(f.host.runScript).not.toHaveBeenCalled(); expect(host.runTask).toHaveBeenCalledOnce()
    expect((await f.assets.state(browserId)).runs).toEqual([])
    expect((await f.assets.state(browserId)).activeBatchId).toBeNull()
  })
  it('uncertain action result never starts another item or offers automatic replay', async () => {
    const f = await fixture(); f.uncertain()
    const result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
    expect(result).toMatchObject({ status: 'interrupted', nextItem: 0 }); expect(f.writes).toEqual([['@e1', 'value-one']])
    await expect(runBrowserTaskBatch(f.assets, { ...f.input, batchId: result.id }, f.batchHost)).rejects.toThrow('cannot continue automatically')
    expect(f.runTask).toHaveBeenCalledOnce()
  })
  it('binds every returned item report to its original run instead of believing a fabricated completed DTO', async () => {
    const f = await fixture(), host: BrowserTaskBatchHost = { runTask: async (item, budget) => ({ ...await f.runTask(item, budget), id: 'wrong-original-run' }) }
    const result = await runBrowserTaskBatch(f.assets, f.input, host)
    expect(result).toMatchObject({ status: 'interrupted', nextItem: 0, warning: expect.stringContaining('bound') })
    expect(f.writes).toEqual([['@e1', 'value-one']]); expect(f.runTask).toHaveBeenCalledOnce()
  })
  it('holds the existing Browser execution lease across item preparation without affecting another Browser', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void
    const prepared = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
    const promise = runBrowserTaskBatch(f.assets, f.input, { runTask: async (item, budget) => { entered(); await waiting; return f.runTask(item, budget) } }); await prepared
    await expect(runBrowserTaskAsset(f.assets, { ...f.input, parameters: { value: 'competing' } }, f.host)).rejects.toThrow('already executing')
    expect(f.assets.isBrowserExecuting('unrelated-browser')).toBe(false); expect(f.writes).toEqual([])
    release(); expect((await promise).status).toBe('completed'); expect(f.assets.isBrowserExecuting(browserId)).toBe(false)
  })
  it('refuses changed item order and per-item secrets before creating an original run', async () => {
    const f = await fixture({ branch: true }); f.known(false)
    const original = await runBrowserTaskBatch(f.assets, f.input, f.batchHost); f.returnControl()
    await expect(runBrowserTaskBatch(f.assets, { ...f.input, batchId: original.id, items: [...f.input.items].reverse() }, f.batchHost)).rejects.toThrow('item order changed')
    expect(f.runTask).toHaveBeenCalledOnce(); expect(f.writes).toEqual([])
    const draft = await f.assets.edit(f.asset.id, f.asset.revision, { ...f.asset.draft, parameters: [{ key: 'value', label: 'Fresh secret', secret: true }] }); await f.assets.saveVersion(f.asset.id, draft.revision)
    await expect(runBrowserTaskBatch(f.assets, { ...f.input, version: 2 }, f.batchHost)).rejects.toThrow('non-secret')
    expect((await f.assets.state(browserId)).batches).toHaveLength(1)
  })
  it('enforces nonempty items, unique identity and the aggregate value budget', async () => {
    const f = await fixture()
    for (const items of [[], Array.from({ length: 17 }, (_, i) => ({ id: String(i), parameters: {} })), [f.input.items[0]!, f.input.items[0]!]])
      expect(() => validateBrowserTaskBatchValues({ ...f.input, items })).toThrow('uniquely identified')
    expect(() => validateBrowserTaskBatchValues({ ...f.input, items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), parameters: { value: 'a'.repeat(10_000) } })) })).toThrow('64 KiB')
    expect(f.runTask).not.toHaveBeenCalled(); expect((await f.assets.state(browserId)).runs).toEqual([])
  })
  it('ordinary owner reload retains all item IDs and progress and never replays running or completed groups', async () => {
    const f = await fixture(), completed = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
    const restored = new BrowserTaskAssets(f.store); expect((await restored.state(browserId)).batches).toEqual([completed])
    await expect(runBrowserTaskBatch(restored, { ...f.input, batchId: completed.id }, f.batchHost)).rejects.toThrow('cannot continue automatically')
    f.store.document!.batches![0]!.status = 'running'
    const uncertain = new BrowserTaskAssets(f.store); expect((await uncertain.state(browserId)).batches).toMatchObject([{ id: completed.id, status: 'interrupted', nextItem: 2 }])
    expect(f.writes).toEqual([['@e1', 'value-one'], ['@e1', 'value-two']]); expect(f.runTask).toHaveBeenCalledTimes(2)
  })
  it('the real atomic file owner retains item/run mappings and rejects any automatic replay after reload', async () => {
    const f = await fixture(); await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/browser-task-batch-file-')), path = join(directory, 'original-tasks.json')
    try {
      const store = new BrowserTaskAssetFileStore(path); await store.save(f.store.document!)
      const owner = new BrowserTaskAssets(store); f.bindTo(owner)
      const result = await runBrowserTaskBatch(owner, f.input, { runTask: (item, budget) => runBrowserTaskAsset(owner, item, f.host, budget) })
      expect(result).toMatchObject({ status: 'completed', nextItem: 2, operationCount: 2 })
      const restored = new BrowserTaskAssets(new BrowserTaskAssetFileStore(path)), state = await restored.state(browserId)
      expect(state.batches).toEqual([result]); expect(state.runs.map(run => run.id)).toEqual(result.items.map(item => item.runId))
      await expect(runBrowserTaskBatch(restored, { ...f.input, batchId: result.id }, f.batchHost)).rejects.toThrow('cannot continue automatically')
      expect(f.writes).toEqual([['@e1', 'value-one'], ['@e1', 'value-two']])
      const raw = await readFile(path, 'utf8'); expect(raw).not.toContain('value-one'); expect(raw).not.toContain('value-two')
    } finally { await rm(directory, { recursive: true }) }
  })
  it('aggregate operation budget stops at 256 original actions before preparing another item', async () => {
    const f = await fixture({ steps: 128 })
    const result = await runBrowserTaskBatch(f.assets, { ...f.input, items: [...f.input.items, { id: 'third', parameters: { value: 'third' } }] }, f.batchHost)
    expect(result).toMatchObject({ status: 'interrupted', nextItem: 2, operationCount: 256, items: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] })
    expect(f.writes).toHaveLength(256); expect(f.runTask).toHaveBeenCalledTimes(2)
    expect((await f.assets.state(browserId)).runs).toHaveLength(2)
  })
  it('remaining aggregate time travels through the original execution deadline and stops the next item', async () => {
    const f = await fixture(); let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const original = f.host.runScript
    f.host.runScript = async (...args) => { const report = await original(...args); clock += 60_000; return report }
    try {
      const result = await runBrowserTaskBatch(f.assets, { ...f.input, items: [...f.input.items, { id: 'third', parameters: { value: 'third' } }] }, f.batchHost)
      expect(result).toMatchObject({ status: 'interrupted', nextItem: 2, executedMillis: 120_000 })
      expect(f.writes).toEqual([['@e1', 'value-one'], ['@e1', 'value-two']]); expect(f.runTask).toHaveBeenCalledTimes(2)
      expect(f.executions.map(execution => execution.deadlineMillis)).toEqual([121_000, 121_000])
    } finally { vi.restoreAllMocks() }
  })
  it('in-flight original operation and uncertain elapsed time are reflected in the retained group', async () => {
    const f = await fixture(); let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const original = f.host.runScript
    f.host.runScript = async (...args) => {
      const report = await original(...args)
      expect((await f.assets.state(browserId)).batches).toMatchObject([{ status: 'running', operationCount: 1 }])
      clock += 25; throw Error('Unknown after original action')
    }
    try {
      const result = await runBrowserTaskBatch(f.assets, f.input, f.batchHost)
      expect(result).toMatchObject({ status: 'interrupted', operationCount: 1, executedMillis: 25, nextItem: 0 })
      expect(f.writes).toEqual([['@e1', 'value-one']]); expect(f.runTask).toHaveBeenCalledOnce()
    } finally { vi.restoreAllMocks() }
  })
})
