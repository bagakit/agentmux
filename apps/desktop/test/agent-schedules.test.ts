import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { nextCalendarOccurrence, latestCalendarOccurrence } from '../src/main/agent-schedule-calendar.js'
import { ContinuousProgressLoopManager, type LoopTickHandler } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { observeAgent, type ContinuousProgressLoop, type AgentMuxRpcCallContext } from '@agentmux/core'
import { parseAgentScheduleCalendar, type AgentScheduleCalendar } from '../../../packages/core/src/agent-schedule.js'
import { validateScheduleRpcResult } from '../../../packages/core/src/public-rpc-schedules.js'

const rules = (kind: AgentScheduleCalendar['kind'], fields: Partial<AgentScheduleCalendar> = {}): AgentScheduleCalendar => ({ kind, timezone: 'UTC', time: _hygiene_fixtureClock(9, 30), policies: { gap: 'skip', fold: 'earlier', monthEnd: 'clamp', overdue: 'latest' }, ...fields })
const target = { hostId: 'local', agentSessionId: 'agent', providerId: 'generic', workspacePath: _hygiene_fixturePath("repo") }
const stamp = (text: string) => Date.parse(text)
const managers: ContinuousProgressLoopManager[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.stop())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function owner(onTick: LoopTickHandler = async () => 'sent', save = async (_loop: ContinuousProgressLoop, _active: boolean, _context?: AgentMuxRpcCallContext) => {}, authorize = async () => {}) {
  const dir = await mkdtemp(_hygiene_fixturePath("tmp/am-schedule-unit-")); dirs.push(dir)
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
  const intents: Record<string, { operationId: string; prompt: string; message: { userContent: string }; active: boolean }> = {}
  let now = stamp(_hygiene_fixtureIso(24134400000, "second")), occupied = false, working = false, permission = false, missing = false
  const manager = new ContinuousProgressLoopManager(store, onTick, () => now, async (loop, tickId) => {
    const status = { state: working ? 'working' as const : 'done' as const, source: 'native-hook' as const, observedAt: 1 }
    return { session: { ...target, run: { runId: 'run' }, promptCompletionAdmission: { submissionId: 'old-input', completionId: '["run",1]', operationId: 'old-input', startByte: 0, endByte: 1 }, semanticStatus: status, futurePromptIntents: intents, ...(permission ? { pendingInteraction: {} as never } : {}) },
      observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: permission, terminalCapabilityUnverified: false }, now), inputOccupied: occupied, inputByte: missing ? null : 0, tickId, now }
  }, { saveFutureIntent: async (loop, active, context) => { await save(loop, active, context); intents[loop.futureIntentId!] = { operationId: loop.creationOperationId!, prompt: loop.prompt, message: { userContent: loop.prompt }, active } }, authorizeFutureIntent: authorize })
  managers.push(manager)
  return { manager, store, set: (values: { now?: number; occupied?: boolean; working?: boolean; permission?: boolean; missing?: boolean }) => { if (values.now !== undefined) now = values.now; if (values.occupied !== undefined) occupied = values.occupied; if (values.working !== undefined) working = values.working; if (values.permission !== undefined) permission = values.permission; if (values.missing !== undefined) missing = values.missing } }
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
    expect(calls.map(call => call.active)).toEqual([true, true]); expect(calls.every(call => call.context === context)).toBe(true)
    await h.manager.call('schedule.pause', { scheduleId: original.loopId, expectedRevision: 1, operationId: 'pause' }, context)
    const duplicate = await h.manager.call('schedule.create', request, context)
    expect(duplicate.schedule.status).toBe('paused'); expect(calls.at(-1)!.active).toBe(false)
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
  const retried = await h.manager.call(`schedule.${action}`, request)
  expect(attempts).toBe(2)
  expect(retried.schedule.status).toBe(action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'stopped')
  expect(retried.schedule.revision).toBe(revision + 1)
})
