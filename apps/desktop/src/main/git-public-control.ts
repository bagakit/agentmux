import { AgentMuxError, parseGitParams, parseGitResult, type AgentMuxRpcGitOwner, type AgentMuxRpcCallContext, type GitMethod, type GitParameterMap, type GitResultMap, type WorktreeCloseoutParams, type WorktreeCloseoutReceipt } from '@agentmux/core'
import type { AppConfig } from '../shared/contracts.js'
import type { GitService } from './git-service.js'
import type { WorktreeService } from './worktree-service.js'

/** The original resource authorizes reads and closeout; mutations stay at their existing owner. */
export class GitPublicControl implements AgentMuxRpcGitOwner {
  constructor(private readonly ports: {
    config(): AppConfig
    git: Pick<GitService, 'history' | 'commitDetails' | 'commitDiff' | 'branchDiff'>
    worktrees?: Pick<WorktreeService, 'observe'>
    closeWorktree?(params: WorktreeCloseoutParams): Promise<WorktreeCloseoutReceipt>
  }) {}

  async call<M extends GitMethod>(method: M, value: GitParameterMap[M], context?: AgentMuxRpcCallContext): Promise<GitResultMap[M]> {
    const params = parseGitParams(method, value)
    context?.signal?.throwIfAborted()
    if (method === 'git.worktree.close') {
      if (!this.ports.closeWorktree) throw new AgentMuxError('Worktree closeout is unavailable at its original owner. Existing Agents and work remain available.', 'CONTROL_UNAVAILABLE')
      // Closing can withdraw the source record. Its result is checked against the
      // original request. The closeout owner checks the exact resource against
      // either the live source or its original saved operation on readback.
      const result = await this.ports.closeWorktree(params as WorktreeCloseoutParams)
      return parseGitResult(method, result, params)
    }
    const config = this.ports.config()
    this.assertTarget(params, config)
    let result: GitResultMap[GitMethod]
    if (method === 'git.worktrees') {
      result = this.ports.worktrees ? await this.ports.worktrees.observe(params.workspaceId, config)
        : { kind: 'unavailable', ...params.expectedResource, checkedAt: Date.now(), reason: 'Git worktree observation is unavailable. Existing Zones and workfaces remain available.',
          directories: [{ path: params.expectedResource.workspacePath, kind: 'unavailable', reason: 'The original Host directory observer is unavailable. Refresh to retry.' }] }
    } else if (method === 'git.history') {
      const { workspaceId, expectedResource: _resource, ...input } = params as GitParameterMap['git.history']
      result = await this.ports.git.history(workspaceId, input, config)
    } else if (method === 'git.commit') {
      const { workspaceId, expectedResource: _resource, ...input } = params as GitParameterMap['git.commit']
      result = await this.ports.git.commitDetails(workspaceId, input, config)
    } else {
      const { workspaceId, input } = params as GitParameterMap['git.diff']
      result = 'kind' in input
        ? await this.ports.git.commitDiff(workspaceId, input, config)
        : await this.ports.git.branchDiff(workspaceId, input, config)
    }
    context?.signal?.throwIfAborted()
    this.assertTarget(params, this.ports.config())
    return parseGitResult(method, result, params)
  }

  private assertTarget(params: GitParameterMap[GitMethod], config: AppConfig): void {
    const workspace = config.workspaces.find(item => item.id === params.workspaceId)
    if (!workspace || workspace.hostId !== params.expectedResource.hostId || workspace.path !== params.expectedResource.workspacePath) {
      throw new AgentMuxError('The original Git Workspace changed or is unavailable. Discover its exact Host and path before another read; existing workspaces and Agents are retained.', 'GIT_RESOURCE_MISMATCH')
    }
  }
}
