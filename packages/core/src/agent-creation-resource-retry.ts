import { setTimeout as delay } from 'node:timers/promises'
import { AgentMuxError } from './errors.js'

/** Capacity comes from machine facts, within a named read or the exact negative creation receipt. */
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

// A read has no creation disposition of its own. Do not strip a nested receipt.
function hasCreationFailure(error: unknown, operationId?: string, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  const receipt = (error as { creationFailure?: AgentMuxError['creationFailure'] }).creationFailure
  return receipt !== undefined && (!operationId || !receipt || receipt.operationId !== operationId || receipt.disposition !== 'not_applied') ||
    error instanceof AggregateError && error.errors.some(value => hasCreationFailure(value, operationId, seen)) ||
    hasCreationFailure((error as { cause?: unknown }).cause, operationId, seen)
}
export type AgentCreationPreparation = <T>(read: () => Promise<T>) => Promise<T>
export type AgentCreationResourceContext = { preparation: AgentCreationPreparation; waitRevision(): number }

/** Only the original live call owns this wait. No reader, timer, or missing Run creates authority. */
export async function retryAgentCreationResources<T>(input: {
  operationId: string | (() => string | undefined); signal: AbortSignal
  attempt(context: AgentCreationResourceContext): Promise<T>
  waiting(error: unknown, retryAfterMs: number): void
}): Promise<T> {
  let retryAfterMs = 1_000
  let waitRevision = 0
  let lastFailure: unknown
  const wait = async (error: unknown) => {
    lastFailure = error
    waitRevision++
    input.waiting(error, retryAfterMs)
    try { await delay(retryAfterMs, undefined, { signal: input.signal }) } catch { throw error }
    if (input.signal.aborted) throw error
    retryAfterMs = Math.min(retryAfterMs * 2, 30_000)
  }
  const preparation: AgentCreationPreparation = async read => {
    for (;;) {
      input.signal.throwIfAborted()
      try {
        const result = await read()
        input.signal.throwIfAborted()
        return result
      } catch (error) {
        if (input.signal.aborted || hasCreationFailure(error) || !capacityFailure(error)) throw error
        await wait(error)
      }
    }
  }
  for (;;) {
    if (input.signal.aborted && lastFailure) throw lastFailure
    input.signal.throwIfAborted()
    try { return await input.attempt({ preparation, waitRevision: () => waitRevision }) }
    catch (error) {
      const operationId = typeof input.operationId === 'function' ? input.operationId() : input.operationId
      if (!operationId || !(error instanceof AgentMuxError) || error.creationFailure?.operationId !== operationId ||
        error.creationFailure.disposition !== 'not_applied' || hasCreationFailure(error, operationId) || !capacityFailure(error)) throw error
      lastFailure = error
      const failure = error as FailedCreation
      for (;;) {
        if (failure.cleanup?.length && !failure.retryCreationCleanup) throw error
        await wait(error)
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
