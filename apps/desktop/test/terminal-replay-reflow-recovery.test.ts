import { describe, expect, it, vi } from 'vitest'
import headless from '@xterm/headless'
import { readFileSync } from 'node:fs'
import { finishTerminalReplayRecovery, hydrateTerminalReplay, terminalReplayGeometryOutcome, terminalViewportSyncOutcome } from '../src/renderer/src/lib/terminal-replay'
import { classifyServiceNotice } from '../src/renderer/src/lib/service-window-notice'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'

describe('attachment geometry across asynchronous replay', () => {
  it.each([
    { canControl: true, releaseFails: false },
    { canControl: true, releaseFails: true },
    { canControl: false, releaseFails: false },
    { canControl: false, releaseFails: true }
  ])('holds geometry through startup pending writes (control=$canControl, failure=$releaseFails)', async ({ canControl, releaseFails }) => {
    const terminal = new headless.Terminal({ cols: 132, rows: 45, allowProposedApi: true })
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 100, rows: 30 }),
      fit: () => terminal.resize(100, 30),
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize, requestFrame: frames.request, cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1000, height: 600 })
    })
    const calls: string[] = []
    const onRecoveryError = vi.fn()
    let releasedLine: string | undefined
    const write = async (data: string) => await new Promise<void>((resolve) => terminal.write(data, resolve))
    try {
      sync.beginReplay()
      await hydrateTerminalReplay([{ data: '\x1b[?1049hretained', endByte: 16 }], write)
      await expect(finishTerminalReplayRecovery({
        gap: false,
        canControlRun: canControl,
        releaseLiveOutput: async () => {
          calls.push('release')
          for (const data of ['\x1b[39;100HPENDING_A', '\x1b[40;100HPENDING_B']) {
            await write(data)
            sync.observeViewport()
            frames.runNext()
            expect([terminal.cols, terminal.rows]).toEqual([132, 45])
          }
          releasedLine = terminal.buffer.active.getLine(39)?.translateToString(true)
          calls.push('drained')
          if (releaseFails) throw new Error('startup drain failed')
        },
        finishReplay: () => { calls.push('finish'); sync.endReplay(true) },
        startLiveSynchronization: async () => { calls.push('live'); await sync.startLiveSynchronization() },
        redrawCurrentScreen: async () => { throw new Error('No gap redraw expected') },
        onRecoveryError
      })).resolves.toBe(false)
      expect(releasedLine).toBe(`${' '.repeat(99)}PENDING_B`)
      expect(calls).toEqual(canControl ? ['release', 'drained', 'finish', 'live'] : ['release', 'drained', 'finish'])
      expect(onRecoveryError).toHaveBeenCalledTimes(releaseFails ? 1 : 0)
      expect(frames.runNext()).toBe(true)
      await settleResizes(resize)
      expect([terminal.cols, terminal.rows]).toEqual([100, 30])
      expect(resize).toHaveBeenCalledTimes(canControl ? 3 : 0)
    } finally { sync.dispose(); terminal.dispose() }
  })

  it.each([{ cols: 132, rows: 45 }, { cols: 100, rows: 30 }])('locks replay at the owner size before fitting $cols×$rows', async (target) => {
    const terminal = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => target,
      fit: () => terminal.resize(target.cols, target.rows),
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1000, height: 600 })
    })
    try {
      // An already scheduled frame (or a process-state transition) must not fit during replay.
      sync.observeViewport()
      sync.beginReplay()
      await sync.startLiveSynchronization()
      terminal.resize(132, 45)
      const replay = '\x1b[?1049h\x1b[40;100HWIDE_MARK'
      await hydrateTerminalReplay([{ data: replay, endByte: replay.length }],
        async (data) => await new Promise<void>((resolve) => terminal.write(data, resolve)),
        async () => {
          sync.observeViewport()
          frames.runNext()
          expect([terminal.cols, terminal.rows]).toEqual([132, 45])
        })
      expect(terminal.buffer.active.getLine(39)?.translateToString(true)).toBe(`${' '.repeat(99)}WIDE_MARK`)
      expect(resize).not.toHaveBeenCalled()
      sync.endReplay(true)
      await sync.startLiveSynchronization()
      expect([terminal.cols, terminal.rows]).toEqual([target.cols, target.rows])
      expect(frames.runNext()).toBe(true)
      await settleResizes(resize)
      expect([terminal.cols, terminal.rows]).toEqual([target.cols, target.rows])
      expect(resize.mock.calls.at(-1)?.[0]).toEqual(target)
      expect(redrawRoundTrips(resize, target)).toBe(target.cols === 132 ? 0 : 1)
    } finally { sync.dispose(); terminal.dispose() }
  })

  it('clears the pre-attach pixel baseline before restoring owner geometry', async () => {
    const frames = frameHarness()
    let actual = { cols: 80, rows: 24 }
    const target = { cols: 132, rows: 45 }
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => target, fit: () => { actual = target }, readGrid: () => actual,
      resize: async () => true, requestFrame: frames.request, cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1320, height: 900 })
    })
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    expect(actual).toEqual(target)
    sync.beginReplay()
    actual = { cols: 100, rows: 30 }
    sync.endReplay(true)
    await sync.startLiveSynchronization()
    expect(actual).toEqual(target)
    sync.dispose()
  })

  it('keeps repaint pending until the first resize reaches the PTY', async () => {
    const harness = terminalHarness({ cols: 80, rows: 24 })
    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.resize.mockResolvedValueOnce(false)
    await harness.sync.startLiveSynchronization()
    expect(harness.resize.mock.calls).toEqual([[{ cols: 132, rows: 45 }]])
    expect(harness.frames.runNext()).toBe(true)
    await settleResizes(harness.resize)
    expect(redrawRoundTrips(harness.resize, { cols: 132, rows: 45 })).toBe(1)
    expect(harness.resize.mock.calls.at(-1)?.[0]).toEqual({ cols: 132, rows: 45 })
    harness.sync.dispose()
  })

  it('preserves live intent after a thrown resize, shows degradation, and converges on a later viewport event', async () => {
    let failed = false
    const harness = terminalHarness({ cols: 80, rows: 24 }, {
      onResizeError: () => { failed = true },
      onResizeSuccess: () => { failed = false }
    })
    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.resize.mockRejectedValueOnce(new Error('runtime temporarily unavailable'))
      .mockResolvedValueOnce(false)
    await expect(harness.sync.startLiveSynchronization()).rejects.toThrow('runtime temporarily unavailable')
    expect(classifyServiceNotice(terminalViewportSyncOutcome(failed, 'running'))).toMatchObject({
      kind: 'process-degraded', notice: {
        step: expect.stringContaining('terminal size'),
        mode: expect.stringContaining('remains available'),
        restore: expect.stringContaining('Resize the pane')
      }
    })
    // One settling frame was already scheduled at startup. A non-delivery cannot clear the notice.
    expect(harness.frames.runNext()).toBe(true)
    await settleResizes(harness.resize)
    expect(harness.resize).toHaveBeenCalledTimes(2)
    expect(failed).toBe(true)
    expect(harness.frames.runNext()).toBe(false)
    // The next real observer notification retries without calling startLiveSynchronization again.
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    await settleResizes(harness.resize)
    expect(harness.resize).toHaveBeenCalledTimes(5)
    expect(redrawRoundTrips(harness.resize, { cols: 132, rows: 45 })).toBe(1)
    expect(harness.resize.mock.calls.at(-1)?.[0]).toEqual({ cols: 132, rows: 45 })
    expect(classifyServiceNotice(terminalViewportSyncOutcome(failed, 'running'))).toEqual({ kind: 'healthy' })
    harness.sync.dispose()
  })

  it('connects the geometry owner to TerminalView before the first replay write', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
    const begin = source.indexOf('viewport.beginReplay()')
    const adopt = source.indexOf('terminal.resize(result.currentSize.cols, result.currentSize.rows)')
    const replay = source.indexOf('cursor = await hydrateTerminalReplay(')
    const end = source.indexOf('viewport.endReplay(hasReplay)')
    expect(begin).toBeGreaterThan(-1)
    expect(adopt).toBeGreaterThan(begin)
    expect(replay).toBeGreaterThan(adopt)
    expect(end).toBeGreaterThan(replay)
    expect(source).toContain('finishReplay: () => viewport.endReplay(hasReplay)')
    expect(source.match(/viewport\.endReplay\(/g)).toHaveLength(1)
    expect(source).toContain('terminalReplayGeometryOutcome(replaySizeUnknown, session.processState)')
    expect(source).toContain('<ServiceWindowNotice notice={replayGeometryNotice} />')
    expect(source).toContain('if (!disposed) setViewportSyncFailed(true)')
    expect(source).toContain('onResizeSuccess: () => {')
    expect(source).toContain('setViewportSyncFailed(false)')
    expect(source).toContain('setReplayGap(false)')
    expect(source).toContain('terminalViewportSyncOutcome(viewportSyncFailed, session.processState)')
    expect(source).toContain('<ServiceWindowNotice notice={viewportSyncNotice} />')
  })

  it('keeps unknown geometry visible without declaring the healthy Agent broken', () => {
    const result = classifyServiceNotice(terminalReplayGeometryOutcome(true, 'running'))
    expect(result).toMatchObject({ kind: 'process-degraded', notice: {
      step: expect.stringContaining('geometry'),
      mode: expect.stringContaining('remains available'),
      restore: expect.stringContaining('Resize the pane')
    } })
    expect(classifyServiceNotice(terminalReplayGeometryOutcome(false, 'running'))).toEqual({ kind: 'healthy' })
    expect(classifyServiceNotice(terminalReplayGeometryOutcome(true, 'interrupted')).kind).toBe('indeterminate')
  })
})

