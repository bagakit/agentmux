import { describe, expect, it, vi } from 'vitest'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'

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
    },
    count: () => callbacks.size
  }
}

describe('TerminalViewportSynchronizer', () => {
  it('waits for measurable xterm cell metrics instead of synchronizing the default 80x24 grid', async () => {
    const frames = frameHarness()
    let measurable = false
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => measurable ? { cols: 132, rows: 50 } : null,
      fit: () => {},
      readGrid: () => ({ cols: measurable ? 132 : 80, rows: measurable ? 50 : 24 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: measurable ? 1320 : 800, height: measurable ? 1000 : 480 })
    })

    await sync.startLiveSynchronization()
    expect(resize).not.toHaveBeenCalled()

    measurable = true
    expect(frames.runNext()).toBe(true)
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ cols: 132, rows: 50 }))
  })

  it('fits before attach but only synchronizes the PTY after live output is ready', async () => {
    const frames = frameHarness()
    let proposed = { cols: 80, rows: 24 }
    let actual = { cols: 80, rows: 24 }
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => { actual = { ...proposed } },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    proposed = { cols: 132, rows: 45 }
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    expect(resize).not.toHaveBeenCalled()

    await sync.startLiveSynchronization()
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenLastCalledWith({ cols: 132, rows: 45 })

    expect(frames.runNext()).toBe(true)
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))
  })

  it('fits a replay-only historical Run without sending a PTY resize', async () => {
    const frames = frameHarness()
    let actual = { cols: 80, rows: 24 }
    const fit = vi.fn(() => { actual = { cols: 120, rows: 40 } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 120, rows: 40 }),
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1200, height: 800 })
    })

    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()
  })

  it('redraws a live TUI after replay loss by restoring the exact settled grid', async () => {
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 120, rows: 40 }),
      fit: () => {},
      readGrid: () => ({ cols: 120, rows: 40 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1200, height: 800 })
    })

    await sync.startLiveSynchronization()
    resize.mockClear()

    await expect(sync.requestContentRedraw()).resolves.toBe(true)
    expect(resize.mock.calls.map(([size]) => size)).toEqual([
      { cols: 120, rows: 39 },
      { cols: 120, rows: 40 }
    ])
  })

  /**
   * #585「重启后终端经常乱码，放大缩小一下就好」。
   *
   * 重启恢复的顺序是：新建 xterm（构造尺寸 80×24）→ 写入 replay 字节 → 收尾同步里做第一次
   * 确定性 fit。于是那一屏是按 80 列排好的，而 fit 之后 grid 变成真尺寸。xterm 只对**有
   * scrollback 的正常缓冲区**重排（`_isReflowEnabled` 要求 `_hasScrollback`，见 @xterm/xterm
   * 5.5.0），alt screen——Codex 的 diff、vim、htop、lazygit——只逐行补齐/截断，所以那一屏就永久
   * 花在那里。而 daemon 保留的 PTY 尺寸通常与恢复出的布局尺寸**相同**，同尺寸的 TIOCSWINSZ
   * 不产生 SIGWINCH，TUI 永远收不到重画的理由。用户放大缩小能治，是因为 zoom 真的改了 CSS
   * 像素，于是既 fit 又发出一次真的尺寸变化。
   *
   * 所以判据是「第一次 live fit 挪了 grid」——这件事只有 synchronizer 知道（调用方手上只有
   * `gap`，而完整重放的 gap 是 false，此前正是那条路一次重绘都不做）。判据不能是「PTY 尺寸变了
   * 没有」：渲染层不持有 PTY 改动前的尺寸，`resize` 的返回值只说送到没送到。
   */
  it('第一次 live fit 挪了 grid 时补一次重绘：按 80 列排好的 replay 不会自己重排', async () => {
    const frames = frameHarness()
    // 新建的 xterm 就是 80×24，容器其实是 120×40——重启恢复的必然形状。
    let actual = { cols: 80, rows: 24 }
    const fit = vi.fn(() => { actual = { cols: 120, rows: 40 } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 120, rows: 40 }),
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1200, height: 800 })
    })

    await sync.startLiveSynchronization()

    // 先是最终几何，然后是那一对「差一行再回来」的强制重绘——与 gap 路径同一招。
    expect(
      resize.mock.calls.map(([size]) => size),
      '第一次 live fit 从 80 列挪到 120 列，说明刚重放的那一屏是按错的宽度排的：必须补一次重绘'
    ).toEqual([
      { cols: 120, rows: 40 },
      { cols: 120, rows: 39 },
      { cols: 120, rows: 40 }
    ])
    expect(fit).toHaveBeenCalledTimes(1)

    // 一次性：此后的每次真 resize 本身就会发出 SIGWINCH，再补重绘等于每次拖动都闪一下。
    resize.mockClear()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(resize.mock.calls.map(([size]) => size), '几何已稳定，不该再有任何 resize').toEqual([])
  })

  // 成对的另一半。没有它，上面那条可以被「每次 live 起活都无条件重绘」满足——那会让每个正常
  // 开启的终端都多做一对 resize，也就把「挪了 grid」这个判据整个丢掉。
  it('第一次 live fit 没挪 grid 时不重绘：那一屏本来就是按对的宽度排的', async () => {
    const frames = frameHarness()
    // xterm 已经量到了真尺寸（例如同一实例切回来，或 fit 早于 replay 完成）。
    const grid = { cols: 120, rows: 40 }
    const fit = vi.fn()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ ...grid }),
      fit,
      readGrid: () => ({ ...grid }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1200, height: 800 })
    })

    await sync.startLiveSynchronization()

    expect(resize.mock.calls.map(([size]) => size)).toEqual([{ cols: 120, rows: 40 }])
    expect(fit).not.toHaveBeenCalled()
  })

  /**
   * 抖动基线由「这次 fit」建立，而不是由「这次 resize」建立。
   *
   * 这两件事在 `fitAndSynchronize` 里只差一个 `if (!this.live) return`，而 replay 阶段的 fit
   * 恰好全部落在非 live 的那一侧——重启恢复时先 fit 再起活。所以如果把基线记账挪到 live 闸之后，
   * 基线在整个 replay 阶段都是 null，于是紧随其后的第一次 cell-metric 抖动（像素一模一样、
   * proposal 差一列）会被当成真 resize 去 fit：xterm reflow 一列再弹回，把刚画好的 TUI 画花。
   * 那正是 wobble gate 存在的理由，也正是 #585 要修的那种花屏。
   *
   * 有 review 意见建议把那行挪到 live 闸下面（理由是「非 live 的测量不该 latch 基线」）。实测
   * 挪过去 21 条全绿——也就是说这个顺序此前完全无人守。这条用例就是那个判据：它必须在挪动后变红。
   */
  it('replay 阶段的 fit 也要留下抖动基线，否则起活后第一次 cell-metric 抖动就会把 TUI 画花', async () => {
    const frames = frameHarness()
    const pixels = { width: 1200, height: 800 }
    let proposed = { cols: 120, rows: 40 }
    let actual = { cols: 80, rows: 24 }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ ...pixels })
    })

    // 还没起活（replay 正在写入）：fit 一次把 xterm 对齐到容器，但一个字节都不该发给 PTY。
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()
    expect(fit).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()

    // cell-metric 抖动：像素一模一样，proposal 差一列。基线若没在上面那次 fit 时记下，
    // 这里就会再 fit 一次。
    fit.mockClear()
    proposed = { cols: 121, rows: 40 }
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()

    expect(
      fit,
      '像素没变却又 fit 了一次：replay 阶段的 fit 没有留下基线，抖动闸在这条路上是空的'
    ).not.toHaveBeenCalled()
  })

  it('does not redraw a historical Run or race an interactive resize', async () => {
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 120, rows: 40 }),
      fit: () => {},
      readGrid: () => ({ cols: 120, rows: 40 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1200, height: 800 })
    })

    await expect(sync.requestContentRedraw()).resolves.toBe(false)
    await sync.startLiveSynchronization()
    resize.mockClear()
    sync.setInteractiveResize(true)
    await expect(sync.requestContentRedraw()).resolves.toBe(false)
    expect(resize).not.toHaveBeenCalled()
  })

  it('does not resize a live PTY while its viewport is not measurable', async () => {
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => null,
      fit: () => {},
      readGrid: () => ({ cols: 80, rows: 24 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 800, height: 480 })
    })

    await sync.startLiveSynchronization()
    await expect(sync.requestContentRedraw()).resolves.toBe(false)
    expect(resize).not.toHaveBeenCalled()
  })

  it('coalesces viewport observations and forwards the latest settled grid', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => { actual = { ...proposed } },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))

    proposed = { cols: 148, rows: 57 }
    sync.observeViewport()
    sync.observeViewport()
    expect(frames.count()).toBe(1)
    frames.runNext()

    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2))
    expect(resize).toHaveBeenLastCalledWith({ cols: 148, rows: 57 })
  })

  it('cancels a pending settled fit when the terminal view is disposed', () => {
    const frames = frameHarness()
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => ({ cols: 80, rows: 24 }),
      fit: vi.fn(() => true),
      readGrid: () => ({ cols: 80, rows: 24 }),
      resize: async () => true,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 800, height: 480 })
    })

    sync.observeViewport()
    expect(frames.count()).toBe(1)
    sync.dispose()
    expect(frames.count()).toBe(0)
  })

  it('waits for a stable proposed grid before fitting a drag-driven resize', async () => {
    const frames = frameHarness()
    const proposals = [
      { cols: 100, rows: 30 },
      { cols: 101, rows: 30 },
      { cols: 102, rows: 30 },
      { cols: 102, rows: 30 }
    ]
    let proposed = proposals.shift()!
    let actual = { cols: 100, rows: 30 }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => {
        proposed = proposals.shift() ?? proposed
        return proposed
      },
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    expect(fit).not.toHaveBeenCalled()
    expect(frames.runNext()).toBe(true)
    expect(fit).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()
  })

  it('replaces queued intermediate PTY sizes with the latest settled grid', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    let releaseFirstResize = () => {}
    const firstResizePending = new Promise<void>((resolve) => { releaseFirstResize = resolve })
    const resize = vi.fn()
      .mockImplementationOnce(async () => { await firstResizePending; return true })
      .mockResolvedValue(true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => { actual = { ...proposed } },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    const started = sync.startLiveSynchronization()
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 }))

    proposed = { cols: 110, rows: 30 }
    sync.observeViewport()
    frames.runNext()
    proposed = { cols: 120, rows: 30 }
    sync.observeViewport()
    frames.runNext()

    releaseFirstResize()
    await started
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2))
    expect(resize).toHaveBeenLastCalledWith({ cols: 120, rows: 30 })
  })

  it('drops queued viewport work when the owning Terminal View is disposed', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    let releaseResize!: () => void
    const resizePending = new Promise<void>((resolve) => { releaseResize = resolve })
    const resize = vi.fn(async () => { await resizePending; return true })
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => { actual = { ...proposed } },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    const started = sync.startLiveSynchronization()
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 }))
    proposed = { cols: 120, rows: 40 }
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    sync.dispose()

    releaseResize()
    await started
    expect(resize).toHaveBeenCalledTimes(1)
  })

  it('freezes xterm reflow during an interactive split drag and synchronizes only the final grid', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalled())
    fit.mockClear()
    resize.mockClear()

    sync.setInteractiveResize(true)
    proposed = { cols: 110, rows: 30 }
    sync.observeViewport()
    proposed = { cols: 120, rows: 30 }
    sync.observeViewport()

    expect(frames.count()).toBe(0)
    expect(fit).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()

    sync.setInteractiveResize(false)
    expect(frames.count()).toBe(1)
    expect(frames.runNext()).toBe(true)

    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))
    expect(fit).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith({ cols: 120, rows: 30 })
  })

  it('skips a one-column grid wobble when container pixels have not changed', async () => {
    const frames = frameHarness()
    // 拖拽已停：像素固定，但 WebGL/DOM cell-metric 抖动让 proposeDimensions 从 120
    // 跳到 121。只有真实像素变化才应触发 fit，否则 reflow 会把 TUI 画花。
    const pixels = { width: 1200, height: 800 }
    let proposed = { cols: 120, rows: 40 }
    let actual = { cols: 120, rows: 40 }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ ...pixels })
    })

    // 首次 live 同步：像素基线被记录，grid 与 xterm 一致，无需 fit。
    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ cols: 120, rows: 40 }))
    const callsAfterBaseline = resize.mock.calls.length
    expect(fit).not.toHaveBeenCalled()

    // cell-metric 抖动：proposal 差一列，但像素完全没变 → 跳过 fit 与 resize。
    proposed = { cols: 121, rows: 40 }
    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(fit).not.toHaveBeenCalled()
    expect(resize).toHaveBeenCalledTimes(callsAfterBaseline)
  })

  it('fits and resizes when container pixels actually change', async () => {
    const frames = frameHarness()
    const pixels = { width: 1200, height: 800 }
    let proposed = { cols: 120, rows: 40 }
    let actual = { ...proposed }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ ...pixels })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))
    expect(resize).toHaveBeenLastCalledWith({ cols: 120, rows: 40 })

    // 真实 resize：像素与 grid 同时变化 → fit + PTY resize。
    pixels.width = 1400
    proposed = { cols: 140, rows: 40 }
    sync.observeViewport()
    frames.runNext()

    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2))
    expect(resize).toHaveBeenLastCalledWith({ cols: 140, rows: 40 })
    expect(fit).toHaveBeenCalled()
  })
  /**
   * 隐藏的终端一律停工。
   *
   * 保住实例（不卸载）才能让切回不重放，但代价必须为零：一个看不见的终端如果还在 fit /
   * resize / 排帧，开十个 Tab 就是十份持续开销，那是拿一种卡顿换另一种。这类退化不会让
   * 任何既有测试变红，所以必须显式断言。
   */
  it('一个看不见的终端不排帧、不 fit、不 resize', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalled())
    fit.mockClear()
    resize.mockClear()

    sync.setVisible(false)
    // 窗口在它隐藏期间被拉大过好几次——它一次都不该动。
    proposed = { cols: 140, rows: 30 }
    sync.observeViewport()
    proposed = { cols: 160, rows: 44 }
    sync.observeViewport()

    expect(frames.count()).toBe(0)
    expect(fit).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()
  })

  it('切回时一次性追上隐藏期间错过的几何，而不是逐次补做', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalled())
    fit.mockClear()
    resize.mockClear()

    sync.setVisible(false)
    proposed = { cols: 140, rows: 30 }
    sync.observeViewport()
    proposed = { cols: 160, rows: 44 }
    sync.observeViewport()

    sync.setVisible(true)
    expect(frames.count()).toBe(1)
    expect(frames.runNext()).toBe(true)

    // 中间那个 140x30 从未发生过——只同步最终几何一次。
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))
    expect(resize).toHaveBeenCalledWith({ cols: 160, rows: 44 })
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('隐藏与拖拽是两个独立原因：松手时若仍不可见，就仍然不动', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const fit = vi.fn(() => { actual = { ...proposed } })
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit,
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    await sync.startLiveSynchronization()
    frames.runNext()
    await vi.waitFor(() => expect(resize).toHaveBeenCalled())
    fit.mockClear()
    resize.mockClear()

    // 拖动分隔条的同时切走了这张 Tab：两个原因叠加。
    sync.setInteractiveResize(true)
    sync.setVisible(false)
    proposed = { cols: 150, rows: 40 }
    sync.observeViewport()

    // 松手了，但它仍然看不见——一个布尔的实现会在这里恢复同步。
    sync.setInteractiveResize(false)
    expect(frames.count()).toBe(0)
    expect(fit).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()

    // 真正切回来时才动，且只动一次。
    sync.setVisible(true)
    expect(frames.count()).toBe(1)
    expect(frames.runNext()).toBe(true)
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(1))
    expect(resize).toHaveBeenCalledWith({ cols: 150, rows: 40 })
  })

  it('看不见时不接受重绘请求——重放缺口的补画等切回来再说', async () => {
    const frames = frameHarness()
    const proposed = { cols: 100, rows: 30 }
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => {},
      readGrid: () => proposed,
      resize: async () => true,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: 1000, height: 600 })
    })

    await sync.startLiveSynchronization()
    sync.setVisible(false)
    expect(await sync.requestContentRedraw()).toBe(false)
  })

  // 被调用方的闸挡掉的 resize 不许记成「PTY 已经在这个几何上」。
  //
  // 这是 #501 的形状，也是这个返回值存在的唯一理由。TerminalView 的 resize 实现前面有一道闸
  // （进程死了就不再往 PTY 发），而 attach effect 刻意不依赖那道闸的取值——退出再恢复要保住同一个
  // xterm 实例。于是「闸关着的时候来了一次 resize」是正常且可达的：ResizeObserver 不认识进程状态。
  //
  // 判据落在**闸重新打开之后**：几何没有再变（用户不会为了修好它再拖一次窗口），所以只有当那次被挡掉
  // 的请求没有留下记账，requestResize 的相同-key 短路才不会把它吞掉。若把 no-op 记成成功，PTY 永远
  // 停在 100 列而 xterm 已经是 140 列，直到用户恰好拖到另一个尺寸——这正是变异（删掉那行记账回滚）
  // 时本条唯一变红、而上面 18 条全绿的原因。
  it('does not record a gated-out resize as the PTY geometry, so a reopened gate still catches up', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    // 调用方自己的闸，形如 TerminalView 的 canControlRunRef：进程活着 true，退出后 false。
    let ptyAcceptsResize = true
    const delivered: Array<{ cols: number; rows: number }> = []
    const sync = new TerminalViewportSynchronizer({
      proposeGrid: () => proposed,
      fit: () => { actual = { ...proposed } },
      readGrid: () => actual,
      resize: async (size) => {
        if (!ptyAcceptsResize) return false
        delivered.push(size)
        return true
      },
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
    })

    // 帧调度要跑到静止：synchronizer 会为「稳定几何」连排多帧，只推一帧就断言等于在半路上取值。
    const settleFrames = async () => {
      for (let index = 0; index < 20 && frames.count() > 0; index += 1) {
        frames.runNext()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    await sync.startLiveSynchronization()
    await vi.waitFor(() => expect(delivered).toEqual([{ cols: 100, rows: 30 }]))

    // 进程退出：闸关上，但同一个 xterm 还在，容器尺寸变化照旧被观察到。
    ptyAcceptsResize = false
    proposed = { cols: 140, rows: 30 }
    sync.observeViewport()
    await settleFrames()
    expect(delivered, '进程已死时不该向 PTY 发 resize').toEqual([{ cols: 100, rows: 30 }])

    // 恢复：闸重新打开，几何与被挡掉那次完全相同。
    ptyAcceptsResize = true
    sync.observeViewport()
    await settleFrames()

    expect(delivered.at(-1), 'PTY 停在 100 列而 xterm 已是 140 列：被挡掉的 resize 被记成了成功')
      .toEqual({ cols: 140, rows: 30 })
  })
})
