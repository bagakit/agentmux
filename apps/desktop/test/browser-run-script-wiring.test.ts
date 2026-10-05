import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_OPERATION_FEEDBACK_WORLD_ID } from '../src/main/browser-operation-feedback.js'
import { AgentMuxControlServer, BROWSER_PAGE_CAPABILITY_NAMES, browserPageCapabilityNames } from '@agentmux/core'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { projectBrowserControlResult } from '../src/main/browser-completion-control.js'
import { mkdtempSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { LocalExecutionHost } from '@agentmux/core'
import { BrowserUploads } from '../src/main/browser-uploads.js'
import type { BrowserUploadReceipt } from '../src/shared/browser-upload.js'
import { BrowserDownloads } from '../src/main/browser-downloads.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import type { BrowserDownloadReceipt, BrowserDownloadChunk } from '../src/shared/browser-download.js'
import vm from 'node:vm'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BrowserDemonstrationCapture } from '../src/main/browser-demonstration-capture.js'
import { BrowserDemonstrationFileStore, BrowserDemonstrationRecorder } from '../src/main/browser-demonstration-recorder.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../src/main/browser-task-assets.js'
import type { BrowserTaskAsset, BrowserTaskContent } from '../src/shared/browser-task-assets.js'
import type { BrowserDemonstrationDocument, BrowserDemonstrationDraft } from '../src/shared/browser-demonstration.js'

/**
 * `runScript` 那条路的单元判据：**生产的 onPageCall 真的走派发层**，以及会话中途没了要如实报告。
 *
 * 这条与真机那条 browser-drive-e2e.test.ts 的分工是刻意的，两条缺一不可：
 *
 * - 真机那条自己建 `BrowserCdpSession` + `createBrowserPageDispatch` 驱动一遍，证「这套代码在真
 *   页面上能闭环」。但它**不构造 BrowserViewManager、不调 runScript**——所以把 runScript 里的
 *   接线整段删掉，它照样绿。那正是本 Feature 点名要防的陷阱形状（生产走别的路，桥只在测试里出现）。
 * - 这条不碰真页面，只钉住「manager 把页面调用交给了派发层」这一条关系。它跑得快，且删接线必红。
 *
 * 这里 mock 的是 `browser-page-dispatch`，不是 CDP：要判定的是**谁调谁**，不是页面语义。
 */

const fakeElectron = vi.hoisted(() => {
  class FakeDebugger {
    attached = false
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    /** 被踢掉的原因；测试用它模拟"用户中途打开了 DevTools"。 */
    sendCommandImpl: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> = async () => ({})
    /** 置成 true 就让 attach 抛——模拟"用户此刻开着 DevTools"，Electron 的真实行为。 */
    attachThrows = false
    attach(): void {
      if (this.attachThrows) throw new Error('Another debugger is already attached to this target')
      this.attached = true
    }
    isAttached(): boolean { return this.attached }
    detach(): void { this.attached = false }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    off(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener({}, ...args)
    }
    async sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
      return await this.sendCommandImpl(method, params, sessionId)
    }
  }

  class FakeWebContents {
    static nextId = 1
    readonly id = FakeWebContents.nextId++
    emitMainNavigation = false
    url = 'https://example.invalid/'
    title = 'Example'
    destroyed = false
    readonly debugger = new FakeDebugger()
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    readonly session = {
      listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
      on(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this },
      removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener)); return this },
      emit(event: string, ...args: unknown[]) { for (const listener of [...this.listeners.get(event) ?? []]) listener(...args) },
      listenerCount(event: string) { return this.listeners.get(event)?.length ?? 0 }
    }
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    readonly capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toPNG: () => Buffer.alloc(0)
    }))
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this { return this.on(event, listener) }
    // 真的摘掉，不是 no-op：`input-event` 的判据之一就是「run 结束后监听器不再留着」，
    // 而一个 no-op 的假件会让那条判据永远为假、看起来像实现的错。
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
      return this
    }
    /** 模拟真人在这个 view 上的一次原生输入。 */
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener({}, ...args)
    }
    setWindowOpenHandler(): void {}
    disableDeviceEmulation(): void {}
    enableDeviceEmulation(): void {}
    setZoomFactor(): void {}
    getZoomFactor(): number { return 1 }
    getURL(): string { return this.url }
    getTitle(): string { return this.title }
    isLoading(): boolean { return false }
    isLoadingMainFrame(): boolean { return false }
    isDestroyed(): boolean { return this.destroyed }
    async loadURL(url: string): Promise<void> {
      this.url = url
      if (this.emitMainNavigation) for (const listener of this.listeners.get('did-start-navigation') ?? []) listener({ url, isMainFrame: true, isSameDocument: false })
      for (const listener of this.listeners.get('did-stop-loading') ?? []) listener({})
    }
    close(): void { this.destroyed = true }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    readonly webContents = new FakeWebContents()
    constructor() { FakeWebContentsView.instances.push(this) }
    setVisible(): void {}
    setBounds(): void {}
  }

  return { FakeWebContentsView }
})

vi.mock('electron', () => ({
  WebContentsView: fakeElectron.FakeWebContentsView,
  app: { getPath: () => tmpdir() }
}))

// 只替换派发层。CDP 会话用真的——`endedReason` 那条判据要的就是它真实的记账行为。
// 走 vi.hoisted 是因为 vi.mock 的工厂会被提到文件顶部，直接引用下面的 const 会撞到 TDZ。
//
// 返回类型**显式写成 `Promise<unknown>`**，与 `createBrowserPageDispatch` 的真实签名一致。不写的话
// TS 会从默认实现体推断出 `Promise<string>`——比生产窄，于是每个返回快照对象（`{ nodes: [...] }`）
// 或 `null` 的 `mockImplementationOnce` 都报 TS2322。假件的类型比被替换的真件窄，是在用测试替身
// 伪造一个生产不存在的约束，而 vitest 运行时照样放行，所以这族错误只有 tsc 看得见。
const dispatchSpy = vi.hoisted(() => {
  const calls: { name: string; args: unknown[] }[] = []
  const create = vi.fn(
    (_context: BrowserPageContext): ((name: string, args: unknown[]) => Promise<unknown>) =>
      async (name: string, args: unknown[]) => {
        calls.push({ name, args })
        return `dispatched:${name}`
      }
  )
  return { calls, create }
})
const dispatchCalls = dispatchSpy.calls
const createDispatch = dispatchSpy.create
vi.mock('../src/main/browser-page-dispatch.js', () => ({
  createBrowserPageDispatch: dispatchSpy.create,
  renderBrowserSnapshotText: () => ''
}))

import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'
import { BrowserViewManager, type BrowserProfileResolver } from '../src/main/browser-view-manager.js'
import { BrowserOperationFileStore, BrowserOperationJournal, type BrowserOperationJournalDocument } from '../src/main/browser-operation-journal.js'
import { BrowserStepEvidenceStore } from '../src/main/browser-step-evidence.js'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact.js'
import type { BrowserResultArtifactReference, BrowserResultArtifactChunk } from '../src/shared/browser-result-artifact.js'
import type { BrowserStructuredOutputReceipt } from '../src/shared/browser-structured-output.js'
import type { BrowserPageContext } from '../src/main/browser-page-dispatch.js'

const profiles: BrowserProfileResolver = {
  defaultProfileId: () => 'default',
  resolvePartition: (id) => `persist:${id}`
}

function fakeWindow(): any {
  const events: unknown[] = []
  return {
    events,
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    // Electron serializes at send time. Retaining the mutable operation object here would let later
    // phase changes rewrite earlier events and make a missing real-time emit pass this test.
    webContents: { isDestroyed: () => false, send: vi.fn((_channel, event) => events.push(structuredClone(event))) }
  }
}

async function managerWithBrowser(journal?: BrowserOperationJournal, evidence?: BrowserStepEvidenceStore,
  results?: BrowserResultArtifactStore, workspaceId: string | null = null, demonstrations?: BrowserDemonstrationRecorder, assets?: BrowserTaskAssets, downloads?: BrowserDownloads, uploads?: BrowserUploads): Promise<{
  manager: BrowserViewManager
  contents: any
  /** 到此刻为止推给渲染进程的每一个 browser 事件——判「驱动位有没有真的送出去」要读它。 */
  sentEvents: () => any[]
}> {
  dispatchCalls.length = 0
  createDispatch.mockClear()
  fakeElectron.FakeWebContentsView.instances.length = 0
  // ref 账本给临时路径：本文件 mock 掉了派发层，账本根本不会被读，但真路径会往 userData 里写文件。
  const window = fakeWindow()
  const manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(
    join(mkdtempSync(join(tmpdir(), 'agentmux-wiring-')), 'ref-ledger.json')
  ), {
    // 派发层已被 mock，应用链接走不到；给个惰性宿主，不要真的去开系统应用。
    rememberedSchemes: async () => ({}),
    rememberScheme: async () => {},
    openExternal: () => {}
  }, journal, evidence, results, demonstrations, assets, downloads, uploads)
  await manager.create('b1', 'https://example.invalid/', workspaceId)
  const view = fakeElectron.FakeWebContentsView.instances[0]!
  // 函数而不是数组：驱动的开始与结束各推一次，都发生在 create 之后，取快照就看不到它们了。
  return {
    manager,
    contents: view.webContents,
    sentEvents: () => window.events
  }
}

/**
 * 让派发层在**第一次**被调用时顺手模拟一次显式停止，并记下每次调用的名字。
 *
 * 停止请求必须从主进程这一侧发出，因为程序跑在它自己的子进程里，够不到 webContents。挂在
 * 第一次调用上是为了拿到确定的时序：「第一次动作发生过、之后的一个都没有」正是这套设计
 * 承诺的那句话。
 *
 * 放在模块级而不是某个 describe 里：驱动位那一族也要用它——「被掐断的运行有没有把驱动位还原」
 * 和「掐断之后动作停不停」是同一次接管的两个侧面，两处各写一份会漂。
 */
function stopOnFirstCall(manager: BrowserViewManager, sentEvents: () => any[]): string[] {
  const seen: string[] = []
  let fired = false
  createDispatch.mockImplementationOnce(() => async (name: string) => {
    seen.push(name)
    if (!fired) {
      fired = true
      const operationId = sentEvents().filter(event => event.browser?.id === 'b1').at(-1)?.browser.activity.operation?.id
      expect(operationId).toBeTruthy()
      await manager.stopOperationById(operationId)
    }
    return `dispatched:${name}`
  })
  return seen
}

describe('runScript records readable evidence for the exact step', () => {
  it('retains a completed observation and action before a failure, with durable evidence in the receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amx-step-wiring-'))
    const journalPath = join(root, 'journal.json')
    const evidence = new BrowserStepEvidenceStore(join(root, 'evidence'))
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
    const { manager } = await managerWithBrowser(journal, evidence)
    createDispatch.mockImplementationOnce(context => async name => {
      if (name === 'snapshot') return { ...context.pageInfo(), nodes: [{ ref: '@e1', role: 'button', name: 'Reveal', depth: 0, backendNodeId: 7 }], missingFrames: [] }
      if (name === 'click') return true
      throw new Error('page refused: private-input-never-in-diagnostic')
    })
    try {
      const report = await manager.runScript('b1', 'await snapshot(); await click("@e1"); await elementContext("@e404")')
      expect(report.outcome.kind).toBe('script-failed')
      expect(report.runOperation.steps).toEqual([
        expect.objectContaining({ sequence: 1, status: 'completed' }),
        expect.objectContaining({ sequence: 2, status: 'completed' }),
        expect.objectContaining({ sequence: 3, status: 'failed' })
      ])
      const saved = await manager.getStepEvidence(report.runOperation.id, 3)
      expect(saved.status).toBe('available')
      expect(saved.items).toHaveLength(1)
      expect(saved.items[0]?.reference).toMatchObject({ operationId: report.runOperation.id, sequence: 3, browserId: 'b1', kind: 'diagnostic' })
      expect(saved.items[0]?.content).toMatchObject({ kind: 'diagnostic', nextAction: expect.stringContaining('fresh snapshot') })
      expect(JSON.stringify(saved)).not.toContain('private-input')
      const first = await manager.getStepEvidence(report.runOperation.id, 1)
      expect(first.items[0]?.content).toMatchObject({ kind: 'page', text: expect.stringContaining('Reveal') })
      await expect(manager.getStepEvidence(report.runOperation.id, 2)).resolves.toMatchObject({ status: 'not-recorded', items: [] })
      const restarted = await managerWithBrowser(new BrowserOperationJournal(new BrowserOperationFileStore(journalPath)), new BrowserStepEvidenceStore(join(root, 'evidence')))
      try {
        await expect(restarted.manager.getStepEvidence(report.runOperation.id, 3)).resolves.toEqual(saved)
        await expect(restarted.manager.getOperation(report.runOperation.id)).resolves.toMatchObject({ phase: 'failed' })
      } finally { restarted.manager.dispose() }
    } finally { manager.dispose() }
  }, 30_000)

  it('does not turn a completed action into failure when evidence cannot be saved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amx-step-unavailable-'))
    const evidence = new BrowserStepEvidenceStore(join(root, 'evidence'))
    vi.spyOn(evidence, 'write').mockRejectedValue(new Error('disk full'))
    const { manager } = await managerWithBrowser(new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json'))), evidence)
    createDispatch.mockImplementationOnce(context => async () => ({ ...context.pageInfo(), nodes: [], missingFrames: [] }))
    try {
      const report = await manager.runScript('b1', 'await snapshot(); return "action-kept"')
      expect(report).toMatchObject({ result: 'action-kept', outcome: { kind: 'completed' } })
      expect(report.runOperation.steps).toEqual([expect.objectContaining({ status: 'completed' })])
      expect(report.runOperation.warning).toContain('could not be saved')
      await expect(manager.getStepEvidence(report.runOperation.id, 1)).resolves.toMatchObject({ status: 'unavailable', warning: expect.stringContaining('action result is retained'), items: [] })
    } finally { manager.dispose() }
  }, 30_000)
})

