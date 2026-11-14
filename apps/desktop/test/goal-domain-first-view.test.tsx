// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createGoalQualifiedPublicFixture } from './helpers/goal-qualified-public-fixture'
import { installGoalFinitePublicBridge } from './helpers/goal-finite-public-bridge'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'
import { api } from '../src/renderer/src/lib/api'
import { retainGoalFiniteStartIntent, useAppStore } from '../src/renderer/src/store'
import { readGoalFiniteStartIntent } from '../src/renderer/src/lib/goal-finite-start'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { GoalStartWork } from '../src/renderer/src/components/GoalStartWork'
import { goalNextStepFact } from '../src/renderer/src/lib/goal-presentation'
import { goalStartRows } from '../src/renderer/src/lib/goal-start-presentation'
import { MobileGoalSessions } from '../../mobile/src/goals/MobileGoalSessions'
import { publicGoalRecord } from '../../host/src/goal-projection'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function Finite({ id }: { id: string }) { const goal = useAppStore(state => state.demands[id]); return goal ? <GoalFiniteStartControl demand={goal} primary /> : null }
const button = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!
async function fixture() {
  const f = await createGoalQualifiedPublicFixture(cleanup), bridge = installGoalFinitePublicBridge(f.rpc)
  vi.spyOn(api.goals, 'execute').mockImplementation(bridge.api.goals.execute)
  vi.spyOn(api.demands, 'list').mockImplementation(bridge.api.demands.list)
  vi.spyOn(api.demands, 'onChanged').mockImplementation(() => () => {}); vi.spyOn(api.sessions, 'onEvent').mockImplementation(() => () => {})
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.config, 'get').mockRejectedValueOnce(Error('Private startup observation unavailable'))
  cleanup.push(await useAppStore.getState().initialize())
  const goal: DemandProjection = { ...f.goal, source: 'default-topic', sessions: [], workspacePath: null }
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'D-current', kind: 'ssh', label: 'Other actual Runtime', hostname: 'fixture.invalid' }] },
    demands: { [goal.id]: goal }, sessions: [], timelines: {}, agentNames: {}, goalFiniteStartIntents: {}, agentComposerDrafts: { neighbor: 'Keep original healthy input' } })
  await dom.render(<Finite id={goal.id} />)
  return { ...f, bridge, choose: async (hostId: string) => {
    const field = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === `Project connection for ${f.reference.source.spaceId}`)!
    await chooseField(field, JSON.stringify({ hostId }))
  } }
}

it('actual GUI keeps a requested OP after wrong Source and explicitly continues it through formal Preload/Main/public Core once', async () => {
  const f = await fixture(), drafts = useAppStore.getState().agentComposerDrafts
  await f.choose('D-current')
  const original = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)!
  await act(async () => button('Submit retained task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('another semantic Runtime'))
  expect(readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)).toMatchObject({ operationId: original.operationId, phase: 'may-have-dispatched' })
  await act(async () => button('Inspect original Start').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('saved before input preparation'))
  expect(goalNextStepFact(useAppStore.getState().demands[f.goal.id]!, useAppStore.getState().goalFiniteStartIntents[f.goal.id])).toMatchObject({ stage: 'attention', text: 'Task saved before input preparation · Continue the original request' })
  expect(f.send).not.toHaveBeenCalled()
  await f.choose('local')
  await act(async () => button('Continue original Start').click())
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  const starts = f.bridge.requests.filter(value => value.channel === 'goals:execute' && (value.input as { operation?: string }).operation === 'demand.start')
  expect(starts.map(value => (value.input as { requestId: string }).requestId)).toEqual([original.operationId, original.operationId])
  expect(starts[1]!.input).toMatchObject({ resumeOriginal: true, access: { source: { hostId: 'local' } } })
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('another view selects access for the shared requested OP using its frozen Goal version without sending input', async () => {
  const f = await fixture(), operationId = 'another-view-requested'
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: { source: { hostId: 'D-current' } } }).catch(() => {})
  await f.goals.demands.update(f.goal.id, { description: 'Another device changed the current Goal after this request' })
  const current = (await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId })).goal!
  const observed: DemandProjection = { ...current, source: 'default-topic', sessions: [], workspacePath: null }
  await act(async () => { useAppStore.setState({ demands: { [f.goal.id]: observed }, goalFiniteStartIntents: {} }) })
  await f.choose('local')
  const saved = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)
  expect(saved).toMatchObject({ operationId, agentReference: f.reference, expectedUpdatedAt: f.goal.updatedAt, phase: 'may-have-dispatched' })
  expect(current.updatedAt).not.toBe(f.goal.updatedAt)
  expect(goalNextStepFact(useAppStore.getState().demands[f.goal.id]!, useAppStore.getState().goalFiniteStartIntents[f.goal.id])).toMatchObject({ stage: 'attention', text: 'Task saved before input preparation · Continue the original request' })
  expect(f.send).not.toHaveBeenCalled()
})

