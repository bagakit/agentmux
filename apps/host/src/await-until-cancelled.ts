/** Stop waiting on cancellation, retaining the original promise and its owner.
 * The caller must distinguish a cancelled read from a possibly applied business operation. */
export async function awaitUntilCancelled<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let aborted: (() => void) | undefined
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
    })])
  } finally { if (aborted) signal.removeEventListener('abort', aborted) }
}
