import { mintObjectId } from '@agentmux/core/object-id'
import { parseQuestionReplyAttempt, questionReplyKey,
  questionReplyState, submitQuestionReply, type ConversationQuestionInput, type ConversationQuestionTarget, type QuestionReplyState } from '@agentmux/client-ui/conversation-question-reply'
import { api } from './api'
import { nativeSourceUnconfirmed } from '../../../shared/agent-native-source'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { DesktopQuestionReplies } from './conversation-question-intent'
import { retainConversationQuestionReply, retainConversationQuestionDraft, useAppStore } from '../store'
export { reconcileConversationQuestionReplies } from '../store'

export function desktopQuestionReplyState(replies: DesktopQuestionReplies[string] | undefined,
  sessionId: string, target: ConversationQuestionTarget): QuestionReplyState | undefined {
  const value = replies?.[questionReplyKey(sessionId, target)]
  if (!value) return undefined
  try { return questionReplyState(parseQuestionReplyAttempt(value)) }
  catch (error) { return { phase: 'unknown', answers: [], diagnostic: { code: 'QUESTION_REPLY_RECORD_UNAVAILABLE', message: presentError(error) } } }
}
export function editConversationQuestionDraft(control: AgentSessionControl, target: ConversationQuestionTarget, answers: ConversationQuestionInput['answers']): void {
  retainConversationQuestionDraft(control.agentSessionId, questionReplyKey(control.agentSessionId, target), answers)
}

/** The workbench owns persistence; shared reply transitions own the original frozen operation. */
export async function sendConversationQuestionReply(control: AgentSessionControl, input: ConversationQuestionInput, moteSource?: import('@agentmux/core').AgentInputMoteSource): Promise<void> {
  const key = questionReplyKey(control.agentSessionId, input)
  const get = () => useAppStore.getState().questionReplies?.[control.agentSessionId]?.[key]
  const assertOwner = () => {
    const current = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)
    if (current?.kind !== 'agent' || current.control.hostId !== control.hostId || current.control.run.runId !== control.run.runId ||
        nativeSourceUnconfirmed(current) || current.nativeHandle?.kind !== 'provider' ||
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
    create: () => ({ hostId: control.hostId, phase: 'sending', input: { ...structuredClone(input), ...(moteSource ? { moteSource: structuredClone(moteSource) } : {}),
      expectedRun: { ...control.run }, afterSubmissionId: session.promptSubmissionPredecessor ?? null,
      ...(session.inputEpoch === undefined ? {} : { inputEpoch: session.inputEpoch }), operationId: mintObjectId() } }),
    retain: (next, expected) => retainConversationQuestionReply(control.agentSessionId, key, next, expected),
    submit: original => { assertOwner(); return api.sessions.replyQuestion(control, original) }
  })
}
