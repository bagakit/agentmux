import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { DemandDelegation, DemandDelegationReportInput } from '@agentmux/demand/delegations'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
const core = await import(/* @vite-ignore */ new URL('../dist/index.js', import.meta.url).href) as typeof import('../src/index.js')
const goal = await import(/* @vite-ignore */ new URL('../dist/goal-delegation.js', import.meta.url).href) as typeof import('../src/goal-delegation.js')
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('rejects contradictory source identity objects in an otherwise original Goal read', async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient'], core)
  try {
    const saved: DemandDelegation = { operationId: 'original-task', sourceMessageId: 'original-source', hostId: 'local',
      ownerAgentSessionId: 'caller', workerAgentSessionId: 'recipient', ownerRunId: 'run-caller', workerRunId: 'run-recipient',
      threadId: 'original-thread', text: 'Original delegated input', alignmentRevision: 1, criterionIds: ['AC-01'], preparedAt: reshapeFixtureEpoch(0, 0, 1),
      capturedCriteria: [{ id: 'AC-01', text: 'Deliver original evidence' }] }
    const queue = new core.DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
    await queue.append({ operationId: saved.operationId, messageId: saved.sourceMessageId, createdAt: reshapeFixtureEpoch(0, 0, 1),
      sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: 'caller', senderRunId: saved.ownerRunId, recipientSessionId: 'recipient', recipientRunId: saved.workerRunId,
      threadId: saved.threadId, correlationId: saved.sourceMessageId, replyTo: null, workspaceId: null, body: saved.text })
    await h.client.openDispatch({ capability: h.capability, callerAgentSessionId: 'caller', sourceMessageId: saved.sourceMessageId })
    const communication = { ...await h.client.readDispatch({ sourceMessageId: saved.sourceMessageId }), hostId: 'local' }
    const value = { goalId: 'goal', goalUpdatedAt: reshapeFixtureEpoch(0, 0, 1), delegations: [saved], diskDurability: 'confirmed',
      observations: [{ operationId: saved.operationId, communication }] }
    expect(goal.parseGoalDelegationResult(value, { goalId: 'goal' }).observations![0]!.communication!.source).toEqual(communication.source)
    for (const field of ['sender', 'recipient'] as const) {
      const forged: any = structuredClone(value)
      forged.observations[0]!.communication.source.envelope[field] = { kind: 'agent-session', agentSessionId: 'another-subject' }
      expect(() => goal.parseGoalDelegationResult(forged, { goalId: 'goal' })).toThrow('frozen Goal intent')
    }
  } finally { await h.close() }
})

it('rejects contradictory worker reply objects without changing original report acceptance', async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient'], core)
  try {
    const saved: DemandDelegation = { operationId: 'original-task', sourceMessageId: 'original-source', hostId: 'local',
      ownerAgentSessionId: 'caller', workerAgentSessionId: 'recipient', ownerRunId: 'run-caller', workerRunId: 'run-recipient',
      threadId: 'original-thread', text: 'Original delegated input', alignmentRevision: 1, criterionIds: ['AC-01'], preparedAt: reshapeFixtureEpoch(0, 0, 1),
      capturedCriteria: [{ id: 'AC-01', text: 'Deliver original evidence' }] }
    const report: DemandDelegationReportInput = { operationId: 'report-operation', replyMessageId: 'report-reply', authorAgentSessionId: 'recipient',
      grounding: { alignmentRevision: 1, summary: 'Recorded evidence', checks: [{ criterionId: 'AC-01', outcome: 'met', evidence: ['evidence/result.md'], note: '' }] } }
    const queue = new core.DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()), body = goal.goalDelegationReportBody('goal', saved.operationId, report)
    await queue.append({ operationId: report.operationId, messageId: report.replyMessageId, createdAt: reshapeFixtureEpoch(0, 0, 1),
      sender: { kind: 'agent-session', agentSessionId: 'recipient' }, recipient: { kind: 'agent-session', agentSessionId: 'caller' },
      senderSessionId: 'recipient', senderRunId: saved.workerRunId, recipientSessionId: 'caller', recipientRunId: saved.ownerRunId,
      threadId: saved.threadId, correlationId: saved.sourceMessageId, replyTo: saved.sourceMessageId, workspaceId: null, body })
    const reply = (await queue.readByOperationId(report.operationId))!
    expect(goal.readGoalDelegationWireReport('goal', saved, reply)).toEqual(report)
    for (const field of ['sender', 'recipient'] as const) {
      const forged: any = structuredClone(reply)
      forged.envelope[field] = { kind: 'agent-session', agentSessionId: 'another-subject' }
      expect(() => goal.readGoalDelegationWireReport('goal', saved, forged)).toThrow('actual worker reply')
    }
    expect(saved.report).toBeUndefined(); expect(saved.collection).toBeUndefined()
  } finally { await h.close() }
})
