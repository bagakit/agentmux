import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, connectAgentMuxRpc, agentPromptCondition, type AgentMuxHeadlessRuntime } from '@agentmux/core'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/core/spatial-layout'
import { injectedContextCore } from '../../desktop/test/helpers/injected-context-core.js'
import { createHostGoals } from '../src/goals.js'
import { createHostSpatialAgentControl } from '../src/spatial-agent-control.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/mote-topic-model.js'
import { contributeGoalDiscussionBinding, readGoalDiscussionBinding } from '../src/goal-discussion-bindings.js'
import { fixtureHostExecutorOptions } from './helpers/configured-executor-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-first-discussion-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const coreRoot = join(root, 'core'), scratchRoot = join(root, 'scratch')
  await mkdir(coreRoot); await mkdir(scratchRoot)
  const configurationPath = join(root, 'configuration.json')
  const io = await injectedContextCore(coreRoot, undefined, fixtureHostExecutorOptions(() => configurationPath)); cleanup.push(io.dispose)
  vi.spyOn((io.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Original Mote', hostId: 'local', path: scratchRoot, kind: 'scratch' }
  const topic = await new ScratchTopics().ensure(workspace, PMO_TEAMS_TOPIC_ID)
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [workspace],
    executors: { claude: { providerId: 'claude', label: 'Private original Agent', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }
  await writeFile(configurationPath, JSON.stringify(config))
  const primary = await io.core.createAgent({ agentSessionId: 'primary', providerId: 'claude', executorId: 'claude', workspacePath: topic.physicalDirectoryPath!, createOperationId: 'original-primary', injectAgentMuxGuide: false })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'mote', topicId: PMO_TEAMS_TOPIC_ID, hostId: 'local', name: 'Original', directoryPath: topic.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId: 'zone', kind: 'home', hostId: 'local', workspaceId: SCRATCH_WORKSPACE_ID, directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId: 'space', zoneId: 'zone' }],
    tabs: [{ tabId: 'primary-tab', zoneId: 'zone', workspaceId: SCRATCH_WORKSPACE_ID, name: 'Original primary', regionIds: ['primary-region'] }],
    regions: [{ tabId: 'primary-tab', regionId: 'primary-region', kind: 'agent', agentSessionId: primary.agentSessionId, runId: primary.run.runId, execution: { hostId: 'local', cwd: primary.workspacePath } }],
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', ['primary-tab']) }, tabLayouts: { 'primary-tab': createWorkbenchViewLayout('primary-region') }, resources: {}
  } })
  const runtime = () => ({ client: io.core }) as AgentMuxHeadlessRuntime
  let server: AgentMuxControlServer
  const goals = createHostGoals({ configurationPath, spatial, runtime, projects: async () => [], coreCall: async (_host, method, params, context) => server.callRpc(method, params, context) })
  cleanup.push(() => goals.dispose())
  server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client: io.core }], spatialState: spatial,
    goalControl: goals.execute, goalParticipation: goals.participation, goalDelegations: goals.goalDelegations,
    spatialAgentControl: createHostSpatialAgentControl({ configurationPath, spatial, runtime, agentMuxContext: request => goals.contextForSpatialOpen(request) }) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { io, goals, spatial, primary, rpc, socketPath: server.path }
}

it('concurrent public first discussions converge on one original Core creation and retain both explicit clarification inputs', async () => {
  const f = await fixture(), goalId = 'legacy-concurrent'
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original legacy Goal', description: 'Keep the same outcome and context.' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands)
  let count = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementation(async (...args) => { if (++count === 2) release(); await gate; return prepare(...args) })
  const before = f.io.start.mock.calls.length
  const requests = ['first-request', 'second-request'].map(operationId => ({ goalId, mode: 'grill' as const, operationId }))
  const results = await Promise.allSettled(requests.map(request => f.rpc.call('goal.discuss', request)))
  const receipts = []
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!
    // Only an explicit same-operation read/retry after the first calls settle;
    // an uncertain result never becomes a replacement operation or Session.
    receipts.push(result.status === 'fulfilled' ? result.value : await f.rpc.call('goal.discuss', requests[index]!))
  }
  expect(new Set(receipts.map(result => result.receipt.agentSessionId)).size).toBe(1)
  expect(f.io.start.mock.calls.length).toBe(before + 1)
  const goal = (await f.goals.demands.get(goalId))!, binding = readGoalDiscussionBinding((await f.spatial.read())!.graph, goalId)!
  expect(goal.discussionIntent?.requestOperationId).toBeOneOf(requests.map(request => request.operationId))
  expect(binding.recipient.kind).toBe('agent')
  const sessionId = receipts[0]!.receipt.agentSessionId!
  const session = await f.io.core.inspectAgentCreation(sessionId)
  expect(session).toMatchObject({ kind: 'agent', creation: { createOperationId: goal.discussionOperationId } })
  const timeline = await f.io.core.sessionTimeline(sessionId)
  const inputs = timeline.items.filter(item => item.kind === 'user_message' && item.content === 'Clarify this existing Goal.')
  expect(inputs).toHaveLength(2)
  expect(goal.creationOrigin).toBeUndefined(); expect(goal.supervisorSessionId).toBeNull(); expect(goal.plan).toBeUndefined()
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyConcurrent: { requests, initialOutcomes: results.map(result => result.status), receipts,
    startsBefore: before, startsAfter: f.io.start.mock.calls.length, inputCount: inputs.length, goal, binding } }) + '\n')
})

