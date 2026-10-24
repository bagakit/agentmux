import { AgentMuxError, spatialCatalog, type AgentMuxHeadlessRuntime, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { createMoteChatAgents } from './mote-chat-agents.js'
import { createMoteChatResources, readMoteConfiguredExecutor, readMoteResourceConfiguration } from './mote-resources.js'

/** Read the saved Mote's original configuration; no configuration or environment goes on RPC. */
export function createHostMoteChat(options: {
  configurationPath: string
  spatial: AgentMuxSpatialStateStore
  runtime(): AgentMuxHeadlessRuntime
}) {
  const resources = createMoteChatResources({
    configuration: resource => readMoteResourceConfiguration(options.configurationPath, resource),
    catalog: async () => { const original = await options.spatial.read(); return original ? spatialCatalog(original.graph) : null }
  })
  const exact = (hostId: string) => {
    if (hostId !== 'local') throw new AgentMuxError('The original Mote resource belongs to another Host. Its saved route and existing conversations are retained.', 'MOTE_CHAT_HOST_UNAVAILABLE')
    return options.runtime()
  }
  const agents = createMoteChatAgents({ resources,
    clients: () => [{ hostId: 'local', client: options.runtime().client }],
    executors: {
      resolve: async (hostId, executorId, workspacePath) => {
        exact(hostId)
        const config = await readMoteConfiguredExecutor(options.configurationPath, executorId)
        return { providerId: config.providerId, launch: {
          commandOverride: config.command, args: [...config.args],
          env: { ...config.env, AGENTMUX_WIKI_DIR: workspacePath }, injectAgentMuxGuide: config.injectAgentMuxGuide
        } }
      },
      create: async prepared => {
        if (prepared.executorRevision !== undefined) throw new AgentMuxError('This original prepared creation belongs to another Executor owner. Retain its exact operation and inspect it without recomposing.', 'MOTE_CHAT_EXECUTOR_UNCONFIRMED')
        return await exact(prepared.executionHostId).client.createAgentWithDelivery(prepared.input)
      }
    }
  })
  return { agents, assertTarget: agents.assertTarget, assertReady: agents.assertReady }
}