describe('structured extraction via the actual Manager → Journal → retained result chain', () => {
  it('joins only the Main-recorded extraction step to its exact artifact and reads without rerunning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amx-structured-wiring-'))
    const results = new BrowserResultArtifactStore(join(directory, 'results'))
    const { manager } = await managerWithBrowser(
      new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json'))),
      new BrowserStepEvidenceStore(join(directory, 'evidence')), results, 'workspace-structured')
    let calls = 0
    createDispatch.mockImplementationOnce(context => async name => {
      expect(name).toBe('extractStructured')
      calls++
      const source = { ...context.structuredOutput!.source(), url: context.pageInfo().url,
        document: 'actual-document:11', documentUrl: context.pageInfo().url, scope: { kind: 'page' as const } }
      const artifact = await results.registerJSON(source, { value: 'retained observation' })
      const receipt: BrowserStructuredOutputReceipt = { kind: 'browser-structured-output', status: 'complete', source,
        fields: [{ key: 'title', type: 'string', source: { selector: 'h1', read: 'text' },
          status: 'observed', inline: true, value: 'retained observation' }], work: null,
        artifactStatus: 'available', artifact }
      return receipt
    })
    try {
      const report = await manager.runScript('b1', 'return await extractStructured({fields:[{key:"title",type:"string",source:{selector:"h1",read:"text"}}]})')
      expect(report.outcome).toMatchObject({ kind: 'completed' })
      expect(report.runOperation.steps).toEqual([expect.objectContaining({ method: 'extractStructured', status: 'completed' })])
      const evidence = await manager.getStepEvidence(report.runOperation.id, 1)
      expect(evidence.items).toHaveLength(1)
      expect(evidence.items[0]?.content).toEqual({ kind: 'structured-output', receipt: report.result })
      const chunk = await manager.readStepResult(report.runOperation.id, 1, { offset: 0, maxBytes: 65536 })
      expect(JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'))).toEqual({ value: 'retained observation' })
      expect(calls).toBe(1)
      expect(await manager.listOperationHistory()).toEqual([expect.objectContaining({ id: report.runOperation.id })])

      // A receipt-shaped script result is not an extraction step recorded by Main.
      const foreign = await manager.runScript('b1', 'return ' + JSON.stringify(report.result))
      await expect(manager.readStepResult(foreign.runOperation.id, 1)).rejects.toThrow('no retained structured result')

      const corrupted = structuredClone(evidence)
      const item = corrupted.items[0]!
      if (item.content.kind !== 'structured-output') throw new Error('Actual extraction evidence absent')
      const reader = vi.spyOn(manager, 'getStepEvidence').mockResolvedValue(corrupted)
      try {
        for (const [field, value] of [
          ['operationId', 'other-operation'], ['browserId', 'other-browser'],
          ['workspaceId', 'other-workspace'], ['navigationId', 'other-document']
        ] as const) {
          item.content.receipt.source = { ...(report.result as BrowserStructuredOutputReceipt).source, [field]: value }
          await expect(manager.readStepResult(report.runOperation.id, 1), field).rejects.toThrow('does not belong')
        }
      } finally { reader.mockRestore() }
      expect(calls).toBe(1)
      expect(manager.resourceOwnerCounts().browserViews).toBe(1)
    } finally { manager.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  it('publishes and retains an observation warning while keeping the completed step and healthy Browser', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amx-structured-warning-'))
    const { manager, sentEvents } = await managerWithBrowser(
      new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json'))),
      new BrowserStepEvidenceStore(join(directory, 'evidence')))
    const warning = 'Structured result storage is unavailable. Inspect the live page before retrying.'
    let warningVisibleDuringRead = false
    createDispatch.mockImplementationOnce(context => async () => {
      context.note(warning)
      warningVisibleDuringRead = sentEvents().at(-1)?.browser.activity.operation.warning === warning
      const receipt: BrowserStructuredOutputReceipt = { kind: 'browser-structured-output', status: 'unavailable',
        source: { ...context.structuredOutput!.source(), url: context.pageInfo().url, document: 'actual-document:11',
          documentUrl: context.pageInfo().url, scope: { kind: 'page' } }, fields: [], work: null,
        artifactStatus: 'unavailable', warning }
      return receipt
    })
    try {
      const report = await manager.runScript('b1', 'return await extractStructured({fields:[{key:"title",type:"string",source:{selector:"h1",read:"text"}}]})')
      expect(report.outcome).toMatchObject({ kind: 'indeterminate', message: warning })
      expect(report.runOperation.steps).toEqual([expect.objectContaining({ method: 'extractStructured', status: 'completed' })])
      expect(warningVisibleDuringRead).toBe(true)
      expect(sentEvents().filter(event => event.browser?.activity?.warning === warning).length).toBeGreaterThan(0)
      await expect(manager.getOperation(report.runOperation.id)).resolves.toMatchObject({ phase: 'indeterminate', warning })
      await expect(manager.readStepResult(report.runOperation.id, 1)).rejects.toThrow('no retained structured result')
      expect(manager.resourceOwnerCounts().browserViews).toBe(1)
      await expect(manager.runScript('b1', 'return 42')).resolves.toMatchObject({ result: 42, outcome: { kind: 'completed' } })
    } finally { manager.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})

describe('human demonstration via the actual Manager → capture → recorder chain', () => {
  it('publishes a nonempty draft through Browser snapshots and recovers it without starting capture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amx-demonstration-owner-'))
    const storePath = join(directory, 'drafts.json')
    const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(storePath))
    const { manager, contents, sentEvents } = await managerWithBrowser(undefined, undefined, undefined, null, recorder)
    try {
      const started = await manager.startDemonstration('b1')
      expect(started.draft).toMatchObject({ browserId: 'b1', status: 'recording', steps: [] })
      expect(contents.debugger.isAttached()).toBe(true)
      recorder.noteNativeInput({ browserId: 'b1', navigationId: started.draft!.navigationId, type: 'mouseDown' })
      await recorder.recordBrowserDemonstration({ browserId: 'b1', navigationId: started.draft!.navigationId,
        kind: 'click', isTrusted: true, target: { role: 'button', name: 'Review preferences', ordinal: 1, count: 1 } })
      const stopped = await manager.stopDemonstration('b1')
      expect(stopped.draft).toMatchObject({ id: started.draft!.id, status: 'stopped',
        steps: [expect.objectContaining({ method: 'click', source: 'native-human', target: { role: 'button', name: 'Review preferences', ordinal: 1, count: 1 } })] })
      expect(sentEvents().at(-1)?.browser.demonstration).toEqual(stopped)
      expect(contents.debugger.isAttached()).toBe(false)
      manager.dispose()
      const restored = await managerWithBrowser(undefined, undefined, undefined, null,
        new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(storePath)))
      try {
        await expect(restored.manager.getDemonstration('b1')).resolves.toEqual(stopped)
        expect(restored.contents.debugger.isAttached()).toBe(false)
        expect(restored.sentEvents().at(-1)?.browser.demonstration).toEqual(stopped)
      } finally { restored.manager.dispose() }
    } finally { manager.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  it('one actual capture owner moves between Browsers and releases the previous native session', async () => {
    const recorder = new BrowserDemonstrationRecorder({ load: async () => null, save: async () => {} })
    const { manager, contents } = await managerWithBrowser(undefined, undefined, undefined, null, recorder)
    try {
      const first = await manager.startDemonstration('b1')
      await manager.create('b2', 'https://second.example.invalid/')
      const secondContents = fakeElectron.FakeWebContentsView.instances[1]!.webContents
      const second = await manager.startDemonstration('b2')
      expect(second.draft).toMatchObject({ browserId: 'b2', status: 'recording' })
      expect(contents.debugger.isAttached()).toBe(false)
      expect(secondContents.debugger.isAttached()).toBe(true)
      await expect(manager.getDemonstration('b1')).resolves.toMatchObject({ draft: { id: first.draft!.id, status: 'stopped' } })
      await manager.stopDemonstration('b2')
      expect(secondContents.debugger.isAttached()).toBe(false)
    } finally { manager.dispose() }
  }, 30_000)

  it('a slow recording start releases synchronously and never gates or reattaches after a healthy Agent run', async () => {
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let holdFirst = true
    const recorder = new BrowserDemonstrationRecorder({ load: async () => null, save: async document => {
      if (holdFirst && document.drafts.at(-1)?.status === 'recording') { holdFirst = false; entered(); await held }
    } })
    const { manager, contents } = await managerWithBrowser(undefined, undefined, undefined, null, recorder)
    const attach = vi.spyOn(contents.debugger, 'attach')
    const start = manager.startDemonstration('b1').then(value => value, error => error)
    try {
      await ready
      const outcome = await Promise.race([
        manager.runScript('b1', 'return 41').then(value => value, error => error),
        new Promise(resolve => setTimeout(() => resolve('run blocked on recording storage'), 3_000))
      ])
      expect(outcome).toMatchObject({ result: 41, outcome: { kind: 'completed' } })
      expect(attach).toHaveBeenCalledTimes(1)
      release()
      expect(await start).toEqual(expect.objectContaining({ message: expect.stringContaining('no longer owns') }))
      await manager.stopDemonstration('b1')
      expect(attach).toHaveBeenCalledTimes(1)
      expect(contents.debugger.isAttached()).toBe(false)
      await expect(manager.runScript('b1', 'return 42')).resolves.toMatchObject({ result: 42, outcome: { kind: 'completed' } })
    } finally { release(); await start; attach.mockRestore(); manager.dispose() }
  }, 30_000)

  it('an old capture callback cannot overwrite the newer recording on the same entry/view', async () => {
    const recorder = new BrowserDemonstrationRecorder({ load: async () => null, save: async () => {} })
    const originalStart = BrowserDemonstrationCapture.prototype.start
    const captures: BrowserDemonstrationCapture[] = []
    const start = vi.spyOn(BrowserDemonstrationCapture.prototype, 'start').mockImplementation(function(this: BrowserDemonstrationCapture) {
      captures.push(this)
      return originalStart.call(this)
    })
    const { manager, sentEvents } = await managerWithBrowser(undefined, undefined, undefined, null, recorder)
    try {
      const first = await manager.startDemonstration('b1')
      await manager.stopDemonstration('b1')
      const second = await manager.startDemonstration('b1')
      expect(captures).toHaveLength(2)
      expect(second.draft!.id).not.toBe(first.draft!.id)
      // Exercise the callback supplied by Main: model an async producer completing after replacement.
      const old = captures[0] as unknown as { options: { onDraft: (draft: BrowserDemonstrationDraft, warning?: string) => void } }
      old.options.onDraft(first.draft!, 'Late producer result')
      expect(sentEvents().at(-1)?.browser.demonstration).toEqual(second)
      await expect(manager.getDemonstration('b1')).resolves.toEqual(second)
    } finally { start.mockRestore(); manager.dispose() }
  }, 30_000)

  it('a recovered recording draft is interrupted and has no capture listener beyond its ordinary window pointer owner', async () => {
    const draft: BrowserDemonstrationDraft = { id: 'prior-draft', browserId: 'b1', navigationId: 'prior-nav',
      url: 'https://example.invalid/', revision: 2, status: 'recording', startedAt: 1, updatedAt: 2,
      steps: [{ id: 'prior-step', sequence: 1, recordedAt: 2, navigationId: 'prior-nav', source: 'native-human',
        method: 'fillInput', url: 'https://example.invalid/', args: [], inputKey: 'input-1', blockedReason: 'Supply a fresh parameter.' }] }
    const persisted: BrowserDemonstrationDocument = { version: 1, drafts: [draft] }
    const recorder = new BrowserDemonstrationRecorder({ load: async () => structuredClone(persisted), save: async () => {} })
    const { manager, contents, sentEvents } = await managerWithBrowser(undefined, undefined, undefined, null, recorder)
    try {
      const restored = await manager.getDemonstration('b1')
      expect(restored.draft).toMatchObject({ id: 'prior-draft', status: 'interrupted', steps: [expect.objectContaining({ inputKey: 'input-1' })] })
      expect(restored.warning).toContain('restart')
      expect(sentEvents().at(-1)?.browser.demonstration).toEqual(restored)
      expect(contents.debugger.isAttached()).toBe(false)
      expect(contents.listeners.get('input-event') ?? []).toHaveLength(1)
      await expect(manager.runScript('b1', 'return 7')).resolves.toMatchObject({ result: 7, outcome: { kind: 'completed' } })
    } finally { manager.dispose() }
  }, 30_000)
})

describe('runScript waiting follows the Core capability effects', () => {
  const waitCapabilities = browserPageCapabilityNames('wait')
  it('the authoritative wait set is nonempty', () => {
    expect(waitCapabilities.length).toBeGreaterThan(0)
  })

  it.each(waitCapabilities)('%s emits waiting only while dispatch is pending and restores running before the next step', async name => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const phases: string[] = []
    createDispatch.mockImplementationOnce(() => async called => {
      phases.push(sentEvents().at(-1)?.browser.activity.operation.phase)
      if (called === name) { entered(); await pending }
      return true
    })
    try {
      const running = manager.runScript('b1', `await ${name}(); return await js('true')`)
      await ready
      expect(sentEvents().at(-1)?.browser.activity.operation.phase).toBe('waiting')
      release()
      const report = await running
      expect(phases).toEqual(['waiting', 'running'])
      expect(report.outcome.kind).toBe('completed')
      expect(sentEvents().at(-1)?.browser.activity.operation.phase).toBe('completed')
      // Existing operation feedback uses its own isolated world; waiting must not
      // execute a second business script through this native boundary.
      expect(contents.executeJavaScriptInIsolatedWorld.mock.calls
        .filter(([worldId]) => worldId !== BROWSER_OPERATION_FEEDBACK_WORLD_ID)).toEqual([])
    } finally { release(); manager.dispose() }
  }, 30_000)

  it('wait rejection restores running for a caught error before the next observation', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const phases: string[] = []
    createDispatch.mockImplementationOnce(() => async name => {
      phases.push(sentEvents().at(-1)?.browser.activity.operation.phase)
      if (name === 'waitForElement') throw new Error('element not found')
      return true
    })
    try {
      const report = await manager.runScript('b1', "try { await waitForElement() } catch {} return await pageInfo()")
      expect(phases).toEqual(['waiting', 'running'])
      expect(report.outcome.kind).toBe('completed')
    } finally { manager.dispose() }
  }, 30_000)

  it('completing a wait never overwrites explicit Stop', async () => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const phases: string[] = []
    createDispatch.mockImplementationOnce(() => async name => {
      if (name === 'waitForElement') await manager.stopOperationById(sentEvents().at(-1)?.browser.activity.operation.id)
      phases.push(sentEvents().at(-1)?.browser.activity.operation.phase)
      return true
    })
    try {
      const report = await manager.runScript('b1', 'await waitForElement(); return await pageInfo()')
      expect(phases).toEqual(['stopped'])
      expect(report.outcome.kind).toBe('stopped')
      expect(sentEvents().at(-1)?.browser.activity.control).toBe('human')
    } finally { manager.dispose() }
  }, 30_000)

  it('a healthy completed program retains a cleanup warning and remains runnable', async () => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const originalOff = contents.debugger.off
    contents.debugger.off = () => { throw new Error('listener removal unavailable') }
    try {
      const report = await manager.runScript('b1', 'return 7')
      expect(report).toMatchObject({ result: 7, outcome: { kind: 'completed' }, runOperation: { warning: expect.stringContaining('cleanup') } })
      expect(sentEvents().at(-1)?.browser.activity.warning).toContain('cleanup')
      expect(contents.debugger.isAttached()).toBe(false)
      contents.debugger.off = originalOff
      await expect(manager.runScript('b1', 'return 8')).resolves.toMatchObject({ result: 8, outcome: { kind: 'completed' } })
    } finally { contents.debugger.off = originalOff; manager.dispose() }
  }, 30_000)
})

describe('runScript 把页面调用交给派发层', () => {
  it('Agent 程序调页面函数，落到 createBrowserPageDispatch 建的那个闭包上', async () => {
    const { manager, contents } = await managerWithBrowser()

    const report = await manager.runScript('b1', 'return await snapshot()')

    // 删掉 runScript 里的接线，这两条立刻红——这正是它存在的理由。
    expect(createDispatch, '派发层没被建起来——runScript 走的是别的路').toHaveBeenCalledTimes(1)
    expect(dispatchCalls.map((call) => call.name), 'snapshot() 没有落到派发层上')
      .toEqual(['snapshot'])
    expect(report.outcome.kind, `程序没跑完：${JSON.stringify(report.outcome)}`).toBe('completed')
    expect(report.result, '派发层的返回值没回到脚本手里').toBe('dispatched:snapshot')
    // 用完必须摘干净：不摘的话用户此后再也打不开这个页面的 DevTools，而且是静默的。
    expect(contents.debugger.isAttached(), '跑完了 debugger 还挂着').toBe(false)
  }, 30_000)

  it('参数原样送到派发层，不在中途被改写', async () => {
    const { manager } = await managerWithBrowser()

    await manager.runScript('b1', 'await click("@e3"); await fillInput("@e7", "hello")')

    expect(dispatchCalls).toEqual([
      { name: 'click', args: ['@e3'] },
      { name: 'fillInput', args: ['@e7', 'hello'] }
    ])
  }, 30_000)

  it('程序抛了就是 script-failed，不许升级成 indeterminate', async () => {
    // 反向判据。少了它，一个"永远报 indeterminate"的实现会让下面那条 detach 判据全绿——
    // 而 indeterminate 的含义是"别重试、先去看页面"，滥发它等于让 Agent 永远不敢往下走。
    const { manager } = await managerWithBrowser()

    const report = await manager.runScript('b1', 'throw new Error("my bug")')

    expect(report.outcome.kind).toBe('script-failed')
  }, 30_000)

  it('attach 失败之后这个 Browser 还能再跑——失败不许把它锁死', async () => {
    // 用户开着 DevTools 时 attach 必抛，这是**常规路径**（那句错误自己就说了"关掉 DevTools 再跑"）。
    // 而 `runInFlight` 在 attach 之前就被置了 true：抛在 try 外面，这一位永远回不去，此后每次
    // run 都报"另一个操作正在运行"——可 `activeRun` 是空的，连个能停的东西都没有，只有销毁重建
    // 这个 view 才能恢复。一次可恢复的失败被变成了不可恢复的。
    const { manager, contents } = await managerWithBrowser()
    contents.debugger.attachThrows = true

    await expect(manager.runScript('b1', 'return 1')).rejects.toThrow(/DevTools/)

    // 人照着提示关掉了 DevTools，下一次必须真的能跑。
    contents.debugger.attachThrows = false
    const report = await manager.runScript('b1', 'return await snapshot()')
    expect(report.outcome.kind, 'attach 失败把 Browser 锁死了：此后再也跑不起来').toBe('completed')
  }, 30_000)

  it('会话中途没了，即便程序自己吞掉了错误也要报 indeterminate', async () => {
    const { manager, contents } = await managerWithBrowser()
    createDispatch.mockImplementationOnce(() => async () => {
      // 用户中途打开 DevTools：Electron 会把我们踢掉，debugger 发出 detach。
      contents.debugger.emit('detach', 'target closed')
      throw new Error('the debugging session for this Browser ended')
    })

    // 这段程序是 Agent 的**正常写法**：包一层 try/catch 然后照常返回。
    const report = await manager.runScript(
      'b1',
      'try { await click("@e1") } catch (error) { } return "done"'
    )

    // 判在 manager 这一层，所以程序 catch 不 catch 都盖不住。判在脚本那一层就会被这个 catch 吃掉，
    // 一次不知道点没点成的运行会被报成 completed——而 completed 连个放警告的字段都没有。
    expect(report.outcome.kind, '会话中途没了却报成功——页面可能已经被点过一次了').toBe('indeterminate')
    expect(
      report.outcome.kind === 'indeterminate' ? report.outcome.message : '',
      '没说清是会话没了、也没说下一步该干什么'
    ).toMatch(/DevTools/)

    // 被踢掉之后照样要把监听摘干净。漏掉的话每一次「跑到一半被打开 DevTools」都会在 debugger 上
    // 留一对永不回收的 handler，跑十次就是十对——而它一声不响，只有内存慢慢长。
    // （这条是变异测出来的：把 detach 改成「会话没了就整个跳过」，此前全部 12 条测试照样绿。）
    for (const event of ['detach', 'message']) {
      expect(contents.debugger.listeners.get(event) ?? [], `${event} 的监听没摘掉——每轮泄漏一对`)
        .toHaveLength(0)
    }
  }, 30_000)
})

