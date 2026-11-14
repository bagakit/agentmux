import { SPACE_LINK_METHODS, type SpaceLinkParams, type SpaceLinkResult } from './space-link.js'
import { AGENT_PROMOTION_METHODS, type AgentPromotionParamsMap, type AgentPromotionResultMap, type AgentPromotionMethod } from './agent-promotion.js'
import { MESH_NETWORK_METHODS, type MeshNetworkParams, type MeshNetworkResults, type MeshNetworkMethod } from './mesh-network.js'
import { NAME_CONTROL_METHODS, type NameControlParams, type NameControlResults } from './name-control.js'
import { OBJECT_AVATAR_METHODS, type ObjectAvatarParamsMap, type ObjectAvatarResultMap, type ObjectAvatarMethod } from './object-avatar.js'
import { SPACE_CLOSE_METHODS } from './space-close.js'
import { SETTINGS_PREFERENCE_OPERATIONS } from './settings-preferences.js'
import { TAILCAT_CONFIGURATION_METHODS, type TailcatConfigurationParamsMap, type TailcatConfigurationResultMap, type TailcatConfigurationMethod } from './public-rpc-tailcat-configuration.js'
import { NOTES_STORAGE_METHODS, type NotesStorageParamsMap, type NotesStorageResultMap, type NotesStorageMethod } from './public-rpc-notes-storage.js'
import { PROVIDER_CATALOG_METHODS, type ProviderCatalogParamsMap, type ProviderCatalogResultMap, type ProviderCatalogMethod } from './public-rpc-provider-catalog.js'
import { SPACE_MEMBER_METHODS, type SpaceMemberParams, type SpaceMemberResults } from './space-member.js'
import { HOST_ROUTE_METHODS, type HostRouteParams, type HostRouteResults } from './host-route.js'
import { SPACE_FOLDER_METHODS, type SpaceFolderParams, type SpaceFolderResults } from './space-folder.js'
import { AGENT_OPEN_METHODS, type AgentOpenParams, type AgentOpenResults } from './agent-open-contract.js'
import { SPACE_SESSION_METHODS, type SpaceSessionsParams, type SpaceSessionsResults } from './space-sessions.js'
import { SPACE_AUTHORITY_METHODS, type SpaceAuthorityParams, type SpaceAuthorityResults } from './space-authority.js'
import { NODE_LOCATOR_METHODS, type NodeLocatorParamsMap, type NodeLocatorResultMap, type NodeLocatorMethod } from './node-locator.js'
import { NODE_PUBLISHING_METHODS, type NodePublishingParams, type NodePublishingResults, type NodePublishingMethod } from './node-publishing.js'
import { AGENTMUX_RPC_IMAGE_METHODS, type ImageParamsMap, type ImageResultMap, type ImageMethod } from './public-rpc-image.js'
import { MOTE_DIALOGUE_METHODS, type MoteDialogueParamsMap, type MoteDialogueResultMap } from './mote-dialogue.js'
import { AGENT_PROGRESS_METHODS, type AgentProgressParams, type AgentProgressResults } from './agent-progress.js'
import { MOTE_CHAT_RPC_METHODS } from './mote-chat-codec.js'
import { AGENT_LEARNING_METHODS, type AgentLearningMethod, type AgentLearningParamsMap, type AgentLearningResultMap } from './agent-learning.js'
import { CAPSULE_METHODS, type CapsuleParamsMap, type CapsuleResultMap } from '@agentmux/capsule'
import { CAPSULE_RUNTIME_METHODS, type CapsuleRuntimeParamsMap, type CapsuleRuntimeResultMap } from './capsule-runtime.js'
import type { MoteChatMethod, MoteChatParamsMap, MoteChatResultMap } from './mote-chat-contract.js'
import { APPLICATION_ACCESS_METHODS, type ApplicationAccessMethod, type ApplicationAccessParameterMap, type ApplicationAccessResultMap } from './application-access.js'
import { MOTE_CONNECTION_RPC_METHODS } from './mote-connection-codec.js'
import type { MoteConnectionMethod, MoteConnectionParamsMap, MoteConnectionResultMap } from './mote-connection-contract.js'
import { CONNECTION_RPC_METHODS } from './connections-codec.js'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from './connections-contract.js'
import { GOAL_DELEGATION_METHODS } from './goal-delegation-methods.js'
import type { GoalDelegationParamsMap, GoalDelegationResultMap } from './goal-delegation.js'
import { AGENTMUX_RPC_MOTE_AVATAR_WRITE_METHODS, type MoteAvatarParameterMap, type MoteAvatarResultMap, type MoteAvatarMethod } from './mote-avatar-write.js'
import { AGENTMUX_RPC_MOTE_AVATAR_METHODS } from './mote-avatar-series.js'
import { AGENTMUX_RPC_TOPIC_METHODS } from './public-rpc-topics.js'
import type { TopicParameterMap, TopicResultMap, TopicMethod } from './public-rpc-topics.js'
import { AGENTMUX_RPC_FILE_METHODS } from './public-rpc-files.js'
import type { FileParameterMap, FileResultMap, FileMethod } from './public-rpc-files.js'
import { AGENTMUX_RPC_GIT_METHODS } from './public-rpc-git.js'
import type { GitParameterMap, GitResultMap, GitMethod } from './public-rpc-git.js'
import { AGENTMUX_RPC_WINDOW_METHODS } from './public-rpc-windows.js'
import { APP_CAPTURE_METHODS, type AppCaptureParamsMap, type AppCaptureResultMap } from './app-capture.js'
import type { AppWindowParamsMap, AppWindowResultMap } from './public-rpc-windows.js'
import { AGENTMUX_RPC_SCHEDULE_METHODS } from './public-rpc-schedules.js'
import type { ScheduleParamsMap, ScheduleResultMap, ScheduleMethod } from './public-rpc-schedules.js'
import { AGENTMUX_RPC_DESKTOP_NATIVE_METHODS, type NativeDesktopParamsMap, type NativeDesktopResultMap, type NativeDesktopMethod } from './public-rpc-native-desktop.js'
import type { AgentMuxClient } from './client.js'
import type { AgentPromptExecution } from './types.js'
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
import { AGENTMUX_RPC_HOST_SETTINGS_METHODS } from './public-rpc-host-settings.js'
import type { HostSettingsParameterMap, HostSettingsResultMap, HostSettingsMethod } from './public-rpc-host-settings.js'
import { AGENTMUX_RPC_TAILCAT_KEY_METHODS, type TailcatKeyParamsMap, type TailcatKeyResultMap, type TailcatKeyMethod } from './public-rpc-tailcat-key.js'
import { AGENTMUX_RPC_HOST_MAINTENANCE_METHODS, type HostMaintenanceMethod, type HostMaintenanceParamsMap, type HostMaintenanceResultMap } from './public-rpc-host-maintenance.js'

