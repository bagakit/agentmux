import type { NormalizedRect, ScreenshotShape } from '@agentmux/client-ui/image-annotation'

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
/** An output may resolve true once its host has kept that exact output; the editor then closes without a discard confirmation. */
export type ImageAnnotationOutputResult = void | Promise<boolean | void>
