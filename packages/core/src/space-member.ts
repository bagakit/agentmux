import type { AgentMuxHostedRuntimeParameterMap, AgentMuxHostedRuntimeResultMap, AgentMuxHostedStreamInitialMap } from './hosted-client-contract.js'
import { parseSpaceAuthorityRef, type SpaceAuthorityRef } from './space-reference.js'
import type { AgentMuxRunRef } from './types.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { AgentMuxError } from './errors.js'

export type SpaceMemberAdmission = { kind: 'creation' | 'association'; operationId: string }
/** A locator pin, never a grant or a replacement creation identity. */
export function parseSpaceMemberAdmission(value: unknown): SpaceMemberAdmission {
  const p = rpcRecord(value, ['kind', 'operationId'])
  if (p.kind !== 'creation' && p.kind !== 'association') throw new AgentMuxError('Select the original creation C or association L.', 'INVALID_CONTROL_REQUEST')
  return { kind: p.kind, operationId: rpcString(p.operationId, 'Original member admission operation') }
}

/** IDs belong to the original Space and execution Core, never to a viewing client. */
export type SpaceMemberIdentity = {
  reference: SpaceAuthorityRef
  regionId: string
  runtimeId: string
  agentSessionId: string
  expectedAdmission?: SpaceMemberAdmission
}
export function parseSpaceMemberIdentity(value: unknown): SpaceMemberIdentity {
  const p = rpcRecord(value, ['reference', 'regionId', 'runtimeId', 'agentSessionId', 'expectedAdmission'])
  return { reference: parseSpaceAuthorityRef(p.reference), regionId: rpcString(p.regionId, 'Original Region'),
    runtimeId: rpcString(p.runtimeId, 'Original execution Runtime'), agentSessionId: rpcString(p.agentSessionId, 'Original Agent Session'),
    ...(p.expectedAdmission === undefined ? {} : { expectedAdmission: parseSpaceMemberAdmission(p.expectedAdmission) }) }
}
export type SpaceMemberTarget = SpaceMemberIdentity & { expectedRun: AgentMuxRunRef }
export type PinnedSpaceMemberIdentity = SpaceMemberIdentity & { expectedAdmission: SpaceMemberAdmission }
/** Durable conversation access cannot grant Native observation, attachment or input. */
export type SpaceMemberReadingTarget = PinnedSpaceMemberIdentity & { kind: 'conversation' }
export type SpaceMemberRoute = SpaceMemberTarget | SpaceMemberReadingTarget
export const SPACE_MEMBER_INVOCATIONS = [
  'readAgentInputEpoch', 'readAgentSession', 'runtimeSubject', 'attachTerminal', 'refreshRunAttachment', 'readRunReplay',
  'releaseRunAttachment', 'resizeTerminal', 'writeAgent', 'pasteAgent', 'submitAgentPrompt',
  'statusAgent', 'inspectAgentInteractionOperation', 'inspectAgentInput', 'inspectAgentPromptSubmission',
  'stopAgentInputWaiting', 'rejoinAgentInputWaiting', 'signalAgent',
  'readAgentConversation', 'conversationCheckpoint', 'readConversationChanges', 'releaseConversationView',
] as const
export type SpaceMemberInvocation = typeof SPACE_MEMBER_INVOCATIONS[number]
export const SPACE_MEMBER_CALLS = ['runtime.owner.identity', 'runtime.bootstrap', 'runtime.invoke', 'runtime.release-consumer'] as const
export const SPACE_MEMBER_STREAMS = ['runtime.events', 'runtime.attachment-watch', 'runtime.replay-watch', 'runtime.conversation-watch'] as const
export type SpaceMemberCallMethod = typeof SPACE_MEMBER_CALLS[number]
export type SpaceMemberStreamMethod = typeof SPACE_MEMBER_STREAMS[number]
export type SpaceMemberHostedCall<M extends SpaceMemberCallMethod = SpaceMemberCallMethod> = {
  [K in M]: { method: K; params: AgentMuxHostedRuntimeParameterMap[K] }
}[M]
export type SpaceMemberHostedWatch<M extends SpaceMemberStreamMethod = SpaceMemberStreamMethod> = {
  [K in M]: { method: K; params: AgentMuxHostedRuntimeParameterMap[K] }
}[M]
export const SPACE_MEMBER_METHODS = { 'space.member.call': 'long', 'space.member.watch': 'long' } as const
export type SpaceMemberParams = {
  'space.member.call': { target: SpaceMemberRoute; call: SpaceMemberHostedCall }
  'space.member.watch': { target: SpaceMemberRoute; call: SpaceMemberHostedWatch }
}
export type SpaceMemberResults = {
  'space.member.call': AgentMuxHostedRuntimeResultMap[SpaceMemberCallMethod]
  'space.member.watch': AgentMuxHostedStreamInitialMap[SpaceMemberStreamMethod]
}
