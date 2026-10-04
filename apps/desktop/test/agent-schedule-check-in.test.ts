import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { observeAgent, type AgentTimelineSnapshot, type AgentSessionHistoryPage, type ContinuousProgressLoop, type AgentMuxRpcCallContext } from '@agentmux/core'
import { DEFAULT_AGENT_SCHEDULE_CHECK_IN, AGENT_SCHEDULE_CHECK_IN_GUIDANCE } from '@agentmux/core/schedule'
import { checkInHumanObservation, decideCheckIn, type CheckInObservation } from '../src/main/agent-schedule-check-in'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'

const at = (time: string) => Date.parse(time), day = at(_hygiene_fixtureIso(24138000000, "minute")), target = { hostId: 'local', agentSessionId: 'check-in-agent', providerId: 'generic', workspacePath: _hygiene_fixturePath("repo") }
const policy = DEFAULT_AGENT_SCHEDULE_CHECK_IN
const calendar = { kind: 'daily' as const, timezone: 'UTC', time: _hygiene_fixtureClock(9, 30), policies: { gap: 'skip' as const, fold: 'earlier' as const, monthEnd: 'clamp' as const, overdue: 'latest' as const } }
const context: AgentMuxRpcCallContext = { principal: { kind: 'user', id: 'actual-private-local-user' }, transport: 'unix' }
const marker = (id = 'original-human', createdAt = day - 19 * 3_600_000): AgentTimelineSnapshot['items'][number] => ({ id, agentSessionId: target.agentSessionId, kind: 'user_message', status: 'complete', source: 'user', createdAt, updatedAt: createdAt, title: 'Real captured input', content: 'Review the original design decision.', authorHuman: true })
const timeline = (items = [marker()]): AgentTimelineSnapshot => ({ agentSessionId: target.agentSessionId, revision: 1, items })
const page = (items: AgentSessionHistoryPage['items'] = []): AgentSessionHistoryPage => ({ agentSessionId: target.agentSessionId, source: { providerId: target.providerId, nativeSessionId: 'native-original' }, items, nextCursor: null, sourceSizeBytes: 100 })
const observed: CheckInObservation = { known: true, human: { id: 'original-human', createdAt: marker().createdAt } }
const base = (): ContinuousProgressLoop => ({ ...target, loopId: 'loop', intervalMs: 1000, calendar, checkIn: policy, prompt: 'Original editable topic', status: 'active', nextCheckAt: day + 1_800_000 })
const managers: ContinuousProgressLoopManager[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.stop())); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function owner() {
  const dir = await mkdtemp(_hygiene_fixturePath("tmp/am-checkin-")); dirs.push(dir)
  const store = new ContinuousProgressLoopStore(join(dir, 'loops.json')), inputs: ContinuousProgressLoop[] = []
  let now = day, occupied = false, observation: CheckInObservation = observed, observedCalls = 0, unknown = false, finalInputOccupied = false
  const intents: Record<string, { operationId: string; prompt: string; message: { userContent: string }; active: boolean }> = {}
  const progress = async (_loop: typeof target, tickId: string) => {
    const status = { state: 'done' as const, source: 'native-hook' as const, observedAt: now }
    return { session: { ...target, kind: 'agent' as const, executorId: target.providerId, retiredRuns: [], createdAt: 1, updatedAt: 1, run: { runId: 'original-run' }, futurePromptIntents: intents, semanticStatus: status }, observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now), inputByte: 10, inputOccupied: occupied, now, tickId }
  }
  const manager = new ContinuousProgressLoopManager(store, async (loop, operationId, isCurrent, signal) => {
    if (finalInputOccupied) return await deliverContinuousProgress({ observeContinuousProgress: async (...args) => ({ ...await progress(args[0], args[1]), inputOccupied: true }), submitPrompt: async () => { inputs.push(loop) } }, loop, operationId, isCurrent, signal)
    inputs.push(loop); return unknown ? 'unknown' : 'sent'
  }, () => now, progress, { saveFutureIntent: async (loop, active) => { intents[loop.futureIntentId!] = { operationId: loop.creationOperationId!, prompt: loop.prompt, message: { userContent: loop.prompt }, active } }, observeCheckIn: async () => { observedCalls++; return observation } })
  managers.push(manager)
  const create = (operationId = 'checkin-create', checkIn = true, actor: AgentMuxRpcCallContext | undefined = context) => manager.call('schedule.create', { target, calendar, prompt: 'Original editable topic', operationId, ...(checkIn ? { checkIn: policy } : {}) }, actor)
  return { manager, store, inputs, create, set: (change: { now?: number; occupied?: boolean; observation?: CheckInObservation; unknown?: boolean; finalInputOccupied?: boolean }) => { if (change.now !== undefined) now = change.now; if (change.occupied !== undefined) occupied = change.occupied; if (change.observation !== undefined) observation = change.observation; if (change.unknown !== undefined) unknown = change.unknown; if (change.finalInputOccupied !== undefined) finalInputOccupied = change.finalInputOccupied }, observedCalls: () => observedCalls }
}

