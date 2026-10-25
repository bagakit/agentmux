import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { AgentExternalMessageAuthor, AgentExternalInteractionAuthor } from './external-author.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'

/** A current observation of the frozen input target, never a retry or lifecycle decision. */
export type ConnectionIngressRuntimeObservation = {
  target: 'original' | 'changed' | 'missing' | 'unavailable'
  state: import('./types.js').AgentMuxRunState | 'unavailable'
  exitCode: number | null
}

/** A platform parent reference is retained even while its application author is unknown. */
export type ConnectionIngressAddressing = { replyToMessageId: string } & (
  | { state: 'confirmed'; selection: 'reply' | 'message' }
  | { state: 'unknown'; reason: 'reply-unconfirmed' }
  | { state: 'unavailable'; reason: 'adapter-unavailable' | 'credential-missing' }
)

/** Original external intake facts. Claim means a Core call may have happened, never delivery. */
export type ConnectionIngressMessage = {
  kind?: never
  ingressId: string
  /** Original authenticated receiver configuration, retained even when the Binding uses another local alias. */
  connectionId: string
  application: ConnectionApplication
  eventId: string
  externalMessageId: string
  externalConversationId: string
  /** Original adapter protocol fact; absence does not imply a direct chat. */
  conversationKind?: 'direct' | 'group'
  actor: ConnectionActor
  body: string
  addressing?: ConnectionIngressAddressing
  /** Captured at authenticated group intake, before ACK. null means no active relationship then. */
  group?: { target: { hostId: string; agentSessionId: string; connectionId: string; bindingId: string; bindingRevision: number;
    /** Original owner-qualified publication boundary at intake, before an input is claimed. */
    publicationRevision?: number;
    authoritySource?: import('./external-author.js').AgentExternalAuthoritySource } | null; recorded?: import('./external-conversation.js').AgentExternalConversationReceipt; recording?: { state: 'unavailable' | 'refused'; code: string } }
  state: 'received' | 'refused' | 'claimed'
  /** Refusal reason, or the latest recoverable preparation observation while still received. */
  code?: string
  input?: {
    hostId: string; agentSessionId: string; expectedRun: { runId: string }
    /** The author identifies the exact authorized Binding connection, not the transport alias. */
    operationId: string; messageId: string; author: AgentExternalMessageAuthor
    /** First-claim display snapshot; cache refresh never changes this original input. */
    channelProfile?: import('./channel-profile.js').ChannelActorProfileObservation
    channelQuote?: import('./channel-quote.js').ChannelTranscriptQuote
    /** Original recipient observation for position correlation; never an input grant. */
    contextSource?: import('./types.js').AgentSessionHistorySource
    /** Original first-claim selection observation; does not change native coverage or input outcome. */
    contextObservation?: 'known-publications-unavailable'
    /** Original first claim only; missing historical intent is unknown and never reconstructed. */
    admissionIntent?: Exclude<import('./agent-prompt-condition.js').AgentPromptAdmissionIntent, { kind: 'exact-condition' }>
  }
}
/** Authenticated native action intake. An opaque reference locates an original intent, never authority. */
export type ConnectionQuestionAnswerSubmission = { questionId: string; optionIds?: string[]; text?: string }
export type ConnectionIngressAction = {
  kind: 'action'
  ingressId: string
  connectionId: string
  application: ConnectionApplication
  eventId: string
  actor?: ConnectionActor
  externalConversationId?: string
  sourceMessageId?: string
  actionRef?: string
  answers?: ConnectionQuestionAnswerSubmission[]
  state: 'received' | 'refused' | 'claimed'
  code?: 'INGRESS_ACTION_UNSUPPORTED' | 'INGRESS_QUESTION_ANSWER_INVALID' | ConnectionIngressAuthorityCode
  input?: { hostId: string; agentSessionId: string; expectedRun: { runId: string }; operationId: string; intentDigest: string; author: AgentExternalInteractionAuthor; responseKind?: 'question' }
  body?: never
  externalMessageId?: never
  addressing?: never
}
export type ConnectionIngressRecord = ConnectionIngressMessage | ConnectionIngressAction
export type ConnectionIngressInspectInput = { ingressId: string }
export type ConnectionIngressListInput = { connectionId: string; bindingId?: string; afterIngressId?: string; limit?: number }
/** Safe original context preparation/position facts. No quoted bodies or actor identities. */
export type ConnectionIngressContextObservation = {
  coverage: import('./channel-quote.js').ChannelTranscriptQuote['coverage']
  quotedMessages: number; gapCount: number; positionMessageId: string | null
  observation: 'observed' | 'unavailable'
  code?: 'known-publications-unavailable'
}
export type ConnectionIngressInspection = {
  ingress: ConnectionIngressRecord | null
  /** Original Core read only. An absent receipt never licenses a replay. */
  inputReceipt: AgentInputSubmissionReceipt | null
  context?: ConnectionIngressContextObservation
  /** Safe projection of the original Core historical-question admission, not another input journal. */
  questionReceipt?: { agentSessionId: string; expectedRun: { runId: string }; operationId: string;
    source: import('./types.js').AgentSessionHistorySource; recordId: string; questionIds: string[]; outcome: 'saved' | 'unknown' | 'not-applied' | 'submitted' } | null
  interactionReceipt?: { operationId: string; agentSessionId: string; run: { runId: string }; delivery: 'saved' | 'unknown' | 'bytes-accepted' | 'hook-written' | 'acp-acknowledged'; nativeAdoption: 'unknown' } | null
  observation: 'not-started' | 'observed' | 'unavailable'
}
export type ConnectionIngressPage = { ingresses: ConnectionIngressRecord[]; nextAfterIngressId: string | null }
export type ConnectionIngressAuthorityCode = 'INGRESS_SERVICE_DISABLED' | 'INGRESS_SERVICE_UNCONFIRMED' | 'INGRESS_CLAIM_UNAVAILABLE' | 'INGRESS_CONNECTION_UNAVAILABLE' | 'INGRESS_BINDING_UNAVAILABLE' | 'INGRESS_ACTOR_NOT_AUTHORIZED' | 'INGRESS_INPUT_OUTSIDE_SCOPE' | 'INGRESS_ADDRESSING_UNCONFIRMED' | 'INGRESS_AUTHORITY_REVISED' | 'INGRESS_TARGET_UNCONFIRMED' | 'INGRESS_STORAGE_UNCONFIRMED'
/** Original claim and current owner observation only. No Core receipt read or serialized permission. */
export type ConnectionIngressAuthority = {
  ingress: ConnectionIngressRecord | null
  authority: 'current' | 'refused' | 'unavailable'
  code?: ConnectionIngressAuthorityCode
}
export type ConnectionIngressAudienceInput = { application: ConnectionApplication; externalConversationId: string; beforeIngressId?: string; limit?: number }
export type ConnectionIngressAudiencePage = { ingresses: ConnectionIngressRecord[]; nextBeforeIngressId: string | null }
export interface ConnectionIngressReadPort {
  /** Local latest-first audience window across receiver aliases. Never dispatches or reads a platform. */
  listAudience?(input: ConnectionIngressAudienceInput): Promise<ConnectionIngressAudiencePage>
  inspect(input: ConnectionIngressInspectInput): Promise<ConnectionIngressInspection>
  list(input: ConnectionIngressListInput): Promise<ConnectionIngressPage>
  authority(input: { operationId: string }): Promise<ConnectionIngressAuthority>
  recordAuthority(input: import('./external-conversation.js').AgentExternalConversationReference): Promise<import('./external-conversation.js').AgentExternalConversationAuthority>
}
export type ConnectionIngressParamsMap = {
  'connection.ingress.inspect': ConnectionIngressInspectInput
  'connection.ingress.ls': ConnectionIngressListInput
  'connection.ingress.record-authority': import('./external-conversation.js').AgentExternalConversationReference
  'connection.ingress.authority': { operationId: string }
}
export type ConnectionIngressResultMap = {
  'connection.ingress.inspect': ConnectionIngressInspection
  'connection.ingress.ls': ConnectionIngressPage
  'connection.ingress.record-authority': import('./external-conversation.js').AgentExternalConversationAuthority
  'connection.ingress.authority': ConnectionIngressAuthority
}
export type ConnectionIngressMethod = keyof ConnectionIngressParamsMap
