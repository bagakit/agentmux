// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core/control'
import { callPublicGoalControl, rpcControlResult } from '@agentmux/core'
import { parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { parseGoalDelegationResult } from '@agentmux/core/goal-delegation'
import type { GoalPlanState } from '@agentmux/demand/goal-plan'
import type { AppConfig } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { applyGoalDelegationResult } from '../src/renderer/src/lib/goal-delegation-work'
import { openHostGoalTransport } from './helpers/host-goal-transport'

const initial = useAppStore.getState()
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private original Host' }], workspaces: [],
  appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
let host: Awaited<ReturnType<typeof openHostGoalTransport>>, root: Root, element: HTMLDivElement
let fault: 'missing' | 'structure' | 'association' | null
let writes: Array<{ request: AgentMuxControlRequest; result: AgentMuxControlResult }>
const damage = (goal: { id: string; planState?: GoalPlanState }) => {
  if (goal.id !== 'bad' || !fault) return
  if (fault === 'missing') delete goal.planState
  else if (fault === 'structure') goal.planState!.revision += 1
  else goal.planState!.nodes[0]!.attempt!.delegationOperationId = 'another-operation'
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); fault = null; writes = []
  useAppStore.setState({ ...initial, config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board' })
  host = await openHostGoalTransport({ config })
  // Only the returned wire projection is damaged. The original Host executes and persists
  // every request, then the public RPC codec and the shipping Main adapter both decode it.
  host.execute.mockImplementation(request => callPublicGoalControl(request, async (method, params) => {
    const result = await host.hostGoals.execute(request, undefined, { principal: { kind: 'user', id: 'private-person' } })
    if (!result) throw Error('The original Goal owner must handle this request')
    if (request.operation === 'demand.update') writes.push({ request, result: structuredClone(result) })
    const wire = structuredClone(rpcControlResult(method, result))
    if (wire.goal) damage(wire.goal as never)
    if (Array.isArray(wire.goals)) wire.goals.forEach(goal => damage(goal))
    return parseRpcControlResult(method as never, wire, params)
  }))
  vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
    const value = structuredClone(await host.rpc.call(method, input as never)) as any
    if (input.goalId === 'bad' && fault) damage({ id: 'bad', get planState() { return value.planState }, set planState(state) { value.planState = state } })
    if (input.goalId === 'bad' && fault === 'missing') delete value.planState
    return parseGoalDelegationResult(value, input) as never
  })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(async () => root.unmount()); await host.dispose(); element.remove(); vi.restoreAllMocks(); useAppStore.setState(initial, true) })
async function seed() {
  for (const id of ['bad', 'healthy']) {
    await seedStoredDemand(host.demands, { id, title: id === 'bad' ? 'Keep this original Goal' : 'Healthy other Goal', description: 'Original intent', status: 'in_progress' })
    await useAppStore.getState().refreshDemand(id)
    await useAppStore.getState().updateDemand(id, { alignment: { summary: 'Original outcome', criteria: [{ id: 'criterion', text: 'Original criterion' }], openQuestions: [] } })
    await host.demands.revisePlan(id, { operationId: 'plan-' + id, expectedRevision: 0, alignmentRevision: 1, nodes: [
      { id: 'node', title: 'Original plan node', outcome: 'Keep the original facts', dependsOn: [], criterionIds: ['criterion'], check: 'node original-check.mjs', executor: null }
    ] }, { kind: 'user', id: 'private-person' })
  }
  await host.demands.update('bad', { sessionIds: ['supervisor', 'worker'], assigneeSessionIds: ['supervisor', 'worker'], supervisorSessionId: 'supervisor' })
  await host.demands.prepareDelegation('bad', { operationId: 'original-delegation', sourceMessageId: 'original-source', threadId: 'original-thread', planNodeId: 'node',
    hostId: 'local', ownerAgentSessionId: 'supervisor', workerAgentSessionId: 'worker', ownerRunId: 'original-owner-run', workerRunId: 'original-worker-run',
    text: 'Original task', alignmentRevision: 1, criterionIds: ['criterion'] }, 'supervisor')
  writes = []
}
async function readList() {
  return await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.list', requestId: 'original-list' })
}
async function mount() { await act(async () => { useAppStore.setState({ selectedDemandId: 'bad' }); root.render(<GlobalBoardSurface />) }) }
const states = () => [...element.querySelectorAll('[data-goal-plan-node]')].map(node => node.getAttribute('data-goal-plan-state'))

