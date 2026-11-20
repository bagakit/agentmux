import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('saves one authorized claimant through the public CLI, reunites its original operation after restart and sends no work', async () => {
  const owner = await crossHostOwner(cleanup, 'node-claims', ['supervisor', 'worker-a', 'worker-b', 'reader'])
  const goalId = (await owner.call('supervisor', ['goal', 'create', '--title', 'Claim work', '--status', 'in_progress',
    '--related', JSON.stringify(['supervisor', 'worker-a', 'worker-b', 'reader']), '--assignees', JSON.stringify(['supervisor', 'worker-a', 'worker-b']), '--supervisor', 'supervisor',
    '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-goal'])).goal.id
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Prove a claim', criteria: [{ id: 'working', text: 'One executor owns the result' }], openQuestions: []
  })])
  const node = { id: 'prepare', title: 'Prepare', outcome: 'One checked result', dependsOn: [], criterionIds: ['working'], check: 'check', executor: null }
  const published = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'initial-plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [node, { ...node, id: 'dependent', dependsOn: [node.id] }, { ...node, id: 'other' }] } })
  const [nodeId, dependentId, otherId] = published.plan.nodes.map((node: { id: string }) => node.id)
  const write = ['goal', 'plan', 'assignment', '--input', '-']
  const open = { goalId, nodeId, operationId: 'open-node', expectedRevision: 1, assignment: { kind: 'open' } }
  const claim = (op: string, token: string, target = nodeId) =>
    ['goal', 'plan', 'claim', '--goal', goalId, '--node', target, '--claim-token', token, '--operation-id', op]
  expect((await owner.cli('worker-a', claim('closed', 'expired'))).code).toBe(1)
  expect((await owner.cli('supervisor', write, { ...open, nodeId: dependentId })).code).toBe(1)
  expect((await owner.cli('worker-a', write, open)).code).toBe(1)
  const collision = await owner.cli(null, write, { ...open, expectedOwner: { runtimeId: owner.identity.runtimeId, namespace: 'another-store' } })
  expect(collision.stderr).toContain('another Goal owner')
  const opened = await owner.call(null, write, open)
  expect(opened.plan.nodes[0]).toMatchObject({ claimOpen: true, executor: null })
  const initialToken = opened.planState.nodes[0].claimToken
  expect(initialToken).toBeTruthy()
  const revise = (operationId: string, expectedRevision: number, check: string) => owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], {
    goalId, revision: { operationId, expectedRevision, alignmentRevision: 1, nodes: [{ ...opened.plan.nodes[0], check }, ...opened.plan.nodes.slice(1)] },
  })
  await revise('edit-check', 2, 'updated check')
  await revise('restore-check', 3, node.check)
  const token = (await owner.call(null, ['goal', 'plan', '--goal', goalId])).planState.nodes[0].claimToken
  expect(token, 'a reversed check revision does not revive the original claim').not.toBe(initialToken)
  expect((await owner.cli('worker-a', claim('old-token', initialToken))).stderr).toContain('current claim token')
  const otherGoalId = (await owner.call('supervisor', ['goal', 'create', '--title', 'Separate goal', '--status', 'in_progress',
    '--assignees', JSON.stringify(['supervisor', 'worker-a']), '--supervisor', 'supervisor',
    '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-other-goal'])).goal.id
  await owner.call(null, ['goal', 'update', '--goal', otherGoalId, '--alignment', JSON.stringify({
    summary: 'Prove a claim', criteria: [{ id: 'working', text: 'One executor owns the result' }], openQuestions: []
  })])
  const otherPlan = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: otherGoalId, revision: {
    operationId: 'initial-plan', expectedRevision: 0, alignmentRevision: 1, nodes: [node],
  } })
  const otherGoalNode = otherPlan.plan.nodes[0]
  await owner.call(null, write, { ...open, goalId: otherGoalId, nodeId: otherGoalNode.id })
  await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: otherGoalId, revision: {
    operationId: 'edit-check', expectedRevision: 2, alignmentRevision: 1, nodes: [{ ...otherGoalNode, check: 'updated check', claimOpen: true }],
  } })
  await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId: otherGoalId, revision: {
    operationId: 'restore-check', expectedRevision: 3, alignmentRevision: 1, nodes: [{ ...otherGoalNode, claimOpen: true }],
  } })
  const crossGoal = await owner.cli('worker-a', claim('wrong-goal', token, otherGoalNode.id).map(arg => arg === goalId ? otherGoalId : arg))
  expect(crossGoal.stderr, 'a claim cannot use another Goal’s token').toContain('current claim token')
  expect((await owner.cli(null, claim('user-cannot-claim', token))).code).toBe(1)
  const outsider = await owner.cli('reader', claim('reader-claim', token))
  expect(outsider.stderr, 'a related reader cannot claim an open node').toContain('no work role')
  const contenders = ['worker-a', 'worker-b']
  const outcomes = await Promise.all(contenders.map(who => owner.cli(who, claim('claim-' + who, token))))
  expect(outcomes.map(result => result.code).sort(), 'exactly one claim must be confirmed').toEqual([0, 1])
  const winner = contenders[outcomes.findIndex(result => result.code === 0)]!
  let plan = (await owner.call(null, ['goal', 'plan', '--goal', goalId])).plan
  expect(plan.nodes[0], 'the claim must bind the authenticated executor').toMatchObject({ executor: { hostId: 'local', agentSessionId: winner } })
  expect(plan.nodes[0]).not.toHaveProperty('claimOpen')
  expect(plan.history[4]).toMatchObject({ operationId: 'claim-' + winner, revision: 5, author: { kind: 'agent', id: winner, hostId: 'local', runtimeId: owner.identity.runtimeId },
    change: { nodeId, assignment: { kind: 'claim' } } })
  const assigned = await owner.call('supervisor', write, { ...open, nodeId: otherId, expectedRevision: 5, operationId: 'assign-other',
    assignment: { kind: 'assign', executor: { hostId: 'local', agentSessionId: 'worker-b' } } })
  expect(assigned.plan.nodes[2].executor.agentSessionId).toBe('worker-b')
  await owner.stop(); await owner.start()
  const replay = await owner.call(winner, claim('claim-' + winner, token))
  expect(replay.plan.revision).toBe(6)
  expect(replay.plan.history).toHaveLength(6)
  expect(replay.delegations).toEqual([])
  expect((await owner.cli(winner, claim('claim-' + winner, 'different-token'))).code).toBe(1)
  expect((await owner.cli(winner, claim('claim-' + winner, token, otherId))).code).toBe(1)
  expect((await owner.cli(contenders.find(who => who !== winner)!, claim('claim-' + winner, token))).code).toBe(1)
  plan = (await owner.call(null, ['goal', 'plan', '--goal', goalId])).plan
  expect(plan.history).toEqual(replay.plan.history)
})

