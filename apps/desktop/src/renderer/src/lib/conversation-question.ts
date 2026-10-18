import { mintObjectId } from '@agentmux/core/object-id'
import { type AgentPromptNotApplied } from '@agentmux/core/prompt-condition'
import { parseQuestionReplyAttempt, questionReplyKey,
  questionReplyState, submitQuestionReply, type ConversationQuestionInput, type ConversationQuestionTarget, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { DesktopQuestionReplies } from './conversation-question-intent'
import { retainConversationQuestionReply, retainConversationQuestionDraft, useAppStore } from '../store'

export function desktopQuestionReplyState(replies: DesktopQuestionReplies[string] | undefined,
  sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const value = replies?.[questionReplyKey(sessionId, target)]
  if (!value) return undefined
  try { return questionReplyState(parseQuestionReplyAttempt(value)) }
  catch (error) { return { phase: 'unknown', answers: [], diagnostic: { code: 'QUESTION_REPLY_RECORD_UNAVAILABLE', message: presentError(error) } } }
}
export function reconcileConversationQuestionReplies(control: AgentSessionControl, notApplied?: AgentPromptNotApplied): void {
  if (!notApplied) return
  for (const [key, attempt] of Object.entries(useAppStore.getState().questionReplies?.[control.agentSessionId] ?? {})) {
    if (attempt?.phase === 'confirmed') continue
    try {
      parseQuestionReplyAttempt(attempt)
      if (key !== questionReplyKey(control.agentSessionId, attempt.input)) continue
      if (attempt.phase === 'unknown' && attempt.hostId === control.hostId &&
        notApplied?.submissionId === attempt.input.operationId && notApplied.run.runId === attempt.input.expectedRun.runId &&
        control.run.runId === attempt.input.expectedRun.runId) {
        void retainConversationQuestionReply(control.agentSessionId, key, { ...attempt, phase: 'rejected', diagnostic: {
          code: 'QUESTION_REPLY_NOT_APPLIED', message: 'Core confirmed the original reply was not applied. Your edited answer is kept and can be sent as a new explicit reply.'
        } }, attempt).catch(() => {})
      }
    } catch { /* Unreadable original intent remains held; observing another source cannot replace it. */ }
  }
}

export function editConversationQuestionDraft(control: AgentSessionControl, target: ConversationQuestionTarget, answers: ConversationQuestionInput['answers']): void {
  retainConversationQuestionDraft(control.agentSessionId, questionReplyKey(control.agentSessionId, target), answers)
}

/** The workbench owns persistence; shared reply transitions own the original frozen operation. */
export async function sendConversationQuestionReply(control: AgentSessionControl, input: ConversationQuestionInput): Promise<void> {
  const key = questionReplyKey(control.agentSessionId, input)
  const get = () => useAppStore.getState().questionReplies?.[control.agentSessionId]?.[key]
  const assertOwner = () => {
    const current = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)
    if (current?.kind !== 'agent' || current.control.hostId !== control.hostId || current.control.run.runId !== control.run.runId ||
        current.nativeSourceObservation || current.nativeHandle?.kind !== 'provider' ||
        current.nativeHandle.providerId !== input.source.providerId || current.nativeHandle.sessionId !== input.source.nativeSessionId) {
      throw new Error('The original question source or Run changed. Your draft and original operation are preserved.')
    }
    return current
  }
  const session = assertOwner(), previous = get()
  if (previous && (previous.hostId !== control.hostId || previous.input.expectedRun.runId !== control.run.runId)) {
    throw new Error('The preserved reply belongs to another Host or Run. It has not been replaced.')
  }
  await submitQuestionReply({ sessionId: control.agentSessionId, get,
    create: () => ({ hostId: control.hostId, phase: 'sending', input: { ...structuredClone(input),
      expectedRun: { ...control.run }, afterSubmissionId: session.promptSubmissionPredecessor ?? null, operationId: mintObjectId() } }),
    retain: (next, expected) => retainConversationQuestionReply(control.agentSessionId, key, next, expected),
    submit: original => { assertOwner(); return api.sessions.replyQuestion(control, original) }
  })
}
