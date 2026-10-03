import { validateAgentPromptCondition } from '@agentmux/core/prompt-condition'
import type { ConversationQuestionReply } from '@agentmux/client-ui/components/ConversationNativeThread'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import { useAppStore } from '../store'

/** An explicit click uses the rendered Run and Core's existing predecessor; no read or new queue. */
export function replyConversationQuestion(control: AgentSessionControl,
  input: Parameters<ConversationQuestionReply>[0]): ReturnType<ConversationQuestionReply> {
  const current = useAppStore.getState().sessions.find(session => session.id === control.agentSessionId)
  if (current?.kind !== 'agent' || current.control.hostId !== control.hostId || current.control.run.runId !== control.run.runId) {
    return Promise.reject(new Error('This question’s original Session or Run changed. Its conversation and terminal remain available.'))
  }
  const condition = validateAgentPromptCondition({ expectedRun: { ...control.run }, afterSubmissionId: current.promptSubmissionPredecessor })
  return api.sessions.replyQuestion(control, { ...input, ...condition })
}
