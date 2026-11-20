import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('reserves budget for new original workflow attempts through the real Goal CLI', async () => {
  const host = await crossHostOwner(cleanup, 'budget-owner', ['supervisor', 'worker-one', 'worker-two'])
  const config = JSON.parse(await readFile(host.configurationPath, 'utf8'))
  const writeBudget = (maxConcurrent: number, maxAttempts: number) =>
    writeFile(host.configurationPath, JSON.stringify({ ...config, goals: { workflow: { maxConcurrent, maxAttempts } } }))
  await writeBudget(1, 2)
  const created = await host.call('supervisor', ['goal', 'create', '--title', 'Deliver checked artifacts', '--assignees',
    JSON.stringify(['supervisor', 'worker-one', 'worker-two']), '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  const goalId = created.goal.id
  const alignment = { summary: 'Deliver checked artifacts', criteria: [{ id: 'proof', text: 'Each artifact has independent evidence' }], openQuestions: [] }
  await host.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(alignment)])
  await host.call(null, ['goal', 'confirm', '--goal', goalId, '--revision', '1'])
  const plan = await host.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], {
    goalId, revision: { operationId: 'workflow-plan', expectedRevision: 0, alignmentRevision: 1,
      nodes: ['worker-one', 'worker-two'].map(agentSessionId => ({
        id: agentSessionId, title: 'Deliver ' + agentSessionId, outcome: 'One original artifact',
        dependsOn: [], criterionIds: ['proof'], check: 'Read the original artifact',
        executor: { hostId: 'local', agentSessionId }
      })) }
  })
  const start = await host.call(null, ['goal', 'start', '--goal', goalId, '--session', 'supervisor',
    '--continue-ms', '600000', '--alignment-revision', '1', '--operation-id', 'workflow-continuation'])
  const loopId = start.continuation.loopId
  const commands = ['goal', 'delegation', 'prepare', '--input', '-']
  const request = (index: number) => {
    const node = plan.plan.nodes[index]
    return { goalId, intent: { operationId: 'workflow-attempt-' + index, sourceMessageId: 'workflow-source-' + index,
      hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor',
      workerAgentSessionId: node.executor.agentSessionId, workerRunId: 'run-' + node.executor.agentSessionId,
      threadId: 'workflow-thread-' + index, text: node.outcome, alignmentRevision: 1,
      criterionIds: ['proof'], planNodeId: node.id, workflowLoopId: loopId } }
  }
  const results = await Promise.all([request(0), request(1)].map(input => host.cli('supervisor', commands, input)))
  const winner = results.findIndex(result => result.code === 0)
  expect(winner).toBeGreaterThanOrEqual(0)
  const waiting = 1 - winner
  expect(results[waiting]!.code, 'a second concurrent admission exceeded the saved budget').toBe(1)
  expect(results[waiting]!.stderr).toContain('1 of 1 workflow attempts in flight')
  const retained = await host.call('supervisor', ['goal', 'delegations', '--goal', goalId])
  expect(retained.delegations).toHaveLength(1)
  expect(retained.delegations[0]).toMatchObject({ operationId: request(winner).intent.operationId, workflowLoopId: loopId })
  await writeBudget(2, 1)
  const capped = await host.cli('supervisor', ['goal', 'delegate', '--input', '-'], request(waiting))
  expect(capped.code).toBe(1)
  expect(capped.stderr).toContain('used 1 of 1 workflow attempts')
  const original = await host.call('supervisor', commands, request(winner))
  expect(original.delegations).toEqual(retained.delegations)
  const foreign = request(waiting)
  foreign.intent.workflowLoopId = 'another-continuation'
  const rejected = await host.cli('supervisor', commands, foreign)
  expect(rejected.stderr).toContain('does not name the active original Goal continuation')
  const { workflowLoopId: _workflow, ...manual } = request(waiting).intent
  const manuallyPrepared = await host.call('supervisor', commands, { goalId, intent: manual })
  expect(manuallyPrepared.delegations).toHaveLength(2)
  expect(manuallyPrepared.delegations[1].workflowLoopId).toBeUndefined()
})
