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
  WorkspaceRecord
} from '../shared/contracts.js'
import { scrubGitCredentials } from './git-service.js'

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
 * GitHub CLI capability probing, beside `GitService` in Desktop main and, like it, never spawning a
 * process itself — everything runs through the injected `ExecutionHost.run('gh', argv)` seam so the
 * whole class is driven by a fake executor in tests.
 *
 * The single job here is to answer, without side effects, "is gh installed, and is it authenticated?"
 * — three states the UI keeps distinct so it can give the right fix. Authentication is delegated
 * wholly to `gh auth`: this probes `gh auth status` and reads the outcome, it never handles a token.
 */
export class GhService {
  constructor(private readonly hostFor: (id: string) => ExecutionHost) {}

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
    const base = assertSafeGhRef(input.base, 'base branch')
    const head = input.head === undefined ? undefined : assertSafeGhRef(input.head, 'head branch')
    const title = input.title.trim()
    if (!title) return { kind: 'refused', reason: 'A pull request needs a title.' }

    // Preflight: the base must exist on the remote. `ls-remote --exit-code` answers with its exit code,
    // but only an exit of 0 or 2 is an ANSWER — anything else (no network, no permission, gh/git
    // missing) means we do not know, and not knowing is a refusal.
    let probe
    try {
      probe = await host.run(
        'git',
        ['-C', workspace.path, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${base.replace(/^origin\//u, '')}`],
        GH_RUN_OPTIONS
      )
    } catch {
      return { kind: 'refused', reason: 'Could not verify the base branch on the remote, so the pull request was not created.' }
    }
    if (probe.exitCode === 2) {
      return { kind: 'refused', reason: `The base branch ${base} does not exist on the remote.` }
    }
    if (probe.exitCode !== 0) {
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
          message: scrubGitCredentials(result.stderr.trim() || result.stdout.trim() || 'gh pr create failed.')
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

  private workspace(config: AppConfig, id: string): WorkspaceRecord {
    const workspace = config.workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`Unknown workspace: ${id}`)
    return workspace
  }
}
