import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSession, AgentMuxRunRef } from './types.js'

/** Capture once before the first possibly executing RPC; retain with the sending intent. */
export type AgentPromptCondition = {
  expectedRun: AgentMuxRunRef
  afterSubmissionId: string | null
}

export function validateAgentPromptCondition(value: unknown): AgentPromptCondition {
  const condition = value as Partial<AgentPromptCondition> | null | undefined
  if (!condition || typeof condition.expectedRun?.runId !== 'string' || !condition.expectedRun.runId.trim() ||
    !Object.hasOwn(condition, 'afterSubmissionId') || condition.afterSubmissionId !== null &&
    (typeof condition.afterSubmissionId !== 'string' || !condition.afterSubmissionId.trim())) throw new AgentMuxError(
      'The original prompt delivery condition is missing. Your message is kept; use the terminal while its delivery is reviewed.',
      'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  return { expectedRun: { ...condition.expectedRun }, afterSubmissionId: condition.afterSubmissionId }
}

export function agentPromptCondition(
  session: Pick<AgentMuxAgentSession, 'run' | 'promptCompletionAdmission'>
): AgentPromptCondition {
  const afterSubmissionId = agentPromptPredecessor(session)
  if (afterSubmissionId === undefined) throw new AgentMuxError(
    'The previous prompt admission has no logical identity. Your message is kept; use the terminal while its delivery is reviewed.',
    'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  return { expectedRun: { ...session.run }, afterSubmissionId }
}

/** A missing logical identity is unknown; only absent admission proves an empty predecessor. */
export function agentPromptPredecessor(session: Pick<AgentMuxAgentSession, 'promptCompletionAdmission'>): string | null | undefined {
  return session.promptCompletionAdmission === undefined ? null : session.promptCompletionAdmission.submissionId
}
