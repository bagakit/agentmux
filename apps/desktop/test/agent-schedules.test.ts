import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nextCalendarOccurrence, latestCalendarOccurrence } from '@agentmux/core/schedule-calendar'
import { ContinuousProgressLoopManager, type LoopTickHandler, type LoopObservationProvider, type FutureProgressInputOwner } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'
import { observeAgent, type ContinuousProgressInputReading, type ContinuousProgressLoop, type AgentMuxRpcCallContext, type AgentMuxPendingInteraction } from '@agentmux/core'
import { parseAgentScheduleCalendar, type AgentScheduleCalendar } from '../../../packages/core/src/agent-schedule.js'
import { parseScheduleRpcParams, parseScheduleRecord, validateScheduleRpcResult } from '../../../packages/core/src/public-rpc-schedules.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const rules = (kind: AgentScheduleCalendar['kind'], fields: Partial<AgentScheduleCalendar> = {}): AgentScheduleCalendar => ({ kind, timezone: 'UTC', time: _hygiene_fixtureClock(9, 30), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' }, ...fields })
const target = { hostId: 'local', agentSessionId: 'agent', providerId: 'generic', workspacePath: _hygiene_fixturePath("repo") }
const pendingPermission: AgentMuxPendingInteraction = { request: { kind: 'permission', id: 'permission',
  agentSessionId: target.agentSessionId, title: 'Private permission request',
  options: [{ id: 'allow-once', kind: 'allow-once', label: 'Allow' }],
  evidence: { source: 'native-hook', run: { runId: 'run' }, hookReceiptId: 'permission', observedAt: _historyFixtureEpoch(0, 0, 1) } } }
const stamp = (text: string) => Date.parse(text)
const managers: ContinuousProgressLoopManager[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.stop())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function owner(onTick: LoopTickHandler = async () => 'sent', save = async (_loop: ContinuousProgressLoop, _active: boolean, _context?: AgentMuxRpcCallContext) => {}, authorize = async () => {}, inspectInput?: FutureProgressInputOwner['inspectInput']) {
  const dir = await mkdtemp(_hygiene_fixturePath("tmp/am-schedule-unit-")); dirs.push(dir)
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const intents: Record<string, { operationId: string; prompt: string; message: { userContent: string }; active: boolean }> = {}
  let now = stamp(_hygiene_fixtureIso(24134400000, "second")), occupied = false, working = false, permission = false, missing = false
  const observe: LoopObservationProvider = async (_loop, tickId) => {
    const status = { state: working ? 'working' as const : 'done' as const, source: 'native-hook' as const, observedAt: 1 }
    return { session: { ...target, run: { runId: 'run' }, promptCompletionAdmission: { submissionId: 'old-input', completionId: '["run",1]', operationId: 'old-input', startByte: 0, endByte: 1 }, semanticStatus: status, futurePromptIntents: intents, ...(permission ? { pendingInteraction: pendingPermission } : {}) },
      observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: permission, terminalCapabilityUnverified: false }, now), inputOccupied: occupied, inputByte: missing ? null : 0, tickId, now }
  }
  const inputs: FutureProgressInputOwner = { saveFutureIntent: async (loop, active, context) => { await save(loop, active, context); intents[loop.futureIntentId!] = { operationId: loop.creationOperationId!, prompt: loop.prompt, message: { userContent: loop.prompt }, active } }, authorizeFutureIntent: authorize,
    ...(inspectInput ? { inspectInput, inspectFutureIntent: async (loop: ContinuousProgressLoop) => ({ active: intents[loop.futureIntentId!]?.active === true }) } : {}),
    observeCheckIn: async (_target, at) => ({ known: true, human: { id: 'original-human', createdAt: at - 36 * 3_600_000 } }) }
  const open = (storage: ContinuousProgressLoopStore) => {
    const manager = new ContinuousProgressLoopManager(storage, onTick, () => now, observe, inputs)
    managers.push(manager)
    return manager
  }
  const manager = open(store)
  return { manager, store, reopen: () => open(new ContinuousProgressLoopStore(join(dir, 'loops.json'))), reload: () => new ContinuousProgressLoopStore(join(dir, 'loops.json')).load(), set: (values: { now?: number; occupied?: boolean; working?: boolean; permission?: boolean; missing?: boolean }) => { if (values.now !== undefined) now = values.now; if (values.occupied !== undefined) occupied = values.occupied; if (values.working !== undefined) working = values.working; if (values.permission !== undefined) permission = values.permission; if (values.missing !== undefined) missing = values.missing } }
}

describe('civil calendar', () => {
  it('computes once/day/week/month/year without fixed-duration drift', () => {
    expect(nextCalendarOccurrence(rules('once', { date: _hygiene_fixtureCivil(12, 31) }), stamp((_hygiene_fixtureCivil(10, 1) + "Z")))).toBe(stamp(_hygiene_fixtureIso(31483800000, "minute")))
    expect(nextCalendarOccurrence(rules('daily'), stamp(_hygiene_fixtureIso(31485600000, "minute")))).toBe(stamp(_hygiene_fixtureIso(31570200000, "minute")))
    expect(nextCalendarOccurrence(rules('weekly', { weekday: 1 }), stamp(_hygiene_fixtureIso(24141600000, "minute")))).toBe(stamp(_hygiene_fixtureIso(24571800000, "minute")))
    expect(nextCalendarOccurrence(rules('monthly', { day: 31 }), stamp(_hygiene_fixtureIso(34164000000, "minute")))).toBe(stamp(_hygiene_fixtureIso(36581400000, "minute")))
    expect(nextCalendarOccurrence(rules('yearly', { month: 2, day: 29 }), stamp(_hygiene_fixtureIso(36583200000, "minute")))).toBe(stamp(_hygiene_fixtureIso(68203800000, "minute")))
    expect(latestCalendarOccurrence(rules('daily'), stamp(_hygiene_fixtureIso(34200000, "minute")), stamp(_hygiene_fixtureIso(24141600000, "minute")))).toBe(stamp(_hygiene_fixtureIso(24139800000, "minute")))
  })
  it('skips DST gaps and selects one explicit fold offset', () => {
    const gap = rules('daily', { timezone: 'America/New_York', time: _hygiene_fixtureClock(2, 30) })
    expect(nextCalendarOccurrence(gap, stamp(_hygiene_fixtureIso(5720400000, "zone-minute", -300)))).toBe(stamp(_hygiene_fixtureIso(5812200000, "zone-minute", -240)))
    const fold = rules('daily', { timezone: 'America/New_York', time: _hygiene_fixtureClock(1, 30) })
    expect(nextCalendarOccurrence(fold, stamp(_hygiene_fixtureIso(26280000000, "zone-minute", -240)))).toBe(stamp(_hygiene_fixtureIso(26285400000, "zone-minute", -240)))
    expect(nextCalendarOccurrence({ ...fold, policies: { ...fold.policies, fold: 'later' } }, stamp(_hygiene_fixtureIso(26280000000, "zone-minute", -240)))).toBe(stamp(_hygiene_fixtureIso(26289000000, "zone-minute", -300)))
    expect(() => parseAgentScheduleCalendar({ ...gap, timezone: 'Invalid/Zone' })).toThrow()
    expect(() => parseAgentScheduleCalendar(rules('once', { date: _hygiene_fixtureCivil(2, 30) }))).toThrow()
  })
})

