/// <reference lib="webworker" />
import init, { WasmLazyDocument } from 'djvu-rs'
import type { DjvuReadResult, DjvuRequest, DjvuResult } from './djvu-protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
let initialized: ReturnType<typeof init> | undefined
let nextRead = 0
const reads = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>()
const send = (message: DjvuResult) => scope.postMessage(message)
function read(offset: number, length: number): Promise<Uint8Array> {
  const request = ++nextRead
  return new Promise((resolve, reject) => { reads.set(request, { resolve, reject }); send({ type: 'read', request, offset, length }) })
}

scope.onmessage = async ({ data }: MessageEvent<DjvuRequest | DjvuReadResult>) => {
  if (data.type === 'bytes' || data.type === 'read-error') {
    const pending = reads.get(data.request); if (!pending) return
    reads.delete(data.request)
    if (data.type === 'bytes') pending.resolve(data.bytes); else pending.reject(new Error(data.message))
    return
  }
  let document: Awaited<ReturnType<typeof WasmLazyDocument.open>> | undefined
  try {
    await (initialized ??= init())
    // Upstream retains every visited parsed page. A per-operation document bounds that cache.
    document = await WasmLazyDocument.open(data.size, read)
    if (data.type === 'open') { send({ type: 'opened', id: data.id, pages: document.page_count() }); return }
    const [width, height, dpi] = await document.page_info(data.index)
    // Bound the display raster, without limiting the original file or its native dimensions.
    const targetDpi = Math.max(1, Math.min(150, dpi! * Math.sqrt(4_000_000 / (width! * height!))))
    const pixmap = await document.render_page(data.index, targetDpi)
    try {
      const canvas = new OffscreenCanvas(pixmap.width(), pixmap.height())
      const context = canvas.getContext('2d')
      if (!context) throw new Error('The DjVu page canvas is unavailable.')
      // to_bytes owns its pixels. A borrowed WASM view must not survive allocations or free().
      const pixels = new Uint8ClampedArray(pixmap.to_bytes())
      context.putImageData(new ImageData(pixels, pixmap.width(), pixmap.height()), 0, 0)
      send({ type: 'rendered', id: data.id, blob: await canvas.convertToBlob({ type: 'image/png' }) })
      canvas.width = 0; canvas.height = 0
    } finally { pixmap.free() }
  } catch (error) { send({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) }) }
  finally { document?.free() }
}
