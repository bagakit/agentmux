// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserTaskAssets } from '../src/main/browser-task-assets'
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { createBrowserAutomationGate } from '../src/main/browser-automation-gate'
import { importTaskRecording } from './helpers/import-task-recording'
const source = 'review-source', target = 'review-target', profileId = 'selected-profile', url = 'https://review.invalid/'
async function fixture(steps = 1) {
 let saved: any = null, sequence = 0
 const store = { load: async () => structuredClone(saved), save: async (value: unknown) => { saved = structuredClone(value) } }
 const owner = new BrowserTaskAssets(store, { id: () => `review-${++sequence}`, parallelCapacity: () => 2 })
 const recording = await importTaskRecording(owner, { id: 'review-recording', browserId: source, revision: 1, navigationId: 'nav-original', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
 const edit = await owner.edit(recording.id, recording.revision, { name: 'Original fixed version', url, parameters: [], steps: Array.from({ length: steps }, (_, index) => ({ id: `navigate-${index + 1}`, kind: 'navigate' as const, url, reviewed: true })) })
 const asset = await owner.saveVersion(edit.id, edit.revision)
 const entry = { id: target, storage: { mode: 'normal', profileId }, humanControl: false, activity: { control: 'agent' }, controlRevision: 'original-control', navigationId: 'nav-original', view: { webContents: { isDestroyed: () => false } } }
 const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
 Object.assign(manager, { taskAssets: owner, entries: new Map([[target, entry]]), taskExecutions: new Map() })
 let effects = 0, onEffect: ((count: number) => void) | undefined
 vi.spyOn(manager, 'runScript').mockImplementation(async (browserId, _script, _operator, _capture, _caller, prepared) => {
  const operation = { id: `review-operation-${++effects}`, browserId, phase: 'completed', operator: { id: 'review', name: 'Review' }, startedAt: 1, summary: 'Actual operation callback', url, steps: [] } as any
  await prepared?.(operation)
  onEffect?.(effects)
  return { result: {}, logs: [], outcome: { kind: 'completed' }, runOperation: operation }
 })
 return { owner, asset, manager, entry, store, read: () => saved, effects: () => effects, onEffect: (action: (count: number) => void) => { onEffect = action } }
}
it('refuses changed target permission between native preparation and page dispatch', async () => {
 const f = await fixture(); let permitted = true, authorizations = 0
 const gate = createBrowserAutomationGate({ automation: () => true, profileOf: async () => profileId, agentAccess: () => permitted })
 f.manager.prepareTaskTarget = async () => { permitted = false }
 await f.manager.runControlledTaskParallel(source, f.asset.id, 1, { operationId: 'permission-race', targets: [{ id: 'target', browserId: target, profileId, parameters: {} }] }, async (browserId, expectedProfile) => { authorizations++; await gate(browserId, { agentSessionId: 'original-agent' }, expectedProfile) })
 await vi.waitFor(async () => expect((await f.owner.inspectParallel(source, 'permission-race'))!.run.status).not.toBe('running'))
 const facts = { authorizations, permittedAtDispatch: permitted, pageEffects: f.effects(), run: (await f.owner.inspectParallel(source, 'permission-race'))!.run }
 expect(facts.pageEffects, 'a queued target must not dispatch after its exact Profile Agent access was disabled during preparation').toBe(0)
})
it('measures exact active inspection work against unrelated retained orchestration history', async () => {
 const f = await fixture()
 await f.manager.runControlledTaskParallel(source, f.asset.id, 1, { operationId: 'exact-inspect', targets: [{ id: 'target', browserId: target, profileId, parameters: {} }] }, async () => {})
 await vi.waitFor(async () => expect((await f.owner.inspectParallel(source, 'exact-inspect'))!.run.status).toBe('completed'))
 const document = structuredClone(f.read()), original = document.parallel[0]
 const other = await importTaskRecording(f.owner, { id: 'other-recording', browserId: 'other-source', revision: 1, navigationId: 'other', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
 const edited = await f.owner.edit(other.id, other.revision, { ...other.draft, steps: [{ id: 'other-step', kind: 'navigate', url, reviewed: true }] })
 const published = await f.owner.saveVersion(edited.id, edited.revision)
 document.assets.push(published)
 const sizes = [0, 1000, 20000], results = []
 for (const size of sizes) {
  document.parallel = [...Array.from({ length: size }, (_, i) => ({ operationId: `other-operation-${i}`, browserId: 'other-source', assetId: published.id, version: 1, requestedConcurrency: 1, concurrency: 1, status: 'failed', startedAt: 1, updatedAt: 2, targets: [{ id: `other-${i}`, browserId: `other-browser-${i}`, profileId: 'other-profile', phase: 'failed' }] })), original]
  const restored = new BrowserTaskAssets({ load: async () => structuredClone(document), save: async () => {} })
  await restored.ready(); await restored.inspectParallel(source, 'exact-inspect', undefined, 1)
  let unrelatedVisits = 0
  for (const record of (restored as any).document.parallel.slice(0, size)) { const value = record.operationId; Object.defineProperty(record, 'operationId', { get: () => { unrelatedVisits++; return value } }) }
  const inspection = await restored.inspectParallel(source, 'exact-inspect', undefined, 1)
  expect(inspection!.targets).toHaveLength(1); expect(inspection!.targets[0]!.run!.status).toBe('completed')
  results.push({ retainedUnrelatedOperations: size, returnedTargets: inspection!.targets.length, unrelatedVisits })
 }
 expect(results.at(-1)!.unrelatedVisits, 'repeated exact one-target progress inspection must stay independent of other source libraries').toBe(0)
})

it('does not report a bound target as completed after its original script acknowledgement is lost', async () => {
 const f = await fixture(); f.onEffect(() => { throw Error('Original native operation acknowledgement lost') })
 await f.manager.runControlledTaskParallel(source, f.asset.id, 1, { operationId: 'late-unknown', targets: [{ id: 'target', browserId: target, profileId, parameters: {} }] }, async () => {})
 await vi.waitFor(async () => expect((await f.owner.inspectParallel(source, 'late-unknown'))!.run.status).not.toBe('running'))
 const result = (await f.owner.inspectParallel(source, 'late-unknown'))!
 expect(result.run.status).not.toBe('completed')
 expect(result.targets[0]!.run!.status).toBe('interrupted')
})

it('rechecks the original caller before the next original step when Profile access changes during an in-flight run', async () => {
 const f = await fixture(2); let permitted = true
 const gate = createBrowserAutomationGate({ automation: () => true, profileOf: async () => profileId, agentAccess: () => permitted })
 f.onEffect(count => { if (count === 1) permitted = false })
 await f.manager.runControlledTaskParallel(source, f.asset.id, 1, { operationId: 'next-step-policy', targets: [{ id: 'target', browserId: target, profileId, parameters: {} }] }, (browserId, expectedProfile) => gate(browserId, { agentSessionId: 'original-agent' }, expectedProfile))
 await vi.waitFor(async () => expect((await f.owner.inspectParallel(source, 'next-step-policy'))!.run.status).not.toBe('running'))
 const result = (await f.owner.inspectParallel(source, 'next-step-policy'))!
 expect(f.effects()).toBe(1)
 expect(result.run.status).not.toBe('completed')
 expect(result.targets[0]!.run!.operationCount).toBe(1)
})
