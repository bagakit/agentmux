import { setTimeout as delay } from 'node:timers/promises'
import { AgentMuxError } from './errors.js'

/** Machine resource facts explain a failure; only the exact creation receipt permits retry. */
function capacityFailure(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const failure = error as { code?: unknown; errcode?: unknown; storageFailure?: AgentMuxError['storageFailure']; cause?: unknown }
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(value => capacityFailure(value, new Set(seen)))
  return failure.code === 'ENOSPC' || failure.code === 'EDQUOT' || failure.code === 'SQLITE_FULL' ||
    failure.code === 'ERR_SQLITE_ERROR' && typeof failure.errcode === 'number' && (failure.errcode & 0xff) === 13 ||
    failure.storageFailure?.sqlitePrimaryCode === 13 || failure.storageFailure?.systemErrno === 28 ||
    capacityFailure(failure.cause, seen)
}

type FailedCreation = AgentMuxError & { cleanup?: unknown[]; retryCreationCleanup?: () => Promise<void> }

/** Only the original live call owns this wait. No reader, timer, or missing Run creates authority. */
export async function retryAgentCreationResources<T>(input: {
  operationId: string; signal: AbortSignal; attempt(): Promise<T>
  waiting(error: AgentMuxError, retryAfterMs: number): void
}): Promise<T> {
  let retryAfterMs = 1_000
  let lastFailure: AgentMuxError | undefined
  for (;;) {
    if (input.signal.aborted && lastFailure) throw lastFailure
    input.signal.throwIfAborted()
    try { return await input.attempt() }
    catch (error) {
      if (!(error instanceof AgentMuxError) || error.creationFailure?.operationId !== input.operationId ||
        error.creationFailure.disposition !== 'not_applied' || !capacityFailure(error)) throw error
      lastFailure = error
      const failure = error as FailedCreation
      for (;;) {
        if (failure.cleanup?.length && !failure.retryCreationCleanup) throw error
        input.waiting(error, retryAfterMs)
        try { await delay(retryAfterMs, undefined, { signal: input.signal }) }
        catch { throw error } // Cancellation retains the last exact not-applied receipt.
        if (input.signal.aborted) throw error
        retryAfterMs = Math.min(retryAfterMs * 2, 30_000)
        if (!failure.cleanup?.length) break
        try { await failure.retryCreationCleanup!() }
        catch (cleanupError) {
          // Only this original owner's cleanup may be retried, without another Start.
          if (!capacityFailure(cleanupError)) throw error
          continue
        }
        if (failure.cleanup?.length) throw error
        break
      }
    }
  }
}
