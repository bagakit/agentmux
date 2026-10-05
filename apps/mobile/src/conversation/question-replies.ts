import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { parseQuestionReplyAttempt, questionReplyFailurePhase, questionReplyKey, questionReplyReceiptMatches, questionReplyRecorded,
  questionReplyState, type ConversationQuestionInput, type ConversationQuestionTarget, type QuestionReplyAttempt, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import { errorMessage } from './delivery'
import type { createLocalDrafts } from './local-drafts'

export type MobileQuestionReplyAttempt = QuestionReplyAttempt & { runtimeId: string | null; hostId: string }
type Local = ReturnType<typeof createLocalDrafts>
export function mobileQuestionReplyState(local: Local, sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const attempt = local.questions.get(questionReplyKey(sessionId, target))
  return attempt ? questionReplyState(attempt) : undefined
}
/** The device intent owner outlives this page's mounted card. No reconnect or render dispatches it. */
export async function replyMobileQuestion(client: AgentMuxHostedClient, sessionId: string, renderedRunId: string,
  input: ConversationQuestionInput, local: Local, changed: () => void) {
  const key = questionReplyKey(sessionId, input), previous = local.questions.get(key)
  if (previous) {
    parseQuestionReplyAttempt(previous)
    if (previous.phase === 'sending' || previous.phase === 'submitted') throw new Error('原答复正在等待原生回答记录；原会话仍可使用。')
    if (previous.phase === 'unknown' && JSON.stringify(previous.input.answers) !== JSON.stringify(input.answers)) throw new Error('原答复回执未知，另一份正文不能替换它；请核对或重试原答复。')
  }
  const session = client.agentSession(sessionId)
  if (session.run.runId !== renderedRunId) throw new Error('原问题的 Run 已改变；对话与终端仍保留。')
  const original: MobileQuestionReplyAttempt = previous?.phase === 'unknown' ? previous : { phase: 'sending',
    runtimeId: client.runtimeOwnerIdentity?.()?.runtimeId ?? null, hostId: session.hostId,
    input: { ...structuredClone(input), operationId: randomClientRequestId(), ...agentPromptCondition(session) } }
  const targetCurrent = () => {
    const current = client.agentSession(sessionId)
    return current.agentSessionId === sessionId && current.hostId === original.hostId && current.run.runId === original.input.expectedRun.runId
      && (original.runtimeId === null || client.runtimeOwnerIdentity?.()?.runtimeId === original.runtimeId)
  }
  if (!targetCurrent()) throw new Error('原答复属于另一 Runtime、Host 或 Run；原正文与回执保留。')
  const attempt: MobileQuestionReplyAttempt = { ...original, phase: 'sending', diagnostic: undefined }
  local.questions.set(key, attempt); changed()
  let dispatched = false
  try {
    if (!await local.save() || local.questions.get(key) !== attempt) throw new Error('原设备答复记录已变化；本次未请求输入，原正文保留。')
    if (!targetCurrent()) throw new Error('保存期间原答复 Run 已改变；本次未请求输入。')
    dispatched = true
    const receipt = await client.forwardRpc!('agent.question.reply', { ...original.input, agentSessionId: sessionId, sourceChannel: 'api' })
    if (!questionReplyReceiptMatches(sessionId, original.input, receipt)) throw new Error('原答复回执身份未匹配；正文与原操作保留，请核对。')
    if (local.questions.get(key) === attempt) { local.questions.set(key, { ...attempt, phase: 'submitted' }); await local.save() }
    return receipt
  } catch (error) {
    if (local.questions.get(key) === attempt) {
      local.questions.set(key, { ...attempt, phase: questionReplyFailurePhase(previous?.phase, dispatched, error), diagnostic: {
        code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'QUESTION_REPLY_UNCONFIRMED', message: errorMessage(error)
      } }); await local.save()
    }
    throw error
  } finally { changed() }
}
export async function observeMobileQuestionAnswers(local: Local, sessionId: string, page: AgentSessionHistoryPage): Promise<boolean> {
  let changed = false
  for (const [key, attempt] of local.questions) if (attempt.phase !== 'confirmed' && questionReplyRecorded(sessionId, attempt, page)) {
    local.questions.set(key, { ...attempt, phase: 'confirmed', diagnostic: undefined }); changed = true
  }
  if (changed) await local.save()
  return changed
}
