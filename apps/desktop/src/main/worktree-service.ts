import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type {
  AppConfig,
  CreateWorktreeForBranchInput,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord,
  WorkspaceSelectionResult
} from '../shared/contracts.js'

type ConfigWriter = {
  save(value: AppConfig): Promise<AppConfig>
}

type GitWorktree = { path: string; branch: string | null }
type GitBranchesSnapshot = Extract<WorkspaceBranchesSnapshot, { kind: 'git-repository' }>

const NOT_A_GIT_REPOSITORY = /^fatal: not a git repository \(or any of the parent directories\): .+\n?$/
const GIT_DISCOVERY_OPTIONS = {
  env: { LC_ALL: 'C', LANG: 'C' },
  timeoutMs: 20_000,
  maxOutputBytes: 256 * 1024
} as const
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
      host.run('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        timeoutMs: 20_000,
        maxOutputBytes: 2 * 1024 * 1024
      }),
      host.run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain', '-z'], {
        timeoutMs: 20_000,
        maxOutputBytes: 2 * 1024 * 1024
      })
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
    if (!branch) throw new Error(`Unknown branch: ${branchName}`)
    if (branch.worktreePath) throw new Error(`Branch already has a worktree: ${branchName}`)
    if (config.workspaces.some((item) => item.hostId === snapshot.hostId && item.path === path)) {
      throw new Error(`Workspace already registered: ${path}`)
    }
    const host = this.hostFor(snapshot.hostId)
    const result = await host.run(
      'git',
      ['-C', snapshot.repoPath, 'worktree', 'add', '--', path, branchName],
      { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
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
      NOT_A_GIT_REPOSITORY.test(result.stderr) &&
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
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || fallback)
    }
  }

  private async register(config: AppConfig, workspace: WorkspaceRecord): Promise<WorkspaceSelectionResult> {
    const nextConfig = await this.configWriter.save({
      ...config,
      workspaces: [...config.workspaces, workspace]
    })
    return { config: nextConfig, workspace }
  }
}
