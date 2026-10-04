import type { AgentMuxClient } from './client.js'
import type { AgentCatalogEntry, AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRuntimeIdentity,
  AgentMuxClientEventListener, AgentMuxClientEventListenerOptions,
  AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from './types.js'
import type { AgentMuxRpcStreamParams } from './public-rpc.js'
import type { AgentMuxRpcSubscriptionOptions } from './public-rpc-client.js'

/** The finite SDK surface delegated by a Client to the single semantic Host. */
export const AGENTMUX_HOSTED_METHODS = [
  'readDeliveryAttempt', 'runtimeDiagnostics', 'runtimeResourceSnapshot', 'observeRunStorage', 'probeAgent', 'probeExecutorAvailability',
  'listHostExecutors', 'configureHostExecutor', 'createHostAgentWithDelivery',
  'agentCreationAuthority', 'attestAgentCreation', 'listTrustedCreationSources', 'trustCreationSource',
  'listRuns', 'runtimeProjection', 'runtimeSubject', 'statusAgent', 'refreshAgentSession', 'confirmAgentNativeSession',
  'readAgentSessions', 'sessionTimeline', 'sessionHistorySources', 'sessionHistoryPage', 'sessionHistoryResource', 'inspectManagedHooks',
  'createTerminal', 'attachTerminal', 'refreshRunAttachment', 'readRunReplay',
  'removeTerminal', 'releaseRunAttachment', 'writeTerminal', 'resizeTerminal', 'signalTerminal', 'stopTerminal',
  'createAgent', 'createAgentWithDelivery', 'inspectAgentCreation', 'reattachAgent', 'ensureAgentContinuity',
  'resumeAgent', 'reopenAgent', 'reconcileAgentReopen', 'respawnAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt', 'submitAgentMessage', 'saveAgentFuturePromptIntent', 'replySessionQuestion',
  'respondAgentInteraction', 'setAgentPosture', 'resizeAgent', 'signalAgent', 'stopAgent',
  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'checkDeliveries', 'ackDeliveryBatch',
  'answerAsk', 'cancelAsk', 'startDiscussion', 'handOff', 'openDispatch', 'recordDispatchEvent', 'showDispatch'
] as const satisfies readonly (keyof AgentMuxClient)[]

export type AgentMuxHostedMethod = typeof AGENTMUX_HOSTED_METHODS[number]
type HostedArguments<M extends AgentMuxHostedMethod> = M extends 'trustCreationSource'
  ? [input: Parameters<AgentMuxClient['trustCreationSource']>[0]] : Parameters<AgentMuxClient[M]>
export type AgentMuxHostedInvocation = { [M in AgentMuxHostedMethod]: {
  method: M; args: HostedArguments<M>
} }[AgentMuxHostedMethod]
type DelegatedMethods = { [M in AgentMuxHostedMethod]:
  (...args: HostedArguments<M>) => Promise<Awaited<ReturnType<AgentMuxClient[M]>>> }

/** The original Core observation contract; all opening facts belong to its one output lease. */
export type AgentMuxHostedOutputObservation = Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>>

/** Metadata and Session values are read projections. No Provider implementation or Store lives here. */
export type AgentMuxHostedClient = DelegatedMethods & {
  readonly providers: { catalog(): AgentCatalogEntry[]; get(id: string): { catalog: AgentCatalogEntry } }
  connect(): Promise<void>
  dispose(): Promise<void>
  onEvent<Result>(listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions): () => void
  runtimeOwnerIdentity(): AgentMuxRuntimeOwnerIdentity | null
  forwardRpc?: AgentMuxHostedForwardRpc
  disconnect(): void
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

export type AgentMuxRuntimeOwnerIdentity = {
  runtimeId: string; ownerInstanceId: string; protocolVersion: 1; processId: number
  ctxmux: AgentMuxRuntimeIdentity; availability: 'connected' | 'unverified'
}
export type AgentMuxRuntimeFence = Pick<AgentMuxRuntimeOwnerIdentity, 'runtimeId' | 'ownerInstanceId'>
export type AgentMuxHostedForwardRpc = <M extends import('./public-rpc.js').AgentMuxRpcMethod>(
  method: M, params: import('./public-rpc.js').AgentMuxRpcParams<M>,
  context?: import('./public-rpc-service.js').AgentMuxRpcCallContext
) => Promise<import('./public-rpc.js').AgentMuxRpcResult<M>>

export type AgentMuxHostedBootstrap = {
  owner: AgentMuxRuntimeOwnerIdentity
  identity: AgentMuxRuntimeIdentity
  storePath: string | null
  hostProcessId: number
  catalog: AgentCatalogEntry[]
  sessions: AgentMuxAgentSession[]
  messageQueuePath: string
}
export type AgentMuxHostedTransferChunk = { transferId: string; index: number; dataBase64: string; final: boolean }
export type AgentMuxHostedStreamValue =
  | { kind: 'initial'; value: unknown }
  // A Native restored transition carries the current owner facts on the same ordered stream.
  | { kind: 'event'; event: AgentMuxClientEvent; owner?: AgentMuxRuntimeOwnerIdentity }
  | { kind: 'history'; observation: AgentSessionHistoryObservation }
export type AgentMuxHostedStreamEvent =
  | { type: 'snapshot'; data: AgentMuxHostedTransferChunk }
  | { type: 'end'; data: unknown }
  | { type: 'error'; error: { code: string; message: string } }
export type AgentMuxHostedSubscription = { dispose(): Promise<void> }
export type AgentMuxHostedAttachmentTarget = { kind: 'agent-session'; agentSessionId: string; runId?: string } |
  { kind: 'terminal-run'; runId: string }
export type AgentMuxHostedRuntimeParameterMap = {
  'runtime.owner.identity': { expectedRuntimeId?: string }
  'runtime.owner.shutdown': { fence: AgentMuxRuntimeFence }
  'runtime.bootstrap': { consumerId: string; fence: AgentMuxRuntimeFence }
  'runtime.invoke': { consumerId: string; fence: AgentMuxRuntimeFence; invocation: AgentMuxHostedInvocation }
  'runtime.release-consumer': { consumerId: string; fence: AgentMuxRuntimeFence }
  'runtime.events': { consumerId: string; fence: AgentMuxRuntimeFence }
  'runtime.history-watch': { consumerId: string; fence: AgentMuxRuntimeFence; agentSessionId: string;
    options?: Omit<NonNullable<Parameters<AgentMuxClient['observeSessionHistory']>[2]>, 'signal'> }
  'runtime.attachment-watch': { consumerId: string; fence: AgentMuxRuntimeFence; target: AgentMuxHostedAttachmentTarget;
    afterByte: number; view: 'raw' | 'terminal'; refresh?: boolean; operationId?: string }
  'runtime.replay-watch': { consumerId: string; fence: AgentMuxRuntimeFence; target: AgentMuxHostedAttachmentTarget;
    afterByte: number; view: 'raw' | 'terminal' }
}
export type AgentMuxHostedRuntimeResultMap = {
  'runtime.owner.identity': { owner: AgentMuxRuntimeOwnerIdentity }
  'runtime.owner.shutdown': { owner: AgentMuxRuntimeOwnerIdentity; accepted: true }
  'runtime.bootstrap': AgentMuxHostedBootstrap
  'runtime.invoke': { value: unknown }
  'runtime.release-consumer': { released: boolean }
  'runtime.events': never
  'runtime.history-watch': never
  'runtime.attachment-watch': never
  'runtime.replay-watch': never
}
export type AgentMuxHostedRuntimeMethod = keyof AgentMuxHostedRuntimeParameterMap
export type AgentMuxHostedStreamMethod = 'runtime.events' | 'runtime.history-watch' | 'runtime.attachment-watch' | 'runtime.replay-watch'
export type AgentMuxHostedStreamInitialMap = {
  'runtime.events': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
  'runtime.history-watch': { owner: AgentMuxRuntimeOwnerIdentity; source: AgentSessionHistoryObservationHandle['source'] }
  'runtime.attachment-watch': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
  'runtime.replay-watch': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
}
export type AgentMuxHostedStreamInitial<M extends AgentMuxHostedStreamMethod> = AgentMuxHostedStreamInitialMap[M]
export const AGENTMUX_HOSTED_RPC_METHODS = {
  'runtime.owner.identity': 'short', 'runtime.owner.shutdown': 'short',
  'runtime.bootstrap': 'short', 'runtime.invoke': 'long', 'runtime.release-consumer': 'long',
  'runtime.events': 'long', 'runtime.history-watch': 'long', 'runtime.attachment-watch': 'long', 'runtime.replay-watch': 'long'
} as const satisfies Record<AgentMuxHostedRuntimeMethod, 'short' | 'long'>

export const AGENTMUX_HOSTED_RPC_FIELDS = {
  'runtime.owner.identity': ['expectedRuntimeId'], 'runtime.owner.shutdown': ['fence'],
  'runtime.bootstrap': ['consumerId', 'fence'], 'runtime.invoke': ['consumerId', 'fence', 'invocation'],
  'runtime.release-consumer': ['consumerId', 'fence'], 'runtime.events': ['consumerId', 'fence'],
  'runtime.history-watch': ['consumerId', 'fence', 'agentSessionId', 'options'],
  'runtime.attachment-watch': ['consumerId', 'fence', 'target', 'afterByte', 'view', 'refresh', 'operationId'],
  'runtime.replay-watch': ['consumerId', 'fence', 'target', 'afterByte', 'view']
} as const satisfies Record<AgentMuxHostedRuntimeMethod, readonly string[]>

/** Existing public agent.output subscription; no Runtime.invoke or shared Run attachment. */
export type AgentMuxHostedOutputRpcPort = {
  subscribe(method: 'agent.output', params: AgentMuxRpcStreamParams<'agent.output'>,
    handlers: AgentMuxRpcSubscriptionOptions<'agent.output'>): Promise<AgentMuxHostedSubscription>
}

/** The existing RPC client implements this transport-only port. */
export type AgentMuxHostedRpcPort = AgentMuxHostedOutputRpcPort & {
  call<M extends Exclude<AgentMuxHostedRuntimeMethod, AgentMuxHostedStreamMethod>>(method: M,
    params: AgentMuxHostedRuntimeParameterMap[M], options?: { signal?: AbortSignal }): Promise<AgentMuxHostedRuntimeResultMap[M]>
  subscribe<M extends AgentMuxHostedStreamMethod>(method: M, params: AgentMuxHostedRuntimeParameterMap[M], handlers: {
    onInitial(value: AgentMuxHostedStreamInitial<M>): void
    onEvent(value: AgentMuxHostedStreamEvent): void
    onEnd?(error?: Error): void
    signal?: AbortSignal
  }): Promise<AgentMuxHostedSubscription>
}
