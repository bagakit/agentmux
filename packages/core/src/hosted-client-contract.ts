import type { AgentMuxClient } from './client.js'
import type { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from './runtime-owner-protocol.js'
import type { AgentCatalogEntry, AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxRuntimeIdentity,
  AgentMuxClientEventListener, AgentMuxClientEventListenerOptions,
  AgentSessionHistoryObservation, AgentSessionHistoryObservationHandle } from './types.js'
import type { AgentMuxRpcStreamParams } from './public-rpc.js'
import type { AgentMuxRpcSubscriptionOptions } from './public-rpc-client.js'
import type { AgentMuxHostedSession, AgentMuxHostedSessionProjection } from './hosted-session-summary.js'

/** The finite SDK surface delegated by a Client to the single semantic Host. */
export const AGENTMUX_HOSTED_METHODS = [
  'hostEnvironment',
  'clientPerformanceDiagnostics', 'connectRuntime', 'readDeliveryAttempt', 'readReadingDiagnostic', 'findReadingDiagnostics', 'readAgentStartupDiagnostic', 'findAgentStartupDiagnostics', 'inspectAgentPromptSubmission', 'readAgentInputActivity', 'runtimeDiagnostics', 'runtimeResourceSnapshot', 'agentSessionResourceSnapshot', 'runningSavedAgentResourceSnapshot', 'observeRunStorage', 'probeAgent', 'probeExecutorAvailability',
  'inspectAgentInput', 'inspectMoteInput', 'readAgentInputResource', 'readAgentInputMailbox', 'readAgentInputChanges', 'stopAgentInputWaiting', 'rejoinAgentInputWaiting',
  'listHostExecutors', 'listNativeAgentSessions', 'listHostNativeAgentSessions', 'readNativeAgentHistory', 'readHostNativeAgentHistory',
  'readNativeAgentHistoryResource', 'readHostNativeAgentHistoryResource', 'configureHostExecutor', 'removeHostExecutor', 'createHostAgentWithDelivery',
  'agentCreationAuthority', 'attestAgentCreation', 'listTrustedCreationSources', 'trustCreationSource',
  'agentMessageAuthority', 'listTrustedMessageSources', 'trustMessageSource', 'prepareFederatedMessage', 'intakeFederatedMessage', 'prepareFederatedRead', 'exportFederatedThread',
  'readFederatedOutbox', 'recordFederatedDispatchEvent', 'intakeFederatedDispatchEvent', 'recordFederatedInboxReceipt',
  'listRuns', 'runtimeProjection', 'runtimeSubject', 'statusAgent', 'refreshAgentSession', 'confirmAgentNativeSession',
  'recordExternalConversationMessage', 'readAgentMessageQueuePath', 'readAgentSession', 'readAgentSessions', 'readAgentFuturePromptIntent', 'listAgentFuturePromptIntents', 'sessionTimeline', 'readAgentSessionHistory', 'readAgentSessionUsage', 'inspectAgentSessionRecord', 'deleteAgentSessionRecord', 'readAgentConversation', 'releaseConversationView', 'listConversationSnapshots', 'releaseConversationSnapshot', 'sessionHistoryCheckpoint', 'readSessionHistoryChanges', 'conversationCheckpoint', 'readConversationChanges', 'sessionHistorySources', 'sessionHistoryPage', 'sessionHistoryResource', 'inspectManagedHooks',
  'inspectAgentExecutionOperation', 'prepareAgentExecutionHelper', 'prepareTerminal', 'createPreparedTerminal', 'inspectPreparedTerminal', 'terminalCreationRuntimeIdentity', 'retirePreparedTerminalCreation', 'observePreparedTerminalCreationRetirement', 'prepareTerminalStop', 'stopPreparedTerminal', 'controlTerminal', 'inspectTerminalControl', 'inspectTerminalCreation', 'retireTerminalCreation', 'createTerminal', 'recoverTerminal', 'attachTerminal', 'refreshRunAttachment', 'readRunReplay',
  'removeTerminal', 'releaseRunAttachment', 'writeTerminal', 'writeTerminalBytes', 'resizeTerminal', 'signalTerminal', 'stopTerminal',
  'createAgent', 'createAgentWithDelivery', 'resolveAgentCreationSessionId', 'inspectAgentCreation', 'continueAgentCreation', 'listAgentSpawns', 'reattachAgent', 'ensureAgentContinuity', 'controlAgentContinuity',
  'restartAgent', 'inspectAgentRestart', 'inspectAgentStop', 'resumeAgent', 'reopenAgent', 'reconcileAgentReopen', 'respawnAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt', 'submitAgentMessage', 'notifyMessages', 'inspectMessageNotification', 'saveAgentFuturePromptIntent', 'replySessionQuestion',
  'respondAgentInteraction', 'inspectAgentInteractionOperation', 'inspectAgentPosture', 'setAgentPosture', 'resizeAgent', 'signalAgent', 'stopAgent',
  'authorizeAgentCaller', 'authorizeRetainedAgentCaller', 'authorizeAgentMessage', 'checkDeliveries', 'ackDeliveryBatch',
  'answerAsk', 'cancelAsk', 'startDiscussion', 'handOff', 'openDispatch', 'recordDispatchEvent', 'showDispatch', 'readMessage', 'listMessages', 'listMessageEvents', 'broadcastMessages', 'inspectMessageBroadcast', 'readDispatch', 'listDispatches'
] as const satisfies readonly (keyof AgentMuxClient)[]

export type AgentMuxHostedMethod = typeof AGENTMUX_HOSTED_METHODS[number]

/** Preparation belongs to this finite transport surface; each operation keeps its own business prerequisites. */
type AgentMuxHostedPreparation = 'owner' | 'runtime' | 'session-observation' | 'input-admission'
export const AGENTMUX_HOSTED_PREPARATION = {
  hostEnvironment: 'owner',
  clientPerformanceDiagnostics: 'owner',
  connectRuntime: 'runtime',
  readDeliveryAttempt: 'owner',
  readReadingDiagnostic: 'owner',
  findReadingDiagnostics: 'owner',
  readAgentStartupDiagnostic: 'owner',
  findAgentStartupDiagnostics: 'owner',
  inspectAgentPromptSubmission: 'owner',
  readAgentInputActivity: 'runtime',
  runtimeDiagnostics: 'owner',
  runtimeResourceSnapshot: 'owner',
  agentSessionResourceSnapshot: 'owner',
  runningSavedAgentResourceSnapshot: 'owner',
  observeRunStorage: 'runtime',
  probeAgent: 'session-observation',
  probeExecutorAvailability: 'session-observation',
  inspectAgentInput: 'owner',
  inspectMoteInput: 'owner',
  readAgentInputResource: 'owner',
  readAgentInputMailbox: 'owner',
  readAgentInputChanges: 'owner',
  stopAgentInputWaiting: 'owner',
  rejoinAgentInputWaiting: 'owner',
  listHostExecutors: 'owner',
  listNativeAgentSessions: 'owner',
  listHostNativeAgentSessions: 'owner',
  readNativeAgentHistory: 'owner',
  readHostNativeAgentHistory: 'owner',
  readNativeAgentHistoryResource: 'owner',
  readHostNativeAgentHistoryResource: 'owner',
  configureHostExecutor: 'owner',
  removeHostExecutor: 'owner',
  createHostAgentWithDelivery: 'runtime',
  agentCreationAuthority: 'session-observation',
  attestAgentCreation: 'owner',
  listTrustedCreationSources: 'session-observation',
  trustCreationSource: 'owner',
  agentMessageAuthority: 'owner', listTrustedMessageSources: 'owner', trustMessageSource: 'owner',
  prepareFederatedMessage: 'owner', intakeFederatedMessage: 'owner', prepareFederatedRead: 'owner', exportFederatedThread: 'owner',
  readFederatedOutbox: 'owner', recordFederatedDispatchEvent: 'owner', intakeFederatedDispatchEvent: 'owner', recordFederatedInboxReceipt: 'owner',
  listRuns: 'runtime',
  runtimeProjection: 'runtime',
  runtimeSubject: 'runtime',
  statusAgent: 'runtime',
  refreshAgentSession: 'session-observation',
  confirmAgentNativeSession: 'session-observation',
  recordExternalConversationMessage: 'session-observation',
  readAgentMessageQueuePath: 'owner',
  readAgentSession: 'owner',
  readAgentSessions: 'owner',
  readAgentFuturePromptIntent: 'owner',
  listAgentFuturePromptIntents: 'owner',
  sessionTimeline: 'owner',
  readAgentSessionHistory: 'owner',
  readAgentSessionUsage: 'owner',
  inspectAgentSessionRecord: 'owner',
  deleteAgentSessionRecord: 'owner',
  readAgentConversation: 'owner',
  releaseConversationView: 'owner',
  listConversationSnapshots: 'owner',
  releaseConversationSnapshot: 'owner',
  sessionHistoryCheckpoint: 'owner',
  readSessionHistoryChanges: 'owner',
  conversationCheckpoint: 'owner',
  readConversationChanges: 'owner',
  sessionHistorySources: 'owner',
  sessionHistoryPage: 'owner',
  sessionHistoryResource: 'owner',
  inspectManagedHooks: 'owner',
  inspectAgentExecutionOperation: 'owner',
  prepareAgentExecutionHelper: 'owner',
  prepareTerminal: 'owner',
  createPreparedTerminal: 'runtime',
  inspectPreparedTerminal: 'runtime',
  terminalCreationRuntimeIdentity: 'owner',
  retirePreparedTerminalCreation: 'runtime',
  observePreparedTerminalCreationRetirement: 'runtime',
  controlTerminal: 'owner',
  inspectTerminalControl: 'owner',
  inspectTerminalCreation: 'owner',
  retireTerminalCreation: 'owner',
  prepareTerminalStop: 'runtime',
  stopPreparedTerminal: 'runtime',
  createTerminal: 'runtime',
  recoverTerminal: 'runtime',
  attachTerminal: 'runtime',
  refreshRunAttachment: 'runtime',
  readRunReplay: 'runtime',
  removeTerminal: 'runtime',
  releaseRunAttachment: 'runtime',
  writeTerminal: 'runtime',
  writeTerminalBytes: 'runtime',
  resizeTerminal: 'runtime',
  signalTerminal: 'runtime',
  stopTerminal: 'runtime',
  createAgent: 'runtime',
  createAgentWithDelivery: 'runtime',
  resolveAgentCreationSessionId: 'owner',
  inspectAgentCreation: 'owner',
  continueAgentCreation: 'owner',
  listAgentSpawns: 'owner',
  reattachAgent: 'runtime',
  ensureAgentContinuity: 'runtime',
  controlAgentContinuity: 'owner',
  restartAgent: 'runtime',
  inspectAgentRestart: 'runtime',
  inspectAgentStop: 'owner',
  resumeAgent: 'runtime',
  reopenAgent: 'session-observation',
  reconcileAgentReopen: 'session-observation',
  respawnAgent: 'session-observation',
  writeAgent: 'runtime',
  pasteAgent: 'runtime',
  submitAgentPrompt: 'input-admission',
  submitAgentMessage: 'input-admission',
  notifyMessages: 'owner',
  inspectMessageNotification: 'owner',
  saveAgentFuturePromptIntent: 'session-observation',
  replySessionQuestion: 'owner',
  respondAgentInteraction: 'owner',
  inspectAgentInteractionOperation: 'owner',
  inspectAgentPosture: 'owner',
  setAgentPosture: 'owner',
  resizeAgent: 'runtime',
  signalAgent: 'runtime',
  stopAgent: 'runtime',
  authorizeAgentCaller: 'owner',
  authorizeRetainedAgentCaller: 'owner',
  authorizeAgentMessage: 'owner',
  checkDeliveries: 'owner',
  ackDeliveryBatch: 'owner',
  answerAsk: 'session-observation',
  cancelAsk: 'session-observation',
  startDiscussion: 'session-observation',
  handOff: 'owner',
  openDispatch: 'session-observation',
  recordDispatchEvent: 'session-observation',
  showDispatch: 'session-observation',
  readMessage: 'owner',
  listMessages: 'owner',
  listMessageEvents: 'owner',
  broadcastMessages: 'owner',
  inspectMessageBroadcast: 'owner',
  readDispatch: 'owner',
  listDispatches: 'owner',
} as const satisfies Record<AgentMuxHostedMethod, AgentMuxHostedPreparation>

type HostedArguments<M extends AgentMuxHostedMethod> = M extends 'trustCreationSource' | 'trustMessageSource'
  ? [input: Parameters<AgentMuxClient[M]>[0]]
  : M extends 'writeTerminal' | 'writeTerminalBytes' ? [ref: Parameters<AgentMuxClient[M]>[0], input: Parameters<AgentMuxClient[M]>[1], observation?: Parameters<AgentMuxClient[M]>[2]]
  : M extends 'controlTerminal' | 'setAgentPosture' | 'writeAgent' | 'pasteAgent' | 'recordExternalConversationMessage' | 'ensureAgentContinuity' | 'readAgentInputMailbox' | 'readAgentInputChanges' | 'controlAgentContinuity' | 'submitAgentPrompt' | 'submitAgentMessage' | 'broadcastMessages' | 'notifyMessages' | 'rejoinAgentInputWaiting' | 'respondAgentInteraction' | 'replySessionQuestion'
    ? [input: Parameters<AgentMuxClient[M]>[0]] : Parameters<AgentMuxClient[M]>
export type AgentMuxHostedInvocation = { [M in AgentMuxHostedMethod]: {
  method: M; args: HostedArguments<M>
} }[AgentMuxHostedMethod]
type DelegatedMethods = { [M in AgentMuxHostedMethod]:
  M extends 'readMessage' ? AgentMuxClient[M] :
  (...args: HostedArguments<M>) => Promise<Awaited<ReturnType<AgentMuxClient[M]>>> }

/** The original Core observation contract; all opening facts belong to its one output lease. */
export type AgentMuxHostedOutputObservation = Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>>

/** Metadata and Session values are read projections. No Provider implementation or Store lives here. */
export type AgentMuxHostedClient<P extends AgentMuxHostedSessionProjection = 'full'> = DelegatedMethods & {
  readonly providers: { catalog(): AgentCatalogEntry[]; get(id: string): { catalog: AgentCatalogEntry } }
  connect(): Promise<void>
  dispose(): Promise<void>
  /** Low-frequency owner facts only; ordered Run bytes never visit these listeners. */
  onStatusEvent<Result>(listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions): () => void
  onRunEvent<Result>(runId: string, listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions): () => void
  onEvent<Result>(listener: AgentMuxClientEventListener<Result>, options?: AgentMuxClientEventListenerOptions): () => void
  sessionObservationScope(): import('./hosted-session-summary.js').AgentMuxHostedSessionScope | null
  runtimeOwnerIdentity(): AgentMuxRuntimeOwnerIdentity | null
  /** Exact control-plane identity; no Native, Session bootstrap or event lease is required. */
  readRuntimeOwnerIdentity(options?: { signal?: AbortSignal }): Promise<AgentMuxRuntimeOwnerIdentity>
  remoteTransportObservation(): import('./remote-transport-observation.js').RemoteTransportObservation | null
  forwardRpc?: AgentMuxHostedForwardRpc
  subscribeRpc?: AgentMuxHostedSubscribeRpc
  disconnect(): void
  runtimeIdentity(): AgentMuxRuntimeIdentity
  catalog(): AgentCatalogEntry[]
  agentSessions(): AgentMuxHostedSession<P>[]
  agentSession(id: string): AgentMuxHostedSession<P>
  resolveAgentSession(lookup: Parameters<AgentMuxClient['resolveAgentSession']>[0]): AgentMuxHostedSession<P>
  agentMessageQueuePath(): string
  observeAgentOutput(...args: Parameters<AgentMuxClient['observeAgentOutput']>): Promise<AgentMuxHostedOutputObservation>
  observeSessionHistory(id: string, listener: (observation: AgentSessionHistoryObservation) => void,
    options: Parameters<AgentMuxClient['observeSessionHistory']>[2]): Promise<AgentSessionHistoryObservationHandle>
  observeConversation(...args: Parameters<AgentMuxClient['observeConversation']>): ReturnType<AgentMuxClient['observeConversation']>
}

export type AgentMuxRuntimeOwnerIdentity = {
  runtimeId: string; ownerInstanceId: string; protocolVersion: typeof AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION; processId: number
  /** Current publicly confirmed Native identity. null is unconfirmed, never a dead Run fact. */
  ctxmux: AgentMuxRuntimeIdentity | null
  /** Semantic control-owner observation, independent of Native readiness. */
  availability: 'connected' | 'unverified'
}
export type AgentMuxRuntimeFence = Pick<AgentMuxRuntimeOwnerIdentity, 'runtimeId' | 'ownerInstanceId'>
export type AgentMuxHostedForwardRpc = <M extends import('./public-rpc.js').AgentMuxRpcMethod>(
  method: M, params: import('./public-rpc.js').AgentMuxRpcParams<M>,
  context?: import('./public-rpc-service.js').AgentMuxRpcCallContext,
  /** Optional exact destination owner, unlike an inbound context.runtimeFence. Omission keeps normal owner refresh. */
  expectedOwner?: AgentMuxRuntimeFence
) => Promise<import('./public-rpc.js').AgentMuxRpcResult<M>>

/** Borrow the existing public transport for a read lease; no Runtime event or second owner. */
export type AgentMuxHostedSubscribeRpc = <M extends import('./public-rpc.js').AgentMuxRpcStreamMethod>(
  method: M, params: import('./public-rpc.js').AgentMuxRpcStreamParams<M>,
  handlers: import('./public-rpc-client.js').AgentMuxRpcSubscriptionOptions<M>
) => Promise<import('./public-rpc-client.js').AgentMuxRpcSubscription>

export type AgentMuxHostedBootstrap<P extends AgentMuxHostedSessionProjection = 'full'> = {
  owner: AgentMuxRuntimeOwnerIdentity
  connection: Extract<AgentMuxClientEvent, { type: 'connection-state' }> | null
  storePath: string | null
  hostProcessId: number
  catalog: AgentCatalogEntry[]
  sessions: AgentMuxHostedSession<P>[]
  sessionScope?: import('./hosted-session-summary.js').AgentMuxHostedSessionScope
  messageQueuePath: string
}
export type AgentMuxHostedTransferChunk = { transferId: string; index: number; dataBase64: string; final: boolean }
export type AgentMuxHostedStreamValue =
  | { kind: 'initial'; value: unknown }
  // A Native restored transition carries the current owner facts on the same ordered stream.
  | { kind: 'event'; event: AgentMuxClientEvent; owner?: AgentMuxRuntimeOwnerIdentity }
  | { kind: 'history'; observation: AgentSessionHistoryObservation }
  | { kind: 'conversation'; observation: import('./conversation-changes.js').ConversationObservation }
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
  'runtime.network.inspect': { fence: AgentMuxRuntimeFence }
  'runtime.profile.capture': import('./runtime-v8-profile.js').RuntimeV8ProfileInput
  'runtime.bootstrap': { consumerId: string; fence: AgentMuxRuntimeFence; sessions?: AgentMuxHostedSessionProjection; agentSessionIds?: readonly string[] }
  'runtime.invoke': { consumerId: string; fence: AgentMuxRuntimeFence; invocation: AgentMuxHostedInvocation }
  'runtime.release-consumer': { consumerId: string; fence: AgentMuxRuntimeFence }
  'runtime.events': { consumerId: string; fence: AgentMuxRuntimeFence; sessions?: AgentMuxHostedSessionProjection; agentSessionIds?: readonly string[] }
  'runtime.conversation-watch': { consumerId: string; fence: AgentMuxRuntimeFence; reference: import('./conversation-changes.js').ConversationWatchInput; options?: Omit<import('./conversation-changes.js').ConversationReadOptions, 'signal'> }
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
  'runtime.network.inspect': import('./runtime-network.js').RuntimeNetworkSnapshot
  'runtime.profile.capture': import('./runtime-v8-profile.js').RuntimeV8ProfileResult
  'runtime.bootstrap': AgentMuxHostedBootstrap
  'runtime.invoke': { value: unknown }
  'runtime.release-consumer': { released: boolean }
  'runtime.events': never
  'runtime.conversation-watch': never
  'runtime.history-watch': never
  'runtime.attachment-watch': never
  'runtime.replay-watch': never
}
export type AgentMuxHostedRuntimeMethod = keyof AgentMuxHostedRuntimeParameterMap
export type AgentMuxHostedStreamMethod = 'runtime.events' | 'runtime.conversation-watch' | 'runtime.history-watch' | 'runtime.attachment-watch' | 'runtime.replay-watch'
export type AgentMuxHostedStreamInitialMap = {
  'runtime.events': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
  'runtime.conversation-watch': { owner: AgentMuxRuntimeOwnerIdentity; opening: import('./conversation-changes.js').ConversationWatchOpening }
  'runtime.history-watch': { owner: AgentMuxRuntimeOwnerIdentity; source: AgentSessionHistoryObservationHandle['source'] }
  'runtime.attachment-watch': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
  'runtime.replay-watch': { owner: AgentMuxRuntimeOwnerIdentity; transferId: string }
}
export type AgentMuxHostedStreamInitial<M extends AgentMuxHostedStreamMethod> = AgentMuxHostedStreamInitialMap[M]
export const AGENTMUX_HOSTED_RPC_METHODS = {
  'runtime.owner.identity': 'short', 'runtime.owner.shutdown': 'short',
  'runtime.network.inspect': 'short', 'runtime.profile.capture': 'long',
  'runtime.bootstrap': 'short', 'runtime.invoke': 'long', 'runtime.release-consumer': 'long',
  'runtime.events': 'long', 'runtime.conversation-watch': 'long', 'runtime.history-watch': 'long', 'runtime.attachment-watch': 'long', 'runtime.replay-watch': 'long'
} as const satisfies Record<AgentMuxHostedRuntimeMethod, 'short' | 'long'>

