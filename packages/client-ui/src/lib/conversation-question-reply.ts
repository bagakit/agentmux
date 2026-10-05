import type { AgentMuxSessionQuestionReplyInput, AgentSessionHistoryPage, AgentSessionQuestionReplyReceipt } from '@agentmux/core'
import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'

export type ConversationQuestionTarget = Pick<AgentMuxSessionQuestionReplyInput, 'source' | 'turnId' | 'recordId'>
export type ConversationQuestionInput = ConversationQuestionTarget & Pick<AgentMuxSessionQuestionReplyInput, 'answers'>
export type QuestionReplyIntent = ConversationQuestionInput & {
  operationId: string
  expectedRun: { runId: string }
  afterSubmissionId: string | null
}
export type QuestionReplyPhase = 'sending' | 'unknown' | 'submitted' | 'rejected' | 'confirmed'
export type QuestionReplyState = { phase: QuestionReplyPhase; answers: QuestionReplyIntent['answers']; diagnostic?: { code: string; message: string } | undefined }
export type QuestionReplyAttempt = Omit<QuestionReplyState, 'answers'> & { input: QuestionReplyIntent }

/** A native question is addressed within one Session and exact Provider source. */
export function questionReplyKey(sessionId: string, target: ConversationQuestionTarget): string {
  return JSON.stringify([sessionId, target.source.providerId, target.source.nativeSessionId, target.turnId, target.recordId])
}
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
export function questionReplyReceiptMatches(sessionId: string, input: QuestionReplyIntent, receipt: AgentSessionQuestionReplyReceipt): boolean {
  return receipt?.outcome === 'submitted' && receipt.agentSessionId === sessionId && receipt.operationId === input.operationId
    && receipt.recordId === input.recordId && receipt.source?.providerId === input.source.providerId && receipt.source.nativeSessionId === input.source.nativeSessionId
    && Array.isArray(receipt.questionIds) && receipt.questionIds.length === input.answers.length
    && input.answers.every(answer => receipt.questionIds.includes(answer.questionId))
}
/** These are the same accepted native facts the Conversation renders, never ACKs or body guesses. */
export function recordedQuestionAnswers(page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null): Map<string, string> {
  const answers = new Map<string, string>()
  const collect = (value: AgentSessionHistoryPage) => {
    for (const item of value.items) if (item.kind === 'user-message') for (const answer of item.questionAnswers ?? []) answers.set(answer.questionId, answer.answer)
  }
  if (context?.agentSessionId === page.agentSessionId && context.source.providerId === page.source.providerId && context.source.nativeSessionId === page.source.nativeSessionId) collect(context)
  collect(page)
  return answers
}
/** One native page/context index per observation, shared by all related original intents. */
export function createQuestionReplyMatcher(sessionId: string, page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null): (attempt: QuestionReplyAttempt) => boolean {
  let answers: ReadonlyMap<string, string> | undefined
  return attempt => {
    if (page.agentSessionId !== sessionId || page.source.providerId !== attempt.input.source.providerId || page.source.nativeSessionId !== attempt.input.source.nativeSessionId) return false
    answers ??= recordedQuestionAnswers(page, context)
    return attempt.input.answers.every(answer => answers!.has(answer.questionId))
  }
}
/** A dispatched command failure describes its phase, never the whole original input. */
export function questionReplyFailurePhase(previous: QuestionReplyPhase | undefined, dispatched: boolean): 'unknown' | 'rejected' {
  if (previous === 'unknown' || previous === 'sending' || previous === 'submitted' || dispatched) return 'unknown'
  return 'rejected'
}
