import { describe, expect, it, vi } from 'vitest'
import {
  calloutBubble, calloutLeader, commitShape, createBlurShape, createCalloutShape, createScreenshotDocument, createSpotlightShape,
  hitTestShape, isScreenshotMask, moveShape, nextNoteNumber, removeShapes, renumberNotes, scaleShape, screenshotOutputShapes, shapeBounds, undoShape,
  type CalloutShape, type NoteShape, type ScreenshotShape
} from '@agentmux/client-ui/image-annotation'
import { drawScreenshotShapes } from '@agentmux/client-ui/image-annotation'
import { hitSelectionHandle, resizeShapeFromHandle, selectionHandles } from '@agentmux/client-ui/image-annotation'
import { AnnotationDocumentError, createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { formatScreenshotContext } from '../src/renderer/src/components/browser-screenshot/context'

const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const limits = { maxDocumentBytes: 1024 * 1024, maxImageBytes: 1024, maxImageDimension: 1000, maxImagePixels: 1000000 }
const note = (id: string, number: number, x = 10, y = 10): NoteShape => ({ id, kind: 'note', color: '#ef4444', radius: 4, width: 1, number, note: id,
  from: { x, y }, to: { x: x + 4, y: y + 4 } })
const blur = createBlurShape('blur', '#111827', { x: 40, y: 40 }, { x: 80, y: 60 }, 16)
const spotlight = createSpotlightShape('spot', '#ffffff', { x: 10, y: 10 }, { x: 50, y: 30 })
const callout: CalloutShape = createCalloutShape('zoom', '#ef4444', { x: 20, y: 20 }, { x: 40, y: 30 }, 2, { x: 100, y: 10 })

function codecRejects(label: string, shape: Record<string, unknown>) {
  const content = JSON.stringify({ schema: 'agentmux.image-annotation.v1', image, shapes: [shape], crop: null, source: null })
  let error: unknown = null
  try { parseEditableAnnotationDocument(content, limits) } catch (caught) { error = caught }
  expect(error, label + ' must be rejected').toBeInstanceOf(AnnotationDocumentError)
  expect(error).toMatchObject({ code: 'ANNOTATION_DOCUMENT_INVALID' })
}

describe('pointing marks in the shared annotation model', () => {
  it('treats blur as a redaction mask that hides the notes under it from processed output and context', () => {
    expect(isScreenshotMask(blur), 'blur must join the redaction family').toBe(true)
    expect(createBlurShape('a', '#000', { x: 0, y: 0 }, { x: 1, y: 1 }, 1).radius).toBe(2)
    expect(createBlurShape('b', '#000', { x: 0, y: 0 }, { x: 1, y: 1 }, 500).radius).toBe(64)
    const hidden = note('PRIVATE_UNDER_BLUR', 1, 50, 45), visible = note('VISIBLE_NOTE', 2, 5, 5)
    const shapes: ScreenshotShape[] = [hidden, blur, visible]
    expect(screenshotOutputShapes(shapes).map(shape => shape.id), 'processed output must omit the note under blur').toEqual([visible.id, blur.id])
    const text = formatScreenshotContext(null, { image: {} as HTMLImageElement, shapes, crop: null, displayWidth: 120, displayHeight: 80 },
      { mimeType: 'image/png', ...image, width: 120, height: 80, byteLength: 68 })
    expect(text).not.toContain(hidden.note)
    expect(text).toContain(visible.note)
    expect(scaleShape(blur, 0.5)).toMatchObject({ radius: 8, from: { x: 20, y: 20 }, to: { x: 40, y: 30 } })
    expect(moveShape(blur, 3, 4)).toMatchObject({ id: blur.id, from: { x: 43, y: 44 }, to: { x: 83, y: 64 } })
    expect(hitTestShape([blur], { x: 60, y: 50 }, 0)?.id, 'a blur is hit across its whole region').toBe(blur.id)
    expect(selectionHandles(blur).map(handle => handle.id)).toEqual(['nw', 'ne', 'se', 'sw'])
    expect(resizeShapeFromHandle(blur, 'se', { x: 90, y: 70 })).toMatchObject({ from: { x: 40, y: 40 }, to: { x: 90, y: 70 }, radius: 16 })
  })

  it('orders output as marks, masks, callouts, then spotlights while keeping order within each layer', () => {
    const rect: ScreenshotShape = { id: 'rect', kind: 'rect', color: '#22c55e', width: 2, from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }
    const cover: ScreenshotShape = { id: 'cover', kind: 'cover', color: '#111827', from: { x: 90, y: 0 }, to: { x: 95, y: 5 } }
    const second = createSpotlightShape('spot-2', '#fff', { x: 0, y: 0 }, { x: 1, y: 1 })
    const order = screenshotOutputShapes([spotlight, callout, blur, rect, second, cover]).map(shape => shape.id)
    expect(order.indexOf('zoom'), 'callouts sample only processed mask pixels').toBeGreaterThan(Math.max(order.indexOf('blur'), order.indexOf('cover')))
    expect(order.slice(-2), 'spotlights paint after every other mark').toEqual(['spot', 'spot-2'])
    expect(order).toEqual(['rect', 'blur', 'cover', 'zoom', 'spot', 'spot-2'])
    expect(isScreenshotMask(spotlight), 'spotlight points, it does not redact').toBe(false)
    expect(isScreenshotMask(callout)).toBe(false)
  })

  it('dims everything outside the spotlight region with one even-odd fill and a light frame', () => {
    const calls: string[] = []
    const context = {
      canvas: { width: 200, height: 100 }, save: vi.fn(), restore: vi.fn(),
      getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
      beginPath: vi.fn(), rect: vi.fn((...args: number[]) => calls.push('rect ' + args.join(','))),
      fill: vi.fn((rule: string) => calls.push('fill ' + rule)), strokeRect: vi.fn((...args: number[]) => calls.push('frame ' + args.join(',')))
    } as unknown as CanvasRenderingContext2D
    drawScreenshotShapes(context, [createSpotlightShape('dim', '#fff', { x: 50, y: 30 }, { x: 10, y: 10 }, 0.7)])
    expect(calls, 'the whole canvas minus the region is filled once').toEqual(['rect 0,0,100,50', 'rect 10,10,40,20', 'fill evenodd', 'frame 10,10,40,20'])
    expect(context.fillStyle).toBe('rgba(0,0,0,0.7)')
    expect(context.lineWidth, 'the frame is one device pixel').toBe(0.5)
    expect(createSpotlightShape('a', '#fff', { x: 0, y: 0 }, { x: 1, y: 1 }, 0).dim).toBe(0.3)
    expect(createSpotlightShape('b', '#fff', { x: 0, y: 0 }, { x: 1, y: 1 }, 1).dim).toBe(0.85)
  })

  it('selects a spotlight only by its frame so the marks inside it stay selectable', () => {
    const inside = note('inside', 1, 30, 20)
    expect(hitTestShape([inside, spotlight], { x: 30, y: 20 }, 2)?.id, 'the interior hits the mark it points at').toBe(inside.id)
    expect(hitTestShape([spotlight], { x: 30, y: 20 }, 2)).toBeNull()
    expect(hitTestShape([spotlight], { x: 50.5, y: 20 }, 2)?.id).toBe(spotlight.id)
    expect(shapeBounds(spotlight)).toEqual({ x: 10, y: 10, width: 40, height: 20 })
    expect(moveShape(spotlight, -5, 5)).toMatchObject({ from: { x: 5, y: 15 }, to: { x: 45, y: 35 }, dim: spotlight.dim })
    expect(resizeShapeFromHandle(spotlight, 'nw', { x: 0, y: 0 })).toMatchObject({ from: { x: 0, y: 0 }, to: { x: 50, y: 30 } })
  })

  it('places a callout bubble at source size times zoom with a leader between the nearest edge midpoints', () => {
    expect(calloutBubble(callout)).toEqual({ x: 100, y: 10, width: 40, height: 20 })
    expect(calloutLeader(callout), 'source right edge to bubble left edge').toEqual({ from: { x: 40, y: 25 }, to: { x: 100, y: 20 } })
    expect(calloutLeader({ ...callout, at: { x: 10, y: 80 } }), 'source bottom edge to bubble top edge').toEqual({ from: { x: 30, y: 30 }, to: { x: 30, y: 80 } })
    expect(shapeBounds(callout), 'bounds cover the source and the bubble').toEqual({ x: 20, y: 10, width: 120, height: 20 })
    const fresh = createCalloutShape('fresh', '#ef4444', { x: 20, y: 20 }, { x: 40, y: 30 })
    expect(fresh, 'without a view the gap is CALLOUT_GAP image pixels').toMatchObject({ zoom: 2.5, at: { x: 60, y: 20 } })
    expect(createCalloutShape('g', '#ef4444', { x: 20, y: 20 }, { x: 40, y: 30 }, 2, undefined, { gap: 40 }).at, 'the editor passes its screen gap in image pixels').toEqual({ x: 80, y: 20 })
    expect(createCalloutShape('z', '#000', { x: 0, y: 0 }, { x: 1, y: 1 }, 99).zoom).toBe(6)
    expect(createCalloutShape('z', '#000', { x: 0, y: 0 }, { x: 1, y: 1 }, 1).zoom).toBe(1.5)
  })

  it('places a default bubble inside the image or selection: right, else left, else below or above, else clamped', () => {
    const at = (from: [number, number], to: [number, number], zoom: number, bounds: { x: number; y: number; width: number; height: number }) =>
      createCalloutShape('b', '#ef4444', { x: from[0], y: from[1] }, { x: to[0], y: to[1] }, zoom, undefined, { bounds }).at
    const image = { x: 0, y: 0, width: 200, height: 100 }
    expect(at([20, 20], [40, 30], 2, image), 'right of the source when it fits').toEqual({ x: 60, y: 20 })
    expect(at([170, 20], [190, 30], 2, image), 'flips left when the right side has no room').toEqual({ x: 110, y: 20 })
    expect(at([30, 20], [70, 30], 2, { x: 0, y: 0, width: 100, height: 200 }), 'goes below when neither side fits').toEqual({ x: 10, y: 50 })
    expect(at([30, 40], [70, 50], 2, { x: 0, y: 0, width: 100, height: 60 }), 'goes above when below has no room').toEqual({ x: 10, y: 0 })
    expect(at([20, 20], [40, 30], 4, { x: 0, y: 0, width: 200, height: 50 }), 'a bubble taller than the space keeps its side and is clamped').toEqual({ x: 60, y: 10 })
    const tight = { x: 0, y: 0, width: 100, height: 40 }, clamped = createCalloutShape('c', '#ef4444', { x: 30, y: 10 }, { x: 70, y: 20 }, 2, undefined, { bounds: tight })
    const bubble = calloutBubble(clamped)
    expect(clamped.at, 'clamps inside when no side fits').toEqual({ x: 10, y: 20 })
    expect(bubble.x >= tight.x && bubble.y >= tight.y && bubble.x + bubble.width <= tight.width && bubble.y + bubble.height <= tight.height).toBe(true)
    expect(at([250, 120], [270, 130], 2, { x: 100, y: 100, width: 200, height: 100 }), 'a capture selection is its own bounds').toEqual({ x: 190, y: 120 })
    expect(createCalloutShape('k', '#ef4444', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, { x: 500, y: 500 }, { bounds: image }).at, 'an explicit position is kept').toEqual({ x: 500, y: 500 })
  })

  it('clamps a bubble that fits nowhere to the place covering least of its source, ties going right, left, below, above', () => {
    const at = (from: number, zoom = 4) => createCalloutShape('o', '#ef4444', { x: from, y: 15 }, { x: from + 10, y: 25 }, zoom, undefined,
      { bounds: { x: 0, y: 0, width: 100, height: 40 } }).at
    expect(at(55), 'the left clamp clears a source near the right, where below or the right clamp would cover it').toEqual({ x: 0, y: 0 })
    expect(at(35), 'the right clamp clears a source near the left').toEqual({ x: 60, y: 0 })
    expect(at(45), 'both side clamps clear a centred source, so the right one wins').toEqual({ x: 60, y: 0 })
    expect(at(45, 2), 'a bubble that fits beside the source is not moved').toEqual({ x: 75, y: 15 })
  })

  it('draws the leader only when it is long enough to read and never a stub between touching frames', () => {
    const leader = (at: { x: number; y: number }) => {
      const lines: string[] = []
      const context = {
        canvas: { width: 0, height: 0 }, getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), save: vi.fn(), restore: vi.fn(),
        beginPath: vi.fn(), moveTo: vi.fn((x: number, y: number) => lines.push(x + ',' + y)), lineTo: vi.fn((x: number, y: number) => lines.push(x + ',' + y)),
        stroke: vi.fn(), strokeRect: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), clip: vi.fn()
      } as unknown as CanvasRenderingContext2D
      drawScreenshotShapes(context, [createCalloutShape('l', '#ef4444', { x: 20, y: 20 }, { x: 40, y: 30 }, 2, at)])
      return lines
    }
    // At a 2x pixel ratio one image pixel is one point, so a 3 image pixel gap is 3 points.
    expect(leader({ x: 43, y: 15 }), 'a 3 point gap draws no leader').toEqual([])
    expect(leader({ x: 46, y: 15 }), 'a 6 point gap draws the leader between the facing edge midpoints').toEqual(['40,25', '46,25'])
  })

  it('hits, moves and scales a callout as one mark across its source, leader and bubble', () => {
    expect(hitTestShape([callout], { x: 120, y: 20 }, 0)?.id, 'the bubble interior').toBe(callout.id)
    expect(hitTestShape([callout], { x: 20, y: 25 }, 1)?.id, 'the source frame').toBe(callout.id)
    expect(hitTestShape([callout], { x: 70, y: 22.5 }, 1)?.id, 'the leader').toBe(callout.id)
    expect(hitTestShape([callout], { x: 30, y: 25 }, 1), 'the source interior stays free for the marks it points at').toBeNull()
    expect(hitTestShape([callout], { x: 70, y: 60 }, 1)).toBeNull()
    expect(moveShape(callout, 5, -5)).toMatchObject({ from: { x: 25, y: 15 }, to: { x: 45, y: 25 }, at: { x: 105, y: 5 }, zoom: 2 })
    expect(scaleShape(callout, 2)).toMatchObject({ from: { x: 40, y: 40 }, to: { x: 80, y: 60 }, at: { x: 200, y: 20 }, zoom: 2 })
  })

  it('resizes the callout source from its corners and its zoom proportionally from the bubble corners', () => {
    const handles = selectionHandles(callout)
    expect(handles.map(handle => handle.id)).toEqual(['nw', 'ne', 'se', 'sw', 'zoom-nw', 'zoom-ne', 'zoom-se', 'zoom-sw'])
    expect(hitSelectionHandle(callout, { x: 140, y: 30 }, 2)).toBe('zoom-se')
    expect(resizeShapeFromHandle(callout, 'se', { x: 50, y: 40 }), 'a source corner changes the region only').toMatchObject({ from: { x: 20, y: 20 }, to: { x: 50, y: 40 }, at: { x: 100, y: 10 }, zoom: 2 })
    const zoomed = resizeShapeFromHandle(callout, 'zoom-se', { x: 160, y: 25 })
    expect(zoomed, 'the larger reach sets the zoom around the fixed opposite corner').toMatchObject({ zoom: 3, at: { x: 100, y: 10 }, from: callout.from, to: callout.to })
    const fromNw = resizeShapeFromHandle(callout, 'zoom-nw', { x: 120, y: 20 })
    expect(fromNw, 'the bottom-right corner stays fixed').toMatchObject({ zoom: 1.5 })
    expect(calloutBubble(fromNw as CalloutShape)).toEqual({ x: 110, y: 15, width: 30, height: 15 })
    expect(resizeShapeFromHandle(callout, 'zoom-se', { x: 1000, y: 1000 })).toMatchObject({ zoom: 6 })
  })

  it('renumbers notes to 1..n after removal and restores the earlier numbers with one Undo', () => {
    let doc = createScreenshotDocument()
    for (const shape of [note('a', 1), blur, note('b', 2), note('c', 3)]) doc = commitShape(doc, shape)
    const removed = removeShapes(doc, new Set(['b']))
    expect(removed.shapes.filter(shape => shape.kind === 'note').map(shape => [shape.id, shape.number]), 'removing note 2 of 3 must leave 1, 2').toEqual([['a', 1], ['c', 2]])
    expect(removed.shapes[1], 'unchanged shapes keep their identity').toBe(blur)
    expect(undoShape(removed).shapes.filter(shape => shape.kind === 'note').map(shape => shape.number)).toEqual([1, 2, 3])
    expect(nextNoteNumber(removed.shapes)).toBe(3)
    expect(renumberNotes([note('late', 7), blur, note('early', 2), note('tie-b', 4), note('tie-a', 4)]).flatMap(shape => shape.kind === 'note' ? [[shape.id, shape.number]] : []),
      'explicit renumbering keeps paint order and orders by number, then id').toEqual([['late', 4], ['early', 1], ['tie-b', 3], ['tie-a', 2]])
    expect(nextNoteNumber([note('gap', 5)]), 'a gapped saved original never gets a duplicate number').toBe(6)
    expect(nextNoteNumber([])).toBe(1)
  })

  it('round trips blur, spotlight and callout through the editable original with exact fields', () => {
    const shapes: ScreenshotShape[] = [blur, spotlight, callout]
    const document = createEditableAnnotationDocument({ image, shapes, crop: null, source: null }, limits)
    expect(parseEditableAnnotationDocument(encodeEditableAnnotationDocument(document, limits), limits).shapes).toEqual(shapes)
  })

  it('rejects pointing marks with out-of-range strength, extra fields or missing geometry', () => {
    const region = { from: { x: 1, y: 1 }, to: { x: 5, y: 5 } }
    codecRejects('blur radius below 2', { id: 'b', kind: 'blur', color: '#000000', ...region, radius: 1 })
    codecRejects('blur radius above 64', { id: 'b', kind: 'blur', color: '#000000', ...region, radius: 65 })
    codecRejects('blur with a pixelation field', { id: 'b', kind: 'blur', color: '#000000', ...region, radius: 8, blockSize: 8 })
    codecRejects('spotlight dim below 0.3', { id: 's', kind: 'spotlight', color: '#ffffff', ...region, dim: 0.2 })
    codecRejects('spotlight dim above 0.85', { id: 's', kind: 'spotlight', color: '#ffffff', ...region, dim: 0.9 })
    codecRejects('spotlight without dim', { id: 's', kind: 'spotlight', color: '#ffffff', ...region })
    codecRejects('callout zoom below 1.5', { id: 'c', kind: 'callout', color: '#ef4444', ...region, at: { x: 9, y: 9 }, zoom: 1.4 })
    codecRejects('callout zoom above 6', { id: 'c', kind: 'callout', color: '#ef4444', ...region, at: { x: 9, y: 9 }, zoom: 6.5 })
    codecRejects('callout without a bubble position', { id: 'c', kind: 'callout', color: '#ef4444', ...region, zoom: 2 })
    codecRejects('callout with a spotlight field', { id: 'c', kind: 'callout', color: '#ef4444', ...region, at: { x: 9, y: 9 }, zoom: 2, dim: 0.5 })
  })
})