describe('original schedule owner', () => {
  it.each(['claim', 'prepared-input', 'busy-check'] as const)('retains the due schedule through storage failure at %s', async stage => {
    const dispatched = vi.fn(async () => 'sent' as const)
    const h = await owner(dispatched)
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'next', operationId: 'storage-create' })
    const due = schedule.nextCheckAt
    h.set({ now: due, working: stage === 'busy-check' })
    const save = h.store.save.bind(h.store)
    const fault = vi.spyOn(h.store, 'save').mockImplementation(async loops => {
      const candidate = loops.find(loop => loop.loopId === schedule.loopId)!
      if (stage === 'prepared-input' && !candidate.pendingCompletion) return save(loops)
      throw Object.assign(new Error('Injected write failure'), { code: 'ENOSPC' })
    })
    await expect(h.manager.check(due)).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(fault).toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
    const held = (await h.manager.call('schedule.inspect', { scheduleId: schedule.loopId })).schedule!
    expect(held).toMatchObject({ status: 'active', nextCheckAt: due, lastOutcome: 'skipped' })
    expect(held.pendingCompletion).toBeUndefined()
    expect(held.lastInputRef).toBeUndefined()
    fault.mockClear()
    await h.manager.check(due)
    expect(fault).not.toHaveBeenCalled()
    fault.mockRestore()
    h.set({ now: due + 1_000, working: false })
    await h.manager.check(due + 1_000)
    expect(dispatched).toHaveBeenCalledOnce()
    expect((await h.reload())[0]).toMatchObject({ loopId: schedule.loopId, status: 'active', nextCheckAt: due + 60_000 })
  })

  it('reads original schedules from a cold Host without requiring a write', async () => {
    const h = await owner()
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'next', operationId: 'readable-original' })
    const restored = new ContinuousProgressLoopManager(h.store, vi.fn(), () => 0, vi.fn())
    const save = vi.spyOn(h.store, 'save').mockRejectedValue(Object.assign(new Error('Injected write failure'), { code: 'ENOSPC' }))
    try {
      await expect(restored.call('schedule.inspect', { scheduleId: schedule.loopId })).resolves.toMatchObject({ schedule })
      await expect(restored.call('schedule.list', {})).resolves.toMatchObject({ schedules: [schedule] })
      expect(save).not.toHaveBeenCalled()
    } finally {
      save.mockRestore()
      await restored.stop()
    }
  })

  it('persists a human postponement without the interrupted unsubmitted preparation', async () => {
    const dispatched = vi.fn(async () => 'sent' as const)
    const h = await owner(dispatched)
    h.manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'next', operationId: 'postpone-create',
      managedSource: { sourceId: 'original-care', revision: 'original-role' } })
    h.set({ now: schedule.nextCheckAt })
    const save = h.store.save.bind(h.store), entered = deferred(), release = deferred()
    let interrupted = false
    const fault = vi.spyOn(h.store, 'save').mockImplementation(async loops => {
      await save(loops)
      if (!interrupted && loops.some(loop => loop.loopId === schedule.loopId && loop.pendingCompletion)) {
        interrupted = true
        entered.resolve()
        await release.promise
        throw Object.assign(new Error('Original directory sync unconfirmed after replacing the file'), { code: 'ENOSPC' })
      }
    })
    const checking = h.manager.check().catch(error => error)
    try {
      await entered.promise
      const stored = (await h.reload())[0]!
      expect(stored.pendingCompletion).toBeDefined()
      const [deferred] = await h.manager.deferManaged([schedule.loopId], 'Original human input postponed care.')
      expect(deferred).toMatchObject({ status: 'fulfilled' })
      const after = (await h.reload())[0]!
      expect(after).toMatchObject({ status: 'active', nextCheckAt: schedule.nextCheckAt + 60_000 })
      expect(after.pendingCompletion).toBeUndefined()
      expect(after.lastInputRef).toBeUndefined()
    } finally {
      release.resolve()
      expect(await checking).toMatchObject({ code: 'ENOSPC' })
      fault.mockRestore()
    }
    expect(dispatched).not.toHaveBeenCalled()
    expect((await h.reload())[0]?.pendingCompletion).toBeUndefined()
  })

  it.each(['occupied','working','permission','missing'] as const)('keeps the occurrence due while %s', async blocked => {
    let calls = 0
    const h = await owner(async () => { calls++; return 'sent' })
    const receipt = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'next', operationId: 'create' })
    const due = receipt.schedule.nextCheckAt
    h.set({ now: due, [blocked]: true }); await h.manager.check(due)
    expect(calls).toBe(0); expect(h.manager.list()[0]!.nextCheckAt).toBe(due); expect(h.manager.list()[0]!.pendingCompletion).toBeUndefined()
    h.set({ [blocked]: false }); await h.manager.check(due)
    expect(calls).toBe(1); expect(h.manager.list()[0]!.nextCheckAt).toBe(stamp(_hygiene_fixtureIso(24226200000, "minute")))
  })
  it('freezes and persists the original claim before send, preserving unknown on resume', async () => {
    let h!: Awaited<ReturnType<typeof owner>>, count = 0, original = ''
    h = await owner(async (loop: ContinuousProgressLoop, operationId: string) => {
      const saved = (await h.store.load())[0]!
      expect(saved.pendingCompletion!.operationId).toBe(operationId)
      expect(saved.pendingCompletion!.prompt).toBe('next')
      original ||= operationId; expect(operationId).toBe(original); count++
      return count === 1 ? 'unknown' : 'sent'
    })
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'next', operationId: 'create' })
    const due = created.schedule.nextCheckAt; h.set({ now: due }); await h.manager.check(due)
    expect(h.manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', nextCheckAt: due })
    await h.manager.check(due); expect(count).toBe(1)
    await h.manager.call('schedule.resume', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'resume' }); await h.manager.check(due)
    expect(count).toBe(2); expect(h.manager.list()[0]!.pendingCompletion).toBeUndefined()
  })
  it('does not resurrect cancellation through a delayed resume and rejects stale revision', async () => {
    const blocked = deferred(), entered = deferred(); let delay = false
    const h = await owner(undefined, async (_loop, active) => { if (active && delay) { entered.resolve(); await blocked.promise } })
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'next', operationId: 'create' })
    const id = created.schedule.loopId
    await h.manager.call('schedule.pause', { scheduleId: id, expectedRevision: 1, operationId: 'pause' })
    delay = true
    const resumed = h.manager.call('schedule.resume', { scheduleId: id, expectedRevision: 2, operationId: 'resume' }); await entered.promise
    const cancelled = h.manager.call('schedule.cancel', { scheduleId: id, expectedRevision: 3, operationId: 'cancel' })
    blocked.resolve(); await resumed; await cancelled
    expect((await h.store.load())[0]).toMatchObject({ status: 'stopped', revision: 4, lastMutation: { operationId: 'cancel' } })
    await expect(h.manager.call('schedule.resume', { scheduleId: id, expectedRevision: 3, operationId: 'stale' })).rejects.toMatchObject({ code: 'SCHEDULE_REVISION_CONFLICT' })
  })
  it('does not acknowledge a duplicate create before original future-intent save finishes', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await owner(undefined, async () => { entered.resolve(); await blocked.promise; throw new Error('future store failed') })
    const request = { target, calendar: rules('daily'), prompt: 'next', operationId: 'same-create' }
    const first = h.manager.call('schedule.create', request).then(() => 'success', () => 'failed'); await entered.promise
    let resolved = false
    const second = h.manager.call('schedule.create', request).then(() => { resolved = true; return 'success' }, () => { resolved = true; return 'failed' })
    await Promise.resolve(); expect(resolved).toBe(false); blocked.resolve()
    expect(await first).toBe('failed'); expect(await second).toBe('failed')
  })
  it('converges an original failed create before confirming and forwards the authenticated context', async () => {
    const calls: { active: boolean; context?: AgentMuxRpcCallContext }[] = []
    const context: AgentMuxRpcCallContext = { caller: { agentSessionId: 'sender', capability: 'private-test-capability' }, transport: 'unix' }
    const h = await owner(undefined, async (_loop, active, received) => {
      calls.push({ active, ...(received ? { context: received } : {}) }); if (calls.length === 1) throw new Error('Original Core save unknown')
    })
    const request = { target, calendar: rules('daily'), prompt: 'next', operationId: 'same-create' }
    await expect(h.manager.call('schedule.create', request, context)).rejects.toThrow('Core save unknown')
    const original = h.manager.list()[0]!
    const retried = await h.manager.call('schedule.create', request, context)
    expect(retried.schedule).toMatchObject({ loopId: original.loopId, revision: 1, status: 'active' })
    expect(retried.schedule.lastOutcome).toBeUndefined()
    // A failed admission is explicitly deactivated before the same operation is retried.
    expect(calls.map(call => call.active)).toEqual([true, false, true]); expect(calls.every(call => call.context === context)).toBe(true)
    await h.manager.call('schedule.pause', { scheduleId: original.loopId, expectedRevision: 1, operationId: 'pause' }, context)
    const duplicate = await h.manager.call('schedule.create', request, context)
    expect(duplicate.schedule.status).toBe('paused'); expect(calls.at(-1)!.active).toBe(false)
  })
  it('keeps a confirmed schedule eligible when a duplicate create loses its Host save', async () => {
    const dispatched = vi.fn(async () => 'sent' as const), coreIntent = vi.fn(async () => {})
    const h = await owner(dispatched, coreIntent)
    const request = { target, everyMs: 60_000, prompt: 'Retained message', operationId: 'original-create' }
    const { schedule } = await h.manager.call('schedule.create', request)
    const storeWrite = vi.spyOn(h.store, 'save').mockRejectedValueOnce(Error('Duplicate save unavailable'))
    coreIntent.mockRejectedValue(Error('Core unavailable to a duplicate'))
    await expect(h.manager.call('schedule.create', request)).rejects.toThrow('Duplicate save unavailable')
    expect(coreIntent).toHaveBeenCalledOnce()
    expect((await h.reload())[0]).toEqual(schedule)
    expect((await h.manager.call('schedule.create', request)).schedule).toEqual(schedule)
    expect(coreIntent).toHaveBeenCalledOnce()
    storeWrite.mockRestore()
    h.set({ now: schedule.nextCheckAt }); await h.manager.check(schedule.nextCheckAt)
    expect(dispatched).toHaveBeenCalledOnce()
  })
  it('continues the durable original preparation after a Host restart before Core activation', async () => {
    const coreIntent = vi.fn(async () => {}), h = await owner(undefined, coreIntent)
    const request = { target, afterMs: 90_000, prompt: 'Original message', operationId: 'original-preparation' }
    const save = h.store.save.bind(h.store)
    vi.spyOn(h.store, 'save').mockImplementationOnce(async loops => {
      await save(loops)
      throw Error('Host exited after saving the preparation')
    })
    await expect(h.manager.call('schedule.create', request)).rejects.toThrow('exited after saving')
    expect(coreIntent).not.toHaveBeenCalled()
    const [prepared] = await h.reload()
    expect(prepared).toMatchObject({ status: 'paused', pause: { reason: 'preparation' } })
    expect(prepared?.lastOutcome).toBeUndefined()
    await h.manager.stop()
    const restarted = h.reopen()
    const confirmed = await restarted.call('schedule.create', request)
    expect(confirmed.schedule).toMatchObject({ status: 'active', loopId: prepared!.loopId, nextCheckAt: prepared!.nextCheckAt })
    expect(coreIntent).toHaveBeenCalledOnce()
    expect(await h.reload()).toEqual([confirmed.schedule])
  })
  it.each([false, true])('preserves a later explicit pause and interval edit after a late creation result (unknown=%s)', async unknown => {
    const entered = deferred(), release = deferred()
    let coreActive = false
    const h = await owner(undefined, async (_loop, active) => {
      if (active) { entered.resolve(); await release.promise }
      coreActive = active
      if (active && unknown) throw Error('Original Core activation response was lost')
    })
    const request = { target, everyMs: 60_000, prompt: 'Next', operationId: 'create-before-pause' }
    const creation = h.manager.call('schedule.create', request).catch(error => error)
    try {
      await entered.promise
      const [candidate] = h.manager.list()
      const paused = await h.manager.call('schedule.pause', { scheduleId: candidate!.loopId, expectedRevision: 1, operationId: 'original-explicit-pause' })
      const latest = await h.manager.call('schedule.update', { scheduleId: paused.schedule.loopId, expectedRevision: 2, everyMs: 120_000, operationId: 'original-interval-update' })
      release.resolve()
      const result = await creation
      if (unknown) expect(result).toMatchObject({ message: 'Original Core activation response was lost' })
      else expect(result).toEqual(latest)
      expect(await h.reload()).toEqual([latest.schedule])
      expect((await h.manager.call('schedule.create', request)).schedule).toEqual(latest.schedule)
      expect(coreActive).toBe(false)
    } finally { release.resolve(); await creation }
  })
  it('keeps a newer resume active when a late create has to settle an earlier pause', async () => {
    const creating = deferred(), releaseCreate = deferred(), repairing = deferred(), releaseRepair = deferred()
    let firstActivation = true, pauseWrites = 0, coreActive = false
    const h = await owner(undefined, async (_loop, active) => {
      if (active && firstActivation) { firstActivation = false; creating.resolve(); await releaseCreate.promise }
      if (!active && ++pauseWrites === 2) { repairing.resolve(); await releaseRepair.promise }
      coreActive = active
    })
    const creation = h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'Original', operationId: 'create-before-controls' })
    try {
      await creating.promise
      const scheduleId = h.manager.list()[0]!.loopId
      await h.manager.call('schedule.pause', { scheduleId, expectedRevision: 1, operationId: 'original-pause' })
      releaseCreate.resolve(); await repairing.promise
      const resume = h.manager.call('schedule.resume', { scheduleId, expectedRevision: 2, operationId: 'original-resume' })
      releaseRepair.resolve()
      await creation
      const result = await resume
      expect(await h.reload()).toEqual([result.schedule])
      expect(result.schedule).toMatchObject({ status: 'active', revision: 3 })
      expect(coreActive).toBe(true)
    } finally { releaseCreate.resolve(); releaseRepair.resolve(); await creation.catch(() => {}) }
  })
  it('keeps a newer resume active after an earlier failed creation rolls back its intent', async () => {
    const entered = deferred(), release = deferred()
    let phase = 'create', coreActive = false
    const h = await owner(undefined, async (_loop, active) => {
      if (phase === 'create' && active) { phase = 'rollback'; throw Error('Original activation unavailable') }
      if (phase === 'rollback' && !active) { phase = 'resume'; entered.resolve(); await release.promise }
      coreActive = active
    })
    const creation = h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'Original', operationId: 'failing-create' }).catch(error => error)
    try {
      await entered.promise
      const scheduleId = h.manager.list()[0]!.loopId
      const resume = h.manager.call('schedule.resume', { scheduleId, expectedRevision: 1, operationId: 'later-resume' })
      release.resolve()
      expect(await creation).toMatchObject({ message: 'Original activation unavailable' })
      expect((await resume).schedule).toMatchObject({ status: 'active', revision: 2 })
      expect(coreActive).toBe(true)
    } finally { release.resolve(); await creation }
  })
  it('validates the original timing request across a changed interval and JSON field order', async () => {
    const h = await owner()
    const request = { target, everyMs: 60_000, prompt: 'Original message', operationId: 'interval-create' }
    const first = await h.manager.call('schedule.create', request)
    const updated = await h.manager.call('schedule.update', { scheduleId: first.schedule.loopId, expectedRevision: 1, everyMs: 120_000, operationId: 'interval-update' })
    const replay = await h.manager.call('schedule.create', request)
    expect(replay.schedule).toEqual(updated.schedule)
    expect(validateScheduleRpcResult('schedule.create', replay, request)).toEqual(replay)
    await expect(h.manager.call('schedule.create', { ...request, everyMs: 120_000 })).rejects.toMatchObject({ code: 'SCHEDULE_OPERATION_CONFLICT' })
    expect(() => validateScheduleRpcResult('schedule.create', replay, { ...request, everyMs: 120_000 })).toThrow()
    const { weekday, ...rule } = rules('weekly', { weekday: 2 })
    const calendarRequest = { target, calendar: { weekday, ...rule }, prompt: 'Calendar message', operationId: 'unordered-calendar' }
    const calendarReceipt = await h.manager.call('schedule.create', calendarRequest)
    expect(validateScheduleRpcResult('schedule.create', calendarReceipt, calendarRequest)).toEqual(calendarReceipt)
  })
  it('keeps an in-flight occurrence eligible when saving a new interval fails', async () => {
    const entered = deferred(), release = deferred()
    const h = await owner(async () => { entered.resolve(); await release.promise; return 'sent' })
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'Next', operationId: 'interval-source' })
    h.set({ now: schedule.nextCheckAt })
    const check = h.manager.check(schedule.nextCheckAt)
    try {
      await entered.promise
      const input = h.manager.inspectLoop(schedule.loopId)!.lastInputRef
      vi.spyOn(h.store, 'save').mockRejectedValueOnce(Error('Interval save unavailable'))
      await expect(h.manager.call('schedule.update', { scheduleId: schedule.loopId, expectedRevision: 1, everyMs: 120_000, operationId: 'interval-edit' })).rejects.toThrow('Interval save unavailable')
      expect(h.manager.inspectLoop(schedule.loopId)).toMatchObject({ status: 'active', lastInputRef: input })
      release.resolve(); await check
      expect(h.manager.inspectLoop(schedule.loopId)).toMatchObject({ status: 'active', lastOutcome: 'sent', lastInputRef: input })
    } finally { release.resolve(); await check }
  })
  it.each(['pause', 'resume', 'cancel'] as const)('does not repeat an already confirmed %s across a Host restart', async action => {
    const coreIntent = vi.fn(async () => {}), h = await owner(undefined, coreIntent)
    const { schedule } = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'Original message', operationId: 'original-create' })
    const scheduleId = schedule.loopId
    if (action === 'resume') await h.manager.call('schedule.pause', { scheduleId, expectedRevision: 1, operationId: 'original-pause' })
    const request = { scheduleId, expectedRevision: action === 'resume' ? 2 : 1, operationId: 'original-control' }
    const method = `schedule.${action}` as const
    const result = await h.manager.call(method, request)
    expect(result.schedule.lastMutation).toMatchObject({ phase: 'settled' })
    await h.manager.stop()
    const restarted = h.reopen()
    coreIntent.mockClear().mockRejectedValue(Error('No extra Core write was needed'))
    expect(await restarted.call(method, request)).toEqual(result)
    expect(coreIntent).not.toHaveBeenCalled()
  })
  it('rejects swapped identities, old interval records and counterfeit public receipts', async () => {
    const h = await owner(), params = { target, calendar: rules('daily'), prompt: 'next', operationId: 'create' }
    const receipt = await h.manager.call('schedule.create', params)
    expect(validateScheduleRpcResult('schedule.create', receipt, params)).toEqual(receipt)
    expect(() => validateScheduleRpcResult('schedule.inspect', { schedule: receipt.schedule, executionScope: 'connected-host' }, { scheduleId: 'different' })).toThrow()
    expect(() => validateScheduleRpcResult('schedule.create', { ...receipt, schedule: { ...receipt.schedule, workspacePath: _hygiene_fixturePath("another") } }, params)).toThrow()
    const { calendar: _, ...interval } = receipt.schedule
    expect(() => validateScheduleRpcResult('schedule.create', { ...receipt, schedule: interval }, params)).toThrow()
  })
  it('refuses unauthorized mutation before changing the original arrangement', async () => {
    let denied = false
    const h = await owner(undefined, undefined, async () => { if (denied) throw new Error('Original Core caller refused') })
    const context: AgentMuxRpcCallContext = { caller: { agentSessionId: 'sender', capability: 'private-test-capability' } }
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'future', operationId: 'original-create' }, context)
    denied = true
    const refused = await h.manager.call('schedule.cancel', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'wrong-caller' }, context).then(() => undefined, error => error)
    expect(h.manager.list()[0]).toMatchObject({ status: 'active', revision: 1 })
    expect((await h.store.load())[0]).toMatchObject({ status: 'active', revision: 1 })
    expect(h.manager.list()[0]!.lastMutation).toBeUndefined()
    expect(refused).toMatchObject({ message: 'Original Core caller refused' })
  })
})

