import type { MobileQuestionReplyAttempt } from './question-replies'
import type { AgentSessionHistoryQuestionAnswer } from '@agentmux/core'
import type { AgentPromptCondition } from '@agentmux/core/prompt-condition'
import { DeviceWorkfaceRecordChangedError, getDeviceWorkface, type ConversationBucket, type ConversationCommit, type ConversationConflict, type ConversationEdit, type ConversationValue, type DraftRecord, type DeviceWorkface } from '../recovery/device-workface'

export type PromptAttempt = {
  operationId: string
  runId: string | null
  draft: string
  phase: 'sending' | 'unknown' | 'rejected' | 'confirmed'
  message: string
  request?: { condition: AgentPromptCondition; execution: 'default' | 'immediate'; explicit: boolean; runtimeId: string | null }
  /** Missing means historical/unknown, never permission to construct another input. */
  inputRequested?: boolean
  originalRuntimeId?: string | null
  originalHostId?: string | null
  explicit?: boolean
  logId?: string
}
export type ResponseAttempt = { phase: PromptAttempt['phase']; message: string }
function restoredMessage(value: PromptAttempt['phase'], interaction = false): string {
  if (value === 'unknown') return interaction
    ? '重启后的原请求答复回执未知；不会重复回答，请核对原会话。'
    : '重启后的原输入回执未知；草稿保留，不会自动重投，请刷新核对原会话。'
  return value === 'confirmed' ? '先前已由 Core 确认；当前连接另行核对。' : '原输入未发送或已被拒绝；草稿保留。'
}

