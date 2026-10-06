import type { AgentInputSubmissionReceipt } from '@agentmux/core'

/** Frozen original claim identity; ACK progress and observation diagnostics are not identity. */
function receiptIdentity(record: NonNullable<AgentInputSubmissionReceipt['admission']>): string | undefined {
  const claim = record.admission
  if (!claim) return undefined
  const intent = claim.intent, key = claim.inputKey, message = intent?.message, condition = intent?.admissionIntent
  const plan = intent?.plan
  const common = [record.agentSessionId, record.run.runId, claim.submissionId, claim.operationId,
    key?.kind, key?.agentSessionId, key?.expectedRun.runId, key?.kind === 'prompt' ? key.submissionId : key?.messageId,
    claim.inputDispatch?.ref.waitGeneration, claim.inputDispatch?.gateId,
    intent?.run.runId, intent?.ownerInstanceId, intent?.prompt, intent?.execution,
    condition?.kind, condition?.kind === 'manual-actor' ? condition.expectedRun.runId : condition?.condition.expectedRun.runId,
    condition?.kind === 'exact-condition' ? condition.condition.afterSubmissionId : undefined,
    message?.userContent, message?.systemContext, message?.authorAgentSessionId, message?.authorHuman,
    message?.sourceDevice?.hostId, message?.sourceDevice?.deviceId, message?.sourceDevice?.name, message?.sourceChannel]
  if (claim.transport === 'native') {
    const native = claim.native.plan, input = plan?.kind === 'native-rpc' ? plan : undefined
    return JSON.stringify([...common, 'native', native.kind, native.operation, native.protocolId, native.sourceId, native.actorId,
      native.threadId, native.expectedTurnId, input?.kind, input?.operation, input?.protocolId, input?.sourceId,
      input?.actorId, input?.threadId, input?.expectedTurnId])
  }
  return JSON.stringify([...common, 'pty', claim.startByte, claim.endByte, plan?.kind,
    plan?.kind === 'single-phase' ? plan.data : plan?.kind === 'render-then-submit'
      ? [plan.payload, plan.renderedText, plan.submit, plan.prepare?.interrupt, plan.prepare?.endEvent, plan.prepare?.refresh] : undefined])
}

const settled = (receipt: AgentInputSubmissionReceipt) =>
  receipt.status === 'admitted' || receipt.status === 'terminal-confirmed' || receipt.status === 'not-applied'

/** Retain observations of one Core-owned input. This never interprets transport ACKs,
 * grants admission or creates a new input; Core's typed status is the source of truth. */
export function projectInputReceipt(prior: AgentInputSubmissionReceipt | undefined,
  next: AgentInputSubmissionReceipt): AgentInputSubmissionReceipt {
  if (!prior) return next
  const key = (value: AgentInputSubmissionReceipt['key']) => JSON.stringify([value.kind, value.agentSessionId,
    value.expectedRun.runId, value.kind === 'prompt' ? value.submissionId : value.messageId])
  if (key(prior.key) !== key(next.key)) throw Object.assign(new Error('Core observations belong to different original inputs. The original receipt is retained.'),
    { code: 'CONTROL_REQUEST_CONFLICT' })
  if (prior.ref.waitGeneration > next.ref.waitGeneration) return prior
  if (prior.ref.waitGeneration !== next.ref.waitGeneration) {
    if (prior.admission || prior.control.state === 'dispatch-authorized' || settled(prior)) throw Object.assign(
      new Error('A later waiting generation conflicts with this original input claim or confirmed outcome. Its original receipt is retained.'), { code: 'CONTROL_REQUEST_CONFLICT' })
    return next
  }
  const oldNative = prior.admission?.admission, newNative = next.admission?.admission
  const oldPhases = prior.admission?.terminalPromptSubmission, newPhases = next.admission?.terminalPromptSubmission
  const phasesIdentity = (phases: NonNullable<typeof oldPhases>) => JSON.stringify([phases.run.runId, phases.submissionId, phases.promptDigest,
    phases.payload.operationId, phases.payload.inputByteRange.startByte, phases.payload.inputByteRange.endByte,
    phases.submit.operationId, phases.submit.inputByteRange.startByte, phases.submit.inputByteRange.endByte])
  if (settled(prior) && settled(next) && prior.status !== next.status ||
      prior.control.state === 'dispatch-authorized' && next.control.state === 'dispatch-authorized' && prior.control.gateId !== next.control.gateId ||
      prior.admission && next.admission && receiptIdentity(prior.admission) !== receiptIdentity(next.admission) ||
      oldPhases && newPhases && phasesIdentity(oldPhases) !== phasesIdentity(newPhases) ||
      oldNative?.transport === 'native' && newNative?.transport === 'native' && (
        oldNative.native.turnId !== undefined && newNative.native.turnId !== undefined && oldNative.native.turnId !== newNative.native.turnId ||
        ['admitted', 'not-applied'].includes(oldNative.native.outcome) && ['admitted', 'not-applied'].includes(newNative.native.outcome) && oldNative.native.outcome !== newNative.native.outcome)) {
    throw Object.assign(new Error('Core observations conflict for this original input generation. Its original gate and admission remain retained; refresh the original input before another action.'),
      { code: 'CONTROL_REQUEST_CONFLICT' })
  }
  if (prior.admission && !next.admission || settled(prior) && next.status !== prior.status ||
      oldNative?.transport === 'native' && oldNative.native.turnId !== undefined && newNative?.transport === 'native' && newNative.native.turnId === undefined ||
      oldPhases && (!newPhases || oldPhases.payload.acknowledged && !newPhases.payload.acknowledged || oldPhases.submit.acknowledged && !newPhases.submit.acknowledged) ||
      prior.control.state === 'dispatch-authorized' && next.control.state !== 'dispatch-authorized' ||
      prior.control.state === 'stopped-before-dispatch' && next.control.state !== 'stopped-before-dispatch' ||
      prior.status === 'unknown' && (next.status === 'waiting' || next.status === 'stopped')) return prior
  return next
}