it('retains civil due through the old check-now entry and allows the original interval alongside calendar', async () => {
  let calls = 0
  const h = await owner(async () => { calls++; return 'sent' })
  const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'future', operationId: 'calendar-create' })
  await h.manager.checkNow(created.schedule.loopId)
  expect(h.manager.list()[0]!.nextCheckAt).toBe(created.schedule.nextCheckAt); expect(calls).toBe(0)
  const interval = await h.manager.create({ ...target, intervalMs: 60000, prompt: 'interval' })
  expect(interval.calendar).toBeUndefined()
  await h.manager.pauseTarget(target, 'Human input')
  expect(h.manager.list().find(loop => loop.loopId === created.schedule.loopId)!.status).toBe('active')
  expect(h.manager.list().find(loop => loop.loopId === interval.loopId)!.status).toBe('paused')
})

it.each(['pause','resume','cancel'] as const)('retries the original %s action after Core intent durability was unknown', async action => {
  let fail = false, attempts = 0
  const h = await owner(undefined, async () => { if (fail) { attempts++; if (attempts === 1) throw new Error('Core save unknown') } })
  const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'next', operationId: 'create' })
  let revision = 1
  if (action === 'resume') { await h.manager.call('schedule.pause', { scheduleId: created.schedule.loopId, expectedRevision: revision++, operationId: 'setup-pause' }) }
  fail = true
  const request = { scheduleId: created.schedule.loopId, expectedRevision: revision, operationId: 'original-action' }
  await expect(h.manager.call(`schedule.${action}`, request)).rejects.toThrow('Core save unknown')
  await h.manager.stop()
  const restarted = h.reopen()
  const retried = await restarted.call(`schedule.${action}`, request)
  expect(retried.schedule.lastOutcome).toBeUndefined()
  expect(attempts).toBe(2)
  expect(retried.schedule.status).toBe(action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'stopped')
  expect(retried.schedule.revision).toBe(revision + 1)
})


