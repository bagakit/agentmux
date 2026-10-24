import type { ConnectionMemberAccess, ConnectionEffectiveGrant, ConnectionEffectiveGrants } from './connection-application-access-contract.js'
import type { NativeConversationCheckpoint } from './session-history-changes.js'
import type { ConversationCheckpoint } from './conversation-changes.js'
import type { ConnectionApplication, ConnectionGrant } from './connections-contract.js'
import type { AgentSessionHistorySource } from './types.js'

export type RoomBindingAuthority = { kind: 'user' | 'device' | 'agent'; id: string }
export type RoomBindingScope = {
  input: 'mentions-and-replies' | 'all-messages'
  /** Immutable prior scopes and dedicated private-chat origins remain readable. */
  publication: 'future-native-user-facing' | 'future-shared-conversation'
}
export type RoomBindingTarget = { executionHostId: string; agentSessionId: string; regionAnchor?: { regionId: string } }
/** Explicit source selection for future input, independent of publication/read scope. Never freezes a per-message turn. */
export type RoomBindingInputTarget = Omit<Extract<import('./agent-prompt-condition.js').AgentDirectedPromptTarget, { kind: 'native-conversation' }>, 'expectedTurnId'>
/** An immutable authorized audience snapshot. A Region is navigation, never an execution route. */
export type RoomBinding = Omit<RoomBindingTarget, 'regionAnchor'> & {
  /** Confirmed by the original target owner at this revision, never caller-supplied. */
  executionRuntimeId?: string
  /** Optional original presentation; background conversations do not require a Region. */
  regionAnchor?: RoomBindingTarget['regionAnchor']
  bindingId: string
  revision: number
  state: 'active' | 'paused' | 'detached'
  connectionId: string
  application: ConnectionApplication
  externalConversationId: string
  scope: RoomBindingScope
  inputTarget?: RoomBindingInputTarget
  /** Only original native sources are eligible in this scope. No captured or wall-clock substitute. */
  sourceCheckpoints: NativeConversationCheckpoint[]
  /** Frozen original source cuts accepted by this Binding revision, never discovery authorization. */
  sourceFrontier?: ConversationCheckpoint
  /** Dedicated creation owner authorized this new conversation from its native beginning.
   * Mutually exclusive with frozen cuts; ordinary group bind/relink cannot request it. */
  publicationOrigin?: { createOperationId: string }
  authorizedBy: RoomBindingAuthority
}
/** Original recorded request shape, not permission to dispatch a new group request. */
export type RoomBindingRecordedBindInput = RoomBindingTarget & {
  operationId: string; bindingId: string; connectionId: string; expectedConnectionRevision: number
  externalConversationId: string; scope: RoomBindingScope; expectedSource: AgentSessionHistorySource
  inputTarget?: RoomBindingInputTarget
}
/** Ordinary groups share one complete public conversation across every audience. */
export type RoomBindingBindInput = Omit<RoomBindingRecordedBindInput, 'scope'> & {
  scope: { input: RoomBindingScope['input']; publication: 'future-shared-conversation' }
}
export type RoomBindingRecordedRelinkInput = RoomBindingRecordedBindInput & { expectedRevision: number }
/** Relinking includes an explicit fresh source cut, also when continuing a paused binding to the same audience. */
export type RoomBindingRelinkInput = RoomBindingBindInput & { expectedRevision: number }
export type RoomBindingNoticeEvent = 'connected' | 'disconnected' | 'paused' | 'resumed' | 'updated'
export type RoomBindingNotice = { event: RoomBindingNoticeEvent; deliveryOperationId: string }
export type RoomBindingPauseInput = { operationId: string; bindingId: string; expectedRevision: number }
export type RoomBindingGrantInput = {
  operationId: string; bindingId: string; expectedBindingRevision: number
  grantId: string; expectedRevision: number | null
  actor: ConnectionGrant['actor']; capabilities: ConnectionGrant['capabilities']; state: ConnectionGrant['state']
}
export type RoomBindingInheritInput = { operationId: string; bindingId: string; expectedBindingRevision: number; actor: ConnectionGrant['actor']; expectedGrant: { grantId: string; revision: number } }
export type RoomBindingAction = 'bind' | 'pause' | 'resume' | 'detach' | 'relink' | 'grant' | 'inherit'
export type RoomBindingOperation =
  | { operationId: string; action: RoomBindingAction; state: 'preparing' }
  | { operationId: string; action: RoomBindingAction; state: 'refused'; code: string }
  | { operationId: string; action: RoomBindingAction; state: 'applied'; binding: RoomBinding; grant?: ConnectionGrant; inherited?: { actor: ConnectionGrant['actor']; grants: Array<{ grantId: string; revision: number }> }; reused?: boolean; notices?: RoomBindingNotice[] }
