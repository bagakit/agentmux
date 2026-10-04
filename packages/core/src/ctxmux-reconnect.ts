/** A short exponential retry window limits recovery traffic, not the lifetime of recovery. */
const RECONNECT_BASE_DELAY_MS = 500
/** Maximum attempts in the fast window; the client then schedules one attempt every 30 seconds. */
export const RECONNECT_MAX_ATTEMPTS = 6

export type ReconnectStep =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'give-up'; attempts: number }

/**
 * 给「已经失败过 `priorAttempts` 次」算下一步。`priorAttempts` 从 0 起（0 = 还没试过，排第一次）。
 *
 * 到达上限结束这一轮快速窗口，由 client 转入低频恢复。窗口内 delay 单调递增。
 */
export function nextReconnectStep(priorAttempts: number): ReconnectStep {
  if (priorAttempts >= RECONNECT_MAX_ATTEMPTS) {
    return { kind: 'give-up', attempts: priorAttempts }
  }
  const delayMs = RECONNECT_BASE_DELAY_MS * 2 ** priorAttempts
  return { kind: 'retry', attempt: priorAttempts, delayMs }
}

export type BoundedReconnectResult =
  | { kind: 'reconnected'; attempts: number }
  | { kind: 'exhausted'; attempts: number }
  | { kind: 'cancelled'; attempts: number }

/** Cancelled waits never start another transport operation. */
export async function runBoundedReconnect(deps: {
  attempt: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}): Promise<BoundedReconnectResult> {
  let priorAttempts = 0
  while (true) {
    if (deps.signal?.aborted) return { kind: 'cancelled', attempts: priorAttempts }
    const step = nextReconnectStep(priorAttempts)
    if (step.kind === 'give-up') return { kind: 'exhausted', attempts: step.attempts }
    await deps.sleep(step.delayMs)
    if (deps.signal?.aborted) return { kind: 'cancelled', attempts: priorAttempts }
    try {
      await deps.attempt()
      if (deps.signal?.aborted) return { kind: 'cancelled', attempts: priorAttempts }
      return { kind: 'reconnected', attempts: step.attempt + 1 }
    } catch {
      priorAttempts += 1
    }
  }
}