it('only the original Domain rejection enables an explicit new current task; the rejected OP and unknown states are not replayed', async () => {
  const f = await fixture()
  await f.choose('local')
  const old = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)!
  await f.goals.demands.update(f.goal.id, { description: 'User-reviewed current body' })
  await act(async () => button('Submit retained task').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Goal changed before this task was accepted'))
  await act(async () => button('Inspect original Start').click())
  await vi.waitFor(() => expect(button('Prepare current task')).toBeDefined())
  expect(button('Continue original Start')).toBeUndefined(); expect(f.send).not.toHaveBeenCalled()
  const rejection = await f.goals.demands.inspectDispatch(f.goal.id, old.operationId)
  expect(goalNextStepFact(useAppStore.getState().demands[f.goal.id]!, useAppStore.getState().goalFiniteStartIntents[f.goal.id])).toMatchObject({ stage: 'attention', text: 'Task request rejected · Review before preparing a current task' })
  await vi.waitFor(() => expect(button('Prepare current task').disabled).toBe(false))
  await act(async () => button('Prepare current task').click())
  try { await vi.waitFor(() => expect(readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)?.operationId).not.toBe(old.operationId)) }
  catch (error) { throw Error(JSON.stringify({ ui: dom.container.textContent, private: useAppStore.getState().goalFiniteStartIntents[f.goal.id], domain: useAppStore.getState().demands[f.goal.id]?.dispatches, calls: f.bridge.requests }), { cause: error }) }
  const next = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)!
  expect(next).toMatchObject({ phase: 'not-attempted', agentReference: f.reference })
  expect(next.operationId).not.toBe(old.operationId); expect(f.send).not.toHaveBeenCalled()
  await act(async () => button('Submit retained task').click())
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  expect(await f.goals.demands.inspectDispatch(f.goal.id, old.operationId)).toEqual(rejection)
  expect(await f.goals.demands.inspectDispatch(f.goal.id, next.operationId)).toMatchObject({ prompt: 'User-reviewed current body', target: f.reference })
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: next.operationId }
  await expect.poll(async () => (await f.d.core.inspectAgentInput({ key }))?.status).toBe('admitted')
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId: next.operationId, agentReference: f.reference, access: f.access, resumeOriginal: true })
  const result = await f.rpc.call('goal.inspect', { goalId: f.goal.id }), current = { ...publicGoalRecord(result.goal!), source: 'default-topic' as const, sessions: [], workspacePath: null }
  expect(current.dispatches?.find(value => value.operationId === next.operationId)?.stage).toBe('confirmed')
  expect((await f.d.core.readAgentSession(f.session.agentSessionId))?.run.runId).toBe(f.session.run.runId)
  // The real Run still exists, but no new Source observer is invented to claim
  // current execution here. Its newer input record must still outrank old refusal.
  expect(goalNextStepFact(current, { ...old, phase: 'may-have-dispatched' })).toMatchObject({ source: { kind: 'start', operationId: next.operationId } })
  await dom.render(<GoalStartWork rows={goalStartRows(current)} supervisorSessionId={null} active={false} openAgent={async () => {}} review={async () => {}} />)
  expect(dom.container.querySelector(`[data-goal-work-operation="${old.operationId}"]`)).not.toBeNull()
  expect(dom.container.querySelector(`[data-goal-work-operation="${next.operationId}"]`)).not.toBeNull()
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('the actual Mobile component consumes public requested/rejected records without fabricating Run or querying all Sessions', async () => {
  const f = await createGoalQualifiedPublicFixture(cleanup)
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId: 'mobile-requested', agentReference: f.reference, access: { source: { hostId: 'D-current' } } }).catch(() => {})
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId: 'mobile-rejected', agentReference: f.reference, access: f.access, expectedUpdatedAt: 0 }).catch(() => {})
  const result = await f.rpc.call('goal.inspect', { goalId: f.goal.id })
  expect(result.goal?.dispatches?.map(value => value.stage)).toEqual(['requested', 'rejected'])
  await dom.render(<MobileGoalSessions client={null} sessionIds={[f.reference]} visible goal={result.goal!} openSession={undefined} />)
  expect(dom.container.textContent).toContain('业务请求已保存，输入未准备')
  expect(dom.container.textContent).toContain('业务请求已拒绝')
  expect(dom.container.textContent).toContain('尚未冻结输入正文')
  expect(f.send).not.toHaveBeenCalled(); expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

