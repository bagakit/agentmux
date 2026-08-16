import { AgentMuxError, decideContinuousProgress, type ContinuousProgressLoop } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller.js'

/** Revalidate the durable claim immediately before crossing the typed input boundary. */
export async function deliverContinuousProgress(
  runtime: Pick<RuntimeController, 'observeContinuousProgress' | 'submitPrompt'>,
  loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal
): Promise<'sent' | 'skipped'> {
  const observation = await runtime.observeContinuousProgress(loop, operationId, Date.now())
  const decision = decideContinuousProgress(observation)
  if (!isCurrent() || !loop.pendingCompletion) return 'skipped'
  if (loop.lastOutcome !== 'unknown' && (decision.kind !== 'send' || decision.completionId !== loop.pendingCompletion.id)) return 'skipped'
  try {
    await runtime.submitPrompt({ kind: 'agent', agentSessionId: observation.session.agentSessionId,
      hostId: observation.session.hostId, run: observation.session.run }, loop.prompt, operationId,
    { completionId: loop.pendingCompletion.id, isCurrent, signal })
    return 'sent'
  } catch (error) {
    if (error instanceof AgentMuxError && (error.code === 'AGENT_COMPLETION_CHANGED' || error.code === 'AGENT_PROMPT_CANCELLED')) return 'skipped'
    throw error
  }
}
