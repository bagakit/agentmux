import { parseQuestionReplyAttempt } from '@agentmux/client-ui/conversation-question-reply'
import type { MobileQuestionReplyAttempt } from '../conversation/question-replies'
import type { AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { withDeviceStorageLock, DEVICE_WORKFACE_KEY } from './device-storage-lock'
import { validateDeliveryLogId } from '@agentmux/core/delivery-attempt'
import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
import { isLocalNetworkHost } from '@agentmux/relay/offer'
import type { PromptAttempt, ResponseAttempt } from '../conversation/local-drafts'
import { parseMobileFileUpload, type MobileFileUpload } from '../conversation/attachments'
import { parsePresentationRoute, type MobilePresentationRoute } from './presentation-route'
import { mobileGoalDraftKey, parseMobileGoalDraft, parseMobileGoalDrafts, parseMobileGoalDraftConflicts,
  MobileGoalDraftInvalidError, type MobileGoalDraft, type MobileGoalDraftCommit } from './goal-drafts'
import { mobileKnowledgeDraftKey, parseMobileKnowledgeDraft, parseMobileKnowledgeDrafts, parseMobileKnowledgeDraftConflicts,
  MobileKnowledgeDraftInvalidError, type MobileKnowledgeDraft, type MobileKnowledgeDraftCommit } from './knowledge-drafts'
import { moteFileDraftKey, parseMoteFileDraft, parseMoteFileDrafts, parseMoteFileDraftConflicts,
  MoteFileDraftInvalidError, MoteFileDraftCapacityError, type MoteFileDraft, type MoteFileDraftCommit } from './mote-file-drafts'

export { DEVICE_WORKFACE_KEY } from './device-storage-lock'
export type MobilePanel = 'conversation' | 'sessions' | 'terminal'
export type Navigation = { selectedSessionId: string | null; hostUrl: string; panel: MobilePanel }
export type DraftRecord = { version: 1; drafts: Array<[string, string]>;
  attempts: Array<[string, Omit<PromptAttempt, 'message'>]>;
  responses: Array<[string, Pick<ResponseAttempt, 'phase'>]>; questions?: Array<[string, MobileQuestionReplyAttempt]>;
  questionDrafts?: Array<[string, AgentSessionHistoryQuestionAnswer[]]>; conflicts?: ConversationConflict[] }
export type ConversationBucket = 'drafts' | 'attempts' | 'responses' | 'questions' | 'questionDrafts'
export type ConversationValue = string | Omit<PromptAttempt, 'message'> | Pick<ResponseAttempt, 'phase'> | MobileQuestionReplyAttempt | AgentSessionHistoryQuestionAnswer[]
export type ConversationEdit = { bucket: ConversationBucket; key: string; expected?: ConversationValue | undefined; next?: ConversationValue | undefined }
export type ConversationConflict = { bucket: ConversationBucket; key: string; value: ConversationValue }
/** Facts written by this transaction, excluding later optimistic edits. */
export type ConversationCommit = { recordId: string | null; conversation: DraftRecord }
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export type GoalWorkSelection = { runtimeId: string; deviceHostId: string | null; sessionId: string; goalId: string }
export type MobileGoalOperation = GoalWorkSelection & { operationId: string } & (
  | { kind: 'start'; intervalMs: number; alignmentRevision: number }
  | { kind: 'action'; loopId: string; action: 'pause' | 'resume' | 'stop' | 'check'; expectedRevision: number }
)
export type GoalWorkface = { selection: GoalWorkSelection | null; pending: MobileGoalOperation[] }
export type GoalIntentScope = Pick<GoalWorkSelection, 'runtimeId' | 'deviceHostId'>
export type GoalCreationInput = { goalId: string; operationId: string; title: string; description: string; status: 'backlog'; risk: 'low'; confirmation: 'user'; projectId?: string }
export type GoalIntent = GoalIntentScope & { goalId: string; operationId: string; phase: 'sending' | 'unknown' | 'saved' } & (
  | { kind: 'create'; input: GoalCreationInput }
  | { kind: 'confirm'; expectedRevision: number }
  | { kind: 'accept'; expectedAlignmentRevision: number; expectedSubmissionId: string; acceptGaps: boolean }
)
export function sameGoalIntentScope(a: GoalIntentScope, b: GoalIntentScope): boolean {
  return a.runtimeId === b.runtimeId && a.deviceHostId === b.deviceHostId
}
function sameGoalIntent(a: GoalIntent, b: GoalIntent): boolean {
  if (!sameGoalIntentScope(a, b) || a.goalId !== b.goalId || a.operationId !== b.operationId) return false
  if (a.kind === 'create' && b.kind === 'create') {
    const keys = Object.keys(a.input) as Array<keyof GoalCreationInput>
    return keys.length === Object.keys(b.input).length && keys.every(key => a.input[key] === b.input[key])
  }
  if (a.kind === 'confirm' && b.kind === 'confirm') return a.expectedRevision === b.expectedRevision
  return a.kind === 'accept' && b.kind === 'accept' && a.expectedAlignmentRevision === b.expectedAlignmentRevision && a.expectedSubmissionId === b.expectedSubmissionId && a.acceptGaps === b.acceptGaps
}
function sameGoalOperation(a: MobileGoalOperation, b: MobileGoalOperation): boolean {
  const keys = Object.keys(a) as Array<keyof MobileGoalOperation>
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key])
}
export type DeviceWorkface = Navigation & { version: 1;
  recordId?: string; host: { origin: string; hostId: string } | null; conversation: DraftRecord; presentation?: MobilePresentationRoute; goalWork?: GoalWorkface; goalIntents?: GoalIntent[]; fileUploads?: MobileFileUpload[]; goalDrafts?: MobileGoalDraft[]; goalDraftConflicts?: MobileGoalDraft[]; knowledgeDrafts?: MobileKnowledgeDraft[]; knowledgeDraftConflicts?: MobileKnowledgeDraft[];
  moteFileDrafts?: MoteFileDraft[]; moteFileDraftConflicts?: MoteFileDraft[] }