export const AGENTMUX_HOSTED_RPC_FIELDS = {
  'runtime.owner.identity': ['expectedRuntimeId'], 'runtime.owner.shutdown': ['fence'],
  'runtime.network.inspect': ['fence'], 'runtime.profile.capture': ['fence', 'processId', 'durationMs'],
  'runtime.bootstrap': ['consumerId', 'fence', 'sessions', 'agentSessionIds'], 'runtime.invoke': ['consumerId', 'fence', 'invocation'],
  'runtime.release-consumer': ['consumerId', 'fence'], 'runtime.events': ['consumerId', 'fence', 'sessions', 'agentSessionIds'],
  'runtime.conversation-watch': ['consumerId', 'fence', 'reference', 'options'],
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
  /** Local composition only, deliberately not a delegated Runtime method. */
  remoteTransportObservation?(): import('./remote-transport-observation.js').RemoteTransportObservation | null
  call<M extends Exclude<AgentMuxHostedRuntimeMethod, AgentMuxHostedStreamMethod>>(method: M,
    params: AgentMuxHostedRuntimeParameterMap[M], options?: { signal?: AbortSignal }): Promise<AgentMuxHostedRuntimeResultMap[M]>
  subscribe<M extends AgentMuxHostedStreamMethod>(method: M, params: AgentMuxHostedRuntimeParameterMap[M], handlers: {
    onInitial(value: AgentMuxHostedStreamInitial<M>): void
    onEvent(value: AgentMuxHostedStreamEvent): void
    onEnd?(error?: Error): void
    signal?: AbortSignal
  }): Promise<AgentMuxHostedSubscription>
}