describe('ended schedule boundary', () => {
  it.each(['calendar', 'relative'] as const)('keeps cancelled %s terminal through public and direct controls', async kind => {
    const saves: boolean[] = []
    const h = await owner(undefined, async (_loop, active) => { saves.push(active) })
    const timing = kind === 'calendar' ? { calendar: rules('daily') } : { afterMs: 90000 }
    const created = await h.manager.call('schedule.create', { target, ...timing, prompt: 'original', operationId: 'create' })
    const cancel = { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'cancel' }
    const ended = await h.manager.call('schedule.cancel', cancel)
    expect(validateScheduleRpcResult('schedule.cancel', ended, cancel)).toEqual(ended)
    for (const action of ['pause', 'resume'] as const) {
      await expect(h.manager.call(`schedule.${action}`, { scheduleId: created.schedule.loopId, expectedRevision: 2, operationId: action })).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
      await expect(h.manager[action](created.schedule.loopId)).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
      expect(h.manager.list()).toEqual([ended.schedule])
      expect(await h.reload()).toEqual([ended.schedule])
    }
    expect(saves).toEqual([true, false])
    await expect(h.manager.call('schedule.pause', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'stale' })).rejects.toMatchObject({ code: 'SCHEDULE_REVISION_CONFLICT' })
    await expect(h.manager.call('schedule.resume', cancel)).rejects.toMatchObject({ code: 'SCHEDULE_OPERATION_CONFLICT' })
    const retried = await h.manager.call('schedule.cancel', cancel)
    expect(retried).toEqual(ended); expect(saves).toEqual([true, false])
  })

  it.each(['pause', 'resume'] as const)('does not reapply an old %s operation after the exact schedule ended', async action => {
    const saves: boolean[] = []
    const h = await owner(undefined, async (_loop, active) => { saves.push(active) })
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'original', operationId: 'create' })
    const id = created.schedule.loopId
    if (action === 'resume') await h.manager.call('schedule.pause', { scheduleId: id, expectedRevision: 1, operationId: 'setup' })
    const request = { scheduleId: id, expectedRevision: action === 'resume' ? 2 : 1, operationId: 'original-' + action }
    await h.manager.call(`schedule.${action}`, request)
    await h.manager.stopLoop(id)
    const stopped = h.manager.list(), before = saves.slice()
    await expect(h.manager.call(`schedule.${action}`, request)).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
    expect(h.manager.list()).toEqual(stopped); expect(await h.reload()).toEqual(stopped); expect(saves).toEqual(before)
  })

  it.each(['calendar', 'relative'] as const)('rejects the original resume after a %s one-shot completes', async kind => {
    const saves: boolean[] = []; let inputs = 0
    const h = await owner(async () => { inputs++; return 'sent' }, async (_loop, active) => { saves.push(active) })
    const timing = kind === 'calendar' ? { calendar: rules('once', { date: _hygiene_fixtureCivil(12, 31) }) } : { afterMs: 90000 }
    const created = await h.manager.call('schedule.create', { target, ...timing, prompt: 'one input', operationId: 'create' })
    const id = created.schedule.loopId
    await h.manager.call('schedule.pause', { scheduleId: id, expectedRevision: 1, operationId: 'pause' })
    const request = { scheduleId: id, expectedRevision: 2, operationId: 'original-resume' }
    await h.manager.call('schedule.resume', request)
    h.set({ now: created.schedule.nextCheckAt }); await h.manager.check()
    const ended = h.manager.list(), before = saves.slice()
    expect(ended[0]).toMatchObject({ status: 'stopped', revision: 3, lastOutcome: 'sent', lastMutation: { operationId: 'original-resume' } })
    await expect(h.manager.call('schedule.resume', request)).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
    expect(h.manager.list()).toEqual(ended); expect(saves).toEqual(before)
    await h.manager.check(); expect(inputs).toBe(1)
  })

  it('keeps stopped when cancellation persistence fails, then converges the original cancel', async () => {
    const saves: boolean[] = []
    const h = await owner(undefined, async (_loop, active) => { saves.push(active) })
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'original', operationId: 'create' })
    const request = { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'original-cancel' }
    const save = vi.spyOn(h.store, 'save').mockRejectedValueOnce(new Error('private schedule persistence unavailable'))
    try {
      await expect(h.manager.call('schedule.cancel', request)).rejects.toThrow('persistence unavailable')
      expect(h.manager.list()[0]).toMatchObject({ status: 'stopped', revision: 2, lastMutation: { operationId: request.operationId } })
      await expect(h.manager.pause(created.schedule.loopId)).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
      const retried = await h.manager.call('schedule.cancel', request)
      expect(validateScheduleRpcResult('schedule.cancel', retried, request)).toEqual(retried)
      expect(retried.schedule).toMatchObject({ status: 'stopped', revision: 2 })
      expect(await h.reload()).toEqual([retried.schedule]); expect(saves).toEqual([true, false])
    } finally { save.mockRestore() }
  })

  it('keeps cancellation terminal when an earlier claim persistence later rejects', async () => {
    let inputs = 0
    const h = await owner(async () => { inputs++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'original', operationId: 'create' })
    const entered = deferred(), release = deferred(), originalSave = h.store.save.bind(h.store)
    let first = true
    const save = vi.spyOn(h.store, 'save').mockImplementation(async records => {
      if (first) { first = false; entered.resolve(); await release.promise; throw new Error('original claim save unavailable') }
      await originalSave(records)
    })
    try {
      h.set({ now: created.schedule.nextCheckAt })
      const checking = h.manager.check().then(() => undefined, error => error)
      await entered.promise
      await h.manager.call('schedule.cancel', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'cancel-during-save' })
      release.resolve(); expect(await checking).toMatchObject({ message: 'original claim save unavailable' })
      expect(h.manager.list()[0]).toMatchObject({ status: 'stopped', revision: 2 })
      expect((await h.reload())[0]).toMatchObject({ status: 'stopped', revision: 2 })
      await h.manager.check(); expect(inputs).toBe(0)
    } finally { release.resolve(); save.mockRestore() }
  })

  it.each([false, true])('keeps stopped through a late creation save (retry=%s)', async retry => {
    const entered = deferred(), release = deferred(), saves: boolean[] = []
    let attempts = 0, inactive = false
    const h = await owner(undefined, async (_loop, active) => {
      if (active && ++attempts === 1 && retry) throw new Error('first admission unknown')
      if (active) { entered.resolve(); await release.promise }
      saves.push(active); inactive = !active
    })
    const request = { target, calendar: rules('daily'), prompt: 'original', operationId: 'original-create' }
    if (retry) await expect(h.manager.call('schedule.create', request)).rejects.toThrow('first admission unknown')
    const creating = h.manager.call('schedule.create', request)
    await entered.promise
    const original = h.manager.list()[0]!
    await h.manager.call('schedule.cancel', { scheduleId: original.loopId, expectedRevision: 1, operationId: 'cancel' })
    release.resolve()
    expect((await creating).schedule).toMatchObject({ loopId: original.loopId, status: 'stopped', revision: 2, lastMutation: { operationId: 'cancel' } })
    expect((await h.reload())[0]).toMatchObject({ status: 'stopped', revision: 2 })
    expect(saves).toEqual(retry ? [false, false, true, false] : [false, true, false]); expect(inactive).toBe(true)
  })
})

