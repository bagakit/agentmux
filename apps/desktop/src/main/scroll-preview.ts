import { nativeImage, type NativeImage } from 'electron'

type ScrollPreview = { image: NativeImage; dataUrl: string; sourceHeight: number; scale: number }

/** Append just the newly confirmed rows. Halve the thumbnail resolution only when it outgrows its pixel budget. */
export function appendScrollPreview(previous: ScrollPreview | undefined, frame: NativeImage, addedRows: number): ScrollPreview {
  const size = frame.getSize()
  const sourceHeight = (previous?.sourceHeight ?? 0) + addedRows
  let scale = previous?.scale ?? Math.min(1, 256 / size.width, 512 / size.height)
  while (sourceHeight * scale > 512) scale /= 2
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const start = Math.min(height, Math.round((previous?.sourceHeight ?? 0) * scale))
  if (previous && previous.scale === scale && start === height) return { ...previous, sourceHeight }
  const bitmap = Buffer.alloc(width * height * 4)
  if (previous && start) {
    const prefix = previous.scale === scale ? previous.image : previous.image.resize({ width, height: start })
    prefix.toBitmap().copy(bitmap, 0)
  }
  if (height > start) {
    const strip = addedRows === size.height ? frame : frame.crop({ x: 0, y: size.height - addedRows, width: size.width, height: addedRows })
    strip.resize({ width, height: height - start }).toBitmap().copy(bitmap, start * width * 4)
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height })
  return { image, dataUrl: image.toDataURL(), sourceHeight, scale }
}
