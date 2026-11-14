import { parseQuestionReplyAttempt, questionReplyKey, type QuestionReplyAttempt } from '@agentmux/client-ui/conversation-question-reply'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { AgentPromptNotApplied } from '@agentmux/core/prompt-condition'

export type DesktopQuestionReplyAttempt = QuestionReplyAttempt & { hostId: string }
export type DesktopQuestionReplies = Record<string, Record<string, DesktopQuestionReplyAttempt>>

/** An authoritative refusal settles only the original unknown attempt, never a later input. */
export function rejectedQuestionReply(control: AgentSessionControl, notApplied: AgentPromptNotApplied,
  key: string, attempt: DesktopQuestionReplyAttempt): DesktopQuestionReplyAttempt | null {
  try {
    if (attempt?.phase !== 'unknown') return null
    parseQuestionReplyAttempt(attempt)
    if (key !== questionReplyKey(control.agentSessionId, attempt.input) ||
      attempt.hostId !== control.hostId || notApplied.submissionId !== attempt.input.operationId ||
      notApplied.run.runId !== attempt.input.expectedRun.runId || control.run.runId !== attempt.input.expectedRun.runId) return null
    return { ...attempt, phase: 'rejected', diagnostic: {
      code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core confirmed the original reply was not applied. Your edited answer is kept and can be sent as a new explicit reply.'
    } }
  } catch { return null } // Unreadable original intent remains held, without inventing a new result.
}

/** Restart retains the exact request and removes only the old component's in-flight claim. */
export function restoredQuestionReplies(value: DesktopQuestionReplies): DesktopQuestionReplies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([sessionId, replies]) => [sessionId,
    !replies || typeof replies !== 'object' || Array.isArray(replies) ? replies : Object.fromEntries(Object.entries(replies).map(([key, attempt]) => {
      try { parseQuestionReplyAttempt(attempt); return [key, attempt.phase === 'sending' ? { ...attempt, phase: 'unknown' } : attempt] }
      catch { return [key, attempt] } // Preserve unreadable original intent; the dispatch boundary refuses it.
    }))]))
}

export type DesktopQuestionDrafts = Record<string, Record<string, QuestionReplyAttempt['input']['answers']>>
