import type { AgentOpenExecutionSelector } from '@agentmux/core/agent-open-contract'
import type { SpaceMountSourceTarget } from '../../../shared/space-mount'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** First user birth only. Existing requests keep their exact cut and never call this reader. */
export async function newSourceAgentInput(target: SpaceMountSourceTarget, agentTarget: AgentOpenExecutionSelector['agentTarget']): Promise<{
  fields: { inputRuntimeId: string; inputEpoch?: string }; issue?: string
}> {
  const source = 'expectedRuntimeId' in target ? { hostId: target.hostId, expectedRuntimeId: target.expectedRuntimeId }
    : { hostId: target.hostId, reference: target.reference }
  const original = structuredClone({ target: source, agentTarget })
  const expectedRuntimeId = original.agentTarget?.runtimeId ?? ('expectedRuntimeId' in original.target ? original.target.expectedRuntimeId : original.target.reference.runtimeId)
  if (typeof expectedRuntimeId !== 'string' || !expectedRuntimeId || /[\0\r\n]/u.test(expectedRuntimeId)) {
    throw new Error('The original Agent Runtime is unconfirmed. Your draft is retained; select its exact original device before creating an Agent.')
  }
  const unconfirmed = (reason: string) => ({ fields: { inputRuntimeId: expectedRuntimeId },
    issue: `The Agent device could not confirm its input state. This original request stays pinned to that device; it will check whether it can start. ${reason}` })
  let description: Awaited<ReturnType<typeof api.spaceMounts.call<'describe'>>>
  try { description = await api.spaceMounts.call('describe', { ...original.target, execution: { agentTarget: original.agentTarget }, executionOnly: true }) }
  catch (cause) { return unconfirmed(presentError(cause)) }
  const execution = description.execution
  if (!execution || execution.inputEpoch !== null && (typeof execution.inputEpoch !== 'string' || !execution.inputEpoch)) return unconfirmed('Keep the same target and original request.')
  if (execution.runtimeId !== expectedRuntimeId) throw new Error('The input namespace reply belongs to another Runtime. The original target and draft are retained; no creation was requested.')
  return { fields: { inputRuntimeId: execution.runtimeId, ...(execution.inputEpoch === null ? {} : { inputEpoch: execution.inputEpoch }) } }
}
