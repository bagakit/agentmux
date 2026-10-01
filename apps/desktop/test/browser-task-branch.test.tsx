// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, runBrowserTaskAsset, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import { validateBrowserTaskPath } from '../src/shared/browser-task-path'
import type { BrowserTaskAssetDocument, BrowserTaskContent, BrowserTaskStep, BrowserTaskStepExecution } from '../src/shared/browser-task-assets'
import type { BrowserScriptRunReport } from '../src/shared/contracts'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const url = 'https://generic.invalid/form', otherUrl = 'https://generic.invalid/alternative', browserId = 'branch-browser'
const observed = { scope: { kind: 'page', document: null }, fullObserved: 2, scoped: 2, matched: 2, returned: 2, truncated: false, omittedFrames: [], unlocated: 0,
  work: { axTrees: 1, axNodes: 3, layoutTrees: 0, cdpCommands: 1 } }
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  history: BrowserTaskAssetDocument[] = []
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value); this.history.push(structuredClone(value)) }
}
function steps(kind: 'page-url-is' | 'element-present' = 'page-url-is'): BrowserTaskStep[] {
  return [{ id: 'condition', kind: 'branch', url, reviewed: true, branch: { condition: kind === 'page-url-is' ? { kind, url } : { kind, target: { role: 'button', name: 'Condition target' } }, onTrue: 'true-action', onFalse: 'false-action' } },
    { id: 'true-action', kind: 'click', url, reviewed: true, target: { role: 'button', name: 'True action', ordinal: 1, count: 1 }, nextStepId: null },
    { id: 'false-action', kind: 'navigate', url: otherUrl, reviewed: true }]
}
async function fixture(source = steps()) {
  let sequence = 0, now = 20
  const store = new MemoryStore(), assets = new BrowserTaskAssets(store, { id: () => `branch-${++sequence}`, now: () => now++ })
  const imported = await assets.importRecording({ id: 'real-human-recording', browserId, navigationId: 'recorded-nav', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await assets.edit(imported.id, imported.revision, { ...imported.draft, steps: source })
  const asset = await assets.saveVersion(edited.id, edited.revision)
  let control: 'human' | 'agent' = 'agent', navigationId: string | null = 'actual-nav', pageUrl = url
  let observation: unknown = observed, missingFrames: string[] = [], nodes = [{ ref: '@e1', role: 'button', name: 'Condition target' }, { ref: '@e2', role: 'button', name: 'True action' }]
  let boundAssets = assets
  const actions: unknown[][] = [], issued: BrowserTaskStepExecution[] = []
  let after: ((report: BrowserScriptRunReport, execution: BrowserTaskStepExecution) => Promise<BrowserScriptRunReport> | BrowserScriptRunReport) | undefined
  const runScript = vi.fn(async (id: string, script: string, execution: BrowserTaskStepExecution): Promise<BrowserScriptRunReport> => {
    issued.push(execution)
    const operationId = `original-op-${issued.length}`
    expect(await boundAssets.bindOperation(execution, operationId)).toBe(true)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const result = await new AsyncFunction('pageInfo', 'snapshot', 'click', 'gotoUrl', 'fillInput', script)(
      async () => ({ url: pageUrl, navigationId }), async () => ({ observation, missingFrames, nodes }),
      async (...args: unknown[]) => { actions.push(['click', ...args]) },
      async (...args: unknown[]) => { actions.push(['gotoUrl', ...args]) },
      async (...args: unknown[]) => { actions.push(['fillInput', ...args]) })
    const report: BrowserScriptRunReport = { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: operationId, browserId: id, phase: 'completed', operator: { id: 'source-operator', name: 'Source operator' }, startedAt: 20, summary: 'Actual generated condition observation', url: pageUrl, steps: [] } }
    return after ? await after(report, execution) : report
  })
  const host: BrowserTaskAssetHost = { onRunPrepared: vi.fn(), control: () => control, yieldControl: vi.fn(() => { control = 'human' }), navigationId: () => navigationId, runScript }
  const input = { browserId, assetId: asset.id, version: 1, parameters: {} }
  return { store, assets, asset, host, input, issued, actions, runScript, setUrl: (value: string) => { pageUrl = value }, setNavigation: (value: string | null) => { navigationId = value },
    setObservation: (value: unknown, missing: string[] = []) => { observation = value; missingFrames = missing }, setNodes: (value: typeof nodes) => { nodes = value; if (observation === observed) observation = { ...observed, fullObserved: nodes.length, scoped: nodes.length, matched: nodes.length, returned: nodes.length } },
    bindTo: (value: BrowserTaskAssets) => { boundAssets = value }, returnControl: () => { control = 'agent' }, after: (value: NonNullable<typeof after>) => { after = value } }
}

describe('actual original task runner consumes bounded explicit condition paths', () => {
  it.each(['true', 'false'] as const)('selects only the %s URL path and binds every actual step to its original journal id', async expected => {
    const f = await fixture(); if (expected === 'false') f.setUrl(otherUrl)
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run).toMatchObject({ status: 'completed', nextStep: 3, branchDecisions: [{ stepId: 'condition', navigationId: 'actual-nav', result: expected, nextStepId: `${expected}-action` }],
      stepExecutions: [{ stepId: 'condition', operationId: 'original-op-1' }, { stepId: `${expected}-action`, operationId: 'original-op-2' }] })
    expect(f.actions).toEqual(expected === 'true' ? [['click', '@e2']] : [['gotoUrl', otherUrl]])
    expect(f.issued.map(row => row.stepId)).toEqual(['condition', `${expected}-action`])
    expect(f.store.document?.runs[0]?.branchDecisions).toEqual(run.branchDecisions)
    if (expected === 'true' && process.env.AGENTMUX_BROWSER_TASK_BRANCH_RUN) writeFileSync(process.env.AGENTMUX_BROWSER_TASK_BRANCH_RUN, JSON.stringify({ scope: 'source-original-runner-with-page-double', assetVersion: f.asset.versions[0], run }, null, 2) + '\n')
  })
  it.each([true, false])('uses the complete current semantic observation for element presence=%s', async present => {
    const f = await fixture(steps('element-present')); if (!present) f.setNodes([{ ref: '@e2', role: 'button', name: 'True action' }])
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run.branchDecisions?.map(fact => fact.result)).toEqual([present ? 'true' : 'false'])
    expect(f.actions).toEqual(present ? [['click', '@e2']] : [['gotoUrl', otherUrl]])
  })
  it('unknown/incomplete/empty observation never selects false or sends either action; explicit return only re-observes', async () => {
    const f = await fixture(steps('element-present'))
    f.setObservation({ ...observed, fullObserved: 0 }); f.setNodes([])
    const first = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(first).toMatchObject({ status: 'ready', nextStep: 0, branchDecisions: [{ result: 'unknown' }], warning: expect.stringContaining('No path was chosen') })
    expect(first.branchDecisions?.[0]).not.toHaveProperty('nextStepId'); expect(f.actions).toEqual([])
    await expect(runBrowserTaskAsset(f.assets, { ...f.input, runId: first.id }, f.host)).rejects.toThrow('person has Browser control')
    f.returnControl(); f.setObservation({ ...observed, omittedFrames: ['child'] })
    const again = await runBrowserTaskAsset(f.assets, { ...f.input, runId: first.id }, f.host)
    expect(again.nextStep).toBe(0); expect(again.branchDecisions?.map(fact => fact.result)).toEqual(['unknown']); expect(f.actions).toEqual([])
    f.returnControl(); f.setObservation(observed); f.setNodes([{ ref: '@e2', role: 'button', name: 'True action' }])
    const done = await runBrowserTaskAsset(f.assets, { ...f.input, runId: first.id }, f.host)
    expect(done).toMatchObject({ id: first.id, status: 'completed', branchDecisions: [{ result: 'false' }] })
    expect(f.actions).toEqual([['gotoUrl', otherUrl]])
  })
  it('empty returned nodes cannot manufacture a known absence from inconsistent nonempty observation metadata', async () => {
    const f = await fixture(steps('element-present')); f.setObservation({ ...observed, returned: 0 }); f.setNodes([])
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run.branchDecisions?.map(fact => fact.result)).toEqual(['unknown']); expect(run.nextStep).toBe(0); expect(f.actions).toEqual([])
  })
  it.each(['browserId', 'runId', 'assetId', 'version', 'stepId', 'navigationId'] as const)('rejects a condition result from another %s without a follow-up action', async key => {
    const f = await fixture(); f.after((report, execution) => execution.stepId === 'condition'
      ? { ...report, result: { ...(report.result as object), [key]: key === 'version' ? 2 : 'another-owner' } } : report)
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run.branchDecisions?.map(fact => fact.result)).toEqual(['unknown']); expect(run.nextStep).toBe(0); expect(f.actions).toEqual([])
  })
  it('late navigation/owner loss and stop across observation never run the selected arm', async () => {
    for (const change of ['navigation', 'owner', 'stop'] as const) {
      const f = await fixture(); f.after(async (report, execution) => {
        if (execution.stepId === 'condition') {
          if (change === 'navigation') f.setNavigation('new-document')
          else if (change === 'owner') f.setNavigation(null)
          else await f.assets.stop(execution.runId)
        }
        return report
      })
      const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
      expect(run.status).toBe(change === 'stop' ? 'stopped' : 'ready'); expect(run.nextStep).toBe(0)
      expect(f.store.history.flatMap(document => document.runs.flatMap(run => run.branchDecisions ?? [])).filter(fact => fact.result !== 'unknown')).toEqual([])
      expect(f.actions).toEqual([]); expect(f.issued.map(row => row.stepId)).toEqual(['condition'])
    }
  })
  it('refuses a persisted selected arm after same-URL document change and re-observes instead of replaying', async () => {
    const f = await fixture(), first = await runBrowserTaskAsset(f.assets, { ...f.input, mode: 'step' }, f.host)
    expect(first.nextStep).toBe(1); f.setNavigation('replacement-same-url-document')
    const next = await runBrowserTaskAsset(f.assets, { ...f.input, runId: first.id }, f.host)
    expect(next).toMatchObject({ status: 'ready', nextStep: 0, branchDecisions: [{ result: 'unknown' }] })
    expect(f.actions).toEqual([]); expect(f.issued.map(row => row.stepId)).toEqual(['condition'])
  })
  it('checks the condition document again after selected-cursor save, before sending the action', async () => {
    const f = await fixture(); let changed = false
    f.assets.subscribe(async () => { const run = (await f.assets.state(browserId)).runs[0]; if (!changed && run?.nextStep === 1) { changed = true; f.setNavigation('late-document') } })
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run).toMatchObject({ status: 'ready', nextStep: 0, branchDecisions: [{ result: 'unknown' }] }); expect(f.actions).toEqual([])
    expect(f.issued.map(row => row.stepId)).toEqual(['condition'])
  })
  it('rechecks navigation after the chosen action write-ahead save before dispatch', async () => {
    const f = await fixture(), originalSave = f.store.save.bind(f.store); let selectedSaves = 0
    f.store.save = async document => {
      const run = document.runs[0]
      if (run?.nextStep === 1 && run.status === 'running' && ++selectedSaves === 2) f.setNavigation('changed-during-action-save')
      await originalSave(document)
    }
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(selectedSaves).toBeGreaterThan(1); expect(run.nextStep).toBe(0); expect(run.branchDecisions?.map(fact => fact.result)).toEqual(['unknown'])
    expect(f.actions).toEqual([]); expect(f.issued.map(row => row.stepId)).toEqual(['condition'])
  })
  it('skipping a human checkpoint neither invents approval nor marks the skipped checkpoint as passed', async () => {
    const source = steps(); source.splice(2, 0, { id: 'optional-human', kind: 'checkpoint', url, reviewed: true })
    source[1]!.nextStepId = 'optional-human'
    const f = await fixture(source); f.setUrl(otherUrl)
    const run = await runBrowserTaskAsset(f.assets, f.input, f.host)
    expect(run.status).toBe('completed'); expect(run.humanCheckpoints).toEqual([]); expect(run.warning).toBeUndefined()
    expect(await f.assets.readExactFact({ browserId, runId: run.id, assetId: run.assetId, version: run.version }, 'optional-human')).toEqual({ status: 'not-recorded' })
    expect(f.actions).toEqual([['gotoUrl', otherUrl]])
  })
  it('rejects back edges, missing edges, unreachable steps and branch budget before any page action', async () => {
    const s = steps()
    expect(() => validateBrowserTaskPath([{ ...s[0]!, branch: { ...s[0]!.branch!, onTrue: 'condition' } }, ...s.slice(1)])).toThrow('back edges')
    expect(() => validateBrowserTaskPath([{ ...s[0]!, branch: { ...s[0]!.branch!, onTrue: 'missing' } }, ...s.slice(1)])).toThrow('existing later')
    expect(() => validateBrowserTaskPath([{ ...s[0]!, branch: { ...s[0]!.branch!, onTrue: null } }, ...s.slice(1)])).toThrow('unreachable')
    expect(() => validateBrowserTaskPath(Array.from({ length: 17 }, (_, index) => ({ ...s[0]!, id: `branch-${index}`, branch: { ...s[0]!.branch!, onTrue: index === 16 ? null : `branch-${index + 1}`, onFalse: null } })))).toThrow('budget')
    const f = await fixture(); const draft = { ...f.asset.draft, steps: [{ ...s[0]!, branch: { ...s[0]!.branch!, onFalse: 'missing' } }, ...s.slice(1)] }
    const edited = await f.assets.edit(f.asset.id, f.asset.revision, draft)
    await expect(f.assets.saveVersion(f.asset.id, edited.revision)).rejects.toThrow('existing later'); expect(f.runScript).not.toHaveBeenCalled()
  })
  it('checks the selected segment before its first side effect and never requests secrets for an unselected arm', async () => {
    const f = await fixture()
    const draft: BrowserTaskContent = { ...f.asset.draft, parameters: [{ key: 'fresh', label: 'Chosen input', secret: true }], steps: [
      f.asset.draft.steps[0]!, { ...f.asset.draft.steps[1]!, kind: 'fill', parameterKey: 'fresh', target: { role: 'text input', name: 'Chosen input', ordinal: 1, count: 1 } }, f.asset.draft.steps[2]! ] }
    const edited = await f.assets.edit(f.asset.id, f.asset.revision, draft), asset = await f.assets.saveVersion(f.asset.id, edited.revision)
    f.setNodes([{ ref: '@e2', role: 'text input', name: 'Chosen input' }])
    const chosen = await runBrowserTaskAsset(f.assets, { ...f.input, version: 2 }, f.host)
    expect(chosen).toMatchObject({ status: 'ready', nextStep: 1, warning: expect.stringContaining('fresh value') })
    expect(f.actions).toEqual([]); expect(f.issued.map(row => row.stepId)).toEqual(['condition'])
    const done = await runBrowserTaskAsset(f.assets, { ...f.input, version: 2, runId: chosen.id, parameters: { fresh: 'one-invocation-only' } }, f.host)
    expect(done.status).toBe('completed'); expect(f.actions).toEqual([['fillInput', '@e2', 'one-invocation-only']])
    expect(JSON.stringify(f.store.document)).not.toContain('one-invocation-only'); expect(asset.versions[0]?.steps[1]?.kind).toBe('click')
    f.setUrl(otherUrl)
    const falseRun = await runBrowserTaskAsset(f.assets, { ...f.input, version: 2 }, f.host)
    expect(falseRun.status).toBe('completed'); expect(f.actions.at(-1)).toEqual(['gotoUrl', otherUrl])
  })
  it.each(['operations', 'time'] as const)('enforces the existing run %s budget before sending another observation', async budget => {
    const f = await fixture(); const first = await runBrowserTaskAsset(f.assets, { ...f.input, mode: 'step' }, f.host)
    const persisted = f.store.document!.runs[0]!
    if (budget === 'operations') { persisted.operationIds = Array.from({ length: 128 }, (_, index) => index === 0 ? 'original-op-1' : `retained-op-${index}`) }
    else persisted.executedMillis = 120_000
    const resumed = new BrowserTaskAssets(f.store); f.bindTo(resumed)
    const run = await runBrowserTaskAsset(resumed, { ...f.input, runId: first.id }, f.host)
    expect(run.status).toBe('interrupted'); expect(run.warning).toContain('budget'); expect(f.issued.map(row => row.stepId)).toEqual(['condition']); expect(f.actions).toEqual([])
  })
  it('ordinary owner reload preserves the chosen cursor/path and does not replay a running call', async () => {
    const f = await fixture(); const first = await runBrowserTaskAsset(f.assets, { ...f.input, mode: 'step' }, f.host)
    expect(first).toMatchObject({ status: 'ready', nextStep: 1 })
    const restored = new BrowserTaskAssets(f.store)
    expect((await restored.state(browserId)).runs).toEqual([first]); expect(f.actions).toEqual([])
    f.store.document!.runs[0]!.status = 'running'
    const uncertain = new BrowserTaskAssets(f.store)
    expect((await uncertain.state(browserId)).runs[0]).toMatchObject({ id: first.id, status: 'interrupted', nextStep: 1, branchDecisions: [{ result: 'true' }] })
    await expect(runBrowserTaskAsset(uncertain, { ...f.input, runId: first.id }, f.host)).rejects.toThrow('cannot be continued automatically')
    expect(f.actions).toEqual([])
  })
  it('the original atomic file owner retains the exact selected path and journal mapping after reload', async () => {
    const f = await fixture(), first = await runBrowserTaskAsset(f.assets, { ...f.input, mode: 'step' }, f.host)
    await mkdir(resolve('.tmp'), { recursive: true }); const directory = await mkdtemp(resolve('.tmp/browser-task-branch-store-'))
    try {
      const store = new BrowserTaskAssetFileStore(join(directory, 'assets.json')); await store.save(f.store.document!)
      const restored = new BrowserTaskAssets(store); f.bindTo(restored)
      expect((await restored.state(browserId)).runs).toEqual([first])
      const done = await runBrowserTaskAsset(restored, { ...f.input, runId: first.id }, f.host)
      expect(done.status).toBe('completed'); expect(done.stepExecutions).toEqual([{ stepId: 'condition', operationId: 'original-op-1' }, { stepId: 'true-action', operationId: 'original-op-2' }])
      expect((await store.load())?.runs[0]).toEqual(done); expect(f.actions).toEqual([['click', '@e2']])
    } finally { await rm(directory, { recursive: true }) }
  })
  it('the actual asset editor edits explicit forward paths and displays unknown without collecting either arm input', async () => {
    const f = await fixture(), container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    let saved: BrowserTaskContent | undefined
    const run = await runBrowserTaskAsset(f.assets, { ...f.input, mode: 'step' }, { ...f.host, navigationId: () => null })
    await act(async () => { root.render(createElement(BrowserTaskAssetEditor, { asset: f.asset, recording: null, run,
      onImport: vi.fn(), onSaveDraft: async draft => { saved = draft }, onSaveVersion: vi.fn(), onLocateStep: vi.fn(), onRun: vi.fn(), onStop: vi.fn() })) })
    try {
      expect(container.querySelector('[data-task-condition-result="unknown"]')?.textContent).toContain('no path chosen')
      const selected = container.querySelector<HTMLSelectElement>('[aria-label="Condition 1 false path"]')!; expect(selected.options.length).toBe(3)
      await act(async () => { selected.value = ''; selected.dispatchEvent(new Event('change', { bubbles: true })) })
      const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save draft')!
      await act(async () => { save.click() })
      expect(saved?.steps[0]?.branch?.onFalse).toBe(null); expect(saved?.steps[0]?.reviewed).toBe(false)
      expect(container.querySelector('[aria-label^="Task parameter"]')).toBeNull()
      expect(container.textContent).toContain('Unknown stops here'); expect(container.querySelectorAll('[data-task-step-id]').length).toBe(3)
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})

it('passes the actual cumulative remaining deadline to the next original host call', async () => {
 const f=await fixture();const first=await runBrowserTaskAsset(f.assets,{...f.input,mode:'step'},f.host);
 f.store.document!.runs[0]!.executedMillis=119_975;const resumed=new BrowserTaskAssets(f.store);f.bindTo(resumed);
 let remaining:number|undefined;const original=f.host.runScript;
 f.host.runScript=async (id,script,execution)=>{remaining=execution.deadlineMillis! - performance.now();return original(id,script,execution)};
 const done=await runBrowserTaskAsset(resumed,{...f.input,runId:first.id},f.host);
 expect(done.status).toBe('completed');expect(remaining).toBeGreaterThan(0);expect(remaining).toBeLessThanOrEqual(25);expect(f.actions).toEqual([['click','@e2']]);
});