describe('one-shot relative schedule', () => {
  it.each([90000, 300000])('freezes the original %ims deadline across duplicate creation, pause and overdue resume', async afterMs => {
    let calls = 0
    const h = await owner(async () => { calls++; return 'sent' })
    const request = { target, afterMs, prompt: 'original relative work', operationId: 'relative-create' }
    const receipt = await h.manager.call('schedule.create', request), due = receipt.schedule.nextCheckAt
    expect(validateScheduleRpcResult('schedule.create', receipt, request)).toEqual(receipt)
    expect(receipt.schedule).toMatchObject({ afterMs, revision: 1, status: 'active' })
    expect(receipt.schedule.calendar).toBeUndefined()
    h.set({ now: due - 1 }); await h.manager.checkNow(receipt.schedule.loopId); expect(calls).toBe(0)
    await h.manager.call('schedule.pause', { scheduleId: receipt.schedule.loopId, expectedRevision: 1, operationId: 'relative-pause' })
    h.set({ now: due + 12345 })
    const duplicate = await h.manager.call('schedule.create', request)
    expect(duplicate.schedule).toMatchObject({ loopId: receipt.schedule.loopId, nextCheckAt: due, status: 'paused', revision: 2 })
    await expect(h.manager.call('schedule.create', { ...request, afterMs: afterMs + 1 })).rejects.toMatchObject({ code: 'SCHEDULE_OPERATION_CONFLICT' })
    const resumed = await h.manager.call('schedule.resume', { scheduleId: receipt.schedule.loopId, expectedRevision: 2, operationId: 'relative-resume' })
    expect(resumed.schedule.nextCheckAt).toBe(due)
    expect((await h.store.load())[0]).toMatchObject({ afterMs, nextCheckAt: due, status: 'active' })
    await h.manager.check(); expect(calls).toBe(1)
    expect(h.manager.list()[0]).toMatchObject({ nextCheckAt: due, status: 'stopped', lastOutcome: 'sent', lastOccurrenceAt: due })
    await h.manager.check(due + afterMs * 3); expect(calls).toBe(1)
    await expect(h.manager.call('schedule.pause', { scheduleId: receipt.schedule.loopId, expectedRevision: 3, operationId: 'cannot-rearm-pause' })).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
    await expect(h.manager.call('schedule.resume', { scheduleId: receipt.schedule.loopId, expectedRevision: 3, operationId: 'cannot-repeat' })).rejects.toMatchObject({ code: 'SCHEDULE_CANCELLED' })
  })
  it.each(['occupied','working','permission','missing'] as const)('retains the original relative occurrence while %s', async blocked => {
    let calls = 0
    const h = await owner(async () => { calls++; return 'sent' })
    const receipt = await h.manager.call('schedule.create', { target, afterMs: 90000, prompt: 'relative', operationId: 'relative-blocked' })
    h.set({ now: receipt.schedule.nextCheckAt, [blocked]: true }); await h.manager.check()
    expect(calls).toBe(0); expect(h.manager.list()[0]).toMatchObject({ status: 'active', nextCheckAt: receipt.schedule.nextCheckAt })
    h.set({ [blocked]: false }); await h.manager.check()
    expect(calls).toBe(1); expect(h.manager.list()[0]!.status).toBe('stopped')
  })
  it('reconciles an unknown initial save without restarting its delay and preserves the exact saved record on reload', async () => {
    let saves = 0
    const h = await owner(undefined, async () => { if (++saves === 1) throw new Error('Original future intent unknown') })
    const request = { target, afterMs: 90000, prompt: 'relative', operationId: 'relative-unknown-create' }
    await expect(h.manager.call('schedule.create', request)).rejects.toThrow('future intent unknown')
    const original = (await h.store.load())[0]!
    h.set({ now: original.nextCheckAt + 5000 })
    const retried = await h.manager.call('schedule.create', request)
    expect(retried.schedule).toMatchObject({ loopId: original.loopId, nextCheckAt: original.nextCheckAt, revision: 1, status: 'active' })
    const reloaded = await h.reload()
    expect(reloaded).toEqual(h.manager.list())
  })
  it('isolates relative schedules from the original calendar and completion-driven interval', async () => {
    const h = await owner()
    const relative = (await h.manager.call('schedule.create', { target, afterMs: 90000, prompt: 'timer', operationId: 'relative' })).schedule
    const calendar = (await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'civil', operationId: 'civil' })).schedule
    const interval = await h.manager.create({ ...target, intervalMs: 60000, prompt: 'interval' })
    expect((await h.manager.call('schedule.list', { target })).schedules.map(loop => loop.loopId)).toEqual([relative.loopId, calendar.loopId])
    expect((await h.manager.call('schedule.inspect', { scheduleId: relative.loopId })).schedule).toEqual(relative)
    await h.manager.pauseTarget(target, 'Human input')
    expect(h.manager.list().map(loop => [loop.loopId, loop.status])).toEqual([[relative.loopId, 'active'], [calendar.loopId, 'active'], [interval.loopId, 'paused']])
  })
  it('rejects only invalid timing requests and unsafe computed deadlines without mutating existing arrangements', async () => {
    const h = await owner()
    const original = await h.manager.call('schedule.create', { target, afterMs: 90000, prompt: 'timer', operationId: 'valid' })
    for (const timing of [{}, { afterMs: 0 }, { afterMs: -1 }, { afterMs: 1.5 }, { afterMs: Infinity }, { afterMs: Number.MAX_SAFE_INTEGER + 1 }, { afterMs: 90000, calendar: rules('daily') }, { afterMs: 90000, checkIn: {} }]) {
      expect(() => parseScheduleRpcParams('schedule.create', { target, prompt: 'bad', operationId: 'bad', ...timing })).toThrow()
    }
    await expect(h.manager.call('schedule.create', { target, afterMs: Number.MAX_SAFE_INTEGER, prompt: 'overflow', operationId: 'overflow' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(h.manager.list()).toEqual([original.schedule])
    expect(() => parseScheduleRecord({ ...original.schedule, calendar: rules('daily') })).toThrow()
    expect(() => validateScheduleRpcResult('schedule.create', { ...original, schedule: { ...original.schedule, afterMs: 300000 } }, { target, afterMs: 90000, prompt: 'timer', operationId: 'valid' })).toThrow()
  })
})

describe('minute repeating schedule', () => {
  it('keeps the original future intent, collapses missed occurrences, and delivers repeated messages to the same target', async () => {
    const seen: ContinuousProgressLoop[] = []
    const h = await owner(async loop => { seen.push(structuredClone(loop)); return 'sent' })
    const request = { target, everyMs: 60_000, prompt: 'check the original task', operationId: 'repeat-original' }
    const created = await h.manager.call('schedule.create', request)
    const { loopId, nextCheckAt: due, futureIntentId } = created.schedule
    expect(created.schedule.everyMs).toBe(60_000)
    expect(validateScheduleRpcResult('schedule.create', created, request)).toEqual(created)
    h.set({ now: due, working: true }); await h.manager.check(due)
    expect(seen).toHaveLength(0)
    expect(h.manager.list()[0]!.nextCheckAt).toBe(due)
    h.set({ now: due + 120_000, working: false }); await h.manager.check(due + 120_000)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ ...target, prompt: request.prompt, futureIntentId, pendingCompletion: { futureIntent: { intentId: futureIntentId, occurrenceAt: due + 120_000 } } })
    expect(h.manager.list()[0]).toMatchObject({ loopId, status: 'active', nextCheckAt: due + 180_000, lastOccurrenceAt: due + 120_000 })
    expect(await h.reload()).toEqual(h.manager.list())
    const duplicate = await h.manager.call('schedule.create', request)
    expect(duplicate.schedule.loopId).toBe(loopId)
    await expect(h.manager.call('schedule.create', { ...request, everyMs: 120_000 })).rejects.toMatchObject({ code: 'SCHEDULE_OPERATION_CONFLICT' })
    h.set({ now: due + 180_000 }); await h.manager.check(due + 180_000)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.pendingCompletion!.futureIntent).toEqual({ intentId: futureIntentId, occurrenceAt: due + 180_000 })
  })
  it('retains an unknown occurrence and its original operation until explicit reconciliation', async () => {
    const operations: string[] = []
    const h = await owner(async (_loop, operation) => { operations.push(operation); return operations.length === 1 ? 'unknown' : 'sent' })
    const created = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'same message', operationId: 'repeat-unknown' })
    const due = created.schedule.nextCheckAt
    h.set({ now: due }); await h.manager.check(due)
    expect(h.manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', pendingCompletion: { operationId: operations[0], futureIntent: { occurrenceAt: due } } })
    h.set({ now: due + 600_000 }); await h.manager.check(due + 600_000)
    expect(operations).toHaveLength(1)
    await h.manager.call('schedule.resume', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'resume-repeat' })
    await h.manager.check(due + 600_000)
    expect(operations).toEqual([operations[0], operations[0]])
    expect(h.manager.list()[0]).toMatchObject({ status: 'active', nextCheckAt: due + 660_000, lastOccurrenceAt: due })
  })

  it.each(['terminal-confirmed', 'native-admitted', 'not-applied'] as const)('settles the original %s receipt after Host restart without sending it again', async delivery => {
    const dispatched = vi.fn<LoopTickHandler>().mockResolvedValueOnce('unknown').mockResolvedValue('sent')
    let foreign = true
    const read = vi.fn<NonNullable<FutureProgressInputOwner['inspectInput']>>(async loop => {
      const reference = loop.lastInputRef!
      return { reference: foreign ? { ...reference, preparedAt: reference.preparedAt + 1 } : reference, status: 'confirmed', delivery, nativeResult: { state: 'unknown' } }
    })
    const h = await owner(dispatched, undefined, undefined, read)
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'original', operationId: 'receipt-create' })
    const due = schedule.nextCheckAt
    h.set({ now: due }); await h.manager.check()
    const held = h.manager.list()[0]!
    expect(held.pendingCompletion).toBeDefined()
    expect(dispatched).toHaveBeenCalledTimes(1)
    await h.manager.stop()

    const restored = h.reopen()
    await restored.start()
    await restored.check()
    expect(read).toHaveBeenCalledOnce()
    expect(restored.list()[0]).toEqual(held)
    foreign = false
    h.set({ now: due + 1_000 })
    await restored.check()
    expect(dispatched).toHaveBeenCalledTimes(1)
    const applied = delivery !== 'not-applied'
    expect(restored.list()[0]).toMatchObject({ loopId: schedule.loopId, status: 'active', nextCheckAt: due + 60_000,
      lastInputRef: held.lastInputRef, lastOutcome: applied ? 'sent' : 'skipped' })
    expect(restored.list()[0]!.pendingCompletion).toBeUndefined()
    expect(restored.list()[0]!.lastOccurrenceAt).toBe(applied ? due : undefined)
    expect(await h.reload()).toEqual(restored.list())
    h.set({ now: due + 60_000 }); await restored.check()
    expect(dispatched).toHaveBeenCalledTimes(2)
    expect(dispatched.mock.calls[1]![1]).not.toBe(dispatched.mock.calls[0]![1])
  })

  it('keeps the user pause when the original receipt arrives after the pause', async () => {
    const dispatched = vi.fn<LoopTickHandler>().mockResolvedValue('unknown')
    const entered = deferred(), release = deferred()
    const h = await owner(dispatched, undefined, undefined, async loop => {
      entered.resolve(); await release.promise
      return { reference: loop.lastInputRef!, status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unknown' } }
    })
    const { schedule } = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'original', operationId: 'late-receipt' })
    h.set({ now: schedule.nextCheckAt }); await h.manager.check()
    const checking = h.manager.check()
    try {
      await entered.promise
      await h.manager.call('schedule.pause', { scheduleId: schedule.loopId, expectedRevision: 1, operationId: 'user-pause' })
    } finally { release.resolve(); await checking }
    expect(dispatched).toHaveBeenCalledOnce()
    expect((await h.reload())[0]).toMatchObject({ status: 'paused', pause: { reason: 'manual' }, revision: 2 })
  })

  it('lets a due arrangement of the same Agent send while an old receipt read is held', async () => {
    const dispatched = vi.fn<LoopTickHandler>().mockResolvedValueOnce('unknown').mockResolvedValue('sent')
    const entered = deferred(), release = deferred()
    const h = await owner(dispatched, undefined, undefined, async () => { entered.resolve(); await release.promise; return undefined })
    const first = (await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'first', operationId: 'inspect-held' })).schedule
    const second = (await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'second', operationId: 'independent-due' })).schedule
    h.set({ now: first.nextCheckAt }); await h.manager.check(first.nextCheckAt, first.loopId)
    const checking = h.manager.check()
    try {
      await entered.promise
      await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(2), { timeout: 500 })
      expect(dispatched.mock.calls[1]?.[0].loopId).toBe(second.loopId)
      expect(h.manager.inspectLoop(first.loopId)?.status).toBe('paused')
    } finally { release.resolve(); await checking }
  })

  it('allows the next scheduled follow-up when the previous one was explicitly not applied', async () => {
    const dispatched = vi.fn<LoopTickHandler>().mockResolvedValueOnce('unknown').mockResolvedValue('sent')
    const h = await owner(dispatched, undefined, undefined, async loop => ({
      reference: loop.lastInputRef!, status: 'confirmed', delivery: 'not-applied', nativeResult: { state: 'unknown' },
    }))
    const { schedule } = await h.manager.call('schedule.create', { target, calendar: rules('daily'), prompt: 'check the original work', operationId: 'followup-create',
      checkIn: { silenceMs: 18 * 3_600_000, minIntervalMs: 20 * 3_600_000, dailyBudget: 1, quiet: { start: _hygiene_fixtureClock(22, 0), end: _hygiene_fixtureClock(8, 0) } } }, { principal: { kind: 'user', id: 'original-human' } })
    const due = schedule.nextCheckAt
    h.set({ now: due }); await h.manager.check()
    expect(h.manager.inspectLoop(schedule.loopId)?.checkInState?.unanswered?.claimAt).toBe(due)
    await h.manager.check()
    const settled = h.manager.inspectLoop(schedule.loopId)!
    expect(settled.checkInState).toMatchObject({ lastClaimAt: due, budgetUsed: 1 })
    expect(settled.checkInState!.unanswered).toBeUndefined()
    h.set({ now: settled.nextCheckAt }); await h.manager.check()
    expect(dispatched).toHaveBeenCalledTimes(2)
    expect(h.manager.inspectLoop(schedule.loopId)?.lastOutcome).toBe('sent')
  })

  it('retains the original one-shot occurrence when the exact receipt confirms it was not applied', async () => {
    const dispatched = vi.fn<LoopTickHandler>().mockResolvedValue('unknown')
    const read = vi.fn(async (loop: ContinuousProgressLoop): Promise<ContinuousProgressInputReading> => ({
      reference: loop.lastInputRef!, status: 'confirmed', delivery: 'not-applied', nativeResult: { state: 'unknown' },
    }))
    const h = await owner(dispatched, undefined, undefined, read)
    const { schedule } = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original', operationId: 'one-shot-receipt' })
    h.set({ now: schedule.nextCheckAt }); await h.manager.check()
    const prior = h.manager.list()[0]
    await h.manager.check()
    expect(read).toHaveBeenCalledOnce()
    expect(dispatched).toHaveBeenCalledOnce()
    expect(h.manager.list()[0]).toEqual(prior)
  })
  it('rejects ambiguous or non-minute repetition at the public request boundary', () => {
    for (const timing of [{ everyMs: 59_999 }, { everyMs: 60_001 }, { everyMs: 0 }, { everyMs: 60_000, afterMs: 60_000 }, { everyMs: 60_000, calendar: rules('daily') }, { everyMs: 60_000, checkIn: {} }]) {
      expect(() => parseScheduleRpcParams('schedule.create', { target, prompt: 'x', operationId: 'x', ...timing })).toThrow()
    }
  })
})

