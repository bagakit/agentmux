export type TerminalGridSize = {
  cols: number
  rows: number
}

type TerminalViewportSynchronizerOptions = {
  proposeGrid(): TerminalGridSize | null
  fit(): void
  readGrid(): TerminalGridSize
  resize(size: TerminalGridSize): Promise<void>
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(frameId: number): void
  onResizeError?(error: unknown): void
}

const MAX_STABILITY_FRAMES = 8

function gridKey(size: TerminalGridSize): string {
  return `${size.cols}x${size.rows}`
}

function isUsableGrid(size: TerminalGridSize): boolean {
  return Number.isInteger(size.cols) && size.cols > 0 && Number.isInteger(size.rows) && size.rows > 0
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

  constructor(private readonly options: TerminalViewportSynchronizerOptions) {}

  observeViewport(): void {
    if (this.disposed || this.frameId !== null) return
    const proposed = this.options.proposeGrid()
    this.previousProposedGrid = proposed && isUsableGrid(proposed) ? proposed : null
    this.stabilityFrames = 0
    this.requestStabilityFrame()
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameId !== null) this.options.cancelFrame(this.frameId)
    this.frameId = null
    this.previousProposedGrid = null
    this.pendingResize = null
  }

  private async continueStableFit(): Promise<void> {
    if (this.disposed) return
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

    const current = this.options.readGrid()
    if (gridKey(current) !== gridKey(proposed)) this.options.fit()

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
        await this.options.resize(size)
      } catch (error) {
        this.pendingResize = null
        this.lastRequestedGrid = null
        this.options.onResizeError?.(error)
        throw error
      }
    }
  }
}
