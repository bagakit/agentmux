/**
 * Limit repeated fast recovery windows when the transport connects and immediately drops.
 * Exhaustion switches the client to quiet, cancellable low-frequency recovery; it is
 * neither evidence of a dead Run nor a limit on the lifetime of its original Session.
 */
export const RECONNECT_FLAP_BUDGET = 3

/** A continuously healthy connection replenishes the fast-window budget. */
export const RECONNECT_PROBATION_MS = 90_000

export type ReconnectFlapLedger = { flapCount: number }
export type FlapVerdict =
  | { kind: 'reconnect'; flapCount: number }
  /** Give up the fast window only; the client continues low-frequency attempts. */
  | { kind: 'give-up'; flapCount: number }

/** Record one actual loss; successful short-lived connections do not reset the ledger. */
export function judgeReconnectFlap(ledger: ReconnectFlapLedger): FlapVerdict {
  const flapCount = ledger.flapCount + 1
  if (ledger.flapCount >= RECONNECT_FLAP_BUDGET) {
    return { kind: 'give-up', flapCount }
  }
  return { kind: 'reconnect', flapCount }
}

/** Sleep/wake clock jumps replenish this budget rather than declaring a terminal failure. */
export function shouldClearFlapLedger(healthySince: number, now: number): boolean {
  return now - healthySince >= RECONNECT_PROBATION_MS
}
