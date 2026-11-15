import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const owner = await crossHostOwner(cleanup, 'plan-revision-owner', ['supervisor', 'worker-a', 'worker-b', 'reviewer'])
  const goalId = 'original-revision-goal'
  await owner.call('supervisor', ['goal', 'create', '--goal', goalId, '--title', 'Keep original plan work', '--status', 'in_progress', '--session', 'supervisor',
    '--assignees', JSON.stringify(['supervisor', 'worker-a', 'worker-b', 'reviewer']), '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-original'])
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