/** Derived routing only; the original keyed Map remains the device intent owner. */
class SessionQuestionReplies extends Map<string, MobileQuestionReplyAttempt> {
  private readonly sessionKeys = new Map<string, Set<string>>()
  private sessionId(key: string): string | undefined {
    try { const parts: unknown = JSON.parse(key); return Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : undefined }
    catch { return undefined }
  }
  override set(key: string, attempt: MobileQuestionReplyAttempt): this {
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
  *forSession(sessionId: string): IterableIterator<[string, MobileQuestionReplyAttempt]> {
    for (const key of this.sessionKeys.get(sessionId) ?? []) {
      const attempt = this.get(key)
      if (attempt) yield [key, attempt]
    }
  }
}

/** Device-owned drafts and original intent guards only. No credentials, message log or send queue. */
export function createLocalDrafts(storage?: () => Pick<Storage, 'getItem' | 'setItem'>) {
  const drafts = new Map<string, string>(), attempts = new Map<string, PromptAttempt>(), responses = new Map<string, ResponseAttempt>(), questions = new SessionQuestionReplies(), questionDrafts = new Map<string, AgentSessionHistoryQuestionAnswer[]>()
  const owner = getDeviceWorkface(storage)
  const state = { drafts, attempts, responses, questions, questionDrafts, conflicts: [] as ConversationConflict[], canSave: true, notice: null as string | null, save, exportBackup, recordChanged: false }
  let baseline: DraftRecord = { version: 1, drafts: [], attempts: [], responses: [] }
  let durableBaseline = baseline
  let originalRecord: DeviceWorkface = owner.snapshot().record
  let recordId: string | null = null
  let saveRevision = 0
  try {
    const snapshot = owner.snapshot()
    if (snapshot.issue) {
      state.canSave = false
      state.notice = '本机草稿存储暂时无法读取，原记录尚未覆盖。当前草稿和未确认输入仍保留，可继续编辑和复制；请恢复设备存储后明确保存当前工作面。'
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
      for (const [key, item] of savedAttempts) {
        const intent = item as PromptAttempt, status = intent.phase === 'sending' ? 'unknown' : intent.phase
        attempts.set(key, { ...intent, phase: status, message: restoredMessage(status) })
      }
      for (const [key, attempt] of value.questions ?? []) questions.set(key, { ...attempt, phase: attempt.phase === 'sending' ? 'unknown' : attempt.phase })
      for (const [key, answers] of value.questionDrafts ?? []) questionDrafts.set(key, answers)
      for (const [key, item] of savedResponses) {
        const status = (item as ResponseAttempt).phase === 'sending' ? 'unknown' : (item as ResponseAttempt).phase
        responses.set(key, { phase: status, message: restoredMessage(status, true) })
      }
    }
  } catch {
    state.canSave = false
    state.notice = '本机草稿存储暂时无法读取，原记录尚未覆盖。当前仍可编辑和复制，但本次修改仅在当前运行中保留；请恢复设备存储后重新读取。'
  }
  function serialize(): DraftRecord {
      const record: DraftRecord = { version: 1, drafts: [...drafts],
        attempts: [...attempts].map(([key, intent]) => [key, {
          operationId: intent.operationId, runId: intent.runId,
          // Failed original bodies are retained for explicit retry. Confirmed bodies
          // remain in Core history and are removed from this device-owned intent.
          draft: intent.phase === 'confirmed' ? '' : intent.draft, phase: intent.phase,
          ...(intent.request ? { request: structuredClone(intent.request) } : {}), ...(intent.logId ? { logId: intent.logId } : {}),
          ...(intent.inputRequested !== undefined ? { inputRequested: intent.inputRequested } : {}),
          ...(intent.originalRuntimeId !== undefined ? { originalRuntimeId: intent.originalRuntimeId } : {}),
          ...(intent.originalHostId !== undefined ? { originalHostId: intent.originalHostId } : {}),
          ...(intent.explicit !== undefined ? { explicit: intent.explicit } : {})
        }]), responses: [...responses].map(([key, intent]) => [key, { phase: intent.phase }]),
        ...(questions.size ? { questions: [...questions].map(([key, intent]) => [key, structuredClone(intent)] as [string, MobileQuestionReplyAttempt]) } : {}),
        ...(questionDrafts.size ? { questionDrafts: [...questionDrafts].map(([key, answers]) => [key, structuredClone(answers)] as [string, AgentSessionHistoryQuestionAnswer[]]) } : {}) }
      return record
  }
  function exportBackup(): string {
    const current = owner.snapshot().record
    const record = (current.recordId ?? null) === recordId ? current : originalRecord
    return JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...record, conversation: serialize() } }, null, 2)
  }
  function save(): Promise<boolean> {
    const captured = serialize(), revision = ++saveRevision, expectedRecordId = recordId
    const edits: ConversationEdit[] = []
    for (const bucket of ['drafts', 'attempts', 'responses', 'questions', 'questionDrafts'] as ConversationBucket[]) {
      const before = new Map<string, ConversationValue>(baseline[bucket] ?? []), after = new Map<string, ConversationValue>(captured[bucket] ?? [])
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))) edits.push({ bucket, key, expected: before.get(key), next: after.get(key) })
      }
    }
    baseline = captured
    let operation: Promise<ConversationCommit>
    try { operation = owner.editConversation(edits, recordId) } catch (error) { operation = Promise.reject(error) }
    return operation.then(committed => {
      if (committed.recordId !== expectedRecordId || owner.recordIdentity() !== expectedRecordId) {
        throw new DeviceWorkfaceRecordChangedError('设备工作面已被替换；原保存回执不能采用新的记录，原正文与操作仍保留。')
      }
      const saved = committed.conversation
      state.conflicts = saved.conflicts ?? []
      // Do not erase edits made while saving. Replace a conflicted attempt object,
      // so its pending callback cannot mistake it for the canonical original.
      const current = serialize()
      for (const bucket of ['drafts', 'attempts', 'responses', 'questions', 'questionDrafts'] as ConversationBucket[]) {
        const before = new Map<string, ConversationValue>(captured[bucket] ?? []), now = new Map<string, ConversationValue>(current[bucket] ?? [])
        const disk = new Map<string, ConversationValue>(saved[bucket] ?? [])
        for (const key of new Set([...before.keys(), ...disk.keys()])) {
          if (JSON.stringify(now.get(key)) !== JSON.stringify(before.get(key))) continue
          const value = disk.get(key)
          if (bucket === 'drafts') { if (value === undefined) drafts.delete(key); else drafts.set(key, value as string) }
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
            else { const phase = (value as ResponseAttempt).phase; responses.set(key, { phase, message: restoredMessage(phase, true) }) }
          }
        }
      }
      durableBaseline = saved
      if (revision === saveRevision) baseline = saved
      state.canSave = true
      state.recordChanged = false
      state.notice = state.conflicts.length ? '另一页面已更新同一条记录；原请求和两份正文均保留。请核对保全内容，不会自动重投。' : null
      return true
    }).catch(error => {
      const issue = owner.snapshot().issue
      if (revision === saveRevision) baseline = durableBaseline
      state.recordChanged = error instanceof DeviceWorkfaceRecordChangedError
      state.canSave = !state.recordChanged && owner.canRetrySave()
      state.notice = error instanceof DeviceWorkfaceRecordChangedError ? error.message : issue ?? '本机草稿暂时无法保存，先前记录仍保留。当前仍可编辑和发送，但新草稿与未知回执仅在本次运行中保留；请恢复设备存储后重试保存。'
      return !(error instanceof DeviceWorkfaceRecordChangedError)
    })
  }
  return state
}
