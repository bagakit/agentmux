import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { DemandDelegationIntent } from '@agentmux/demand/delegations'
import type { GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { goalTickets } from '../../../packages/demand/test/helpers/goal-tickets.js'
import { ContinuousProgressLoopManager } from '../../host/src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../../host/src/continuous-progress-loop-store.js'
import { deliverContinuousProgress } from '../../host/src/continuous-progress-delivery.js'
import { createGoalRuntime } from '../../host/src/goal-runtime.js'
import { injectedContextCore } from './helpers/injected-context-core.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const supervisor = { kind: 'agent' as const, id: 'supervisor' }
const criteria = [{ id: 'accepted', text: 'The original criterion' }]
const node = (id: string, patch: Partial<GoalPlanNodeInput> = {}): GoalPlanNodeInput => ({ id, title: id, outcome: `Read the original body of ${id}`, check: `check ${id}`,
  criterionIds: ['accepted'], dependsOn: [], executor: { hostId: 'worker-host', agentSessionId: 'worker' }, ...patch })
const task = (nodeId: string): DemandDelegationIntent => ({ operationId: `delegate-${nodeId}`, sourceMessageId: `source-${nodeId}`, threadId: `thread-${nodeId}`,
  hostId: 'local', workerHostId: 'worker-host', ownerAgentSessionId: 'supervisor', ownerRunId: 'original-run', workerAgentSessionId: 'worker', workerRunId: 'worker-run',
  text: `Original task body ${nodeId}`, alignmentRevision: 1, criterionIds: ['accepted'], planNodeId: nodeId })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-plan-continuation-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let now = Date.now(), beforeObserve: (() => Promise<void>) | undefined
  const native = await injectedContextCore(root, { kind: 'agent', agentSessionId: 'supervisor', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: now - 1000, updatedAt: now - 1000,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: now - 1000 },
    terminalPromptReadiness: { source: 'native-stop', id: 'original-completion', run: { runId: 'original-run' }, observedAt: now - 1000, outputCursorBytes: 0, readyThroughByte: 0 } })
  cleanup.push(native.dispose)
  vi.spyOn((native.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const runtime = createGoalRuntime({ clients: () => [{ hostId: 'local', client: native.core }], inputOccupied: async () => false,
    checkIn: async () => ({ known: false, reason: 'This original Goal is not a check-in schedule.' }) })
  const tickets = goalTickets(join(root, 'goals')), goals = tickets.store
  await seedStoredDemand(goals, { id: 'goal', title: 'Original Goal', status: 'in_progress', sessionIds: ['supervisor', 'worker', 'reviewer'], assigneeSessionIds: ['supervisor', 'worker', 'reviewer'], supervisorSessionId: 'supervisor' })
  await goals.proposeAlignment('goal', { summary: 'Original scope', criteria, openQuestions: [] }); await goals.confirmAlignment('goal', 1)
  const loops = new ContinuousProgressLoopStore(join(root, 'loops.json'))
  const loop: ContinuousProgressLoop = { loopId: 'original-loop', creationOperationId: 'original-start', revision: 1, hostId: 'local', agentSessionId: 'supervisor', providerId: 'codex', workspacePath: root,
    intervalMs: 60_000, nextCheckAt: now, status: 'active', prompt: 'Original no-plan continuation body\r\n ', taskSource: { kind: 'goal', goalId: 'goal', alignmentRevision: 1 },
    initialDelivery: { operationId: 'original-start', startedAt: now - 1000, state: 'confirmed', prompt: 'Original first input', condition: { expectedRun: { runId: 'original-run' }, afterSubmissionId: null } } }
  await loops.save([loop])
  const read = vi.fn((id: string) => goals.get(id)), originalSubmit = runtime.submitPrompt, submitted = vi.spyOn(runtime, 'submitPrompt')
  const manager = new ContinuousProgressLoopManager(loops, (...args) => deliverContinuousProgress(runtime, ...args), () => now,
    async (saved, tickId, at, signal) => { const action = beforeObserve; beforeObserve = undefined; await action?.(); return runtime.observeContinuousProgress(saved, tickId, at, signal) },
    undefined, { read, inspectInitial: async () => 'confirmed',
      subscribe: listener => goals.subscribe((snapshot, _ids, changes) => listener(changes, snapshot.revision, snapshot.demands)) })
  cleanup.push(() => manager.stop()); await manager.start()
  const revise = async (nodes: GoalPlanNodeInput[]) => { const original = await goals.get('goal'); return tickets.revise('goal', { operationId: `plan-${(original!.plan?.revision ?? 0) + 1}`, expectedRevision: original!.plan?.revision ?? 0, alignmentRevision: 1, nodes }, supervisor) }
  const report = async (id: string, verdict?: 'pass' | 'changes') => {
    const original = task(id)
    const submitted = await tickets.submit('goal', original.operationId, { operationId: `report-${id}`, replyMessageId: `reply-${id}`, authorAgentSessionId: 'worker',
      grounding: { alignmentRevision: 1, summary: `Delivered ${id}`, checks: [{ criterionId: 'accepted', outcome: 'met', evidence: [`logs/${id}.log`], note: '' }] } }, 'worker')
    const deliveryHash = submitted.demand.delegations?.find(entry => entry.operationId === original.operationId)?.report?.delivery?.hash
    if (verdict) await tickets.review('goal', { operationId: `review-${id}`, nodeId: id, delegationOperationId: original.operationId, verdict, ...(deliveryHash ? { deliveryHash } : {}),
      check: { command: `check ${id}`, result: 'Actual result', evidence: [`checks/${id}.log`] }, note: verdict === 'changes' ? 'Return this change on the original thread.' : '' }, { kind: 'agent', id: 'reviewer' })
    return deliveryHash
  }
  const delegate = async (id: string, linked = true) => { const original = { ...task(id), planNodeId: tickets.id(id) }; await goals.prepareDelegation('goal', original, 'supervisor'); if (linked) await goals.linkDelegation('goal', original.operationId, original.sourceMessageId, 'supervisor') }
  return { native, runtime, goals, loops, manager, read, submitted, originalSubmit, loop, revise, delegate, report, ticketId: tickets.id, observeAfter: (action: () => Promise<void>) => { beforeObserve = action }, advance: () => { now += 60_000 } }
}
function handoff(prompt: string) { return JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2)) }

