import { afterEach, expect, it, vi } from 'vitest'
import { DemandStore } from '@agentmux/demand'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const owner = await crossHostOwner(cleanup, 'plan-revision-owner', ['supervisor', 'worker-a', 'worker-b', 'reviewer'])
  const goalId = (await owner.call('supervisor', ['goal', 'create', '--title', 'Keep original plan work', '--status', 'in_progress', '--session', 'supervisor',
    '--assignees', JSON.stringify(['supervisor', 'worker-a', 'worker-b', 'reviewer']), '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-original'])).goal.id
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({ summary: 'Original plan scope', criteria: [{ id: 'original', text: 'The original criterion remains independently checkable.' }], openQuestions: [] })])
  const node = { id: 'original-node', title: 'Original node', outcome: 'Deliver the original result', dependsOn: [], criterionIds: ['original'],
    check: 'node --test checks/original.test.mjs', executor: { hostId: 'local', agentSessionId: 'worker-a' } }
  const revision = { operationId: 'plan-1', expectedRevision: 0, alignmentRevision: 1, nodes: [node] }
  const published = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision })
  const read = () => owner.call('supervisor', ['goal', 'plan', '--goal', goalId])
  return { owner, goalId, node: published.plan.nodes[0] as typeof node, revision, read }
}

it('public CLI revision replay compares the full original input and rejects newly written invalid criteria without losing the current plan', async () => {
  const f = await fixture(), before = await f.read()
  const changed = await f.owner.cli('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId,
    revision: { ...f.revision, nodes: [{ ...f.node, title: 'Different payload using the same operation' }] } })
  expect(changed.code).toBe(1); expect(changed.stderr).toContain('already recorded with different content')
  const invalid = await f.owner.cli('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId,
    revision: { ...f.revision, operationId: 'invalid-new-node', expectedRevision: 1, nodes: [f.node, { ...f.node, id: 'invalid', criterionIds: [] }] } })
  expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('must write at least one success criterion')
  expect((await f.read()).plan).toEqual(before.plan)
  const next = await f.owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId,
    revision: { ...f.revision, operationId: 'plan-2', expectedRevision: 1, nodes: [{ ...f.node, title: 'Explicit new revision' }] } })
  expect(next.plan.revision).toBe(2)
  const earlier = await f.owner.cli('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId, revision: f.revision })
  expect(earlier.code).toBe(1); expect(earlier.stderr).toContain('already applied at plan revision 1; the current plan is revision 2')
  expect(f.owner.native.stop).not.toHaveBeenCalled()
})

it('the public Supervisor reassigns an active plan node, preserves a late original report and delegates only the new current attempt', async () => {
  const f = await fixture()
  const intent = (worker: string, attempt: number) => ({ operationId: `delegate-${attempt}`, sourceMessageId: `source-${attempt}`, threadId: `thread-${attempt}`, hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: worker, workerRunId: `run-${worker}`,
    text: 'Deliver the original result', alignmentRevision: 1, criterionIds: ['original'], planNodeId: f.node.id })
  await f.owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: f.goalId, intent: intent('worker-a', 1) })
  expect((await f.read()).planState.nodes[0]).toMatchObject({ state: 'working', attempts: 1, attempt: { delegationOperationId: 'delegate-1' } })
  const changed = await f.owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: f.goalId,
    revision: { ...f.revision, operationId: 'reassign-to-b', expectedRevision: 1, nodes: [{ ...f.node, executor: { hostId: 'local', agentSessionId: 'worker-b' } }] } })
  expect(changed.planState.nodes[0]).toMatchObject({ state: 'ready', attempts: 1, attempt: null })
  await f.owner.call('worker-a', ['goal', 'report', '--input', '-'], { goalId: f.goalId, operationId: 'delegate-1', report: {
    operationId: 'late-original-report', replyMessageId: 'late-original-reply', authorAgentSessionId: 'worker-a', grounding: { alignmentRevision: 1,
      summary: 'The original worker reported after reassignment', checks: [{ criterionId: 'original', outcome: 'met', evidence: ['checks/original-a.log'], note: '' }] } } })
  const late = await f.read()
  expect(late.delegations[0].report).toMatchObject({ replyMessageId: 'late-original-reply' })
  expect(late.planState.nodes[0]).toMatchObject({ state: 'ready', attempt: null })
  const forbidden = await f.owner.cli('reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId: f.goalId, review: { operationId: 'old-attempt-review',
    nodeId: f.node.id, delegationOperationId: 'delegate-1', verdict: 'pass', check: { command: f.node.check, result: 'Original result', evidence: ['checks/original-a.log'] }, note: '' } })
  expect(forbidden.code).toBe(1); expect(forbidden.stderr).toContain("must judge the node's current attempt")
  const delegated = await f.owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: f.goalId, intent: intent('worker-b', 2) })
  expect(delegated.planState.nodes[0]).toMatchObject({ state: 'working', attempts: 2, attempt: { delegationOperationId: 'delegate-2' } })
  expect(delegated.delegations.map((entry: { sourceMessageId: string }) => entry.sourceMessageId)).toEqual(['source-1', 'source-2'])
  const original = await f.owner.call('supervisor', ['message', 'read', '--host', 'local', '--message-id', 'source-1'])
  expect(original.message.envelope).toMatchObject({ messageId: 'source-1', threadId: 'thread-1', recipientSessionId: 'worker-a' })
  expect(f.owner.native.stop).not.toHaveBeenCalled()
})

