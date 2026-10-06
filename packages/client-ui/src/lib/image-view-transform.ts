export type ImageViewTransform = { scale: number; x: number; y: number }
export type ImageViewGeometry = { width: number; height: number; naturalWidth: number; naturalHeight: number }

export const FIT_IMAGE: ImageViewTransform = { scale: 1, x: 0, y: 0 }

export function imageViewSize(geometry: ImageViewGeometry) {
  const { width, height, naturalWidth, naturalHeight } = geometry
  if (Math.min(width, height, naturalWidth, naturalHeight) <= 0) return { width: 0, height: 0, maxScale: 1 }
  const fit = Math.min(1, width / naturalWidth, height / naturalHeight)
  return { width: naturalWidth * fit, height: naturalHeight * fit, maxScale: Math.max(4, 1 / fit) }
}

/** Translation is measured from the fitted image's center, independently of its CSS transform. */
export function constrainImageView(view: ImageViewTransform, geometry: ImageViewGeometry): ImageViewTransform {
  const size = imageViewSize(geometry)
  const scale = Math.max(1, Math.min(size.maxScale, view.scale))
  const boundX = Math.max(0, (size.width * scale - geometry.width) / 2)
  const boundY = Math.max(0, (size.height * scale - geometry.height) / 2)
  return { scale, x: Math.max(-boundX, Math.min(boundX, view.x)), y: Math.max(-boundY, Math.min(boundY, view.y)) }
}

/** Keep the image point under the pointer stationary until a real image edge reaches the viewport. */
export function zoomImageView(view: ImageViewTransform, scale: number, anchor: { x: number; y: number }, geometry: ImageViewGeometry): ImageViewTransform {
  const next = constrainImageView({ ...view, scale }, geometry)
  const ratio = next.scale / view.scale
  return constrainImageView({ scale: next.scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio }, geometry)
}
