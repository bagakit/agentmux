import type { NoteTextMerge } from '@agentmux/core/note-merge'

export type NoteLiveMerge = NoteTextMerge | { status: 'unavailable'; message: string }
/** The original rich validation and exact diff3 both run off the input thread. */
export async function mergeLiveNote(base: string, current: string, proposed: string, signal?: AbortSignal): Promise<NoteLiveMerge> {
  if (signal?.aborted) return { status: 'unavailable', message: 'This original merge was cancelled. The draft and observed file are retained.' }
  let worker: Worker
  try { worker = new Worker(new URL('./note-live-merge.worker.js', import.meta.url), { type: 'module' }) }
  catch (error) { return { status: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
  return await new Promise<NoteLiveMerge>(resolve => {
    let finished = false
    const finish = (value: NoteLiveMerge) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); worker.terminate(); resolve(value) }
    const abort = () => finish({ status: 'unavailable', message: 'This original merge was cancelled. Both drafts remain available.' })
    worker.onmessage = (event: MessageEvent<NoteLiveMerge>) => {
      const value = event.data
      finish(value?.status === 'conflict' || value?.status === 'merged' && typeof value.content === 'string' || value?.status === 'unavailable' && typeof value.message === 'string'
        ? value : { status: 'unavailable', message: 'The merge returned no confirmed original content.' })
    }
    worker.onerror = () => finish({ status: 'unavailable', message: 'The merge worker stopped. The draft and observed file remain available.' })
    worker.onmessageerror = () => finish({ status: 'unavailable', message: 'The merge result could not be read. The original inputs are retained.' })
    signal?.addEventListener('abort', abort, { once: true })
    try { if (signal?.aborted) abort(); else worker.postMessage({ base, current, proposed }) }
    catch (error) { finish({ status: 'unavailable', message: error instanceof Error ? error.message : String(error) }) }
  })
}
