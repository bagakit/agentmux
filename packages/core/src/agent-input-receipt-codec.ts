import { AgentMuxError } from './errors.js'
import { dequal } from 'dequal'
import { parseDeliveryFailure } from './delivery-attempt.js'
import { agentInputDeliveryKey, agentInputSubmissionStatus, validateAgentInputDeliveryKey, validateAgentInputRetry, validateAgentInputWaitRef, type AgentInputSubmissionReceipt } from './agent-input-wait.js'
import { agentPromptInputId, validateAgentPromptInputKey } from './agent-prompt-condition.js'
import { parsePromptSubmissionRecord } from './prompt-submission-record.js'
import { rpcRecord } from './rpc-data.js'
function wireFail(): never { throw new AgentMuxError('Original input receipt is invalid.', 'CONTROL_PROTOCOL_ERROR') }
const wireRecord = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'CONTROL_PROTOCOL_ERROR')
function wireString(value: unknown): void { if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) wireFail() }
function wireTimestamp(value: unknown): void { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) wireFail() }
function wireMember(value: unknown, fields: readonly unknown[]): void { if (!fields.includes(value)) wireFail() }
export function parseAgentInputSubmissionReceipt(value: unknown): AgentInputSubmissionReceipt {
  const p = wireRecord(value, ['key', 'ref', 'originalControlOperationId', 'persistence', 'control', 'admission', 'status', 'observation'])
  const key = validateAgentPromptInputKey(p.key), ref = validateAgentInputWaitRef(p.ref)
  if (!dequal(key, ref.key) || p.persistence !== 'confirmed') wireFail()
  wireMember(p.observation, ['owned', 'rejoin-needed', 'closed'])
  if (p.originalControlOperationId !== undefined) wireString(p.originalControlOperationId)
  const control = wireRecord(p.control, ['ref', 'state', 'at', 'waiting', 'gateId', 'deliveryKey', 'retry'])
  if (!dequal(validateAgentInputWaitRef(control.ref), ref)) wireFail()
  wireMember(control.state, ['enabled', 'stopped-before-dispatch', 'dispatch-authorized']); wireTimestamp(control.at)
  if (control.state === 'dispatch-authorized') wireString(control.gateId)
  else if (control.gateId !== undefined) wireFail()
  if (control.deliveryKey !== undefined) {
    if (control.state !== 'dispatch-authorized') wireFail()
    const delivery = validateAgentInputDeliveryKey(key, control.deliveryKey)
    if (delivery.attemptId !== (control.retry as import('./agent-input-wait.js').AgentInputRetry | undefined)?.attemptId) wireFail()
  }
  if (control.retry !== undefined && validateAgentInputRetry(key, control.retry).previousWaitGeneration >= ref.waitGeneration) wireFail()
  if (control.waiting !== undefined) {
    const waiting = wireRecord(control.waiting, ['phase', 'reason', 'wake', 'failure', 'mechanism', 'observation'])
    if (waiting.phase === 'runtime') { if (waiting.reason !== 'runtime-unavailable' || waiting.wake !== 'runtime-restored') wireFail() }
    else if (waiting.phase === 'session') { if (waiting.reason !== 'session-resume-needed' || waiting.wake !== 'session-restored') wireFail() }
    else if (waiting.phase === 'authorization') { if (waiting.reason !== 'author-authorization-needed' || waiting.wake !== 'explicit-rejoin') wireFail() }
    else if (waiting.phase === 'observer') { if (waiting.reason !== 'observer-stopped' || waiting.wake !== 'explicit-rejoin' || waiting.failure === undefined) wireFail() }
    else if (waiting.phase === 'input-environment') { if (!['original-input-unconfirmed', 'original-target-changed'].includes(String(waiting.reason)) || waiting.wake !== 'explicit-rejoin' || waiting.failure === undefined) wireFail() }
    else if (waiting.phase === 'service') { if (waiting.reason !== 'observation-failed' || !['explicit-rejoin', 'session-restored'].includes(String(waiting.wake)) || waiting.failure === undefined) wireFail() }
    else { if (waiting.phase !== 'native-environment' || !['original-environment-unconfirmed', 'original-target-changed'].includes(String(waiting.reason)) || waiting.wake !== 'explicit-rejoin') wireFail() }
    if (waiting.failure !== undefined) parseDeliveryFailure(waiting.failure)
    if (waiting.mechanism !== undefined) wireMember(waiting.mechanism, ['unconfirmed', 'unavailable'])
    if (waiting.observation !== undefined) {
      const observed = wireRecord(waiting.observation, ['phase', 'failure']); wireString(observed.phase)
      if (observed.failure !== undefined) parseDeliveryFailure(observed.failure)
      else if (waiting.phase === 'native-environment') wireFail()
    }
  }
  const admission = p.admission === null ? null : parsePromptSubmissionRecord(p.admission)
  const deliveryKey = agentInputDeliveryKey(control as AgentInputSubmissionReceipt['control'])
  if (admission && (admission.agentSessionId !== key.agentSessionId || admission.run.runId !== deliveryKey.expectedRun.runId ||
      admission.admission?.inputKey && !dequal(admission.admission.inputKey, deliveryKey) ||
      (admission.admission?.submissionId ?? admission.terminalPromptSubmission?.submissionId ?? admission.admission?.operationId) !== agentPromptInputId(deliveryKey))) wireFail()
  const status = agentInputSubmissionStatus(control as AgentInputSubmissionReceipt['control'], admission)
  if (p.status !== status) wireFail()
  return value as AgentInputSubmissionReceipt
}