it('the current Supervisor collects the original worker report after reassignment', async () => {
  const f = await fixture()
  const intent = { operationId: 'original-dispatch', sourceMessageId: 'original-source', threadId: 'original-thread', hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker-a', workerRunId: 'run-worker-a',
    text: f.node.outcome, alignmentRevision: 1, criterionIds: ['original'], planNodeId: f.node.id }
  await f.owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: f.goalId, intent })
  await f.owner.call(null, ['goal', 'update', '--goal', f.goalId, '--supervisor', 'worker-b'])
  const report = {
    operationId: 'original-report', replyMessageId: 'original-reply', authorAgentSessionId: 'worker-a',
    grounding: { alignmentRevision: 1, summary: 'Original evidence',
      checks: [{ criterionId: 'original', outcome: 'met', evidence: ['checks/original.log'], note: '' }] }
  }
  const reported = await f.owner.call('worker-a', ['goal', 'report', '--input', '-'], { goalId: f.goalId, operationId: intent.operationId, report })
  const original = reported.delegations[0]
  expect(original.report.delivery.hash).toMatch(/^[a-f0-9]{64}$/u)

  const args = ['goal', 'collect', '--input', '-']
  const input = { goalId: f.goalId, operationId: intent.operationId,
    collection: { operationId: 'collect-original', replyMessageId: report.replyMessageId } }
  const refused = await f.owner.cli('reviewer', args, input)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('Only the original responsibility owner or current Supervisor')
  const collected = await f.owner.call('worker-b', args, input)
  expect(collected.goalState.supervisorSessionId).toBe('worker-b')
  expect(collected.delegations).toEqual([{ ...original, collection: expect.objectContaining({ ...input.collection,
    collector: { kind: 'agent', id: 'worker-b' } }) }])
  expect(collected.grounding.acceptedAt).toBeNull()
  expect(f.owner.native.stop).not.toHaveBeenCalled()
})

