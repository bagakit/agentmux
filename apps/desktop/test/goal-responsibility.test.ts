import { fixturePath as _newTailFixturePath } from "../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { observeAgent, type AgentMuxAgentRuntimeStatus, type AgentMuxClientEvent, type AgentStatus } from '@agentmux/core'
import { demandExecutionReferences, demandResponsibilityScope, openDemandStore, type Demand, type DemandProgress } from '@agentmux/demand'
import { GOAL_IDLE_GRACE_MS, goalResponsibilityBasis, observeGoalExecution } from '@agentmux/core/goal-responsibility'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { GoalResponsibilityOwner } from '../src/main/goal-responsibility-owner'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks() })
function status(id: string, state: AgentStatus['state'] = 'done', since = Date.now() - 90_000, source: AgentStatus['source'] = 'native-hook'): AgentMuxAgentRuntimeStatus {
  const semanticStatus = { state, source, observedAt: Date.now(), stateEnteredAt: since, currentActivityRevision: 7 }
  return { session: { kind: 'agent', agentSessionId: id, providerId: source === 'acp' ? 'gemini' : 'codex', executorId: 'fixture', hostId: 'local',
    workspacePath: _newTailFixturePath("fixture"), run: { runId: id + '-run' }, retiredRuns: [], createdAt: Date.now() - 100_000, updatedAt: Date.now(), semanticStatus },
    run: { runId: id + '-run', kind: 'agent', providerId: source === 'acp' ? 'gemini' : 'codex', executorId: 'fixture', agentSessionId: id,
      workspacePath: _newTailFixturePath("fixture"), pid: null, state: 'running', cols: 80, rows: 24, observedAt: Date.now(), latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: source === 'acp' ? 'acp-turn-id' : 'native-turn-id' },
    observation: observeAgent({ process: 'running', status: semanticStatus, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, Date.now()) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-responsibility-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root })
  await demands.create({ id: 'goal', title: 'Original task', status: 'in_progress', assigneeSessionIds: ['manager', 'worker'], supervisorSessionId: 'manager' })
  await demands.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Original evidence' }], openQuestions: [] })
  await demands.prepareDispatch('goal', { operationId: 'start', hostId: 'worker-host', agentSessionId: 'worker', runId: 'worker-run', execution: 'finite', prompt: 'Original task' })
  await demands.recordDispatchPhase('goal', 'start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:start', createdAt: Date.now() } })
  const goal = (await demands.get('goal'))!, execution = demandExecutionReferences(goal)[0]!
  const facts = (value = status('worker')) => ({ execution, inputConfirmed: true, originalRun: { runId: 'worker-run', state: 'running' as const }, status: value })
  const progress = (phase: DemandProgress['phase'], value = status('worker'), verified = true): DemandProgress => ({
    operationId: 'progress', execution, expectedScope: demandResponsibilityScope(goal), phase, summary: 'Original next step', evidence: ['external:original'], nextAction: 'Follow the original condition',
    ...(phase === 'waiting-external' ? { waiting: { reference: 'external:original', resumeWhen: 'Original external reply arrives' } } : {}),
    author: { kind: 'agent', id: verified ? 'manager' : 'worker' }, reportingRunId: verified ? 'manager-run' : 'worker-run', recordedAt: Date.now(), basis: goalResponsibilityBasis(value), managerVerified: verified, ...(phase === 'review' ? { reviewForHuman: true } : {}) })
  return { demands, goal, execution, facts, progress }
}

it('delays a short native idle but exposes persistent unreported responsibility from its original state start', async () => {
  const f = await fixture(), now = Date.now()
  const short = observeGoalExecution(f.goal, f.facts(status('worker', 'done', now - 500)), now)
  expect(short).toMatchObject({ phase: 'idle-grace', alert: null, nextCheckAt: now - 500 + GOAL_IDLE_GRACE_MS, nextOwner: { agentSessionId: 'worker' } })
  const stalled = observeGoalExecution(f.goal, f.facts(), now)
  expect(stalled).toMatchObject({ phase: 'stalled', alert: 'stalled', nextOwner: { kind: 'manager', agentSessionId: 'manager' } })
  const noStart = status('worker'); delete noStart.session.semanticStatus!.stateEnteredAt
  expect(observeGoalExecution(f.goal, f.facts(noStart), now)).toMatchObject({ phase: 'unknown', alert: 'unknown' })
})

