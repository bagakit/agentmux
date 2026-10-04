/** Git transport types are owned by the neutral package; GitHub/PR remain host capabilities. */
export type * from '@agentmux/git/types'

/**
 * The result of probing GitHub CLI availability and authentication for a workspace. Three states the
 * UI must keep distinct: `not-installed` (the gh binary is absent — the fix is to install it),
 * `not-authenticated` (gh is present but logged out — the fix is `gh auth login`), and `authenticated`
 * (ready). Authentication is entirely delegated to `gh auth`; AgentMux only *probes* `gh auth status`
 * and never reads, stores, or forwards a token — gh inherits GH_TOKEN/GITHUB_TOKEN from the process on
 * its own, so this adds no new credential-storage surface.
 */
export type GhAuthProbe =
  | { kind: 'not-installed' }
  | { kind: 'not-authenticated' }
  | { kind: 'authenticated' }

export type CreatePullRequestInput = {
  title: string
  body: string
  base: string
  /** Omitted lets gh infer the current branch, which is the ordinary case. */
  head?: string
  draft?: boolean
}

/**
 * Where a pull request's base branch came from, so the UI can say why it is proposing that target.
 *
 * `remote-head` is `origin/HEAD` — the remote's own declared default, the only authoritative answer.
 * `fallback` is a guess made because that ref is absent: it is genuinely missing in ordinary clones
 * (`git clone` writes it, but a repo initialized locally and pushed never gets one, and `git remote
 * set-head` is the only way to add it), so a UI that assumes "the default branch is knowable" is wrong
 * on a large fraction of real repositories. A guess must be visible and overridable, never silent —
 * opening a PR against the wrong base is not a mistake the user can undo by clicking again.
 */
export type PrBaseSource = 'remote-head' | 'fallback'

/**
 * Everything needed to answer "can a pull request be opened right now?", read in ONE main-process call.
 *
 * Why one call rather than the renderer assembling it: two of these facts (`baseRef`,
 * `baseExistsOnRemote`) have no renderer-side source at all — there is no `ls-remote` on the git bridge
 * and no notion of a default branch in this contract. The rest would take three independent awaits
 * (`gh.authStatus`, `git.status`, `git.aheadBehind`), and anything that awaits between reading two
 * facts can act on a pair that was never true together: the branch can move while the auth probe is in
 * flight. Gathering them together makes the set internally consistent by construction.
 *
 * This is a *hint*, not the authority. `GhService.createPullRequest` re-checks the base against the
 * remote and refuses on its own terms; this exists so the user gets "push it first" instead of whatever
 * gh happens to print. `checkedAt` is when the read happened, so a stale panel can say so.
 */
export type PrReadiness = {
  auth: GhAuthProbe
  branch: string | null
  baseRef: string
  baseSource: PrBaseSource
  baseExistsOnRemote: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasUncommittedChanges: boolean
  checkedAt: number
}

/**
 * Three outcomes, kept apart because they call for different responses.
 *
 * `refused` is a decision made *before* anything was created — a failed preflight, a missing binary,
 * an empty title — so nothing exists on GitHub and the composer keeps its content for a retry.
 * `failed` means gh ran and did not succeed; the message is already credential-scrubbed. Neither is
 * retried automatically: a write that may have partly landed must never be repeated on its own, or the
 * user ends up with two pull requests.
 */
export type CreatePullRequestResult =
  | { kind: 'created'; url: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }
