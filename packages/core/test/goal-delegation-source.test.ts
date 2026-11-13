import { expect, it } from 'vitest'
import { goalDelegationApplication, readGoalDelegationSource, assertGoalSourceReport, goalReportApplication, readGoalReportApplication } from '../src/goal-delegation-source.js'
import { assertGoalDelegationSource, assertGoalDelegationReply, goalDelegationReportBody } from '../src/goal-delegation.js'
import type { DurableAgentMuxMessage } from '../src/agent-global-message-queue.js'
import type { DemandDelegation } from '@agentmux/demand/delegations'

const saved: DemandDelegation = { operationId: 'delegate', sourceMessageId: 'source', hostId: 'owner', workerHostId: 'worker',
  ownerAgentSessionId: 'same-session', workerAgentSessionId: 'same-session', ownerRunId: 'same-run', workerRunId: 'same-run',
  threadId: 'thread', text: 'Original text can change its display without changing protocol', alignmentRevision: 1, criterionIds: ['c'],
  preparedAt: 1, capturedCriteria: [{ id: 'c', text: 'Deliver original result' }], linkedAt: 2,
  runtimeIdentity: { ownerRuntimeId: 'owner-runtime', workerRuntimeId: 'worker-runtime' } }
const report = { operationId: 'report', replyMessageId: 'reply', authorAgentSessionId: 'same-session',
  grounding: { alignmentRevision: 1, summary: 'Actual result', checks: [{ criterionId: 'c', outcome: 'met' as const, evidence: ['result.log'], note: '' }] } }
const source = (): DurableAgentMuxMessage => ({ envelope: { operationId: saved.operationId, messageId: saved.sourceMessageId,
  sender: { kind: 'agent-session', agentSessionId: saved.ownerAgentSessionId }, senderSessionId: saved.ownerAgentSessionId, senderRunId: saved.ownerRunId,
  recipient: { kind: 'agent-session', agentSessionId: saved.workerAgentSessionId }, recipientSessionId: saved.workerAgentSessionId, recipientRunId: saved.workerRunId,
  senderRuntimeId: 'owner-runtime', recipientRuntimeId: 'worker-runtime', threadId: saved.threadId, replyTo: null, body: saved.text,
  application: goalDelegationApplication('goal', saved) }, provenance: { source: { runtimeId: 'owner-runtime' }, target: { runtimeId: 'worker-runtime' } } } as DurableAgentMuxMessage)

it('reads only explicit Goal application and compares finite JSON by meaning rather than object key order', () => {
  const original = source(), payload = original.envelope.application!.data as Record<string, unknown>
  original.envelope.application!.data = Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]])) as typeof original.envelope.application.data
  expect(() => assertGoalDelegationSource(saved, original, 'goal')).not.toThrow()
  original.envelope.body = JSON.stringify({ schema: 'agentmux.goal-delegation.v1', goalId: 'forged' })
  expect(readGoalDelegationSource(original).goalId).toBe('goal')
  delete original.envelope.application
  expect(() => readGoalDelegationSource(original)).toThrow('no authenticated Goal delegation application')
})

it('keeps the complete original criterion set and revision in a source report', () => {
  const data = readGoalDelegationSource(source())
  expect(() => assertGoalSourceReport(data, report)).not.toThrow()
  expect(() => assertGoalSourceReport(data, { ...report, grounding: { ...report.grounding, alignmentRevision: 2 } })).toThrow('original proposal')
  expect(() => assertGoalSourceReport(data, { ...report, grounding: { ...report.grounding, checks: [] } })).toThrow('every delegated criterion')
})

it('binds an original source to canonical Runtime identities even when SID and Run match', () => {
  const original = source()
  original.envelope.recipientRuntimeId = 'impostor-runtime'
  expect(() => assertGoalDelegationSource(saved, original, 'goal')).toThrow('Runtime identities differ')
})

it('accepts the original signed reverse reply and refuses a same-SID report from another Runtime', () => {
  const original = source(), body = goalDelegationReportBody('goal', saved.operationId, report)
  const reply = { ...original, envelope: { ...original.envelope, operationId: 'report', messageId: 'reply',
    senderRuntimeId: 'worker-runtime', recipientRuntimeId: 'owner-runtime', replyTo: 'source', body,
    application: goalReportApplication('goal', saved.operationId, report) }, provenance: { source: { runtimeId: 'worker-runtime' }, target: { runtimeId: 'owner-runtime' } } } as DurableAgentMuxMessage
  expect(readGoalReportApplication(reply, 'goal', 'delegate')).toEqual(report)
  expect(() => assertGoalDelegationReply(saved, report, reply, body, original)).not.toThrow()
  reply.envelope.senderRuntimeId = 'impostor-runtime'
  expect(() => assertGoalDelegationReply(saved, report, reply, body, original)).toThrow('actual worker reply differs')
})
