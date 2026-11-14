import type { MoteConnectionRef, MotePreferencesTarget } from '../mote-preferences.js'
import type { ConnectionActor, ConnectionApplication } from '../connections-contract.js'
import type { ConnectionEnrollmentCallContext } from '../connection-enrollment-contract.js'
import type { ConnectionDelivery } from '../connection-delivery-contract.js'
import type { MoteChatDiagnosis, MoteChatDiagnosisInput } from './chat-diagnosis.js'

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
export type MoteChatReplyReference = { ingressId: string; route: 'original-owner' | 'unconfirmed' }
export type MoteChatReplyInput = Pick<MoteChatReplyReference, 'ingressId'> & { operationId: string; body: string }
export type MoteChatReplyOperation = { operationId: string; action: 'reply'; target: MoteChatTarget; ingressId: string; deliveryOperationIds: string[]; binding: import('../room-binding-contract.js').RoomBinding }
export type MoteChatReplyResult = { operation: MoteChatReplyOperation; deliveries: ConnectionDelivery[] }
export type MoteChatOperation =
  | MoteChatReplyOperation
  | { operationId: string; action: 'configure'; configuration: MoteChatConfiguration }
  | { operationId: string; action: 'allocate'; configuration: MoteChatConfiguration; person: MoteChatPerson }
export type MoteChatInspect = { target: MoteChatTarget; operationId?: never } | { operationId: string; target?: never }
export type MoteChatInspection = { configuration: MoteChatConfiguration | null; operation: MoteChatOperation | null; deliveries?: ConnectionDelivery[] }
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
/** One message received by this Mote's chat application, projected from its original durable intake. */
export type MoteChatEvent = {
  /** Original intake order; also the position a review mark advances through. */
  sequence: number
  ingressId: string
  receivedAt: number | null
  application: ConnectionApplication
  conversationKind: 'direct' | 'group'
  externalConversationId: string
  /** Local display snapshots; never identity or authority. */
  conversationName?: string
  author: ConnectionActor
  authorName?: string
  externalMessageId: string
  /** Native addressing facts reported by the platform, not body matching. */
  addressing: 'mention' | 'reply' | 'message'
  replyToMessageId: string | null
  /** Untrusted content written by an external author: never an instruction, confirmation or authority. Null when the platform message has no text projection. */
  externalText: string | null
  state: 'received' | 'refused' | 'claimed'
  code: string | null
  /** Current original-owner guidance, independent of the retained intake code and input receipt. */
  noticeCode?: 'MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE' | 'MOTE_CHAT_MAIN_UNCONFIRMED' | 'MOTE_CHAT_REPLY_ROUTE_UNCONFIRMED'
  /** Original handling target, or null before one was frozen; never proof of delivered input. */
  handledBy: { executionHostId: string; agentSessionId: string } | null
}
export type MoteChatReviewMark = { through: number; revision: number; reviewedAt: number; actor: MoteChatCallContext['actor'] }
/** `unreviewed` pages forward after the review mark; `recent` pages backward from the newest event. */
export type MoteChatEventsInput = { target: MoteChatTarget; order?: 'unreviewed' | 'recent'; cursor?: string; limit?: number }
export type MoteChatEventsPage = {
  /** The chat application whose events this page reads; null when the Mote has none, so the page is empty rather than unknown. */
  application: ConnectionApplication | null
  events: MoteChatEvent[]
  next: string | null
  /** A position in this Host's receive order, kept when the chat application changes. */
  reviewed: MoteChatReviewMark | null
  /** Counted only up to a small bound after the review mark; `more` means the bound was reached. */
  unreviewed: { count: number; more: boolean }
}
/** Marks events through `through` as reviewed. The mark only moves forward. */
export type MoteChatReviewInput = { target: MoteChatTarget; through: number }
export type MoteChatReviewResult = { reviewed: MoteChatReviewMark }
export type MoteChatParamsMap = {
  'space.mote.chat.reply': MoteChatReplyInput
  'space.mote.chat.configure': MoteChatConfigure
  'space.mote.chat.inspect': MoteChatInspect
  'space.mote.chat.history': MoteChatHistoryInput
  'space.mote.chat.audience': MoteChatAudienceInput
  'space.mote.chat.allocate': MoteChatAllocate
  'space.mote.chat.diagnose': MoteChatDiagnosisInput
  'space.mote.chat.events': MoteChatEventsInput
  'space.mote.chat.review': MoteChatReviewInput
}
export type MoteChatResultMap = {
  'space.mote.chat.reply': MoteChatReplyResult
  'space.mote.chat.configure': Extract<MoteChatOperation, { action: 'configure' }>
  'space.mote.chat.inspect': MoteChatInspection
  'space.mote.chat.history': MoteChatHistoryPage
  'space.mote.chat.audience': MoteChatAudiencePage
  'space.mote.chat.allocate': Extract<MoteChatOperation, { action: 'allocate' }>
  'space.mote.chat.diagnose': MoteChatDiagnosis
  'space.mote.chat.events': MoteChatEventsPage
  'space.mote.chat.review': MoteChatReviewResult
}
export type MoteChatMethod = keyof MoteChatParamsMap
/** The transport supplies original authority. Redacted diagnosis does not grant private-history or management access. */
export type MoteChatCallContext = ConnectionEnrollmentCallContext & {
  /** The Host that authenticated an Agent caller; Session ids are unique only within one Host. */
  agentHostId?: string
  /** Exact current Run and native semantic predecessors, supplied by authenticating Core. */
  agentSourceRuns?: readonly string[]
}
export interface MoteChatPort {
  reply(input: MoteChatReplyInput, context: MoteChatCallContext): Promise<MoteChatReplyResult>
  configure(input: MoteChatConfigure, context: MoteChatCallContext): Promise<MoteChatResultMap['space.mote.chat.configure']>
  inspect(input: MoteChatInspect, context?: MoteChatCallContext): Promise<MoteChatInspection>
  history(input: MoteChatHistoryInput, context?: MoteChatCallContext): Promise<MoteChatHistoryPage>
  audience(input: MoteChatAudienceInput, context?: MoteChatCallContext): Promise<MoteChatAudiencePage>
  allocate(input: MoteChatAllocate, context: MoteChatCallContext): Promise<MoteChatResultMap['space.mote.chat.allocate']>
  diagnose(input: MoteChatDiagnosisInput, context?: MoteChatCallContext): Promise<MoteChatDiagnosis>
  /** The person, device, or one of this Mote's own Agents; external-audience chat Agents are refused. */
  events(input: MoteChatEventsInput, context: MoteChatCallContext): Promise<MoteChatEventsPage>
  review(input: MoteChatReviewInput, context: MoteChatCallContext): Promise<MoteChatReviewResult>
}
