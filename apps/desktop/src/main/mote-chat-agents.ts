import { AgentMuxError, agentDiscoveryActivity, type AgentMuxAgentCreationInspection, type AgentMuxAgentSession, type AgentMuxClient } from '@agentmux/core'
import { parseConversationCheckpointPage, type ConversationCheckpointPage, type ConversationRef } from '@agentmux/core/conversation'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MoteChatTarget } from '@agentmux/core/mote-chat'
import type { MoteChatAgentPort, MoteChatCreatedAgent, MoteChatPreparedLaunch } from '@agentmux/connectors'
import type { AppConfig } from '../shared/contracts.js'
import { directoryIdentity, homeZoneId } from '../shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import { profileAgentContext } from '../shared/user-profile.js'
import type { ScratchTopics } from './scratch-topics.js'

type Core = Pick<AgentMuxClient, 'createAgentWithDelivery' | 'inspectAgentCreation' | 'readAgentSession'>
export type MoteChatAgentOptions = {
  config(): AppConfig
  catalog(): Promise<AgentMuxSpaceCatalog | null>
  topics: Pick<ScratchTopics, 'readForDirectory' | 'read' | 'prepareAgent'>
  clients(): readonly { hostId: string; client: Core }[]
  checkpoint(reference: ConversationRef): Promise<ConversationCheckpointPage>
}
export type DesktopMoteChatAgents = MoteChatAgentPort & {
  assertTarget(target: MoteChatTarget): Promise<void>
  /** Validate the saved new-chat Executor without preparing an identity or starting a Run. */
  assertReady(target: MoteChatTarget): Promise<void>
}
const failure = (code: string, message: string): never => { throw new AgentMuxError(message, code) }

