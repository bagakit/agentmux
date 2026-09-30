import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Actual Main/asset/compiler/script worker/dispatch/Journal/evaluator/evidence Source.
// Electron and CDP transport are doubles; no Native Chromium or process-restart claim.
const native = vi.hoisted(() => ({ views: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    readonly id = 91
    url = ''; attached = false; destroyed = false; clicks = 0; loads: string[] = []; resolves = 0; snapshots = 0
    failResolves = 0; rejectAction = false; failLoad = false; onResolve?: () => Promise<void>
    removeTargetOnFailure = false; targetMissing = false
    readonly session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly mainFrame = { framesInSubtree: [] }
    readonly debugger = Object.assign(new EventEmitter(), {
      attach: () => { this.attached = true }, detach: () => { this.attached = false }, isAttached: () => this.attached,
      sendCommand: async (method: string, parameters: Record<string, any> = {}) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'document-a' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 }
        if (method === 'Accessibility.getFullAXTree') {
          this.snapshots++
          return { nodes: [{ nodeId: '1', backendDOMNodeId: this.snapshots + 10, role: { value: 'button' }, name: { value: this.targetMissing ? 'Changed item' : 'Continue' }, childIds: [] }] }
        }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') {
          this.resolves++
          if (this.failResolves > 0) { this.failResolves--; this.targetMissing = this.removeTargetOnFailure; throw new Error('Backend node detached') }
          await this.onResolve?.()
          return { object: { objectId: `object-${parameters.backendNodeId}` } }
        }
        if (method === 'Runtime.callFunctionOn') {
          expect(parameters.functionDeclaration).toContain('this.click()')
          this.clicks++
          if (this.rejectAction) return { exceptionDetails: { text: 'Explicit user rejection: do not retry' } }
          return { result: { value: null } }
        }
        return {}
      }
    })
    isDestroyed() { return this.destroyed }
    isLoading() { return false }
    getURL() { return this.url }
    getTitle() { return 'Generic page' }
    getZoomFactor() { return 1 }
    setZoomFactor() {}
    disableDeviceEmulation() {}
    enableDeviceEmulation() {}
    setWindowOpenHandler() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      this.loads.push(url)
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
      this.url = url
      if (this.failLoad) { this.failLoad = false; throw new Error('Native load rejected without effect certainty') }
      this.emit('did-finish-load')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    readonly webContents = new Contents()
    constructor() { native.views.push(this) }
    setVisible() {}
    setBounds() {}
  }
  return { WebContentsView: View, app: { getPath: () => tmpdir() } }
})
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../src/main/browser-task-assets.js'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../src/main/browser-operation-journal.js'
import { BrowserStepEvidenceStore } from '../src/main/browser-step-evidence.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { projectBrowserControlOperation } from '../src/main/browser-completion-control.js'
import type { BrowserTaskContent } from '../src/shared/browser-task-assets.js'

