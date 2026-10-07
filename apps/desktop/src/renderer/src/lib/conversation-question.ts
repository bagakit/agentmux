import { type AgentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { parseQuestionReplyAttempt, questionReplyKey,
  questionReplyState, type ConversationQuestionInput, type ConversationQuestionTarget, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { DesktopQuestionReplies } from './conversation-question-intent'
import { retainConversationQuestionReply, retainConversationQuestionDraft, useAppStore } from '../store'

export function desktopQuestionReplyState(replies: DesktopQuestionReplies[string] | undefined,
  sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const value = replies?.[questionReplyKey(sessionId, target)]
  if (!value) return undefined
  try { return questionReplyState(parseQuestionReplyAttempt(value)) }
  catch (error) { return { phase: 'unknown', answers: [], diagnostic: { code: 'QUESTION_REPLY_RECORD_UNAVAILABLE', message: presentError(error) } } }
}
export function reconcileConversationQuestionReplies(control: AgentSessionControl, notApplied?: AgentPromptNotApplied): void {
  if (!notApplied) return
  for (const [key, attempt] of Object.entries(useAppStore.getState().questionReplies?.[control.agentSessionId] ?? {})) {
    if (attempt?.phase === 'confirmed') continue
    try {
      parseQuestionReplyAttempt(attempt)
      if (key !== questionReplyKey(control.agentSessionId, attempt.input)) continue
      if (attempt.phase === 'unknown' && attempt.hostId === control.hostId &&
        notApplied?.submissionId === attempt.input.operationId && notApplied.run.runId === attempt.input.expectedRun.runId &&
        control.run.runId === attempt.input.expectedRun.runId) {
        void retainConversationQuestionReply(control.agentSessionId, key, { ...attempt, phase: 'rejected', diagnostic: {
          code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core confirmed the original reply was not applied. Your edited answer is kept; copy it and answer in the original terminal.'
        } }, attempt).catch(() => {})
      }
    } catch { /* Unreadable original intent remains held; observing another source cannot replace it. */ }
  }
}

export function editConversationQuestionDraft(control: AgentSessionControl, target: ConversationQuestionTarget, answers: ConversationQuestionInput['answers']): void {
  retainConversationQuestionDraft(control.agentSessionId, questionReplyKey(control.agentSessionId, target), answers)
}
