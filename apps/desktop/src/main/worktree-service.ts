import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import { gitFailureError, GIT_NONINTERACTIVE_ENV, isNotAGitRepositoryStderr } from './git-service.js'
import type {
  AppConfig,
  CreateWorktreeForBranchInput,
  FanOutTeardownResult,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord,
  WorkspaceSelectionResult,
  WorktreeRetention
} from '../shared/contracts.js'

type ConfigWriter = {
  save(value: AppConfig): Promise<AppConfig>
}

/**
 * A removal that stopped, carrying which of the three world-states it stopped in.
 *
 * Why the classification is thrown rather than inferred by the catch: only the code that was standing at
 * the failure knows whether git had already deleted the directory. A `catch` sees one `Error` and cannot
 * tell "git refused" from "git succeeded and then the record write failed" — those differ by whether the
 * directory still exists, and guessing wrong tells the user to go review work that is already gone. The
 * previous shape had exactly one catch assigning one hardcoded meaning to all of them.
 */
export class WorktreeRetainedError extends Error {
  constructor(readonly retention: WorktreeRetention, message: string) {
    super(message)
    this.name = 'WorktreeRetainedError'
  }
}

/**
 * Classify a caught teardown failure.
 *
 * Anything that is not an explicit {@link WorktreeRetainedError} is `git-failed`: an unforeseen throw
 * leaves the directory in place (the record write is the only step that runs after git, and it raises the
 * explicit error), so `git-failed` is the conservative answer — it promises the user nothing was
 * discarded and offers no discard button, which is safe to say about an unknown failure.
 */
export function classifyRetention(error: unknown): { retention: WorktreeRetention; reason: string } {
  if (error instanceof WorktreeRetainedError) {
    return { retention: error.retention, reason: error.message }
  }
  return { retention: 'git-failed', reason: error instanceof Error ? error.message : String(error) }
}

/** One loser's fate in a keep-the-winner teardown. Shares the renderer's vocabulary, never a second one. */
export type FanOutTeardownOutcome = FanOutTeardownResult

export type KeepOneOfFanOutResult = {
  config: AppConfig
  keptWorkspaceId: string
  outcomes: FanOutTeardownOutcome[]
}

type GitWorktree = { path: string; branch: string | null }
type GitBranchesSnapshot = Extract<WorkspaceBranchesSnapshot, { kind: 'git-repository' }>

// Every git invocation in this service shares the main process's non-interactive environment (see
// `GIT_NONINTERACTIVE_ENV`): an unattended `worktree add` against a repository whose remote wants a
// password must fail fast, not sit forever on a credential prompt no one can answer. Only the clocks
// and output ceilings differ, by verb.
//
// Discovery: `rev-parse`/`status --porcelain` answer with a path or a short list.
const GIT_DISCOVERY_OPTIONS = {
  env: GIT_NONINTERACTIVE_ENV,
  timeoutMs: 20_000,
  maxOutputBytes: 256 * 1024
} as const
// Enumeration: a repository with thousands of branches or worktrees legitimately produces far more.
const GIT_ENUMERATION_OPTIONS = {
  env: GIT_NONINTERACTIVE_ENV,
  timeoutMs: 20_000,
  maxOutputBytes: 2 * 1024 * 1024
} as const
// Mutation: `worktree add` checks out a tree and `worktree remove` deletes one, both of which touch the
// filesystem proportionally to the repository's size, so they get the longer clock.
const GIT_MUTATION_OPTIONS = {
  env: GIT_NONINTERACTIVE_ENV,
  timeoutMs: 60_000,
  maxOutputBytes: 2 * 1024 * 1024
} as const
// Not a git invocation: this runs `test -e`, so it deliberately carries no git environment.
const METADATA_PROBE_OPTIONS = { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 } as const

export function parseGitWorktreePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  let current: GitWorktree | null = null
  for (const rawToken of output.split('\0')) {
    const token = rawToken.replace(/^\n+/, '')
    if (token.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: token.slice('worktree '.length), branch: null }
    } else if (current && token.startsWith('branch refs/heads/')) {
      current.branch = token.slice('branch refs/heads/'.length)
    }
  }
  if (current) worktrees.push(current)
  return worktrees
}

export function parseGitBranches(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean))]
}

