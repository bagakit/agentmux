import type { MobileQuestionReplyAttempt } from './question-replies'
import type { MobileMoteMainInput } from './mote-main-input'
import type { AgentInputMoteSource, AgentInputSubmissionReceipt, AgentInputWaitRef, AgentInputWaitStopReceipt, AgentSessionHistoryQuestionAnswer, AgentMuxAgentInteractionInput, AgentMuxInteractionOperationReceipt, AgentPromptSubmissionRecord } from '@agentmux/core'
import type { AgentPromptCondition } from '@agentmux/core/prompt-condition'
import { DeviceWorkfaceRecordChangedError, getDeviceWorkface, type ConversationBucket, type ConversationCommit, type ConversationConflict, type ConversationEdit, type ConversationValue, type DraftRecord, type DeviceWorkface, type UnstoredConversationDraft } from '../recovery/device-workface'

export type PromptAttempt = {
  operationId: string
  runId: string | null
  draft: string
  /** Original device text slot; the input attempt still belongs to its exact Session key. */
  textSource?: { key: string; recordId: string | null }
  /** Source declared by a new logical-Main producer, frozen before its first request. */
  admissionIntent?: { kind: 'session-conversation' }
  /** Frozen at explicit input; absence on an old operation remains unknown on retry. */
  moteSource?: AgentInputMoteSource
  /** Platform discovery frozen before first intake; old absent values remain absent. */
  agentMuxNote?: string
  /** Frozen before original logical-main intake; old generic operations stay generic. */
  moteMain?: MobileMoteMainInput
  phase: 'sending' | 'unknown' | 'rejected' | 'confirmed'
  message: string
  request?: { condition: AgentPromptCondition; execution: 'default' | 'immediate'; explicit: boolean; runtimeId: string | null }
  /** A new explicit producer, frozen before its first intake. Old exact requests stay exact. */
  manualInput?: { agentSessionId: string; expectedRun: { runId: string }; runtimeId: string | null;
    stopIntent?: { ref: AgentInputWaitRef; cancelOperationId: string }; stopReceipt?: AgentInputWaitStopReceipt }
  /** Live projection only. Cold readers inspect the original Core key instead of restoring authority. */
  inputReceipt?: AgentInputSubmissionReceipt
  /** Live original Core observation; never serialized as cold authority. */
  mainRecord?: AgentPromptSubmissionRecord
  /** Missing means historical/unknown, never permission to construct another input. */
  inputRequested?: boolean
  originalRuntimeId?: string | null
  originalHostId?: string | null
  explicit?: boolean
  logId?: string
  /** The author explicitly recovered this text into the draft; original delivery remains queryable. */
  movedToDraft?: true
}
export type ResponseAttempt = { phase: PromptAttempt['phase']; message: string;
  /** Live Core evidence. Cold readers inspect the original intent again. */
  receipt?: AgentMuxInteractionOperationReceipt;
  /** Frozen device intent only. Cold readers query Core; they never restore dispatch authority. */
  original?: { input: AgentMuxAgentInteractionInput; hostId: string; runtimeId: string | null } }
function restoredMessage(value: PromptAttempt['phase'], interaction = false): string {
  if (value === 'unknown') return interaction
    ? '重启前的答复还没确认送达，不会重复发送。可以打开对话查看。'
    : '重启前的消息还没确认送达，不会自动重发。可以刷新对话查看。'
  return value === 'confirmed' ? '先前已由 Core 确认；当前连接另行核对。' : '这条消息没有发送或被拒绝。'
}

/** Derived routing only; the original keyed Map remains the device intent owner. */
class SessionIntents<T> extends Map<string, T> {
  private readonly sessionKeys = new Map<string, Set<string>>()
  private sessionId(key: string): string | undefined {
    try { const parts: unknown = JSON.parse(key); return Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : undefined }
    catch { return undefined }
  }
  override set(key: string, attempt: T): this {
    const sessionId = this.sessionId(key)
    if (sessionId !== undefined) {
      let keys = this.sessionKeys.get(sessionId)
      if (!keys) this.sessionKeys.set(sessionId, keys = new Set())
      keys.add(key)
    }
    return super.set(key, attempt)
  }
  override delete(key: string): boolean {
    const sessionId = this.sessionId(key), keys = sessionId === undefined ? undefined : this.sessionKeys.get(sessionId)
    keys?.delete(key)
    if (keys?.size === 0) this.sessionKeys.delete(sessionId!)
    return super.delete(key)
  }
  override clear(): void { super.clear(); this.sessionKeys.clear() }
  *forSession(sessionId: string): IterableIterator<[string, T]> {
    for (const key of this.sessionKeys.get(sessionId) ?? []) {
      const attempt = this.get(key)
      if (attempt) yield [key, attempt]
    }
  }
}

