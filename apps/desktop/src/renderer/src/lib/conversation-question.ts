import { validateAgentPromptCondition, type AgentPromptNotApplied } from '@agentmux/core/prompt-condition'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { ConversationQuestionReply } from '@agentmux/client-ui/components/ConversationView'
import { parseQuestionReplyAttempt, questionReplyFailurePhase, questionReplyKey, questionReplyReceiptMatches, createQuestionReplyMatcher,
  questionReplyState, type ConversationQuestionTarget, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { DesktopQuestionReplyAttempt, DesktopQuestionReplies } from './conversation-question-intent'
import { api } from './api'
import { retainConversationQuestionReply, retainConversationQuestionDraft, useAppStore } from '../store'

export function desktopQuestionReplyState(replies: DesktopQuestionReplies[string] | undefined,
  sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const value = replies?.[questionReplyKey(sessionId, target)]
  if (!value) return undefined
  try { return questionReplyState(parseQuestionReplyAttempt(value)) }
  catch (error) { return { phase: 'unknown', answers: [], diagnostic: { code: 'QUESTION_REPLY_RECORD_UNAVAILABLE', message: presentError(error) } } }
}
/** An explicit retry rejoins the host's original intent, including its original predecessor. */
export async function replyConversationQuestion(control: AgentSessionControl,
  input: Parameters<ConversationQuestionReply>[0]): ReturnType<ConversationQuestionReply> {
  const key = questionReplyKey(control.agentSessionId, input)
  const previous = useAppStore.getState().questionReplies?.[control.agentSessionId]?.[key]
  if (previous) {
    parseQuestionReplyAttempt(previous)
    if (previous.phase === 'sending' || previous.phase === 'submitted') throw new Error('The original reply is still awaiting its recorded answer. Its Session remains available.')
    if (previous.phase === 'unknown' && JSON.stringify(input.answers) !== JSON.stringify(previous.input.answers)) throw new Error('The original reply is unconfirmed. A changed answer cannot replace it; retry the original reply or inspect its Session.')
  }
  const current = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)
  if (current?.kind !== 'agent' || current.control.hostId !== control.hostId || current.control.run.runId !== control.run.runId) throw new Error('This question’s original Session or Run changed. Its conversation and terminal remain available.')
  const original = previous?.phase === 'unknown' ? previous : {
    hostId: control.hostId, input: { ...structuredClone(input), operationId: crypto.randomUUID(),
      ...validateAgentPromptCondition({ expectedRun: { ...control.run }, afterSubmissionId: current.promptSubmissionPredecessor }) }, phase: 'sending' as const
  }
  if (original.hostId !== control.hostId || original.input.expectedRun.runId !== current.control.run.runId) throw new Error('The original reply belongs to another Host or Run. Its answer and Session remain available.')
  const attempt: DesktopQuestionReplyAttempt = { ...original, phase: 'sending', diagnostic: undefined }
  let dispatched = false
  try {
    await retainConversationQuestionReply(control.agentSessionId, key, attempt, previous)
    if (useAppStore.getState().questionReplies[control.agentSessionId]?.[key] !== attempt) throw new Error('The original reply record changed before input. This click did not submit it.')
    const latest = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)
    if (latest?.kind !== 'agent' || latest.control.hostId !== original.hostId || latest.control.run.runId !== original.input.expectedRun.runId) throw new Error('The original reply Run changed before input; the answer is preserved.')
    dispatched = true
    const receipt = await api.sessions.replyQuestion(control, original.input)
    if (!questionReplyReceiptMatches(control.agentSessionId, original.input, receipt)) throw new Error('The original question reply receipt did not match. Its answer is preserved for inspection.')
    await retainConversationQuestionReply(control.agentSessionId, key, { ...attempt, phase: 'submitted' }, attempt)
    return receipt
  } catch (error) {
    const next: DesktopQuestionReplyAttempt = { ...attempt, phase: questionReplyFailurePhase(previous?.phase, dispatched), diagnostic: {
      code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'QUESTION_REPLY_UNCONFIRMED', message: presentError(error)
    } }
    // A late callback cannot replace a native confirmation or another owner update.
    if (useAppStore.getState().questionReplies?.[control.agentSessionId]?.[key] === attempt) await retainConversationQuestionReply(control.agentSessionId, key, next, attempt)
    throw error
  }
}
export function observeConversationQuestionAnswers(control: AgentSessionControl, page: AgentSessionHistoryPage, context?: AgentSessionHistoryPage | null, notApplied?: AgentPromptNotApplied): void {
  const recorded = createQuestionReplyMatcher(control.agentSessionId, page, context)
  for (const [key, attempt] of Object.entries(useAppStore.getState().questionReplies?.[control.agentSessionId] ?? {})) {
    if (attempt?.phase === 'confirmed') continue
    try {
      parseQuestionReplyAttempt(attempt)
      if (key !== questionReplyKey(control.agentSessionId, attempt.input)) continue
      if (attempt.hostId === control.hostId && recorded(attempt)) {
        void retainConversationQuestionReply(control.agentSessionId, key, { ...attempt, phase: 'confirmed', diagnostic: undefined }, attempt).catch(() => {})
      } else if (attempt.phase === 'unknown' && attempt.hostId === control.hostId &&
        notApplied?.submissionId === attempt.input.operationId && notApplied.run.runId === attempt.input.expectedRun.runId &&
        control.run.runId === attempt.input.expectedRun.runId) {
        void retainConversationQuestionReply(control.agentSessionId, key, { ...attempt, phase: 'rejected', diagnostic: {
          code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core confirmed the original reply was not applied. Your edited answer is kept; you can submit it explicitly.'
        } }, attempt).catch(() => {})
      }
    } catch { /* Unreadable original intent remains held; observing another source cannot replace it. */ }
  }
}

export function editConversationQuestionDraft(control: AgentSessionControl, target: ConversationQuestionTarget, answers: Parameters<ConversationQuestionReply>[0]['answers']): void {
  retainConversationQuestionDraft(control.agentSessionId, questionReplyKey(control.agentSessionId, target), answers)
}