/** Exact Mote files and existing Core creation, independently of Renderer, focus or Region placement. */
export function createMoteChatAgents(options: MoteChatAgentOptions): DesktopMoteChatAgents {
  function core(hostId: string): Core {
    const matches = options.clients().filter(entry => entry.hostId === hostId)
    if (matches.length !== 1) failure('MOTE_CHAT_HOST_UNAVAILABLE', 'The original Mote execution Host is unavailable or ambiguous. Its messages, creation and existing Agents are retained.')
    return matches[0]!.client
  }
  async function target(input: MoteChatTarget) {
    const config = options.config(), catalog = await options.catalog()
    const spaces = catalog?.spaces.filter(space => space.spaceId === input.spaceId)
    const zones = catalog?.zones.filter(zone => zone.zoneId === input.zoneId)
    const mote = spaces?.length === 1 ? spaces[0] : null, zone = zones?.length === 1 ? zones[0] : null
    const workspaces = config.workspaces.filter(workspace => workspace.id === input.expectedResource.workspaceId)
    const workspace = workspaces.length === 1 ? workspaces[0] : null
    if (!mote || mote.kind !== 'mote' || !zone || zone.kind !== 'home' || !workspace ||
      workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local' ||
      workspace.hostId !== input.expectedResource.hostId || workspace.path !== input.expectedResource.workspacePath ||
      mote.hostId !== workspace.hostId || zone.hostId !== workspace.hostId || zone.workspaceId !== workspace.id ||
      zone.zoneId !== homeZoneId(mote.spaceId) || !mote.directoryPath || !zone.directoryPath ||
      !catalog?.bindings.some(binding => binding.spaceId === mote.spaceId && binding.zoneId === zone.zoneId)) {
      return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The exact original local Mote home is unconfirmed. Its files, conversations and saved chat route are retained; refresh this Mote before continuing.')
    }
    const fact = await options.topics.readForDirectory(workspace, mote.directoryPath)
    if (!fact || fact.id !== mote.topicId || !fact.identityDirectoryPath ||
      directoryIdentity(workspace.hostId, fact.identityDirectoryPath) !== mote.spaceId ||
      !fact.physicalDirectoryPath || !fact.confirmedDirectoryPaths?.includes(mote.directoryPath) || !fact.confirmedDirectoryPaths.includes(zone.directoryPath)) {
      return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The original Mote directory identity is unconfirmed. Keep its exact route and inspect the same Mote; no replacement Agent was created.')
    }
    return { config, workspace, fact }
  }
  async function ready(input: MoteChatTarget) {
    const original = await target(input)
    const topic = await options.topics.read(original.workspace, original.fact.id)
    if (!topic || topic.kind !== 'mote' || topic.identityDirectoryPath !== original.fact.identityDirectoryPath ||
      topic.physicalDirectoryPath !== original.fact.physicalDirectoryPath || topic.quickMode?.status === 'unconfirmed') {
      return failure('MOTE_CHAT_EXECUTOR_UNCONFIRMED', 'This Mote’s saved new-chat settings are unconfirmed. Review Executor for new chat in its Profile; existing conversations remain available.')
    }
    const executorId = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.executorId : undefined
    if (!executorId) return failure('MOTE_CHAT_EXECUTOR_REQUIRED', 'Choose Executor for new chat in this Mote Profile before enabling Feishu chat. No Agent was started.')
    const executor = Object.hasOwn(original.config.executors, executorId) ? original.config.executors[executorId] : undefined
    if (!executor) return failure('MOTE_CHAT_EXECUTOR_UNAVAILABLE', 'The saved Mote new-chat Executor is unavailable. Choose an existing Executor in this Mote Profile; its conversations and saved choice are retained.')
    core(original.workspace.hostId)
    return { ...original, executorId, executor }
  }
  function exact(prepared: MoteChatPreparedLaunch, session: AgentMuxAgentCreationInspection): AgentMuxAgentSession {
    const input = prepared.input
    if (session.kind !== 'agent') return failure('MOTE_CHAT_AGENT_RETIRED', 'This original Mote chat Agent was explicitly retired. Its history and exact creation remain available; it was not recreated.')
    if (session.agentSessionId !== input.agentSessionId || session.hostId !== 'local' && session.hostId !== prepared.executionHostId ||
      session.providerId !== input.providerId || session.executorId !== input.executorId || session.workspacePath !== input.workspacePath ||
      !input.createOperationId || session.creation?.createOperationId !== input.createOperationId) {
      return failure('MOTE_CHAT_CREATE_MISMATCH', 'The original Core creation does not confirm this exact Mote chat Session and intent. Keep the original operation and inspect it without replacing its identity.')
    }
    if (session.creation.agentMuxContext !== 'confirmed') return failure('MOTE_CHAT_CONTEXT_UNCONFIRMED', 'The original Agent exists, but its required Mote and conversation-history context is unconfirmed. Its creation and incoming message are retained for inspection.')
    return session
  }
  async function created(prepared: MoteChatPreparedLaunch, value: AgentMuxAgentCreationInspection): Promise<MoteChatCreatedAgent> {
    const session = exact(prepared, value)
    const reference = { hostId: prepared.executionHostId, agentSessionId: session.agentSessionId }
    // A missing native source is an observation of this already-created Session, never absence of creation.
    const checkpoint = parseConversationCheckpointPage(await options.checkpoint(reference), reference)
    return { executionHostId: reference.hostId, agentSessionId: reference.agentSessionId, checkpoint }
  }
  return {
    assertTarget: async input => { await target(input) },
    assertReady: async input => { await ready(input) },
    prepare: async ({ generation, systemContext }) => {
      const original = await ready(generation.target)
      if (generation.executionHostId !== original.workspace.hostId) return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The chat reservation belongs to another Mote Host. Its original identity and incoming message are retained.')
      const executor = structuredClone(original.executor), profileContext = profileAgentContext(original.config.profile)
      const prepared = await options.topics.prepareAgent(original.workspace, original.fact.id, {
        providerId: executor.providerId, sessionId: generation.agentSessionId
      })
      if (prepared.snapshot.kind !== 'mote' || prepared.snapshot.id !== original.fact.id ||
        prepared.absolutePath !== original.fact.physicalDirectoryPath || prepared.snapshot.identityDirectoryPath !== original.fact.identityDirectoryPath) {
        return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The original Mote changed during preparation. The same reservation and incoming message are retained; no replacement Agent was started.')
      }
      const input: MoteChatPreparedLaunch['input'] = {
        agentSessionId: generation.agentSessionId, createOperationId: generation.createOperationId,
        providerId: executor.providerId, executorId: original.executorId, workspacePath: prepared.absolutePath,
        injectAgentMuxGuide: executor.injectAgentMuxGuide, commandOverride: executor.command,
        ...(executor.args === undefined ? {} : { args: [...executor.args] }),
        env: { ...executor.env, AGENTMUX_WIKI_DIR: prepared.absolutePath },
        agentMuxNote: [prepared.prompt, systemContext, profileContext].filter(note => note?.trim()).join('\n\n'),
        optionalContext: structuredClone(prepared.optionalContext)
      }
      return { executionHostId: generation.executionHostId, input }
    },
    create: async prepared => {
      const receipt = await core(prepared.executionHostId).createAgentWithDelivery(structuredClone(prepared.input))
      return await created(prepared, receipt.session)
    },
    inspect: async prepared => {
      let session: AgentMuxAgentCreationInspection
      try { session = await core(prepared.executionHostId).inspectAgentCreation(prepared.input.agentSessionId!) }
      catch (error) {
        // Core explicitly has neither a Session nor prepared creation; stable create IDs are still retained.
        if (error instanceof AgentMuxError && error.code === 'AGENT_CREATION_UNKNOWN') return null
        throw error
      }
      return await created(prepared, session)
    },
    activity: async reference => {
      const session = await core(reference.executionHostId).readAgentSession(reference.agentSessionId)
      if (!session) return { lastActivityAt: null }
      if (session.agentSessionId !== reference.agentSessionId || session.hostId !== 'local' && session.hostId !== reference.executionHostId) {
        return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The activity observation belongs to another original Mote chat Session. Its recorded activity and Agent are retained.')
      }
      return { lastActivityAt: agentDiscoveryActivity(session)?.observedAt ?? null }
    }
  }
}
