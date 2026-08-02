export type TerminalGridSize = {
  cols: number
  rows: number
}

export type TerminalViewportPixels = {
  width: number
  height: number
}

type TerminalViewportSynchronizerOptions = {
  proposeGrid(): TerminalGridSize | null
  fit(): void
  readGrid(): TerminalGridSize
  /**
   * 把这个几何送到 PTY。返回 false = **没送到**（调用方自己的闸把这次 resize 挡掉了，
   * 例如进程已死时不该再向 PTY 发 resize）。
   *
   * 这个返回值不是可选的礼貌信息，而是承重的：synchronizer 用「最后一次请求的几何」
   * 给相同尺寸的重复请求短路，所以一次被挡掉的 resize 若被记成成功，它就会以为 PTY
   * 已经在那个几何上，而 PTY 其实停在改动前——此后同一尺寸的观察全被短路，xterm 与
   * PTY 永久错位，直到用户恰好拖到**另一个**尺寸。返回 false 让这次请求不留痕，闸重新
   * 打开后同一几何的下一次观察才能真正送达。
   */
  resize(size: TerminalGridSize): Promise<boolean>
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(frameId: number): void
  onResizeError?(error: unknown): void
  /**
   * 容器的 CSS 像素几何。synchronizer 只在像素真的变化时 fit：
   * proposeDimensions 差一列但像素未变，是 WebGL/DOM cell-metric 的瞬时抖动，
   * fit 会让 xterm reflow 一列再弹回、把 Codex 等 diff 绘制的 TUI 画花。
   */
  measureViewport(): TerminalViewportPixels
}

const MAX_STABILITY_FRAMES = 8

function gridKey(size: TerminalGridSize): string {
  return `${size.cols}x${size.rows}`
}

function isUsableGrid(size: TerminalGridSize): boolean {
  return Number.isInteger(size.cols) && size.cols > 0 && Number.isInteger(size.rows) && size.rows > 0
}

