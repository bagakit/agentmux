import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { demandExecutionKey, demandExecutionReferences, demandResponsibilityScope, openDemandStore,
  type DemandPatrolAttempt, type DemandPatrolReportInput } from '../src/index.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-patrol-domain-')); roots.push(root)
  const store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original responsibility', supervisorSessionId: 'manager', assigneeSessionIds: ['manager', 'worker'], status: 'in_progress' })
  await store.proposeAlignment('goal', { summary: 'Original goal', criteria: [{ id: 'AC', text: 'Original result' }], openQuestions: [] })
  await store.prepareDispatch('goal', { operationId: 'start', hostId: 'worker-host', agentSessionId: 'worker', runId: 'worker-run', prompt: 'Original task', execution: 'finite' })
  await store.recordDispatchPhase('goal', 'start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:start', createdAt: Date.now() } })
  const goal = (await store.get('goal'))!, execution = demandExecutionReferences(goal)[0]!, expectedScope = demandResponsibilityScope(goal)
  const attempt = (runId = 'manager-run', action = 'patrol'): Omit<DemandPatrolAttempt, 'preparedAt'> => ({ operationId: 'input-' + action, actionOperationId: action, intentId: 'intent-' + action,
    target: { hostId: 'manager-host', agentSessionId: 'manager', runId, providerId: 'codex', workspacePath: root }, agentMuxNote: 'Original application-authored note' })
  const prepare = (withAttempt = true, operationId = 'patrol') => store.preparePatrol('goal', { operationId, expectedScope, executions: [execution], supervisorAgentSessionId: 'manager',
    context: JSON.stringify({ exactOriginal: 'goal' }), requestedBy: { kind: 'user', id: 'person' }, ...(withAttempt ? { attempt: attempt() } : {}) })
  const report = (): DemandPatrolReportInput => ({ operationId: 'inspection-report', summary: 'Actually inspected the original work', status: 'in_review',
    grounding: { alignmentRevision: 1, summary: 'Original evidence reviewed', checks: [{ criterionId: 'AC', outcome: 'met', evidence: ['evidence/original.log'], note: '' }] },
    progress: [{ operationId: 'review-start', execution, expectedScope, phase: 'review', summary: 'Verified the original Start result', evidence: ['evidence/original.log'], nextAction: 'Person reviews original result' }],
    nextOwner: { kind: 'human', agentSessionId: null, action: 'Review the verified original evidence' } })
  const basis = { stateEnteredAt: Date.now() - 90_000, activityRevision: 3, inputSubmissionId: 'start' }
  const bases = new Map([[JSON.stringify(execution), basis]])
  return { root, store, goal, execution, expectedScope, attempt, prepare, report, bases, basis }
}
it('coalesces one unresolved original scope durably and retains a temporarily unavailable original manager route', async () => {
  const f = await fixture(); await f.prepare(false); await f.prepare(false, 'other-click')
  const restarted = openDemandStore({ root: f.root }), patrols = (await restarted.get('goal'))!.patrols!
  expect(patrols).toHaveLength(1); expect(patrols[0]).toMatchObject({ operationId: 'patrol', supervisorAgentSessionId: 'manager', attempts: [], alignment: { revision: 1 } })
  await restarted.continuePatrol('goal', 'patrol', null, f.attempt('confirmed-manager-run', 'bind-first-route'))
  expect((await restarted.get('goal'))!.patrols![0]!.attempts).toMatchObject([{ actionOperationId: 'bind-first-route', target: { runId: 'confirmed-manager-run', hostId: 'manager-host' } }])
})
it('original owners atomically grant only one first attempt; a replayed read is not new submit permission', async () => {
  const f = await fixture(); await f.prepare(); const other = openDemandStore({ root: f.root })
  const results = await Promise.all([f.store.markPatrolAttempt('goal', 'patrol', 'input-patrol'), other.markPatrolAttempt('goal', 'patrol', 'input-patrol')])
  expect(results.filter(receipt => receipt.replayed !== true)).toHaveLength(1)
  expect(results.filter(receipt => receipt.replayed === true)).toHaveLength(1)
  await expect(other.continuePatrol('goal', 'patrol', 'input-patrol', f.attempt('new-run', 'continue'))).rejects.toThrow(/may have attempted/)
  expect((await f.store.get('goal'))!.patrols![0]!.attempts).toHaveLength(1)
})
it('a continued request fences its superseded input across owners and the original action is immutable', async () => {
  const f = await fixture(); await f.prepare(); const next = f.attempt('new-run', 'continue')
  await f.store.continuePatrol('goal', 'patrol', 'input-patrol', next)
  await expect(openDemandStore({ root: f.root }).markPatrolAttempt('goal', 'patrol', 'input-patrol')).rejects.toThrow(/superseded/)
  const replay = await f.store.continuePatrol('goal', 'patrol', 'input-patrol', next); expect(replay.replayed).toBe(true)
  await expect(f.store.continuePatrol('goal', 'patrol', 'input-patrol', { ...next, target: { ...next.target, runId: 'different-run' } })).rejects.toThrow(/different frozen content/)
  const history = (await f.store.get('goal'))!.patrols![0]!.attempts
  expect(history).toHaveLength(2); expect(history[0]!.supersededAt).toBeGreaterThan(0); expect(history[0]!.attemptedAt).toBeUndefined()
})
it('writes real inspection, original evidence and next responsibility atomically without human acknowledgement', async () => {
  const f = await fixture(); await f.prepare()
  const receipt = await f.store.recordPatrolReport('goal', 'patrol', f.report(), { agentSessionId: 'manager', runId: 'manager-recovered-run' }, f.bases)
  expect(receipt.demand).toMatchObject({ status: 'in_review', alignment: { confirmedAt: null }, grounding: { acceptedAt: null }, patrols: [{ report: { applied: true, reportingRunId: 'manager-recovered-run' } }] })
  const update = receipt.demand.progressUpdates![0]!
  expect(update).toMatchObject({ managerVerified: true, groundingSubmissionId: receipt.demand.grounding!.submissionId, basis: f.basis })
  expect(demandExecutionKey(update.execution)).toBe(demandExecutionKey(f.execution))
  const replay = await f.store.recordPatrolReport('goal', 'patrol', f.report(), { agentSessionId: 'manager', runId: 'manager-recovered-run' }, f.bases)
  expect(replay.replayed).toBe(true); expect(replay.demand.progressUpdates).toHaveLength(1)
  await expect(f.store.recordPatrolReport('goal', 'patrol', { ...f.report(), summary: 'Different original body' }, { agentSessionId: 'manager', runId: 'manager-recovered-run' }, f.bases)).rejects.toThrow(/immutable/)
})
it('preserves a late inspection under the frozen criteria while human acknowledgement and later work stay authoritative', async () => {
  const f = await fixture(); await f.prepare(); await f.store.confirmAlignment('goal', 1)
  expect(demandResponsibilityScope((await f.store.get('goal'))!)).not.toBe(f.expectedScope)
  const result = await f.store.recordPatrolReport('goal', 'patrol', f.report(), { agentSessionId: 'manager', runId: 'manager-run' }, f.bases)
  expect(result.demand.patrols![0]!.report!.applied).toBe(false)
  expect(result.demand.progressUpdates).toBeUndefined(); expect(result.demand.grounding).toBeUndefined(); expect(result.demand.status).toBe('in_progress')
  expect(result.demand.alignment!.confirmedAt).toBeGreaterThan(0)
  const bad = await fixture(); await bad.prepare()
  await expect(bad.store.recordPatrolReport('goal', 'patrol', { ...bad.report(), grounding: { ...bad.report().grounding!, checks: [] } }, { agentSessionId: 'manager', runId: 'manager-run' }, bad.bases)).rejects.toThrow(/each frozen criterion/)
  await expect(bad.store.recordPatrolReport('goal', 'patrol', { ...bad.report(), progress: [{ ...bad.report().progress[0]!, execution: { ...bad.execution, operationId: 'invented' } }] }, { agentSessionId: 'manager', runId: 'manager-run' }, bad.bases)).rejects.toThrow(/exact original execution/)
})
