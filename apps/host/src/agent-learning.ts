import { createHash } from 'node:crypto'
import { AgentMuxError, AgentMuxSpatialStateStore, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext } from '@agentmux/core'
import { parseAgentLearningResult } from '@agentmux/core/agent-learning'
import { AgentLearningOwner } from './agent-learning-owner.js'
import { createAgentLearningResources } from './agent-learning-resources.js'
import { readConfiguredExecutor } from './mote-resources.js'

/** Read the original configuration on demand; no mirrored settings or launch secrets. */
export function createHostAgentLearning(options: {
  directory: string; configurationPath: string; spatial?: AgentMuxSpatialStateStore
  runtime(): AgentMuxHeadlessRuntime
  desktop(context: AgentMuxRpcCallContext): Promise<import('@agentmux/core').AgentMuxRpcClient>
}) {
  const spatial = options.spatial ?? new AgentMuxSpatialStateStore()
  const configuration = async (executorId: string) => {
    const config = await readConfiguredExecutor(options.configurationPath, executorId)
    const revision = createHash('sha256').update(JSON.stringify(config)).digest('hex')
    return { config, revision }
  }
  return new AgentLearningOwner({ directory: options.directory, ownerRuntimeId: () => options.runtime().ownerIdentity().runtimeId,
    core: () => options.runtime().client,
    executor: async executorId => { const original = await configuration(executorId); return { providerId: original.config.providerId, revision: original.revision } },
    create: async input => {
      let original: Awaited<ReturnType<typeof configuration>>
      try { original = await configuration(input.executorId!) }
      catch (error) { throw new AgentMuxError(error instanceof Error ? error.message : String(error), 'LEARNING_EXECUTOR_UNCONFIRMED', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 }) }
      const { config, revision } = original
      if (revision !== input.executorRevision) throw new AgentMuxError('The chosen original Executor changed after preparation. Keep this learning operation and frozen input; restore that exact Executor configuration before continuing this operation.', 'LEARNING_EXECUTOR_CONFLICT', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
      const { executorRevision: _revision, initialMessageAdmission: _admission, threadId: _thread, ...request } = input
      return await options.runtime().client.createAgentWithDelivery({ ...request, providerId: config.providerId,
        commandOverride: config.command, args: [...config.args], env: { ...config.env }, injectAgentMuxGuide: config.injectAgentMuxGuide })
    },
    target: createAgentLearningResources({ configurationPath: options.configurationPath, spatial }),
    confirmation: async (confirmationId, binding) => {
      const input = { confirmationId, binding }, desktop = await options.desktop({ transport: 'unix' })
      try { parseAgentLearningResult('agent.learning.confirmation', await desktop.call('agent.learning.confirmation', input), input) }
      finally { await desktop.dispose() }
    }
  })
}
