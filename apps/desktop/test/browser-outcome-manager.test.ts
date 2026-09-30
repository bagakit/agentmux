// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false; contextId = 17
    attached = false; attaches = 0; detaches = 0; reads = 0
    beforeRead?: () => Promise<void>
    beforeLoad?: () => Promise<void>
    session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    mainFrame = { framesInSubtree: [] }
    debugger = Object.assign(new EventEmitter(), {
      attach: () => { if (this.attached) throw new Error('Already attached'); this.attached = true; this.attaches++ },
      detach: () => { this.attached = false; this.detaches++ },
      isAttached: () => this.attached,
      sendCommand: async (method: string, parameters: any = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: this.contextId }
        if (method === 'Runtime.evaluate') return { result: parameters.expression === 'document'
          ? { objectId: 'actual-document' } : { value: document.URL } }
        if (method === 'Runtime.callFunctionOn') {
          if (parameters.functionDeclaration.includes('readStructuredDom')) { this.reads++; await this.beforeRead?.() }
          const value = Function(`return (${parameters.functionDeclaration})`)().call(document,
            ...(parameters.arguments ?? []).map((argument: any) => argument.value))
          return { result: { value } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }
    isLoading() { return false }
    getURL() { return this.url }
    getTitle() { return 'Generic form' }
    getZoomFactor() { return 1 }
    setZoomFactor() {}
    disableDeviceEmulation() {}
    enableDeviceEmulation() {}
    setWindowOpenHandler() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      await this.beforeLoad?.()
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
      this.url = url; this.emit('did-finish-load')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    webContents = new Contents()
    constructor() { native.views.push(this) }
    setVisible() {}
    setBounds() {}
  }
  return { WebContentsView: View, app: { getPath: () => tmpdir() } }
})
import { BrowserViewManager } from '../src/main/browser-view-manager'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal'
import { BrowserStepEvidenceStore } from '../src/main/browser-step-evidence'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store'
import { BrowserTaskAssetFileStore, BrowserTaskAssets } from '../src/main/browser-task-assets'
import type { BrowserTaskAssetDocument } from '../src/shared/browser-task-assets'

const roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0
})
const input = { request: { fields: [{ key: 'result', type: 'string' as const, source: { selector: '#result', read: 'text' as const } }] },
  criteria: [{ kind: 'field-equals' as const, key: 'result', expected: 'ready' }] }
async function fixture(beforeTaskSave?: (value: BrowserTaskAssetDocument) => Promise<void>) {
  document.body.innerHTML = '<span id="result">ready</span>'
  const root = await mkdtemp(join(tmpdir(), 'amux-outcome-manager-')); roots.push(root)
  const path = join(root, 'journal.json'), journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
  const taskPath = join(root, 'tasks.json'), taskStore = new BrowserTaskAssetFileStore(taskPath)
  const taskAssets = new BrowserTaskAssets({ load: () => taskStore.load(), save: async value => {
    await beforeTaskSave?.(value); await taskStore.save(value)
  } })
  const events: any[] = []
  const children: any[] = []
  const window = { contentView: { children, addChildView: (view: any) => children.push(view), removeChildView: (view: any) => children.splice(children.indexOf(view), 1) },
    isDestroyed: () => false, webContents: { isDestroyed: () => false, send(_channel: string, event: unknown) { events.push(structuredClone(event)) } } }
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} },
    journal, new BrowserStepEvidenceStore(join(root, 'evidence')), new BrowserResultArtifactStore(join(root, 'results')), undefined, taskAssets)
  managers.push(manager)
  await manager.create('browser-a', 'https://generic.invalid/form', 'workspace-a')
  return { manager, journal, path, view: children[0], taskAssets, taskPath,
    browser: () => events.filter(event => event.type === 'updated').at(-1)?.browser }
}