it.each(['missing', 'structure', 'association'] as const)('the public Goal list isolates %s state while its original plan and a healthy Goal reach the mounted store', async kind => {
  await seed(); fault = kind
  useAppStore.setState({ demands: {} })
  const outcome = await readList().then(value => ({ value }), error => ({ error }))
  expect(outcome, 'The public read must isolate only its derived state').not.toHaveProperty('error')
  expect('value' in outcome && outcome.value).toMatchObject({ operation: 'demand.list' })
  const read = useAppStore.getState().demands
  expect(Object.keys(read).sort()).toEqual(['bad', 'healthy'])
  expect(read.bad).toMatchObject({ plan: { revision: 1 }, delegations: [{ operationId: 'original-delegation', sourceMessageId: 'original-source', threadId: 'original-thread' }] })
  expect(read.bad).not.toHaveProperty('planState')
  expect(read.bad!.planStateIssue).toContain(kind === 'missing' ? 'no derivation' : kind === 'structure' ? 'another plan revision' : 'not one of its delegations')
  expect(read.healthy!.planState?.nodes[0]!.state).toBe('ready')
  await mount()
  expect(element.querySelector('[data-demand-id="bad"]')).not.toBeNull(); expect(element.querySelector('[data-demand-id="healthy"]')).not.toBeNull()
  expect(states()).toEqual(['unavailable'])
  expect(element.querySelector('[data-goal-plan-states-unavailable]')?.textContent).toContain(read.bad!.planStateIssue!)
  expect(element.querySelector('.goal-plan__progress, .goal-plan-node--next')).toBeNull()
  const retry = [...element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read Goal again')!
  fault = null; await act(async () => { retry.click() })
  await vi.waitFor(() => expect(useAppStore.getState().demands.bad!.planStateIssue).toBeUndefined())
  await act(async () => {})
  expect(states()).toEqual(['unknown']); expect(element.querySelector('[data-goal-plan-states-unavailable]')).toBeNull()
  expect(useAppStore.getState().demands.healthy!.planState?.nodes[0]!.state).toBe('ready')
})

it('an actual saved write keeps its original operation and receipt through an invalid derived return without replay', async () => {
  await seed(); await readList(); fault = 'structure'
  const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.update', requestId: 'saved-original-operation', demandId: 'bad', patch: { description: 'Saved once at the original owner' } })
  expect(result.operation).toBe('demand.update')
  if (result.operation !== 'demand.update' || writes[0]!.result.operation !== 'demand.update') throw Error('The actual original write receipt is required')
  expect(result.receipt).toEqual(writes[0]!.result.receipt)
  expect(writes).toHaveLength(1); expect(writes[0]!.request.requestId).toBe('saved-original-operation')
  expect((await host.demands.get('bad'))!.description).toBe('Saved once at the original owner')
  expect(useAppStore.getState().demands.bad).toMatchObject({ description: 'Saved once at the original owner', plan: { revision: 1 }, planStateIssue: expect.stringContaining('another plan revision') })
  expect(useAppStore.getState().demands.bad).not.toHaveProperty('planState')
  await mount(); expect(element.querySelector('[data-goal-plan-states-unavailable]')?.textContent).toContain('another plan revision')
  expect(writes).toHaveLength(1)
})

it('the public delegation read replaces only its derived state and diagnostic and joins a minimal attempt to the exact original delegation', async () => {
  await seed(); await readList()
  const healthy = await api.demands.delegation('goal.delegations', { goalId: 'bad' })
  expect(healthy.planState).toBeDefined()
  expect(healthy.planState!.nodes[0]!.attempt).toEqual({ delegationOperationId: 'original-delegation', reported: false })
  expect(healthy.delegations[0]).toMatchObject({ sourceMessageId: 'original-source', threadId: 'original-thread', workerAgentSessionId: 'worker' })
  fault = 'association'
  await act(async () => applyGoalDelegationResult(await api.demands.delegation('goal.delegations', { goalId: 'bad' })))
  expect(useAppStore.getState().demands.bad).not.toHaveProperty('planState')
  expect(useAppStore.getState().demands.bad!.planStateIssue).toContain('not one of its delegations')
  await mount(); expect(states()).toEqual(['unavailable'])
  fault = null
  await act(async () => applyGoalDelegationResult(await api.demands.delegation('goal.delegations', { goalId: 'bad' })))
  expect(useAppStore.getState().demands.bad).not.toHaveProperty('planStateIssue')
  expect(states()).toEqual(['unknown'])
})
