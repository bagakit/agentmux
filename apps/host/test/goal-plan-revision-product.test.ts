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

const resultEvidence = (attempt: string) => ['checks/' + attempt + '.log']
async function deliverPlanResult(owner: Awaited<ReturnType<typeof fixture>>['owner'], goalId: string,
  target: Awaited<ReturnType<typeof fixture>>['node'], attempt: string, alignmentRevision: number, outcome: 'gap' | 'met', verdict: 'pass' | 'changes') {
  await owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: {
    operationId: attempt, sourceMessageId: attempt + '-source', threadId: attempt + '-thread', hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker-a', workerRunId: 'run-worker-a',
    text: target.outcome, alignmentRevision, criterionIds: target.criterionIds, planNodeId: target.id,
  } })
  const replyMessageId = attempt + '-reply'
  const reported = await owner.call('worker-a', ['goal', 'report', '--input', '-'], { goalId, operationId: attempt, report: {
    operationId: attempt + '-report', replyMessageId, authorAgentSessionId: 'worker-a',
    grounding: { alignmentRevision, summary: attempt, checks: target.criterionIds.map(criterionId =>
      ({ criterionId, outcome, evidence: resultEvidence(attempt), note: outcome === 'gap' ? attempt + ' found a remaining problem' : '' })) },
  } })
  const deliveryHash = reported.delegations.find((value: { operationId: string }) => value.operationId === attempt).report.delivery.hash
  await owner.call('supervisor', ['goal', 'collect', '--input', '-'], { goalId, operationId: attempt,
    collection: { operationId: attempt + '-collection', replyMessageId } })
  return owner.call('reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: {
    operationId: attempt + '-review', nodeId: target.id, delegationOperationId: attempt, deliveryHash, verdict,
    check: { command: target.check, result: 'Reviewed this delivery', evidence: resultEvidence(attempt) },
    note: verdict === 'changes' ? 'Resolve the reported gap' : '',
  } })
}