type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>
type StorageGetter = () => DeviceStorage
const defaultStorage: StorageGetter = () => localStorage
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 256
export class DeviceHostMismatchError extends Error {}
export class DeviceWorkfaceRecordChangedError extends Error {}

export function emptyDeviceWorkface(): DeviceWorkface {
  return { version: 1, selectedSessionId: null, hostUrl: '', panel: 'conversation', host: null,
    conversation: { version: 1, drafts: [], attempts: [], responses: [] } }
}
function invalid(): Error { return new Error('设备工作面记录无法完整核实；原记录与当前阅读仍保留。') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
function phase(value: unknown): value is PromptAttempt['phase'] {
  return value === 'sending' || value === 'unknown' || value === 'rejected' || value === 'confirmed'
}
function entries(value: unknown): Array<[string, unknown]> {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw invalid()
  const found = new Set<string>()
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !id(item[0]) || found.has(item[0])) throw invalid()
    found.add(item[0])
  }
  return value
}
function body(value: unknown): value is string { return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 65536 }
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname)) && url.origin === value
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' } catch { return false }
}
export function parseDraftRecord(value: unknown): DraftRecord {
  const v = record(value, ['version', 'drafts', 'attempts', 'responses', ...['conflicts', 'questions', 'questionDrafts'].filter(key => Object.hasOwn(value ?? {}, key))])
  if (v.version !== 1) throw invalid()
  const drafts = entries(v.drafts), attempts = entries(v.attempts), responses = entries(v.responses)
  for (const [, draft] of drafts) if (!body(draft)) throw invalid()
  for (const [, item] of attempts) {
    const keys = ['operationId', 'runId', 'draft', 'phase']
    if (item && typeof item === 'object' && Object.hasOwn(item, 'request')) keys.push('request')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'logId')) keys.push('logId')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'inputRequested')) keys.push('inputRequested')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'originalRuntimeId')) keys.push('originalRuntimeId')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'originalHostId')) keys.push('originalHostId')
    if (item && typeof item === 'object' && Object.hasOwn(item, 'explicit')) keys.push('explicit')
    const attempt = record(item, keys)
    if (!id(attempt.operationId) || !(attempt.runId === null || id(attempt.runId))
      || !body(attempt.draft) || !phase(attempt.phase)) throw invalid()
    if (attempt.logId !== undefined) validateDeliveryLogId(attempt.logId)
    if (attempt.inputRequested !== undefined && typeof attempt.inputRequested !== 'boolean') throw invalid()
    if (attempt.explicit !== undefined && typeof attempt.explicit !== 'boolean') throw invalid()
    if (attempt.originalRuntimeId !== undefined && !(attempt.originalRuntimeId === null || id(attempt.originalRuntimeId))) throw invalid()
    if (attempt.originalHostId !== undefined && !(attempt.originalHostId === null || id(attempt.originalHostId))) throw invalid()
    if (attempt.request !== undefined) {
      const r = record(attempt.request, ['condition', 'execution', 'explicit', 'runtimeId'])
      const c = record(r.condition, ['expectedRun', 'afterSubmissionId'])
      record(c.expectedRun, ['runId'])
      const condition = validateAgentPromptCondition(c)
      if (!id(condition.expectedRun.runId) || condition.expectedRun.runId !== attempt.runId ||
          !(condition.afterSubmissionId === null || id(condition.afterSubmissionId)) ||
          !['default', 'immediate'].includes(r.execution as string) || typeof r.explicit !== 'boolean' ||
          !(r.runtimeId === null || id(r.runtimeId))) throw invalid()
    }
  }
  for (const [, item] of responses) if (!phase(record(item, ['phase']).phase)) throw invalid()
  if (v.questions !== undefined) for (const [, item] of entries(v.questions)) {
    const attempt = parseQuestionReplyAttempt(item), scope = item as MobileQuestionReplyAttempt
    if (!(scope.runtimeId === null || id(scope.runtimeId)) || !id(scope.hostId) || !attempt.input.answers.length) throw invalid()
  }
  if (v.questionDrafts !== undefined) for (const [, item] of entries(v.questionDrafts)) {
    if (!Array.isArray(item) || item.length > MAX_ENTRIES) throw invalid()
    const ids = new Set<string>()
    for (const answer of item) {
      const draft = record(answer, ['questionId', 'answer'])
      if (!id(draft.questionId) || !body(draft.answer) || ids.has(draft.questionId)) throw invalid()
      ids.add(draft.questionId)
    }
  }
  if (v.conflicts !== undefined) {
    if (!Array.isArray(v.conflicts)) throw invalid()
    for (const item of v.conflicts) {
      const c = record(item, ['bucket', 'key', 'value'])
      if (!['drafts', 'attempts', 'responses', 'questions', 'questionDrafts'].includes(String(c.bucket)) || !id(c.key)) throw invalid()
      parseDraftRecord({ version: 1, drafts: [], attempts: [], responses: [], [String(c.bucket)]: [[c.key, c.value]] })
    }
  }
  return structuredClone(value) as DraftRecord
}
export function parseDeviceWorkface(value: unknown): DeviceWorkface {
  const keys = ['version', 'selectedSessionId', 'hostUrl', 'panel', 'host', 'conversation']
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalWork')) keys.push('goalWork')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalIntents')) keys.push('goalIntents')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'fileUploads')) keys.push('fileUploads')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'presentation')) keys.push('presentation')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'recordId')) keys.push('recordId')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalDrafts')) keys.push('goalDrafts')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'goalDraftConflicts')) keys.push('goalDraftConflicts')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'knowledgeDrafts')) keys.push('knowledgeDrafts')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'knowledgeDraftConflicts')) keys.push('knowledgeDraftConflicts')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'moteFileDrafts')) keys.push('moteFileDrafts')
  if (value && typeof value === 'object' && Object.hasOwn(value, 'moteFileDraftConflicts')) keys.push('moteFileDraftConflicts')
  const v = record(value, keys)
  if (v.recordId !== undefined && !id(v.recordId)) throw invalid()
  if (v.version !== 1 || !(v.selectedSessionId === null || id(v.selectedSessionId))
    || !(v.hostUrl === '' || origin(v.hostUrl))
    || !(v.panel === 'conversation' || v.panel === 'sessions' || v.panel === 'terminal')) throw invalid()
  if (v.host !== null) {
    const host = record(v.host, ['origin', 'hostId'])
    if (!origin(host.origin) || !id(host.hostId)) throw invalid()
  }
  parseDraftRecord(v.conversation)
  if (v.goalDrafts !== undefined) parseMobileGoalDrafts(v.goalDrafts)
  if (v.goalDraftConflicts !== undefined) parseMobileGoalDraftConflicts(v.goalDraftConflicts)
  if (v.knowledgeDrafts !== undefined) parseMobileKnowledgeDrafts(v.knowledgeDrafts)
  if (v.knowledgeDraftConflicts !== undefined) parseMobileKnowledgeDraftConflicts(v.knowledgeDraftConflicts)
  if (v.moteFileDrafts !== undefined) parseMoteFileDrafts(v.moteFileDrafts)
  if (v.moteFileDraftConflicts !== undefined) parseMoteFileDraftConflicts(v.moteFileDraftConflicts)
  if (Object.hasOwn(v, 'presentation')) parsePresentationRoute(v.presentation)
  if (v.fileUploads !== undefined) {
    if (!Array.isArray(v.fileUploads) || v.fileUploads.length > MAX_ENTRIES) throw invalid()
    const found = new Set<string>()
    for (const upload of v.fileUploads) {
      const parsed = parseMobileFileUpload(upload)
      if (found.has(parsed.identity.operationId)) throw invalid()
      found.add(parsed.identity.operationId)
    }
  }
  if (Object.hasOwn(v, 'goalWork')) parseGoalWorkface(v.goalWork)
  if (Object.hasOwn(v, 'goalIntents')) {
    if (!Array.isArray(v.goalIntents)) throw invalid()
    const found = new Set<string>()
    for (const intent of v.goalIntents) {
      parseGoalIntent(intent)
      if (found.has(intent.operationId)) throw invalid()
      found.add(intent.operationId)
    }
  }
  return structuredClone(value) as DeviceWorkface
}

