import { afterEach, expect, it, vi } from 'vitest'
import { agentPromptCondition, observeAgent, type AgentMuxRpcCallContext, type ContinuousProgressLoop, type ContinuousProgressObservation } from '@agentmux/core'
import { ContinuousProgressLoopManager, type GoalProgressOwner } from '../src/continuous-progress-loop-manager.js'

const person: AgentMuxRpcCallContext = { principal: { kind: 'user', id: 'original-person' } }
const cleanup: Array<() => Promise<void>> = []
const deferred = () => Promise.withResolvers<void>()
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

function record(loopId: string, patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop {
  return { loopId, hostId: 'local', agentSessionId: loopId, providerId: 'fixture-provider', workspacePath: '/fixture/workspace',
    intervalMs: 60_000, prompt: `Original prompt for ${loopId}`, nextCheckAt: 60_100, status: 'active', ...patch }
}
function observation(loop: ContinuousProgressLoop, tickId: string, mode: 'done' | 'working' = 'done'): ContinuousProgressObservation {
  const status = { state: mode, source: 'native-hook' as const, observedAt: 1 }
  return { session: { ...loop, run: { runId: `original-run-${loop.loopId}` }, semanticStatus: status },
    observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, 100),
    tickId, now: 100, inputByte: 0, inputOccupied: false }
}
async function fixture(records: ContinuousProgressLoop[], options: { goals?: GoalProgressOwner } = {}) {
  let saved = structuredClone(records)
  const store = { load: async () => structuredClone(saved), save: vi.fn(async (next: readonly ContinuousProgressLoop[]) => { saved = structuredClone([...next]) }) }
  const observed: Array<{ loopId: string; tickId: string }> = []
  const submitted: Array<{ loop: ContinuousProgressLoop; operationId: string }> = []
  const modes = new Map<string, 'done' | 'working'>()
  const occupied = new Set<string>(), gates = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>()
  let outcome: 'sent' | 'unknown' = 'sent'
  const manager = new ContinuousProgressLoopManager(store as never, async (loop, operationId, isCurrent) => {
    expect(isCurrent()).toBe(true)
    expect(saved.find(value => value.loopId === loop.loopId)?.pendingCompletion?.operationId).toBe(operationId)
    submitted.push({ loop: structuredClone(loop), operationId }); return outcome
  }, () => 100, async (loop, tickId) => {
    observed.push({ loopId: loop.loopId, tickId })
    const gate = gates.get(loop.loopId)
    if (gate) { gates.delete(loop.loopId); gate.entered.resolve(); await gate.release.promise }
    return { ...observation(loop, tickId, modes.get(loop.loopId)), inputOccupied: occupied.has(loop.loopId) }
  }, undefined, options.goals)
  const releases: Array<() => void> = []
  cleanup.push(async () => { releases.forEach(release => release()); await manager.stop() })
  await manager.start()
  const exact = (id: string) => manager.list().find(loop => loop.loopId === id)!
  const request = (loopId: string, action: 'pause' | 'resume' | 'check' | 'stop', operationId: string) => {
    const expectedLoop = exact(loopId), { hostId, agentSessionId, providerId, workspacePath } = expectedLoop
    return { target: { hostId, agentSessionId, providerId, workspacePath }, loopId, action, operationId, expectedLoop }
  }
  return { manager, store, observed, submitted, modes, occupied, exact, request,
    saved: () => structuredClone(saved), outcome: (value: typeof outcome) => { outcome = value },
    action: (loopId: string, action: 'pause' | 'resume' | 'check' | 'stop', operationId: string, context = person) => manager.callProgress('agent.progress.action', request(loopId, action, operationId), context),
    hold: (loopId: string) => { const gate = { entered: deferred(), release: deferred() }; gates.set(loopId, gate); releases.push(() => gate.release.resolve()); return gate }
  }
}

