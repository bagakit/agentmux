import type { AgentMuxAgentSession } from '@agentmux/core'
import { agentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { questionReplyKey,
  questionReplyState, type ConversationQuestionTarget, type QuestionReplyAttempt, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import type { createLocalDrafts } from './local-drafts'

export type MobileQuestionReplyAttempt = QuestionReplyAttempt & { runtimeId: string | null; hostId: string }
type Local = ReturnType<typeof createLocalDrafts>
const notAppliedDiagnostic = { code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core 已确认原答复完全未应用；编辑草稿保留，可复制答案后在原终端回答。' }
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
