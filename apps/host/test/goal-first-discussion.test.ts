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

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-first-discussion-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const coreRoot = join(root, 'core'), scratchRoot = join(root, 'scratch')
  await mkdir(coreRoot); await mkdir(scratchRoot)
  const io = await injectedContextCore(coreRoot); cleanup.push(io.dispose)
  vi.spyOn((io.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Original Mote', hostId: 'local', path: scratchRoot, kind: 'scratch' }
  const topic = await new ScratchTopics().ensure(workspace, PMO_TEAMS_TOPIC_ID)
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [workspace],
    executors: { claude: { providerId: 'claude', label: 'Private original Agent', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }
  const configurationPath = join(root, 'configuration.json'); await writeFile(configurationPath, JSON.stringify(config))
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
  return { io, goals, spatial, primary, rpc }
}

it('concurrent public first discussions converge on one original Core creation and retain both explicit planning inputs', async () => {
  const f = await fixture(), goalId = 'legacy-concurrent'
  await f.goals.demands.create({ id: goalId, title: 'Original legacy Goal', description: 'Keep the same outcome and context.' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands)
  let count = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementation(async (...args) => { if (++count === 2) release(); await gate; return prepare(...args) })
  const before = f.io.start.mock.calls.length
  const requests = ['first-request', 'second-request'].map(operationId => ({ goalId, mode: 'plan' as const, operationId }))
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
  const inputs = timeline.items.filter(item => item.kind === 'user_message' && item.content === `Make a plan for this existing Goal: ${goalId}.`)
  expect(inputs).toHaveLength(2)
  expect(goal.creationOrigin).toBeUndefined(); expect(goal.supervisorSessionId).toBeNull(); expect(goal.plan).toBeUndefined()
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyConcurrent: { requests, initialOutcomes: results.map(result => result.status), receipts,
    startsBefore: before, startsAfter: f.io.start.mock.calls.length, inputCount: inputs.length, goal, binding } }) + '\n')
})

it('a real binding contributed during public reservation preserves the original Run and leaves manual input usable', async () => {
  const f = await fixture(), goalId = 'legacy-contributed'
  await f.goals.demands.create({ id: goalId, title: 'Original legacy Goal' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands), before = f.io.start.mock.calls.length
  const retained = { schema: 'agentmux.goal-discussion-binding.v1' as const, tabId: 'primary-tab', regionId: 'primary-region', recipient: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.primary.agentSessionId } }
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementation(async (...args) => {
    const receipt = await prepare(...args)
    await contributeGoalDiscussionBinding({ spatial: f.spatial, goalId, binding: retained })
    return receipt
  })
  let issue: unknown
  try { await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'original-contributed-request' }) } catch (error) { issue = error }
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
  const before = (await f.goals.demands.create({ id: goalId, title: 'Original legacy Goal' },
    { operationId: 'old-goal-create', creationOrigin: { requesterAsSupervisor: true } })).demand
  const starts = f.io.start.mock.calls.length
  const result = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'old-goal-create' })
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
  await f.goals.demands.create({ id: goalId, title: 'Original legacy Goal' })
  const prepare = f.goals.demands.prepareDiscussion.bind(f.goals.demands), before = f.io.start.mock.calls.length
  let winner!: Awaited<ReturnType<typeof f.rpc.call<'goal.discuss'>>>
  vi.spyOn(f.goals.demands, 'prepareDiscussion').mockImplementationOnce(async (...args) => {
    winner = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'known-winner-request' })
    return prepare(...args)
  })
  const loser = await f.rpc.call('goal.discuss', { goalId, mode: 'plan', operationId: 'original-loser-request' })
  expect(loser.receipt.agentSessionId).toBe(winner.receipt.agentSessionId)
  expect(f.io.start.mock.calls.length).toBe(before + 1)
  const goal = (await f.goals.demands.get(goalId))!
  expect(goal.discussionIntent?.requestOperationId).toBe('known-winner-request')
  const timeline = await f.io.core.sessionTimeline(loser.receipt.agentSessionId!)
  const inputs = timeline.items.filter(item => item.kind === 'user_message' && item.content === `Make a plan for this existing Goal: ${goalId}.`)
  expect(inputs).toHaveLength(2)
  if (process.env.GOAL_PLANNING_FACTS) appendFileSync(process.env.GOAL_PLANNING_FACTS, JSON.stringify({ legacyWinner: { goal, winner, loser, startsBefore: before,
    startsAfter: f.io.start.mock.calls.length, inputCount: inputs.length } }) + '\n')
})
