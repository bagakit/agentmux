import type { ExecutionHost } from '@agentmux/core'
import { GitRepository, readLocalWorktreeFile, createRunnerWorktreeReader, scrubGitCredentials, type WorktreeReader } from '@agentmux/git'
import type { AppConfig } from '../shared/contracts.js'
import type {
  GitBranchCompareInput, GitBranchDiffDescriptor, GitCommitDetailsInput, GitCommitDiffDescriptor,
  GitHistoryInput, GitPullStrategy, GitPushOptions, GitRemoteOptions
} from '@agentmux/git/types'

/** Desktop authorization/config adapter; all Git facts and operations belong to @agentmux/git. */
export class GitService {
  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly readWorktreeFile?: WorktreeReader
  ) {}

  private repository(workspaceId: string, config: AppConfig): GitRepository {
    const workspace = config.workspaces.find(item => item.id === workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    const host = this.hostFor(workspace.hostId)
    const reader = this.readWorktreeFile ?? (host.kind === 'local'
      ? readLocalWorktreeFile
      : createRunnerWorktreeReader(host))
    return new GitRepository({ hostId: workspace.hostId, path: workspace.path }, host, reader)
  }

  async projectIdentity(workspaceId: string, config: AppConfig): Promise<import('@agentmux/git/types').GitProjectIdentityResult> {
    const workspace = config.workspaces.find(item => item.id === workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    try { return await this.repository(workspaceId, config).projectIdentity() }
    catch (error) {
      return { kind: 'unavailable', hostId: workspace.hostId, workspacePath: workspace.path,
        reason: scrubGitCredentials(error instanceof Error ? error.message : 'Repository source observation failed.') }
    }
  }

  history(workspaceId: string, input: GitHistoryInput = {}, config: AppConfig) {
    return this.repository(workspaceId, config).history(input)
  }

  compareBranches(workspaceId: string, input: GitBranchCompareInput, config: AppConfig) {
    return this.repository(workspaceId, config).compareBranches(input)
  }

  branchDiff(workspaceId: string, descriptor: GitBranchDiffDescriptor, config: AppConfig) {
    return this.repository(workspaceId, config).branchDiff(descriptor)
  }

  commitDetails(workspaceId: string, input: GitCommitDetailsInput, config: AppConfig) {
    return this.repository(workspaceId, config).commitDetails(input)
  }

  commitDiff(workspaceId: string, descriptor: GitCommitDiffDescriptor, config: AppConfig) {
    return this.repository(workspaceId, config).commitDiff(descriptor)
  }

  status(workspaceId: string, config: AppConfig) {
    return this.repository(workspaceId, config).status()
  }

  stage(workspaceId: string, path: string, config: AppConfig) {
    return this.repository(workspaceId, config).stage(path)
  }

  commit(workspaceId: string, message: string, config: AppConfig) {
    return this.repository(workspaceId, config).commit(message)
  }

  diff(workspaceId: string, workspacePath: string, config: AppConfig) {
    return this.repository(workspaceId, config).diff(workspacePath)
  }

  unstage(workspaceId: string, path: string, config: AppConfig) {
    return this.repository(workspaceId, config).unstage(path)
  }

  discard(workspaceId: string, path: string, untracked: boolean, config: AppConfig) {
    return this.repository(workspaceId, config).discard(path, untracked)
  }

  aheadBehind(workspaceId: string, config: AppConfig) {
    return this.repository(workspaceId, config).aheadBehind()
  }

  push(workspaceId: string, config: AppConfig, options: GitPushOptions = {}) {
    return this.repository(workspaceId, config).push(options)
  }

  pull(workspaceId: string, config: AppConfig, options: { strategy?: GitPullStrategy } = {}) {
    return this.repository(workspaceId, config).pull(options)
  }

  fetch(workspaceId: string, config: AppConfig, options: GitRemoteOptions = {}) {
    return this.repository(workspaceId, config).fetch(options)
  }
}