describe('quiet follow-up trusted context', () => {
  it('accepts only the exact completed captured human marker with a full current source', () => {
    expect(checkInHumanObservation(target.agentSessionId, timeline(), page(), day)).toEqual(observed)
    for (const changed of [{ authorHuman: false }, { authorAgentSessionId: 'an-agent' }, { status: 'streaming' as const }, { agentSessionId: 'another-agent' }]) {
      expect(checkInHumanObservation(target.agentSessionId, timeline([{ ...marker(), ...changed }]), page(), day).known).toBe(false)
    }
  })
  it('does not promote bounded coverage, later native unknown input or a later edit into silence or a reply', () => {
    expect(checkInHumanObservation(target.agentSessionId, timeline(), { ...page(), nextCursor: 'earlier' }, day).known).toBe(false)
    const { sourceSizeBytes: _, ...noExtent } = page()
    expect(checkInHumanObservation(target.agentSessionId, timeline(), noExtent, day).known).toBe(false)
    const old = { ...marker(), updatedAt: day }
    expect(checkInHumanObservation(target.agentSessionId, timeline([old]), page([{ id: 'unknown-native', kind: 'user-message', startedAt: old.createdAt + 1, contentParts: [{ kind: 'text', text: old.content! }] }]), day).known).toBe(false)
    expect(checkInHumanObservation(target.agentSessionId, timeline(), page([{ id: 'missing-time', kind: 'user-message', contentParts: [] }]), day).known).toBe(false)
    const { authorHuman: __, ...noAuthor } = marker('arrived-during-await', day + 1)
    for (const author of [{}, { authorHuman: true }, { authorAgentSessionId: 'later-agent' }]) expect(checkInHumanObservation(target.agentSessionId, timeline([marker(), { ...noAuthor, ...author }]), page(), day).known).toBe(false)
  })
  it('simultaneously enforces quiet time, silence, minimum interval and civil budget', () => {
    expect(decideCheckIn(base(), observed, day).send).toBe(true)
    expect(decideCheckIn(base(), observed, at(_hygiene_fixtureIso(24186600000, "minute"))).reason).toContain('quiet period')
    expect(decideCheckIn(base(), { known: true, human: { id: 'new-human', createdAt: day - 1000 } }, day).reason).toContain('silence interval')
    expect(decideCheckIn({ ...base(), checkInState: { lastClaimAt: day - 1000 } }, observed, day).reason).toContain('minimum')
    expect(decideCheckIn({ ...base(), checkInState: { budgetDate: _hygiene_fixtureCivil(10, 7), budgetUsed: 1 } }, observed, day).reason).toContain('budget')
    expect(decideCheckIn({ ...base(), calendar: { ...calendar, timezone: 'Asia/Shanghai' } }, observed, at(_hygiene_fixtureIso(24159600000, "minute"))).send).toBe(false)
  })
  it('requires a distinct genuine later human input to clear the unanswered question', () => {
    const state = decideCheckIn(base(), observed, day).state
    for (const human of [{ id: 'original-human', createdAt: day + 1 }, { id: 'older-human', createdAt: day - 1 }]) expect(decideCheckIn({ ...base(), checkInState: state }, { known: true, human }, day + 86_400_000).send).toBe(false)
    expect(decideCheckIn({ ...base(), checkInState: state }, { known: false, reason: 'Unknown native author' }, day + 86_400_000).send).toBe(false)
    expect(decideCheckIn({ ...base(), checkInState: state }, { known: true, human: { id: 'genuine-reply', createdAt: day + 3_600_000 } }, day + 86_400_000).send).toBe(true)
  })
})
describe('quiet follow-up original owner', () => {
  it('requires transport opt-in and prevents managed callers or a second arrangement from inventing permission', async () => {
    const h = await owner()
    await expect(h.create('untrusted', true, {})).rejects.toMatchObject({ code: 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED' })
    await expect(h.create('managed', true, { ...context, caller: { agentSessionId: target.agentSessionId, capability: 'not-a-human-marker' } })).rejects.toMatchObject({ code: 'SCHEDULE_CHECK_IN_OPT_IN_REQUIRED' })
    expect(h.manager.list()).toHaveLength(0)
    await h.create()
    await expect(h.create('second-checkin')).rejects.toMatchObject({ code: 'SCHEDULE_CHECK_IN_EXISTS' })
    expect(h.manager.list()).toHaveLength(1)
  })
  it('keeps follow-up off by default and performs no conversation observation for ordinary arrangements', async () => {
    const h = await owner(), created = await h.create('ordinary', false)
    h.set({ now: created.schedule.nextCheckAt }); await h.manager.check()
    expect(h.inputs).toHaveLength(1); expect(h.observedCalls()).toBe(0)
    expect(h.inputs[0]!.pendingCompletion!.agentMuxNote).not.toContain(AGENT_SCHEDULE_CHECK_IN_GUIDANCE)
  })
  it('does not consume an occurrence or budget while facts or input occupancy are unknown', async () => {
    const h = await owner(), created = await h.create(), due = created.schedule.nextCheckAt
    h.set({ now: due, occupied: true }); await h.manager.check()
    expect(h.observedCalls()).toBe(0); expect(h.manager.list()[0]!.checkInState).toBeUndefined()
    h.set({ occupied: false, observation: { known: false, reason: 'Current native source unconfirmed' } }); await h.manager.check()
    const preserved = h.manager.list()[0]!
    expect(h.inputs).toHaveLength(0); expect(preserved.nextCheckAt).toBe(due); expect(preserved.checkInState?.budgetUsed).toBeUndefined(); expect(preserved.pendingCompletion).toBeUndefined(); expect(preserved.status).toBe('active')
    expect(preserved.lastDecision).toContain('source unconfirmed')
  })
  it('persists one original claim, frozen guidance and unanswered suppression through unknown retry and independent manager recovery', async () => {
    const h = await owner(), created = await h.create(); h.set({ now: created.schedule.nextCheckAt, unknown: true }); await h.manager.check()
    const frozen = h.manager.list()[0]!, claim = frozen.pendingCompletion!
    expect(frozen.checkInState).toMatchObject({ budgetUsed: 1, unanswered: { humanId: 'original-human' } })
    expect(claim.agentMuxNote).toContain(AGENT_SCHEDULE_CHECK_IN_GUIDANCE)
    await h.manager.stop()
    let input: ContinuousProgressLoop | undefined
    const recovered = new ContinuousProgressLoopManager(h.store, async loop => { input = loop; return 'sent' }, () => frozen.nextCheckAt, async () => { throw new Error('Unknown original operation must not read or mint a new intent') }, { saveFutureIntent: async () => {} })
    managers.push(recovered); await recovered.start(); await recovered.call('schedule.resume', { scheduleId: frozen.loopId, expectedRevision: 1, operationId: 'resume-original' }, context); await recovered.check()
    expect(input!.pendingCompletion).toEqual(claim); expect(input!.checkInState).toEqual(frozen.checkInState)
    expect(recovered.list()[0]!.checkInState?.budgetUsed).toBe(1)
  })
  it('clears unanswered after the real final delivery input fence skips with zero Input and preserves the due occurrence', async () => {
    const h = await owner(), created = await h.create(), due = created.schedule.nextCheckAt
    h.set({ now: due, finalInputOccupied: true }); await h.manager.check()
    const skipped = h.manager.list()[0]!
    expect(h.inputs).toHaveLength(0); expect(h.observedCalls()).toBe(1)
    expect(skipped.lastOutcome).toBe('skipped'); expect(skipped.nextCheckAt).toBe(due); expect(skipped.pendingCompletion).toBeUndefined()
    expect(skipped.checkInState?.budgetUsed).toBe(1); expect(skipped.checkInState?.unanswered).toBeUndefined()
    expect(skipped.lastDecision).toContain('This follow-up was not delivered')
  })
})
