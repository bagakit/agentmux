// Shell-style prompt-history for the multiline composer: up/down recall with draft preservation.
// Pure so the React component that owns the textarea DOM can stay a thin shell — all recall logic
// lives here and is unit-tested for real. (The component cannot run effects/handlers under node-env
// vitest; this module can.)

export type HistoryState = {
  entries: readonly string[] // submitted prompts, oldest -> newest
  cursor: number // index into entries; === entries.length means "on the live draft"
  stash: string | null // the live draft, saved when the user first arrows up off it
}

export const emptyHistory: HistoryState = { entries: [], cursor: 0, stash: null }

// Record a just-submitted prompt. HIST_IGNORE_DUPS: skip a second copy of the newest entry. Empty /
// whitespace-only prompts are not history. Recording always snaps navigation back to the live position
// (cursor === entries.length) and clears the stash.
export function recordHistory(state: HistoryState, prompt: string): HistoryState {
  if (prompt.trim() === '') return state
  const newest = state.entries[state.entries.length - 1]
  const entries = newest === prompt ? state.entries : [...state.entries, prompt]
  return { entries, cursor: entries.length, stash: null }
}

// Navigate history. `draft` is the live textarea value at keypress. Returns { state, value } when the
// keystroke is HANDLED (component preventDefaults and sets the textarea to `value`), or null when there
// is nothing to recall and the caret should move normally.
//
// cursor === entries.length is the one live-draft sentinel: no separate boolean, so "am I on the draft"
// and "which entry" are the same number and cannot disagree.
export function navigateHistory(
  state: HistoryState,
  direction: 'older' | 'newer',
  draft: string
): { state: HistoryState; value: string } | null {
  const { entries, cursor, stash } = state
  const live = entries.length

  if (direction === 'older') {
    if (cursor === live) {
      if (entries.length === 0) return null // nothing to recall — let the caret move
      // Stash the live draft on the first step off it, jump to the newest entry.
      const next = live - 1
      return { state: { entries, cursor: next, stash: draft }, value: entries[next]! }
    }
    if (cursor === 0) {
      // Oldest already shown: shells "beep" — stay put but keep it HANDLED so the caret doesn't jump
      // past the recalled line. State unchanged.
      return { state, value: entries[0]! }
    }
    const next = cursor - 1
    return { state: { entries, cursor: next, stash }, value: entries[next]! }
  }

  // direction === 'newer'
  if (cursor === live) return null // already on the live draft, nothing newer
  if (cursor === live - 1) {
    // Newest entry -> back to the live draft: restore the stashed draft and clear it. The draft-restore
    // is the behaviour users notice most.
    return { state: { entries, cursor: live, stash: null }, value: stash ?? '' }
  }
  const next = cursor + 1
  return { state: { entries, cursor: next, stash }, value: entries[next]! }
  // Every `entries[i]!` above is guarded: the branch condition that reaches each line has already proven
  // the index is in range (noUncheckedIndexedAccess widens it to `| undefined` regardless).
}

// ponytail: known ceiling — editing a recalled entry then navigating does NOT re-stash the edited text;
// only the original live draft is preserved. Matches basic shell recall and keeps the reducer small.
// Upgrade path: snapshot `draft` into a per-cursor overlay map if per-entry edits ever need to survive.

// Pure caret-boundary predicates so "only trigger history at the line boundary" is testable, not DOM
// code. caret is a 0-based index into value.
export function caretAtFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes('\n')
}

export function caretAtLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes('\n')
}
