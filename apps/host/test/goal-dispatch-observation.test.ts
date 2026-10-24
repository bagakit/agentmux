import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type AgentTimelineItem } from '@agentmux/core'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { createHostGoals } from '../src/goals.js'
import { reconcileDesktopGoalDispatch } from '../../desktop/src/main/desktop-goals.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

for (const execution of ['finite', 'continue'] as const) it(`Desktop inspection of an original ${execution} Start only reconciles its exact existing input and never submits`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-input-observation-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let items: AgentTimelineItem[] = []
  const sessionTimeline = vi.fn(async () => ({ agentSessionId: 'original-worker', items })), submitPrompt = vi.fn(async () => { throw new Error('Inspection must never submit an input.') })
  const owner = createHostGoals({ configurationPath: join(root, 'configuration.json'),
    runtime: () => ({ client: { sessionTimeline, submitPrompt }, ownerIdentity: () => ({ ownerInstanceId: 'original-owner' }) }) as never,
    coreCall: async () => { throw new Error('Inspection must not dispatch another Core operation.') }, projects: async () => [] })
  cleanup.push(() => owner.dispose())
  await owner.demands.create({ id: 'original-goal', title: 'Original Goal', assigneeSessionIds: ['original-worker'] })
  await owner.demands.proposeAlignment('original-goal', { summary: 'Original work', criteria: [{ id: 'original', text: 'Original result' }], openQuestions: [] })
  const reference = { goalId: 'original-goal', operationId: 'original-start' }
  await owner.demands.prepareDispatch(reference.goalId, { operationId: reference.operationId, hostId: 'local', agentSessionId: 'original-worker', runId: 'original-run',
    execution, prompt: 'Original exact task', ...(execution === 'continue' ? { loopId: 'original-loop', alignmentRevision: 1 } : {}) })
  const service = new AgentMuxRpcService({ coreClients: () => [], goalControl: owner.execute })
  const calls: string[] = []
  const desktop = { callOriginalCore: async (_host: string, method: string, params: unknown, context: any) => {
    calls.push(method); return await service.call(method as never, params as never, context)
  } }
  await expect(reconcileDesktopGoalDispatch(desktop as never, reference)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(await owner.demands.inspectDispatch(reference.goalId, reference.operationId)).toMatchObject({ stage: 'prepared', execution })
  expect(submitPrompt).not.toHaveBeenCalled()
  items = [{ id: 'prompt:original-start', agentSessionId: 'original-worker', kind: 'user_message', status: 'complete', content: 'Original exact task', createdAt: 1 }] as AgentTimelineItem[]
  const result = await reconcileDesktopGoalDispatch(desktop as never, reference)
  expect(result.demand.dispatches).toMatchObject([{ operationId: reference.operationId, execution, stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:original-start' } }])
  expect(calls).toEqual(['goal.inspect', 'goal.inspect']); expect(submitPrompt).not.toHaveBeenCalled()
  expect((await owner.demands.get(reference.goalId))!.dispatches).toHaveLength(1)
  await expect(reconcileDesktopGoalDispatch(desktop as never, { ...reference, operationId: 'another-operation' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(submitPrompt).not.toHaveBeenCalled()
})

it('strict public Goal inspect and the actual CLI preserve only the selected original dispatch identity', async () => {
  expect(rpcControlRequest('goal.inspect', { goalId: 'original-goal', dispatchOperationId: 'original-start' })).toMatchObject({ operation: 'demand.show', demandId: 'original-goal', dispatchOperationId: 'original-start' })
  expect(() => rpcControlRequest('goal.inspect', { goalId: 'original-goal', dispatchOperationId: {} })).toThrow()
  expect(await parseAgentMuxCliInvocation(['goal', 'inspect', '--goal', 'original-goal', '--dispatch-operation', 'original-start'])).toMatchObject({ command: { method: 'goal.inspect' }, params: { goalId: 'original-goal', dispatchOperationId: 'original-start' } })
})
