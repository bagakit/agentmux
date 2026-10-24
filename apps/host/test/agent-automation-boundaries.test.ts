import { afterEach, expect, it } from 'vitest'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { createGoalAutomationPause } from '../src/goal-automation-pause.js'
import type { ContinuousProgressObservation } from '@agentmux/core'
const context = { principal: { kind: 'user' as const, id: 'original-user' } }
const target = { hostId: 'local', agentSessionId: 'original-session', providerId: 'codex', workspacePath: '/private-fixture' }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })
const input = { agentSessionId: target.agentSessionId, expectedRun: { runId: 'original-run' }, ownerInstanceId: 'original-owner', operationId: 'original-pause' }
const pauseOwner = (progress: ContinuousProgressLoopManager) => createGoalAutomationPause({ ownerInstanceId: () => input.ownerInstanceId, progress, cancel: () => {}, client: {
  agentSession: () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun }),
  readAgentSession: async () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun }),
  listAgentFuturePromptIntents: async () => ({ intents: [], nextIntentId: null })
} as never })

it('retains a later Run and its loop when the original pause waits for the scheduler', async () => {
  const entered = deferred(), release = deferred(); let runId = 'original-run'
  const paused: string[] = []
  const owner = createGoalAutomationPause({ ownerInstanceId: () => 'original-owner', client: {
    agentSession: () => ({ agentSessionId: target.agentSessionId, run: { runId } }),
    readAgentSession: async () => ({ agentSessionId: target.agentSessionId, run: { runId } })
  } as never, progress: {
    start: async () => { entered.resolve(); await release.promise },
    list: () => [{ ...target, loopId: 'later-loop', status: 'active' }],
    pause: async (id: string) => { paused.push(id) }
  } as never, cancel: () => {} })
  const input = { agentSessionId: target.agentSessionId, expectedRun: { runId }, ownerInstanceId: 'original-owner', operationId: 'original-pause' }
  const result = owner.pause(input, context).then(value => ({ value }), error => ({ error }))
  await entered.promise; runId = 'later-run'; release.resolve()
  expect(await result).toMatchObject({ error: { code: 'STALE_AGENT_SESSION' } })
  expect(paused).toEqual([])
  expect((await owner.inspect(input, context)).receipt).toMatchObject({ status: 'unknown', pausedLoopIds: [] })
})

it.each(['active', 'paused'] as const)('a newer explicit pause cancels an older %s loop resume through the actual scheduler', async status => {
  const entered = deferred(), release = deferred(); let observing = false
  const manager = new ContinuousProgressLoopManager({ load: async () => [], save: async () => {} } as never,
    async () => 'skipped', () => 0, async () => { if (observing) { entered.resolve(); await release.promise } return { inputOccupied: false } as ContinuousProgressObservation })
  cleanup.push(() => manager.stop())
  let loop = await manager.create({ ...target, intervalMs: 60_000, prompt: 'Original intent', operationId: 'original-create' })
  if (status === 'paused') loop = await manager.pause(loop.loopId)
  observing = true
  const resume = manager.callProgress('agent.progress.action', { target, loopId: loop.loopId, action: 'resume', expectedLoop: loop, operationId: 'original-resume' }, context)
    .then(value => ({ value }), error => ({ error }))
  await entered.promise
  expect((await pauseOwner(manager).pause(input, context)).receipt?.status).toBe('confirmed')
  release.resolve()
  expect(await resume).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
  expect(manager.list()[0]?.status).toBe('paused')
})

it('cancel-only revokes a still-preparing new progress intent without creating another loop', async () => {
  const entered = deferred(), release = deferred()
  const manager = new ContinuousProgressLoopManager({ load: async () => [], save: async () => {} } as never,
    async () => 'skipped', () => 0, async () => { entered.resolve(); await release.promise; return { inputOccupied: false } as ContinuousProgressObservation })
  cleanup.push(() => manager.stop())
  const create = manager.callProgress('agent.progress.create', { target, intervalMs: 60_000, prompt: 'Original intent', operationId: 'original-create' }, context)
    .then(value => ({ value }), error => ({ error }))
  await entered.promise
  expect((await pauseOwner(manager).pause(input, context)).receipt?.status).toBe('confirmed')
  release.resolve()
  expect(await create).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
  expect(manager.list()).toEqual([])
})

it('checks the exact Run at the actual scheduler pause after scheduler startup', async () => {
  const entered = deferred(), release = deferred(); let current = true
  const manager = new ContinuousProgressLoopManager({ load: async () => [], save: async () => {} } as never,
    async () => 'skipped', () => 0, async () => ({ inputOccupied: false }) as ContinuousProgressObservation)
  cleanup.push(() => manager.stop())
  const loop = await manager.create({ ...target, intervalMs: 60_000, prompt: 'Original intent', operationId: 'original-create' })
  const pause = manager.pause(loop.loopId, 'Exact cancellation', context, { prepare: async () => { entered.resolve(); await release.promise },
    assertCurrent: () => { if (!current) throw new Error('Original Run changed') } }).then(value => ({ value }), error => ({ error }))
  await entered.promise; current = false; release.resolve()
  expect(await pause).toMatchObject({ error: { message: 'Original Run changed' } })
  expect(manager.list()[0]?.status).toBe('active')
})

it('local cancel-only retains a preparing foreign Host intent with the same Session ID', async () => {
  const entered = deferred(), release = deferred()
  const manager = new ContinuousProgressLoopManager({ load: async () => [], save: async () => {} } as never,
    async () => 'skipped', () => 0, async () => { entered.resolve(); await release.promise; return { inputOccupied: false } as ContinuousProgressObservation })
  cleanup.push(() => manager.stop())
  const foreign = { ...target, hostId: 'original-remote' }
  const create = manager.callProgress('agent.progress.create', { target: foreign, intervalMs: 60_000, prompt: 'Original remote intent', operationId: 'original-remote-create' }, context)
  await entered.promise
  expect((await pauseOwner(manager).pause(input, context)).receipt?.status).toBe('confirmed')
  release.resolve()
  expect(await create).toMatchObject({ loop: { hostId: foreign.hostId, agentSessionId: target.agentSessionId, status: 'active' } })
  expect(manager.list()).toHaveLength(1)
})