it('a real binding contributed during public reservation preserves the original Run and leaves manual input usable', async () => {
  const f = await fixture(), goalId = 'legacy-contributed'
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original legacy Goal' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands), before = f.io.start.mock.calls.length
  const retained = { schema: 'agentmux.goal-discussion-binding.v1' as const, tabId: 'primary-tab', regionId: 'primary-region', recipient: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.primary.agentSessionId } }
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementation(async (...args) => {
    const receipt = await prepare(...args)
    await contributeGoalDiscussionBinding({ spatial: f.spatial, goalId, binding: retained })
    return receipt
  })
  let issue: unknown
  try { await f.rpc.call('goal.discuss', { goalId, mode: 'grill', operationId: 'original-contributed-request' }) } catch (error) { issue = error }
  expect(f.io.start.mock.calls.length).toBe(before)
  expect(issue).toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(readGoalDiscussionBinding((await f.spatial.read())!.graph, goalId)).toEqual(retained)
  const current = await f.io.core.readAgentSession(f.primary.agentSessionId)
  expect(current!.run).toEqual(f.primary.run)
  await f.io.core.submitAgentPrompt({ agentSessionId: f.primary.agentSessionId, ...agentPromptCondition(f.io.core.agentSession(f.primary.agentSessionId)),
    prompt: 'Manual input remains available.', operationId: 'original-manual-after-binding-conflict', authorHuman: true })
  const input = await f.io.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: f.primary.agentSessionId, expectedRun: f.primary.run, submissionId: 'original-manual-after-binding-conflict' })
  expect(input?.admission?.acknowledged).toBe(true); expect(f.io.stop).not.toHaveBeenCalled()
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyBinding: { retained, startsBefore: before, startsAfter: f.io.start.mock.calls.length,
    originalRun: f.primary.run, retainedRun: current!.run, manualInput: input, goal: await f.goals.demands.get(goalId) } }) + '\n')
})

it('a public later discussion records ordinary participation without resolving a pending original Goal creator or Supervisor', async () => {
  const f = await fixture(), goalId = 'legacy-pending-origin'
  const before = (await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original legacy Goal' },
    { operationId: 'old-goal-create', creationOrigin: { requesterAsSupervisor: true } })).demand
  const starts = f.io.start.mock.calls.length
  const result = await f.rpc.call('goal.discuss', { goalId, mode: 'grill', operationId: 'old-goal-create' })
  const after = (await f.goals.demands.get(goalId))!
  expect(after.creationOrigin).toEqual(before.creationOrigin)
  expect(after.creationOrigin?.requesterParticipationId).toBeNull(); expect(after.creationOrigin?.supervisorDefaultPending).toBe(true)
  expect(after.supervisorSessionId).toBeNull()
  expect(after.participations).toHaveLength(1)
  expect(after.participations[0]).toMatchObject({ kind: 'discussion', agentSessionId: result.receipt.agentSessionId })
  expect(f.io.start.mock.calls.length).toBe(starts + 1)
  expect(after.plan).toBeUndefined()
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyOrigin: { request: 'old-goal-create', before, after, result,
    startsBefore: starts, startsAfter: f.io.start.mock.calls.length } }) + '\n')
})

