import type { AgentMuxSessionQuestionReplyInput } from './client.js'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentSessionHistoryQuestion, AgentSessionHistoryQuestionAnswer, AgentSessionHistoryQuestionRequest, AgentSessionHistorySource, AgentSessionQuestionReplyReceipt } from './types.js'

export type ConversationQuestionTarget = Pick<AgentMuxSessionQuestionReplyInput, 'source' | 'turnId' | 'recordId'>
export type ConversationQuestionInput = ConversationQuestionTarget & Pick<AgentMuxSessionQuestionReplyInput, 'answers'>
type ReplyIdentity = ConversationQuestionInput & Pick<AgentMuxSessionQuestionReplyInput, 'operationId'>

/** A reading reference, not current pending authority or proof that an input was applied. */
export type ConversationQuestionReference = {
  agentSessionId: string
  executionHostId?: string
  source: AgentSessionHistorySource
  recordId: string
  turnId?: string
  questionId: string
}
export type ConversationQuestionAnswerFact = AgentSessionHistoryQuestionAnswer & {
  agentSessionId: string
  source: AgentSessionHistorySource
  recordId: string
  turnId?: string
  original: AgentSessionHistoryItem
}
export type ConversationQuestionRecord = {
  agentSessionId: string
  source: AgentSessionHistorySource
  recordId: string
  turnId?: string
  request: AgentSessionHistoryQuestionRequest
  questions: Array<{ reference: ConversationQuestionReference; question: AgentSessionHistoryQuestion; answer?: ConversationQuestionAnswerFact }>
  recordedAnswers: ReadonlyMap<string, string>
  original: AgentSessionHistoryItem
}

/** Native opaque IDs remain qualified by the exact managed Session and original source. */
export function questionReplyKey(sessionId: string, target: ConversationQuestionTarget): string {
  return JSON.stringify([sessionId, target.source.providerId, target.source.nativeSessionId, target.turnId, target.recordId])
}
/** Submission receipts and recorded native answers are separate facts. */
export function questionReplyReceiptMatches(sessionId: string, input: ReplyIdentity, receipt: AgentSessionQuestionReplyReceipt): boolean {
  return receipt?.outcome === 'submitted' && receipt.agentSessionId === sessionId && receipt.operationId === input.operationId
    && receipt.recordId === input.recordId && receipt.source?.providerId === input.source.providerId && receipt.source.nativeSessionId === input.source.nativeSessionId
    && Array.isArray(receipt.questionIds) && receipt.questionIds.length === input.answers.length
    && input.answers.every(answer => receipt.questionIds.includes(answer.questionId))
}

/** Index only already accepted same-source records; the displayed page retains its original precedence. */
export function recordedQuestionAnswerFacts(page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null): Map<string, ConversationQuestionAnswerFact> {
  const answers = new Map<string, ConversationQuestionAnswerFact>()
  const collect = (value: AgentSessionHistoryPage) => {
    for (const item of value.items) if (item.kind === 'user-message') for (const answer of item.questionAnswers ?? []) {
      answers.set(answer.questionId, { agentSessionId: page.agentSessionId, source: page.source, recordId: item.id,
        ...(item.turnId === undefined ? {} : { turnId: item.turnId }), ...answer, original: item })
    }
  }
  if (context?.agentSessionId === page.agentSessionId && context.source.providerId === page.source.providerId && context.source.nativeSessionId === page.source.nativeSessionId) collect(context)
  collect(page)
  return answers
}

export function recordedQuestionAnswers(page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null): Map<string, string> {
  return new Map([...recordedQuestionAnswerFacts(page, context)].map(([id, fact]) => [id, fact.answer]))
}

/** One accepted answer index per observation; this confirms native answers, never an operation's delivery. */
export function createQuestionReplyMatcher(sessionId: string, page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null): (attempt: { input: Pick<ConversationQuestionInput, 'source' | 'answers'> }) => boolean {
  let answers: ReadonlyMap<string, ConversationQuestionAnswerFact> | undefined
  return attempt => {
    if (page.agentSessionId !== sessionId || page.source.providerId !== attempt.input.source.providerId || page.source.nativeSessionId !== attempt.input.source.nativeSessionId) return false
    answers ??= recordedQuestionAnswerFacts(page, context)
    return attempt.input.answers.every(answer => answers!.has(answer.questionId))
  }
}

/** Project exact question references and original answer evidence without acquiring another reader or cache. */
export function projectConversationQuestions({ agentSessionId, executionHostId, historyPage, answerContext }: {
  agentSessionId: string
  executionHostId?: string | undefined
  historyPage: AgentSessionHistoryPage
  answerContext?: AgentSessionHistoryPage | null | undefined
}): ConversationQuestionRecord[] {
  if (historyPage.agentSessionId !== agentSessionId) return []
  const facts = recordedQuestionAnswerFacts(historyPage, answerContext)
  return historyPage.items.flatMap(item => {
    if (!item.questionRequest) return []
    const identity = { agentSessionId, source: historyPage.source, recordId: item.id,
      ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }
    const questions = item.questionRequest.questions.map(question => {
      const answer = facts.get(question.id)
      return { reference: { ...identity, ...(executionHostId === undefined ? {} : { executionHostId }), questionId: question.id },
        question, ...(answer === undefined ? {} : { answer }) }
    })
    return [{ ...identity, request: item.questionRequest, questions,
      recordedAnswers: new Map(questions.flatMap(value => value.answer ? [[value.question.id, value.answer.answer] as const] : [])), original: item }]
  })
}
