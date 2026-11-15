import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const run = promisify(execFile)
const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('uses the original Git result as optional Ticket evidence and preserves explicit Goal acceptance', async () => {
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
  await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'define-git-ticket', expectedRevision: 0, alignmentRevision: 1,
    nodes: [{ id: 'code', title: 'Land the change', outcome: 'A verified commit on main', executor: null, criterionIds: [criterion.id], dependsOn: [], check }],
  } })
  await owner.call(null, ['goal', 'plan', 'assignment', '--input', '-'], {
    goalId, nodeId: 'code', expectedRevision: 1, operationId: 'open-git-ticket', assignment: { kind: 'open' },
  })
  const active = await owner.call('worker', ['goal', 'plan', 'active'])
  const claim = await owner.call('worker', ['goal', 'plan', 'claim', '--goal', goalId, '--node', 'code',
    '--claim-token', active.goals[0].nodes[0].claimToken, '--operation-id', 'claim-git-ticket'])
  const ticketLink = claim.ticketLinks[0]
  expect(ticketLink).toBe('amux://goal/' + goalId + '#T1')
  await owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: {
    operationId: 'dispatch-git-ticket', sourceMessageId: 'source-git-ticket', threadId: 'thread-git-ticket',
    hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker', workerRunId: 'run-worker',
    text: 'Deliver and report the original repository result.', alignmentRevision: 1, criterionIds: [criterion.id], planNodeId: 'code',
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
  await owner.call('reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: {
    operationId: 'review-git-ticket', nodeId: 'code', delegationOperationId: 'dispatch-git-ticket', deliveryHash, verdict: 'pass', note: '',
    check: { command: check, result: 'Confirmed the commit content and its original Ticket trailer', evidence: [commitEvidence.href] },
  } })
  const collected = await owner.call('supervisor', ['goal', 'collect', '--input', '-'], { goalId, operationId: 'dispatch-git-ticket',
    collection: { operationId: 'collect-git-ticket', replyMessageId: 'reply-git-ticket' },
  })
  expect(collected.goalState.status).toBe('in_progress')
  expect(collected.grounding.acceptedAt).toBeNull()
  await owner.stop(); await owner.start()
  const historical = await owner.call('reviewer', ['goal', 'plan', '--goal', goalId])
  expect(historical.ticketLinks).toEqual([ticketLink])
  expect(historical.plan.reviews[0]).toMatchObject({ deliveryHash, reviewer: { id: 'reviewer' } })
  const accept = ['goal', 'accept', '--goal', goalId, '--revision', '1', '--submission', collected.grounding.submissionId, '--finish']
  expect((await owner.cli('reviewer', accept)).code).toBe(1)
  expect((await owner.call(null, accept)).goal.status).toBe('done')
})
