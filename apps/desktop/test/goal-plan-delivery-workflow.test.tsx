// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { openDemandStore } from '../../../packages/demand/src/demand-store'
import { GoalDelegationOwner } from '../../host/src/goal-delegation-owner'
import { publicGoalRecord } from '../../host/src/goal-projection'
import type { DemandDelegationIntent } from '@agentmux/demand/delegations'
import type { GoalPlanNodeInput } from '@agentmux/demand/goal-plan'
import { GoalPlanGraph } from '../src/renderer/src/components/GoalPlanGraph'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyGoalDelegationResult } from '../src/renderer/src/lib/goal-delegation-work'
import { editGoalDraft, goalPlanReviewDraftKey } from '../src/renderer/src/lib/goal-edit-drafts'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { await dom.render(null) } finally { for (const close of cleanup.splice(0).reverse()) await close() } })
const goalId = 'original-delivery-goal'
function MountedPlan() { const goal = useAppStore(state => state.demands[goalId]); return goal ? <GoalPlanGraph demand={goal as DemandProjection} /> : null }
const node = (id: string, dependsOn: string[] = []): GoalPlanNodeInput => ({ id, title: id === 'api' ? 'Deliver the API' : 'Build its consumer', outcome: `Deliver ${id}`, dependsOn,
  criterionIds: ['result'], check: 'node --test checks/api.test.mjs', executor: { hostId: 'local', agentSessionId: 'worker' } })

