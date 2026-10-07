import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { demandExecutionReferences, demandResponsibilityScope, type DemandProgressInput } from '../src/responsibility.js'

const cleanup: string[] = [], execute = promisify(execFile)
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-responsibility-domain-')); cleanup.push(root)
  const store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original work', status: 'in_progress', assigneeSessionIds: ['manager', 'worker'], supervisorSessionId: 'manager' })
  await store.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Deliver original evidence' }], openQuestions: [] })
  await store.prepareDispatch('goal', { operationId: 'start', agentSessionId: 'worker', hostId: 'worker-host', runId: 'worker-run', execution: 'finite', prompt: 'Original task' })
  await store.recordDispatchPhase('goal', 'start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:start', createdAt: Date.now() } })
  const input = async (phase: DemandProgressInput['phase'] = 'executing'): Promise<DemandProgressInput> => {
    const goal = (await store.get('goal'))!
    return { operationId: 'progress-' + phase, execution: demandExecutionReferences(goal)[0]!, expectedScope: demandResponsibilityScope(goal),
      phase, summary: 'Original progress', evidence: ['evidence/original.json'], nextAction: 'Continue original work',
      ...(phase === 'waiting-external' ? { waiting: { reference: 'external-request:original', resumeWhen: 'The original external request resolves' } } : {}) }
  }
  const basis = { stateEnteredAt: Date.now() - 10_000, activityRevision: 4, inputSubmissionId: 'start' }
  const worker = { author: { kind: 'agent' as const, id: 'worker' }, reportingRunId: 'worker-run', basis }
  const manager = { author: { kind: 'agent' as const, id: 'manager' }, reportingRunId: 'manager-run', basis }
  return { root, store, input, worker, manager }
}

it('persists the authenticated exact execution and original declaration across a second real process', async () => {
  const f = await fixture(), input = await f.input('waiting-external')
  const first = await f.store.recordProgress('goal', input, f.worker)
  expect(first.demand.progressUpdates).toHaveLength(1)
  expect(first.demand.progressUpdates![0]).toMatchObject({ ...input, author: f.worker.author, basis: f.worker.basis, managerVerified: false })
  const script = `import {openDemandStore} from ${JSON.stringify(new URL('../dist/src/index.js', import.meta.url).href)}; console.log(JSON.stringify(await openDemandStore({root:process.argv[1]}).get('goal')))`
  const child = await execute(process.execPath, ['--input-type=module', '-e', script, f.root])
  expect(JSON.parse(child.stdout).progressUpdates).toEqual(first.demand.progressUpdates)
  expect((await f.store.get('goal'))!.alignment!.confirmedAt).toBeNull()
})

it('keeps an original operation idempotent after later progress while changed text/author conflicts', async () => {
  const f = await fixture(), original = await f.input()
  await f.store.recordProgress('goal', original, f.worker)
  await f.store.recordProgress('goal', await f.input('blocked'), f.worker)
  const reread = await f.store.recordProgress('goal', original, f.worker)
  expect(reread.demand.progressUpdates).toHaveLength(2)
  await expect(f.store.recordProgress('goal', { ...original, summary: 'Changed body' }, f.worker)).rejects.toThrow(/original progress operation/)
  await expect(f.store.recordProgress('goal', original, f.manager)).rejects.toThrow(/original progress operation/)
})

it('scopes mutations to actual business changes, keeping unrelated activity outside the guard', async () => {
  const f = await fixture(), original = await f.input()
  await f.store.appendActivity('goal', { kind: 'evidence', message: 'Read-only inspection evidence', operationId: 'unrelated-activity', actorId: 'manager' })
  expect(demandResponsibilityScope((await f.store.get('goal'))!)).toBe(original.expectedScope)
  await f.store.recordProgress('goal', original, f.worker)
  const old = await f.input('blocked')
  await f.store.proposeAlignment('goal', { summary: 'Changed scope', criteria: [{ id: 'AC', text: 'Different accepted proposal' }], openQuestions: [] })
  await expect(f.store.recordProgress('goal', old, f.manager)).rejects.toThrow(/responsibility changed/)
  expect((await f.store.get('goal'))!.progressUpdates).toHaveLength(1)
})

it('a worker phase cannot invent a result, a target handoff or management approval', async () => {
  const f = await fixture()
  await expect(f.store.recordProgress('goal', await f.input('review'), f.worker)).rejects.toThrow(/Review requires/)
  const handoff = { ...await f.input(), phase: 'handed-off' as const, handoffExecution: { kind: 'start' as const, operationId: 'not-created', hostId: 'worker-host', agentSessionId: 'other-worker', runId: 'other-run' } }
  await expect(f.store.recordProgress('goal', handoff, f.worker)).rejects.toThrow(/already-bound/)
  const waiting = await f.input('waiting-external')
  await f.store.recordProgress('goal', waiting, f.worker)
  expect((await f.store.get('goal'))!.progressUpdates![0]!.managerVerified).toBe(false)
  const acknowledgment = { ...await f.input('waiting-external'), operationId: 'manager-verified-wait' }
  await f.store.recordProgress('goal', acknowledgment, f.manager)
  expect((await f.store.get('goal'))!.progressUpdates![1]!.managerVerified).toBe(true)
})

it('wrong original Run, missing wait basis and another execution reject only this write', async () => {
  const f = await fixture()
  await expect(f.store.recordProgress('goal', await f.input(), { ...f.worker, reportingRunId: 'replacement-run' })).rejects.toThrow(/original worker Run/)
  await expect(f.store.recordProgress('goal', await f.input('waiting-external'), { ...f.manager, basis: { ...f.manager.basis, stateEnteredAt: null } })).rejects.toThrow(/observed original state basis/)
  const wrong = await f.input(); wrong.execution = { ...wrong.execution, runId: 'another-run' }
  await expect(f.store.recordProgress('goal', wrong, f.manager)).rejects.toThrow(/original execution/)
  const goal = (await f.store.get('goal'))!
  expect(goal.progressUpdates ?? []).toEqual([])
  expect(goal.dispatches![0]!.runId).toBe('worker-run')
  expect(goal.status).toBe('in_progress')
})
