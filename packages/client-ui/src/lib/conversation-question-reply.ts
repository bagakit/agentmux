import type { ConversationQuestionInput } from '@agentmux/core/conversation'
export type { ConversationQuestionInput, ConversationQuestionTarget } from '@agentmux/core/conversation'
export { questionReplyKey, questionReplyReceiptMatches, recordedQuestionAnswers, createQuestionReplyMatcher } from '@agentmux/core/conversation'
import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'

export type QuestionReplyIntent = ConversationQuestionInput & {
  operationId: string
  expectedRun: { runId: string }
  afterSubmissionId: string | null
}
export type QuestionReplyPhase = 'sending' | 'unknown' | 'submitted' | 'rejected' | 'confirmed'
export type QuestionReplyState = { phase: QuestionReplyPhase; answers: QuestionReplyIntent['answers']; diagnostic?: { code: string; message: string } | undefined }
export type QuestionReplyAttempt = Omit<QuestionReplyState, 'answers'> & { input: QuestionReplyIntent }

export function questionReplyState(attempt: QuestionReplyAttempt): QuestionReplyState {
  return { phase: attempt.phase, answers: attempt.input.answers, ...(attempt.diagnostic ? { diagnostic: attempt.diagnostic } : {}) }
}
export function parseQuestionReplyAttempt(value: unknown): QuestionReplyAttempt {
  if (!value || typeof value !== 'object') throw new Error('The original question reply record is unavailable; it has not been replaced.')
  const attempt = value as QuestionReplyAttempt, input = attempt.input
  const id = (v: unknown) => typeof v === 'string' && v.length > 0
  if (!input || !id(input.operationId) || !id(input.recordId) || !id(input.turnId) || !id(input.source?.providerId) || !id(input.source?.nativeSessionId)
    || !Array.isArray(input.answers) || !input.answers.length || input.answers.some(answer => !id(answer.questionId) || typeof answer.answer !== 'string' || !answer.answer.trim())
    || !['sending', 'unknown', 'submitted', 'rejected', 'confirmed'].includes(attempt.phase)) throw new Error('The original question reply identity or answer is unavailable; it has not been replaced.')
  validateAgentPromptCondition(input)
  if (attempt.diagnostic && (!id(attempt.diagnostic.code) || typeof attempt.diagnostic.message !== 'string')) throw new Error('The original question reply diagnostic is unreadable.')
  return structuredClone(attempt)
}
/** A dispatched command failure describes its phase, never the whole original input. */
export function questionReplyFailurePhase(previous: QuestionReplyPhase | undefined, dispatched: boolean): 'unknown' | 'rejected' {
  if (previous === 'unknown' || previous === 'sending' || previous === 'submitted' || dispatched) return 'unknown'
  return 'rejected'
}
