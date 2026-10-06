import type { ScreenshotPoint } from './drawing-model'

export type AnnotationView = { scale: number; x: number; y: number }
export type ImageViewport = {
  width: number; height: number; dpr: number
  imageWidth: number; imageHeight: number
  view: AnnotationView
}

export function fitImageView(width: number, height: number, imageWidth: number, imageHeight: number): AnnotationView {
  const scale = Math.min(width / imageWidth, height / imageHeight)
  return { scale, x: (width - imageWidth * scale) / 2, y: (height - imageHeight * scale) / 2 }
}

export function imagePoint(view: AnnotationView, point: ScreenshotPoint): ScreenshotPoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

/** Keep the exact image point under the cursor when changing magnification. */
export function zoomImageView(view: AnnotationView, scale: number, anchor: ScreenshotPoint): AnnotationView {
  const point = imagePoint(view, anchor)
  return { scale, x: anchor.x - point.x * scale, y: anchor.y - point.y * scale }
}
