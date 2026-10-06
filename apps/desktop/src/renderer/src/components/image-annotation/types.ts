import type { NormalizedRect, ScreenshotShape } from './drawing-model'

/** One host-provided image. Geometry always uses its original pixels. */
export type AnnotationImage = { dataUrl: string; width: number; height: number }

export type ImageAnnotationInput = {
  image: HTMLImageElement
  shapes: ScreenshotShape[]
  crop: NormalizedRect | null
  /** Original image pixels, independent of the fitted viewport and DPR. */
  displayWidth: number
  displayHeight: number
}
