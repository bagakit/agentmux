const RETRY_DELAYS_MS = [500, 1000, 2000] as const

/** These are connection facts, never display text or an unknown business result. */
export function recoverableInitialTerminalObservation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'CONTROL_UNAVAILABLE' || code === 'CONTROL_CONNECTION_FAILED' || code === 'CTXMUX_DISCONNECTED'
}

/** One finite wake window for a visible consumer that has not received its first lease. */
export class TerminalInitialObservationRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private attempts = 0
  private disposed = false
  constructor(private visible: boolean, private readonly idle: () => boolean,
    private readonly retry: () => Promise<void>) {}

  failure(error: unknown): void {
    this.failed = recoverableInitialTerminalObservation(error)
    if (!this.failed) this.pause()
  }
  pause(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  settled(): void {
    if (this.disposed || !this.visible || !this.failed || !this.idle() || this.timer !== null || this.attempts >= RETRY_DELAYS_MS.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || !this.visible || !this.failed || !this.idle()) return
      this.attempts++
      void this.retry().catch(() => {})
    }, RETRY_DELAYS_MS[this.attempts])
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.pause()
    if (visible) { this.attempts = 0; this.settled() }
  }
  ownerRestored(): void {
    if (this.disposed || !this.failed) return
    this.attempts = 0
    this.settled()
  }
  acquired(): void { this.failed = false; this.pause() }
  dispose(): void { this.disposed = true; this.pause() }
}
