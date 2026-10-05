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

/** Original whole-input refusal, interpreted by Core rather than by a client error callback. */
export type AgentPromptNotApplied = { submissionId: string; run: AgentMuxRunRef }

export function agentPromptNotApplied(
  session: Pick<AgentMuxAgentSession, 'run' | 'promptCompletionAdmission' | 'terminalPromptSubmission'>
): AgentPromptNotApplied | undefined {
  const admission = session.promptCompletionAdmission
  if (!admission?.submissionId || !admission.notApplied || admission.acknowledged ||
      admission.intent?.run.runId !== session.run.runId || admission.frameRefresh?.notApplied) return undefined
  const submission = session.terminalPromptSubmission
  if (admission.intent.plan.kind === 'single-phase') {
    if (submission) return undefined
  } else {
    if (!submission || submission.submissionId !== admission.submissionId || submission.run.runId !== session.run.runId) return undefined
    const first = submission.prepare?.interrupt ?? submission.payload
    // A refusal of the final submit cannot undo an accepted payload. Nor does an
    // independent redraw refusal prove what happened to the original prompt bytes.
    if (admission.operationId !== first.operationId || admission.startByte !== first.inputByteRange.startByte ||
        admission.endByte !== submission.submit.inputByteRange.endByte || submission.prepare?.interrupt?.acknowledged ||
        submission.payload.acknowledged || submission.submit.acknowledged) return undefined
  }
  return { submissionId: admission.submissionId, run: { ...session.run } }
}