describe('due busy schedule pre-observation', () => {
  it('rechecks the exact busy target without repeatedly claiming or writing and delivers once it is idle', async () => {
    let sent = 0
    const h = await owner(async () => { sent++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, everyMs: 60_000, prompt: 'original', operationId: 'busy-repeat' })
    const due = created.schedule.nextCheckAt
    const observe = vi.spyOn(h.manager as unknown as { observe: (...args: any[]) => Promise<any> }, 'observe')
    const writes = vi.spyOn(h.store, 'save').mockResolvedValue(undefined)
    h.set({ working: true })
    for (let seconds = 0; seconds < 600; seconds++) {
      const now = due + seconds * 1000; h.set({ now }); await h.manager.check(now)
    }
    expect(sent).toBe(0); expect(observe).toHaveBeenCalledTimes(600)
    expect(writes.mock.calls.length).toBeLessThanOrEqual(11)
    expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'active', lastOutcome: 'skipped', lastDecision: 'stale-working', nextCheckAt: due + 540_000 })
    expect(h.manager.list()[0]!.lastTickId).toBeUndefined()
    h.set({ now: due + 599_000, working: false }); await h.manager.check(due + 599_000)
    expect(sent).toBe(1)
    expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, lastOccurrenceAt: due + 540_000 })
  })
  it('does not claim or deliver after an explicit pause cancels an in-flight pre-observation', async () => {
    let sent = 0
    const h = await owner(async () => { sent++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original', operationId: 'pause-probe' })
    const entered = deferred(), release = deferred()
    const ports = h.manager as unknown as { observe: (...args: any[]) => Promise<any> }, original = ports.observe
    // Freeze the observed intent before pause; the delayed read must not share the fixture's mutable intent map.
    ports.observe = async (...args) => { const observation = structuredClone(await original(...args)); entered.resolve(); await release.promise; return observation }
    h.set({ now: created.schedule.nextCheckAt, working: true })
    const checking = h.manager.check(); await entered.promise
    await h.manager.call('schedule.pause', { scheduleId: created.schedule.loopId, expectedRevision: 1, operationId: 'pause-original' })
    release.resolve(); await checking
    expect(sent).toBe(0)
    expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'paused', nextCheckAt: created.schedule.nextCheckAt, lastDecision: 'Explicitly paused.', pause: { reason: 'manual', episodeId: expect.any(String), pausedAt: created.schedule.nextCheckAt } })
    expect(h.manager.list()[0]!.lastTickId).toBeUndefined()
  })
  it('checks only the requested loop and does not observe or mutate an unrelated due target', async () => {
    const h = await owner()
    const a = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'A', operationId: 'scoped-a' })
    const b = await h.manager.call('schedule.create', { target: { ...target, agentSessionId: 'other' }, afterMs: 60_000, prompt: 'B', operationId: 'scoped-b' })
    h.set({ now: a.schedule.nextCheckAt })
    const before = structuredClone(h.manager.list().find(loop => loop.loopId === b.schedule.loopId))
    const observe = vi.spyOn(h.manager as unknown as { observe: (...args: any[]) => Promise<any> }, 'observe')
    await h.manager.checkNow(a.schedule.loopId)
    expect(observe.mock.calls.length).toBeGreaterThan(0)
    expect(observe.mock.calls.every(call => call[0].loopId === a.schedule.loopId)).toBe(true)
    expect(h.manager.list().find(loop => loop.loopId === b.schedule.loopId)).toEqual(before)
  })
  it('rechecks input occupation after a ready pre-observation before attempting delivery', async () => {
    let sent = 0, calls = 0
    const h = await owner(async () => { sent++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original', operationId: 'input-changed' })
    const ports = h.manager as unknown as { observe: LoopObservationProvider }, original = ports.observe
    ports.observe = async (...args) => { const result = await original(...args); if (++calls === 1) h.set({ occupied: true }); return result }
    h.set({ now: created.schedule.nextCheckAt }); await h.manager.check()
    expect(calls).toBe(2); expect(sent).toBe(0)
    expect(h.manager.list()[0]).toMatchObject({ status: 'active', nextCheckAt: created.schedule.nextCheckAt, lastDecision: 'user-input-changed' })
  })
  it('keeps the original failure and due eligibility if the pre-observation fails', async () => {
    let sent = 0
    const h = await owner(async () => { sent++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original', operationId: 'observation-failed' })
    const ports = h.manager as unknown as { observe: LoopObservationProvider }
    ports.observe = async () => { throw new Error('original observation unavailable') }
    h.set({ now: created.schedule.nextCheckAt }); await h.manager.check()
    expect(sent).toBe(0)
    expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'active', lastOutcome: 'skipped', nextCheckAt: created.schedule.nextCheckAt, lastDecision: 'original observation unavailable' })
    expect(await h.reload()).toEqual(h.manager.list())
  })
  it('restores the same due schedule after Host restart and delivers when the Agent is idle', async () => {
    let sent = 0
    const h = await owner(async () => { sent++; return 'sent' })
    const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original', operationId: 'busy-restart' })
    const due = created.schedule.nextCheckAt
    h.set({ now: due, working: true }); await h.manager.check(due)
    expect((await h.reload())[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'active', nextCheckAt: due, lastOutcome: 'skipped' })
    await h.manager.stop()
    const ports = h.manager as unknown as { observe: LoopObservationProvider; futureInputs: FutureProgressInputOwner }
    const restarted = new ContinuousProgressLoopManager(h.store, async () => { sent++; return 'sent' }, () => due + 1000, ports.observe, ports.futureInputs)
    managers.push(restarted); await restarted.start()
    h.set({ now: due + 1000, working: false }); await restarted.check(due + 1000)
    expect(sent).toBe(1)
    expect(restarted.list()[0]).toMatchObject({ loopId: created.schedule.loopId, nextCheckAt: due, status: 'stopped', lastOccurrenceAt: due })
  })
})