/** The mounted plan uses production Preload + registered trusted IPC + Unix RPC
 * + the real Host review owner and durable Demand store. Historical task/report
 * setup uses the original store; this proof never starts a Run or sends input. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-goal-delivery-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(root)
  const store = openDemandStore({ root: join(root, 'goals') })
  await store.create({ id: goalId, title: 'Review the original delivery', description: 'Keep the same Goal', status: 'in_progress',
    sessionIds: ['supervisor', 'worker'], assigneeSessionIds: ['supervisor', 'worker'], supervisorSessionId: 'supervisor' })
  await store.proposeAlignment(goalId, { summary: 'Deliver and verify', criteria: [{ id: 'result', text: 'The consumer uses a verified API' }], openQuestions: [] })
  await store.revisePlan(goalId, { operationId: 'original-plan', expectedRevision: 0, alignmentRevision: 1, nodes: [node('api'), node('consumer', ['api'])] }, { kind: 'user', id: 'original-planner' })
  const runtime = { agentCreation: vi.fn().mockRejectedValue(Error('Execution observation is outside this review')) }
  const owner = new GoalDelegationOwner(store, runtime), calls = vi.spyOn(owner, 'call')
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), goalDelegations: owner }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const ipc = await owningBridge(undefined, { publicCoreEndpointPath: server.path }); cleanup.push(ipc.dispose)
  await ipc.workbenchUserState.write(JSON.stringify({ state: {}, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => ipc.workbenchUserState.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => ipc.workbenchUserState.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => ipc.workbenchUserState.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const closeHydration = await useAppStore.getState().initialize()
  closeHydration()
  let fault: 'none' | 'lost' | 'wrong-attempt' = 'none'
  const delivery = vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
    const result = await bridge.api!.demands.delegation(method, input)
    if (method === 'goal.plan.review' && fault === 'lost') throw Error('The review receipt was lost after the original owner saved it')
    if (method === 'goal.plan.review' && fault === 'wrong-attempt') return { ...result, plan: { ...result.plan!, reviews: result.plan!.reviews.map(review => ({ ...review, delegationOperationId: 'another-attempt' })) } }
    return result
  })
  const deliver = async (attempt: number) => {
    const intent: DemandDelegationIntent = { operationId: `delegation-${attempt}`, sourceMessageId: `source-${attempt}`, threadId: 'original-delivery-thread', hostId: 'local',
      ownerAgentSessionId: 'supervisor', ownerRunId: 'supervisor-run', workerAgentSessionId: 'worker', workerRunId: 'worker-run', text: 'Deliver the API', alignmentRevision: 1, criterionIds: ['result'], planNodeId: 'api' }
    await store.prepareDelegation(goalId, intent, 'supervisor'); await store.linkDelegation(goalId, intent.operationId, intent.sourceMessageId, 'supervisor')
    await store.submitDelegationReport(goalId, intent.operationId, { operationId: `report-${attempt}`, replyMessageId: `reply-${attempt}`, authorAgentSessionId: 'worker',
      grounding: { alignmentRevision: 1, summary: `Delivery ${attempt}: API implementation and evidence`, checks: [{ criterionId: 'result', outcome: 'met', evidence: [`checks/attempt-${attempt}.log`], note: 'Reported independently checkable work' }] } }, 'worker')
  }
  await deliver(1)
  const read = () => rpc.call('goal.plan', { goalId })
  useAppStore.setState({ config: composerConfig, demands: { [goalId]: publicGoalRecord((await store.get(goalId))!) }, sessions: [], timelines: {}, agentNames: {}, goalEditDrafts: {}, loading: false })
  applyGoalDelegationResult(await read())
  await dom.render(<MountedPlan />)
  return { store, read, deliver, calls, runtime, delivery, user: ipc.workbenchUserState, fail(value: typeof fault) { fault = value } }
}

const button = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!
async function openDelivery() {
  const entry = dom.container.querySelector<HTMLButtonElement>('[data-goal-review-delivery="api"]')!
  expect(entry).not.toBeNull(); await act(async () => entry.click())
  expect(document.activeElement).toBe(dom.container.querySelector('.goal-plan__reading h3'))
  expect(dom.container.querySelector('.goal-delivery__report')?.textContent).toContain('API implementation and evidence')
  expect(dom.container.querySelector<HTMLDetailsElement>('.goal-delivery__form')?.open).toBe(false)
  await act(async () => dom.container.querySelector<HTMLElement>('.goal-delivery__form > summary')!.click())
}
async function fill(label: string, text: string) {
  const input = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  await act(async () => { Object.getOwnPropertyDescriptor(input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function passFields() { await fill('Review observed result', 'The independent check passed'); await fill('Review evidence locations', 'checks/independent-review.log') }
const stateOf = (id: string) => dom.container.querySelector(`[data-goal-plan-node="${id}"]`)?.getAttribute('data-goal-plan-state')

it('a person requests changes then passes the new exact delivery through the original owner, unlocking only its dependent node', async () => {
  const f = await fixture(); expect(stateOf('consumer')).toBe('waiting')
  await openDelivery(); await fill('Review note', 'The API must preserve the original source')
  await act(async () => button('Request changes').click())
  await vi.waitFor(() => expect(stateOf('api')).toBe('changes'))
  expect(stateOf('consumer')).toBe('waiting')
  const changed = (await f.store.get(goalId))!.plan!.reviews[0]!
  expect(changed).toMatchObject({ delegationOperationId: 'delegation-1', verdict: 'changes', reviewer: { kind: 'user' } })
  expect(useAppStore.getState().goalEditDrafts[goalId]?.planReviews).toBeUndefined()
  await f.deliver(2); await act(async () => applyGoalDelegationResult(await f.read()))
  await act(async () => button('Back to node').click()); await openDelivery(); await passFields()
  await act(async () => button('Pass node').click())
  await vi.waitFor(() => expect(stateOf('api')).toBe('done'))
  expect(stateOf('consumer')).toBe('ready')
  const saved = (await f.store.get(goalId))!
  expect(saved.plan!.reviews.map(review => [review.delegationOperationId, review.verdict, review.reviewer.kind])).toEqual([['delegation-1', 'changes', 'user'], ['delegation-2', 'pass', 'user']])
  expect(saved.status).toBe('in_progress'); expect(saved.grounding?.acceptedAt).toBeUndefined()
  const reviews = f.calls.mock.calls.filter(([method]) => method === 'goal.plan.review')
  expect(reviews).toHaveLength(2)
  expect(reviews.every(call => call[3].actor.kind === 'user')).toBe(true)
  expect(bridge.invoke.mock.calls.some(([channel, method]) => channel === 'demands:delegation' && method === 'goal.plan.review')).toBe(true)
  expect(f.runtime.agentCreation).not.toHaveBeenCalled()
  expect(dom.container.querySelector('.goal-delivery__history')?.textContent).toContain('Changes requested')
  expect(document.activeElement).toBe(dom.container.querySelector('.goal-delivery__receipt'))
})

it('keeps unsent inputs and an uncertain original operation across a detail unmount and actual user-document cold read, then reads the owner without resending', async () => {
  const f = await fixture(); await openDelivery(); await passFields(); await fill('Review note', 'Keep the original draft')
  act(() => editGoalDraft(goalId, 'title', 'Keep the original title draft'))
  const key = goalPlanReviewDraftKey('api', 'delegation-1')
  await dom.render(null); await dom.render(<MountedPlan />); await openDelivery()
  expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Review note"]')!.value).toBe('Keep the original draft')
  f.fail('lost'); await act(async () => button('Pass node').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('review receipt was lost'))
  const original = useAppStore.getState().goalEditDrafts[goalId]!.planReviews![key]!.request!
  let stored: ReturnType<typeof useAppStore.getState>['goalEditDrafts'] = {}
  await vi.waitFor(async () => {
    const bytes = await new WorkbenchUserStateStore(f.user.path).read()
    expect(bytes).not.toBeNull(); stored = JSON.parse(bytes!).state.goalEditDrafts ?? {}
    expect(stored[goalId]?.planReviews?.[key]?.request).toEqual(original)
  })
  expect(stored[goalId].planReviews[key]).not.toHaveProperty('pending')
  expect(stored[goalId].planReviews[key].request).toEqual(original)
  await dom.render(null); useAppStore.setState({ goalEditDrafts: stored }); await dom.render(<MountedPlan />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-goal-plan-node="api"] .goal-plan-node__head')!.click())
  const before = f.delivery.mock.calls.filter(([method]) => method === 'goal.plan.review').length
  f.fail('none'); await act(async () => button('Read original Goal').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Review saved'))
  expect(f.delivery.mock.calls.filter(([method]) => method === 'goal.plan.review')).toHaveLength(before)
  expect((await f.store.get(goalId))!.plan!.reviews).toHaveLength(1)
  expect(useAppStore.getState().goalEditDrafts[goalId]?.planReviews).toBeUndefined()
  expect(useAppStore.getState().goalEditDrafts[goalId]?.title?.value).toBe('Keep the original title draft')
})

it('does not acknowledge a receipt carrying the same operation but another attempt', async () => {
  const f = await fixture(); await openDelivery(); await passFields(); f.fail('wrong-attempt')
  await act(async () => button('Pass node').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('review receipt is unconfirmed'))
  expect(dom.container.querySelector('.goal-delivery__receipt')).toBeNull()
  expect(useAppStore.getState().goalEditDrafts[goalId]!.planReviews![goalPlanReviewDraftKey('api', 'delegation-1')]!.request).toBeDefined()
})

it('sends one frozen review on a rapid double click and does not open an original discussion until asked', async () => {
  const f = await fixture(), thread = vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('The original discussion is temporarily unavailable'))
  await openDelivery(); await passFields(); expect(thread).not.toHaveBeenCalled()
  const pass = button('Pass node')
  await act(async () => { pass.click(); pass.click() })
  await vi.waitFor(() => expect(stateOf('api')).toBe('done'))
  expect(f.delivery.mock.calls.filter(([method]) => method === 'goal.plan.review')).toHaveLength(1)
  expect((await f.store.get(goalId))!.plan!.reviews).toHaveLength(1)
  await act(async () => button('Read original thread').click())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('original discussion is temporarily unavailable'))
  expect(thread).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: 'supervisor' }, 'source-1')
  expect(dom.container.querySelector('.goal-delivery__report')?.textContent).toContain('Delivery 1')
})
