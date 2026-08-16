import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/main/browser-operation-journal.js'
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

async function managerWithBrowser(journal?: BrowserOperationJournal): Promise<{
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
  }, journal)
  await manager.create('b1', 'https://example.invalid/')
  const view = fakeElectron.FakeWebContentsView.instances[0]!
  // 函数而不是数组：驱动的开始与结束各推一次，都发生在 create 之后，取快照就看不到它们了。
  return {
    manager,
    contents: view.webContents,
    sentEvents: () => window.events
  }
}

/**
 * 让派发层在**第一次**被调用时顺手模拟一次真人输入，并记下每次调用的名字。
 *
 * 接管信号必须从主进程这一侧发出，因为程序跑在它自己的子进程里，够不到 webContents。挂在
 * 第一次调用上是为了拿到确定的时序：「第一次动作发生过、之后的一个都没有」正是这套设计
 * 承诺的那句话。
 *
 * 放在模块级而不是某个 describe 里：驱动位那一族也要用它——「被掐断的运行有没有把驱动位还原」
 * 和「掐断之后动作停不停」是同一次接管的两个侧面，两处各写一份会漂。
 */
function takeoverOnFirstCall(contents: any, type = 'mouseDown'): string[] {
  const seen: string[] = []
  let fired = false
  createDispatch.mockImplementationOnce(() => async (name: string) => {
    seen.push(name)
    if (!fired) {
      fired = true
      contents.emit('input-event', { type })
    }
    return `dispatched:${name}`
  })
  return seen
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

/**
 * T-012：人伸手把方向盘抢回去之后，Agent 明确停下。
 *
 * 判在这一层而不是派发层，因为要判的正是 manager 那三件事：**拦在 onPageCall 这道必经之路上**、
 * **结局压成 `stopped`**、**监听器跟着这一次运行走**。派发层对「有没有人碰过这个 view」一无所知。
 *
 * 「Agent 的动作不产生 input-event」那条地基在 browser-ownership.test.ts 上真机判——这里喂的是
 * 合成事件，证不了那件事，也不打算证。
 */
describe('runScript：人接管之后，动作停、观察放行', () => {
  it('人点了一下之后 click 被拒，而这之前的 click 正常执行', async () => {
    const { manager, contents } = await managerWithBrowser()
    const seen = takeoverOnFirstCall(contents)

    const report = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')

    // 正向：接管**之前**那次真的做了。少了这一半，一个「永远拒绝」的实现也会绿——而那等于
    // Agent 从此再也驱动不了任何页面。
    expect(seen, '接管之前那次 click 没落到派发层上').toEqual(['click'])
    // 反向：之后那次没落下去。只判结局的话，一个「照点不误、最后才把结局改个名」的实现也会绿。
    expect(seen, '接管之后那次 click 照样点下去了').toHaveLength(1)
    expect(report.outcome.kind, '接管之后的运行没被降级').toBe('stopped')
  }, 30_000)

  it('接管之后 snapshot 照样放行，js 和 cdp 被拒', async () => {
    // 放行观察是设计的一半：程序被打断之后最该做的事就是看一眼页面再报告。把 snapshot 也拦掉，
    // 它只能瞎猜着退出。两个逃生口按动作算——它们能做任何事，漏掉任何一个等于没拦。
    const { manager, contents } = await managerWithBrowser()
    const seen = takeoverOnFirstCall(contents)

    const report = await manager.runScript('b1', `
      await click("@e1")
      const outcomes = []
      for (const [label, run] of [
        ['snapshot', () => snapshot()],
        ['pageInfo', () => pageInfo()],
        ['js', () => js('1')],
        ['cdp', () => cdp('Runtime.evaluate', {})]
      ]) {
        try { await run(); outcomes.push(label + ':allowed') }
        catch (error) { outcomes.push(label + ':refused') }
      }
      return outcomes
    `)

    // 程序把拒绝吞了照常 return，所以 result 拿得到——而结局仍然被压成 stopped（下一条判）。
    expect(report.result, `程序没跑到底：${JSON.stringify(report.outcome)}`).toEqual([
      'snapshot:allowed',
      'pageInfo:allowed',
      'js:refused',
      'cdp:refused'
    ])
    // 放行的两个真的落到派发层上了，不是被上层伪造成一次成功。
    expect(seen, '放行的观察没真的执行').toEqual(['click', 'snapshot', 'pageInfo'])
  }, 30_000)

  it('程序把拒绝 try/catch 吞了照常 return，结局仍然是 stopped', async () => {
    // 这条是承重的，与 `endedReason` 那段注释里的是同一个陷阱：判在脚本层会被这个 catch 吃掉。
    const { manager, contents } = await managerWithBrowser()
    takeoverOnFirstCall(contents)

    const report = await manager.runScript(
      'b1',
      'await click("@e1"); try { await click("@e2") } catch (error) { } return "done"'
    )

    expect(report.outcome.kind, '被接管却报成功——Agent 会以为它的程序跑完了').toBe('stopped')
    const message = report.outcome.kind === 'stopped' ? report.outcome.message : ''
    // 文案点名的恢复动作必须是「再跑一次」：它真能走通，而"去改设置"不成比例（人从没要求
    // 禁用自动化），照 browser-automation-setting-reachable.test.ts 的房规。
    expect(message, '没说清是人接管了').toMatch(/took control/i)
    expect(message, '没告诉 Agent 下一步能干什么').toMatch(/run the program again/i)
    expect(message, '没提先看一眼页面').toMatch(/snapshot\(\)/)
  }, 30_000)

  it('被接管不报 indeterminate，也不报 script-failed', async () => {
    // 三支各有各的下一步，折并任意两支都会让 Agent 走错方向：
    // - indeterminate 说的是"做到哪一步不知道"，而这里知道——拦在必经之路上，之后一个都没跑。
    // - script-failed 是在把人的动作记到 Agent 程序头上，还叫它去改一段本来没错的代码。
    //   这一支只有在覆写被放进 `if (run.completed)` 里面时才会冒出来：程序**没吞**拒绝的时候，
    //   错是抛着出来的，落进 browserRunOutcomeFromFailure。两条路必须汇到同一个结局。
    const { manager, contents } = await managerWithBrowser()

    takeoverOnFirstCall(contents)
    const swallowed = await manager.runScript(
      'b1',
      'await click("@e1"); try { await click("@e2") } catch (error) { } return "done"'
    )
    takeoverOnFirstCall(contents)
    manager.returnControl('b1')
    const thrown = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')

    for (const [label, report] of [['吞了的', swallowed], ['没吞的', thrown]] as const) {
      expect(report.outcome.kind, `${label}那次报成了 ${report.outcome.kind}`).toBe('stopped')
    }
    // 结局一样，`result` 不一样：吞了的那次程序真的 return 了东西（观察放行就是为了让它能这么做），
    // 没吞的那次根本没跑到 return。两边都填一个值，或者两边都丢掉，都是在说谎。
    expect(swallowed.result, '程序吞掉拒绝后 return 的东西被丢了——等于逼它再跑一遍').toBe('done')
    expect(thrown.result, '程序没跑到 return 却报出了返回值').toBeUndefined()
  }, 30_000)

  it('鼠标飘过不算接管——只有有意的输入才算', async () => {
    // 少了这条，一个「什么 input-event 都算」的实现会让上面几条全绿，而那等于人把指针挪过屏幕
    // Agent 就停。这是一个会让整个功能变成噪音的假阳性，而且没人会当它是 bug。
    const { manager, contents } = await managerWithBrowser()
    const seen: string[] = []
    createDispatch.mockImplementationOnce(() => async (name: string) => {
      seen.push(name)
      for (const type of ['mouseMove', 'mouseEnter', 'pointerMove', 'pointerRawUpdate', 'mouseLeave']) {
        contents.emit('input-event', { type })
      }
      return `dispatched:${name}`
    })

    const report = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')

    expect(seen, '指针飘过之后的动作被拦了').toEqual(['click', 'click'])
    expect(report.outcome.kind, '指针飘过就被判成接管了——这功能会吵到没法用').toBe('completed')
  }, 30_000)

  it('监听器跟着这一次运行走，不跟着 entry 走', async () => {
    // 挂在整个 entry 生命周期上的话，人平时正常用浏览器就一直在写这个字段，下一次 run 一启动
    // 就以为自己被接管了。这条连跑两次来判：第一次的输入不许影响第二次。
    const { manager, contents } = await managerWithBrowser()

    takeoverOnFirstCall(contents)
    const first = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')
    expect(first.outcome.kind, '第一次没被判接管——这条判据在对空气生效').toBe('stopped')

    manager.returnControl('b1')
    const second = await manager.runScript('b1', 'await click("@e1"); return "done"')

    expect(second.outcome.kind, '上一次的接管漏到了下一次运行——监听器没摘干净').toBe('completed')
    expect(contents.listeners.get('input-event') ?? [], 'input-event 的监听没摘掉——每轮泄漏一个')
      .toHaveLength(0)
  }, 30_000)

  it('人接管后必须显式交还方向盘，交还会清掉锁', async () => {
    const { manager, contents } = await managerWithBrowser()
    takeoverOnFirstCall(contents)
    const stopped = await manager.runScript('b1', 'await click("@e1"); return "done"')
    expect(stopped.outcome.kind).toBe('stopped')
    await expect(manager.runScript('b1', 'return "blocked"')).rejects.toThrow(/return control/i)
    manager.returnControl('b1')
    const resumed = await manager.runScript('b1', 'return "resumed"')
    expect(resumed.outcome.kind).toBe('completed')
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
    takeoverOnFirstCall(contents)

    const report = await manager.runScript('b1', 'await click("@e1"); await click("@e2"); return "done"')

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
      const document = JSON.parse(await readFile(path, 'utf8')) as { operations?: Array<{ id: string; phase: string }> }
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
      if (name === 'snapshot') return { nodes: [{ ref: '@fresh', role: 'button', name: 'Continue' }] }
      if (name === 'click') context.recordTarget?.(target)
      return null
    })
    const replay = await manager.runReplay('b1', plan!)
    expect(replay.outcome.kind).toBe('completed')
    expect(calls).toEqual([
      { name: 'pageInfo', args: [] },
      { name: 'snapshot', args: [] },
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
          nodes: [
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

  it('真人输入当时就推送 control=human，不等挂起的 page call 结束', async () => {
    const { manager, contents, sentEvents } = await managerWithBrowser()
    const held = holdNextCall()
    const pending = manager.runScript('b1', 'await wait(1000); await click("@e1")')
    try {
      await held.entered
      const before = sentEvents().length
      contents.emit('input-event', { type: 'mouseDown' })
      const handoffEvents = sentEvents().slice(before)
      expect(handoffEvents).toHaveLength(1)
      expect(handoffEvents[0]).toMatchObject({
        type: 'updated', browser: { driving: false, activity: { control: 'human', operation: { phase: 'human' } } }
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
    const pending = manager.runScript('b1', 'await wait(1000); await click("@e1")')
    try {
      await held.entered
      const before = sentEvents().length
      const stopped = manager.stopOperation('b1')
      expect(stopped).toMatchObject({ driving: false, activity: { control: 'human' } })
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
