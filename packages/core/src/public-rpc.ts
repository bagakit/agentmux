import type { AgentMuxClient } from './client.js'
import { AGENTMUX_HOSTED_RPC_METHODS } from './hosted-client-contract.js'
import type { AgentMuxHostedRuntimeParameterMap, AgentMuxHostedRuntimeResultMap, AgentMuxHostedStreamMethod, AgentMuxHostedStreamInitialMap, AgentMuxHostedStreamEvent } from './hosted-client-contract.js'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxMessageTarget } from './control.js'
import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'
import type { AgentRoleBinding } from './agent-role-directory.js'
import type { AgentMuxMessageReceipt } from './agent-global-message-queue.js'
import type { AgentMuxDoctorReport } from './doctor.js'
import type { FollowOutput } from './session-output-follow.js'
import { AGENTMUX_RPC_DEVICE_METHODS } from './public-rpc-device.js'
import type { AgentMuxRpcDeviceMethod, AgentMuxRpcDeviceParameterMap, AgentMuxRpcDeviceResultMap } from './public-rpc-device.js'

/** Canonical public names and their existing business owner. No wire aliases. */
export const AGENTMUX_RPC_CONTROL_METHODS = {
  'agent.open': 'agent.open', 'agent.rename': 'agent.rename', 'agent.view': 'agent.view',
  'agent.interrupt': 'interrupt', 'agent.resume': 'resume', 'agent.stop': 'stop',
  'space.ls': 'space.ls', 'space.inspect': 'space.inspect', 'space.rename': 'space.rename',
  'space.mv': 'space.mv', 'space.swap': 'space.swap', 'space.bind': 'space.bind',
  'space.unbind': 'space.unbind', 'space.focus': 'focus', 'space.promote': 'promote.region',
  'space.arrange': 'arrange', 'file.open': 'open.file', 'file.view': 'space.view',
  'terminal.open': 'open.terminal', 'browser.open': 'open.browser',
  'browser.targets': 'browser.targets', 'browser.run': 'browser.run', 'browser.history': 'browser.history',
  'browser.inspect': 'browser.operation', 'browser.stop': 'browser.stop',
  'browser.replay': 'browser.replay', 'browser.follow': 'browser.subscribe',
  'browser.task.assets': 'browser.task.assets', 'browser.task.reliability': 'browser.task.reliability',
  'browser.task.run': 'browser.task.run', 'browser.task.stop': 'browser.task.stop',
  'browser.task.batch': 'browser.task.batch', 'browser.task.batch-stop': 'browser.task.batch-stop',
  'goal.ls': 'demand.list', 'goal.inspect': 'demand.show', 'goal.create': 'demand.create',
  'goal.update': 'demand.update', 'goal.delete': 'demand.delete', 'goal.assign': 'demand.assign',
  'goal.start': 'demand.start', 'goal.handoff': 'demand.handoff',
  'goal.link-session': 'demand.link-session', 'goal.link-project': 'demand.link-project',
  'goal.decisions': 'demand.decision-log', 'goal.focus': 'focus',
  'app.inspect': 'inspect.client', 'app.focus': 'focus',
  'settings.inspect': 'settings.get', 'settings.set': 'settings.set',
  'settings.hosts.ls': 'settings.hosts.list', 'settings.hosts.test': 'settings.hosts.test',
  'settings.executors.refresh': 'settings.executors.refresh',
  'settings.workspaces.register': 'settings.workspaces.add',
  'settings.browser-links.ls': 'settings.browser.links.list',
  'settings.browser-links.forget': 'settings.browser.links.forget',
  'settings.executors.ls': 'settings.resource.list', 'settings.executors.inspect': 'settings.resource.get',
  'settings.executors.create': 'settings.resource.add', 'settings.executors.update': 'settings.resource.update',
  'settings.executors.delete': 'settings.resource.remove',
  'settings.prompts.ls': 'settings.resource.list', 'settings.prompts.inspect': 'settings.resource.get',
  'settings.prompts.create': 'settings.resource.add', 'settings.prompts.update': 'settings.resource.update',
  'settings.prompts.delete': 'settings.resource.remove',
  'system.crash-log.inspect': 'diagnostics.crash-log.get',
  'system.crash-log.reveal': 'diagnostics.crash-log.reveal',
  'system.metrics.get': 'metrics.get', 'system.metrics.watch': 'metrics.watch',
  'toolkit.ls': 'toolkit.list', 'toolkit.inspect': 'toolkit.get', 'toolkit.script': 'toolkit.script',
  'toolkit.run': 'toolkit.run', 'toolkit.stop': 'toolkit.stop', 'toolkit.watch': 'toolkit.watch',
  'toolkit.create': 'toolkit.add', 'toolkit.update': 'toolkit.update',
  'toolkit.delete': 'toolkit.remove', 'toolkit.action': 'toolkit.action'
} as const satisfies Record<string, AgentMuxControlRequest['operation']>