it('claims independent successors from one read and delivers the exact prerequisite through the public CLI', async () => {
  const owner = await crossHostOwner(cleanup, 'node-lineage', ['supervisor', 'worker-a', 'worker-b'])
  const goalId = (await owner.call('supervisor', ['goal', 'create', '--title', 'Verify a file deliverable', '--status', 'in_progress',
    '--assignees', JSON.stringify(['supervisor', 'worker-a', 'worker-b']), '--supervisor', 'supervisor',
    '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-file-work'])).goal.id
  const criterion = { id: 'file', text: 'The original file is independently checked' }
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Deliver the file and follow-on notes', criteria: [criterion], openQuestions: [],
  })])
  const nodes = ['original', 'notes-a', 'notes-b'].map((id, index) => ({ id, title: id, outcome: 'Deliver ' + id, check: 'cat artifact.txt',
    criterionIds: [criterion.id], dependsOn: index ? ['original'] : [], executor: index ? null : { hostId: 'local', agentSessionId: 'worker-a' } }))
  const planned = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'file-plan', expectedRevision: 0, alignmentRevision: 1, nodes,
  } })
  const issued: Record<string, string> = Object.fromEntries(nodes.map((node, index) => [node.id, planned.plan.nodes[index].id]))
  const ticketId = (draft: string) => issued[draft]!
  const delegation = (nodeId: string, worker: string) => ({
    goalId, intent: { operationId: 'dispatch-' + nodeId, sourceMessageId: 'source-' + nodeId, threadId: 'thread-' + nodeId,
      hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: worker, workerRunId: 'run-' + worker,
      text: 'Deliver ' + nodeId, alignmentRevision: 1, criterionIds: [criterion.id], planNodeId: ticketId(nodeId) },
  })
  const delegate = (nodeId: string, worker: string) => owner.call('supervisor', ['goal', 'delegate', '--input', '-'], delegation(nodeId, worker))
  const report = (nodeId: string, worker: string, evidence: string) => owner.call(worker, ['goal', 'report', '--input', '-'], {
    goalId, operationId: 'dispatch-' + nodeId, report: { operationId: 'report-' + nodeId, replyMessageId: 'reply-' + nodeId, authorAgentSessionId: worker,
      grounding: { alignmentRevision: 1, summary: 'Delivered original ' + nodeId, checks: [{ criterionId: criterion.id, outcome: 'met', note: '', evidence: [evidence] }] } },
  })
  await delegate('original', 'worker-a')
  const path = join(owner.original.root, 'artifact.txt')
  await writeFile(path, 'file deliverable\n')
  const originalReport = await report('original', 'worker-a', 'artifact.txt:1')
  const delivery = originalReport.delegations[0].report.delivery
  expect(delivery).toMatchObject({ schema: 'agentmux.ticket-delivery.v2', hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    authorRuntimeId: owner.identity.runtimeId })
  const planSource = await owner.call(null, ['goal', 'plan', '--goal', goalId])
  const originalHash = createHash('sha256').update(JSON.stringify([delivery.schema, owner.identity.runtimeId, planSource.address.namespace,
    goalId, ticketId('original'), 'dispatch-original', owner.identity.runtimeId, 'worker-a', [], 'report-original', 'reply-original',
    originalReport.delegations[0].report.grounding])).digest('hex')
  expect(delivery.hash, 'the delivery hash binds the original author and report contents').toBe(originalHash)
  const original = await readFile(path, 'utf8')
  expect(original).toBe('file deliverable\n')
  const review = { operationId: 'review-original', nodeId: ticketId('original'), delegationOperationId: 'dispatch-original',
    deliveryHash: delivery.hash, verdict: 'pass', note: '', check: { command: 'read artifact.txt', result: original, evidence: ['artifact.txt:1'] } }
  const forged = await owner.cli(null, ['goal', 'plan', 'review', '--input', '-'], {
    goalId, review: { ...review, deliveryHash: delivery.hash.replace(/^./u, (value: string) => value === 'a' ? 'b' : 'a') },
  })
  expect(forged.stderr, 'an independent review must bind the exact delivery hash').toContain('must name the exact original Ticket delivery hash')
  const reviewed = await owner.call(null, ['goal', 'plan', 'review', '--input', '-'], { goalId, review })
  for (const [index, nodeId] of ['notes-a', 'notes-b'].entries()) {
    await owner.call(null, ['goal', 'plan', 'assignment', '--input', '-'], {
      goalId, nodeId: ticketId(nodeId), operationId: 'open-' + nodeId, expectedRevision: 1 + index, assignment: { kind: 'open' },
    })
  }
  const observed = await owner.call(null, ['goal', 'plan', '--goal', goalId])
  const claim = (nodeId: string, token: string) => ['goal', 'plan', 'claim', '--goal', goalId, '--node', ticketId(nodeId), '--claim-token', token, '--operation-id', 'claim-' + nodeId]
  const assignments = ['notes-a', 'notes-b'].map((nodeId, index) => {
    const token = observed.planState.nodes.find((node: { id: string }) => node.id === ticketId(nodeId)).claimToken
    expect(token).toBeTruthy()
    return { nodeId, worker: index ? 'worker-b' : 'worker-a', token }
  })
  const results = await Promise.all(assignments.map(({ nodeId, worker, token }) => owner.cli(worker, claim(nodeId, token))))
  expect(results.map(result => result.code), 'independent claims must succeed from the same read').toEqual([0, 0])
  const predecessor = { nodeId: ticketId('original'), delegationOperationId: 'dispatch-original', reportOperationId: 'report-original', reviewOperationId: 'review-original', deliveryHash: delivery.hash, completionHash: reviewed.plan.reviews[0].completion.hash }
  await owner.stop(); await owner.start()
  const replay = await owner.call('worker-b', claim('notes-b', assignments[1]!.token))
  expect(replay.delegations[0].report.delivery).toEqual(delivery)
  expect((await report('original', 'worker-a', 'artifact.txt:1')).delegations[0].report.delivery).toEqual(delivery)
  expect(replay.plan.history.find((entry: { operationId: string }) => entry.operationId === 'claim-notes-b')?.claim.predecessors).toEqual([predecessor])
  await delegate('notes-b', 'worker-b')
  const received = await owner.call('worker-b', ['message', 'read', '--host', 'local', '--message-id', 'source-notes-b'])
  expect(received.message.envelope.application.data.predecessors, 'the worker must receive its frozen predecessor').toEqual([predecessor])
  await writeFile(join(owner.original.root, 'notes.txt'), original)
  const delivered = await report('notes-b', 'worker-b', 'notes.txt:1')
  expect(delivered.delegations.find((attempt: { operationId: string }) => attempt.operationId === 'dispatch-notes-b'))
    .toMatchObject({ claimOperationId: 'claim-notes-b', predecessors: [predecessor], report: { operationId: 'report-notes-b' } })
  const appended = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'adopt-worker-proposal', expectedRevision: replay.plan.revision, alignmentRevision: 1,
    nodes: [...replay.plan.nodes, { ...nodes[0], id: 'follow-up', executor: null }],
    proposals: [{ nodeId: 'follow-up', delegationOperationId: 'dispatch-original', replyMessageId: 'reply-original' }],
  } })
  expect(appended.plan.history.at(-1)).toMatchObject({ operationId: 'adopt-worker-proposal', author: { id: 'supervisor', runtimeId: owner.identity.runtimeId },
    createdTickets: [{ hash: appended.plan.nodes.at(-1).id, record: { draftId: 'follow-up' } }], proposals: [{ nodeId: appended.plan.nodes.at(-1).id, author: { agentSessionId: 'worker-a', runtimeId: owner.identity.runtimeId },
      sourceMessageId: 'source-original', proposalOperationId: 'report-original' }] })
  const prepared = delegation('notes-a', 'worker-a')
  await owner.call('supervisor', ['goal', 'delegation', 'prepare', '--input', '-'], prepared)
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Deliver the file and notes', criteria: [{ ...criterion, text: 'Check the file against the revised requirements' }], openQuestions: [],
  })])
  const stale = await owner.cli('supervisor', ['goal', 'delegate', '--input', '-'], prepared)
  expect(stale.stderr, 'a prepared attempt requires current predecessor receipts at first dispatch')
    .toContain('no longer has current task requirements or passing predecessor receipts')
  const absent = await owner.call('worker-a', ['message', 'read', '--host', 'local', '--message-id', 'source-notes-a'])
  expect(absent.message).toBeNull()
})
