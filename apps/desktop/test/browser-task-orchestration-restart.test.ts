// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'
import { importTaskRecording } from './helpers/import-task-recording'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets'

const source = 'original-source', url = 'https://original.invalid/', permission = async () => {}
class Store implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  fault: 'before' | 'after' | undefined
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) {
    if (this.fault === 'before') throw Error('private writer fault')
    this.document = structuredClone(document)
    if (this.fault === 'after') throw Error('private writer ACK fault')
  }
}
const target = (id: string, profileId = id) => ({ id, browserId: `browser-${id}`, profileId, parameters: {} })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(checkpoint = false) {
  const store = new Store(); let id = 0
  const owner = new BrowserTaskAssets(store, { id: () => `original-${++id}`, parallelCapacity: () => 3 })
  const imported = await importTaskRecording(owner, { id: 'recording', browserId: source, revision: 1, navigationId: 'original-document', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await owner.edit(imported.id, imported.revision, { ...imported.draft, steps: [
    { id: 'already-done', kind: 'navigate', url, reviewed: true },
    ...(checkpoint ? [{ id: 'person-review', kind: 'checkpoint' as const, url, reviewed: true }] : []),
    { id: 'remaining', kind: 'navigate', url: url + 'remaining', reviewed: true },
    { id: 'last', kind: 'navigate', url: url + 'last', reviewed: true }
  ] })
  const asset = await owner.saveVersion(edited.id, edited.revision)
  const entries = new Map(['a', 'b', 'queued', 'neighbor'].map(id => [`browser-${id}`, {
    id: `browser-${id}`, storage: { mode: 'normal', profileId: id === 'queued' ? 'a' : id }, humanControl: false,
    activity: { control: 'agent' }, controlRevision: 1, navigationId: 'original-document', view: { webContents: { isDestroyed: () => false } }
  }]))
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { taskAssets: owner, entries, taskExecutions: new Map() })
  // Native input shield/presentation ports are outside this original-owner test; the trusted
  // Manager method and its checkpoint/cursor checks run unchanged. Native proof covers the ports.
  vi.spyOn(manager as any, 'yieldControl').mockImplementation((browserId: string) => { const e = entries.get(browserId)!; e.humanControl = true; e.activity.control = 'human'; e.controlRevision++ })
  const returnControl = vi.spyOn(manager as any, 'applyAgentControl').mockImplementation((entry: any) => { entry.humanControl = false; entry.activity.control = 'agent'; entry.controlRevision++; return {} })
  const operations: { browserId: string; id: string; cursor?: number }[] = [], holds = new Map<string, ReturnType<typeof deferred>>()
  let beforeScript: (() => void) | undefined
  vi.spyOn(manager, 'runScript').mockImplementation(async (browserId, _code, _operator, _replay, _operationId, prepared, _private, page) => {
    beforeScript?.()
    const operation = { id: `page-operation-${operations.length + 1}`, browserId, phase: 'completed', operator: { id: 'native-port', name: 'Native port' }, startedAt: 1, summary: 'Original operation', url, steps: [] } as any
    operations.push({ browserId, id: operation.id, cursor: page?.cursor.stepId === 'already-done' ? 0 : undefined })
    await prepared?.(operation)
    const entry = entries.get(browserId)! as any
    let stopped = false; entry.activeRun = { operationId: operation.id, stop: () => { stopped = true; holds.get(browserId)?.resolve() } }; entry.activity.operation = operation
    await holds.get(browserId)?.promise
    delete entry.activeRun
    return { result: {}, logs: [], outcome: { kind: stopped ? 'stopped' : 'completed' }, runOperation: { ...operation, phase: stopped ? 'stopped' : 'completed' } }
  })
  const inspect = (operationId = 'group') => owner.inspectParallel(source, operationId)
  const settled = async (operationId = 'group') => {
    await vi.waitFor(async () => { expect((await inspect(operationId))!.run.status).not.toBe('running'); expect((owner as any).activeParallel.has(operationId)).toBe(false) })
    return (await inspect(operationId))!
  }
  const start = (targets = [target('a')], operationId = 'group') => manager.runControlledTaskParallel(source, asset.id, 1, { operationId, concurrency: 3, targets }, permission)
  return { owner, store, manager, entries, asset, operations, holds, inspect, settled, start, returnControl, beforeScript: (action: () => void) => { beforeScript = action } }
}

it('stops preparation and queued original targets without changing another healthy operation or returning control', async () => {
  const f = await fixture(), preparation = deferred(), prepared = deferred()
  f.manager.prepareTaskTarget = async browserId => { if (browserId === 'browser-a') { prepared.resolve(); await preparation.promise } }
  await f.start([target('a'), target('queued', 'a')]); await prepared.promise
  await f.start([target('neighbor')], 'neighbor-group'); await f.settled('neighbor-group')
  const neighbor = structuredClone(f.operations)
  const stopped = await f.manager.stopTaskParallel(source, 'group')
  expect(stopped).toMatchObject({ status: 'stopped', counts: { stopped: 2 } })
  preparation.resolve(); await f.settled()
  expect(f.operations).toEqual(neighbor)
  expect((await f.inspect())!.targets.map(row => [row.phase, row.run])).toEqual([['stopped', undefined], ['stopped', undefined]])
  expect(f.returnControl).not.toHaveBeenCalled()
  expect(await f.manager.stopTaskParallel('wrong-source', 'group')).toBeNull()
  expect((await f.inspect('neighbor-group'))!.run.status).toBe('completed')
})

it('a stopped late native preparation cannot take the person\'s Browser control', async () => {
  const f = await fixture(), preparation = deferred(), prepared = deferred()
  f.entries.get('browser-a')!.humanControl = true; f.entries.get('browser-a')!.activity.control = 'human'
  f.manager.prepareTaskTarget = async () => { prepared.resolve(); await preparation.promise }
  await f.manager.runTaskParallel(source, f.asset.id, 1, { operationId: 'group', targets: [target('a')] }, permission)
  await prepared.promise; await f.manager.stopTaskParallel(source, 'group'); preparation.resolve(); await f.settled()
  expect(f.returnControl, 'stopped preparation must not take control just to discover its stopped admission later').not.toHaveBeenCalled()
  expect(f.entries.get('browser-a')!.humanControl).toBe(true)
  expect(f.operations).toEqual([])
})

it('stops the exact in-flight page operation, retaining completed steps, original operations and uncertain effects', async () => {
  const f = await fixture(), hold = deferred()
  f.beforeScript(() => { if (f.operations.length === 1) f.holds.set('browser-a', hold) })
  await f.start(); await vi.waitFor(() => expect(f.operations).toHaveLength(2))
  const before = (await f.inspect())!.targets[0]!.run!
  expect(before.nextStep).toBe(1)
  await f.manager.stopTaskParallel(source, 'group'); await f.settled()
  const after = (await f.inspect())!.targets[0]!.run!
  expect(after).toMatchObject({ id: before.id, status: 'stopped', nextStep: 1, operationCount: 2 })
  expect(f.operations).toHaveLength(2)
  expect((await f.owner.inspect('browser-a', after.id))!.runs[0]!.operationIds).toEqual(f.operations.map(op => op.id))
  expect(await f.manager.stopTaskParallel(source, 'group')).toMatchObject({ status: 'stopped' })
})

it('trusted continuation uses the original version, cursor and Run while public control cannot approve a human checkpoint', async () => {
  const f = await fixture(true); await f.start(); const waiting = await f.settled()
  const row = waiting.targets[0]!, originalRun = row.run!.id
  expect(row.run).toMatchObject({ status: 'waiting-human', nextStep: 2, operationCount: 1 })
  expect(row.continuationRevision).toMatch(/^[a-f0-9]{64}$/)
  const edited = await f.owner.edit(f.asset.id, f.asset.revision, { ...f.asset.draft, steps: [{ id: 'new-version', kind: 'navigate', url, reviewed: true }] })
  await f.owner.saveVersion(edited.id, edited.revision)
  const input = { continuationId: 'person-continuation', expectedRevision: row.continuationRevision!, parameters: {} }
  const refused = await f.manager.continueControlledTaskParallelTarget(source, 'group', 'a', { ...input, continuationId: 'agent-request' }, permission)
  expect(refused.continuation.admission).toBe('refused'); expect(f.operations).toHaveLength(1)
  const admitted = await f.manager.continueTaskParallelTarget(source, 'group', 'a', input, permission)
  expect(admitted.continuation.admission).toBe('confirmed'); await f.settled()
  const original = (await f.owner.inspect('browser-a', originalRun))!.runs[0]!
  expect(original).toMatchObject({ id: originalRun, version: 1, status: 'completed', nextStep: 4 })
  expect(original.operationIds).toHaveLength(3)
  expect(original.humanCheckpoints).toMatchObject([{ checkpointId: 'person-review', origin: 'trusted-ui', pendingCursor: 2 }])
  const duplicate = await f.manager.continueTaskParallelTarget(source, 'group', 'a', input, permission)
  expect(duplicate.continuation).toMatchObject({ id: input.continuationId, targetId: 'a', admission: 'confirmed' }); expect(f.operations).toHaveLength(3)
  expect((await f.manager.inspectTaskParallel(source, 'group', undefined, 32, input.continuationId))!.continuation).toMatchObject({ admission: 'confirmed' })
})

it('stops an original human-wait tree without writing approval or allowing a late continuation', async () => {
  const f = await fixture(true); await f.start(); const waiting = await f.settled(), runId = waiting.targets[0]!.run!.id
  await f.manager.stopTaskParallel(source, 'group')
  expect((await f.owner.inspect('browser-a', runId))!.runs[0]).toMatchObject({ status: 'stopped', humanCheckpoints: [], nextStep: 2, pendingCheckpointId: 'person-review' })
  expect((await f.manager.continueTaskParallelTarget(source, 'group', 'a', { continuationId: 'late-person', expectedRevision: waiting.targets[0]!.continuationRevision!, parameters: {} }, permission)).continuation.admission).toBe('refused')
  expect(f.operations).toHaveLength(1)
})

it('continues the original waiting subflow leaf and stops the next one while completed items keep their identities and approvals', async () => {
  const f = await fixture(true)
  const imported = await importTaskRecording(f.owner, { id: 'root-recording', browserId: source, revision: 1, navigationId: 'original-document', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await f.owner.edit(imported.id, imported.revision, { ...imported.draft, steps: [{ id: 'original-loop', kind: 'subflow', url, reviewed: true, subflow: { target: { kind: 'local', assetId: f.asset.id, version: 1 }, iteration: 'each' } }] })
  const root = await f.owner.saveVersion(edited.id, edited.revision)
  const calls = { 'original-loop': { parameters: {}, items: [{ id: 'original-first', parameters: {} }, { id: 'original-second', parameters: {} }] } }
  await f.manager.runControlledTaskParallel(source, root.id, 1, { operationId: 'group', targets: [{ ...target('a'), calls }] }, permission)
  const first = await f.settled(), rootId = first.targets[0]!.run!.id, firstLeaf = (await f.owner.waitingLeaf(rootId))!
  expect(firstLeaf.parent).toMatchObject({ runId: rootId, itemId: 'original-first' })
  await f.manager.continueTaskParallelTarget(source, 'group', 'a', { continuationId: 'original-leaf-continue', expectedRevision: first.targets[0]!.continuationRevision!, parameters: {}, calls }, permission)
  await f.settled()
  const tree = (await f.owner.inspect('browser-a', rootId))!, nextLeaf = (await f.owner.waitingLeaf(rootId))!
  expect(tree.rootRunId).toBe(rootId)
  expect(tree.runs.find(run => run.id === rootId)!.calls).toMatchObject([{ nextItem: 1, items: [{ id: 'original-first', runId: firstLeaf.id }, { id: 'original-second', runId: nextLeaf.id }] }])
  expect(nextLeaf.id).not.toBe(firstLeaf.id); expect(nextLeaf.humanCheckpoints).toEqual([])
  const completed = tree.runs.find(run => run.id === firstLeaf.id)!
  expect(completed).toMatchObject({ status: 'completed', humanCheckpoints: [{ runId: firstLeaf.id, checkpointId: 'person-review', origin: 'trusted-ui' }] })
  expect(f.operations).toHaveLength(4)
  await f.manager.stopTaskParallel(source, 'group')
  const stopped = (await f.owner.inspect('browser-a', rootId))!
  expect(stopped.runs.find(run => run.id === firstLeaf.id)).toEqual(completed)
  expect(stopped.runs.find(run => run.id === nextLeaf.id)).toMatchObject({ status: 'stopped', humanCheckpoints: [], parent: { itemId: 'original-second' } })
  expect(stopped.operationCount).toBe(4)
})

it.each(['before', 'after'] as const)('keeps a %s-write continuation ACK unknown under its original ID and never auto replays it', async fault => {
  const f = await fixture(true); await f.start(); const waiting = await f.settled()
  const input = { continuationId: `lost-${fault}`, expectedRevision: waiting.targets[0]!.continuationRevision!, parameters: {} }
  f.store.fault = fault
  await expect(f.manager.continueTaskParallelTarget(source, 'group', 'a', input, permission)).rejects.toMatchObject({ code: 'BROWSER_TASK_PARALLEL_UNCONFIRMED' })
  expect(f.operations).toHaveLength(1)
  const queried = await f.manager.inspectTaskParallel(source, 'group', undefined, 32, input.continuationId)
  expect(queried!.continuation).toMatchObject({ id: input.continuationId, admission: fault === 'before' ? 'unknown' : 'confirmed' })
  expect((await f.manager.inspectTaskParallel(source, 'group', undefined, 32, 'not-yet-observed'))!.continuation).toBeNull()
  f.store.fault = undefined
  await f.manager.continueTaskParallelTarget(source, 'group', 'a', input, permission)
  expect(f.operations).toHaveLength(1)
  const restored = new BrowserTaskAssets(f.store)
  const read = await restored.inspectParallel(source, 'group', undefined, 32, input.continuationId)
  expect(read!.targets[0]!.run!.id).toBe(waiting.targets[0]!.run!.id)
  expect(read!.targets[0]!.run!.operationCount).toBe(1)
  expect(f.operations).toHaveLength(1)
})

it('public Stop remains reachable when automation is disabled and does not require a source native page', async () => {
  const f = await fixture(true); await f.start(); await f.settled()
  const owner = { stopTaskParallel: f.manager.stopTaskParallel.bind(f.manager) } as any
  const stopped = await executeBrowserTaskControl({ operation: 'browser.task.parallel-stop', browserId: source, operationId: 'group' }, owner, false)
  expect(stopped).toMatchObject({ operation: 'browser.task.parallel-stop', run: { operationId: 'group', status: 'stopped' } })
  expect(f.entries.has(source)).toBe(false)
})