it('a real planned tick reaches Core as a manager with every open node and its original thread', async () => {
  const f = await fixture(), ready = Array.from({ length: 40 }, (_, i) => node(`ready-${i}`))
  await f.revise([...ready, node('working'), node('review'), node('changes'), node('unknown'), node('done'), node('waiting', { dependsOn: ['working'] }), node('cancelled', { cancelled: true })])
  for (const id of ['working', 'review', 'changes', 'done']) await f.delegate(id)
  await f.delegate('unknown', false); const deliveryHash = await f.report('review'); await f.report('changes', 'changes'); await f.report('done', 'pass')
  await f.manager.check()
  expect(f.manager.list()[0]).toMatchObject({ lastOutcome: 'sent', lastCompletionId: expect.any(String) })
  expect(f.read).toHaveBeenCalledWith('goal'); expect(f.read.mock.calls.every(([id]) => id === 'goal')).toBe(true); expect(f.submitted).toHaveBeenCalledOnce()
  const [target, prompt, operationId, , , , , guidance] = f.submitted.mock.calls[0]!
  expect(target).toMatchObject({ agentSessionId: 'supervisor', run: { runId: 'original-run' } })
  expect(guidance).toContain('Goal role: manager'); expect(guidance).toContain('"operationId":' + JSON.stringify(operationId))
  expect(prompt).toContain('Read amux goal plan active --goal "goal"'); expect(prompt).not.toContain('Read the original body of')
  const frozen = handoff(prompt)
  expect(frozen).toMatchObject({ schema: 'agentmux.goal-plan-continuation.v1', goalId: 'goal', alignmentRevision: 1, planRevision: 1 })
  expect(frozen.nodes.map((item: { id: string; state: string }) => [item.id, item.state])).toEqual([...ready.map(item => [f.ticketId(item.id), 'ready']), ...['working', 'review', 'changes', 'unknown'].map(id => [f.ticketId(id), id])])
  expect(frozen.nodes.at(-1)).toEqual({ id: f.ticketId('unknown'), state: 'unknown', executor: { hostId: 'worker-host', agentSessionId: 'worker' }, unknown: ['dispatch-link'],
    next: { kind: 'reconcile', reasons: ['dispatch-link'] },
    attempt: { delegationOperationId: 'delegate-unknown', sourceMessageId: 'source-unknown', threadId: 'thread-unknown', workerHostId: 'worker-host', workerAgentSessionId: 'worker' } })
  expect(deliveryHash).toMatch(/^[a-f0-9]{64}$/u)
  expect(frozen.nodes.find((node: { id: string }) => node.id === f.ticketId('review'))?.next,
    'a scheduled review names the precise original delivery').toEqual({ kind: 'review', delegationOperationId: 'delegate-review', deliveryHash })
  expect(frozen.nodes[0]?.next).toEqual({ kind: 'dispatch', executor: ready[0]!.executor, predecessors: [] })
  const original = await f.native.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'supervisor', expectedRun: { runId: 'original-run' }, submissionId: operationId })
  expect(original?.admission).toMatchObject({ acknowledged: true, intent: { message: { userContent: prompt, systemContext: guidance } } })
  expect(f.native.writes.length).toBeGreaterThan(0); expect(f.native.start).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
})

