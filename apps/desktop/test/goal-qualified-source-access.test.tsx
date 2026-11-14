// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { createHostGoals } from '../../host/src/goals'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import { GoalDetail } from '../src/renderer/src/components/GoalDetail'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { desktopGoalControl } from '../src/main/desktop-goals'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  // This metadata-only fixture pins each queue/Runtime/state directory at Core construction.
  const f = await createSpaceSessionsFixture(cleanup)
  await f.d.put('namesake-SID')
  const admitted = await f.admit('D-in-B', f.d.owner.runtimeId, 'namesake-SID', 'original-C')
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { ...f.reference, regionId: admitted.address.regionId,
    admission: { kind: 'creation', operationId: admitted.requestId } }, execution: { runtimeId: f.d.owner.runtimeId, agentSessionId: 'namesake-SID' } }
  const sourceReads: string[] = []
  const source = await connectHostedAgentMux({ rpc: f.b.rpc, connectOnDemand: true, subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc),
    forwardRpc: (method, params, context = {}) => { sourceReads.push(method); return f.b.rpc.call(method, params, {
      ...(context.signal ? { signal: context.signal } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}),
      ...(context.caller ? { credentials: context.caller } : {}), ...(context.principal?.kind === 'device' && context.forwarding ? { forwarding: context.forwarding } : {}) }) } })
  cleanup.push(() => source.dispose())
  const configurationPath = join(f.d.root, 'goal-config.json'); await writeFile(configurationPath, '{}')
  let server!: AgentMuxControlServer
  const runtime = { client: f.d.core, get server() { return server }, ownerIdentity: () => f.d.owner } as AgentMuxHeadlessRuntime
  const goals = createHostGoals({ configurationPath, runtime: () => runtime, clients: () => [{ hostId: 'configured-B', client: source }], projects: async () => [],
    coreCall: (hostId, method, params, context) => { if (hostId !== 'local') throw Error('No substitute Goal owner'); return server.callRpc(method, params, context) } })
  cleanup.push(() => goals.dispose())
  server = new AgentMuxControlServer({ socketPath: join(f.d.root, 'goal-role.sock'), spatialState: f.d.spatial,
    coreClients: () => [{ hostId: 'local', client: f.d.core }], hostedRuntime: () => f.d.hosted, goalControl: goals.execute, goalDelegations: goals.goalDelegations })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const control = desktopGoalControl({ callOriginalCore: (hostId, method, params, context) => {
    if (hostId !== 'local') throw Error('No substitute Goal owner')
    return rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}), ...(context.caller ? { credentials: context.caller } : {}),
      ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.principal?.kind === 'device' && context.forwarding ? { forwarding: context.forwarding } : {}) })
  } })
  vi.spyOn(api.goals, 'execute').mockImplementation(control)
  vi.spyOn(api.demands, 'onChanged').mockImplementation(() => () => {})
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(() => () => {})
  const stored = (await goals.demands.create({ id: 'original-goal', title: 'Original Goal', assigneeSessionIds: [reference], sessionIds: ['legacy-original', reference] })).demand
  const goal: DemandProjection = { ...stored, source: 'default-topic', sessions: [], workspacePath: null }
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'configured-B', kind: 'ssh', label: 'Project device B', hostname: 'private-fixture.invalid' }] },
    demands: { [goal.id]: goal }, sessions: [composerSession('namesake-SID')], timelines: {}, agentNames: {}, goalAgentSelectionDrafts: {}, goalAgentCreationDrafts: {},
    agentComposerDrafts: { 'namesake-SID': 'Keep the original local unsent input' } })
  return { ...f, goal, goals, reference, sourceReads }
}
async function chooseCarrier(value: string, spaceId: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(value => value.getAttribute('aria-label') === `Project connection for ${spaceId}`)!
  expect(button, JSON.stringify({ spaceId, labels: [...document.querySelectorAll('[aria-label]')].map(value => value.getAttribute('aria-label')), text: document.body.innerText, drafts: useAppStore.getState().goalAgentSelectionDrafts })).toBeTruthy()
  await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.getAttribute('data-value') === JSON.stringify({ hostId: value }))!
  expect(option).toBeTruthy()
  await act(async () => option.click())
}
async function openPicker(f: Awaited<ReturnType<typeof fixture>>) {
  const save = vi.fn(async (patch: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[1], revision: number, access?: Parameters<ReturnType<typeof useAppStore.getState>['updateDemand']>[4]) => {
    await useAppStore.getState().updateDemand(f.goal.id, patch, undefined, revision, access)
    return true
  })
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null }}><GoalExecution demand={f.goal} onUpdate={save}/></WorkbenchPresentationContext.Provider>)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Choose Goal Supervisor"]')!.click())
  await act(async () => document.querySelector<HTMLInputElement>('.goal-agent-picker__row[data-goal-agent-key] input')!.click())
  return { save, submit: () => document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')! }
}

