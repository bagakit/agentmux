/**
 * Pure policy for the Renderer terminal working set.
 *
 * A hidden Workbench is intentionally kept warm for a short hysteresis window so a normal
 * project/tab switch never remounts xterm.  Beyond that window only surfaces which Core can
 * re-attach and replay are candidates; the most recently visible surface is always retained and
 * the remaining hot set is bounded.  This module has no React or Runtime dependency so the
 * lifecycle contract can be tested without a desktop process.
 */

export const TERMINAL_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_HOT_RETAIN_LIMIT = 6

export type TerminalColdParkCandidate = {
  /** Stable Region identity; a Session may be projected into more than one Region. */
  id: string
  visible: boolean
  /**
   * Whether this Region belongs to the currently visible Workspace/Topic navigation context.
   * A context switch is a projection change, not permission to discard the terminal surface: keeping
   * this false blocks the TTL so returning to a Project or Scratch Topic cannot manufacture a replay gap.
   */
  navigationContextActive: boolean
  hiddenSinceMs: number | null
  /** Higher values mean the Region became visible more recently. */
  lastActivatedSeq: number
  /** `launching` has no replay/attach contract yet. */
  phase: 'launching' | 'attached'
  /** Core can reattach this exact Run and replay its retained bytes. */
  canRebuild: boolean
  /** A pending interaction must remain available to the user. */
  hasPendingInteraction: boolean
}

export type TerminalColdParkPolicy = {
  parkingEnabled?: boolean
  measurementActive?: boolean
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
  parkCooldownUntilMs?: number | null
}

function compareRecentHidden(
  left: TerminalColdParkCandidate,
  right: TerminalColdParkCandidate
): number {
  const leftHidden = left.hiddenSinceMs ?? Number.NEGATIVE_INFINITY
  const rightHidden = right.hiddenSinceMs ?? Number.NEGATIVE_INFINITY
  if (leftHidden !== rightHidden) return rightHidden - leftHidden
  if (left.lastActivatedSeq !== right.lastActivatedSeq) {
    return right.lastActivatedSeq - left.lastActivatedSeq
  }
  return left.id.localeCompare(right.id)
}

function isEligible(
  candidate: TerminalColdParkCandidate,
  policy: Required<Pick<TerminalColdParkPolicy, 'nowMs' | 'coldParkDelayMs'>> &
    Pick<TerminalColdParkPolicy, 'parkingEnabled' | 'measurementActive' | 'parkCooldownUntilMs'>
): boolean {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return false
  if (
    candidate.visible ||
    !candidate.navigationContextActive ||
    candidate.hiddenSinceMs === null
  ) return false
  if (candidate.phase !== 'attached' || !candidate.canRebuild || candidate.hasPendingInteraction) {
    return false
  }
  if (
    policy.parkCooldownUntilMs != null &&
    policy.nowMs < policy.parkCooldownUntilMs
  ) return false
  return policy.nowMs - candidate.hiddenSinceMs >= policy.coldParkDelayMs
}

/**
 * Select the Region surfaces which may be cold-parked at this instant.
 *
 * Recently hidden Regions stay warm through the hot-retain TTL.  Once that TTL expires the newest
 * Region is eligible too; otherwise a single hidden project could remain an unbounded xterm owner
 * forever and the memory budget would have no effect.
 */
export function selectColdParkedTerminalRegions(
  candidates: readonly TerminalColdParkCandidate[],
  policy: TerminalColdParkPolicy
): Set<string> {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return new Set()
  const coldParkDelayMs = policy.coldParkDelayMs ?? TERMINAL_COLD_PARK_DELAY_MS
  const hotRetainMs = policy.hotRetainMs ?? TERMINAL_HOT_RETAIN_MS
  const hotRetainLimit = Math.max(0, policy.hotRetainLimit ?? TERMINAL_HOT_RETAIN_LIMIT)
  const eligible = candidates.filter((candidate) => isEligible(candidate, {
    ...policy,
    coldParkDelayMs
  }))
  if (eligible.length === 0) return new Set()

  eligible.sort(compareRecentHidden)
  const parked = new Set<string>()
  const retained: TerminalColdParkCandidate[] = []
  for (const candidate of eligible) {
    if ((policy.nowMs - (candidate.hiddenSinceMs ?? policy.nowMs)) >= hotRetainMs) {
      parked.add(candidate.id)
    } else {
      retained.push(candidate)
    }
  }
  retained.sort(compareRecentHidden)
  for (const candidate of retained.slice(hotRetainLimit)) parked.add(candidate.id)
  return parked
}

/** Wake at the next policy deadline instead of polling every hidden terminal. */
export function nextTerminalColdParkDelayMs(
  candidates: readonly TerminalColdParkCandidate[],
  policy: TerminalColdParkPolicy
): number | null {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return null
  const coldParkDelayMs = policy.coldParkDelayMs ?? TERMINAL_COLD_PARK_DELAY_MS
  const hotRetainMs = policy.hotRetainMs ?? TERMINAL_HOT_RETAIN_MS
  const deadlines = candidates.flatMap((candidate) => {
    if (
      candidate.visible ||
      !candidate.navigationContextActive ||
      candidate.hiddenSinceMs === null
    ) return []
    if (candidate.phase !== 'attached' || !candidate.canRebuild || candidate.hasPendingInteraction) {
      return []
    }
    const values = [candidate.hiddenSinceMs + coldParkDelayMs, candidate.hiddenSinceMs + hotRetainMs]
    if (policy.parkCooldownUntilMs != null) values.push(policy.parkCooldownUntilMs)
    return values.filter((deadline) => deadline > policy.nowMs)
  })
  if (deadlines.length === 0) return null
  return Math.max(1, Math.min(...deadlines) - policy.nowMs)
}

export function haveSameTerminalRegionIds(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id))
}