export class WorktreeService {
  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly configWriter: ConfigWriter
  ) {}

  async list(workspaceId: string, config: AppConfig): Promise<WorkspaceBranchesSnapshot> {
    const workspace = this.workspace(config, workspaceId)
    const host = this.hostFor(workspace.hostId)
    const repoPath = workspace.repoPath ?? await this.resolveRepoPath(host, workspace.path)
    if (repoPath === null) {
      return { kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path }
    }
    const [branchesResult, worktreesResult] = await Promise.all([
      host.run('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
        GIT_ENUMERATION_OPTIONS),
      host.run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain', '-z'],
        GIT_ENUMERATION_OPTIONS)
    ])
    this.assertGit(branchesResult, 'Could not list Git branches')
    this.assertGit(worktreesResult, 'Could not list Git worktrees')
    const worktrees = parseGitWorktreePorcelain(worktreesResult.stdout)
    const worktreeByBranch = new Map(
      worktrees.flatMap((item) => item.branch ? [[item.branch, item] as const] : [])
    )
    const branchNames = new Set(parseGitBranches(branchesResult.stdout))
    for (const item of worktrees) if (item.branch) branchNames.add(item.branch)
    const branches = [...branchNames].map((name) => {
      const worktreePath = worktreeByBranch.get(name)?.path ?? null
      const registered = worktreePath
        ? config.workspaces.find((item) => item.hostId === workspace.hostId && item.path === worktreePath)
        : undefined
      return {
        name,
        worktreePath,
        workspaceId: registered?.id ?? null,
        isCurrent: worktreePath === workspace.path
      }
    }).sort((left, right) =>
      Number(right.isCurrent) - Number(left.isCurrent) ||
      Number(right.worktreePath !== null) - Number(left.worktreePath !== null) ||
      left.name.localeCompare(right.name)
    )
    return { kind: 'git-repository', hostId: workspace.hostId, repoPath, branches }
  }

  async openBranch(
    workspaceId: string,
    branchName: string,
    config: AppConfig
  ): Promise<WorkspaceSelectionResult> {
    const snapshot = await this.list(workspaceId, config)
    this.assertRepository(snapshot)
    const branch = snapshot.branches.find((item) => item.name === branchName)
    if (!branch?.worktreePath) throw new Error(`Branch has no worktree: ${branchName}`)
    const existing = config.workspaces.find(
      (item) => item.hostId === snapshot.hostId && item.path === branch.worktreePath
    )
    if (existing) return { config, workspace: existing }
    return await this.register(config, {
      id: randomUUID(),
      name: branch.name,
      hostId: snapshot.hostId,
      path: branch.worktreePath,
      kind: 'worktree',
      repoPath: snapshot.repoPath,
      branch: branch.name
    })
  }

  async createForBranch(
    input: CreateWorktreeForBranchInput,
    config: AppConfig
  ): Promise<WorkspaceSelectionResult> {
    const branchName = input.branch.trim()
    const path = input.path.trim()
    if (!branchName || !path) throw new Error('Branch and worktree path are required')
    const snapshot = await this.list(input.workspaceId, config)
    this.assertRepository(snapshot)
    const branch = snapshot.branches.find((item) => item.name === branchName)
    // Creating the branch and adopting an existing one are different intents, and confusing them is how
    // someone's work gets moved. `createBranch` therefore requires the name to be free, and the default
    // path still requires it to exist — neither silently does the other's job.
    if (input.createBranch) {
      if (branch) throw new Error(`Branch already exists: ${branchName}`)
    } else {
      if (!branch) throw new Error(`Unknown branch: ${branchName}`)
      if (branch.worktreePath) throw new Error(`Branch already has a worktree: ${branchName}`)
    }
    if (config.workspaces.some((item) => item.hostId === snapshot.hostId && item.path === path)) {
      throw new Error(`Workspace already registered: ${path}`)
    }
    const host = this.hostFor(snapshot.hostId)
    const result = await host.run(
      'git',
      input.createBranch
        // `-b <branch> <path> HEAD`: the new branch starts at the repository's current HEAD, which is
        // what "run these N agents from where I am now" means. Git itself refuses if the name is taken,
        // so the check above is the readable error rather than the only guard.
        ? ['-C', snapshot.repoPath, 'worktree', 'add', '-b', branchName, '--', path, 'HEAD']
        : ['-C', snapshot.repoPath, 'worktree', 'add', '--', path, branchName],
      GIT_MUTATION_OPTIONS
    )
    // Registration only happens after git succeeded, so a failed create never leaves a workspace record
    // pointing at a directory that does not exist.
    this.assertGit(result, 'Git worktree creation failed')
    return await this.register(config, {
      id: randomUUID(),
      name: branchName,
      hostId: snapshot.hostId,
      path,
      kind: 'worktree',
      repoPath: snapshot.repoPath,
      branch: branchName
    })
  }

  /**
   * Remove one worktree and withdraw its workspace record.
   *
   * A fan-out that cannot clean up is a fan-out that leaks: N directories and N workspace rows every
   * time someone compares approaches. This is the symmetric half of createForBranch, and it is a general
   * capability rather than fan-out scaffolding.
   *
   * Uncommitted work is refused by default. Losing an agent's output because it happened to be the lane
   * you did not pick is the one outcome this must never produce silently, so discarding is opt-in and
   * says what it is.
   */
  async removeWorktree(
    input: { workspaceId: string; discardChanges?: boolean },
    config: AppConfig
  ): Promise<{ config: AppConfig; removedPath: string }> {
    const workspace = this.workspace(config, input.workspaceId)
    if (workspace.kind !== 'worktree' || !workspace.repoPath) {
      throw new Error(`Workspace is not a worktree: ${workspace.name}`)
    }
    const host = this.hostFor(workspace.hostId)

    if (!input.discardChanges) {
      // `status --porcelain` is empty exactly when there is nothing to lose: no modifications, no staged
      // changes, no untracked files. Anything at all means stop and say so.
      const status = await host.run(
        'git',
        ['-C', workspace.path, 'status', '--porcelain'],
        GIT_DISCOVERY_OPTIONS
      )
      this.assertGit(status, 'Could not inspect the worktree for uncommitted changes')
      if (status.stdout.trim() !== '') {
        throw new WorktreeRetainedError(
          'uncommitted-changes',
          `Worktree has uncommitted changes: ${workspace.name}. Review them, or remove it explicitly discarding the changes.`
        )
      }
    }

    const removal = await host.run(
      'git',
      input.discardChanges
        ? ['-C', workspace.repoPath, 'worktree', 'remove', '--force', '--', workspace.path]
        : ['-C', workspace.repoPath, 'worktree', 'remove', '--', workspace.path],
      GIT_MUTATION_OPTIONS
    )
    this.assertGit(removal, 'Git worktree removal failed')

    // Deliberately NO `git worktree prune` here. It looked like hygiene, but it is both redundant and
    // dangerous: `worktree remove` already deletes the admin entry, so the path is immediately
    // re-addable (verified against real git), while `prune` deregisters EVERY worktree whose directory
    // happens to be missing right now — an unmounted volume or a directory someone moved by hand. This
    // method is a general capability, so that would silently drop an unrelated worktree's registration
    // for callers that never asked to touch it.

    // Withdrawn only after git confirmed: a record removed ahead of a failed removal would strand a
    // real directory with nothing pointing at it.
    //
    // Past this line the directory is GONE, so a failure here is not the same event as a failure above it.
    // The record still names a path that no longer exists, and removing again cannot fix it: the status
    // probe runs inside the vanished directory and fails, so every retry now reports a git failure. That
    // is why this is its own classification instead of being folded into the caller's catch — a consumer
    // told "retained" without it will offer to discard work that is already deleted.
    let nextConfig: AppConfig
    try {
      nextConfig = await this.configWriter.save({
        ...config,
        workspaces: config.workspaces.filter((item) => item.id !== workspace.id)
      })
    } catch (error) {
      throw new WorktreeRetainedError(
        'record-not-withdrawn',
        `Removed the worktree at ${workspace.path}, but could not update the workspace list: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    return { config: nextConfig, removedPath: workspace.path }
  }

  /**
   * Keep one lane of a fan-out, tear down the rest.
   *
   * The closing move of a bake-off: the user picked a winner, so that lane's worktree and its Session
   * stay exactly as they are, and the losing lanes are removed. This does not re-implement teardown — it
   * calls `removeWorktree` once per loser, which is why the dirty-tree protection is still in force:
   * a losing lane that still holds uncommitted work (an agent's output the user never chose to discard)
   * is refused, left on disk, kept in the record set, and reported as retained. Silently discarding the
   * lane a person did not pick is the one outcome this must never produce.
   *
   * One loser that cannot be cleaned up never strands the others that can — the clean lanes are removed
   * and the retained ones are reported with which of the three retention states they are in, mirroring how
   * a fan-out's launch failures never stop its successes. Whether to throw a retained lane away is a
   * per-lane, explicit choice made through `removeWorktree({ discardChanges: true })`; this batch has no
   * blanket "discard every dirty loser" switch, because that is exactly the data-loss lever the protection
   * exists to remove.
   */
  async keepOneOfFanOut(
    input: { keepWorkspaceId: string; removeWorkspaceIds: readonly string[] },
    config: AppConfig
  ): Promise<KeepOneOfFanOutResult> {
    // The winner must exist. Reporting a lane as kept when there is no such workspace would be a lie, and
    // failing here is better than quietly keeping nothing while tearing the others down.
    const kept = this.workspace(config, input.keepWorkspaceId)

    const outcomes: FanOutTeardownOutcome[] = []
    let current = config
    for (const workspaceId of input.removeWorkspaceIds) {
      // Never tear down the lane we were told to keep, even if a caller mistakenly lists it among the
      // losers. Removing the winner is precisely the mistake this guard exists to refuse.
      if (workspaceId === kept.id) continue
      try {
        const removal = await this.removeWorktree({ workspaceId }, current)
        current = removal.config
        outcomes.push({ status: 'removed', workspaceId, removedPath: removal.removedPath })
      } catch (error) {
        // `retained` says the removal did not complete; `retention` says how far it got, because only the
        // failing step knows. Two of the three leave the lane's directory intact (the protection refused,
        // or git failed) and are safe to describe as "still there to review". The third — git removed it
        // and the record write failed — does not, so it must not be reported as if it did: this used to
        // be one hardcoded sentence for all of them, and the batch banner told the user the lane still
        // held changes while its directory was already gone.
        outcomes.push({ status: 'retained', workspaceId, ...classifyRetention(error) })
      }
    }
    return { config: current, keptWorkspaceId: kept.id, outcomes }
  }

  private workspace(config: AppConfig, id: string): WorkspaceRecord {
    const workspace = config.workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`Unknown workspace: ${id}`)
    return workspace
  }

  private async resolveRepoPath(host: ExecutionHost, path: string): Promise<string | null> {
    const result = await host.run(
      'git',
      ['-C', path, 'rev-parse', '--show-toplevel'],
      GIT_DISCOVERY_OPTIONS
    )
    if (
      result.exitCode !== 0 &&
      isNotAGitRepositoryStderr(result.stderr) &&
      !await this.hasGitMetadataInAncestry(host, path)
    ) return null
    this.assertGit(result, 'Workspace is not a Git repository')
    const repoPath = result.stdout.trim()
    if (!repoPath) throw new Error('Git returned an empty repository path')
    return repoPath
  }

  private async hasGitMetadataInAncestry(host: ExecutionHost, path: string): Promise<boolean> {
    let directory = posix.normalize(path)
    while (true) {
      const metadataPath = posix.join(directory, '.git')
      const result = await host.run(
        'test',
        ['-e', metadataPath, '-o', '-L', metadataPath],
        METADATA_PROBE_OPTIONS
      )
      if (result.exitCode === 0) return true
      if (result.exitCode !== 1) this.assertGit(result, 'Could not inspect Git repository metadata')
      const parent = posix.dirname(directory)
      if (parent === directory) return false
      directory = parent
    }
  }

  private assertRepository(snapshot: WorkspaceBranchesSnapshot): asserts snapshot is GitBranchesSnapshot {
    if (snapshot.kind !== 'git-repository') throw new Error('Workspace is not a Git repository')
  }

  private assertGit(
    result: { exitCode: number; stdout: string; stderr: string },
    fallback: string
  ): void {
    // Shared with the branches service on purpose: this message reaches the user (it becomes
    // `retained.reason`, then the removal dialog's description) and it is built from git's stderr,
    // which can contain the remote URL's userinfo. See `gitFailureError`.
    if (result.exitCode !== 0) throw gitFailureError(result, fallback)
  }

  private async register(config: AppConfig, workspace: WorkspaceRecord): Promise<WorkspaceSelectionResult> {
    const nextConfig = await this.configWriter.save({
      ...config,
      workspaces: [...config.workspaces, workspace]
    })
    return { config: nextConfig, workspace }
  }
}
