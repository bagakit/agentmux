import type { ConversationQuestionInput } from '@agentmux/core/conversation'
import type { AgentSessionQuestionReplyReceipt } from '@agentmux/core'
import { questionReplyReceiptMatches } from '@agentmux/core/conversation'
import { presentError } from './error-presentation.js'
export type { ConversationQuestionInput, ConversationQuestionTarget } from '@agentmux/core/conversation'
export { questionReplyKey, questionReplyReceiptMatches, recordedQuestionAnswers, createQuestionReplyMatcher } from '@agentmux/core/conversation'
import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'

export type QuestionReplyIntent = ConversationQuestionInput & {
  operationId: string
  expectedRun: { runId: string }
  afterSubmissionId: string | null
}
export type QuestionReplyPhase = 'sending' | 'unknown' | 'submitted' | 'rejected' | 'confirmed'
export type QuestionReplyState = { phase: QuestionReplyPhase; answers: QuestionReplyIntent['answers']; original?: QuestionReplyAttempt & { hostId?: string; runtimeId?: string | null }; diagnostic?: { code: string; message: string } | undefined }
export type QuestionReplyAttempt = Omit<QuestionReplyState, 'answers' | 'original'> & { input: QuestionReplyIntent }

export function questionReplyState(attempt: QuestionReplyAttempt): QuestionReplyState {
  return { phase: attempt.phase, answers: attempt.input.answers, original: attempt, ...(attempt.diagnostic ? { diagnostic: attempt.diagnostic } : {}) }
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

/** Hosts retain their own records; both clients share the one explicit reply transition. */
export async function submitQuestionReply<T extends QuestionReplyAttempt>({ sessionId, get, create, retain, submit }: {
  sessionId: string
  get(): T | undefined
  create(): T
  retain(next: T, expected: T | undefined): Promise<void>
  submit(input: QuestionReplyIntent): Promise<AgentSessionQuestionReplyReceipt>
}): Promise<void> {
  const previous = get()
  if (previous) parseQuestionReplyAttempt(previous)
  if (previous && ['sending', 'submitted', 'confirmed'].includes(previous.phase)) return
  // Editing never changes an unresolved original operation or its answers.
  const attempt = { ...(previous?.phase === 'unknown' ? previous : create()), phase: 'sending' as const }
  parseQuestionReplyAttempt(attempt)
  let dispatched = false
  try {
    await retain(attempt, previous)
    dispatched = true
    const receipt = await submit(attempt.input)
    if (!questionReplyReceiptMatches(sessionId, attempt.input, receipt)) throw new Error('The original question reply receipt does not match this operation.')
    await retain({ ...attempt, phase: 'submitted', diagnostic: undefined }, attempt)
  } catch (error) {
    const diagnostic = { code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : 'QUESTION_REPLY_UNCONFIRMED', message: presentError(error) }
    // A failed save may already have retained the record in memory. Never replace another callback's result.
    if (get() === attempt) {
      await retain({ ...attempt, phase: questionReplyFailurePhase(previous?.phase, dispatched), diagnostic }, attempt).catch(() => {})
    }
    throw error
  }
}
