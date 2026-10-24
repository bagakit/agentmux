import { AgentMuxError } from './errors.js'

/** Only the exclusive creation owner or its exact Runtime receipt can call this. */
export function agentCreationNotAppliedError(error: unknown, operationId: string): AgentMuxError {
  const original = error instanceof AgentMuxError ? error : undefined
  const code = original?.code ?? (error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : 'AGENT_CREATION_NOT_APPLIED')
  const failure = new AgentMuxError(error instanceof Error ? error.message : String(error), code,
    original?.detail, { disposition: 'not_applied', confirmedInputBytes: null }, original?.logId,
    original?.creationFailure ?? { operationId, disposition: 'not_applied' }, original?.storageFailure)
  Object.defineProperty(failure, 'cause', { value: error, configurable: true })
  // A Store's historical close/rollback errors remain in cause. Its pending lock
  // handle is settled by the exact releaseLifecycle action, not by an error array.
  return failure
}

/** The active caller may retry these exact cleanup actions; this closure never starts a Run. */
export async function finishAgentCreationCleanup(error: unknown, actions: Array<() => Promise<void>>): Promise<void> {
  let pending = actions
  const retry = async (initial = false): Promise<void> => {
    const cleanup: unknown[] = [], remaining: Array<() => Promise<void>> = []
    for (const action of pending) {
      try { await action() } catch (failure) { cleanup.push(failure); remaining.push(action) }
    }
    pending = remaining
    if (cleanup.length) {
      if (!(error instanceof Error)) error = new AggregateError(error === undefined ? cleanup : [error, ...cleanup], 'Agent creation cleanup failed.')
      Object.defineProperty(error, 'cleanup', { value: cleanup, configurable: true })
      Object.defineProperty(error, 'retryCreationCleanup', { value: async () => { await retry() }, configurable: true })
      throw initial ? error : cleanup.length === 1 ? cleanup[0] : new AggregateError(cleanup, 'Agent creation cleanup remains unavailable.')
    }
    if (error instanceof Error) {
      Reflect.deleteProperty(error, 'cleanup')
      Reflect.deleteProperty(error, 'retryCreationCleanup')
    }
  }
  await retry(true)
}
