import type { RandomAccessSource } from '../../bytes'
import type { DjvuRequest, DjvuResult } from './djvu-protocol'
import { pageBook } from './page-book'

export async function openDjvuBook(source: RandomAccessSource, name: string, controller: AbortController) {
  let worker: Worker | undefined
  let sequence = 0
  let active: { id: number; reject(error: unknown): void; cancel(): void } | undefined
  const stop = () => { worker?.terminate(); worker = undefined; const pending = active; active = undefined; pending?.cancel(); pending?.reject(new DOMException('The page read was cancelled.', 'AbortError')) }
  controller.signal.addEventListener('abort', stop, { once: true })
  function run(kind: 'open', signal: AbortSignal): Promise<number>
  function run(kind: 'render', signal: AbortSignal, index: number): Promise<Blob>
  function run(kind: 'open' | 'render', signal: AbortSignal, index?: number): Promise<number | Blob> {
    signal.throwIfAborted()
    if (active) stop()
    worker ??= new Worker(new URL('./djvu.worker.ts', import.meta.url), { type: 'module' })
    const current = worker, id = ++sequence
    return new Promise((resolve, reject) => {
      const abort = () => { if (active?.id === id) stop() }
      const cancel = () => signal.removeEventListener('abort', abort)
      const finish = (error?: unknown, value?: number | Blob) => { if (active?.id !== id) return; active = undefined; cancel(); error ? reject(error) : resolve(value!) }
      active = { id, reject, cancel }
      signal.addEventListener('abort', abort, { once: true })
      current.onerror = event => { finish(new Error(event.message || 'The DjVu decoder worker failed.')); current.terminate(); if (worker === current) worker = undefined }
      current.onmessage = async ({ data }: MessageEvent<DjvuResult>) => {
        if (active?.id !== id) return
        if (data.type === 'read') {
          try {
            const bytes = (await source.read(data.offset, data.length, signal)).slice()
            if (active?.id !== id) return
            current.postMessage({ type: 'bytes', request: data.request, bytes }, [bytes.buffer as ArrayBuffer])
          } catch (error) {
            if (active?.id === id) current.postMessage({ type: 'read-error', request: data.request, message: error instanceof Error ? error.message : String(error) })
          }
        } else if (data.id === id) {
          if (data.type === 'error') finish(new Error(data.message))
          else finish(undefined, data.type === 'opened' ? data.pages : data.blob)
        }
      }
      current.postMessage({ type: kind, id, size: source.size, ...(kind === 'render' ? { index } : {}) } as DjvuRequest)
    })
  }
  try {
    const count = await run('open', controller.signal)
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('This DjVu document contains no pages.')
    return pageBook(name, Array.from({ length: count }, (_, index) => ({ id: `page:${index}`, size: 0 })), controller,
      (index, signal) => run('render', signal, index), () => { controller.signal.removeEventListener('abort', stop); stop() })
  } catch (error) { stop(); controller.signal.removeEventListener('abort', stop); throw error }
}
