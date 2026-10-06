import { describe, expect, it, vi } from 'vitest'
import {
  arrowHeadGeometry,
  canRedo,
  canUndo,
  clearShapes,
  commitShape,
  createScreenshotDocument,
  normalizeRect,
  redoShape,
  scaleShape,
  setCrop,
  replaceShape,
  removeShapes,
  moveShape,
  hitTestShape,
  shapeBounds,
  intersectRect,
  screenshotOutputShapes,
  undoShape,
  type ScreenshotShape
} from '../src/renderer/src/components/browser-screenshot/drawing-model.js'
import { drawScreenshotShapes } from '../src/renderer/src/components/browser-screenshot/drawing-renderer.js'

function shape(id: string): ScreenshotShape {
  return {
    id,
    kind: 'rect',
    color: '#ef4444',
    width: 4,
    from: { x: 8, y: 12 },
    to: { x: 2, y: 4 }
  }
}

function drawingContext() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    ellipse: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textBaseline: 'alphabetic'
  }
}

describe('Browser screenshot drawing model', () => {
  it('selects actual ink in reverse paint order and moves exactly that object with undo', () => {
    const line: ScreenshotShape = { id: 'line', kind: 'pen', color: '#f00', width: 2, points: [{ x: 10, y: 10 }, { x: 50, y: 50 }] }
    const box: ScreenshotShape = { id: 'box', kind: 'rect', color: '#f00', width: 2, from: { x: 5, y: 5 }, to: { x: 55, y: 55 } }
    expect(hitTestShape([line, box], { x: 30, y: 30 }, 1)?.id).toBe('line')
    expect(hitTestShape([line, box], { x: 30, y: 5 }, 1)?.id).toBe('box')
    expect(hitTestShape([line, box], { x: 10, y: 40 }, 1)).toBeNull()
    const doc = commitShape(commitShape(createScreenshotDocument(), line), box)
    const moved = replaceShape(doc, moveShape(line, 8, 12))
    expect(moved.shapes[0]).toMatchObject({ id: 'line', points: [{ x: 18, y: 22 }, { x: 58, y: 62 }] })
    expect(moved.shapes[1]).toBe(box)
    expect(undoShape(moved).shapes).toEqual(doc.shapes)
    const erased = removeShapes(moved, new Set(['line']))
    expect(erased.shapes).toEqual([box])
    expect(undoShape(erased).shapes).toEqual(moved.shapes)
    expect(removeShapes(doc, new Set(['missing']))).toBe(doc)
  })

  it('keeps crop and editable image annotations together in the same reversible snapshot', () => {
    const first = commitShape(createScreenshotDocument(), shape('first'))
    const cropped = setCrop(first, { x: 3, y: 4, width: 80, height: 60 })
    const edited = replaceShape(cropped, moveShape(shape('first'), 20, 10))
    expect(undoShape(edited)).toMatchObject({ shapes: cropped.shapes, crop: cropped.crop, past: cropped.past })
    expect(undoShape(cropped)).toMatchObject({ shapes: first.shapes, crop: first.crop, past: first.past })
    expect(redoShape(undoShape(cropped))).toEqual(cropped)
    expect(clearShapes(edited)).toMatchObject({ shapes: [], crop: null })
    expect(undoShape(clearShapes(edited))).toMatchObject({ shapes: edited.shapes, crop: edited.crop, past: edited.past })
    expect(intersectRect({ x: -3, y: 4, width: 8, height: 7 }, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ x: 0, y: 4, width: 5, height: 6 })
  })

  it('scales numbered regions and pixel blocks consistently without mutating their identities or notes', () => {
    const note: ScreenshotShape = { id: 'note', kind: 'note', number: 2, note: '检查此处', radius: 12, width: 2, color: '#f00', from: { x: 20, y: 20 }, to: { x: 70, y: 60 } }
    expect(scaleShape(note, 0.5)).toMatchObject({ id: 'note', number: 2, note: '检查此处', radius: 6, from: { x: 10, y: 10 }, to: { x: 35, y: 30 } })
    expect(hitTestShape([note], { x: 20, y: 20 }, 1)?.id).toBe('note')
    expect(shapeBounds(note)).toEqual({ x: 8, y: 8, width: 62, height: 52 })
    expect(scaleShape({ id: 'pixels', kind: 'pixelate', color: '#000', from: { x: 1, y: 2 }, to: { x: 9, y: 10 }, blockSize: 8 }, 2)).toMatchObject({ id: 'pixels', from: { x: 2, y: 4 }, to: { x: 18, y: 20 }, blockSize: 16 })
    const mask: ScreenshotShape = { id: 'mask', kind: 'pixelate', color: '#000', blockSize: 8, from: { x: 15, y: 15 }, to: { x: 25, y: 25 } }
    expect(screenshotOutputShapes([mask, note])).toEqual([mask])
    expect(screenshotOutputShapes([note], { x: 30, y: 10, width: 50, height: 70 })).toEqual([])
    expect(screenshotOutputShapes([note], { x: 10, y: 10, width: 80, height: 70 })).toEqual([note])
  })
  it('keeps undo, redo, clear, and divergent edits deterministic', () => {
    const first = commitShape(createScreenshotDocument(), shape('first'))
    const second = commitShape(first, shape('second'))

    expect(second.shapes.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(canUndo(second)).toBe(true)
    const undone = undoShape(second)
    expect(undone.shapes.map(({ id }) => id)).toEqual(['first'])
    expect(canRedo(undone)).toBe(true)
    expect(redoShape(undone)).toEqual(second)

    const divergent = commitShape(undone, shape('replacement'))
    expect(divergent.shapes.map(({ id }) => id)).toEqual(['first', 'replacement'])
    expect(canRedo(divergent)).toBe(false)
    expect(undoShape(clearShapes(divergent)).shapes).toEqual(divergent.shapes)
  })

  it('normalizes and scales geometry without changing shape identity', () => {
    expect(normalizeRect({ x: 8, y: 12 }, { x: 2, y: 4 })).toEqual({
      x: 2,
      y: 4,
      width: 6,
      height: 8
    })
    expect(scaleShape(shape('rect'), 2)).toEqual({
      ...shape('rect'),
      width: 8,
      from: { x: 16, y: 24 },
      to: { x: 4, y: 8 }
    })
    expect(scaleShape({
      id: 'text',
      kind: 'text',
      color: '#fff',
      at: { x: 3, y: 5 },
      text: 'note',
      fontSize: 18
    }, 1.5)).toMatchObject({ id: 'text', at: { x: 4.5, y: 7.5 }, fontSize: 27 })
    expect(arrowHeadGeometry({ x: 1, y: 1 }, { x: 1, y: 1 }, 4)).toBeNull()
    expect(arrowHeadGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)?.tip).toEqual({ x: 10, y: 0 })
  })

  it('dispatches every public markup shape to the canvas primitives', () => {
    const context = drawingContext()
    drawScreenshotShapes(context as unknown as CanvasRenderingContext2D, [
      { id: 'pen', kind: 'pen', color: '#f00', width: 2, points: [{ x: 1, y: 2 }] },
      { id: 'highlight', kind: 'highlight', color: '#ff0', width: 4, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      { id: 'arrow', kind: 'arrow', color: '#0f0', width: 2, from: { x: 1, y: 2 }, to: { x: 8, y: 9 } },
      shape('rect'),
      { id: 'ellipse', kind: 'ellipse', color: '#00f', width: 2, from: { x: 1, y: 2 }, to: { x: 8, y: 9 } },
      { id: 'text', kind: 'text', color: '#fff', at: { x: 3, y: 4 }, text: 'note', fontSize: 18 }
    ])

    expect(context.save).toHaveBeenCalledTimes(6)
    expect(context.restore).toHaveBeenCalledTimes(6)
    expect(context.arc).toHaveBeenCalled()
    expect(context.strokeRect).toHaveBeenCalledWith(2, 4, 6, 8)
    expect(context.ellipse).toHaveBeenCalled()
    expect(context.strokeText).toHaveBeenCalledWith('note', 3, 4)
    expect(context.fillText).toHaveBeenCalledWith('note', 3, 4)
  })
})
