import type { MoteConnectionRef, MotePreferencesTarget } from './mote-preferences.js'
import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import type { ConnectionEnrollmentCallContext } from './connection-enrollment-contract.js'
import type { MoteChatDiagnosis, MoteChatDiagnosisInput } from './mote-chat-diagnosis.js'

/** Chat policy is owned once by the connector Host, separately from MOTE.md group defaults. */
export type MoteChatTarget = MotePreferencesTarget
export type MoteChatValues = {
  enabled: boolean
  connection: MoteConnectionRef | null
  conversationIdleMs: number
  /** Total allowance seeded once for each new guest; zero declines new guests. */
  strangerMessageLimit: number
}
/** Editable product defaults, not a runtime expiry or a limit on retained conversations. */
export const MOTE_CHAT_DEFAULT_VALUES: Readonly<MoteChatValues> = Object.freeze({
  enabled: false, connection: null, conversationIdleMs: 30 * 60_000, strangerMessageLimit: 0
})
export type MoteChatConfiguration = {
  target: MoteChatTarget
  revision: number
  values: MoteChatValues
  /** Original application-scoped creator, resolved by the Host rather than supplied by JSON. */
  creator: ConnectionActor | null
}
export type MoteChatConfigure = {
  operationId: string
  target: MoteChatTarget
  expectedRevision: number | null
  expectedConnectionRevision: number | null
  values: MoteChatValues
}
export type MoteChatPerson = {
  actor: ConnectionActor
  creator: boolean
  revision: number
  total: number | null
  used: number
  remaining: number | null
  name?: string
}
export type MoteChatAllocate = {
  operationId: string
  target: MoteChatTarget
  expectedConfigurationRevision: number
  actor: ConnectionActor
  expectedPersonRevision: number
  /** New total allowance. Allocating never resets the already admitted count. */
  total: number
}
export type MoteChatOperation =
  | { operationId: string; action: 'configure'; configuration: MoteChatConfiguration }
  | { operationId: string; action: 'allocate'; configuration: MoteChatConfiguration; person: MoteChatPerson }
export type MoteChatInspect = { target: MoteChatTarget; operationId?: never } | { operationId: string; target?: never }
export type MoteChatInspection = { configuration: MoteChatConfiguration | null; operation: MoteChatOperation | null }
export type MoteChatGeneration = {
  generationId: string
  target: MoteChatTarget
  application: ConnectionApplication
  externalConversationId: string
  actor: ConnectionActor
  executionHostId: string
  agentSessionId: string
  createOperationId: string
  phase: 'preparing' | 'ready'
  createdAt: number
  lastActivityAt: number
}
export type MoteChatHistoryInput = { target: MoteChatTarget; actor?: ConnectionActor; cursor?: string; limit?: number }
export type MoteChatHistoryPage = { generations: MoteChatGeneration[]; next: string | null }
export type MoteChatAudienceInput = { target: MoteChatTarget; cursor?: string; limit?: number }
export type MoteChatAudiencePage = { people: MoteChatPerson[]; next: string | null }
export type MoteChatParamsMap = {
  'space.mote.chat.configure': MoteChatConfigure
  'space.mote.chat.inspect': MoteChatInspect
  'space.mote.chat.history': MoteChatHistoryInput
  'space.mote.chat.audience': MoteChatAudienceInput
  'space.mote.chat.allocate': MoteChatAllocate
  'space.mote.chat.diagnose': MoteChatDiagnosisInput
}
export type MoteChatResultMap = {
  'space.mote.chat.configure': Extract<MoteChatOperation, { action: 'configure' }>
  'space.mote.chat.inspect': MoteChatInspection
  'space.mote.chat.history': MoteChatHistoryPage
  'space.mote.chat.audience': MoteChatAudiencePage
  'space.mote.chat.allocate': Extract<MoteChatOperation, { action: 'allocate' }>
  'space.mote.chat.diagnose': MoteChatDiagnosis
}
export type MoteChatMethod = keyof MoteChatParamsMap
/** The transport supplies original authority. Redacted diagnosis does not grant private-history or management access. */
export type MoteChatCallContext = ConnectionEnrollmentCallContext
export interface MoteChatPort {
  configure(input: MoteChatConfigure, context: MoteChatCallContext): Promise<MoteChatResultMap['space.mote.chat.configure']>
  inspect(input: MoteChatInspect, context?: MoteChatCallContext): Promise<MoteChatInspection>
  history(input: MoteChatHistoryInput, context?: MoteChatCallContext): Promise<MoteChatHistoryPage>
  audience(input: MoteChatAudienceInput, context?: MoteChatCallContext): Promise<MoteChatAudiencePage>
  allocate(input: MoteChatAllocate, context: MoteChatCallContext): Promise<MoteChatResultMap['space.mote.chat.allocate']>
  diagnose(input: MoteChatDiagnosisInput, context?: MoteChatCallContext): Promise<MoteChatDiagnosis>
}
