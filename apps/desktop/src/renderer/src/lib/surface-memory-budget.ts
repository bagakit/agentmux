/**
 * Independent memory policy for heavyweight non-terminal surfaces.
 *
 * Terminal has a different replay/attachment contract and intentionally does not use this module.
 * Browser and Monaco are selected in separate buckets so a large Browser page can never consume the
 * Monaco hot-retain allowance (or vice versa).  This file only decides which Region-native owners may
 * be released; it never mutates a Session, Run, Region, document, or Browser identity.
 */

const MONACO_MEMORY_RELEASE_DELAY_MS = 60_000
const MONACO_MEMORY_HOT_RETAIN_MS = 5 * 60_000
const MONACO_MEMORY_HOT_RETAIN_LIMIT = 4
const BROWSER_MEMORY_RELEASE_DELAY_MS = 90_000
const BROWSER_MEMORY_HOT_RETAIN_MS = 5 * 60_000
const BROWSER_MEMORY_HOT_RETAIN_LIMIT = 3

export type SurfaceMemoryKind = 'monaco' | 'browser'

export type SurfaceMemoryCandidate = {
  /** Stable Workbench Region identity. */
  id: string
  kind: SurfaceMemoryKind
  visible: boolean
  /** False while another Workspace/Topic is selected; navigation alone never releases a surface. */
  navigationContextActive: boolean
  hiddenSinceMs: number | null
  /** Higher values mean the Region was activated more recently. */
  lastActivatedSeq: number
  /** A native owner currently exists and can be released. */
  ownerPresent: boolean
  /** The Region can be rebuilt without inventing a second source of truth. */
  canRebuild: boolean
  /** Unsaved/pending native work is a correctness boundary, not a memory optimization target. */
  protected: boolean
}

export type SurfaceMemoryPolicy = {
  nowMs: number
  parkingEnabled?: boolean
  measurementActive?: boolean
  releaseDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
  releaseCooldownUntilMs?: number | null
}

function compareRecentHidden(
  left: SurfaceMemoryCandidate,
  right: SurfaceMemoryCandidate
): number {
  const leftHidden = left.hiddenSinceMs ?? Number.NEGATIVE_INFINITY
  const rightHidden = right.hiddenSinceMs ?? Number.NEGATIVE_INFINITY
  if (leftHidden !== rightHidden) return rightHidden - leftHidden
  if (left.lastActivatedSeq !== right.lastActivatedSeq) {
    return right.lastActivatedSeq - left.lastActivatedSeq
  }
  return left.id.localeCompare(right.id)
}

function eligible(
  candidate: SurfaceMemoryCandidate,
  policy: Required<Pick<SurfaceMemoryPolicy, 'nowMs' | 'releaseDelayMs'>> &
    Pick<SurfaceMemoryPolicy, 'parkingEnabled' | 'measurementActive' | 'releaseCooldownUntilMs'>
): boolean {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return false
  if (
    candidate.visible ||
    !candidate.navigationContextActive ||
    candidate.hiddenSinceMs === null ||
    !candidate.ownerPresent ||
    !candidate.canRebuild ||
    candidate.protected
  ) return false
  if (
    policy.releaseCooldownUntilMs != null &&
    policy.nowMs < policy.releaseCooldownUntilMs
  ) return false
  return policy.nowMs - candidate.hiddenSinceMs >= policy.releaseDelayMs
}