function parseGoalIntent(value: unknown): GoalIntent {
  const kind = (value as GoalIntent)?.kind
  const v = record(value, ['runtimeId', 'deviceHostId', 'goalId', 'operationId', 'phase', 'kind', ...(kind === 'create' ? ['input'] : kind === 'confirm' ? ['expectedRevision'] : ['expectedAlignmentRevision', 'expectedSubmissionId', 'acceptGaps'])])
  if (!id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId)) || !id(v.goalId) || !id(v.operationId) || !['sending', 'unknown', 'saved'].includes(String(v.phase))) throw invalid()
  if (kind === 'create') {
    const input = record(v.input, ['goalId', 'operationId', 'title', 'description', 'status', 'risk', 'confirmation', ...(Object.hasOwn(v.input ?? {}, 'projectId') ? ['projectId'] : [])])
    if (input.goalId !== v.goalId || input.operationId !== v.operationId || !body(input.title) || !input.title || !body(input.description) || input.status !== 'backlog' || input.risk !== 'low' || input.confirmation !== 'user' || input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId)) throw invalid()
  } else if (kind === 'confirm') {
    if (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1 || v.phase === 'saved') throw invalid()
  } else if (kind !== 'accept' || !Number.isSafeInteger(v.expectedAlignmentRevision) || Number(v.expectedAlignmentRevision) < 1 || !id(v.expectedSubmissionId) || typeof v.acceptGaps !== 'boolean' || v.phase === 'saved') throw invalid()
  return structuredClone(value) as GoalIntent
}