it('one new tick freezes the same Goal snapshot that decided to continue', async () => {
  const f = await fixture(); await f.revise([node('original-ready')])
  f.observeAfter(async () => { await f.revise([node('original-ready', { cancelled: true }), node('newer-ready')]) })
  await f.manager.check()
  expect(f.read).toHaveBeenCalledWith('goal'); expect(f.read.mock.calls.every(([id]) => id === 'goal')).toBe(true); expect(f.submitted).toHaveBeenCalledOnce()
  expect(handoff(f.submitted.mock.calls[0]![1])).toMatchObject({ planRevision: 1, nodes: [{ id: f.ticketId('original-ready'), state: 'ready' }] })
  expect((await f.goals.get('goal'))!.plan!.revision).toBe(2)
})

it('unknown delivery reconciles the frozen original manager input after the plan changes and a Host restart', async () => {
  const f = await fixture(); await f.revise([node('original-ready')])
  f.submitted.mockImplementationOnce(async (...args) => { await f.originalSubmit(...args); throw new Error('The saved Core ACK was lost') })
  await f.manager.check()
  const pending = f.manager.list()[0]!.pendingCompletion!
  expect(f.manager.list()[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown', lastDecision: 'The saved Core ACK was lost' })
  expect(f.native.writes.length).toBeGreaterThan(0)
  expect(pending.prompt).toContain(f.ticketId('original-ready')); expect(pending.agentMuxNote).toContain('Goal role: manager')
  await f.revise([node('original-ready', { cancelled: true }), node('newer-ready')]); await f.manager.stop()
  let now = Date.now() + 120_000
  const inspect = vi.spyOn(f.runtime, 'inspectGoalAttention')
  const second = new ContinuousProgressLoopManager(f.loops, (...args) => deliverContinuousProgress(f.runtime, ...args), () => now,
    (loop, tickId, at, signal) => f.runtime.observeContinuousProgress(loop, tickId, at, signal), undefined, { read: id => f.goals.get(id), inspectInitial: async () => 'confirmed' })
  // The same original Runtime owner remains; only the Host scheduler is restarted.
  cleanup.push(() => second.stop()); await second.start(); await second.goalAction('goal', 'original-loop', 'resume', 1, 'explicit-resume')
  const writes = f.native.writes.length; now += 60_000; await second.check()
  expect(f.submitted).toHaveBeenCalledOnce()
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', supervisorAgentSessionId: 'supervisor', supervisorRunId: 'original-run', operationId: pending.operationId })
  expect(f.native.writes).toHaveLength(writes)
  expect(second.list()[0]).toMatchObject({ status: 'active', lastOutcome: 'sent' })
})

it('a Goal without a plan keeps its exact original prompt and Supervisor guidance through Core', async () => {
  const f = await fixture(); await f.manager.check()
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.submitted.mock.calls[0]![1]).toBe(f.loop.prompt)
  expect(f.submitted.mock.calls[0]![7]).toContain('Goal role: manager')
})

it('a plan whose live nodes passed review pauses without another Core input or human acceptance', async () => {
  const f = await fixture(); await f.revise([node('done'), node('cancelled', { cancelled: true })]); await f.delegate('done'); await f.report('done', 'pass')
  await f.manager.check()
  expect(f.manager.list()[0]).toMatchObject({ status: 'paused', lastDecision: expect.stringContaining('Waiting for a person to accept') })
  expect(f.submitted).not.toHaveBeenCalled(); expect((await f.goals.get('goal'))!.grounding?.acceptedAt).toBeUndefined()
})

it('the authoritative Supervisor change pauses new planned manager input while keeping the original loop and healthy Agent', async () => {
  const f = await fixture(); await f.revise([node('ready')])
  const original = f.manager.list()[0]!, session = f.native.core.agentSession('supervisor')
  await f.goals.update('goal', { supervisorSessionId: 'reviewer' })
  expect(f.manager.list()[0]).toMatchObject({ loopId: original.loopId, agentSessionId: 'supervisor', status: 'paused', lastDecision: expect.stringContaining('current Supervisor') })
  await f.manager.check(); expect(f.submitted).not.toHaveBeenCalled()
  expect(f.native.core.agentSession('supervisor').run).toEqual(session.run)
  await expect(f.manager.resume(original.loopId)).rejects.toThrow('current Supervisor')
  // An explicit restoration of the same role permits normal current-Supervisor management again.
  await f.goals.update('goal', { supervisorSessionId: 'supervisor' }); await f.manager.resume(original.loopId); f.advance(); await f.manager.check()
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.submitted.mock.calls[0]![7]).toContain('Goal role: manager')
  expect(f.submitted.mock.calls[0]![0].agentSessionId).toBe('supervisor')
})

