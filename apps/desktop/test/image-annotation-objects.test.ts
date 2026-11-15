import { describe, expect, it } from 'vitest'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'
import { AnnotationDocumentError, createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import {
  alignShapes, createScreenshotDocument, distributeShapes, duplicateShapes, groupBounds, hitTestShape, moveShapes, pasteShapes,
  reorderShapes, screenshotOutputShapes, setShapes, shapeBounds, setShapesLocked, undoShape,
  type NoteShape, type RectShape, type ScreenshotShape
} from '@agentmux/client-ui/image-annotation'
import { marqueeSelection } from '@agentmux/client-ui/image-annotation'

const rect = (id: string, x: number, y: number, width: number, height: number, extra: Partial<RectShape> = {}): RectShape =>
  ({ id, kind: 'rect', color: '#ef4444', width: 2, from: { x, y }, to: { x: x + width, y: y + height }, ...extra })
const note = (id: string, number: number, x: number, y: number): NoteShape =>
  ({ id, kind: 'note', color: '#ef4444', width: 2, radius: 10, number, note: id, from: { x, y }, to: { x: x + 40, y: y + 30 } })
const cover = (id: string): ScreenshotShape => ({ id, kind: 'cover', color: '#111827', from: { x: 0, y: 0 }, to: { x: 50, y: 50 } })
const ids = (...values: string[]) => new Set(values)
const box = (shapes: readonly ScreenshotShape[], id: string) => shapeBounds(shapes.find(shape => shape.id === id)!)
const order = (shapes: readonly ScreenshotShape[]) => shapes.map(shape => shape.id)

describe('object editing model', () => {
  const scene = [rect('a', 10, 10, 20, 20), rect('b', 60, 40, 40, 10), rect('c', 30, 100, 10, 30), rect('d', 200, 200, 5, 5)]

  it('aligns every selected mark to the same edge or centre of the group bounds and leaves the rest alone', () => {
    const left = alignShapes(scene, ids('a', 'b', 'c'), 'left')
    expect(['a', 'b', 'c'].map(id => box(left, id).x)).toEqual([10, 10, 10])
    expect(left[3]).toBe(scene[3])
    const right = alignShapes(scene, ids('a', 'b', 'c'), 'right')
    expect(['a', 'b', 'c'].map(id => box(right, id).x + box(right, id).width)).toEqual([100, 100, 100])
    const center = alignShapes(scene, ids('a', 'b', 'c'), 'center')
    expect(['a', 'b', 'c'].map(id => box(center, id).x + box(center, id).width / 2)).toEqual([55, 55, 55])
    const top = alignShapes(scene, ids('a', 'b'), 'top'), bottom = alignShapes(scene, ids('a', 'b'), 'bottom'), middle = alignShapes(scene, ids('a', 'c'), 'middle')
    expect([box(top, 'a').y, box(top, 'b').y]).toEqual([10, 10])
    expect([box(bottom, 'a').y + 20, box(bottom, 'b').y + 10]).toEqual([50, 50])
    expect([box(middle, 'a').y + 10, box(middle, 'c').y + 15]).toEqual([70, 70])
    // Alignment never changes size or the other axis.
    expect([box(left, 'b').width, box(left, 'b').y]).toEqual([40, 40])
    expect(alignShapes(scene, ids('a'), 'left')).toBe(scene)
  })

  it('distributes three or more marks with equal gaps between neighbours, keeping the outermost two', () => {
    const row = [rect('a', 0, 0, 10, 10), rect('b', 15, 0, 30, 10), rect('c', 100, 0, 20, 10), rect('x', 50, 50, 5, 5)]
    const spread = distributeShapes(row, ids('a', 'b', 'c'), 'horizontal')
    const gaps = [box(spread, 'b').x - 10, box(spread, 'c').x - (box(spread, 'b').x + 30)]
    expect(gaps[0]).toBeCloseTo(30); expect(gaps[1]).toBeCloseTo(30)
    expect([box(spread, 'a').x, box(spread, 'c').x]).toEqual([0, 100])
    expect(spread[3]).toBe(row[3])
    const column = [rect('a', 0, 0, 10, 10), rect('b', 0, 80, 10, 10), rect('c', 0, 30, 10, 20)]
    const stacked = distributeShapes(column, ids('a', 'b', 'c'), 'vertical')
    expect(box(stacked, 'c').y).toBeCloseTo(35)
    expect(distributeShapes(row, ids('a', 'b'), 'horizontal')).toBe(row)
  })

  it('reorders only stacking inside a paint layer, so a mark brought to the back still paints above a mask', () => {
    const shapes = [rect('a', 0, 0, 5, 5), cover('m'), rect('b', 0, 0, 5, 5), rect('c', 0, 0, 5, 5)]
    expect(order(reorderShapes(shapes, ids('a'), 'forward'))).toEqual(['b', 'm', 'a', 'c'])
    expect(order(reorderShapes(shapes, ids('c'), 'backward'))).toEqual(['a', 'm', 'c', 'b'])
    expect(order(reorderShapes(shapes, ids('a'), 'front'))).toEqual(['b', 'm', 'c', 'a'])
    expect(order(reorderShapes(shapes, ids('c'), 'back'))).toEqual(['c', 'm', 'a', 'b'])
    expect(order(reorderShapes(shapes, ids('a', 'b'), 'forward'))).toEqual(['c', 'm', 'a', 'b'])
    expect(reorderShapes(shapes, ids('c'), 'front')).toBe(shapes)
    const output = screenshotOutputShapes(reorderShapes(shapes, ids('c'), 'back'))
    expect(output.at(-1)!.id).toBe('m')
  })

  it('duplicates with fresh ids on top, offset, and gives copied notes the next free numbers', () => {
    const shapes = [note('n1', 1, 10, 10), rect('r', 0, 0, 5, 5), note('n2', 2, 90, 90)]
    let counter = 0
    const result = duplicateShapes(shapes, ids('n1', 'r'), { x: 12, y: 12 }, () => `copy-${++counter}`)
    expect(result.ids).toEqual(['copy-1', 'copy-2'])
    expect(new Set(order(result.shapes)).size).toBe(5)
    expect(order(result.shapes).slice(-2)).toEqual(['copy-1', 'copy-2'])
    expect(result.shapes.find(shape => shape.id === 'copy-1')).toMatchObject({ kind: 'note', number: 3, from: { x: 22, y: 22 } })
    expect(box(result.shapes, 'copy-2').x).toBe(12)
    const pasted = pasteShapes(result.shapes, [shapes[0]!], { x: 0, y: 0 }, () => 'copy-3')
    expect(pasted.shapes.at(-1)).toMatchObject({ number: 4 })
  })

  it('moves a group by one delta and records no Undo step when nothing moves', () => {
    const moved = moveShapes(scene, ids('a', 'b'), 5, -5)
    expect([box(moved, 'a').x, box(moved, 'b').y]).toEqual([15, 35])
    expect(moved[2]).toBe(scene[2])
    expect(moveShapes(scene, ids('a'), 0, 0)).toBe(scene)
    const doc = setShapes(setShapes(createScreenshotDocument(), scene), moved)
    expect(undoShape(doc).shapes).toBe(scene)
    expect(groupBounds([scene[0]!, scene[1]!])).toEqual({ x: 10, y: 10, width: 90, height: 40 })
  })

  it('locks marks out of hit testing and marquee selection and unlocks them again', () => {
    const locked = setShapesLocked(scene, ids('a'), true)
    expect(locked[0]).toMatchObject({ locked: true })
    expect(locked.slice(1), 'only the listed mark changes').toEqual(scene.slice(1))
    expect(hitTestShape(locked, { x: 10, y: 20 })).toBeNull()
    expect(hitTestShape(scene, { x: 10, y: 20 })?.id).toBe('a')
    expect(marqueeSelection(locked, { x: 0, y: 0, width: 300, height: 300 })).toEqual(['b', 'c', 'd'])
    expect(marqueeSelection(scene, { x: 55, y: 35, width: 10, height: 10 })).toEqual(['b'])
    expect(setShapesLocked(locked, ids('a'), true), 'locking a locked mark records no change').toBe(locked)
    const both = setShapesLocked(locked, ids('a', 'b'), true)
    expect([both[0]!.locked, both[1]!.locked]).toEqual([true, true])
    const unlocked = setShapesLocked(both, ids('a'), false)
    expect([Object.hasOwn(unlocked[0]!, 'locked'), unlocked[1]!.locked], 'unlocking drops the field from that mark alone').toEqual([false, true])
    expect(setShapesLocked(scene, ids('a'), false), 'unlocking an unlocked mark records no change').toBe(scene)
  })

  it('round trips the lock and rejects any other value for it', () => {
    const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
    const shapes: ScreenshotShape[] = [rect('a', 0, 0, .5, .5, { locked: true }), { ...note('n', 1, .1, .1), locked: true }, rect('b', .1, .1, .2, .2)]
    const doc = createEditableAnnotationDocument({ image, shapes, crop: null, source: null }, ANNOTATION_DOCUMENT_LIMITS)
    const reopened = parseEditableAnnotationDocument(encodeEditableAnnotationDocument(doc, ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
    expect(reopened.shapes).toEqual(shapes)
    expect(Object.hasOwn(reopened.shapes[2]!, 'locked')).toBe(false)
    const raw = JSON.parse(encodeEditableAnnotationDocument(doc, ANNOTATION_DOCUMENT_LIMITS))
    raw.shapes[0].locked = false
    expect(() => parseEditableAnnotationDocument(JSON.stringify(raw), ANNOTATION_DOCUMENT_LIMITS)).toThrow(AnnotationDocumentError)
  })
})