function selection(value: unknown): GoalWorkSelection {
  const v = record(value, ['runtimeId', 'deviceHostId', 'sessionId', 'goalId'])
  if (!id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId)) || !id(v.sessionId) || !id(v.goalId)) throw invalid()
  return structuredClone(value) as GoalWorkSelection
}
export function parseGoalWorkface(value: unknown): GoalWorkface {
  const v = record(value, ['selection', 'pending'])
  if (v.selection !== null) selection(v.selection)
  if (!Array.isArray(v.pending) || v.pending.length > MAX_ENTRIES) throw invalid()
  const found = new Set<string>()
  for (const item of v.pending) {
    const keys = ['runtimeId', 'deviceHostId', 'sessionId', 'goalId', 'operationId', 'kind']
    const op = record(item, [...keys, ...(item?.kind === 'start' ? ['intervalMs', 'alignmentRevision'] : ['loopId', 'action', 'expectedRevision'])])
    selection({ runtimeId: op.runtimeId, deviceHostId: op.deviceHostId, sessionId: op.sessionId, goalId: op.goalId })
    if (!id(op.operationId) || found.has(op.operationId)) throw invalid()
    found.add(op.operationId)
    if (op.kind === 'start') {
      if (!Number.isSafeInteger(op.intervalMs) || Number(op.intervalMs) < 60000 || !Number.isSafeInteger(op.alignmentRevision) || Number(op.alignmentRevision) < 1) throw invalid()
    } else if (op.kind !== 'action' || !id(op.loopId) || !['pause', 'resume', 'stop', 'check'].includes(String(op.action))
      || !Number.isSafeInteger(op.expectedRevision) || Number(op.expectedRevision) < 1) throw invalid()
  }
  return structuredClone(value) as GoalWorkface
}

/** One device record owns navigation, drafts and intent guards. All writers
 * serialize read/merge/set across pages; readers never own whole-record replacement. */
