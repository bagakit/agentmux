import type { BrowserPng, BrowserScreenshotCapture } from '../../../../shared/contracts'
import { screenshotCropGeometry } from './compose'
import { intersectRect, shapeBounds, screenshotOutputShapes } from './drawing-model'
import type { ScreenshotCompleteInput } from './ScreenshotEditor'

/** A description of this processed image, never a fresh read of the current tab. */
export function formatScreenshotContext(capture: BrowserScreenshotCapture, input: ScreenshotCompleteInput, output: BrowserPng): string {
  const geometry = screenshotCropGeometry(input.displayWidth, input.displayHeight, 1, input.crop)
  const scaleX = output.width / geometry.cropWidth, scaleY = output.height / geometry.cropHeight
  const annotations = screenshotOutputShapes(input.shapes, input.crop).flatMap(shape => {
    const bounds = intersectRect(shapeBounds(shape), geometry.rect)
    if (!bounds) return []
    return [{ id: shape.id, kind: shape.kind,
      ...(shape.kind === 'note' ? { number: shape.number, note: shape.note } : {}),
      originalImagePixels: bounds,
      pngPixels: { x: (bounds.x * geometry.scale - geometry.left) * scaleX, y: (bounds.y * geometry.scale - geometry.top) * scaleY,
        width: bounds.width * geometry.scale * scaleX, height: bounds.height * geometry.scale * scaleY } }]
  })
  return 'Screenshot context\n\nCoordinates refer to this processed PNG and its original captured image.\n\n' + JSON.stringify({
    browserId: capture.browserId, navigationId: capture.navigationId, source: capture.source,
    originalImagePixels: { width: capture.image.width, height: capture.image.height },
    outputPng: { width: output.width, height: output.height },
    crop: geometry.rect,
    transform: { sourceScale: geometry.scale, cropOffsetPixels: { x: geometry.left, y: geometry.top }, finalScale: { x: scaleX, y: scaleY } },
    annotations
  }, null, 2)
}
