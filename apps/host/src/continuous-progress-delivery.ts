import { awaitUntilCancelled } from './await-until-cancelled.js'
import { AgentMuxError, decideContinuousProgress, decideFutureProgress, validateAgentPromptCondition, type ContinuousProgressLoop } from '@agentmux/core'
import type { GoalRuntimePort } from './goal-runtime.js'
import { AutomaticInputNotDispatchedError } from './automatic-input-not-dispatched.js'

/** Revalidate the durable claim immediately before crossing the typed input boundary. */
export async function deliverContinuousProgress(
  runtime: Pick<GoalRuntimePort, 'observeContinuousProgress' | 'submitPrompt'>,
  loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal
): Promise<'sent' | 'skipped'> {
  // Observation precedes any input: a read cancelled here proves this tick sent nothing.
  let observation: Awaited<ReturnType<typeof runtime.observeContinuousProgress>>
  try { observation = await awaitUntilCancelled(() => runtime.observeContinuousProgress(loop, operationId, Date.now(), signal), signal) }
  catch (error) { throw loop.lastOutcome === 'unknown' ? error : new AutomaticInputNotDispatchedError(error) }
  const decision = loop.pendingCompletion?.futureIntent ? decideFutureProgress(observation, loop.pendingCompletion.futureIntent) : decideContinuousProgress(observation)
  if (!isCurrent() || !loop.pendingCompletion) {
    if (loop.lastOutcome === 'unknown') throw new AgentMuxError('The original input remains unconfirmed after cancellation. Inspect that same operation.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
    return 'skipped'
  }
  if (loop.lastOutcome !== 'unknown' && (decision.kind !== 'send' || !loop.pendingCompletion.futureIntent && decision.completionId !== loop.pendingCompletion.id)) return 'skipped'
  const pending = loop.pendingCompletion
  if (typeof pending.prompt !== 'string' || !pending.prompt.trim() ||
      typeof pending.agentMuxNote !== 'string' || !pending.agentMuxNote.trim()) {
    throw new AgentMuxError('The original automatic message content is unconfirmed. Its operation and Agent are kept; manual input remains available.',
      'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
  }
  const condition = validateAgentPromptCondition(pending.condition)
  try {
    await runtime.submitPrompt({ kind: 'agent', agentSessionId: observation.session.agentSessionId,
      hostId: loop.hostId, run: condition.expectedRun }, pending.prompt, operationId, condition,
    { ...(pending.futureIntent ? { futureIntent: pending.futureIntent } : { completionId: pending.id }),
      ...(pending.inputByte !== undefined ? { inputByte: pending.inputByte } : {}), isCurrent, signal },
    undefined, undefined, pending.agentMuxNote)
    return 'sent'
  } catch (error) {
    // Core raises these before it claims the input, so nothing was sent and the next due tick may retry.
    if (loop.lastOutcome !== 'unknown' && error instanceof AgentMuxError && (error.code === 'AGENT_PROMPT_CANCELLED' || error.code === 'AGENT_COMPLETION_CHANGED' || error.controlFailure?.disposition === 'not_applied')) throw new AutomaticInputNotDispatchedError(error)
    throw error
  }
}
