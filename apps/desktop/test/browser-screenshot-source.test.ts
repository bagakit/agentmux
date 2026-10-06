import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => tmpdir() } }))

import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { readScreenshotViewport, screenshotSource, SCREENSHOT_VIEWPORT_SCRIPT } from '../src/main/browser-screenshot-source.js'

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  bytes[24] = 8; bytes[25] = 6
  return bytes
}

// Exercise the actual capture owner method with only its native IO replaced. Native creation,
// input, BrowserPane consumption and identity restoration have separate Electron proof.
function captureOwner() {
  const bytes = png(1200, 800)
  const nativeImage = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), toPNG: () => bytes }
  const contents = {
    url: 'https://example.invalid/captured', title: 'Title at capture',
    getURL() { return this.url }, getTitle() { return this.title }, isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ width: 600, height: 400, deviceScaleFactor: 3 })),
    capturePage: vi.fn(async () => nativeImage)
  }
  const entry = { view: { webContents: contents }, navigationId: 'original-navigation' }
  const entries = new Map([['original-browser', entry]])
  const owner = { entries, require: vi.fn(() => entry) } as unknown as BrowserViewManager
  return { contents, entry, entries, nativeImage, capture: () => BrowserViewManager.prototype.captureScreenshot.call(owner, 'original-browser') }
}

afterEach(() => vi.useRealTimers())

describe('Screenshot capture source', () => {
  it('returns the original owner source with CSS viewport independent from PNG pixels and DPR', async () => {
    const fixture = captureOwner()
    fixture.contents.capturePage.mockImplementation(async () => {
      fixture.contents.url = 'https://example.invalid/later-display-url'
      fixture.contents.title = 'Later page or Renderer title'
      return fixture.nativeImage
    })
    const result = await fixture.capture()
    expect(result).toMatchObject({
      browserId: 'original-browser', navigationId: 'original-navigation',
      source: { url: 'https://example.invalid/captured', title: 'Title at capture',
        viewport: { width: 600, height: 400, deviceScaleFactor: 3 }, viewportWarning: null },
      image: { width: 1200, height: 800, byteLength: 33 }
    })
    expect(fixture.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2)
    for (const call of fixture.contents.executeJavaScriptInIsolatedWorld.mock.calls) {
      expect(call).toEqual([expect.any(Number), [{ code: SCREENSHOT_VIEWPORT_SCRIPT }]])
    }
    expect(result.image.width).not.toBe(result.source.viewport!.width * result.source.viewport!.deviceScaleFactor!)
  })

  it('retains PNG when optional viewport reads reject', async () => {
    const fixture = captureOwner()
    fixture.contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('observation unavailable'))
    const result = await fixture.capture()
    expect(fixture.contents.capturePage).toHaveBeenCalledOnce()
    expect(result.image).toMatchObject({ mimeType: 'image/png', width: 1200, height: 800 })
    expect(result.source).toMatchObject({ title: 'Title at capture', viewport: null,
      viewportWarning: expect.stringContaining('could not be confirmed') })
  })

  it('bounds unresolved viewport observations and still returns the original PNG', async () => {
    vi.useFakeTimers()
    const fixture = captureOwner()
    fixture.contents.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise(() => {}))
    const pending = fixture.capture()
    await vi.advanceTimersByTimeAsync(500)
    expect(fixture.contents.capturePage).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    const result = await pending
    expect(result.image).toMatchObject({ width: 1200, height: 800 })
    expect(result.source.viewport).toBeNull()
    expect(result.source.viewportWarning).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports viewport unknown when the original page resizes or zooms during capture', async () => {
    const fixture = captureOwner()
    fixture.contents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce({ width: 600, height: 400, deviceScaleFactor: 3 })
      .mockResolvedValueOnce({ width: 590, height: 400, deviceScaleFactor: 3 })
    const result = await fixture.capture()
    expect(result.source.viewport).toBeNull()
    expect(result.source.viewportWarning).not.toBeNull()
    expect(result.image.width).toBe(1200)
    expect(screenshotSource('original-url', 'original-title',
      { width: 600, height: 400, deviceScaleFactor: 2 },
      { width: 600, height: 400, deviceScaleFactor: 3 }).viewport).toBeNull()
  })

  it('still rejects a changed capture owner instead of swallowing it as missing metadata', async () => {
    const fixture = captureOwner()
    fixture.contents.capturePage.mockImplementation(async () => {
      fixture.entry.navigationId = 'replacement-navigation'
      return fixture.nativeImage
    })
    await expect(fixture.capture()).rejects.toThrow('Browser page changed')
  })

  it.each([null, {}, { width: 0, height: 10 }, { width: 10, height: -1 },
    { width: Number.NaN, height: 10 }, { width: 10, height: Infinity }, { width: '10', height: 10 }])
  ('does not invent geometry from invalid optional observation %j', async value => {
    await expect(readScreenshotViewport(async () => value)).resolves.toBeNull()
  })

  it('preserves valid CSS dimensions when DPR alone is unavailable', async () => {
    await expect(readScreenshotViewport(async () => ({ width: 640.5, height: 359.75, deviceScaleFactor: 0 })))
      .resolves.toEqual({ width: 640.5, height: 359.75, deviceScaleFactor: null })
    await expect(readScreenshotViewport(() => { throw new Error('synchronous observer failure') })).resolves.toBeNull()
  })

  it('keeps unavailable URL and title explicit instead of inventing source metadata', () => {
    const viewport = { width: 600, height: 400, deviceScaleFactor: null }
    expect(screenshotSource(null, null, viewport, viewport)).toEqual({
      url: null, title: null, viewport, viewportWarning: null
    })
  })
})
