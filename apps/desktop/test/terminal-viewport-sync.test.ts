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
      fit: () => measurable,
      readGrid: () => ({ cols: measurable ? 132 : 80, rows: measurable ? 50 : 24 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel
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
      fit: () => { actual = { ...proposed }; return true },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel
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
    const fit = vi.fn(() => true)
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
    const sync = new TerminalViewportSynchronizer({
      fit,
      readGrid: () => ({ cols: 120, rows: 40 }),
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel
    })

    sync.observeViewport()
    expect(frames.runNext()).toBe(true)
    await Promise.resolve()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()
  })

  it('coalesces viewport observations and forwards the latest settled grid', async () => {
    const frames = frameHarness()
    let proposed = { cols: 100, rows: 30 }
    let actual = { ...proposed }
    const resize = vi.fn(async (_size: { cols: number; rows: number }) => {})
    const sync = new TerminalViewportSynchronizer({
      fit: () => { actual = { ...proposed }; return true },
      readGrid: () => actual,
      resize,
      requestFrame: frames.request,
      cancelFrame: frames.cancel
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
      fit: vi.fn(() => true),
      readGrid: () => ({ cols: 80, rows: 24 }),
      resize: async () => {},
      requestFrame: frames.request,
      cancelFrame: frames.cancel
    })

    sync.observeViewport()
    expect(frames.count()).toBe(1)
    sync.dispose()
    expect(frames.count()).toBe(0)
  })
})
