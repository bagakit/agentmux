import { readAgentPromptPreparationWait, type AgentPromptPreparationRetryFence } from '@agentmux/core/prompt-preparation'

export type PromptPreparationRetryProgress = import('@agentmux/core/prompt-preparation').AgentPromptPreparationRetryProgress
const BACKOFF_MS = [2_000, 4_000, 8_000] as const

/** This finite call owns retry permission. Stored progress is evidence, never permission. */
export async function submitWithPreparationRetry(input: {
  agentSessionId: string; runId: string; operationId: string; explicit: boolean
  signal: AbortSignal
  submit(fence?: AgentPromptPreparationRetryFence): Promise<void>
  current(): boolean
  refresh(): Promise<boolean>
  progress(value: PromptPreparationRetryProgress): void
}): Promise<void> {
  let fence: AgentPromptPreparationRetryFence | undefined
  for (let attempt = 0; ; attempt++) {
    try { await input.submit(fence); return }
    catch (error) {
      const wait = readAgentPromptPreparationWait(error)
      const failure = error && typeof error === 'object' && 'controlFailure' in error ? error.controlFailure as { disposition?: unknown; confirmedInputBytes?: unknown } : undefined
      if (!input.explicit || !wait?.retrySafe || wait.agentSessionId !== input.agentSessionId || wait.runId !== input.runId ||
          wait.operationId !== input.operationId || failure?.disposition !== 'not_applied' || failure.confirmedInputBytes !== 0 ||
          fence && (fence.inputByte !== wait.inputByte || fence.nativeSourceId !== wait.nativeSourceId)) throw error
      if (attempt >= BACKOFF_MS.length) {
        input.progress({ reason: wait.reason, state: 'exhausted', attempt, maxAttempts: 3, nextAttemptAt: null }); throw error
      }
      const progress: PromptPreparationRetryProgress = { reason: wait.reason, state: 'waiting', attempt: attempt + 1,
        maxAttempts: 3, nextAttemptAt: Date.now() + BACKOFF_MS[attempt]! }
      const stop = () => input.progress({ ...progress, state: 'stopped', nextAttemptAt: null })
      if (input.signal.aborted || !input.current()) { stop(); throw error }
      fence ??= { inputByte: wait.inputByte, nativeSourceId: wait.nativeSourceId }
      input.progress(progress)
      const cancelled = await new Promise<boolean>(resolve => {
        const finish = (stopped: boolean) => { clearTimeout(timer); input.signal.removeEventListener('abort', abort); resolve(stopped) }
        const abort = () => finish(true)
        const timer = setTimeout(() => finish(false), BACKOFF_MS[attempt]!)
        input.signal.addEventListener('abort', abort, { once: true })
        if (input.signal.aborted) abort()
      })
      if (cancelled || !input.current() || !await input.refresh() || input.signal.aborted || !input.current()) { stop(); throw error }
      input.progress({ ...progress, state: 'preparing', nextAttemptAt: null })
    }
  }
}