// 子像素抖动（devicePixelRatio 舍入、滚动条出现/消失的亚像素）不应被当成真 resize；
// 差异小于 1 CSS 像素时视为同一几何。
function samePixels(a: TerminalViewportPixels, b: TerminalViewportPixels): boolean {
  return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

/** Keeps the xterm grid and the retained PTY on one settled viewport size. */
export class TerminalViewportSynchronizer {
  private live = false
  private disposed = false
  private frameId: number | null = null
  private previousProposedGrid: TerminalGridSize | null = null
  private stabilityFrames = 0
  private lastRequestedGrid: string | null = null
  private pendingResize: TerminalGridSize | null = null
  private resizeDrain: Promise<void> | null = null
  private lastFittedPixels: TerminalViewportPixels | null = null
  private readonly suspendReasons = new Set<'interactive-resize' | 'hidden'>()
  private observedWhileSuspended = false

  constructor(private readonly options: TerminalViewportSynchronizerOptions) {}

  observeViewport(): void {
    if (this.disposed) return
    if (this.suspended) {
      this.observedWhileSuspended = true
      return
    }
    if (this.frameId !== null) return
    const proposed = this.options.proposeGrid()
    this.previousProposedGrid = proposed && isUsableGrid(proposed) ? proposed : null
    this.stabilityFrames = 0
    this.requestStabilityFrame()
  }

  setInteractiveResize(active: boolean): void {
    this.setSuspended('interactive-resize', active)
  }

  /**
   * 这一格现在看不看得见。
   *
   * 不可见的终端一律停工：隐藏的 Tab 仍留在 DOM 里（保住 xterm 实例，切回才不必重放），
   * 但它不该继续 fit / resize / 渲染——保住实例的前提是它闲着不花钱，否则开十个 Tab
   * 就是十份持续开销。切回时补一次 observe，把隐藏期间错过的几何变化一次性追上。
   */
  setVisible(visible: boolean): void {
    this.setSuspended('hidden', !visible)
  }

  /**
   * 暂停 viewport 同步，按原因记账。
   *
   * 拖拽 resize 与"这一格被隐藏"是两个独立原因，可以同时成立：拖动分隔条时切走 Tab，
   * 松手若无条件恢复同步，一个看不见的终端就会开始 fit。所以记的是原因集合而非一个布尔，
   * 只有全部原因都消失才恢复，并补一次 observe——挂起期间到达的观察不能就这么丢掉，
   * 否则切回时行列数还停在隐藏前的几何上。
   */
  private setSuspended(reason: 'interactive-resize' | 'hidden', active: boolean): void {
    if (this.disposed) return
    const had = this.suspended
    if (active) this.suspendReasons.add(reason)
    else this.suspendReasons.delete(reason)
    if (this.suspended === had) return
    if (this.suspended) {
      this.observedWhileSuspended = true
      if (this.frameId !== null) this.options.cancelFrame(this.frameId)
      this.frameId = null
      this.previousProposedGrid = null
      this.stabilityFrames = 0
      return
    }
    if (!this.observedWhileSuspended) return
    this.observedWhileSuspended = false
    this.observeViewport()
  }

  private get suspended(): boolean {
    return this.suspendReasons.size > 0
  }

  private requestStabilityFrame(): void {
    this.frameId = this.options.requestFrame(() => {
      this.frameId = null
      void this.continueStableFit().catch(() => {})
    })
  }

  async startLiveSynchronization(): Promise<void> {
    if (this.disposed || this.live) return
    this.live = true
    this.lastRequestedGrid = null
    try {
      await this.fitAndSynchronize()
    } catch (error) {
      this.live = false
      throw error
    } finally {
      // Font metrics and pane layout may settle after the attach continuation.
      this.observeViewport()
    }
  }

  /**
   * Asks a live terminal application to repaint after bounded replay lost the
   * byte prefix needed to reconstruct its screen. The xterm grid stays on the
   * settled size while the PTY briefly moves by one cell and returns, so this
   * path changes no input or Run identity and finishes on the authoritative
   * viewport size.
   */
  async requestContentRedraw(): Promise<boolean> {
    if (this.disposed || !this.live || this.suspended) return false
    const proposed = this.options.proposeGrid()
    if (!proposed || !isUsableGrid(proposed)) return false
    const size = this.options.readGrid()
    if (!isUsableGrid(size)) return false
    const temporary = size.rows > 1
      ? { cols: size.cols, rows: size.rows - 1 }
      : size.cols > 1
        ? { cols: size.cols - 1, rows: size.rows }
        : null
    if (!temporary) return false
    try {
      await this.requestResize(temporary)
      await this.requestResize(size)
      return true
    } catch (error) {
      // A failed return-to-final resize must re-enter the normal settled-size
      // owner instead of leaving PTY and xterm geometry divergent.
      this.observeViewport()
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameId !== null) this.options.cancelFrame(this.frameId)
    this.frameId = null
    this.previousProposedGrid = null
    this.pendingResize = null
    this.observedWhileSuspended = false
  }

  private async continueStableFit(): Promise<void> {
    if (this.disposed) return
    if (this.suspended) {
      this.observedWhileSuspended = true
      return
    }
    const proposed = this.options.proposeGrid()
    if (!proposed || !isUsableGrid(proposed)) {
      this.previousProposedGrid = null
      return
    }

    this.stabilityFrames += 1
    const current = this.options.readGrid()
    const stable = gridKey(proposed) === gridKey(this.previousProposedGrid ?? proposed)
    if (
      gridKey(current) === gridKey(proposed) ||
      stable ||
      this.stabilityFrames >= MAX_STABILITY_FRAMES
    ) {
      this.previousProposedGrid = null
      await this.fitAndSynchronize(proposed)
      return
    }

    this.previousProposedGrid = proposed
    this.requestStabilityFrame()
  }

  private async fitAndSynchronize(proposed = this.options.proposeGrid()): Promise<void> {
    if (this.disposed || !proposed || !isUsableGrid(proposed)) return
    if (this.suspended) {
      this.observedWhileSuspended = true
      return
    }

    const current = this.options.readGrid()
    const gridDiverged = gridKey(current) !== gridKey(proposed)
    const pixels = this.options.measureViewport()

    // Wobble gate: xterm 已经等于 proposal 时本来就不 fit；但当 grid 差一列而容器
    // CSS 像素相对上次成功 fit 没变，这是 WebGL/DOM cell-metric 的瞬时抖动，不是真
    // resize。fit 会让 xterm reflow 一列再弹回，把 Codex 等 diff 绘制的 TUI 画花。
    // 直接跳过——像素没变，PTY 尺寸也无需变。
    if (gridDiverged && this.lastFittedPixels && samePixels(pixels, this.lastFittedPixels)) {
      return
    }

    if (gridDiverged) this.options.fit()
    // 记录本次 fit 决策所依据的像素，作为后续抖动判定的基线。存副本，避免调用方
    // 复用同一可变对象时把基线一起改掉（getBoundingClientRect 每次新建，但契约不保证）。
    this.lastFittedPixels = { width: pixels.width, height: pixels.height }

    const size = this.options.readGrid()
    if (!isUsableGrid(size)) return
    if (!this.live) return

    await this.requestResize(size)
  }

  private async requestResize(size: TerminalGridSize): Promise<void> {
    const key = gridKey(size)
    if (key === this.lastRequestedGrid) {
      await this.resizeDrain
      return
    }
    this.lastRequestedGrid = key
    this.pendingResize = size

    if (!this.resizeDrain) {
      const drain = this.drainPendingResizes()
      this.resizeDrain = drain
      void drain.finally(() => {
        if (this.resizeDrain === drain) this.resizeDrain = null
      }).catch(() => {})
    }
    await this.resizeDrain
  }

  private async drainPendingResizes(): Promise<void> {
    while (!this.disposed && this.pendingResize) {
      const size = this.pendingResize
      this.pendingResize = null
      try {
        const delivered = await this.options.resize(size)
        // 被调用方的闸挡掉时，抹掉「已请求过这个几何」的记账。否则闸重新打开后，同一
        // 几何的观察会被 requestResize 的相同-key 短路吞掉，PTY 永远追不上 xterm。
        // 与下面 catch 的处理一致：两者都是「这个几何没到 PTY」，只是一个安静一个响亮。
        if (!delivered) this.lastRequestedGrid = null
      } catch (error) {
        this.pendingResize = null
        this.lastRequestedGrid = null
        this.options.onResizeError?.(error)
        throw error
      }
    }
  }
}
