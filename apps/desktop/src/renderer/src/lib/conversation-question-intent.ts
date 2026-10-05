import { parseQuestionReplyAttempt, type QuestionReplyAttempt } from '@agentmux/client-ui/conversation-question-reply'

export type DesktopQuestionReplyAttempt = QuestionReplyAttempt & { hostId: string }
export type DesktopQuestionReplies = Record<string, Record<string, DesktopQuestionReplyAttempt>>

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
