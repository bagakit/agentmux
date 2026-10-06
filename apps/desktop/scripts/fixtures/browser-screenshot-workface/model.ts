import { composeScreenshot } from '../../../src/renderer/src/components/browser-screenshot/compose'
import { drawScreenshotShapes } from '../../../src/renderer/src/components/browser-screenshot/drawing-renderer'
import { commitShape, createScreenshotDocument, hitTestShape, moveShape, removeShapes, replaceShape, setCrop, undoShape, type ScreenshotShape } from '../../../src/renderer/src/components/browser-screenshot/drawing-model'

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function canvas(width: number, height: number) {
  const element = document.createElement('canvas'); element.width = width; element.height = height
  return element
}
async function decode(dataUrl: string) {
  const image = new Image(); image.src = dataUrl; await image.decode(); return image
}
(window as any).modelProof = (async () => {
  const base = canvas(160, 100), context = base.getContext('2d')!
  for (let x = 0; x < 160; x += 2) { context.fillStyle = x % 4 ? '#142736' : '#e8f4f7'; context.fillRect(x, 0, 2, 100) }
  const pixels: ScreenshotShape = { id: 'mask', kind: 'pixelate', color: '#000', blockSize: 10, from: { x: 20, y: 20 }, to: { x: 70, y: 70 } }
  const note: ScreenshotShape = { id: 'note', kind: 'note', number: 1, note: '检查这一处', color: '#ef4444', width: 2, radius: 10, from: { x: 95, y: 30 }, to: { x: 130, y: 75 } }
  const shapes = [pixels, note]
  const preview = canvas(160, 100), paint = preview.getContext('2d')!
  paint.drawImage(base, 0, 0); drawScreenshotShapes(paint, shapes)
  const original = context.getImageData(23, 25, 1, 1).data, treated = paint.getImageData(23, 25, 1, 1).data
  check(original.some((byte, index) => byte !== treated[index]), 'pixelate must change the actual base image pixels')
  check(paint.getImageData(24, 25, 1, 1).data.every((byte, index) => byte === treated[index]), 'pixelate must make a constant block')
  const crop = { x: 10, y: 15, width: 130, height: 70 }
  const encoded = await composeScreenshot({ image: base, shapes, crop, displayWidth: 160, displayHeight: 100, outputScale: 1 })
  check(encoded.width === 130 && encoded.height === 70, 'crop must change final PNG dimensions')
  const final = canvas(encoded.width, encoded.height), exported = final.getContext('2d')!
  exported.drawImage(await decode(encoded.dataUrl), 0, 0)
  const a = paint.getImageData(crop.x, crop.y, crop.width, crop.height).data
  const b = exported.getImageData(0, 0, crop.width, crop.height).data
  check(a.length === b.length && a.every((byte, index) => byte === b[index]), 'preview and cropped PNG must have identical actual pixels')
  // Captured pointers and later moves can leave the image: only painted source dimensions
  // decide the block count, even under a scaled Canvas transform.
  for (const scale of [1, 2]) {
    const outside = canvas(160 * scale, 100 * scale), clipped = outside.getContext('2d')!
    clipped.scale(scale, scale); clipped.drawImage(base, 0, 0)
    drawScreenshotShapes(clipped, [{ ...pixels, from: { x: -1000, y: -1000 }, to: { x: 160, y: 100 } }])
    const c = clipped.getImageData(23 * scale, 25 * scale, 1, 1).data
    const d = clipped.getImageData(24 * scale, 25 * scale, 1, 1).data
    check(c.every((byte, index) => byte === d[index]), 'clipped pixelation must retain blocks under scale ' + scale)
  }
  let doc = setCrop(commitShape(commitShape(createScreenshotDocument(), pixels), note), crop)
  const moved = moveShape(note, 5, 8)
  check(moved.kind === 'note' && moved.from.x === 100 && moved.from.y === 38 && moved.id === note.id, 'move must preserve the selected identity and translate geometry')
  doc = replaceShape(doc, moved)
  check(hitTestShape(doc.shapes, { x: 100, y: 38 }, 1)?.id === note.id, 'hit test must consume the moved numbered marker')
  check(undoShape(removeShapes(doc, new Set([note.id]))).shapes.length === 2, 'erase undo must restore the original annotations')
  check(undoShape(doc).crop === crop, 'move undo must keep crop in the same snapshot')
  check(hitTestShape([{ id: 'long', kind: 'ellipse', color: '#f00', width: 4, from: { x: 0, y: 0 }, to: { x: 2000, y: 100 } }], { x: 1840, y: 50 }, 6) === null,
    'elongated ellipse interiors are not actual ink hits')
  const nativeGetContext = HTMLCanvasElement.prototype.getContext
  try {
    HTMLCanvasElement.prototype.getContext = function (...args: any[]) { return this === preview ? nativeGetContext.apply(this, args as any) : null } as any
    let failure = ''
    try { drawScreenshotShapes(paint, [pixels]) } catch (error) { failure = String(error) }
    check(failure.includes('pixelation requires'), 'failed pixelation sampling must never silently export the untreated base')
  } finally { HTMLCanvasElement.prototype.getContext = nativeGetContext }
  return { passed: true, cases: ['actual-pixel-blocks', 'crop-dimensions', 'preview-export-pixel-equality', 'outside-scaled-pixelation', 'identity-move-erase-undo', 'ellipse-ink-distance', 'pixelation-failure'], pixelCount: a.length / 4, png: encoded }
})().catch(error => ({ passed: false, failure: String(error) }))
