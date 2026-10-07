import { AgentMuxError } from '../errors.js'
import type {
  AgentSessionHistoryQuestionRequest,
  AgentSessionHistoryQuestionAnswer
} from '../types.js'

const OPEN = '<send_user_message_question_reply>'
const CLOSE = '</send_user_message_question_reply>'

function invalid(): never {
  throw new AgentMuxError('Native asynchronous question data is invalid.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
}

/** Codex 0.160.1 async questions use call identity plus their original array index. */
export function codexQuestionRequest(item: Record<string, unknown>): AgentSessionHistoryQuestionRequest | undefined {
  if (item.delivery !== 'async' || item.questions === undefined || item.questions === null) return undefined
  if (typeof item.id !== 'string' || !item.id || !Array.isArray(item.questions) || !item.questions.length) return invalid()
  return { delivery: 'async', questions: item.questions.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const question = value as Record<string, unknown>
    if (typeof question.title !== 'string' || !question.title.trim() ||
      question.options !== undefined && question.options !== null &&
      (!Array.isArray(question.options) || !question.options.length || question.options.some(option => typeof option !== 'string' || !option.trim()))) return invalid()
    const id = JSON.stringify(['request_user_input_async', item.id, index])
    return { id, prompt: question.title,
      options: ((question.options ?? []) as string[]).map((label, optionIndex) => ({ id: String(optionIndex), label })),
      acceptsText: true }
  }) }
}

/** Interpret only a complete native reply, never a quoted/partial tag or message authorship. */
export function codexQuestionAnswers(content: unknown): AgentSessionHistoryQuestionAnswer[] | undefined {
  if (!Array.isArray(content)) return undefined
  const relevant = content.filter(part => part?.type !== 'skill' && part?.type !== 'mention')
  if (relevant.length !== 1 || relevant[0]?.type !== 'text' || typeof relevant[0]?.text !== 'string') return undefined
  let text = relevant[0].text.trim()
  if (text.startsWith('# Context from my IDE setup:\n')) {
    const marker = '\n## My request for Codex:\n'
    const index = text.lastIndexOf(marker)
    if (index < 0) return undefined
    text = text.slice(index + marker.length).trim()
  }
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(OPEN.length, -CLOSE.length)) } catch { return undefined }
  const replies = Array.isArray(parsed) ? parsed : [parsed]
  if (!replies.length || replies.some(reply => !reply || typeof reply !== 'object' || Array.isArray(reply) ||
    typeof reply.questionItemId !== 'string' || !reply.questionItemId || typeof reply.question !== 'string' || typeof reply.answer !== 'string')) return undefined
  return replies.map(reply => ({ questionId: reply.questionItemId, answer: reply.answer, prompt: reply.question }))
}
