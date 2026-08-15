import type { WorkspaceRecord } from '../../../shared/contracts'
import type {
  PrBaseSource,
  PrReadiness
} from '../../../shared/git-contracts'
import type { CreatePrIntentState, CreatePrToken } from './create-pr-intent'
import {
  evaluatePrEligibility,
  PR_BLOCKER_MESSAGES,
  type PrBlockerKey,
  type PrEligibilityInput
} from './pr-eligibility'

/**
 * What one "open a pull request" click should do, decided from a readiness read.
 *
 * `blocked` carries every unmet condition with its copy, so the panel shows the whole list at once.
 * `ready` carries the create payload — including the intent token and the eligibility input the store
 * will re-check — plus the base and where it came from, so the form can show a guess AS a guess.
 */
export type PrLaunchPlan =
  | { kind: 'blocked'; blockers: PrBlockerKey[]; messages: string[] }
  | {
      kind: 'ready'
      branch: string
      baseRef: string
      baseSource: PrBaseSource
      token: CreatePrToken
      current: CreatePrIntentState
      eligibility: PrEligibilityInput
    }

/**
 * Turn one readiness read into the whole decision.
 *
 * The reason this is a function taking `readiness` **once** — rather than the component reading the
 * ladder's input from readiness and then assembling the token from wherever else it can reach — is that
 * two independent derivations of the same fact drift, and here the drift is silent and expensive: the
 * ladder would clear a PR against the branch and base it inspected while the token carried a different
 * pair, so the intent guard downstream would compare a payload nobody asked for. That exact shape (two
 * sites each resolving "the current thing" across an await) has already shipped twice in this codebase.
 * One argument in, one plan out, and there is no second place for the pair to come from.
 *
 * `now` is passed rather than read from a clock so this stays pure and the token's `startedAt` is the
 * caller's moment, not this module's.
 *
 * A `ready` plan is a *hint*, never authority. The store re-runs the ladder and main re-checks the base
 * against the remote; this exists so the user reads "push it first" instead of whatever gh prints.
 */
export function planPrLaunch(input: {
  readiness: PrReadiness
  workspace: WorkspaceRecord
  now: number
}): PrLaunchPlan {
  const { readiness, workspace } = input
  // The ladder's input is a projection of the same read, named field by field rather than spread: a
  // widened PrReadiness must not silently start feeding the ladder something it never agreed to judge.
  const eligibility: PrEligibilityInput = {
    auth: readiness.auth,
    branch: readiness.branch,
    baseRef: readiness.baseRef,
    baseExistsOnRemote: readiness.baseExistsOnRemote,
    upstream: readiness.upstream,
    ahead: readiness.ahead,
    behind: readiness.behind,
    hasUncommittedChanges: readiness.hasUncommittedChanges
  }
  const verdict = evaluatePrEligibility(eligibility)
  // `branch === null` is already a blocker (`no-branch`), so an eligible verdict cannot have one — but
  // the check is here rather than asserted away, because a token with a null branch would compare
  // unequal to every later state and abort a PR the user is entitled to open.
  if (!verdict.eligible || readiness.branch === null) {
    const blockers = verdict.blockers
    return {
      kind: 'blocked',
      blockers,
      messages: blockers.map((key) => PR_BLOCKER_MESSAGES[key])
    }
  }
  return {
    kind: 'ready',
    branch: readiness.branch,
    baseRef: readiness.baseRef,
    baseSource: readiness.baseSource,
    token: {
      worktreeId: workspace.id,
      worktreePath: workspace.path,
      branch: readiness.branch,
      baseRef: readiness.baseRef,
      startedAt: input.now
    },
    current: {
      worktreeId: workspace.id,
      branch: readiness.branch,
      baseRef: readiness.baseRef
    },
    eligibility
  }
}

/**
 * A first draft of the PR title from the branch name: `feature/add-retry-to-uploader` → `Add retry to
 * uploader`. The user edits it before anything is sent; this only exists so the common case is one click
 * plus a glance rather than one click plus typing.
 *
 * Deliberately not clever. It takes the last path segment (so a `feature/` or `user/name/` prefix does
 * not end up in the title), turns separators into spaces, and capitalizes the first letter — nothing
 * that could turn a branch name into something the user would not recognise as coming from it. An empty
 * result yields an empty string rather than a placeholder, because a title the user did not write must
 * never be what gets submitted.
 */
export function draftPrTitleFromBranch(branch: string): string {
  const segment = branch.split('/').filter(Boolean).at(-1) ?? ''
  const words = segment.replace(/[-_.]+/gu, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/** What one "open a pull request" click produces: the plan, and the draft to seed the form with. */
export type PrLaunchOpening = {
  /** null when readiness could not be read at all — the reader's own error surface says why. */
  plan: PrLaunchPlan | null
  title: string
  body: string
}

/**
 * Read readiness once, plan from it, and draft a title — the whole of what one click does.
 *
 * This lives here rather than inside the panel's click handler for a reason that is about *guarding*, not
 * tidiness. A handler defined inside a component closes over its state; with no DOM in this test project
 * there is no way to click it, so a handler whose body was silently emptied (one `return` at the top) is
 * indistinguishable from a working one — every call site it contains is still there in the source for a
 * syntactic guard to count. Measured: inserting that one `return` left the whole suite green. As a plain
 * async function it can be called, so "the reader is actually reached" becomes an assertion instead of an
 * inference, and the shell left behind in the component has no branch and no early exit to hide in.
 *
 * `check` is passed in rather than the hook being reached from here: this stays free of React and of the
 * bridge, and the caller keeps the one reader whose error surface the panel already renders.
 */
export async function beginPrLaunch(input: {
  check: () => Promise<PrReadiness | null>
  workspace: WorkspaceRecord
  now: number
}): Promise<PrLaunchOpening> {
  const readiness = await input.check()
  // A failed read is not a blocked plan: `check` has already written the reason to its own error surface,
  // and inventing a blocker here would be a second, weaker account of the same failure.
  if (!readiness) return { plan: null, title: '', body: '' }
  const plan = planPrLaunch({ readiness, workspace: input.workspace, now: input.now })
  // The draft is seeded from the plan's branch, not the readiness': the title has to describe the same
  // branch the token targets, and those are one value precisely so they cannot disagree.
  return {
    plan,
    title: plan.kind === 'ready' ? draftPrTitleFromBranch(plan.branch) : '',
    body: ''
  }
}