describe('independent due targets', () => {
  it('delivers ready A while a later B observation remains blocked', async () => {
    const sent: string[] = [], entered = deferred(), release = deferred()
    const h = await owner(async loop => { sent.push(loop.agentSessionId); return 'sent' })
    const a = () => h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'A', operationId: 'counter-a' })
    const b = () => h.manager.call('schedule.create', { target: { ...target, agentSessionId: 'other' }, afterMs: 60_000, prompt: 'B', operationId: 'counter-b' })
    const first = await a(); await b()
    const ports = h.manager as unknown as { observe: (...args: any[]) => Promise<any> }, original = ports.observe
    ports.observe = async (...args) => { if (args[0].agentSessionId === 'other') { entered.resolve(); await release.promise }; return await original(...args) }
    h.set({ now: first.schedule.nextCheckAt })
    const checking = h.manager.check()
    try {
      await entered.promise
      await vi.waitFor(() => expect(sent).toContain(target.agentSessionId))
    } finally { release.resolve(); await checking }
    expect(sent).toContain(target.agentSessionId)
  })
})

it('keeps a later due schedule unchanged when it is cancelled while an earlier target is delivering', async () => {
  const entered = deferred(), release = deferred(), seen: string[] = []
  const h = await owner(async loop => {
    seen.push(loop.agentSessionId)
    if (loop.agentSessionId === target.agentSessionId) { entered.resolve(); await release.promise }
    return 'sent'
  })
  const a = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'A', operationId: 'before-a' })
  const b = await h.manager.call('schedule.create', { target: { ...target, agentSessionId: 'other' }, everyMs: 60_000, prompt: 'B', operationId: 'cancel-b' })
  const now = a.schedule.nextCheckAt + 120_000
  h.set({ now })
  const checking = h.manager.check(now); await entered.promise
  const cancelled = await h.manager.call('schedule.cancel', { scheduleId: b.schedule.loopId, expectedRevision: 1, operationId: 'cancel-original-b' })
  release.resolve(); await checking
  expect(seen).toEqual([target.agentSessionId])
  expect(h.manager.list().find(loop => loop.loopId === b.schedule.loopId)).toEqual(cancelled.schedule)
  expect((await h.reload()).find(loop => loop.loopId === b.schedule.loopId)).toEqual(cancelled.schedule)
})

