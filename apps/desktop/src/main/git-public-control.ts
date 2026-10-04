import { AgentMuxError, parseGitParams, parseGitResult, type AgentMuxRpcGitOwner, type AgentMuxRpcCallContext, type GitMethod, type GitParameterMap, type GitResultMap } from '@agentmux/core'
import type { AppConfig } from '../shared/contracts.js'
import type { GitService } from './git-service.js'

/** The configured original resource authorizes each read; all Git work stays in GitService. */
export class GitPublicControl implements AgentMuxRpcGitOwner {
  constructor(private readonly ports: {
    config(): AppConfig
    git: Pick<GitService, 'history' | 'commitDetails' | 'commitDiff' | 'branchDiff'>
  }) {}

  async call<M extends GitMethod>(method: M, value: GitParameterMap[M], context?: AgentMuxRpcCallContext): Promise<GitResultMap[M]> {
    const params = parseGitParams(method, value)
    context?.signal?.throwIfAborted()
    const config = this.ports.config()
    this.assertTarget(params, config)
    let result: GitResultMap[GitMethod]
    if (method === 'git.history') {
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