async function savedCheckpoint(assets: BrowserTaskAssets) {
  const imported = await assets.importRecording({ id: 'recording-a', browserId: 'browser-a', navigationId: 'navigation-a',
    url: 'https://generic.invalid/form', status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await assets.edit(imported.id, imported.revision, { ...imported.draft, steps: [
    { id: 'checkpoint-a', kind: 'checkpoint', url: imported.draft.url, reviewed: true },
    { id: 'navigate-after', kind: 'navigate', url: 'https://generic.invalid/next', reviewed: true }
  ] })
  return await assets.saveVersion(edited.id, edited.revision)
}

describe('finite field checks through the real Main execution owner', () => {
  it('saves registration before real extraction and joins journal evidence and T003 bytes, then verifies without repeating the producer', async () => {
    const f = await fixture()
    let beforeProducer: any
    f.view.webContents.beforeRead = async () => { beforeProducer = JSON.parse(await readFile(f.path, 'utf8')).operations.at(-1) }
    const result = await f.manager.checkOutcomeFields('browser-a', input)
    expect(result.status, JSON.stringify(await f.journal.list())).toBe('passed')
    expect(beforeProducer.steps).toHaveLength(1)
    expect(beforeProducer.steps[0].status).toBe('running')
    expect(beforeProducer.outcome.registration.criteria).toHaveLength(1)
    expect(beforeProducer.outcome.registration.context.operationId).toBe(beforeProducer.id)
    expect(result.status).toBe('passed')
    expect(result.conditions.map(c => c.status)).toEqual(['passed'])
    const operation = await f.journal.get(result.context.operationId)
    expect(operation?.steps.map(s => s.method)).toEqual(['extractStructured'])
    expect(operation?.outcome?.evaluation).toEqual(result)
    expect(f.view.webContents.reads).toBe(1)
    expect((await f.manager.verifyOutcome('browser-a', result.context.operationId)).status).toBe('passed')
    expect(f.view.webContents.reads).toBe(1)
    expect(f.view.webContents.attached).toBe(false)
    expect(f.view.webContents.attaches).toBe(f.view.webContents.detaches)
  }, 30_000)

  it('rejects a changed same-URL document on read-only verification and leaves the Browser available', async () => {
    const f = await fixture(), first = await f.manager.checkOutcomeFields('browser-a', input)
    expect(first.status).toBe('passed')
    f.view.webContents.contextId = 18
    const checked = await f.manager.verifyOutcome('browser-a', first.context.operationId)
    expect(checked.status).toBe('unavailable')
    expect(checked.conditions.map(c => c.status)).toEqual(['unavailable'])
    expect(f.view.webContents.reads).toBe(1)
    const next = await f.manager.checkOutcomeFields('browser-a', input)
    expect(next.status).toBe('passed')
    expect(next.context.operationId).not.toBe(first.context.operationId)
    expect(f.view.webContents.reads).toBe(2)
  }, 30_000)

  it('rejects the aggregate registered budget before observation, preserves the Browser and accepts a subsequent small check', async () => {
    const f = await fixture()
    const fields = Array.from({ length: 32 }, (_, i) => ({ key: `field-${i}`, type: 'string' as const,
      source: { selector: '#result' + ' '.repeat(490), read: 'text' as const } }))
    const criteria = fields.slice(0, 8).map(field => ({ kind: 'field-equals' as const, key: field.key, expected: 'ready' }))
    await expect(f.manager.checkOutcomeFields('browser-a', { request: { fields }, criteria })).rejects.toThrow('registration budget')
    expect(f.view.webContents.reads).toBe(0)
    expect(f.view.webContents.attached).toBe(false)
    expect((await f.journal.list()).map(operation => operation.steps)).toEqual([[]])
    expect((await f.manager.checkOutcomeFields('browser-a', input)).status).toBe('passed')
    expect(f.view.webContents.reads).toBe(1)
  }, 30_000)

  it('an asynchronous pre-producer callback failure releases active run and debugger so the next healthy operation can run', async () => {
    const f = await fixture()
    await expect(f.manager.runScript('browser-a', 'return 1', undefined, undefined, undefined,
      async () => { throw new Error('registration failed') })).rejects.toThrow('registration failed')
    expect(f.view.webContents.attached).toBe(false)
    expect((await f.manager.runScript('browser-a', 'return 2')).outcome.kind).toBe('completed')
    expect(f.view.webContents.attaches).toBe(f.view.webContents.detaches)
    expect((await f.journal.list()).map(op => op.phase)).toEqual(['indeterminate', 'completed'])
  }, 30_000)
})

describe('the existing trusted task action records confirmation before returning control', () => {
  it('holds human control and the original pending cursor until the exact event save acknowledges, then executes only the remaining step', async () => {
    let release!: () => void, acknowledge!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { acknowledge = resolve })
    let holding = false
    const f = await fixture(async value => {
      if (holding && value.runs.some(run => run.humanCheckpoints?.length)) { acknowledge(); await held }
    })
    const asset = await savedCheckpoint(f.taskAssets)
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    expect(waiting.status).toBe('waiting-human')
    expect(waiting.pendingCheckpointId).toBe('checkpoint-a')
    expect(waiting.operationIds).toEqual([])
    expect(f.browser()?.activity.control).toBe('human')
    holding = true
    const continuing = f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, runId: waiting.id, parameters: {} })
    try {
      let timer!: ReturnType<typeof setTimeout>
      try {
        expect(await Promise.race([entered.then(() => true), new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 1500)
        })])).toBe(true)
      } finally { clearTimeout(timer) }
      expect(f.browser()?.activity.control).toBe('human')
      expect((await f.taskAssets.state('browser-a')).runs[0]).toMatchObject({ id: waiting.id, nextStep: 1,
        pendingCheckpointId: 'checkpoint-a', humanCheckpoints: [] })
      expect((await f.journal.list()).map(op => op.id)).toEqual([])
      release()
      const complete = await continuing
      expect(complete.status).toBe('completed')
      expect(complete.id).toBe(waiting.id)
      expect(complete.operationIds).toHaveLength(1)
      expect(complete.humanCheckpoints).toEqual([expect.objectContaining({ runId: waiting.id, browserId: 'browser-a',
        assetId: asset.id, version: 1, checkpointId: 'checkpoint-a', pendingCursor: 1, origin: 'trusted-ui', controlBefore: 'human' })])
      expect(f.view.webContents.getURL()).toBe('https://generic.invalid/next')
      expect(f.view.webContents.attached).toBe(false)
      expect((await f.journal.list()).map(op => op.steps.map(step => step.method))).toEqual([['pageInfo', 'gotoUrl']])
      const restarted = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.taskPath))
      expect((await restarted.state('browser-a')).runs[0]?.humanCheckpoints).toEqual(complete.humanCheckpoints)
    } finally { release(); await continuing }
  }, 30_000)

  it('rejects a foreign continuation before returning human control or creating any event/producer', async () => {
    const f = await fixture(), asset = await savedCheckpoint(f.taskAssets)
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    await expect(f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 2, runId: waiting.id, parameters: {} }))
      .rejects.toThrow('original task continuation identity')
    expect(f.browser()?.activity.control).toBe('human')
    expect((await f.taskAssets.state('browser-a')).runs[0]).toMatchObject({ id: waiting.id, status: 'waiting-human', humanCheckpoints: [] })
    expect(await f.journal.list()).toEqual([])
    const complete = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, runId: waiting.id, parameters: {} })
    expect(complete.status).toBe('completed')
    expect(complete.operationIds).toHaveLength(1)
  }, 30_000)

  it('does not block the healthy remaining action when the optional confirmation save fails', async () => {
    const f = await fixture(async value => {
      if (value.runs.some(run => run.status === 'waiting-human' && run.humanCheckpoints?.length)) throw new Error('private save failure')
    }), asset = await savedCheckpoint(f.taskAssets)
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, parameters: {} })
    const complete = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: asset.id, version: 1, runId: waiting.id, parameters: {} })
    expect(complete.status).toBe('completed')
    expect(complete.operationIds).toHaveLength(1)
    expect(complete.humanCheckpoints).toEqual([])
    expect(f.view.webContents.getURL()).toBe('https://generic.invalid/next')
    expect(await f.taskAssets.readExactFact({ runId: waiting.id, browserId: 'browser-a', assetId: asset.id, version: 1 }, 'checkpoint-a'))
      .toMatchObject({ status: 'unavailable' })
    expect(f.view.webContents.attached).toBe(false)
  }, 30_000)
})

