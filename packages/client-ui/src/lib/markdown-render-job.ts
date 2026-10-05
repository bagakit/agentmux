import { markdownRenderLimit, type MarkdownRenderInput, type MarkdownRenderResult } from './markdown-render.js'

type Job = { id: string; input: MarkdownRenderInput; signal: AbortSignal; resolve(value: MarkdownRenderResult): void; reject(error: unknown): void; abort(): void }
type Slot = { worker: Worker; job: Job | null }
const queue: Job[] = [], slots = new Set<Slot>()
const CONCURRENCY = 2
// Correlation is local to this pool, including replies from a reused Worker.
let nextJobId = 0
const cancelled = () => new DOMException('Markdown preview cancelled.', 'AbortError')

function retire(slot: Slot) {
  slot.worker.terminate()
  slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker.onmessageerror = null
  slots.delete(slot)
}
function settle(slot: Slot, result: MarkdownRenderResult) {
  const job = slot.job
  if (!job) return
  slot.job = null
  job.signal.removeEventListener('abort', job.abort)
  job.resolve(result)
  pump()
}
function pump() {
  while (queue.length) {
    let slot = [...slots].find(candidate => !candidate.job)
    if (!slot && slots.size >= CONCURRENCY) return
    const job = queue.shift()!
    if (!slot) {
      try {
        // .js serves the tsc library output and Vite resolves its source .ts entry.
        slot = { worker: new Worker(new URL('./markdown-render.worker.js', import.meta.url), { type: 'module' }), job: null }
        slots.add(slot)
        const owner = slot
        owner.worker.onmessage = (event: MessageEvent<{ id: string; result: MarkdownRenderResult }>) => {
          if (owner.job?.id === event.data.id) settle(owner, event.data.result)
        }
        const failed = () => {
          if (!slots.has(owner)) return
          const active = owner.job
          owner.job = null; retire(owner)
          if (active) { active.signal.removeEventListener('abort', active.abort); active.resolve({ error: 'Markdown preview worker stopped. Original source shown.' }) }
          pump()
        }
        owner.worker.onerror = failed; owner.worker.onmessageerror = failed
      } catch (error) { job.signal.removeEventListener('abort', job.abort); job.reject(error); continue }
    }
    slot.job = job
    try { slot.worker.postMessage({ id: job.id, input: job.input }) }
    catch (error) {
      slot.job = null; retire(slot)
      job.signal.removeEventListener('abort', job.abort); job.reject(error)
    }
  }
  // Engines are reused only within this burst; an empty queue owns no idle Worker.
  for (const slot of slots) if (!slot.job) retire(slot)
}

/** Two concurrent visible jobs; each consumer still owns and cancels its exact request. */
export function requestMarkdownRender(input: MarkdownRenderInput, signal: AbortSignal): Promise<MarkdownRenderResult> {
  if (signal.aborted) return Promise.reject(cancelled())
  const message = markdownRenderLimit(input)
  if (message) return Promise.resolve({ message })
  return new Promise((resolve, reject) => {
    const job: Job = { id: String(++nextJobId), input, signal, resolve, reject, abort() {
      const index = queue.indexOf(job)
      if (index >= 0) queue.splice(index, 1)
      const slot = [...slots].find(candidate => candidate.job === job)
      if (slot) { slot.job = null; retire(slot) }
      signal.removeEventListener('abort', job.abort)
      reject(cancelled())
      queueMicrotask(pump)
    } }
    signal.addEventListener('abort', job.abort, { once: true })
    queue.push(job)
    if (signal.aborted) job.abort()
    else pump()
  })
}
