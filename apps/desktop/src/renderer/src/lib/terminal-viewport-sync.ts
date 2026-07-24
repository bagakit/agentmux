export type TerminalGridSize = {
  cols: number
  rows: number
}

type TerminalViewportSynchronizerOptions = {
  fit(): boolean
  readGrid(): TerminalGridSize
  resize(size: TerminalGridSize): Promise<void>
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(frameId: number): void
  onResizeError?(error: unknown): void
}

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
  private lastRequestedGrid: string | null = null
  private resizeTail = Promise.resolve()

  constructor(private readonly options: TerminalViewportSynchronizerOptions) {}

  observeViewport(): void {
    if (this.disposed || this.frameId !== null) return
    this.frameId = this.options.requestFrame(() => {
      this.frameId = null
      void this.fitAndSynchronize().catch(() => {})
    })
  }

  async startLiveSynchronization(): Promise<void> {
    if (this.disposed || this.live) return
    this.live = true
    try {
      await this.fitAndSynchronize()
      await this.resizeTail
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
  }

  private async fitAndSynchronize(): Promise<void> {
    if (this.disposed) return
    if (!this.options.fit()) return
    if (!this.live) return

    const size = this.options.readGrid()
    if (!isUsableGrid(size)) return
    const key = gridKey(size)
    if (key === this.lastRequestedGrid) {
      await this.resizeTail
      return
    }
    this.lastRequestedGrid = key

    const operation = this.resizeTail
      .catch(() => {})
      .then(async () => {
        if (!this.disposed) await this.options.resize(size)
      })
    this.resizeTail = operation.catch((error) => {
        if (this.lastRequestedGrid === key) this.lastRequestedGrid = null
        this.options.onResizeError?.(error)
      })
    await operation
  }
}
