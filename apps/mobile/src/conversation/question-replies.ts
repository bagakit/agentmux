import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { agentPromptCondition, agentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { questionReplyKey, submitQuestionReply,
  questionReplyState, type ConversationQuestionInput, type ConversationQuestionTarget, type QuestionReplyAttempt, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import type { createLocalDrafts } from './local-drafts'

export type MobileQuestionReplyAttempt = QuestionReplyAttempt & { runtimeId: string | null; hostId: string }
type Local = ReturnType<typeof createLocalDrafts>
const notAppliedDiagnostic = { code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core 已确认原答复完全未应用；草稿和原操作保留，可明确重新发送答案。' }
export async function submitMobileQuestionReply(local: Local, sessionId: string, client: AgentMuxHostedClient | null,
  input: ConversationQuestionInput, notify: () => void): Promise<void> {
  const key = questionReplyKey(sessionId, input)
  await submitQuestionReply<MobileQuestionReplyAttempt>({
    sessionId,
    get: () => local.questions.get(key),
    create: () => {
      if (!client) throw new Error('原 Host 尚未连接，答案草稿保留；连接恢复后可继续发送。')
      const session = client.agentSession(sessionId)
      return { phase: 'sending', runtimeId: client.runtimeOwnerIdentity()?.runtimeId ?? null, hostId: session.hostId,
        input: structuredClone({ ...input, ...agentPromptCondition(session), operationId: randomClientRequestId() }) }
    },
    retain: async (next, expected) => {
      if (local.questions.get(key) !== expected) throw new Error('另一页面已更新原答复；原操作和草稿保留，请核对原记录。')
      local.questions.set(key, next)
      notify()
      const saved = await local.save(), issue = local.saveIssue
      notify()
      if (!saved || issue || local.questions.get(key) !== next) throw new Error(issue ?? '原答复尚未持久保存；原操作和答案保留，恢复设备存储后可重试。')
    },
    submit: async frozen => {
      if (!client) throw new Error('原 Host 尚未连接，原操作和答案保留；连接恢复后可核对发送结果。')
      const original = local.questions.get(key)!
      let target: AgentMuxAgentSession | undefined
      try { target = client.agentSession(sessionId) } catch { /* Missing observations do not replace the original reply target. */ }
      const runtimeId = client.runtimeOwnerIdentity()?.runtimeId
      if (original.runtimeId && runtimeId && original.runtimeId !== runtimeId || target?.hostId && original.hostId !== target.hostId) {
        throw new Error('当前连接与原答复的 Host 或 Runtime 不一致；原操作保留，不会转向另一处重投。')
      }
      return client.replySessionQuestion({ ...frozen, agentSessionId: sessionId, authorHuman: true, sourceChannel: 'question-reply' })
    }
  })
}
function originalReplyNotApplied(attempt: MobileQuestionReplyAttempt, sessionId: string, session?: AgentMuxAgentSession | null, runtimeId?: string | null): boolean {
  const fact = session && agentPromptNotApplied(session)
  return session?.agentSessionId === sessionId && session.hostId === attempt.hostId &&
    attempt.runtimeId !== null && attempt.runtimeId === runtimeId && fact?.submissionId === attempt.input.operationId &&
    fact.run.runId === attempt.input.expectedRun.runId
}
export function mobileQuestionReplyState(local: Local, sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const attempt = local.questions.get(questionReplyKey(sessionId, target))
  return attempt ? questionReplyState(attempt) : undefined
}
export async function reconcileMobileQuestionReplies(local: Local, sessionId: string, session?: AgentMuxAgentSession | null, runtimeId?: string | null): Promise<boolean> {
  if (!session || !agentPromptNotApplied(session)) return false
  let changed = false
  for (const [key, attempt] of local.questions.forSession(sessionId)) {
    if (key !== questionReplyKey(sessionId, attempt.input) || attempt.phase === 'confirmed') continue
    if (attempt.phase === 'unknown' && originalReplyNotApplied(attempt, sessionId, session, runtimeId)) {
      local.questions.set(key, { ...attempt, phase: 'rejected', diagnostic: notAppliedDiagnostic }); changed = true
    }
  }
  if (changed) await local.save()
  return changed
}