it('reads current result evidence from reviewed Ticket attempts through the Goal CLI and Host', async () => {
  const { owner, goalId, node, read } = await fixture()
  const inspect = () => owner.call(null, ['goal', 'inspect', '--goal', goalId])
  const evidence = resultEvidence
  const deliver = deliverPlanResult.bind(undefined, owner, goalId)
  const originalGap = await deliver(node, 'first-gap', 1, 'gap', 'changes')
  expect(originalGap.grounding.checks[0]).toMatchObject({ outcome: 'gap', evidence: evidence('first-gap') })
  const responsibility = async () => (await owner.call(null, ['goal', 'delegations', '--goal', goalId])).responsibility.executions
  expect(await responsibility()).toMatchObject([{ execution: { operationId: 'first-gap' }, phase: 'rework', alert: null }])
  const reworked = await deliver(node, 'current-rework', 1, 'met', 'pass')
  expect(reworked.grounding.checks[0]).toMatchObject({ outcome: 'met', evidence: evidence('current-rework') })
  expect(await responsibility()).toMatchObject([
    { execution: { operationId: 'first-gap' }, phase: 'closed', alert: null },
    { execution: { operationId: 'current-rework' }, phase: 'closed', alert: null },
  ])

  const reviseAlignment = (text: string, summary: string) => owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment',
    JSON.stringify({ summary, criteria: [{ id: 'original', text }], openQuestions: [] })])
  await reviseAlignment('The original criterion remains independently checkable.', 'Expanded explanation of the same criterion')
  await owner.call('supervisor', ['goal', 'confirm', '--goal', goalId, '--revision', '2'])
  const stable = await read()
  expect(stable.grounding).toMatchObject({ alignmentRevision: 2, acceptedAt: null, checks: [{ outcome: 'met', evidence: evidence('current-rework') }] })
  expect((await inspect()).goal.grounding).toEqual(stable.grounding)

  const append = async (operationId: string, additions: (typeof node)[]) => {
    const result = await owner.call('supervisor', ['goal', 'plan', 'append', '--goal', goalId, '--alignment-revision', '2',
      '--operation-id', operationId, '--runtime', stable.address.runtimeId, '--namespace', stable.address.namespace, '--input', '-'], { nodes: additions })
    return result.plan.nodes.slice(-additions.length) as (typeof node)[]
  }
  const accept = (submissionId: string, ...flags: string[]) => ['goal', 'accept', '--goal', goalId, '--revision', '2', '--submission', submissionId, ...flags]
  const [audit] = await append('append-audit', [{ ...node, id: 'audit', title: 'Audit original result' }])
  const open = await read()
  expect(open.grounding.checks[0].outcome).toBe('unknown')
  expect((await owner.cli(null, accept(stable.grounding.submissionId))).stderr).toContain('results changed')
  const audited = await deliver(audit!, 'signed-audit-gap', 2, 'gap', 'pass')
  expect(audited.grounding.checks[0].outcome).toBe('gap')
  const [independent, repair] = await append('append-resolution', [
    { ...node, id: 'independent', title: 'Independent branch' },
    { ...node, id: 'repair', title: 'Repair audited gap', dependsOn: [audit!.id] },
  ])
  await deliver(independent!, 'independent-gap', 2, 'gap', 'pass')
  const current = await deliver(repair!, 'audit-repair', 2, 'met', 'pass')
  expect(current.grounding.checks[0]).toMatchObject({ outcome: 'gap',
    evidence: [...evidence('current-rework'), ...evidence('independent-gap'), ...evidence('audit-repair')] })
  expect(current.grounding.checks[0].note).toContain('independent-gap-reply')
  expect(current.grounding.checks[0].note).not.toContain('signed-audit-gap-reply')
  expect(current.delegations.filter((attempt: { report?: unknown }) => attempt.report).map(({ operationId }: { operationId: string }) => operationId))
    .toEqual(['first-gap', 'current-rework', 'signed-audit-gap', 'independent-gap', 'audit-repair'])
  expect(current.plan.reviews).toHaveLength(5)
  expect((await inspect()).goal.grounding).toEqual(current.grounding)
  expect((await owner.rpc.call('goal.ls', { goalId })).goals[0]?.grounding).toEqual(current.grounding)
  expect((await owner.cli(null, accept(current.grounding.submissionId))).stderr).toContain('remaining gaps')
  const accepted = await owner.call(null, accept(current.grounding.submissionId, '--accept-gaps'))
  expect(accepted.receipt).toMatchObject({ submissionId: current.grounding.submissionId, acceptedWithGaps: true })
  await append('append-after-acceptance', [{ ...node, id: 'after-acceptance', title: 'Follow-up' }])
  expect((await read()).grounding).toEqual(accepted.goal.grounding)

  await reviseAlignment('The current criterion changed.', 'Different success criterion')
  expect((await read()).grounding.checks[0]).toMatchObject({ outcome: 'unknown', evidence: [] })
})

it('retains an unaccepted Done result without a Goal plan', async () => {
  const { owner } = await fixture()
  const { goal } = await owner.call(null, ['goal', 'create', '--title', 'Original historical Goal', '--status', 'done',
    '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-unplanned'])
  const criterion = { id: 'original', text: 'Check the original result' }
  await owner.call(null, ['goal', 'update', '--goal', goal.id, '--alignment', JSON.stringify({ summary: 'Historical execution', criteria: [criterion], openQuestions: [] })])
  const proposal = { alignmentRevision: 1, summary: 'Original result report', checks: [{ criterionId: criterion.id,
    outcome: 'met', evidence: ['checks/historical.log'], note: 'Historical artifact passed' }] }
  const updated = await owner.call(null, ['goal', 'update', '--goal', goal.id, '--grounding', JSON.stringify(proposal)])
  const inspected = await owner.call(null, ['goal', 'inspect', '--goal', goal.id])
  expect(inspected.goal).toMatchObject({ status: 'done', grounding: { ...proposal, acceptedAt: null } })
  expect(inspected.goal.plan).toBeUndefined()
  expect((await owner.call(null, ['goal', 'plan', '--goal', goal.id])).grounding).toEqual(updated.goal.grounding)
})