it.each(['missing', 'different'] as const)('a real Domain rejection with %s original version cannot replace the private unknown OP', async mode => {
  const f = await fixture(), operationId = 'unknown-private-' + mode
  if (mode === 'missing') await f.goals.demands.update(f.goal.id, { assigneeSessionIds: [] })
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access,
    ...(mode === 'different' ? { expectedUpdatedAt: 0 } : {}) }).catch(() => {})
  if (mode === 'missing') await f.goals.demands.update(f.goal.id, { assigneeSessionIds: [f.reference] })
  const result = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId })
  expect(result.goal?.dispatches?.find(value => value.operationId === operationId)?.stage).toBe('rejected')
  const goal: DemandProjection = { ...publicGoalRecord(result.goal!), source: 'default-topic', sessions: [], workspacePath: null }
  const raw = { goalId: f.goal.id, operationId, agentReference: f.reference, expectedUpdatedAt: f.goal.updatedAt,
    phase: 'may-have-dispatched' as const, access: f.access, accessDraft: { source: { hostId: 'D-current' } } }
  useAppStore.setState({ demands: { [goal.id]: goal }, goalFiniteStartIntents: { [goal.id]: raw } })
  await expect(retainGoalFiniteStartIntent({ ...raw, operationId: 'replacement-' + mode, expectedUpdatedAt: goal.updatedAt, phase: 'not-attempted' }, raw)).rejects.toThrow('cannot be replaced')
  expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBe(raw)
  expect(f.send).not.toHaveBeenCalled()
})

it('an assignee rejection can prepare a different actual current Agent without retaining the old access or sending input', async () => {
  const f = await fixture()
  await f.choose('D-current')
  const old = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)!
  await f.goals.demands.update(f.goal.id, { assigneeSessionIds: [] })
  await act(async () => button('Submit retained task').click())
  await vi.waitFor(() => expect(button('Inspect original Start')?.disabled).toBe(false))
  await act(async () => button('Inspect original Start').click())
  await vi.waitFor(() => expect(button('Prepare current task')?.disabled).toBe(false))
  const rejected = await f.goals.demands.inspectDispatch(f.goal.id, old.operationId)
  expect(rejected).toMatchObject({ stage: 'rejected', rejection: { kind: 'goal-start-assignee-conflict' } })
  const session = (await f.runtime.client.readAgentSession('B-namesake'))!
  const folder = await f.spatial.registerFolder({ id: 'current-B-resource', hostId: 'local', name: 'Current B project', path: session.workspacePath })
  const admitted = await f.spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: 'current-B-C', operation: 'agent.open',
    content: { kind: 'new-agent', executorId: 'codex' }, destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false },
    agentSessionId: session.agentSessionId, execution: { hostId: 'local', runtimeId: f.reference.source.runtimeId,
      executorRevision: 'current-B-executor', workspacePath: session.workspacePath, workspaceId: 'current-B-resource' }, regionResource: {} })
  const current = { kind: 'space-member' as const, source: { runtimeId: f.reference.source.runtimeId, spaceId: folder.spaceId,
    regionId: admitted.record.address.regionId, admission: { kind: 'creation' as const, operationId: 'current-B-C' } },
    execution: { runtimeId: f.reference.source.runtimeId, agentSessionId: session.agentSessionId } }
  await f.goals.demands.update(f.goal.id, { assigneeSessionIds: [current] })
  await act(async () => { await useAppStore.getState().refreshDemand(f.goal.id) })
  await vi.waitFor(() => expect(button('Prepare current task')?.disabled).toBe(false))
  await act(async () => button('Prepare current task').click())
  await vi.waitFor(() => expect(readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)?.operationId).not.toBe(old.operationId))
  const next = readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[f.goal.id], f.goal.id)!
  expect(next).toMatchObject({ phase: 'not-attempted', agentReference: current }); expect(next).not.toHaveProperty('access'); expect(next).not.toHaveProperty('accessDraft')
  expect(await f.goals.demands.inspectDispatch(f.goal.id, old.operationId)).toEqual(rejected)
  expect(f.send).not.toHaveBeenCalled()
})
