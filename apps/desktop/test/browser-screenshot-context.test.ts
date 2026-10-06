import { describe, expect, it } from 'vitest'
import type { BrowserPng, BrowserScreenshotCapture } from '../src/shared/contracts.js'
import { formatScreenshotContext } from '../src/renderer/src/components/browser-screenshot/context.js'
import type { ImageAnnotationInput } from '../src/renderer/src/components/image-annotation/types.js'
import type { ScreenshotShape } from '../src/renderer/src/components/image-annotation/drawing-model.js'

const capture: BrowserScreenshotCapture = {
  browserId: 'original-browser', navigationId: 'original-navigation',
  image: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQ==', width: 600, height: 400, byteLength: 1 },
  source: { url: 'https://example.invalid/captured', title: 'Title from capture receipt',
    viewport: { width: 300, height: 200, deviceScaleFactor: 3 }, viewportWarning: null }
}
function note(id: string, number: number, x: number, y: number, comment: string): ScreenshotShape {
  return { id, kind: 'note', number, note: comment, from: { x, y }, to: { x: x + 40, y: y + 30 },
    color: '#ef4444', width: 2, radius: 10 }
}
function input(shapes: ScreenshotShape[], crop: ImageAnnotationInput['crop'] = null): ImageAnnotationInput {
  return { image: {} as HTMLImageElement, shapes, crop, displayWidth: capture.image.width, displayHeight: capture.image.height }
}
function output(width: number, height: number): BrowserPng {
  return { mimeType: 'image/png', dataUrl: 'data:image/png;base64,AQ==', width, height, byteLength: 1 }
}
function decode(text: string) { return JSON.parse(text.slice(text.indexOf('{'))) }

describe('Screenshot processed-image context', () => {
  it('uses capture receipt source and original pixel dimensions, never a later display title or DPR-derived size', () => {
    const result = decode(formatScreenshotContext(capture, input([]), output(300, 200)))
    expect(result.browserId).toBe(capture.browserId)
    expect(result.navigationId).toBe(capture.navigationId)
    expect(result.source).toEqual(capture.source)
    expect(result.originalImagePixels).toEqual({ width: 600, height: 400 })
    expect(result.outputPng).toEqual({ width: 300, height: 200 })
    expect(result.transform.finalScale).toEqual({ x: 0.5, y: 0.5 })
    expect(result.annotations).toEqual([])
    expect(result).not.toHaveProperty('image')
    expect(JSON.stringify(result)).not.toContain(capture.image.dataUrl)
  })

  it('omits both crop-away and pixelate-overlapped comments while preserving visible numbers and treated ranges', () => {
    const visible = note('visible-note', 5, 80, 70, 'Check this retained region')
    const outside = note('outside-note', 2, 20, 70, 'CROP_AWAY_PRIVATE_COMMENT')
    const hidden = note('masked-note', 8, 180, 90, 'PIXELATED_PRIVATE_COMMENT')
    const mask: ScreenshotShape = { id: 'mask', kind: 'pixelate', color: '#000', blockSize: 16,
      from: { x: 170, y: 80 }, to: { x: 210, y: 115 } }
    const text = formatScreenshotContext(capture, input([mask, outside, visible, hidden], { x: 50, y: 40, width: 250, height: 180 }), output(250, 180))
    const result = decode(text)
    expect(result.annotations.map((shape: { id: string }) => shape.id)).toEqual(['visible-note', 'mask'])
    expect(result.annotations[0]).toMatchObject({ number: 5, note: 'Check this retained region' })
    expect(result.annotations[1]).not.toHaveProperty('note')
    expect(text).not.toContain('CROP_AWAY_PRIVATE_COMMENT')
    expect(text).not.toContain('PIXELATED_PRIVATE_COMMENT')
    expect(text).not.toContain('outside-note')
    expect(text).not.toContain('masked-note')
  })

  it('maps crop pixel edges and actual final PNG dimensions, including fractional crop and downscaling', () => {
    const visible = note('visible-note', 4, 80, 70, 'Coordinate example')
    const result = decode(formatScreenshotContext(capture,
      input([visible], { x: 50.25, y: 40.75, width: 250.5, height: 180.5 }), output(125, 90)))
    expect(result.crop).toEqual({ x: 50.25, y: 40.75, width: 250.5, height: 180.5 })
    expect(result.transform).toEqual({ sourceScale: 1, cropOffsetPixels: { x: 50, y: 40 }, finalScale: { x: 125 / 251, y: 90 / 182 } })
    expect(result.annotations[0].originalImagePixels).toEqual({ x: 70, y: 60, width: 50, height: 40 })
    expect(result.annotations[0].pngPixels).toEqual({ x: 20 * 125 / 251, y: 20 * 90 / 182, width: 50 * 125 / 251, height: 40 * 90 / 182 })
  })

  it('clips a visible numbered region to output bounds without exposing its cropped-away range', () => {
    const edge = note('edge-note', 3, 295, 205, 'Visible portion only')
    const result = decode(formatScreenshotContext(capture, input([edge], { x: 50, y: 40, width: 250, height: 180 }), output(250, 180)))
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations[0]).toMatchObject({ number: 3,
      originalImagePixels: { x: 285, y: 195, width: 15, height: 25 },
      pngPixels: { x: 235, y: 155, width: 15, height: 25 } })
  })

  it('preserves explicit unknown source viewport while retaining usable image-space context', () => {
    const unavailable = { ...capture, source: { url: null, title: null, viewport: null, viewportWarning: 'Observation timed out' } }
    const result = decode(formatScreenshotContext(unavailable, input([note('visible', 1, 80, 70, 'Still usable')]), output(600, 400)))
    expect(result.source).toEqual(unavailable.source)
    expect(result.annotations[0]).toMatchObject({ number: 1, note: 'Still usable' })
    expect(result.transform.finalScale).toEqual({ x: 1, y: 1 })
  })
})
