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
