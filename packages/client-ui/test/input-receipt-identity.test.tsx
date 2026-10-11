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
