export type ImageViewPoint = { x: number; y: number }

export function fitImageScale(width: number, height: number, imageWidth: number, imageHeight: number) {
  return Math.min(1, width / imageWidth, height / imageHeight)
}

/** Preserve the image point under the stationary viewport anchor as its scale changes. */
export function imageOffsetAtScale(origin: ImageViewPoint, anchor: ImageViewPoint, ratio: number): ImageViewPoint {
  return { x: anchor.x - (anchor.x - origin.x) * ratio, y: anchor.y - (anchor.y - origin.y) * ratio }
}
