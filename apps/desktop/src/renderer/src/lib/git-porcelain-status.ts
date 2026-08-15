import type { GitFileChange } from '../../../shared/git-contracts'

/**
 * The one place the app reads git's two porcelain status columns and says what they mean.
 *
 * Porcelain gives every change two letters, `XY`: X is index-vs-HEAD, Y is worktree-vs-index. Almost
 * every code is legible one column at a time — and that is exactly the trap. **A merge conflict is a
 * property of the pair, not of either letter**, so a reader that picks one column and switches on it
 * gets four of the seven conflict codes wrong while appearing to work:
 *
 *   | code | what git means                | reading X alone says |
 *   |------|-------------------------------|----------------------|
 *   | `DD` | both deleted                  | deleted              |
 *   | `AU` | added by us                   | added   ← wrong      |
 *   | `UD` | deleted by them               | conflicted           |
 *   | `UA` | added by them                 | conflicted           |
 *   | `DU` | deleted by us                 | deleted ← wrong      |
 *   | `AA` | both added                    | added   ← wrong      |
 *   | `UU` | both modified                 | conflicted           |
 *
 * The three that come out right are right **by accident** — their X happens to be `U`. That is why
 * this was wrong in two independently hand-written copies (the file tree's colouring and the Changes
 * panel's label) and why neither noticed: on the common conflict, `UU`, both were correct.
 *
 * The pair also cannot be reduced to "both columns are dirty": `AD` — staged an add, then deleted the
 * file from disk — has two non-blank columns and is not a conflict at all. Real git emits it outside
 * any merge. So the seven codes are a closed, enumerated set, taken from git's own table in
 * `git-status(1)`, and verified against bytes recorded from a real conflicted repository.
 *
 * Both surfaces map {@link GitChangeClass} to their own vocabulary through an exhaustive `Record`, so
 * the *decision* lives here once while each surface keeps the wording it needs — the tree has one
 * `conflicted` colour, the panel can say which side deleted. Two derivations of one fact agree until
 * the day they don't, and the divergence is invisible (记忆 two-resolutions-that-happen-to-agree).
 */

/**
 * Git's unmerged codes, verbatim and complete, from `git-status(1)`'s own table.
 *
 * Exported so a test can pin the set rather than trusting a comment, and so the "is this a conflict"
 * question has exactly one answer in the app. Order follows git's table, not significance.
 */
export const GIT_UNMERGED_CODES = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'] as const

export type GitUnmergedCode = (typeof GIT_UNMERGED_CODES)[number]

const UNMERGED_CODES: ReadonlySet<string> = new Set(GIT_UNMERGED_CODES)

/**
 * Git's own phrasing for each conflict, keyed by code. `Record<GitUnmergedCode, string>` so a code
 * added to the set above cannot ship without wording.
 *
 * The wording matters: "deleted by them" and "deleted by us" call for opposite actions, and a single
 * "Conflicted" for all seven throws that away at the moment the user most needs it.
 */
export const GIT_UNMERGED_DESCRIPTION: Record<GitUnmergedCode, string> = {
  DD: 'both deleted',
  AU: 'added by us',
  UD: 'deleted by them',
  UA: 'added by them',
  DU: 'deleted by us',
  AA: 'both added',
  UU: 'both modified'
}

/**
 * The conflict code for this change, or `null` when it is not an unmerged entry.
 *
 * Reads **both** columns as one token — the whole point of this module. `null` is the ordinary answer;
 * callers then classify by the single relevant column, which is safe once conflicts are off the table.
 */
export function gitUnmergedCodeOf(change: GitFileChange): GitUnmergedCode | null {
  const code = `${change.index}${change.worktree}`
  return UNMERGED_CODES.has(code) ? (code as GitUnmergedCode) : null
}

/**
 * What one git change is, as a closed set the whole renderer shares.
 *
 * Closed so every consumer's presentation table can be an exhaustive `Record` and a new member makes
 * `tsc` red at each table instead of degrading to a silent fallback (记忆: exhaustive tables must be
 * tsc-forced). `renamed` and `copied` stay apart here even though the tree draws them alike — the
 * distinction exists in git, and collapsing it is the consumer's decision to state explicitly.
 */
export type GitChangeClass =
  | 'conflicted'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'modified'

/** Every class except `conflicted` — what remains once the pair has been ruled out. */
type GitNonConflictClass = Exclude<GitChangeClass, 'conflicted'>

/**
 * Classify a change already known not to be a conflict, from the one column that applies.
 *
 * Split out from {@link gitChangeClass} so the "not a conflict" half is a type rather than a comment:
 * this returns {@link GitNonConflictClass}, which is what lets the label path call it and index an
 * exhaustive table with no cast and no unreachable arm. Folding it back into the caller would put an
 * impossible `conflicted` case back in front of every downstream table.
 *
 * The rule is the original one: the index column when something is staged, otherwise the worktree
 * column. Git's letters are an open set, so the tail falls back to `modified` — any tracked, non-blank
 * change is at least a modification, and the fallback is a real member of the union rather than an
 * "unknown" that would break the exhaustive tables downstream.
 */
function gitSingleColumnClass(change: GitFileChange): GitNonConflictClass {
  if (change.untracked) return 'untracked'
  const mark = change.staged ? change.index : change.worktree
  switch (mark) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typeChanged'
    case 'M':
    default:
      return 'modified'
  }
}

/**
 * Classify one change: conflicts first (from the pair), then the relevant single column.
 *
 * Order is load-bearing. Conflict detection must precede the single-column switch, because four of the
 * seven codes have an X of `A` or `D` and would be swallowed by it.
 */
export function gitChangeClass(change: GitFileChange): GitChangeClass {
  if (gitUnmergedCodeOf(change) !== null) return 'conflicted'
  return gitSingleColumnClass(change)
}

/** Prose for every non-conflict class, for a status column the user reads. Exhaustive. */
const CHANGE_CLASS_LABEL: Record<GitNonConflictClass, string> = {
  untracked: 'Untracked',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typeChanged: 'Type changed',
  modified: 'Modified'
}

/**
 * A short human label for one change, naming the conflict when there is one.
 *
 * A conflict reads `Conflict: deleted by them` rather than a bare `Conflicted`, so the row carries the
 * one fact that decides what the user does next.
 *
 * The two branches call the two halves of the classification directly, which is why neither an
 * unreachable `'conflicted'` arm nor a cast appears here. An earlier draft called `gitChangeClass` and
 * kept a `classified === 'conflicted'` arm returning `Conflict: both modified`: dead code, since
 * `gitChangeClass` reports `'conflicted'` exactly when `gitUnmergedCodeOf` is non-null and that case
 * returned one line above — but dead code holding a *wrong* answer, naming one conflict kind for all
 * seven, which is the very information loss #746 is about.
 */
export function gitChangeLabel(change: GitFileChange): string {
  const unmerged = gitUnmergedCodeOf(change)
  if (unmerged !== null) return `Conflict: ${GIT_UNMERGED_DESCRIPTION[unmerged]}`
  return CHANGE_CLASS_LABEL[gitSingleColumnClass(change)]
}
