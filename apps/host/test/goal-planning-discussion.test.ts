import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core'
import { deriveObjectId } from '@agentmux/core/object-id'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/core/spatial-layout'
import { contributeGoalDiscussionBinding } from '../src/goal-discussion-bindings.js'
import { workspaceProjectId } from '../src/workspace-projects.js'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

// Each case drives real Hosts through separate public CLI processes.
vi.setConfig({ testTimeout: 60_000 })
const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the current authenticated Supervisor confirms its exact Goal through CLI and the Host retains the original actor', async () => {
  vi.stubEnv('NODE_OPTIONS', [process.env.NODE_OPTIONS, '--import ' + resolve('apps/host/test/goal-planning-discussion-node-loader.mjs')].filter(Boolean).join(' '))
  const f = await crossHostOwner(cleanup, 'supervisor-confirmation', ['supervisor', 'other'])
  const goalId = 'supervisor-confirmation-goal'
  await f.call(null, ['goal', 'create', '--goal', goalId, '--title', 'Deliver a checked outcome',
    '--assignees', '["supervisor","other"]', '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  const proposal = { summary: 'Deliver a checked outcome.', criteria: [{ id: 'result', text: 'The result has an independent check.' }], openQuestions: [] }
  await f.call('supervisor', ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(proposal)])
  const confirm = ['goal', 'confirm', '--goal', goalId, '--revision', '1', '--operation-id', 'supervisor-confirmation']
  const denied = await f.cli('other', confirm)
  expect(denied.code).toBe(1)
  expect(denied.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const continuation = await f.cli('supervisor', [...confirm, '--continue-with', '{"hostId":"local","agentSessionId":"supervisor"}'])
  expect(continuation.code).toBe(1)
  expect(continuation.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const confirmed = await f.call('supervisor', confirm)
  const saved = confirmed.goal.alignment
  expect(saved).toMatchObject({ revision: 1, confirmedAt: expect.any(Number),
    confirmedBy: { kind: 'agent', id: 'supervisor', hostId: 'local', runtimeId: f.identity.runtimeId } })
  expect((await f.call(null, confirm)).goal.alignment).toEqual(saved)
  expect((await f.call(null, ['goal', 'inspect', '--goal', goalId])).goal.alignment).toEqual(saved)
  const accepted = await f.cli('supervisor', ['goal', 'accept', '--goal', goalId, '--revision', '1', '--submission', 'report'])
  expect(accepted.code).toBe(1)
  expect(accepted.stderr).toContain('CONTROL_PERMISSION_DENIED')
  await f.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({ ...proposal, summary: 'New scope' })])
  const stale = await f.cli('supervisor', confirm)
  expect(stale.code).toBe(1)
  expect((await f.call(null, ['goal', 'inspect', '--goal', goalId])).goal.alignment).toMatchObject({ revision: 2, confirmedAt: null })
})