it('appends independent branches from a completed Ticket through the public CLI', async () => {
  const f = await fixture()
  const parent = f.node.id
  await f.owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: f.goalId, intent: {
    operationId: 'dispatch-original', sourceMessageId: 'source-original', threadId: 'thread-original', hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker-a', workerRunId: 'run-worker-a',
    text: f.node.outcome, alignmentRevision: 1, criterionIds: ['original'], planNodeId: parent,
  } })
  const report = await f.owner.call('worker-a', ['goal', 'report', '--input', '-'], { goalId: f.goalId, operationId: 'dispatch-original', report: {
    operationId: 'report-original', replyMessageId: 'reply-original', authorAgentSessionId: 'worker-a',
    grounding: { alignmentRevision: 1, summary: 'Original result', checks: [{ criterionId: 'original', outcome: 'met', evidence: ['proof:original'], note: '' }] },
  } })
  const before = await f.owner.call('reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId: f.goalId, review: {
    operationId: 'review-original', nodeId: parent, delegationOperationId: 'dispatch-original',
    deliveryHash: report.delegations[0].report.delivery.hash, verdict: 'pass', note: '',
    check: { command: f.node.check, result: 'Passed', evidence: ['proof:original'] },
  } })
  expect(before.planState.nodes[0].state).toBe('done')
  const { runtimeId, namespace } = before.address
  const args = (operationId: string, alias = runtimeId, alignment = '1') => ['goal', 'plan', 'append', '--goal', f.goalId,
    '--alignment-revision', alignment, '--operation-id', operationId, '--runtime', alias, '--namespace', namespace, '--input', '-']
  const next = { ...f.node, id: 'follow-up', title: 'Follow up', dependsOn: [parent], executor: null }
  const later = { ...next, id: 'verify-follow-up', title: 'Verify follow-up', dependsOn: [next.id] }
  const branchA = { nodes: [later, next] }
  const branchB = { nodes: [{ ...next, title: 'Independent branch' }] }
  const skill = await f.owner.cli('supervisor', ['goal', '--skill'])
  expect(skill.code).toBe(0)
  expect(skill.stdout).toContain('Keep decomposition and follow-up work within the original Goal')
  const denial = await f.owner.cli('worker-a', args('not-supervisor'), branchA)
  expect(denial.stderr).toContain('current Supervisor or a person')
  expect((await f.owner.cli('supervisor', args('wrong-owner', 'unrelated-runtime'), branchA)).stderr).toContain('another Goal owner')
  expect((await f.owner.cli('supervisor', args('wrong-alignment', runtimeId, '2'), branchA)).stderr).toContain('current Goal proposal version')
  expect((await f.owner.cli('supervisor', args('unknown-predecessor'), { nodes: [{ ...next, dependsOn: ['unpublished'] }] })).stderr).toContain('not in this plan')
  expect((await f.owner.cli('supervisor', args('cannot-replace'), { nodes: [{ ...next, id: parent }] })).stderr).toContain('appears twice')
  expect((await f.read()).plan).toEqual(before.plan)
  const [a, b] = await Promise.all([
    f.owner.call('supervisor', args('append-a'), branchA),
    f.owner.call('supervisor', args('append-b'), branchB),
  ])
  const aSaved = a.plan.history.find((entry: { operationId: string }) => entry.operationId === 'append-a')
  const bSaved = b.plan.history.find((entry: { operationId: string }) => entry.operationId === 'append-b')
  const [first, second] = aSaved.createdTickets
  const [other] = bSaved.createdTickets
  expect(first.record).toMatchObject({ draftId: next.id, predecessors: [parent] })
  expect(second.record).toMatchObject({ draftId: later.id, predecessors: [first.hash] })
  expect(other.hash).not.toBe(first.hash)
  expect(a.ticketLinks.some((url: string) => url.endsWith('#T-' + second.hash))).toBe(true)
  const current = await f.read()
  expect(current.plan.revision).toBe(before.plan.revision + 2)
  expect(current.plan.nodes[0]).toEqual(before.plan.nodes[0])
  expect(current.plan.reviews).toEqual(before.plan.reviews)
  expect(current.delegations).toEqual(before.delegations)
  expect(current.planState.nodes.map(({ id, state }: { id: string; state: string }) => [id, state])).toEqual(expect.arrayContaining([
    [parent, 'done'], [first.hash, 'ready'], [second.hash, 'waiting'], [other.hash, 'ready'],
  ]))
  const latest = aSaved.revision > bSaved.revision ? { operationId: 'append-a', input: branchA } : { operationId: 'append-b', input: branchB }
  const replay = await f.owner.call('supervisor', args(latest.operationId), latest.input)
  expect(replay.plan).toEqual(current.plan)
  expect((await f.owner.cli('supervisor', args(latest.operationId), { nodes: [{ ...next, title: 'Different original input' }] })).stderr)
    .toContain('already recorded with different content')
  const revisePlan = DemandStore.prototype.revisePlan
  let entered!: () => void, release!: () => void
  const atSave = new Promise<void>(resolve => { entered = resolve })
  const resumeSave = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(DemandStore.prototype, 'revisePlan').mockImplementationOnce(async function (this: DemandStore, ...input) {
    entered()
    await resumeSave
    return revisePlan.apply(this, input)
  })
  const interrupted = f.owner.cli('supervisor', args('stale-supervisor'), branchA)
  try {
    await Promise.race([atSave, interrupted.then(result => { throw new Error(result.stderr || 'Append ended before saving') })])
    await f.owner.call(null, ['goal', 'update', '--goal', f.goalId, '--supervisor', 'worker-b'])
  } finally {
    release()
  }
  const refused = await interrupted
  spy.mockRestore()
  expect(refused.stderr).toContain('current Supervisor or a person')
  expect((await f.owner.call('worker-b', ['goal', 'plan', '--goal', f.goalId])).plan).toEqual(current.plan)
  expect(f.owner.native.stop).not.toHaveBeenCalled()
})

