import { canFormatFile } from './format-support'

export type FileFormatResult = { status: 'formatted' | 'unchanged' | 'unsupported' | 'unavailable' | 'stale' | 'cancelled' | 'failed'; message?: string }
export type FileFormatSnapshot = { path: string; content: string; model: object; version: number; generation: number }
export type FileFormatAdapter = {
  snapshot(): FileFormatSnapshot | null
  isCurrent(snapshot: FileFormatSnapshot): boolean
  apply(snapshot: FileFormatSnapshot, content: string): boolean
  watch(snapshot: FileFormatSnapshot, invalidate: (error?: unknown) => void): () => void
}
type Job = { adapter: FileFormatAdapter; cancel(): void }
const adapters = new Map<string, FileFormatAdapter>()
const jobs = new Map<string, Job>()

/** Registration retains a live editor capability, never a second text buffer. */
export function registerFileRegionFormatter(regionId: string, adapter: FileFormatAdapter): () => void {
  const previous = adapters.get(regionId)
  if (previous) jobs.get(regionId)?.cancel()
  adapters.set(regionId, adapter)
  return () => {
    if (adapters.get(regionId) !== adapter) return
    jobs.get(regionId)?.cancel()
    adapters.delete(regionId)
  }
}

export function cancelFileRegionFormat(regionId: string): void { jobs.get(regionId)?.cancel() }

/** GUI and public control consume this same exact-Region action. */
export async function formatFileRegion(regionId: string, signal?: AbortSignal): Promise<FileFormatResult> {
  if (signal?.aborted) return { status: 'cancelled', message: 'Formatting cancelled. The draft is unchanged.' }
  const adapter = adapters.get(regionId)
  if (!adapter) return { status: 'unavailable', message: 'Show source in this File Region to format its current draft.' }
  let snapshot: FileFormatSnapshot | null
  try { snapshot = adapter.snapshot() }
  catch { return { status: 'failed', message: 'The source editor could not read the current draft. Retry formatting.' } }
  if (!snapshot) return { status: 'unavailable', message: 'The source editor is updating. Retry formatting the current draft.' }
  if (!canFormatFile(snapshot.path)) return { status: 'unsupported', message: 'This file has no source-preserving formatter.' }
  jobs.get(regionId)?.cancel()
  let worker: Worker
  try { worker = new Worker(new URL('./format-worker.ts', import.meta.url), { type: 'module' }) }
  catch { return { status: 'unavailable', message: 'The formatter could not start. The draft is unchanged.' } }
  return await new Promise(resolve => {
    const id = crypto.randomUUID()
    let finished = false
    let unwatch = () => {}
    const stopWatching = () => { const cleanup = unwatch; unwatch = () => {}; cleanup() }
    const finish = (result: FileFormatResult) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      stopWatching()
      worker.terminate()
      if (jobs.get(regionId) === job) jobs.delete(regionId)
      resolve(result)
    }
    const job: Job = { adapter, cancel: () => finish({ status: 'cancelled', message: 'Formatting cancelled. The draft is unchanged.' }) }
    const abort = () => job.cancel()
    jobs.set(regionId, job)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ id: string; content?: string; error?: string }>) => {
      if (finished || event.data.id !== id) return
      try {
        if (adapters.get(regionId) !== adapter || !adapter.isCurrent(snapshot)) return finish({ status: 'stale', message: 'The draft changed while formatting. Format the current draft again.' })
        if (event.data.error || typeof event.data.content !== 'string') return finish({ status: 'failed', message: event.data.error ?? 'The formatter returned no source. The draft is unchanged.' })
        if (event.data.content === snapshot.content) return finish({ status: 'unchanged', message: 'The draft is already formatted.' })
        // executeEdits synchronously notifies model/document listeners; this job's own edit is valid.
        stopWatching()
        const applied = adapter.apply(snapshot, event.data.content)
        finish(applied ? { status: 'formatted', message: 'Formatted the draft. Save to write it to disk.' } : { status: 'stale', message: 'The source editor changed. The draft is unchanged.' })
      } catch { finish({ status: 'failed', message: 'The source edit could not be applied. Check the current draft before retrying.' }) }
    }
    worker.onerror = () => finish({ status: 'failed', message: 'The formatter stopped. The draft is unchanged.' })
    worker.onmessageerror = () => finish({ status: 'failed', message: 'The formatter response could not be read. The draft is unchanged.' })
    try {
      const cleanup = adapter.watch(snapshot, error => finish(error === undefined
        ? { status: 'stale', message: 'The draft changed while formatting. Format the current draft again.' }
        : { status: 'failed', message: 'The current source could not be checked. Retry formatting the draft.' }))
      if (finished) cleanup()
      else unwatch = cleanup
      if (signal?.aborted) abort()
      if (!finished) worker.postMessage({ id, path: snapshot.path, content: snapshot.content })
    } catch { finish({ status: 'failed', message: 'The formatter request could not start. The draft is unchanged.' }) }
  })
}