it('the public CLI submits and reconciles an original managed planning input, then only the legal author can save the unconfirmed Goal plan', async () => {
  vi.stubEnv('NODE_OPTIONS', [process.env.NODE_OPTIONS, '--import ' + resolve('apps/host/test/goal-planning-discussion-node-loader.mjs')].filter(Boolean).join(' '))
  const f = await crossHostOwner(cleanup, 'planning', ['supervisor', 'discussion'])
  const config = JSON.parse(await readFile(f.configurationPath, 'utf8'))
  await writeFile(f.configurationPath, JSON.stringify({ ...config, goals: { workflow: { template: 'evidence-synthesis' } } }))
  const goalId = 'original-planning-goal', operationId = 'original-planning-request'
  await f.call(null, ['goal', 'create', '--goal', goalId, '--title', 'Keep the real Goal', '--description', 'Preserve the original human intent.',
    '--assignees', '["supervisor","discussion"]', '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  const alignment = { summary: 'Deliver a checked outcome.', criteria: [{ id: 'result', text: 'The original result has an independent check.' }], openQuestions: [] }
  await f.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(alignment)])
  const spatial = new AgentMuxSpatialStateStore(), directory = f.original.root
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'mote', topicId: '__pmo_teams__', name: 'Original', hostId: 'local', directoryPath: directory, projectId: null }],
    zones: [{ zoneId: 'zone', workspaceId: 'original-project', kind: 'home', hostId: 'local', directoryPath: directory, branch: null }],
    bindings: [{ spaceId: 'space', zoneId: 'zone' }], tabs: [{ tabId: 'discussion-tab', zoneId: 'zone', workspaceId: 'original-project', name: 'Original discussion', regionIds: ['discussion-region'] }],
    regions: [{ tabId: 'discussion-tab', regionId: 'discussion-region', kind: 'agent', agentSessionId: 'discussion', runId: 'run-discussion', execution: { hostId: 'local', cwd: directory } }],
    layouts: { 'original-project': createWorkspaceLayout('group', ['discussion-tab']) }, tabLayouts: { 'discussion-tab': createWorkbenchViewLayout('discussion-region') }, resources: {}
  } })
  await contributeGoalDiscussionBinding({ spatial, goalId, binding: { schema: 'agentmux.goal-discussion-binding.v1', tabId: 'discussion-tab', regionId: 'discussion-region',
    recipient: { kind: 'agent', hostId: 'local', agentSessionId: 'discussion' } } })
  const args = ['goal', 'discuss', '--goal', goalId, '--mode', 'plan', '--operation-id', operationId]
  const current = (await f.original.store.readMetadata('supervisor'))!, now = Date.now()
  await f.original.store.compareAndSwapMetadata(current, { ...current, semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now,
    nativeTurnId: 'planning-ready' }, updatedAt: now })
  await (f.client() as unknown as { registry: { load(host: string): Promise<void> } }).registry.load('local')
  vi.spyOn((f.client() as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const first = await f.call('discussion', args)
  expect(first.receipt).toMatchObject({ route: 'supervisor', mode: 'plan', operationId, agentSessionId: 'supervisor', requestOperationId: operationId })
  const goal = (await f.call(null, ['goal', 'inspect', '--goal', goalId])).goal
  const request = goal.patrols.find((item: { purpose?: string }) => item.purpose === 'plan'), attempt = request.attempts[0]
  expect(request).toMatchObject({ requestedBy: { kind: 'agent', id: 'discussion' }, supervisorAgentSessionId: 'supervisor' })
  expect(attempt.agentMuxNote).toContain('goal plan revise')
  expect(attempt.agentMuxNote).toContain('agentmux.goal-plan-request.v1')
  const frozenPlan = JSON.parse(attempt.agentMuxNote.split('\n\n')[0])
  expect(frozenPlan.context.workflow).toMatchObject({ id: 'evidence-synthesis', title: 'Evidence and synthesis' })
  expect(frozenPlan.context.workflow.instructions).toContain('depends on those verified deliveries')
  const input = await f.client().inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'supervisor', expectedRun: { runId: 'run-supervisor' }, submissionId: attempt.operationId })
  expect(input?.admission).toMatchObject({ acknowledged: true, inputKey: { kind: 'prompt', agentSessionId: 'supervisor', expectedRun: { runId: 'run-supervisor' }, submissionId: attempt.operationId } })
  expect(input?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect((await f.call(null, ['goal', 'plan', '--goal', goalId])).plan).toBeUndefined()
  const nativeWrites = () => f.original.rawInput.mock.calls.length + (f.native.input as { mock: { calls: unknown[] } }).mock.calls.length
  const beforeRetry = nativeWrites(); expect(beforeRetry).toBeGreaterThan(0)
  await writeFile(f.configurationPath, JSON.stringify({ ...config, goals: { workflow: { template: 'execution-review' } } }))
  await f.call(null, ['goal', 'update', '--goal', goalId, '--project', workspaceProjectId({ id: 'original-project', name: 'Original project', hostId: 'local', path: directory })])
  const retry = await f.call('discussion', args)
  expect(retry.receipt).toEqual(first.receipt); expect(nativeWrites()).toBe(beforeRetry)
  const revision = { goalId, revision: { operationId: 'original-plan-revision', expectedRevision: 0, alignmentRevision: 1, nodes: [
    { id: 'prepare', title: 'Prepare', outcome: 'A checked input', dependsOn: [], criterionIds: ['result'], check: 'check prepare', executor: null },
    { id: 'deliver', title: 'Deliver', outcome: 'The checked result', dependsOn: ['prepare'], criterionIds: ['result'], check: 'check deliver', executor: null }
  ] } }
  const denied = await f.cli('discussion', ['goal', 'plan', 'revise', '--input', '-'], revision)
  expect(denied.code).toBe(1); expect(denied.stderr).toContain('CONTROL_PERMISSION_DENIED')
  expect((await f.call(null, ['goal', 'plan', '--goal', goalId])).plan).toBeUndefined()
  const saved = await f.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], revision)
  expect(saved.plan.history[0].author).toMatchObject({ kind: 'agent', id: 'supervisor' })
  expect(saved.plan.nodes[1].dependsOn).toEqual([saved.plan.nodes[0].id])
  const read = await f.call(null, ['goal', 'inspect', '--goal', goalId])
  expect(read.goal).toMatchObject({ supervisorSessionId: 'supervisor', alignment: { confirmedAt: null }, plan: { revision: 1 } })
  expect(read.goal.delegations ?? []).toEqual([])
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ cli: f.cliReceipts, originalInput: input, planningRequest: request,
    originalReceipt: first.receipt, retryReceipt: retry.receipt, nativeWritesBeforeRetry: beforeRetry, nativeWritesAfterRetry: nativeWrites(), plan: saved.plan, finalGoal: read.goal }) + '\n')
})
