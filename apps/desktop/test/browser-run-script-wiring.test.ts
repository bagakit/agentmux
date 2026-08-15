import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    sendCommandImpl: (method: string) => Promise<unknown> = async () => ({})
    attach(): void { this.attached = true }
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
    async sendCommand(method: string): Promise<unknown> { return await this.sendCommandImpl(method) }
  }

  class FakeWebContents {
    url = 'https://example.invalid/'
    title = 'Example'
    destroyed = false
    readonly debugger = new FakeDebugger()
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    readonly session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn()
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
    removeListener(): this { return this }
    setWindowOpenHandler(): void {}
    setZoomFactor(): void {}
    getZoomFactor(): number { return 1 }
    getURL(): string { return this.url }
    getTitle(): string { return this.title }
    isLoading(): boolean { return false }
    isLoadingMainFrame(): boolean { return false }
    isDestroyed(): boolean { return this.destroyed }
    async loadURL(url: string): Promise<void> {
      this.url = url
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
const dispatchSpy = vi.hoisted(() => {
  const calls: { name: string; args: unknown[] }[] = []
  const create = vi.fn(() => async (name: string, args: unknown[]) => {
    calls.push({ name, args })
    return `dispatched:${name}`
  })
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

const profiles: BrowserProfileResolver = {
  defaultProfileId: () => 'default',
  resolvePartition: (id) => `persist:${id}`
}

function fakeWindow(): any {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { isDestroyed: () => false, send: vi.fn() }
  }
}

async function managerWithBrowser(): Promise<{
  manager: BrowserViewManager
  contents: any
}> {
  dispatchCalls.length = 0
  createDispatch.mockClear()
  fakeElectron.FakeWebContentsView.instances.length = 0
  // ref 账本给临时路径：本文件 mock 掉了派发层，账本根本不会被读，但真路径会往 userData 里写文件。
  const manager = new BrowserViewManager(fakeWindow(), profiles, new BrowserRefLedgerStore(
    join(mkdtempSync(join(tmpdir(), 'agentmux-wiring-')), 'ref-ledger.json')
  ))
  await manager.create('b1', 'https://example.invalid/')
  const view = fakeElectron.FakeWebContentsView.instances[0]!
  return { manager, contents: view.webContents }
}

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
