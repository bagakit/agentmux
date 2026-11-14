import type { SpaceAuthorityRef, SpaceSnapshot, SpaceApply, SpaceApplyReceipt, SpaceWatch } from '@agentmux/core'
import type { FolderSpaceRegistration, FolderSpaceReceipt } from '@agentmux/core/space-folder'
import type { WorkspaceLayout, WorkbenchViewLayout } from '@agentmux/layout'
import type { SpaceSessionsOpening, SpaceSessionsObservation } from '@agentmux/core/space-sessions'

/** Host ID is only this client's carrier. Every inner entity ID belongs to reference.runtimeId. */
export type SpaceMountSourceTarget = { hostId: string; expectedRuntimeId: string } | SpaceMountTarget
export type SpaceMountTarget = { hostId: string; reference: SpaceAuthorityRef }
export type SpaceMountRecord = SpaceMountTarget & { zoneId: string; workspaceId: string }
/** This client's presentation only; never included in source apply or local spatial commits. */
export type SpaceMountView = {
  composition: WorkspaceLayout
  tabLayouts: Record<string, WorkbenchViewLayout>
  selection: { tabId: string; regionId: string; groupId: string } | null
}
export type SpaceMountResources = {
  hostId: string; runtimeId: string; workspaces: import('@agentmux/core').AgentMuxRpcWorkspace[]
}
export type SpaceMountHostChoices = { runtimeId: string; hosts: Array<{ hostId: string; label: string; kind: 'local' | 'ssh'; runtimeId: string | null }> }
export type SpaceMountMethods = {
  resources: { input: { hostId: string }; result: SpaceMountResources }
  hostChoices: { input: SpaceMountSourceTarget; result: SpaceMountHostChoices }
  describe: { input: SpaceMountSourceTarget; result: import('@agentmux/core/agent-open-contract').AgentOpenDescription }
  routeChoices: { input: SpaceMountSourceTarget; result: import('@agentmux/core/host-route').HostRouteChoices }
  routeExecutors: { input: SpaceMountSourceTarget & { agentTarget: import('@agentmux/core/host-route').HostRouteAgentTarget; executorId?: string }; result: import('@agentmux/core/host-route').HostRouteExecutors }
  register: { input: { hostId: string; registration: FolderSpaceRegistration }; result: FolderSpaceReceipt }
  inspectRegistration: { input: { hostId: string; registration: FolderSpaceRegistration }; result: import('@agentmux/core/space-folder').FolderSpaceRegistrationInspection | null }
  snapshot: { input: SpaceMountTarget; result: SpaceSnapshot }
  apply: { input: SpaceMountTarget & { edit: SpaceApply }; result: SpaceApplyReceipt }
  executors: { input: SpaceMountSourceTarget & { agentHostId: string; executorId?: string }; result: import('@agentmux/core').AgentMuxRpcResult<'settings.executors.discover'> }
  open: { input: SpaceMountTarget & { request: import('@agentmux/core').AgentMuxRpcParams<'agent.open'> }; result: import('@agentmux/core').AgentMuxRpcResult<'agent.open'> }
  inspect: { input: SpaceMountTarget & { requestId: string }; result: import('@agentmux/core').AgentMuxRpcResult<'space.inspect'> }
}
export type SpaceMountWatch = SpaceMountTarget & { after?: SpaceWatch['after'] }
export type SpaceMountEvent = { type: 'snapshot'; snapshot: SpaceSnapshot } | { type: 'error'; error: { code: string; message: string } }
export type SpaceMountSessionsEvent = { type: 'observation'; observation: SpaceSessionsObservation } | { type: 'error'; error: { code: string; message: string } }
export type SpaceMountPort = {
  member(input: SpaceMountMemberTarget, listener: (event: SpaceMountMemberEvent) => void, signal?: AbortSignal): Promise<SpaceMountMemberSurface>
  call<M extends keyof SpaceMountMethods>(method: M, input: SpaceMountMethods[M]['input'], signal?: AbortSignal): Promise<SpaceMountMethods[M]['result']>
  watch(input: SpaceMountWatch, listener: (event: SpaceMountEvent) => void, signal?: AbortSignal): Promise<{ initial: SpaceSnapshot; dispose(): void }>
  sessions(input: SpaceMountTarget, listener: (event: SpaceMountSessionsEvent) => void, signal?: AbortSignal): Promise<{ initial: SpaceSessionsOpening; dispose(): void }>
}
export const SPACE_MOUNT_EVENT = 'spaceMounts:event'
export const SPACE_MOUNT_SESSIONS_EVENT = 'spaceMounts:sessionsEvent'
export type SpaceMountPreloadApi = {
  member(input: SpaceMountMemberTarget, listener: (event: SpaceMountMemberEvent) => void, context?: { onAbort?: (cancel: () => void) => () => void }): Promise<import('./contracts').SessionInputOperationResult<SpaceMountMemberSurface>>
  call<M extends keyof SpaceMountMethods>(method: M, input: SpaceMountMethods[M]['input'], context?: { onAbort?: (cancel: () => void) => () => void }): Promise<import('./contracts').SessionInputOperationResult<SpaceMountMethods[M]['result']>>
  watch(input: SpaceMountWatch, listener: (event: SpaceMountEvent) => void, context?: { onAbort?: (cancel: () => void) => () => void }): Promise<import('./contracts').SessionInputOperationResult<{ initial: SpaceSnapshot; dispose(): void }>>
  sessions(input: SpaceMountTarget, listener: (event: SpaceMountSessionsEvent) => void, context?: { onAbort?: (cancel: () => void) => () => void }): Promise<import('./contracts').SessionInputOperationResult<{ initial: SpaceSessionsOpening; dispose(): void }>>
}
/** A client key is scoped; raw entity IDs never become another Core's local identity. */
export const spaceMountKey = (reference: SpaceAuthorityRef) => JSON.stringify([reference.runtimeId, reference.spaceId])

