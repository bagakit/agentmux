import { Worker } from 'node:worker_threads'
import type { NoteTextMerge } from './note-merge.js'

/** CPU work stays outside the original Host event loop. The caller retains its existing write lock. */
export async function mergeNoteTextInWorker(base: string, current: string, proposed: string): Promise<NoteTextMerge> {
  if (current === base || current === proposed) return { status: 'merged', content: proposed }
  if (proposed === base) return { status: 'merged', content: current }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./note-merge-worker.js', import.meta.url), { workerData: { base, current, proposed } })
    let received = false
    worker.once('message', (result: NoteTextMerge) => { received = true; resolve(result) })
    worker.once('error', reject)
    worker.once('exit', code => { if (!received) reject(new Error(`The original Note merge worker exited without a result (code ${code}).`)) })
  })
}
