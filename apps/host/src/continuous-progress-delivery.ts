import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, decideContinuousProgress, decideFutureProgress, validateAgentPromptCondition, type AgentMuxRpcCallContext, type ContinuousProgressLoop } from '@agentmux/core'
import type { GoalRuntimePort } from './goal-runtime.js'
import { AutomaticInputNotDispatchedError } from './automatic-input-not-dispatched.js'
import { awaitUntilCancelled } from './await-until-cancelled.js'

/** Revalidate the durable claim immediately before crossing the typed input boundary. */
export async function deliverContinuousProgress(
  runtime: Pick<GoalRuntimePort, 'observeContinuousProgress' | 'submitPrompt'> & Partial<Pick<GoalRuntimePort, 'inspectGoalAttention'>>,
  loop: ContinuousProgressLoop, operationId: string, isCurrent: () => boolean, signal: AbortSignal, onDispatch?: () => void, authority?: AgentMuxRpcCallContext
): Promise<'sent' | 'skipped' | 'not-applied' | 'unknown'> {
  if (loop.taskSource?.kind === 'goal' && loop.lastOutcome === 'unknown') {
    const pending = loop.pendingCompletion
    const inspect = runtime.inspectGoalAttention
    if (!isCurrent() || pending?.operationId !== operationId || !pending.condition || !pending.prompt || !pending.agentMuxNote || !inspect) return 'unknown'
    // A missing exact receipt leaves this original operation unresolved.
    const condition = validateAgentPromptCondition(pending.condition)
    const record = await awaitUntilCancelled(() => inspect({ hostId: loop.hostId, supervisorAgentSessionId: loop.agentSessionId,
      supervisorRunId: condition.expectedRun.runId, operationId }), signal)
    const admission = record?.admission, key = admission?.inputKey, intent = admission?.intent
    if (!isCurrent() || record?.agentSessionId !== loop.agentSessionId || record.run.runId !== condition.expectedRun.runId ||
        key?.kind !== 'prompt' || key.submissionId !== operationId || key.attemptId !== undefined || key.agentSessionId !== loop.agentSessionId || key.expectedRun.runId !== condition.expectedRun.runId ||
        admission?.submissionId !== operationId || admission.completionId !== pending.id || intent?.message?.userContent !== pending.prompt ||
        intent.message.systemContext !== pending.agentMuxNote || intent.message.sourceChannel !== 'message-tool' ||
        intent.message.authorHuman || intent.message.authorAgentSessionId || intent.message.authorExternal ||
        intent.admissionIntent?.kind !== 'exact-condition' || !isDeepStrictEqual(intent.admissionIntent.condition, condition)) return 'unknown'
    return admission.acknowledged || record.terminalPromptSubmission?.submissionId === operationId && record.terminalPromptSubmission.submit.acknowledged ? 'sent' : 'unknown'
  }
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
  try { await authority?.assertCurrent?.() }
  catch (error) { throw new AutomaticInputNotDispatchedError(error) }
  try {
    await runtime.submitPrompt({ kind: 'agent', agentSessionId: observation.session.agentSessionId,
      hostId: loop.hostId, run: condition.expectedRun }, pending.prompt, operationId, condition,
    { ...(pending.futureIntent ? { futureIntent: pending.futureIntent } : { completionId: pending.id }),
      ...(pending.inputByte !== undefined ? { inputByte: pending.inputByte } : {}), isCurrent, signal,
      ...(onDispatch ? { onDispatch } : {}) },
    undefined, undefined, pending.agentMuxNote, undefined, undefined, authority)
    return 'sent'
  } catch (error) {
    // Core has reserved this exact occurrence and retained the refusal.
    if (pending.futureIntent && error instanceof AgentMuxError && error.code === 'AGENT_PROMPT_INPUT_NOT_APPLIED') return 'not-applied'
    // A pre-admission refusal leaves the original due occurrence available.
    if (loop.lastOutcome !== 'unknown' && error instanceof AgentMuxError && (error.code === 'AGENT_PROMPT_CANCELLED' || error.code === 'AGENT_COMPLETION_CHANGED' || error.controlFailure?.disposition === 'not_applied')) throw new AutomaticInputNotDispatchedError(error)
    throw error
  }
}