describe('explicit Browser control', () => {
  it('the built CLI stops the exact live operation through the public socket and actual client branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amx-explicit-cli-'))
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json')))
    let dispatchFinished!: () => void
    const stepSaved = new Promise<void>(resolve => { dispatchFinished = resolve })
    const finishStep = journal.finishStep.bind(journal)
    const observedFinish = vi.spyOn(journal, 'finishStep').mockImplementation(async (...args) => {
      try { return await finishStep(...args) } finally { dispatchFinished() }
    })
    const { manager, sentEvents } = await managerWithBrowser(journal)
    const source = await readFile(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
    const from = source.indexOf("    if (request.operation === 'browser.stop')")
    const until = source.indexOf("    // browser.subscribe", from)
    expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const execute = new AsyncFunction('request', 'api', source.slice(from, until))
    const api = { browser: { stopOperationById: (id: string) => manager.stopOperationById(id), getOperation: (id: string) => manager.getOperation(id) } }
    const socketPath = join(directory, 'control.sock')
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], execute: async request =>
      projectBrowserControlResult(await execute(request, api)) })
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const calls: string[] = []
    createDispatch.mockImplementationOnce(() => async name => { calls.push(name); entered(); await held; return null })
    const operationId = 'op:public-explicit-stop'
    let pending: ReturnType<BrowserViewManager['runScript']> | undefined
    try {
      await server.start()
      pending = manager.runScript('b1', 'await snapshot(); await click("@e1")', undefined, undefined, operationId)
      await ready
      const reply = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'browser', 'stop', '--operation-id', operationId], objectCliEnvironment(directory))
      expect(reply.code, reply.stderr).toBe(0)
      expect(JSON.parse(reply.stdout).result.runOperation).toMatchObject({ id: operationId, browserId: 'b1', phase: 'stopped' })
      expect(sentEvents().at(-1)?.browser.activity.control).toBe('human')
      expect((await pending).outcome.kind).toBe('stopped')
      expect(calls).toEqual(['snapshot'])
      const inspect = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'browser', 'inspect', '--operation-id', operationId], objectCliEnvironment(directory))
      expect(inspect.code, inspect.stderr).toBe(0)
      expect(JSON.parse(inspect.stdout).result.runOperation).toMatchObject({ id: operationId, phase: 'stopped' })
      await expect(manager.runScript('b1', 'return 1')).rejects.toMatchObject({ code: 'BROWSER_HUMAN_CONTROL_ACTIVE' })
    } finally {
      release(); await pending; await server.stop()
      // Stop ends the child before its held page call finishes. Preserve the real journal write.
      if (calls.length > 0) await stepSaved
      observedFinish.mockRestore(); manager.dispose(); await rm(directory, {recursive: true, force: true})
    }
  }, 30_000)

  for (const type of ['mouseDown', 'mouseUp', 'mouseWheel', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'pointerDown', 'mouseMove']) {
    it(`ordinary native ${type} never takes control or cancels the program`, async () => {
      const { manager, contents, sentEvents } = await managerWithBrowser()
      const listeners = [...contents.listeners.get('input-event') ?? []]
      const calls: string[] = []
      createDispatch.mockImplementationOnce(() => async name => {
        calls.push(name)
        contents.emit('input-event', { type })
        expect(sentEvents().at(-1)?.browser.activity.control).toBe('agent')
        expect(sentEvents().at(-1)?.browser.driving).toBe(true)
        return null
      })
      try {
        const report = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')
        expect(report.outcome.kind).toBe('completed')
        expect(report.result).toBe('done')
        expect(calls).toEqual(['click', 'click'])
        expect(sentEvents().at(-1)?.browser.activity.control).toBe('agent')
        expect(contents.listeners.get('input-event') ?? []).toEqual(listeners)
      } finally { manager.dispose() }
    }, 30_000)
  }

  it('explicit Stop ends the original program even when its code catches errors', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const calls = stopOnFirstCall(manager, sentEvents)
    try {
      const report = await manager.runScript('b1', 'await click("@e1"); try { await click("@e2") } catch {} return "done"', undefined, undefined, 'op:explicit-catch')
      expect(report.outcome.kind).toBe('stopped')
      expect(calls).toEqual(['click'])
      expect(sentEvents().at(-1)?.browser.activity.control).toBe('human')
      expect(report.runOperation.phase).toBe('stopped')
      expect(report.outcome.kind === 'stopped' && report.outcome.message).toMatch(/stopped explicitly/i)
    } finally { manager.dispose() }
  }, 30_000)

  it('a fresh run requires explicit Return; Return does not replay the old program', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const calls = stopOnFirstCall(manager, sentEvents)
    try {
      const stopped = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "old"', undefined, undefined, 'op:explicit-return')
      expect(stopped.outcome.kind).toBe('stopped')
      for (const attempt of [1, 2, 3]) {
        await expect(manager.runScript('b1', `return ${attempt}`)).rejects.toMatchObject({ code: 'BROWSER_HUMAN_CONTROL_ACTIVE' })
      }
      manager.returnControl('b1')
      expect(calls).toEqual(['click'])
      expect(stopped.runOperation.phase).toBe('stopped')
      expect(await manager.runScript('b1', 'return "fresh"')).toMatchObject({ outcome: {kind: 'completed'}, result: 'fresh' })
      expect(calls).toEqual(['click'])
    } finally { manager.dispose() }
  }, 30_000)
})

/**
 * 驱动这件事要推给渲染进程——页面内角标之外的另一半覆盖面。
 *
 * 角标（T-012）只在人**看着那一页**时成立，而人恰恰常在别处干活。标签上要认得出是哪一格，
 * 渲染进程就必须知道；这里判的是「主进程有没有把它送出去」，标签怎么画由
 * `workbench-tab-marks.test.ts` 判。两条缺一不可：只判后者的话，一个从不 emit 的实现照样全绿
 * ——纯函数收到什么就画什么，而真实世界里它永远收不到 true。
 */
describe('runScript：驱动状态推到渲染进程', () => {
  /** 推给渲染的每一个 `updated` 事件里的 driving 位，按时间序。 */
  function drivingSequence(events: any[]): boolean[] {
    return events
      .filter((event) => event?.type === 'updated')
      .map((event) => event.browser.driving)
      .filter((value, index, values) => index === 0 || value !== values[index - 1])
  }

  it('运行期间推一次 true，结束后推一次 false', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const before = drivingSequence(sentEvents()).length

    await manager.runScript('b1', 'return await snapshot()')

    // 只判最后两个：create 与导航自己也会推事件，它们的 driving 都是 false，数进来会让断言
    // 依赖那些事件的个数——那是别的代码的实现细节。
    expect(drivingSequence(sentEvents()).slice(before), '驱动的开始或结束没有推出去').toEqual([
      true,
      false
    ])
  }, 30_000)

  it('人接管把运行掐断之后，收尾那次 false 照样推出去', async () => {
    // 这条是 finally 那一句的判据。漏掉它，标签会永远停在"正在被驱动"——而那一段程序早就停了，
    // 比不画更糟：它让人以为 Agent 还在动，从而不敢去碰那个页面。
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const before = drivingSequence(sentEvents()).length
    stopOnFirstCall(manager, sentEvents)

    const report = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"', undefined, undefined, 'op:explicit-driving')

    expect(report.outcome.kind, '这条没走到接管那条路上，判据在对空气生效').toBe('stopped')
    expect(drivingSequence(sentEvents()).slice(before), '被掐断的运行没把驱动位还原').toEqual([
      true,
      false
    ])
  }, 30_000)

  it('程序抛出来的那次也把驱动位还原——finally 不是只管顺利跑完的那条路', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const before = drivingSequence(sentEvents()).length

    const report = await manager.runScript('b1', 'throw new Error("my bug")')

    expect(report.outcome.kind).toBe('script-failed')
    expect(drivingSequence(sentEvents()).slice(before), '程序抛了就把标签卡在驱动态了').toEqual([
      true,
      false
    ])
  }, 30_000)
})

