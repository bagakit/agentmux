import { describe, expect, it, vi } from 'vitest'
import { renderCommittedLayer } from '@agentmux/client-ui/image-annotation'
import { outlineContains } from '@agentmux/client-ui/image-annotation'
import { AnnotationDocumentError, createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'
import { createAdjustShape, isScreenshotMask, moveShape, outlineExtent, outlineRects, scaleShape, screenshotOutputLayer, screenshotOutputShapes, withOutline,
  type CoverShape, type NoteShape, type RegionHighlightShape, type ScreenshotOutline, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'

// A complete PNG keeps the codec honest; shape geometry is not bounded by the image size.
const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
// An L-shaped region with a square hole in its upright: the even-odd fill excludes the hole and the L's notch.
const L: ScreenshotOutline = [
  [{ x: 20, y: 20 }, { x: 20, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 45 }, { x: 45, y: 45 }, { x: 45, y: 20 }],
  [{ x: 25, y: 25 }, { x: 35, y: 25 }, { x: 35, y: 35 }, { x: 25, y: 35 }]
]
const cover = (outline = L): CoverShape => withOutline({ id: 'cover', kind: 'cover', color: '#111827', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, outline)
const adjust = withOutline(createAdjustShape('adjust', { x: 0, y: 0 }, { x: 1, y: 1 }, { brightness: 1.2, contrast: 0.9, saturation: 1.3, sharpen: 0.4 }), L)
const document = (shapes: ScreenshotShape[]) => createEditableAnnotationDocument({ image, shapes, crop: null, source: {
  url: 'https://example.invalid/historical', title: 'Historical capture', viewport: { width: 400, height: 300, deviceScaleFactor: null }, viewportWarning: null
} }, ANNOTATION_DOCUMENT_LIMITS)
/** The saved JSON of a document with one region mark, whose fields the case then replaces. */
function saved(shape: Record<string, unknown>) {
  const value = JSON.parse(encodeEditableAnnotationDocument(document([cover()]), ANNOTATION_DOCUMENT_LIMITS))
  value.shapes = [{ ...value.shapes[0], ...shape }]
  return JSON.stringify(value)
}
function refused(content: string, message: RegExp) {
  let error: unknown
  try { parseEditableAnnotationDocument(content, ANNOTATION_DOCUMENT_LIMITS) } catch (caught) { error = caught }
  expect(error, 'the document is refused').toBeInstanceOf(AnnotationDocumentError)
  expect((error as AnnotationDocumentError).message).toMatch(message)
}

describe('wand outlines and adjust marks in the model', () => {
  it('paints adjustments first, then marks, masks, magnifiers and spotlights', () => {
    const shapes: ScreenshotShape[] = [
      { id: 'spot', kind: 'spotlight', color: '#ffffff', dim: 0.6, from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
      { id: 'zoom', kind: 'callout', color: '#ef4444', zoom: 2, from: { x: 0, y: 0 }, to: { x: 4, y: 4 }, at: { x: 20, y: 0 } },
      cover(), { id: 'rect', kind: 'rect', color: '#ef4444', width: 2, from: { x: 0, y: 0 }, to: { x: 9, y: 9 } }, adjust
    ]
    expect(shapes.map(screenshotOutputLayer)).toEqual([3, 2, 1, 0, -1])
    expect(screenshotOutputShapes(shapes).map(shape => shape.id), 'a magnifier samples adjusted pixels').toEqual(['adjust', 'rect', 'cover', 'zoom', 'spot'])
  })

  it('moves and scales a wand outline with its region', () => {
    const moved = moveShape(cover(), 5, -3) as CoverShape
    expect(moved.outline![0]![0], 'the rings move with the region').toEqual({ x: 25, y: 17 })
    expect(moved.outline![1]![2]).toEqual({ x: 40, y: 32 })
    expect({ from: moved.from, to: moved.to }, 'the region rect stays the outline extent').toEqual(outlineExtent(moved.outline!))
    const scaled = scaleShape(adjust, 2) as typeof adjust
    expect(scaled.outline![0]![3], 'the rings scale with the region').toEqual({ x: 140, y: 90 })
    expect({ from: scaled.from, to: scaled.to }).toEqual(outlineExtent(scaled.outline!))
    expect(scaled).toMatchObject({ brightness: 1.2, contrast: 0.9, saturation: 1.3, sharpen: 0.4 })
  })

  it('covers an outline\'s even-odd fill exactly with rects, holes and notches left out', () => {
    const rects = outlineRects(L)
    const inRect = (x: number, y: number) => rects.filter(rect => x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height).length
    for (let y = 10; y < 80; y++) for (let x = 10; x < 80; x++) {
      const centre = { x: x + 0.5, y: y + 0.5 }
      expect(inRect(centre.x, centre.y), `pixel ${x},${y}`).toBe(outlineContains(L, centre) ? 1 : 0)
    }
    expect(() => cover([[{ x: 20, y: 20 }, { x: 20, y: 70 }, { x: 70, y: 70 }]]), 'a slanted edge has no whole-pixel fill').toThrow(/horizontal or vertical/)
  })

  it('filters a note under an outlined mask by the mask bounds, outside its fill too', () => {
    // The note sits in the L's notch: inside the mask's bounds, outside its painted fill.
    const note: NoteShape = { id: 'note', kind: 'note', color: '#ef4444', width: 2, radius: 4, number: 1, note: 'hidden', from: { x: 60, y: 30 }, to: { x: 60, y: 30 } }
    expect(screenshotOutputShapes([note, cover()]).map(shape => shape.id)).toEqual(['cover'])
  })

  it('saves and reopens outlined region marks and adjust marks unchanged', () => {
    const shapes: ScreenshotShape[] = [cover(), adjust, withOutline({ id: 'pixels', kind: 'pixelate', color: '#000', blockSize: 8, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L),
      withOutline({ id: 'blur', kind: 'blur', color: '#111827', radius: 12, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L),
      withOutline({ id: 'spot', kind: 'spotlight', color: '#ffffff', dim: 0.6, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L),
      createAdjustShape('whole', { x: 0, y: 0 }, { x: 400, y: 300 }, { contrast: 1.1 })]
    const reopened = parseEditableAnnotationDocument(encodeEditableAnnotationDocument(document(shapes), ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
    expect(reopened.shapes).toEqual(shapes)
  })

  it('keeps a region highlight editable through original, move and scale without hiding notes', () => {
    const highlight = withOutline<RegionHighlightShape>({ id: 'highlight', kind: 'region-highlight', color: '#facc15', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L)
    const note: NoteShape = { id: 'visible-note', kind: 'note', color: '#ef4444', width: 2, radius: 4, number: 1, note: 'keep this context', from: { x: 30, y: 50 }, to: { x: 30, y: 50 } }
    const reopened = parseEditableAnnotationDocument(encodeEditableAnnotationDocument(document([highlight, note]), ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
    expect(reopened.shapes, 'the original keeps the region highlight and its geometry').toEqual([highlight, note])
    expect(isScreenshotMask(highlight), 'highlighting is not redaction').toBe(false)
    expect(screenshotOutputShapes(reopened.shapes).map(shape => shape.id), 'a highlighted note remains in the processed output and context').toEqual(['highlight', 'visible-note'])
    const moved = moveShape(reopened.shapes[0]!, 5, -3) as RegionHighlightShape
    expect(moved.outline![0]![0], 'the highlight outline moves with its pixels').toEqual({ x: 25, y: 17 })
    const scaled = scaleShape(moved, 2) as RegionHighlightShape
    expect(scaled.outline![1]![2], 'the highlight outline scales with its pixels').toEqual({ x: 80, y: 64 })
    expect({ from: scaled.from, to: scaled.to }, 'highlight bounds remain the outline extent').toEqual(outlineExtent(scaled.outline!))
  })

  it('rejects outlines that are open, non-finite, outside their region or over the limits', () => {
    refused(saved({ outline: [[{ x: 20, y: 20 }, { x: 70, y: 70 }]] }), /at least three points/)
    refused(saved({ outline: [] }), /closed rings/)
    refused(saved({ outline: [[{ x: 20, y: 20 }, { x: null, y: 70 }, { x: 70, y: 70 }]] }), /finite|number/i)
    refused(saved({ outline: [[{ x: 20, y: 20 }, { x: 20, y: 90 }, { x: 70, y: 90 }, { x: 70, y: 20 }]] }), /inside its region/)
    refused(saved({ outline: [[{ x: 20, y: 20 }, { x: 20, y: 70 }, { x: 70, y: 70 }]] }), /horizontal or vertical/)
    const ring = [{ x: 20, y: 20 }, { x: 20, y: 21 }, { x: 21, y: 21 }, { x: 21, y: 20 }]
    refused(saved({ outline: Array.from({ length: 10_001 }, () => ring) }), /too many rings/)
    expect(() => cover(Array.from({ length: 10_001 }, () => ring)), 'the editor refuses the same outline whole').toThrow(/too detailed/)
  })

  it('rejects adjust marks out of range or with missing or extra fields', () => {
    const value = (changes: Record<string, unknown>, drop?: string) => {
      const saved = JSON.parse(encodeEditableAnnotationDocument(document([adjust]), ANNOTATION_DOCUMENT_LIMITS))
      const shape = { ...saved.shapes[0], ...changes }
      if (drop) delete shape[drop]
      saved.shapes = [shape]; return JSON.stringify(saved)
    }
    refused(value({ brightness: 1.6 }), /adjustment is out of range/)
    refused(value({ saturation: 0.4 }), /adjustment is out of range/)
    refused(value({ sharpen: -0.1 }), /adjustment is out of range/)
    refused(value({ gamma: 1 }), /unsupported fields/)
    refused(value({}, 'sharpen'), /missing or unsupported fields/)
  })
})

/** A 2D context that only counts the sharpen readbacks the adjusted base costs; every other call does nothing. */
function countingCanvas(readbacks: { count: number }): HTMLCanvasElement {
  const context = new Proxy({ filter: 'none', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    getImageData: (_x: number, _y: number, width: number, height: number) => { readbacks.count++; return { width, height, data: new Uint8ClampedArray(width * height * 4) } } } as Record<string, unknown>,
  { get: (target, key: string) => key in target ? target[key] : vi.fn(), set: (target, key: string, value) => { target[key] = value; return true } })
  const canvas = { width: 0, height: 0, getContext: () => context, ownerDocument: { createElement: () => countingCanvas(readbacks) } }
  ;(context as Record<string, unknown>).canvas = canvas
  return canvas as unknown as HTMLCanvasElement
}

describe('adjustments in the committed layer', () => {
  it('reuses the adjusted image across pan and zoom and repaints it when a parameter changes', () => {
    const readbacks = { count: 0 }, layer = countingCanvas(readbacks), image = { width: 400, height: 300 } as unknown as CanvasImageSource
    const sharpened = withOutline(createAdjustShape('sharp', { x: 0, y: 0 }, { x: 1, y: 1 }, { sharpen: 0.5 }), L)
    const marks: ScreenshotShape[] = [sharpened, { id: 'rect', kind: 'rect', color: '#ef4444', width: 2, from: { x: 0, y: 0 }, to: { x: 9, y: 9 } }]
    const at = (scale: number, x: number, y: number) => ({ width: 200, height: 150, dpr: 2, imageWidth: 400, imageHeight: 300, view: { scale, x, y } })
    renderCommittedLayer(layer, marks, at(0.5, 0, 0), image)
    expect(readbacks.count, 'the first paint adjusts the image once').toBe(1)
    renderCommittedLayer(layer, marks, at(0.5, -40, 12.5), image); renderCommittedLayer(layer, marks, at(1.75, -300, -90), image)
    renderCommittedLayer(layer, [...marks, { id: 'pen', kind: 'pen', color: '#ef4444', width: 2, points: [{ x: 1, y: 1 }] }], at(1.75, -300, -90), image)
    expect(readbacks.count, 'pan, zoom and other marks reuse the adjusted image').toBe(1)
    renderCommittedLayer(layer, [{ ...sharpened, sharpen: 0.8 }, marks[1]!], at(1.75, -300, -90), image)
    expect(readbacks.count, 'a changed parameter repaints it').toBe(2)
  })
})