describe('declared task completion consumes the actual asset owner through Main', () => {
  it('registers the immutable version and actual run before the producer, reads trusted Continue, and verifies after owner rebuild without replay', async () => {
    const f = await fixture()
    const imported = await f.taskAssets.importRecording({ id: 'recording-contract', browserId: 'browser-a', navigationId: 'nav-original',
      url: 'https://generic.invalid/form', status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
    const edited = await f.taskAssets.edit(imported.id, imported.revision, { ...imported.draft, steps: [
      { id: 'producer', kind: 'navigate', url: 'https://generic.invalid/next', reviewed: true },
      { id: 'confirm', kind: 'checkpoint', url: 'https://generic.invalid/next', reviewed: true },
      { id: 'remaining', kind: 'navigate', url: 'https://generic.invalid/final', reviewed: true }
    ], completion: { criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] } } as any)
    const saved = await f.taskAssets.saveVersion(edited.id, edited.revision)
    let beforeProducer: any
    f.view.webContents.beforeLoad = async () => {
      beforeProducer = { journal: JSON.parse(await readFile(f.path, 'utf8')), tasks: JSON.parse(await readFile(f.taskPath, 'utf8')) }
    }
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: saved.id, version: 1, parameters: {} })
    expect(waiting.status).toBe('waiting-human')
    expect(waiting.operationIds).toHaveLength(1)
    expect(beforeProducer.tasks.runs[0].operationIds).toEqual(waiting.operationIds)
    expect(beforeProducer.journal.operations[0].outcome.registration.assetRun).toEqual({ runId: waiting.id, assetId: saved.id, version: 1 })
    const operation = await f.journal.get(waiting.operationIds[0]!)
    expect(operation?.outcome?.registration).toMatchObject({ assetRun: { runId: waiting.id, assetId: saved.id, version: 1 },
      context: { browserId: 'browser-a', operationId: waiting.operationIds[0] }, criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] })
    expect((await f.manager.verifyOutcome('browser-a', operation!.id)).conditions.map(item => item.status)).toEqual(['not-met'])
    const complete = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: saved.id, version: 1, runId: waiting.id, parameters: {} })
    expect(complete.operationIds).toHaveLength(2)
    expect((await f.manager.verifyOutcome('browser-a', operation!.id)).conditions.map(item => item.status)).toEqual(['passed'])
    const count = (await f.journal.list()).length
    await f.manager.verifyOutcome('browser-a', operation!.id)
    expect((await f.journal.list()).length).toBe(count)
    const rebuilt = new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.taskPath))
    expect((await rebuilt.state('browser-a')).runs[0]?.operationIds).toEqual(complete.operationIds)
    expect((await rebuilt.get(saved.id))?.versions[0]?.completion).toEqual(saved.versions[0]?.completion)
    expect((await rebuilt.readExactFact({ browserId: 'browser-a', runId: waiting.id, assetId: saved.id, version: 1 }, 'confirm')).status).toBe('available')
    await f.manager.runScript('browser-a', 'return "independent healthy operation"')
    expect((await f.manager.verifyOutcome('browser-a', operation!.id)).conditions.map(item => item.status)).toEqual(['unavailable'])
    expect(f.view.webContents.isDestroyed()).toBe(false)
  }, 30_000)

  it('keeps failed pre-producer completion recording unavailable while the same healthy action finishes', async () => {
    let failOnce = true
    const f = await fixture(async value => {
      if (failOnce && value.runs.some(run => run.status === 'running' && run.operationIds.length > 0)) {
        failOnce = false; throw new Error('Optional binding save failed')
      }
    })
    const imported = await f.taskAssets.importRecording({ id: 'recording-unknown', browserId: 'browser-a', navigationId: 'nav-original',
      url: 'https://generic.invalid/form', status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
    const edited = await f.taskAssets.edit(imported.id, imported.revision, { ...imported.draft, steps: [
      { id: 'producer', kind: 'navigate', url: 'https://generic.invalid/next', reviewed: true },
      { id: 'confirm', kind: 'checkpoint', url: 'https://generic.invalid/next', reviewed: true }
    ], completion: { criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] } })
    const saved = await f.taskAssets.saveVersion(edited.id, edited.revision)
    const waiting = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: saved.id, version: 1, parameters: {} })
    expect(waiting.status).toBe('waiting-human')
    expect(waiting.completionWarning).toContain('unavailable')
    expect(f.view.webContents.getURL()).toBe('https://generic.invalid/next')
    const complete = await f.manager.runTaskAsset({ browserId: 'browser-a', assetId: saved.id, version: 1, runId: waiting.id, parameters: {} })
    expect(complete.status).toBe('completed')
    expect(complete.humanCheckpoints).toHaveLength(1)
    expect((await f.manager.verifyOutcome('browser-a', complete.operationIds[0]!)).conditions.map(item => item.status)).toEqual(['unavailable'])
    expect((await new BrowserTaskAssets(new BrowserTaskAssetFileStore(f.taskPath)).state('browser-a')).runs[0]?.completionWarning).toContain('unavailable')
    expect(f.view.webContents.isDestroyed()).toBe(false)
  }, 30_000)
})
