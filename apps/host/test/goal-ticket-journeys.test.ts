import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyGoalTicketProof } from '@agentmux/demand/goal-ticket-crypto'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const run = promisify(execFile)
const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('signs original Tickets, claims and completions through the public CLI', async () => {
  const owner = await crossHostOwner(cleanup, 'git-ticket', ['supervisor', 'worker', 'reviewer'])
  const created = await owner.call('supervisor', ['goal', 'create', '--title', 'Deliver a checked repository result', '--status', 'in_progress',
    '--assignees', JSON.stringify(['supervisor', 'worker']), '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  const goalId = created.goal.id
  const criterion = { id: 'checked', text: 'The landed commit has the authored work and passes its declared check' }
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Validate a landed change', criteria: [criterion], openQuestions: [],
  })])
  await owner.call(null, ['goal', 'confirm', '--goal', goalId, '--revision', '1'])
  const check = 'Read the original landed commit and its Goal-Node trailer'
  const revision = { goalId, revision: {
    operationId: 'define-git-tickets', expectedRevision: 0, alignmentRevision: 1,
    nodes: [
      { id: 'follow-up', title: 'Consume the result', outcome: 'Review the established artifact', executor: null, criterionIds: [criterion.id], dependsOn: ['code'], check },
      { id: 'code', title: 'Land the change', outcome: 'A verified commit on main', executor: null, criterionIds: [criterion.id], dependsOn: [], check },
    ],
  } }
  const revise = ['goal', 'plan', 'revise', '--input', '-']
  const published = await owner.call('supervisor', revise, revision)
  const [successor, initial] = published.plan.nodes
  const nodeId = initial.id, childId = successor.id
  const [issue, childIssue] = published.plan.history[0].createdTickets
  expect(initial.id).toBe(issue.hash)
  expect(successor.dependsOn).toEqual([nodeId])
  expect(childIssue).toMatchObject({ hash: childId, record: { kind: 'issued', predecessors: [nodeId], actor: { id: 'supervisor', runtimeId: owner.identity.runtimeId } } })
  expect(published.planState.nodes[0].state).toBe('waiting')
  expect((await owner.call('supervisor', revise, revision)).plan.history[0].createdTickets).toEqual([issue, childIssue])
  const { fingerprint } = await owner.client().agentCreationAuthority()
  const verify = (proof: any, hash = proof.hash, expectedKey = fingerprint) => owner.cli(null,
    ['goal', 'plan', 'verify', '--input', '-', '--goal', goalId, '--hash', hash, '--fingerprint', expectedKey], proof)
  expect((await verify(childIssue)).code).toBe(0)
  const modifiedIssue = structuredClone(childIssue)
  modifiedIssue.record.actor.id = 'another-author'
  const replacementHash = createHash('sha256').update(JSON.stringify([modifiedIssue.schema, modifiedIssue.record])).digest('base64url')
  expect(() => verifyGoalTicketProof({ ...modifiedIssue, hash: replacementHash }, { fingerprint, goalId, hash: replacementHash }),
    'recomputing the Ticket hash cannot authorize an altered author').toThrow()
  expect((await verify(modifiedIssue)).code, 'a changed Ticket author fails the public proof verifier').toBe(1)
  expect((await verify(childIssue, childIssue.hash, '0'.repeat(64))).code).toBe(1)
  const assign = ['goal', 'plan', 'assignment', '--input', '-']
  await owner.call(null, assign, { goalId, nodeId, expectedRevision: 1, operationId: 'open-git-ticket', assignment: { kind: 'open' } })
  const active = await owner.call('worker', ['goal', 'plan', 'active'])
  expect(active.goals[0].nodes.map((node: { nodeId: string }) => node.nodeId)).toEqual([nodeId])
  const claimArgs = ['goal', 'plan', 'claim', '--goal', goalId, '--node', nodeId,
    '--claim-token', active.goals[0].nodes[0].claimToken, '--operation-id', 'claim-git-ticket']
  const claim = await owner.call('worker', claimArgs)
  const claimed = claim.plan.history.at(-1).claim.proof
  expect(claimed.record).toMatchObject({ kind: 'claim', ticketId: nodeId, executor: { id: 'worker' }, predecessors: [] })
  expect((await owner.call('worker', claimArgs)).plan.history.at(-1).claim.proof).toEqual(claimed)
  const ticketLink = claim.ticketLinks[1]
  expect(ticketLink).toBe('amux://goal/' + goalId + '#T-' + nodeId)
  await owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: {
    operationId: 'dispatch-git-ticket', sourceMessageId: 'source-git-ticket', threadId: 'thread-git-ticket',
    hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker', workerRunId: 'run-worker',
    text: 'Deliver and report the original repository result.', alignmentRevision: 1, criterionIds: [criterion.id], planNodeId: nodeId,
  } })
  const received = await owner.call('worker', ['message', 'read', '--host', 'local', '--message-id', 'source-git-ticket'])
  expect(received.message.envelope.application.data.ticketLink).toBe(ticketLink)
  const repo = join(owner.original.root, 'repository')
  await mkdir(repo)
  const git = async (...args: string[]) => (await run('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args])).stdout.trim()
  await git('init', '-b', 'main')
  await writeFile(join(repo, 'value.txt'), 'checked result\n')
  await git('add', '--', 'value.txt')
  await git('commit', '--no-verify', '-m', 'Deliver the checked result', '-m', 'Goal-Node: ' + ticketLink)
  const commit = await git('rev-parse', '--verify', 'main')
  const commitEvidence = pathToFileURL(repo)
  commitEvidence.searchParams.set('commit', commit)
  commitEvidence.hash = 'value.txt'
  expect(await git('show', '--no-ext-diff', '--no-textconv', commit + ':value.txt')).toBe('checked result')
  expect(await git('show', '-s', '--format=%(trailers:key=Goal-Node,valueonly)', commit)).toBe(ticketLink)
  const submitted = await owner.call('worker', ['goal', 'report', '--input', '-'], { goalId, operationId: 'dispatch-git-ticket', report: {
    operationId: 'submit-git-ticket', replyMessageId: 'reply-git-ticket', authorAgentSessionId: 'worker',
    grounding: { alignmentRevision: 1, summary: 'The original main commit passed its check', checks: [
      { criterionId: criterion.id, outcome: 'met', evidence: [commitEvidence.href], note: '' },
    ] },
  } })
  const deliveryHash = submitted.delegations[0].report.delivery.hash
  const reviewRequest = { goalId, review: {
    operationId: 'review-git-ticket', nodeId, delegationOperationId: 'dispatch-git-ticket', deliveryHash, verdict: 'pass' as const, note: '',
    check: { command: check, result: 'Confirmed the commit content and its original Ticket trailer', evidence: [commitEvidence.href] },
  } }
  const reviewArgs = ['goal', 'plan', 'review', '--input', '-']
  const reviewed = await owner.call('reviewer', reviewArgs, reviewRequest)
  const completion = reviewed.plan.reviews[0].completion
  expect(completion.record).toMatchObject({ kind: 'completed', ticketId: nodeId, attemptId: 'dispatch-git-ticket',
    executionHash: claimed.hash, deliveryHash, actor: { id: 'reviewer' } })
  expect((await verify(completion)).code).toBe(0)
  const changedResult = structuredClone(completion)
  changedResult.record.deliveryHash = '0'.repeat(64)
  expect((await verify(changedResult)).code).toBe(1)
  expect((await owner.call('reviewer', reviewArgs, reviewRequest)).plan.reviews[0].completion).toEqual(completion)
  await owner.call(null, assign, { goalId, nodeId: childId, expectedRevision: reviewed.plan.revision,
    operationId: 'open-successor', assignment: { kind: 'open' } })
  const ready = await owner.call('worker', ['goal', 'plan', 'active'])
  const childClaim = await owner.call('worker', ['goal', 'plan', 'claim', '--goal', goalId, '--node', childId,
    '--claim-token', ready.goals[0].nodes[0].claimToken, '--operation-id', 'claim-successor'])
  const childProof = childClaim.plan.history.at(-1).claim.proof
  expect(childProof.record.predecessors, 'claim proof must bind the actual upstream completion').toEqual([{ ticketId: nodeId, completionHash: completion.hash }])
  expect((await verify(childProof)).code).toBe(0)
  const collected = await owner.call('supervisor', ['goal', 'collect', '--input', '-'], { goalId, operationId: 'dispatch-git-ticket',
    collection: { operationId: 'collect-git-ticket', replyMessageId: 'reply-git-ticket' },
  })
  expect(collected.goalState.status).toBe('in_progress')
  expect(collected.grounding.acceptedAt).toBeNull()
  await owner.stop(); await owner.start()
  const historical = await owner.call('reviewer', ['goal', 'plan', '--goal', goalId])
  expect(historical.ticketLinks[1]).toBe(ticketLink)
  expect(historical.plan.history.at(-1).claim.proof).toEqual(childProof)
  expect(historical.plan.reviews[0]).toMatchObject({ deliveryHash, reviewer: { id: 'reviewer' } })
  const accept = ['goal', 'accept', '--goal', goalId, '--revision', '1', '--submission', collected.grounding.submissionId, '--finish']
  expect((await owner.cli('reviewer', accept)).code).toBe(1)
  expect((await owner.call(null, accept)).goal.status).toBe('done')
})
