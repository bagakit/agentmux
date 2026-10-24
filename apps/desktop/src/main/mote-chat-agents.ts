import { AgentMuxError } from '@agentmux/core'
import { createMoteChatAgents as createHostMoteChatAgents } from '@agentmux/host/mote-chat-agents'
import { createMoteChatResources } from '@agentmux/host/mote-resources'
import { profileAgentContext } from '../shared/user-profile.js'
import type { AppConfig } from '../shared/contracts.js'
import type { ScratchTopics } from './scratch-topics.js'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { DesktopRuntimeClient } from './desktop-host.js'
export type MoteChatAgentOptions = {
  config(): AppConfig
  catalog(): Promise<AgentMuxSpaceCatalog | null>
  topics: Pick<ScratchTopics, 'readForDirectory' | 'read' | 'prepareAgent'>
  clients(): readonly { hostId: string; client: DesktopRuntimeClient }[]
}
export type DesktopMoteChatAgents = ReturnType<typeof createHostMoteChatAgents>
/** Desktop supplies its original config owner; the resource and agent workflow are framework-free. */
export function createMoteChatAgents(options: MoteChatAgentOptions): DesktopMoteChatAgents {
  const core = (hostId: string) => { const found = options.clients().filter(entry => entry.hostId === hostId); if (found.length !== 1) throw new AgentMuxError('The original Mote Host is unavailable.', 'MOTE_CHAT_HOST_UNAVAILABLE'); return found[0]!.client }
  const resources = createMoteChatResources({ topics: options.topics, catalog: options.catalog, configuration: async target => {
    const config = options.config(), found = config.workspaces.filter(workspace => workspace.id === target.workspaceId), profileContext = profileAgentContext(config.profile)
    return { workspace: found.length === 1 ? found[0]! : null, ...(profileContext ? { profileContext } : {}) }
  } })
  return createHostMoteChatAgents({ resources, clients: options.clients, executors: {
    resolve: async (_hostId, executorId, workspacePath) => {
      const config = options.config(), executor = Object.hasOwn(config.executors, executorId) ? config.executors[executorId] : undefined
      if (!executor) throw new AgentMuxError('The original saved Mote Executor is unavailable.', 'MOTE_CHAT_EXECUTOR_UNAVAILABLE')
      return { providerId: executor.providerId, launch: { injectAgentMuxGuide: executor.injectAgentMuxGuide, commandOverride: executor.command, ...(executor.args ? { args: executor.args } : {}), env: { ...executor.env, AGENTMUX_WIKI_DIR: workspacePath } } }
    },
    create: async prepared => {
      if (prepared.executorRevision || typeof prepared.input.injectAgentMuxGuide !== 'boolean') throw new AgentMuxError('This prepared creation belongs to its original Host Executor owner. Retain and inspect it without recomposing.', 'MOTE_CHAT_EXECUTOR_UNCONFIRMED')
      return await core(prepared.executionHostId).createAgentWithDelivery({ ...prepared.input, injectAgentMuxGuide: prepared.input.injectAgentMuxGuide })
    }
  } })
}
