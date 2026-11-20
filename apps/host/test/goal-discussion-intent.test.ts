import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDemandStore } from '@agentmux/demand'
import { createHostGoalDiscussions } from '../src/goal-discussions.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/mote-topic-model.js'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { goalPmoOperation } from '../src/goal-pmo-origin.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-discussion-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root: join(root, 'demands') }), operationId = 'goal_pmo_create_original'
  await seedStoredDemand(demands, { id: 'original-goal', title: 'Original Goal' }, { operationId: 'original-create', discussionOperationId: operationId, creationOrigin: { requesterAsSupervisor: true } })
  const configurationPath = join(root, 'configuration.json'), path = join(root, 'mote')
  const launch = { label: 'Original Agent', command: 'original-agent', args: [], env: {}, injectAgentMuxGuide: false }
  const config = { executors: { codex: { ...launch, providerId: 'codex' }, claude: { ...launch, providerId: 'claude' } }, workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: root }] }
  await writeFile(configurationPath, JSON.stringify(config))
  let quickMode: unknown = { status: 'missing' }
  vi.spyOn(ScratchTopics.prototype, 'read').mockImplementation(async () => ({ kind: 'mote', identityDirectoryPath: path, physicalDirectoryPath: path, quickMode }) as never)
  const graph: any = { spaces: [{ spaceId: 'original-space', kind: 'mote', topicId: PMO_TEAMS_TOPIC_ID, hostId: 'local', directoryPath: path, name: 'Original' }],
    zones: [{ zoneId: 'original-zone', kind: 'home', hostId: 'local', directoryPath: path, workspaceId: SCRATCH_WORKSPACE_ID }], bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }], tabs: [], regions: [], layouts: {}, resources: {} }
  const agentCreation = vi.fn(async () => ({ kind: 'agent', agentSessionId: 'original-bot', run: { runId: 'original-run' }, executorId: 'claude', providerId: 'claude', workspacePath: path }))
  const call = vi.fn(async () => { throw new Error('native-boundary') })
  const owner = createHostGoalDiscussions({ configurationPath, demands, spatial: { read: async () => ({ graph }) } as never, runtime: { agentCreation } as never, call: call as never, confirmParticipation: async () => {} })
  const request = { schemaVersion: 1, operation: 'demand.discuss', requestId: 'original-discussion', demandId: 'original-goal', mode: 'grill' } as Extract<AgentMuxControlRequest, { operation: 'demand.discuss' }>
  const bot = (hostId = 'local') => { graph.tabs.push({ tabId: 'original-tab', zoneId: 'original-zone' }); graph.regions.push({ kind: 'agent', tabId: 'original-tab', regionId: 'original-region', agentSessionId: 'original-bot', runId: 'original-run', execution: { hostId } }) }
  return { demands, owner, request, operationId, graph, bot, agentCreation, call, quick: (value: unknown) => { quickMode = value } }
}
it('keeps old Goal data absent and refuses an unconfirmed source without a native action', async () => {
  const f = await fixture()
  await seedStoredDemand(f.demands, { id: 'old-goal', title: 'Original old Goal' })
  await expect(f.owner.execute({ ...f.request, demandId: 'old-goal' }, {})).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect((await f.demands.get('old-goal'))).not.toHaveProperty('discussionOperationId'); expect(f.call).not.toHaveBeenCalled()
})
it('an exactly empty primary Mote needs its explicit first selection and freezes that same request', async () => {
  const f = await fixture()
  await expect(f.owner.execute(f.request, {})).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(f.call).not.toHaveBeenCalled()
  await expect(f.owner.execute({ ...f.request, executorId: 'claude' }, {})).rejects.toThrow('native-boundary')
  expect((await f.demands.get(f.request.demandId))!.discussionIntent).toMatchObject({ executorId: 'claude', mode: 'grill', requestOperationId: f.request.requestId })
  await expect(f.owner.execute({ ...f.request, mode: 'grounding' }, {})).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(f.call).toHaveBeenCalledTimes(1)
})
it('a retained known bot supplies its actual Executor and cannot be replaced by a client default', async () => {
  const f = await fixture(); f.bot()
  await expect(f.owner.execute({ ...f.request, executorId: 'codex' }, {})).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(f.call).not.toHaveBeenCalled()
  await expect(f.owner.execute(f.request, {})).rejects.toThrow('native-boundary')
  expect(f.call.mock.calls[0]![1]).toMatchObject({ content: { executorId: 'claude' } })
})
it('several original discussions with the same verified configuration do not block another new Goal', async () => {
  const f = await fixture(); f.bot(); f.graph.tabs.push({ tabId: 'second-tab', zoneId: 'original-zone' })
  f.graph.regions.push({ kind: 'agent', tabId: 'second-tab', regionId: 'second-region', agentSessionId: 'second-bot', runId: 'original-run', execution: { hostId: 'local' } })
  await expect(f.owner.execute(f.request, {})).rejects.toThrow('native-boundary')
  expect(f.agentCreation).toHaveBeenCalledWith('local', 'original-bot'); expect(f.agentCreation).toHaveBeenCalledWith('local', 'second-bot')
  expect(f.call.mock.calls[0]![1]).toMatchObject({ content: { executorId: 'claude' } })
})
it('a foreign execution reference never borrows a same-ID local bot', async () => {
  const f = await fixture(); f.bot('original-remote')
  await expect(f.owner.execute({ ...f.request, executorId: 'codex' }, {})).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(f.agentCreation).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
})
it('the exact frozen platform source refuses another valid placement before native creation', async () => {
  const f = await fixture()
  await expect(f.owner.execute({ ...f.request, executorId: 'claude' }, {})).rejects.toThrow('native-boundary')
  const original = f.call.mock.calls[0]![1] as any
  const canonical = { ...original, schemaVersion: 1, operation: 'agent.open', requestId: original.operationId } as Extract<AgentMuxControlRequest, { operation: 'agent.open' }>
  expect(await f.owner.contextForSpatialOpen(canonical)).toContain('Original Goal facts:')
  await expect(f.owner.contextForSpatialOpen({ ...canonical, destination: { ...canonical.destination, newTab: undefined, tabId: 'another-tab', regionId: 'another-launcher' } })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  await expect(f.owner.contextForSpatialOpen({ ...canonical, focus: true })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
})
it('a new planning request never reserves a dedicated discussion or starts a replacement Agent', async () => {
  const f = await fixture(), before = await f.demands.get(f.request.demandId)
  await expect(f.owner.execute({ ...f.request, mode: 'plan', executorId: 'claude' }, {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(await f.demands.get(f.request.demandId)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled()
})
it('an explicit legacy discussion uses a distinct original source and preserves pending Goal creation provenance', async () => {
  const f = await fixture()
  await seedStoredDemand(f.demands, { id: 'legacy', title: 'Original legacy Goal' }, { operationId: 'same-request', creationOrigin: { requesterAsSupervisor: true } })
  const before = (await f.demands.get('legacy'))!
  const request = { ...f.request, demandId: 'legacy', requestId: 'same-request', mode: 'grill' as const, executorId: 'claude' }
  await expect(f.owner.execute(request, {})).rejects.toThrow('native-boundary')
  const goal = (await f.demands.get('legacy'))!, expected = await goalPmoOperation({ goalId: goal.id, creationOperationId: request.requestId }, 'discussion-create')
  expect(goal.discussionOperationId).toBe(expected); expect(expected).toMatch(/^goal_pmo_create_/u)
  expect(expected).not.toBe(await goalPmoOperation({ goalId: goal.id, creationOperationId: request.requestId }, 'create'))
  expect(goal.discussionIntent).toMatchObject({ requestOperationId: request.requestId, mode: 'grill', prompt: 'Clarify this existing Goal.' })
  expect(goal.creationOrigin).toEqual(before.creationOrigin); expect(goal.supervisorSessionId).toBeNull(); expect(goal.participations).toEqual(before.participations)
  const call = f.call.mock.calls[0]![1] as any
  expect(call.operationId).toBe(expected)
  expect(await f.owner.contextForSpatialOpen({ ...call, schemaVersion: 1, operation: 'agent.open', requestId: expected })).toBe(goal.discussionIntent!.agentMuxNote)
})

it('a canonical binding contributed during reservation prevents any replacement creation', async () => {
  const f = await fixture()
  await seedStoredDemand(f.demands, { id: 'legacy', title: 'Retained work' })
  const prepare = f.demands.prepareDiscussion.bind(f.demands)
  vi.spyOn(f.demands, 'prepareDiscussion').mockImplementation(async (...args) => {
    const receipt = await prepare(...args)
    f.bot()
    f.graph.tabs[0]!.regionIds = ['original-region']
    f.graph.resources['owned:goal-discussion:legacy'] = { schema: 'agentmux.goal-discussion-binding.v1', tabId: 'original-tab', regionId: 'original-region',
      recipient: { kind: 'agent', hostId: 'local', agentSessionId: 'original-bot' } }
    return receipt
  })
  await expect(f.owner.execute({ ...f.request, demandId: 'legacy', mode: 'grill', executorId: 'claude' }, {})).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.graph.resources['owned:goal-discussion:legacy'].recipient.agentSessionId).toBe('original-bot')
  expect((await f.demands.get('legacy'))!.discussionIntent?.mode).toBe('grill')
})

it('failed spatial observation never reserves a legacy discussion or reaches Native creation', async () => {
  const f = await fixture()
  await seedStoredDemand(f.demands, { id: 'legacy', title: 'Retained work' })
  const before = await f.demands.get('legacy')
  const owner = createHostGoalDiscussions({ configurationPath: '', demands: f.demands, spatial: { read: async () => null } as never,
    runtime: {} as never, call: f.call as never, confirmParticipation: async () => {} })
  await expect(owner.execute({ ...f.request, demandId: 'legacy', mode: 'grill' }, {})).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(await f.demands.get('legacy')).toEqual(before); expect(f.call).not.toHaveBeenCalled()
})