/** Canonical public names and their existing business owner. No wire aliases. */
export const AGENTMUX_RPC_CONTROL_METHODS = {
  ...SETTINGS_PREFERENCE_OPERATIONS,
  'message.pending.ls': 'message.pending.ls', 'message.pending.edit': 'message.pending.edit', 'message.pending.send': 'message.pending.send', 'message.pending.stop': 'message.pending.stop',
  'message.pending.archive': 'message.pending.archive', 'message.pending.restore': 'message.pending.restore',
  'agent.open': 'agent.open', 'agent.rename': 'agent.rename', 'agent.view': 'agent.view',
  'agent.interrupt': 'interrupt', 'agent.resume': 'resume', 'agent.stop': 'stop',
  'space.mote.preferences.read': 'space.mote.preferences.read', 'space.mote.preferences.save': 'space.mote.preferences.save',
  'space.ls': 'space.ls', 'space.inspect': 'space.inspect', 'space.rename': 'space.rename', 'space.agent-order': 'space.agent-order', 'space.survey-list': 'space.survey-list',
  'space.mv': 'space.mv', 'space.swap': 'space.swap', 'space.bind': 'space.bind',
  'space.unbind': 'space.unbind', 'space.focus': 'focus', 'space.promote': 'promote.region',
  'space.arrange': 'arrange', 'file.open': 'open.file', 'file.view': 'space.view', 'file.format': 'file.format', 'file.build': 'file.build', 'file.build.inspect': 'file.build.inspect', 'file.build.cancel': 'file.build.cancel',
  'terminal.open': 'open.terminal', 'browser.open': 'open.browser',
  'git.open': 'open.git',
  'browser.create': 'browser.create', 'browser.close': 'browser.close', 'browser.release': 'browser.release', 'browser.restore': 'browser.restore', 'browser.targets': 'browser.targets', 'browser.run': 'browser.run', 'browser.history': 'browser.history',
  'browser.inspect': 'browser.operation',
  'browser.agent-workspace.prepare': 'browser.agent-workspace.prepare',
  'browser.profile.proxy.ls': 'browser.profile.proxy.ls', 'browser.profile.proxy.create': 'browser.profile.proxy.create', 'browser.profile.proxy.update': 'browser.profile.proxy.update', 'browser.profile.proxy.delete': 'browser.profile.proxy.delete', 'browser.profile.proxy.assign': 'browser.profile.proxy.assign',
  'browser.profile.ls': 'browser.profile.ls', 'browser.profile.inspect': 'browser.profile.inspect',
  'browser.profile.folder.create': 'browser.profile.folder.create', 'browser.profile.folder.rename': 'browser.profile.folder.rename', 'browser.profile.folder.delete': 'browser.profile.folder.delete',
  'browser.profile.trash.ls': 'browser.profile.trash.ls', 'browser.profile.trash.restore': 'browser.profile.trash.restore',
  'browser.profile.trash.retention': 'browser.profile.trash.retention', 'browser.profile.trash.purge': 'browser.profile.trash.purge', 'browser.profile.trash.inspect': 'browser.profile.trash.inspect',
  'browser.profile.view.create': 'browser.profile.view.create', 'browser.profile.view.update': 'browser.profile.view.update', 'browser.profile.view.delete': 'browser.profile.view.delete', 'browser.profile.bulk-update': 'browser.profile.bulk-update',
  'browser.profile.creation.inspect': 'browser.profile.creation.inspect',
  'browser.profile.create': 'browser.profile.create', 'browser.profile.copy': 'browser.profile.copy', 'browser.profile.update': 'browser.profile.update',
  'browser.profile.set-default': 'browser.profile.set-default', 'browser.profile.delete': 'browser.profile.delete',
  'browser.profile.proxy-sign-in.set': 'browser.profile.proxy-sign-in.set', 'browser.profile.proxy-sign-in.clear': 'browser.profile.proxy-sign-in.clear',
  'browser.profile.network.check': 'browser.profile.network.check',
  'browser.profile.network.probe': 'browser.profile.network.probe',
  'browser.profile.network.history': 'browser.profile.network.history',
  'browser.profile.cookie-file.prepare-import': 'browser.profile.cookie-file.prepare-import', 'browser.profile.cookie-file.import': 'browser.profile.cookie-file.import', 'browser.profile.cookie-file.export': 'browser.profile.cookie-file.export', 'browser.profile.cookie-file.inspect': 'browser.profile.cookie-file.inspect', 'browser.profile.cookie-file.discard': 'browser.profile.cookie-file.discard', 'browser.profile.cookie-file.reveal': 'browser.profile.cookie-file.reveal',
  'browser.profile.bookmark.ls': 'browser.profile.bookmark.ls', 'browser.profile.bookmark.edit': 'browser.profile.bookmark.edit',
  'browser.profile.bookmark.import': 'browser.profile.bookmark.import', 'browser.profile.bookmark.export': 'browser.profile.bookmark.export', 'browser.profile.bookmark.open': 'browser.profile.bookmark.open',
  'browser.profile.extension.ls': 'browser.profile.extension.ls', 'browser.profile.extension.prepare': 'browser.profile.extension.prepare',
  'browser.profile.extension.apply': 'browser.profile.extension.apply', 'browser.profile.extension.remove': 'browser.profile.extension.remove', 'browser.profile.extension.load': 'browser.profile.extension.load',
  // Stopping an active external-tab operation also ends only its original sharing
  // grant. Finished operations return their retained state without revoking sharing.
  // Other targets and the original tab remain. Cancelling a reader does neither.
  'browser.stop': 'browser.stop',
  'browser.replay': 'browser.replay', 'browser.follow': 'browser.subscribe',
  'browser.task.export': 'browser.task.export', 'browser.task.import': 'browser.task.import', 'browser.task.import-inspect': 'browser.task.import-inspect',
  'browser.task.source': 'browser.task.source',
  'browser.task.draft': 'browser.task.draft',
  'browser.task.create': 'browser.task.create',
  'browser.task.create-inspect': 'browser.task.create-inspect',
  'browser.task.assets': 'browser.task.assets', 'browser.task.inspect': 'browser.task.inspect', 'browser.task.parallel-continue': 'browser.task.parallel-continue', 'browser.task.parallel-stop': 'browser.task.parallel-stop', 'browser.task.parallel': 'browser.task.parallel', 'browser.task.parallel-inspect': 'browser.task.parallel-inspect', 'browser.task.parallel-list': 'browser.task.parallel-list', 'browser.task.reliability': 'browser.task.reliability',
  'browser.task.edit': 'browser.task.edit', 'browser.task.publish': 'browser.task.publish',
  'browser.task.run': 'browser.task.run', 'browser.task.stop': 'browser.task.stop',
  'browser.task.batch': 'browser.task.batch', 'browser.task.batch-stop': 'browser.task.batch-stop',
  'goal.ls': 'demand.list', 'goal.inspect': 'demand.show', 'goal.create': 'demand.create',
  'goal.update': 'demand.update', 'goal.delete': 'demand.delete', 'goal.assign': 'demand.assign',
  'goal.discuss': 'demand.discuss', 'goal.confirm': 'demand.confirm', 'goal.accept': 'demand.accept',
  'goal.patrol.all': 'demand.patrol-all',
  'goal.start': 'demand.start', 'goal.continuation-action': 'demand.continuation-action', 'goal.handoff': 'demand.handoff',
  'goal.link-session': 'demand.link-session', 'goal.link-project': 'demand.link-project',
  'goal.decisions': 'demand.decision-log', 'goal.focus': 'focus',
  'goal.activity.collection': 'demand.activity.collection', 'goal.activity.read': 'demand.activity.read', 'goal.activity.append': 'demand.activity.append', 'goal.activity.inspect': 'demand.activity.inspect',
  'app.inspect': 'inspect.client', 'app.focus': 'focus',
  'settings.inspect': 'settings.get', 'settings.set': 'settings.set',
  'settings.hosts.create': 'settings.hosts.create', 'settings.hosts.configure': 'settings.hosts.configure', 'settings.hosts.delete': 'settings.hosts.delete',
  'settings.hosts.ls': 'settings.hosts.list', 'settings.hosts.update': 'settings.hosts.update', 'settings.hosts.test': 'settings.hosts.test',
  'settings.hosts.install-check': 'settings.hosts.install-check',
  'settings.hosts.install': 'settings.hosts.install',
  'settings.hosts.install-inspect': 'settings.hosts.install-inspect',
  'settings.hosts.upgrade-check': 'settings.hosts.upgrade-check',
  'settings.hosts.upgrade': 'settings.hosts.upgrade',
  'settings.hosts.upgrade-inspect': 'settings.hosts.upgrade-inspect',
  'settings.hosts.upgrade-reconnect': 'settings.hosts.upgrade-reconnect',
  'settings.executors.refresh': 'settings.executors.refresh',
  'settings.workspaces.register': 'settings.workspaces.add',
  'settings.browser-default.inspect': 'settings.browser.default.inspect',
  'settings.browser-default.open-settings': 'settings.browser.default.open-settings',
  'settings.browser-links.ls': 'settings.browser.links.list',
  'settings.browser-links.forget': 'settings.browser.links.forget',
  'settings.executors.ls': 'settings.resource.list', 'settings.executors.inspect': 'settings.resource.get',
  'settings.executors.create': 'settings.resource.add', 'settings.executors.update': 'settings.resource.update',
  'settings.executors.delete': 'settings.resource.remove',
  'settings.prompts.ls': 'settings.resource.list', 'settings.prompts.inspect': 'settings.resource.get',
  'settings.prompts.create': 'settings.resource.add', 'settings.prompts.update': 'settings.resource.update',
  'settings.prompts.delete': 'settings.resource.remove',
  'settings.themes.ls': 'settings.resource.list', 'settings.themes.inspect': 'settings.resource.get',
  'settings.themes.create': 'settings.resource.add', 'settings.themes.update': 'settings.resource.update',
  'settings.themes.delete': 'settings.resource.remove',
  'settings.derived-actions.ls': 'settings.resource.list', 'settings.derived-actions.inspect': 'settings.resource.get',
  'settings.derived-actions.create': 'settings.resource.add', 'settings.derived-actions.update': 'settings.resource.update',
  'settings.derived-actions.delete': 'settings.resource.remove',
  'system.crash-log.inspect': 'diagnostics.crash-log.get',
  'system.crash-log.reveal': 'diagnostics.crash-log.reveal',
  'system.metrics.get': 'metrics.get', 'system.metrics.watch': 'metrics.watch',
  'system.metrics.app-memory.inspect': 'metrics.app-memory.inspect',
  'system.metrics.allocations.capture': 'metrics.allocations.capture',
  'system.metrics.scene.capture': 'metrics.scene.capture',
  'system.metrics.scene.inspect': 'metrics.scene.inspect',
  'system.metrics.profile.capture': 'metrics.profile.capture',
  'system.metrics.cache.inspect': 'metrics.cache.inspect',
  'system.metrics.cache.reclaim': 'metrics.cache.reclaim',
  'system.metrics.memory.inspect': 'metrics.memory.inspect',
  'system.metrics.memory.workers.inspect': 'metrics.memory.workers.inspect',
  'system.metrics.heap.capture': 'metrics.heap.capture',
  'system.metrics.heap.inspect': 'metrics.heap.inspect',
  'system.metrics.animations.inspect': 'metrics.animations.inspect',
  'system.metrics.trace.capture': 'metrics.trace.capture',
  'toolkit.ls': 'toolkit.list', 'toolkit.inspect': 'toolkit.get', 'toolkit.script': 'toolkit.script',
  'toolkit.run': 'toolkit.run', 'toolkit.evaluate': 'toolkit.evaluate', 'toolkit.stop': 'toolkit.stop', 'toolkit.watch': 'toolkit.watch',
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
  [K in keyof T as K extends 'demandIds' ? 'goalIds' : K extends 'demandId' ? 'goalId' : K extends 'parentDemandId' ? 'parentGoalId' : K extends 'demand' ? 'goal' : K extends 'demands' ? 'goals' : K]:
    K extends 'receipt' | 'goal' | 'demand' | 'goals' | 'demands' | 'decisions' | 'groups' | 'patch' ? GoalKeys<T[K]> : T[K]
} : T
type OperationKeys<T> = T extends object ? {
  [K in keyof T as K extends 'requestId' ? 'operationId' : K]: K extends 'request' | 'report' | 'binding' | 'receipt' ? OperationKeys<T[K]> : T[K]
} : T
type ControlParams<M extends ControlMethod> = M extends 'space.inspect'
  ? { target: import('./space-control.js').AgentMuxSpaceSelector | { operationId: string }; presentation?: boolean }
  : M extends 'space.mote.preferences.save' ? import('./mote-preferences.js').MotePreferencesSaveParams
  : M extends 'goal.ls' ? AgentMuxRpcGoalFilters
  : M extends 'goal.create' ? GoalKeys<Omit<BusinessParams<M>, 'decision'>> & {
      risk?: import('./control.js').AgentMuxDemandDecision['risk'];
      confirmation?: import('./control.js').AgentMuxDemandDecision['confirmation']; wikiVersion?: string;
      decision?: Omit<import('./control.js').AgentMuxDemandDecision, 'recordedAt' | 'sourceSessionId'> }
  : M extends 'goal.focus' ? { goalId: string; runtimeId?: string; namespace?: string; section?: 'plan'; input?: 'preserve' | 'target' }
  : M extends 'goal.activity.append' | 'goal.activity.inspect' ? GoalKeys<BusinessParams<M>> & { operationId: string }
  : M extends 'settings.browser-links.forget' ? { input: unknown }
  : M extends 'settings.prompts.inspect' ? { id: string; keyword?: never } | { keyword: string; id?: never }
  : M extends 'settings.executors.inspect' | 'settings.themes.inspect' | 'settings.derived-actions.inspect' ? { id: string }
  : M extends `settings.${'executors' | 'prompts' | 'themes' | 'derived-actions'}.update` ? { id: string; input: unknown }
  : M extends `settings.${'executors' | 'prompts' | 'themes' | 'derived-actions'}.delete` ? { id: string; input?: unknown }
  : M extends 'toolkit.update' | 'toolkit.delete' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.evaluate'
    ? { toolId: string; input?: unknown }
  : M extends 'toolkit.create' ? { toolId: string; value: unknown }
  : M extends `settings.${'executors' | 'prompts' | 'themes' | 'derived-actions'}.create` ? { id: string; value: unknown }
  : M extends `goal.${string}` ? GoalKeys<BusinessParams<M>>
  : BusinessParams<M>

