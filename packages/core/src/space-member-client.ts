import { connectHostedAgentMux } from './hosted-client.js'
import { parseHostedBootstrap } from './hosted-value.js'
import { mintObjectId } from './object-id.js'
import { parseSpaceMemberRoute, parseSpaceMemberParams } from './space-member-codec.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcClient } from './public-rpc-client.js'
import type { AgentMuxHostedClient, AgentMuxHostedRpcPort, AgentMuxHostedStreamEvent } from './hosted-client-contract.js'
import type { SpaceMemberTarget, SpaceMemberReadingTarget, SpaceMemberRoute } from './space-member.js'

export type SpaceMemberClient = Pick<AgentMuxHostedClient, 'connect' | 'dispose' | 'onEvent' | 'onRunEvent' | 'runtimeOwnerIdentity' | 'runtimeIdentity' |
  'readAgentInputEpoch' | 'catalog' | 'providers' | 'agentSessions' | 'agentSession' | 'readAgentSession' | 'reattachAgent' | 'attachTerminal' |
  'refreshRunAttachment' | 'readRunReplay' | 'releaseRunAttachment' | 'resizeTerminal' | 'writeAgent' | 'pasteAgent' |
  'submitAgentPrompt' | 'statusAgent' | 'inspectAgentInteractionOperation' | 'inspectAgentInput' | 'inspectAgentPromptSubmission' |
  'stopAgentInputWaiting' | 'signalAgent' |
  'readAgentConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'releaseConversationView' | 'observeConversation'> & {
    /** Original exact-SID full metadata and Provider declarations, without an event lease prerequisite. */
    metadata(): Promise<import('./hosted-client-contract.js').AgentMuxHostedBootstrap>
    rejoinAgentInputWaiting(input: { ref: import('./agent-input-wait.js').AgentInputWaitRef }): ReturnType<AgentMuxHostedClient['rejoinAgentInputWaiting']>
    runtimeSubject(target: Extract<import('./runtime.js').AgentMuxRuntimeSubjectTarget, { kind: 'agent-session' }>): ReturnType<AgentMuxHostedClient['runtimeSubject']>
  }

/** Reuse the original exact-SID Hosted client and its reader/attachment machinery.
 * The carrier cannot invoke an arbitrary remote method or change this member. */
export type SpaceMemberReadingClient = Pick<SpaceMemberClient, 'readAgentInputEpoch' | 'dispose' | 'readAgentConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'releaseConversationView' | 'observeConversation'>
export function connectSpaceMember(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: SpaceMemberTarget): Promise<SpaceMemberClient>
export function connectSpaceMember(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: SpaceMemberReadingTarget): Promise<SpaceMemberReadingClient>
export function connectSpaceMember(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: SpaceMemberRoute): Promise<SpaceMemberClient | SpaceMemberReadingClient>
export async function connectSpaceMember(rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>, value: SpaceMemberRoute): Promise<SpaceMemberClient> {
  const target = parseSpaceMemberRoute(value)
  const port = {
    async call(method: string, params: unknown, options: { signal?: AbortSignal } = {}) {
      const input = parseSpaceMemberParams('space.member.call', { target, call: { method, params } })
      return await rpc.call('space.member.call', input, options)
    },
    async subscribe(method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: AgentMuxHostedStreamEvent): void; onEnd?(error?: Error): void; signal?: AbortSignal
    }) {
      const p = rpcRecord(params)
      // The original SDK's SID attachment shorthand has no Run argument. This
      // fixed carrier adds only its already explicit expected Run, never a new one.
      const current = 'expectedRun' in target && (method === 'runtime.attachment-watch' || method === 'runtime.replay-watch') ? { ...p,
        target: { ...rpcRecord(p.target), runId: target.expectedRun.runId } } : p
      const input = parseSpaceMemberParams('space.member.watch', { target, call: { method, params: current } })
      return await rpc.subscribe('space.member.watch', input, handlers)
    }
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port, connectOnDemand: true, sessions: 'full', agentSessionIds: [target.agentSessionId], expectedRuntimeId: target.runtimeId })
  const metadataConsumer = mintObjectId()
  return Object.assign(client, { metadata: async () => {
    const owner = client.runtimeOwnerIdentity() ?? (await port.call('runtime.owner.identity', { expectedRuntimeId: target.runtimeId })).owner
    return parseHostedBootstrap(await port.call('runtime.bootstrap', { consumerId: metadataConsumer,
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, sessions: 'full', agentSessionIds: [target.agentSessionId] }), 'full', [target.agentSessionId])
  } })
}
