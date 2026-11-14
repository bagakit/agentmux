/// <reference lib="webworker" />
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import { inspectGif, writeGifMetadata } from '../../shared/gif-metadata'
import type { SequenceFrame, GifKeyframe } from '../../shared/capture-sequence'
self.onmessage = async (event: MessageEvent<{ frames: SequenceFrame[]; keyframes: GifKeyframe[] }>) => {
  try {
    const { frames, keyframes } = event.data
    if (!frames.length) throw new Error('Record frames before exporting a GIF.')
    const first = frames[0]!.image, canvas = new OffscreenCanvas(first.width, first.height), context = canvas.getContext('2d')!
    const gif = GIFEncoder()
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!, image = await createImageBitmap(new Blob([Uint8Array.from(atob(frame.image.dataUrl.split(',')[1]!), char => char.charCodeAt(0))], { type: 'image/png' }))
      try {
        if (image.width !== canvas.width || image.height !== canvas.height) throw new Error('GIF frames must keep the same pixel size.')
        if (frame.delayMs > 655350) throw new Error('A frame interval exceeds the GIF delay range. Keep the captured frames and start a shorter recording.')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, palette = quantize(pixels, 256, { format: 'rgb444' })
        gif.writeFrame(applyPalette(pixels, palette, 'rgb444'), canvas.width, canvas.height, { palette, delay: Math.max(10, Math.round(frame.delayMs / 10) * 10), repeat: 0 })
        if (gif.bytesView().byteLength > 64 * 1024 * 1024) throw new Error('The encoded GIF exceeds the 64 MB export budget. Your captured frames are kept.')
        self.postMessage({ progress: index + 1 })
      } finally { image.close() }
    }
    gif.finish()
    const bytes = gif.bytes(), info = inspectGif(bytes)
    const result = writeGifMetadata(bytes, { schema: 'agentmux.gif.v1', width: info.width, height: info.height, delays: info.delays, keyframes })
    self.postMessage({ bytes: result }, [result.buffer])
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
