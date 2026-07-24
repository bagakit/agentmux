import { randomUUID } from 'node:crypto'
import type { ExecutionHost } from '@agentmux/core'
import type { AppConfig, CreateWorktreeInput, WorkspaceRecord } from '../shared/contracts.js'

type ConfigWriter = {
  save(value: AppConfig): Promise<AppConfig>
}

export type WorktreeCreation = {
  config: AppConfig
  workspace: WorkspaceRecord
}

function labelFor(input: CreateWorktreeInput): string {
  return input.name?.trim() || input.path.split(/[\\/]/).filter(Boolean).pop() || input.branch
}

export class WorktreeService {
  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly configWriter: ConfigWriter
  ) {}

  async create(input: CreateWorktreeInput, config: AppConfig): Promise<WorktreeCreation> {
    const repoPath = input.repoPath.trim()
    const path = input.path.trim()
    const branch = input.branch.trim()
    const baseRef = input.baseRef.trim()
    if (!repoPath || !path || !branch || !baseRef) {
      throw new Error('Repository, worktree path, branch, and base ref are required')
    }
    if (config.workspaces.some((item) => item.hostId === input.hostId && item.path === path)) {
      throw new Error(`Workspace already registered: ${path}`)
    }

    const host = this.hostFor(input.hostId)
    const result = await host.run(
      'git',
      ['-C', repoPath, 'worktree', 'add', '-b', branch, '--', path, baseRef],
      { timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Git worktree creation failed')
    }

    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: labelFor({ ...input, path, branch }),
      hostId: input.hostId,
      path,
      kind: 'worktree',
      repoPath,
      branch
    }
    const nextConfig = await this.configWriter.save({
      ...config,
      workspaces: [...config.workspaces, workspace]
    })
    return { config: nextConfig, workspace }
  }
}