/**
 * 「按错的宽度排好的 replay 要补一次重绘」这条机制，判据锚点错过两次，所以这个文件专钉锚点，
 * 不重测 `terminal-viewport-sync.test.ts` 已经守着的其余行为。
 *
 * 错法一（b5209aa 发货的形状，审计实测）：锚在「第一次 live fit 这一次挪了 grid 吗」。
 * 而非 live 的 fit 也会挪 grid——`fitAndSynchronize` 里的 `fit()` 不看 `this.live`，只有
 * `requestResize` 被挡。于是调用方排在 attach 之前的那一帧，完全可以在 replay 字节写进解析器
 * **之后**、第一次 live fit **之前**把 grid 挪到终值；此后两端相等，判据答否，那一屏 80 列
 * 排好的 alt screen 永久留在屏上。
 *
 * 错法二（我修第一版时的形状，被本文件第三条用例当场打红）：锚在「synchronizer 建好之后挪过吗」。
 * xterm 一律以 80×24 构造、第一次 fit 必然挪，所以这个问法在每一格上恒真——等于无条件重绘，
 * 不再是判据，每个全新终端都白搭一对 resize。
 *
 * 现在锚在 `markReplayLanded()` 记下的那一刻，上面两条路径就都判对了。前两条用例只差
 * 「重放在 pre-fit 之前还是之后」，那一对就是判据的分界。
 *
 * 这个文件另开一份而不是加进 terminal-viewport-sync.test.ts：那个文件是多个并发方向的共享锚点。
 */