it('Core active, awaiting input, error, stale and wrong Run remain distinct without reading display text', async () => {
  const f = await fixture(), now = Date.now()
  expect(observeGoalExecution(f.goal, f.facts(status('worker', 'working')), now)).toMatchObject({ phase: 'executing', alert: null })
  expect(observeGoalExecution(f.goal, f.facts(status('worker', 'waiting')), now)).toMatchObject({ phase: 'needs-input', alert: 'manager-review' })
  expect(observeGoalExecution(f.goal, f.facts(status('worker', 'error')), now)).toMatchObject({ phase: 'blocked', alert: 'error' })
  const stale = status('worker', 'working'); stale.session.semanticStatus!.observedAt = now - 60 * 60_000
  stale.observation = observeAgent({ process: 'running', status: stale.session.semanticStatus!, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now)
  expect(observeGoalExecution(f.goal, f.facts(stale), now)).toMatchObject({ phase: 'unknown', alert: 'unknown' })
  const otherRun = status('worker'); otherRun.session.run = { runId: 'replacement-run' }; otherRun.run.runId = 'replacement-run'
  expect(observeGoalExecution(f.goal, f.facts(otherRun), now)).toMatchObject({ phase: 'unknown', alert: 'unknown' })
  const display = status('worker', 'working'); display.session.semanticStatus!.detail = 'Done! idle exit accepted complete';
  expect(observeGoalExecution(f.goal, f.facts(display), now)).toMatchObject({ phase: 'executing', alert: null })
})

it('a Goal-level result cannot discharge another worker or a finite Start without actual attribution', async () => {
  const f = await fixture()
  await f.demands.proposeGrounding('goal', { alignmentRevision: 1, summary: 'Another worker result', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/another-worker.json'], note: '' }] })
  const goal = (await f.demands.get('goal'))!
  expect(observeGoalExecution(goal, f.facts(), Date.now())).toMatchObject({ phase: 'stalled', alert: 'stalled' })
  expect(observeGoalExecution(goal, { ...f.facts(), report: true }, Date.now())).toMatchObject({ phase: 'report-review', nextOwner: { kind: 'manager' } })
  expect(observeGoalExecution(goal, { ...f.facts(), collected: true }, Date.now())).toMatchObject({ phase: 'result-review', alert: 'manager-review' })
  const current = { ...f.progress('review'), groundingSubmissionId: goal.grounding!.submissionId }
  expect(observeGoalExecution({ ...goal, progressUpdates: [current] }, f.facts(), Date.now())).toMatchObject({ phase: 'result-review', alert: null, nextOwner: { kind: 'human' } })
})

it('worker waits need management verification; accepted external conditions expire on accurate related activity and never hide exit', async () => {
  const f = await fixture(), original = status('worker')
  const declared = f.progress('waiting-external', original, false)
  expect(observeGoalExecution({ ...f.goal, progressUpdates: [declared] }, f.facts(original), Date.now())).toMatchObject({ phase: 'report-review', alert: 'manager-review' })
  const verified = f.progress('waiting-external', original)
  expect(observeGoalExecution({ ...f.goal, progressUpdates: [verified] }, f.facts(original), Date.now())).toMatchObject({ phase: 'waiting-external', alert: null })
  const changed = status('worker'); changed.session.semanticStatus!.currentActivityRevision = 8
  expect(observeGoalExecution({ ...f.goal, progressUpdates: [verified] }, f.facts(changed), Date.now())).toMatchObject({ phase: 'stalled', alert: 'stalled' })
  expect(observeGoalExecution({ ...f.goal, progressUpdates: [verified] }, { ...f.facts(original), originalRun: { runId: 'worker-run', state: 'exited' } }, Date.now())).toMatchObject({ phase: 'ended', alert: 'ended' })
  expect(observeGoalExecution({ ...f.goal, status: 'done' }, f.facts(), Date.now())).toMatchObject({ phase: 'closed', alert: null })
})

it('unknown source, shared-Run attribution and another execution cannot acquire an idle failure from a title or status', async () => {
  const f = await fixture()
  expect(observeGoalExecution({ ...f.goal, title: 'Done idle failed' }, { ...f.facts(), inputConfirmed: false }, Date.now())).toMatchObject({ binding: 'unconfirmed', phase: 'unknown' })
  expect(observeGoalExecution(f.goal, f.facts(), Date.now(), true)).toMatchObject({ binding: 'ambiguous', phase: 'unknown', alert: 'unknown' })
  const unrelated = { ...f.progress('waiting-external'), execution: { ...f.execution, operationId: 'another-operation' } }
  expect(observeGoalExecution({ ...f.goal, progressUpdates: [unrelated] }, f.facts(), Date.now())).toMatchObject({ phase: 'stalled' })
})

it('monitors original work without a mounted detail, indexes related events and one idle deadline, and reads late events from current owners', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let current = status('worker', 'done', Date.now()), listener: ((host: string, event: AgentMuxClientEvent) => void) | undefined
  const runtime = {
    observeGoalAgent: vi.fn(async () => current),
    resolveGoalAgent: vi.fn(async () => ({ hostId: 'manager-host', status: status('manager', 'working') })),
    observeCoreEvents: vi.fn((_types, callback) => { listener = callback; return () => { listener = undefined } })
  }
  const values: GoalDelegationResult[] = [], changed = vi.fn()
  const read = vi.fn(async () => {
    const goal = (await f.demands.get('goal'))!
    const start = goal.dispatches![0]!
    const work: GoalDelegationResult = { goalId: goal.id, goalUpdatedAt: goal.updatedAt, diskDurability: 'confirmed', delegations: [], dispatches: goal.dispatches!,
      startObservations: [{ operationId: start.operationId, input: { state: 'confirmed' }, originalRun: { runId: start.runId, state: 'running' }, responsibility: 'working' }] }
    work.responsibility = await owner.observe(goal, work); values.push(work); return work
  })
  const owner = new GoalResponsibilityOwner(f.demands, runtime, read, changed); cleanup.push(() => owner.dispose())
  await owner.start()
  await vi.waitFor(() => expect(values).toHaveLength(1))
  expect(values[0]!.responsibility).toMatchObject({ supervisor: { hostId: 'manager-host', agentSessionId: 'manager' }, executions: [{ phase: 'idle-grace' }] })
  const reads = read.mock.calls.length
  for (let i = 0; i < 1000; i++) listener!('worker-host', { type: 'agent-status', agentSessionId: 'unrelated-' + i, state: 'done',
    evidence: { source: 'native-hook', observedAt: Date.now() } })
  expect(read).toHaveBeenCalledTimes(reads)
  await vi.advanceTimersByTimeAsync(GOAL_IDLE_GRACE_MS)
  await vi.waitFor(() => expect(values.at(-1)!.responsibility!.executions[0]!.phase).toBe('stalled'))
  current = status('worker', 'working')
  listener!('worker-host', { type: 'process-state', run: { runId: 'worker-run' }, state: 'exited', pid: null, evidence: { source: 'run-process', observedAt: Date.now() - 1000 } })
  await vi.waitFor(() => expect(values.at(-1)!.responsibility!.executions[0]!.phase).toBe('executing'))
  expect(vi.getTimerCount()).toBe(0)
})

it('a progress write authenticates the original worker and leaves the source Goal and native capability intact on refusal', async () => {
  const f = await fixture(), runtime = { observeGoalAgent: vi.fn(async () => status('worker')),
    resolveGoalAgent: vi.fn(async () => ({ hostId: 'manager-host', status: status('manager') })), observeCoreEvents: vi.fn(() => () => {}) }
  const owner = new GoalResponsibilityOwner(f.demands, runtime, vi.fn(), vi.fn())
  const input = { operationId: 'wrong-author', execution: f.execution, expectedScope: demandResponsibilityScope(f.goal), phase: 'blocked' as const,
    summary: 'Original blocker', evidence: ['original:evidence'], nextAction: 'Inspect original blocker' }
  await expect(owner.progress('goal', input, {}, { actor: { kind: 'agent', id: 'impostor' }, hostId: 'worker-host', runId: 'worker-run' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await owner.progress('goal', { ...input, operationId: 'actual-worker' }, {}, { actor: { kind: 'agent', id: 'worker' }, hostId: 'worker-host', runId: 'worker-run' })
  expect((await f.demands.get('goal'))!.progressUpdates).toHaveLength(1)
  expect((await f.demands.get('goal'))!.dispatches).toEqual(f.goal.dispatches)
})