it('a public CAS loser reads an already committed winner without needing another request or Native start', async () => {
  const f = await fixture(), goalId = 'legacy-cas-winner'
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original legacy Goal' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands), before = f.io.start.mock.calls.length
  let winner!: Awaited<ReturnType<typeof f.rpc.call<'goal.discuss'>>>
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementationOnce(async (...args) => {
    winner = await f.rpc.call('goal.discuss', { goalId, mode: 'grill', operationId: 'known-winner-request' })
    return prepare(...args)
  })
  const loser = await f.rpc.call('goal.discuss', { goalId, mode: 'grill', operationId: 'original-loser-request' })
  expect(loser.receipt.agentSessionId).toBe(winner.receipt.agentSessionId)
  expect(f.io.start.mock.calls.length).toBe(before + 1)
  const goal = (await f.goals.demands.get(goalId))!
  expect(goal.discussionIntent?.requestOperationId).toBe('known-winner-request')
  const timeline = await f.io.core.sessionTimeline(loser.receipt.agentSessionId!)
  const inputs = timeline.items.filter(item => item.kind === 'user_message' && item.content === 'Clarify this existing Goal.')
  expect(inputs).toHaveLength(2)
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyWinner: { goal, winner, loser, startsBefore: before,
    startsAfter: f.io.start.mock.calls.length, inputCount: inputs.length } }) + '\n')
})

async function nativeState(f: Awaited<ReturnType<typeof fixture>>, state: 'working' | 'done', id = f.primary.agentSessionId) {
  const previous = (await f.io.store.readMetadata(id))!, now = Date.now()
  await f.io.store.compareAndSwapMetadata(previous, { ...previous, semanticStatus: { state, source: 'native-hook', observedAt: now, stateEnteredAt: now,
    nativeTurnId: 'planning-' + now }, updatedAt: now })
  const core = f.io.core as unknown as { registry: { load(host: string): Promise<void> }; publisher: { publish(event: unknown): void } }
  await core.registry.load('local')
  core.publisher.publish({ type: 'agent-status', agentSessionId: id, state, evidence: { source: 'native-hook', observedAt: now } })
}
async function supervisor(f: Awaited<ReturnType<typeof fixture>>) {
  const capability = f.io.start.mock.calls.map(([spec]) => (spec as { env?: Record<string, string | undefined> }).env)
    .find(env => env?.AGENTMUX_AGENT_SESSION_ID === f.primary.agentSessionId)?.AGENTMUX_AGENT_CAPABILITY
  expect(capability).toEqual(expect.any(String))
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath },
    credentials: { agentSessionId: f.primary.agentSessionId, capability: capability! } })
  cleanup.push(() => rpc.dispose()); return rpc
}

it('a planning request refuses missing management and self-request before any Goal or Core input changes', async () => {
  const f = await fixture(), goalId = 'planning-without-manager'
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original Goal' })
  const before = await f.goals.demands.get(goalId), writes = [...f.io.writes], starts = f.io.start.mock.calls.length
  await expect(f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'missing-supervisor-request' })).rejects.toMatchObject({ code: 'GOAL_PLAN_SUPERVISOR_REQUIRED' })
  expect(await f.goals.demands.get(goalId)).toEqual(before)
  await f.goals.demands.update(goalId, { supervisorSessionId: f.primary.agentSessionId, assigneeSessionIds: [f.primary.agentSessionId] })
  const assigned = await f.goals.demands.get(goalId), manager = await supervisor(f)
  await expect(manager.call('goal.discuss', { goalId, mode: 'plan', operationId: 'self-plan-request' })).rejects.toMatchObject({ code: 'GOAL_PLAN_REQUEST_SELF' })
  expect(await f.goals.demands.get(goalId)).toEqual(assigned)
  expect(f.io.writes).toEqual(writes); expect(f.io.start.mock.calls.length).toBe(starts); expect(f.io.stop).not.toHaveBeenCalled()
  await f.io.core.submitAgentPrompt({ agentSessionId: f.primary.agentSessionId, ...agentPromptCondition(f.io.core.agentSession(f.primary.agentSessionId)), prompt: 'Healthy manual input after refused plan request', operationId: 'manual-after-plan-refusal', authorHuman: true })
  expect((await f.io.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: f.primary.agentSessionId, expectedRun: f.primary.run, submissionId: 'manual-after-plan-refusal' }))?.admission?.acknowledged).toBe(true)
})