type ControlMethod = keyof typeof AGENTMUX_RPC_CONTROL_METHODS
type Owner<M extends ControlMethod> = typeof AGENTMUX_RPC_CONTROL_METHODS[M]
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type OperationOwner<T, O> = T extends { operation: infer Operation }
  ? O extends Operation ? T : never : never
type BusinessParams<M extends ControlMethod> = OmitEach<OperationOwner<AgentMuxControlRequest,
  Owner<M>>, 'schemaVersion' | 'requestId' | 'operation' | 'caller' | 'resource'>
type BusinessResult<M extends ControlMethod> = OmitEach<OperationOwner<AgentMuxControlResult,
  Owner<M>>, 'operation'>
type GoalKeys<T> = T extends readonly (infer E)[] ? GoalKeys<E>[] : T extends object ? {
  [K in keyof T as K extends 'demandId' ? 'goalId' : K extends 'parentDemandId' ? 'parentGoalId' : K extends 'demand' ? 'goal' : K extends 'demands' ? 'goals' : K]:
    K extends 'receipt' | 'goal' | 'demand' | 'goals' | 'demands' | 'decisions' | 'patch' ? GoalKeys<T[K]> : T[K]
} : T
type OperationKeys<T> = T extends object ? {
  [K in keyof T as K extends 'requestId' ? 'operationId' : K]: K extends 'request' | 'report' | 'binding' ? OperationKeys<T[K]> : T[K]
} : T
type ControlParams<M extends ControlMethod> = M extends 'space.inspect'
  ? { target: import('./space-control.js').AgentMuxSpaceSelector | { operationId: string } }
  : M extends 'goal.ls' ? AgentMuxRpcGoalFilters
  : M extends 'goal.create' ? Omit<BusinessParams<M>, 'decision'> & {
      risk?: import('./control.js').AgentMuxDemandDecision['risk'];
      confirmation?: import('./control.js').AgentMuxDemandDecision['confirmation']; wikiVersion?: string;
      decision?: Omit<import('./control.js').AgentMuxDemandDecision, 'recordedAt' | 'sourceSessionId'> }
  : M extends 'goal.focus' ? { goalId: string; input?: 'preserve' | 'target' }
  : M extends 'settings.browser-links.forget' ? { input: unknown }
  : M extends `settings.${'executors' | 'prompts'}.update` ? { id: string; input: unknown }
  : M extends `settings.${'executors' | 'prompts'}.delete` ? { id: string; input?: unknown }
  : M extends 'toolkit.update' | 'toolkit.delete' | 'toolkit.run' | 'toolkit.stop'
    ? { toolId: string; input?: unknown }
  : M extends 'toolkit.create' ? { toolId: string; value: unknown }
  : M extends `settings.${'executors' | 'prompts'}.create` ? { id: string; value: unknown }
  : M extends `goal.${string}` ? GoalKeys<BusinessParams<M>>
  : BusinessParams<M>

export type AgentMuxRpcCredentials = { agentSessionId: string; capability: string }
/** Transport-approved local user/device identity; never supplied by business params. */
export type AgentMuxRpcPrincipal = Readonly<{ kind: 'user' | 'device'; id: string }>
export type AgentMuxRpcEndpoint =
  | { transport: 'unix'; path: string }
  | { transport: 'http'; url: string; token?: string }
  | { transport: 'ssh'; host: string; port?: number; user?: string; identityFile?: string; command?: string; socketPath?: string }