it('the actual picker and Store save a qualified role through the original public Goal and exact Source owner, without reading the local namesake or creating input', async () => {
  const f = await fixture(), drafts = useAppStore.getState().agentComposerDrafts, lookup = vi.spyOn(api.sessions, 'historySource')
  const { save, submit } = await openPicker(f)
  await chooseCarrier('configured-B', f.reference.source.spaceId)
  await act(async () => submit().click())
  expect(save).toHaveBeenCalledExactlyOnceWith({ supervisorSessionId: f.reference }, f.goal.updatedAt, [{ reference: f.reference, access: { source: { hostId: 'configured-B' } } }])
  await act(async () => { expect(await save.mock.results[0]!.value.then(() => ({ saved: true }), (error: unknown) => ({ error }))).toEqual({ saved: true }) })
  expect((await f.goals.demands.get(f.goal.id))?.supervisorSessionId).toEqual(f.reference)
  expect((await f.goals.demands.get(f.goal.id))?.sessionIds).toEqual(['legacy-original', f.reference])
  expect((await f.goals.demands.get(f.goal.id))?.dispatches ?? []).toEqual([])
  expect(f.sourceReads).toEqual(['runtime.owner.identity', 'space.inspect'])
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(lookup).not.toHaveBeenCalled()
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled(); expect(f.d.runs).not.toHaveBeenCalled()
  const reads = f.sourceReads.length
  await useAppStore.getState().updateDemand(f.goal.id, { description: 'Unrelated edit', supervisorSessionId: f.reference })
  expect(f.sourceReads).toHaveLength(reads)
})

it('a wrong current Source is refused by the real owner while retaining the exact role selection and private input', async () => {
  const f = await fixture(), drafts = useAppStore.getState().agentComposerDrafts
  const { save, submit } = await openPicker(f)
  await chooseCarrier('local', f.reference.source.spaceId)
  await act(async () => submit().click())
  await act(async () => { await expect(save.mock.results[0]!.value).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' }) })
  expect((await f.goals.demands.get(f.goal.id))?.supervisorSessionId).toBeNull()
  expect([...document.querySelectorAll('.goal-agent-picker [role="status"]')].some(value => value.textContent?.includes('Runtime'))).toBe(true)
  const entries = Object.values(useAppStore.getState().goalAgentSelectionDrafts)
  expect(entries).toEqual([{ goalId: f.goal.id, role: 'supervisor', selected: [f.reference], expectedUpdatedAt: f.goal.updatedAt,
    relationAccess: [{ reference: f.reference, access: { source: { hostId: 'local' } } }] }])
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(f.sourceReads).toEqual([]); expect(f.d.inventory).not.toHaveBeenCalled()
})

it('the real Goal detail callback carries the same explicit Source through its original Store and public owner', async () => {
  const f = await fixture(), noop = () => {}
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null }}>
    <GoalDetail demand={f.goal} onClose={noop} onOpenMote={noop} onGrill={noop} onGrounding={noop} onPlan={noop}
      acknowledgementFeedback={{ pending: false, failure: null, reloadError: null }} onAcknowledgementFeedbackChange={noop} moteError={null} onRetryMote={noop}/>
  </WorkbenchPresentationContext.Provider>)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Choose Goal Supervisor"]')!.click())
  await act(async () => document.querySelector<HTMLInputElement>('.goal-agent-picker__row[data-goal-agent-key] input')!.click())
  await chooseCarrier('configured-B', f.reference.source.spaceId)
  await act(async () => document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')!.click())
  await vi.waitFor(() => expect(vi.mocked(api.goals.execute).mock.calls.some(([request]) => request.operation === 'demand.update')).toBe(true))
  const index = vi.mocked(api.goals.execute).mock.calls.findIndex(([request]) => request.operation === 'demand.update')
  await act(async () => { await vi.mocked(api.goals.execute).mock.results[index]!.value })
  expect((await f.goals.demands.get(f.goal.id))?.supervisorSessionId).toEqual(f.reference)
  expect(useAppStore.getState().demands[f.goal.id]?.supervisorSessionId).toEqual(f.reference)
  expect(f.sourceReads).toEqual(['runtime.owner.identity', 'space.inspect'])
  expect((await f.goals.demands.get(f.goal.id))?.dispatches ?? []).toEqual([])
})

it('the real Goal detail retains a refused Project connection and shows its original Runtime diagnosis', async () => {
  const f = await fixture(), noop = () => {}, drafts = useAppStore.getState().agentComposerDrafts
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: false, retainedRegionId: null }}>
    <GoalDetail demand={f.goal} onClose={noop} onOpenMote={noop} onGrill={noop} onGrounding={noop} onPlan={noop}
      acknowledgementFeedback={{ pending: false, failure: null, reloadError: null }} onAcknowledgementFeedbackChange={noop} moteError={null} onRetryMote={noop}/>
  </WorkbenchPresentationContext.Provider>)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Choose Goal Supervisor"]')!.click())
  await act(async () => document.querySelector<HTMLInputElement>('.goal-agent-picker__row[data-goal-agent-key] input')!.click())
  await chooseCarrier('local', f.reference.source.spaceId)
  await act(async () => document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')!.click())
  await vi.waitFor(() => expect(vi.mocked(api.goals.execute).mock.calls.some(([request]) => request.operation === 'demand.update')).toBe(true))
  const index = vi.mocked(api.goals.execute).mock.calls.findIndex(([request]) => request.operation === 'demand.update')
  await act(async () => { await vi.mocked(api.goals.execute).mock.results[index]!.value.catch(() => {}) })
  expect([...document.querySelectorAll('.goal-agent-picker [role="status"]')].some(value => value.textContent?.includes('Runtime'))).toBe(true)
  expect((await f.goals.demands.get(f.goal.id))?.supervisorSessionId).toBeNull()
  expect(Object.values(useAppStore.getState().goalAgentSelectionDrafts)).toEqual([{ goalId: f.goal.id, role: 'supervisor', selected: [f.reference], expectedUpdatedAt: f.goal.updatedAt,
    relationAccess: [{ reference: f.reference, access: { source: { hostId: 'local' } } }] }])
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(f.sourceReads).toEqual([])
})
