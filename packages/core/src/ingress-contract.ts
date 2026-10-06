import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { AgentExternalMessageAuthor } from './external-author.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'

/** Original external intake facts. Claim means a Core call may have happened, never delivery. */
export type ConnectionIngressRecord = {
  ingressId: string
  connectionId: string
  application: ConnectionApplication
  eventId: string
  externalMessageId: string
  externalConversationId: string
  actor: ConnectionActor
  body: string
  state: 'received' | 'refused' | 'claimed'
  code?: string
  input?: {
    hostId: string; agentSessionId: string; expectedRun: { runId: string }
    operationId: string; messageId: string; author: AgentExternalMessageAuthor
  }
}
export type ConnectionIngressInspectInput = { ingressId: string }
export type ConnectionIngressListInput = { connectionId: string; bindingId?: string; afterIngressId?: string; limit?: number }
export type ConnectionIngressInspection = {
  ingress: ConnectionIngressRecord | null
  /** Original Core read only. An absent receipt never licenses a replay. */
  inputReceipt: AgentInputSubmissionReceipt | null
  observation: 'not-started' | 'observed' | 'unavailable'
}
export type ConnectionIngressPage = { ingresses: ConnectionIngressRecord[]; nextAfterIngressId: string | null }
export interface ConnectionIngressReadPort {
  inspect(input: ConnectionIngressInspectInput): Promise<ConnectionIngressInspection>
  list(input: ConnectionIngressListInput): Promise<ConnectionIngressPage>
}
export type ConnectionIngressParamsMap = {
  'connection.ingress.inspect': ConnectionIngressInspectInput
  'connection.ingress.ls': ConnectionIngressListInput
}
export type ConnectionIngressResultMap = {
  'connection.ingress.inspect': ConnectionIngressInspection
  'connection.ingress.ls': ConnectionIngressPage
}
export type ConnectionIngressMethod = keyof ConnectionIngressParamsMap