export type AgentMuxRpcSessionTarget = AgentMuxAgentSessionLookup | { kind: 'self' }
export type AgentMuxRpcUnavailable = { code: string; message: string; recovery: string }
export type AgentMuxRpcGoalFilters = {
  goalId?: string; projectId?: string; agentSessionId?: string; executorId?: string;
  status?: string; since?: number; limit?: number
}
export type AgentMuxRpcAgentInspection = {
  session: ReturnType<AgentMuxClient['agentSession']>
  status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null
  unavailable: AgentMuxRpcUnavailable[]
  displayName: { override: string | null; availability: 'observed' | 'unavailable' }
}
export type AgentMuxRpcSnapshotParams = {
  projectId?: string; workspaceId?: string; topicId?: string; agentSessionId?: string;
  goalId?: string; executorId?: string; status?: string; since?: number; limit?: number;
  include?: Array<'projects' | 'workspaces' | 'topics' | 'motes' | 'spaces' | 'zones' |
    'executors' | 'agents' | 'sessions' | 'goals' | 'decisions' | 'activity'>
}
export type AgentMuxRpcSnapshot = {
  projects: import('./control.js').AgentMuxControlProject[]; workspaces: AgentMuxRpcWorkspace[]; topics: AgentMuxRpcTopic[]; motes: AgentMuxRpcTopic[];
  spaces: import('./space-control.js').AgentMuxSpaceFact[]; zones: import('./space-control.js').AgentMuxZoneFact[];
  executors: Extract<AgentMuxControlResult, { operation: 'list.agents' }>['agents'];
  agents: import('./control.js').AgentMuxControlActiveAgent[];
  sessions: Awaited<ReturnType<AgentMuxClient['statusAgent']>>[]; goals: AgentMuxRpcGoal[];
  decisions: Array<{ goalId: string; decisions: import('./control.js').AgentMuxDemandDecision[] }>;
  activity: Array<{ goalId: string; message: string; updatedAt: number }>;
  unavailable: Array<AgentMuxRpcUnavailable & { source: string }>
}
export type AgentMuxRpcWorkspace = {
  workspaceId: string; hostId: string; name: string; projectId: string | null;
  path: string; kind: string; repoPath: string | null; branch: string | null
}
/** Original filesystem facts; Core transports them without ensuring or rewriting files. */
export type AgentMuxRpcTopic = {
  id: string; topicId: string; workspaceId: string; hostId: string; path: string;
  spaceId: string | null; kind: 'topic' | 'mote' | 'unknown'; directoryPath: string;
  topicPath: string; title: string; summary: string; readError?: string;
  soul?: { path: string; content: string; version: string };
  moteArchive?: { state: 'active' | 'archived'; version: string } | { state: 'unknown'; issue: string };
  collaborators: Array<{ fileName: string; providerId: string; sessionId: string }>;
  wiki?: { path: string; content: string; version: string; source: 'default' | 'user'; enabled: boolean; updatedAt: number | null }
}
export type AgentMuxRpcGoal = GoalKeys<import('./control.js').AgentMuxDemand>
export type AgentMuxRpcOutputBytes = Omit<FollowOutput, 'dataBytes'> & { dataBase64: string }
export type AgentMuxRpcOutputInitial = {
  session: ReturnType<AgentMuxClient['agentSession']>
} & Pick<Awaited<ReturnType<AgentMuxClient['observeAgentOutput']>>['attachment'],
  'run' | 'gap' | 'terminal' | 'resizeRevision'>
