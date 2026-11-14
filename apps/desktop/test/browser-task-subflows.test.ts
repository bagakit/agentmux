import { describe, expect, it, vi } from 'vitest'
import { browserTaskImportInput } from '../../../packages/core/src/browser-task-control.js'
import { BrowserTaskAssets, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import { importTaskRecording } from './helpers/import-task-recording.js'
import type { BrowserTaskAssetDocument, BrowserTaskAssetRunInput, BrowserTaskContent, BrowserTaskStep, BrowserTaskStepExecution } from '../src/shared/browser-task-assets.js'
import type { BrowserScriptRunReport } from '../src/shared/contracts.js'

const browserId = 'forms-browser', url = 'https://forms.invalid/input'
const target = { role: 'textbox', name: 'Entry', ordinal: 1, count: 1 }
const fill = (id = 'write'): BrowserTaskStep => ({ id, kind: 'fill', url, reviewed: true, target, parameterKey: 'entry' })
const checkpoint = (): BrowserTaskStep => ({ id: 'review', kind: 'checkpoint', url, reviewed: true })
const call = (assetId: string, version = 1, id = 'forms'): BrowserTaskStep => ({ id, kind: 'subflow', url, reviewed: true, subflow: { target: { kind: 'local', assetId, version }, iteration: 'each' } })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  fail: ((document: BrowserTaskAssetDocument) => 'before' | 'after' | undefined) | undefined
  beforeSave: ((document: BrowserTaskAssetDocument) => void) | undefined
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) {
    this.beforeSave?.(document)
    const fault = this.fail?.(document)
    if (fault === 'before') throw Error('private storage fault')
    this.document = structuredClone(document)
    if (fault === 'after') throw Error('private storage acknowledgement lost')
  }
}
async function fixture() {
  let sequence = 0, clock = 1_000, control: 'human' | 'agent' = 'agent', navigationId = 'document-1'
  const store = new MemoryStore()
  let owner = new BrowserTaskAssets(store, { id: () => `original-${++sequence}`, now: () => clock++ })
  const actions: { runId: string; value: string }[] = [], executions: BrowserTaskStepExecution[] = []
  const frames: { runId: string; values: Record<string, string>; sensitive: boolean }[] = []
  let after: ((execution: BrowserTaskStepExecution) => Promise<void>) | undefined
  const runScript = vi.fn(async (id: string, script: string, execution: BrowserTaskStepExecution, frame?: { parameters: Record<string, string>; sensitive: boolean }): Promise<BrowserScriptRunReport> => {
    const operationId = `journal-${executions.length + 1}`
    expect(await owner.bindOperation(execution, operationId)).toBe(true)
    expect(owner.isExecutionCurrent(execution, operationId)).toBe(true)
    if (execution.expectedNavigationId !== undefined) expect(navigationId).toBe(execution.expectedNavigationId)
    executions.push(structuredClone(execution))
    if (frame) frames.push({ runId: execution.runId, values: { ...frame.parameters }, sensitive: frame.sensitive })
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', script)(
      async () => ({ url, navigationId }),
      async () => ({ navigationId, nodes: [{ ref: '@entry', role: 'textbox', name: 'Entry' }], missingFrames: [],
        observation: { scope: { kind: 'page', document: null }, fullObserved: 1, scoped: 1, matched: 1, returned: 1, truncated: false, omittedFrames: [] } }),
      async (_ref: string, value: string) => { actions.push({ runId: execution.runId, value }) })
    await after?.(execution)
    return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: operationId, browserId: id, phase: 'completed',
      operator: { id: 'original-operator', name: 'Operator' }, startedAt: 1, summary: 'Write a form', url,
      steps: [{ sequence: 1, method: 'fillInput', status: 'completed' }] } }
  })
  const host: BrowserTaskAssetHost = { onRunPrepared: vi.fn(), runScript, navigationId: () => navigationId, control: () => control, yieldControl: () => { control = 'human' } }
  const publish = async (steps: BrowserTaskStep[], scope = browserId, parameters: BrowserTaskContent['parameters'] = [{ key: 'entry', label: 'Entry', secret: false }]) => {
    const asset = await importTaskRecording(owner, { id: `recording-${++sequence}`, browserId: scope, revision: 1, navigationId: 'recorded-document', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
    const edited = await owner.edit(asset.id, asset.revision, { name: 'Form task', url, steps, parameters })
    return owner.saveVersion(edited.id, edited.revision)
  }
  const invoke = (assetId: string, entries = ['alpha', 'beta']): BrowserTaskAssetRunInput => ({ browserId, assetId, version: 1, parameters: {},
    calls: { forms: { parameters: {}, items: entries.map((entry, index) => ({ id: `item-${index + 1}`, parameters: { entry } })) } } })
  return { store, host, publish, invoke, actions, executions, frames, runScript, owner: () => owner,
    reload: () => { owner = new BrowserTaskAssets(store, { id: () => `original-${++sequence}`, now: () => clock++ }); return owner },
    setNavigation: (next: string) => { navigationId = next }, setControl: (next: typeof control) => { control = next }, after: (fn: typeof after) => { after = fn } }
}

describe('finite calls use the original task owner and immutable child runs', () => {
  it('runs a nonempty collection against the fixed version, saves exact parent items and keeps fresh values private', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    const changed = await f.owner().edit(child.id, child.revision, { ...child.draft, steps: [fill('newer-definition')] })
    await f.owner().saveVersion(child.id, changed.revision)
    const run = await f.owner().run(f.invoke(root.id), f.host), inspection = await f.owner().inspect(browserId)
    expect(run, JSON.stringify({ run, inspection, persisted: f.store.document?.runs })).toMatchObject({ status: 'completed', nextStep: 1, calls: [{ stepId: 'forms', assetId: child.id, version: 1, nextItem: 2 }] })
    expect(f.actions.map(action => action.value)).toEqual(['alpha', 'beta'])
    expect(f.executions.map(execution => [execution.version, execution.stepId])).toEqual([[1, 'write'], [1, 'write']])
    expect(inspection?.runs).toHaveLength(3)
    for (const [index, item] of run.calls![0]!.items.entries()) {
      expect(inspection?.runs.find(child => child.id === item.runId)).toMatchObject({ assetId: child.id, version: 1, status: 'completed',
        parent: { runId: run.id, stepId: 'forms', itemId: `item-${index + 1}` }, operationIds: [`journal-${index + 1}`] })
    }
    expect(inspection).toMatchObject({ rootRunId: run.id, currentRunId: run.id, operationCount: 2 })
    expect(f.frames.map(frame => frame.values)).toEqual([{ entry: 'alpha' }, { entry: 'beta' }])
    expect(JSON.stringify(f.store.document)).not.toMatch(/alpha|beta/)
    expect(f.host.onRunPrepared).toHaveBeenCalledTimes(1)
  })

  it('continues only the exact waiting child, without rerunning an earlier item or copying its human fact', async () => {
    const f = await fixture(), child = await f.publish([fill(), checkpoint(), fill('after-review')]), root = await f.publish([call(child.id)], browserId, [])
    const input = f.invoke(root.id)
    const first = await f.owner().run(input, f.host), firstLeaf = (await f.owner().waitingLeaf(first.id))!
    expect(first).toMatchObject({ status: 'waiting-human', nextStep: 0 }); expect(firstLeaf.parent).toMatchObject({ runId: first.id, itemId: 'item-1' })
    expect(await f.owner().recordHumanCheckpoint({ ...first, runId: first.id }, 'review', { pendingCheckpointId: 'review', nextStep: firstLeaf.nextStep, controlBefore: 'human' })).toMatchObject({ saved: false })
    await expect(f.owner().run({ ...input, assetId: child.id, runId: firstLeaf.id, parameters: { entry: 'wrong-direct-input' }, calls: {} }, f.host)).rejects.toThrow('original root')
    const confirm = async (leaf: typeof firstLeaf) => {
      expect(await f.owner().recordHumanCheckpoint({ browserId, runId: leaf.id, assetId: leaf.assetId, version: leaf.version }, 'review',
        { pendingCheckpointId: 'review', nextStep: leaf.nextStep, controlBefore: 'human' })).toMatchObject({ saved: true, fact: { runId: leaf.id } })
      f.setControl('agent')
    }
    await confirm(firstLeaf)
    const second = await f.owner().run({ ...input, runId: first.id }, f.host), secondLeaf = (await f.owner().waitingLeaf(first.id))!
    expect(second.calls![0]!.nextItem).toBe(1); expect(secondLeaf.id).not.toBe(firstLeaf.id)
    expect(secondLeaf.humanCheckpoints).toEqual([])
    expect(f.actions.map(action => action.value)).toEqual(['alpha', 'alpha', 'beta'])
    const reordered = { ...input, runId: first.id, calls: { forms: { ...input.calls!.forms!, items: [...input.calls!.forms!.items].reverse() } } }
    f.setControl('agent')
    const refused = await f.owner().run(reordered, f.host)
    expect(refused.warning).toContain('original ids and order'); expect(f.actions).toHaveLength(3)
    await confirm(secondLeaf)
    const complete = await f.owner().run({ ...input, runId: first.id }, f.host)
    expect(complete.status).toBe('completed'); expect(f.actions.map(action => action.value)).toEqual(['alpha', 'alpha', 'beta', 'beta'])
    expect((await f.owner().inspect(browserId))?.runs.filter(run => run.parent).map(run => run.humanCheckpoints?.[0]?.runId)).toEqual([firstLeaf.id, secondLeaf.id])
    expect(complete.humanCheckpoints).toEqual([])
  })

  it('does not dispatch an unreviewed subflow or an unreviewed later call after a completed page step', async () => {
    const f = await fixture(), child = await f.publish([fill()]), unreviewed = { ...call(child.id), reviewed: false }
    const root = await f.publish([unreviewed], browserId, [])
    await expect(f.owner().run(f.invoke(root.id), f.host)).rejects.toThrow(/Review.*subflow/)
    expect(f.actions).toEqual([])
    const later = await f.publish([fill('before-call'), unreviewed])
    const run = await f.owner().run({ ...f.invoke(later.id), parameters: { entry: 'prior-action' } }, f.host)
    expect(run).toMatchObject({ status: 'ready', nextStep: 1, warning: expect.stringMatching(/Review.*subflow/) })
    expect(f.actions.map(action => action.value)).toEqual(['prior-action'])
  })

  it('stops the active child and all pending work while preserving completed siblings', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    f.after(async execution => { if (f.actions.length === 2) await f.owner().stop((await f.owner().inspect(browserId))!.rootRunId) })
    const run = await f.owner().run(f.invoke(root.id, ['one', 'two', 'three']), f.host), tree = (await f.owner().inspect(browserId))!
    expect(run.status).toBe('stopped'); expect(f.actions.map(action => action.value)).toEqual(['one', 'two'])
    expect(tree.runs.map(run => run.status)).toEqual(['stopped', 'completed', 'stopped'])
    expect(run.calls![0]!.items[2]!.runId).toBeUndefined()
    expect(tree.operationCount).toBe(2)
  })

  it('retains a known original operation after its page effect loses its acknowledgement and sends no remaining item', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    f.after(async () => { if (f.actions.length === 2) throw Error('private reply lost') })
    const input = f.invoke(root.id, ['one', 'two', 'three']), run = await f.owner().run(input, f.host)
    expect(run).toMatchObject({ status: 'interrupted', calls: [{ nextItem: 1 }] })
    expect(f.actions.map(action => action.value)).toEqual(['one', 'two'])
    const tree = await f.reload().inspect(browserId)
    expect(tree?.runs.map(run => [run.status, run.operationIds.length])).toEqual([['interrupted', 0], ['completed', 1], ['interrupted', 1]])
    await expect(f.owner().run({ ...input, runId: run.id }, f.host)).rejects.toThrow('cannot be continued automatically')
    expect(f.actions).toHaveLength(2); expect(JSON.stringify(tree)).not.toContain('private reply lost')
  })

  it.each(['before', 'after'] as const)('keeps the original child binding when the first child save fails %s durable write', async fault => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    let injected = false
    f.store.fail = document => { if (!injected && document.runs.some(run => run.parent)) { injected = true; return fault } }
    const run = await f.owner().run(f.invoke(root.id), f.host)
    expect(injected).toBe(true); expect(run.status).toBe('interrupted'); expect(f.actions).toEqual([])
    const tree = await f.owner().inspect(browserId), binding = run.calls![0]!.items[0]!.runId
    expect(binding).toBeTruthy(); expect(tree?.runs.map(run => run.id)).toContain(binding)
    const recovered = await f.reload().inspect(browserId)
    expect(recovered?.runs.map(run => run.id)).toEqual(tree?.runs.map(run => run.id))
    expect(recovered?.runs[0]?.calls?.[0]?.items[0]?.runId).toBe(binding)
    expect(f.actions).toEqual([])
  })

  it('charges one operation allowance across all items and never sends the next operation after it is exhausted', async () => {
    const f = await fixture(), child = await f.publish(Array.from({ length: 9 }, (_, index) => fill(`field-${index}`))), root = await f.publish([call(child.id)], browserId, [])
    const run = await f.owner().run(f.invoke(root.id, Array.from({ length: 16 }, (_, index) => `row-${index}`)), f.host), tree = (await f.owner().inspect(browserId))!
    expect(run.status).toBe('interrupted'); expect(tree.operationCount).toBe(128); expect(f.actions).toHaveLength(128)
    expect(run.calls![0]!.nextItem).toBe(14); expect(run.calls![0]!.items[15]!.runId).toBeUndefined()
    expect(tree.runs.at(-1)).toMatchObject({ status: 'interrupted', nextStep: 2 })
  })

  it('sums leaf elapsed time once and keeps human waiting outside the execution budget', async () => {
    const f = await fixture(), child = await f.publish([fill(), checkpoint(), fill('resume')]), root = await f.publish([call(child.id)], browserId, [])
    const input = f.invoke(root.id), run = await f.owner().run(input, f.host), leaf = (await f.owner().waitingLeaf(run.id))!
    const before = (await f.owner().inspect(browserId))!
    expect(before.executedMillis).toBe(f.store.document!.runs.filter(run => run.parent).reduce((sum, run) => sum + (run.executedMillis ?? 0), 0))
    f.store.document!.runs.find(run => run.id === leaf.id)!.executedMillis = 120_000
    f.reload(); f.setControl('agent')
    const next = await f.owner().run({ ...input, runId: run.id }, f.host)
    expect(next.status).toBe('interrupted'); expect(f.actions).toHaveLength(1)
  })

  it('refuses unknown, foreign or missing retained callees without a page operation and keeps the original Browser usable', async () => {
    const f = await fixture(), foreign = await f.publish([fill()], 'other-browser')
    for (const step of [call(foreign.id), call('missing'), call(foreign.id, 999)]) {
      const asset = await importTaskRecording(f.owner(), { id: `source-${step.subflow!.target.kind === 'local' ? step.subflow!.target.version : ''}-${step.subflow!.target.kind === 'local' ? step.subflow!.target.assetId : ''}`, browserId, revision: 1, navigationId: 'nav', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
      const draft = await f.owner().edit(asset.id, asset.revision, { name: 'Caller', url, parameters: [], steps: [step] })
      await expect(f.owner().saveVersion(draft.id, draft.revision)).rejects.toThrow('unavailable in this Browser')
    }
    expect(f.actions).toEqual([])
    const normal = await f.publish([fill()])
    expect((await f.owner().run({ browserId, assetId: normal.id, version: 1, parameters: { entry: 'healthy' } }, f.host)).status).toBe('completed')
    expect(f.actions.map(action => action.value)).toEqual(['healthy'])
  })

  it('rejects a fifth call level and malformed finite inputs before any page action', async () => {
    const f = await fixture(); let child = await f.publish([fill()])
    for (let depth = 2; depth <= 4; depth++) child = await f.publish([call(child.id)], browserId, [])
    const tooDeep = await importTaskRecording(f.owner(), { id: 'too-deep-recording', browserId, revision: 1, navigationId: 'nav', url, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
    const draft = await f.owner().edit(tooDeep.id, tooDeep.revision, { name: 'Fifth level', url, parameters: [], steps: [call(child.id)] })
    await expect(f.owner().saveVersion(draft.id, draft.revision)).rejects.toThrow('at most 4')
    const leaf = await f.publish([fill()]), root = await f.publish([call(leaf.id)], browserId, [])
    const input = f.invoke(root.id)
    for (const calls of [{ forms: { parameters: {}, items: [] } }, { forms: { parameters: {}, items: [input.calls!.forms!.items[0]!, input.calls!.forms!.items[0]!] } },
      { unknown: input.calls!.forms! }, { forms: { parameters: {}, items: [{ id: 'one', parameters: { secret: 'private' } }] } }]) {
      await expect(f.owner().run({ ...input, calls }, f.host)).rejects.toThrow()
    }
    expect(f.actions).toEqual([])
  })

  it('uses each exact run’s fresh values even when root and child parameter keys collide', async () => {
    const f = await fixture(), child = await f.publish([fill()], browserId, [{ key: 'entry', label: 'Private child input', secret: true }])
    const root = await f.publish([fill('parent-write'), call(child.id)])
    const run = await f.owner().run({ ...f.invoke(root.id), parameters: { entry: 'private-root-value' },
      calls: { forms: { parameters: { entry: 'private-child-value' }, items: [{ id: 'child-one', parameters: {} }, { id: 'child-two', parameters: {} }] } } }, f.host)
    expect(run.status).toBe('completed')
    expect(f.actions.map(action => action.value)).toEqual(['private-root-value', 'private-child-value', 'private-child-value'])
    expect(f.frames.map(frame => frame.values.entry)).toEqual(['private-root-value', 'private-child-value', 'private-child-value'])
    expect(f.frames.every(frame => frame.sensitive)).toBe(true)
    expect(JSON.stringify(f.store.document)).not.toContain('private-')
    await expect(f.owner().run({ ...f.invoke(root.id), parameters: { entry: 'root' },
      calls: { forms: { parameters: {}, items: [{ id: 'bad-item-secret', parameters: { entry: 'child-secret' } }] } } }, f.host)).rejects.toThrow('non-secret')
    expect(f.actions).toHaveLength(3)
  })

  it('rejects an expanded input over the shared child count or byte allowance before dispatching any call', async () => {
    const f = await fixture(), leaf = await f.publish([fill()]), middle = await f.publish([call(leaf.id)], browserId, []), root = await f.publish([call(middle.id)], browserId, [])
    const nested = { forms: { parameters: {}, items: Array.from({ length: 16 }, (_, index) => ({ id: `outer-${index}`, parameters: {},
      calls: { forms: { parameters: {}, items: [{ id: 'one', parameters: { entry: 'first' } }, { id: 'two', parameters: { entry: 'second' } }] } } })) } }
    await expect(f.owner().run({ ...f.invoke(root.id), calls: nested }, f.host)).rejects.toThrow('bounded fresh parameters')
    const wide = await f.publish([call(leaf.id)], browserId, [])
    await expect(f.owner().run(f.invoke(wide.id, Array.from({ length: 16 }, () => 'x'.repeat(8_192))), f.host)).rejects.toThrow('bounded fresh parameters')
    expect(f.actions).toEqual([]); expect((await f.owner().state(browserId)).runs).toEqual([])
  })

  it('retains a completed child when its durable completion acknowledgement is lost and never replays it', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    let injected = false
    f.store.fail = document => { if (!injected && document.runs.some(run => run.parent && run.status === 'completed')) { injected = true; return 'after' } }
    const input = f.invoke(root.id), run = await f.owner().run(input, f.host)
    expect(injected).toBe(true); expect(run.status).toBe('interrupted')
    const original = await f.owner().inspect(browserId), recovered = await f.reload().inspect(browserId)
    expect(recovered?.runs.map(run => [run.id, run.status])).toEqual(original?.runs.map(run => [run.id, run.status]))
    expect(recovered?.runs[1]).toMatchObject({ status: 'completed', operationIds: ['journal-1'] })
    await expect(f.owner().run({ ...input, runId: run.id }, f.host)).rejects.toThrow('cannot be continued automatically')
    expect(f.actions.map(action => action.value)).toEqual(['alpha'])
  })

  it('detects a recursive retained definition before publishing and leaves its original data available', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    f.store.document!.assets.find(asset => asset.id === child.id)!.versions[0]!.steps = [call(child.id)]
    f.reload()
    const original = await f.owner().get(root.id)
    await expect(f.owner().saveVersion(root.id, original!.revision)).rejects.toThrow('recursively call an active task version')
    expect(await f.owner().get(root.id)).toEqual(original)
    expect(f.actions).toEqual([])
  })

  it('rechecks a parent condition after a child write-ahead save and sends no action into a replacement document', async () => {
    const f = await fixture(), child = await f.publish([fill()])
    const root = await f.publish([
      { id: 'choose', kind: 'branch', url, reviewed: true, branch: { condition: { kind: 'page-url-is', url }, onTrue: 'forms', onFalse: 'other' } },
      { ...call(child.id), nextStepId: null }, fill('other')])
    let changed = false
    f.store.beforeSave = document => {
      if (!changed && document.runs.some(run => run.parent && run.status === 'running' && run.operationIds.length === 0)) {
        changed = true; f.setNavigation('replacement-same-url-document')
      }
    }
    const run = await f.owner().run(f.invoke(root.id), f.host)
    expect(changed).toBe(true); expect(run).toMatchObject({ status: 'ready', nextStep: 0, branchDecisions: [{ result: 'unknown' }] })
    expect(f.actions).toEqual([]); expect(f.executions.map(execution => execution.stepId)).toEqual(['choose'])
    expect((await f.owner().inspect(browserId))?.runs[1]).toMatchObject({ status: 'ready', nextStep: 0, operationIds: [] })
  })

  it('retains the parent condition across an early child checkpoint until the first child operation', async () => {
    const f = await fixture(), child = await f.publish([checkpoint(), fill()])
    const root = await f.publish([
      { id: 'choose', kind: 'branch', url, reviewed: true, branch: { condition: { kind: 'page-url-is', url }, onTrue: 'forms', onFalse: 'other' } },
      { ...call(child.id), nextStepId: null }, fill('other')])
    const input = f.invoke(root.id), run = await f.owner().run(input, f.host), leaf = (await f.owner().waitingLeaf(run.id))!
    expect(run.status).toBe('waiting-human'); expect(leaf.nextStep).toBe(1); expect(f.actions).toEqual([])
    const childId = leaf.id
    f.reload(); f.setNavigation('replacement-during-human-wait'); f.setControl('agent')
    const next = await f.owner().run({ ...input, runId: run.id }, f.host)
    expect(next).toMatchObject({ id: run.id, status: 'ready', nextStep: 0, branchDecisions: [{ result: 'unknown' }] })
    expect(next.calls?.[0]?.items[0]?.runId).toBe(childId)
    expect(f.executions.map(execution => execution.stepId)).toEqual(['choose']); expect(f.actions).toEqual([])
  })

  it('consumes the parent condition once a child operation has run and does not bind later items to the old document', async () => {
    const f = await fixture(), child = await f.publish([fill(), checkpoint(), fill('after-review')])
    const root = await f.publish([
      { id: 'choose', kind: 'branch', url, reviewed: true, branch: { condition: { kind: 'page-url-is', url }, onTrue: 'forms', onFalse: 'other' } },
      { ...call(child.id), nextStepId: null }, fill('other')])
    let replaced = false
    f.after(async execution => { if (!replaced && execution.stepId === 'write') { replaced = true; f.setNavigation('next-same-url-document') } })
    const input = f.invoke(root.id), first = await f.owner().run(input, f.host), leaf = (await f.owner().waitingLeaf(first.id))!
    expect(first.status).toBe('waiting-human'); expect(f.executions[1]?.expectedNavigationId).toBe('document-1')
    await f.owner().recordHumanCheckpoint({ browserId, runId: leaf.id, assetId: leaf.assetId, version: leaf.version }, 'review',
      { pendingCheckpointId: 'review', nextStep: leaf.nextStep, controlBefore: 'human' })
    f.reload(); f.setControl('agent')
    const second = await f.owner().run({ ...input, runId: first.id }, f.host)
    expect(second).toMatchObject({ status: 'waiting-human', nextStep: 1, calls: [{ nextItem: 1 }] })
    expect(f.actions.map(action => action.value)).toEqual(['alpha', 'alpha', 'beta'])
    expect(f.executions.map(execution => execution.stepId)).toEqual(['choose', 'write', 'after-review', 'write'])
    expect(f.executions.slice(2).every(execution => execution.expectedNavigationId === undefined)).toBe(true)
  })

  it('treats an omitted prototype-named call as missing fresh input instead of reading an inherited property', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id, 1, 'constructor')], browserId, [])
    const run = await f.owner().run({ browserId, assetId: root.id, version: 1, parameters: {}, calls: {} }, f.host)
    expect(run).toMatchObject({ status: 'ready', nextStep: 0, warning: expect.stringContaining('fresh call items') })
    expect(f.actions).toEqual([]); expect(f.executions).toEqual([])
  })

  it('portable import preserves callee provenance but never binds a colliding local asset or carries approval', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    const bundle = await f.owner().exportPortable(root.id, root.revision, 1)
    const imported = await f.owner().importPortable(browserTaskImportInput('target-browser', bundle))
    const step = imported.draft.steps[0]!
    expect(step).toMatchObject({ kind: 'subflow', reviewed: false, subflow: { target: { kind: 'imported', source: { assetId: child.id, version: 1 } } } })
    expect(imported.versions).toEqual([]); expect(step.id).not.toBe('forms')
    await expect(f.owner().saveVersion(imported.id, imported.revision)).rejects.toThrow('unbound imported target')
    expect(f.actions).toEqual([])
  })

  it('validates restored parent chains before exposing a cyclic or over-deep run tree', async () => {
    const f = await fixture(), child = await f.publish([fill()]), root = await f.publish([call(child.id)], browserId, [])
    const first = await f.owner().run(f.invoke(root.id), f.host)
    const document = f.store.document!, childRun = document.runs.find(run => run.parent)!, parentRun = document.runs.find(run => run.id === first.id)!
    // A damaged persisted definition can otherwise make both sides of a cycle individually look bound.
    document.assets.find(asset => asset.id === child.id)!.versions[0]!.steps = [call(root.id, 1, 'back')]
    childRun.nextStep = 0; childRun.status = 'ready'; childRun.calls = [{ stepId: 'back', assetId: root.id, version: 1, nextItem: 0, items: [{ id: 'back-item', runId: parentRun.id }] }]
    parentRun.parent = { runId: childRun.id, stepId: 'back', itemId: 'back-item' }; parentRun.nextStep = 0; parentRun.calls![0]!.nextItem = 0
    const before = structuredClone(document)
    await expect(f.reload().inspect(browserId)).rejects.toThrow('could not be restored')
    expect(f.store.document).toEqual(before); expect(f.actions).toHaveLength(2)
  })
})
