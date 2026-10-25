import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ContinuousProgressScheduler, observeAgent, type ContinuousProgressLoop, type ContinuousProgressObservation } from '@agentmux/core'
import { ContinuousProgressLoopManager, type FutureProgressInputOwner, type LoopObservationProvider } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createGoalAutomationPause } from '../src/goal-automation-pause.js'

const target = { hostId: 'local', agentSessionId: 'selected-session', providerId: 'fixture-provider', workspacePath: 'fixture-workspace' }
const person = { principal: { kind: 'user' as const, id: 'original-person' } }
const input = { agentSessionId: target.agentSessionId, expectedRun: { runId: 'original-run' }, ownerInstanceId: 'original-owner', operationId: 'original-pause' }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

function record(loopId: string, patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop {
  return { ...target, loopId, intervalMs: 60_000, prompt: `Original ${loopId}`, status: 'active', nextCheckAt: 60_100, ...patch }
}
function schedules(): ContinuousProgressLoop[] {
  let next = 0
  const scheduler = new ContinuousProgressScheduler({ now: () => 100, id: () => `schedule-${++next}` })
  return [1, 2].map(index => scheduler.createSchedule({ ...target, afterMs: 60_000, nextDue: 60_100, prompt: `Original schedule ${index}`, operationId: `create-schedule-${index}` }))
}
const busyObservation: LoopObservationProvider = async (loop, tickId, now) => {
  const semanticStatus = { state: 'working' as const, source: 'native-hook' as const, observedAt: now }
  return { session: { ...loop, run: input.expectedRun, semanticStatus }, tickId, now, inputByte: 0, inputOccupied: false,
    observation: observeAgent({ process: 'running', status: semanticStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now) } as ContinuousProgressObservation
}
async function fixture(records: ContinuousProgressLoop[], options: { observe?: LoopObservationProvider; future?: FutureProgressInputOwner['saveFutureIntent']; listIntents?: () => Promise<{ intents: []; nextIntentId: null }> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-manual-automation-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(directory, 'loops.json'))
  await store.save(records)
  const future = vi.fn(options.future ?? (async () => {})), tick = vi.fn(async () => 'skipped' as const)
  const manager = new ContinuousProgressLoopManager(store, tick, () => 100, options.observe ?? busyObservation, { saveFutureIntent: future })
  cleanup.push(() => manager.stop())
  await manager.start()
  const save = vi.spyOn(store, 'save'), cancel = vi.fn()
  const owner = createGoalAutomationPause({ ownerInstanceId: () => input.ownerInstanceId, progress: manager, cancel, client: {
    agentSession: () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun }),
    readAgentSession: async () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun }),
    listAgentFuturePromptIntents: options.listIntents ?? (async () => ({ intents: [], nextIntentId: null }))
  } as never })
  return { manager, store, save, future, tick, owner, cancel }
}

it('exact target lookup and cancellation never enumerate unrelated loop records, preserving index order after replacement', async () => {
  const early = record('early', { hostId: 'foreign' }), later = record('later')
  const f = await fixture([early, later, ...Array.from({ length: 200 }, (_, index) => record(`other-${index}`, { agentSessionId: `other-${index}` }))])
  const scheduler = (f.manager as unknown as { scheduler: ContinuousProgressScheduler }).scheduler
  scheduler.replace(early.loopId, { ...early, hostId: target.hostId })
  const schedule = scheduler.createSchedule({ ...target, afterMs: 60_000, nextDue: 60_100, prompt: 'New original schedule', operationId: 'new-schedule' })
  const created = scheduler.create({ ...target, agentSessionId: 'new-session', prompt: 'New original loop', intervalMs: 60_000 })
  const values = vi.spyOn((scheduler as unknown as { loops: Map<string, ContinuousProgressLoop> }).loops, 'values')
  expect(f.manager.list(target).map(loop => loop.loopId)).toEqual([early.loopId, later.loopId, schedule.loopId])
  expect(f.manager.list({ ...target, agentSessionId: 'missing' })).toEqual([])
  expect(f.manager.list({ ...target, providerId: 'foreign-provider' })).toEqual([])
  expect(f.manager.list({ ...target, agentSessionId: created.agentSessionId }).map(loop => loop.loopId)).toEqual([created.loopId])
  f.manager.cancelTarget(target)
  expect(values).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
  const complete = f.manager.list({ hostId: 'local' })
  expect(values).toHaveBeenCalledOnce() // Partial targets legitimately inspect the original full record owner.
  expect(complete).toHaveLength(204)
  const detached = f.manager.list(target); detached[0]!.prompt = 'Caller mutation'
  expect(f.manager.list(target)[0]!.prompt).toBe(early.prompt)
  values.mockRestore()
})