type NativeParams = AgentMuxRpcDeviceParameterMap & AgentMuxHostedRuntimeParameterMap & {
  'notebook.ls': Record<string, never>
  'notebook.inspect': { notebookId?: string; noteId?: string; operationId?: string }
  'notebook.apply': import('./notebook-catalog.js').NotebookWrite
  'space.state': Record<string, never>
  'space.commit': import('./spatial-state.js').AgentMuxSpatialCommit
  'space.resolve': import('./spatial-state.js').AgentMuxSpatialResolve
  whoami: Record<string, never>
  'agent.ls': { agentSessionId?: string; executorId?: string; status?: string; since?: number; limit?: number }
  'agent.inspect': { target: AgentMuxRpcSessionTarget }
  'agent.history': import('./session-history-reader.js').AgentSessionHistoryReadInput
  'agent.reopen': Parameters<AgentMuxClient['reopenAgent']>[0]
  'agent.reopen.check': Parameters<AgentMuxClient['reconcileAgentReopen']>[0]
  'agent.role.ls': { workspacePath?: string }
  'agent.role.register': { role: string; providerId?: string }
  'agent.role.resolve': { role: string; workspacePath?: string }
  'agent.send': { target: AgentMuxMessageTarget; text: string; operationId: string;
    messageId?: string; threadId?: string; correlationId?: string; replyTo?: string }
  'agent.discuss': { executorId: string; providerId?: string; text: string; operationId: string }
  'agent.handoff': { toAgentSessionId: string; taskId: string }
  'agent.output': { agentSessionId: string; afterByte?: number; follow?: boolean }
  'message.inbox.check': { limit: number }
  'message.inbox.ack': { generation: number; readerRun: import('./types.js').AgentMuxRunRef }
  'message.dispatch.open': { sourceMessageId: string }
  'message.dispatch.inspect': { sourceMessageId: string }
  'message.dispatch.report': { sourceMessageId: string; replyMessageId: string; kind: import('./agent-handoff.js').DispatchEventKind }
  'app.snapshot': AgentMuxRpcSnapshotParams
  'goal.activity': AgentMuxRpcGoalFilters
  'system.doctor': { workspacePath?: string }
  'system.endpoint': Record<string, never>
  'system.subscription.cancel': { subscriptionId: string }
}
type NativeResult = AgentMuxRpcDeviceResultMap & AgentMuxHostedRuntimeResultMap & {
  'notebook.ls': { state: import('./notebook-catalog.js').NotebookState }
  'notebook.inspect': { state: import('./notebook-catalog.js').NotebookState; notebook: import('./notebook-catalog.js').Notebook | null; pages: import('./notebook-catalog.js').NotebookPage[]; trail: import('./notebook-catalog.js').NoteTrailEvent[]; recordedOperation: import('./notebook-catalog.js').NotebookState['operations'][string] | null }
  'notebook.apply': { state: import('./notebook-catalog.js').NotebookState }
  'space.state': { state: import('./spatial-state.js').AgentMuxSpatialState | null }
  'space.commit': { state: import('./spatial-state.js').AgentMuxSpatialState }
  'space.resolve': ReturnType<typeof import('./spatial-state.js').resolveSpatialRegion>
  whoami: { session: ReturnType<AgentMuxClient['agentSession']>; status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null;
    view: import('./agent-self-context.js').SelfViewOutcome; topic: string;
    messaging: typeof import('./agent-messaging-guidance.js').AGENTMUX_AGENT_MESSAGING_RULES; unavailable: AgentMuxRpcUnavailable[] }
  'agent.ls': { sessions: Awaited<ReturnType<AgentMuxClient['statusAgent']>>[];
    errors: Array<{ agentSessionId: string | null; hostId?: string; code: string; message: string }> }
  'agent.inspect': AgentMuxRpcAgentInspection
  'agent.history': import('./session-history-reader.js').AgentSessionHistoryReadPage
  'agent.reopen': { session: Awaited<ReturnType<AgentMuxClient['reopenAgent']>> }
  'agent.reopen.check': { session: Awaited<ReturnType<AgentMuxClient['reconcileAgentReopen']>> }
  'agent.role.ls': { bindings: AgentRoleBinding[] }
  'agent.role.register': { binding: AgentRoleBinding }
  'agent.role.resolve': { binding: AgentRoleBinding }
  'agent.send': AgentMuxMessageReceipt & { agentSessionId?: string }
  'agent.discuss': { threadId: string; delivery: string; targetAgentSessionId: string }
  'agent.handoff': ReturnType<AgentMuxClient['handOff']>
  'agent.output': AgentMuxRpcOutputInitial & { replay: AgentMuxRpcOutputBytes[] }
  'message.inbox.check': Awaited<ReturnType<AgentMuxClient['checkDeliveries']>>
  'message.inbox.ack': Awaited<ReturnType<AgentMuxClient['ackDeliveryBatch']>>
  'message.dispatch.open': Awaited<ReturnType<AgentMuxClient['openDispatch']>>
  'message.dispatch.inspect': Awaited<ReturnType<AgentMuxClient['showDispatch']>>
  'message.dispatch.report': Awaited<ReturnType<AgentMuxClient['recordDispatchEvent']>>
  'app.snapshot': AgentMuxRpcSnapshot
  'goal.activity': { activity: Array<{ goalId: string; message: string; updatedAt: number }> }
  'system.doctor': AgentMuxDoctorReport
  'system.endpoint': { protocol: 'jsonrpc-2.0'; framing: 'json-lines'; endpoint: AgentMuxRpcEndpoint }
  'system.subscription.cancel': { disposed: boolean }
}
export type AgentMuxRpcMethod = ControlMethod | keyof NativeParams
type PublicParameterMap = AgentMuxHostedRuntimeParameterMap & AgentMuxRpcDeviceParameterMap & {
  [M in Exclude<keyof NativeParams, keyof AgentMuxHostedRuntimeParameterMap | AgentMuxRpcDeviceMethod>]: NativeParams[M] & { operationId?: string }
} & { [M in ControlMethod]: ControlParams<M> & { operationId?: string } }
export type AgentMuxRpcParams<M extends AgentMuxRpcMethod> = PublicParameterMap[M]
type PublicResultMap = NativeResult & {
  [M in ControlMethod]: M extends 'space.inspect' ? OperationKeys<BusinessResult<M>> & { presentation?: AgentMuxRpcSpacePresentation }
    : OperationKeys<GoalKeys<BusinessResult<M>>>
}
export type AgentMuxRpcResult<M extends AgentMuxRpcMethod> = PublicResultMap[M]
export type AgentMuxRpcSpacePresentation = {
  region: import('./control.js').AgentMuxInspectedRegion | null;
  tab: import('./control.js').AgentMuxInspectedTab | null;
  unavailable: AgentMuxRpcUnavailable[]
}

