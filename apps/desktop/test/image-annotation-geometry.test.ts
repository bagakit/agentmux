import { describe, expect, it } from 'vitest'
import { commitShape, createScreenshotDocument, replaceShape, screenshotOutputShapes, undoShape, type ScreenshotShape } from '../src/renderer/src/components/image-annotation/drawing-model'
import { hitSelectionHandle, resizeShapeFromHandle, selectionHandles } from '../src/renderer/src/components/image-annotation/selection-geometry'

const rectangle: ScreenshotShape = { id: 'original-rectangle', kind: 'rect', color: '#ef4444', width: 4, from: { x: 80, y: 60 }, to: { x: 20, y: 10 } }

describe('Image annotation selection geometry', () => {
  it('exposes four corners in image pixels even when the original endpoints are reversed', () => {
    expect(selectionHandles(rectangle)).toEqual([
      { id: 'nw', point: { x: 20, y: 10 } }, { id: 'ne', point: { x: 80, y: 10 } },
      { id: 'se', point: { x: 80, y: 60 } }, { id: 'sw', point: { x: 20, y: 60 } }
    ])
    expect(selectionHandles({ ...rectangle, kind: 'ellipse' })).toEqual(selectionHandles(rectangle))
  })

  it('resizes from the original gesture across the opposite corner without accumulating samples or changing identity', () => {
    const crossed = resizeShapeFromHandle(rectangle, 'nw', { x: 100, y: 90 })
    expect(crossed).toEqual({ ...rectangle, from: { x: 80, y: 60 }, to: { x: 100, y: 90 } })
    const returned = resizeShapeFromHandle(rectangle, 'nw', { x: 0, y: 0 })
    expect(returned).toEqual({ ...rectangle, from: { x: 80, y: 60 }, to: { x: 0, y: 0 } })
    expect(rectangle.from).toEqual({ x: 80, y: 60 }); expect(rectangle.to).toEqual({ x: 20, y: 10 })
  })

  it('edits one arrow endpoint and undoes the complete geometry while retaining the other object and crop', () => {
    const arrow: ScreenshotShape = { id: 'original-arrow', kind: 'arrow', color: '#22c55e', width: 8, from: { x: 15, y: 25 }, to: { x: 110, y: 95 } }
    expect(selectionHandles(arrow)).toEqual([{ id: 'from', point: arrow.from }, { id: 'to', point: arrow.to }])
    const resized = resizeShapeFromHandle(arrow, 'to', { x: 160, y: 70 })
    expect(resized).toEqual({ ...arrow, to: { x: 160, y: 70 } })
    const before = { ...commitShape(commitShape(createScreenshotDocument(), arrow), rectangle), crop: { x: 5, y: 10, width: 180, height: 100 } }
    const after = replaceShape(before, resized)
    expect(after.shapes).toEqual([resized, rectangle]); expect(after.shapes[1]).toBe(rectangle)
    expect(undoShape(after)).toMatchObject({ shapes: [arrow, rectangle], crop: before.crop })
  })

  it('chooses the nearest handle and respects the caller image-space tolerance instead of the whole shape bounds', () => {
    const small: ScreenshotShape = { ...rectangle, from: { x: 10, y: 10 }, to: { x: 14, y: 14 } }
    expect(hitSelectionHandle(small, { x: 13, y: 10 }, 4)).toBe('ne')
    expect(hitSelectionHandle(small, { x: 6, y: 10 }, 4)).toBe('nw')
    expect(hitSelectionHandle(small, { x: 6, y: 10 }, 3.9)).toBeNull()
    expect(hitSelectionHandle(rectangle, { x: 50, y: 35 }, 6)).toBeNull()
  })

  it('preserves numbered-note text, template, anchor role and style while changing a selected corner', () => {
    const note: ScreenshotShape = { id: 'original-note', kind: 'note', color: '#3b82f6', width: 2, radius: 12, number: 3,
      note: 'Keep the user text', template: 'expected', from: { x: 20, y: 30 }, to: { x: 90, y: 80 } }
    const next = resizeShapeFromHandle(note, 'se', { x: 120, y: 110 })
    expect(next).toEqual({ ...note, to: { x: 120, y: 110 } })
    const point = { id: 'original-text', kind: 'text', color: '#000', at: { x: 30, y: 20 }, text: 'Existing text', fontSize: 18 } as const
    expect(selectionHandles(point)).toEqual([])
    expect(resizeShapeFromHandle(point, 'nw', { x: 0, y: 0 })).toBe(point)
  })

  it('orders cover and pixelate after ordinary ink and excludes covered or crop-away note payloads', () => {
    const visible: ScreenshotShape = { id: 'visible', kind: 'note', color: '#f00', width: 2, radius: 5, number: 1, note: 'Retained note', template: 'request', from: { x: 20, y: 20 }, to: { x: 35, y: 35 } }
    const hidden: ScreenshotShape = { ...visible, id: 'covered', number: 2, note: 'COVERED_NOTE_MUST_NOT_LEAK', from: { x: 80, y: 50 }, to: { x: 110, y: 70 } }
    const outside: ScreenshotShape = { ...visible, id: 'outside', number: 3, note: 'CROP_AWAY_NOTE_MUST_NOT_LEAK', from: { x: 140, y: 120 }, to: { x: 160, y: 140 } }
    const cover: ScreenshotShape = { id: 'cover', kind: 'cover', color: '#ff000080', from: { x: 75, y: 40 }, to: { x: 115, y: 75 } }
    const pixels: ScreenshotShape = { id: 'pixelate', kind: 'pixelate', color: '#000', blockSize: 16, from: { x: 150, y: 20 }, to: { x: 170, y: 40 } }
    const output = screenshotOutputShapes([cover, hidden, visible, pixels, outside, rectangle], { x: 0, y: 0, width: 120, height: 100 })
    expect(output.map(shape => shape.id)).toEqual(['visible', 'original-rectangle', 'cover', 'pixelate'])
    expect(JSON.stringify(output)).not.toContain('COVERED_NOTE_MUST_NOT_LEAK')
    expect(JSON.stringify(output)).not.toContain('CROP_AWAY_NOTE_MUST_NOT_LEAK')
    expect(resizeShapeFromHandle(cover, 'se', { x: 130, y: 90 })).toEqual({ ...cover, to: { x: 130, y: 90 } })
  })
})