it('public resume checks the exact original loop immediately and reuses its operation without double submission', async () => {
  const f = await fixture([record('original', { status: 'paused' })])
  const input = f.request('original', 'resume', 'explicit-resume')
  const result = await f.manager.callProgress('agent.progress.action', input, person)
  expect(result.loop).toMatchObject({ status: 'active', lastOutcome: 'sent', lastTickAt: 100, prompt: input.expectedLoop.prompt })
  expect(f.submitted).toHaveLength(1)
  expect(f.submitted[0]!.loop.pendingCompletion).toMatchObject({ condition: { expectedRun: { runId: 'original-run-original' } }, prompt: input.expectedLoop.prompt })
  expect(await f.manager.callProgress('agent.progress.action', input, person)).toEqual(result)
  const next = await f.action('original', 'check', 'explicit-check')
  expect(next.loop).toMatchObject({ lastOutcome: 'skipped', lastDecision: 'completion-consumed' })
  expect(f.submitted).toHaveLength(1)
})

it('resume reports a real busy check without forcing a prompt', async () => {
  const f = await fixture([record('original', { status: 'paused' })]); f.modes.set('original', 'working')
  expect((await f.action('original', 'resume', 'explicit-resume')).loop).toMatchObject({ status: 'active', lastOutcome: 'skipped', lastDecision: 'working', lastTickAt: 100 })
  expect(f.submitted).toEqual([])
})

it('unknown resumed delivery keeps its original operation and pauses without automatic replay', async () => {
  const f = await fixture([record('original', { status: 'paused' })]); f.outcome('unknown')
  const input = f.request('original', 'resume', 'explicit-resume')
  const result = await f.manager.callProgress('agent.progress.action', input, person)
  expect(result.loop).toMatchObject({ status: 'paused', lastOutcome: 'unknown', pendingCompletion: { operationId: f.submitted[0]!.operationId } })
  await f.manager.callProgress('agent.progress.action', input, person)
  await f.manager.check(100_000)
  expect(f.submitted).toHaveLength(1)
  expect(f.exact('original').pendingCompletion).toEqual(result.loop.pendingCompletion)
})

it('known client input veto rejects explicit resume while preserving the original paused loop', async () => {
  const original = record('original', { status: 'paused' }), f = await fixture([original]); f.occupied.add('original')
  await expect(f.action('original', 'resume', 'explicit-resume')).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(f.exact('original')).toEqual(original); expect(f.submitted).toEqual([])
})

it('concurrent public checks each evaluate their own exact target after an older timer check', async () => {
  const f = await fixture([record('old', { nextCheckAt: 0 }), record('a'), record('b')])
  const gate = f.hold('old'), old = f.manager.check(100, 'old'); await gate.entered.promise
  const a = f.action('a', 'check', 'explicit-a'), b = f.action('b', 'check', 'explicit-b')
  await vi.waitFor(() => expect(f.observed.filter(value => value.tickId.startsWith('explicit-'))).toHaveLength(2), { interval: 1 })
  gate.release.resolve()
  const [, aResult, bResult] = await Promise.all([old, a, b])
  expect(aResult.loop).toMatchObject({ lastOutcome: 'sent', lastTickAt: 100 })
  expect(bResult.loop).toMatchObject({ lastOutcome: 'sent', lastTickAt: 100 })
  expect(f.submitted.map(value => value.loop.loopId).sort()).toEqual(['a', 'b', 'old'])
  expect(new Set(f.submitted.map(value => value.operationId)).size).toBe(3)
})

it.each(['check', 'resume'] as const)('queued public %s cannot cross a newer input cancellation even after a later explicit activation', async action => {
  const f = await fixture([record('old', { nextCheckAt: 0 }), record('original', { status: action === 'resume' ? 'paused' : 'active' })])
  const gate = f.hold('old'), old = f.manager.check(100, 'old'); await gate.entered.promise
  const entered = deferred(), originalCheck = f.manager.checkNow.bind(f.manager)
  vi.spyOn(f.manager, 'checkNow').mockImplementation((loopId, assertCurrent) => { const result = originalCheck(loopId, assertCurrent); entered.resolve(); return result })
  const pending = f.action('original', action, 'original-action').then(value => ({ value }), error => ({ error }))
  await entered.promise
  f.manager.cancelTarget({ hostId: 'local', agentSessionId: 'original' })
  await f.manager.pause('original', 'Newer explicit input')
  await f.manager.resume('original')
  gate.release.resolve(); await old
  expect(await pending).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
  expect(f.exact('original')).toMatchObject({ status: 'active' })
  expect(f.exact('original').lastTickId).toBeUndefined()
  expect(f.submitted.map(value => value.loop.loopId)).toEqual(['old'])
})

