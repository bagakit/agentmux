import type { SessionSnapshot } from '../../../shared/contracts'
import { attentionSortRank, categoryFor, type AttentionCategory } from './attention-event'

// Attention that survives collapsing.
//
// The window-wide bar answers "does anything need me". The tab dot answers it for one Session. Between
// them sat a gap: the Project Rail row showed a workspace COUNT, so a collapsed project with an Agent
// waiting inside looked exactly like an idle one. You had to open each project to find out who to
// handle first, which is the work the rollup was supposed to remove.
//
// This rolls the shared status vocabulary up one level, deriving from the same Session projection the
// bar and the dots already read — no second aggregation pipeline, and no new state.

// Highest attention wins, in the same order the rest of the app ranks it: needs-you above error above
// working. A row shows one signal, so it must be the most urgent one under it.
//
// The order comes from `attentionSortRank`, not from a local table. It used to be a second literal here
// that happened to agree with the shared one — and `tsc` cannot see two object literals disagree, so a
// change to either would have left the rail ranking rows differently from the roster and the switcher
// with nothing going red. `AttentionCategory` is a subset of the sort classes that table already covers,
// so there is nothing to translate; the whole reason to copy it was gone.

export type RowAttention = {
  // The single signal this row should carry, or null to stay neutral.
  category: AttentionCategory | null
  // How many Agents under this row are in that category, for the accessible name and tooltip.
  count: number
  // Total Agent Sessions under the row, so a caller can say "3 of 5" without a second pass.
  agents: number
}

const NEUTRAL: RowAttention = { category: null, count: 0, agents: 0 }

/**
 * Roll the Agents under one navigation row into a single attention signal.
 *
 * `done` is deliberately NOT surfaced here. A finished Agent is a notification and a Board column; a
 * persistent mark on a collapsed row would leave the rail permanently lit and make the one signal that
 * matters — someone is waiting on you — indistinguishable from routine completion.
 */
export function rowAttention(sessions: readonly SessionSnapshot[]): RowAttention {
  let winner: AttentionCategory | null = null
  let agents = 0
  const counts = new Map<AttentionCategory, number>()

  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    agents += 1
    const category = categoryFor(session.status.state)
    // Completion is real attention for a notification but not for a persistent row mark.
    if (!category || category === 'done') continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
    if (!winner || attentionSortRank(category) < attentionSortRank(winner)) winner = category
  }

  if (!winner) return { ...NEUTRAL, agents }
  return { category: winner, count: counts.get(winner) ?? 0, agents }
}

/**
 * The row's accessible name suffix and tooltip text.
 *
 * The count goes into the name rather than only the colour, so a screen reader gets the fact instead of
 * just "project" — the same reason the window bar puts its counts in its buttons' labels.
 */
export function rowAttentionLabel(attention: RowAttention): string | null {
  if (!attention.category || attention.count === 0) return null
  const one = attention.count === 1
  const noun = one ? 'Agent' : 'Agents'
  // The verb agrees with the noun independently: "1 Agent needs you" / "2 Agents need you".
  if (attention.category === 'needs-you') {
    return `${attention.count} ${noun} ${one ? 'needs' : 'need'} you`
  }
  return `${attention.count} ${noun} in error`
}
