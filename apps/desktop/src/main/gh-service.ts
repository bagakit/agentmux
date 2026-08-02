import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type {
  AppConfig,
  CreatePullRequestInput,
  CreatePullRequestResult,
  GhAuthProbe,
  PrBaseSource,
  PrReadiness,
  WorkspaceRecord
} from '../shared/contracts.js'
import { gitFailureMessage, scrubGitCredentials, type GitService } from './git-service.js'

/**
 * The base branch proposed when `origin/HEAD` cannot answer. Deliberately a single constant rather than
 * a list of candidates to try: probing for `main`, then `master`, then `develop` would make the guess
 * look like a finding. One labelled guess the user can see and override is honest; a search that lands
 * on something is a guess wearing evidence's clothes.
 */
const PR_FALLBACK_BASE = 'main'

/**
 * Non-interactive environment for every `gh` invocation. This runs in the unattended Desktop main
 * process, so gh must never sit waiting on a prompt from a terminal that is not there:
 *   - GH_PROMPT_DISABLED disables interactive prompting outright.
 *   - GH_NO_UPDATE_NOTIFIER stops a background version check from injecting noise or a stall.
 * Deliberately absent: any token. Authentication is entirely `gh auth`'s job — gh inherits
 * GH_TOKEN/GITHUB_TOKEN from `process.env` on its own, so putting one here would only add a
 * credential-handling surface AgentMux does not want. The probe reads gh's own state, it never sets it.
 */
const GH_NONINTERACTIVE_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1'
} as const

// A probe is a fast, read-only status check: a short timeout keeps a wedged gh from hanging the caller
// (the no-prompt env already removes the usual reason it would block), and a tight output ceiling is
// plenty for a status summary while capping a misbehaving binary.
const GH_RUN_OPTIONS = {
  env: GH_NONINTERACTIVE_ENV,
  timeoutMs: 15_000,
  maxOutputBytes: 1024 * 1024
} as const

// Creating a PR reaches the network and may wait on GitHub, so it gets a longer ceiling than a probe.
// It is still bounded: an unbounded write would leave the user unable to tell "slow" from "stuck".
const GH_CREATE_RUN_OPTIONS = {
  env: GH_NONINTERACTIVE_ENV,
  timeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024
} as const

/**
 * Refuse a ref that could be read as a flag or smuggle shell-significant bytes.
 *
 * argv is always an array here, so this is not about quoting — it is about a leading `-` turning a
 * branch name into a gh option, and about refusing the control characters and spaces a real ref
 * cannot contain anyway.
 */
