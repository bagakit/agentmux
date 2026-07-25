import { describe, expect, it, vi } from 'vitest'
import {
  LatestBrowserBoundsSynchronizer,
  rendererCssBoundsToWindowDip
} from '../src/renderer/src/lib/browser-bounds-sync.js'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('native Browser bounds synchronization', () => {
  it.each([
    { zoomFactor: 1, expected: { x: 120, y: 50, width: 640, height: 480 } },
    { zoomFactor: 1.25, expected: { x: 150, y: 62.5, width: 800, height: 600 } },
    { zoomFactor: 0.8, expected: { x: 96, y: 40, width: 512, height: 384 } }
  ])('maps Renderer CSS pixels to window DIP at $zoomFactor zoom', ({ zoomFactor, expected }) => {
    expect(rendererCssBoundsToWindowDip(
      { x: 120, y: 50, width: 640, height: 480 },
      zoomFactor
    )).toEqual(expected)
  })

  it('submits live resize geometry instead of leaving a stale native viewport visible', async () => {
    const apply = vi.fn(async () => {})
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())

    sync.observe({ x: 10.2, y: 20.6, width: 800.1, height: 500.8 })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
    expect(apply).toHaveBeenCalledWith({ x: 10, y: 21, width: 800, height: 501 })
  })

  it('keeps one request in flight and collapses a resize burst to its latest value', async () => {
    const first = deferred()
    const apply = vi.fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValue(undefined)
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())

    sync.observe({ x: 0, y: 40, width: 900, height: 600 })
    sync.observe({ x: 0, y: 40, width: 850, height: 550 })
    sync.observe({ x: 0, y: 40, width: 800, height: 500 })
    expect(apply).toHaveBeenCalledOnce()

    first.resolve()
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    expect(apply).toHaveBeenLastCalledWith({ x: 0, y: 40, width: 800, height: 500 })
  })

  it('turns transient zero geometry into an immediate hide without reporting an error', async () => {
    const apply = vi.fn(async () => {})
    const reportError = vi.fn()
    const sync = new LatestBrowserBoundsSynchronizer(apply, reportError)

    sync.observe({ x: 0, y: 0, width: 0, height: 500 })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(null))
    expect(reportError).not.toHaveBeenCalled()
  })
})
