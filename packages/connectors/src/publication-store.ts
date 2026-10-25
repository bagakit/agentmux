import { queryInputPosition, queryInputPage, queryInputPending, queryInputReceipt, type QueryInputPosition } from './publication-query-input.js'
import { isCompleteConversationRecord } from '@agentmux/core/conversation'
import { projectQueryFeedback, queueQueryFeedback, queryFeedbackOperationId, reconcileQueryFeedback } from './publication-query-feedback.js'
import { externalConversationAuthor, externalConversationRecordId } from '@agentmux/core'
import { createHash } from 'node:crypto'
import { publicationImage, type PublicationImage, type PublicationFile, type ResourceUploadReceipt, type ResolvedPublicationPart } from './publication-resource.js'
import { publicationContent, publicationPartKey, type PublicationContentPlan } from './publication-content.js'
import { publicationInputAlias } from './publication-input-alias.js'
import { replyRecord, replyMetadata, type ReplyPublicationMetadata, type ReplyFact, type ReplyProjection } from './publication-reply-metadata.js'
export type { ReplyPublicationMetadata } from './publication-reply-metadata.js'
import type { PublicationA2A, PublicationOriginalMessage } from './publication-a2a.js'
import type { PublicationSpeaker } from './publication-speaker.js'
import type { PublicationCardAdapter, PublicationCardPreparation, PublicationPortrait, CardCreateReceipt, PortraitReceipt } from './publication-card.js'
import { parsePreparedPublication, publicationSpeechText, type PreparedPublication, type PublicationPreparer } from './publication-wire.js'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { AgentMuxError, type AgentSessionHistoryItem, type AgentSessionHistoryContentPart } from '@agentmux/core'
import { sameRoomPublication, type RoomBindingReadPort, parseConnectionDelivery, parseConnectionDeliveryReceipt, parseConnectionDeliveryCoverage, type ConnectionDeliveryCoverage, type ConnectionDeliveryGap, type ConnectionDelivery, type ConnectionDeliveryState, type ConnectionDeliveryMapping, type ConnectionDeliveryReceiptReason, type ConnectionDeliveryReceipt, type RoomBinding } from '@agentmux/core/connections'
import { parseConversationChangesPageForWindow, parseConversationUnit, parseConversationUnitsForPage, parseConversationCheckpoint, conversationRecordId, conversationSourceKey, conversationQuestionIdentity, conversationInputAdoptionEdges, mergeConversationInputAdoptionContexts, conversationInputIdentity, conversationNativeInputWitness, type ConversationInputWitness, type ConversationQuestionIdentity, type ConversationContentRef, type ConversationUnit, type ConversationChangesPage, type ConversationCheckpoint, type ConversationItemRef, type ConversationRef } from '@agentmux/core/conversation'

/** The immutable authorized audience; presentation and current focus are deliberately absent. */
export type PublicationBoundary = Pick<RoomBinding, 'bindingId' | 'revision' | 'connectionId' | 'application' | 'executionHostId' | 'agentSessionId' | 'externalConversationId' | 'sourceCheckpoints' | 'sourceFrontier' | 'publicationOrigin' | 'scope' | 'executionRuntimeId' | 'inputTarget' | 'publicationBoundary'>
/** Exact original recipient, independent of current connection aliases and Binding generations. */
export type PublicationContextRecipient = {
  application: PublicationBoundary['application']; externalConversationId: string; hostId: string; agentSessionId: string
  source: import('@agentmux/core').AgentSessionHistorySource
}
export type PermissionPublicationPayload = {
  kind: 'permission'; disclosure: 'shared' | 'redacted'; title: string; context?: string; status: 'pending' | 'response-sent' | 'unconfirmed' | 'unavailable'
  options: Array<{ label: string; actionRef: string }>
}
export type QuestionPublicationPayload = {
  kind: 'question'; text: string; questions: NonNullable<AgentSessionHistoryItem['questionRequest']>['questions']
  status: 'pending' | 'response-sent' | 'unconfirmed' | 'unavailable'; actionRef?: string
  unavailableReason?: string
  answers?: Array<{ questionId: string; answer: string }>
  phase?: 'progress' | 'final'
}
export type ImagePublicationPayload = { kind: 'image'; part: ConversationContentRef; image: PublicationImage; phase?: 'progress' | 'final'; relay?: NonNullable<ConnectionDelivery['relay']> }
export type FilePublicationPayload = { kind: 'file'; part: ConversationContentRef; file: PublicationFile; phase?: 'progress' | 'final'; relay?: NonNullable<ConnectionDelivery['relay']> }
export type BindingLifecyclePayload = {
  kind: 'binding-lifecycle'
  event: import('@agentmux/core/connections').RoomBindingNoticeEvent
  agentSessionId: string
  scope: RoomBinding['scope']
  synchronization: boolean | null
}
export type PublicationTextFragment = { text: string; presentationContext?: { before: string; after: string; literal?: true } }
export type QueryFeedbackPayload = { kind: 'query-feedback'; stage: NonNullable<ConnectionDelivery['queryFeedback']>['stage']; messageId: string }
/** Only Provider-qualified public fields; native message and nativeCode stay in Core history. */
export type FailurePublicationPayload = { kind: 'failure'; turnId: string; code: string; message?: string; recovery: string; httpStatusCode?: number }
export type PublicationPayload = FailurePublicationPayload | QueryFeedbackPayload | PermissionPublicationPayload | QuestionPublicationPayload | BindingLifecyclePayload | ImagePublicationPayload | FilePublicationPayload | {
  kind: 'speech'
  text: string
  presentationContext?: PublicationTextFragment['presentationContext']
  inputSubmission?: import('@agentmux/core').AgentInputSubmissionObservation
  phase?: 'progress' | 'final'
  questions?: NonNullable<AgentSessionHistoryItem['questionRequest']>['questions']
  relay?: NonNullable<ConnectionDelivery['relay']>
  replyMetadata?: ReplyPublicationMetadata
}
export type PublicationTarget = Pick<PublicationBoundary, 'connectionId' | 'application' | 'externalConversationId'>
export type PublicationState = ConnectionDeliveryState
export type PublicationMapping = ConnectionDeliveryMapping
export type PublicationFailureReason = ConnectionDeliveryReceiptReason
export type PublicationReceipt = ConnectionDeliveryReceipt
export type PublicationOperation = ConnectionDelivery & {
  /** Presentation only: original source time or the first recorded operation time. */
  presentationTime?: number
  payload: PublicationPayload
  /** Absent in original stored operations, whose scope remains assistant speech. */
  publicationScope?: RoomBinding['scope']['publication']
  /** Private receipt correlation; never changes the original operation or platform request key. */
  attempt?: number
  /** Frozen before dispatch; private to this Host, never exposed in public delivery DTOs. */
  prepared?: PreparedPublication
  sourceRecords?: ConversationItemRef[]
  /** Exact immutable journal body, qualified before queuing; the source remains its original notification record. */
  originalMessage?: Pick<PublicationOriginalMessage, 'messageId' | 'senderSessionId' | 'notificationId'>
  /** Private unfinished receipt observation; never an input state or a platform effect state. */
  queryPending?: true
  /** Original qualified adoption proof retained with its effect for later turn completion. */
  queryTurn?: import('@agentmux/core/conversation').ConversationInputWitness
  queryCompletion?: { record: ConversationItemRef; revision: string }
  uploads?: Array<{ state: 'dispatching' } | ResourceUploadReceipt>
  /** Frozen presentation, never another source of author or sharing authority. */
  speaker?: PublicationSpeaker
  avatarUploads?: Array<{ state: 'dispatching' } | import('./publication-resource.js').ImageUploadReceipt>
  /** Reuse points at an original upload receipt, never a fabricated second attempt. */
  avatarSource?: { operationId: string; attempt: number; imageKey?: string }
  cardPreparation?: PublicationCardPreparation
  /** Reserved in the original entity owner, then frozen with this body's request. */
  cardSequence?: number
  portrait?: PublicationPortrait
}
/** Reuse the original public receipt codec without accepting private request or body fields. */
const parseReceipt = parseConnectionDeliveryReceipt
export function publicDelivery(operation: PublicationOperation): ConnectionDelivery {
  const { payload: _payload, publicationScope: _scope, prepared: _prepared, attempt: _attempt, sourceRecords: _records, originalMessage: _originalMessage, uploads: _uploads, presentationTime: _presentationTime, speaker: _speaker, avatarUploads: _avatarUploads, avatarSource: _avatarSource, queryTurn: _queryTurn, queryCompletion: _queryCompletion, queryPending: _queryPending, cardPreparation, cardSequence: _cardSequence, portrait, ...delivery } = operation
  const last = operation.uploads?.at(-1)
  return parseConnectionDelivery({ ...delivery, ...(cardPreparation || portrait ? { presentation: {
    ...(cardPreparation ? { entity: { state: cardPreparation.receipt.state, ...('reason' in cardPreparation.receipt ? { reason: cardPreparation.receipt.reason } : {}) } } : {}),
    ...(portrait ? { portrait: { state: portrait.state, ...('receipt' in portrait && portrait.receipt && 'reason' in portrait.receipt ? { reason: portrait.receipt.reason } : {}) } } : {})
  } } : {}), ...((operation.payload.kind === 'image' || operation.payload.kind === 'file') && operation.effect === 'upsert' && !operation.prepared?.request.multipart ? { resourceUpload: { kind: operation.payload.kind, part: operation.payload.part, attempt: operation.uploads?.length ?? 0, state: last?.state ?? 'pending' } } : {}) })
}
export type PublicationPageOptions = {
  queryFeedback?: true
  replyMetadata?: true
  queryAuthorized?: (query: import('@agentmux/core/connections').ConnectionIngressMessage) => boolean
  fragmentBytes?: number
  fragmentText?: (payload: Extract<PublicationPayload, { kind: 'speech' }>, speaker?: PublicationSpeaker, originalMessage?: PublicationOperation['originalMessage']) => readonly PublicationTextFragment[] | undefined
  units: readonly ConversationUnit[]
  resolvedText: ReadonlyMap<string, ResolvedPublicationPart>
  questions?: ReadonlyMap<string, QuestionPublicationPayload>
  speakers?: ReadonlyMap<string, PublicationSpeaker>
  originals?: ReadonlyMap<string, readonly PublicationA2A[]>
}
// JSON object property order carries no source or platform identity.
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('base64url')
const sourceKey = (source: RoomBinding['sourceCheckpoints'][number]['source']) => encode([source.providerId, source.nativeSessionId])
const scopeKey = (boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>) => [boundary.bindingId, boundary.revision] as const
const ref = (boundary: PublicationBoundary): ConversationRef => ({ hostId: boundary.executionHostId, agentSessionId: boundary.agentSessionId })
const same = (a: unknown, b: unknown) => encode(a) === encode(b)
/** A neighboring observation revision does not replace an unchanged original image effect. */
function sameImageEffect(a: PublicationPayload, b: PublicationPayload): boolean {
  const effect = ({ part, image, phase, relay }: ImagePublicationPayload) => ({
    part: { record: part.record, selector: part.selector }, image, phase,
    relay: relay && { ...relay, sources: relay.sources.map(({ part, ...source }) => ({
      ...source, part: { record: part.record, selector: part.selector }
    })) }
  })
  return a.kind === 'image' && b.kind === 'image' && same(effect(a), effect(b))
}
type RepresentationIntent = { kind: 'representation'; projectionId: string } & PublicationContentPlan['pieces'][number]
type LegacyRepresentationIntent = { kind: 'legacy-representation'; projectionId: string; record: ConversationItemRef; operations: string[]; text: string }
type RepresentationRow = { ordinal: number; id: string; value: RepresentationIntent | LegacyRepresentationIntent }
type InputAliasDecision = { kind: 'gap'; gap: ConnectionDeliveryGap; state: 'resolved' | 'unresolved'; inputAlias: ConversationInputWitness }
type QuestionReadWitness = { recordRevision: string; targets: ConversationQuestionIdentity[]; read: string[] }
const questionReadsComplete = (witnesses: QuestionReadWitness[]) => witnesses.length > 0 && witnesses.every(witness => witness.targets.length > 0 && witness.targets.every(target => witness.read.includes(encode(target))))
function acceptQuestionReads(witnesses: QuestionReadWitness[], questions: ReadonlySet<string>): QuestionReadWitness[] {
  return witnesses.map(witness => ({ ...witness, read: [...new Set([...witness.read, ...witness.targets.map(encode).filter(target => questions.has(target))])] }))
}
/** Exact UTF-8 text fragments. The adapter declares its supported payload budget before admission. */
function fragments(payload: Extract<PublicationPayload, { kind: 'speech' }>, byteLimit: number, fragmentText?: PublicationPageOptions['fragmentText']): PublicationPayload[] {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 4 || byteLimit > 128 * 1024)
    throw new AgentMuxError('The adapter must declare a bounded publication text budget.', 'INVALID_PUBLICATION_REQUEST')
  const texts: string[] = []
  let text = '', bytes = 0
  for (const character of payload.text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > byteLimit) { texts.push(text); text = ''; bytes = 0 }
    text += character; bytes += size
  }
  if (text || !texts.length) texts.push(text)
  const selected: readonly PublicationTextFragment[] = fragmentText?.(payload) ?? texts.map(text => ({ text }))
  if (!selected.length || selected.some(part => typeof part.text !== 'string' || payload.text.length > 0 && !part.text.length) || selected.map(part => part.text).join('') !== payload.text)
    throw new AgentMuxError('The adapter must retain nonempty publication text fragments.', 'INVALID_PUBLICATION_REQUEST')
  return selected.map((part, index) => ({ kind: 'speech', text: part.text, ...(part.presentationContext ? { presentationContext: part.presentationContext } : {}),
    ...(payload.inputSubmission ? { inputSubmission: payload.inputSubmission } : {}),
    ...(payload.relay ? { relay: payload.relay } : {}),
    ...(payload.phase === undefined ? {} : { phase: payload.phase }),
    ...(index !== selected.length - 1 || payload.questions === undefined ? {} : { questions: payload.questions }),
    ...(index !== selected.length - 1 || payload.replyMetadata === undefined ? {} : { replyMetadata: payload.replyMetadata }) }))
}

type RepresentationPart = { text: string; part?: ConversationContentRef; image?: PublicationImage; file?: PublicationFile; segments?: Array<{ text: string; image?: PublicationImage }> }
type ContentPayload = Exclude<PublicationPayload, FailurePublicationPayload | PermissionPublicationPayload | QuestionPublicationPayload | BindingLifecyclePayload | QueryFeedbackPayload>
type RepresentationPayload = FailurePublicationPayload | Extract<PublicationPayload, { kind: 'speech' }> | { kind: 'sequence'; parts: ContentPayload[] }
type MaterializedPlan = PublicationContentPlan & { resourceParts?: RepresentationPart[] }
function representation(parts: readonly RepresentationPart[], phase?: 'progress' | 'final', relay?: ConnectionDelivery['relay'], separator = '\n\n', inputSubmission?: import('@agentmux/core').AgentInputSubmissionObservation): RepresentationPayload {
  parts = parts.flatMap<RepresentationPart>(part => part.segments ? part.segments.map(segment => ({ ...segment, ...(part.part ? { part: part.part } : {}) })) : [part])
  const fields = { ...(phase ? { phase } : {}), ...(relay ? { relay } : {}) }
  const speechFields = { ...fields, ...(inputSubmission ? { inputSubmission } : {}) }
  if (!parts.some(part => part.image || part.file)) return { kind: 'speech', text: parts.map(part => part.text).filter(Boolean).join(separator), ...speechFields }
  const result: ContentPayload[] = [], texts: string[] = []
  const flush = () => { if (texts.length) result.push({ kind: 'speech', text: texts.splice(0).join(separator), ...speechFields }) }
  for (const part of parts) {
    if (part.image) { flush(); result.push({ kind: 'image', part: part.part!, image: part.image, ...fields }) }
    else if (part.file) { flush(); result.push({ kind: 'file', part: part.part!, file: part.file, ...fields }) }
    else if (part.text) texts.push(part.text)
  }
  flush(); return { kind: 'sequence', parts: result }
}
function withReplyMetadata(payload: RepresentationPayload, metadata: ReplyPublicationMetadata | undefined): RepresentationPayload {
  const speech = payload.kind === 'speech' ? payload : payload.kind === 'sequence' ? [...payload.parts].reverse().find(part => part.kind === 'speech') : undefined
  if (metadata && speech?.kind === 'speech') speech.replyMetadata = metadata
  return payload
}
type QuestionRepresentation = QuestionPublicationPayload | { kind: 'sequence'; parts: Array<ContentPayload | QuestionPublicationPayload> }
const questionText = (value: RepresentationPayload): string => value.kind === 'failure' ? '' : value.kind === 'speech' ? value.text : value.parts.flatMap(part => part.kind === 'speech' ? [part.text] : []).join('\n\n')
/** The original form follows its media, with text from the converted representation, never raw image paths. */
function questionRepresentation(value: RepresentationPayload, original: QuestionPublicationPayload): QuestionRepresentation {
  const question = { ...original, text: questionText(value) }
  return value.kind === 'speech' || value.kind === 'failure' ? question : { kind: 'sequence', parts: [...value.parts, question] }
}
function representationFragments(value: RepresentationPayload | QuestionRepresentation, bytes: number, fragmentText?: PublicationPageOptions['fragmentText']): PublicationPayload[] {
  return value.kind === 'question' || value.kind === 'failure' ? [value] : value.kind === 'speech' ? value.text ? fragments(value, bytes, fragmentText) : []
    : value.parts.flatMap<PublicationPayload>(part => part.kind === 'speech' ? fragments(part, bytes, fragmentText) : [part])
}
// Query and derived index use the same original recovery qualification.
const recoverableGapPredicate = "json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved' AND json_extract(decision_json,'$.gap.reason') IN ('resource-unavailable','version-unavailable') AND json_type(decision_json,'$.gap.anchor')='object' AND (json_extract(decision_json,'$.gap.code')='PUBLICATION_A2A_ORIGINAL_UNAVAILABLE' OR (json_type(decision_json,'$.gap.part')='object' AND json_type(decision_json,'$.gap.event')='object'))"

