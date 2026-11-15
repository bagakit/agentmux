import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ContinuousProgressScheduler, observeAgent, type ContinuousProgressLoop, type ContinuousProgressObservation } from '@agentmux/core'
import { ContinuousProgressLoopManager, type FutureProgressInputOwner, type LoopObservationProvider } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createGoalAutomationPause } from '../src/goal-automation-pause.js'
import { deliverContinuousProgress } from '../src/continuous-progress-delivery.js'

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
async function fixture(records: ContinuousProgressLoop[], options: { observe?: LoopObservationProvider; future?: FutureProgressInputOwner['saveFutureIntent']; tick?: ConstructorParameters<typeof ContinuousProgressLoopManager>[1] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-manual-automation-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new ContinuousProgressLoopStore(join(directory, 'loops.json'))
  await store.save(records)
  const future = vi.fn(options.future ?? (async () => {})), tick = vi.fn(options.tick ?? (async () => 'skipped' as const))
  const manager = new ContinuousProgressLoopManager(store, tick, () => 100, options.observe ?? busyObservation, { saveFutureIntent: future })
  cleanup.push(() => manager.stop())
  await manager.start()
  const save = vi.spyOn(store, 'save'), cancel = vi.fn()
  const owner = createGoalAutomationPause({ ownerInstanceId: () => input.ownerInstanceId, progress: manager, cancel, client: {
    agentSession: () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun }),
    readAgentSession: async () => ({ agentSessionId: target.agentSessionId, run: input.expectedRun })
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

it('one input edge pauses continuation and retains active and explicitly paused schedules', async () => {
  const savedSchedules = schedules(), foreign = record('foreign', { hostId: 'foreign' }), stopped = record('stopped', { status: 'stopped' })
  savedSchedules[1] = { ...savedSchedules[1]!, status: 'paused', pause: { reason: 'manual', pausedAt: 1, episodeId: 'original-explicit-pause' } }
  const records = [record('progress'), ...savedSchedules, foreign, stopped], f = await fixture(records)
  const result = await f.owner.pause(input, person)
  expect(result.receipt).toMatchObject({ status: 'confirmed', pausedLoopIds: ['progress'], disabledIntentIds: [], issues: [] })
  expect(f.save).toHaveBeenCalledOnce()
  const persisted = await f.store.load()
  expect(persisted).toHaveLength(records.length)
  expect(persisted[0]?.status).toBe('paused')
  expect(persisted.slice(1)).toEqual([...savedSchedules, foreign, stopped])
  expect(f.future).not.toHaveBeenCalled()
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: input.expectedRun })
  expect(await f.owner.inspect(input, person)).toEqual(result)
  expect(await f.owner.pause(input, person)).toEqual(result)
  expect(f.save).toHaveBeenCalledOnce(); expect(f.future).not.toHaveBeenCalled(); expect(f.tick).not.toHaveBeenCalled()
})

it('an input edge writes no schedule state and does not call the future intent owner', async () => {
  const originals = schedules()
  const f = await fixture(originals, { future: async () => { throw Error('Original intent save unavailable') } })
  const result = await f.owner.pause(input, person)
  expect(result.receipt).toMatchObject({ status: 'confirmed', pausedLoopIds: [], disabledIntentIds: [], issues: [] })
  expect(f.save).not.toHaveBeenCalled(); expect(f.future).not.toHaveBeenCalled()
  expect(await f.store.load()).toEqual(originals)
  expect(await f.owner.pause(input, person)).toEqual(result)
})

it('an input edge leaves a concurrently saved schedule and its future intent enabled', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const f = await fixture([], { future: async () => { entered.resolve(); await released.promise } })
  const creating = f.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'Original saved message', operationId: 'create-during-edit' })
  try {
    await entered.promise
    expect((await f.owner.pause(input, person)).receipt?.status).toBe('confirmed')
    released.resolve()
    const { schedule } = await creating
    expect(schedule).toMatchObject({ status: 'active', nextCheckAt: 60_100, creationOperationId: 'create-during-edit' })
    expect(f.future).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ loopId: schedule.loopId }), true, undefined)
    expect(await f.store.load()).toEqual([schedule])
  } finally { released.resolve(); await creating.catch(() => {}) }
})

