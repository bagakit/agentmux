import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('saves one authorized claimant through the public CLI, reunites its original operation after restart and sends no work', async () => {
  const owner = await crossHostOwner(cleanup, 'node-claims', ['supervisor', 'worker-a', 'worker-b', 'reader'])
  const goalId = 'node-claim-goal', nodeId = 'prepare'
  await owner.call('supervisor', ['goal', 'create', '--goal', goalId, '--title', 'Claim work', '--status', 'in_progress',
    '--related', JSON.stringify(['supervisor', 'worker-a', 'worker-b', 'reader']), '--assignees', JSON.stringify(['supervisor', 'worker-a', 'worker-b']), '--supervisor', 'supervisor',
    '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-goal'])
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Prove a claim', criteria: [{ id: 'working', text: 'One executor owns the result' }], openQuestions: []
  })])
  const node = { id: nodeId, title: 'Prepare', outcome: 'One checked result', dependsOn: [], criterionIds: ['working'], check: 'check', executor: null }
  await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'initial-plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [node, { ...node, id: 'dependent', dependsOn: [nodeId] }, { ...node, id: 'other' }] } })
  const write = ['goal', 'plan', 'assignment', '--input', '-']
  const open = { goalId, nodeId, operationId: 'open-node', expectedRevision: 1, assignment: { kind: 'open' } }
  const claim = (op: string, version: number, target = nodeId) =>
    ['goal', 'plan', 'claim', '--goal', goalId, '--node', target, '--revision', String(version), '--operation-id', op]
  expect((await owner.cli('worker-a', claim('closed', 1))).code).toBe(1)
  expect((await owner.cli('supervisor', write, { ...open, nodeId: 'dependent' })).code).toBe(1)
  expect((await owner.cli('worker-a', write, open)).code).toBe(1)
  const collision = await owner.cli(null, write, { ...open, expectedOwner: { runtimeId: owner.identity.runtimeId, namespace: 'another-store' } })
  expect(collision.stderr).toContain('another Goal owner')
  const opened = await owner.call(null, write, open)
  expect(opened.plan.nodes[0]).toMatchObject({ claimOpen: true, executor: null })
  expect((await owner.cli(null, claim('user-cannot-claim', 2))).code).toBe(1)
  const outsider = await owner.cli('reader', claim('reader-claim', 2))
  expect(outsider.stderr, 'a related reader cannot claim an open node').toContain('no work role')
  const contenders = ['worker-a', 'worker-b']
  const outcomes = await Promise.all(contenders.map(who => owner.cli(who, claim('claim-' + who, 2))))
  expect(outcomes.map(result => result.code).sort(), 'exactly one claim must be confirmed').toEqual([0, 1])
  const winner = contenders[outcomes.findIndex(result => result.code === 0)]!
  let plan = (await owner.call(null, ['goal', 'plan', '--goal', goalId])).plan
  expect(plan.nodes[0], 'the claim must bind the authenticated executor').toMatchObject({ executor: { hostId: 'local', agentSessionId: winner } })
  expect(plan.nodes[0]).not.toHaveProperty('claimOpen')
  expect(plan.history[2]).toMatchObject({ operationId: 'claim-' + winner, revision: 3, author: { kind: 'agent', id: winner, hostId: 'local', runtimeId: owner.identity.runtimeId },
    change: { nodeId, assignment: { kind: 'claim' } } })
  const assigned = await owner.call('supervisor', write, { ...open, nodeId: 'other', expectedRevision: 3, operationId: 'assign-other',
    assignment: { kind: 'assign', executor: { hostId: 'local', agentSessionId: 'worker-b' } } })
  expect(assigned.plan.nodes[2].executor.agentSessionId).toBe('worker-b')
  await owner.stop(); await owner.start()
  const replay = await owner.call(winner, claim('claim-' + winner, 2))
  expect(replay.plan.revision).toBe(4)
  expect(replay.plan.history).toHaveLength(4)
  expect(replay.delegations).toEqual([])
  expect((await owner.cli(winner, claim('claim-' + winner, 3))).code).toBe(1)
  expect((await owner.cli(winner, claim('claim-' + winner, 2, 'other'))).code).toBe(1)
  expect((await owner.cli(contenders.find(who => who !== winner)!, claim('claim-' + winner, 2))).code).toBe(1)
  plan = (await owner.call(null, ['goal', 'plan', '--goal', goalId])).plan
  expect(plan.history).toEqual(replay.plan.history)
})
