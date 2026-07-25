/**
 * The intent behind one "create pull request" click.
 *
 * Creating a PR is several awaited steps — read the branch state, ask a model for a title and body,
 * call `gh` — and the user is free to keep working through all of them. So the click captures a token
 * describing what it was aimed at, and every later step checks that token before it lands.
 *
 * The direction of that check is the whole design, and it is easy to get backwards:
 *
 *   - Switching to ANOTHER worktree is NOT a conflict. The run keeps going and its result still lands
 *     on the worktree and branch it started from. Treating a switch as a conflict would mean opening a
 *     second window mid-flight silently discards the PR you were building — punishing ordinary use.
 *   - Drift INSIDE the same worktree IS a conflict. If the branch or base moved under the run, the
 *     payload no longer describes what the user asked for, so it must abort rather than open a PR
 *     against a target nobody chose.
 *
 * Pure: no IPC, no git, no store. The caller supplies both the token and the current state.
 */
export type CreatePrToken = {
  /** Identity of the worktree the click was aimed at. */
  worktreeId: string
  worktreePath: string
  branch: string
  baseRef: string
  /** Supplied by the caller; never read from a clock here so the module stays deterministic. */
  startedAt: number
}

export type CreatePrIntentState = {
  /** The worktree the user is looking at NOW — may differ from the token, which is fine. */
  worktreeId: string
  branch: string
  baseRef: string
}

export type CreatePrIntentVerdict =
  | { kind: 'proceed' }
  // The user moved on to another worktree. The run finishes against its own token.
  | { kind: 'proceed-detached' }
  | { kind: 'conflict'; reason: string }

/**
 * Normalise a base ref for comparison.
 *
 * `origin/main` and `refs/remotes/origin/main` are the same target written two ways, so a run must not
 * abort because git spelled it differently. `upstream/main` is a DIFFERENT remote and must never
 * compare equal — collapsing it would let a PR open against a repository the user did not pick.
 */
export function normalizeBaseRef(ref: string): string {
  const trimmed = ref.trim()
  const withoutRemotes = trimmed.startsWith('refs/remotes/')
    ? trimmed.slice('refs/remotes/'.length)
    : trimmed
  return withoutRemotes.startsWith('refs/heads/')
    ? withoutRemotes.slice('refs/heads/'.length)
    : withoutRemotes
}

export function evaluateCreatePrIntent(
  token: CreatePrToken,
  current: CreatePrIntentState
): CreatePrIntentVerdict {
  // A different worktree entirely: the user navigated away. Not our business — the run belongs to the
  // worktree it started in, and that worktree has not changed underneath it.
  if (current.worktreeId !== token.worktreeId) return { kind: 'proceed-detached' }

  if (current.branch !== token.branch) {
    return {
      kind: 'conflict',
      reason: `The branch changed from ${token.branch} to ${current.branch} while the pull request was being prepared.`
    }
  }
  if (normalizeBaseRef(current.baseRef) !== normalizeBaseRef(token.baseRef)) {
    return {
      kind: 'conflict',
      reason: `The base changed from ${token.baseRef} to ${current.baseRef} while the pull request was being prepared.`
    }
  }
  return { kind: 'proceed' }
}

/** Whether a verdict permits the create call to land. Both proceed variants do. */
export function intentAllowsCreate(verdict: CreatePrIntentVerdict): boolean {
  return verdict.kind !== 'conflict'
}
