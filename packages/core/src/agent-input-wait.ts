import { AgentMuxError } from './errors.js'
import { agentPromptInputId, validateAgentPromptInputKey, type AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentNativeBinding, AgentNativeSessionHandle, AgentOperationDevice, AgentMessageChannel, AgentPromptSubmissionRecord } from './types.js'

/** Original input identity, waiting generation and stop action are distinct. */
export type AgentInputWaitRef = { key: AgentPromptInputKey; waitGeneration: number }
export type AgentInputSelector = { key: AgentPromptInputKey } | { kind: 'message-control'; originalControlOperationId: string }
export type AgentInputWaitReason =
  | { phase: 'runtime'; reason: 'runtime-unavailable'; wake: 'runtime-restored'; failure?: import('./delivery-attempt.js').DeliveryFailure }
  | { phase: 'authorization'; reason: 'author-authorization-needed'; wake: 'explicit-rejoin'; failure?: import('./delivery-attempt.js').DeliveryFailure }
  | { phase: 'observer'; reason: 'observer-stopped'; wake: 'explicit-rejoin'; failure: import('./delivery-attempt.js').DeliveryFailure; observation?: { phase: string } }
  | { phase: 'native-environment'; reason: 'original-environment-unconfirmed' | 'original-target-changed'; wake: 'explicit-rejoin';
      mechanism?: 'unconfirmed' | 'unavailable'; observation?: { phase: string; failure: import('./delivery-attempt.js').DeliveryFailure } }
  | { phase: 'service'; reason: 'observation-failed'; wake: 'explicit-rejoin'; failure: import('./delivery-attempt.js').DeliveryFailure; observation?: { phase: string } }

/** A saved locator constrains later qualification; saving it does not grant Ready. */
export type AgentInputSavedEnvironment = {
  providerId: string
  executorId: string
  nativeHandle?: AgentNativeSessionHandle
  nativeBinding?: Pick<AgentNativeBinding, 'source' | 'run'>
}
export type AgentInputJournalIntent = {
  key: AgentPromptInputKey
  admissionIntent: { kind: 'manual-actor'; expectedRun: AgentPromptInputKey['expectedRun'] }
  execution: 'immediate'
  environment: AgentInputSavedEnvironment
  source:
    | { kind: 'prompt'; prompt: string; agentMuxNote?: string; authorHuman?: boolean; sourceChannel?: AgentMessageChannel; sourceDevice?: AgentOperationDevice }
    | { kind: 'message'; messageId: string; originalControlOperationId: string }
}
export type AgentInputDispatchLink = { ref: AgentInputWaitRef; gateId: string }
export type AgentInputJournalEntry = { sequence: number; intent: AgentInputJournalIntent; control: AgentInputWaitControl }
export type AgentInputWaitControl = {
  ref: AgentInputWaitRef
  state: 'enabled' | 'stopped-before-dispatch' | 'dispatch-authorized'
  at: number
  waiting?: AgentInputWaitReason
  gateId?: string
}
export type AgentInputWaitStopReceipt = {
  ref: AgentInputWaitRef
  cancelOperationId: string
  outcome: 'stopped-before-dispatch' | 'observation-stopped' | 'already-settled' | 'stale-generation'
  at: number
}
/** Admission is a projection of the original Session owner, never journal outcome. */
export type AgentInputSubmissionReceipt = {
  key: AgentPromptInputKey
  ref: AgentInputWaitRef
  originalControlOperationId?: string
  persistence: 'confirmed'
  control: AgentInputWaitControl
  admission: AgentPromptSubmissionRecord | null
  status: 'waiting' | 'stopped' | 'admitted' | 'not-applied' | 'unknown'
  observation: 'owned' | 'rejoin-needed' | 'closed'
}
export type AgentInputWaitJournalRecord =
  | { kind: 'input-intent'; sequence: number; intent: AgentInputJournalIntent; at: number }
  | { kind: 'input-control'; sequence: number; control: AgentInputWaitControl }
  | { kind: 'input-stop'; sequence: number; receipt: AgentInputWaitStopReceipt }

/** Producer kind cannot give a second writer the same original logical ID. */
export function agentInputJournalKey(key: AgentPromptInputKey): string {
  const original = validateAgentPromptInputKey(key)
  return JSON.stringify([original.agentSessionId, original.expectedRun.runId, agentPromptInputId(original)])
}
export function validateAgentInputWaitRef(value: unknown): AgentInputWaitRef {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'key' && k !== 'waitGeneration')) {
    throw new AgentMuxError('The original input waiting reference is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  }
  const ref = value as AgentInputWaitRef
  if (!Number.isSafeInteger(ref.waitGeneration) || ref.waitGeneration < 1) throw new AgentMuxError(
    'The original input waiting generation is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  return { key: validateAgentPromptInputKey(ref.key), waitGeneration: ref.waitGeneration }
}
export function validateAgentInputControlId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 512 || /[\0\r\n]/u.test(value)) {
    throw new AgentMuxError('The original input control identity is invalid.', 'INVALID_AGENT_INPUT_CONTROL')
  }
  return value
}
