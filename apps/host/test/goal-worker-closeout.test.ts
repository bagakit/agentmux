import { DemandStore } from '@agentmux/demand'
import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('keeps an explicit Supervisor Stop available when observation is slow, unavailable or historical', async () => {
  const workers = ['slow-worker', 'unrecorded-worker', 'historical-worker']
  const owner = await crossHostOwner(cleanup, 'supervisor-closeout', ['supervisor', ...workers])
  const { goal } = await owner.call('supervisor', ['goal', 'create', '--title', 'Stop temporary workers',
    '--status', 'in_progress', '--assignees', JSON.stringify(['supervisor', ...workers]),
    '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  await owner.call(null, ['goal', 'update', '--goal', goal.id, '--alignment', JSON.stringify({
    summary: 'Verify original Stop receipts', criteria: [{ id: 'receipts', text: 'Check the original Stop receipts' }], openQuestions: [],
  })])
  await owner.call(null, ['goal', 'confirm', '--goal', goal.id, '--revision', '1'])
  const setup = async (worker: string) => {
    await owner.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId: goal.id, intent: {
      operationId: 'attempt-' + worker, sourceMessageId: 'source-' + worker, threadId: 'thread-' + worker,
      hostId: 'local', ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor',
      workerAgentSessionId: worker, workerRunId: 'run-' + worker,
      text: 'Verify the original receipt.', alignmentRevision: 1, criterionIds: ['receipts'],
    } })
    return ['goal', 'closeout', '--goal', goal.id, '--attempt', 'attempt-' + worker, '--session', worker,
      '--run', 'run-' + worker, '--operation-id', 'stop-' + worker]
  }
  const slow = await setup(workers[0]!), unrecorded = await setup(workers[1]!), historical = await setup(workers[2]!)
  const observation = vi.spyOn(owner.client(), 'readAgentCloseoutInput').mockImplementationOnce(() => new Promise(() => {}))
  const stopped = await owner.call('supervisor', slow)
  expect(stopped).toMatchObject({ state: 'stopped', receipt: { operationId: 'stop-slow-worker' },
    observations: { coreInput: 'unknown', handoff: 'unreported', otherGoalWork: false } })
  observation.mockRestore()
  const failSave = vi.spyOn(DemandStore.prototype, 'freezeCloseoutObservation')
    .mockRejectedValueOnce(new Error('Original observation store unavailable'))
  const noObservation = await owner.call('supervisor', unrecorded)
  expect(noObservation).toMatchObject({ state: 'stopped', receipt: { operationId: 'stop-unrecorded-worker' }, observationIssue: expect.any(String) })
  expect(noObservation).not.toHaveProperty('observations')
  failSave.mockRestore()
  await owner.client().stopAgent('historical-worker', { runId: 'run-historical-worker' }, { operationId: 'stop-historical-worker' })
  const skipNewSample = vi.spyOn(owner.client(), 'readAgentCloseoutInput')
  const old = await owner.call('supervisor', [...historical, '--inspect'])
  expect(old).toMatchObject({ state: 'observed', stop: { phase: 'retired', operationIdMatched: true }, observationIssue: expect.any(String) })
  expect(old).not.toHaveProperty('observations')
  expect(skipNewSample).not.toHaveBeenCalled()
  await owner.stop(); await owner.start()
  expect(await owner.call('supervisor', [...slow, '--inspect'])).toMatchObject({
    state: 'observed', observations: stopped.observations, stop: { phase: 'retired', operationIdMatched: true },
  })
})
