import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssets, runBrowserTaskAsset, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument, BrowserTaskAssetRun, BrowserTaskStep } from '../src/shared/browser-task-assets'
import type { BrowserScriptRunReport } from '../src/shared/contracts'
import { executeBrowserTaskControl } from '../src/main/browser-task-control'

const url = 'https://generic.invalid/form', browserId = 'testing-browser'
const target = (name: string) => ({ role: 'button', name, ordinal: 1, count: 1 })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value) }
}
function assets() {
  let sequence = 0, now = 10
  return new BrowserTaskAssets(new MemoryStore(), { id: () => `testing-${++sequence}`, now: () => now++ })
}
async function draft(owner: BrowserTaskAssets, steps: BrowserTaskStep[]) {
  const imported = await owner.importRecording({ id: 'real-recording', browserId, navigationId: 'nav', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  return owner.edit(imported.id, imported.revision, { ...imported.draft, steps })
}
async function version(steps: BrowserTaskStep[], owner = assets()) {
  const edited = await draft(owner, steps)
  return owner.saveVersion(edited.id, edited.revision)
}

describe('testing steps are parsed and validated with the existing forward path rules', () => {
  it('keeps every declared testing step and its failure handling through edit and version save', async () => {
    const steps: BrowserTaskStep[] = [
      { id: 'wait', kind: 'wait', url, reviewed: true, wait: { kind: 'element-present', target: { role: 'button', name: 'Ready' } }, timeoutMs: 2_000 },
      { id: 'assert', kind: 'assert', url, reviewed: true, assert: { kind: 'text-present', text: 'Saved' }, retry: 2, onFail: { goto: 'scroll' } },
      { id: 'press', kind: 'press', url, reviewed: true, target: target('Search'), key: 'Enter', onFail: 'continue' },
      { id: 'hover', kind: 'hover', url, reviewed: true, target: target('Menu'), onFail: 'stop' },
      { id: 'scroll', kind: 'scroll', url, reviewed: true, target: target('Footer') }
    ]
    const saved = await version(steps)
    expect(saved.versions[0]!.steps).toEqual(steps)
  })

  it('rejects a failure jump to an earlier or missing step when a version is saved', async () => {
    for (const goto of ['first', 'missing']) {
      const owner = assets()
      const edited = await draft(owner, [
        { id: 'first', kind: 'click', url, reviewed: true, target: target('One') },
        { id: 'second', kind: 'assert', url, reviewed: true, assert: { kind: 'url-is', url }, onFail: { goto } }
      ])
      await expect(owner.saveVersion(edited.id, edited.revision)).rejects.toThrow(/later step|back edges/)
    }
  })

  it.each([-1, 4, 1.5])('rejects retry %s outside 0-3', async retry => {
    await expect(draft(assets(), [{ id: 'one', kind: 'click', url, reviewed: true, target: target('One'), retry }])).rejects.toThrow(/retry must be 0-3/)
  })

  it.each<[string, Partial<BrowserTaskStep>, RegExp]>([
    ['wait without timeout', { kind: 'wait', wait: { kind: 'url-is', url } }, /wait step declares its condition and timeout/],
    ['wait over the per-call budget', { kind: 'wait', wait: { kind: 'url-is', url }, timeoutMs: 25_001 }, /Wait timeout must be 1-25000/],
    ['assert without its fact', { kind: 'assert' }, /assert step declares its expected page fact/],
    ['assert with empty text', { kind: 'assert', assert: { kind: 'text-present', text: ' ' } }, /Invalid assertion/],
    ['press without a key', { kind: 'press', target: target('Search') }, /press step declares its key/],
    ['key on a click', { kind: 'click', target: target('One'), key: 'Enter' }, /press step declares its key/],
    ['retry on a checkpoint', { kind: 'checkpoint', retry: 1 }, /failure handling belongs to page steps/],
    ['unknown failure handling', { kind: 'click', target: target('One'), onFail: 'skip' as never }, /stop, continue or goto/]
  ])('rejects %s', async (_name, step, reason) => {
    await expect(draft(assets(), [{ id: 'one', url, reviewed: true, ...step } as BrowserTaskStep])).rejects.toThrow(reason)
  })

  it('keeps fill parameter rules unchanged next to the new steps', async () => {
    await expect(draft(assets(), [{ id: 'fill', kind: 'fill', url, reviewed: true, target: target('Name'), parameterKey: 'undeclared' }])).rejects.toThrow(/parameter is not defined/)
  })
})

type PageNode = { role: string; name: string }
/** Runs the actual generated step script against a page made of the real injected page function names. */
function page(initial: PageNode[]) {
  let clock = 1_000, operation = 0
  const state = { url, navigationId: 'nav-1', snapshotNavigationId: undefined as string | undefined, nodes: initial, truncated: false, onWait: (_waited: number) => {} }
  const calls: { method: string; args: unknown[] }[] = []
  const failures: string[] = []
  let current: { method: string; args: unknown[] }[] = []
  const record = (method: string) => async (...args: unknown[]) => { const call = { method, args }; calls.push(call); current.push(call) }
  const functions: Record<string, (...args: any[]) => Promise<unknown>> = {
    pageInfo: async () => { await record('pageInfo')(); return { url: state.url, title: 'Form', navigationId: state.navigationId } },
    snapshot: async (query: unknown) => {
      await record('snapshot')(query)
      const nodes = state.nodes.map((node, index) => ({ ref: `@e${index + 1}`, ...node }))
      const count = nodes.length
      return { url: state.url, title: 'Form', navigationId: state.snapshotNavigationId ?? state.navigationId, nodes, missingFrames: [],
        observation: { scope: { kind: 'page', document: null }, fullObserved: count, scoped: count, matched: count, returned: count, truncated: state.truncated, omittedFrames: [] } }
    },
    wait: async (ms: number) => { await record('wait')(ms); clock += ms; state.onWait(clock - 1_000) },
    ...Object.fromEntries(['click', 'fillInput', 'gotoUrl', 'pressKey', 'hover', 'scroll'].map(name => [name, record(name)]))
  }
  const runScript = vi.fn(async (id: string, script: string): Promise<BrowserScriptRunReport> => {
    current = []
    const names = Object.keys(functions)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    let completed = true, message = ''
    try { await new AsyncFunction(...names, '"use strict";\n' + script)(...names.map(name => functions[name])) }
    catch (error) { completed = false; message = error instanceof Error ? error.message : String(error); failures.push(message) }
    finally { now.mockRestore() }
    return { result: undefined, logs: [], outcome: completed ? { kind: 'completed' } : { kind: 'script-failed', message },
      runOperation: { id: `real-operation-${++operation}`, browserId: id, phase: completed ? 'completed' : 'failed', operator: { id: 'person', name: 'Person' }, startedAt: 1, summary: 'Generated step', url: state.url,
        steps: current.map((call, index) => ({ sequence: index + 1, method: call.method, status: 'completed' })) } }
  })
  const host: BrowserTaskAssetHost = { onRunPrepared: vi.fn(), runScript, yieldControl: vi.fn(), control: () => 'agent' }
  return { host, calls, failures, runScript, state, waited: () => clock - 1_000 }
}
async function execute(steps: BrowserTaskStep[], fake: ReturnType<typeof page>) {
  const owner = assets(), saved = await version(steps, owner)
  return runBrowserTaskAsset(owner, { assetId: saved.id, version: 1, browserId, parameters: {} }, fake.host)
}
const ACTIONS = new Set(['click', 'fillInput', 'gotoUrl', 'pressKey', 'hover', 'scroll'])
const actions = (fake: ReturnType<typeof page>) => fake.calls.filter(call => ACTIONS.has(call.method))

describe('testing steps compile to existing Browser page calls', () => {
  it('sends press, hover and scroll as exactly one page function on the reviewed unique target', async () => {
    const fake = page([{ role: 'button', name: 'Search' }, { role: 'button', name: 'Menu' }, { role: 'button', name: 'Footer' }])
    const run = await execute([
      { id: 'press', kind: 'press', url, reviewed: true, target: target('Search'), key: 'Enter' },
      { id: 'hover', kind: 'hover', url, reviewed: true, target: target('Menu') },
      { id: 'scroll', kind: 'scroll', url, reviewed: true, target: target('Footer') }
    ], fake)
    expect(run).toMatchObject({ status: 'completed', nextStep: 3, operationIds: ['real-operation-1', 'real-operation-2', 'real-operation-3'] })
    expect(actions(fake)).toEqual([{ method: 'pressKey', args: ['@e1', 'Enter'] }, { method: 'hover', args: ['@e2'] }, { method: 'scroll', args: ['@e3'] }])
  })

  it('refuses a page action whose target is unknown before any Browser call, while wait and assert need no element target', async () => {
    const fake = page([{ role: 'button', name: 'Search' }])
    await expect(execute([{ id: 'press', kind: 'press', url, reviewed: true, key: 'Enter' }], fake)).rejects.toThrow('unknown or ambiguous')
    expect(fake.runScript).not.toHaveBeenCalled()
    const run = await execute([
      { id: 'wait', kind: 'wait', url, reviewed: true, wait: { kind: 'element-present', target: { role: 'button', name: 'Search' } }, timeoutMs: 1_000 },
      { id: 'assert', kind: 'assert', url, reviewed: true, assert: { kind: 'element-present', target: { role: 'button', name: 'Search' } } }
    ], fake)
    expect(run).toMatchObject({ status: 'completed', nextStep: 2 })
  })

  it('polls a wait with read-only page calls until its element appears, then runs the next step', async () => {
    const fake = page([{ role: 'button', name: 'Continue' }])
    fake.state.onWait = waited => { if (waited >= 700) fake.state.nodes = [{ role: 'button', name: 'Continue' }, { role: 'status', name: 'Ready' }] }
    const run = await execute([
      { id: 'wait', kind: 'wait', url, reviewed: true, wait: { kind: 'element-present', target: { role: 'status', name: 'Ready' } }, timeoutMs: 5_000 },
      { id: 'click', kind: 'click', url, reviewed: true, target: target('Continue') }
    ], fake)
    expect(run).toMatchObject({ status: 'completed', nextStep: 2 })
    const waitCalls = fake.calls.slice(0, fake.calls.findIndex(call => call.method === 'click'))
    expect(new Set(waitCalls.map(call => call.method))).toEqual(new Set(['pageInfo', 'snapshot', 'wait']))
    expect(fake.waited()).toBeGreaterThanOrEqual(700)
    expect(fake.waited()).toBeLessThan(5_000)
    expect(actions(fake)).toEqual([{ method: 'click', args: ['@e1'] }])
  })

  it('ends a wait that does not hold within its timeout as a script failure naming the step, without any page action', async () => {
    const fake = page([{ role: 'button', name: 'Continue' }])
    const run = await execute([
      { id: 'wait', kind: 'wait', url, label: 'Wait for receipt', reviewed: true, wait: { kind: 'url-is', url: 'https://generic.invalid/receipt' }, timeoutMs: 1_000 },
      { id: 'click', kind: 'click', url, reviewed: true, target: target('Continue') }
    ], fake)
    expect(run).toMatchObject({ status: 'failed', nextStep: 0, operationIds: ['real-operation-1'] })
    expect(fake.failures).toEqual(['Task step "Wait for receipt" wait did not hold within 1000 ms: the page URL is not the expected URL.'])
    expect(fake.waited()).toBe(1_000)
    expect(actions(fake)).toEqual([])
  })

  it.each<[string, BrowserTaskStep['assert'], (fake: ReturnType<typeof page>) => void, string | null]>([
    ['text present', { kind: 'text-present', text: 'Saved' }, () => {}, null],
    ['text absent from a complete page', { kind: 'text-present', text: 'Missing' }, () => {}, 'assert failed: the text is absent.'],
    ['element absent from a complete page', { kind: 'element-absent', target: { role: 'alert', name: 'Error' } }, () => {}, null],
    ['element present when it must be absent', { kind: 'element-absent', target: { role: 'status', name: 'Saved draft' } }, () => {}, 'assert failed: the element is present.'],
    ['absence on a truncated observation', { kind: 'element-absent', target: { role: 'alert', name: 'Error' } }, fake => { fake.state.truncated = true }, 'could not be proven'],
    ['presence observed on another document', { kind: 'element-present', target: { role: 'status', name: 'Saved draft' } }, fake => { fake.state.snapshotNavigationId = 'nav-2' }, 'could not be proven'],
    ['another page URL', { kind: 'url-is', url: 'https://generic.invalid/receipt' }, () => {}, 'assert failed: the page URL is not https://generic.invalid/receipt.']
  ])('asserts %s from one read-only observation', async (_name, assert, prepare, failure) => {
    const fake = page([{ role: 'status', name: 'Saved draft' }]); prepare(fake)
    const run = await execute([{ id: 'assert', kind: 'assert', url, label: 'Check result', reviewed: true, assert }], fake)
    expect(run.status).toBe(failure ? 'failed' : 'completed')
    if (failure) expect(fake.failures[0]).toContain(`Task step "Check result" ${failure.startsWith('could') ? 'assert ' : ''}${failure}`)
    else expect(fake.failures).toEqual([])
    expect(new Set(fake.calls.map(call => call.method))).toEqual(new Set(assert!.kind === 'url-is' ? ['pageInfo'] : ['pageInfo', 'snapshot']))
  })
})

describe('per-step failure handling uses only known script failures', () => {
  const failingAssert = (extra: Partial<BrowserTaskStep> = {}): BrowserTaskStep =>
    ({ id: 'check', kind: 'assert', url, label: 'Check saved', reviewed: true, assert: { kind: 'text-present', text: 'Saved' }, ...extra })
  const click = (id: string, name: string): BrowserTaskStep => ({ id, kind: 'click', url, reviewed: true, target: target(name) })

  it('retries a failing assert twice with fresh calls, records every real operation, then stops as script-failed naming the step', async () => {
    const fake = page([{ role: 'button', name: 'Next' }])
    const run = await execute([failingAssert({ retry: 2 }), click('next', 'Next')], fake)
    expect(fake.runScript).toHaveBeenCalledTimes(3)
    expect(run).toMatchObject({ status: 'failed', nextStep: 0, operationIds: ['real-operation-1', 'real-operation-2', 'real-operation-3'],
      stepExecutions: [1, 2, 3].map(n => ({ stepId: 'check', operationId: `real-operation-${n}` })) })
    expect(run.warning).toBe('Task step "Check saved" failed (script-failed) after 3 attempts. Earlier steps remain; inspect operation real-operation-3 before another action.')
    expect(run.failedSteps).toBeUndefined()
    expect(actions(fake)).toEqual([])
  })

  it('moves on after a retry that holds, and the run completes', async () => {
    const fake = page([{ role: 'button', name: 'Next' }])
    fake.runScript.mockImplementationOnce(async (id, script) => { const report = await fake.runScript.getMockImplementation()!(id, script, {} as never); fake.state.nodes = [...fake.state.nodes, { role: 'status', name: 'Saved' }]; return report })
    const run = await execute([failingAssert({ retry: 1 }), click('next', 'Next')], fake)
    expect(run).toMatchObject({ status: 'completed', nextStep: 2, operationIds: ['real-operation-1', 'real-operation-2', 'real-operation-3'] })
    expect(actions(fake)).toEqual([{ method: 'click', args: ['@e1'] }])
  })

  it('continues after a failed step but records it, warns, and never reports the run as completed', async () => {
    const fake = page([{ role: 'button', name: 'Next' }])
    const run = await execute([failingAssert({ onFail: 'continue' }), click('next', 'Next')], fake)
    expect(actions(fake)).toEqual([{ method: 'click', args: ['@e1'] }])
    expect(run).toMatchObject({ status: 'failed', nextStep: 2, failedSteps: [{ stepId: 'check', operationId: 'real-operation-1' }] })
    expect(run.warning).toContain('failed steps: "Check saved" (operation real-operation-1)')
    expect(run.warning).toContain('not a success')
  })

  it('jumps forward to the declared failure step and skips the steps between', async () => {
    const fake = page([{ role: 'button', name: 'Skipped' }, { role: 'button', name: 'Report' }])
    const run = await execute([failingAssert({ onFail: { goto: 'report' } }), click('skipped', 'Skipped'), click('report', 'Report')], fake)
    expect(actions(fake)).toEqual([{ method: 'click', args: ['@e2'] }])
    expect(run).toMatchObject({ status: 'failed', nextStep: 3, failedSteps: [{ stepId: 'check', operationId: 'real-operation-1' }] })
  })

  it('never retries an attempt whose operation already dispatched a page action', async () => {
    const fake = page([{ role: 'button', name: 'Pay' }])
    fake.runScript.mockImplementationOnce(async id => ({ result: undefined, logs: [], outcome: { kind: 'script-failed', message: 'thrown after the click' },
      runOperation: { id: 'real-operation-pay', browserId: id, phase: 'failed', operator: { id: 'person', name: 'Person' }, startedAt: 1, summary: 'Generated step', url,
        steps: [{ sequence: 1, method: 'snapshot', status: 'completed' }, { sequence: 2, method: 'click', status: 'completed' }] } }))
    const run = await execute([{ ...click('pay', 'Pay'), retry: 3, onFail: 'continue' }], fake)
    expect(fake.runScript).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ status: 'failed', operationIds: ['real-operation-pay'], failedSteps: [{ stepId: 'pay', operationId: 'real-operation-pay' }] })
  })

  it.each<['stopped' | 'indeterminate', BrowserTaskAssetRun['status']]>([['stopped', 'stopped'], ['indeterminate', 'interrupted']])(
    'neither retries nor continues a %s result', async (kind, status) => {
      const fake = page([{ role: 'button', name: 'Next' }])
      fake.runScript.mockImplementationOnce(async id => ({ result: undefined, logs: [], outcome: { kind, message: 'not a known script failure' },
        runOperation: { id: 'real-operation-unknown', browserId: id, phase: kind, operator: { id: 'person', name: 'Person' }, startedAt: 1, summary: 'Generated step', url, steps: [] } }))
      const run = await execute([failingAssert({ retry: 3, onFail: 'continue' }), click('next', 'Next')], fake)
      expect(fake.runScript).toHaveBeenCalledTimes(1)
      expect(run).toMatchObject({ status, nextStep: 0, operationIds: ['real-operation-unknown'] })
      expect(run.failedSteps).toBeUndefined()
      expect(actions(fake)).toEqual([])
    })

  it('treats a Browser call without a known result as interrupted and never retries it', async () => {
    const fake = page([{ role: 'button', name: 'Next' }])
    fake.runScript.mockRejectedValueOnce(new Error('connection lost'))
    const run = await execute([failingAssert({ retry: 3, onFail: 'continue' }), click('next', 'Next')], fake)
    expect(fake.runScript).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({ status: 'interrupted', nextStep: 0, operationIds: [] })
  })

  it('keeps recorded failed steps through a restart and rejects ones not bound to a real execution', async () => {
    const store = new MemoryStore(), owner = new BrowserTaskAssets(store, { id: (() => { let n = 0; return () => `restart-${++n}` })(), now: (() => { let n = 10; return () => n++ })() })
    const saved = await version([failingAssert({ onFail: 'continue' }), click('next', 'Next')], owner)
    const run = await runBrowserTaskAsset(owner, { assetId: saved.id, version: 1, browserId, parameters: {} }, page([{ role: 'button', name: 'Next' }]).host)
    const restarted = await new BrowserTaskAssets(store).state(browserId)
    expect(restarted.runs.find(item => item.id === run.id)?.failedSteps).toEqual([{ stepId: 'check', operationId: 'real-operation-1' }])
    store.document!.runs[0]!.failedSteps = [{ stepId: 'check', operationId: 'real-operation-2' }]
    expect((await new BrowserTaskAssets(store).state(browserId)).warning).toContain('could not be restored')
  })
})

describe('public browser.task run carries the recorded failure', () => {
  it('passes a continued failure from the real run owner through the public control codec as failed with failedSteps', async () => {
    const owner = assets(), fake = page([{ role: 'button', name: 'Next' }])
    const saved = await version([
      { id: 'check', kind: 'assert', url, reviewed: true, assert: { kind: 'text-present', text: 'Saved' }, onFail: 'continue' },
      { id: 'next', kind: 'click', url, reviewed: true, target: target('Next') }
    ], owner)
    const result = await executeBrowserTaskControl({ operation: 'browser.task.run', browserId, assetId: saved.id, version: 1, parameters: {} }, {
      runControlledTaskAsset: input => runBrowserTaskAsset(owner, input, fake.host)
    } as Parameters<typeof executeBrowserTaskControl>[1], true)
    expect(result).toMatchObject({ operation: 'browser.task.run', run: { status: 'failed', failedSteps: [{ stepId: 'check', operationId: 'real-operation-1' }] } })
  })
})
