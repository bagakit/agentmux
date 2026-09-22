// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, runBrowserTaskAsset, type BrowserTaskAssetHost, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskContent } from '../src/shared/browser-task-assets'
import type { BrowserDemonstrationDraft } from '../src/shared/browser-demonstration'
import type { BrowserScriptRunReport } from '../src/shared/contracts'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const observed = { scope: { kind: 'page', document: null }, fullObserved: 2, scoped: 2, matched: 2, returned: 2, truncated: false, omittedFrames: [], unlocated: 0, work: { axTrees: 1, axNodes: 2, layoutTrees: 0, cdpCommands: 1 } }
const recording = (): BrowserDemonstrationDraft => ({ id: 'recording-1', browserId: 'browser-1', navigationId: 'nav-1', url: 'https://example.test/form?private=raw-secret', revision: 2, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [
  { id: 'click-1', sequence: 1, navigationId: 'nav-1', recordedAt: 2, source: 'native-human', method: 'click', url: 'https://example.test/form', target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 }, args: [], blockedReason: 'Review this demonstrated click' },
  { id: 'fill-2', sequence: 2, navigationId: 'nav-1', recordedAt: 3, source: 'native-human', method: 'fillInput', url: 'https://example.test/form', target: { role: 'text input', name: 'Name', ordinal: 1, count: 1 }, args: ['raw-secret'], inputKey: 'input-2', blockedReason: 'Supply a fresh parameter' }
] })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  unavailable = false
  saves = 0
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) { this.saves += 1; if (this.unavailable) throw new Error('Disk unavailable'); this.document = structuredClone(document) }
}
function setup(store = new MemoryStore()) {
  let count = 0, at = 10
  return { store, assets: new BrowserTaskAssets(store, { id: () => `asset-or-run-${++count}`, now: () => at++ }) }
}
async function saved(assets: BrowserTaskAssets, transform: (draft: BrowserTaskContent) => BrowserTaskContent = draft => draft): Promise<BrowserTaskAsset> {
  const imported = await assets.importRecording(recording())
  const edited = await assets.edit(imported.id, imported.revision, transform({ ...imported.draft, steps: imported.draft.steps.map(step => ({ ...step, reviewed: true })) }))
  return assets.saveVersion(edited.id, edited.revision)
}
function host() {
  let control: 'human' | 'agent' = 'agent', sequence = 0
  const calls: { method: string; args: unknown[] }[] = []
  let observation: unknown = structuredClone(observed), missingFrames: unknown[] = []
  let url = 'https://example.test/form'
  const runScript = vi.fn(async (browserId: string, script: string): Promise<BrowserScriptRunReport> => {
    const names = ['pageInfo', 'snapshot', 'click', 'fillInput', 'gotoUrl']
    const page = {
      pageInfo: async () => ({ url }),
      snapshot: async (query: unknown) => { calls.push({ method: 'snapshot', args: [query] }); return { observation, missingFrames, nodes: [
        { ref: `@e${++sequence}`, role: 'button', name: 'Continue' }, { ref: `@e${++sequence}`, role: 'text input', name: 'Name' }
      ] } },
      click: async (...args: unknown[]) => calls.push({ method: 'click', args }),
      fillInput: async (...args: unknown[]) => calls.push({ method: 'fillInput', args }),
      gotoUrl: async (destination: string) => { calls.push({ method: 'gotoUrl', args: [destination] }); url = destination }
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    let result: unknown, completed = true
    try { result = await new AsyncFunction(...names, '"use strict";\n' + script)(...names.map(name => page[name as keyof typeof page])) }
    catch { completed = false }
    return { result, logs: [], outcome: completed ? { kind: 'completed' } : { kind: 'script-failed', message: 'The actual generated script refused this page' }, runOperation: {
      id: `real-operation-${runScript.mock.calls.length}`, browserId, phase: completed ? 'completed' : 'failed', operator: { id: 'person', name: 'Person' }, startedAt: 1, summary: 'Actual generated script', url, steps: []
    } }
  })
  const owner: BrowserTaskAssetHost = { onRunPrepared: vi.fn(), runScript, yieldControl: vi.fn(() => { control = 'human' }), control: () => control }
  return { owner, calls, runScript, returnControl: () => { control = 'agent' }, setObservation: (next: unknown, missing: unknown[] = []) => { observation = next; missingFrames = missing } }
}

describe('versioned Browser task assets', () => {
  it('imports semantic metadata only and never retains recording args, values or URL details', async () => {
    const s = setup(), asset = await s.assets.importRecording(recording())
    expect(asset.draft.steps.map(step => step.kind)).toEqual(['click', 'fill'])
    expect(asset.draft.parameters).toEqual([{ key: 'input-2', label: 'input-2', secret: true }])
    expect(asset.draft.steps.map(step => step.reviewed)).toEqual([false, false])
    expect(JSON.stringify(s.store.document)).not.toContain('raw-secret')
    expect(asset.draft.url).toBe('https://example.test/form')
  })
  it('keeps a deliberately empty edited draft empty, rejects stale edits and never rebuilds deleted steps from recording', async () => {
    const s = setup(), asset = await s.assets.importRecording(recording())
    const edited = await s.assets.edit(asset.id, asset.revision, { ...asset.draft, steps: [] })
    await expect(s.assets.edit(asset.id, asset.revision, asset.draft)).rejects.toThrow('draft changed')
    await expect(s.assets.saveVersion(asset.id, edited.revision)).rejects.toThrow('no steps')
    expect((await s.assets.get(asset.id))?.draft.steps).toEqual([])
    const restarted = setup(s.store).assets
    expect((await restarted.get(asset.id))?.draft.steps).toEqual([])
  })
  it('executes exactly the selected immutable version while edits and later versions stay separate', async () => {
    const s = setup(), first = await saved(s.assets), h = host()
    const edited = await s.assets.edit(first.id, first.revision, { ...first.draft, name: 'Only fill now', steps: first.draft.steps.slice(1) })
    const second = await s.assets.saveVersion(first.id, edited.revision)
    const run = await runBrowserTaskAsset(s.assets, { assetId: first.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'fresh-secret' } }, h.owner)
    expect(h.calls.filter(call => call.method !== 'snapshot').map(call => call.method)).toEqual(['click', 'fillInput'])
    expect(run).toMatchObject({ version: 1, nextStep: 2, status: 'completed', operationIds: ['real-operation-1', 'real-operation-2'] })
    expect(second.versions.map(version => version.steps.length)).toEqual([2, 1])
    expect(h.runScript.mock.calls.map(call => call[1]).join('\n')).not.toContain(first.id)
    expect(JSON.stringify(s.store.document)).not.toContain('fresh-secret')
  })
  it('hands a checkpoint to the existing control owner and resumes only later steps after explicit return, including restart', async () => {
    const s = setup(), asset = await saved(s.assets, draft => ({ ...draft, steps: [draft.steps[0]!, { id: 'checkpoint-1', kind: 'checkpoint', url: draft.url, reviewed: true }, draft.steps[1]!] })), h = host()
    const paused = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {} }, h.owner)
    expect(paused).toMatchObject({ nextStep: 2, status: 'waiting-human', pendingCheckpointId: 'checkpoint-1', operationIds: ['real-operation-1'] })
    expect(h.owner.yieldControl).toHaveBeenCalledExactlyOnceWith('browser-1')
    const restarted = setup(s.store).assets
    const input = { assetId: asset.id, version: 1, browserId: 'browser-1', runId: paused.id, parameters: { 'input-2': 'after-checkpoint' } }
    await expect(runBrowserTaskAsset(restarted, input, h.owner)).rejects.toThrow('person has Browser control')
    expect(h.runScript).toHaveBeenCalledTimes(1)
    h.returnControl()
    const finished = await runBrowserTaskAsset(restarted, input, h.owner)
    expect(finished).toMatchObject({ nextStep: 3, status: 'completed', operationIds: ['real-operation-1', 'real-operation-2'] })
    expect(h.calls.filter(call => call.method !== 'snapshot').map(call => call.method)).toEqual(['click', 'fillInput'])
    expect(finished.pendingCheckpointId).toBeUndefined()
  })
  it('runs one next step and continues with the same pinned version without replaying the completed step', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    const first = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {}, mode: 'step' }, h.owner)
    expect(first).toMatchObject({ nextStep: 1, status: 'ready' })
    const finished = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'one-use' }, runId: first.id }, h.owner)
    expect(finished).toMatchObject({ nextStep: 2, status: 'completed' })
    expect(h.calls.filter(call => call.method !== 'snapshot').map(call => call.method)).toEqual(['click', 'fillInput'])
  })
  it('refuses unreviewed, unknown and ambiguous targets without calling the Browser action owner', async () => {
    for (const alteration of ['unreviewed', 'unknown', 'ambiguous'] as const) {
      const s = setup(), asset = await saved(s.assets, draft => {
        const { target: _target, ...unknown } = draft.steps[0]!
        const step = alteration === 'unknown' ? unknown : { ...draft.steps[0]!, ...(alteration === 'unreviewed'
          ? { reviewed: false } : { target: { role: 'button', name: 'Continue', ordinal: 1, count: 2 } }) }
        return { ...draft, steps: [step] }
      }), h = host()
      await expect(runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {} }, h.owner)).rejects.toThrow(alteration === 'unreviewed' ? 'Review the demonstrated step' : 'unknown or ambiguous')
      expect(h.runScript).not.toHaveBeenCalled()
    }
  })
  it('rejects incomplete scoped observations before a semantic action and keeps the real failure operation', async () => {
    const s = setup(), asset = await saved(s.assets, draft => ({ ...draft, steps: [draft.steps[0]!] }))
    for (const [metadata, missing] of [[{ ...observed, truncated: true }, []], [{ ...observed, scope: { kind: 'viewport', document: null } }, []], [{ ...observed, omittedFrames: ['frame-2'] }, []], [observed, ['frame-2']]] as const) {
      const h = host(); h.setObservation(metadata, [...missing])
      const result = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {} }, h.owner)
      expect(result).toMatchObject({ status: 'failed', nextStep: 0, operationIds: ['real-operation-1'] })
      expect(h.calls).toEqual([{ method: 'snapshot', args: [{ maxNodes: 1000 }] }])
    }
  })
  it('checks the entire current segment before its first action, while a single step may finish before a later blocked step', async () => {
    const s = setup(), asset = await saved(s.assets, draft => ({ ...draft, steps: [draft.steps[0]!, { ...draft.steps[1]!, reviewed: false }] })), h = host()
    const input = { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'temporary' } }
    await expect(runBrowserTaskAsset(s.assets, input, h.owner)).rejects.toThrow('Review the demonstrated step')
    expect(h.runScript).not.toHaveBeenCalled()
    expect((await s.assets.state()).runs).toEqual([])
    const first = await runBrowserTaskAsset(s.assets, { ...input, mode: 'step' }, h.owner)
    expect(first).toMatchObject({ status: 'ready', nextStep: 1, operationIds: ['real-operation-1'] })
    await expect(runBrowserTaskAsset(s.assets, { ...input, runId: first.id }, h.owner)).rejects.toThrow('Review the demonstrated step')
    expect(h.runScript).toHaveBeenCalledTimes(1)
    expect((await s.assets.state()).runs).toEqual([first])
  })
  it('requires current-segment parameters and rejects mismatched Browser, version or continuation identity before action', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    await expect(runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {} }, h.owner)).rejects.toThrow('fresh value')
    await expect(runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 2, browserId: 'browser-1', parameters: {} }, h.owner)).rejects.toThrow('version is unavailable')
    await expect(runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-other', parameters: {} }, h.owner)).rejects.toThrow('another Browser')
    expect(h.runScript).not.toHaveBeenCalled()
  })
  it('pins transient parameters for this invocation and rejects attempts to continue a different version', async () => {
    const s = setup(), asset = await saved(s.assets, draft => ({ ...draft, steps: [draft.steps[1]!, { ...draft.steps[1]!, id: 'fill-3' }] })), h = host()
    const values = { 'input-2': 'original-one-use' }
    const original = h.owner.runScript
    h.owner.runScript = async (...args) => { const report = await original(...args); values['input-2'] = 'changed-after-start'; return report }
    const result = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: values }, h.owner)
    expect(result.status).toBe('completed')
    expect(h.calls.filter(call => call.method === 'fillInput').map(call => call.args[1])).toEqual(['original-one-use', 'original-one-use'])
    const s2 = setup(), secondAsset = await saved(s2.assets), firstStep = await runBrowserTaskAsset(s2.assets, { assetId: secondAsset.id, version: 1, browserId: 'browser-1', parameters: {}, mode: 'step' }, host().owner)
    const newer = await s2.assets.saveVersion(secondAsset.id, secondAsset.revision)
    const noActions = host()
    await expect(runBrowserTaskAsset(s2.assets, { assetId: secondAsset.id, version: newer.versions[1]!.version, browserId: 'browser-1', parameters: { 'input-2': 'fresh' }, runId: firstStep.id }, noActions.owner)).rejects.toThrow('continuation identity changed')
    expect(noActions.runScript).not.toHaveBeenCalled()
  })
  it('publishes the changed Browser only, exposes the write-ahead cursor and tolerates a failed projection listener', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    const changed: string[] = [], running: string[] = []
    const stop = s.assets.subscribe(browserId => { changed.push(browserId) })
    const stopFailing = s.assets.subscribe(() => { throw new Error('Renderer projection unavailable') })
    const stopAsyncFailing = s.assets.subscribe(async () => { throw new Error('Renderer projection async read unavailable') })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const original = h.owner.runScript
    h.owner.runScript = async (...args) => { running.push((await s.assets.state('browser-1')).runs[0]!.status); return original(...args) }
    const result = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'temporary' } }, h.owner)
    expect(result.status).toBe('completed')
    expect(changed.length).toBeGreaterThan(0)
    expect(new Set(changed)).toEqual(new Set(['browser-1']))
    expect(running).toEqual(['running', 'running'])
    await new Promise(done => setTimeout(done, 20))
    process.removeListener('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
    stop(); stopFailing(); stopAsyncFailing()
    const count = changed.length
    await s.assets.edit(asset.id, asset.revision, asset.draft)
    expect(changed.length).toBe(count)
  })
  it('marks an in-flight durable cursor interrupted on restart and never runs a Browser or silently retries it', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done }), paused = new Promise<void>(done => { release = done })
    const original = h.owner.runScript
    h.owner.runScript = async (...args) => { entered(); await paused; return original(...args) }
    const running = runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'memory-only' }, mode: 'step' }, h.owner)
    await waiting
    const restarted = setup(s.store).assets, state = await restarted.state()
    expect(state.runs).toEqual([expect.objectContaining({ status: 'interrupted', nextStep: 0, operationIds: [] })])
    await expect(runBrowserTaskAsset(restarted, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {}, runId: state.runs[0]!.id }, h.owner)).rejects.toThrow('cannot be continued automatically')
    expect(h.runScript).not.toHaveBeenCalled()
    release(); await running
  })
  it('keeps a stop during an in-flight action terminal, retaining the completed action without running the next one', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done }), paused = new Promise<void>(done => { release = done })
    const original = h.owner.runScript
    h.owner.runScript = async (...args) => { entered(); await paused; return original(...args) }
    const running = runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'one-use' } }, h.owner)
    await waiting
    const current = (await s.assets.state()).runs[0]!
    await s.assets.stop(current.id); release()
    const stopped = await running
    expect(stopped).toMatchObject({ status: 'stopped', nextStep: 1, operationIds: ['real-operation-1'] })
    expect(h.calls.filter(call => call.method !== 'snapshot').map(call => call.method)).toEqual(['click'])
  })
  it.each(['click', 'checkpoint'] as const)('keeps the first published ready cursor stopped before a queued %s step', async kind => {
    const s = setup(), asset = await saved(s.assets, draft => ({ ...draft, steps: [kind === 'checkpoint'
      ? { id: 'checkpoint', kind, url: draft.url, reviewed: true } : draft.steps[0]!] })), h = host()
    let stopped: ReturnType<BrowserTaskAssets['stop']> | undefined
    let publishedId: string | undefined
    const unsubscribe = s.assets.subscribe(async () => {
      const run = (await s.assets.state()).runs[0]
      if (!run || publishedId) return
      publishedId = run.id
      stopped = s.assets.stop(run.id)
    })
    try {
      const run = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: {} }, h.owner)
      expect(publishedId).toBeTypeOf('string')
      expect(h.owner.onRunPrepared).toHaveBeenCalledExactlyOnceWith(publishedId)
      expect(await stopped).toMatchObject({ id: publishedId, status: 'stopped', nextStep: 0 })
      expect(run).toMatchObject({ id: publishedId, status: 'stopped', nextStep: 0, operationIds: [] })
      expect(h.runScript).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })
  it('retains the actual stopped cursor when an already-started host call rejects', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done }), paused = new Promise<void>(done => { release = done })
    h.owner.runScript = async () => { entered(); await paused; throw new Error('Call result unavailable') }
    const running = runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'one-use' } }, h.owner)
    try {
      await waiting
      const current = (await s.assets.state()).runs[0]!
      await s.assets.stop(current.id); release()
      expect(await running).toMatchObject({ id: current.id, status: 'stopped', nextStep: 0, operationIds: [] })
    } finally { release(); await running }
  })
  it('does not advance an uncertain call, wrong journal identity or storage failure into apparent completion', async () => {
    const s = setup(), asset = await saved(s.assets), h = host()
    h.owner.runScript = async () => { throw new Error('Unknown action completion') }
    const uncertain = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'memory' } }, h.owner)
    expect(uncertain).toMatchObject({ status: 'interrupted', nextStep: 0, operationIds: [] })
    h.owner.runScript = async () => ({ result: undefined, logs: [], outcome: { kind: 'completed' }, runOperation: { id: 'other-op', browserId: 'other-browser', phase: 'completed', operator: { id: 'person', name: 'Person' }, startedAt: 1, summary: 'Wrong owner', url: 'https://example.test/form', steps: [] } })
    const wrong = await runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'memory' } }, h.owner)
    expect(wrong).toMatchObject({ status: 'interrupted', nextStep: 0, operationIds: [] })
    s.store.unavailable = true
    await expect(runBrowserTaskAsset(s.assets, { assetId: asset.id, version: 1, browserId: 'browser-1', parameters: { 'input-2': 'memory' } }, host().owner)).rejects.toThrow('could not be saved')
    expect((await s.assets.state()).warning).toContain('previous Browser work remain')
  })
  it('persists immutable assets through the real atomic file store while rejecting corrupt files without overwriting them', async () => {
    const path = await mkdtemp(join(tmpdir(), 'agentmux-task-assets-test-')), file = join(path, 'assets.json')
    try {
      const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(file)), asset = await saved(assets)
      const restored = new BrowserTaskAssets(new BrowserTaskAssetFileStore(file))
      expect(await restored.get(asset.id)).toEqual(asset)
      const source = await readFile(file, 'utf8')
      expect(source).not.toContain('raw-secret')
      const unreadable = new BrowserTaskAssets({ load: async () => { throw new Error('Unreadable durable file') }, save: vi.fn() })
      const state = await unreadable.state()
      expect(state.warning).toContain('existing file was retained')
      await expect(unreadable.importRecording(recording())).rejects.toThrow('could not be restored')
      expect(await readFile(file, 'utf8')).toBe(source)
    } finally { await rm(path, { recursive: true, force: true }) }
  })
})