function selectForKind(
  candidates: readonly SurfaceMemoryCandidate[],
  kind: SurfaceMemoryKind,
  policy: SurfaceMemoryPolicy
): Set<string> {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return new Set()
  const releaseDelayMs = policy.releaseDelayMs ?? (
    kind === 'monaco' ? MONACO_MEMORY_RELEASE_DELAY_MS : BROWSER_MEMORY_RELEASE_DELAY_MS
  )
  const hotRetainMs = policy.hotRetainMs ?? (
    kind === 'monaco' ? MONACO_MEMORY_HOT_RETAIN_MS : BROWSER_MEMORY_HOT_RETAIN_MS
  )
  const hotRetainLimit = Math.max(0, policy.hotRetainLimit ?? (
    kind === 'monaco' ? MONACO_MEMORY_HOT_RETAIN_LIMIT : BROWSER_MEMORY_HOT_RETAIN_LIMIT
  ))
  const eligibleCandidates = candidates
    .filter((candidate) => candidate.kind === kind)
    .filter((candidate) => eligible(candidate, { ...policy, releaseDelayMs }))
    .sort(compareRecentHidden)
  if (eligibleCandidates.length === 0) return new Set()

  const released = new Set<string>()
  const retained: SurfaceMemoryCandidate[] = []
  for (const candidate of eligibleCandidates) {
    if (policy.nowMs - (candidate.hiddenSinceMs ?? policy.nowMs) >= hotRetainMs) {
      released.add(candidate.id)
    } else {
      retained.push(candidate)
    }
  }
  for (const candidate of retained.slice(hotRetainLimit)) released.add(candidate.id)
  return released
}

/** Select Browser Regions only; Monaco and Browser budgets are deliberately independent. */
function selectBrowserSurfaceReleases(
  candidates: readonly SurfaceMemoryCandidate[],
  policy: SurfaceMemoryPolicy
): Set<string> {
  return selectForKind(candidates, 'browser', policy)
}

/** Select Monaco Regions only; this does not import or call Terminal parking policy. */
function selectMonacoSurfaceReleases(
  candidates: readonly SurfaceMemoryCandidate[],
  policy: SurfaceMemoryPolicy
): Set<string> {
  return selectForKind(candidates, 'monaco', policy)
}

/** Select both buckets while keeping each bucket's limit and TTL separate. */
export function selectSurfaceMemoryReleases(
  candidates: readonly SurfaceMemoryCandidate[],
  policy: SurfaceMemoryPolicy
): Set<string> {
  return new Set([
    ...selectMonacoSurfaceReleases(candidates, policy),
    ...selectBrowserSurfaceReleases(candidates, policy)
  ])
}

function nextForKind(
  candidates: readonly SurfaceMemoryCandidate[],
  kind: SurfaceMemoryKind,
  policy: SurfaceMemoryPolicy
): number | null {
  if (policy.parkingEnabled === false || policy.measurementActive === true) return null
  const releaseDelayMs = policy.releaseDelayMs ?? (
    kind === 'monaco' ? MONACO_MEMORY_RELEASE_DELAY_MS : BROWSER_MEMORY_RELEASE_DELAY_MS
  )
  const hotRetainMs = policy.hotRetainMs ?? (
    kind === 'monaco' ? MONACO_MEMORY_HOT_RETAIN_MS : BROWSER_MEMORY_HOT_RETAIN_MS
  )
  const deadlines = candidates.flatMap((candidate) => {
    if (
      candidate.kind !== kind ||
      candidate.visible ||
      !candidate.navigationContextActive ||
      candidate.hiddenSinceMs === null ||
      !candidate.ownerPresent ||
      !candidate.canRebuild ||
      candidate.protected
    ) return []
    const values = [candidate.hiddenSinceMs + releaseDelayMs, candidate.hiddenSinceMs + hotRetainMs]
    if (policy.releaseCooldownUntilMs != null) values.push(policy.releaseCooldownUntilMs)
    return values.filter((deadline) => deadline > policy.nowMs)
  })
  if (deadlines.length === 0) return null
  return Math.max(1, Math.min(...deadlines) - policy.nowMs)
}

/** Wake the coordinator at the soonest Browser or Monaco deadline. */
export function nextSurfaceMemoryDeadlineMs(
  candidates: readonly SurfaceMemoryCandidate[],
  policy: SurfaceMemoryPolicy
): number | null {
  const deadlines = [
    nextForKind(candidates, 'monaco', policy),
    nextForKind(candidates, 'browser', policy)
  ].filter((value): value is number => value !== null)
  return deadlines.length > 0 ? Math.min(...deadlines) : null
}
