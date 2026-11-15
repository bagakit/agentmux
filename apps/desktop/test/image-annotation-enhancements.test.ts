import { describe, expect, it, vi } from 'vitest'
import { constrainedEndpoint, hitTestShape, maskIntersectsRect, moveShape, scaleShape, screenshotOutputShapes, shapeBounds,
  type NoteShape, type PixelateBrushShape, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'
import { drawScreenshotShapes } from '@agentmux/client-ui/image-annotation'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { formatScreenshotContext } from '../src/renderer/src/components/browser-screenshot/context'

const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const limits = { maxDocumentBytes: 1024 * 1024, maxImageBytes: 1024, maxImageDimension: 1000, maxImagePixels: 1000000 }
const brush: PixelateBrushShape = { id: 'brush', kind: 'pixelate-brush', color: '#111827', blockSize: 8, width: 20,
  points: [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 120 }] }
const note = (id: string, x: number, y: number): NoteShape => ({ id, kind: 'note', color: '#ef4444', radius: 3, width: 1, number: 1, note: id,
  from: { x, y }, to: { x: x + 3, y: y + 3 } })

describe('shared image annotation enhancements', () => {
  it('filters only notes touched by the actual brush corridor from processed Agent context and retains editable originals', () => {
    const hidden = note('PRIVATE_INSIDE_BRUSH', 60, 20), untouched = note('VISIBLE_INSIDE_BOUNDING_BOX', 60, 90)
    const shapes: ScreenshotShape[] = [hidden, brush, untouched]
    expect(shapeBounds(brush)).toEqual({ x: 10, y: 10, width: 120, height: 120 })
    expect(maskIntersectsRect(brush, shapeBounds(hidden))).toBe(true)
    expect(maskIntersectsRect(brush, shapeBounds(untouched)), 'the brush does not cover its empty bounding-box interior').toBe(false)
    expect(screenshotOutputShapes(shapes).map(shape => shape.id), 'actual brush filtering must omit only the masked note').toEqual([untouched.id, brush.id])
    const document = createEditableAnnotationDocument({ image, shapes, crop: null, source: null }, limits)
    expect(parseEditableAnnotationDocument(encodeEditableAnnotationDocument(document, limits), limits)).toEqual(document)
    const text = formatScreenshotContext(null, { image: {} as HTMLImageElement, shapes, crop: null, displayWidth: 160, displayHeight: 140 },
      { mimeType: 'image/png', ...image, width: 160, height: 140, byteLength: 68 })
    expect(text, 'actual context must not reveal brush-covered note text').not.toContain(hidden.note)
    expect(text).toContain(untouched.note)
    expect(hitTestShape([brush], { x: 60, y: 20 }, 0)?.id).toBe(brush.id)
    expect(hitTestShape([brush], { x: 60, y: 90 }, 0)).toBeNull()
    expect(moveShape(brush, 5, 7)).toMatchObject({ id: brush.id, points: [{ x: 25, y: 27 }, { x: 125, y: 27 }, { x: 125, y: 127 }] })
    expect(scaleShape(brush, .5)).toMatchObject({ id: brush.id, width: 10, blockSize: 4, points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] })
  })

  it('keeps constrained square circle and arrow endpoints in original image coordinates', () => {
    expect(constrainedEndpoint('rect', { x: 100, y: 100 }, { x: 40, y: 75 })).toEqual({ x: 40, y: 40 })
    expect(constrainedEndpoint('ellipse', { x: 10, y: 20 }, { x: 80, y: 55 })).toEqual({ x: 80, y: 90 })
    const arrow = constrainedEndpoint('arrow', { x: 20, y: 30 }, { x: 100, y: 40 })
    expect(arrow.y).toBe(30); expect(arrow.x).toBeCloseTo(20 + Math.hypot(80, 10))
  })

  it('draws explicit text lines with the same line height used by selection and Agent bounds', () => {
    const text: ScreenshotShape = { id: 'text', kind: 'text', color: '#123456', fontSize: 20, at: { x: 10, y: 15 }, text: 'Longest\r\n短\nthird' }
    const context = { save: vi.fn(), restore: vi.fn(), strokeText: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D
    drawScreenshotShapes(context, [text])
    expect(vi.mocked(context.fillText).mock.calls, 'actual multiline renderer must paint separate baselines').toEqual([['Longest', 10, 15], ['短', 10, 39], ['third', 10, 63]])
    expect(shapeBounds(text)).toEqual({ x: 10, y: 15, width: 91, height: 72 })
    expect(hitTestShape([text], { x: 15, y: 65 }, 0)?.id).toBe(text.id)
  })
})
