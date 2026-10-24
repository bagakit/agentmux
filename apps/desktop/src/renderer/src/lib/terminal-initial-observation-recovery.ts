const RETRY_DELAYS_MS = [500, 1000, 2000] as const

/** These are connection facts, never display text or an unknown business result. */
export function recoverableInitialTerminalObservation(error: unknown): boolean {
  try {
    const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
    const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    return code === 'CONTROL_UNAVAILABLE' || code === 'CONTROL_CONNECTION_FAILED' || code === 'CTXMUX_DISCONNECTED'
  } catch {
    // Missing connection evidence must leave the original failure and manual recovery usable.
    return false
  }
}

/** One finite wake window for a visible consumer that has not received its first lease. */
export class TerminalInitialObservationRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private retryable = false
  private independentRead: boolean
  private attempts = 0
  private disposed = false
  constructor(private visible: boolean, private readonly idle: () => boolean,
    private readonly retry: () => Promise<void>) { this.independentRead = visible }

  failure(error: unknown): void {
    this.failed = true
    this.retryable = recoverableInitialTerminalObservation(error)
    this.pause()
  }
  pause(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  settled(): void {
    if (this.disposed || !this.visible || !this.failed || !this.idle() || this.timer !== null ||
      this.attempts >= RETRY_DELAYS_MS.length || !this.independentRead && !this.retryable) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || !this.visible || !this.failed || !this.idle()) return
      // A visible consumer may independently reread a failed opening. The new
      // result still passes the original owner/identity/protocol validation.
      // Spending this demand before opening prevents a rejected reread spinning.
      this.independentRead = false
      this.attempts++
      void this.retry().catch(() => {})
    }, this.retryable ? RETRY_DELAYS_MS[this.attempts] : 0)
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.pause()
    this.independentRead = visible
    if (visible) { this.attempts = 0; this.settled() }
  }
  ownerRestored(): void {
    if (this.disposed || !this.failed || !this.retryable) return
    this.attempts = 0
    this.settled()
  }
  acquired(): void { this.failed = false; this.independentRead = false; this.pause() }
  dispose(): void { this.disposed = true; this.independentRead = false; this.pause() }
}
