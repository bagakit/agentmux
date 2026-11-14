import { expect, it, vi } from 'vitest'
import { parseBrowserScreenshotOptions, prepareBrowserScreenshot } from '../../../packages/browser/src/browser-screenshot-options.js'

it('preserves the current page viewport and requests the exact scroll-relative region at output density', async () => {
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 10, pageY: 100, zoom: 1, clientWidth: 200, clientHeight: 100 } }))
  const result = await prepareBrowserScreenshot(send, { clip: { x: 2, y: 3, width: 60, height: 40 }, pixelRatio: 2 },
    { width: 200, height: 100, deviceScaleFactor: 3 })
  expect(result.parameters).toMatchObject({ captureBeyondViewport: false,
    clip: { x: 12, y: 103, width: 60, height: 40, scale: 2 / 3 } })
  expect(result.region).toEqual({ x: 2, y: 3, width: 60, height: 40, pixelRatio: 2 })
  expect(send.mock.calls).toEqual([['Page.getLayoutMetrics']])
})

it('converts a zoomed CSS rectangle to CDP DIP while retaining the requested output density', async () => {
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 10, pageY: 100, zoom: 0.9, clientWidth: 800, clientHeight: 733 } }))
  const result = await prepareBrowserScreenshot(send, { clip: { x: 24, y: 24, width: 320, height: 240 }, pixelRatio: 2 },
    { width: 800, height: 733, deviceScaleFactor: 1.8 })
  expect(result.parameters.clip).toEqual({ x: 30.6, y: 111.60000000000001, width: 288, height: 216, scale: 2 / 1.8 })
  expect(result.region).toEqual({ x: 24, y: 24, width: 320, height: 240, pixelRatio: 2 })
  expect(send.mock.calls).toEqual([['Page.getLayoutMetrics']])
})

it('keeps a missing zoom observation unknown instead of guessing an exact region', async () => {
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 0, pageY: 0 } }))
  await expect(prepareBrowserScreenshot(send, { pixelRatio: 2 },
    { width: 200, height: 100, deviceScaleFactor: 2 })).rejects.toThrow('page zoom is unconfirmed')
  expect(send.mock.calls).toEqual([['Page.getLayoutMetrics']])
})

it('retains integer DIP bounds reported just below the integer by float32 page zoom', async () => {
  const zoom = Math.fround(0.9)
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 0, pageY: 0, zoom, clientWidth: 800, clientHeight: 733 } }))
  const result = await prepareBrowserScreenshot(send, { clip: { x: 24, y: 24, width: 320, height: 240 }, pixelRatio: 2 },
    { width: 800, height: 733, deviceScaleFactor: Math.fround(1.8) })
  expect(result.parameters.clip).toMatchObject({ x: 24 * zoom, y: 24 * zoom, width: 288, height: 216 })
  expect(result.region).toEqual({ x: 24, y: 24, width: 320, height: 240, pixelRatio: 2 })
})

it('captures the actual full visible viewport including its fractional CSS edge at page zoom', async () => {
  const height = 733.3333740234375, zoom = Math.fround(0.9)
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 0, pageY: 0, zoom, clientWidth: 800, clientHeight: height } }))
  const result = await prepareBrowserScreenshot(send, { pixelRatio: 2 }, { width: 800, height: 733, deviceScaleFactor: Math.fround(1.8) })
  expect(result.parameters.clip).toMatchObject({ width: 720, height: 660 })
  expect(result.region).toEqual({ x: 0, y: 0, width: 800, height, pixelRatio: 2 })
})

it('refuses invalid or outside regions before capture, input or viewport emulation', async () => {
  const send = vi.fn(async () => ({ cssVisualViewport: { pageX: 0, pageY: 0, zoom: 1, clientWidth: 200, clientHeight: 100 } }))
  expect(() => parseBrowserScreenshotOptions({ fullPage: true })).toThrow('support')
  expect(() => parseBrowserScreenshotOptions({ within: 'main', clip: {} })).toThrow('either')
  await expect(prepareBrowserScreenshot(send, { clip: { x: 190, y: 0, width: 20, height: 10 } },
    { width: 200, height: 100, deviceScaleFactor: 2 })).rejects.toThrow('entirely')
  await expect(prepareBrowserScreenshot(send, { pixelRatio: 2 }, null)).rejects.toThrow('unconfirmed')
  expect(send.mock.calls).toEqual([['Page.getLayoutMetrics']])
})
