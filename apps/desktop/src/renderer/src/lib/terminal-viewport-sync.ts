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
  applyOwnerGrid?(size: TerminalGridSize): void
  readGrid(): TerminalGridSize
  /**
   * Deliver this grid to the PTY.
   *
   * - `false`: not delivered; the requested size must not be remembered as applied.
   * - `true`: delivered at the requested size.
   * - `{ cols, rows }`: delivered at the owner-confirmed applied size, which may
   *   differ from the UI proposal.
   *
   * 这个返回值不是可选的礼貌信息，而是承重的：synchronizer 用「最后一次请求的几何」
   * 给相同尺寸的重复请求短路，所以一次被挡掉的 resize 若被记成成功，它就会以为 PTY
   * 已经在那个几何上，而 PTY 其实停在改动前。返回 false 让这次请求不留痕。
   */
  resize(size: TerminalGridSize): Promise<boolean | TerminalGridSize>
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(frameId: number): void
  onResizeError?(error: unknown): void
  onResizeSuccess?(): void
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
  private readonly suspendReasons = new Set<'interactive-resize' | 'hidden' | 'replay'>()
  private observedWhileSuspended = false
  private awaitingFirstLiveFit = false
  /** Parser grid held for the entire replay, used to decide whether live content needs repainting. */
  private gridWhenReplayLanded: TerminalGridSize | null = null

  constructor(private readonly options: TerminalViewportSynchronizerOptions) {}

  /** Apply an ordered owner fact without competing with another View for PTY geometry. */
  acceptOwnerSize(size: TerminalGridSize): void {
    if (this.disposed || !isUsableGrid(size)) return
    this.options.applyOwnerGrid?.(size)
    this.lastRequestedGrid = gridKey(size)
  }

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

  /** Replay owns parser geometry until its last asynchronous write has landed. */
  beginReplay(): void {
    this.lastFittedPixels = null
    this.setSuspended('replay', true)
  }

  endReplay(hasReplay: boolean): void {
    if (hasReplay) this.markReplayLanded()
    this.setSuspended('replay', false)
  }

  /**
   * 这一格现在看不看得见。
   *
   * 不可见的终端一律停工：隐藏的 Tab 仍留在 DOM 里（保住 xterm 实例，切回才不必重放），
   * 但它不该继续 fit / resize / 渲染——保住实例的前提是它闲着不花钱，否则开十个 Tab
   * 就是十份持续开销。切回时补一次 observe，把隐藏期间错过的几何变化一次性追上。
   */
  setVisible(visible: boolean): void {
    if (visible && this.suspendReasons.has('hidden')) this.lastFittedPixels = null
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
  private setSuspended(reason: 'interactive-resize' | 'hidden' | 'replay', active: boolean): void {
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

  /**
   * 重放字节已经写进解析器了——记下此刻的 grid。
   *
   * 调用方在写完 replay、起活之前调一次。不调的后果是明确的：`gridWhenReplayLanded` 保持
   * `null`，起活时不会补重绘。对**没有**重放的一格（全新终端）这正是对的；对有重放的一格，
   * 漏调就等于把这套补救关掉，所以调用点与写 replay 的那段代码必须挨着。
   *
   * 幂等：只认第一次。一格终端只有一次「重放的那一屏」，后续的实时输出是另一回事。
   */
  markReplayLanded(): void {
    if (this.disposed || this.gridWhenReplayLanded) return
    const size = this.options.readGrid()
    if (!isUsableGrid(size)) return
    this.gridWhenReplayLanded = { cols: size.cols, rows: size.rows }
  }

  /**
   * Reconcile the visible viewport after replay releases its geometry lock.
   * Alt-screen contents do not reflow when xterm changes size. If the settled grid differs from
   * the replay grid, request one repaint even when the retained PTY already has that final size
   * (a same-size TIOCSWINSZ need not emit SIGWINCH). The first successful delivery consumes the
   * repaint obligation; a blocked resize must leave it pending.
   */
  async startLiveSynchronization(): Promise<void> {
    if (this.disposed || this.live || this.suspendReasons.has('replay')) return
    this.live = true
    this.lastRequestedGrid = null
    this.awaitingFirstLiveFit = true
    try {
      await this.fitAndSynchronize()
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
      const changed = await this.requestResize(temporary)
      const restored = await this.requestResize(size)
      return changed && restored
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
    this.awaitingFirstLiveFit = false
  }

  /**
   * Refit after a **deliberate** cell-metric change (the user changed the terminal font size).
   *
   * A font change is the one case the wobble gate in `fitAndSynchronize` gets exactly wrong. That gate
   * skips a fit when the grid diverges from the proposal while the container's CSS pixels are unchanged,
   * on the theory that a one-cell divergence at constant pixels is WebGL/DOM cell-metric jitter. A font
   * change has that same shape — same container, different cell size, so the whole grid moves while the
   * pixels do not — but it is real, not jitter: the PTY must be told the new column/row count or it
   * keeps wrapping output to the old grid and the screen tears.
   *
   * So the pixel baseline is cleared here (a size change means the last-fitted pixels no longer describe
   * a settled state) and the normal settled-size path is re-entered through `observeViewport`. The fit,
   * the stability-frame wait for xterm to re-measure the new glyph, and the PTY resize all stay in the
   * one owner — this adds no second fit path. Nothing happens before the terminal is live: with no PTY
   * to resize, the constructor-time options already carry the size.
   */
  synchronizeCellMetrics(): void {
    if (this.disposed) return
    this.lastFittedPixels = null
    this.observeViewport()
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

    // A real local layout change can reclaim its grid even if a past request used the same size.
    if (!this.lastFittedPixels || !samePixels(pixels, this.lastFittedPixels)) this.lastRequestedGrid = null
    if (gridDiverged) this.options.fit()
    // 记录本次 fit 决策所依据的像素，作为后续抖动判定的基线。存副本，避免调用方
    // 复用同一可变对象时把基线一起改掉（getBoundingClientRect 每次新建，但契约不保证）。
    this.lastFittedPixels = { width: pixels.width, height: pixels.height }

    const size = this.options.readGrid()
    if (!isUsableGrid(size)) return
    // 非 live 的 fit 不摘旗：旗子等的是「第一次真的把几何送到 PTY 的 fit」。
    if (!this.live) return

    if (!await this.requestResize(size)) return

    if (!this.awaitingFirstLiveFit) return
    this.awaitingFirstLiveFit = false
    // 重放那一屏是按当时的 grid 排的；现在的 grid 与它不同 ⇒ 那一屏排错了宽度。而 alt screen
    // 不会自行重排，同尺寸的 TIOCSWINSZ 也不产生 SIGWINCH，所以 TUI 永远收不到重画的理由。
    // 详见 startLiveSynchronization 与 `gridWhenReplayLanded` 的说明。
    //
    // 没重放过就没有排错的那一屏（`null`）——全新起的终端走这一路，不重绘。
    const atReplay = this.gridWhenReplayLanded
    if (!atReplay || gridKey(size) === gridKey(atReplay)) return
    try {
      await this.requestContentRedraw()
    } catch {
      // 重绘失败不许连坐 live 同步——几何已经送到 PTY 了，缺的只是让 TUI 重画一次。
      // 而且这个失败不是静默的：排空队列在抛之前已经走过 `onResizeError`，
      // `requestContentRedraw` 自己的 catch 也已经把几何重新交回稳定尺寸的所有者。
    }
  }

  private async requestResize(size: TerminalGridSize): Promise<boolean> {
    const key = gridKey(size)
    if (key === this.lastRequestedGrid) {
      await this.resizeDrain
      return this.lastRequestedGrid !== null
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
    return this.lastRequestedGrid !== null
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
        if (delivered === false) this.lastRequestedGrid = null
        else {
          if (delivered !== true) this.lastRequestedGrid = gridKey(delivered)
          this.options.onResizeSuccess?.()
        }
      } catch (error) {
        this.pendingResize = null
        this.lastRequestedGrid = null
        this.options.onResizeError?.(error)
        throw error
      }
    }
  }
}
