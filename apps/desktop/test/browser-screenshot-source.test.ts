import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => tmpdir() } }))

import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { readScreenshotViewport, screenshotSource, SCREENSHOT_VIEWPORT_SCRIPT } from '@agentmux/browser/browser-screenshot-source'

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
  const nativeImage = { isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), toPNG: vi.fn(() => bytes) }
  const viewportObservation = vi.fn(async (): Promise<unknown> => ({ width: 600, height: 400, deviceScaleFactor: 3 }))
  const contents = {
    url: 'https://example.invalid/captured', title: 'Title at capture',
    getURL() { return this.url }, getTitle() { return this.title }, isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: { code: string }[]) => scripts[0]?.code === SCREENSHOT_VIEWPORT_SCRIPT ? viewportObservation() : scripts[0]?.code.includes('hasDisplay:') ? { confirmed: true, hasDisplay: false } : true),
    capturePage: vi.fn(async () => nativeImage)
  }
  const bounds = { x: 0, y: 0, width: 1200, height: 800 }
  const entry = { id: 'original-browser', view: { webContents: contents, getBounds: () => bounds, getVisible: () => true },
    navigationId: 'original-navigation', visible: true, bounds, inputLeaseId: null, initialDocument: null, resourceReads: 0 }
  const entries = new Map([['original-browser', entry]])
  const owner = Object.assign(Object.create(BrowserViewManager.prototype), { entries, require: vi.fn(() => entry), emit: vi.fn() }) as BrowserViewManager
  return { contents, entry, entries, nativeImage, owner, viewportObservation,
    capture: (transport?: Parameters<BrowserViewManager['captureScreenshot']>[1]) => BrowserViewManager.prototype.captureScreenshot.call(owner, 'original-browser', transport) }
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
    expect(fixture.viewportObservation).toHaveBeenCalledTimes(2)
    for (const call of fixture.contents.executeJavaScriptInIsolatedWorld.mock.calls.filter(call => call[1][0]?.code === SCREENSHOT_VIEWPORT_SCRIPT)) {
      expect(call).toEqual([expect.any(Number), [{ code: SCREENSHOT_VIEWPORT_SCRIPT }]])
    }
    expect(result.image.width).not.toBe(result.source.viewport!.width * result.source.viewport!.deviceScaleFactor!)
    expect(fixture.nativeImage.toPNG).toHaveBeenCalledTimes(1)
    expect(fixture.entry.resourceReads).toBe(0)
  })

  it('uses the original CDP session through the same page image seam without a GUI or OS capture', async () => {
    const fixture = captureOwner(), data = png(320, 480).toString('base64')
    const sendCommand = vi.fn(async () => ({ data }))
    const result = await fixture.capture({ view: fixture.entry.view as never, sendCommand })
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    expect(result).toMatchObject({ browserId: 'original-browser', navigationId: 'original-navigation',
      image: { dataUrl: 'data:image/png;base64,' + data, width: 320, height: 480 } })
    expect(fixture.contents.capturePage).not.toHaveBeenCalled()
    expect(fixture.nativeImage.toPNG).not.toHaveBeenCalled()
    expect(fixture.entry.resourceReads).toBe(0)
  })

  it('keeps hidden mobile page pixels available without a system screenshot or screen permission read', async () => {
    const fixture = captureOwner()
    fixture.entry.visible = false
    fixture.viewportObservation.mockResolvedValue({ width: 390, height: 844, deviceScaleFactor: 3 })
    const result = await fixture.capture()
    expect(fixture.contents.capturePage).toHaveBeenCalledOnce()
    expect(result.source.viewport).toEqual({ width: 390, height: 844, deviceScaleFactor: 3 })
    expect(result.image.dataUrl).toBe('data:image/png;base64,' + png(1200, 800).toString('base64'))
    expect(fixture.entry.resourceReads).toBe(0)
  })

  it('rejects original page pixel dimensions mismatching their PNG and releases its exact read lease', async () => {
    const fixture = captureOwner()
    fixture.nativeImage.getSize = () => ({ width: 1201, height: 800 })
    await expect(fixture.capture()).rejects.toThrow(/dimensions changed/)
    expect(fixture.nativeImage.toPNG).toHaveBeenCalledTimes(1)
    expect(fixture.entry.resourceReads).toBe(0)
  })

  it('retains PNG when optional viewport reads reject', async () => {
    const fixture = captureOwner()
    fixture.viewportObservation.mockRejectedValue(new Error('observation unavailable'))
    const result = await fixture.capture()
    expect(fixture.contents.capturePage).toHaveBeenCalledOnce()
    expect(result.image).toMatchObject({ mimeType: 'image/png', width: 1200, height: 800 })
    expect(result.source).toMatchObject({ title: 'Title at capture', viewport: null,
      viewportWarning: expect.stringContaining('could not be confirmed') })
  })

  it('bounds unresolved viewport observations and still returns the original PNG', async () => {
    vi.useFakeTimers()
    const fixture = captureOwner()
    fixture.viewportObservation.mockImplementation(() => new Promise(() => {}))
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
    fixture.viewportObservation
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

it('[clean-capture-owner] brackets the actual original GUI pixels with both display worlds and restores even when pixels reject', async () => {
  const f=captureOwner()
  f.contents.capturePage.mockImplementation(async()=>{
    const calls=f.contents.executeJavaScriptInIsolatedWorld.mock.calls
    for(const world of [1208,1209])expect(calls.some(([id,scripts])=>id===world&&scripts[0]!.code.includes(',true)'))).toBe(true)
    throw new Error('Original capture rejected')
  })
  await expect(f.capture()).rejects.toThrow('Original capture rejected')
  for(const world of [1208,1209])expect(f.contents.executeJavaScriptInIsolatedWorld.mock.calls.some(([id,scripts])=>id===world&&scripts[0]!.code.includes(',false)'))).toBe(true)
  expect(f.entry.resourceReads).toBe(0)
})
it('[clean-capture-owner] refuses only nondefault GUI options without silently capturing other pixels',async()=>{
 const f=captureOwner()
 await expect(f.owner.captureScreenshot('original-browser',undefined,{pixelRatio:2})).rejects.toThrow('require the original Browser program transport')
 expect(f.contents.capturePage).not.toHaveBeenCalled();expect(f.entry.resourceReads).toBe(0)
 const result=await f.capture();expect(result.source.hostOverlays).toBe('excluded')
})

it('[clean-capture-owner] an observation timeout restores display while the original pending native producer retains its exact resource read',async()=>{
 vi.useFakeTimers()
 const f=captureOwner(),events=new EventEmitter()
 let resolvePixels!:(value:typeof f.nativeImage)=>void,present!:()=>void
 const pixels=new Promise<typeof f.nativeImage>(resolve=>{resolvePixels=resolve})
 Object.assign(f.contents,{beginFrameSubscription:vi.fn((_dirty:boolean,callback:()=>void)=>{present=callback}),endFrameSubscription:vi.fn(),invalidate:vi.fn(),once:events.once.bind(events),on:events.on.bind(events),removeListener:events.removeListener.bind(events)})
 f.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async(_world,scripts)=>scripts[0]?.code===SCREENSHOT_VIEWPORT_SCRIPT?f.viewportObservation():scripts[0]?.code.includes('hasDisplay:')?{confirmed:true,hasDisplay:true}:true)
 f.contents.capturePage.mockImplementation(()=>pixels)
 const result=f.capture().then(()=>({status:'unexpected-clean'}),error=>({status:'unconfirmed',message:String(error)}))
 try{
  await vi.advanceTimersByTimeAsync(0);present();await vi.advanceTimersByTimeAsync(1501)
  expect(await result).toEqual({status:'unconfirmed',message:expect.stringContaining('observation budget')})
  expect(f.entry.resourceReads).toBe(1)
  expect(f.contents.capturePage).toHaveBeenCalledTimes(1)
  expect(events.eventNames()).toEqual([])
  for(const world of [1208,1209])expect(f.contents.executeJavaScriptInIsolatedWorld.mock.calls.some(([id,scripts])=>id===world&&scripts[0]!.code.includes(',false)'))).toBe(true)
  await expect(f.capture()).rejects.toThrow('observation budget')
  expect(f.contents.capturePage).toHaveBeenCalledTimes(1);expect(f.entry.resourceReads).toBe(1)
 }finally{resolvePixels(f.nativeImage);await pixels;await Promise.resolve()}
 expect(f.entry.resourceReads).toBe(0);expect(vi.getTimerCount()).toBe(0)
})