it('returns the original human confirmation and continuation instruction under the exact Goal', async () => {
  const f = await fixture()
  const confirmation = await f.owner.call(null, ['goal', 'confirm', '--goal', f.goalId, '--revision', '1', '--operation-id', 'human-confirm-and-continue',
    '--continue-with', '{"hostId":"local","agentSessionId":"supervisor"}'])
  const alignment = confirmation.goal.alignment
  expect(alignment).toMatchObject({ revision: 1, confirmedAt: expect.any(Number), confirmedBy: { kind: 'user', id: expect.any(String) } })
  expect((await f.owner.call(null, ['goal', 'inspect', '--goal', f.goalId])).goal.alignment).toEqual(alignment)
  const originalPlan = await f.read()
  expect(originalPlan.patrols).toHaveLength(1)
  expect(originalPlan.patrols[0]).toMatchObject({ purpose: 'confirmation', operationId: 'human-confirm-and-continue',
    requestedBy: alignment.confirmedBy, requestedAt: alignment.confirmedAt, alignment, executions: [] })
  const otherGoalId = (await f.owner.call(null, ['goal', 'create', '--title', 'Another Goal on the same Supervisor',
    '--supervisor', 'supervisor', '--assignees', '["supervisor"]', '--operation-id', 'create-other-goal', '--risk', 'low', '--confirm', 'user'])).goal.id
  expect((await f.owner.call(null, ['goal', 'plan', '--goal', otherGoalId])).patrols ?? []).toEqual([])
})

it('returns a human executor change and independent review with their original Ticket and attempt', async () => {
  const f = await fixture(), nodeId = f.node.id
  const assigned = await f.owner.call(null, ['goal', 'plan', 'assignment', '--input', '-'], {
    goalId: f.goalId, nodeId, expectedRevision: 1, operationId: 'human-assignment',
    assignment: { kind: 'assign', executor: { hostId: 'local', agentSessionId: 'worker-b' } },
  })
  const assignment = assigned.plan.history.at(-1)
  expect(assignment).toMatchObject({ operationId: 'human-assignment', revisedAt: expect.any(Number),
    author: { kind: 'user', id: expect.any(String) }, change: { nodeId, assignment: { kind: 'assign', executor: { agentSessionId: 'worker-b', hostId: 'local' } } } })
  expect(assigned.delegations).toEqual([])
  await f.owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: f.goalId, intent: {
    operationId: 'assigned-attempt', sourceMessageId: 'assigned-source', threadId: 'assigned-thread', hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker-b', workerRunId: 'run-worker-b',
    text: f.node.outcome, alignmentRevision: 1, criterionIds: ['original'], planNodeId: nodeId,
  } })
  const report = await f.owner.call('worker-b', ['goal', 'report', '--input', '-'], { goalId: f.goalId, operationId: 'assigned-attempt', report: {
    operationId: 'report-assigned', replyMessageId: 'reply-assigned', authorAgentSessionId: 'worker-b', grounding: { alignmentRevision: 1,
      summary: 'The new executor reported', checks: [{ criterionId: 'original', outcome: 'met', evidence: ['proof:assigned'], note: '' }] },
  } })
  await f.owner.call(null, ['goal', 'plan', 'review', '--input', '-'], { goalId: f.goalId, review: {
    operationId: 'human-review', nodeId, delegationOperationId: 'assigned-attempt', deliveryHash: report.delegations[0].report.delivery.hash,
    verdict: 'pass', note: '', check: { command: f.node.check, result: 'Passed', evidence: ['proof:assigned'] },
  } })
  const read = await f.read()
  expect(read.plan.history.find((entry: { operationId: string }) => entry.operationId === assignment.operationId)).toEqual(assignment)
  expect(read.plan.reviews).toMatchObject([{ operationId: 'human-review', nodeId, delegationOperationId: 'assigned-attempt',
    reviewedAt: expect.any(Number), reviewer: assignment.author, completion: { record: { kind: 'completed', ticketId: nodeId, attemptId: 'assigned-attempt' } } }])
  expect(read.planState.nodes[0].state).toBe('done')
  expect(f.owner.native.stop).not.toHaveBeenCalled()
})