function frameHarness() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    request(callback: FrameRequestCallback) {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    },
    cancel(frameId: number) {
      callbacks.delete(frameId)
    },
    runNext() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!entry) return false
      callbacks.delete(entry[0])
      entry[1](0)
      return true
    }
  }
}

/**
 * 一个跟着 fit 走的假 xterm：`fit()` 把 actual 挪到 proposed，`readGrid()` 报 actual。
 * 与被测对象的关系就是真 xterm 与 FitAddon 的关系，没有别的耦合。
 */
function terminalHarness(initial: { cols: number; rows: number }, callbacks: {
  onResizeError?(error: unknown): void
  onResizeSuccess?(): void
} = {}) {
  const frames = frameHarness()
  let proposed = { ...initial }
  let actual = { ...initial }
  // xterm 还没量出 cell 尺寸（或实例已被拆掉）时读到的那种不成立的 grid。真 xterm 在这一刻
  // 报 0，而 0 不是一个「排版宽度」。
  let measurable = true
  const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
  const sync = new TerminalViewportSynchronizer({
    ...callbacks,
    proposeGrid: () => proposed,
    fit: () => {
      actual = { ...proposed }
    },
    readGrid: () => (measurable ? actual : { cols: 0, rows: 0 }),
    resize,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    // 像素跟着列/行走，好让抖动闸只在"像素真没变"时才介入（这里从不触发）。
    measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
  })
  return {
    sync,
    frames,
    resize,
    setProposed(next: { cols: number; rows: number }) {
      proposed = { ...next }
    },
    setMeasurable(next: boolean) {
      measurable = next
    },
    grid: () => actual
  }
}