/** One viewing surface; inner identities always remain at their original Core. */
export type SpaceMountMemberTarget = { hostId: string; target: import('@agentmux/core/space-member').SpaceMemberTarget }
export type SpaceMountMemberIdentity = { id: string; hostId: string }
export type SpaceMountMemberEvent =
  | { type: 'session'; session: import('./contracts').SessionSnapshot }
  | { type: 'runtime'; event: import('./contracts').RuntimeEvent }
  | { type: 'observation-error'; error: { code: string; message: string } }
  | { type: 'error'; error: { code: string; message: string } }
export type SpaceMountMemberMethods = {
  read: { input: Record<string, never>; result: import('./contracts').SessionSnapshot }
  attach: { input: { afterByte: number }; result: import('./contracts').SessionAttachResult }
  refreshAttachment: { input: { attachmentId: string | null; afterByte: number }; result: import('./contracts').SessionAttachResult }
  replay: { input: { attachmentId: string; afterByte: number }; result: import('./contracts').SessionReplayResult }
  detach: { input: { attachmentId: string }; result: void }
  resize: { input: { attachmentId: string; cols: number; rows: number }; result: { cols: number; rows: number } | null }
  write: { input: { data: import('@agentmux/core').AgentMuxRunInputData; source: import('@agentmux/core').AgentMuxAgentWriteInput['source']; observation?: import('@agentmux/core/control').InputObservationReference }; result: void }
  paste: { input: { text: string; terminalData: string; observation?: import('@agentmux/core/control').InputObservationReference }; result: void }
  submitPrompt: { input: { prompt: string; operationId: string; binding: import('@agentmux/core').AgentPromptInputBinding }; result: Awaited<ReturnType<import('@agentmux/core/space-member-client').SpaceMemberClient['submitAgentPrompt']>> }
  inspectInput: { input: { key: import('@agentmux/core').AgentPromptInputKey }; result: import('@agentmux/core').AgentInputSubmissionReceipt | null }
  inspectInteraction: { input: { operationId: string }; result: import('@agentmux/core').AgentMuxInteractionOperationReceipt | null }
}
export type SpaceMountMemberSurface = {
  initial: SpaceMountMemberIdentity
  call<M extends keyof SpaceMountMemberMethods>(method: M, input: SpaceMountMemberMethods[M]['input'], signal?: AbortSignal): Promise<SpaceMountMemberMethods[M]['result']>
  dispose(): void | Promise<void>
}
export const SPACE_MOUNT_MEMBER_EVENT = 'spaceMounts:memberEvent'
