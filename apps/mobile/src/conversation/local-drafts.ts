import { getDeviceWorkface, type DraftRecord } from '../recovery/device-workface'

export type PromptAttempt = {
  operationId: string
  runId: string | null
  draft: string
  phase: 'sending' | 'unknown' | 'rejected' | 'confirmed'
  message: string
}
export type ResponseAttempt = { phase: PromptAttempt['phase']; message: string }
function restoredMessage(value: PromptAttempt['phase'], interaction = false): string {
  if (value === 'unknown') return interaction
    ? '重启后的原请求答复回执未知；不会重复回答，请核对原会话。'
    : '重启后的原输入回执未知；草稿保留，不会自动重投，请刷新核对原会话。'
  return value === 'confirmed' ? '先前已由 Core 确认；当前连接另行核对。' : '原输入未发送或已被拒绝；草稿保留。'
}

/** Device-owned drafts and original intent guards only. No credentials, message log or send queue. */
export function createLocalDrafts(storage?: () => Pick<Storage, 'getItem' | 'setItem'>) {
  const drafts = new Map<string, string>(), attempts = new Map<string, PromptAttempt>(), responses = new Map<string, ResponseAttempt>()
  const owner = getDeviceWorkface(storage)
  const state = { drafts, attempts, responses, canSave: true, notice: null as string | null, save }
  try {
    const snapshot = owner.snapshot()
    if (snapshot.issue) {
      state.canSave = false
      state.notice = '本机草稿存储暂时无法读取，原记录尚未覆盖。当前草稿和未确认输入仍保留，可继续编辑和复制；请恢复设备存储后明确保存当前工作面。'
    }
    {
      const value = snapshot.record.conversation
      const savedDrafts = value.drafts, savedAttempts = value.attempts, savedResponses = value.responses
      for (const [key, draft] of savedDrafts) drafts.set(key, draft as string)
      for (const [key, item] of savedAttempts) {
        const intent = item as PromptAttempt, status = intent.phase === 'sending' ? 'unknown' : intent.phase
        attempts.set(key, { operationId: intent.operationId, runId: intent.runId, draft: intent.draft, phase: status, message: restoredMessage(status) })
      }
      for (const [key, item] of savedResponses) {
        const status = (item as ResponseAttempt).phase === 'sending' ? 'unknown' : (item as ResponseAttempt).phase
        responses.set(key, { phase: status, message: restoredMessage(status, true) })
      }
    }
  } catch {
    state.canSave = false
    state.notice = '本机草稿存储暂时无法读取，原记录尚未覆盖。当前仍可编辑和复制，但本次修改仅在当前运行中保留；请恢复设备存储后重新读取。'
  }
  function save(): void {
    try {
      const record: DraftRecord = { version: 1, drafts: [...drafts],
        attempts: [...attempts].map(([key, intent]) => [key, {
          operationId: intent.operationId, runId: intent.runId,
          // Only an unresolved original draft is needed to reconcile a late receipt. Completed
          // or rejected bodies remain in the authoritative Core history, never a device log.
          draft: intent.phase === 'sending' || intent.phase === 'unknown' ? intent.draft : '', phase: intent.phase
        }]), responses: [...responses].map(([key, intent]) => [key, { phase: intent.phase }]) }
      owner.updateConversation(record)
      state.canSave = true
      state.notice = null
    } catch {
      // localStorage.setItem is atomic: a failed write keeps the previously durable bytes.
      const issue = owner.snapshot().issue
      state.canSave = issue === null
      state.notice = issue ?? '本机草稿暂时无法保存，先前记录仍保留。当前仍可编辑和发送，但新草稿与未知回执仅在本次运行中保留；请恢复设备存储后重试保存。'
    }
  }
  return state
}