/** Connector-owned publication facts, not another Agent history or lifecycle. Borrows the Host database. */
export class PublicationStore {
  private readonly decisionWrite: StatementSync

  constructor(readonly database: DatabaseSync, private readonly bindings?: Pick<RoomBindingReadPort, 'readExact'>) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS connector_publication_frontier (
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, source_key TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL, PRIMARY KEY(binding_id, binding_revision, source_key)
      );
      CREATE TABLE IF NOT EXISTS connector_publication_decision (
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, source_key TEXT NOT NULL,
        record_id TEXT NOT NULL, source_revision TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY(binding_id, binding_revision, source_key, record_id, source_revision)
      );
      CREATE TABLE IF NOT EXISTS connector_publication_operation (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
        projection_id TEXT NOT NULL, source_revision TEXT NOT NULL,
        fragment_ordinal INTEGER NOT NULL,
        binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
        operation_json TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connector_publication_attempt (
        operation_id TEXT NOT NULL, attempt INTEGER NOT NULL, receipt_json TEXT,
        PRIMARY KEY(operation_id, attempt)
      );
      CREATE INDEX IF NOT EXISTS connector_publication_pending
        ON connector_publication_operation(binding_id, binding_revision, ordinal)
        WHERE state IN ('pending','dispatching','unknown','not-applied');
      CREATE INDEX IF NOT EXISTS connector_publication_open_state
        ON connector_publication_operation(binding_id, binding_revision, state, ordinal)
        WHERE state IN ('pending','dispatching','unknown','not-applied');
      CREATE INDEX IF NOT EXISTS connector_publication_open_projection
        ON connector_publication_operation(binding_id, binding_revision, projection_id, ordinal)
        WHERE state IN ('pending','dispatching','unknown','not-applied');
      CREATE INDEX IF NOT EXISTS connector_publication_audit
        ON connector_publication_operation(binding_id, binding_revision, ordinal);
      CREATE INDEX IF NOT EXISTS connector_publication_question_candidate
        ON connector_publication_operation(binding_id, binding_revision, ordinal)
        WHERE json_extract(operation_json,'$.payload.kind')='question'
          AND json_extract(operation_json,'$.payload.status') IN ('pending','unconfirmed');
      CREATE INDEX IF NOT EXISTS connector_publication_projection_latest
        ON connector_publication_operation(binding_id, binding_revision, projection_id, ordinal);
      CREATE INDEX IF NOT EXISTS connector_publication_fragments
        ON connector_publication_operation(projection_id, fragment_ordinal, ordinal);
      CREATE INDEX IF NOT EXISTS connector_publication_avatar
        ON connector_publication_operation(
          json_extract(operation_json,'$.target.connectionId'),json_extract(operation_json,'$.target.application.domain'),
          json_extract(operation_json,'$.target.application.appId'),json_extract(operation_json,'$.speaker.avatar.image.sha256'),ordinal DESC)
        WHERE json_array_length(json_extract(operation_json,'$.avatarUploads'))>0;
      CREATE INDEX IF NOT EXISTS connector_publication_query_pending
        ON connector_publication_operation(binding_id,binding_revision,ordinal)
        WHERE json_extract(operation_json,'$.queryPending')=1;
      CREATE INDEX IF NOT EXISTS connector_publication_portrait_pending
        ON connector_publication_operation(binding_id,binding_revision,ordinal)
        WHERE json_extract(operation_json,'$.portrait.state') IN ('pending','dispatching','unknown');
      CREATE INDEX IF NOT EXISTS connector_publication_portrait_source
        ON connector_publication_operation(json_extract(operation_json,'$.avatarSource.operationId'),binding_id,binding_revision)
        WHERE json_extract(operation_json,'$.portrait.state')='pending';
      CREATE INDEX IF NOT EXISTS connector_publication_card_preparation
        ON connector_publication_operation(binding_id,binding_revision)
        WHERE json_extract(operation_json,'$.cardPreparation.receipt.state')='dispatching';
      CREATE INDEX IF NOT EXISTS connector_publication_query_turn
        ON connector_publication_operation(binding_id,binding_revision,
          json_extract(operation_json,'$.queryTurn.record.source.providerId'),
          json_extract(operation_json,'$.queryTurn.record.source.nativeSessionId'),json_extract(operation_json,'$.queryTurn.turnId'))
        WHERE json_extract(operation_json,'$.payload.kind')='query-feedback' AND json_extract(operation_json,'$.payload.stage')='started';
      CREATE INDEX IF NOT EXISTS connector_publication_binding_notice
        ON connector_publication_operation(ordinal)
        WHERE json_extract(operation_json,'$.payload.kind')='binding-lifecycle'
          AND state IN ('pending','dispatching','unknown');
    `)
    if (!database.prepare('PRAGMA table_info(connector_publication_decision)').all().some(c => c.name === 'decision_json'))
      database.exec('ALTER TABLE connector_publication_decision ADD COLUMN decision_json TEXT')
    database.exec(`CREATE INDEX IF NOT EXISTS connector_publication_content ON connector_publication_decision(binding_id,binding_revision)
      WHERE json_extract(decision_json,'$.kind')='origin' OR (json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved');
      DROP INDEX IF EXISTS connector_publication_content_gap;
      CREATE INDEX IF NOT EXISTS connector_publication_recoverable_gap ON connector_publication_decision(binding_id,binding_revision)
        WHERE ${recoverableGapPredicate};
      CREATE INDEX IF NOT EXISTS connector_publication_gap_part ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.gap.part'))
        WHERE json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved';
      CREATE INDEX IF NOT EXISTS connector_publication_gap_source ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.sourceKey'))
        WHERE json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved';
      CREATE INDEX IF NOT EXISTS connector_publication_gap_record ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.gap.part.record'))
        WHERE json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved';
      CREATE INDEX IF NOT EXISTS connector_publication_intent_projection ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.projectionId'))
      WHERE json_extract(decision_json,'$.kind') IN ('representation','legacy-representation');
      CREATE INDEX IF NOT EXISTS connector_publication_intent_record ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.part.record'))
      WHERE json_extract(decision_json,'$.kind')='representation';
      CREATE INDEX IF NOT EXISTS connector_publication_public_input ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.publicInputKey'))
      WHERE json_extract(decision_json,'$.kind')='representation' AND json_type(decision_json,'$.publicInputKey')='object';
      CREATE INDEX IF NOT EXISTS connector_publication_input_alias ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.inputAlias.key'))
      WHERE json_extract(decision_json,'$.kind')='gap' AND json_type(decision_json,'$.inputAlias.key')='object';
      CREATE INDEX IF NOT EXISTS connector_publication_input_alias_record ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.inputAlias.record'))
      WHERE json_extract(decision_json,'$.kind')='gap' AND json_type(decision_json,'$.inputAlias.key')='object';
      CREATE INDEX IF NOT EXISTS connector_publication_reply_turn ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.kind'),json_extract(decision_json,'$.turnKey'))
        WHERE json_extract(decision_json,'$.kind') IN ('reply-fact','reply-projection');
      CREATE INDEX IF NOT EXISTS connector_publication_reply_record ON connector_publication_decision(binding_id,binding_revision,json_extract(decision_json,'$.kind'),json_extract(decision_json,'$.recordKey'))
        WHERE json_extract(decision_json,'$.kind') IN ('reply-fact','reply-projection');`)

    try { database.exec(`CREATE INDEX IF NOT EXISTS connector_publication_context_message
      ON connector_publication_operation(
        json_extract(operation_json,'$.target.application.domain'),json_extract(operation_json,'$.target.application.appId'),
        json_extract(operation_json,'$.target.externalConversationId'),json_extract(operation_json,'$.reference.hostId'),
        json_extract(operation_json,'$.reference.agentSessionId'),json_extract(operation_json,'$.reference.source.providerId'),
        json_extract(operation_json,'$.reference.source.nativeSessionId'),json_extract(operation_json,'$.mapping.messageId'))
      WHERE state='confirmed' AND json_extract(operation_json,'$.effect')='upsert';`) }
    catch { /* This optional observation must not prevent original input or Outbox ownership. Exact lookup reports it. */ }
    this.decisionWrite = database.prepare('INSERT INTO connector_publication_decision (binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(binding_id,binding_revision,source_key,record_id,source_revision) DO UPDATE SET reason=excluded.reason,decision_json=excluded.decision_json')
  }
  private transaction<T>(action: () => T): T {
    let begun = false
    try { this.database.exec('BEGIN IMMEDIATE'); begun = true; const result = action(); this.database.exec('COMMIT'); return result }
    catch (error) {
      try { if (begun) this.database.exec('ROLLBACK') } catch { /* An unconfirmed commit is inspected through its original operation and frontier. */ }
      if (error instanceof AgentMuxError) throw error
      throw new AgentMuxError('Publication storage could not confirm the original page. Inspect its retained frontier and operations.', 'PUBLICATION_STORAGE_UNCONFIRMED')
    }
  }
  private read(row: Record<string, unknown> | undefined): PublicationOperation | null {
    return row ? { ...JSON.parse(row.operation_json as string), state: row.state as PublicationState } : null
  }
  inspect(operationId: string): PublicationOperation | null {
    return this.read(this.database.prepare('SELECT operation_json, state FROM connector_publication_operation WHERE operation_id=?').get(operationId))
  }
  /** Only original confirmed messages wholly sourced from this native conversation are already known.
   * Captured/relay/mixed or missing source facts remain useful context; no body or bot name is inspected. */
  knownContextMessages(recipient: PublicationContextRecipient, messageIds: readonly string[]): ReadonlySet<string> {
    const known = new Set<string>()
    if (!messageIds.length) return known
    const read = this.database.prepare(`SELECT candidate.value AS message_id FROM json_each(?) candidate WHERE EXISTS (
      SELECT 1 FROM connector_publication_operation original INDEXED BY connector_publication_context_message
      WHERE original.state='confirmed' AND json_extract(original.operation_json,'$.effect')='upsert'
        AND json_extract(original.operation_json,'$.target.application.domain')=? AND json_extract(original.operation_json,'$.target.application.appId')=?
        AND json_extract(original.operation_json,'$.target.externalConversationId')=? AND json_extract(original.operation_json,'$.reference.hostId')=?
        AND json_extract(original.operation_json,'$.reference.agentSessionId')=? AND json_extract(original.operation_json,'$.reference.source.providerId')=?
        AND json_extract(original.operation_json,'$.reference.source.nativeSessionId')=? AND json_extract(original.operation_json,'$.mapping.messageId')=candidate.value
        AND json_extract(original.operation_json,'$.reference.source.kind')='native'
        AND json_extract(original.operation_json,'$.payload.relay') IS NULL
        AND json_type(original.operation_json,'$.sourceRecords')='array' AND json_array_length(original.operation_json,'$.sourceRecords')>0
        AND NOT EXISTS (SELECT 1 FROM json_each(original.operation_json,'$.sourceRecords') source
          WHERE json_extract(source.value,'$.hostId') IS NOT ? OR json_extract(source.value,'$.agentSessionId') IS NOT ?
            OR json_extract(source.value,'$.source.kind') IS NOT 'native' OR json_extract(source.value,'$.source.providerId') IS NOT ?
            OR json_extract(source.value,'$.source.nativeSessionId') IS NOT ?))`)
    for (let offset = 0; offset < messageIds.length; offset += 100) {
      for (const row of read.all(JSON.stringify(messageIds.slice(offset, offset + 100)), recipient.application.domain, recipient.application.appId,
        recipient.externalConversationId, recipient.hostId, recipient.agentSessionId, recipient.source.providerId, recipient.source.nativeSessionId,
        recipient.hostId, recipient.agentSessionId, recipient.source.providerId, recipient.source.nativeSessionId)) known.add(String(row.message_id))
    }
    return known
  }
  /** Called only after the original ingress/admission owner authorizes this exact query. */
  queueQueryReceived(boundary: PublicationBoundary, query: import('@agentmux/core/connections').ConnectionIngressMessage, directBinding?: RoomBinding): void {
    queueQueryFeedback(this, boundary, query, 'received', directBinding)
  }
  queryReceived(boundary: PublicationBoundary, ingressId: string): PublicationOperation | null {
    return this.inspect(queryFeedbackOperationId(boundary, ingressId, 'received'))
  }
  queryInputPosition(boundary: PublicationBoundary) { return queryInputPosition(this, boundary) }
  queryInputPending(boundary: PublicationBoundary, after: number, through?: number) { return queryInputPending(this, boundary, after, through) }
  commitQueryInputPage(boundary: PublicationBoundary, after: QueryInputPosition | null, page: import('@agentmux/core').AgentInputChangesPage, authorized: () => boolean): void {
    this.transaction(() => { if (!authorized()) throw Error('Original query audience unavailable'); queryInputPage(this, boundary, after, page) })
  }
  commitQueryInputReceipt(boundary: PublicationBoundary, original: PublicationOperation, inspection: import('@agentmux/core/connections').ConnectionIngressInspection, authorized: () => boolean): void {
    this.transaction(() => { if (!authorized()) throw Error('Original query audience unavailable'); queryInputReceipt(this, boundary, original, inspection) })
  }
  /** A new relationship boundary skips only ordinary effects that never crossed the dispatch boundary. */
  retireBindingPending(boundary: RoomBinding): void {
    for (const row of this.database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND state='pending' AND json_extract(operation_json,'$.reference.source.kind') IN ('native','captured','ingress') AND json_extract(operation_json,'$.attempt') IS NULL").all(...scopeKey(boundary))) {
      this.write({ ...this.read(row)!, state: 'cancelled', reason: 'binding-revised' })
    }
  }
  /** Called synchronously inside the original Binding transaction, before it publishes its applied receipt. */
  queueBindingNotice(bindingOperationId: string, boundary: RoomBinding, event: BindingLifecyclePayload['event'], synchronization: boolean | null): string {
    const projectionId = 'binding-notice-' + digest([bindingOperationId, event, ...scopeKey(boundary)])
    const operationId = 'publication-' + digest(projectionId)
    const existing = this.inspect(operationId)
    if (existing) return existing.operationId
    const payload: BindingLifecyclePayload = { kind: 'binding-lifecycle', event, agentSessionId: boundary.agentSessionId, scope: boundary.scope, synchronization }
    const operation: PublicationOperation = {
      operationId, projectionId, sourceRevision: digest(payload), bindingId: boundary.bindingId, bindingRevision: boundary.revision,
      reference: { ...ref(boundary), source: { kind: 'binding-operation', operationId: bindingOperationId, event } },
      target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
      publicationScope: boundary.scope.publication, presentationTime: Date.now(), payload, effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending'
    }
    this.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
      .run(operationId, projectionId, operation.sourceRevision, 0, boundary.bindingId, boundary.revision, encode(operation), 'pending')
    return operationId
  }
  /** Only unfinished notice effects participate in recovery; historical conversation data is not scanned. */
  pendingBindingNotices(): PublicationOperation[] {
    return this.database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE json_extract(operation_json,'$.payload.kind')='binding-lifecycle' AND state IN ('pending','dispatching','unknown') ORDER BY ordinal")
      .all().map(row => this.read(row)!)
  }
  list(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, limit = 30, after?: string, order: 'oldest' | 'newest' = 'oldest'): PublicationOperation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentMuxError('Publication pages require a limit from 1 to 100.', 'INVALID_PUBLICATION_REQUEST')
    const cursor = after === undefined ? undefined : this.database.prepare('SELECT ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND operation_id=?')
      .get(boundary.bindingId, boundary.revision, after)
    if (after !== undefined && !cursor) throw new AgentMuxError('The publication cursor belongs to another audience or operation.', 'INVALID_PUBLICATION_REQUEST')
    const direction = order === 'newest' ? 'DESC' : 'ASC', comparison = order === 'newest' ? '<' : '>'
    return this.database.prepare(`SELECT operation_json, state FROM connector_publication_operation WHERE binding_id=? AND binding_revision=?${cursor ? ` AND ordinal${comparison}?` : ''} ORDER BY ordinal ${direction} LIMIT ?`)
      .all(boundary.bindingId, boundary.revision, ...(cursor ? [cursor.ordinal!] : []), limit).map(row => this.read(row)!)
  }
  retainedCheckpoint(boundary: PublicationBoundary): ConversationCheckpoint | null {
    const saved = this.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?').get(...scopeKey(boundary), 'unified')
    return saved ? parseConversationCheckpoint(JSON.parse(String(saved.checkpoint_json)), ref(boundary)) : null
  }
  /** Lift frozen cuts, or the explicitly authorized creation's first real native origin. Never replace a saved cut. */
  checkpoint(boundary: PublicationBoundary, sourceHostId: string, origin?: ConversationCheckpoint): ConversationCheckpoint {
    return this.transaction(() => {
      const query = this.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?')
      this.retainMissingCapturedStart(boundary)
      const saved = this.retainedCheckpoint(boundary)
      if (saved) {
        const checkpoint = saved
        if (checkpoint.sourceHostId !== sourceHostId) throw new AgentMuxError('The retained source namespace changed.', 'PUBLICATION_SOURCE_CONFLICT')
        return checkpoint
      }
      if (boundary.publicationOrigin && (!origin || origin.frontier.cuts.length !== 1 || origin.frontier.cuts[0]?.kind !== 'native') || origin && !boundary.publicationOrigin)
        throw new AgentMuxError('This conversation has no accepted native beginning yet. Input and the original creation remain available.', 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE')
      const initial: ConversationCheckpoint = origin ?? boundary.sourceFrontier ?? {
        ...ref(boundary), sourceHostId, frontier: { hostId: sourceHostId, agentSessionId: boundary.agentSessionId,
          scope: { sources: boundary.sourceCheckpoints.map(c => ({ kind: 'native' as const, ...c.source })) },
          cuts: boundary.sourceCheckpoints.map(c => {
            const original = query.get(...scopeKey(boundary), sourceKey(c.source))
            return { kind: 'native' as const, checkpoint: original ? JSON.parse(String(original.checkpoint_json)) : c }
          }) }
      }
      const checkpoint = parseConversationCheckpoint(initial, ref(boundary))
      if (checkpoint.sourceHostId !== sourceHostId) throw new AgentMuxError('The original Binding belongs to another source namespace.', 'PUBLICATION_SOURCE_CONFLICT')
      this.database.prepare('INSERT INTO connector_publication_frontier VALUES (?, ?, ?, ?)').run(...scopeKey(boundary), 'unified', encode(checkpoint))
      return checkpoint
    })
  }
  private retainMissingCapturedStart(boundary: PublicationBoundary): void {
    if (boundary.sourceFrontier?.frontier.cuts.some(cut => cut.kind === 'captured')) return
    const gap: ConnectionDeliveryGap = { gapId: 'gap-' + digest([...scopeKey(boundary), 'captured-start']), reason: 'start-cut-unconfirmed', code: 'PUBLICATION_CAPTURED_START_UNCONFIRMED' }
    this.saveDecision(boundary, gap.gapId, digest(gap), { kind: 'gap', gap, state: 'unresolved' })
  }
  private saveDecision(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, id: string, revision: string, value: unknown): void {
    this.decisionWrite.run(...scopeKey(boundary), 'unified', id, revision, 'content-accounted', encode(value))
  }
  /** Reuse only this accepted original part's exact derived image; no second resource cache. */
  retainedDiagram(boundary: PublicationBoundary, part: ConversationContentRef, text: string,
    textSha256: string, start: number, end: number): PublicationImage | undefined {
    const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current'")
      .get(...scopeKey(boundary), 'part-' + digest(publicationPartKey(part)))
    if (!row) return
    const value = JSON.parse(String(row.decision_json)) as RepresentationIntent
    if (value.kind !== 'representation' || !same(value.part, part) || value.text !== text) return
    return value.segments?.find(segment => {
      const derived = segment.image?.derivation
      return derived?.kind === 'mermaid' && derived.textSha256 === textSha256 && derived.start === start && derived.end === end
    })?.image
  }
  /** Reuse only a complete representation of this exact accepted part version. */
  retainedResource(boundary: PublicationBoundary, part: ConversationContentRef, textResource = false): ResolvedPublicationPart | undefined {
    const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current'")
      .get(...scopeKey(boundary), 'part-' + digest(publicationPartKey(part)))
    if (!row) return
    const value = JSON.parse(String(row.decision_json)) as RepresentationIntent
    if (value.kind !== 'representation' || !same(value.part, part)) return
    if (!value.image && !value.file && !value.segments && !textResource) return
    const gap = this.database.prepare("SELECT 1 FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved' AND json_extract(decision_json,'$.gap.part')=? LIMIT 1")
      .get(...scopeKey(boundary), encode(part))
    if (gap) return
    return value.image ? { kind: 'image', image: value.image } : value.file ? { kind: 'file', file: value.file }
      : value.segments ? { kind: 'markdown', text: value.text, segments: value.segments, complete: true } : textResource ? { kind: 'text', text: value.text } : undefined
  }
  private representationRows(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId: string, records: readonly ConversationItemRef[] = []): RepresentationRow[] {
    const rows: RepresentationRow[] = this.database.prepare("SELECT rowid,record_id,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND json_extract(decision_json,'$.kind') IN ('representation','legacy-representation') AND json_extract(decision_json,'$.projectionId')=? ORDER BY rowid")
      .all(...scopeKey(boundary), projectionId).map(row => ({ ordinal: Number(row.rowid), id: String(row.record_id), value: JSON.parse(String(row.decision_json)) }))
    // Core content is grouped by original record: primary first, then its accepted
    // contributors. A newly recovered part must not acquire its position from rowid.
    const order = new Map<string, number>(), groups = new Map<string, RepresentationRow[]>()
    for (const record of records) { const id = conversationRecordId(record); if (!order.has(id)) order.set(id, order.size) }
    for (const row of rows) {
      const value = row.value, id = conversationRecordId(value.kind === 'representation' ? value.part.record : value.record)
      const group = groups.get(id) ?? []; group.push(row); groups.set(id, group)
    }
    const known = [...groups].filter(([id]) => order.has(id)).sort(([a], [b]) => order.get(a)! - order.get(b)!)
    let next = 0
    return [...groups].flatMap(([id, original]) => {
      // Unread contributor groups keep their accepted relative positions.
      const group = order.has(id) ? known[next++]![1] : original
      const index = (row: RepresentationRow) => row.value.kind === 'representation' && row.value.part.selector.kind === 'native-part' ? row.value.part.selector.partIndex : undefined
      return group.every(row => index(row) !== undefined) ? group.sort((a, b) => index(a)! - index(b)!) : group
    })
  }
  /** Retain original platform intent, not a fabricated version of a Core record. */
  private retainLegacyRepresentation(boundary: PublicationBoundary, projectionId: string): void {
    if (this.representationRows(boundary, projectionId).length) return
    const operations = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE projection_id=? GROUP BY fragment_ordinal) ORDER BY fragment_ordinal')
      .all(projectionId).map(row => this.read(row)!).filter(operation => operation.effect === 'upsert' && operation.state !== 'cancelled' && operation.payload.kind === 'speech')
    if (!operations.length) return
    const reference = operations[0]!.reference
    if (reference.source.kind !== 'native' && reference.source.kind !== 'captured') return
    this.saveDecision(boundary, 'legacy-' + digest(projectionId), 'current', { kind: 'legacy-representation', projectionId, record: { ...reference, source: reference.source },
      operations: operations.map(operation => operation.operationId), text: operations.map(operation => publicationSpeechText(operation.payload as Extract<PublicationPayload, { kind: 'speech' }>)).join('') } satisfies LegacyRepresentationIntent)
  }
  /** Only accepted exact slots replace intent. Unread or unresolved parts keep their prior representation. */
  private materialize(boundary: PublicationBoundary, projectionId: string, unit: ConversationUnit, plan: PublicationContentPlan, coalesced: readonly string[], selected?: ConversationContentRef, records: readonly ConversationItemRef[] = [unit.event.reference!, ...unit.records.map(record => record.reference!)]): MaterializedPlan {
    for (const original of [projectionId, ...coalesced]) {
      this.retainLegacyRepresentation(boundary, original)
      if (original !== projectionId) for (const row of this.representationRows(boundary, original))
        this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...row.value, projectionId }), row.ordinal)
    }
    const covered = new Set(unit.records.filter(isCompleteConversationRecord).map(record => record.id)), blocked = new Set(plan.gaps.flatMap(gap => gap.part ? [conversationRecordId(gap.part.record)] : []))
    const pieces = new Map(plan.pieces.map(piece => [publicationPartKey(piece.part), piece])), preserveLegacy = new Set<string>(), preserveResources = new Set<string>()
    for (const row of this.representationRows(boundary, projectionId)) {
      const value = row.value, recordId = conversationRecordId(value.kind === 'representation' ? value.part.record : value.record)
      if (!covered.has(recordId)) continue
      if (selected && (value.kind === 'legacy-representation' || publicationPartKey(value.part) !== publicationPartKey(selected))) continue
      if (value.kind === 'legacy-representation') {
        if (blocked.has(recordId)) { preserveLegacy.add(recordId); continue }
      } else if (plan.gaps.some(gap => gap.part && publicationPartKey(gap.part) === publicationPartKey(value.part))) {
        if (value.image || value.file || value.segments?.some(segment => segment.image)) preserveResources.add(publicationPartKey(value.part))
        continue
      }
      else if (pieces.has(publicationPartKey(value.part))) continue
      // A complete accepted original record proves which selectors are present.
      // Missing records and failed resources never authorize this removal.
      this.database.prepare('DELETE FROM connector_publication_decision WHERE rowid=?').run(row.ordinal)
    }
    for (const piece of plan.pieces) {
      if (preserveLegacy.has(conversationRecordId(piece.part.record)) || preserveResources.has(publicationPartKey(piece.part))) continue
      this.saveDecision(boundary, 'part-' + digest(publicationPartKey(piece.part)), 'current', { kind: 'representation', projectionId, ...piece } satisfies RepresentationIntent)
    }
    const rows = this.representationRows(boundary, projectionId, records)
    const sources = rows.flatMap(row => row.value.kind === 'representation' && row.value.text && row.value.relay ? [row.value.relay] : [])
    return { ...plan, ...(rows.some(row => row.value.kind === 'representation' && (row.value.image || row.value.file || row.value.segments)) ? { resourceParts: rows.map(row => row.value) } : {}), text: rows.map(row => row.value.text).filter(Boolean).join('\n\n'), ...(sources.length ? { relay: { sender: 'application', sources } } : {}) }
  }
  coverage(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, limit = 30, after?: string): ConnectionDeliveryCoverage {
    const pending = "json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved'"
    const live = `(json_extract(decision_json,'$.kind')='origin' OR (${pending}))`
    const afterRow = after === undefined ? undefined : this.database.prepare('SELECT rowid FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND record_id=? AND source_key=?').get(...scopeKey(boundary), after, 'unified')
    if (after !== undefined && !afterRow) throw new AgentMuxError('Content cursor belongs to another exact Binding.', 'INVALID_PUBLICATION_REQUEST')
    const rows = this.database.prepare(`SELECT record_id,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND ${live} AND rowid>? ORDER BY rowid LIMIT ?`).all(...scopeKey(boundary), Number(afterRow?.rowid ?? 0), limit + 1)
    const entries: typeof rows = []; let bytes = 0
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(String(row.decision_json))
      if (entries.length && bytes + size > 3 * 1024 * 1024) break
      bytes += size; entries.push(row)
    }
    const gaps: ConnectionDeliveryCoverage['gaps'] = [], origins: ConnectionDeliveryCoverage['origins'] = []
    for (const row of entries) { const d = JSON.parse(String(row.decision_json)); if (d.kind === 'gap') gaps.push(d.gap); else origins.push(d.representation) }
    const incomplete = this.database.prepare(`SELECT 1 FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND ${pending} LIMIT 1`).get(...scopeKey(boundary))
    return parseConnectionDeliveryCoverage({ state: incomplete ? 'incomplete' : 'complete', gaps, origins,
      nextContent: rows.length > entries.length ? String(entries.at(-1)!.record_id) : null })
  }
  private origin(boundary: PublicationBoundary, unit: ConversationUnit, recordId: string) {
    const r = unit.records.find(r => r.id === recordId), item = r?.original.kind === 'captured' ? r.original.item : undefined, author = item?.authorExternal
    if (!author || item?.publicContent !== 'confirmed' || item.kind !== 'user_message' || item.source !== 'user') return
    try {
      if (!this.publicationMember(boundary, author.bindingId, author.bindingRevision)) return
      const row = this.database.prepare('SELECT record_json FROM connection_ingress_message WHERE domain=? AND app_id=? AND message_id=?')
        .get(boundary.application.domain, boundary.application.appId, author.externalMessageId)
      if (!row) return
      const ingress = JSON.parse(String(row.record_json))
      const target = ingress.group?.target
      if (target && target.hostId === boundary.executionHostId && target.agentSessionId === boundary.agentSessionId && target.connectionId === boundary.connectionId && target.bindingId === boundary.bindingId && target.bindingRevision === author.bindingRevision &&
        r?.reference?.source.kind === 'captured' && r.reference.source.recordId === item.id && item.id === externalConversationRecordId(author) && ingress.body === item.content &&
        same(externalConversationAuthor(author), { kind: 'external', connectionId: target.connectionId, actor: ingress.actor, externalConversationId: ingress.externalConversationId, externalMessageId: ingress.externalMessageId, bindingId: target.bindingId, bindingRevision: target.bindingRevision, ...(target.authoritySource ? { authoritySource: target.authoritySource } : {}) })) {
        return { connectionId: boundary.connectionId, externalConversationId: boundary.externalConversationId, externalMessageId: author.externalMessageId }
      }
      if (item.inputRef?.kind !== 'message') return
      if (ingress.externalConversationId !== boundary.externalConversationId || ingress.input?.hostId !== boundary.executionHostId || ingress.input?.agentSessionId !== boundary.agentSessionId || item.inputRef.agentSessionId !== ingress.input.agentSessionId || item.inputRef.messageId !== ingress.input.messageId || !same(item.inputRef.expectedRun, ingress.input.expectedRun) || !same(ingress.input.author, author) || ingress.state === 'refused') return
      // Core's original input writer records this exact Input key, author and
      // public-content boundary together. Ordinary content edits remove the key
      // and boundary; retained revisions keep their original facts. Today's
      // formatter cannot qualify or invalidate the original accepted wire.
      return { connectionId: boundary.connectionId, externalConversationId: boundary.externalConversationId, externalMessageId: author.externalMessageId }
    } catch { return }
  }
  /** Original intake configuration stays intact; only its publication association is resolved. */
  publicationMember(boundary: PublicationBoundary, bindingId: string, revision: number): boolean {
    if (bindingId !== boundary.bindingId) return false
    if (revision === boundary.revision) return true
    const original = this.bindings?.readExact(bindingId, revision)
    return !!original && sameRoomPublication(original, boundary)
  }
  /** Complete units, exact gaps and their next read frontier commit in the original outbox transaction. */
  commitPage(boundary: PublicationBoundary, after: ConversationCheckpoint, value: ConversationChangesPage, authorized: () => boolean, options: PublicationPageOptions): void {
    const page = parseConversationChangesPageForWindow(value, { ...ref(boundary), checkpoint: after, limit: 100, maxBytes: value.budgetBytes })
    const units = parseConversationUnitsForPage(options.units, page)
    const decisions = units.map(unit => ({ unit, plan: publicationContent(unit, boundary, page.checkpoint, { resolved: options.resolvedText, origin: id => this.origin(boundary, unit, id), ...(options.speakers?.has(unit.event.id) ? { attributed: true } : {}) }) }))
    const questionRecords = units.flatMap(unit => unit.records.flatMap(record => {
      const reference = record.reference
      if (record.original.kind !== 'native' || reference?.source.kind !== 'native') return []
      const source = { providerId: reference.source.providerId, nativeSessionId: reference.source.nativeSessionId }
      return (record.original.item.questionRequest?.questions ?? []).flatMap(question => {
        const identity = conversationQuestionIdentity({ ...reference, source }, question.id)
        return identity ? [{ question: identity, record: reference, recordRevision: record.revision }] : []
      })
    }))
    const questionsRead = new Set(questionRecords.map(record => encode(record.question)))
    this.transaction(() => {
      if (!authorized()) throw new AgentMuxError('This exact Binding no longer authorizes publication.', 'PUBLICATION_NOT_AUTHORIZED')
      const row = this.database.prepare('SELECT checkpoint_json FROM connector_publication_frontier WHERE binding_id=? AND binding_revision=? AND source_key=?').get(...scopeKey(boundary), 'unified')
      if (!row || !same(JSON.parse(String(row.checkpoint_json)), after)) throw new AgentMuxError('The retained publication frontier changed.', 'PUBLICATION_CHECKPOINT_CONFLICT')
      this.retainMissingCapturedStart(boundary)
      if (options.queryFeedback) projectQueryFeedback(this, boundary, units, options.queryAuthorized)
      const replyProjections = options.replyMetadata ? this.acceptReplyFacts(boundary, units) : []
      for (const original of questionRecords) this.saveDecision(boundary, 'question-read-' + digest(original.question), 'current', { kind: 'question-read', ...original })
      for (const coverage of page.coverage) {
        const key = conversationSourceKey(coverage.source)
        const rows = this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved' AND json_extract(decision_json,'$.sourceKey')=?").all(...scopeKey(boundary), key)
        for (const row of rows) {
          const d = JSON.parse(String(row.decision_json))
          if (d.sourceKey !== key) continue
          const gap = d.gap as ConnectionDeliveryGap
          // Coverage is the current read window. An empty or unrelated window
          // does not prove that an earlier recorded relation has been closed.
          const targetRead = gap.record && ['CONVERSATION_ANCHOR_UNREAD', 'CONVERSATION_OBSERVED_TARGET_UNREAD'].includes(gap.code ?? '') && units.some(unit => unit.records.some(record => record.id === conversationRecordId(gap.record!)))
          const sourceRecovered = !gap.record && !gap.code?.startsWith('CONVERSATION_') && coverage.current === 'complete-through-cut' && !coverage.gaps.length
          // An original answer's typed targets, not its current text/version,
          // survive separate read pages and reopen in this same decision.
          const questionReads = d.questionReads as QuestionReadWitness[] | undefined
          const accepted = questionReads && acceptQuestionReads(questionReads, questionsRead)
          if (targetRead || sourceRecovered || accepted && !same(accepted, questionReads)) this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...d,
            ...(accepted ? { questionReads: accepted } : {}), state: targetRead || sourceRecovered || accepted && questionReadsComplete(accepted) ? 'resolved' : 'unresolved' }), Number(row.rowid))
        }
        for (const original of coverage.gaps) {
          const gap: ConnectionDeliveryGap = { gapId: 'gap-' + digest([...scopeKey(boundary), key, original.code, original.record]), reason: 'source-gap', source: coverage.source, code: original.code, ...(original.record ? { record: original.record } : {}) }
          const revision = digest(original)
          if (original.code === 'CONVERSATION_QUESTION_TARGET_UNREAD' && original.record) {
            const prior = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision=?").get(...scopeKey(boundary), gap.gapId, revision)
            const previous = prior ? JSON.parse(String(prior.decision_json)) : undefined
            // Historical decisions without frozen targets cannot acquire proof
            // from a later answer version. Preserve their original unknown.
            if (previous && !previous.questionReads) continue
            const record = units.flatMap(unit => unit.records).find(record => record.id === conversationRecordId(original.record!))
            const targets = units.flatMap(unit => unit.event.relations.flatMap(relation => relation.kind === 'answers' && same(relation.from, original.record) ? [relation.question] : []))
            let witnesses: QuestionReadWitness[] = previous?.questionReads ?? []
            if (record && targets.length && !witnesses.some(witness => witness.recordRevision === record.revision)) {
              const originalTargets = [...new Map(targets.map(target => [encode(target), target])).values()]
              const read = originalTargets.flatMap(target => {
                const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current'")
                  .get(...scopeKey(boundary), 'question-read-' + digest(target))
                const accepted = row ? JSON.parse(String(row.decision_json)) : undefined
                return accepted?.kind === 'question-read' && same(accepted.question, target) ? [encode(target)] : []
              })
              witnesses = [...witnesses, { recordRevision: record.revision, targets: originalTargets, read }]
            }
            if (witnesses.length) {
              witnesses = acceptQuestionReads(witnesses, questionsRead)
              this.saveDecision(boundary, gap.gapId, revision, { kind: 'gap', state: questionReadsComplete(witnesses) ? 'resolved' : 'unresolved', sourceKey: key, gap, questionReads: witnesses })
              continue
            }
          }
          this.saveDecision(boundary, gap.gapId, revision, { kind: 'gap', state: 'unresolved', sourceKey: key, gap })
        }
      }
      for (const decision of decisions) {
        const { unit } = decision
        let plan = decision.plan
        const references = [unit.event.reference!, ...unit.records.map(r => r.reference!)]
        const keys = references.map(reference => 'projection-' + digest([...scopeKey(boundary), ...(reference.source.kind === 'native' ? [reference.source.providerId, reference.source.nativeSessionId, reference.source.recordId, 'speech'] : ['captured', reference.source.recordId, 'conversation'])]))
        const eventIds = [unit.event.id, ...(unit.event.coalesces ?? []).flatMap(edge => edge.fromEventIds)]
        const represented = eventIds.flatMap(id => {
          const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND json_extract(decision_json,'$.kind')='event-representation' ORDER BY rowid DESC LIMIT 1").get(...scopeKey(boundary), 'event-' + digest(id))
          return row ? [JSON.parse(String(row.decision_json)).projectionId as string] : []
        })
        const allowedEvents = new Set(eventIds), qualification = new Map<string, boolean>()
        const qualified = (projectionId: string) => {
          if (qualification.has(projectionId)) return qualification.get(projectionId)!
          const original = this.latestProjection(projectionId) ?? this.latestProjection(projectionId + '-failure')
          const accepted = !original || (original.event ? allowedEvents.has(original.event.id) : (original.reference.source.kind === 'native' || original.reference.source.kind === 'captured') && references.some(reference => conversationRecordId(reference) === conversationRecordId(original.reference as ConversationItemRef)))
          qualification.set(projectionId, accepted); return accepted
        }
        const ambiguous = new Set<string>()
        for (const record of unit.records) {
          const prior = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='representation' AND json_extract(decision_json,'$.part.record')=?")
            .all(...scopeKey(boundary), encode(record.reference))
          const retainedFailure = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current' AND json_extract(decision_json,'$.kind')='failure-record'").get(...scopeKey(boundary), 'failure-record-' + digest(record.reference))
          if (retainedFailure && !qualified(JSON.parse(String(retainedFailure.decision_json)).projectionId)) ambiguous.add(record.id)
          if (prior.some(row => { const intent = JSON.parse(String(row.decision_json)) as RepresentationIntent; return intent.text && !qualified(intent.projectionId) })) ambiguous.add(record.id)
        }
        if (ambiguous.size) {
          const gaps = unit.records.filter(record => ambiguous.has(record.id)).map(record => {
            const slot = unit.event.content.find(slot => slot.recordId === record.id)
            return { gapId: record.id, reason: 'source-gap' as const, code: 'PUBLICATION_REPRESENTATION_RELATION_UNCONFIRMED', record: record.reference!, event: { id: unit.event.id, revision: unit.event.revision },
              ...(slot ? { part: { record: record.reference!, recordRevision: record.revision, selector: slot.selector } } : {}), anchor: { record: record.reference!, revision: record.revision, frontier: page.checkpoint } }
          })
          const { failure: _unconfirmedFailure, ...acceptedPlan } = plan
          plan = { ...acceptedPlan, pieces: plan.pieces.filter(piece => !ambiguous.has(conversationRecordId(piece.part.record))),
            origins: plan.origins.filter(origin => !ambiguous.has(conversationRecordId(origin.part.record))), gaps: [...plan.gaps, ...gaps], complete: false }
        }
        const existing = [...new Set([...keys.filter(key => this.latestProjection(key) || this.latestProjection(key + '-failure')), ...represented])].filter(qualified)
        const projectionId = existing[0] ?? keys[0]!, coalesced = existing.filter(id => id !== projectionId)
        const mappingConflict = !qualified(projectionId)
        // A later Core coalescence can be a payload no-op. Retain its exact
        // representation link in the original decision owner without rewriting
        // historical operations, prepared bytes or platform receipts.
        if (!mappingConflict) this.saveDecision(boundary, 'event-' + digest(unit.event.id), unit.event.revision, { kind: 'event-representation', event: { id: unit.event.id, revision: unit.event.revision }, records: references, projectionId })
        // Resolve only decisions superseded by these accepted original versions.
        const relatedGaps = unit.records.flatMap(record => this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved' AND json_extract(decision_json,'$.gap.part.record')=?").all(...scopeKey(boundary), encode(record.reference)))
        for (const row of relatedGaps) {
          const d = JSON.parse(String(row.decision_json))
          if (plan.gaps.some(gap => same(gap.part, d.gap.part) && same(gap.event, d.gap.event) && (gap.reason === d.gap.reason || gap.reason === 'resource-unavailable' && d.gap.reason === 'version-unavailable'))) continue
          if (d.kind === 'gap' && !d.inputAlias && d.gap.part && !ambiguous.has(conversationRecordId(d.gap.part.record)) && unit.records.some(r => r.id === conversationRecordId(d.gap.part.record))) this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...d, state: 'resolved' }), Number(row.rowid))
        }
        this.saveDecision(boundary, 'scope-' + digest(unit.event.id), unit.event.revision, { kind: 'scope', event: { id: unit.event.id, revision: unit.event.revision }, excluded: plan.excluded })
        for (const gap of plan.gaps) {
          const stored = { ...gap, gapId: 'gap-' + digest([...scopeKey(boundary), gap.event, gap.part, gap.reason]) }
          const inputAlias = publicationInputAlias(unit, gap)
          // A replacement window does not change this missing part's original read cut.
          const retained = this.database.prepare("SELECT 1 FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision=? AND json_extract(decision_json,'$.state')='unresolved'")
            .get(...scopeKey(boundary), stored.gapId, gap.part?.recordRevision ?? unit.event.revision)
          if (retained) continue
          this.saveDecision(boundary, stored.gapId, gap.part?.recordRevision ?? unit.event.revision, { kind: 'gap', gap: stored, state: 'unresolved', ...(inputAlias ? { inputAlias } : {}) })
        }
        for (const representation of plan.origins) this.saveDecision(boundary, 'origin-' + digest(representation.part), representation.part.recordRevision, { kind: 'origin', representation })
        if (mappingConflict) continue
        const { failure: _failure, ...materialized } = this.materialize(boundary, projectionId, unit, plan, coalesced)
        // An input's transport-only observation has no new public body or receipt.
        // Keep its original captured representation instead of dropping that receipt.
        const inputWireOnly = !plan.pieces.length && unit.records.length > 0 && unit.records.every(record => isCompleteConversationRecord(record) && record.original.kind === 'native' && record.original.item.kind === 'user-message' && conversationNativeInputWitness(record)?.key !== undefined)
        if (!inputWireOnly) this.queueRepresentation(boundary, projectionId, unit, materialized, options.fragmentBytes ?? 4096, undefined, undefined,
          plan.pieces.map(piece => options.questions?.get(conversationRecordId(piece.part.record))).find(value => value !== undefined), options.fragmentText, options.speakers?.get(unit.event.id), undefined, options.replyMetadata)
        // A turn result supplements ordinary content. Its own fragment cannot replace
        // or withdraw a public answer that shares the accepted original event.
        if (plan.failure || this.latestProjection(projectionId + '-failure')) this.queueRepresentation(boundary, projectionId + '-failure', unit,
          { ...plan, text: '', pieces: [] }, options.fragmentBytes ?? 4096)
        this.projectOriginalMessages(boundary, unit, options.originals?.get(unit.event.id) ?? [], page.checkpoint, options.fragmentBytes ?? 4096, options.fragmentText)
        // Explicit Core coalescence moves only representation intent. Original
        // platform mappings retire through their normal ordered effects; an
        // unknown predecessor remains inspect-only and keeps its request bytes.
        for (const original of coalesced) {
          this.queueRepresentation(boundary, original, unit, { text: '', pieces: [], gaps: [], origins: [], excluded: [], complete: true }, options.fragmentBytes ?? 4096)
          this.queueRepresentation(boundary, original + '-failure', unit, { text: '', pieces: [], gaps: [], origins: [], excluded: [], complete: true }, options.fragmentBytes ?? 4096)
        }
      }
      this.accountInputAliases(boundary, units)
      for (const projectionId of replyProjections) this.refreshReplyMetadata(boundary, projectionId, options.fragmentText)
      this.database.prepare('UPDATE connector_publication_frontier SET checkpoint_json=? WHERE binding_id=? AND binding_revision=? AND source_key=?').run(encode(page.checkpoint), ...scopeKey(boundary), 'unified')
    })
  }
  /** A public captured span represents only its exact accepted native text wrapper. */
  private accountInputAliases(boundary: PublicationBoundary, units: readonly ConversationUnit[]): void {
    if (boundary.scope.publication !== 'future-shared-conversation') return
    const records = units.flatMap(unit => unit.records).filter(isCompleteConversationRecord), keys = new Map<string, NonNullable<RepresentationIntent['publicInputKey']>>()
    for (const record of records) {
      const key = record.original.kind === 'native' ? record.original.item.conversation?.adoptedInput?.key : record.original.item.kind === 'user_message' ? record.original.item.inputRef : undefined
      if (key) keys.set(encode(key), key)
    }
    const aliases = new Map<number, InputAliasDecision>(), witnesses = units.flatMap(unit => unit.event.inputAdoption?.witnesses ?? [])
    const collect = (rows: Record<string, unknown>[]) => { for (const row of rows) aliases.set(Number(row.rowid), JSON.parse(String(row.decision_json))) }
    for (const key of keys.keys()) collect(this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_type(decision_json,'$.inputAlias.key')='object' AND json_extract(decision_json,'$.inputAlias.key')=?").all(...scopeKey(boundary), key))
    // Include prior facts for a changed native record so Core can reject conflicting source/key updates.
    for (const record of records) if (record.original.kind === 'native' && record.reference && conversationNativeInputWitness(record)) {
      collect(this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_type(decision_json,'$.inputAlias.key')='object' AND json_extract(decision_json,'$.inputAlias.record')=?").all(...scopeKey(boundary), encode(record.reference)))
      const witness = conversationNativeInputWitness(record)
      if (witness) witnesses.push(witness)
    }
    if (!aliases.size) return
    witnesses.push(...[...aliases.values()].map(value => value.inputAlias))
    const context = mergeConversationInputAdoptionContexts(units.map(unit => ({ records: unit.records.filter(isCompleteConversationRecord), context: unit.event.inputAdoption })))
    const accepted = conversationInputAdoptionEdges(records, { ...context, witnesses })
    if (accepted.unconfirmed) return
    const byKey = new Map<string, Array<[number, InputAliasDecision]>>()
    for (const entry of aliases) if (entry[1].state === 'unresolved' && entry[1].inputAlias.key) {
      const key = encode(entry[1].inputAlias.key), group = byKey.get(key) ?? []
      group.push(entry); byKey.set(key, group)
    }
    for (const [encoded, key] of keys) {
      const related = byKey.get(encoded)
      if (!related?.length) continue
      const publicParts = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND json_extract(decision_json,'$.kind')='representation' AND json_type(decision_json,'$.publicInputKey')='object' AND json_extract(decision_json,'$.publicInputKey')=?").all(...scopeKey(boundary), encoded)
        .map(row => JSON.parse(String(row.decision_json)) as RepresentationIntent)
        .filter(part => part.purpose === 'conversation' && part.part.record.source.kind === 'captured' && part.part.selector.kind === 'captured-field' && part.part.selector.field === 'content' && same(part.publicInputKey, key))
      if (publicParts.length !== 1) continue
      for (const [ordinal, value] of related) {
        const identity = conversationInputIdentity(value.inputAlias.record.hostId, key), association = accepted.byKey.get(identity)
        if (accepted.unconfirmedKeys.has(identity) || accepted.ambiguous.has(identity) || association?.length !== 1 || !association[0]!.key || conversationRecordId(association[0]!.record) !== conversationRecordId(value.inputAlias.record)) continue
        if (publicParts[0]!.part.record.hostId !== value.inputAlias.record.hostId || publicParts[0]!.part.record.agentSessionId !== key.agentSessionId) continue
        this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...value, state: 'resolved' }), ordinal)
      }
    }
  }
  /** Small delivery witnesses live beside their original representation, not in a second history. */
  private replyProjection(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId: string): ReplyProjection | undefined {
    const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current'")
      .get(...scopeKey(boundary), 'reply-projection-' + digest(projectionId))
    return row ? JSON.parse(String(row.decision_json)) as ReplyProjection : undefined
  }
  private replySnapshot(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projection: ReplyProjection): ReplyPublicationMetadata {
    const rows = new Map<number, ReplyFact>()
    for (const [field, key] of [['recordKey', projection.recordKey], ['turnKey', projection.turnKey]] as const) {
      if (!key) continue
      for (const row of this.database.prepare(`SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=?
        AND json_extract(decision_json,'$.kind') IN ('reply-fact','reply-projection') AND json_extract(decision_json,'$.kind')='reply-fact'
        AND json_extract(decision_json,'$.${field}')=?`).all(...scopeKey(boundary), key)) rows.set(Number(row.rowid), JSON.parse(String(row.decision_json)))
    }
    const snapshot = replyMetadata(projection, [...rows.values()])
    // Retain only the contributing field witnesses, not a copy of this turn's history.
    this.saveDecision(boundary, 'reply-snapshot-' + digest([projection.projectionId, snapshot.metadata]), digest([projection, snapshot.witnesses]), { kind: 'reply-snapshot', projection, ...snapshot })
    return snapshot.metadata
  }
  private acceptReplyFacts(boundary: PublicationBoundary, units: readonly ConversationUnit[]): Set<string> {
    const projections = new Set<string>()
    for (const record of units.flatMap(unit => unit.records)) {
      if (!isCompleteConversationRecord(record)) continue
      const witness = replyRecord(record, boundary.executionHostId, boundary.agentSessionId)
      if (!witness || record.original.kind !== 'native') continue
      const id = 'reply-fact-' + digest(witness.recordKey)
      const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current'").get(...scopeKey(boundary), id)
      const prior = row ? JSON.parse(String(row.decision_json)) as ReplyFact : undefined, item = record.original.item
      if (!prior && !item.metrics && !item.turnOutcome) continue
      const fact: ReplyFact = { kind: 'reply-fact', ...witness, ...(item.metrics ? { metrics: item.metrics } : {}), ...(item.turnOutcome && witness.turnKey ? { outcome: item.turnOutcome.status } : {}) }
      if (same(prior, fact)) continue
      this.saveDecision(boundary, id, 'current', fact)
      for (const value of [prior, fact]) if (value) for (const [field, key] of [['recordKey', value.recordKey], ['turnKey', value.turnKey]] as const) {
        if (!key) continue
        for (const linked of this.database.prepare(`SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=?
          AND json_extract(decision_json,'$.kind') IN ('reply-fact','reply-projection') AND json_extract(decision_json,'$.kind')='reply-projection'
          AND json_extract(decision_json,'$.${field}')=?`).all(...scopeKey(boundary), key)) projections.add((JSON.parse(String(linked.decision_json)) as ReplyProjection).projectionId)
      }
    }
    return projections
  }
  private projectReplyMetadata(boundary: PublicationBoundary, projectionId: string, unit: ConversationUnit, plan: MaterializedPlan, exists: boolean): ReplyPublicationMetadata | undefined {
    const prior = this.replyProjection(boundary, projectionId)
    // Upgrades cannot enroll a previously frozen request, even when its source reappears.
    if (!prior && exists) return
    const piece = [...plan.pieces].reverse().find(piece => piece.text && !piece.image && !piece.file)
    const record = piece && unit.records.find(record => same(record.reference, piece.part.record) && record.revision === piece.part.recordRevision)
    if (!record || !isCompleteConversationRecord(record) || record.original.kind !== 'native' || record.original.item.kind !== 'assistant-message')
      return prior && plan.phase === 'final' ? this.replySnapshot(boundary, prior) : undefined
    const witness = replyRecord(record, boundary.executionHostId, boundary.agentSessionId)
    if (!witness) return
    const projection: ReplyProjection = { kind: 'reply-projection', projectionId, ...witness }
    this.saveDecision(boundary, 'reply-projection-' + digest(projectionId), 'current', projection)
    return record.original.item.messagePhase === 'final' ? this.replySnapshot(boundary, projection) : undefined
  }
  /** A late snapshot changes only an already confirmed editable original card. */
  private refreshReplyMetadata(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId: string, fragmentText?: PublicationPageOptions['fragmentText']): void {
    const projection = this.replyProjection(boundary, projectionId)
    if (!projection) return
    const latest = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE projection_id=? GROUP BY fragment_ordinal) ORDER BY fragment_ordinal')
      .all(projectionId).map(row => this.read(row)!)
    const original = [...latest].reverse().find(operation => operation.effect === 'upsert' && operation.payload.kind === 'speech')
    if (!original || original.state !== 'confirmed' || !original.mapping || original.payload.kind !== 'speech' || original.payload.phase !== 'final' || !original.payload.replyMetadata) return
    const metadata = this.replySnapshot(boundary, projection), payload = { ...original.payload, replyMetadata: metadata }
    if (same(original.payload, payload)) return
    const split = fragmentText?.(payload, original.speaker, original.originalMessage)
    if (split && (split.length !== 1 || split[0]!.text !== payload.text)) return
    const represented = representation(latest.filter(operation => operation.effect === 'upsert').map(operation => operation.payload.kind === 'image' ? { text: '', part: operation.payload.part, image: operation.payload.image }
      : operation.payload.kind === 'file' ? { text: '', part: operation.payload.part, file: operation.payload.file }
      : { text: operation.payload.kind === 'speech' ? operation.payload.text : '' }), payload.phase, payload.relay, '', payload.inputSubmission)
    const revision = digest(withReplyMetadata(represented, metadata)), operationId = 'publication-' + digest([original.operationId, 'reply-metadata', revision])
    if (this.inspect(operationId)) return
    const { attempt: _attempt, prepared: _prepared, mapping: _mapping, cardPreparation: _card, cardSequence: _sequence, portrait: _portrait,
      uploads: _uploads, avatarUploads: _avatarUploads, avatarSource: _avatarSource, reason: _reason, receipt: _receipt, ...retained } = original
    const operation: PublicationOperation = { ...retained, operationId, sourceRevision: revision, payload, predecessorOperationId: original.operationId, state: 'pending' }
    const avatar = original.avatarUploads?.at(-1)
    if (original.avatarSource) operation.avatarSource = original.avatarSource
    else if (avatar?.state === 'confirmed') operation.avatarSource = { operationId: original.operationId, attempt: original.avatarUploads!.length, imageKey: avatar.imageKey }
    this.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
      .run(operationId, projectionId, revision, operation.fragment.ordinal, ...scopeKey(boundary), encode(operation), operation.state)
  }
  private queueRepresentation(boundary: PublicationBoundary, projectionId: string, unit: ConversationUnit, plan: MaterializedPlan, fragmentBytes: number, event: ConnectionDelivery['event'] = { id: unit.event.id, revision: unit.event.revision }, references: readonly ConversationItemRef[] = [unit.event.reference!, ...unit.records.map(record => record.reference!)], question?: QuestionPublicationPayload, fragmentText?: PublicationPageOptions['fragmentText'], speaker?: PublicationSpeaker, originalMessage?: PublicationOriginalMessage, metadataEnabled?: true): void {
    const latest = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE projection_id=? GROUP BY fragment_ordinal) ORDER BY fragment_ordinal').all(projectionId).map(row => this.read(row)!)
    // An unresolved part never withdraws a prior complete platform representation.
    if (!plan.failure && !plan.text && !plan.resourceParts?.some(part => part.image || part.file) && !plan.complete) return
    const payload = plan.failure ?? representation(plan.resourceParts ?? [{ text: plan.text }], plan.phase, plan.relay, '\n\n', plan.inputSubmission)
    if (!question && !originalMessage && !plan.failure && (metadataEnabled || this.replyProjection(boundary, projectionId))) {
      const metadata = this.projectReplyMetadata(boundary, projectionId, unit, plan, latest.length > 0)
      withReplyMetadata(payload, metadata)
    }
    const represented = question && plan.text && (plan.complete || plan.gaps.every(gap => gap.reason === 'resource-unavailable'))
      ? questionRepresentation(payload, { ...question, ...(plan.phase ? { phase: plan.phase } : {}) }) : payload
    if (plan.failure) {
      this.saveDecision(boundary, 'failure-' + digest(projectionId), 'current', { kind: 'failure-representation', projectionId, payload: plan.failure, records: references, event })
      for (const record of unit.records) if (isCompleteConversationRecord(record) && record.original.item.turnOutcome?.status === 'failed')
        this.saveDecision(boundary, 'failure-record-' + digest(record.reference), 'current', { kind: 'failure-record', projectionId })
    }
    const revision = digest(represented), parts = representationFragments(represented, fragmentBytes, fragmentText ? payload => fragmentText(payload, speaker, originalMessage) : undefined)
    const withoutMetadata = (payload: PublicationPayload) => payload.kind === 'speech' ? (({ replyMetadata: _metadata, ...body }) => body)(payload) : payload
    // Only a metadata-only change to a still-owned frozen request waits for its
    // receipt. Ordinary pending work and cancelled body recovery keep their original path.
    const metadataOnly = latest.length === parts.length && latest.every((operation, index) => operation.effect === 'upsert' &&
      same(withoutMetadata(operation.payload), withoutMetadata(parts[index]!))) && latest.some((operation, index) => !same(operation.payload, parts[index]))
    const frozenOriginal = latest.every(operation => !['cancelled', 'superseded'].includes(operation.state)) && latest.some(operation =>
      ['unknown', 'dispatching'].includes(operation.state) || operation.state === 'pending' && (operation.prepared !== undefined || operation.attempt !== undefined))
    if (metadataOnly && frozenOriginal) return
    if (parts.length && latest.length && latest.every(o => o.sourceRevision === revision && o.state !== 'cancelled')) return
    // A form status update has its own original receipt; unchanged media must not be sent again.
    if (question && payload.kind === 'sequence' && parts.length === latest.length && latest.every((operation, index) => operation.effect === 'upsert' && !['cancelled', 'superseded'].includes(operation.state) && same(operation.payload, parts[index]))) return
    const previous = new Map(latest.map(o => [o.fragment.ordinal, o])), count = Math.max(parts.length, ...latest.map(o => o.fragment.ordinal + 1))
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const prior = previous.get(ordinal), body = parts[ordinal]
      if (body && prior?.effect === 'upsert' && (same(prior.payload, body) || sameImageEffect(prior.payload, body)) && (['confirmed', 'unknown', 'dispatching'].includes(prior.state) || prior.attempt !== undefined || !!prior.uploads?.length)) continue
      if (!body && prior?.effect === 'withdraw' && prior.state !== 'cancelled') continue
      // Keep an already queued withdrawal as the barrier for a replacement.
      const direct = prior?.predecessorOperationId ? this.inspect(prior.predecessorOperationId) : null
      let predecessor = prior?.effect === 'withdraw' && !['cancelled', 'superseded'].includes(prior.state) ? prior
        : prior && ['pending', 'not-applied', 'cancelled', 'superseded'].includes(prior.state) && direct?.effect === 'withdraw' && !['cancelled', 'superseded'].includes(direct.state) ? direct : this.appliedPredecessor(prior)
      if ((prior?.state === 'pending' || prior?.state === 'not-applied') && prior.operationId !== predecessor?.operationId) this.write({ ...prior, state: body ? 'superseded' : 'cancelled', ...(!body ? { reason: 'original-speech-withdrawn' as const } : {}) })
      if (!body && (!predecessor || predecessor.effect === 'withdraw')) continue
      let identity = prior?.operationId ?? null
      const queue = (effect: 'upsert' | 'withdraw', payload: PublicationPayload, parent: PublicationOperation | null): PublicationOperation => {
        const operationId = 'publication-' + digest([projectionId, ordinal, identity, revision, effect])
        const readingOriginal = unit.records.find(record => record.id === unit.event.anchorId)?.original
        const original = readingOriginal?.kind === 'deferred' ? readingOriginal.item : readingOriginal
        const sourceTime = original?.kind === 'native' ? original.item.startedAt : original?.item.createdAt
        const presentationTime = originalMessage?.createdAt ?? (sourceTime !== undefined && Number.isFinite(sourceTime) && Math.abs(sourceTime) <= 8.64e15
          ? sourceTime : prior?.presentationTime ?? Date.now())
        const operation: PublicationOperation = { operationId, projectionId, sourceRevision: revision, presentationTime, ...(event ? { event } : {}), sourceRecords: [...references],
          ...(speaker && (payload.kind === 'speech' || payload.kind === 'question') ? { speaker } : {}),
          ...(originalMessage ? { originalMessage: { messageId: originalMessage.messageId, senderSessionId: originalMessage.senderSessionId, ...(originalMessage.notificationId ? { notificationId: originalMessage.notificationId } : {}) } } : {}),
          bindingId: boundary.bindingId, bindingRevision: boundary.revision, publicationScope: boundary.scope.publication,
          reference: unit.event.reference!, target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
          payload, ...(plan.relay ? { relay: plan.relay } : {}), effect, fragment: { ordinal, count: parts.length }, state: 'pending', ...(parent ? { predecessorOperationId: parent.operationId } : {}) }
        this.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)').run(operationId, projectionId, revision, ordinal, ...scopeKey(boundary), encode(operation), 'pending')
        return operation
      }
      // File messages cannot be edited; retire the original mapping before creating another type or file version.
      if (body && predecessor?.effect === 'upsert' && (body.kind === 'file' || predecessor.payload.kind === 'file')) {
        predecessor = queue('withdraw', { kind: 'speech', text: '' }, predecessor)
        identity = predecessor.operationId
      }
      queue(body ? 'upsert' : 'withdraw', body ?? { kind: 'speech', text: '' }, predecessor)

    }
  }
  /** Journal originals reuse this Outbox; a repeated notification cannot acquire a second representation. */
  private projectOriginalMessages(boundary: PublicationBoundary, unit: ConversationUnit, values: readonly PublicationA2A[], frontier: ConversationCheckpoint, fragmentBytes: number, fragmentText?: PublicationPageOptions['fragmentText'], sourceEvent: ConnectionDelivery['event'] | null = { id: unit.event.id, revision: unit.event.revision }): void {
    if (boundary.scope.publication !== 'future-shared-conversation') return
    for (const value of values) {
      const gapId = 'a2a-gap-' + digest([...scopeKey(boundary), conversationRecordId(value.record), value.revision, value.notificationId ?? value.key])
      if (value.unavailable) {
        const gap: ConnectionDeliveryGap = { gapId, reason: value.startUnconfirmed ? 'start-cut-unconfirmed' : 'resource-unavailable', code: 'PUBLICATION_A2A_ORIGINAL_UNAVAILABLE',
          event: { id: unit.event.id, revision: unit.event.revision }, record: value.record, ...(value.part ? { part: value.part } : {}),
          anchor: { record: value.record, revision: value.revision, frontier } }
        this.saveDecision(boundary, gapId, value.revision, { kind: 'gap', gap, state: 'unresolved' })
      } else this.database.prepare("UPDATE connector_publication_decision SET decision_json=json_set(decision_json,'$.state','resolved') WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=?").run(...scopeKey(boundary), gapId)
      // A native direct input's public body is the journal original, not its raw envelope.
      // Resolve only the exact text-wire gap; unrelated resources and purposes keep their own gaps.
      const record = unit.records.find(record => same(record.reference, value.record) && record.revision === value.revision)
      if (sourceEvent && value.originalAgentInput && record?.original.kind === 'native' && record.original.item.kind === 'user-message') {
        for (const [partIndex, part] of record.original.item.contentParts.entries()) if (part.kind === 'text' && part.contentRole !== 'tool' && part.contentRole !== 'reasoning') {
          const exact = { record: value.record, recordRevision: value.revision, selector: { kind: 'native-part', partIndex } }
          const gapId = 'gap-' + digest([...scopeKey(boundary), sourceEvent, exact, 'public-content-unconfirmed'])
          this.database.prepare("UPDATE connector_publication_decision SET decision_json=json_set(decision_json,'$.state','resolved') WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision=? AND json_extract(decision_json,'$.kind')='gap' AND json_extract(decision_json,'$.state')='unresolved'").run(...scopeKey(boundary), gapId, value.revision)
        }
      }
      for (const message of value.messages) {
        const projectionId = 'a2a-original-' + digest([...scopeKey(boundary), boundary.executionHostId, boundary.agentSessionId, message.messageId])
        if (this.latestProjection(projectionId)) continue
        const plan: MaterializedPlan = { text: message.body, pieces: [], gaps: [], origins: [], excluded: [], complete: true }
        this.queueRepresentation(boundary, projectionId, unit, plan, fragmentBytes, undefined, [value.record], undefined, fragmentText, message.speaker, message)
      }
    }
  }
  recoverOriginalMessages(boundary: PublicationBoundary, gap: ConnectionDeliveryGap, unit: ConversationUnit, values: readonly PublicationA2A[], authorized: () => boolean, fragmentBytes: number, fragmentText?: PublicationPageOptions['fragmentText']): void {
    if (!gap.anchor || gap.code !== 'PUBLICATION_A2A_ORIGINAL_UNAVAILABLE') return
    this.transaction(() => {
      if (!authorized()) return
      const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision=? AND json_extract(decision_json,'$.state')='unresolved'").get(...scopeKey(boundary), gap.gapId, gap.anchor!.revision)
      if (!row) return
      const current = JSON.parse(String(row.decision_json)).gap as ConnectionDeliveryGap
      if (current.anchor) this.projectOriginalMessages(boundary, unit, values.filter(value => same(value.record, current.anchor!.record) && value.revision === current.anchor!.revision), current.anchor.frontier, fragmentBytes, fragmentText, current.event ?? null)
    })
  }
  recoverableGaps(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, after = 0): Array<{ ordinal: number; gap: ConnectionDeliveryGap }> {
    // Qualification can retain a diagnostic gap without a readable original. Such
    // gaps remain in coverage, but must not occupy every slot before later media.
    return this.database.prepare(`SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND rowid>? AND ${recoverableGapPredicate} ORDER BY rowid LIMIT 4`)
      .all(...scopeKey(boundary), after).map(row => ({ ordinal: Number(row.rowid), gap: JSON.parse(String(row.decision_json)).gap }))
  }
  /** Recovery admits only the missing exact part, with no read-cut movement or replay of represented bytes. */
  recoverPart(boundary: PublicationBoundary, gap: ConnectionDeliveryGap, original: ConversationUnit, resolvedText: ReadonlyMap<string, ResolvedPublicationPart>, authorized: () => boolean, fragmentBytes: number, fragmentText?: PublicationPageOptions['fragmentText'], speaker?: PublicationSpeaker): boolean {
    if (!gap.anchor || !gap.part || !gap.event) return false
    const event = gap.event
    const unit = parseConversationUnit(original, { hostId: gap.anchor.frontier.sourceHostId, agentSessionId: boundary.agentSessionId }, gap.anchor.frontier.frontier.scope)
    if (!unit.records.some(r => r.id === conversationRecordId(gap.part!.record) && r.revision === gap.part!.recordRevision)) return false
    const plan = publicationContent(unit, boundary, gap.anchor.frontier, { resolved: resolvedText, origin: id => this.origin(boundary, unit, id), ...(speaker ? { attributed: true } : {}) })
    return this.transaction(() => {
      if (!authorized()) throw new AgentMuxError('Original audience no longer authorizes this content.', 'PUBLICATION_NOT_AUTHORIZED')
      const row = this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND json_extract(decision_json,'$.state')='unresolved'").get(...scopeKey(boundary), gap.gapId)
      if (!row || !same(JSON.parse(String(row.decision_json)).gap, gap)) return false
      const represented = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND json_extract(decision_json,'$.kind')='event-representation' ORDER BY rowid DESC LIMIT 1").get(...scopeKey(boundary), 'event-' + digest(event.id))
      // The original event already has a retained projection even when all its
      // parts were gaps. Recovery updates that intent, never creates a second
      // event/message or substitutes a newer original record.
      if (!represented) return false
      const { projectionId, records } = JSON.parse(String(represented.decision_json)) as { projectionId: string; records: ConversationItemRef[] }
      const before = this.latestProjection(projectionId)?.operationId
      this.queueRepresentation(boundary, projectionId, unit, this.materialize(boundary, projectionId, unit, plan, [], undefined, records), fragmentBytes, event, records, undefined, fragmentText, speaker)
      for (const representation of plan.origins) this.saveDecision(boundary, 'origin-' + digest(representation.part), representation.part.recordRevision, { kind: 'origin', representation })
      let recovered = false
      for (const piece of plan.pieces) {
        if (plan.gaps.some(missing => missing.part && publicationPartKey(missing.part) === publicationPartKey(piece.part))) continue
        const id = 'gap-' + digest([...scopeKey(boundary), event, piece.part, 'resource-unavailable'])
        const pending = this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND json_extract(decision_json,'$.state')='unresolved'")
          .get(...scopeKey(boundary), id)
        if (pending) {
          this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...JSON.parse(String(pending.decision_json)), state: 'resolved' }), Number(pending.rowid))
          recovered = true
        }
      }
      if (!plan.gaps.some(missing => missing.part && publicationPartKey(missing.part) === publicationPartKey(gap.part!))) {
        this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...JSON.parse(String(row.decision_json)), state: 'resolved' }), Number(row.rowid))
        recovered = true
      }
      return recovered || before !== this.latestProjection(projectionId)?.operationId
    })
  }
  versionUnavailable(boundary: PublicationBoundary, gap: ConnectionDeliveryGap, code: string): void {
    const row = this.database.prepare("SELECT rowid,decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND json_extract(decision_json,'$.state')='unresolved'").get(...scopeKey(boundary), gap.gapId)
    if (row) this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...JSON.parse(String(row.decision_json)), gap: { ...gap, reason: 'version-unavailable', code } }), Number(row.rowid))
  }
  /** Original request projection uses this same outbox, not a fabricated history record or source cut. */
  commitInteraction(boundary: PublicationBoundary, projectionId: string, reference: ConnectionDelivery['reference'], payload: PermissionPublicationPayload | QuestionPublicationPayload): void {
    this.transaction(() => {
      const revision = digest(payload), prior = this.latestProjection(projectionId)
      if (prior?.sourceRevision === revision && prior.state !== 'cancelled') return
      const predecessor = this.appliedPredecessor(prior ?? undefined)
      if (prior?.state === 'pending' || prior?.state === 'not-applied') this.write({ ...prior, state: 'superseded' })
      const operationId = 'publication-' + digest([projectionId, prior?.operationId ?? null, revision])
      const operation: PublicationOperation = { operationId, projectionId, sourceRevision: revision, presentationTime: prior?.presentationTime ?? Date.now(),
        bindingId: boundary.bindingId, bindingRevision: boundary.revision, publicationScope: boundary.scope.publication,
        reference, target: { connectionId: boundary.connectionId, application: boundary.application, externalConversationId: boundary.externalConversationId },
        payload, effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending', ...(predecessor ? { predecessorOperationId: predecessor.operationId } : {}) }
      this.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
        .run(operationId, projectionId, revision, 0, boundary.bindingId, boundary.revision, encode(operation), 'pending')
    })
  }
  updateQuestion(operation: PublicationOperation, payload: QuestionPublicationPayload): void {
    if (operation.payload.kind !== 'question' || same(operation.payload, payload)) return
    this.transaction(() => {
      const latest = this.latestProjection(operation.projectionId)
      if (!latest || latest.operationId !== operation.operationId) return
      if (latest.state === 'pending' || latest.state === 'not-applied') this.write({ ...latest, state: 'superseded' })
      const revision = digest(payload), operationId = 'publication-' + digest([latest.operationId, revision])
      const predecessor = this.appliedPredecessor(latest)
      const next: PublicationOperation = { ...latest, operationId, sourceRevision: revision, payload, state: 'pending',
        ...(predecessor ? { predecessorOperationId: predecessor.operationId } : {}) }
      delete next.attempt; delete next.prepared; delete next.mapping; delete next.cardPreparation; delete next.cardSequence; delete next.portrait
      this.database.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
        .run(operationId, next.projectionId, revision, next.fragment.ordinal, next.bindingId, next.bindingRevision, encode(next), next.state)
    })
  }
  latestProjection(projectionId: string): PublicationOperation | null {
    return this.read(this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE projection_id=? ORDER BY ordinal DESC LIMIT 1').get(projectionId))
  }
  confirmedMapping(projectionId: string): PublicationMapping | undefined {
    return this.read(this.database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE projection_id=? AND state='confirmed' ORDER BY ordinal DESC LIMIT 1").get(projectionId))?.mapping
  }
  private appliedPredecessor(value: PublicationOperation | undefined): PublicationOperation | null {
    let original = value ?? null
    while (original && ['pending', 'cancelled', 'superseded', 'not-applied'].includes(original.state))
      original = original.predecessorOperationId ? this.inspect(original.predecessorOperationId) : null
    return original
  }
  next(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId?: string, after?: string): PublicationOperation | null {
    return this.read(this.candidate(boundary, projectionId, after))
  }
  /** One exact eligible head per projection. Both preparation and atomic claim use this selection. */
  private candidate(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId?: string, after?: string) {
    const cursor = after === undefined ? undefined : this.database.prepare('SELECT ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND operation_id=?').get(...scopeKey(boundary), after)
    return this.database.prepare(`SELECT original.operation_json, original.state FROM connector_publication_operation original
      WHERE original.binding_id=? AND original.binding_revision=?
        AND original.ordinal>?
        AND original.state IN ('pending','dispatching','unknown','not-applied') AND original.state='pending'
        AND ${projectionId === undefined ? "json_extract(original.operation_json,'$.reference.source.kind') IN ('native','captured','ingress')" : 'original.projection_id=?'}
        AND NOT EXISTS (SELECT 1 FROM connector_publication_operation earlier
          WHERE earlier.binding_id=original.binding_id AND earlier.binding_revision=original.binding_revision AND earlier.projection_id=original.projection_id
            AND earlier.state IN ('pending','dispatching','unknown','not-applied') AND earlier.ordinal<original.ordinal
            AND NOT (earlier.state='not-applied' AND json_extract(earlier.operation_json,'$.payload.kind') IN ('image','file')))
        AND (json_extract(original.operation_json,'$.predecessorOperationId') IS NULL OR EXISTS (
          SELECT 1 FROM connector_publication_operation predecessor WHERE predecessor.operation_id=json_extract(original.operation_json,'$.predecessorOperationId')
            AND predecessor.binding_id=original.binding_id AND predecessor.binding_revision=original.binding_revision AND predecessor.projection_id=original.projection_id
            AND predecessor.state='confirmed' AND json_type(predecessor.operation_json,'$.mapping')='object'))
      ORDER BY original.ordinal LIMIT 1`).get(...scopeKey(boundary), Number(cursor?.ordinal ?? 0), ...(projectionId === undefined ? [] : [projectionId]))
  }
  /** Read-only recovery advances through this audience's retained open rows, never another queue or history. */
  nextUnconfirmed(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, after?: string, projectionId?: string): PublicationOperation | null {
    const cursor = after === undefined ? undefined : this.database.prepare('SELECT ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND operation_id=?').get(...scopeKey(boundary), after)
    if (projectionId === undefined) {
      const parameters = [...scopeKey(boundary), Number(cursor?.ordinal ?? 0)]
      // Each state has an ordered range in the existing open-state index. Taking
      // its first eligible ordinal avoids scanning completed history to merge them.
      return this.read(this.database.prepare(`SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (
        SELECT MIN(ordinal) FROM connector_publication_operation
          WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied')
            AND state='dispatching' AND ordinal>? AND json_extract(operation_json,'$.reference.source.kind')!='binding-operation'
        UNION ALL
        SELECT MIN(ordinal) FROM connector_publication_operation
          WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied')
            AND state='unknown' AND ordinal>? AND json_extract(operation_json,'$.reference.source.kind')!='binding-operation'
      ) ORDER BY ordinal LIMIT 1`).get(...parameters, ...parameters))
    }
    return this.read(this.database.prepare(`SELECT operation_json,state FROM connector_publication_operation
      WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied')
        AND state IN ('dispatching','unknown') AND ordinal>? AND projection_id=?
      ORDER BY ordinal LIMIT 1`).get(...scopeKey(boundary), Number(cursor?.ordinal ?? 0), projectionId))
  }
  /** Aggregate effect facts cannot be overwritten by a newer successful independent message. */
  unresolvedState(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, projectionId?: string): 'unknown' | 'not-applied' | null {
    const suffix = projectionId === undefined ? '' : ' AND projection_id=?', parameters = [...scopeKey(boundary), ...(projectionId === undefined ? [] : [projectionId])]
    if (this.database.prepare("SELECT 1 FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied') AND state IN ('dispatching','unknown')" + suffix + ' LIMIT 1').get(...parameters)) return 'unknown'
    return this.database.prepare("SELECT 1 FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND state IN ('pending','dispatching','unknown','not-applied') AND state='not-applied'" + suffix + ' LIMIT 1').get(...parameters) ? 'not-applied' : null
  }
  /** Only the original pending projection supplies records missing accepted purpose. No history scan. */
  pendingRecords(operation: PublicationOperation): ConversationItemRef[] {
    if (!['speech', 'image', 'file', 'question'].includes(operation.payload.kind) || operation.effect !== 'upsert') return []
    const rows = this.representationRows({ bindingId: operation.bindingId, revision: operation.bindingRevision }, operation.projectionId)
    const records = rows.flatMap(row => {
      const reference = row.value.kind === 'representation' ? row.value.part.record : row.value.record
      return row.value.kind !== 'representation' || row.value.purpose !== 'conversation' || reference.source.kind === 'native' && row.value.contentEligibility !== 'public' ? [reference] : []
    })
    if (!rows.length) records.push(...(operation.sourceRecords ?? [operation.reference]).filter((reference): reference is ConversationItemRef => reference.source.kind === 'native' || reference.source.kind === 'captured'))
    return [...new Map(records.map(record => [conversationRecordId(record), record])).values()]
  }
  /** New qualification must account for the exact frozen bytes, not bless another version's payload. */
  qualifyPending(boundary: PublicationBoundary, operation: PublicationOperation,
    originals: ReadonlyMap<string, { unit: ConversationUnit; frontier: ConversationCheckpoint; resolved: ReadonlyMap<string, ResolvedPublicationPart> }>, frontier: ConversationCheckpoint): 'qualified' | 'cancelled' | 'unavailable' {
    return this.transaction(() => {
      const current = this.inspect(operation.operationId)
      if (!current || current.state !== 'pending' || !same(current, operation)) return 'unavailable'
      if (operation.payload.kind === 'failure') {
        const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? AND source_revision='current' AND json_extract(decision_json,'$.kind')='failure-representation'").get(...scopeKey(boundary), 'failure-' + digest(operation.projectionId))
        // The original transaction qualified this exact public summary. Reopen must not
        // reclassify a later raw record or grant sharing to an unqualified old operation.
        return row && same(JSON.parse(String(row.decision_json)).payload, operation.payload) ? 'qualified' : 'unavailable'
      }
      if (!['speech', 'image', 'file', 'question'].includes(operation.payload.kind)) return 'unavailable'
      const content = operation.payload as ContentPayload
      const rows = this.representationRows(boundary, operation.projectionId, operation.sourceRecords)
      const failures: Array<{ reason: 'outside-conversation-scope' | 'private-content' | 'public-content-unconfirmed' | 'version-unavailable'; part?: ConversationContentRef; record?: ConversationItemRef; frontier?: ConversationCheckpoint }> = []
      if (!rows.length) failures.push({ reason: 'public-content-unconfirmed' })
      const qualified: Array<{ part: ConversationContentRef; frontier: ConversationCheckpoint }> = []
      for (const row of rows) {
        const retained = row.value
        if (retained.kind === 'legacy-representation') { failures.push({ reason: retained.record.source.kind === 'native' ? 'public-content-unconfirmed' : 'version-unavailable', record: retained.record }); continue }
        // This original accepted decision names one exact part version and frozen representation.
        // It survives paging/restart without requiring a Provider's newer observation capability.
        if (retained.purpose === 'conversation' && (retained.part.record.source.kind !== 'native' || retained.contentEligibility === 'public')) { qualified.push({ part: retained.part, frontier }); continue }
        const original = originals.get(conversationRecordId(retained.part.record))
        if (!original) { failures.push({ reason: 'version-unavailable', part: retained.part, frontier }); continue }
        const record = original.unit.records.find(record => same(record.reference, retained.part.record))
        if (!record) return 'unavailable'
        const part = { ...retained.part, recordRevision: record.revision }
        const eligibility = record.original.kind === 'native' && part.selector.kind === 'native-part'
          ? record.original.item.contentParts[part.selector.partIndex]?.contentEligibility
          : record.original.kind === 'captured' ? record.original.item.contentEligibility : undefined
        if (eligibility === 'private') { failures.push({ reason: 'private-content', part, frontier: original.frontier }); continue }
        const plan = publicationContent(original.unit, boundary, original.frontier, { resolved: original.resolved, origin: () => undefined, selected: part, ...(operation.speaker ? { attributed: true } : {}) })
        if (plan.excluded.some(value => publicationPartKey(value) === publicationPartKey(part))) {
          failures.push({ reason: 'outside-conversation-scope', part, frontier: original.frontier }); continue
        }
        if (plan.gaps.some(gap => gap.reason === 'public-content-unconfirmed')) {
          failures.push({ reason: 'public-content-unconfirmed', part, frontier: original.frontier }); continue
        }
        const piece = plan.pieces.find(piece => publicationPartKey(piece.part) === publicationPartKey(part))
        if (!plan.complete || !piece || piece.text !== retained.text || (!same(piece.image, retained.image) || !same(piece.file, retained.file) || !same(piece.segments, retained.segments))) { failures.push({ reason: 'version-unavailable', part, frontier: original.frontier }); continue }
        this.database.prepare('UPDATE connector_publication_decision SET decision_json=? WHERE rowid=?').run(encode({ ...retained, part, purpose: 'conversation', ...(record.original.kind === 'native' ? { contentEligibility: 'public' } : {}) }), row.ordinal)
        qualified.push({ part, frontier: original.frontier })
      }
      // Verify the original whole payload and its exact stored fragments as well as each qualified slot.
      if (!failures.length) {
        const original = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE projection_id=? AND source_revision=? ORDER BY fragment_ordinal,ordinal')
          .all(operation.projectionId, operation.sourceRevision).map(row => this.read(row)!).filter(value => value.effect === 'upsert')
        const frozen = [...new Map(original.map(value => [value.fragment.ordinal, value])).values()]
        const latest = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE projection_id=? GROUP BY fragment_ordinal) ORDER BY fragment_ordinal')
          .all(operation.projectionId).map(row => this.read(row)!).filter(value => value.effect === 'upsert')
        const latestSpeech = latest.find(value => value.payload.kind === 'speech')?.payload
        const payload = representation(rows.map(row => row.value), content.phase, content.relay, '\n\n', latestSpeech?.kind === 'speech' ? latestSpeech.inputSubmission : undefined)
        const assemble = (operations: PublicationOperation[], currentImages = false) => {
          // Media has no input observation. Each whole version uses its own speech
          // metadata, including absence, even when an unchanged image spans versions.
          const speeches = operations.flatMap(value => value.payload.kind === 'speech' ? [value.payload] : [])
          const inputSubmission = speeches[0]?.inputSubmission
          if (speeches.some(value => !same(value.inputSubmission, inputSubmission))) return
          const metadata = speeches.at(-1)?.replyMetadata
          if (speeches.slice(0, -1).some(value => value.replyMetadata !== undefined)) return
          if (metadata) {
            const row = this.database.prepare("SELECT decision_json FROM connector_publication_decision WHERE binding_id=? AND binding_revision=? AND source_key='unified' AND record_id=? LIMIT 1")
              .get(...scopeKey(boundary), 'reply-snapshot-' + digest([operation.projectionId, metadata]))
            if (!row) return
            const snapshot = JSON.parse(String(row.decision_json)) as { metadata: ReplyPublicationMetadata }
            if (!same(snapshot.metadata, metadata)) return
          }
          const questions = operations.filter(value => value.payload.kind === 'question')
          if (questions.length > 1 || questions.length && operations.at(-1) !== questions[0]) return
          // Qualification above still owns every accepted part. Compare its current observation
          // with a retained identical image without rewriting that image's original effect.
          const currentPart = (image: ImagePublicationPayload) => currentImages && payload.kind === 'sequence'
            ? payload.parts.find((part): part is ImagePublicationPayload => part.kind === 'image' && sameImageEffect(part, image))?.part ?? image.part : image.part
          const body = representation(operations.filter(value => value.payload.kind !== 'question').map(value => value.payload.kind === 'image' ? { text: '', part: currentPart(value.payload), image: value.payload.image }
            : value.payload.kind === 'file' ? { text: '', part: value.payload.part, file: value.payload.file }
            : { text: value.payload.kind === 'speech' ? value.payload.text : '' }), content.phase, content.relay, '', inputSubmission)
          withReplyMetadata(body, metadata)
          return { body, whole: questions.length ? questionRepresentation(body, questions[0]!.payload as QuestionPublicationPayload) : body }
        }
        const retained = assemble(latest, true), prior = assemble(frozen)
        if (retained) withReplyMetadata(payload, latest.flatMap(value => value.payload.kind === 'speech' && value.payload.replyMetadata ? [value.payload.replyMetadata] : []).at(-1))
        const current = latest.some(value => value.operationId === operation.operationId && same(value.payload, operation.payload))
        if (current && operation.payload.kind === 'question' && operation.payload.text === questionText(payload) &&
            digest(operation.payload) === operation.sourceRevision && frozen.length === 1 && same(frozen[0]!.payload, operation.payload)) return 'qualified'
        // A neighbor may change while a started original fragment remains exact. Verify both
        // the current accepted representation and its original immutable frozen cohort.
        if (current && retained && same(payload, retained.body) && latest.every(value => ['speech', 'image', 'file', 'question'].includes(value.payload.kind)) &&
          (digest(retained.whole) === operation.sourceRevision && latest.length === operation.fragment.count || prior && digest(prior.whole) === operation.sourceRevision && frozen.length === operation.fragment.count)) return 'qualified'
        failures.push({ reason: 'version-unavailable' })
      }
      // An already attempted request retains its prepared bytes and original receipt. It is never requalified into another effect.
      if (current.attempt !== undefined) return 'unavailable'
      const reason = failures.some(f => f.reason === 'outside-conversation-scope') ? 'outside-conversation-scope' : failures.some(f => f.reason === 'private-content') ? 'private-content' : failures[0]!.reason
      for (const row of this.database.prepare("SELECT operation_json,state FROM connector_publication_operation WHERE projection_id=? AND source_revision=? AND state='pending'").all(operation.projectionId, operation.sourceRevision)) {
        const pending = this.read(row)!
        if (pending.attempt === undefined) this.write({ ...pending, state: 'cancelled', reason })
      }
      // One frozen fragment may mix allowed and denied parts. Remove only the denied intent;
      // represented public parts get exact recoverable gaps, never silent completion.
      for (const failure of failures) if (failure.part) for (const row of rows) if (row.value.kind === 'representation' && publicationPartKey(row.value.part) === publicationPartKey(failure.part))
        this.database.prepare('DELETE FROM connector_publication_decision WHERE rowid=?').run(row.ordinal)
      for (const value of qualified) failures.push({ reason: 'version-unavailable', ...value })
      for (const failure of failures) {
        if (failure.reason === 'private-content' || failure.reason === 'outside-conversation-scope') {
          this.saveDecision(boundary, 'scope-private-' + digest([operation.operationId, failure.part]), 'current', { kind: 'scope', excluded: failure.part ? [failure.part] : [], reason: failure.reason })
          continue
        }
        const gap: ConnectionDeliveryGap = { gapId: 'gap-' + digest([operation.operationId, failure.part, failure.record, failure.reason]), reason: failure.reason,
          ...(operation.event ? { event: operation.event } : {}), ...(failure.part ? { part: failure.part } : failure.record ? { record: failure.record } : (operation.reference.source.kind === 'native' || operation.reference.source.kind === 'captured') ? { record: { hostId: operation.reference.hostId, agentSessionId: operation.reference.agentSessionId, source: operation.reference.source } } : {}),
          ...(failure.part && failure.frontier ? { anchor: { record: failure.part.record, revision: failure.part.recordRevision, frontier: failure.frontier } } : {}),
          code: 'PUBLICATION_PENDING_CONTENT_UNCONFIRMED' }
        this.saveDecision(boundary, gap.gapId, failure.part?.recordRevision ?? operation.sourceRevision, { kind: 'gap', gap, state: 'unresolved' })
      }
      return 'cancelled'
    })
  }
  claimResourceUpload(operationId: string, authorized: () => boolean, purpose: 'content' | 'avatar' = 'content', inFlight?: (operationId: string, attempt: number) => boolean): PublicationOperation | null {
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (purpose === 'avatar') {
        if (!authorized() || !original || original.effect !== 'upsert' || !original.speaker?.avatar || original.avatarSource || original.avatarUploads?.length ||
          !(original.state === 'pending' && !original.prepared && original.attempt === undefined || this.pendingPortrait(original))) return null
        // A prepared human profile's revision is the Core-validated original image hash.
        const imageHash = original.speaker.avatar.image?.sha256 ?? (original.speaker.avatar.input ? original.speaker.avatar.revision?.slice('sha256:'.length) : undefined)
        if (!imageHash) return null
        const previous = this.read(this.database.prepare(`SELECT operation_json,state FROM connector_publication_operation
          WHERE json_array_length(json_extract(operation_json,'$.avatarUploads'))>0
            AND json_extract(operation_json,'$.avatarUploads[#-1].state') IN ('confirmed','dispatching')
            AND json_extract(operation_json,'$.target.connectionId')=? AND json_extract(operation_json,'$.target.application.domain')=?
            AND json_extract(operation_json,'$.target.application.appId')=? AND json_extract(operation_json,'$.speaker.avatar.image.sha256')=?
          ORDER BY CASE json_extract(operation_json,'$.avatarUploads[#-1].state') WHEN 'confirmed' THEN 0 ELSE 1 END, ordinal DESC LIMIT 1`).get(original.target.connectionId, original.target.application.domain, original.target.application.appId, imageHash))
        if (previous && (previous.avatarUploads!.at(-1)!.state === 'confirmed' || inFlight?.(previous.operationId, previous.avatarUploads!.length))) {
          const receipt = previous.avatarUploads!.at(-1)!
          const { image: _bytes, ...avatar } = original.speaker.avatar
          const retained: PublicationOperation = { ...original, speaker: { ...original.speaker, avatar }, avatarSource: { operationId: previous.operationId, attempt: previous.avatarUploads!.length,
            ...(receipt.state === 'confirmed' ? { imageKey: receipt.imageKey } : {}) } }
          this.write(retained); return retained
        }
        if (!original.speaker.avatar.image) return null
        const claimed: PublicationOperation = { ...original, avatarUploads: [{ state: 'dispatching' }] }
        this.write(claimed); return claimed
      }
      if (!authorized() || !original || original.state !== 'pending' || original.effect !== 'upsert' || (original.payload.kind !== 'image' && original.payload.kind !== 'file') || original.prepared || original.attempt !== undefined || ['dispatching', 'confirmed'].includes(original.uploads?.at(-1)?.state ?? '')) return null
      const predecessor = original.predecessorOperationId ? this.inspect(original.predecessorOperationId) : null
      if (predecessor && (predecessor.state !== 'confirmed' || !predecessor.mapping)) return null
      const claimed = { ...original, uploads: [...(original.uploads ?? []), { state: 'dispatching' as const }] }
      this.write(claimed); return claimed
    })
  }
  /** Late resource observation changes only its exact original optional presentation. */
  settleAvatarResource(operationId: string, resource: import('@agentmux/core').AgentInputResourceResult): PublicationOperation | null {
    return this.transaction(() => {
      const original = this.inspect(operationId), avatar = original?.speaker?.avatar
      if (!original?.speaker || !avatar?.input || !same(avatar.input, resource.key) || avatar.revision !== resource.revision) return null
      const { code: _code, image: _image, ...retained } = avatar
      const next: PublicationOperation = { ...original, speaker: { ...original.speaker, avatar: resource.status === 'available'
        ? { ...retained, observation: 'available', image: publicationImage({ ...resource, status: 'read' }) }
        : { ...retained, observation: 'unavailable', code: resource.code } } }
      this.write(next); return next
    })
  }
  settleResourceUpload(operationId: string, attempt: number, receipt: ResourceUploadReceipt, purpose: 'content' | 'avatar' = 'content'): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId), previous = (purpose === 'avatar' ? original?.avatarUploads : original?.uploads)?.[attempt - 1]
      const receivedKey = receipt.state === 'confirmed' ? 'imageKey' in receipt ? receipt.imageKey : receipt.fileKey : undefined
      if (!original || (purpose === 'avatar' ? !original.speaker?.avatar?.image : original.payload.kind !== 'image' && original.payload.kind !== 'file') || !Number.isSafeInteger(attempt) || attempt < 1 || !previous ||
        receipt.state === 'confirmed' && (((purpose === 'avatar' || original.payload.kind === 'image')) !== ('imageKey' in receipt) || !receivedKey || /[\u0000-\u001f\u007f]/u.test(receivedKey) || receivedKey.length > 16_384))
        throw new AgentMuxError('The upload receipt does not identify its original resource attempt.', 'PUBLICATION_RECEIPT_CONFLICT')
      if (previous.state === 'confirmed') {
        if (receipt.state === 'unknown') return original
        if (!same(previous, receipt)) throw new AgentMuxError('The original upload already confirmed another resource key.', 'PUBLICATION_RECEIPT_CONFLICT')
        return original
      }
      if (purpose === 'avatar') {
        const result: PublicationOperation = { ...original, avatarUploads: original.avatarUploads!.map((value, index) => index === attempt - 1 ? receipt as import('./publication-resource.js').ImageUploadReceipt : value) }
        this.write(result); return result
      }
      const uploads = original.uploads!.map((value, index) => index === attempt - 1 ? receipt : value)
      const { reason: _reason, ...retained } = original
      const result = attempt === uploads.length && original.attempt === undefined && ['pending', 'not-applied'].includes(original.state)
        ? { ...retained, uploads, ...(receipt.state === 'confirmed' ? { state: 'pending' as const } : { state: 'not-applied' as const, reason: 'effect-unconfirmed' as const }) }
        : { ...original, uploads }
      this.write(result); return result
    })
  }
  /** One optional create on a genuinely in-flight original resource; never another body queue. */
  claimCard(operationId: string, authorized: () => boolean, adapter: PublicationPreparer & { cards?: PublicationCardAdapter }, inFlight: boolean): PublicationOperation | null {
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (!authorized() || !adapter.cards || !inFlight || !original || original.state !== 'pending' || original.effect !== 'upsert' ||
          !['speech', 'question'].includes(original.payload.kind) || !original.speaker?.avatar || original.prepared || original.attempt !== undefined || original.cardPreparation || original.mapping) return null
      const parent = original.predecessorOperationId ? this.inspect(original.predecessorOperationId) : null
      if (parent && parent.effect !== 'withdraw') return null
      let prepared: PreparedPublication
      try { prepared = parsePreparedPublication(adapter.cards.prepareCreate(original), adapter) }
      catch { return null /* Unsupported optional presentation leaves the original body preparation available. */ }
      const claimed: PublicationOperation = { ...original, cardPreparation: { prepared, receipt: { state: 'dispatching' }, sequence: 0 } }
      this.write(claimed); return claimed
    })
  }
  settleCard(operationId: string, receipt: CardCreateReceipt): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId), card = original?.cardPreparation
      if (!original || !card) throw new AgentMuxError('The optional card receipt has no original preparation.', 'PUBLICATION_RECEIPT_CONFLICT')
      if (card.receipt.state !== 'dispatching' && card.receipt.state !== 'unknown') {
        if (receipt.state === 'unknown' || same(card.receipt, receipt)) return original
        throw new AgentMuxError('The original card preparation already has another authoritative receipt.', 'PUBLICATION_RECEIPT_CONFLICT')
      }
      if (receipt.state === 'confirmed' && (typeof receipt.id !== 'string' || !receipt.id || receipt.id.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(receipt.id)))
        throw new AgentMuxError('The native card identity is invalid.', 'PUBLICATION_RECEIPT_CONFLICT')
      const next = { ...original, cardPreparation: { ...card, receipt } }
      publicDelivery(next); this.write(next); return next
    })
  }
  unconfirmedCards(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>): PublicationOperation[] {
    return this.database.prepare("SELECT operation_json,state FROM connector_publication_operation INDEXED BY connector_publication_card_preparation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.cardPreparation.receipt.state')='dispatching'")
      .all(...scopeKey(boundary)).map(row => this.read(row)!)
  }
  portraitAudiences(uploadOperationId: string): Array<{ bindingId: string; revision: number }> {
    return this.database.prepare(`SELECT binding_id,binding_revision FROM connector_publication_operation WHERE operation_id=?
      UNION SELECT binding_id,binding_revision FROM connector_publication_operation WHERE json_extract(operation_json,'$.avatarSource.operationId')=? AND json_extract(operation_json,'$.portrait.state')='pending'`)
      .all(uploadOperationId, uploadOperationId).map(row => ({ bindingId: String(row.binding_id), revision: Number(row.binding_revision) }))
  }
  private withPortraitResource(original: PublicationOperation): PublicationOperation {
    if (!original.avatarSource || original.avatarSource.imageKey) return original
    const source = this.inspect(original.avatarSource.operationId)?.avatarUploads?.[original.avatarSource.attempt - 1]
    return source?.state === 'confirmed' ? { ...original, avatarSource: { ...original.avatarSource, imageKey: source.imageKey } } : original
  }
  private portraitAvailable(original: PublicationOperation): boolean {
    return !!original.avatarSource?.imageKey || original.avatarUploads?.at(-1)?.state === 'confirmed'
  }
  private reserveCardSequence(operation: PublicationOperation): number {
    const mapping = operation.mapping?.nativeCard, owner = mapping ? this.inspect(mapping.operationId) : null, card = owner?.cardPreparation
    if (!mapping || !owner || !card || card.receipt.state !== 'confirmed' || card.receipt.id !== mapping.id || !same(owner.target, operation.target) ||
        owner.projectionId !== operation.projectionId || owner.fragment.ordinal !== operation.fragment.ordinal || card.sequence >= 2_147_483_647)
      throw new AgentMuxError('The original native card sequence cannot be reserved.', 'PUBLICATION_PREPARATION_UNCONFIRMED')
    const sequence = card.sequence + 1, next = { ...card, sequence }
    this.write({ ...owner, cardPreparation: next })
    if (operation.operationId === owner.operationId) operation.cardPreparation = next
    return sequence
  }
  /** Indexed optional work on this Binding only, independent of semantic predecessor selection. */
  nextPortrait(boundary: Pick<PublicationBoundary, 'bindingId' | 'revision'>, after?: string): PublicationOperation | null {
    return this.read(this.database.prepare(`SELECT operation_json,state FROM connector_publication_operation
      WHERE binding_id=? AND binding_revision=? AND ordinal>COALESCE((SELECT ordinal FROM connector_publication_operation WHERE operation_id=?),0)
      AND json_extract(operation_json,'$.portrait.state') IN ('pending','dispatching','unknown') ORDER BY ordinal LIMIT 1`).get(...scopeKey(boundary), after ?? ''))
  }
  private pendingPortrait(original: PublicationOperation): PublicationOperation | null {
    if (original.portrait?.state !== 'pending' || original.state !== 'confirmed' || !original.mapping?.nativeCard) return null
    const latest = this.read(this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE projection_id=? AND fragment_ordinal=? ORDER BY ordinal DESC LIMIT 1').get(original.projectionId, original.fragment.ordinal))
    if (latest?.operationId !== original.operationId) {
      // Pending/unknown body has priority. Its eventual confirmed representation retires this intent.
      if (latest?.state === 'confirmed' || latest?.state === 'cancelled') this.write({ ...original, portrait: { state: 'superseded' } })
      return null
    }
    if (original.effect !== 'upsert' || !['speech', 'question'].includes(original.payload.kind) || !original.speaker?.avatar) {
      this.write({ ...original, portrait: { state: 'superseded' } }); return null
    }
    return original
  }
  claimPortrait(operationId: string, authorized: () => boolean, adapter: PublicationPreparer & { cards?: PublicationCardAdapter }): PublicationOperation | null {
    return this.transaction(() => {
      const retained = this.inspect(operationId)
      if (!authorized() || !adapter.cards || !retained) return null
      const pending = this.pendingPortrait(retained)
      if (!pending) return null
      const original = this.withPortraitResource(pending)
      if (!this.portraitAvailable(original)) return null
      const sequence = this.reserveCardSequence(original)
      const prepared = parsePreparedPublication(adapter.cards.preparePortrait(original, sequence), adapter)
      const claimed: PublicationOperation = { ...original, portrait: { state: 'dispatching', prepared, sequence } }
      this.write(claimed); return claimed
    })
  }
  /** A later body can show the same avatar; that cannot confirm the earlier optional write. */
  portraitInspectable(operation: PublicationOperation): boolean {
    if (!operation.mapping?.nativeCard || !operation.portrait || !('prepared' in operation.portrait)) return false
    const owner = this.inspect(operation.mapping.nativeCard.operationId)
    return owner?.cardPreparation?.sequence === operation.portrait.sequence
  }
  settlePortrait(operationId: string, receipt: PortraitReceipt, evidence: 'effect' | 'readback' = 'effect'): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId), portrait = original?.portrait
      if (!original || !portrait || !('prepared' in portrait)) throw new AgentMuxError('The portrait receipt has no original request.', 'PUBLICATION_RECEIPT_CONFLICT')
      if (portrait.state === 'confirmed' || portrait.state === 'not-applied') {
        if (receipt.state === 'unknown' || same(portrait.receipt, receipt)) return original
        throw new AgentMuxError('The original portrait already has another authoritative receipt.', 'PUBLICATION_RECEIPT_CONFLICT')
      }
      // A GET begun before a newer body cannot attest to the original optional effect.
      if (evidence === 'readback' && !this.portraitInspectable(original)) return original
      const next: PublicationOperation = { ...original, portrait: { ...portrait, state: receipt.state, receipt } }
      publicDelivery(next); this.write(next); return next
    })
  }
  /** Claim only the exact qualified candidate; an unresolved projection cannot hold independent work. */
  claimNext(boundary: PublicationBoundary, expectedOperationId: string, authorized: () => boolean, adapter: PublicationPreparer, projectionId?: string): PublicationOperation | null {
    return this.transaction(() => {
      if (!authorized()) return null
      let first = this.read(this.candidate(boundary, projectionId))
      if (first?.queryFeedback) {
        reconcileQueryFeedback(this, first)
        first = this.read(this.candidate(boundary, projectionId))
      }
      if (!first || first.operationId !== expectedOperationId) return null
      if ((first.publicationScope ?? 'future-native-user-facing') !== boundary.scope.publication)
        throw new AgentMuxError('The original publication retains another sharing scope. Inspect its Binding revision without replacing the operation.', 'PUBLICATION_SCOPE_CONFLICT')
      const predecessor = first.predecessorOperationId ? this.inspect(first.predecessorOperationId) : null
      if (predecessor && (predecessor.state !== 'confirmed' || !predecessor.mapping)) return null
      const original = this.withPortraitResource({ ...first, ...(predecessor?.mapping && predecessor.effect !== 'withdraw' ? { mapping: predecessor.mapping } : {}) })

      if (!adapter.directResources && (original.payload.kind === 'image' || original.payload.kind === 'file') && original.effect === 'upsert' && original.uploads?.at(-1)?.state !== 'confirmed') return null
      let candidate: unknown = original.prepared
      if (!candidate) {
        const upload = original.avatarSource ? this.inspect(original.avatarSource.operationId)?.avatarUploads?.[original.avatarSource.attempt - 1] : original.avatarUploads?.at(-1)
        if (!original.mapping && original.cardPreparation?.receipt.state === 'confirmed' && (upload?.state === 'dispatching' ||
          original.speaker?.avatar?.input && !original.speaker.avatar.image && !original.speaker.avatar.code)) original.cardPreparation = { ...original.cardPreparation, useForMessage: true }
        if (original.mapping?.nativeCard && original.effect === 'upsert') original.cardSequence = this.reserveCardSequence(original)
        try { candidate = adapter.prepare(JSON.parse(encode(original))) }
        catch { throw new AgentMuxError('The adapter could not prepare the original request. No platform effect was dispatched.', 'PUBLICATION_PREPARATION_UNCONFIRMED') }
      }
      const prepared = parsePreparedPublication(candidate, adapter)
      if (!original.prepared && prepared.renderVersion !== adapter.renderVersion)
        throw new AgentMuxError('The adapter must prepare its declared current render version.', 'PUBLICATION_PREPARATION_UNCONFIRMED')
      if (!authorized()) return null
      const claimed = { ...original, prepared, attempt: (original.attempt ?? 0) + 1, state: 'dispatching' as const }
      if (original.effect === 'upsert' && ['speech', 'question'].includes(original.payload.kind) && original.speaker?.avatar && !this.portraitAvailable(original) &&
          (original.mapping?.nativeCard || original.cardPreparation?.useForMessage)) claimed.portrait = { state: 'pending' }
      this.database.prepare('INSERT INTO connector_publication_attempt (operation_id,attempt) VALUES (?,?)').run(claimed.operationId, claimed.attempt)
      this.write(claimed)
      return claimed
    })
  }
  private write(operation: PublicationOperation): void {
    this.database.prepare('UPDATE connector_publication_operation SET operation_json=?, state=? WHERE operation_id=?')
      .run(encode(operation), operation.state, operation.operationId)
  }
  settle(operationId: string, attempt: number, value: PublicationReceipt): PublicationOperation {
    const result = parseReceipt(value)
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
      const dispatch = this.database.prepare('SELECT receipt_json FROM connector_publication_attempt WHERE operation_id=? AND attempt=?').get(operationId, attempt)
      if (!Number.isSafeInteger(attempt) || attempt < 1 || !dispatch) throw new AgentMuxError('The receipt does not identify an original dispatch attempt.', 'PUBLICATION_RECEIPT_CONFLICT')
      const previous: PublicationReceipt | null = dispatch.receipt_json ? parseReceipt(JSON.parse(String(dispatch.receipt_json))) : null
      if (previous && previous.state !== 'unknown') {
        // A stale uncertainty cannot erase an authoritative outcome for its own attempt.
        if (result.state === 'unknown') return original
        if (!same(previous, result)) throw new AgentMuxError('The original dispatch attempt has a different authoritative outcome; its confirmed mapping cannot be replaced.', 'PUBLICATION_RECEIPT_CONFLICT')
        return original
      }
      this.database.prepare('UPDATE connector_publication_attempt SET receipt_json=? WHERE operation_id=? AND attempt=?').run(encode(result), operationId, attempt)
      // Late outcomes belong to that attempt alone, even when the same operation has been explicitly retried.
      if (original.attempt !== attempt) return original
      if (original.state === 'confirmed') {
        if (result.state !== 'confirmed' || !same(original.mapping, result.mapping))
          throw new AgentMuxError('The original confirmed platform mapping cannot be replaced.', 'PUBLICATION_RECEIPT_CONFLICT')
        return original
      }
      if (original.state !== 'dispatching' && original.state !== 'unknown')
        throw new AgentMuxError('This publication operation was not dispatched.', 'PUBLICATION_RECEIPT_CONFLICT')
      if (result.state === 'confirmed' && (typeof result.mapping.messageId !== 'string' || !result.mapping.messageId || result.mapping.messageId.length > 16_384 ||
        result.mapping.threadId !== undefined && (typeof result.mapping.threadId !== 'string' || !result.mapping.threadId || result.mapping.threadId.length > 16_384) ||
        original.mapping && !same(original.mapping, result.mapping)))
        throw new AgentMuxError('The platform did not confirm the original exact message mapping.', 'PUBLICATION_RECEIPT_CONFLICT')
      const { reason: _reason, ...retained } = original
      let settled: PublicationOperation = result.state === 'confirmed'
        ? { ...retained, state: 'confirmed', mapping: result.mapping, receipt: result }
        : { ...retained, state: result.state, reason: result.reason, receipt: result }
      this.write(settled)
      if (result.state === 'confirmed' && settled.effect === 'upsert' && settled.payload.kind === 'speech')
        this.refreshReplyMetadata({ bindingId: settled.bindingId, revision: settled.bindingRevision }, settled.projectionId)
      if (result.state === 'confirmed' && settled.effect === 'upsert' && settled.queryFeedback) reconcileQueryFeedback(this, settled)
      if (result.state === 'not-applied') {
        const successors = this.database.prepare("SELECT operation_json, state FROM connector_publication_operation WHERE projection_id=? AND fragment_ordinal=? AND state='pending' AND json_extract(operation_json,'$.predecessorOperationId')=? ORDER BY ordinal")
          .all(original.projectionId, original.fragment.ordinal, original.operationId).map(row => this.read(row)!)
        if (successors.length) {
          const earlier = this.appliedPredecessor(settled)
          let withdrawalBarrier = false
          for (const successor of successors) {
            if (original.effect === 'withdraw' && (successor.payload.kind === 'file' || earlier?.payload.kind === 'file')) {
              withdrawalBarrier = true; continue
            }
            const { predecessorOperationId: _predecessor, ...next } = successor
            this.write({ ...next, ...(earlier ? { predecessorOperationId: earlier.operationId } : {}),
              ...(next.effect === 'withdraw' && (!earlier || earlier.effect === 'withdraw') ? { state: 'cancelled' as const, reason: 'original-speech-withdrawn' } : {}) })
          }
          if (!withdrawalBarrier) { settled = { ...settled, state: 'superseded' }; this.write(settled) }
        }
      }
      return settled
    })
  }
  attempts(operationId: string): Array<{ attempt: number; receipt: PublicationReceipt | null }> {
    return this.database.prepare('SELECT attempt,receipt_json FROM connector_publication_attempt WHERE operation_id=? ORDER BY attempt').all(operationId).map(row => ({ attempt: Number(row.attempt), receipt: row.receipt_json ? parseReceipt(JSON.parse(String(row.receipt_json))) : null }))
  }
  /** Explicit retry of a non-applied message or an upload whose message was never attempted. */
  retry(operationId: string, authorized: () => boolean): PublicationOperation {
    return this.transaction(() => {
      const original = this.inspect(operationId)
      if (!original) throw new AgentMuxError('The original publication operation is unknown.', 'UNKNOWN_PUBLICATION_OPERATION')
      if (original.state !== 'not-applied') throw new AgentMuxError('The platform has not confirmed non-application. Inspect the original operation.', 'PUBLICATION_RETRY_UNCONFIRMED')
      if (!authorized()) throw new AgentMuxError('This exact Binding no longer authorizes dispatch.', 'PUBLICATION_NOT_AUTHORIZED')
      const { reason: _reason, ...retained } = original
      const pending: PublicationOperation = { ...retained, state: 'pending' }
      this.write(pending)
      return pending
    })
  }
}