export const AGENTMUX_RPC_NATIVE_METHODS = {
  ...AGENTMUX_RPC_DEVICE_METHODS,
  ...AGENTMUX_HOSTED_RPC_METHODS,
  'notebook.ls': 'short', 'notebook.inspect': 'short', 'notebook.apply': 'long',
  'space.state': 'short', 'space.commit': 'long', 'space.resolve': 'short',
  whoami: 'short', 'agent.ls': 'short', 'agent.inspect': 'short', 'agent.history': 'long', 'agent.reopen': 'long', 'agent.reopen.check': 'long',
  'agent.role.ls': 'short', 'agent.role.register': 'long', 'agent.role.resolve': 'short',
  'agent.send': 'long', 'agent.discuss': 'long', 'agent.handoff': 'short',
  'agent.output': 'long', 'message.inbox.check': 'long', 'message.inbox.ack': 'long',
  'message.dispatch.open': 'long', 'message.dispatch.inspect': 'short', 'message.dispatch.report': 'long',
  'app.snapshot': 'long', 'goal.activity': 'short', 'system.doctor': 'long',
  'system.endpoint': 'short', 'system.subscription.cancel': 'short'
} as const satisfies Record<keyof NativeParams, 'short' | 'long'>

export type AgentMuxRpcStreamMethod = 'agent.output' | 'browser.follow' | 'toolkit.watch' | 'system.metrics.watch' |
  AgentMuxHostedStreamMethod
export type AgentMuxRpcStreamParams<M extends AgentMuxRpcStreamMethod> = AgentMuxRpcParams<M> &
  (M extends 'agent.output' ? { follow?: boolean } : Record<never, never>)
type AgentMuxRpcStreamInitialMap = AgentMuxHostedStreamInitialMap & {
  'agent.output': AgentMuxRpcOutputInitial
  'browser.follow': { runOperation: import('./control.js').AgentMuxControlBrowserOperation | null;
    gap: { droppedThrough: number } | null }
  'toolkit.watch': { toolId: string }
  'system.metrics.watch': { observation: import('./metrics.js').MetricsObservation }
}
export type AgentMuxRpcStreamInitial<M extends AgentMuxRpcStreamMethod> = AgentMuxRpcStreamInitialMap[M]
export type AgentMuxRpcStreamEvent<M extends AgentMuxRpcStreamMethod> =
  | { type: 'end'; data: unknown }
  | { type: 'error'; error: { code: string; message: string; detail?: string; details?: unknown; candidates?: unknown; controlFailure?: import('./errors.js').AgentMuxControlFailure; evidence?: import('./types.js').AgentMuxEvidence } }
  | (M extends AgentMuxHostedStreamMethod ? Extract<AgentMuxHostedStreamEvent, { type: 'snapshot' }>
    : M extends 'agent.output' ? { type: 'output'; data: AgentMuxRpcOutputBytes }
    : M extends 'browser.follow' ? { type: 'progress'; data: import('./control.js').AgentMuxControlBrowserEvent }
    : { type: 'snapshot'; data: M extends 'toolkit.watch' ? import('./toolkit.js').ToolkitSnapshot : import('./metrics.js').MetricsObservation })

export function isAgentMuxRpcMethod(value: unknown): value is AgentMuxRpcMethod {
  return typeof value === 'string' && (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, value) ||
    Object.hasOwn(AGENTMUX_RPC_NATIVE_METHODS, value))
}
export function isAgentMuxRpcStream(method: AgentMuxRpcMethod, params: Record<string, unknown>): method is AgentMuxRpcStreamMethod {
  return method === 'browser.follow' || method === 'toolkit.watch' || method === 'system.metrics.watch' ||
    method === 'agent.output' || method === 'runtime.events' || method === 'runtime.history-watch' ||
    method === 'runtime.attachment-watch' || method === 'runtime.replay-watch'
}