it('a busy Supervisor retains coalesced planning operations and native eligibility sends the original input once', async () => {
  const f = await fixture(), goalId = 'busy-planning'
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original outcome', supervisorSessionId: f.primary.agentSessionId, assigneeSessionIds: [f.primary.agentSessionId] })
  await f.goals.demands.proposeAlignment(goalId, { summary: 'Original useful result', criteria: [{ id: 'result', text: 'Check the same outcome' }], openQuestions: [] })
  await nativeState(f, 'working'); await f.goals.start()
  const writes = [...f.io.writes]
  const results = await Promise.all(['planning-a', 'planning-b'].map(operationId => f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId })))
  expect(results.map(result => result.receipt.route)).toEqual(['supervisor', 'supervisor'])
  const requested = (await f.goals.demands.get(goalId))!, original = requested.patrols![0]!
  expect(requested.patrols).toHaveLength(1)
  expect(new Set(results.map(result => result.receipt.route === 'supervisor' ? result.receipt.requestOperationId : null))).toEqual(new Set([original.operationId]))
  expect(original.requestOperationIds).toHaveLength(1); expect(original.attempts[0]!.attemptedAt).toBeUndefined()
  expect(f.io.writes).toEqual(writes); expect(requested.discussionIntent).toBeUndefined(); expect(requested.participations).toEqual([])
  await f.goals.demands.prepareDispatch(goalId, { operationId: 'unrelated-start', hostId: 'local', agentSessionId: f.primary.agentSessionId,
    runId: f.primary.run.runId, execution: 'finite', prompt: 'Unrelated original execution' })
  const pending = await f.rpc.call('goal.plan', { goalId })
  expect(pending.patrolObservations?.[0]?.state).toBe('prepared')
  await nativeState(f, 'done')
  await vi.waitFor(async () => {
    const read = await f.rpc.call('goal.plan', { goalId })
    expect(read.patrolObservations?.[0]?.state).toBe('delivered')
  })
  const delivered = [...f.io.writes]
  expect(delivered.length).toBeGreaterThan(writes.length)
  for (const operationId of ['planning-a', 'planning-b']) await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId })
  expect(f.io.writes).toEqual(delivered)
  const manager = await supervisor(f)
  await manager.call('goal.plan.revise', { goalId, revision: { operationId: 'actual-supervisor-plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [{ id: 'deliver', title: 'Deliver', outcome: 'Original outcome', dependsOn: [], criterionIds: ['result'], check: 'check original', executor: null }] } })
  const complete = await f.rpc.call('goal.plan', { goalId })
  expect(complete.patrolObservations?.[0]).toMatchObject({ state: 'planned', planRevision: 1 })
  await expect(manager.call('goal.patrol.report', { goalId, patrolOperationId: original.operationId, report: { operationId: 'not-plan-completion',
    summary: 'Input is not a saved plan', progress: [], nextOwner: { kind: 'human', agentSessionId: null, action: 'Review' } } })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect((await f.goals.demands.get(goalId))!.patrols![0]!.report).toBeUndefined(); expect(f.io.stop).not.toHaveBeenCalled()
})

it.each(['changed-supervisor', 'removed-supervisor', 'changed-criteria', 'saved-plan'] as const)('a coalesced planning alias reconciles only its original request after %s', async change => {
  const f = await fixture(), goalId = 'retained-planning-alias'
  const next = await f.io.core.createAgent({ agentSessionId: 'next-manager', providerId: 'claude', executorId: 'claude', workspacePath: f.primary.workspacePath,
    createOperationId: 'next-manager-create', injectAgentMuxGuide: false })
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original outcome', supervisorSessionId: f.primary.agentSessionId, assigneeSessionIds: [f.primary.agentSessionId, next.agentSessionId] })
  await f.goals.demands.proposeAlignment(goalId, { summary: 'Original useful result', criteria: [{ id: 'result', text: 'Check the same outcome' }], openQuestions: [] })
  await nativeState(f, 'working'); await f.goals.start()
  const first = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'planning-original' })
  const merged = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'planning-alias' })
  expect(first.receipt).toMatchObject({ route: 'supervisor', requestOperationId: 'planning-original', agentSessionId: f.primary.agentSessionId })
  expect(merged.receipt).toMatchObject({ route: 'supervisor', requestOperationId: 'planning-original' })
  const original = (await f.goals.demands.get(goalId))!.patrols![0]!
  expect(original.requestOperationIds).toEqual(['planning-alias'])
  expect(original.attempts[0]!.attemptedAt).toBeUndefined()
  if (change === 'changed-supervisor' || change === 'removed-supervisor') {
    await f.goals.demands.update(goalId, { supervisorSessionId: change === 'changed-supervisor' ? next.agentSessionId : null })
  } else if (change === 'changed-criteria') {
    await f.goals.demands.proposeAlignment(goalId, { summary: 'Updated useful result', criteria: [{ id: 'updated', text: 'Check the updated outcome' }], openQuestions: [] })
  } else {
    const manager = await supervisor(f)
    await manager.call('goal.plan.revise', { goalId, revision: { operationId: 'actual-supervisor-plan', expectedRevision: 0, alignmentRevision: 1,
      nodes: [{ id: 'deliver', title: 'Deliver', outcome: 'Original outcome', dependsOn: [], criterionIds: ['result'], check: 'check original', executor: null }] } })
  }
  const before = (await f.goals.demands.get(goalId))!, writes = [...f.io.writes], starts = f.io.start.mock.calls.length
  // A protocol/runtime rejection must become a semantic assertion failure, not an infrastructure RED.
  const result = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'planning-alias' })
    .then(value => ({ value, error: null }), error => ({ value: null, error: String(error) }))
  expect(result.error).toBeNull()
  expect(result.value!.receipt).toMatchObject({ route: 'supervisor', operationId: 'planning-alias', requestOperationId: original.operationId,
    hostId: 'local', agentSessionId: original.supervisorAgentSessionId })
  expect(await f.goals.demands.get(goalId)).toEqual(before)
  expect(before.patrols).toHaveLength(1); expect(before.patrols![0]!.attempts).toEqual(original.attempts)
  expect(f.io.writes).toEqual(writes); expect(f.io.start.mock.calls.length).toBe(starts); expect(f.io.stop).not.toHaveBeenCalled()
})

