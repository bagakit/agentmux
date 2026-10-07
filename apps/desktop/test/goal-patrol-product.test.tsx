// @vitest-environment happy-dom
import './helpers/goal-responsibility-product'
import { fixture, mount, container, evidence, settle } from './helpers/goal-responsibility-product'
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { demandExecutionReferences, type Demand, type DemandPatrol, type DemandPatrolReportInput } from '@agentmux/demand'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import { AGENTMUX_GOAL_SKILL_ENTRY, goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { refreshGoalDelegations } from '../src/renderer/src/lib/goal-delegation-work'
import { RuntimeController } from '../src/main/runtime-controller'
import { semantic } from './helpers/goal-responsibility-product'

type Fixture = Awaited<ReturnType<typeof fixture>>
function current() { return useAppStore.getState().demands.goal! }
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
async function prepared(options: { alignment?: boolean | 'empty' } = {}) {
  const f = await fixture({ patrol: true, ...options }); await f.finite(); await f.publish()
  await mount(createElement(GoalDelegationWork, { demand: current() }))
  expect(container.querySelector('.goal-patrol')).not.toBeNull()
  expect(current().responsibility!.executions[0]).toMatchObject({ phase: 'stalled', alert: 'stalled' })
  return f
}
function inspection(goal: Demand, patrol: DemandPatrol, suffix = 'review', review = true): DemandPatrolReportInput {
  return { operationId: 'inspection-' + suffix, summary: 'Actually inspected the original work and evidence', status: review ? 'in_review' : 'blocked',
    grounding: { alignmentRevision: patrol.alignment!.revision, summary: 'Verified original criterion evidence',
      checks: patrol.alignment!.criteria.map(criterion => ({ criterionId: criterion.id, outcome: review ? 'met' as const : 'gap' as const,
        evidence: ['apps/desktop/test/goal-patrol-product.test.tsx:1'], note: review ? '' : 'The original frozen task still has a gap.' })) },
    progress: review ? [{ operationId: 'verified-start-' + suffix, execution: demandExecutionReferences(goal)[0]!, expectedScope: patrol.expectedScope,
      phase: 'review', summary: 'Verified original Start result', evidence: ['apps/desktop/test/goal-patrol-product.test.tsx:1'], nextAction: 'Person reviews the exact original evidence' }] : [],
    nextOwner: { kind: 'human', agentSessionId: null, action: 'Review the original verified criterion and remaining gaps' } }
}
async function request(f: Fixture, operationId = 'original-patrol') {
  return (await f.cli('owner', ['goal', 'patrol', '--goal', 'goal', '--operation-id', operationId])).result as GoalDelegationResult
}
async function read(f: Fixture) { return (await f.cli('owner', ['goal', 'delegations', '--goal', 'goal'])).result as GoalDelegationResult }
async function report(f: Fixture, patrol: DemandPatrol, input?: DemandPatrolReportInput) {
  const actual = input ?? inspection((await f.demands.get('goal'))!, patrol)
  return (await f.action('owner', 'patrol report', { goalId: 'goal', patrolOperationId: patrol.operationId, report: actual })).result as GoalDelegationResult
}
async function updated(action: () => void | Promise<unknown>, assertion: () => unknown) {
  await act(async () => { await action(); await vi.waitFor(assertion); await refreshGoalDelegations('goal') }); await settle()
}

describe('actual original PMO patrol CLI, Core Input and mounted business consumer', () => {
  it('one actual click coalesces duplicate intent, commits the original Core input and keeps delivery distinct from PMO writeback', async () => {
    vi.spyOn(api.demands, 'acceptGrounding')
    const f = await prepared(), drafts = { original: 'Do not replace this unsent user draft' }
    useAppStore.setState({ agentComposerDrafts: drafts, selectedDemandId: 'goal' })
    const initial = await f.capture('initial')
    expect(initial.inspect).toMatchObject({ ok: true, operation: 'goal.inspect', result: { goal: { id: 'goal' } } })
    expect((initial.delegations as { result: GoalDelegationResult }).result.patrols).toBeUndefined()
    const trigger = button('PMO 巡查')
    await updated(() => { trigger.click(); trigger.click() }, () => expect(current().patrolObservations?.[0]?.state).toBe('delivered'))
    const saved = (await f.demands.get('goal'))!, patrol = saved.patrols![0]!, attempt = patrol.attempts[0]!
    expect(saved.patrols).toHaveLength(1); expect(f.attempts).toHaveLength(1)
    expect(f.attempts[0]).toMatchObject({ operationId: attempt.operationId, agentSessionId: 'owner', runId: 'owner-run' })
    expect(attempt.target).toMatchObject({ hostId: 'local', agentSessionId: 'owner', runId: 'owner-run' })
    const admitted = await f.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'owner', expectedRun: { runId: 'owner-run' }, submissionId: attempt.operationId })
    expect(admitted).toMatchObject({ agentSessionId: 'owner', run: { runId: 'owner-run' }, admission: { acknowledged: true, submissionId: attempt.operationId,
      inputKey: { kind: 'prompt', agentSessionId: 'owner', expectedRun: { runId: 'owner-run' }, submissionId: attempt.operationId },
      intent: { message: { systemContext: attempt.agentMuxNote } } } })
    expect(admitted!.admission!.intent!.message!.authorHuman).toBeUndefined()
    expect(JSON.parse(attempt.agentMuxNote)).toMatchObject({ schema: 'agentmux.goal-patrol.v1', goalId: 'goal', patrolOperationId: patrol.operationId,
      inputOperationId: attempt.operationId, read: { method: 'goal.delegations', params: { goalId: 'goal' } }, roleGuidance: goalRoleGuidance({
        role: 'manager', goalId: 'goal', agentSessionId: 'owner', runId: 'owner-run', source: { kind: 'goal-patrol', operationId: patrol.operationId } }) })
    expect(JSON.parse(attempt.agentMuxNote).roleGuidance).toContain('Required module: ' + AGENTMUX_GOAL_SKILL_ENTRY)
    expect(f.nativeWrites.length).toBeGreaterThan(0)
    expect(saved.progressUpdates).toBeUndefined(); expect(saved.patrols![0]!.report).toBeUndefined(); expect(saved.status).toBe('in_progress')
    expect(current().responsibility!.executions[0]).toMatchObject({ phase: 'stalled', alert: 'stalled' })
    expect(container.querySelector('.goal-patrol')!.textContent).toContain('已投递 · 等待实际巡查')
    expect(button('巡查请求已保存').disabled).toBe(true)
    await f.capture('delivered')
    await request(f, 'other-click'); expect(f.attempts).toHaveLength(1)
    const returned = await report(f, patrol)
    expect(returned.patrols![0]!.report).toMatchObject({ applied: true, authorAgentSessionId: 'owner', reportingRunId: 'owner-run' })
    expect(returned.goalState!.status).toBe('in_review')
    // The CLI-triggered Domain event updates actual business state through the
    // shared response adapter. A full filesystem refresh must not hide a gap.
    await updated(async () => await refreshGoalDelegations('goal'), () => expect(current().status).toBe('in_review'))
    expect(current().responsibility!.executions[0]).toMatchObject({ phase: 'result-review', alert: null, nextOwner: { kind: 'human' } })
    expect(current().grounding).toMatchObject({ acceptedAt: null }); expect(current().alignment!.confirmedAt).toBeNull()
    expect(container.querySelector('.goal-patrol')!.textContent).toContain('巡查已回填')
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().selectedDemandId).toBe('goal')
    expect(f.stop).not.toHaveBeenCalled(); expect(api.demands.acceptGrounding).not.toHaveBeenCalled()
    await f.capture('reported')
    const source = await evidence('one-click-real-core-input-actual-cli-report-writeback', await f.proof(), 'patrol')
    if (source) await f.exportJourney(source, { initialSnapshotId: 'initial', deliveredSnapshotId: 'delivered', reportedSnapshotId: 'reported' })
  }, 30_000)

  it.each([
    ['explicit-manager', (input: DemandPatrolReportInput) => { input.nextOwner = { kind: 'agent', agentSessionId: 'owner', action: 'PMO still owns the remaining verification' } }, false],
    ['unknown-check', (input: DemandPatrolReportInput) => { input.grounding!.checks[0] = { criterionId: 'AC', outcome: 'unknown', evidence: [], note: 'The original result is not yet verifiable' } }, true],
    ['blocked-status', (input: DemandPatrolReportInput) => { input.status = 'blocked' }, true],
    ['unlocatable-evidence', (input: DemandPatrolReportInput) => { input.grounding!.checks[0]!.evidence = ['claimed complete'] }, true]
  ] as const)('review keeps management responsibility after actual %s inspection writeback', async (suffix, change, forHuman) => {
    const f = await prepared(), pending = await request(f), patrol = pending.patrols![0]!
    const input = inspection((await f.demands.get('goal'))!, patrol, suffix); change(input)
    const returned = await report(f, patrol, input)
    expect(returned.patrols![0]!.report).toMatchObject({ applied: true })
    expect(returned.progressUpdates!.at(-1)).toMatchObject({ phase: 'review', managerVerified: true, reviewForHuman: forHuman })
    await updated(async () => await refreshGoalDelegations('goal'), () => expect(current().responsibility!.executions[0]).toMatchObject({
      phase: 'result-review', alert: 'manager-review', nextOwner: { kind: 'manager', agentSessionId: 'owner' } }))
    expect(current().grounding!.acceptedAt).toBeNull(); expect(current().alignment!.confirmedAt).toBeNull()
    expect(button('PMO 巡查').disabled).toBe(false); expect(f.stop).not.toHaveBeenCalled()
    await evidence('review-retains-management-' + suffix, await f.proof(), 'patrol')
  }, 30_000)

  it('review keeps management responsibility when an actual inspection has empty frozen criteria and empty checks', async () => {
    const f = await prepared({ alignment: 'empty' }), pending = await request(f), patrol = pending.patrols![0]!
    expect(patrol.alignment!.criteria).toEqual([])
    const input = inspection((await f.demands.get('goal'))!, patrol, 'empty-criteria')
    expect(input.grounding!.checks).toEqual([])
    const returned = await report(f, patrol, input)
    expect(returned.patrols![0]!.report).toMatchObject({ applied: true })
    expect(returned.progressUpdates!.at(-1)).toMatchObject({ managerVerified: true, reviewForHuman: true })
    await updated(async () => await refreshGoalDelegations('goal'), () => expect(current().responsibility!.executions[0]).toMatchObject({
      phase: 'result-review', alert: 'manager-review', nextOwner: { kind: 'manager', agentSessionId: 'owner' } }))
    expect(current().grounding!.acceptedAt).toBeNull(); expect(current().alignment!.confirmedAt).toBeNull()
    expect(button('PMO 巡查').disabled).toBe(false); expect(f.stop).not.toHaveBeenCalled()
    await evidence('empty-criteria-checks-retain-management-responsibility', await f.proof(), 'patrol')
  }, 30_000)

  it('an explicitly completed patrol can start a new generation at the same unaligned business scope while in-flight duplicate clicks still coalesce', async () => {
    const f = await prepared({ alignment: false }), scope = current().responsibility!.scope
    await updated(() => button('PMO 巡查').click(), () => expect(current().patrolObservations?.[0]?.state).toBe('delivered'))
    const first = (await f.demands.get('goal'))!.patrols![0]!
    expect(first.alignment).toBeUndefined()
    await report(f, first, { operationId: 'unaligned-inspection', summary: 'Actually inspected missing original alignment; PMO must resolve it',
      progress: [], nextOwner: { kind: 'agent', agentSessionId: 'owner', action: 'Resolve the original missing criteria before another inspection' } })
    expect(current().responsibility!.scope).toBe(scope)
    expect(current().responsibility!.executions[0]!.alert).toBe('stalled')
    await act(async () => { await f.setNativeState('owner', 'done'); await refreshGoalDelegations('goal') })
    const trigger = button('PMO 巡查')
    await updated(() => { trigger.click(); trigger.click() }, () => expect(current().patrols).toHaveLength(2))
    await updated(async () => { await f.flushPatrol(); await refreshGoalDelegations('goal') }, () => expect(current().patrolObservations?.at(-1)?.state).toBe('delivered'))
    const saved = (await f.demands.get('goal'))!, second = saved.patrols![1]!
    expect(second.expectedScope).toBe(scope); expect(second.operationId).not.toBe(first.operationId)
    expect(second.attempts[0]!.operationId).not.toBe(first.attempts[0]!.operationId)
    expect(second.attempts[0]!.target).toEqual(first.attempts[0]!.target)
    expect(saved.patrols![0]!.report).toMatchObject({ operationId: 'unaligned-inspection', applied: true })
    expect(second.report).toBeUndefined(); expect(f.attempts).toHaveLength(2); expect(f.stop).not.toHaveBeenCalled()
    await evidence('reported-same-scope-next-generation-inflight-coalescing', await f.proof(), 'patrol')
  }, 30_000)

  it('busy and occupied management remain prepared until the exact agent-input event admits the same frozen operation', async () => {
    const f = await prepared(); await f.setNativeState('owner', 'working')
    const pending = await request(f), patrol = pending.patrols![0]!, originalInput = patrol.attempts[0]!.operationId
    expect(pending.patrolObservations).toMatchObject([{ state: 'prepared' }]); expect(f.attempts).toEqual([])
    await f.setNativeState('owner', 'done'); f.patrolState.inputOccupied = true
    await updated(async () => { f.emitInput(); await f.flushPatrol(); await f.flushMain() }, () => expect(f.attempts).toEqual([]))
    f.patrolState.inputOccupied = false
    await updated(async () => { f.emitInput() }, () => expect(f.attempts.map(item => item.operationId)).toEqual([originalInput]))
    const result = await read(f)
    expect(result.patrols).toHaveLength(1); expect(result.patrols![0]!.attempts).toHaveLength(1)
    expect(result.patrolObservations).toMatchObject([{ state: 'delivered' }]); expect(result.responsibility!.executions[0]!.alert).toBe('stalled')
    await evidence('prepared-input-exact-event-admits-original-once', await f.proof(), 'patrol')
  }, 30_000)

  it('an unknown attempted input survives a restarted Main owner without blind replay or replacement Session', async () => {
    const f = await prepared(); f.patrolState.loseBeforeSubmit = true
    const unknown = await request(f), patrol = unknown.patrols![0]!, original = patrol.attempts[0]!
    expect(unknown.patrolObservations).toMatchObject([{ state: 'unknown' }]); expect(original.attemptedAt).toBeGreaterThan(0)
    expect(f.attempts).toHaveLength(1); expect(f.nativeWrites).toEqual([])
    await act(async () => { await f.restartPatrol(); await refreshGoalDelegations('goal') }); await request(f, 'after-restart-click')
    expect(f.attempts).toHaveLength(1)
    await act(async () => { await f.advanceSession('owner', 'recovered-owner-run'); await refreshGoalDelegations('goal') })
    await expect(f.cli('owner', ['goal', 'patrol', 'continue', '--goal', 'goal', '--patrol', patrol.operationId,
      '--operation-id', 'forbidden-replay', '--expect-run', 'recovered-owner-run'])).rejects.toMatchObject({ code: 1 })
    expect(f.attempts).toHaveLength(1); expect((await f.demands.get('goal'))!.patrols![0]!.attempts).toEqual([original])
    f.patrolState.loseBeforeSubmit = false
    const inspected = await report(f, patrol)
    expect(inspected.patrols![0]!.report).toMatchObject({ applied: true, reportingRunId: 'recovered-owner-run' })
    expect(inspected.responsibility!.executions[0]).toMatchObject({ phase: 'result-review', alert: null })
    expect(f.attempts).toHaveLength(1); expect(f.stop).not.toHaveBeenCalled()
    await evidence('unknown-input-owner-restart-same-session-report', await f.proof(), 'patrol')
  }, 30_000)

  it('a never-attempted recovered same Session disables the original intent and preserves both immutable input identities', async () => {
    const f = await prepared(); await f.setNativeState('owner', 'working')
    const before = await request(f), patrol = before.patrols![0]!, first = patrol.attempts[0]!
    expect(f.attempts).toEqual([]); expect(first.attemptedAt).toBeUndefined()
    await act(async () => { await f.advanceSession('owner', 'recovered-owner-run'); await refreshGoalDelegations('goal') })
    const next = (await f.cli('owner', ['goal', 'patrol', 'continue', '--goal', 'goal', '--patrol', patrol.operationId,
      '--operation-id', 'continue-original', '--expect-run', 'recovered-owner-run'])).result as GoalDelegationResult
    expect(next.patrols![0]!.attempts).toHaveLength(2)
    const [superseded, continued] = next.patrols![0]!.attempts
    expect(superseded).toMatchObject({ operationId: first.operationId, target: first.target, supersededAt: expect.any(Number) })
    expect(superseded!.attemptedAt).toBeUndefined(); expect(continued!.target).toMatchObject({ agentSessionId: 'owner', runId: 'recovered-owner-run' })
    expect(await f.client.readAgentFuturePromptIntent('owner', first.intentId)).toMatchObject({ active: false, operationId: first.operationId })
    expect(f.attempts.map(item => item.operationId)).toEqual([continued!.operationId])
    await f.cli('owner', ['goal', 'patrol', 'continue', '--goal', 'goal', '--patrol', patrol.operationId,
      '--operation-id', 'continue-original', '--expect-run', 'recovered-owner-run'])
    expect(f.attempts).toHaveLength(1); expect(f.stop).not.toHaveBeenCalled()
    await evidence('never-attempted-same-session-continued-input', await f.proof(), 'patrol')
  }, 30_000)

  it('missing original manager routing retains the request, then its first confirmed route is explicitly bound without choosing another Agent', async () => {
    const f = await prepared(); f.patrolState.routeUnavailable = true
    const missing = await request(f), patrol = missing.patrols![0]!
    expect(patrol.attempts).toEqual([]); expect(missing.patrolObservations).toMatchObject([{ state: 'missing' }]); expect(f.attempts).toEqual([])
    const retained = await f.demands.snapshot()
    await expect(f.cli('stranger', ['goal', 'patrol', 'continue', '--goal', 'goal', '--patrol', patrol.operationId,
      '--operation-id', 'wrong-author', '--expect-run', 'owner-run'])).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.snapshot()).toEqual(retained)
    f.patrolState.routeUnavailable = false
    await updated(async () => await refreshGoalDelegations('goal'), () => expect(current().responsibility!.supervisor.state).toBe('available'))
    expect(button('接续原巡查').disabled).toBe(false)
    await updated(() => button('接续原巡查').click(), () => expect(current().patrolObservations![0]!.state).toBe('delivered'))
    expect(f.attempts).toHaveLength(1); expect((await f.demands.get('goal'))!.patrols).toHaveLength(1)
    expect(f.attempts[0]!.agentSessionId).toBe('owner'); expect(f.stop).not.toHaveBeenCalled()
    await evidence('unavailable-manager-first-route-actual-continuation', await f.proof(), 'patrol')
  }, 30_000)

  it('a stale frozen inspection retains original evidence without overriding new business scope, and unrelated authors cannot report it', async () => {
    const f = await prepared(), pending = await request(f), patrol = pending.patrols![0]!
    const originalGoal = (await f.demands.get('goal'))!, original = inspection(originalGoal, patrol, 'late', false)
    const unchanged = await f.demands.snapshot()
    await expect(f.action('finite-worker', 'patrol report', { goalId: 'goal', patrolOperationId: patrol.operationId, report: original })).rejects.toMatchObject({ code: 1 })
    expect(await f.demands.snapshot()).toEqual(unchanged)
    await act(async () => { await f.demands.confirmAlignment('goal', 1); await refreshGoalDelegations('goal') })
    const late = await report(f, patrol, original)
    expect(late.patrols![0]!.report).toMatchObject({ applied: false, authorAgentSessionId: 'owner' })
    expect(late.goalState!.status).toBe('in_progress'); expect(late.progressUpdates).toBeUndefined(); expect(late.grounding).toBeUndefined()
    expect(late.goalState!.alignment!.confirmedAt).toBeGreaterThan(0)
    await updated(async () => await refreshGoalDelegations('goal'), () => expect(current().patrolObservations![0]!.state).toBe('stale'))
    expect(current().responsibility!.executions[0]!.alert).toBe('stalled')
    expect(button('PMO 巡查').disabled).toBe(false); expect(f.attempts).toHaveLength(1)
    await evidence('stale-inspection-exact-authority-business-scope', await f.proof(), 'patrol')
  }, 30_000)

  it('actual Runtime observation and old-intent cancellation retain the exact routed Session when its Core source Host differs', async () => {
    const f = await fixture(), original = semantic(f.metadata.get('owner')!, 'done')
    const client = { statusAgent: vi.fn(async () => original), readAgentFuturePromptIntent: vi.fn(async () => ({ operationId: 'input', message: { systemContext: 'Original note' } })),
      saveAgentFuturePromptIntent: vi.fn(async () => {}) }
    const observeInput = vi.fn(async () => false)
    const port = { hosts: new Map([['remote-route', { client }]]), progressInputObserver: observeInput, connectedClient: vi.fn(async () => client) }
    const result = await RuntimeController.prototype.observeContinuousProgress.call(port as unknown as RuntimeController,
      { hostId: 'remote-route', agentSessionId: 'owner', providerId: original.session.providerId, workspacePath: original.session.workspacePath, futureIntentId: 'intent' }, 'input', Date.now())
    expect(result.session.hostId).toBe('local'); expect(result.session.agentSessionId).toBe('owner')
    expect(observeInput).toHaveBeenCalledWith({ kind: 'agent', hostId: 'remote-route', agentSessionId: 'owner', run: original.session.run }, undefined)
    await RuntimeController.prototype.disableGoalAttention.call(port as unknown as RuntimeController,
      { hostId: 'remote-route', supervisorAgentSessionId: 'owner', intentId: 'intent', operationId: 'input', agentMuxNote: 'Original note' })
    expect(client.saveAgentFuturePromptIntent).toHaveBeenCalledWith({ agentSessionId: 'owner', intentId: 'intent', operationId: 'input', prompt: '', agentMuxNote: 'Original note', active: false })
    client.readAgentFuturePromptIntent.mockResolvedValue({ operationId: 'different-input', message: { systemContext: 'Original note' } })
    await expect(RuntimeController.prototype.disableGoalAttention.call(port as unknown as RuntimeController,
      { hostId: 'remote-route', supervisorAgentSessionId: 'owner', intentId: 'intent', operationId: 'input', agentMuxNote: 'Original note' })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    expect(client.saveAgentFuturePromptIntent).toHaveBeenCalledOnce()
  })
})