const browserId = 'browser-a', url = 'https://generic.invalid/work', roots: string[] = [], managers: BrowserViewManager[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) manager.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  native.views.length = 0
})
async function fixture(kind: 'click' | 'navigate' = 'click', declared = true) {
  const root = await mkdtemp('/tmp/agentmux-local-recovery-manager-'); roots.push(root)
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json')))
  const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root, 'assets.json')))
  const children: any[] = [], window = { contentView: { addChildView: (view: any) => children.push(view), removeChildView() {} },
    isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } }
  const manager = new BrowserViewManager(window as never, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:local' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} },
    journal, new BrowserStepEvidenceStore(join(root, 'evidence')), undefined, undefined, assets)
  managers.push(manager); await manager.create(browserId, url, 'workspace-a')
  const contents = children[0].webContents
  // A real completed prefix operation is not an input to task recovery.
  const prefix = await manager.runScript(browserId, `await gotoUrl(${JSON.stringify(url)}); const page = await snapshot(); await click(page.nodes[0].ref); return 1`)
  expect(prefix.outcome.kind).toBe('completed'); expect(contents.clicks).toBe(1)
  const imported = await assets.importRecording({ id: 'recording-a', browserId, navigationId: 'recorded-a', url,
    status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const draft: BrowserTaskContent = { ...imported.draft, steps: [
    { id: 'current-a', kind, url: kind === 'navigate' ? 'https://generic.invalid/next' : url, reviewed: true,
      ...(kind === 'click' ? { target: { role: 'button', name: 'Continue', ordinal: 1, count: 1 } } : {}) },
    { id: 'later-checkpoint', kind: 'checkpoint', url, reviewed: true }
  ], ...(declared ? { completion: { criteria: [{ kind: 'human-checkpoint', checkpointId: 'later-checkpoint' }] } } : {}) }
  const edited = await assets.edit(imported.id, imported.revision, draft), asset = await assets.saveVersion(edited.id, edited.revision)
  const run = () => manager.runTaskAsset({ browserId, assetId: asset.id, version: 1, parameters: {} })
  return { root, journal, assets, manager, contents, asset, run, prefix }
}
async function recoveredStep(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const operation = await f.manager.getOperation(operationId)
  expect(operation?.browserId).toBe(browserId)
  const call = operation!.steps.find(step => step.method === 'click' || step.method === 'gotoUrl')!
  expect(call).toBeDefined()
  const evidence = await f.manager.getStepEvidence(operationId, call.sequence)
  expect(evidence.items.length).toBeGreaterThan(0)
  return { operation: operation!, call, evidence }
}
describe('local recovery uses the actual Main task caller', () => {
  it('repairs one current locator call under its original tuple; completed prefix and future checkpoint stay intact', async () => {
    const f = await fixture(); f.contents.failResolves = 1
    const run = await f.run()
    expect(run.status, JSON.stringify({ run, operation: await f.manager.getOperation(run.operationIds[0]!), clicks: f.contents.clicks })).toBe('waiting-human'); expect(run.nextStep).toBe(2)
    expect(run.operationIds).toHaveLength(1)
    expect(f.contents.clicks).toBe(2); expect(f.contents.loads).toEqual([url, url])
    const { operation, call, evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(call.status).toBe('completed')
    expect(evidence.items[0]!.content).toMatchObject({ kind: 'diagnostic', message: expect.stringContaining('action-completed') })
    if (evidence.items[0]!.content.kind !== 'diagnostic') throw new Error('Missing final recovery diagnostic')
    expect(evidence.items[0]!.content.message).toContain('/2 attempts')
    expect(evidence.items[0]!.content.message).toContain('/5000 ms')
    expect(evidence.items[0]!.content.message).toContain('Outcome evidence: not-met')
    expect(operation.outcome!.registration.assetRun).toEqual({ runId: run.id, assetId: f.asset.id, version: 1 })
    expect(projectBrowserControlOperation(operation).completion?.status).toBe('not-met')
    await expect(f.manager.verifyOutcome(browserId, operation.id)).resolves.toMatchObject({ status: 'not-met' })
    expect(f.contents.clicks).toBe(2)
    const rebuilt = new BrowserOperationJournal(new BrowserOperationFileStore(join(f.root, 'journal.json')))
    expect((await rebuilt.get(operation.id))?.outcome?.evaluation?.status).toBe('not-met')
    expect(f.contents.destroyed).toBe(false); expect(f.contents.attached).toBe(false)
  }, 30_000)

  it('a real Native navigation rejection has unknown effects, retains an explicit error and sends no second navigation', async () => {
    const f = await fixture('navigate'); f.contents.failLoad = true
    const run = await f.run()
    expect(run.status).toBe('failed'); expect(run.nextStep).toBe(0)
    expect(f.contents.loads).toEqual([url, url, 'https://generic.invalid/next'])
    expect(f.contents.clicks).toBe(1)
    const { call, evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(call.status).toBe('failed')
    expect(evidence.items[0]!.content).toMatchObject({ kind: 'diagnostic', message: expect.stringContaining('navigation-failed; effects: unknown') })
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)

  it('an explicit page rejection after dispatch does not retry the action', async () => {
    const f = await fixture(); f.contents.rejectAction = true
    const run = await f.run()
    expect(run.status).toBe('failed'); expect(run.nextStep).toBe(0)
    expect(f.contents.clicks).toBe(2); expect(f.contents.resolves).toBe(2)
    const { call, evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(call.status).toBe('failed')
    expect(evidence.items[0]!.content).toMatchObject({ kind: 'diagnostic', message: expect.stringContaining('not-eligible') })
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)

  it('an undeclared operation does not enter a recovery action before unavailable verification', async () => {
    const f = await fixture('click', false); f.contents.failResolves = 1
    const run = await f.run()
    expect(run.status).toBe('failed'); expect(f.contents.clicks).toBe(1); expect(f.contents.resolves).toBe(2)
    const { operation, evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(operation.outcome).toBeUndefined()
    expect(evidence.items.map(item => item.content.kind)).toEqual(['diagnostic'])
    expect(evidence.items[0]!.content).toMatchObject({ message: expect.stringContaining('did not report completion') })
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)

  it('human takeover during real ref resolution stops before the native action boundary', async () => {
    const f = await fixture(); f.contents.failResolves = 1
    f.contents.onResolve = async () => { f.contents.emit('input-event', {}, { type: 'mouseDown' }) }
    const run = await f.run()
    expect(['failed', 'interrupted', 'stopped']).toContain(run.status)
    expect(f.contents.clicks).toBe(1)
    expect(f.contents.destroyed).toBe(false)
    const operation = await f.manager.getOperation(run.operationIds[0]!)
    expect(operation?.warning).toContain('control')
  }, 30_000)

  it('an expired recovery authorization is checked after real DOM.resolveNode before native dispatch', async () => {
    const f = await fixture(); f.contents.failResolves = 1
    f.contents.onResolve = async () => { vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001) }
    const run = await f.run()
    expect(run.nextStep).toBe(0); expect(f.contents.clicks).toBe(1)
    const { evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(evidence.items[0]!.content).toMatchObject({ kind: 'diagnostic', message: expect.stringContaining('handoff') })
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)

  it('a durable cursor stopped during handle resolution cannot be replaced by an old execution tuple', async () => {
    const f = await fixture(); f.contents.failResolves = 1
    f.contents.onResolve = async () => {
      const current = await f.assets.currentRun(browserId)
      expect(current?.status).toBe('running')
      await f.assets.stop(current!.id)
    }
    const run = await f.run()
    expect(run.status).toBe('stopped'); expect(f.contents.clicks).toBe(1)
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)

  it('an absent target hands off with the original reviewed goal directly readable in the final diagnostic', async () => {
    const f = await fixture(); f.contents.failResolves = 1; f.contents.removeTargetOnFailure = true
    const run = await f.run()
    expect(run.status).toBe('failed'); expect(run.nextStep).toBe(0); expect(f.contents.clicks).toBe(1)
    const { call, evidence } = await recoveredStep(f, run.operationIds[0]!)
    expect(call.target).toBeUndefined()
    expect(evidence.items[0]!.content.kind).toBe('diagnostic')
    if (evidence.items[0]!.content.kind !== 'diagnostic') throw new Error('Missing failed recovery diagnostic')
    expect(evidence.items[0]!.content.message).toContain('handoff')
    expect(evidence.items[0]!.content.message).toContain('button "Continue"')
    expect(evidence.items[0]!.content.message).toContain('1/1')
    expect(evidence.items[0]!.content.message).toContain(url)
    expect(evidence.items[0]!.content.message).toContain('/2 attempts')
    expect(f.contents.destroyed).toBe(false)
  }, 30_000)
})
