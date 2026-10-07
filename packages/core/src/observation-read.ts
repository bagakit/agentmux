import { AgentMuxError } from './errors.js'

/** End this readonly consumer promptly. The original signal-aware reader owns
 * its resource cleanup; shared openings and admitted operations remain owned. */
export async function observeRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new AgentMuxError('The original observation reader was cancelled; its Run and admitted operations are retained.', 'CONTROL_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