it('one explicit pause durably saves the complete batch once and keeps each original schedule receipt', async () => {
  const savedSchedules = schedules(), foreign = record('foreign', { hostId: 'foreign' }), stopped = record('stopped', { status: 'stopped' })
  const records = [record('progress'), ...savedSchedules, foreign, stopped], f = await fixture(records)
  const result = await f.owner.pause(input, person)
  expect(result.receipt).toMatchObject({ status: 'confirmed', pausedLoopIds: ['progress', ...savedSchedules.map(loop => loop.loopId)], disabledIntentIds: [], issues: [] })
  expect(f.save).toHaveBeenCalledOnce()
  const persisted = await f.store.load()
  expect(persisted).toHaveLength(records.length)
  expect(persisted.slice(0, 3).map(loop => loop.status)).toEqual(['paused', 'paused', 'paused'])
  expect(persisted.slice(3)).toEqual([foreign, stopped])
  expect(f.future.mock.calls.map(([loop, active]) => [loop.loopId, loop.futureIntentId, active])).toEqual(savedSchedules.map(loop => [loop.loopId, loop.futureIntentId, false]))
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: input.expectedRun })
  expect(await f.owner.inspect(input, person)).toEqual(result)
  expect(await f.owner.pause(input, person)).toEqual(result)
  expect(f.save).toHaveBeenCalledOnce(); expect(f.future).toHaveBeenCalledTimes(2); expect(f.tick).not.toHaveBeenCalled()
})

it('a failed schedule effect keeps independent batch outcomes and the original operation unknown', async () => {
  const savedSchedules = schedules()
  const f = await fixture([record('progress'), ...savedSchedules], { future: async loop => { if (loop.loopId === savedSchedules[0]!.loopId) throw Error('Original intent save unavailable') } })
  const result = await f.owner.pause(input, person)
  expect(result.receipt).toMatchObject({ status: 'unknown', pausedLoopIds: ['progress', savedSchedules[1]!.loopId], issues: [{ stage: 'pause-original-automatic-input', message: 'Original intent save unavailable' }] })
  expect(f.save).toHaveBeenCalledOnce(); expect(f.future).toHaveBeenCalledTimes(2)
  expect((await f.store.load()).map(loop => loop.status)).toEqual(['paused', 'paused', 'paused'])
  expect(await f.owner.pause(input, person)).toEqual(result)
  expect(f.future).toHaveBeenCalledTimes(2)
})

it('one failing loop observer cannot swallow another saved schedule outcome', async () => {
  const [schedule] = schedules(), f = await fixture([record('progress'), schedule!])
  const unsubscribe = f.manager.subscribe(loop => { if (loop.loopId === 'progress') throw Error('Original loop observer unavailable') })
  try {
    const result = await f.owner.pause(input, person)
    expect(result.receipt).toMatchObject({ status: 'unknown', pausedLoopIds: [schedule!.loopId], issues: [{ message: 'Original loop observer unavailable' }] })
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.future.mock.calls.map(([loop, active]) => [loop.loopId, active])).toEqual([[schedule!.loopId, false]])
    expect((await f.store.load()).map(loop => loop.status)).toEqual(['paused', 'paused'])
  } finally { unsubscribe() }
})

