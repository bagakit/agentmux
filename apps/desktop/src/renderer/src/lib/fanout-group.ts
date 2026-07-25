import type { SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { categoryFor, type AttentionCategory } from './attention-event'

// Reading a bake-off.
//
// After a fan-out there are N branches racing on the same prompt, and the question is which of them
// finished, which is stuck on you, and which fell over. The Board already answers that per branch; what
// was missing is knowing which branches belong to the SAME comparison, so they can be read as a set
// instead of hunted for among every other branch in the repo.
//
// The grouping is DERIVED, not stored. A fan-out names its lanes `<stem>-1`, `<stem>-2`, … from one
// deterministic plan (see main/fanout-plan.ts), so the stem already identifies the set. Persisting a
// group id would mean widening the strict workspace schema and maintaining a second registry of
// something the branch names already say — a second source of truth for no new information.
//
// The cost of deriving is honest and bounded: branches a human happened to name `foo-1` and `foo-2` will
// read as one group. That is a cosmetic coincidence in a view, not a correctness problem, and it is
// preferable to a stored id that can drift from the branches it claims to describe.

export type FanOutLane = {
  branch: string
  workspaceId: string
  path: string
  /** The Agent running in this lane, when one is projected. */
  session: SessionSnapshot | null
  /** Attention class for this lane, or null when it wants nothing. */
  attention: AttentionCategory | null
}

export type FanOutGroup = {
  /** The shared stem, e.g. `add-retry-to-the-uploader` — what the lanes have in common. */
  stem: string
  lanes: FanOutLane[]
}

// A lane branch is `<stem>-<n>`. Splitting on the final numeric segment is what recovers the stem.
const LANE_BRANCH = /^(?<stem>.+)-(?<ordinal>\d+)$/u

function laneParts(branch: string): { stem: string; ordinal: number } | null {
  const match = LANE_BRANCH.exec(branch)
  // Named groups are typed as possibly-absent even when the pattern guarantees them, so read them
  // explicitly rather than asserting — a non-match must fall through, not throw.
  const stem = match?.groups?.stem
  const rawOrdinal = match?.groups?.ordinal
  if (stem === undefined || rawOrdinal === undefined) return null
  const ordinal = Number(rawOrdinal)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null
  return { stem, ordinal }
}

/**
 * Group the worktree workspaces into fan-out sets.
 *
 * Only groups of two or more are returned: a single `foo-1` branch is just a branch, and presenting it
 * as a one-lane bake-off would be noise. Lanes come back in ordinal order so the set reads the way it
 * was created.
 */
export function fanOutGroups(input: {
  workspaces: readonly WorkspaceRecord[]
  sessions: readonly SessionSnapshot[]
}): FanOutGroup[] {
  const sessionByPath = new Map<string, SessionSnapshot>()
  for (const session of input.sessions ?? []) {
    // First session wins for a path: a lane shows the Agent that owns it, and a second projection of the
    // same workspace does not change which lane this is.
    if (!sessionByPath.has(session.workspacePath)) sessionByPath.set(session.workspacePath, session)
  }

  const byStem = new Map<string, { ordinal: number; lane: FanOutLane }[]>()
  for (const workspace of input.workspaces ?? []) {
    if (workspace.kind !== 'worktree' || !workspace.branch) continue
    const parts = laneParts(workspace.branch)
    if (!parts) continue
    const session = sessionByPath.get(workspace.path) ?? null
    const entries = byStem.get(parts.stem) ?? []
    entries.push({
      ordinal: parts.ordinal,
      lane: {
        branch: workspace.branch,
        workspaceId: workspace.id,
        path: workspace.path,
        session,
        attention: session ? categoryFor(session.status.state) : null
      }
    })
    byStem.set(parts.stem, entries)
  }

  const groups: FanOutGroup[] = []
  for (const [stem, entries] of byStem) {
    // One lane is not a comparison. Surfacing it as a group would turn every ordinary `foo-1` branch
    // into a bake-off in the UI.
    if (entries.length < 2) continue
    entries.sort((left, right) => left.ordinal - right.ordinal)
    groups.push({ stem, lanes: entries.map((entry) => entry.lane) })
  }
  // Deterministic order so the view does not reshuffle between renders.
  groups.sort((left, right) => left.stem.localeCompare(right.stem))
  return groups
}

/**
 * The one lane in a group that most wants the user, or null when none does.
 *
 * Same ranking the rest of the window uses — needs-you above error — and inside a class the longest
 * wait wins, matching the attention bar's "jump to the earliest" contract so a group and the bar never
 * point at different lanes.
 */
export function groupLaneNeedingYou(group: FanOutGroup): FanOutLane | null {
  const rank: Record<AttentionCategory, number> = { 'needs-you': 0, error: 1, done: 3 }
  let winner: FanOutLane | null = null
  let winnerRank = Number.POSITIVE_INFINITY
  for (const lane of group.lanes) {
    // `done` is not a request for attention; a finished lane is a result to read, not an interruption.
    if (!lane.attention || lane.attention === 'done') continue
    const laneRank = rank[lane.attention]
    if (laneRank < winnerRank) {
      winner = lane
      winnerRank = laneRank
      continue
    }
    if (laneRank === winnerRank && winner?.session && lane.session) {
      if (lane.session.status.observedAt < winner.session.status.observedAt) winner = lane
    }
  }
  return winner
}

/**
 * How the group is progressing, for a one-line summary.
 *
 * `idle` counts lanes with no Agent projected — a worktree left behind by a lane that never launched is
 * still part of the set, and hiding it would make the group look smaller than it is.
 */
export function groupProgress(group: FanOutGroup): {
  total: number
  done: number
  needsYou: number
  error: number
  working: number
  idle: number
} {
  let done = 0
  let needsYou = 0
  let error = 0
  let working = 0
  let idle = 0
  for (const lane of group.lanes) {
    if (!lane.session) { idle += 1; continue }
    if (lane.attention === 'done') { done += 1; continue }
    if (lane.attention === 'needs-you') { needsYou += 1; continue }
    if (lane.attention === 'error') { error += 1; continue }
    if (lane.session.status.state === 'working') { working += 1; continue }
    idle += 1
  }
  return { total: group.lanes.length, done, needsYou, error, working, idle }
}
