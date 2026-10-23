import { CapsuleValidationError, parseCapsuleInteraction, parseCapsulePreparedReply, parseCapsuleInputObservation,
  type CapsuleInteraction, type CapsulePreparedReply, type CapsuleInputObservation } from '@agentmux/capsule'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString, rpcText } from './rpc-business-codec.js'

/** Client-side input authority. A public transport identity never certifies a human action. */
export type CapsuleInputRequest =
  | { phase: 'prepare'; request: { interaction: CapsuleInteraction; answer: string; inputOperationId: string; operationId: string } }
  | { phase: 'submit' | 'inspect'; prepared: CapsulePreparedReply }
export type CapsuleInputResult =
  | { phase: 'prepare'; prepared: CapsulePreparedReply }
  | { phase: 'submit' | 'inspect'; observation: CapsuleInputObservation | null }
export interface CapsuleInputPort {
  call(input: CapsuleInputRequest): Promise<CapsuleInputResult>
}
function capsuleValue<T>(read: () => T, result = false): T {
  try { return read() }
  catch (error) {
    if (error instanceof CapsuleValidationError) throw new AgentMuxError(error.message, result ? 'CONTROL_PROTOCOL_ERROR' : 'INVALID_CONTROL_REQUEST')
    throw error
  }
}
export function parseCapsuleInputRequest(value: unknown): CapsuleInputRequest {
  const p = rpcRecord(value, ['phase', 'request', 'prepared'])
  if (p.phase === 'prepare' && p.prepared === undefined) {
    const r = rpcRecord(p.request, ['interaction', 'answer', 'inputOperationId', 'operationId'])
    return { phase: 'prepare', request: { interaction: capsuleValue(() => parseCapsuleInteraction(r.interaction)),
      answer: rpcText(r.answer, 'Original answer'), inputOperationId: rpcString(r.inputOperationId, 'Original input operation'),
      operationId: rpcString(r.operationId, 'Original Capsule reply operation') } }
  }
  if ((p.phase === 'submit' || p.phase === 'inspect') && p.request === undefined)
    return { phase: p.phase, prepared: capsuleValue(() => parseCapsulePreparedReply(p.prepared)) }
  throw new AgentMuxError('A precise Capsule input phase is required.', 'INVALID_CONTROL_REQUEST')
}
export function parseCapsuleInputResult(value: unknown, input: CapsuleInputRequest): CapsuleInputResult {
  const p = rpcRecord(value, ['phase', 'prepared', 'observation'])
  if (p.phase !== input.phase) throw new AgentMuxError('The original Capsule input phase changed.', 'CONTROL_PROTOCOL_ERROR')
  if (input.phase === 'prepare' && p.observation === undefined) {
    const prepared = capsuleValue(() => parseCapsulePreparedReply(p.prepared), true)
    const original = input.request
    if (prepared.operationId !== original.operationId || prepared.inputOperationId !== original.inputOperationId ||
      prepared.capsuleId !== original.interaction.capsuleId || prepared.interactionId !== original.interaction.interactionId ||
      prepared.target.hostId !== original.interaction.target?.hostId || prepared.target.agentSessionId !== original.interaction.target?.agentSessionId)
      throw new AgentMuxError('The original Capsule input target changed.', 'CONTROL_PROTOCOL_ERROR')
    return { phase: 'prepare', prepared }
  }
  if (input.phase !== 'prepare' && p.prepared === undefined) {
    const observation = p.observation === null ? null : capsuleValue(() => parseCapsuleInputObservation(p.observation), true)
    if (observation && (observation.inputOperationId !== input.prepared.inputOperationId || observation.expectedRun.runId !== input.prepared.expectedRun.runId))
      throw new AgentMuxError('The original Capsule input receipt changed.', 'CONTROL_PROTOCOL_ERROR')
    if (input.phase === 'submit' && !observation) throw new AgentMuxError('The original Capsule submit receipt is missing.', 'CONTROL_PROTOCOL_ERROR')
    return { phase: input.phase, observation }
  }
  throw new AgentMuxError('The original Capsule input result is malformed.', 'CONTROL_PROTOCOL_ERROR')
}