const dueSchedule = () => ({ ...schedules()[0]!, nextCheckAt: 100 })
const readySchedule: LoopObservationProvider = async (loop, tickId, now, signal) => {
  const base = await busyObservation(loop, tickId, now, signal)
  const semanticStatus = { state: 'done' as const, source: 'native-hook' as const, observedAt: now }
  return { ...base, session: { ...base.session, semanticStatus, futurePromptIntents: {
    [loop.futureIntentId!]: { operationId: loop.creationOperationId!, prompt: loop.prompt, message: { userContent: loop.prompt }, active: true }
  } }, observation: observeAgent({ process: 'running', status: semanticStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now) }
}

it('yields the exact due check before dispatch and delivers the same occurrence on a later check', async () => {
  const schedule = dueSchedule(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let first = true
  const f = await fixture([schedule], { observe: async (...args) => {
    if (first) { first = false; entered.resolve(); await released.promise }
    return readySchedule(...args)
  }, tick: async () => 'sent' })
  const firstCheck = f.manager.checkNow(schedule.loopId)
  try {
    await entered.promise
    expect((await f.owner.pause(input, person)).receipt?.status).toBe('confirmed')
    released.resolve()
    expect(await firstCheck).toEqual(schedule)
    expect(f.tick).not.toHaveBeenCalled()
    expect(await f.manager.checkNow(schedule.loopId)).toMatchObject({ lastOutcome: 'sent', lastOccurrenceAt: schedule.nextCheckAt, status: 'stopped' })
    expect(f.tick).toHaveBeenCalledOnce()
  } finally { released.resolve(); await firstCheck.catch(() => {}) }
})

it('yields a saved preparation during the production delivery preflight before calling Core', async () => {
  const schedule = dueSchedule(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const submitPrompt = vi.fn(async () => {})
  const f = await fixture([schedule], { observe: readySchedule, tick: (...args) => deliverContinuousProgress({
    observeContinuousProgress: async (loop, op, now, signal) => {
      entered.resolve(); await released.promise
      return readySchedule(loop, op, now, signal!)
    }, submitPrompt,
  }, ...args) })
  const checking = f.manager.checkNow(schedule.loopId)
  try {
    await entered.promise
    expect((await f.store.load())[0]?.pendingCompletion).toBeDefined()
    expect((await f.owner.pause(input, person)).receipt?.status).toBe('confirmed')
    released.resolve()
    expect(await checking).toMatchObject({ status: 'active', nextCheckAt: schedule.nextCheckAt })
    expect((await f.store.load())[0]?.pendingCompletion).toBeUndefined()
    expect((await f.store.load())[0]?.lastInputRef).toBeUndefined()
    expect(submitPrompt).not.toHaveBeenCalled()
  } finally { released.resolve(); await checking.catch(() => {}) }
})

it('does not cancel a due occurrence after its original input owner has started', async () => {
  const schedule = dueSchedule(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let originalSignal: AbortSignal | undefined
  const f = await fixture([schedule], { observe: readySchedule, tick: async (_loop, _operation, _current, signal, onDispatch) => {
    onDispatch()
    originalSignal = signal
    entered.resolve(); await released.promise
    return 'sent'
  } })
  const checking = f.manager.checkNow(schedule.loopId)
  try {
    await entered.promise
    const before = f.manager.list(target)[0]
    expect(before?.lastInputRef).toBeTruthy()
    expect((await f.owner.pause(input, person)).receipt?.status).toBe('confirmed')
    expect(originalSignal?.aborted).toBe(false)
    expect(f.manager.list(target)[0]).toEqual(before)
    released.resolve()
    expect(await checking).toMatchObject({ lastOutcome: 'sent', lastInputRef: before?.lastInputRef, status: 'stopped' })
  } finally { released.resolve(); await checking.catch(() => {}) }
})

it('one failing loop observer cannot swallow a separate continuation pause result', async () => {
  const [schedule] = schedules(), f = await fixture([record('progress'), record('next'), schedule!])
  const unsubscribe = f.manager.subscribe(loop => { if (loop.loopId === 'progress') throw Error('Original observer failure') })
  try {
    const result = await f.owner.pause(input, person)
    expect(result.receipt).toMatchObject({ status: 'unknown', pausedLoopIds: ['next'], issues: [{ message: 'Original observer failure' }] })
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.future).not.toHaveBeenCalled()
    expect((await f.store.load()).map(loop => loop.status)).toEqual(['paused', 'paused', 'active'])
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

it('input cancellation fences an already paused continuation resume before its save finishes', async () => {
  const observing = Promise.withResolvers<void>(), releaseObservation = Promise.withResolvers<void>()
  const saving = Promise.withResolvers<void>(), releaseSave = Promise.withResolvers<void>()
  let held = false
  const original = record('paused', { status: 'paused' })
  const f = await fixture([original], {
    observe: async (...args) => { if (!held) { held = true; observing.resolve(); await releaseObservation.promise } return busyObservation(...args) }
  })
  f.save.mockImplementationOnce(async loops => { saving.resolve(); await releaseSave.promise; await ContinuousProgressLoopStore.prototype.save.call(f.store, loops) })
  const resume = f.manager.callProgress('agent.progress.action', { target, loopId: original.loopId, action: 'resume', expectedLoop: original, operationId: 'older-resume' }, person)
    .then(value => ({ value }), error => ({ error }))
  let pause: ReturnType<typeof f.owner.pause> | undefined
  try {
    await observing.promise
    pause = f.owner.pause(input, person)
    await saving.promise
    releaseObservation.resolve()
    expect(await resume).toMatchObject({ error: { code: 'CONTROL_REQUEST_CONFLICT' } })
    expect(f.manager.list(target)[0]!.status).toBe('paused')
    expect(await f.store.load()).toEqual([original])
    releaseSave.resolve()
    expect((await pause).receipt?.status).toBe('confirmed')
    expect(f.save).toHaveBeenCalledOnce(); expect(f.tick).not.toHaveBeenCalled()
  } finally { releaseObservation.resolve(); releaseSave.resolve(); await Promise.allSettled([resume, ...(pause ? [pause] : [])]) }
})

it('a person\'s input moves a Mote standing heartbeat one interval later and keeps it on, without a manual resume', async () => {
  const managedSource = { sourceId: 'mote-main:fixture', revision: 'role-1' }
  const heartbeat = schedules()[0]!, managed = { ...heartbeat, loopId: 'heartbeat', everyMs: 1_800_000, managedSource, nextCheckAt: 50 }
  delete (managed as Partial<ContinuousProgressLoop>).afterMs
  const f = await fixture([record('progress'), managed])
  const result = await f.owner.pause(input, person)
  expect(result.receipt).toMatchObject({ status: 'confirmed', pausedLoopIds: ['progress'], deferredLoopIds: ['heartbeat'], disabledIntentIds: [], issues: [] })
  // The due occurrence now waits a full interval after the input (the fixture clock reads 100), saved durably.
  expect((await f.store.load()).find(loop => loop.loopId === 'heartbeat')).toMatchObject({ status: 'active', nextCheckAt: 100 + 1_800_000 })
  expect(f.future).not.toHaveBeenCalled()
  // A heartbeat already later than one interval keeps its own time.
  const later = await f.owner.pause({ ...input, operationId: 'second-pause' }, person)
  expect(later.receipt).toMatchObject({ deferredLoopIds: [] })
  expect((await f.store.load()).find(loop => loop.loopId === 'heartbeat')).toMatchObject({ status: 'active', nextCheckAt: 100 + 1_800_000 })
})