/**
 * 把还在飞的 resize 链排空，直到调用次数不再增长。
 *
 * 这一步是承重的，不是礼节。`continueStableFit` 是 `void …catch(() => {})` 排出去的**浮动**
 * promise，起活之后的补重绘那一对 resize 就排在它里面。只 `waitFor` 到「resize 次数变多了」
 * 会在第一次 resize 刚落地时就返回，补重绘还没排出来——于是「只重绘一次」那条断言看不见第二次
 * 重绘，对着一个永不清 `awaitingFirstLiveFit` 的实现照旧全绿（实测存活，见那条用例的注释）。
 *
 * 每一轮既排空 microtask 也让出一次 macrotask。**只泵 microtask 是不够的，而且这不是风格问题**：
 * 删掉 `terminal-viewport-sync.ts` 里那句摘旗（`awaitingFirstLiveFit = false`，补救从一次性变成
 * 每次 live fit 都来一遍）时，只泵 microtask 的版本确实把它打红了；但在同一个变异上再往补重绘前面
 * 插一个 `await new Promise((r) => setTimeout(r, 0))`，同一条断言就 6 条全绿——同一个真缺陷，因为
 * 实现多了一跳定时器而彻底隐身。让出 macrotask 之后两种形状都红。
 *
 * 让出用 `setTimeout(0)`：`setImmediate` 的 check 阶段排在 timers 之前，所以等到一次 timer 回调
 * 就同时排空了这两类。本文件不用假定时器，代价是每轮多一次真让出——收敛条件是「次数稳住」，
 * 常见情况两轮就退出，不是 20 轮 × 一次让出。
 *
 * 按「次数稳住」收敛而不是数固定的 tick 数，免得实现里多一层 await 就让这个 helper 静默失效。
 */