it('keeps independent Goal and PMO results in the exact current submission through the CLI', async () => {
  const { owner, goalId, node, read } = await fixture()
  await owner.call('supervisor', ['goal', 'confirm', '--goal', goalId, '--revision', '1'])
  const reviewed = await deliverPlanResult(owner, goalId, node, 'verified-ticket', 1, 'met', 'pass')
  const accept = (id: string, ...flags: string[]) => ['goal', 'accept', '--goal', goalId, '--revision', '1', '--submission', id, ...flags]
  const update = (grounding: unknown) => owner.call(null, ['goal', 'update', '--goal', goalId, '--grounding', JSON.stringify(grounding)])
  const goalReport = (label: string, outcome: 'met' | 'gap', evidence = resultEvidence(label)) => ({
    alignmentRevision: 1, summary: label, checks: [{ criterionId: 'original', outcome, evidence, note: outcome === 'gap' ? label + ' remains open' : '' }],
  })
  const before = reviewed.grounding
  const direct = (await update(goalReport('independent-direct', 'gap'))).goal.grounding
  expect(direct.checks).toMatchObject([{ outcome: 'gap', evidence: [...resultEvidence('verified-ticket'), ...resultEvidence('independent-direct')] }])
  expect((await owner.rpc.call('goal.ls', { goalId })).goals[0]?.grounding).toEqual(direct)
  expect((await owner.cli(null, accept(before.submissionId))).stderr).toContain('results changed')
  expect((await owner.cli(null, accept(direct.submissionId))).stderr).toContain('remaining gaps')
  const unsupported = (await update(goalReport('unsupported-gap', 'gap', []))).goal.grounding
  expect(unsupported.checks[0].outcome).toBe('unknown')
  expect((await owner.cli(null, accept(unsupported.submissionId, '--accept-gaps'))).stderr).toContain('unknown')
  const current = (await update(goalReport('independent-direct', 'gap'))).goal.grounding

  const operationId = 'original-unreported-execution'
  await owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: {
    operationId, sourceMessageId: operationId + '-source', threadId: operationId + '-thread', hostId: 'local',
    ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker-b', workerRunId: 'run-worker-b',
    text: 'Check the independent original Goal result', alignmentRevision: 1, criterionIds: ['original'],
  } })
  const execution = { kind: 'delegation', operationId, hostId: 'local', agentSessionId: 'worker-b', runId: 'run-worker-b' }
  const work = () => owner.call('supervisor', ['goal', 'delegations', '--goal', goalId])
  const scope = (await work()).responsibility.scope
  expect(JSON.parse(scope).grounding).toBe(current.submissionId)
  const reviewProgress = { operationId: 'manager-current-result', expectedScope: scope, execution, phase: 'review',
    summary: 'Manager checked this exact Goal result', evidence: resultEvidence('independent-direct'), nextAction: 'Review the exact evidence' }
  const progressArgs = ['goal', 'progress', '--input', '-']
  const staleProgress = await owner.cli('supervisor', progressArgs, { goalId, progress: { ...reviewProgress, groundingSubmissionId: before.submissionId } })
  expect(staleProgress.stderr).toContain('current result explicitly associated')
  await owner.call('supervisor', progressArgs, { goalId, progress: { ...reviewProgress, groundingSubmissionId: current.submissionId } })

  const patrolId = 'original-current-inspection'
  const requested = await owner.call(null, ['goal', 'patrol', '--goal', goalId, '--operation-id', patrolId])
  const patrol = requested.patrols.find((item: { operationId: string }) => item.operationId === patrolId)
  const frozen = JSON.parse(patrol.context)
  expect(frozen.groundingSubmissionId).toBe(current.submissionId)
  expect(JSON.parse(patrol.expectedScope).grounding).toBe(current.submissionId)
  const pmoReport = goalReport('independent-pmo', 'gap')
  const finished = await owner.call('supervisor', ['goal', 'patrol', 'report', '--input', '-'], { goalId, patrolOperationId: patrolId, report: {
    operationId: 'original-inspection-report', summary: 'Actual PMO inspection', grounding: pmoReport,
    progress: [{ ...reviewProgress, operationId: 'pmo-result-association', expectedScope: patrol.expectedScope, evidence: resultEvidence('independent-pmo') }],
    nextOwner: { kind: 'human', agentSessionId: null, action: 'Read the original independent inspection' },
  } })
  const pmo = finished.grounding
  expect(pmo.checks).toMatchObject([{ outcome: 'gap', evidence: [...resultEvidence('verified-ticket'), ...resultEvidence('independent-pmo')] }])
  expect(finished.progressUpdates.find((item: { operationId: string }) => item.operationId === 'pmo-result-association'))
    .toMatchObject({ managerVerified: true, groundingSubmissionId: pmo.submissionId })
  expect(finished.patrols.find((item: { operationId: string }) => item.operationId === patrolId))
    .toMatchObject({ context: patrol.context, expectedScope: patrol.expectedScope, report: { applied: true, grounding: pmoReport } })
  expect((await read()).grounding).toEqual(pmo)
  const inspected = await owner.call(null, ['goal', 'inspect', '--goal', goalId])
  expect(inspected.goal.grounding).toEqual(pmo)
  expect((await owner.cli(null, accept(pmo.submissionId))).stderr).toContain('remaining gaps')
  const accepted = await owner.call(null, accept(pmo.submissionId, '--accept-gaps'))
  expect(accepted.receipt).toMatchObject({ submissionId: pmo.submissionId, acceptedWithGaps: true })
  expect((await update(pmoReport)).goal.grounding).toEqual(accepted.goal.grounding)

  await owner.call('supervisor', ['goal', 'plan', 'append', '--goal', goalId, '--alignment-revision', '1', '--operation-id', 'append-unverified',
    '--runtime', reviewed.address.runtimeId, '--namespace', reviewed.address.namespace, '--input', '-'], {
    nodes: [{ ...node, id: 'unverified', title: 'Independent work still needs review' }],
  })
  expect((await read()).grounding).toEqual(accepted.goal.grounding)
  const pending = (await update(goalReport('positive-goal-report', 'met'))).goal.grounding
  expect(pending.checks[0]).toMatchObject({ outcome: 'unknown', evidence: expect.arrayContaining(resultEvidence('positive-goal-report')) })
  expect((await owner.cli(null, accept(pending.submissionId, '--accept-gaps'))).stderr).toContain('unknown')

  const lateId = 'inspection-before-plan-change'
  const lateRequest = await owner.call(null, ['goal', 'patrol', '--goal', goalId, '--operation-id', lateId])
  const late = lateRequest.patrols.find((item: { operationId: string }) => item.operationId === lateId)
  const newer = await owner.call('supervisor', ['goal', 'plan', 'append', '--goal', goalId, '--alignment-revision', '1', '--operation-id', 'append-during-inspection',
    '--runtime', reviewed.address.runtimeId, '--namespace', reviewed.address.namespace, '--input', '-'], {
    nodes: [{ ...node, id: 'added-during-inspection', title: 'Added during original inspection' }],
  })
  expect(newer.grounding.submissionId).not.toBe(pending.submissionId)
  const lateResult = await owner.call('supervisor', ['goal', 'patrol', 'report', '--input', '-'], { goalId, patrolOperationId: lateId, report: {
    operationId: 'late-inspection-report', summary: 'The original inspection finished after a plan change',
    grounding: goalReport('late-pmo', 'met'), progress: [],
    nextOwner: { kind: 'human', agentSessionId: null, action: 'Read the retained original inspection' },
  } })
  expect(lateResult.grounding).toEqual(newer.grounding)
  expect(lateResult.patrols.find((item: { operationId: string }) => item.operationId === lateId))
    .toMatchObject({ context: late.context, expectedScope: late.expectedScope, report: { applied: false, grounding: goalReport('late-pmo', 'met') } })
})