async function mount(asset: BrowserTaskAsset | null, overrides: Record<string, unknown> = {}) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const handlers = { onImport: vi.fn(), onSaveDraft: vi.fn(async (_draft: BrowserTaskContent, _event: React.MouseEvent<HTMLButtonElement>) => {}), onSaveVersion: vi.fn(async (_draft: BrowserTaskContent, _event: React.MouseEvent<HTMLButtonElement>) => {}), onLocateStep: vi.fn((_stepId: string, _event: React.MouseEvent<HTMLButtonElement>) => {}), onRun: vi.fn(async (_input: { version: number; parameters: Record<string, string>; mode: 'run' | 'step'; runId?: string }, _event: React.MouseEvent<HTMLButtonElement>) => {}), onStop: vi.fn() }
  await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: recording(), ...handlers, ...overrides })))
  return { host, handlers, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('BrowserTaskAssetEditor', () => {
  it('mounts no unused asset panel and keeps a warning visible without inventing an importable draft', async () => {
    const empty = await mount(null, { recording: null })
    try {
      expect(empty.host.childElementCount).toBe(0)
      expect(empty.handlers.onImport).not.toHaveBeenCalled()
    } finally { await empty.close() }
    const failed = await mount(null, { recording: null, warning: 'Saved task data could not be restored; live Browser remains available.' })
    try {
      expect(failed.host.querySelector('[role="status"]')?.textContent).toContain('could not be restored')
      expect(failed.host.querySelector('header')).toBeNull()
      expect(failed.host.querySelector('button')).toBeNull()
    } finally { await failed.close() }
  })
  it('keeps the compact import entry disabled during recording or busy work, while retaining its warning', async () => {
    for (const overrides of [{ recording: { ...recording(), status: 'recording' } }, { busy: true }]) {
      const m = await mount(null, { ...overrides, warning: 'Live draft retained; storage unavailable.' })
      try {
        expect(m.host.querySelector('header')).toBeNull()
        expect(m.host.querySelector<HTMLButtonElement>('button')?.textContent).toBe('Edit demonstration')
        expect(m.host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
        expect(m.host.querySelector('[role="status"]')?.textContent).toContain('Live draft retained')
        await act(async () => m.host.querySelector<HTMLButtonElement>('button')!.click())
        expect(m.handlers.onImport).not.toHaveBeenCalled()
        expect(m.handlers.onRun).not.toHaveBeenCalled()
      } finally { await m.close() }
    }
  })
  it('renders nonempty draft and immutable version preview, keeps deleted steps absent and shows checkpoint progress', async () => {
    const s = setup(), asset = await saved(s.assets), m = await mount(asset, { run: { id: 'run-1', assetId: asset.id, version: 1, browserId: 'browser-1', nextStep: 1, status: 'waiting-human', operationIds: ['op-1'], pendingCheckpointId: 'cp-1', warning: 'Inspect before returning control', startedAt: 1, updatedAt: 2 } })
    try {
      expect(m.host.querySelectorAll('[data-task-step-id]')).toHaveLength(2)
      expect(m.host.textContent).toContain('Return control and continue')
      expect(m.host.textContent).toContain('Inspect before returning control')
      await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Delete task step 1"]')!.click())
      await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Delete task step 1"]')!.click())
      expect(m.host.querySelectorAll('[data-task-step-id]')).toHaveLength(0)
      expect(m.host.textContent).toContain('deleted steps stay deleted')
      expect(m.host.textContent).toContain('Preview v1 · 2 steps')
      const save = Array.from(m.host.querySelectorAll('button')).find(button => button.textContent === 'Save draft')!
      await act(async () => save.click())
      expect(m.handlers.onSaveDraft.mock.calls[0]?.[0]).toMatchObject({ steps: [] })
    } finally { await m.close() }
  })
  it('forwards actual UI events without claiming trust and keeps unresolved targets blocked from review', async () => {
    const { target: _target, ...unknown } = recording().steps[0]!
    const s = setup(), asset = await s.assets.importRecording({ ...recording(), steps: [unknown] }), m = await mount(asset)
    try {
      const review = m.host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!
      expect(review.disabled).toBe(true)
      expect(review.checked).toBe(false)
      await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Locate task step 1"]')!.click())
      expect(m.handlers.onLocateStep.mock.calls[0]?.[0]).toBe('click-1')
      expect(m.handlers.onLocateStep.mock.calls[0]?.[1].nativeEvent.type).toBe('click')
      expect(m.handlers.onLocateStep.mock.calls[0]?.[1].nativeEvent.isTrusted).not.toBe(true)
      expect(m.host.textContent).toContain('Target needs location')
    } finally { await m.close() }
  })
  it('exposes stopped demonstration import without an automatic execution path', async () => {
    const m = await mount(null)
    try {
      const buttons = Array.from(m.host.querySelectorAll<HTMLButtonElement>('button'))
      expect(buttons.map(button => button.textContent)).toEqual(['Edit demonstration'])
      await act(async () => buttons[0]!.click())
      expect(m.handlers.onImport).toHaveBeenCalledTimes(1)
      expect(m.handlers.onRun).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('inserts a real checkpoint between steps and saves that edited sequence rather than a reconstructed demonstration', async () => {
    const s = setup(), asset = await saved(s.assets), m = await mount(asset)
    try {
      await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Insert checkpoint after task step 1"]')!.click())
      expect(m.host.querySelectorAll('[data-task-step-id]')).toHaveLength(3)
      expect(m.host.textContent).toContain('Hands control to the person')
      await act(async () => Array.from(m.host.querySelectorAll('button')).find(button => button.textContent === 'Save version')!.click())
      expect(m.handlers.onSaveVersion.mock.calls[0]?.[0].steps.map(step => step.kind)).toEqual(['click', 'checkpoint', 'fill'])
    } finally { await m.close() }
  })
})