describe('Browser RSI：manager 到真实 journal 的竖切', () => {
  function fileJournal() {
    const path = join(mkdtempSync(join(tmpdir(), 'agentmux-operation-wiring-')), 'operations.json')
    return { path, journal: new BrowserOperationJournal(new BrowserOperationFileStore(path)) }
  }

  it('另一真实进程持写锁时 Main 仍完成健康 Browser，保留原增量待存储恢复', async () => {
    const { path, journal } = fileJournal()
    await journal.start({ id: 'original', browserId: 'b1', operator: { id: 'person', name: 'Person' }, summary: 'Original', url: 'https://example.invalid/' })
    await journal.finish('original', 'completed')
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked');
      process.stdin.once('data', () => { database.exec('ROLLBACK'); database.close(); process.exit(0); });
    `, path], { stdio: ['pipe', 'pipe', 'ignore'] })
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error(`SQLite lock process exited ${code}`))); child.once('error', reject) })
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('exit', code => reject(new Error(`SQLite lock was not obtained (${code})`))); child.once('error', reject) })
      const { manager, sentEvents } = await managerWithBrowser(journal)
      const started = performance.now()
      const report = await manager.runScript('b1', 'return await snapshot()')
      expect(performance.now() - started, 'A storage lock blocked the Main event loop').toBeLessThan(1000)
      expect(report.outcome.kind).toBe('completed')
      expect(report.result).toBe('dispatched:snapshot')
      expect(report.runOperation?.warning).toContain('could not be saved')
      expect(sentEvents().at(-1)?.browser.activity.warning).toContain('could not be saved')
      child.stdin.write('release'); await exited
      await journal.finish(report.runOperation!.id, 'completed')
      const recovered = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect(await recovered.get('original')).toMatchObject({ id: 'original', phase: 'completed' })
      expect(await recovered.get(report.runOperation!.id)).toMatchObject({ phase: 'completed', steps: [{ sequence: 1, status: 'completed' }] })
    } finally {
      if (child.exitCode === null) child.stdin.write('release')
      await exited
      await rm(dirname(path), { recursive: true, force: true })
    }
  }, 30_000)

  it('旧步骤缺口在 Main owner 拒绝整轮和单步，原页面仍可执行新操作', async () => {
    const { path, journal: first } = fileJournal()
    await first.start({ id: 'legacy-gap', browserId: 'b1', operator: { id: 'agent', name: 'Agent' }, summary: 'Original', url: 'https://example.invalid/' })
    for (let index = 1; index <= 3; index++) {
      await first.startStep('legacy-gap', { method: 'pressKey', label: 'Original key', replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
      await first.finishStep('legacy-gap', index, { status: 'completed' })
    }
    await first.finish('legacy-gap', 'completed')
    const document = (await new BrowserOperationFileStore(path).load())!
    document.operations[0]!.steps = document.operations[0]!.steps.slice(1)
    const database = new DatabaseSync(path)
    database.prepare('DELETE FROM steps WHERE operation_id = ? AND sequence = 1').run('legacy-gap')
    database.close() // A stored retained tail, not a new empty identity.
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
    const { manager, contents } = await managerWithBrowser(journal)
    const surviving = document.operations[0]!.steps.map(step => step.replay!)
    const plan = { schema: 'agentmux.browser-replay.v1' as const, operationId: 'legacy-gap', url: 'https://example.invalid/', steps: surviving }
    createDispatch.mockClear()
    await expect(manager.replayPlan('legacy-gap')).rejects.toThrow(/incomplete/)
    await expect(manager.runReplay('b1', plan)).rejects.toThrow(/incomplete/)
    await expect(manager.runReplay('b1', { ...plan, steps: [surviving[0]!] })).rejects.toThrow(/incomplete/)
    expect(createDispatch).not.toHaveBeenCalled()
    expect(contents.isDestroyed()).toBe(false)
    expect((await journal.get('legacy-gap'))?.steps.map(step => step.sequence)).toEqual([2, 3])
    expect(await manager.runScript('b1', 'return "new work remains available"')).toMatchObject({ result: 'new work remains available', outcome: { kind: 'completed' } })
  }, 30_000)

  it('未知和停止的原操作不能通过调用者自制单步计划重放', async () => {
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    await journal.start({ id: 'original-unknown', browserId: 'b1', operator: { id: 'agent', name: 'Agent' }, summary: 'Original', url: 'https://example.invalid/' })
    await journal.startStep('original-unknown', { method: 'pressKey', label: 'Applied key', replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
    await journal.finishStep('original-unknown', 1, { status: 'completed' })
    const plan = { schema: 'agentmux.browser-replay.v1' as const, operationId: 'original-unknown', url: 'https://example.invalid/', steps: [{ method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] }] }
    for (const phase of ['indeterminate', 'stopped'] as const) {
      await journal.finish('original-unknown', phase)
      createDispatch.mockClear()
      await expect(manager.runReplay('b1', plan)).rejects.toThrow(/stopped|unconfirmed/)
      expect(createDispatch).not.toHaveBeenCalled()
      expect(await journal.get('original-unknown')).toMatchObject({ id: 'original-unknown', phase })
    }
  })

  it('真实 CLI 经公共 socket 与当前 Workbench 分支消费原 identity、整轮/单步和缺口拒绝', async () => {
    const { path, journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    await journal.start({ id: 'cli-original', browserId: 'b1', operator: { id: 'agent', name: 'Agent' }, summary: 'Original', url: 'https://example.invalid/' })
    for (let sequence = 1; sequence <= 2; sequence++) {
      await journal.startStep('cli-original', { method: 'pressKey', label: 'Key', replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
      await journal.finishStep('cli-original', sequence, { status: 'completed' })
    }
    await journal.finish('cli-original', 'completed')
    for (let index = 0; index < 64; index++) {
      const id = `cli-later-${index}`
      await journal.start({ id, browserId: 'b1', operator: { id: 'agent', name: 'Agent' }, summary: 'Later', url: 'https://example.invalid/' })
      await journal.finish(id, 'completed')
    }
    // Execute the unchanged production Control branch, rather than reimplementing its mode semantics.
    const source = await readFile(join(process.cwd(), 'apps/desktop/src/renderer/src/store.ts'), 'utf8')
    const from = source.indexOf("    if (request.operation === 'browser.history')")
    const until = source.indexOf('    const state = get()', from)
    expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const execute = new AsyncFunction('request', 'api', 'controlFailure', 'requireActive', source.slice(from, until))
    const api = { browser: {
      listOperationHistory: () => manager.listOperationHistory(),
      getOperation: (id: string) => manager.getOperation(id),
      replayPlan: (id: string) => manager.replayPlan(id),
      runReplay: (id: string, plan: Parameters<BrowserViewManager['runReplay']>[1]) => manager.runReplay(id, plan)
    } }
    const socketPath = join(dirname(path), 'control.sock')
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], execute: async request =>
      projectBrowserControlResult(await execute(request, api, (code: string, message: string) => Object.assign(new Error(message), { code }), () => {})) })
    await server.start()
    const invoke = (args: string[]) => runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'browser', ...args], objectCliEnvironment(dirname(path)))
    const previousDispatch = createDispatch.getMockImplementation()!
    createDispatch.mockImplementation(() => async name => name === 'pageInfo' ? { url: 'https://example.invalid/' } : null)
    try {
      const history = await invoke(['history', '--browser', 'b1'])
      expect(history.code, history.stderr).toBe(0)
      expect(JSON.parse(history.stdout).result.operations).toHaveLength(64)
      expect(JSON.parse(history.stdout).result.operations.some((operation: { id: string }) => operation.id === 'cli-original')).toBe(false)
      const inspect = await invoke(['inspect', '--operation-id', 'cli-original'])
      expect(inspect.code, inspect.stderr).toBe(0)
      expect(JSON.parse(inspect.stdout).result.runOperation).toMatchObject({ id: 'cli-original', steps: [{ sequence: 1 }, { sequence: 2 }] })
      const preview = await invoke(['replay', '--browser', 'b1', '--operation-id', 'cli-original', '--preview'])
      expect(preview.code, preview.stderr).toBe(0)
      expect(JSON.parse(preview.stdout).result.plan.steps).toHaveLength(2)
      for (const [mode, count] of [[['--run'], 2], [['--step', '2'], 1]] as const) {
        const reply = await invoke(['replay', '--browser', 'b1', '--operation-id', 'cli-original', ...mode])
        expect(reply.code, reply.stderr).toBe(0)
        expect(JSON.parse(reply.stdout).result).toMatchObject({ result: { replayOf: 'cli-original', steps: count }, outcome: { kind: 'completed' }, runOperation: { replayOf: 'cli-original' } })
      }
      for (const barrier of ['unsafe', 'failed', 'no-contribution'] as const) {
        const id = `cli-${barrier}`
        await journal.start({ id, browserId: 'b1', operator: { id: 'agent', name: 'Agent' }, summary: 'Original barrier', url: 'https://example.invalid/' })
        await journal.startStep(id, { method: 'pressKey', label: 'Safe-looking first step', replay: { method: 'pressKey', url: 'https://example.invalid/', args: ['ArrowDown'] } })
        await journal.finishStep(id, 1, { status: 'completed' })
        await journal.startStep(id, { method: barrier === 'unsafe' ? 'fillInput' : 'snapshot', label: 'Original barrier',
          ...(barrier === 'unsafe' ? { replay: { method: 'fillInput', url: 'https://example.invalid/', args: ['private original input'] } } : {}) })
        await journal.finishStep(id, 2, { status: barrier === 'failed' ? 'failed' : 'completed' })
        await journal.finish(id, barrier === 'failed' ? 'failed' : 'completed')
        const authoritative = await manager.replayPlan(id)
        expect(authoritative?.steps).toHaveLength(2)
        expect(authoritative?.steps[1]?.blockedReason).toBeTruthy()
        createDispatch.mockClear()
        // Even a direct IPC caller stripping the original barrier cannot dispatch an action.
        const forged = { ...authoritative!, steps: authoritative!.steps.map(({ blockedReason: _blocked, ...step }) => step) }
        await expect(manager.runReplay('b1', forged)).rejects.toThrow(/original.*requires review/i)
        await expect(manager.runReplay('b1', { ...forged, steps: [forged.steps[0]!] })).rejects.toThrow(/original.*requires review/i)
        for (const mode of [['--run'], ['--step', '1']]) {
          const rejected = await invoke(['replay', '--browser', 'b1', '--operation-id', id, ...mode])
          expect(rejected.code).toBe(1)
          expect(JSON.parse(rejected.stderr).error.message).toMatch(/original.*requires review/i)
        }
        expect(createDispatch).not.toHaveBeenCalled()
        expect((await journal.get(id))?.steps).toHaveLength(2)
      }
      const document = (await new BrowserOperationFileStore(path).load())!
      document.operations.find(operation => operation.id === 'cli-original')!.steps.shift()
      const database = new DatabaseSync(path)
      database.prepare('DELETE FROM steps WHERE operation_id = ? AND sequence = 1').run('cli-original')
      database.close()
      const restored = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      api.browser.replayPlan = id => restored.replayPlan(id)
      createDispatch.mockClear()
      for (const mode of [['--preview'], ['--run'], ['--step', '1']]) {
        const reply = await invoke(['replay', '--browser', 'b1', '--operation-id', 'cli-original', ...mode])
        expect(reply.code).toBe(1)
        expect(JSON.parse(reply.stderr).error.message).toContain('incomplete')
      }
      expect(createDispatch).not.toHaveBeenCalled()
      expect((await restored.get('cli-original'))?.steps.map(step => step.sequence)).toEqual([2])
    } finally { createDispatch.mockImplementation(previousDispatch); await server.stop(); await rm(dirname(path), { recursive: true, force: true }) }
  }, 30_000)

  it('子进程崩了：收据和 history 必须给出同一个结论，不能一个说别重试、一个说改完重跑', async () => {
    // 这是一次**真的**崩溃：脚本让自己的进程直接退出，不走结果帧那条路。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)

    const report = await manager.runScript('b1', 'process.exit(7)')

    // 收据这一侧早就对了：崩溃意味着"做到哪一步不知道"——页面上可能已经点过一次了。
    expect(report.outcome.kind).toBe('indeterminate')
    // journal 这一侧曾经把它折进 `failed`（写的是 `stopped ? stopped : failed`）。于是同一次崩溃，
    // Agent 读到"先看一眼页面、别重试"，人在历史里读到"失败了，改完重跑"——两个相反的下一步。
    // phase 枚举里本来就有 `indeterminate`，所以这不是缺词，是映射错了。
    expect(report.runOperation?.phase, '收据说 indeterminate，operation 却记成别的——同一次崩溃两个结论')
      .toBe('indeterminate')
    const history = await manager.listOperationHistory()
    expect(history.at(-1)?.phase, 'history 里的 phase 和收据不一致').toBe('indeterminate')
  }, 30_000)

  it('同一 operation identity 经 receipt、实时事件与重启后的 history 保留语义目标', async () => {
    const { path, journal } = fileJournal()
    const { manager, sentEvents } = await managerWithBrowser(journal)
    const target = { role: 'button', name: 'Continue', ordinal: 2, count: 2 }
    createDispatch.mockImplementationOnce((context) => async (name) => {
      if (name === 'click') context.recordTarget?.(target)
      return name === 'snapshot' ? { nodes: [] } : null
    })

    const report = await manager.runScript('b1', 'await snapshot(); await click("@e2"); return "done"', {
      id: 'operator-1', name: 'Navigator', providerId: 'codex'
    })

    expect(report.outcome.kind).toBe('completed')
    expect(report.runOperation).toMatchObject({
      id: expect.any(String),
      operator: { id: 'operator-1', name: 'Navigator', providerId: 'codex' },
      steps: [
        { sequence: 1, method: 'snapshot', status: 'completed' },
        { sequence: 2, method: 'click', status: 'completed', target, replay: { target, args: [] } }
      ]
    })
    const operationId = report.runOperation!.id
    const updates = sentEvents().filter((event) => event.type === 'updated' && event.browser.activity?.operation)
    expect(updates.map((event) => event.browser.activity.operation.id)).toEqual(
      Array(updates.length).fill(operationId)
    )
    expect(updates.length).toBeGreaterThan(2)
    expect(updates.some((event) => event.browser.activity.operation.steps.some((step: { status: string }) => step.status === 'running'))).toBe(true)
    expect(updates.at(-1).browser.activity.operation).toMatchObject({ id: operationId, phase: 'completed' })

    const history = await manager.listOperationHistory()
    expect(history).toMatchObject([{ id: operationId, steps: [{ method: 'snapshot' }, { target, replay: { target } }] }])
    const plan = await manager.replayPlan(operationId)
    expect(plan).toMatchObject({ operationId, steps: [{ method: 'snapshot' }, { method: 'click', target, args: [] }] })
    // Wait for the file store's serialized final write before reading it with a fresh owner. Do not
    // create a fresh owner until the completed snapshot is on disk: loading the transient running
    // version would correctly recover it as indeterminate and then overwrite the completed record.
    await vi.waitFor(async () => {
      const document = (await new BrowserOperationFileStore(path).load())!
      expect(document.operations?.find((operation) => operation.id === operationId)?.phase).toBe('completed')
    })
    const restarted = new BrowserOperationJournal(new BrowserOperationFileStore(path))
    await expect(restarted.list()).resolves.toMatchObject([
      { id: operationId, phase: 'completed', steps: [{ method: 'snapshot' }, { target, replay: { target } }] }
    ])
  }, 30_000)

  it('敏感步骤保留为闸门，整份计划先拒绝，不能跳过填值后只回放两旁的 click', async () => {
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    createDispatch.mockImplementationOnce((context) => async (name) => {
      context.recordTarget?.({ role: name === 'fillInput' ? 'textbox' : 'button', name: 'Target', ordinal: 1, count: 1 })
      return null
    })
    const report = await manager.runScript('b1', 'await click("@e1"); await fillInput("@e2", "secret-value"); await click("@e3")')
    const plan = await manager.replayPlan(report.runOperation!.id)
    expect(plan?.steps.map((step) => step.method)).toEqual(['click', 'fillInput', 'click'])
    expect(plan?.steps[1]).toMatchObject({ method: 'fillInput', args: [], inputKey: 'value', blockedReason: expect.any(String) })
    expect(JSON.stringify(await manager.listOperationHistory())).not.toContain('secret-value')
    expect(JSON.stringify(report.runOperation)).not.toContain('secret-value')
    expect(plan).not.toBeNull()

    createDispatch.mockClear()
    await expect(manager.runReplay('b1', plan!)).rejects.toThrow(/review|value|blocked|sensitive/i)
    expect(createDispatch).not.toHaveBeenCalled()
    expect((await manager.listOperationHistory()).map((operation) => operation.id)).toEqual([report.runOperation!.id])
  }, 30_000)

  it('可运行的 replay 重新解析语义 ref，receipt 与 journal 都链接原 operation', async () => {
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const target = { role: 'button', name: 'Continue', ordinal: 1, count: 1 }
    createDispatch.mockImplementationOnce((context) => async () => {
      context.recordTarget?.(target)
      return null
    })
    const original = await manager.runScript('b1', 'await click("@old")')
    const plan = await manager.replayPlan(original.runOperation!.id)
    expect(plan?.steps).toEqual([expect.objectContaining({ method: 'click', target })])

    const calls: { name: string; args: unknown[] }[] = []
    createDispatch.mockImplementationOnce((context) => async (name, args) => {
      calls.push({ name, args })
      if (name === 'pageInfo') return { url: 'https://example.invalid/' }
      if (name === 'snapshot') return { observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [{ ref: '@fresh', role: 'button', name: 'Continue' }] }
      if (name === 'click') context.recordTarget?.(target)
      return null
    })
    const replay = await manager.runReplay('b1', plan!)
    expect(replay.outcome.kind).toBe('completed')
    expect(calls).toEqual([
      { name: 'pageInfo', args: [] },
      { name: 'snapshot', args: [{ maxNodes: 1000 }] },
      { name: 'click', args: ['@fresh'] }
    ])
    expect(replay.runOperation).toMatchObject({ replayOf: original.runOperation!.id })
    expect(replay.runOperation!.id).not.toBe(original.runOperation!.id)
    expect((await manager.listOperationHistory()).map(({ id, replayOf }) => ({ id, replayOf }))).toEqual([
      { id: original.runOperation!.id, replayOf: undefined },
      { id: replay.runOperation!.id, replayOf: original.runOperation!.id }
    ])
  }, 30_000)

  it('回放打在同名元素上不报 completed——按外观命中就得说出来', async () => {
    // 回放的目标身份只有 role+name+序号+总数。同名元素多于一个时，这组条件挡不住"列表多一行、
    // 少一行"：总数仍是 3、序号仍是 2，闸门放行，点下去的却是另一个 Delete。而
    // browser-ref-resolve.ts 刻意不做 role/name 回退，理由正是"静默改打同名元素还照常报成功"。
    // 所以这条路必须和 ref 自愈同一个出口：`indeterminate` + 一句说清下一步的话。
    //
    // 上一条用 `count: 1` 判的正是这条的反面：只有一个同名元素时认不错，报 completed 是诚实的。
    // 两条一起才是判据——少了任何一条，"一律降级"和"一律不降级"都能全绿。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const crowded = { role: 'button', name: 'Delete', ordinal: 2, count: 3 }
    createDispatch.mockImplementationOnce((context) => async () => {
      context.recordTarget?.(crowded)
      return null
    })
    const original = await manager.runScript('b1', 'await click("@e2")')
    const plan = await manager.replayPlan(original.runOperation!.id)

    createDispatch.mockImplementationOnce((context) => async (name) => {
      if (name === 'pageInfo') return { url: 'https://example.invalid/' }
      if (name === 'snapshot') {
        return {
          observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [
            { ref: '@a', role: 'button', name: 'Delete' },
            { ref: '@b', role: 'button', name: 'Delete' },
            { ref: '@c', role: 'button', name: 'Delete' }
          ]
        }
      }
      if (name === 'click') context.recordTarget?.(crowded)
      return null
    })
    const replay = await manager.runReplay('b1', plan!)

    expect(replay.outcome.kind, '按外观命中同名元素却报成一次干净的成功').toBe('indeterminate')
    expect(
      replay.outcome.kind === 'indeterminate' ? replay.outcome.message : '',
      '没说清命中是按外观的，也没说下一步去看页面'
    ).toMatch(/appearance/i)
    expect(replay.runOperation?.phase).toBe('indeterminate')
    expect(replay.runOperation?.replayOf).toBe(original.runOperation!.id)
  }, 30_000)

  it('按外观命中之后某一步抛了，告示不许跟着丢——失败臂和成功臂必须汇到同一个结局', async () => {
    // 这是 `count > 1` 降级与自愈告示的**未闭合兄弟**：两处降级判据都写在 `if (run.completed)`
    // 里，而一次「已经按外观点下去了、后面某步才抛」的运行 `completed` 为 false，于是整份 notes
    // 被静默丢掉，收据报 `script-failed`。
    //
    // 为什么这个差别是承重的：`script-failed` 对 Agent 的意思是「你的程序写错了，改完重跑」，
    // 而此刻真实状态是「一个可能打在另一个同名元素上的破坏性动作已经执行了」。Agent 照着
    // script-failed 去整段重跑，那个动作就再执行一次——正是同文件反复点名的「下单点两次」。
    //
    // 同一份原则在接管那一支已经写明并兑现了（browser-view-manager.ts:749-759「两条路必须汇到
    // 同一个结局」），这里只是没提上来。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const crowded = { role: 'button', name: 'Delete', ordinal: 2, count: 3 }
    createDispatch.mockImplementationOnce((context) => async () => {
      context.recordTarget?.(crowded)
      return null
    })
    const original = await manager.runScript('b1', 'await click("@e2")')
    const plan = await manager.replayPlan(original.runOperation!.id)

    // 回放：click 真的落下去（并记下 count:3 的身份），随后一步抛。
    createDispatch.mockImplementationOnce((context) => async (name) => {
      if (name === 'pageInfo') return { url: 'https://example.invalid/' }
      if (name === 'snapshot') {
        return {
          observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [
            { ref: '@a', role: 'button', name: 'Delete' },
            { ref: '@b', role: 'button', name: 'Delete' },
            { ref: '@c', role: 'button', name: 'Delete' }
          ]
        }
      }
      if (name === 'click') {
        context.recordTarget?.(crowded)
        return null
      }
      throw new Error('the page changed under us')
    })
    // 走真实回放路径：计划里两步，第一步 click 落下去，第二步 hover 抛。
    const twoStep = { ...plan!, steps: [plan!.steps[0]!, { ...plan!.steps[0]!, method: 'hover' }] }
    const replay = await manager.runReplay('b1', twoStep)

    expect(
      replay.outcome.kind,
      '破坏性动作已按外观落下去了，却报 script-failed——Agent 会改代码整段重跑，那个动作再来一次'
    ).toBe('indeterminate')
    expect(replay.runOperation?.phase).toBe('indeterminate')
  }, 30_000)

  it('journal 写入失败不阻断健康 Browser，降级告示到达 receipt 和实际 renderer 事件', async () => {
    const journal = new BrowserOperationJournal({
      load: async () => null,
      save: async () => { throw new Error('storage unavailable') }
    })
    const { manager, sentEvents } = await managerWithBrowser(journal)
    const report = await manager.runScript('b1', 'return await snapshot()')
    expect(report.outcome.kind).toBe('completed')
    expect(report.result).toBe('dispatched:snapshot')
    expect(report.runOperation?.warning).toMatch(/could not be saved|unavailable/i)
    expect(sentEvents().at(-1)?.browser.activity.warning).toMatch(/could not be saved|unavailable/i)
    expect((await manager.listOperationHistory()).map((operation) => operation.id)).toEqual([report.runOperation!.id])
  }, 30_000)
})

/**
 * T-003/T-004/T-005：**operation 的寿命长于任何一条连接。**
 *
 * 这一族判的是「凭 operationId 查询 / 取消」这条能力，而它成立的前提是调用方在操作**开跑之前**
 * 就有 id。三件事必须一起证，缺任何一件前两件只对已结束的操作有效：
 *   - id 由调用方给，在飞期间就够得着（T-005）；
 *   - 凭 id 能停，且走的是既有的那条 AbortController，不是第二套 kill（T-003）；
 *   - 凭 id 能查，读的是既有 journal，不是第二份账（T-004）。
 *
 * 为什么判在 manager 这一层而不只在协议解析：解析层只证「这个请求长得对」，而这几条要证的是
 * 「那次操作真的停下了」「那条事实真的还在」。协议侧的形状判据在 control-host.test.ts。
 *
 * `holdNextCall` 在下一个 describe 里定义，这里要自己挂住一次调用——两处的用途不同：那边是
 * 「挂住以便观察交接事件」，这里是「挂住以便从另一个入口伸手进去」。
 */
describe('Browser RSI：operation 凭 id 可查可停，与发起它的那条连接无关', () => {
  function fileJournal() {
    const path = join(mkdtempSync(join(tmpdir(), 'agentmux-operation-lifecycle-')), 'operations.json')
    return { path, journal: new BrowserOperationJournal(new BrowserOperationFileStore(path)) }
  }

  /** 挂住派发层的第一次调用，交出「已经进去了」和「放它走」两个把手。 */
  function holdFirstCall() {
    let release!: () => void
    let arrived!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { arrived = resolve })
    const calls: string[] = []
    createDispatch.mockImplementationOnce(() => async (name: string) => {
      calls.push(name)
      if (calls.length === 1) {
        arrived()
        await released
      }
      return null
    })
    return { calls, entered, release }
  }

  it('调用方给的 id 就是记录里的 id，在飞期间凭它既查得到也停得下', async () => {
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const held = holdFirstCall()
    // 调用方自己造 id，并在**开跑之前**就持有它。这是整条链子的前提：主进程铸的 id 只随终局
    // 回执露出（Control 是一问一答），那时已无可取消。
    const mine = 'op:caller-minted'
    const pending = manager.runScript('b1', 'await wait(1000); await click("@e1")', undefined, undefined, mine)
    try {
      await held.entered
      // 查：拿到的是**同一个** identity，而且它还没结束。两个铸造点的话这里会查不到（journal 里
      // 记的是它自己铸的那个），而两边各自看起来都正常。
      const inFlight = await manager.getOperation(mine)
      expect(inFlight?.id, '调用方给的 id 在 journal 里查不到——identity 分岔了').toBe(mine)
      expect(
        ['preparing', 'running', 'waiting'],
        `在飞的操作被答成了终局：${inFlight?.phase}`
      ).toContain(inFlight!.phase)
      // 停：凭 id，不给 browserId。这条路必须真的把它停下来，不是记一笔"请求过取消"。
      const stopped = await manager.stopOperationById(mine)
      expect(stopped?.id).toBe(mine)
      expect(stopped?.phase, '凭 id 取消没把它停下来').toBe('stopped')
    } finally {
      held.release()
      await pending
    }
    const report = await pending
    // 结局落在四分类里**正确**那一档：被我们截断的是 stopped，不是 script-failed（那会让 Agent
    // 去改一段本来没错的程序），也不是 completed。
    expect(report.outcome.kind, '被取消的操作结局不是 stopped').toBe('stopped')
    expect(report.runOperation?.id, '终局回执里的 id 换人了').toBe(mine)
    // 取消之后，第一次动作发生过、之后的一个都没有。
    expect(held.calls).toEqual(['wait'])
  }, 30_000)

  it('另一个 Browser 上的操作也停得下：寻址按 operationId，不按哪一页', async () => {
    // 这条是 T-003 的要害，T-008 之后更是唯一入口：协议调用方手上只有 id，它不知道也不该需要知道
    // 那个操作跑在哪个 Browser 上。把实现改成只看某一个 entry（或要求 browserId），这条必红。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    await manager.create('b2', 'https://second.invalid/')
    const held = holdFirstCall()
    const mine = 'op:on-the-second-browser'
    const pending = manager.runScript('b2', 'await wait(1000); await click("@e1")', undefined, undefined, mine)
    try {
      await held.entered
      const stopped = await manager.stopOperationById(mine)
      expect(stopped?.browserId, '停错了 Browser').toBe('b2')
      expect(stopped?.phase, '第二个 Browser 上的操作停不下来——寻址被绑在某一页上了').toBe('stopped')
    } finally {
      held.release()
      await pending
    }
    expect((await pending).outcome.kind).toBe('stopped')
  }, 30_000)

  it('取消一个已经结束的操作是幂等成功并答出它的既有终局，不抛', async () => {
    // 正常时序下取消**总会**撞上刚结束的操作（人按下停止的同一刻程序自己跑完了）。把这个竞态
    // 写成失败，调用方就分不出「我停晚了」和「出错了」。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const done = 'op:already-done'
    const report = await manager.runScript('b1', 'return await snapshot()', undefined, undefined, done)
    expect(report.outcome.kind).toBe('completed')

    const late = await manager.stopOperationById(done)
    expect(late?.id).toBe(done)
    // 答出**既有**终局，而不是把一个跑完的操作改写成 stopped：那会让历史里的事实被一次迟到的
    // 取消覆盖掉。
    expect(late?.phase, '迟到的取消把一个已完成的操作改写了').toBe('completed')
    // 再来一次仍是同一个答案——幂等不是"第一次成功"。
    expect((await manager.stopOperationById(done))?.phase).toBe('completed')
  }, 30_000)

  it('未知 id 答 null 而不是抛，且这个 Browser 随后照样能跑', async () => {
    // RED-LINES 第 2 类：我们查不到 ≠ Browser 坏了。id 可能来自另一台机器、或早被日志轮转掉了。
    // 把它实现成动 entry 状态（例如顺手清掉 activeRun），后半句必红。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    await expect(manager.getOperation('op:never-existed')).resolves.toBeNull()
    await expect(manager.stopOperationById('op:never-existed')).resolves.toBeNull()
    // 能力没被这次查询失败拿走。
    const after = await manager.runScript('b1', 'return await snapshot()')
    expect(after.outcome.kind, '一次查不到把 Browser 的能力拿走了').toBe('completed')
  }, 30_000)

  it('重启后仍查得到，且那一档是 indeterminate——不许折进 failed 或 completed', async () => {
    // T-004 的要害：事实必须活过进程。judge 的不是"内存里还在不在"，而是换一个 owner 从磁盘
    // 读起来还在不在。把查询实现成从内存按连接找，这条必红。
    const { path, journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const finished = 'op:before-restart'
    await manager.runScript('b1', 'return await snapshot()', undefined, undefined, finished)
    // 等最后一次写落盘再换 owner：读到中途那份 running 版本会被正确地恢复成 indeterminate，
    // 然后把 completed 记录覆盖掉——那是竞态，不是被测的性质。
    await vi.waitFor(async () => {
      const document = (await new BrowserOperationFileStore(path).load())!
      expect(document.operations?.find((operation) => operation.id === finished)?.phase).toBe('completed')
    })

    // 进程重启：新 owner、新 manager，磁盘是唯一的桥。
    const restartedJournal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
    const { manager: restarted } = await managerWithBrowser(restartedJournal)
    expect((await restarted.getOperation(finished))?.phase, '重启后查不到已完成的那条，或它的档位变了')
      .toBe('completed')

    // 另一档：重启时**活着**的操作。手写一条 running 记录进磁盘，再让新 owner 读它——这一步
    // 必须真的经过 journal 重载，不是手造一条 indeterminate 记录来自证。
    await new BrowserOperationFileStore(path).save({ writer: 'crash-fixture', revision: 1, operations: [{ metadata: {
      id: 'op:was-running', browserId: 'b1', operator: { id: 'agent:x', name: 'Agent' },
      startedAt: 1, phase: 'running', summary: 'Agent is operating the Browser', url: 'https://example.invalid/'
    }, steps: [] }], events: [], maxEvents: 512 })
    const { manager: afterCrash } = await managerWithBrowser(
      new BrowserOperationJournal(new BrowserOperationFileStore(path))
    )
    const recovered = await afterCrash.getOperation('op:was-running')
    // `indeterminate` 的意思是「这件事做到哪儿我们不知道」，调用方对它唯一正确的反应是**别盲目
    // 重试**。折进 failed 会被读成"失败了，改完重跑"——而页面上那个动作可能已经做过一次了。
    expect(recovered?.phase, '重启时活着的操作被折成了别的档——"分不清"这一档消失了')
      .toBe('indeterminate')
    // 四档互不折叠：同一个 owner 上两条记录必须给出两个不同的答案。
    expect(
      new Set([(await afterCrash.getOperation(finished))?.phase, recovered?.phase]).size,
      '两条不同结局的操作被答成了同一档'
    ).toBe(2)
  }, 30_000)

  it('journal 读坏了：查询答 null，而这个 Browser 照样接得住新操作', async () => {
    // 流程状态，不是 Browser 坏了（RED-LINES 第 2 类）。journal 本来就是 advisory 的。
    const broken = new BrowserOperationJournal({
      load: async () => { throw new Error('journal unreadable') },
      save: async () => {}
    })
    const { manager } = await managerWithBrowser(broken)
    await expect(manager.getOperation('op:anything')).resolves.toBeNull()
    const report = await manager.runScript('b1', 'return await snapshot()')
    expect(report.outcome.kind, 'journal 读不了把 Browser 阻断了').toBe('completed')
    // 而且降级要说出来，不许静默：用户有权知道自己在降级状态下工作。
    expect(report.runOperation?.warning, 'journal 降级了却没有任何告示').toMatch(/unavailable|unreadable|could not/i)
  }, 30_000)

  it('查询与 history 指向同一条 operation，不是两份投影', async () => {
    // 两个数据源一条生命周期＝鬼影。分岔时两边各自看起来都正常，所以判据要把两条路读同一条
    // 记录的结果**逐字段**比一遍。
    const { journal } = fileJournal()
    const { manager } = await managerWithBrowser(journal)
    const id = 'op:one-truth'
    await manager.runScript('b1', 'return await snapshot()', undefined, undefined, id)
    const listed = (await manager.listOperationHistory()).find((operation) => operation.id === id)
    expect(listed, 'history 里没有这条——下面的比对在对空气生效').toBeDefined()
    expect(await manager.getOperation(id), '按 id 查和按 Browser 列给出了两份不同的事实')
      .toEqual(listed)
  }, 30_000)
})

describe('Browser RSI：及时交接与单一运行者', () => {
  function holdNextCall() {
    let release!: () => void
    let arrived!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { arrived = resolve })
    const calls: string[] = []
    createDispatch.mockImplementationOnce(() => async (name) => {
      calls.push(name)
      if (calls.length === 1) {
        arrived()
        await released
      }
      return null
    })
    return { calls, entered, release }
  }

  it('显式停止立即推送 control=human，不等挂起的 page call 结束', async () => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const held = holdNextCall()
    const pending = manager.runScript('b1', 'await wait(1000); await click("@e1")')
    try {
      await held.entered
      const before = sentEvents().length
      await manager.stopOperationById(sentEvents().at(-1)?.browser.activity.operation.id)
      const handoffEvents = sentEvents().slice(before)
      expect(handoffEvents).toHaveLength(1)
      expect(handoffEvents[0]).toMatchObject({
        type: 'updated', browser: { driving: false, activity: { control: 'human', operation: { phase: 'stopped' } } }
      })
    } finally {
      held.release()
      await pending
    }
    expect((await pending).outcome.kind).toBe('stopped')
    expect(held.calls).toEqual(['wait'])
  }, 30_000)

  it('显式 Stop 立即交还控制并停止后续动作，直到人明确交还', async () => {
    const { manager, sentEvents } = await managerWithBrowser()
    const held = holdNextCall()
    // 寻址走 operationId（T-008 之后那是取消的唯一入口；按 browserId 的 `stopOperation` 已删）。
    // 这条断言的不变量没变：人停下之后控制归人、后续动作不再发生、直到人明确交还。
    const mine = 'op:explicit-stop'
    const pending = manager.runScript('b1', 'await wait(1000); await click("@e1")', undefined, undefined, mine)
    try {
      await held.entered
      const before = sentEvents().length
      const stopped = await manager.stopOperationById(mine)
      expect(stopped?.phase, '显式停止没把这条操作判成 stopped').toBe('stopped')
      // 控制交还给人这件事只在 snapshot 事件里可见（stopOperationById 答的是操作事实，不是页面快照）。
      expect(sentEvents().slice(before)).toEqual(expect.arrayContaining([
        expect.objectContaining({ browser: expect.objectContaining({ driving: false, activity: expect.objectContaining({ control: 'human' }) }) })
      ]))
    } finally {
      held.release()
      await pending
    }
    expect((await pending).outcome.kind).toBe('stopped')
    expect(held.calls).toEqual(['wait'])
    await expect(manager.runScript('b1', 'return "cannot take control"')).rejects.toThrow(/return control/i)
    manager.returnControl('b1')
    expect((await manager.runScript('b1', 'return "resumed"')).result).toBe('resumed')
  }, 30_000)

  it('已有程序挂起时拒绝重入，旧程序和 operation identity 继续有效', async () => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const held = holdNextCall()
    const pending = manager.runScript('b1', 'await wait(1000); return "first"')
    let operationId: string | undefined
    try {
      await held.entered
      operationId = sentEvents().at(-1).browser.activity.operation.id
      await expect(manager.runScript('b1', 'return "second"')).rejects.toThrow(/already running/i)
      expect(contents.debugger.isAttached()).toBe(true)
      expect(sentEvents().at(-1).browser.activity.operation.id).toBe(operationId)
    } finally {
      held.release()
      await pending
    }
    const report = await pending
    expect(report).toMatchObject({ result: 'first', outcome: { kind: 'completed' }, runOperation: { id: operationId } })
    expect(held.calls).toEqual(['wait'])
  }, 30_000)
})


describe('durable result via the actual Manager → dispatch → runner chain', () => {
  it('real disk failure retains the completed action and a healthy original Browser', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentmux-result-disk-failure-'))
    const blocked = join(directory, 'not-a-directory')
    await writeFile(blocked, 'keep this file')
    const actual = await vi.importActual<typeof import('../src/main/browser-page-dispatch.js')>('../src/main/browser-page-dispatch.js')
    createDispatch.mockImplementation(context => actual.createBrowserPageDispatch(context))
    let manager: BrowserViewManager | undefined
    try {
      const created = await managerWithBrowser(new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json'))),
        undefined, new BrowserResultArtifactStore(blocked), 'workspace-a')
      manager = created.manager
      let actions = 0
      created.contents.debugger.sendCommandImpl = async (method: string) => {
        if (method === 'Runtime.evaluate') { actions += 1; return { result: { value: 'acted' } } }
        return {}
      }
      const failed = await manager.runScript('b1', 'await js("one action"); return "x".repeat(1100000)')
      expect(failed.outcome.kind).toBe('indeterminate')
      expect(failed.outcome.kind !== 'completed' && failed.outcome.message).toContain('Do not automatically rerun')
      expect(failed.runOperation!.steps).toEqual([expect.objectContaining({ method: 'js', status: 'completed' })])
      expect(failed.runOperation!.phase).toBe('indeterminate')
      expect(actions).toBe(1)
      expect(manager.resourceOwnerCounts().browserViews).toBe(1)
      expect(created.contents.isDestroyed()).toBe(false)
      expect((await manager.runScript('b1','return "still healthy"')).outcome.kind).toBe('completed')
      expect(actions).toBe(1)
      expect(await readFile(blocked,'utf8')).toBe('keep this file')
    } finally {
      manager?.close('b1')
      createDispatch.mockImplementation(() => async (name,args) => { dispatchCalls.push({name,args}); return `dispatched:${name}` })
      await rm(directory,{recursive:true,force:true})
    }
  }, 30_000)

  it('continues original result after navigation and native release/restart without replaying its action', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentmux-result-manager-'))
    const journalPath = join(directory, 'operations.json')
    const storePath = join(directory, 'results')
    const actual = await vi.importActual<typeof import('../src/main/browser-page-dispatch.js')>('../src/main/browser-page-dispatch.js')
    createDispatch.mockImplementation(context => actual.createBrowserPageDispatch(context))
    let manager: BrowserViewManager | undefined
    try {
      const journal = new BrowserOperationJournal(new BrowserOperationFileStore(journalPath))
      const created = await managerWithBrowser(journal, undefined, new BrowserResultArtifactStore(storePath), 'workspace-a')
      manager = created.manager
      let actions = 0
      created.contents.debugger.sendCommandImpl = async (method: string) => {
        if (method === 'Runtime.evaluate') { actions += 1; return { result: { value: 'acted' } } }
        return {}
      }
      const initialNavigation = (await manager.create('b1', 'https://ignored.invalid/', 'workspace-a')).navigationId
      const report = await manager.runScript('b1', 'await js("increment a counter"); return {text:"中文🙂".repeat(150000)}')
      expect(report.outcome.kind).toBe('completed')
      const reference = report.result as BrowserResultArtifactReference
      expect(reference).toMatchObject({ workspaceId: 'workspace-a', browserId: 'b1', operationId: report.runOperation!.id, navigationId: initialNavigation })
      expect(report.runOperation!.steps).toEqual([expect.objectContaining({ method: 'js' })])
      expect(actions).toBe(1)
      const navigationListeners = created.contents.listeners.get('did-start-navigation')
      expect(navigationListeners.length).toBeGreaterThan(0)
      for (const listener of navigationListeners) listener({ url: 'https://next.invalid/', isMainFrame: true, isSameDocument: false })
      expect((await manager.create('b1', 'https://ignored.invalid/', 'workspace-a')).navigationId).not.toBe(reference.navigationId)
      const continued = await manager.runScript('b1', `return await readResult(${JSON.stringify(reference)}, {offset:1,maxBytes:65536})`)
      expect(continued.outcome.kind).toBe('completed')
      const chunk = continued.result as BrowserResultArtifactChunk
      expect(chunk.returnedBytes).toBe(65536)
      expect(chunk.reference.operationId).toBe(reference.operationId)
      expect(continued.runOperation!.id).not.toBe(reference.operationId)
      expect(continued.runOperation!.steps).toEqual([expect.objectContaining({ method: 'readResult' })])
      expect(actions).toBe(1)
      await expect(manager.create('b1', 'https://ignored.invalid/', 'foreign-workspace')).rejects.toThrow(/another Workspace/)
      await manager.release('b1')
      await expect(manager.restore('b1', { workspaceId: 'foreign-workspace' })).rejects.toThrow(/another Workspace/)
      await manager.restore('b1', { workspaceId: null })
      const resumed = await manager.runScript('b1', `return await readResult(${JSON.stringify(reference)}, {offset:0,maxBytes:11})`)
      expect(resumed.outcome.kind).toBe('completed')
      expect((resumed.result as BrowserResultArtifactChunk).returnedBytes).toBe(11)
      manager.close('b1')
      const restarted = await managerWithBrowser(new BrowserOperationJournal(new BrowserOperationFileStore(journalPath)), undefined,
        new BrowserResultArtifactStore(storePath), 'workspace-a')
      manager = restarted.manager
      const recovered = await manager.runScript('b1', `return await readResult(${JSON.stringify(reference)}, {offset:65537,maxBytes:33})`)
      expect(recovered.outcome.kind).toBe('completed')
      expect(recovered.result).toMatchObject({ reference, offset: 65537, returnedBytes: 33 })
      expect(actions).toBe(1)
      const forged = await manager.runScript('b1', `return await readResult(${JSON.stringify({ ...reference, operationId: 'foreign-operation' })})`)
      expect(forged.outcome.kind).toBe('script-failed')
      expect(actions).toBe(1)
    } finally {
      manager?.close('b1')
      createDispatch.mockImplementation(() => async (name, args) => { dispatchCalls.push({ name, args }); return `dispatched:${name}` })
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('an unknown Workspace keeps small scripts healthy and reports large result unavailable after an action', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentmux-result-unknown-'))
    const actual = await vi.importActual<typeof import('../src/main/browser-page-dispatch.js')>('../src/main/browser-page-dispatch.js')
    createDispatch.mockImplementation(context => actual.createBrowserPageDispatch(context))
    let manager: BrowserViewManager | undefined
    try {
      const created = await managerWithBrowser(new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json'))),
        undefined, new BrowserResultArtifactStore(join(directory, 'results')), null)
      manager = created.manager
      let actions = 0
      created.contents.debugger.sendCommandImpl = async (method: string) => {
        if (method === 'Runtime.evaluate') { actions += 1; return { result: { value: 'acted' } } }
        return {}
      }
      expect((await manager.runScript('b1', 'return null')).result).toBeNull()
      const large = await manager.runScript('b1', 'await js("one action"); return "x".repeat(1100000)')
      expect(large.outcome.kind).toBe('indeterminate')
      expect(large.outcome.kind !== 'completed' && large.outcome.message).toMatch(/no verified Workspace/)
      expect(large.runOperation!.steps).toEqual([expect.objectContaining({ method: 'js' })])
      expect(actions).toBe(1)
      const after = await manager.runScript('b1', 'return "still healthy"')
      expect(after.outcome.kind).toBe('completed')
      expect(after.result).toBe('still healthy')
      expect(actions).toBe(1)
    } finally {
      manager?.close('b1')
      createDispatch.mockImplementation(() => async (name, args) => { dispatchCalls.push({ name, args }); return `dispatched:${name}` })
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('versioned task assets via the actual Browser Manager', () => {
  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'amx-task-assets-owner-'))
    const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(join(directory, 'drafts.json')))
    const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(directory, 'assets.json')))
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'operations.json')))
    const browser = await managerWithBrowser(journal, new BrowserStepEvidenceStore(join(directory, 'evidence')),
      new BrowserResultArtifactStore(join(directory, 'results')), 'workspace-1', recorder, assets)
    const draft = await recorder.start({ browserId: 'b1', navigationId: 'nav-1', url: 'https://example.invalid/' })
    recorder.noteNativeInput({ browserId: 'b1', navigationId: draft.navigationId, type: 'mouseDown' })
    await recorder.recordBrowserDemonstration({ browserId: 'b1', navigationId: draft.navigationId,
      kind: 'click', isTrusted: true, target: { role: 'button', name: 'Review preferences', ordinal: 1, count: 1 } })
    await recorder.stop('b1')
    const imported = await browser.manager.importTaskAsset('b1', 'Preferences task')
    return { ...browser, directory, journal, assets, recorder, imported,
      close: async () => { browser.manager.dispose(); await rm(directory, { recursive: true, force: true }) } }
  }
  const snapshot = () => ({ navigationId: 'nav-1', title: 'Preferences', url: 'https://example.invalid/',
    observation: { scope: { kind: 'page', document: null }, truncated: false, omittedFrames: [] }, missingFrames: [],
    nodes: [{ ref: '@e1', role: 'button', name: 'Review preferences' }, { ref: '@e2', role: 'text input', name: 'Private value' }] })
  function pageDispatch(onClick: () => Promise<unknown> = async () => true) {
    return async (name: string) => name === 'pageInfo' ? { url: 'https://example.invalid/' }
      : name === 'snapshot' ? snapshot() : name === 'click' ? await onClick() : true
  }
  async function version(f: Awaited<ReturnType<typeof fixture>>, content: BrowserTaskContent = {
    ...f.imported.draft, steps: f.imported.draft.steps.map(step => ({ ...step, reviewed: true }))
  }): Promise<BrowserTaskAsset> {
    return await f.manager.saveTaskAssetVersion('b1', f.imported.id, f.imported.revision, content)
  }

  // Real Manager, selection scripts, CDP session, AX verification and snapshot collector.
  // Only Electron/CDP transport is doubled; this is not a native Chromium input proof.
  function selectedWorlds(f: Awaited<ReturnType<typeof fixture>>) {
    const listeners = new Map<string, (event: any) => void>()
    const document: any = { title: 'Fixture', addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name), querySelectorAll: () => [] }
    class Element {
      readonly ownerDocument = document
      readonly style = {}
      readonly attributes = []
      readonly tagName = 'BUTTON'
      readonly parentElement = null
      readonly previousElementSibling = null
      readonly nextElementSibling = null
      textContent: string
      constructor(readonly backendNodeId = 0, readonly innerText = '') { this.textContent = innerText }
      get outerHTML() { return `<button>${this.innerText}</button>` }
      appendChild() {} append() {} setAttribute() {} remove() {}
      getAttribute() { return null }
      contains() { return false }
      attachShadow() { return { append() {} } }
      getBoundingClientRect() { return { x: 0, y: 0, width: 200, height: 50 } }
    }
    document.body = document.documentElement = new Element()
    document.createElement = () => new Element()
    const chosen = new Element(11, 'Human chosen button'), decoy = new Element(22, 'Page nominated button')
    const environment = { document, Element, getComputedStyle: () => ({ position: 'static' }),
      CSS: { escape: (value: string) => value }, location: { href: 'https://example.invalid/' } }
    const isolated = vm.createContext({ ...environment, window: { scrollX: 0, scrollY: 0 } })
    const page = vm.createContext({ ...environment, __agentMuxBrowserSelection: { revision: 2, selectedTarget: decoy } })
    const unrelated = vm.createContext({ ...environment, __agentMuxBrowserSelection: { revision: 2, inspectionToken: 'wrong-world-token', selectedTarget: decoy } })
    const worlds = new Map([[3, page], [4, unrelated], [9, unrelated], [5, unrelated], [7, isolated]])
    const calls: { method: string; params?: any }[] = []
    const handles = new Map<string, Element>()
    const inspectionTokens: string[] = []
    let click: 'select' | 'cancel' = 'select'
    let provenContext = true, ambiguous = false
    f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (worldId: number, scripts: { code: string }[]) => {
      expect(worldId).toBe(1208)
      const response = vm.runInContext(scripts[0]!.code, isolated)
      if (scripts[0]!.code.includes('Select an element')) {
        inspectionTokens.push(vm.runInContext('globalThis.__agentMuxBrowserSelection.inspectionToken', isolated))
        const event = { isTrusted: true, target: chosen, composedPath: () => [chosen],
          key: 'Escape', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }
        listeners.get(click === 'cancel' ? 'keydown' : 'click')!(event)
      }
      // Electron serializes an isolated-world result into the Main realm.
      return structuredClone(await response)
    })
    f.contents.debugger.sendCommandImpl = async (method: string, params?: any) => {
      calls.push({ method, params })
      if (method === 'Runtime.enable') {
        for (const [id, auxData] of [[3, { isDefault: true, type: 'default', frameId: 'main' }],
          [4, { isDefault: false, type: 'worker', frameId: 'main' }],
          [9, { isDefault: false, type: 'isolated', frameId: 'child' }],
          [5, { isDefault: false, type: 'isolated', frameId: 'main' }],
          [7, { isDefault: false, type: 'isolated', frameId: 'main' }]] as const) {
          f.contents.debugger.emit('message', 'Runtime.executionContextCreated', { context: { id, ...(id !== 7 || provenContext ? { auxData } : {}) } })
        }
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'loader-1' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Runtime.evaluate') {
        const context = worlds.get(params.contextId)
        if (!context) throw new Error('Unknown context')
        const result = vm.runInContext(params.expression, context)
        if (params.returnByValue) return { result: { value: result } }
        if (!(result instanceof Element)) return { result: { type: 'undefined' } }
        const objectId = `selected-${result.backendNodeId}`
        handles.set(objectId, result)
        return { result: { objectId } }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: handles.get(params.objectId)?.backendNodeId } }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ backendDOMNodeId: params.backendNodeId, ignored: false,
        role: { value: 'button' }, name: { value: params.backendNodeId === 11 ? chosen.innerText : decoy.innerText } }] }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [
        { nodeId: 'root', role: { value: 'generic' }, frameId: 'main', childIds: ['human', 'decoy'] },
        { nodeId: 'human', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: chosen.innerText } },
        { nodeId: 'decoy', backendDOMNodeId: 22, role: { value: 'button' }, name: { value: ambiguous ? chosen.innerText : decoy.innerText } }
      ] }
      return {}
    }
    return { isolated, page, calls, listeners, inspectionTokens, cancel: () => { click = 'cancel' },
      omitContextProof: () => { provenContext = false }, makeAmbiguous: () => { ambiguous = true } }
  }

  it('locates only the human selected target, rejecting default and unrelated isolated world nominations', async () => {
    const f = await fixture()
    try {
      const worlds = selectedWorlds(f)
      const asset = await f.manager.locateTaskAssetStep('b1', f.imported.id, f.imported.revision, f.imported.draft.steps[0]!.id)
      expect(asset.draft.steps[0]).toMatchObject({ target: { role: 'button', name: 'Human chosen button', ordinal: 1, count: 1 }, reviewed: false })
      const inspections = worlds.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.returnByValue === false)
      expect(inspections.map(call => call.params.contextId)).toEqual([5, 7])
      expect(worlds.calls.filter(call => call.method === 'DOM.describeNode').map(call => call.params.objectId)).toEqual(['selected-11'])
      expect(worlds.calls.filter(call => call.method === 'Accessibility.getPartialAXTree').map(call => call.params.backendNodeId)).toEqual([11])
      expect(f.contents.debugger.isAttached()).toBe(false)
      expect(worlds.listeners.size).toBe(0)
      expect(vm.runInContext('globalThis.__agentMuxBrowserSelection.selectedTarget', worlds.isolated)).toBeUndefined()
      expect(vm.runInContext('globalThis.__agentMuxBrowserSelection.selectedTarget.innerText', worlds.page)).toBe('Page nominated button')
    } finally { await f.close() }
  })

  it('retains the draft when the selected context identity is unknown, without falling back to the page world', async () => {
    const f = await fixture()
    try {
      const worlds = selectedWorlds(f)
      worlds.omitContextProof()
      await expect(f.manager.locateTaskAssetStep('b1', f.imported.id, f.imported.revision, f.imported.draft.steps[0]!.id))
        .rejects.toThrow('actual selected target is unknown')
      expect(await f.assets.get(f.imported.id)).toEqual(f.imported)
      expect(worlds.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.returnByValue === false).map(call => call.params.contextId)).toEqual([5])
      expect(worlds.calls.filter(call => call.method === 'DOM.describeNode')).toEqual([])
      expect(f.contents.debugger.isAttached()).toBe(false)
      expect(worlds.listeners.size).toBe(0)
      expect(vm.runInContext('globalThis.__agentMuxBrowserSelection.selectedTarget', worlds.isolated)).toBeUndefined()
    } finally { await f.close() }
  })

  it('uses a fresh inspection token for each explicit relocation rather than a reusable selection revision', async () => {
    const f = await fixture()
    try {
      const worlds = selectedWorlds(f)
      const first = await f.manager.locateTaskAssetStep('b1', f.imported.id, f.imported.revision, f.imported.draft.steps[0]!.id)
      const second = await f.manager.locateTaskAssetStep('b1', first.id, first.revision, first.draft.steps[0]!.id)
      expect(second.draft.steps[0]!.target).toEqual({ role: 'button', name: 'Human chosen button', ordinal: 1, count: 1 })
      expect(worlds.inspectionTokens).toHaveLength(2)
      expect(worlds.inspectionTokens[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(worlds.inspectionTokens[1]).not.toBe(worlds.inspectionTokens[0])
      expect(f.contents.debugger.isAttached()).toBe(false)
      expect(worlds.listeners.size).toBe(0)
      expect(vm.runInContext('globalThis.__agentMuxBrowserSelection.selectedTarget', worlds.isolated)).toBeUndefined()
    } finally { await f.close() }
  })

  it('still rejects an ambiguous actual human target and releases its retained owner', async () => {
    const f = await fixture()
    try {
      const worlds = selectedWorlds(f)
      worlds.makeAmbiguous()
      await expect(f.manager.locateTaskAssetStep('b1', f.imported.id, f.imported.revision, f.imported.draft.steps[0]!.id))
        .rejects.toThrow('actual selected target is unknown')
      expect(await f.assets.get(f.imported.id)).toEqual(f.imported)
      expect(worlds.calls.filter(call => call.method === 'Accessibility.getPartialAXTree').map(call => call.params.backendNodeId)).toEqual([11])
      expect(f.contents.debugger.isAttached()).toBe(false)
      expect(worlds.listeners.size).toBe(0)
      expect(vm.runInContext('globalThis.__agentMuxBrowserSelection.selectedTarget', worlds.isolated)).toBeUndefined()
    } finally { await f.close() }
  })

  it('cancels actual selection without reading a page nominee, editing a task, or retaining the native session', async () => {
    const f = await fixture()
    try {
      const worlds = selectedWorlds(f)
      worlds.cancel()
      await expect(f.manager.locateTaskAssetStep('b1', f.imported.id, f.imported.revision, f.imported.draft.steps[0]!.id))
        .rejects.toThrow('Target location was cancelled')
      expect(await f.assets.get(f.imported.id)).toEqual(f.imported)
      expect(worlds.calls.filter(call => call.method === 'Runtime.evaluate')).toEqual([])
      expect(f.contents.debugger.isAttached()).toBe(false)
      expect(worlds.listeners.size).toBe(0)
    } finally { await f.close() }
  })

  it('imports only the actual Main draft, preserves saved versions, and projects real running progress before the call returns', async () => {
    const f = await fixture()
    let finishClick!: () => void
    let running: ReturnType<BrowserViewManager['runTaskAsset']> | undefined
    const held = new Promise<void>(resolve => { finishClick = resolve })
    try {
      expect(f.imported).toMatchObject({ browserId: 'b1', sourceRecordingId: expect.any(String), versions: [],
        draft: { steps: [expect.objectContaining({ reviewed: false, target: { role: 'button', name: 'Review preferences', ordinal: 1, count: 1 } })] } })
      const saved = await version(f)
      const edited = await f.manager.saveTaskAssetDraft('b1', saved.id, saved.revision, { ...saved.draft, name: 'New draft', steps: [] })
      expect(edited.versions).toEqual(saved.versions)
      await expect(f.manager.saveTaskAssetVersion('b1', saved.id, saved.revision, saved.draft)).rejects.toThrow('changed')
      f.manager.returnControl('b1')
      createDispatch.mockImplementationOnce(() => pageDispatch(async () => { await held; return true }))
      running = f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      await expect.poll(() => f.sentEvents().filter(event => event.browser?.taskAssets?.runs.some((run: any) => run.status === 'running')).length).toBeGreaterThan(0)
      await expect.poll(() => f.sentEvents().at(-1)?.browser.driving).toBe(true)
      finishClick()
      const run = await running
      expect(run).toMatchObject({ status: 'completed', nextStep: 1 })
      expect(run.operationIds).toHaveLength(1)
      expect(run.operationIds[0]).not.toBe(run.id)
      expect(run.operationIds[0]).not.toBe(saved.id)
      expect(await f.journal.get(run.operationIds[0]!)).toMatchObject({ id: run.operationIds[0], browserId: 'b1', phase: 'completed' })
      await expect.poll(() => f.sentEvents().at(-1)?.browser.taskAssets?.runs.at(-1)?.status).toBe('completed')
    } finally { finishClick(); await Promise.allSettled([running]); await f.close() }
  }, 30_000)

  it('an initial checkpoint blocks Agent execution and the trusted Client continues the exact cursor once', async () => {
    const f = await fixture()
    try {
      const saved = await version(f, { ...f.imported.draft, steps: [
        { id: 'human-checkpoint', kind: 'checkpoint', url: f.imported.draft.url, reviewed: true },
        ...f.imported.draft.steps.map(step => ({ ...step, reviewed: true }))
      ] })
      f.manager.returnControl('b1')
      const paused = await f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      expect(paused).toMatchObject({ status: 'waiting-human', nextStep: 1, operationIds: [],
        pendingCheckpointId: 'human-checkpoint', humanCheckpoints: [] })
      expect(f.sentEvents().at(-1)?.browser.activity).toMatchObject({ operation: null, control: 'human' })
      await expect(f.manager.runScript('b1', 'return 1')).rejects.toMatchObject({ code: 'BROWSER_HUMAN_CONTROL_ACTIVE' })
      const tuple = { runId: paused.id, browserId: 'b1', assetId: saved.id, version: 1 }
      expect(await f.assets.readExactFact(tuple, 'human-checkpoint')).toEqual({ status: 'not-recorded' })
      expect(dispatchCalls).toEqual([])
      const fact = { ...tuple, checkpointId: 'human-checkpoint', pendingCursor: 1,
        origin: 'trusted-ui', controlBefore: 'human', confirmedAt: expect.any(Number) }
      const click = vi.fn(async () => {
        expect(await f.assets.readExactFact(tuple, 'human-checkpoint')).toEqual({ status: 'available', fact })
        expect(f.sentEvents().at(-1)?.browser.activity.control).toBe('agent')
        return true
      })
      createDispatch.mockImplementationOnce(() => pageDispatch(click))
      // Direct Source call to the existing trusted Client action. The privileged IPC
      // authenticates its sender; this method is not exposed by the public Agent API.
      const completed = await f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', runId: paused.id, parameters: {} })
      expect(completed).toMatchObject({ id: paused.id, status: 'completed', nextStep: 2 })
      expect(completed.humanCheckpoints).toEqual([fact])
      expect(completed.operationIds).toHaveLength(1)
      expect(click).toHaveBeenCalledOnce()
      const retained = await f.assets.state('b1'), operations = await f.journal.list()
      await expect(f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', runId: paused.id, parameters: {} }))
        .rejects.toThrow('cannot continue from its current cursor')
      expect(await f.assets.state('b1')).toEqual(retained)
      expect(await f.journal.list()).toEqual(operations)
      expect(click).toHaveBeenCalledOnce()
    } finally { await f.close() }
  }, 30_000)

  it('stops the associated real operation while retaining an unrelated healthy Browser operation', async () => {
    const f = await fixture()
    let releaseOther!: () => void
    let releaseTask!: () => void
    let otherEntered!: () => void
    let activeTask: ReturnType<BrowserViewManager['runTaskAsset']> | undefined
    let healthyOther: ReturnType<BrowserViewManager['runScript']> | undefined
    const otherHeld = new Promise<void>(resolve => { releaseOther = resolve })
    const taskHeld = new Promise<void>(resolve => { releaseTask = resolve })
    const otherReady = new Promise<void>(resolve => { otherEntered = resolve })
    const originalDispatch = createDispatch.getMockImplementation()!
    try {
      const saved = await version(f)
      await f.manager.create('b2', 'https://example.invalid/', 'workspace-1')
      f.manager.returnControl('b1')
      createDispatch.mockImplementation(context => {
        expect(context.resultArtifacts?.owner.browserId).toMatch(/^b[12]$/)
        return context.resultArtifacts!.owner.browserId === 'b1'
          ? pageDispatch(async () => { await taskHeld; return true })
          : async () => { otherEntered(); await otherHeld; return true }
      })
      activeTask = f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      await expect.poll(() => f.sentEvents().filter(event => event.browser?.id === 'b1' && event.browser.driving).length).toBeGreaterThan(0)
      healthyOther = f.manager.runScript('b2', "await waitForElement('Other pending fact'); return 82")
      await otherReady
      expect(f.sentEvents().filter(event => event.browser?.id === 'b2' && event.browser.activity?.operation?.phase === 'waiting').length).toBeGreaterThan(0)
      const taskRun = (await f.assets.state('b1')).runs.at(-1)!
      await expect(f.manager.stopTaskAsset('b2', taskRun.id)).rejects.toThrow('does not belong')
      const stopped = await f.manager.stopTaskAsset('b1', taskRun.id)
      expect(stopped).toMatchObject({ id: taskRun.id, status: 'stopped' })
      expect(f.sentEvents().filter(event => event.browser?.id === 'b1').at(-1)?.browser.activity.operation.phase).toBe('stopped')
      expect(f.sentEvents().filter(event => event.browser?.id === 'b2').at(-1)?.browser.activity.operation.phase).toBe('waiting')
      expect((await activeTask).status).toBe('stopped')
      releaseOther(); releaseTask()
      expect(await healthyOther).toMatchObject({ result: 82, outcome: { kind: 'completed' } })
      await expect(f.manager.saveTaskAssetDraft('b2', saved.id, saved.revision, saved.draft)).rejects.toThrow('does not belong')
    } finally {
      releaseOther(); releaseTask()
      await Promise.allSettled([activeTask, healthyOther])
      createDispatch.mockImplementation(originalDispatch)
      await f.close()
    }
  }, 30_000)

  it('hands preparation-time Stop to the actual late operation without actions or running rebound and preserves another healthy Browser', async () => {
    const f = await fixture()
    let releasePreparation!: () => void
    let releaseOther!: () => void
    let otherEntered!: () => void
    const preparing = new Promise<void>(resolve => { releasePreparation = resolve })
    const otherHeld = new Promise<void>(resolve => { releaseOther = resolve })
    const otherReady = new Promise<void>(resolve => { otherEntered = resolve })
    let preparationReached = false
    let preparedOperationId: string | undefined
    let activeTask: ReturnType<BrowserViewManager['runTaskAsset']> | undefined
    let healthyOther: ReturnType<BrowserViewManager['runScript']> | undefined
    const taskCalls: string[] = []
    let taskActions = 0
    const originalDispatch = createDispatch.getMockImplementation()!
    const originalStart = f.journal.start.bind(f.journal)
    vi.spyOn(f.journal, 'start').mockImplementation(async input => {
      const operation = await originalStart(input)
      if (input.browserId === 'b1') {
        preparedOperationId = operation.id
        preparationReached = true
        await preparing
      }
      return operation
    })
    try {
      const saved = await version(f)
      await f.manager.create('b2', 'https://example.invalid/', 'workspace-1')
      createDispatch.mockImplementation(context => {
        expect(context.resultArtifacts?.owner.browserId).toMatch(/^b[12]$/)
        if (context.resultArtifacts!.owner.browserId === 'b2') return async () => { otherEntered(); await otherHeld; return true }
        const dispatch = pageDispatch(async () => { taskActions += 1; return true })
        return async (name: string) => { taskCalls.push(name); return await dispatch(name) }
      })
      healthyOther = f.manager.runScript('b2', "await waitForElement('Other pending fact'); return 82")
      await otherReady
      expect(f.sentEvents().filter(event => event.browser?.id === 'b2' && event.browser.activity?.operation?.phase === 'waiting').length).toBeGreaterThan(0)
      f.manager.returnControl('b1')
      activeTask = f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      await expect.poll(() => preparationReached).toBe(true)
      const cursor = (await f.assets.state('b1')).runs.at(-1)!
      expect(cursor).toMatchObject({ status: 'running', nextStep: 0, operationIds: [] })
      expect(f.sentEvents().filter(event => event.browser?.id === 'b1').at(-1)?.browser.driving).toBe(false)
      expect(await f.journal.get(preparedOperationId!)).toMatchObject({ phase: 'preparing' })
      expect(await f.manager.stopTaskAsset('b1', cursor.id)).toMatchObject({ id: cursor.id, status: 'stopped', nextStep: 0 })
      releasePreparation()
      const stopped = await activeTask
      expect({ run: stopped, pageCalls: taskCalls, actions: taskActions }).toMatchObject({
        run: { id: cursor.id, status: 'stopped', nextStep: 0, operationIds: [preparedOperationId] }, pageCalls: [], actions: 0
      })
      expect(await f.journal.get(preparedOperationId!)).toMatchObject({ id: preparedOperationId, browserId: 'b1', phase: 'stopped', steps: [] })
      const phases = (await f.journal.events(preparedOperationId!)).filter(event => event.type === 'phase-changed')
      expect(phases.map(event => event.type === 'phase-changed' ? event.phase : null)).toEqual(['stopped'])
      expect(f.sentEvents().filter(event => event.browser?.id === 'b2').at(-1)?.browser.activity.operation.phase).toBe('waiting')
      releaseOther()
      expect(await healthyOther).toMatchObject({ result: 82, outcome: { kind: 'completed' } })
      expect(await f.assets.state('b1')).toMatchObject({ runs: [expect.objectContaining({ id: cursor.id, status: 'stopped', nextStep: 0 })] })
    } finally {
      releasePreparation(); releaseOther()
      await Promise.allSettled([activeTask, healthyOther])
      createDispatch.mockImplementation(originalDispatch)
      await f.close()
    }
  }, 30_000)

  it.each(['ready', 'running'] as const)('stops the first published %s cursor before its real operation is bound', async status => {
    const f = await fixture()
    const originalDispatch = createDispatch.getMockImplementation()!
    const calls: string[] = []
    let stopped: ReturnType<BrowserViewManager['stopTaskAsset']> | undefined
    let publishedRunId: string | undefined
    let activeTask: ReturnType<BrowserViewManager['runTaskAsset']> | undefined
    const unsubscribe = f.assets.subscribe(async browserId => {
      if (browserId !== 'b1' || publishedRunId) return
      const run = (await f.assets.state(browserId)).runs.at(-1)
      if (run?.status !== status || publishedRunId) return
      publishedRunId = run.id
      stopped = f.manager.stopTaskAsset(browserId, run.id)
    })
    try {
      const saved = await version(f)
      createDispatch.mockImplementation(() => {
        const dispatch = pageDispatch()
        return async name => { calls.push(name); return await dispatch(name) }
      })
      f.manager.returnControl('b1')
      activeTask = f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      const run = await activeTask
      expect(publishedRunId).toBeTypeOf('string')
      expect(await stopped).toMatchObject({ id: publishedRunId, status: 'stopped', nextStep: 0 })
      expect({ run, calls }).toMatchObject({ run: { id: publishedRunId, status: 'stopped', nextStep: 0 }, calls: [] })
      expect(await f.assets.state('b1')).toMatchObject({ runs: [expect.objectContaining({ id: publishedRunId, status: 'stopped', nextStep: 0 })] })
      const operations = await f.journal.list()
      expect(operations.length).toBe(run.operationIds.length)
      expect(operations.map(operation => operation.phase)).toEqual(run.operationIds.map(() => 'stopped'))
      expect(f.sentEvents().filter(event => event.browser?.id === 'b1' && event.browser.activity.operation?.phase === 'running')).toEqual([])
    } finally {
      unsubscribe()
      await Promise.allSettled([activeTask, stopped])
      createDispatch.mockImplementation(originalDispatch)
      await f.close()
    }
  }, 30_000)

  it('does not transfer an old cursor Stop to a fresh execution of the same asset and version', async () => {
    const f = await fixture()
    const originalDispatch = createDispatch.getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let preparedId: string | undefined
    let running: ReturnType<BrowserViewManager['runTaskAsset']> | undefined
    try {
      const saved = await version(f)
      createDispatch.mockImplementation(() => pageDispatch())
      f.manager.returnControl('b1')
      const old = await f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      expect(old).toMatchObject({ status: 'completed', nextStep: 1 })
      const start = f.journal.start.bind(f.journal)
      vi.spyOn(f.journal, 'start').mockImplementation(async input => {
        const operation = await start(input); preparedId = operation.id; await held; return operation
      })
      running = f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {} })
      await expect.poll(() => preparedId).toBeTypeOf('string')
      const fresh = (await f.assets.state('b1')).runs.at(-1)!
      expect(fresh.id).not.toBe(old.id)
      expect(await f.manager.stopTaskAsset('b1', old.id)).toMatchObject({ id: old.id, status: 'completed' })
      release()
      expect(await running).toMatchObject({ id: fresh.id, status: 'completed', nextStep: 1, operationIds: [preparedId] })
      expect(await f.journal.get(preparedId!)).toMatchObject({ id: preparedId, phase: 'completed', steps: expect.arrayContaining([expect.objectContaining({ method: 'click' })]) })
    } finally {
      release(); await Promise.allSettled([running])
      createDispatch.mockImplementation(originalDispatch)
      await f.close()
    }
  }, 30_000)

  it('keeps temporary parameters, escaped errors and page echoes out of every actual durable owner', async () => {
    const f = await fixture()
    const secret = 'sentinel-PRIVATE-"\\\n-parameter'
    let filled = false
    let capturedContext: BrowserPageContext | undefined
    try {
      const saved = await version(f, { ...f.imported.draft, parameters: [{ key: 'private-value', label: 'Private value', secret: true }],
        steps: [{ id: 'fill-private', kind: 'fill', url: f.imported.draft.url, reviewed: true, parameterKey: 'private-value',
          target: { role: 'text input', name: 'Private value', ordinal: 1, count: 1 } },
          ...f.imported.draft.steps.map(step => ({ ...step, reviewed: true }))] })
      f.manager.returnControl('b1')
      const dispatch = (context: BrowserPageContext) => {
        capturedContext = context
        return async (name: string, args: unknown[]) => {
          if (name === 'pageInfo') return { url: f.imported.draft.url }
          if (name === 'snapshot') {
            const page = snapshot()
            if (filled) page.nodes.push({ ref: '@e3', role: 'text', name: `Echo ${JSON.stringify(secret)}` })
            await context.writeLedger({ url: page.url, entries: [{ ref: '@e3', role: 'button', name: secret, nth: 1 }] })
            return page
          }
          if (name === 'fillInput') { expect(args).toEqual(['@e2', secret]); filled = true; return secret }
          if (name === 'click') throw new Error(`Page echoed ${JSON.stringify(secret)}`)
          return true
        }
      }
      createDispatch.mockImplementationOnce(dispatch).mockImplementationOnce(dispatch)
      const run = await f.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: { 'private-value': secret } })
      expect(run).toMatchObject({ status: 'failed', nextStep: 1 })
      expect(run.operationIds).toHaveLength(2)
      const failed = await f.journal.get(run.operationIds[1]!)
      expect(failed?.summary).toContain('Raw error text is withheld')
      expect(failed?.steps.find(step => step.method === 'click')?.summary).toContain('Raw error text is withheld')
      const observed = failed?.steps.find(step => step.method === 'snapshot')!
      expect(observed.evidenceWarning).toEqual(expect.stringContaining('private invocation parameters'))
      expect(observed.evidence).toBeUndefined()
      expect(await capturedContext!.readLedger()).toBeNull()
      const files = await import('node:fs/promises').then(async fs => {
        const names = await fs.readdir(f.directory, { recursive: true })
        const data: string[] = []
        for (const name of names.filter(name => name.endsWith('.json'))) data.push(await fs.readFile(join(f.directory, name), 'utf8'))
        return data
      })
      expect(files.length).toBeGreaterThan(2)
      const durable = files.join('\n')
      expect(durable).not.toContain(secret)
      expect(durable).not.toContain(JSON.stringify(secret).slice(1, -1))
      expect(durable).not.toContain('Echo ')
      createDispatch.mockImplementationOnce(() => async () => { throw new Error('Ordinary diagnostic retained') })
      await f.manager.runScript('b1', 'await click("@e8")')
      expect((await f.journal.list()).at(-1)?.summary).toContain('Ordinary diagnostic retained')
    } finally { await f.close() }
  }, 30_000)

  it('inspects the current selected DOM owner before cancellation and releases it when verification rejects', async () => {
    const f = await fixture()
    try {
      const raw = { pageTitle: 'Fixture', pageUrl: 'https://example.invalid/', tagName: 'button', role: 'button',
        accessibleName: 'Actual target', selector: 'button', text: 'Actual target', nearbyText: [], attributes: {},
        html: '<button>Actual target</button>', rectViewport: { x: 0, y: 0, width: 200, height: 50 },
        rectPage: { x: 0, y: 0, width: 200, height: 50 }, isFixed: false }
      f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, scripts: { code: string }[]) =>
        scripts[0]!.code.includes('Select an element') ? raw : true)
      const inspect = vi.fn(async (revision: number) => {
        expect(f.contents.executeJavaScriptInIsolatedWorld.mock.calls.at(-1)?.[1][0].code).toContain('const retainTarget = true')
        expect(revision).toBeGreaterThan(0)
        throw new Error('Actual backend is ambiguous')
      })
      await expect(f.manager.selectElement('b1', inspect)).rejects.toThrow('Actual backend is ambiguous')
      expect(inspect).toHaveBeenCalledOnce()
      expect(f.contents.executeJavaScriptInIsolatedWorld.mock.calls.at(-1)?.[1][0].code).toContain('const barrier =')
    } finally { await f.close() }
  })

  it('hydrates retained versions and interrupted cursors through Main without attaching or replaying', async () => {
    const f = await fixture()
    try {
      const saved = await version(f)
      const document = JSON.parse(await readFile(join(f.directory, 'assets.json'), 'utf8'))
      document.runs = [{ id: 'uncertain-run', assetId: saved.id, version: 1, browserId: 'b1', nextStep: 0,
        status: 'running', operationIds: [], startedAt: 1, updatedAt: 2 }]
      await writeFile(join(f.directory, 'assets.json'), JSON.stringify(document))
      f.manager.dispose()
      const restored = await managerWithBrowser(undefined, undefined, undefined, 'workspace-1', undefined,
        new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(f.directory, 'assets.json'))))
      try {
        const state = await restored.manager.getTaskAssets('b1')
        expect(state.assets).toEqual([saved])
        expect(state.runs).toEqual([expect.objectContaining({ id: 'uncertain-run', status: 'interrupted', nextStep: 0, operationIds: [] })])
        expect(restored.contents.debugger.isAttached()).toBe(false)
        expect(dispatchCalls).toEqual([])
        expect(restored.sentEvents().at(-1)?.browser.taskAssets).toEqual(state)
        const activity = structuredClone(restored.sentEvents().at(-1)?.browser.activity)
        await expect(restored.manager.runTaskAsset({ assetId: saved.id, version: 1, browserId: 'b1', parameters: {}, runId: 'uncertain-run' }))
          .rejects.toThrow('cannot continue from its current cursor')
        expect(await restored.manager.getTaskAssets('b1')).toEqual(state)
        expect(restored.sentEvents().at(-1)?.browser.activity).toEqual(activity)
        expect(restored.contents.debugger.isAttached()).toBe(false)
        expect(dispatchCalls).toEqual([])
        expect(await restored.manager.runScript('b1', 'return 75')).toMatchObject({ result: 75, outcome: { kind: 'completed' } })
        expect(restored.contents.debugger.isAttached()).toBe(false)
      } finally { restored.manager.dispose() }
    } finally { await f.close() }
  }, 30_000)
})

describe('native downloads via the actual Manager → dispatch → Workspace owner', () => {
  class Download extends EventEmitter {
    path: string | null = null
    bytes = 0
    constructor(readonly total: number) { super() }
    setSavePath(path: string) { this.path = path }
    getFilename() { return 'export.bin' }
    getMimeType() { return 'application/octet-stream' }
    getReceivedBytes() { return this.bytes }
    getTotalBytes() { return this.total }
    cancel() { this.emit('done', {}, 'cancelled') }
  }
  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'amx-manager-download-'))
    const workspace: WorkspaceRecord = { id: 'workspace-download', name: 'Files', hostId: 'local', path: root, kind: 'folder' }
    const files = new WorkspaceFiles(() => new LocalExecutionHost())
    const resolve = (id: string) => { if (id !== workspace.id) throw new Error('Unknown Workspace'); return workspace }
    const downloads = new BrowserDownloads(join(root, 'browser-downloads'), files, resolve)
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.json')))
    const f = await managerWithBrowser(journal, undefined, undefined, workspace.id, undefined, undefined, downloads)
    const dispatchModule = await vi.importActual<typeof import('../src/main/browser-page-dispatch.js')>('../src/main/browser-page-dispatch.js')
    const payload = Buffer.from([0, 255, 128, 13, 10, 2])
    let clicks = 0
    const install = (mode: 'complete' | 'cancel' | 'none' = 'complete', afterSnapshot?: () => Promise<unknown>) => {
      f.contents.debugger.sendCommandImpl = async (method: string) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 11,
          role: { value: 'link' }, name: { value: 'Export file' }, childIds: [] }] }
        if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'object-download' } }
        if (method === 'Runtime.callFunctionOn') {
          clicks += 1
          expect(f.contents.session.listenerCount('will-download')).toBe(1)
          if (mode !== 'none') {
            const item = new Download(payload.length)
            f.contents.session.emit('will-download', {}, item, f.contents)
            expect(item.path).not.toBeNull()
            if (mode === 'complete') { await writeFile(item.path!, payload); item.bytes = payload.length; item.emit('done', {}, 'completed') }
            else item.cancel()
          }
          return { result: { value: null } }
        }
        return {}
      }
      createDispatch.mockImplementationOnce(context => {
        const dispatch = dispatchModule.createBrowserPageDispatch(context)
        return afterSnapshot ? async (name, args) => {
          const value = await dispatch(name, args)
          if (name === 'snapshot') await afterSnapshot()
          return value
        } : dispatch
      })
    }
    return { ...f, root, workspace, files, downloads, resolve, journal, payload, install, actualDispatch: dispatchModule.createBrowserPageDispatch, clicks: () => clicks,
      close: async () => { f.manager.dispose(); await rm(root, { recursive: true, force: true }) } }
  }

  it('registers before the actual ref click, binds real source operation, publishes bytes and continues after navigation/restart without another click', async () => {
    const f = await fixture()
    try {
      f.install()
      const report = await f.manager.runScript('b1', 'const page = await snapshot(); return await download(page.nodes[0].ref, {path:"published.bin", timeoutMs:2000})')
      expect(report.outcome).toEqual({ kind: 'completed' })
      const receipt = report.result as BrowserDownloadReceipt
      expect(receipt).toMatchObject({ status: 'completed', workspaceId: f.workspace.id, browserId: 'b1', operationId: report.runOperation.id })
      expect(receipt.reference).toMatchObject({ path: 'published.bin', operationId: report.runOperation.id, byteLength: f.payload.length })
      expect(report.runOperation.steps).toEqual([expect.objectContaining({ method: 'snapshot' }), expect.objectContaining({ method: 'download' })])
      expect(f.clicks()).toBe(1)
      expect(await readFile(join(f.root, 'published.bin'))).toEqual(f.payload)
      const names = await f.files.readDirectory(f.workspace, '')
      expect(names.map(entry => entry.name)).toContain('published.bin')
      await f.manager.create('b2', 'https://example.invalid/', f.workspace.id)
      createDispatch.mockImplementationOnce(context => f.actualDispatch(context))
      const foreign = await f.manager.runScript('b2', `return await readDownload(${JSON.stringify(receipt.reference)})`)
      expect(foreign.outcome.kind).toBe('script-failed')
      expect(foreign.runOperation.summary).toEqual(expect.stringContaining('does not belong to this Workspace and Browser'))
      expect(f.clicks()).toBe(1)
      await f.manager.navigate('b1', 'https://example.invalid/another-document')
      f.install('none')
      const read = await f.manager.runScript('b1', `return await readDownload(${JSON.stringify(receipt.reference)}, {offset:1,maxBytes:3})`)
      expect(read.outcome).toEqual({ kind: 'completed' })
      const chunk = read.result as BrowserDownloadChunk
      expect(chunk).toMatchObject({ returnedBytes: 3, offset: 1, nextOffset: 4, revision: receipt.reference!.revision })
      expect(Buffer.from(chunk.data, 'base64')).toEqual(f.payload.subarray(1, 4))
      expect(f.clicks()).toBe(1)
      f.manager.dispose()
      const restartedStore = new BrowserDownloads(join(f.root, 'browser-downloads'), f.files, f.resolve)
      const restored = await managerWithBrowser(undefined, undefined, undefined, f.workspace.id, undefined, undefined, restartedStore)
      try {
        createDispatch.mockImplementationOnce(context => f.actualDispatch(context))
        const resumed = await restored.manager.runScript('b1', `return await readDownload(${JSON.stringify(receipt.reference)}, {offset:4,maxBytes:2})`)
        expect(resumed.outcome).toEqual({ kind: 'completed' })
        expect(Buffer.from((resumed.result as BrowserDownloadChunk).data, 'base64')).toEqual(f.payload.subarray(4))
        expect(f.clicks()).toBe(1)
      } finally { restored.manager.dispose() }
    } finally { await f.close() }
  }, 30_000)

  it('refuses relabelling an old operation as the replacement native view and preserves the new healthy Browser', async () => {
    const f = await fixture()
    try {
      const waits = vi.spyOn(f.downloads, 'wait')
      f.install('none', async () => await f.manager.switchProfile('b1', 'another-profile'))
      const report = await f.manager.runScript('b1', 'const page=await snapshot(); return await download(page.nodes[0].ref,{path:"wrong-owner.bin",timeoutMs:100})')
      const replacement = fakeElectron.FakeWebContentsView.instances.at(-1)!.webContents
      expect(replacement.id).not.toBe(f.contents.id)
      expect(f.contents.isDestroyed()).toBe(true)
      expect(waits).toHaveBeenCalledTimes(0)
      expect(f.clicks()).toBe(0)
      expect(replacement.session.listenerCount('will-download')).toBe(0)
      expect(report.outcome.kind).not.toBe('completed')
      await expect(readFile(join(f.root, 'wrong-owner.bin'))).rejects.toMatchObject({code:'ENOENT'})
      expect(await f.manager.runScript('b1','return 58')).toMatchObject({result:58,outcome:{kind:'completed'}})
      expect(replacement.isDestroyed()).toBe(false)
    } finally { await f.close() }
  }, 30_000)

  it('rejects unknown Workspace and script-owned callbacks before triggering a download, while preserving healthy small programs', async () => {
    const f = await fixture()
    try {
      await f.manager.create('b2', 'https://example.invalid/', null)
      createDispatch.mockImplementationOnce(context => f.actualDispatch(context))
      const unavailable = await f.manager.runScript('b2', 'return await download("@e1", {path:"unknown.bin",timeoutMs:100})')
      expect(unavailable.outcome.kind).toBe('script-failed')
      expect(unavailable.runOperation.summary).toEqual(expect.stringContaining('verified Workspace'))
      expect(f.clicks()).toBe(0)
      expect(await f.manager.runScript('b2', 'return 18')).toMatchObject({ result: 18, outcome: { kind: 'completed' } })
      f.install()
      const invalid = await f.manager.runScript('b1', 'return await download("@e1", {path:"unsafe.bin",signal:{aborted:false}})')
      expect(invalid.outcome.kind).toBe('script-failed')
      expect(f.clicks()).toBe(0)
      expect(f.contents.session.listenerCount('will-download')).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('keeps actual cancellation and timeout receipts visible, retains no fabricated file, and permits a healthy next run', async () => {
    const f = await fixture()
    try {
      for (const mode of ['cancel', 'none'] as const) {
        f.install(mode)
        const report = await f.manager.runScript('b1', `const page = await snapshot(); return await download(page.nodes[0].ref, {path:"${mode}.bin",timeoutMs:100})`)
        expect(report.outcome.kind).toBe('indeterminate')
        const receipt = report.result as BrowserDownloadReceipt
        expect(receipt.status).toBe(mode === 'cancel' ? 'cancelled' : 'failed')
        expect(receipt.reference).toBeUndefined()
        expect(report.runOperation.warning).toEqual(expect.stringMatching(mode === 'cancel' ? /cancelled/ : /did not complete within/i))
        if (receipt.warning) expect(report.runOperation.warning).toBe(receipt.warning)
        expect(f.sentEvents().at(-1)?.browser.activity.warning).toBe(report.runOperation.warning)
        await expect(readFile(join(f.root, `${mode}.bin`))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(f.contents.session.listenerCount('will-download')).toBe(0)
        expect(await f.manager.runScript('b1', 'return 94')).toMatchObject({ result: 94, outcome: { kind: 'completed' } })
      }
    } finally { await f.close() }
  }, 30_000)

  it('releases a pending native listener on real operation Stop without publishing a file', async () => {
    const f = await fixture()
    try {
      f.install('none')
      const pending = f.manager.runScript('b1', 'const page = await snapshot(); return await download(page.nodes[0].ref, {path:"stopped.bin",timeoutMs:2000})', undefined, undefined, 'download-stop')
      await vi.waitFor(() => expect(f.clicks()).toBe(1))
      expect(f.contents.session.listenerCount('will-download')).toBe(1)
      await f.manager.stopOperationById('download-stop')
      expect((await pending).outcome.kind).toBe('stopped')
      expect(f.contents.session.listenerCount('will-download')).toBe(0)
      await expect(readFile(join(f.root, 'stopped.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
      f.manager.returnControl('b1')
      expect(await f.manager.runScript('b1', 'return 37')).toMatchObject({ result: 37, outcome: { kind: 'completed' } })
    } finally { await f.close() }
  }, 30_000)

  it('refuses native download action after explicit Stop', async () => {
    const f = await fixture()
    try {
      f.install()
      const report = await f.manager.runScript('b1', 'const page = await snapshot(); return await download(page.nodes[0].ref, {path:"human.bin",timeoutMs:100})')
      const reference = (report.result as BrowserDownloadReceipt).reference
      expect(reference).toBeDefined()
      createDispatch.mockImplementationOnce(context => {
        const dispatch = f.actualDispatch(context)
        return async (name, args) => {
          const result = await dispatch(name, args)
          if (name === 'snapshot') await f.manager.stopOperationById(f.sentEvents().at(-1)?.browser.activity.operation.id)
          return result
        }
      })
      const blocked = await f.manager.runScript('b1', `const page = await snapshot(); await readDownload(${JSON.stringify(reference)}); return await download(page.nodes[0].ref, {path:"must-not-publish.bin",timeoutMs:100})`)
      expect(blocked.outcome.kind).toBe('stopped')
      expect(f.clicks()).toBe(1)
      expect(blocked.runOperation.steps).toEqual([expect.objectContaining({ method: 'snapshot' })])
      expect(f.contents.session.listenerCount('will-download')).toBe(0)
      await expect(readFile(join(f.root, 'must-not-publish.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.close() }
  }, 30_000)
})

describe('file upload via exact current ref and sole Workspace snapshot owner', () => {
  async function fixture(frame = false) {
    const root = mkdtempSync(join(tmpdir(), 'amx-manager-upload-'))
    const workspace: WorkspaceRecord = { id: 'workspace-upload', name: 'Upload', hostId: 'local', path: root, kind: 'folder' }
    const files = new WorkspaceFiles(() => new LocalExecutionHost())
    const uploads = new BrowserUploads(join(root, 'browser-uploads'), files, id => {
      if (id !== workspace.id) throw new Error('Unknown Workspace')
      return workspace
    })
    const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.json')))
    const f = await managerWithBrowser(journal, undefined, undefined, workspace.id, undefined, undefined, undefined, uploads)
    f.contents.emitMainNavigation = true
    const actual = await vi.importActual<typeof import('../src/main/browser-page-dispatch.js')>('../src/main/browser-page-dispatch.js')
    const payload = Buffer.from([0, 128, 255, 10])
    await writeFile(join(root, 'attachment.bin'), payload)
    let staged: string[] = []
    let assignments = 0
    let loseAcknowledgement = false
    const targetSessions: (string | undefined)[] = []
    f.contents.debugger.sendCommandImpl = async (method: string, args: any, sessionId?: string) => {
      if (method === 'Target.setAutoAttach' && frame && !sessionId) {
        f.contents.debugger.emit('message','Target.attachedToTarget',{sessionId:'actual-file-frame',targetInfo:{type:'iframe'}})
        return {}
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: sessionId ? 'native-file-document' : 'native-main-document', loaderId: 'actual-observed-loader', ...(sessionId ? { parentId: 'native-main-document' } : {}) } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: frame && !sessionId ? [{nodeId:'root',role:{value:'RootWebArea'}}] : [{ nodeId: '1', backendDOMNodeId: 11,
        role: { value: 'button' }, name: { value: 'Choose file' }, childIds: [] }] }
      if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
      if (['DOM.resolveNode','DOM.setFileInputFiles','Runtime.callFunctionOn'].includes(method)) {
        targetSessions.push(sessionId)
        expect(sessionId).toBe(frame ? 'actual-file-frame' : undefined)
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'actual-current-file-input' } }
      if (method === 'DOM.setFileInputFiles') {
        expect(args.objectId).toBe('actual-current-file-input')
        expect(args.backendNodeId).toBeUndefined()
        staged = args.files
        assignments += 1
        if (loseAcknowledgement) throw new Error('Native assignment acknowledgement lost')
        return {}
      }
      if (method === 'Runtime.callFunctionOn') {
        expect(args.objectId).toBe('actual-current-file-input')
        if (args.functionDeclaration.includes('HTMLInputElement')) return { result: { value: { multiple: true } } }
        return { result: { value: [{ name: 'attachment.bin', byteLength: payload.length }] } }
      }
      return {}
    }
    const install = () => createDispatch.mockImplementationOnce(context => actual.createBrowserPageDispatch(context))
    return { ...f, root, workspace, files, uploads, payload, install, actualDispatch: actual.createBrowserPageDispatch, targetSessions,
      staged: () => staged, assignments: () => assignments, loseAcknowledgement: () => { loseAcknowledgement = true },
      close: async () => { f.manager.dispose(); await uploads.dispose(); await rm(root, { recursive: true, force: true }) } }
  }

  it('binds the real operation, pins exact file bytes beyond run completion, and releases only the related document', async () => {
    const f = await fixture()
    try {
      const releases = vi.spyOn(f.uploads, 'releaseBrowser')
      f.install()
      const report = await f.manager.runScript('b1', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref, ["attachment.bin"])')
      expect(report.outcome.kind, JSON.stringify(report.outcome)).toBe('completed')
      const receipt = report.result as BrowserUploadReceipt
      expect(receipt).toMatchObject({ kind: 'browser-upload-files', workspaceId: f.workspace.id, browserId: 'b1', operationId: report.runOperation.id,
        byteLength: f.payload.length, files: [{ path: 'attachment.bin', name: 'attachment.bin', byteLength: f.payload.length }] })
      expect(JSON.stringify(receipt)).not.toContain(f.root)
      expect(f.assignments()).toBe(1)
      expect(f.staged()).toHaveLength(1)
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      await writeFile(join(f.root, 'attachment.bin'), Buffer.from('workspace changed after selection'))
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      expect(await f.manager.runScript('b1', 'return 29')).toMatchObject({ result: 29, outcome: { kind: 'completed' } })
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      for (const listener of f.contents.listeners.get('did-start-navigation') ?? []) listener({ url: 'https://example.invalid/#section', isMainFrame: true, isSameDocument: true })
      expect(releases).toHaveBeenCalledTimes(0)
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      await f.manager.create('b2', 'https://example.invalid/', f.workspace.id)
      fakeElectron.FakeWebContentsView.instances.at(-1)!.webContents.emitMainNavigation = true
      await f.manager.navigate('b2', 'https://example.invalid/unrelated')
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      await f.manager.navigate('b1', 'https://example.invalid/next')
      await vi.waitFor(async () => await expect(readFile(f.staged()[0]!)).rejects.toMatchObject({ code: 'ENOENT' }))
      expect(await f.manager.runScript('b1', 'return 31')).toMatchObject({ result: 31, outcome: { kind: 'completed' } })
    } finally { await f.close() }
  }, 30_000)

  it('rejects original-view source callbacks after an actual profile replacement and keeps the replacement healthy', async () => {
    const f = await fixture()
    const rejectionFacts: string[] = []
    try {
      const assignments = vi.spyOn(f.uploads, 'upload')
      createDispatch.mockImplementationOnce(context => {
        const originalSource = context.uploads!.context()
        const dispatch = f.actualDispatch(context)
        return async (name, args) => {
          const value = await dispatch(name, args)
          if (name === 'snapshot') {
            await f.manager.switchProfile('b1', 'another-profile')
            try { context.uploads!.context() } catch (error) { rejectionFacts.push((error as Error).message) }
            try { originalSource.currentNavigationId() } catch (error) { rejectionFacts.push((error as Error).message) }
          }
          return value
        }
      })
      const report = await f.manager.runScript('b1', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref,["attachment.bin"])')
      const replacement = fakeElectron.FakeWebContentsView.instances.at(-1)!.webContents
      expect(f.contents.isDestroyed()).toBe(true)
      expect(replacement.id).not.toBe(f.contents.id)
      expect(rejectionFacts).toEqual(['The Browser view changed before upload.', 'The Browser view changed during upload.'])
      expect(report.outcome.kind).toBe('script-failed')
      expect(assignments).toHaveBeenCalledTimes(0)
      expect(f.assignments()).toBe(0)
      expect(f.staged()).toEqual([])
      expect(await f.manager.runScript('b1', 'return 59')).toMatchObject({result:59,outcome:{kind:'completed'}})
      expect(replacement.isDestroyed()).toBe(false)
    } finally { await f.close() }
  }, 30_000)

  it('rejects ledger-only, superseded and cross-navigation refs before any file assignment', async () => {
    const f = await fixture()
    try {
      f.install()
      const previous = await f.manager.runScript('b1', 'return await snapshot()')
      const ref = (previous.result as { nodes: {ref:string}[] }).nodes[0]!.ref
      expect(ref).toBeTruthy()
      f.install()
      const ledgerOnly = await f.manager.runScript('b1', `return await uploadFiles(${JSON.stringify(ref)}, ["attachment.bin"])`)
      expect(ledgerOnly.outcome.kind).toBe('script-failed')
      expect(ledgerOnly.runOperation.summary).toEqual(expect.stringContaining('latest snapshot in this run'))
      f.install()
      const superseded = await f.manager.runScript('b1', 'const old=await snapshot(); await snapshot(); return await uploadFiles(old.nodes[0].ref, ["attachment.bin"])')
      expect(superseded.outcome.kind).toBe('script-failed')
      createDispatch.mockImplementationOnce(context => {
        const dispatch = f.actualDispatch(context)
        return async (name,args) => {
          const result = await dispatch(name,args)
          if (name === 'snapshot') await f.manager.navigate('b1','https://example.invalid/cross-document')
          return result
        }
      })
      const crossDocument = await f.manager.runScript('b1', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref, ["attachment.bin"])')
      expect(crossDocument.outcome.kind).toBe('script-failed')
      expect(crossDocument.runOperation.summary).toEqual(expect.stringContaining('navigated since that snapshot'))
      expect(f.assignments()).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('resolves and assigns an observed iframe file input only through that actual frame sender', async () => {
    const f = await fixture(true)
    try {
      f.install()
      const report = await f.manager.runScript('b1', 'const page=await snapshot(); const input=page.nodes.find(node=>node.name==="Choose file"); return await uploadFiles(input.ref,["attachment.bin"])')
      expect(report.outcome.kind,JSON.stringify(report.outcome)).toBe('completed')
      expect(f.assignments()).toBe(1)
      expect(f.targetSessions).toEqual(['actual-file-frame','actual-file-frame','actual-file-frame','actual-file-frame','actual-file-frame'])
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
    } finally { await f.close() }
  }, 30_000)

  it('rejects a guessed ref omitted by the observation budget even when it exists in the full identity graph', async () => {
    const f = await fixture()
    try {
      const send = f.contents.debugger.sendCommandImpl
      f.contents.debugger.sendCommandImpl = async (method: string, args: any, sessionId?: string) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes: [
          { nodeId: '0', backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Other action' }, childIds: [] },
          { nodeId: '1', backendDOMNodeId: 11, role: { value: 'button' }, name: { value: 'Choose file' }, childIds: [] }
        ] }
        return await send(method,args,sessionId)
      }
      f.install()
      const report = await f.manager.runScript('b1','const page=await snapshot({maxNodes:1}); if(page.nodes.length!==1)throw new Error("nonempty bounded observation required"); const hiddenRef="@e"+(Number(page.nodes[0].ref.slice(2))+1); return await uploadFiles(hiddenRef,["attachment.bin"])')
      expect(report.outcome.kind).toBe('script-failed')
      expect(report.runOperation.summary).toEqual(expect.stringContaining('latest snapshot in this run'))
      expect(f.assignments()).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('rejects unknown Workspace before assigning files and permits a healthy next program', async () => {
    const f = await fixture()
    try {
      await f.manager.create('b2','https://example.invalid/',null)
      const b2 = fakeElectron.FakeWebContentsView.instances.at(-1)!.webContents
      b2.debugger.sendCommandImpl = f.contents.debugger.sendCommandImpl
      f.install()
      const report = await f.manager.runScript('b2', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref, ["attachment.bin"])')
      expect(report.outcome.kind).toBe('script-failed')
      expect(report.runOperation.summary).toEqual(expect.stringContaining('verified Workspace'))
      expect(f.assignments()).toBe(0)
      expect(await f.manager.runScript('b2', 'return 41')).toMatchObject({ result: 41, outcome: { kind: 'completed' } })
    } finally { await f.close() }
  }, 30_000)

  it('retains possible FileList bytes when native acknowledgement is lost, reports uncertainty, and never repeats assignment', async () => {
    const f = await fixture()
    try {
      f.loseAcknowledgement(); f.install()
      const report = await f.manager.runScript('b1', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref, ["attachment.bin"])')
      expect(report.outcome.kind).toBe('indeterminate')
      expect(report.runOperation.warning).toEqual(expect.stringMatching(/may.*selected|possibly.*selected|uncertain|acknowledgement/i))
      expect(f.assignments()).toBe(1)
      await expect(readFile(f.staged()[0]!)).resolves.toEqual(f.payload)
      expect(await f.manager.runScript('b1','return 43')).toMatchObject({ result: 43, outcome: { kind: 'completed' } })
      expect(f.assignments()).toBe(1)
      await f.manager.close('b1')
      await vi.waitFor(async () => await expect(readFile(f.staged()[0]!)).rejects.toMatchObject({ code: 'ENOENT' }))
    } finally { await f.close() }
  }, 30_000)

  for (const boundary of ['stop', 'return-during-IO'] as const) {
    it(`does not assign files after ${boundary} while the real Workspace snapshot IO is still pending`, async () => {
      const f = await fixture()
      let releaseIO!: () => void
      const held = new Promise<void>(resolve => { releaseIO = resolve })
      let entered = false
      let uploadSettled = false
      const snapshotBytes = f.files.snapshotBytes.bind(f.files)
      vi.spyOn(f.files, 'snapshotBytes').mockImplementation(async (...args) => {
        entered = true
        await held
        return await snapshotBytes(...args)
      })
      const actualUpload = f.uploads.upload.bind(f.uploads)
      vi.spyOn(f.uploads, 'upload').mockImplementation(async (...args) => {
        try { return await actualUpload(...args) } finally { uploadSettled = true }
      })
      try {
        f.install()
        const pending = f.manager.runScript('b1', 'const page=await snapshot(); return await uploadFiles(page.nodes[0].ref,["attachment.bin"])', undefined, undefined, `upload-held-${boundary}`)
        await vi.waitFor(() => expect(entered).toBe(true))
        expect(f.assignments()).toBe(0)
        await f.manager.create('b2', 'https://example.invalid/healthy', f.workspace.id)
        expect(await f.manager.runScript('b2', 'return 71')).toMatchObject({result:71,outcome:{kind:'completed'}})
        await f.manager.stopOperationById(`upload-held-${boundary}`)
        if (boundary === 'return-during-IO') f.manager.returnControl('b1')
        releaseIO()
        const report = await pending
        await vi.waitFor(() => expect(uploadSettled).toBe(true))
        expect(f.assignments()).toBe(0)
        expect(f.staged()).toEqual([])
        expect(report.outcome.kind).toBe('stopped')
        expect(f.sentEvents().at(-1)?.browser.activity.control).toBe(boundary === 'return-during-IO' ? 'agent' : 'human')
        expect(f.contents.isDestroyed()).toBe(false)
        f.manager.returnControl('b1')
        expect(await f.manager.runScript('b1', 'return 67')).toMatchObject({result:67,outcome:{kind:'completed'}})
      } finally { releaseIO(); await f.close() }
    }, 30_000)
  }

  it('refuses file selection after explicit Stop before the owner can assign files', async () => {
    const f = await fixture()
    try {
      createDispatch.mockImplementationOnce(context => {
        const dispatch = f.actualDispatch(context)
        return async (name,args) => {
          const result = await dispatch(name,args)
          if (name === 'snapshot') await f.manager.stopOperationById(f.sentEvents().at(-1)?.browser.activity.operation.id)
          return result
        }
      })
      const report = await f.manager.runScript('b1','const page=await snapshot(); return await uploadFiles(page.nodes[0].ref,["attachment.bin"])')
      expect(report.outcome.kind).toBe('stopped')
      expect(f.assignments()).toBe(0)
    } finally { await f.close() }
  }, 30_000)

  it('keeps cleanup failure visible without blocking the new healthy Browser document', async () => {
    const f = await fixture()
    try {
      f.install()
      const report = await f.manager.runScript('b1','const page=await snapshot(); return await uploadFiles(page.nodes[0].ref,["attachment.bin"])')
      expect(report.outcome.kind).toBe('completed')
      vi.spyOn(f.uploads,'releaseBrowser').mockRejectedValueOnce(new Error('Owned cleanup IO failed'))
      await f.manager.navigate('b1','https://example.invalid/retry-cleanup')
      await vi.waitFor(() => expect(f.sentEvents().at(-1)?.browser.activity.warning).toEqual(expect.stringContaining('staging could not be fully released')))
      expect(await f.manager.runScript('b1','return 47')).toMatchObject({result:47,outcome:{kind:'completed'}})
    } finally { await f.close() }
  }, 30_000)
})
