import type { QuestionDiagnostic } from '@agentmux/client-ui/components/AgentAsyncQuestionCard'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Record-local failure uses the existing service window. It never gates the Session or original Input. */
export function renderConversationQuestionNotice(diagnostic: QuestionDiagnostic) {
  return <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: diagnostic.message,
    mode: `Question details or its reply could not be confirmed (${diagnostic.code}). The original conversation and Session remain available.`,
    restore: 'Inspect the original conversation or answer in terminal. Retry the same reply only when you choose to.'
  } }} />
}