it('a cold old loop checks the current plan Supervisor before creating a new tick claim', async () => {
  const f = await fixture(); await f.revise([node('ready')]); await f.manager.stop()
  await f.goals.update('goal', { supervisorSessionId: 'reviewer' })
  await f.loops.save([f.loop])
  const second = new ContinuousProgressLoopManager(f.loops, (...args) => deliverContinuousProgress(f.runtime, ...args), () => Date.now() + 120_000,
    (loop, tick, now, signal) => f.runtime.observeContinuousProgress(loop, tick, now, signal), undefined, { read: id => f.goals.get(id), inspectInitial: async () => 'confirmed' })
  cleanup.push(() => second.stop()); await second.start(); await second.check()
  expect(second.list()[0]).toMatchObject({ loopId: 'original-loop', status: 'paused', lastDecision: expect.stringContaining('current Supervisor') })
  expect(second.list()[0]!.pendingCompletion).toBeUndefined(); expect(f.submitted).not.toHaveBeenCalled()
})

it('a confirmed role removal between source observation and delivery cancels only new management input', async () => {
  const f = await fixture(); await f.revise([node('ready')])
  f.observeAfter(() => f.goals.update('goal', { supervisorSessionId: null }).then(() => undefined))
  await f.manager.check()
  expect(f.manager.list()[0]).toMatchObject({ loopId: 'original-loop', status: 'paused', lastDecision: expect.stringContaining('current Supervisor') })
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.native.core.agentSession('supervisor').run.runId).toBe('original-run')
})