function assertSafeGhRef(value: string, label: string): string {
  const ref = value.trim()
  if (ref === '') throw new Error(`A ${label} is required`)
  if (ref.startsWith('-')) throw new Error(`A ${label} cannot begin with "-"`)
  if (/[\0\n\r\t ~^:?*[\\]/.test(ref)) throw new Error(`Invalid ${label}: ${ref}`)
  return ref
}

/** True when a caught error is the process runner's "binary not found" rejection (spawn ENOENT). */
function isMissingBinaryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * `origin/main` → `main`: the plain branch name, with a remote-tracking prefix removed.
 *
 * There is exactly one of these because normalizing twice is how the ref you *verified* stops being the
 * ref you *use*. That is not hypothetical — it was the shape of a real bug here: the `ls-remote`
 * preflight stripped the prefix while the `gh pr create` argv did not, so a base of `origin/main` was
 * confirmed to exist as `main` and then handed to gh as `origin/main`.
 *
 * Only the leading `origin/` goes, and only once: a branch legitimately named `origin/thing` under a
 * differently-named remote must not lose a segment. The anchor is what makes that true, so it is not
 * decoration — `/origin\//` would eat the middle of `feature/origin/rework`.
 */
function plainBranchName(ref: string): string {
  return ref.replace(/^origin\//u, '')
}

/**
 * GitHub CLI capability probing, beside `GitService` in Desktop main and, like it, never spawning a
 * process itself — everything runs through the injected `ExecutionHost.run('gh', argv)` seam so the
 * whole class is driven by a fake executor in tests.
 *
 * The single job here is to answer, without side effects, "is gh installed, and is it authenticated?"
 * — three states the UI keeps distinct so it can give the right fix. Authentication is delegated
 * wholly to `gh auth`: this probes `gh auth status` and reads the outcome, it never handles a token.
 */
export class GhService {
  /**
   * `git` is injected rather than instantiated here so both services resolve a workspace's host through
   * the same seam and a test drives one fake executor, not two that could disagree about the repo.
   */
  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly git: Pick<GitService, 'status' | 'aheadBehind'>
  ) {}

  /**
   * Probe `gh auth status` for a workspace's host. The three outcomes come from two different signals,
   * which is what keeps them distinct:
   *   - A spawn ENOENT (gh is not on PATH) is `not-installed` — the fix is to install gh. This is the
   *     one caught rejection; it is recognized by its error code, not swallowed blindly, so a timeout
   *     or any other spawn failure re-throws as the real error it is rather than posing as absence.
   *   - A clean exit is `authenticated`; a non-zero exit is `not-authenticated` — gh itself exits 1
   *     when no host is logged in, and the fix there is `gh auth login`.
   * argv is an array (`['auth', 'status']`), never a shell string, and carries no user-controlled
   * token — so there is nothing here for a `-`-prefixed input to attack.
   */
  async authStatus(workspaceId: string, config: AppConfig): Promise<GhAuthProbe> {
    const host = this.hostFor(this.workspace(config, workspaceId).hostId)
    let result
    try {
      result = await host.run('gh', ['auth', 'status'], GH_RUN_OPTIONS)
    } catch (error) {
      if (isMissingBinaryError(error)) return { kind: 'not-installed' }
      throw error
    }
    return result.exitCode === 0 ? { kind: 'authenticated' } : { kind: 'not-authenticated' }
  }

  /**
   * Open a pull request through `gh pr create`.
   *
   * Deliberate choices, each guarding a way this can go wrong:
   *   - **The body goes through a temp file** (`--body-file`), not argv. A PR body is prose of
   *     unbounded length; passing it as an argument risks the platform's argv ceiling on exactly the
   *     inputs a person cared most about writing.
   *   - **No retry, ever.** Every other verb here is a read and safe to repeat; this one creates
   *     something in the outside world. A retry after an ambiguous failure opens a second pull request.
   *   - **Backend preflight is the final authority.** The renderer's eligibility ladder is a hint that
   *     may be stale by the time this runs, so the base is re-checked against the remote here — and an
   *     *unavailable* check is a refusal, not a pass. Proceeding on an unverified premise is how a PR
   *     ends up targeting a branch nobody chose.
   *   - Every ref is `assertSafeGhRef`-checked, so a `-`-prefixed value cannot turn into a gh flag.
   */
  async createPullRequest(
    workspaceId: string,
    input: CreatePullRequestInput,
    config: AppConfig
  ): Promise<CreatePullRequestResult> {
    const workspace = this.workspace(config, workspaceId)
    const host = this.hostFor(workspace.hostId)
    // Normalized ONCE, here, so the ref verified below is the same ref handed to gh further down.
    const base = plainBranchName(assertSafeGhRef(input.base, 'base branch'))
    const head = input.head === undefined ? undefined : assertSafeGhRef(input.head, 'head branch')
    const title = input.title.trim()
    if (!title) return { kind: 'refused', reason: 'A pull request needs a title.' }

    // Preflight: the base must exist on the remote. Only `present` may proceed — `unknown` means we
    // could not check, and "I could not check" is not "it is fine".
    const presence = await this.remoteBranchPresence(host, workspace.path, base)
    if (presence === 'absent') {
      return { kind: 'refused', reason: `The base branch ${base} does not exist on the remote.` }
    }
    if (presence === 'unknown') {
      return { kind: 'refused', reason: 'Could not verify the base branch on the remote, so the pull request was not created.' }
    }

    const bodyFile = join(tmpdir(), `agentmux-pr-${randomUUID()}.md`)
    try {
      // 0o600 because this is the user's prose sitting in a world-readable shared tmpdir for as long
      // as `gh` takes to run. Every other user-content write in this app already picks that mode.
      await writeFile(bodyFile, input.body, { encoding: 'utf8', mode: 0o600 })
      const argv = ['pr', 'create', '--base', base, '--title', title, '--body-file', bodyFile]
      if (head) argv.push('--head', head)
      if (input.draft) argv.push('--draft')
      const result = await host.run('gh', argv, GH_CREATE_RUN_OPTIONS)
      if (result.exitCode !== 0) {
        return {
          kind: 'failed',
          // gh echoes the remote in its errors, so scrub before this text can reach a UI or a log.
          message: gitFailureMessage(result, 'gh pr create failed.')
        }
      }
      return { kind: 'created', url: scrubGitCredentials(result.stdout.trim()) }
    } catch (error) {
      if (isMissingBinaryError(error)) return { kind: 'refused', reason: 'GitHub CLI is not installed.' }
      return { kind: 'failed', message: scrubGitCredentials(error instanceof Error ? error.message : String(error)) }
    } finally {
      // The body is the user's prose; never leave it lying in the temp directory.
      await rm(bodyFile, { force: true }).catch(() => {})
    }
  }

  /**
   * Gather, in one call, everything the renderer's eligibility ladder needs.
   *
   * Why this lives here rather than being assembled by the renderer from three bridge calls: two of
   * these facts have no renderer-side source at all (there is no `ls-remote` on the git bridge, and no
   * notion of a default branch in the contract), and the remaining six would be read across three
   * separate awaits — a set that can describe a state that never existed, because the branch can move
   * while the auth probe is in flight. This repo has already shipped that bug twice under a different
   * name; gathering the facts together is what makes them consistent by construction.
   *
   * Every step degrades toward *refusing*, never toward a false green: an unreadable branch is `null`
   * (the ladder reports `no-branch`), a base that cannot be verified is `false` — the same value as a
   * base that is genuinely missing, because both must block a click — and a `gh` that cannot be probed
   * still returns its own three-state answer. The one thing this must not do is report readiness it did
   * not establish. The write path keeps the distinction the user needs to hear it worded differently;
   * see {@link GhService.remoteBranchPresence}.
   */
  async prReadiness(workspaceId: string, config: AppConfig): Promise<PrReadiness> {
    const workspace = this.workspace(config, workspaceId)
    const host = this.hostFor(workspace.hostId)
    // The auth probe is the only step that can throw for a reason worth surfacing (a timeout is not
    // absence — see authStatus). Everything else below answers with a value.
    const auth = await this.authStatus(workspaceId, config)
    const status = await this.git.status(workspaceId, config)
    const branch = status.kind === 'git-repository' ? status.branch : null
    const hasUncommittedChanges = status.kind === 'git-repository' && status.changes.length > 0
    const aheadBehind = await this.git.aheadBehind(workspaceId, config)
    const base = await this.resolveBaseRef(host, workspace.path)
    const baseExistsOnRemote = (await this.remoteBranchPresence(host, workspace.path, base.ref)) === 'present'
    return {
      auth,
      branch,
      baseRef: base.ref,
      baseSource: base.source,
      baseExistsOnRemote,
      upstream: aheadBehind.upstream,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      hasUncommittedChanges,
      checkedAt: Date.now()
    }
  }

  /**
   * The base branch a PR would target, and whether that answer is authoritative.
   *
   * `origin/HEAD` is the remote's own declared default and the only real answer. It is **routinely
   * absent**: `git clone` writes it, but a repo created locally and pushed never gets one — this very
   * repository has no `refs/remotes/origin/HEAD` (`git symbolic-ref` on it exits fatal). So the absent
   * case is the common case, not an edge, and the fallback must be *labelled* rather than passed off as
   * knowledge: the UI shows the guess and lets the user change it, because a PR opened against the wrong
   * base cannot be undone by clicking again.
   */
  private async resolveBaseRef(
    host: ExecutionHost,
    repoPath: string
  ): Promise<{ ref: string; source: PrBaseSource }> {
    let result
    try {
      result = await host.run(
        'git',
        ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        GH_RUN_OPTIONS
      )
    } catch {
      return { ref: PR_FALLBACK_BASE, source: 'fallback' }
    }
    // `git symbolic-ref --short refs/remotes/origin/HEAD` prints `origin/<branch>`; the shared
    // normalizer turns that into the plain name.
    const ref = result.exitCode === 0 ? plainBranchName(result.stdout.trim()) : ''
    return ref ? { ref, source: 'remote-head' } : { ref: PR_FALLBACK_BASE, source: 'fallback' }
  }

  /**
   * Ask `origin` whether it has this branch. **Three** answers, not two: `ls-remote --exit-code` exits
   * 0 for present and 2 for absent, and those are the only two ANSWERS — any other exit, or a rejection,
   * means no network / no permission / git missing, which is `unknown`.
   *
   * The split matters because the two callers act on `unknown` differently and both are right:
   * {@link GhService.createPullRequest} refuses with a *different sentence* than "does not exist", so
   * the user is not told a falsehood about their remote, while {@link GhService.prReadiness} folds it
   * into "not verified" so the ladder blocks rather than inviting a click that would then be refused
   * deeper in. Collapsing the three states here would force one of them to lie.
   */
  private async remoteBranchPresence(
    host: ExecutionHost,
    repoPath: string,
    branch: string
  ): Promise<'present' | 'absent' | 'unknown'> {
    let probe
    try {
      probe = await host.run(
        'git',
        // The caller already normalized; asking again here would reintroduce the second decision this
        // helper exists to eliminate.
        ['-C', repoPath, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
        GH_RUN_OPTIONS
      )
    } catch {
      return 'unknown'
    }
    if (probe.exitCode === 0) return 'present'
    return probe.exitCode === 2 ? 'absent' : 'unknown'
  }

  private workspace(config: AppConfig, id: string): WorkspaceRecord {
    const workspace = config.workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`Unknown workspace: ${id}`)
    return workspace
  }
}
