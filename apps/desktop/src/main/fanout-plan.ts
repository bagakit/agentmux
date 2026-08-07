import { basename, join } from 'node:path'
import { MAX_FANOUT_LANES } from '../shared/fanout-limits.js'
import { fanOutSlug } from '../shared/fanout-naming.js'

// Turning "this prompt, five ways" into a concrete plan.
//
// The names and paths for a fan-out have to come from ONE place. If the orchestrator invents them
// inline, two things go wrong: nothing is testable without a disk, and a re-run picks different names,
// so the same request stops being reproducible. This module is that one place, and it is pure — no fs,
// no git, no Electron — so the part that is easy to get subtly wrong is the part that is cheapest to test.
//
// It deliberately does NOT create anything. It reads what already exists and says what SHOULD exist;
// whether that is achievable is the caller's problem, and failing halfway is the caller's problem too.

/** Hard ceiling on one fan-out. Both this module and the surface refuse above it; the number itself
 *  lives in {@link MAX_FANOUT_LANES} so the two sides cannot drift. Refuse rather than silently trim. */

/** Hard ceiling on one fan-out. Both this module and the surface refuse above it; the number itself
 *  lives in {@link MAX_FANOUT_LANES} so the two sides cannot drift. Refuse rather than silently trim. */

export type FanOutBranch = {
  /** The branch to create from HEAD. Guaranteed not to collide with an existing branch. */
  branch: string
  /** Absolute path for this branch's worktree. Guaranteed not to collide with an existing worktree. */
  path: string
  /** Which executor launches this lane's Agent. */
  executorId: string
}

export type FanOutPlan =
  // One lane is not a fan-out: the caller should take the ordinary single-launch path rather than
  // paying for orchestration, grouping and teardown to compare a result with nothing.
  | { kind: 'single'; executorId: string }
  | { kind: 'fanout'; lanes: FanOutBranch[] }
  | { kind: 'rejected'; reason: string }

export type FanOutRequest = {
  /** How many lanes the user asked for. */
  count: number
  /** Stem the branch names are built from — typically derived from the prompt or chosen by the user. */
  baseName: string
  /** Directory the worktrees are created under. */
  worktreeRoot: string
  /** Executors to spread the lanes across, in order. Reused cyclically when there are fewer than lanes. */
  executorIds: readonly string[]
  /** Branches that already exist in this repository. */
  existingBranches: readonly string[]
  /** Worktree paths already registered, so a plan never targets an occupied directory. */
  existingWorktreePaths: readonly string[]
}

// Git refs forbid a lot; the conservative alphabet a branch name is reduced to lives in ONE place —
// {@link fanOutSlug} — because the surface derives a stem from the prompt with the same function and the
// authority slugs `baseName` again here. Two copies once drifted (the surface's trimmed a trailing
// hyphen after truncation, this one did not), so the chain's correctness hung on an unstated fixed
// point; a single function makes that idempotence instead.

/**
 * Build the plan.
 *
 * Deterministic by construction: same request in, same plan out. No clock and no randomness feed the
 * names — a fan-out that named itself from `Date.now()` could not be re-run or reasoned about after
 * the fact, and a test could only assert its shape rather than its content.
 */
export function planFanOut(request: FanOutRequest): FanOutPlan {
  const count = Math.trunc(request.count)
  if (!Number.isFinite(count) || count < 1) {
    return { kind: 'rejected', reason: 'A fan-out needs at least one lane.' }
  }
  if (count > MAX_FANOUT_LANES) {
    // Refuse rather than clamp: silently giving someone 8 lanes when they asked for 40 is a worse
    // outcome than telling them the limit.
    return { kind: 'rejected', reason: `A fan-out is limited to ${MAX_FANOUT_LANES} lanes.` }
  }
  const executorIds = request.executorIds.filter((id) => id.trim() !== '')
  if (executorIds.length === 0) {
    return { kind: 'rejected', reason: 'A fan-out needs at least one Agent executor.' }
  }

  const stem = fanOutSlug(request.baseName)
  if (stem === '') {
    return { kind: 'rejected', reason: 'A fan-out needs a usable branch name.' }
  }

  if (count === 1) return { kind: 'single', executorId: executorIds[0]! }

  const takenBranches = new Set(request.existingBranches)
  // Compare by basename as well as full path: two lanes must not target the same directory even when
  // the caller passes paths that differ only by a trailing separator.
  const takenPaths = new Set(
    request.existingWorktreePaths.map((path) => path.replace(/\/+$/u, ''))
  )

  const lanes: FanOutBranch[] = []
  for (let index = 0; index < count; index += 1) {
    // Start from an ordinal the user can read ("-1", "-2"), then step past anything already taken —
    // including names this same plan has just claimed, so two lanes never coincide.
    let suffix = index + 1
    let branch = `${stem}-${suffix}`
    let path = join(request.worktreeRoot, `${stem}-${suffix}`)
    while (takenBranches.has(branch) || takenPaths.has(path)) {
      suffix += 1
      branch = `${stem}-${suffix}`
      path = join(request.worktreeRoot, `${stem}-${suffix}`)
    }
    takenBranches.add(branch)
    takenPaths.add(path)
    lanes.push({
      branch,
      path,
      // Cycle the executors so a mixed bake-off spreads across providers in a stable order.
      executorId: executorIds[index % executorIds.length]!
    })
  }

  return { kind: 'fanout', lanes }
}

/**
 * The directory name a lane occupies, for callers that need to show it without re-deriving the path.
 */
export function laneDirectoryName(lane: FanOutBranch): string {
  return basename(lane.path)
}
