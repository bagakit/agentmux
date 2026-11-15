import { composeScreenshot } from '../../../src/renderer/src/components/image-annotation/compose'
import { drawScreenshotShapes } from '@agentmux/client-ui/image-annotation'
import { calloutBubble, commitShape, createAdjustShape, createBlurShape, createCalloutShape, createScreenshotDocument, createSpotlightShape, hitTestShape, withOutline, moveShape, removeShapes, replaceShape, screenshotOutputShapes, setCrop, undoShape, type CoverShape, type PixelateShape, type RegionHighlightShape, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'
import { renderCommittedLayer, renderScreenshotScene } from '@agentmux/client-ui/image-annotation'
import { resizeShapeFromHandle } from '@agentmux/client-ui/image-annotation'
import { outlineContains } from '@agentmux/client-ui/image-annotation'
import type { ImageViewport } from '@agentmux/client-ui/image-annotation'

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
  // Wand outlines: an L with a square hole. The even-odd fill is the only area a mask may change, and the editor's
  // committed preview layer and the exported PNG carry the same pixels.
  const L = [[{ x: 20, y: 20 }, { x: 20, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 55 }, { x: 50, y: 55 }, { x: 50, y: 20 }],
    // The hole turns the same way as its outer ring, so only the even-odd rule leaves it unpainted.
    [{ x: 28, y: 30 }, { x: 28, y: 45 }, { x: 40, y: 45 }, { x: 40, y: 30 }]]
  const filled = (x: number, y: number) => outlineContains(L, { x, y })
  const unchangedOutside = (target: CanvasRenderingContext2D) => {
    const after = target.getImageData(0, 0, 160, 100).data, before = context.getImageData(0, 0, 160, 100).data
    for (let y = 0; y < 100; y++) for (let x = 0; x < 160; x++) {
      if (filled(x + 0.5, y + 0.5)) continue
      const at = (y * 160 + x) * 4
      if (after[at] !== before[at] || after[at + 1] !== before[at + 1] || after[at + 2] !== before[at + 2]) return false
    }
    return true
  }
  const exportedPixels = async (shapes: ScreenshotShape[], scale: number) => {
    const png = await composeScreenshot({ image: base, shapes, displayWidth: 160, displayHeight: 100, outputScale: scale })
    const target = canvas(png.width, png.height), targetContext = target.getContext('2d')!
    targetContext.drawImage(await decode(png.dataUrl), 0, 0)
    return { png, data: targetContext.getImageData(0, 0, png.width, png.height).data }
  }
  // The editor's committed layer at one image pixel per canvas pixel: the preview the export must equal.
  const previewPixels = (shapes: ScreenshotShape[]) => {
    const layer = canvas(1, 1), view: ImageViewport = { width: 160, height: 100, dpr: 1, imageWidth: 160, imageHeight: 100, view: { scale: 1, x: 0, y: 0 } }
    renderCommittedLayer(layer, screenshotOutputShapes(shapes), view, base)
    return layer.getContext('2d')!.getImageData(0, 0, 160, 100).data
  }
  const sameAsExport = async (shapes: ScreenshotShape[]) => {
    const { png, data } = await exportedPixels(shapes, 1), preview = previewPixels(shapes)
    return png.width === 160 && png.height === 100 && data.length === preview.length && data.every((byte, index) => byte === preview[index])
  }
  const outlinedCover = withOutline<CoverShape>({ id: 'wand-cover', kind: 'cover', color: '#111827', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L)
  const outlinedPixels = withOutline<PixelateShape>({ id: 'wand-pixels', kind: 'pixelate', color: '#000', blockSize: 10, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L)
  const coverPaint = paintOutput([outlinedCover]), pixelPaint = paintOutput([outlinedPixels])

  check(coverPaint.getImageData(60, 70, 1, 1).data[0]! < 30, 'outlined cover must paint inside its fill')
  // Outside the L's notch only an unclipped mask paints; inside the hole a nonzero clip paints too.
  check(coverPaint.getImageData(75, 35, 1, 1).data.every((byte, index) => byte === context.getImageData(75, 35, 1, 1).data[index]), 'an outlined mask must leave its notch original')
  check(coverPaint.getImageData(34, 38, 1, 1).data.every((byte, index) => byte === context.getImageData(34, 38, 1, 1).data[index]), 'an outline hole must keep its original pixels')
  check(unchangedOutside(coverPaint), 'outlined cover must keep every pixel outside its even-odd fill original')
  check(unchangedOutside(pixelPaint), 'outlined pixelation must keep every pixel outside its even-odd fill original')
  check(await sameAsExport([outlinedCover]) && await sameAsExport([outlinedPixels]), 'outlined mask preview and actual exported PNG must share the same pixels')
  const notchNote: ScreenshotShape = { id: 'notch-note', kind: 'note', number: 1, note: 'under the bounds', color: '#ef4444', width: 2, radius: 4, from: { x: 75, y: 35 }, to: { x: 75, y: 35 } }
  check(!screenshotOutputShapes([notchNote, outlinedCover]).some(shape => shape.id === notchNote.id), 'outlined mask output must filter notes under its bounds')
  // At a fractional pixel ratio and view scale the outline's edges fall inside canvas pixels. Each canvas pixel the fill
  // touches must take the mask whole, exactly as the unoutlined mask over the same rect paints it, so no edge pixel
  // blends with the original. Touch is sampled on a 4 × 4 grid inside each canvas pixel.
  const fractional: ImageViewport = { width: 120, height: 80, dpr: 1.5, imageWidth: 160, imageHeight: 100, view: { scale: 0.7, x: 3.3, y: 2.6 } }
  const touched = (viewport: ImageViewport, width: number, height: number) => {
    const unit = viewport.dpr * viewport.view.scale, pixels: number[] = []
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let inside = false
      for (let sy = 0; sy < 4 && !inside; sy++) for (let sx = 0; sx < 4 && !inside; sx++)
        inside = filled((x + (sx + 0.5) / 4 - viewport.dpr * viewport.view.x) / unit, (y + (sy + 0.5) / 4 - viewport.dpr * viewport.view.y) / unit)
      if (inside) pixels.push(y * width + x)
    }
    return pixels
  }
  const sameAt = (pixels: readonly number[], a: Uint8ClampedArray, b: Uint8ClampedArray) => pixels.every(pixel => [0, 1, 2, 3].every(channel => a[pixel * 4 + channel] === b[pixel * 4 + channel]))
  const layerPixels = (shapes: ScreenshotShape[], viewport: ImageViewport) => {
    const layer = canvas(1, 1); renderCommittedLayer(layer, shapes, viewport, base)
    return { layer, data: layer.getContext('2d')!.getImageData(0, 0, layer.width, layer.height).data }
  }
  const unoutlined = <T extends CoverShape | PixelateShape>(shape: T): T => { const { outline: _outline, ...rest } = shape; return rest as T }
  const edge = touched(fractional, 180, 120)
  check(edge.length > 2000, 'the fractional view must hold the outline')
  for (const shape of [outlinedCover, outlinedPixels]) {
    check(sameAt(edge, layerPixels([shape], fractional).data, layerPixels([unoutlined(shape)], fractional).data),
      'an outlined mask must cover every device pixel an outline touches at a fractional scale: ' + shape.kind)
  }
  // The export at a fractional output scale puts the edges inside PNG pixels the same way.
  for (const shape of [outlinedCover, outlinedPixels]) {
    const outlined = await exportedPixels([shape], 1.5), plain = await exportedPixels([unoutlined(shape)], 1.5)
    const exportView: ImageViewport = { width: outlined.png.width, height: outlined.png.height, dpr: 1, imageWidth: 160, imageHeight: 100, view: { scale: 1.5, x: 0, y: 0 } }
    check(outlined.png.width === 240 && sameAt(touched(exportView, outlined.png.width, outlined.png.height), outlined.data, plain.data),
      'an outlined mask must cover every PNG pixel an outline touches at a fractional scale: ' + shape.kind)
  }
  // While ink is drawn, committed outlined masks keep their processed pixels across their whole touched area, and the
  // ink still shows in the outline's notch, which is inside the mask's rect but outside its fill.
  const committedMask = layerPixels([outlinedPixels], fractional), liveScene = canvas(1, 1)
  const liveInk: ScreenshotShape = { id: 'live-ink', kind: 'pen', color: '#ef4444', width: 14, points: [{ x: 10, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 70 }, { x: 10, y: 70 }] }
  renderScreenshotScene(liveScene, committedMask.layer, liveInk, fractional, [outlinedPixels])
  const live = liveScene.getContext('2d')!.getImageData(0, 0, liveScene.width, liveScene.height).data
  check(sameAt(edge, live, committedMask.data), 'live ink must not replace processed outlined mask pixels at a fractional scale')
  const notch = Math.round((40 * fractional.view.scale + fractional.view.y) * fractional.dpr) * liveScene.width + Math.round((75 * fractional.view.scale + fractional.view.x) * fractional.dpr)
  check(live[notch * 4]! > 200 && live[notch * 4 + 1]! < 120, "live ink must show in an outlined mask's notch")
  // Adjustments: a whole-image brightness and a region sharpen. Callouts sample the adjusted pixels, and the
  // preview equals the export.
  const brighter = createAdjustShape('bright', { x: 0, y: 0 }, { x: 160, y: 100 }, { brightness: 1.3, saturation: 0.6 })
  const sharper = withOutline(createAdjustShape('sharp', { x: 0, y: 0 }, { x: 1, y: 1 }, { sharpen: 1, contrast: 1.2 }), L)
  const dark = context.getImageData(2, 50, 1, 1).data[0]!
  check(paintOutput([brighter]).getImageData(2, 50, 1, 1).data[0]! > dark + 3, 'brightness must lift the actual dark stripe')
  check(unchangedOutside(paintOutput([sharper])), 'region adjustment must keep every pixel outside its even-odd fill original')
  check(paintOutput([sharper]).getImageData(60, 70, 4, 1).data.some((byte, index) => index % 4 < 3 && byte !== context.getImageData(60, 70, 4, 1).data[index]),
    'region adjustment must change pixels inside its fill')
  check(await sameAsExport([brighter]) && await sameAsExport([sharper]), 'adjustment preview and actual exported PNG must share the same pixels')
  // The adjusted range holds the magnifier's source but not its bubble, so only adjusted-then-magnified pixels brighten it.
  const lens = createCalloutShape('lens', '#ef4444', { x: 2, y: 50 }, { x: 10, y: 58 }, 2, { x: 100, y: 10 })
  const brighterSource = createAdjustShape('bright-source', { x: 0, y: 40 }, { x: 60, y: 100 }, { brightness: 1.3 })
  const lensRow = (target: CanvasRenderingContext2D) => target.getImageData(calloutBubble(lens).x + 6, calloutBubble(lens).y + 6, 4, 1).data.filter((_, index) => index % 4 === 0)
  const lifted = lensRow(paintOutput([lens, brighterSource])), plain = lensRow(paintOutput([lens]))
  check(lifted.every((value, index) => value >= plain[index]!) && lifted.some((value, index) => value > plain[index]!), 'callout must magnify the adjusted pixels')
  const regionHighlight = withOutline<RegionHighlightShape>({ id: 'highlight-region', kind: 'region-highlight', color: '#facc15', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, L)
  const highlighted = paintOutput([regionHighlight]), originalStripe = context.getImageData(62, 70, 1, 1).data, highlightedStripe = highlighted.getImageData(62, 70, 1, 1).data
  check(highlightedStripe[0]! > originalStripe[0]! + 30 && highlightedStripe[0]! < 200 && highlightedStripe[3] === 255,
    'region highlight must tint the source while keeping its stripe visible, never paint an opaque cover')
  check(unchangedOutside(highlighted), 'region highlight must leave its hole, notch and every outside pixel unchanged')
  check(await sameAsExport([regionHighlight]), 'region highlight preview and exported PNG must share the same pixels')

  return { passed: true, pointing: ['blur-stripe-contrast', 'blur-outside-untouched', 'blur-edge-opacity', 'spotlight-after-masks', 'callout-enlarges-source', 'callout-masked-preview', 'callout-masked-PNG'],
    wand: ['outline-cover-inside', 'outline-notch', 'outline-cover-outside', 'outline-pixelate-outside', 'outline-hole', 'outline-PNG-equality', 'outline-note-filter',
      'outline-fractional-preview-opacity', 'outline-fractional-PNG-opacity', 'outline-live-ink-protection', 'outline-live-ink-notch', 'adjust-brightness', 'adjust-region-outside', 'adjust-region-inside', 'adjust-PNG-equality', 'adjust-under-callout', 'highlight-translucent-tint', 'highlight-outside-and-holes', 'highlight-PNG-equality'], cases: ['actual-pixel-blocks', 'crop-dimensions', 'preview-export-pixel-equality', 'outside-scaled-pixelation', 'identity-move-erase-undo', 'ellipse-ink-distance', 'pixelation-failure',
    'cover-note-filtering', 'fractional-cover-opacity', 'live-ink-mask-protection', 'viewport-bounded-high-zoom', 'tiny-pixelate-sample-bounds', 'actual-resized-ink', 'processed-PNG-cover-opacity'],
    enhancements: ['brush-corridor-pixels', 'brush-preview-PNG-equality', 'live-brush-mask-protection', 'multiline-raster'],
    pixelCount: a.length / 4, viewportAllocation: { width: scene.width, height: scene.height, scale: highZoom.view.scale }, png: brushedPng }
})().catch(error => ({ passed: false, failure: String(error) }))