export type AgentMuxRpcCredentials = { agentSessionId: string; capability: string }
/** Transport-approved local user/device identity; never supplied by business params. */
export type AgentMuxRpcPrincipal = Readonly<{ kind: 'user' | 'device'; id: string }>
/** Address includes secret connection material; never use it as a display label or diagnostic. */
export type AgentMuxTailcatTarget = { address: string; keyFile: string }
export type AgentMuxRpcRemoteEndpoint =
  | { transport: 'tailcat'; address: string; keyFile: string }
  | { transport: 'ssh'; host: string; port?: number; user?: string; identityFile?: string; command?: string; socketPath?: string; tailcat?: AgentMuxTailcatTarget }
export type AgentMuxRpcEndpoint =
  | { transport: 'relay'; offer: import('@agentmux/relay/offer').ConnectionOffer }
  | { transport: 'unix'; path: string }
  | { transport: 'http'; url: string; token?: string }
  | AgentMuxRpcRemoteEndpoint
export type AgentMuxRpcSessionTarget = AgentMuxAgentSessionLookup | { kind: 'self' }
export type AgentMuxRpcUnavailable = { code: string; message: string; recovery: string }
export type AgentMuxRpcGoalFilters = {
  goalId?: string; projectId?: string; agentSessionId?: string; assigneeSessionId?: string; supervisorSessionId?: string;
  status?: string; since?: number; limit?: number; all?: true
}
/** Route identity belongs to the selected service; native Session facts stay unchanged. */
export type AgentMuxRpcAgentObservation = import('./agent-discovery.js').AgentDiscoveryObservation
export type AgentMuxRpcAgentInspection = {
  routeHostId: string
  session: ReturnType<AgentMuxClient['agentSession']>
  status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null
  unavailable: AgentMuxRpcUnavailable[]
  displayName: { override: string | null; source: import('./display-label.js').AgentMuxDisplayLabelSource | null; nameRevision: number | null; availability: 'observed' | 'unavailable' }
}
export type AgentMuxRpcSnapshotParams = {
  projectId?: string; workspaceId?: string; topicId?: string; agentSessionId?: string;
  goalId?: string; executorId?: string; assigneeSessionId?: string; supervisorSessionId?: string; status?: string; since?: number; limit?: number;
  include?: Array<'projects' | 'workspaces' | 'topics' | 'motes' | 'spaces' | 'zones' |
    'executors' | 'agents' | 'sessions' | 'goals' | 'decisions' | 'activity'>
}
export type AgentMuxRpcSnapshot = {
  projects: import('./control.js').AgentMuxControlProject[]; workspaces: AgentMuxRpcWorkspace[]; topics: AgentMuxRpcTopic[]; motes: AgentMuxRpcTopic[];
  spaces: import('./space-control.js').AgentMuxSpaceFact[]; zones: import('./space-control.js').AgentMuxZoneFact[];
  executors: Extract<AgentMuxControlResult, { operation: 'list.agents' }>['agents'];
  agents: import('./control.js').AgentMuxControlActiveAgent[];
  sessions: AgentMuxRpcAgentObservation[]; goals: AgentMuxRpcGoal[];
  decisions: Array<{ goalId: string; decisions: import('@agentmux/demand').DemandDecision[] }>;
  activity: Array<import('./control.js').AgentMuxDemandActivity & { goalId: string }>;
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
type NativeParams = SpaceLinkParams & MeshNetworkParams & AgentPromotionParamsMap & NameControlParams & AgentOpenParams & import('./space-close.js').SpaceCloseParams & HostRouteParams & SpaceMemberParams & SpaceSessionsParams & SpaceFolderParams & SpaceAuthorityParams & NodeLocatorParamsMap & NodePublishingParams & MoteDialogueParamsMap & { 'capsule.input': import('./capsule-input.js').CapsuleInputRequest } & CapsuleRuntimeParamsMap & CapsuleParamsMap & ApplicationAccessParameterMap & AgentLearningParamsMap & MoteChatParamsMap & MoteConnectionParamsMap & ObjectAvatarParamsMap & GoalDelegationParamsMap & MoteAvatarParameterMap & TopicParameterMap & ConnectionParamsMap & TailcatConfigurationParamsMap & NotesStorageParamsMap & ProviderCatalogParamsMap & HostSettingsParameterMap & TailcatKeyParamsMap & HostMaintenanceParamsMap & FileParameterMap & GitParameterMap & AppWindowParamsMap & AppCaptureParamsMap & ScheduleParamsMap & AgentProgressParams & ImageParamsMap & NativeDesktopParamsMap & AgentMuxRpcDeviceParameterMap & AgentMuxHostedRuntimeParameterMap & {
  'system.metrics.host-profile.capture': import('./runtime-v8-profile.js').HostV8ProfileInput
  'goal.participation.confirm': import('./goal-participation.js').GoalParticipationConfirm
  'goal.watch': Record<string, never>
  'settings.appearance.watch': Record<string, never>
  'notebook.ls': Record<string, never>
  'notebook.inspect': { notebookId?: string; noteId?: string; operationId?: string; content?: boolean; maxBytes?: number }
  'notebook.scan': import('./note-corpus.js').NoteCorpusParams
  'notebook.graph': import('./notebook-observation.js').NotebookGraphParams
  'notebook.resolve': import('./note-links.js').NotebookResolveParams
  'notebook.apply': import('./notebook-catalog.js').NotebookWrite
  'space.state': Record<string, never>
  'space.commit': import('./spatial-state.js').AgentMuxSpatialCommit
  'space.resolve': import('./spatial-state.js').AgentMuxSpatialResolve
  'name.history': import('./display-label.js').AgentMuxNameHistoryQuery
  'name.confirm': { operationId: string }
  whoami: Record<string, never>
  'agent.ls': import('./agent-discovery.js').AgentDiscoveryFilters
  'agent.creation.continue': import('./agent-creation-continue.js').AgentMuxCreationContinueParams
  'agent.inspect': { target: AgentMuxRpcSessionTarget }
  'agent.execution.inspect': import('./agent-execution-journal.js').AgentExecutionOperationKey & { hostId: string }
  'agent.execution.admit': import('./agent-execution-coordinator.js').AgentExecutionOpenInput
  'agent.execution.create': import('./agent-execution-coordinator.js').AgentExecutionOpenInput
  'agent.execution.continue': import('./agent-execution-contract.js').AgentExecutionReference
  'agent.execution.binding': { bindingId: string; view?: 'association' }
  'agent.execution.watch': { bindingId: string }
  'agent.execution.rejoin': { bindingId: string }
  'agent.posture.inspect': import('./agent-posture.js').PostureInspect
  'agent.posture.set': import('./agent-posture.js').PostureSet
  'terminal.input': import('./terminal-control.js').TerminalInputIntent
  'terminal.interrupt': import('./terminal-control.js').TerminalControlIntent
  'terminal.stop': import('./terminal-control.js').TerminalControlIntent
  'terminal.operation.inspect': import('./terminal-control.js').TerminalControlInspect
  'terminal.creation.retire': import('./terminal-creation.js').TerminalCreationRetire
  'terminal.creation.inspect': import('./terminal-creation.js').TerminalCreationInspect
  'terminal.ls': import('./terminal-observation.js').TerminalListParams
  'terminal.inspect': { target: import('./terminal-observation.js').TerminalTarget }
  'terminal.output': import('./terminal-observation.js').TerminalOutputParams
  'terminal.recover': import('./terminal-recovery.js').AgentMuxTerminalRecoveryInput & { hostId: string }
  'skill.ls': { hostId: string; agentSessionId: string }
  'agent.continuity.control': import('./agent-session-recovery/control-contract.js').AgentMuxContinuityControlInput
  'agent.restart': import('./agent-session-recovery/restart-contract.js').AgentMuxAgentRestartIdentity
  'agent.restart.inspect': import('./agent-session-recovery/restart-contract.js').AgentMuxAgentRestartIdentity
  'agent.stop.inspect': import('./agent-stop-receipt.js').AgentMuxAgentStopIdentity
  'agent.refresh': { agentSessionId: string }
  'agent.native.confirm': import('./types.js').AgentMuxNativeSessionConfirmationInput
  'agent.native.ls': { hostId: string; executorId: string; workspacePath?: string }
  'agent.native.history': import('./public-rpc-native-history.js').AgentMuxRpcNativeHistoryParams
  'agent.native.history.resource': import('./public-rpc-native-history.js').AgentMuxRpcNativeHistoryResourceParams
  'agent.context': import('./agent-context.js').AgentContextParams
  'agent.interaction.respond': Omit<import("./client-contract.js").AgentMuxAgentInteractionInput,'authorHuman'>
  'agent.interaction.inspect': { agentSessionId: string; operationId: string }
  'agent.question.reply': Omit<import("./client-contract.js").AgentMuxSessionQuestionReplyInput, 'authorHuman' | 'sourceDevice' | 'signal' | 'commandOverride' | 'args' | 'env'>
  'agent.history.usage': import('./agent-session-usage.js').AgentSessionUsageInput
  'agent.history.record.inspect': import('./agent-session-record.js').AgentSessionRecordInput
  'agent.history.record.delete': import('./agent-session-record.js').AgentSessionRecordDeleteInput
  'agent.history.resource': import('./session-history-resource.js').AgentSessionHistoryResourceParams
  'agent.conversation.record': import('./external-conversation.js').AgentExternalConversationReference & { hostId: string }
  'agent.conversation.snapshot.ls': import('./conversation-snapshot.js').ConversationSnapshotInput
  'agent.conversation.snapshot.release': import('./conversation-snapshot.js').ConversationSnapshotReleaseInput
  'agent.conversation.checkpoint': import('./conversation-changes.js').ConversationCheckpointInput
  'agent.conversation.release': import('./conversation-changes.js').ConversationViewReleaseInput
  'agent.conversation.changes': import('./conversation-changes.js').ConversationChangesInput
  'agent.conversation.watch': import('./conversation-changes.js').ConversationWatchInput
  'agent.conversation.inspect': import('./conversation-changes.js').ConversationTimelineReadInput
  'agent.conversation.landmark.ls': import('./conversation-landmarks.js').ConversationLandmarkQuery
  'agent.conversation.landmark.apply': import('./conversation-landmarks.js').ConversationLandmarkWrite
  'agent.history': import('./session-history-reader.js').AgentSessionHistoryReadInput
  'agent.reopen': Parameters<AgentMuxClient['reopenAgent']>[0]
  'agent.reopen.check': Parameters<AgentMuxClient['reconcileAgentReopen']>[0]
  'agent.role.ls': { workspacePath?: string }
  'agent.role.register': { role: string; providerId?: string }
  'agent.role.resolve': { role: string; workspacePath?: string }
  'agent.input.changes': import('./agent-input-changes.js').AgentInputChangesRead & { hostId: string }
  'agent.input.ls': import('./agent-input-mailbox.js').AgentInputMailboxRead & { hostId: string }
  'agent.input.submit': import('./agent-input-submit.js').AgentInputSubmit
  'agent.automation.pause': import('./agent-automation.js').AgentAutomationPause
  'agent.automation.inspect': import('./agent-automation.js').AgentAutomationTarget
  'browser.input.inspect': import('./agent-input-context-capture.js').AgentInputContextCaptureReference
  'agent.input.resource': import('./agent-input-resource.js').AgentInputResourceRead
  'agent.input.inspect': import('./agent-input-wait.js').AgentInputSelector & { activity?: true }
  'agent.input.observation': {agentSessionId:string;observationId:string}
  'agent.input.stop': { ref: import('./agent-input-wait.js').AgentInputWaitRef; cancelOperationId: string }
  'agent.input.rejoin': { ref: import('./agent-input-wait.js').AgentInputWaitRef }
  'agent.send': { target: AgentMuxMessageTarget; text: string; operationId: string;
    application?: import('./agent-message-envelope.js').AgentMuxMessageApplication;
    admissionIntent?: Extract<import('./agent-prompt-condition.js').AgentPromptAdmissionIntent, { kind: 'session-conversation' | 'native-conversation' }>;
    execution?: AgentPromptExecution; expectedRun?: import('./types.js').AgentMuxRunRef; sourceChannel?: import('./types.js').AgentMessageChannel;
    messageId?: string; threadId?: string; correlationId?: string; replyTo?: string }
  'agent.broadcast': import('./agent-message-broadcast.js').AgentMuxMessageBroadcastInput
  'agent.broadcast.inspect': { operationId: string; hostId?: string }
  'agent.discuss': { executorId: string; providerId?: string; text: string; operationId: string }
  'agent.spawn.ls': import('./agent-spawn-query.js').AgentMuxSpawnQuery & { hostId: string }
  'agent.handoff': { toAgentSessionId: string; taskId: string }
  'agent.output': { agentSessionId: string; afterByte?: number; follow?: boolean }
  'app.mobile.assets.inspect': import('./mobile-web.js').MobileAssetsInspectParams
  'app.mobile.assets.activate': import('./mobile-web.js').MobileAssetsActivateParams
  'app.mobile.assets.loaded': import('./mobile-web.js').MobileAssetsLoadedParams
  'app.mobile.report': import('./mobile-web.js').MobileWebReportParams
  'system.diagnostics.inspect': import('./diagnostic-evidence.js').AgentMuxDiagnosticEvidenceInspectParams
  'message.delivery.inspect': { logId: string; hostId?: string }
  'message.delivery.report': { hostId: string; record: import('./delivery-attempt.js').DeliveryAttempt }
  'message.inbox.check': { limit: number }
  'message.inbox.ack': { generation: number; readerRun: import('./types.js').AgentMuxRunRef }
  'message.notify': { operationId: string; messageIds: readonly string[]; hostId: string }
  'message.notify.inspect': { operationId: string; hostId: string }
  'message.read': import('./agent-message-query.js').AgentMuxMessageReadRequest & { hostId?: string }
  'message.events': Omit<import('./agent-message-events.js').AgentMuxMessageEventsQuery, 'participantSessionId'> & { hostId?: string; participantSessionId?: string }
  'message.ls': Omit<import('./agent-message-query.js').AgentMuxMessageQuery, 'participantSessionId'> & { hostId?: string; participantSessionId?: string }
  'message.federation.dispatch-intake': { event: import('./agent-message-federation.js').AgentMuxSignedDispatchEvent }
  'message.federation.intake': { packet: import('./agent-message-federation.js').AgentMuxSignedMessage }
  'message.federation.export': { authority: import('./agent-message-federation.js').AgentMuxMessageReadAuthority }
  'message.dispatch.sync': { sourceMessageId: string; hostId: string }
  'message.dispatch.open': { sourceMessageId: string }
  'message.dispatch.inspect': { sourceMessageId: string }
  'message.dispatch.read': { sourceMessageId: string; hostId?: string }
  'message.dispatch.ls': { hostId?: string; participantSessionId?: string; afterSourceMessageId?: string; limit?: number }
  'message.dispatch.report': { sourceMessageId: string; replyMessageId: string; kind: import('./agent-handoff.js').DispatchEventKind }
  'app.search': import('./search-contract.js').AgentMuxSearchInput
  'app.snapshot': AgentMuxRpcSnapshotParams
  'goal.activity.history': import('./goal-activity-history.js').GoalActivityHistoryParams
  'goal.activity': Omit<AgentMuxRpcGoalFilters, 'all'>
  'system.storage': { hostId: string; runId: string }
  'system.doctor': { workspacePath?: string }
  'system.endpoint': Record<string, never>
  'system.relay.inspect': Record<string, never>
  'system.subscription.cancel': { subscriptionId: string }
}
type NativeResult = SpaceLinkResult & MeshNetworkResults & AgentPromotionResultMap & NameControlResults & AgentOpenResults & import('./space-close.js').SpaceCloseResults & HostRouteResults & SpaceMemberResults & SpaceSessionsResults & SpaceFolderResults & SpaceAuthorityResults & NodeLocatorResultMap & NodePublishingResults & MoteDialogueResultMap & { 'capsule.input': import('./capsule-input.js').CapsuleInputResult } & CapsuleRuntimeResultMap & CapsuleResultMap & ApplicationAccessResultMap & AgentLearningResultMap & MoteChatResultMap & MoteConnectionResultMap & ObjectAvatarResultMap & GoalDelegationResultMap & MoteAvatarResultMap & TopicResultMap & ConnectionResultMap & TailcatConfigurationResultMap & NotesStorageResultMap & ProviderCatalogResultMap & HostSettingsResultMap & TailcatKeyResultMap & HostMaintenanceResultMap & FileResultMap & GitResultMap & AppWindowResultMap & AppCaptureResultMap & ScheduleResultMap & AgentProgressResults & ImageResultMap & NativeDesktopResultMap & AgentMuxRpcDeviceResultMap & AgentMuxHostedRuntimeResultMap & {
  'system.metrics.host-profile.capture': import('./runtime-v8-profile.js').RuntimeV8ProfileResult
  'goal.participation.confirm': import('./goal-participation.js').GoalParticipationReceipt
  'goal.watch': never
  'settings.appearance.watch': never
  'notebook.ls': { state: import('./notebook-catalog.js').NotebookState }
  'notebook.inspect': { state: import('./notebook-catalog.js').NotebookState; notebook: import('./notebook-catalog.js').Notebook | null; pages: import('./notebook-catalog.js').NotebookPage[]; trail: import('./notebook-catalog.js').NoteTrailEvent[]; recordedOperation: import('./notebook-catalog.js').NotebookState['operations'][string] | null; storageOperation?: import('./public-rpc-notes-storage.js').NotesStorageOperationInspection | null; resourceChanges?: import('./notes-storage.js').NotesResourceChange[]; conversionIssues?: import('./notes-storage.js').NotesConversionIssue[]; titleOperation?: import('./note-title.js').NoteTitleInspection; content?: import('./notebook-observation.js').NoteContentObservation }
  'notebook.scan': import('./note-corpus.js').NoteCorpusResult
  'notebook.graph': import('./notebook-observation.js').NotebookGraph
  'notebook.resolve': import('./note-links.js').NotebookResolveResult
  'notebook.apply': { state: import('./notebook-catalog.js').NotebookState }
  'space.state': { state: import('./spatial-state.js').AgentMuxSpatialState | null }
  'space.commit': { state: import('./spatial-state.js').AgentMuxSpatialState }
  'space.resolve': ReturnType<typeof import('./spatial-state.js').resolveSpatialRegion>
  'name.history': import('./display-label.js').AgentMuxNameHistoryPage
  'name.confirm': { state: import('./spatial-state.js').AgentMuxSpatialState }
  whoami: { session: ReturnType<AgentMuxClient['agentSession']>; status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null;
    view: import('./agent-self-context.js').SelfViewOutcome; unavailable: AgentMuxRpcUnavailable[] }
  'agent.ls': import('./agent-discovery.js').AgentDiscoveryPage
  'agent.creation.continue': import('./agent-creation-continue.js').AgentMuxCreationContinueResult
  'agent.inspect': AgentMuxRpcAgentInspection
  'agent.execution.inspect': import('./agent-execution-journal.js').AgentExecutionOperation | null
  'agent.execution.admit': import('./agent-execution-contract.js').AgentExecutionReference
  'agent.execution.create': { session: import('./types.js').AgentMuxAgentSession; execution: import('./agent-execution-coordinator.js').AgentExecutionInspection }
  'agent.execution.continue': AgentMuxRpcResult<'agent.execution.create'>
  'agent.execution.binding': import('./agent-execution-coordinator.js').AgentExecutionInspection | null
  'agent.execution.watch': import('./agent-execution-coordinator.js').AgentExecutionBindingObservation
  'agent.execution.rejoin': import('./agent-execution-coordinator.js').AgentExecutionInspection
  'agent.posture.inspect': import('./agent-posture.js').PostureInspection
  'agent.posture.set': import('./agent-posture.js').PostureReceipt
  'terminal.input': import('./terminal-control.js').TerminalControlReceipt
  'terminal.interrupt': import('./terminal-control.js').TerminalControlReceipt
  'terminal.stop': import('./terminal-control.js').TerminalControlReceipt
  'terminal.operation.inspect': { hostId: string; run: { runId: string }; operationId: string; operation: import('./terminal-control.js').TerminalControlReceipt | null }
  'terminal.creation.retire': import('./terminal-creation.js').TerminalCreationInspection
  'terminal.creation.inspect': import('./terminal-creation.js').TerminalCreationInspection
  'terminal.ls': import('./terminal-observation.js').TerminalListResult
  'terminal.inspect': import('./terminal-observation.js').TerminalInspectResult
  'terminal.output': import('./terminal-observation.js').TerminalOutputInitial
  'terminal.recover': import('./terminal-recovery.js').AgentMuxTerminalRecoveryResult
  'skill.ls': { hostId: string; sourceHostId: string; agentSessionId: string; providerId: string; workspacePath: string; skills: import('./agent-skills.js').AgentSkill[] }
  'agent.continuity.control': import('./agent-session-recovery/control-contract.js').AgentMuxContinuityControlResult
  'agent.restart': { session: Awaited<ReturnType<AgentMuxClient['restartAgent']>> }
  'agent.restart.inspect': Awaited<ReturnType<AgentMuxClient['inspectAgentRestart']>>
  'agent.stop.inspect': Awaited<ReturnType<AgentMuxClient['inspectAgentStop']>>
  'agent.refresh': { session: ReturnType<AgentMuxClient['agentSession']> }
  'agent.native.confirm': import('./types.js').AgentMuxNativeSessionConfirmation
  'agent.native.ls': import('./types.js').AgentNativeSessionCatalog & { hostId: string; executorId: string }
  'agent.native.history': import('./public-rpc-native-history.js').AgentMuxRpcNativeHistoryResult
  'agent.native.history.resource': import('./public-rpc-native-history.js').AgentMuxRpcNativeHistoryResourceResult
  'agent.context': import('./agent-context.js').AgentContextPage
  'agent.interaction.respond': import('./types.js').AgentMuxInteractionOperationReceipt
  'agent.interaction.inspect': { receipt: import('./types.js').AgentMuxInteractionOperationReceipt | null }
  'agent.question.reply': import('./types.js').AgentSessionQuestionReplyReceipt
  'agent.history.usage': import('./agent-session-usage.js').AgentSessionUsagePage
  'agent.history.record.inspect': import('./agent-session-record.js').AgentSessionRecordInspection
  'agent.history.record.delete': import('./agent-session-record.js').AgentSessionRecordDeletionReceipt
  'agent.history.resource': import('./session-history-resource.js').AgentSessionHistoryResourceResult
  'agent.conversation.record': import('./external-conversation.js').AgentExternalConversationReceipt
  'agent.conversation.snapshot.ls': import('./conversation-snapshot.js').ConversationSnapshotPage
  'agent.conversation.snapshot.release': import('./conversation-snapshot.js').ConversationSnapshotReleaseResult
  'agent.conversation.checkpoint': import('./conversation-changes.js').ConversationCheckpointPage
  'agent.conversation.release': import('./conversation-changes.js').ConversationViewReleaseResult
  'agent.conversation.changes': import('./conversation-changes.js').ConversationChangesPage
  'agent.conversation.watch': import('./conversation-changes.js').ConversationWatchOpening
  'agent.conversation.inspect': import('./conversation.js').AgentConversationReadPage
  'agent.conversation.landmark.ls': import('./conversation-landmarks.js').ConversationLandmarkPage
  'agent.conversation.landmark.apply': import('./conversation-landmarks.js').ConversationLandmarkPage
  'agent.history': import('./session-history-reader.js').AgentSessionHistoryReadPage
  'agent.reopen': { session: Awaited<ReturnType<AgentMuxClient['reopenAgent']>> }
  'agent.reopen.check': { session: Awaited<ReturnType<AgentMuxClient['reconcileAgentReopen']>> }
  'agent.role.ls': { bindings: AgentRoleBinding[] }
  'agent.role.register': { binding: AgentRoleBinding }
  'agent.role.resolve': { binding: AgentRoleBinding }
  'agent.input.changes': import('./agent-input-changes.js').AgentInputChangesPage & { hostId: string }
  'agent.input.ls': import('./agent-input-mailbox.js').AgentInputMailboxPage & { hostId: string }
  'agent.input.submit': import('./agent-input-submit.js').AgentInputSubmitResult
  'agent.automation.pause': import('./agent-automation.js').AgentAutomationPauseInspection
  'agent.automation.inspect': import('./agent-automation.js').AgentAutomationPauseInspection
  'browser.input.inspect': import('./agent-input-context-capture.js').AgentInputContextCaptureRead
  'agent.input.resource': import('./agent-input-resource.js').AgentInputResourceResult
  'agent.input.inspect': { activity?: import('./types.js').AgentInputActivity; sourceNow?:number; moteObservationId?:string; record: Awaited<ReturnType<AgentMuxClient['inspectAgentPromptSubmission']>>; input?: import('./agent-input-wait.js').AgentInputSubmissionReceipt | null }
  'agent.input.observation': {inspection:import('./mote-input.js').MoteInputInspection|null}
  'agent.input.stop': import('./agent-input-wait.js').AgentInputWaitStopReceipt
  'agent.input.rejoin': import('./agent-input-wait.js').AgentInputSubmissionReceipt
  'agent.send': AgentMuxMessageReceipt & { agentSessionId?: string; inputReceipt?: import('./agent-input-wait.js').AgentInputSubmissionReceipt }
  'agent.broadcast': import('./agent-message-broadcast.js').AgentMuxMessageBroadcastReceipt
  'agent.broadcast.inspect': { hostId: string; broadcast: import('./agent-message-broadcast.js').AgentMuxMessageBroadcastReceipt | null }
  'agent.discuss': { threadId: string; delivery: string; targetAgentSessionId: string; creation: import('./types.js').AgentMuxAgentCreationFact }
  'agent.spawn.ls': import('./agent-spawn-query.js').AgentMuxSpawnPage & { hostId: string }
  'agent.handoff': ReturnType<AgentMuxClient['handOff']>
  'agent.output': AgentMuxRpcOutputInitial & { replay: AgentMuxRpcOutputBytes[] }
  'app.mobile.assets.inspect': import('./mobile-web.js').MobileAssetsInspection
  'app.mobile.assets.activate': import('./mobile-web.js').MobileAssetsActivationReceipt
  'app.mobile.assets.loaded': import('./mobile-web.js').MobileAssetsLoadedReceipt
  'app.mobile.report': import('./mobile-web.js').MobileWebReportReceipt
  'system.diagnostics.inspect': import('./diagnostic-evidence.js').AgentMuxDiagnosticEvidenceResult
  'message.delivery.inspect': import('./delivery-attempt.js').DeliveryAttemptLookup
  'message.delivery.report': import('./delivery-attempt.js').DeliveryAttemptLookup
  'message.inbox.check': Awaited<ReturnType<AgentMuxClient['checkDeliveries']>>
  'message.inbox.ack': Awaited<ReturnType<AgentMuxClient['ackDeliveryBatch']>>
  'message.notify': Awaited<ReturnType<AgentMuxClient['notifyMessages']>> & { hostId: string }
  'message.notify.inspect': Awaited<ReturnType<AgentMuxClient['inspectMessageNotification']>> & { hostId: string }
  'message.read': { hostId: string; message: import('./agent-message-query.js').AgentMuxMessageReadView | null; field?: never } |
    { hostId: string; message: null; field: import('./agent-message-query.js').AgentMuxMessageFieldPage | null }
  'message.ls': import('./agent-message-query.js').AgentMuxMessagePage & { hostId: string }
  'message.events': import('./agent-message-events.js').AgentMuxMessageEventsPage & { hostId: string }
  'message.federation.dispatch-intake': import('./agent-message-federation.js').AgentMuxDispatchEventSubmission
  'message.federation.intake': AgentMuxMessageReceipt
  'message.federation.export': import('./agent-message-federation.js').AgentMuxFederatedThread
  'message.dispatch.sync': import('./agent-handoff.js').DispatchObservation & { hostId: string }
  'message.dispatch.open': Awaited<ReturnType<AgentMuxClient['openDispatch']>>
  'message.dispatch.inspect': Awaited<ReturnType<AgentMuxClient['showDispatch']>>
  'message.dispatch.read': Awaited<ReturnType<AgentMuxClient['readDispatch']>> & { hostId: string }
  'message.dispatch.ls': Awaited<ReturnType<AgentMuxClient['listDispatches']>> & { hostId: string }
  'message.dispatch.report': Awaited<ReturnType<AgentMuxClient['recordDispatchEvent']>> | import('./agent-message-federation.js').AgentMuxDispatchEventSubmission
  'app.search': import('./search-contract.js').AgentMuxSearchPage
  'app.snapshot': AgentMuxRpcSnapshot
  'goal.activity.history': import('./goal-activity-history.js').GoalActivityHistory
  'goal.activity': { activity: Array<import('./control.js').AgentMuxDemandActivity & { goalId: string }>; diskDurability: 'confirmed'; coverage: { scope: 'matching-goals'; observation: 'selected-goals-then-confirmed-activity'; order: 'goal-order-then-append'; matchedGoalCount: number; totalActivityCount: number; returnedActivityCount: number; limit: number; truncated: boolean } }
  'system.storage': import('./run-storage-observation.js').AgentMuxRunStorageObservation
  'system.doctor': AgentMuxDoctorReport
  'system.endpoint': { protocol: 'jsonrpc-2.0'; framing: 'json-lines'; endpoint: AgentMuxRpcEndpoint; connection: 'responded'; publication: import('./control-endpoint-state.js').AgentMuxControlEndpointState | null; methods?: AgentMuxRpcMethod[] }
  'system.relay.inspect': import('./public-rpc-relay-gateway.js').AgentMuxRelayInspection
  'system.subscription.cancel': { disposed: boolean }
}
export type AgentMuxRpcMethod = ControlMethod | keyof NativeParams
type PublicParameterMap = MeshNetworkParams & AgentPromotionParamsMap & NodeLocatorParamsMap & NodePublishingParams & ApplicationAccessParameterMap & AgentLearningParamsMap & MoteChatParamsMap & MoteConnectionParamsMap & MoteAvatarParameterMap & TopicParameterMap & ConnectionParamsMap & ObjectAvatarParamsMap & TailcatConfigurationParamsMap & NotesStorageParamsMap & ProviderCatalogParamsMap & HostSettingsParameterMap & TailcatKeyParamsMap & HostMaintenanceParamsMap & FileParameterMap & GitParameterMap & ScheduleParamsMap & AgentProgressParams & ImageParamsMap & NativeDesktopParamsMap & AgentMuxHostedRuntimeParameterMap & AgentMuxRpcDeviceParameterMap & {
  [M in Exclude<keyof NativeParams, keyof AgentMuxHostedRuntimeParameterMap | AgentPromotionMethod | MeshNetworkMethod | AgentMuxRpcDeviceMethod | ApplicationAccessMethod | AgentLearningMethod | MoteChatMethod | MoteConnectionMethod | MoteAvatarMethod | TopicMethod | ConnectionMethod | ObjectAvatarMethod | TailcatConfigurationMethod | NotesStorageMethod | ProviderCatalogMethod | HostSettingsMethod | NodePublishingMethod | NodeLocatorMethod | TailcatKeyMethod | HostMaintenanceMethod | FileMethod | GitMethod | ScheduleMethod | ImageMethod | NativeDesktopMethod>]: NativeParams[M] & { operationId?: string }
} & { [M in ControlMethod]: ControlParams<M> & { operationId?: string } }
export type AgentMuxRpcParams<M extends AgentMuxRpcMethod> = PublicParameterMap[M]
type PublicResultMap = NativeResult & {
  [M in ControlMethod]: M extends 'space.inspect' | 'space.ls' ? OperationKeys<BusinessResult<M>> & { presentation?: AgentMuxRpcSpacePresentation }
    : OperationKeys<GoalKeys<BusinessResult<M>>>
}
export type AgentMuxRpcResult<M extends AgentMuxRpcMethod> = PublicResultMap[M]
export type AgentMuxRpcSpacePresentation = {
  region: import('./control.js').AgentMuxInspectedRegion | null;
  tab: import('./control.js').AgentMuxInspectedTab | null;
  unavailable: AgentMuxRpcUnavailable[]
}

export const AGENTMUX_RPC_NATIVE_METHODS = {
  ...AGENT_PROMOTION_METHODS,
  ...HOST_ROUTE_METHODS,
  ...MOTE_DIALOGUE_METHODS,
  'system.metrics.host-profile.capture': 'long',
  ...SPACE_CLOSE_METHODS,
  ...AGENTMUX_RPC_DESKTOP_NATIVE_METHODS,
  ...AGENTMUX_RPC_IMAGE_METHODS,
  ...AGENT_LEARNING_METHODS,
  ...CAPSULE_METHODS,
  ...CAPSULE_RUNTIME_METHODS,
  'capsule.input': 'long',
  ...MOTE_CHAT_RPC_METHODS,
  ...MOTE_CONNECTION_RPC_METHODS,
  ...GOAL_DELEGATION_METHODS,
  ...AGENTMUX_RPC_MOTE_AVATAR_METHODS,
  ...AGENTMUX_RPC_MOTE_AVATAR_WRITE_METHODS,
  ...AGENTMUX_RPC_TOPIC_METHODS,
  ...AGENTMUX_RPC_FILE_METHODS,
  ...AGENTMUX_RPC_GIT_METHODS,
  ...AGENTMUX_RPC_WINDOW_METHODS,
  ...APP_CAPTURE_METHODS,
  ...AGENTMUX_RPC_SCHEDULE_METHODS,
  ...AGENT_PROGRESS_METHODS,
  ...CONNECTION_RPC_METHODS,
  ...AGENTMUX_RPC_DEVICE_METHODS,
  ...NODE_PUBLISHING_METHODS,
  ...MESH_NETWORK_METHODS,
  ...NODE_LOCATOR_METHODS,
  ...OBJECT_AVATAR_METHODS,
  ...TAILCAT_CONFIGURATION_METHODS,
  ...NOTES_STORAGE_METHODS,
  ...PROVIDER_CATALOG_METHODS,
  ...AGENTMUX_RPC_HOST_SETTINGS_METHODS,
  ...AGENTMUX_RPC_TAILCAT_KEY_METHODS,
  ...AGENTMUX_RPC_HOST_MAINTENANCE_METHODS,
  ...APPLICATION_ACCESS_METHODS,
  ...AGENTMUX_HOSTED_RPC_METHODS,
  'goal.participation.confirm': 'short',
  'goal.watch': 'long',
  'settings.appearance.watch': 'long',
  'notebook.scan': 'long', 'notebook.ls': 'short', 'notebook.inspect': 'long', 'notebook.graph': 'long', 'notebook.resolve': 'long', 'notebook.apply': 'long',
  ...SPACE_LINK_METHODS, ...NAME_CONTROL_METHODS, ...SPACE_MEMBER_METHODS, ...SPACE_SESSION_METHODS, ...SPACE_FOLDER_METHODS, ...SPACE_AUTHORITY_METHODS, ...AGENT_OPEN_METHODS,
  'space.state': 'short', 'space.commit': 'long', 'space.resolve': 'short', 'name.history': 'short', 'name.confirm': 'long',
  'agent.conversation.landmark.ls': 'short', 'agent.conversation.landmark.apply': 'long',
  'agent.conversation.snapshot.ls': 'long', 'agent.conversation.snapshot.release': 'short', whoami: 'short', 'skill.ls': 'long', 'agent.ls': 'short', 'agent.inspect': 'short', 'agent.creation.continue': 'short', 'agent.execution.inspect': 'short', 'agent.execution.admit': 'long', 'agent.execution.create': 'long', 'agent.execution.continue': 'long', 'agent.execution.binding': 'short', 'agent.execution.watch': 'short', 'agent.execution.rejoin': 'long', 'agent.restart': 'long', 'agent.restart.inspect': 'short', 'agent.stop.inspect': 'short', 'agent.refresh': 'short', 'agent.continuity.control': 'short', 'agent.native.confirm': 'long', 'agent.native.ls': 'long', 'agent.native.history': 'long', 'agent.native.history.resource': 'long', 'agent.context': 'long', 'agent.history': 'long', 'agent.conversation.record': 'long', 'agent.conversation.release': 'short', 'agent.conversation.inspect': 'long', 'agent.conversation.checkpoint': 'long', 'agent.conversation.changes': 'long', 'agent.conversation.watch': 'long', 'agent.history.usage': 'long', 'agent.history.record.inspect': 'long', 'agent.history.record.delete': 'long', 'agent.history.resource': 'long', 'agent.interaction.respond': 'long', 'agent.interaction.inspect': 'short', 'agent.question.reply': 'long', 'agent.reopen': 'long', 'agent.reopen.check': 'long',
  'agent.role.ls': 'short', 'agent.role.register': 'long', 'agent.role.resolve': 'short', 'agent.spawn.ls': 'short',
  'agent.automation.pause': 'short', 'agent.automation.inspect': 'short',
  'agent.input.observation': 'short',
  'agent.input.changes': 'short', 'agent.input.ls': 'short', 'agent.input.submit': 'long', 'agent.input.inspect': 'short', 'agent.input.resource': 'long', 'agent.input.stop': 'short', 'agent.input.rejoin': 'long', 'agent.send': 'long', 'agent.broadcast': 'long', 'agent.broadcast.inspect': 'short', 'agent.discuss': 'long', 'agent.handoff': 'short',
  'browser.input.inspect': 'long',
  'app.mobile.assets.inspect': 'short',
  'app.mobile.assets.activate': 'long',
  'app.mobile.assets.loaded': 'short',
  'app.mobile.report': 'short',
  'system.diagnostics.inspect': 'short',
  'message.delivery.inspect': 'short', 'message.delivery.report': 'long',
  'agent.output': 'long', 'message.inbox.check': 'long', 'message.inbox.ack': 'long',
  'message.federation.dispatch-intake': 'long', 'message.federation.intake': 'long', 'message.federation.export': 'long', 'message.dispatch.sync': 'long', 'message.dispatch.open': 'long', 'message.dispatch.inspect': 'short', 'message.dispatch.report': 'long',
  'message.notify': 'long', 'message.notify.inspect': 'short', 'message.read': 'short', 'message.ls': 'short', 'message.events': 'short', 'message.dispatch.read': 'short', 'message.dispatch.ls': 'short',
  'app.search': 'long', 'app.snapshot': 'long', 'goal.activity': 'short', 'goal.activity.history': 'short', 'system.doctor': 'long', 'system.storage': 'short',
  'system.endpoint': 'short', 'system.relay.inspect': 'short', 'system.subscription.cancel': 'short', 'terminal.recover': 'long', 'agent.posture.inspect': 'short', 'agent.posture.set': 'long', 'terminal.input': 'long', 'terminal.interrupt': 'long', 'terminal.stop': 'long', 'terminal.operation.inspect': 'short', 'terminal.creation.retire': 'long', 'terminal.creation.inspect': 'short', 'terminal.ls': 'short', 'terminal.inspect': 'short', 'terminal.output': 'long'
} as const satisfies Record<keyof NativeParams, 'short' | 'long'>

export type AgentMuxRpcStreamMethod = 'file.mutation.watch' | 'space.member.watch' | import('./host-route.js').HostRouteStreamMethod | 'space.sessions.watch' | 'space.snapshot' | 'space.watch' | 'goal.watch' | 'agent.conversation.watch' | 'agent.output' | 'terminal.output' | 'browser.follow' | 'toolkit.watch' | 'system.metrics.watch' | 'settings.appearance.watch' | 'connection.metadata.watch' |
  'agent.execution.watch' | AgentMuxHostedStreamMethod
export type AgentMuxRpcStreamParams<M extends AgentMuxRpcStreamMethod> = AgentMuxRpcParams<M> &
  (M extends 'agent.output' ? { follow?: boolean } : Record<never, never>)
type AgentMuxRpcStreamInitialMap = AgentMuxHostedStreamInitialMap & {
  'agent.execution.watch': import('./agent-execution-coordinator.js').AgentExecutionBindingObservation
  'file.mutation.watch': import('./public-rpc-file-mutations.js').FileMutationWatchOpening
  'space.member.watch': import('./space-member.js').SpaceMemberResults['space.member.watch']
  'route.watch': import('./host-route.js').HostRouteStreamInitial
  'route.receive-watch': import('./host-route.js').HostRouteStreamInitial
  'agent.conversation.watch': import('./conversation-changes.js').ConversationWatchOpening
  'agent.output': AgentMuxRpcOutputInitial
  'terminal.output': import('./terminal-observation.js').TerminalOutputInitial
  'browser.follow': { runOperation: import('./control.js').AgentMuxControlBrowserOperation | null;
    gap: { droppedThrough: number } | null }
  'toolkit.watch': { toolId: string }
  'space.snapshot': import('./space-authority-stream.js').SpaceStreamOpening
  'space.watch': import('./space-authority-stream.js').SpaceStreamOpening
  'space.sessions.watch': import('./space-session-codec.js').SpaceSessionsStreamOpening
  'goal.watch': import('./goal-changes.js').GoalChanges
  'connection.metadata.watch': Record<string, never>
  'settings.appearance.watch': { observation: import('./public-rpc-settings-observation.js').AgentMuxAppearanceObservation }
  'system.metrics.watch': { observation: import('./metrics.js').MetricsObservation }
}
export type AgentMuxRpcStreamInitial<M extends AgentMuxRpcStreamMethod> = AgentMuxRpcStreamInitialMap[M]
export type AgentMuxRpcStreamEvent<M extends AgentMuxRpcStreamMethod> =
  | { type: 'end'; data: unknown }
  | { type: 'error'; error: { code: string; message: string; detail?: string; details?: unknown; candidates?: unknown; controlFailure?: import('./errors.js').AgentMuxControlFailure; logId?: string; creationFailure?: import('./errors.js').AgentMuxCreationFailure; storageFailure?: import('./errors.js').AgentMuxStorageFailure; executionFailure?: import('./agent-execution-contract.js').AgentExecutionFailure; evidence?: import('./types.js').AgentMuxEvidence } }
  | (M extends import('./host-route.js').HostRouteStreamMethod ? import('./host-route.js').HostRouteStreamEvent
    : M extends 'agent.execution.watch' ? { type: 'snapshot'; data: import('./agent-execution-coordinator.js').AgentExecutionBindingObservation }
    : M extends 'space.member.watch' ? Extract<AgentMuxHostedStreamEvent, { type: 'snapshot' }>
    : M extends AgentMuxHostedStreamMethod ? Extract<AgentMuxHostedStreamEvent, { type: 'snapshot' }>
    : M extends 'agent.conversation.watch' ? { type: 'snapshot'; data: import('./conversation-changes.js').ConversationObservation }
    : M extends 'space.snapshot' | 'space.watch' | 'space.sessions.watch' ? { type: 'snapshot'; data: import('./hosted-client-contract.js').AgentMuxHostedTransferChunk }
    : M extends 'file.mutation.watch' ? { type: 'effect'; data: import('./public-rpc-file-mutations.js').FileMutationEffect }
    : M extends 'goal.watch' ? { type: 'change'; data: import('./goal-changes.js').GoalChanges }
    : M extends 'connection.metadata.watch' ? { type: 'change'; data: import('./channel-metadata-contract.js').ChannelMetadataChange }
    : M extends 'agent.output' | 'terminal.output' ? { type: 'output'; data: AgentMuxRpcOutputBytes }
    : M extends 'browser.follow' ? { type: 'progress'; data: import('./control.js').AgentMuxControlBrowserEvent }
    : { type: 'snapshot'; data: M extends 'toolkit.watch' ? import('./toolkit.js').ToolkitSnapshot : M extends 'settings.appearance.watch' ? import('./public-rpc-settings-observation.js').AgentMuxAppearanceObservation : import('./metrics.js').MetricsObservation })

export function isAgentMuxRpcMethod(value: unknown): value is AgentMuxRpcMethod {
  return typeof value === 'string' && (Object.hasOwn(AGENTMUX_RPC_CONTROL_METHODS, value) ||
    Object.hasOwn(AGENTMUX_RPC_NATIVE_METHODS, value))
}
export function isAgentMuxRpcStream(method: AgentMuxRpcMethod, params: Record<string, unknown>): method is AgentMuxRpcStreamMethod {
  return method === 'agent.execution.watch' || method === 'file.mutation.watch' || method === 'space.member.watch' || method === 'route.watch' || method === 'route.receive-watch' || method === 'space.sessions.watch' || method === 'space.snapshot' || method === 'space.watch' || method === 'goal.watch' || method === 'connection.metadata.watch' || method === 'agent.conversation.watch' || method === 'browser.follow' || method === 'toolkit.watch' || method === 'system.metrics.watch' || method === 'settings.appearance.watch' ||
    method === 'agent.output' || method === 'terminal.output' || method === 'runtime.events' || method === 'runtime.conversation-watch' || method === 'runtime.history-watch' ||
    method === 'runtime.attachment-watch' || method === 'runtime.replay-watch'
}