it('a Supervisor change keeps the original planning request stale and only a new operation targets the new manager', async () => {
  const f = await fixture(), goalId = 'changed-planning-supervisor'
  const next = await f.io.core.createAgent({ agentSessionId: 'next-manager', providerId: 'claude', executorId: 'claude', workspacePath: f.primary.workspacePath,
    createOperationId: 'next-manager-create', injectAgentMuxGuide: false })
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original outcome', supervisorSessionId: f.primary.agentSessionId, assigneeSessionIds: [f.primary.agentSessionId] })
  await nativeState(f, 'working'); await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'old-manager-request' })
  await f.goals.demands.update(goalId, { supervisorSessionId: next.agentSessionId, assigneeSessionIds: [f.primary.agentSessionId, next.agentSessionId] })
  expect((await f.rpc.call('goal.plan', { goalId })).patrolObservations?.[0]?.state).toBe('stale')
  const repeated = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'old-manager-request' })
  expect(repeated.receipt.agentSessionId).toBe(f.primary.agentSessionId)
  const fresh = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'explicit-new-manager-request' })
  expect(fresh.receipt.agentSessionId).toBe(next.agentSessionId)
  expect((await f.goals.demands.get(goalId))!.patrols).toHaveLength(2); expect(f.io.stop).not.toHaveBeenCalled()
})

it('an old claimed discussion planning operation is only reconciled while a new operation uses the Supervisor', async () => {
  const f = await fixture(), goalId = 'claimed-planning-discussion'
  const next = await f.io.core.createAgent({ agentSessionId: 'real-manager', providerId: 'claude', executorId: 'claude', workspacePath: f.primary.workspacePath,
    createOperationId: 'real-manager-create', injectAgentMuxGuide: false })
  await seedStoredDemand(f.goals.demands, { id: goalId, title: 'Original outcome', supervisorSessionId: next.agentSessionId, assigneeSessionIds: [next.agentSessionId] })
  await contributeGoalDiscussionBinding({ spatial: f.spatial, goalId, binding: { schema: 'agentmux.goal-discussion-binding.v1', tabId: 'primary-tab', regionId: 'primary-region',
    recipient: { kind: 'agent', hostId: 'local', agentSessionId: f.primary.agentSessionId } } })
  await f.io.core.submitAgentPrompt({ agentSessionId: f.primary.agentSessionId, ...agentPromptCondition(f.io.core.agentSession(f.primary.agentSessionId)),
    prompt: 'Make a plan for this existing Goal: ' + goalId + '.', operationId: 'old-claimed-plan', authorHuman: true })
  const writes = [...f.io.writes]
  const old = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'old-claimed-plan' })
  expect(old.receipt).toMatchObject({ route: 'discussion', agentSessionId: f.primary.agentSessionId, tabId: 'primary-tab' })
  expect(f.io.writes).toEqual(writes); expect((await f.goals.demands.get(goalId))!.patrols).toBeUndefined()
  const fresh = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'explicit-new-plan' })
  expect(fresh.receipt).toMatchObject({ route: 'supervisor', agentSessionId: next.agentSessionId })
  expect(readGoalDiscussionBinding((await f.spatial.read())!.graph, goalId)?.recipient).toMatchObject({ agentSessionId: f.primary.agentSessionId })
})
