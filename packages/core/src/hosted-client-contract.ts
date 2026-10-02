import type { AgentMuxClient } from './client.js'
import type { AgentCatalogEntry, AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRuntimeIdentity,
  AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from './types.js'
import type { AgentMuxRpcStreamParams } from './public-rpc.js'
import type { AgentMuxRpcSubscriptionOptions } from './public-rpc-client.js'

/** The finite SDK surface delegated by a Client to the single semantic Host. */
export const AGENTMUX_HOSTED_METHODS = [
  'runtimeDiagnostics', 'runtimeResourceSnapshot', 'probeAgent', 'probeExecutorAvailability',
  'listRuns', 'runtimeProjection', 'runtimeSubject', 'statusAgent', 'refreshAgentSession',
  'readAgentSessions', 'sessionTimeline', 'sessionHistorySources', 'sessionHistoryPage', 'inspectManagedHooks',
  'createTerminal', 'attachTerminal', 'refreshRunAttachment', 'readRunReplay',
  'removeTerminal', 'releaseRunAttachment', 'writeTerminal', 'resizeTerminal', 'signalTerminal', 'stopTerminal',
  'createAgent', 'createAgentWithDelivery', 'reattachAgent', 'ensureAgentContinuity',
  'resumeAgent', 'reopenAgent', 'reconcileAgentReopen', 'respawnAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt', 'submitAgentMessage',
  'respondAgentInteraction', 'setAgentPosture', 'resizeAgent', 'signalAgent', 'stopAgent',
  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'checkDeliveries', 'ackDeliveryBatch',
  'startDiscussion', 'handOff', 'openDispatch', 'recordDispatchEvent', 'showDispatch'
] as const satisfies readonly (keyof AgentMuxClient)[]

export type AgentMuxHostedMethod = typeof AGENTMUX_HOSTED_METHODS[number]
export type AgentMuxHostedInvocation = { [M in AgentMuxHostedMethod]: {
  method: M; args: Parameters<AgentMuxClient[M]>
} }[AgentMuxHostedMethod]
type DelegatedMethods = { [M in AgentMuxHostedMethod]:
  (...args: Parameters<AgentMuxClient[M]>) => Promise<Awaited<ReturnType<AgentMuxClient[M]>>> }

/** The original Core observation contract; all opening facts belong to its one output lease. */
export type AgentMuxHostedOutputObservation = Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>>

/** Metadata and Session values are read projections. No Provider implementation or Store lives here. */
export type AgentMuxHostedClient = DelegatedMethods & {
  readonly providers: { catalog(): AgentCatalogEntry[]; get(id: string): { catalog: AgentCatalogEntry } }
  connect(): Promise<void>
  dispose(): Promise<void>
  onEvent(listener: (event: AgentMuxClientEvent) => void): () => void
  runtimeIdentity(): AgentMuxRuntimeIdentity
  catalog(): AgentCatalogEntry[]
  agentSessions(): AgentMuxAgentSession[]
  agentSession(id: string): AgentMuxAgentSession
  resolveAgentSession(lookup: Parameters<AgentMuxClient['resolveAgentSession']>[0]): AgentMuxAgentSession
  agentMessageQueuePath(): string
  observeAgentOutput(...args: Parameters<AgentMuxClient['observeAgentOutput']>): Promise<AgentMuxHostedOutputObservation>
  observeSessionHistory(id: string, listener: (observation: AgentSessionHistoryObservation) => void,
    options: Parameters<AgentMuxClient['observeSessionHistory']>[2]): Promise<AgentSessionHistoryObservationHandle>
}

export type AgentMuxHostedBootstrap = {
  identity: AgentMuxRuntimeIdentity
  storePath: string | null
  hostProcessId: number
  catalog: AgentCatalogEntry[]
  sessions: AgentMuxAgentSession[]
  messageQueuePath: string
}
export type AgentMuxHostedStreamEvent =
  | { type: 'snapshot'; data: { event: AgentMuxClientEvent } }
  | { type: 'snapshot'; data: { observation: AgentSessionHistoryObservation } }
  | { type: 'end'; data: unknown }
  | { type: 'error'; error: { code: string; message: string } }
export type AgentMuxHostedSubscription = { dispose(): Promise<void> }

/** Existing public agent.output subscription; no Runtime.invoke or shared Run attachment. */
export type AgentMuxHostedOutputRpcPort = {
  subscribe(method: 'agent.output', params: AgentMuxRpcStreamParams<'agent.output'>,
    handlers: AgentMuxRpcSubscriptionOptions<'agent.output'>): Promise<AgentMuxHostedSubscription>
}

/** A public-RPC adapter implements this port. It has no transport implementation of its own. */
export type AgentMuxHostedRpcPort = AgentMuxHostedOutputRpcPort & {
  call(method: 'runtime.bootstrap', params: { consumerId: string }): Promise<AgentMuxHostedBootstrap>
  call(method: 'runtime.invoke', params: { consumerId: string; invocation: AgentMuxHostedInvocation }, options?: { signal?: AbortSignal }): Promise<{ value: unknown }>
  call(method: 'runtime.release-consumer', params: { consumerId: string }): Promise<{ released: boolean }>
  subscribe(method: 'runtime.events' | 'runtime.history-watch', params: {
    consumerId: string; agentSessionId?: string;
    options?: Omit<NonNullable<Parameters<AgentMuxClient['observeSessionHistory']>[2]>, 'signal'>
  }, handlers: {
    onInitial(value: { bootstrap?: AgentMuxHostedBootstrap; source?: AgentSessionHistoryObservationHandle['source'] }): void
    onEvent(value: AgentMuxHostedStreamEvent): void
    onEnd?(error?: Error): void
    signal?: AbortSignal
  }): Promise<AgentMuxHostedSubscription>
}