export class DeviceWorkfaceStore {
  private goalIntentFlights = new Map<string, string | null>()
  private goalIntentListeners = new Set<() => void>()
  private goalIntentVersion = 0
  subscribeGoalIntents = (listener: () => void): (() => void) => { this.goalIntentListeners.add(listener); return () => this.goalIntentListeners.delete(listener) }
  goalIntentRevision = (): number => this.goalIntentVersion
  private notifyGoalIntents(): void { this.goalIntentVersion += 1; for (const listener of this.goalIntentListeners) listener() }
  goalIntentRunning(operationId: string): boolean { return this.goalIntentFlights.has(operationId) && this.goalIntentFlights.get(operationId) === this.recordIdentity() }
  private value = emptyDeviceWorkface()
  private lastRaw: string | null | undefined
  private issue: string | null = null
  private temporary = false
  private writeUnavailable = false
  recordIdentity(): string | null { this.refresh(); return this.value.recordId ?? null }
  canRetrySave(): boolean { return this.issue === null || this.writeUnavailable }
  constructor(private readonly storage: () => DeviceStorage) { this.refresh() }
  private refresh(): void {
    try {
      const raw = this.storage().getItem(DEVICE_WORKFACE_KEY)
      if (raw === this.lastRaw) return
      this.lastRaw = raw
      if (this.temporary && this.pending.length > 0 && this.issue === null) {
        // Pending writes are normal concurrency, not a failed temporary record.
        const latest = raw === null ? emptyDeviceWorkface() : parseDeviceWorkface(JSON.parse(raw))
        this.value = this.projectPending(latest)
        return
      }
      if (this.temporary) {
        this.issue = '设备存储已可读取或原记录已变化；当前临时工作面仍保留，尚未覆盖原字节。请先导出需要保留的内容，再明确采用当前工作面或导入备份。'
        return
      }
      if (raw !== null && new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw invalid()
      this.value = raw === null ? emptyDeviceWorkface() : parseDeviceWorkface(JSON.parse(raw))
      this.issue = null
    } catch { this.issue = '这台设备的工作面记录暂时无法读取。原记录尚未覆盖，当前阅读和草稿保留；请恢复原记录或导入已保全的工作面。' }
  }
  snapshot(): { record: DeviceWorkface; issue: string | null } {
    this.refresh(); return { record: structuredClone(this.value), issue: this.issue }
  }
  private tail: Promise<unknown> = Promise.resolve()
  private pending: Array<(value: DeviceWorkface) => DeviceWorkface> = []
  private projectPending(latest: DeviceWorkface): DeviceWorkface {
    // A conflicting pending operation is refused when its own transaction runs;
    // its optimistic projection cannot obscure the latest canonical facts.
    return this.pending.reduce((value, apply) => {
      try { return parseDeviceWorkface(apply(value)) } catch { return value }
    }, latest)
  }
  private write(value: DeviceWorkface): void {
    const bytes = JSON.stringify(parseDeviceWorkface(value))
    if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw invalid()
    this.storage().setItem(DEVICE_WORKFACE_KEY, bytes)
    this.lastRaw = bytes; this.issue = null; this.writeUnavailable = false
  }
  private exclusive<T>(action: () => T): Promise<T> {
    // setItem is atomic; a read/modify/write is not. All writers share this lock.
    return withDeviceStorageLock(action)
  }
  private update<T = void>(change: (value: DeviceWorkface) => DeviceWorkface, expectedRecordId?: string | null,
    acknowledge?: (committed: DeviceWorkface) => T): Promise<T> {
    this.refresh()
    const recordId = expectedRecordId === undefined ? this.value.recordId ?? null : expectedRecordId
    if ((this.value.recordId ?? null) !== recordId) throw new DeviceWorkfaceRecordChangedError('设备工作面已被替换；原回执不能改写新的记录，请核对原操作。')
    this.value = parseDeviceWorkface(change(this.value))
    this.temporary = true
    const project = (value: DeviceWorkface) => {
      if ((value.recordId ?? null) !== recordId) throw new DeviceWorkfaceRecordChangedError('原记录已替换。')
      return change(value)
    }
    this.pending.push(project)
    const releasePending = () => { const index = this.pending.indexOf(project); if (index >= 0) this.pending.splice(index, 1) }
    let domainFailure = false, failedLatest: DeviceWorkface | undefined, failedRaw: string | null | undefined
    const work = this.tail.then(() => this.exclusive(() => {
      if (this.issue && !this.writeUnavailable) throw new Error(this.issue)
      const raw = this.storage().getItem(DEVICE_WORKFACE_KEY)
      const latest = raw === null ? emptyDeviceWorkface() : parseDeviceWorkface(JSON.parse(raw))
      let next: DeviceWorkface
      failedLatest = latest; failedRaw = raw
      if ((latest.recordId ?? null) !== recordId) { domainFailure = true; throw new DeviceWorkfaceRecordChangedError('设备工作面已被替换；原回执不能改写新的记录，请核对原操作。') }
      try { next = parseDeviceWorkface(change(latest)) } catch (error) { domainFailure = true; throw error }
      this.write(next)
      const acknowledged = acknowledge?.(next) as T
      releasePending()
      this.value = this.projectPending(next)
      this.temporary = this.pending.length > 0
      return acknowledged
    })).catch(error => {
      releasePending()
      if (domainFailure && failedLatest) {
        this.lastRaw = failedRaw
        this.value = this.projectPending(failedLatest)
        this.temporary = this.pending.length > 0
      }
      if (!domainFailure && (!this.issue || this.writeUnavailable)) {
        this.writeUnavailable = true
        this.issue = '设备意图尚未持久保存；先前记录仍保留，当前内存与原操作可继续。刷新保障不足，请导出备份，存储恢复后重试保存。'
      }
      throw error
    })
    this.tail = work.catch(() => {})
    return work
  }
  updateNavigation(navigation: Navigation): Promise<void> {
    const captured = structuredClone(navigation)
    return this.update(value => ({ ...value, ...captured }))
  }
  updatePresentation(navigation: Navigation, presentation: MobilePresentationRoute, expectedRecordId?: string | null): Promise<void> {
    const parsed = parsePresentationRoute(presentation), captured = structuredClone(navigation)
    return this.update(value => ({ ...value, ...captured, presentation: parsed }), expectedRecordId)
  }
  /** Whole-record recovery/fixtures only. Draft readers use editConversation. */
  updateConversation(conversation: DraftRecord): Promise<void> {
    const parsed = parseDraftRecord(conversation)
    return this.update(value => ({ ...value, conversation: parsed }))
  }
  /** One scoped Goal key, using the original record/lock and actual durable ack. */
  editGoalDraft(expected: MobileGoalDraft | null, next: MobileGoalDraft, recordId: string | null): Promise<MobileGoalDraftCommit> {
    const captured = parseMobileGoalDraft(next), previous = expected === null ? null : parseMobileGoalDraft(expected)
    const key = mobileGoalDraftKey(captured.goalId, captured.scope)
    if (previous && mobileGoalDraftKey(previous.goalId, previous.scope) !== key) throw new MobileGoalDraftInvalidError('目标草稿的原对象或 Host 不同；本次保存未发送，原正文保留。')
    return this.update(value => {
      const drafts = value.goalDrafts ?? [], current = drafts.find(item => mobileGoalDraftKey(item.goalId, item.scope) === key) ?? null
      let result: DeviceWorkface
      if (!sameValue(current, previous) && !sameValue(current, captured)) {
        const conflicts = value.goalDraftConflicts ?? []
        result = { ...value, goalDraftConflicts: conflicts.some(item => sameValue(item, captured)) ? conflicts : [...conflicts, captured] }
      } else result = { ...value, goalDrafts: [...drafts.filter(item => mobileGoalDraftKey(item.goalId, item.scope) !== key), captured] }
      // This is the same record budget, checked before the I/O boundary so a
      // rejected oversized intent cannot be mistaken for a failed durable save.
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new MobileGoalDraftInvalidError('当前设备工作面已超过原保存范围；本次请求未发送，原记录与本页草稿保留，请先保全内容。')
      return result
    }, recordId, committed => {
      const draft = committed.goalDrafts?.find(item => mobileGoalDraftKey(item.goalId, item.scope) === key) ?? null
      const applied = sameValue(draft, captured)
      const conflict = applied ? null : committed.goalDraftConflicts?.find(item => sameValue(item, captured)) ?? null
      return { recordId: committed.recordId ?? null, applied, draft: structuredClone(draft), conflict: structuredClone(conflict) }
    })
  }
  /** One original Knowledge entry, preserving other fields under the existing transaction. */
  editKnowledgeDraft(expected: MobileKnowledgeDraft | null, next: MobileKnowledgeDraft, recordId: string | null): Promise<MobileKnowledgeDraftCommit> {
    const captured = parseMobileKnowledgeDraft(next), previous = expected === null ? null : parseMobileKnowledgeDraft(expected)
    const key = mobileKnowledgeDraftKey(captured.topicId, captured.entryId, captured.scope)
    if (previous && mobileKnowledgeDraftKey(previous.topicId, previous.entryId, previous.scope) !== key) throw new MobileKnowledgeDraftInvalidError('知识草稿的原条目或 Host 不同；本次保存未发送，原正文保留。')
    return this.update(value => {
      const drafts = value.knowledgeDrafts ?? [], current = drafts.find(item => mobileKnowledgeDraftKey(item.topicId, item.entryId, item.scope) === key) ?? null
      let result: DeviceWorkface
      if (!sameValue(current, previous) && !sameValue(current, captured)) {
        const conflicts = value.knowledgeDraftConflicts ?? []
        result = { ...value, knowledgeDraftConflicts: conflicts.some(item => sameValue(item, captured)) ? conflicts : [...conflicts, captured] }
      } else result = { ...value, knowledgeDrafts: [...drafts.filter(item => mobileKnowledgeDraftKey(item.topicId, item.entryId, item.scope) !== key), captured] }
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new MobileKnowledgeDraftInvalidError('当前设备工作面已超过原保存范围；本次请求未发送，原记录与本页草稿保留，请先保全内容。')
      return result
    }, recordId, committed => {
      const draft = committed.knowledgeDrafts?.find(item => mobileKnowledgeDraftKey(item.topicId, item.entryId, item.scope) === key) ?? null
      const applied = sameValue(draft, captured)
      const conflict = applied ? null : committed.knowledgeDraftConflicts?.find(item => sameValue(item, captured)) ?? null
      return { recordId: committed.recordId ?? null, applied, draft: structuredClone(draft), conflict: structuredClone(conflict) }
    })
  }
  /** One exact Mote file draft; business writes still belong to the public Files owner. */
  editMoteFileDraft(expected: MoteFileDraft | null, next: MoteFileDraft, recordId: string | null): Promise<MoteFileDraftCommit> {
    const captured = parseMoteFileDraft(next), previous = expected === null ? null : parseMoteFileDraft(expected)
    const key = moteFileDraftKey(captured.scope)
    if (previous && moteFileDraftKey(previous.scope) !== key) throw new MoteFileDraftInvalidError('原文件、Mote 或 Host 不同；正文保留，本次保存未发送。')
    return this.update(value => {
      const drafts = value.moteFileDrafts ?? [], current = drafts.find(item => moteFileDraftKey(item.scope) === key) ?? null
      let result: DeviceWorkface
      if (!sameValue(current, previous) && !sameValue(current, captured)) {
        const conflicts = value.moteFileDraftConflicts ?? []
        result = { ...value, moteFileDraftConflicts: conflicts.some(item => sameValue(item, captured)) ? conflicts : [...conflicts, captured] }
      } else result = { ...value, moteFileDrafts: [...drafts.filter(item => moteFileDraftKey(item.scope) !== key), captured] }
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new MoteFileDraftCapacityError('设备原工作面超过备份范围；本次设备更新未应用，原记录与当前正文保留。')
      return result
    }, recordId, committed => {
      const draft = committed.moteFileDrafts?.find(item => moteFileDraftKey(item.scope) === key) ?? null
      const applied = sameValue(draft, captured)
      const conflict = applied ? null : committed.moteFileDraftConflicts?.find(item => sameValue(item, captured)) ?? null
      return { recordId: committed.recordId ?? null, applied, draft: structuredClone(draft), conflict: structuredClone(conflict) }
    })
  }
  editConversation(edits: ConversationEdit[], recordId: string | null): Promise<ConversationCommit> {
    const captured = structuredClone(edits)
    return this.update(value => {
      const conversation = structuredClone(value.conversation)
      const conflicts = conversation.conflicts ?? []
      for (const edit of captured) {
        const items = ((conversation as Record<ConversationBucket, Array<[string, ConversationValue]>>)[edit.bucket] ??= [])
        const at = items.findIndex(([key]) => key === edit.key), current = at < 0 ? undefined : items[at]![1]
        if ((value.recordId ?? null) !== recordId || !sameValue(current, edit.expected) && !sameValue(current, edit.next)) {
          if (edit.next !== undefined && !sameValue(current, edit.next)) {
            const conflict = { bucket: edit.bucket, key: edit.key, value: edit.next }
            if (!conflicts.some(item => sameValue(item, conflict))) conflicts.push(conflict)
          }
          continue
        }
        if (at >= 0) items.splice(at, 1)
        if (edit.next !== undefined) items.push([edit.key, edit.next])
      }
      if (conflicts.length) conversation.conflicts = conflicts
      return { ...value, conversation: parseDraftRecord(conversation) }
    }, recordId, committed => ({ recordId: committed.recordId ?? null, conversation: structuredClone(committed.conversation) }))
  }
  retainFileUpload(input: MobileFileUpload, expectedRecordId = this.recordIdentity(), expectedUpload?: MobileFileUpload): Promise<void> {
    const upload = parseMobileFileUpload(input)
    return this.update(value => {
      const current = value.fileUploads ?? []
      const previous = current.find(item => item.identity.operationId === upload.identity.operationId)
      if (expectedUpload && !sameValue(previous, expectedUpload)) throw new Error('原附件记录已变化；迟到回执保留，不覆盖较新状态。')
      if (previous && (previous.runtimeId !== upload.runtimeId || JSON.stringify(previous.identity) !== JSON.stringify(upload.identity))) throw new Error('原附件的目标或内容不同；保留原记录，不覆盖或换目标。')
      return { ...value, fileUploads: previous ? current.map(item => item === previous ? upload : item) : [...current, upload] }
    }, expectedRecordId)
  }
  removeFileUpload(operationId: string, expectedRecordId = this.recordIdentity()): Promise<void> {
    return this.update(value => {
      const current = value.fileUploads ?? []
      const original = current.find(item => item.identity.operationId === operationId)
      if (original?.phase === 'sending' || original?.phase === 'unknown') throw new Error('原上传回执尚未确认；记录保留，可核对原操作。')
      return { ...value, fileUploads: current.filter(item => item !== original) }
    }, expectedRecordId)
  }
  selectGoal(next: GoalWorkSelection | null): Promise<void> {
    return this.update(value => {
      return { ...value, goalWork: { selection: next === null ? null : selection(next), pending: value.goalWork?.pending ?? [] } }
    })
  }
  retainGoalOperation(operation: MobileGoalOperation): Promise<void> {
    return this.update(value => {
      const current = value.goalWork ?? { selection: null, pending: [] }
      const existing = current.pending.find(op => op.operationId === operation.operationId)
      if (existing && !sameGoalOperation(existing, operation)) throw new Error('原目标操作的内容不同；保留原操作，不能换目标重试。')
      if (!existing && current.pending.some(op => op.runtimeId === operation.runtimeId && op.sessionId === operation.sessionId && op.goalId === operation.goalId
        && (op.deviceHostId === null || operation.deviceHostId === null || op.deviceHostId === operation.deviceHostId))) throw new Error('这个原目标已有待确认操作；请先检查并重试原操作，不替换为新的操作。')
      const pending = existing ? current.pending : [...current.pending, operation]
      return { ...value, goalWork: parseGoalWorkface({ ...current, pending }) }
    })
  }
  confirmGoalOperation(operation: MobileGoalOperation, expectedRecordId = this.recordIdentity()): Promise<void> {
    return this.update(value => {
      const current = value.goalWork
      if (!current) return value
      const existing = current.pending.find(op => op.operationId === operation.operationId)
      if (!existing || !sameGoalOperation(existing, operation)) return value
      return { ...value, goalWork: { ...current, pending: current.pending.filter(op => op !== existing) } }
    }, expectedRecordId)
  }
  retainGoalIntent(intent: GoalIntent, expectedRecordId = this.recordIdentity()): Promise<void> {
    const work = this.update(record => {
      const value = parseGoalIntent(intent), current = record.goalIntents ?? []
      const existing = current.find(item => item.operationId === value.operationId)
      if (existing || current.some(item => sameGoalIntentScope(item, value) && (value.kind === 'create' ? item.kind === 'create' : item.kind !== 'create' && item.goalId === value.goalId))) throw new Error('原 Goal 已有待核对的操作意图；先读原目标，不替换或重复提交。')
      return { ...record, goalIntents: [...current, value] }
    }, expectedRecordId).catch(error => { if (error instanceof DeviceWorkfaceRecordChangedError || !this.issue) throw error }).finally(() => this.notifyGoalIntents())
    this.goalIntentFlights.set(intent.operationId, expectedRecordId)
    return work
  }
  releaseGoalIntent(intent: GoalIntent, expectedRecordId = this.recordIdentity()): void {
    if (this.goalIntentFlights.get(intent.operationId) === expectedRecordId) this.goalIntentFlights.delete(intent.operationId)
    this.notifyGoalIntents()
  }
  settleGoalIntent(intent: GoalIntent, phase: 'unknown' | 'saved' | 'confirmed', expectedRecordId = this.recordIdentity(), expectedIntent = this.snapshot().record.goalIntents?.find(item => item.operationId === intent.operationId)): Promise<void> {
    if (this.goalIntentRunning(intent.operationId)) throw new Error('原操作仍在等待回执，当前读取不能代签它。')
    return this.update(value => {
      const current = value.goalIntents ?? [], existing = current.find(item => item.operationId === intent.operationId)
      if (!existing || !sameGoalIntent(existing, intent)) return value
      if (!sameValue(existing, expectedIntent)) throw new Error('原 Goal 意图已变化；迟到回执不能覆盖较新状态。')
      const next = phase === 'confirmed' ? current.filter(item => item !== existing) : current.map(item => item === existing ? { ...item, phase } : item)
      return { ...value, goalIntents: next }
    }, expectedRecordId).catch(error => { if (error instanceof DeviceWorkfaceRecordChangedError || !this.issue) throw error }).finally(() => this.notifyGoalIntents())
  }
  confirmHost(host: NonNullable<DeviceWorkface['host']>): Promise<void> {
    return this.update(value => {
      if (!origin(host.origin) || !id(host.hostId)) throw invalid()
      if (value.host && (value.host.hostId !== host.hostId)) {
        throw new DeviceHostMismatchError('当前 Mac 与已保全工作面的原 Host 身份不同。原会话、草稿和未确认输入仍保留；请接回原 Mac，或明确建立另一份设备工作面。')
      }
      return { ...value, host: { ...host } }
    })
  }
  exportBackup(): string {
    this.refresh()
    return JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: this.value }, null, 2)
  }
  parseBackup(bytes: string): DeviceWorkface {
    if (new TextEncoder().encode(bytes).byteLength > MAX_BYTES) throw invalid()
    const backup = record(JSON.parse(bytes), ['schema', 'workface'])
    if (backup.schema !== 'agentmux.mobile-workface.v1') throw invalid()
    return parseDeviceWorkface(backup.workface)
  }
  replaceBackup(next: DeviceWorkface): Promise<void> {
    const parsed = parseDeviceWorkface(next)
    const work = this.tail.then(() => this.exclusive(() => {
      const adopted = { ...parsed, recordId: randomClientRequestId() }
      this.write(adopted)
      this.value = adopted; this.temporary = false
      this.notifyGoalIntents()
    }))
    this.tail = work.catch(() => {})
    return work
  }
  replaceUnreadableWithCurrent(navigation?: Navigation): Promise<void> {
    const next = navigation ? { ...this.value, ...navigation } : this.value
    return this.replaceBackup(next)
  }

}

const stores = new WeakMap<object, DeviceWorkfaceStore>()
const getterStores = new WeakMap<StorageGetter, DeviceWorkfaceStore>()
export function getDeviceWorkface(storage: StorageGetter = defaultStorage): DeviceWorkfaceStore {
  const known = getterStores.get(storage)
  if (known) return known
  let target: DeviceStorage
  try { target = storage() } catch {
    const owner = new DeviceWorkfaceStore(storage)
    getterStores.set(storage, owner)
    return owner
  }
  let owner = stores.get(target)
  if (!owner) { owner = new DeviceWorkfaceStore(storage); stores.set(target, owner) }
  getterStores.set(storage, owner)
  return owner
}