it.each(['occupied', 'permission'] as const)('preserves the original due and avoids repeated writes while %s remains confirmed', async blocked => {
  let sent = 0
  const h = await owner(async () => { sent++; return 'sent' })
  const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'same original message', operationId: 'held-' + blocked })
  const due = created.schedule.nextCheckAt, writes = vi.spyOn(h.store, 'save').mockResolvedValue(undefined)
  h.set({ [blocked]: true })
  for (let seconds = 0; seconds < 120; seconds++) {
    const now = due + seconds * 1000; h.set({ now }); await h.manager.check(now)
  }
  expect(sent).toBe(0); expect(writes).toHaveBeenCalledTimes(1)
  expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'active', nextCheckAt: due, lastOutcome: 'skipped', lastDecision: blocked === 'occupied' ? 'user-input-changed' : 'interaction-pending' })
  h.set({ [blocked]: false }); await h.manager.check(due + 119_000)
  expect(sent).toBe(1)
  expect(h.manager.list()[0]).toMatchObject({ loopId: created.schedule.loopId, status: 'stopped', lastOccurrenceAt: due })
})

it('does not clone unrelated large due schedules while explicitly rechecking one unchanged busy target', async () => {
  const h = await owner()
  const created = await h.manager.call('schedule.create', { target, afterMs: 60_000, prompt: 'original A', operationId: 'bounded-a' })
  const scheduler = (h.manager as unknown as { scheduler: import('@agentmux/core').ContinuousProgressScheduler }).scheduler
  const [original] = h.manager.list()
  const unrelated = Array.from({ length: 256 }, (_, i) => ({ ...original!, loopId: `unrelated-${i}`, agentSessionId: `other-${i}`, prompt: 'unrelated large body '.repeat(800) }))
  scheduler.restore([original!, ...unrelated])
  vi.spyOn(h.store, 'save').mockResolvedValue(undefined)
  h.set({ now: created.schedule.nextCheckAt, working: true })
  await h.manager.checkNow(created.schedule.loopId)
  const cloned = vi.spyOn(globalThis, 'structuredClone')
  try {
    await h.manager.checkNow(created.schedule.loopId)
    expect(cloned.mock.calls.length).toBeGreaterThan(0)
    const containsUnrelated = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      if (Array.isArray(value)) return value.some(containsUnrelated)
      return typeof (value as { loopId?: unknown }).loopId === 'string' && (value as { loopId: string }).loopId.startsWith('unrelated-')
    }
    expect(cloned.mock.calls.some(([value]) => containsUnrelated(value))).toBe(false)
  } finally { cloned.mockRestore() }
  expect(scheduler.get('unrelated-255')).toEqual(unrelated[255])
})
