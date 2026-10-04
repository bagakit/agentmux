import { AgentMuxError } from '../errors.js'
import type {
  AgentSessionHistoryQuestionRequest,
  AgentSessionHistoryQuestionAnswer,
  AgentTerminalScreenSnapshot
} from '../types.js'

const OPEN = '<send_user_message_question_reply>'
const CLOSE = '</send_user_message_question_reply>'
const MAX_REFERENCE_BYTES = 512

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

function nativeTitle(prompt: string): string {
  // Native framing truncates on a UTF-8 boundary. Keep the original display/raw text elsewhere.
  let title = '', bytes = 0
  for (const point of prompt) {
    const length = Buffer.byteLength(point)
    if (bytes + length > 512) break
    title += point; bytes += length
  }
  return title.replace(/[\r\n]/gu, ' ')
}

/** This is ordinary user input, not a permission response or AgentMux A2A envelope. */
export function encodeCodexQuestionReply(request: AgentSessionHistoryQuestionRequest, answers: AgentSessionHistoryQuestionAnswer[]): string {
  if (!answers.length) throw new AgentMuxError('A question reply requires at least one exact answer.', 'INVALID_AGENT_QUESTION_REPLY')
  const ids = new Set<string>()
  const replies = answers.map(({ questionId, answer }) => {
    const question = request.questions.find(question => question.id === questionId)
    if (!question || ids.has(questionId) || typeof answer !== 'string' || !answer.trim()) {
      throw new AgentMuxError('The answer does not identify one original native question.', 'INVALID_AGENT_QUESTION_REPLY')
    }
    if (Buffer.byteLength(questionId) > MAX_REFERENCE_BYTES) throw new AgentMuxError(
      'This native question identity cannot be represented by its reply protocol; ordinary terminal input remains available.',
      'AGENT_QUESTION_REPLY_UNSUPPORTED')
    ids.add(questionId)
    return { answer, question: nativeTitle(question.prompt), questionItemId: questionId }
  })
  return OPEN + '\n' + JSON.stringify(replies) + '\n' + CLOSE
}

/** Leave only the current native async editor, preserving drafts in earlier questions. */
export function codexQuestionComposerNavigation(screen: AgentTerminalScreenSnapshot | undefined): string {
  if (!screen) return ''
  const footer = screen.lines.slice(-4).map(line => line.text).join(' ')
  if (!/\benter submit\b/u.test(footer) || !/ctrl\+\] skip\b/u.test(footer)) return ''
  const destination = /shift\+→\s+(main prompt|prev question)(?:\s|$)/u.exec(footer)?.[1]
  if (destination === 'main prompt') return '\u001b[1;2C'
  const progress = screen.lines.slice(0, -4).map(line => /^\s*(\d+) of (\d+)\s*$/u.exec(line.text)).filter(match => match !== null).at(-1)
  const current = Number(progress?.[1]), total = Number(progress?.[2])
  if (destination !== 'prev question' || !Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current <= 1 || current > total) {
    throw new AgentMuxError('The current native question editor cannot be navigated safely; ordinary terminal input remains available.', 'AGENT_QUESTION_REPLY_UNSUPPORTED')
  }
  return '\u001b[1;2C'.repeat(current)
}
