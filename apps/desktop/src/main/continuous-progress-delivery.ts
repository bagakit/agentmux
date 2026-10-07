import { AgentMuxError, decideContinuousProgress, decideFutureProgress, validateAgentPromptCondition, type ContinuousProgressLoop } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller.js'

/** Revalidate the durable claim immediately before crossing the typed input boundary. */
export async function deliverContinuousProgress(
  runtime: Pick<RuntimeController, 'observeContinuousProgress' | 'submitPrompt'>,
  loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal
): Promise<'sent' | 'skipped'> {
  const observation = await runtime.observeContinuousProgress(loop, operationId, Date.now(), signal)
  const decision = loop.pendingCompletion?.futureIntent ? decideFutureProgress(observation, loop.pendingCompletion.futureIntent) : decideContinuousProgress(observation)
  if (!isCurrent() || !loop.pendingCompletion) return 'skipped'
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
    if (!pending.futureIntent && error instanceof AgentMuxError && (error.code === 'AGENT_COMPLETION_CHANGED' || error.code === 'AGENT_PROMPT_CANCELLED')) return 'skipped'
    throw error
  }
}