export type RoomBindingInspectInput = { bindingId: string; revision?: number; operationId?: never } | { operationId: string; bindingId?: never; revision?: never }
export type RoomBindingInspection = { binding: RoomBinding | null; current: RoomBinding | null; operation: RoomBindingOperation | null; grants: ConnectionGrant[]; access?: ConnectionMemberAccess[] }
export type RoomBindingListInput = { connectionId?: string; executionHostId?: string; agentSessionId?: string }
export type RoomBindingCallContext = { actor: RoomBindingAuthority; assertCurrent?(): void | Promise<void> }
export interface RoomBindingsPort {
  bind(input: RoomBindingBindInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  inspect(input: RoomBindingInspectInput): Promise<RoomBindingInspection>
  list(input: RoomBindingListInput): Promise<{ bindings: RoomBinding[] }>
  pause(input: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  resume(input: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  detach(input: RoomBindingPauseInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  relink(input: RoomBindingRelinkInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  inherit(input: RoomBindingInheritInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
  grant(input: RoomBindingGrantInput, context: RoomBindingCallContext): Promise<RoomBindingOperation>
}
export type RoomPublicationAuthority = {
  binding: RoomBinding | null
  authorized: boolean
  reason?: 'missing' | 'binding-revised' | 'paused' | 'connection-disabled' | 'publication-not-granted' | 'service-disabled'
}
/** Synchronous reads can join the original connector database transaction. They never query a Region occupant. */
export interface RoomBindingReadPort {
  effectiveGrant(bindingId: string, revision: number, actor: ConnectionGrant['actor']): ConnectionEffectiveGrant | null
  effectiveGrants(bindingId: string, revision: number): ConnectionEffectiveGrants
  readOperation?(operationId: string): RoomBindingOperation | null
  grants?(bindingId: string, revision: number): ConnectionGrant[]
  readExact(bindingId: string, revision: number): RoomBinding | null
  readCurrent(bindingId: string): RoomBinding | null
  /** The original unique native application/group owner, independent of its receiver alias. */
  findActiveAudience(input: { application: ConnectionApplication; externalConversationId: string }): RoomBinding | null
  listActive(input?: RoomBindingListInput): RoomBinding[]
  publicationAuthority(bindingId: string, revision: number): RoomPublicationAuthority
  readGrant(grantId: string, revision?: number): ConnectionGrant | null
  findGrant(input: { connectionId: string; externalConversationId: string; actor: ConnectionGrant['actor'] }): ConnectionGrant | null
}

export type RoomBindingParamsMap = {
  'connection.bind': RoomBindingBindInput
  'connection.binding.inspect': RoomBindingInspectInput
  'connection.binding.ls': RoomBindingListInput
  'connection.binding.pause': RoomBindingPauseInput
  'connection.binding.resume': RoomBindingPauseInput
  'connection.binding.detach': RoomBindingPauseInput
  'connection.binding.relink': RoomBindingRelinkInput
  'connection.binding.member.inherit': RoomBindingInheritInput
  'connection.grant': RoomBindingGrantInput
}
export type RoomBindingResultMap = {
  'connection.bind': RoomBindingOperation
  'connection.binding.inspect': RoomBindingInspection
  'connection.binding.ls': { bindings: RoomBinding[] }
  'connection.binding.pause': RoomBindingOperation
  'connection.binding.resume': RoomBindingOperation
  'connection.binding.detach': RoomBindingOperation
  'connection.binding.relink': RoomBindingOperation
  'connection.binding.member.inherit': RoomBindingOperation
  'connection.grant': RoomBindingOperation
}
export type RoomBindingMethod = keyof RoomBindingParamsMap