it('failed persistence remains unknown until a new explicit pause actually saves the original paused records', async () => {
  const records = [record('first'), record('second')], f = await fixture(records)
  f.save.mockRejectedValueOnce(Error('Original store unavailable'))
  const first = await f.owner.pause(input, person)
  expect(first.receipt).toMatchObject({ status: 'unknown', pausedLoopIds: [], issues: [{ message: 'Original store unavailable' }, { message: 'Original store unavailable' }] })
  expect(f.manager.list(target).map(loop => loop.status)).toEqual(['paused', 'paused'])
  expect(await f.store.load()).toEqual(records)
  expect(await f.owner.pause(input, person)).toEqual(first); expect(f.save).toHaveBeenCalledOnce()
  const next = { ...input, operationId: 'explicit-pause-after-repair' }
  const confirmed = await f.owner.pause(next, person)
  expect(confirmed.receipt).toMatchObject({ status: 'confirmed', pausedLoopIds: records.map(loop => loop.loopId), issues: [] })
  expect(f.save).toHaveBeenCalledTimes(2)
  expect((await f.store.load()).map(loop => loop.status)).toEqual(['paused', 'paused'])
  expect(await f.owner.inspect(input, person)).toEqual(first)
  expect(await f.owner.inspect(next, person)).toEqual(confirmed)
})

it('a failed-save observer cannot prevent another original loop from reporting its disk failure', async () => {
  const f = await fixture([record('first'), record('second')]), notified: ContinuousProgressLoop[] = []
  f.save.mockRejectedValueOnce(Error('Original disk failure'))
  const unsubscribe = f.manager.subscribe(loop => {
    notified.push(loop)
    if (loop.loopId === 'first') throw Error('Original observer failure')
  })
  try {
    const result = await f.owner.pause(input, person)
    expect(result.receipt).toMatchObject({ status: 'unknown', pausedLoopIds: [], issues: [
      { message: 'Original observer failure' }, { message: 'Original disk failure' }
    ] })
    expect(notified.map(loop => loop.loopId)).toEqual(['first', 'second'])
    expect(notified.every(loop => loop.status === 'paused' && loop.lastDecision?.includes('Original disk failure'))).toBe(true)
    expect(f.save).toHaveBeenCalledOnce()
    expect((await f.store.load()).map(loop => loop.status)).toEqual(['active', 'active'])
  } finally { unsubscribe() }
})

it('cancel discovery fences an already paused resume before the later intent read and batch save finish', async () => {
  const observing = Promise.withResolvers<void>(), releaseObservation = Promise.withResolvers<void>()
  const readingIntents = Promise.withResolvers<void>(), releaseIntents = Promise.withResolvers<void>()
  let held = false
  const original = record('paused', { status: 'paused' })
  const f = await fixture([original], {
    observe: async (...args) => { if (!held) { held = true; observing.resolve(); await releaseObservation.promise } return busyObservation(...args) },
    listIntents: async () => { readingIntents.resolve(); await releaseIntents.promise; return { intents: [], nextIntentId: null } }
  })
  const resume = f.manager.callProgress('agent.progress.action', { target, loopId: original.loopId, action: 'resume', expectedLoop: original, operationId: 'older-resume' }, person)
    .then(value => ({ value }), error => ({ error }))
  let pause: ReturnType<typeof f.owner.pause> | undefined
  try {
    await observing.promise
    pause = f.owner.pause(input, person)
    await readingIntents.promise
    releaseObservation.resolve()
    expect(await resume).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
    expect(f.manager.list(target)[0]!.status).toBe('paused')
    expect(f.save).not.toHaveBeenCalled()
    releaseIntents.resolve()
    expect((await pause).receipt?.status).toBe('confirmed')
    expect(f.save).toHaveBeenCalledOnce(); expect(f.tick).not.toHaveBeenCalled()
  } finally { releaseObservation.resolve(); releaseIntents.resolve(); await Promise.allSettled([resume, ...(pause ? [pause] : [])]) }
})