/** Device-owned drafts and original intent guards only. No credentials, message log or send queue. */
export function createLocalDrafts(storage?: () => Pick<Storage, 'getItem' | 'setItem'>) {
  const drafts = new Map<string, string>(), moteTextSources = new Map<string, string>(), attempts = new Map<string, PromptAttempt>(), responses = new SessionIntents<ResponseAttempt>(), questions = new SessionIntents<MobileQuestionReplyAttempt>(), questionDrafts = new Map<string, AgentSessionHistoryQuestionAnswer[]>()
  const owner = getDeviceWorkface(storage)
  const state = { drafts, moteTextSources, attempts, responses, questions, questionDrafts, conflicts: [] as ConversationConflict[], canSave: true, notice: null as string | null, save, saveText, exportBackup, unstoredDraftEdits, recordChanged: false,
    get saveIssue() { return owner.snapshot().issue },
    get hasUnconfirmedSave() { return pendingSaves > 0 || saveRevision !== durableRevision } }
  let baseline: DraftRecord = { version: 1, drafts: [], attempts: [], responses: [] }
  let durableBaseline = baseline
  const snapshot = owner.snapshot()
  let originalRecord: DeviceWorkface = snapshot.record
  let recordId: string | null = null
  let saveRevision = 0, durableRevision = 0, pendingSaves = 0
  // Edit identity only: a late whole-save callback cannot replace newer text,
  // including an edit back to the same string. Durable data remains in the original baselines.
  const textEdits = new Map<string, { bucket: 'drafts' | 'moteTextSources'; key: string; intent: object; acknowledged: number }>()
  try {
    if (snapshot.issue) {
      state.canSave = false
      state.notice = '暂时读不到这台手机上的草稿，已存的记录尚未覆盖。当前草稿和未确认输入都还在，可以继续编辑和复制，恢复设备存储后再保存当前工作面。'
    }
    {
      originalRecord = snapshot.record
      const value = snapshot.record.conversation
      baseline = value
      durableBaseline = value
      recordId = snapshot.record.recordId ?? null
      state.conflicts = value.conflicts ?? []
      const savedDrafts = value.drafts, savedAttempts = value.attempts, savedResponses = value.responses
      for (const [key, draft] of savedDrafts) drafts.set(key, draft as string)
      for (const [scope, key] of value.moteTextSources ?? []) moteTextSources.set(scope, key)
      for (const [key, item] of savedAttempts) {
        const intent = item as PromptAttempt, status = intent.phase === 'sending' ? 'unknown' : intent.phase
        attempts.set(key, { ...intent, phase: status, message: restoredMessage(status) })
      }
      for (const [key, attempt] of value.questions ?? []) questions.set(key, { ...attempt, phase: attempt.phase === 'sending' ? 'unknown' : attempt.phase })
      for (const [key, answers] of value.questionDrafts ?? []) questionDrafts.set(key, answers)
      for (const [key, item] of savedResponses) {
        const status = (item as ResponseAttempt).phase === 'sending' ? 'unknown' : (item as ResponseAttempt).phase
        responses.set(key, { ...item, phase: status, message: restoredMessage(status, true) })
      }
    }
  } catch {
    state.canSave = false
    state.notice = '暂时读不到这台手机上的草稿，已存的记录尚未覆盖。可以继续编辑和复制，但修改只留在当前页面。请恢复设备存储后重新读取。'
  }
  function serialize(): DraftRecord {
      const record: DraftRecord = { version: 1, drafts: [...drafts],
        ...(moteTextSources.size ? { moteTextSources: [...moteTextSources] } : {}),
        attempts: [...attempts].map(([key, intent]) => [key, {
          operationId: intent.operationId, runId: intent.runId,
          // Failed original bodies are retained for explicit retry. Confirmed bodies
          // remain in Core history and are removed from this device-owned intent.
          draft: intent.phase === 'confirmed' && !intent.manualInput ? '' : intent.draft, phase: intent.phase,
          ...(intent.textSource ? { textSource: structuredClone(intent.textSource) } : {}),
          ...(intent.admissionIntent ? { admissionIntent: structuredClone(intent.admissionIntent) } : {}),
          ...(intent.request ? { request: structuredClone(intent.request) } : {}), ...(intent.logId ? { logId: intent.logId } : {}),
          ...(intent.manualInput ? { manualInput: structuredClone(intent.manualInput) } : {}),
          ...(intent.moteSource ? { moteSource: structuredClone(intent.moteSource) } : {}),
          ...(intent.agentMuxNote === undefined ? {} : { agentMuxNote: intent.agentMuxNote }),
          ...(intent.moteMain ? { moteMain: structuredClone(intent.moteMain) } : {}),
          ...(intent.inputRequested !== undefined ? { inputRequested: intent.inputRequested } : {}),
          ...(intent.originalRuntimeId !== undefined ? { originalRuntimeId: intent.originalRuntimeId } : {}),
          ...(intent.originalHostId !== undefined ? { originalHostId: intent.originalHostId } : {}),
          ...(intent.explicit !== undefined ? { explicit: intent.explicit } : {}),
          ...(intent.movedToDraft ? { movedToDraft: true as const } : {})
        }]), responses: [...responses].map(([key, intent]) => [key, { phase: intent.phase,
          ...(intent.original ? { original: structuredClone(intent.original) } : {}) }]),
        ...(questions.size ? { questions: [...questions].map(([key, intent]) => [key, structuredClone(intent)] as [string, MobileQuestionReplyAttempt]) } : {}),
        ...(questionDrafts.size ? { questionDrafts: [...questionDrafts].map(([key, answers]) => [key, structuredClone(answers)] as [string, AgentSessionHistoryQuestionAnswer[]]) } : {}) }
      return record
  }
  function unstoredDraftEdits(): UnstoredConversationDraft[] {
    const saved = new Map(durableBaseline.drafts)
    return [...drafts].flatMap(([key, next]) => next === saved.get(key) ? [] : [{ key, expected: saved.get(key), next }])
  }
  function exportBackup(): string {
    const current = owner.snapshot().record
    const record = (current.recordId ?? null) === recordId ? current : originalRecord
    return JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...record, conversation: serialize() } }, null, 2)
  }
  function save(): Promise<boolean> {
    const captured = serialize(), revision = ++saveRevision, expectedRecordId = recordId
    const capturedTextEdits = new Map([...textEdits].map(([key, value]) => [key, value.intent]))
    const edits: ConversationEdit[] = []
    for (const bucket of ['drafts', 'attempts', 'responses', 'questions', 'questionDrafts', 'moteTextSources'] as ConversationBucket[]) {
      const before = new Map<string, ConversationValue>(baseline[bucket] ?? []), after = new Map<string, ConversationValue>(captured[bucket] ?? [])
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))) edits.push({ bucket, key, expected: before.get(key), next: after.get(key) })
      }
    }
    baseline = captured
    let operation: Promise<ConversationCommit>
    try { operation = owner.editConversation(edits, recordId) } catch (error) { operation = Promise.reject(error) }
    return acknowledge(operation, revision, expectedRecordId, saved => {
      // Do not erase edits made while saving. Replace a conflicted attempt object,
      // so its pending callback cannot mistake it for the canonical original.
      const current = serialize()
      for (const bucket of ['drafts', 'attempts', 'responses', 'questions', 'questionDrafts', 'moteTextSources'] as ConversationBucket[]) {
        const before = new Map<string, ConversationValue>(captured[bucket] ?? []), now = new Map<string, ConversationValue>(current[bucket] ?? [])
        const disk = new Map<string, ConversationValue>(saved[bucket] ?? [])
        for (const key of new Set([...before.keys(), ...disk.keys()])) {
          if (bucket === 'drafts' || bucket === 'moteTextSources') {
            const text = textEdits.get(bucket + ':' + key)
            if (text && text.acknowledged <= revision) text.acknowledged = revision
            if (text?.intent !== capturedTextEdits.get(bucket + ':' + key)) continue
          }
          if (JSON.stringify(now.get(key)) !== JSON.stringify(before.get(key))) continue
          const value = disk.get(key)
          if (bucket === 'drafts') { if (value === undefined) drafts.delete(key); else drafts.set(key, value as string) }
          else if (bucket === 'moteTextSources') { if (value === undefined) moteTextSources.delete(key); else moteTextSources.set(key, value as string) }
          else if (bucket === 'attempts') {
            if (JSON.stringify(value) === JSON.stringify(now.get(key))) continue
            if (value === undefined) attempts.delete(key)
            else { const intent = value as Omit<PromptAttempt, 'message'>, phase = intent.phase === 'sending' ? 'unknown' : intent.phase; attempts.set(key, { ...intent, phase, message: restoredMessage(phase) }) }
          } else if (bucket === 'questions') {
            if (JSON.stringify(value) === JSON.stringify(now.get(key))) continue
            if (value === undefined) questions.delete(key)
            else { const intent = value as MobileQuestionReplyAttempt; questions.set(key, { ...intent, phase: intent.phase === 'sending' ? 'unknown' : intent.phase }) }
          } else if (bucket === 'questionDrafts') {
            if (value === undefined) questionDrafts.delete(key)
            else questionDrafts.set(key, value as AgentSessionHistoryQuestionAnswer[])
          } else {
            if (JSON.stringify(value) === JSON.stringify(now.get(key))) continue
            if (value === undefined) responses.delete(key)
            else { const intent = value as ResponseAttempt, phase = intent.phase === 'sending' ? 'unknown' : intent.phase; responses.set(key, { ...intent, phase, message: restoredMessage(phase, true) }) }
          }
        }
      }
      let durable = saved
      for (const text of textEdits.values()) if (text.acknowledged > revision) {
        durable = withText(durable, text.bucket, text.key, durableBaseline[text.bucket]?.find(([key]) => key === text.key)?.[1])
      }
      durableBaseline = durable
      if (revision === saveRevision) baseline = durable
    })
  }
  /** A text edit owns these exact keys, not a snapshot of other input intents. */
  function saveText(key: string, expected: string | undefined, source?: { key: string; expected: string | undefined; next: string }): Promise<boolean> {
    const revision = ++saveRevision, expectedRecordId = recordId, token = {}
    const edits = [{ bucket: 'drafts' as const, key, expected, next: drafts.get(key) },
      ...(source ? [{ bucket: 'moteTextSources' as const, ...source }] : [])]
    for (const edit of edits) {
      const address = edit.bucket + ':' + edit.key, previous = textEdits.get(address)
      if (previous) previous.intent = token
      else textEdits.set(address, { bucket: edit.bucket, key: edit.key, intent: token, acknowledged: 0 })
    }
    let operation: Promise<ConversationCommit>
    try { operation = owner.editConversation(edits, recordId) } catch (error) { operation = Promise.reject(error) }
    return acknowledge(operation, revision, expectedRecordId, saved => {
      for (const edit of edits) {
        const values = edit.bucket === 'drafts' ? drafts : moteTextSources
        const text = textEdits.get(edit.bucket + ':' + edit.key)!
        if (text.acknowledged > revision) continue
        const value = saved[edit.bucket]?.find(([key]) => key === edit.key)?.[1]
        text.acknowledged = revision
        baseline = withText(baseline, edit.bucket, edit.key, value)
        durableBaseline = withText(durableBaseline, edit.bucket, edit.key, value)
        if (text.intent !== token || values.get(edit.key) !== edit.next) continue
        if (value === undefined) values.delete(edit.key); else values.set(edit.key, value)
      }
      // Only the acknowledged text fields advance; other input intents still
      // require the original complete save before an explicit send.
    })
  }
  function withText(record: DraftRecord, bucket: 'drafts' | 'moteTextSources', key: string, value: string | undefined): DraftRecord {
    if (record[bucket]?.find(([id]) => id === key)?.[1] === value) return record
    const others = (record[bucket] ?? []).filter(([id]) => id !== key)
    return { ...record, [bucket]: value === undefined ? others : [...others, [key, value]] }
  }
  function acknowledge(operation: Promise<ConversationCommit>, revision: number, expectedRecordId: string | null,
    adopt: (saved: DraftRecord) => void): Promise<boolean> {
    pendingSaves++
    return operation.then(committed => {
      if (committed.recordId !== expectedRecordId || owner.recordIdentity() !== expectedRecordId) {
        throw new DeviceWorkfaceRecordChangedError('这台手机上的工作面已被替换，这次保存结果没有写入。')
      }
      const saved = committed.conversation
      const currentReceipt = revision >= durableRevision
      adopt(saved)
      if (currentReceipt) state.conflicts = saved.conflicts ?? []
      durableRevision = Math.max(durableRevision, revision)
      if (revision === saveRevision) {
        state.canSave = true
        state.recordChanged = false
        state.notice = state.conflicts.length ? '另一个页面更新了同一条记录，两份正文都已保留。请核对保留的内容，不会自动重发。' : null
      }
      return true
    }).catch(error => {
      const issue = owner.snapshot().issue
      if (revision === saveRevision) baseline = durableBaseline
      state.recordChanged = error instanceof DeviceWorkfaceRecordChangedError
      state.canSave = !state.recordChanged && owner.canRetrySave()
      state.notice = error instanceof DeviceWorkfaceRecordChangedError ? error.message : issue ?? '草稿暂时存不到这台手机上，先前记录仍保留。可以继续编辑和发送，但新草稿只留在当前页面。请恢复设备存储后重试保存。'
      return !(error instanceof DeviceWorkfaceRecordChangedError)
    }).finally(() => {
      if (--pendingSaves === 0) textEdits.clear()
    })
  }
  return state
}
