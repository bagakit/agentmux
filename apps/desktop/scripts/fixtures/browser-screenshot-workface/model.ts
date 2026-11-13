import { composeScreenshot } from '../../../src/renderer/src/components/image-annotation/compose'
import { drawScreenshotShapes } from '../../../src/renderer/src/components/image-annotation/drawing-renderer'
import { calloutBubble, commitShape, createBlurShape, createCalloutShape, createScreenshotDocument, createSpotlightShape, hitTestShape, moveShape, removeShapes, replaceShape, screenshotOutputShapes, setCrop, undoShape, type ScreenshotShape } from '../../../src/renderer/src/components/image-annotation/drawing-model'
import { renderCommittedLayer, renderScreenshotScene } from '../../../src/renderer/src/components/image-annotation/canvas-render'
import { resizeShapeFromHandle } from '../../../src/renderer/src/components/image-annotation/selection-geometry'
import type { ImageViewport } from '../../../src/renderer/src/components/image-annotation/view'

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
  const cover: ScreenshotShape = { id: 'opaque-cover', kind: 'cover', color: '#ff000000', from: { x: 30.25, y: 20.1 }, to: { x: 45.4, y: 40.2 } }
  const coveredNote: ScreenshotShape = { ...note, id: 'hidden-note', note: 'COVERED_CONTEXT_MUST_NOT_LEAK', template: 'expected', from: { x: 33, y: 24 }, to: { x: 40, y: 32 } }
  const output = screenshotOutputShapes([coveredNote, pixels, cover], null)
  check(output.map(shape => shape.id).join(',') === 'mask,opaque-cover', 'cover output must omit masked note data and paint masks last')
  const viewport: ImageViewport = { width: 200, height: 120, dpr: 2, imageWidth: 160, imageHeight: 100, view: { scale: 1.25, x: 10.5, y: 6.25 } }
  const committed = canvas(1, 1), scene = canvas(1, 1)
  renderCommittedLayer(committed, output, viewport, base)
  renderScreenshotScene(scene, committed, null, viewport, output)
  check(committed.width === 400 && committed.height === 240 && scene.width === 400 && scene.height === 240,
    'viewport allocation must use visible area and DPR')
  const covered = committed.getContext('2d')!, coverLeft = Math.floor((10.5 + 30.25 * 1.25) * 2), coverTop = Math.floor((6.25 + 20.1 * 1.25) * 2)
  const coverRight = Math.ceil((10.5 + 45.4 * 1.25) * 2), coverBottom = Math.ceil((6.25 + 40.2 * 1.25) * 2)
  const coveredPixels = covered.getImageData(coverLeft, coverTop, coverRight - coverLeft, coverBottom - coverTop).data
  check(coveredPixels.length > 100 && coveredPixels.every((byte, index) => byte === [17, 24, 39, 255][index % 4]),
    'fractional cover must be opaque through every outward-rounded device pixel regardless of loaded color')
  const crossing: ScreenshotShape = { id: 'new-ink', kind: 'pen', color: '#ef4444', width: 12, points: [{ x: 15, y: 30 }, { x: 100, y: 30 }] }
  renderScreenshotScene(scene, committed, crossing, viewport, output)
  const protectedPixels = scene.getContext('2d')!.getImageData(coverLeft, coverTop, coverRight - coverLeft, coverBottom - coverTop).data
  check(protectedPixels.every((byte, index) => byte === coveredPixels[index]), 'live ink must not replace processed cover pixels')
  const masks = output.filter(shape => shape.kind === 'cover' || shape.kind === 'pixelate')
  const maskedBefore = covered.getImageData(148, 80, 25, 15).data
  const maskedDuring = scene.getContext('2d')!.getImageData(148, 80, 25, 15).data
  check(maskedBefore.every((byte, index) => byte === maskedDuring[index]), 'live ink must not replace processed pixelation pixels')
  const highZoom = { ...viewport, view: { scale: 8, x: -150, y: -100 } }
  renderCommittedLayer(committed, masks, highZoom, base); renderScreenshotScene(scene, committed, crossing, highZoom, masks)
  check(committed.width === 400 && committed.height === 240 && scene.width === 400 && scene.height === 240,
    'high zoom must not allocate a full magnified image bitmap')
  const createdSamples: HTMLCanvasElement[] = [], nativeCreateElement = document.createElement.bind(document)
  try {
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const element = nativeCreateElement(tag, options)
      if (tag === 'canvas') createdSamples.push(element as HTMLCanvasElement)
      return element
    }) as typeof document.createElement
    renderCommittedLayer(committed, [{ ...pixels, blockSize: 1e-300 }], highZoom, base)
  } finally { document.createElement = nativeCreateElement }
  check(createdSamples.length === 1 && createdSamples.every(sample => sample.width > 0 && sample.height > 0 && sample.width <= 400 && sample.height <= 240),
    'tiny pixelation blocks must retain a finite viewport-bounded actual sampling canvas')
  const originalRectangle: ScreenshotShape = { id: 'resizable', kind: 'rect', color: '#ef4444', width: 2, from: { x: 10, y: 10 }, to: { x: 40, y: 30 } }
  const resized = resizeShapeFromHandle(originalRectangle, 'se', { x: 80, y: 60 })
  const geometry = canvas(160, 100), geometryContext = geometry.getContext('2d')!
  drawScreenshotShapes(geometryContext, [resized])
  check(geometryContext.getImageData(80, 40, 1, 1).data[3] > 200 && geometryContext.getImageData(40, 20, 1, 1).data[3] === 0,
    'resized geometry must move actual ink to the new selected corner')
  const coveredPng = await composeScreenshot({ image: base, shapes: [coveredNote, cover], displayWidth: 160, displayHeight: 100, outputScale: 1 })
  const decodedCover = canvas(160, 100), decodedCoverContext = decodedCover.getContext('2d')!
  decodedCoverContext.drawImage(await decode(coveredPng.dataUrl), 0, 0)
  check(decodedCoverContext.getImageData(32, 25, 8, 8).data.every((byte, index) => byte === [17, 24, 39, 255][index % 4]),
    'processed PNG must contain actual opaque cover pixels')
  const brush: ScreenshotShape = { id: 'brush', kind: 'pixelate-brush', color: '#000', width: 18, blockSize: 10,
    points: [{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 80 }] }
  const brushed = canvas(160, 100), brushedContext = brushed.getContext('2d')!
  brushedContext.drawImage(base, 0, 0); drawScreenshotShapes(brushedContext, [brush])
  const brushInside = brushedContext.getImageData(24, 20, 1, 1).data, brushOutside = brushedContext.getImageData(20, 45, 80, 30).data
  check(brushInside.some((byte, index) => byte !== context.getImageData(24, 20, 1, 1).data[index]), 'brush pixelation must change actual corridor pixels')
  const originalOutside = context.getImageData(20, 45, 80, 30).data
  check(brushOutside.every((byte, index) => byte === originalOutside[index]), 'brush pixelation must preserve the empty corridor bounding box')
  const brushedPng = await composeScreenshot({ image: base, shapes: [brush], displayWidth: 160, displayHeight: 100, outputScale: 1 })
  const brushExport = canvas(160, 100), brushExportContext = brushExport.getContext('2d')!
  brushExportContext.drawImage(await decode(brushedPng.dataUrl), 0, 0)
  const brushPreviewPixels = brushedContext.getImageData(0, 0, 160, 100).data
  check(brushExportContext.getImageData(0, 0, 160, 100).data.every((byte, index) => byte === brushPreviewPixels[index]), 'brush preview and actual exported PNG must share the same processed pixels')
  const brushView: ImageViewport = { width: 160, height: 100, dpr: 1, imageWidth: 160, imageHeight: 100, view: { scale: 1, x: 0, y: 0 } }
  renderCommittedLayer(committed, [brush], brushView, base)
  renderScreenshotScene(scene, committed, { ...crossing, points: [{ x: 10, y: 20 }, { x: 150, y: 20 }] }, brushView, [brush])
  check(scene.getContext('2d')!.getImageData(30, 20, 10, 1).data.every((byte, index) => byte === committed.getContext('2d')!.getImageData(30, 20, 10, 1).data[index]),
    'live ink must not reveal or repaint committed brush pixels')
  const multiline = canvas(160, 100), multilineContext = multiline.getContext('2d')!
  drawScreenshotShapes(multilineContext, [{ id: 'multiline', kind: 'text', color: '#ef4444', fontSize: 20, at: { x: 10, y: 8 }, text: 'First\nSecond' }])
  check(multilineContext.getImageData(8, 32, 110, 25).data.some((byte, index) => index % 4 === 3 && byte > 200), 'multiline text must paint its actual second line')
  // Pointing marks consume the same output order and painted pixels as the PNG.
  const paintOutput = (shapes: ScreenshotShape[]) => {
    const target = canvas(160, 100), paintContext = target.getContext('2d')!
    paintContext.drawImage(base, 0, 0); drawScreenshotShapes(paintContext, screenshotOutputShapes(shapes))
    return paintContext
  }
  const blurred = paintOutput([createBlurShape('blur', '#000', { x: 20, y: 20 }, { x: 70, y: 70 }, 6)])
  const stripe = (target: CanvasRenderingContext2D, x: number) => Array.from({ length: 4 }, (_, offset) => target.getImageData(x + offset, 45, 1, 1).data[0]!)
  const sharp = stripe(context, 40), soft = stripe(blurred, 40)
  check(Math.max(...sharp) - Math.min(...sharp) > 150 && Math.max(...soft) - Math.min(...soft) < 40, 'blur must remove the actual stripe contrast inside its region')
  check(stripe(blurred, 100).every((value, index) => value === stripe(context, 100)[index]), 'blur must leave pixels outside its region untouched')
  check(blurred.getImageData(20, 20, 50, 50).data.every((byte, index) => index % 4 !== 3 || byte === 255), 'blur must keep every edge pixel opaque')
  const under = { x: 30, y: 30, width: 20, height: 20 }
  const dimmed = paintOutput([createSpotlightShape('spot', '#fff', { x: 100, y: 20 }, { x: 140, y: 60 }, 0.6),
    { id: 'cover-out', kind: 'cover', color: '#111827', from: { x: under.x, y: under.y }, to: { x: under.x + under.width, y: under.y + under.height } }])
  const coverOutside = dimmed.getImageData(40, 40, 1, 1).data
  check(coverOutside[0]! < 17 && coverOutside[1]! < 24 && coverOutside[2]! < 39, 'spotlight must dim masks outside it after they paint')
  check(dimmed.getImageData(120, 40, 1, 1).data[0] === context.getImageData(120, 40, 1, 1).data[0], 'spotlight must keep its region at original brightness')
  check(dimmed.getImageData(5, 5, 1, 1).data[0]! < context.getImageData(5, 5, 1, 1).data[0]! || context.getImageData(5, 5, 1, 1).data[0] === 0,
    'spotlight must darken ordinary pixels outside its region')
  const zoom = createCalloutShape('zoom', '#ef4444', { x: 20, y: 20 }, { x: 40, y: 40 }, 2, { x: 90, y: 30 })
  const zoomedMask: ScreenshotShape = { id: 'zoom-mask', kind: 'pixelate', color: '#000', blockSize: 10, from: { x: 20, y: 20 }, to: { x: 40, y: 40 } }
  const bubble = calloutBubble(zoom), inner = { x: bubble.x + 6, y: bubble.y + 6, width: bubble.width - 12, height: bubble.height - 12 }
  const masked = paintOutput([zoom, zoomedMask]), unmasked = paintOutput([zoom])
  const blockSpread = (target: CanvasRenderingContext2D) => {
    const row = target.getImageData(inner.x, inner.y + 4, 8, 1).data
    const reds = Array.from({ length: 8 }, (_, index) => row[index * 4]!)
    return Math.max(...reds) - Math.min(...reds)
  }
  check(blockSpread(unmasked) > 120, 'callout must enlarge the actual source stripes')
  check(blockSpread(masked) < 40, 'callout bubble must show the pixelated pixels, never the original under a mask')
  const zoomPng = await composeScreenshot({ image: base, shapes: [zoom, zoomedMask], displayWidth: 160, displayHeight: 100, outputScale: 1 })
  const zoomExport = canvas(160, 100), zoomExportContext = zoomExport.getContext('2d')!
  zoomExportContext.drawImage(await decode(zoomPng.dataUrl), 0, 0)
  check(blockSpread(zoomExportContext) < 40, 'exported callout bubble must show the pixelated pixels, never the original under a mask')
  return { passed: true, pointing: ['blur-stripe-contrast', 'blur-outside-untouched', 'blur-edge-opacity', 'spotlight-after-masks', 'callout-enlarges-source', 'callout-masked-preview', 'callout-masked-PNG'], cases: ['actual-pixel-blocks', 'crop-dimensions', 'preview-export-pixel-equality', 'outside-scaled-pixelation', 'identity-move-erase-undo', 'ellipse-ink-distance', 'pixelation-failure',
    'cover-note-filtering', 'fractional-cover-opacity', 'live-ink-mask-protection', 'viewport-bounded-high-zoom', 'tiny-pixelate-sample-bounds', 'actual-resized-ink', 'processed-PNG-cover-opacity'],
    enhancements: ['brush-corridor-pixels', 'brush-preview-PNG-equality', 'live-brush-mask-protection', 'multiline-raster'],
    pixelCount: a.length / 4, viewportAllocation: { width: scene.width, height: scene.height, scale: highZoom.view.scale }, png: brushedPng }
})().catch(error => ({ passed: false, failure: String(error) }))
