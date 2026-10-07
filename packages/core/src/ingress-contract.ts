import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { AgentExternalMessageAuthor } from './external-author.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'

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
  connectionId: string
  application: ConnectionApplication
  eventId: string
  externalMessageId: string
  externalConversationId: string
  actor: ConnectionActor
  body: string
  addressing?: ConnectionIngressAddressing
  state: 'received' | 'refused' | 'claimed'
  code?: string
  input?: {
    hostId: string; agentSessionId: string; expectedRun: { runId: string }
    operationId: string; messageId: string; author: AgentExternalMessageAuthor
  }
}
/** Authenticated native action intake, currently unsupported. Missing context remains absent. */
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
  state: 'refused'
  code: 'INGRESS_ACTION_UNSUPPORTED'
  body?: never
  externalMessageId?: never
  addressing?: never
  input?: never
}
export type ConnectionIngressRecord = ConnectionIngressMessage | ConnectionIngressAction
export type ConnectionIngressInspectInput = { ingressId: string }
export type ConnectionIngressListInput = { connectionId: string; bindingId?: string; afterIngressId?: string; limit?: number }
export type ConnectionIngressInspection = {
  ingress: ConnectionIngressRecord | null
  /** Original Core read only. An absent receipt never licenses a replay. */
  inputReceipt: AgentInputSubmissionReceipt | null
  observation: 'not-started' | 'observed' | 'unavailable'
}
export type ConnectionIngressPage = { ingresses: ConnectionIngressRecord[]; nextAfterIngressId: string | null }
export type ConnectionIngressAuthorityCode = 'INGRESS_CLAIM_UNAVAILABLE' | 'INGRESS_CONNECTION_UNAVAILABLE' | 'INGRESS_BINDING_UNAVAILABLE' | 'INGRESS_ACTOR_NOT_AUTHORIZED' | 'INGRESS_INPUT_OUTSIDE_SCOPE' | 'INGRESS_ADDRESSING_UNCONFIRMED' | 'INGRESS_AUTHORITY_REVISED' | 'INGRESS_STORAGE_UNCONFIRMED'
/** Original claim and current owner observation only. No Core receipt read or serialized permission. */
export type ConnectionIngressAuthority = {
  ingress: ConnectionIngressRecord | null
  authority: 'current' | 'refused' | 'unavailable'
  code?: ConnectionIngressAuthorityCode
}
export interface ConnectionIngressReadPort {
  inspect(input: ConnectionIngressInspectInput): Promise<ConnectionIngressInspection>
  list(input: ConnectionIngressListInput): Promise<ConnectionIngressPage>
  authority(input: { operationId: string }): Promise<ConnectionIngressAuthority>
}
export type ConnectionIngressParamsMap = {
  'connection.ingress.inspect': ConnectionIngressInspectInput
  'connection.ingress.ls': ConnectionIngressListInput
  'connection.ingress.authority': { operationId: string }
}
export type ConnectionIngressResultMap = {
  'connection.ingress.inspect': ConnectionIngressInspection
  'connection.ingress.ls': ConnectionIngressPage
  'connection.ingress.authority': ConnectionIngressAuthority
}
export type ConnectionIngressMethod = keyof ConnectionIngressParamsMap
