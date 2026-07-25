import type { GhAuthProbe } from '../../../shared/contracts'

/**
 * Everything the PR-eligibility ladder needs to decide "can a PR be opened right now?", gathered from
 * capabilities that already exist rather than recomputed here: `auth` is {@link GhAuthProbe} from the
 * gh probe, `upstream`/`ahead`/`behind` come straight from GitService's ahead-behind (the same effective
 * upstream it resolves — this ladder never re-derives it), `branch` is the current branch (null on a
 * detached HEAD), and `hasUncommittedChanges` folds the status list into one boolean. `baseRef` is the
 * target branch the PR would merge into and `baseExistsOnRemote` whether that ref is present on the
 * remote. Kept as plain data so the ladder is a pure function, unit-testable with no git or gh in reach.
 */
export type PrEligibilityInput = {
  auth: GhAuthProbe
  branch: string | null
  baseRef: string
  baseExistsOnRemote: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasUncommittedChanges: boolean
}

/**
 * A single reason a PR cannot be opened yet. Each key is stable and maps to exactly one line of
 * actionable copy in {@link PR_BLOCKER_MESSAGES}; the UI keys off the key, never off the prose, so the
 * wording can change without breaking a test or a caller.
 */
export type PrBlockerKey =
  | 'gh-not-installed'
  | 'gh-not-authenticated'
  | 'no-branch'
  | 'no-upstream'
  | 'not-ahead'
  | 'behind-upstream'
  | 'branch-equals-base'
  | 'uncommitted-changes'
  | 'base-missing-on-remote'

export type PrEligibility = {
  eligible: boolean
  blockers: PrBlockerKey[]
}

/**
 * The ladder. Every unmet condition is reported, not just the first: a person seeing "why can't I open
 * a PR" wants the whole list at once, not one reveal per fix. `eligible` is simply "no blockers".
 *
 * Two orderings of intent matter. `gh` availability is checked before authentication so a missing
 * binary ("install gh") and a present-but-logged-out binary ("run gh auth login") stay distinct rather
 * than collapsing into one vague auth error. And a detached HEAD reports `no-branch` on its own — the
 * branch-vs-base comparison is skipped when there is no branch, so a null branch never masquerades as a
 * false `branch-equals-base`.
 */
export function evaluatePrEligibility(input: PrEligibilityInput): PrEligibility {
  const blockers: PrBlockerKey[] = []

  if (input.auth.kind === 'not-installed') blockers.push('gh-not-installed')
  else if (input.auth.kind === 'not-authenticated') blockers.push('gh-not-authenticated')

  if (input.branch === null) blockers.push('no-branch')
  else if (input.branch === input.baseRef) blockers.push('branch-equals-base')

  if (input.upstream === null) blockers.push('no-upstream')
  if (input.ahead <= 0) blockers.push('not-ahead')
  if (input.behind > 0) blockers.push('behind-upstream')
  if (input.hasUncommittedChanges) blockers.push('uncommitted-changes')
  if (!input.baseExistsOnRemote) blockers.push('base-missing-on-remote')

  return { eligible: blockers.length === 0, blockers }
}

/**
 * One actionable line per blocker. The two `gh` blockers carry deliberately different fixes — install
 * the binary vs. run `gh auth login` — because that is the whole point of keeping them distinct. Copy
 * lives beside the keys so a key added without a message is caught by the exhaustive `Record` type.
 */
export const PR_BLOCKER_MESSAGES: Record<PrBlockerKey, string> = {
  'gh-not-installed': 'GitHub CLI is not installed. Install gh to open pull requests from AgentMux.',
  'gh-not-authenticated': 'GitHub CLI is not authenticated. Run gh auth login in a terminal, then retry.',
  'no-branch': 'You are on a detached HEAD. Check out a branch before opening a pull request.',
  'no-upstream': 'This branch has no upstream. Push it first so there is a remote branch to compare.',
  'not-ahead': 'This branch has no commits ahead of its upstream — there is nothing to open a pull request with.',
  'behind-upstream': 'This branch is behind its upstream. Pull or sync it before opening a pull request.',
  'branch-equals-base': 'The branch and the base are the same. Pick a different base to open a pull request.',
  'uncommitted-changes': 'You have uncommitted changes. Commit or discard them before opening a pull request.',
  'base-missing-on-remote': 'The base branch does not exist on the remote. Pick a base that is published.'
}
