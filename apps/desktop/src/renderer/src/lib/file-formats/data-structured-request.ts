import { dataPreviewBudget } from '../file-data-preview'
import type { StructuredDataKind } from './data-parse'
import type { StructuredPreview } from './data-model'

/** Even bounded YAML can take seconds. Only a disposable Worker may parse a visible draft. */
export async function requestStructuredPreview(kind: StructuredDataKind, content: string, signal: AbortSignal): Promise<StructuredPreview> {
  signal.throwIfAborted()
  const limit = dataPreviewBudget(content)
  if (limit) return limit
  const worker = new Worker(new URL('./data-structured.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    let finished = false
    const finish = () => {
      if (finished) return false
      finished = true
      worker.terminate(); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      signal.removeEventListener('abort', abort)
      return true
    }
    const abort = () => { if (finish()) reject(new DOMException('Structured preview cancelled.', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ id: string; parsed: StructuredPreview }>) => { if (event.data.id === id && finish()) resolve(event.data.parsed) }
    worker.onerror = worker.onmessageerror = () => { if (finish()) resolve({ status: 'invalid', message: 'The structured preview worker stopped. Return to Source or retry the preview.' }) }
    if (signal.aborted) { abort(); return }
    try { worker.postMessage({ id, kind, content }) } catch (error) { finish(); reject(error) }
  })
}
