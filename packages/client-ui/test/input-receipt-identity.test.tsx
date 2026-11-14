import { expect, it } from 'vitest'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { projectInputReceipt } from '../src/lib/input-receipt-projection.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


function receipt(): AgentInputSubmissionReceipt {
  const run = { runId: 'original-run' }, key = { kind: 'prompt' as const, agentSessionId: 'original-session', expectedRun: run, submissionId: 'original-input' }
  const ref = { key, waitGeneration: 1 }, plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor', sourceId: 'original-source',
    threadId: 'original-thread', operation: 'start-or-steer' as const, clientCorrelation: 'original-correlation' }
  return { key, ref, persistence: 'confirmed', status: 'unknown', observation: 'closed', control: { ref, state: 'dispatch-authorized', at: _historyFixtureEpoch(0, 0, 1), gateId: 'original-gate' },
    admission: { agentSessionId: key.agentSessionId, run, admission: { submissionId: key.submissionId, operationId: key.submissionId, inputKey: key,
      inputDispatch: { ref, gateId: 'original-gate' }, transport: 'native', acknowledged: false,
      intent: { run, ownerInstanceId: 'original-owner', prompt: 'Original body', execution: 'immediate', plan,
        admissionIntent: { kind: 'native-conversation', source: { providerId: 'codex', nativeSessionId: plan.threadId }, expectedRun: run } },
      native: { plan, outcome: 'unknown' } } } }
}

it.each(['both', 'native', 'intent'] as const)('retains the original receipt when %s correlation changes under the same key and generation', where => {
  const prior = receipt(), before = structuredClone(prior), next = structuredClone(prior), claim = next.admission!.admission!
  if (claim.transport !== 'native' || claim.intent?.plan.kind !== 'native-rpc') throw Error('Expected original native claim')
  if (where !== 'intent') claim.native.plan = { ...claim.native.plan, clientCorrelation: 'different-correlation' }
  if (where !== 'native') claim.intent.plan = { ...claim.intent.plan, clientCorrelation: 'different-correlation' }
  expect(() => projectInputReceipt(prior, next)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
  expect(prior).toEqual(before)
})

it('accepts ACK progress on the same frozen correlation without converting an unknown outcome into adoption', () => {
  const prior = receipt(), next = structuredClone(prior), claim = next.admission!.admission!
  claim.acknowledged = true
  expect(projectInputReceipt(prior, next)).toEqual(next)
  expect(next.status).toBe('unknown')
})

function payloadReceipt(): AgentInputSubmissionReceipt {
  const value = receipt(), native = value.admission!.admission!
  if (native.transport !== 'native' || !native.intent) throw Error('Expected native fixture')
  const { transport: _transport, native: _native, ...original } = native
  value.admission!.admission = { ...original, startByte: 0, endByte: 18, operationId: 'payload-op', intent: {
    ...native.intent, plan: { kind: 'payload-then-submit', payload: 'original-payload', payloadText: 'original-body', submit: 'key', minimumSubmitDelayMs: 35 } } }
  value.admission!.terminalPromptSubmission = { run: value.key.expectedRun, submissionId: 'original-input', promptDigest: 'original-digest', outputCursorBytes: 0,
    payload: { operationId: 'payload-op', inputByteRange: { startByte: 0, endByte: 15 }, acknowledged: true },
    submit: { operationId: 'submit-op', inputByteRange: { startByte: 15, endByte: 18 }, acknowledged: false },
    payloadConsumption: { sourceId: 'original-source', baselineId: 'original-baseline' } }
  return value
}

it.each(['payload', 'payloadText', 'submit', 'minimumSubmitDelayMs'] as const)('keeps the original native payload plan when %s changes', field => {
  const prior = payloadReceipt(), next = structuredClone(prior), plan = next.admission!.admission!.intent!.plan
  if (plan.kind !== 'payload-then-submit') throw Error('Expected native payload plan')
  if (field === 'minimumSubmitDelayMs') plan[field] = 0; else plan[field] = 'another-body'
  expect(() => projectInputReceipt(prior, next)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
})

it.each(['sourceId', 'baselineId'] as const)('keeps the original payload %s across later public observations', field => {
  const prior = payloadReceipt(), next = structuredClone(prior)
  next.admission!.terminalPromptSubmission!.payloadConsumption![field] = 'another-source'
  expect(() => projectInputReceipt(prior, next)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
})

it('projects native consumption progress without granting a turn outcome and retains its confirmed original receipt', () => {
  const prior = payloadReceipt(), consumed = structuredClone(prior)
  consumed.admission!.terminalPromptSubmission!.payloadConsumption!.receipt = { id: 'original-native-body', observedAt: 123 }
  expect(projectInputReceipt(prior, consumed).status).toBe('unknown')
  expect(projectInputReceipt(consumed, prior)).toBe(consumed)
  const conflicting = structuredClone(consumed)
  conflicting.admission!.terminalPromptSubmission!.payloadConsumption!.receipt!.id = 'another-native-body'
  expect(() => projectInputReceipt(consumed, conflicting)).toThrowError(expect.objectContaining({ code: 'CONTROL_REQUEST_CONFLICT' }))
})
