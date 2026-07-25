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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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

  it('does not redraw a historical Run or race an interactive resize', async () => {
    const frames = frameHarness()
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
      resize: async () => {},
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
      .mockImplementationOnce(async () => await firstResizePending)
      .mockResolvedValue(undefined)
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
    const resize = vi.fn(async () => await resizePending)
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
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
})