it('a failed unrelated claim does not reject an explicit check of another healthy target', async () => {
  const f = await fixture([record('old', { nextCheckAt: 0 }), record('original')])
  const entered = deferred(), release = deferred()
  f.store.save.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('Original unrelated claim unavailable') })
  const old = f.manager.check(100, 'old').then(() => null, error => error)
  await entered.promise
  const checking = deferred(), originalCheck = f.manager.checkNow.bind(f.manager)
  vi.spyOn(f.manager, 'checkNow').mockImplementation((loopId, assertCurrent) => { const result = originalCheck(loopId, assertCurrent); checking.resolve(); return result })
  const next = f.action('original', 'check', 'explicit-check')
  await checking.promise
  release.resolve()
  expect(await old).toMatchObject({ message: 'Original unrelated claim unavailable' })
  expect((await next).loop).toMatchObject({ lastOutcome: 'sent', lastTickAt: 100 })
  expect(f.exact('old')).toMatchObject({ status: 'paused', lastDecision: expect.stringContaining('Original unrelated claim unavailable') })
  expect(f.submitted.map(value => value.loop.loopId)).toEqual(['original'])
})

it('paused check stays explicit and shared resume does not change Goal or schedule cadence', async () => {
  const f = await fixture([record('original', { status: 'paused' }), record('schedule', { status: 'paused', afterMs: 10, nextCheckAt: 500 })])
  await expect(f.manager.checkNow('original')).rejects.toThrow('Resume this loop before checking it.')
  expect(f.observed).toEqual([])
  expect(await f.manager.resume('original')).toMatchObject({ status: 'active', nextCheckAt: 60_100 })
  expect(await f.manager.resume('schedule')).toMatchObject({ status: 'active', nextCheckAt: 500 })
  expect(f.observed).toEqual([]); expect(f.submitted).toEqual([])
})

it('a queued Goal check retains its original activation fence and Goal resume keeps its interval', async () => {
  const goalLoop = record('goal', { revision: 1, taskSource: { kind: 'goal', goalId: 'goal', alignmentRevision: 1 } })
  goalLoop.initialDelivery = { operationId: 'original-start', prompt: goalLoop.prompt, condition: agentPromptCondition(observation(goalLoop, 'initial').session), state: 'confirmed', startedAt: 0 }
  const goals: GoalProgressOwner = { inspectInitial: async () => 'confirmed', read: async () => ({ id: 'goal', title: 'Original goal', description: 'Original scope', status: 'in_progress', sessionIds: ['goal'], assigneeSessionIds: ['goal'], supervisorSessionId: null, alignment: { revision: 1, confirmedAt: 1, criteria: [] } }) }
  const f = await fixture([record('old', { nextCheckAt: 0 }), goalLoop], { goals })
  await f.manager.pause('goal')
  const resumed = await f.manager.goalAction('goal', 'goal', 'resume', 1, 'goal-resume', person)
  expect(resumed).toMatchObject({ status: 'active', nextCheckAt: 60_100, revision: 2 }); expect(f.submitted).toEqual([])
  const gate = f.hold('old'), old = f.manager.check(100, 'old'); await gate.entered.promise
  const entered = deferred(), originalCheck = f.manager.checkNow.bind(f.manager)
  vi.spyOn(f.manager, 'checkNow').mockImplementation((loopId, assertCurrent) => { const result = originalCheck(loopId, assertCurrent); entered.resolve(); return result })
  const pending = f.manager.goalAction('goal', 'goal', 'check', 2, 'goal-check', person).then(value => ({ value }), error => ({ error }))
  await entered.promise
  f.manager.cancelTarget({ hostId: 'local', agentSessionId: 'goal' })
  await f.manager.pause('goal'); await f.manager.resume('goal')
  gate.release.resolve(); await old
  expect(await pending).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
  expect(f.exact('goal').lastTickId).toBeUndefined()
  expect(f.submitted.map(value => value.loop.loopId)).toEqual(['old'])
})