it('unreadable Goal facts defer a new planned tick and retain ordinary manual input', async () => {
  const f = await fixture(); await f.revise([node('ready')])
  f.read.mockRejectedValueOnce(new Error('Original Goal owner is temporarily unavailable'))
  await f.manager.check()
  expect(f.manager.list()[0]).toMatchObject({ loopId: 'original-loop', status: 'active', lastDecision: expect.stringContaining('temporarily unavailable') })
  expect(f.submitted).not.toHaveBeenCalled()
  await f.originalSubmit({ kind: 'agent', hostId: 'local', agentSessionId: 'supervisor', run: { runId: 'original-run' } }, 'Original manual input remains available', 'original-manual-input',
    { expectedRun: { runId: 'original-run' }, afterSubmissionId: null }, undefined, undefined, true)
  expect(f.native.writes.length).toBeGreaterThan(0)
})

it('an unplanned Goal pauses future input when its current Supervisor changes', async () => {
  const f = await fixture(); await f.goals.update('goal', { supervisorSessionId: 'reviewer' }); await f.manager.check()
  expect(f.submitted).not.toHaveBeenCalled()
  expect(f.manager.list()[0]).toMatchObject({ loopId: f.loop.loopId, status: 'paused', lastDecision: expect.stringContaining('current Supervisor') })
  await expect(f.manager.goalAction('goal', f.loop.loopId, 'check', 1, 'old-supervisor-check')).rejects.toThrow('current Supervisor')
})

it('a changed Supervisor still reconciles the exact frozen unknown claim without a new input', async () => {
  const f = await fixture(); await f.revise([node('ready')])
  f.submitted.mockImplementationOnce(async (...args) => { await f.originalSubmit(...args); throw new Error('Original manager ACK lost') })
  await f.manager.check()
  const before = f.manager.list()[0]!, pending = before.pendingCompletion!, writes = [...f.native.writes]
  const inspect = vi.spyOn(f.runtime, 'inspectGoalAttention')
  await f.goals.update('goal', { supervisorSessionId: 'reviewer' })
  expect(f.manager.list()[0]!.pendingCompletion).toEqual(pending)
  const resumed = await f.manager.resume(before.loopId).then(() => ({ error: null }), error => ({ error: String(error) }))
  expect(resumed).toEqual({ error: null })
  f.advance(); await f.manager.check()
  expect(f.submitted).toHaveBeenCalledOnce()
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', supervisorAgentSessionId: 'supervisor', supervisorRunId: 'original-run', operationId: pending.operationId })
  expect(f.native.writes).toEqual(writes)
  expect(f.manager.list()[0]).toMatchObject({ loopId: before.loopId, agentSessionId: 'supervisor', lastOutcome: 'sent' })
  // Once the original claim is reconciled, the next fresh manager occurrence loses that old role.
  f.advance(); await f.manager.check(); expect(f.submitted).toHaveBeenCalledOnce()
  expect(f.manager.list()[0]).toMatchObject({ status: 'paused', lastDecision: expect.stringContaining('current Supervisor') })
})

it('a changed Supervisor cannot replay a frozen unknown tick when Core has no claim for it', async () => {
  const f = await fixture()
  f.submitted.mockImplementationOnce(async () => { throw new Error('Original input outcome unavailable before Core responded') })
  await f.manager.check()
  const before = f.manager.list()[0]!, pending = before.pendingCompletion!
  expect(before).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
  const inspect = vi.spyOn(f.runtime, 'inspectGoalAttention')
  await f.goals.update('goal', { supervisorSessionId: 'reviewer' })
  await f.manager.resume(before.loopId)
  f.advance(); await f.manager.check()
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', supervisorAgentSessionId: 'supervisor', supervisorRunId: 'original-run', operationId: pending.operationId })
  expect(f.submitted).toHaveBeenCalledOnce(); expect(f.native.writes).toEqual([])
  expect(f.manager.list()[0]).toMatchObject({ loopId: before.loopId, status: 'paused', lastOutcome: 'unknown', pendingCompletion: pending })
})