async function settleResizes(resize: ReturnType<typeof vi.fn>): Promise<void> {
  let previous = -1
  for (let round = 0; round < 20 && previous !== resize.mock.calls.length; round += 1) {
    previous = resize.mock.calls.length
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * 数「补重绘」发生了几次。
 *
 * 判据取 `requestContentRedraw` 自己的签名：它先送**恰好差一格**的临时尺寸（rows-1，行不够时
 * cols-1），紧接着送回终值。所以只认「前一次是终值差一格、后一次是终值」这种相邻对。
 *
 * 别用宽一点的「前一次不是终值、后一次是终值」——那样连"第一次抵达终值"都算成一次重绘：起活后
 * 又改一次尺寸时，`132x45 → 100x30` 这对会被误判，于是"只重绘一次"那条用例会对着正确的实现打红。
 *
 * 代价是本文件的尺寸必须彼此差一格以上（现在最近的一对是 100x30 与 132x45），否则一次普通的
 * 单格 resize 会与重绘同形。这个前提由下面的断言各自钉住的终值保证。
 */
function redrawRoundTrips(
  resize: ReturnType<typeof vi.fn>,
  settled: { cols: number; rows: number }
): number {
  const calls = resize.mock.calls.map(([size]) => `${size.cols}x${size.rows}`)
  const settledKey = `${settled.cols}x${settled.rows}`
  const oneCellOff = new Set([
    `${settled.cols}x${settled.rows - 1}`,
    `${settled.cols - 1}x${settled.rows}`
  ])
  let trips = 0
  for (let index = 0; index + 1 < calls.length; index += 1) {
    if (oneCellOff.has(calls[index]) && calls[index + 1] === settledKey) trips += 1
  }
  return trips
}

describe('replay 之后的重排补救：判据锚在「重放那一刻的 grid」', () => {
  it('非 live 的 fit 排在重放之后时，起活仍要补一次重绘', async () => {
    // 事故路径：调用方在 attach 之前排了一帧（TerminalView 的 onRender / 首次 observeViewport
    // 都会），而它跑在 replay 字节之后。此时 grid 已被挪到终值。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    // 重放发生在 80 列上——xterm 就是以 80×24 构造的。
    harness.sync.markReplayLanded()

    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    // 非 live 的 fit 挪了 grid，但一个字节也没送到 PTY。
    expect(harness.grid()).toEqual({ cols: 132, rows: 45 })
    expect(harness.resize).not.toHaveBeenCalled()

    await harness.sync.startLiveSynchronization()

    // 此刻「这一次 fit 挪没挪」答否（两端都是 132×45），但重放那一屏是按 80 列排的。
    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      '非 live 的 fit 抢先挪了 grid，起活时就不补重绘了——按 80 列排好的 replay 会留在屏上。' +
        '判据要锚在重放那一刻的 grid，不是「第一次 live fit 这一次挪没挪」。'
    ).toBe(1)
    // 重绘收在终值上：几何的所有者仍是稳定尺寸那一方。
    expect(harness.resize.mock.calls.at(-1)?.[0]).toEqual({ cols: 132, rows: 45 })
  })

  it('非 live 的 fit 排在重放之前时不重绘：那一屏本来就是按对的宽度排的', async () => {
    // 与上一条同样有 pre-fit，只有「重放在 fit 之前还是之后」不同——这一对就是判据的分界。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    expect(harness.grid()).toEqual({ cols: 132, rows: 45 })

    // 重放此时才落地，已经是按 132 列排的。
    harness.sync.markReplayLanded()

    await harness.sync.startLiveSynchronization()

    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      '重放已经按终值宽度排好，重绘只是白花一次 PTY 往返与一次可见闪动。'
    ).toBe(0)
    // 不重绘不等于不同步：几何照样要送到 PTY。
    expect(harness.resize).toHaveBeenCalledWith({ cols: 132, rows: 45 })
  })

  it('没有重放过的全新终端不重绘：没有排错的那一屏', async () => {
    // 全新起的终端第一次 fit 同样从 80×24 挪到真尺寸，但它没有重放，屏上没有需要救的内容。
    // 「建好之后挪过吗」那种问法在这里恒真，会给每一格新终端都白搭一对 resize。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.setProposed({ cols: 120, rows: 40 })
    await harness.sync.startLiveSynchronization()
    expect(harness.frames.runNext()).toBe(true)
    // 这里留着 `vi.waitFor` 而不换成 `settleResizes`，是**测过之后**的决定，不是漏改。
    // 这一条要证的是「一次都没重绘」，`redrawRoundTrips` 数的是不该出现的那一对；只要等到几何真的
    // 送到了 PTY，此后再多等也只会等到更多机会去发现那一对，等不出更少。三个变异实测两种写法同红：
    // 抹掉判据本身（`!atReplay ||` → `atReplay &&`）、同一变异 + 补重绘前插三跳 microtask、
    // 同一变异 + 插一个 `setTimeout(0)`，都是 `2 failed | 4 passed`，且这一条都在红的那两条里。
    // 没找到「waitFor 下存活、settleResizes 下毙掉」的变异，所以换过去买不到判据强度。
    // 下面那两处用 `settleResizes` 是因为它们要证的是**上界**（恰好一次 / 恰好零次，而链子还在飞），
    // 那种断言会被「排空得不够」直接读成通过——见 settleResizes 自己的说明。
    await vi.waitFor(() => expect(harness.resize).toHaveBeenCalledWith({ cols: 120, rows: 40 }))

    expect(
      redrawRoundTrips(harness.resize, { cols: 120, rows: 40 }),
      '没重放过就没有按错宽度排的那一屏；这里重绘是纯粹的多余闪动。'
    ).toBe(0)
  })

  it('只重绘一次：起活后继续挪 grid 不再触发补救', async () => {
    // 补救是一次性的。起活之后的 resize 都是真尺寸变化，会自己发 SIGWINCH，TUI 有重画的理由。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    await harness.sync.startLiveSynchronization()
    // 先确认这一格真的走过一次补救，否则下面的 0 是空的。
    expect(redrawRoundTrips(harness.resize, { cols: 132, rows: 45 })).toBe(1)
    const afterStart = harness.resize.mock.calls.length

    harness.setProposed({ cols: 100, rows: 30 })
    harness.sync.observeViewport()
    // 起活的 finally 已经排了一帧，所以这次 observeViewport 是空操作（frameId 非空即返回），
    // 而那一帧记下的上一个提案是 132×45。稳定闸要两帧提案一致才肯 fit，于是这里必须跑两帧。
    // 别把第二帧省掉：只跑一帧时 resize 一次都不发，会读成「起活后不再同步」的反向结论。
    expect(harness.frames.runNext()).toBe(true)
    expect(harness.resize.mock.calls.length, '第一帧只是记下新提案，稳定闸还没放行').toBe(afterStart)
    expect(harness.frames.runNext()).toBe(true)
    // 必须排空整条链，不能只等到「次数变多了」：补重绘那一对排在浮动 promise 里，会比第一次
    // resize 晚落地。只等第一次的话，一个永不清 `awaitingFirstLiveFit` 的实现（每次 live fit
    // 都补一次重绘）会在断言读到它之前躲开，于是下面的 0 恒真——实测正是这样存活的。
    await settleResizes(harness.resize)
    expect(
      harness.resize.mock.calls.length,
      '起活后的这次几何变化根本没送到 PTY，下面的 0 会是空的'
    ).toBeGreaterThan(afterStart)

    expect(
      redrawRoundTrips(harness.resize, { cols: 100, rows: 30 }),
      '起活之后的每次 resize 都是真尺寸变化，会自己发出 SIGWINCH；再补重绘就是多余的闪动。'
    ).toBe(0)
  })

  it('markReplayLanded 只认第一次：实时输出不是"重放的那一屏"', async () => {
    // 幂等性有承重意义：若后续调用能覆盖锚点，一次实时输出就会把锚点刷成当前 grid，
    // 判据当场退化成恒等，补救永久关闭。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    // 第二次调用发生在 grid 已经挪走之后——若它生效，锚点会变成 132×45，判据即失效。
    harness.sync.markReplayLanded()

    await harness.sync.startLiveSynchronization()

    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      'markReplayLanded 不幂等的话，任何一次后续调用都会把锚点刷成当前 grid，补救永久失效。'
    ).toBe(1)
  })

  it('grid 还量不出来时不落锚点：0×0 不是「重放那一屏的宽度」', async () => {
    // 调用点排在写完 replay 之后，而那一刻 xterm 可能还没量出 cell 尺寸（隐藏的容器、字体
    // 未就绪），`terminal.cols/rows` 报 0。把 0×0 记成锚点的后果是**永久**的：`markReplayLanded`
    // 只认第一次，于是真正的重放宽度再也记不进去，而 0×0 与任何真 grid 都不相等——补救从
    // 「按需」退化成「每一格都无条件重绘」，把这个判据存在的理由整个抹掉。
    //
    // 判据取「重绘发生了几次」而不是读私有锚点：0×0 被拒时锚点留 null，与全新终端同形（不重绘）；
    // 若被接受则每次都判不等（重绘一次）。两种世界在这个观察量上分得开。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.setMeasurable(false)
    harness.sync.markReplayLanded()
    harness.setMeasurable(true)

    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    await harness.sync.startLiveSynchronization()
    await settleResizes(harness.resize)

    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      '0×0 被当成锚点时，它与任何真 grid 都不等 ⇒ 每一格都补一次重绘，' +
        '而真正的重放宽度因为「只认第一次」再也记不进来。'
    ).toBe(0)
    // 不落锚点不等于不同步：几何照样要送到 PTY。
    expect(harness.resize).toHaveBeenCalledWith({ cols: 132, rows: 45 })
  })
})
