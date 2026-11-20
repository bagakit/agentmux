import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { DemandStore } from '@agentmux/demand'
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

async function originalContinuation(name: string) {
  const host = await crossHostOwner(cleanup, name, ['supervisor'])
  const goal = (await host.call('supervisor', ['goal', 'create', '--title', 'Continue the same work', '--assignees', '["supervisor"]',
    '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])).goal
  await host.call(null, ['goal', 'update', '--goal', goal.id, '--alignment', JSON.stringify({ summary: 'Continue the same work',
    criteria: [{ id: 'proof', text: 'Read the original evidence' }], openQuestions: [] })])
  const confirmed = await host.call(null, ['goal', 'confirm', '--goal', goal.id, '--revision', '1'])
  const operationId = 'original-continuation', expectedRun = { runId: 'run-supervisor' }
  const args = ['goal', 'start', '--goal', goal.id, '--session', 'supervisor', '--continue-ms', '600000', '--alignment-revision', '1', '--operation-id', operationId]
  const inspect = () => host.call(null, ['goal', 'inspect', '--goal', goal.id])
  const input = () => host.client().inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'supervisor', expectedRun, submissionId: operationId })
  async function turn(state: 'working' | 'done') {
    const before = (await host.original.store.readMetadata('supervisor'))!, observedAt = Math.max(Date.now(), before.updatedAt + 1)
    await host.original.store.compareAndSwapMetadata(before, { ...before, updatedAt: observedAt,
      semanticStatus: { state, source: 'native-hook', observedAt, stateEnteredAt: observedAt, nativeTurnId: 'original-native-turn' } })
  }
  return { host, args, inspect, input, turn, expectedRun, operationId, goalId: goal.id, currentVersion: confirmed.goal.updatedAt }
}

it('original Goal continuation initial input waits while busy and autonomously admits once after Host and Core reopen', async () => {
  const f = await originalContinuation('goal-initial-wait')
  await f.turn('working')
  const stale = await f.host.cli(null, [...f.args, '--expected-updated-at', String(f.currentVersion - 1)])
  expect(stale.code).toBe(1)
  expect((await f.inspect()).goalContinuations).toEqual([])

  const attempts = await Promise.all([f.host.cli(null, f.args), f.host.cli(null, f.args)])
  for (const attempt of attempts) expect(attempt.code, attempt.stderr).toBe(0)
  const [first, second] = attempts.map(attempt => JSON.parse(attempt.stdout).result)
  const loopId = first.continuation.loopId
  expect(second.continuation.loopId).toBe(loopId)
  expect(first.continuation).toMatchObject({ status: 'paused', pause: { reason: 'preparation' }, lastOutcome: 'skipped',
    initialDelivery: { state: 'prepared', operationId: f.operationId, condition: { expectedRun: f.expectedRun } } })
  expect(first.continuation.lastDecision).toContain('Waiting for the Supervisor')
  const checked = await f.host.call(null, ['goal', 'inspect', '--goal', f.goalId, '--dispatch-operation', f.operationId])
  expect(checked.goalContinuations).toMatchObject([{ loopId, status: 'paused', initialDelivery: { state: 'prepared' } }])
  expect(await f.input()).toBeNull()
  expect(f.host.native.input).toHaveBeenCalledTimes(0)

  await f.host.stop()
  await f.host.start()
  expect((await f.inspect()).goalContinuations).toMatchObject([{ loopId, status: 'paused', initialDelivery: { state: 'prepared' } }])
  expect(await f.input()).toBeNull()
  await f.turn('done')
  await vi.waitFor(async () => {
    expect(await f.input()).toMatchObject({ run: f.expectedRun, admission: { submissionId: f.operationId, acknowledged: true } })
  }, { timeout: 8_000, interval: 50 })
  expect((await f.input())?.admission?.intent?.message?.systemContext).toContain('Goal role: manager')
  expect((await f.inspect()).goalContinuations).toMatchObject([{ loopId, status: 'active', initialDelivery: { state: 'confirmed', operationId: f.operationId } }])
  expect(f.host.native.input).toHaveBeenCalledTimes(1)
})

it('uses executor guidance for the original finite Goal Start', async () => {
  const f = await originalContinuation('goal-finite-start-role')
  await f.turn('done')
  await f.host.call(null, ['goal', 'start', '--goal', f.goalId, '--session', 'supervisor', '--operation-id', f.operationId])
  expect((await f.input())?.admission?.intent?.message?.systemContext).toContain('Goal role: executor')
  expect((await f.inspect()).goalContinuations).toEqual([])
})

it('original Goal continuation initial input releases a prepared loop whose authoritative Goal version refused Start', async () => {
  const f = await originalContinuation('goal-initial-stale')
  const prepare = DemandStore.prototype.prepareDispatch
  vi.spyOn(DemandStore.prototype, 'prepareDispatch').mockImplementationOnce(async function (this: DemandStore, ...args) {
    await this.update(f.goalId, { description: 'The new, explicitly startable Goal version' })
    return await prepare.apply(this, args)
  })
  const refused = await f.host.cli(null, [...f.args, '--expected-updated-at', String(f.currentVersion)])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('CONTROL_REQUEST_CONFLICT')
  const rejected = await f.inspect()
  expect(rejected.goal.dispatches).toEqual([])
  expect(rejected.goalContinuations).toMatchObject([{ status: 'stopped', creationOperationId: f.operationId, initialDelivery: { state: 'prepared' } }])
  expect(rejected.goalContinuations[0].lastDecision).toContain('The Goal changed before this new Start')
  expect(await f.input()).toBeNull()
  expect(f.host.native.input).toHaveBeenCalledTimes(0)
  const nextOperation = 'new-explicit-start', next = await f.host.call(null, [...f.args.slice(0, -1), nextOperation])
  expect(next.continuation).toMatchObject({ status: 'active', initialDelivery: { operationId: nextOperation, state: 'confirmed' } })
  expect(next.continuation.loopId).not.toBe(rejected.goalContinuations[0].loopId)
  expect(f.host.native.input).toHaveBeenCalledTimes(1)
})

it('original Goal continuation initial input keeps the request paused when its Supervisor authorization is withdrawn', async () => {
  const f = await originalContinuation('goal-initial-withdrawn')
  await f.turn('working')
  const start = await f.host.call(null, f.args), loopId = start.continuation.loopId
  expect(start.continuation).toMatchObject({ status: 'paused', pause: { reason: 'preparation' } })
  await f.host.call(null, ['goal', 'update', '--goal', f.goalId, '--clear-supervisor'])
  await f.host.stop()
  await f.host.start()
  await f.turn('done')
  const read = await f.inspect()
  expect(read.goal.supervisorSessionId).toBeNull()
  expect(read.goalContinuations).toMatchObject([{ loopId, status: 'paused', pause: { reason: 'source-changed' },
    initialDelivery: { operationId: f.operationId, state: 'prepared' } }])
  const explicit = await f.host.cli(null, f.args)
  expect(explicit.code).toBe(1)
  expect(explicit.stderr).toContain('currently assigned Supervisor')
  expect(await f.input()).toBeNull()
  expect(f.host.native.input).toHaveBeenCalledTimes(0)
})

it.each([false, true])('original Goal continuation initial input keeps unknown after lost acknowledgment (Core wrote %s)', async applied => {
  const f = await originalContinuation(applied ? 'goal-initial-lost-after' : 'goal-initial-lost-before')
  await f.turn('done')
  const core = f.host.client()
  const submit = core.submitAgentPrompt.bind(core)
  vi.spyOn(core, 'submitAgentPrompt').mockImplementationOnce(async (...args) => {
    if (applied) await submit(...args)
    // The original transport lost the return path. Neither the diagnostic code
    // nor a later empty read can establish an input effect.
    throw new AgentMuxError('The initial attempt outcome was lost.', 'AGENT_TURN_END_UNCONFIRMED')
  })
  const result = await f.host.cli(null, f.args)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('AGENT_TURN_END_UNCONFIRMED')
  const before = await f.inspect(), loopId = before.goalContinuations[0].loopId
  expect(before.goal.dispatches).toMatchObject([{ operationId: f.operationId, stage: 'unknown' }])
  expect(before.goalContinuations).toMatchObject([{ loopId, status: 'paused', initialDelivery: { state: 'unknown', operationId: f.operationId } }])
  await f.host.stop()
  await f.host.start()

  if (applied) {
    expect(await f.input()).toMatchObject({ admission: { submissionId: f.operationId, acknowledged: true } })
    const checked = await f.host.call(null, ['goal', 'inspect', '--goal', f.goalId, '--dispatch-operation', f.operationId])
    expect(checked.goalContinuations).toMatchObject([{ loopId, status: 'paused', initialDelivery: { state: 'unknown' } }])
    const rejoined = await f.host.call(null, f.args)
    expect(rejoined.continuation).toMatchObject({ loopId, status: 'active', initialDelivery: { state: 'confirmed', operationId: f.operationId } })
  } else {
    expect(await f.input()).toBeNull()
    const retry = await f.host.cli(null, f.args)
    expect(retry.code).toBe(1)
    expect(retry.stderr).toContain('AGENT_PROMPT_INPUT_UNCONFIRMED')
    expect((await f.inspect()).goalContinuations).toMatchObject([{ loopId, status: 'paused', initialDelivery: { state: 'unknown' } }])
  }
  expect(f.host.native.input).toHaveBeenCalledTimes(applied ? 1 : 0)
})
