// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '@agentmux/core'
import { formatGoalAddress } from '@agentmux/core/sharing'
import { openDemandStore } from '@agentmux/demand'
import { GoalDelegationOwner } from '../../host/src/goal-delegation-owner'
import { projectHostGoal } from '../../host/src/goal-projection'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createWorkbenchUserDocument } from '../src/renderer/src/lib/workbench-user-storage'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { applyGoalDelegationResult } from '../src/renderer/src/lib/goal-delegation-work'
import { editGoalDraft } from '../src/renderer/src/lib/goal-edit-drafts'

const dom = composerDOM(), cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })
const goalId = 'original-assignment-goal', address = formatGoalAddress(goalId, 'runtime-original', 'store-original')
const expectedOwner = { runtimeId: address.runtimeId, namespace: address.namespace }
const author = { kind: 'user' as const, id: 'plan-author' }
const nodes = ['build', 'test'].map(id => ({ id, title: id, outcome: `Deliver ${id}`, dependsOn: id === 'test' ? ['build'] : [],
  criterionIds: ['result'], check: 'check result', executor: null }))

async function workbench() {
  const root = await mkdtemp(join(tmpdir(), 'amx-node-assignment-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(root)
  const store = openDemandStore({ root: join(root, 'goals') })
  await store.create({ id: goalId, title: 'Ship the board', status: 'in_progress', sessionIds: ['worker'], assigneeSessionIds: ['worker'] })
  await store.proposeAlignment(goalId, { summary: 'Deliver', criteria: [{ id: 'result', text: 'A verified release' }], openQuestions: [] })
  await store.revisePlan(goalId, { operationId: 'plan', expectedRevision: 0, alignmentRevision: 1, nodes }, author)
  const runtime = { agentCreation: vi.fn().mockRejectedValue(Error('No execution needed')),
    locateGoalAgentHost(id: string, host?: string) {
      if (id !== 'worker' || host !== 'local') throw Error('Wrong worker identity')
      return 'local'
    } }
  const owner = new GoalDelegationOwner(store, runtime, undefined, undefined, undefined, undefined, undefined, undefined, async () => expectedOwner)
  const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), goalDelegations: owner })
  await server.start(); cleanup.push(() => server.stop())
  const ipc = await owningBridge(undefined, { publicCoreEndpointPath: server.path }); cleanup.push(ipc.dispose)
  await ipc.workbenchUserState.write(JSON.stringify({ state: {}, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => ipc.workbenchUserState.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => ipc.workbenchUserState.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => ipc.workbenchUserState.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const detach = await useAppStore.getState().initialize(); detach()
  cleanup.push(() => prepareRendererUpdate())
  let lost = false
  const calls = vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
    const result = await bridge.api!.demands.delegation(method, input)
    if (method === 'goal.plan.assignment' && lost) throw Error('Lost assignment receipt')
    return result
  })
  const { plan, planState } = await bridge.api!.demands.delegation('goal.plan', { goalId, expectedOwner })
  const demand = { ...projectHostGoal((await store.get(goalId))!, address), plan: plan!, planState: planState! }
  const worker = composerSession('worker'), remote = { ...worker, id: 'remote-occurrence', hostId: 'remote', control: { ...worker.control, hostId: 'remote' } }
  useAppStore.setState({ demands: { [goalId]: demand }, selectedDemandId: goalId, mainSurface: 'board',
    sessions: [worker, remote], agentNames: { worker: 'Release engineer', 'remote-occurrence': 'Remote engineer' }, goalEditDrafts: {} })
  await dom.render(<GlobalBoardSurface />)
  return { store, calls, userDocument: ipc.workbenchUserState, loseReceipt() { lost = true } }
}
const entry = (id: string) => dom.container.querySelector<HTMLButtonElement>(`[data-goal-plan-node="${id}"] button`)!
const assignment = () => dom.container.querySelector<HTMLElement>('[aria-label="Node assignment"]')
async function click(label: string) {
  const button = [...(assignment()?.querySelectorAll('button') ?? [])].find(button => button.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
  await vi.waitFor(async () => {
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    expect(assignment()?.getAttribute('aria-busy')).not.toBe('true')
  })
}
async function choose() {
  await click('Assign agent…')
  await act(async () => assignment()!.querySelector<HTMLButtonElement>('[aria-label="Agent for this node"]')!.click())
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')]
  expect(options.some(option => option.textContent?.includes('Remote engineer') && option.textContent.includes('remote · worker'))).toBe(true)
  const option = options.find(item => item.textContent?.includes('Release engineer'))
  expect(option).toBeDefined(); await act(async () => option!.click())
}

it('opens, closes and assigns the selected node through the board, trusted IPC and original Goal owner', async () => {
  const f = await workbench()
  await act(async () => entry('test').click())
  expect(assignment()).toBeNull()
  await act(async () => entry('build').click())
  expect(entry('build').parentElement!.textContent).toContain('Unassigned')
  await click('Open for claims')
  expect(entry('build').parentElement!.textContent).toContain('Open to claim')
  expect(f.calls).toHaveBeenCalledWith('goal.plan.assignment', expect.objectContaining({ goalId, expectedOwner, nodeId: 'build', expectedRevision: 1, assignment: { kind: 'open' } }))
  await click('Close claims')
  expect(entry('build').parentElement!.textContent).toContain('Unassigned')
  await choose(); await click('Assign')
  const saved = await f.store.get(goalId)
  expect(saved!.plan!.nodes[0]!.executor, assignment()?.textContent).toEqual({ hostId: 'local', agentSessionId: 'worker' })
  expect(saved!.plan!.history.map(record => record.change?.assignment.kind)).toEqual([undefined, 'open', 'close', 'assign'])
  expect(saved!.delegations ?? []).toHaveLength(0)
  expect(entry('build').parentElement!.textContent).toContain('Release engineer')
  expect(dom.container.querySelector('[data-goal-plan-detail="build"]')!.textContent).toContain('Awaiting dispatch')
  expect(entry('build').getAttribute('aria-expanded')).toBe('true')
})

it('retains a lost receipt and an unrelated draft through a cold user-document read and reopens the original board without another write', async () => {
  const f = await workbench()
  await act(async () => { editGoalDraft(goalId, 'description', 'Original draft'); entry('build').click() })
  f.loseReceipt()
  await click('Open for claims')
  expect(assignment()!.textContent).toContain('Lost assignment receipt')
  const before = ((await f.store.get(goalId))!).plan!.history.at(-1)!
  expect(JSON.parse((await f.userDocument.read())!).state.goalEditDrafts[goalId].assignments).toEqual(expect.objectContaining({
    [JSON.stringify([expectedOwner.runtimeId, expectedOwner.namespace, 'build'])]: expect.objectContaining({ request: expect.objectContaining({ operationId: before.operationId, expectedOwner }) })
  }))
  await dom.render(null)
  const previous = useAppStore.persist.getOptions().storage!
  const reopened = new WorkbenchUserStateStore(f.userDocument.path)
  const cold = createWorkbenchUserDocument({ readWorkbenchState: () => reopened.read(), importWorkbenchState: value => reopened.importIfAbsent(value),
    writeWorkbenchState: value => reopened.write(value) }, () => window.localStorage)
  const read = vi.fn(cold.persistent.storage.getItem as typeof previous.getItem)
  try {
    // A new renderer starts with blank memory. Keep this reset out of the original file.
    useAppStore.persist.setOptions({ storage: { ...previous, getItem: read, setItem: () => {} } })
    useAppStore.setState({ goalEditDrafts: {}, selectedDemandId: null })
    await useAppStore.persist.rehydrate()
  } finally { useAppStore.persist.setOptions({ storage: previous }) }
  expect(read).toHaveBeenCalled()
  expect(useAppStore.getState().selectedDemandId).toBe(goalId)
  await dom.render(<GlobalBoardSurface />)
  await act(async () => entry('build').click())
  expect(assignment()!.textContent).toContain(before.operationId)
  await click('Check original request')
  expect(f.calls).toHaveBeenCalledWith('goal.plan', { goalId, expectedOwner })
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(1)
  expect(entry('build').parentElement!.textContent).toContain('Open to claim')
  expect(useAppStore.getState().goalEditDrafts[goalId]).toEqual({ description: expect.objectContaining({ value: 'Original draft' }) })
})

it('bounds a stale selection to its displayed revision and another owner with the same Goal ID cannot consume it', async () => {
  const f = await workbench()
  await act(async () => entry('build').click())
  await choose()
  await f.store.revisePlan(goalId, { operationId: 'parallel-edit', expectedRevision: 1, alignmentRevision: 1, nodes }, author)
  await click('Assign')
  expect((await f.store.get(goalId))!.plan!.nodes[0]!.executor).toBeNull()
  await click('Check original request')
  await click('Use revision 2')
  expect(assignment()!.querySelector('[aria-label="Agent for this node"]')?.textContent).toContain('Release engineer')
  await act(async () => {
    const demand = useAppStore.getState().demands[goalId]!
    useAppStore.setState({ demands: { [goalId]: { ...demand, address: formatGoalAddress(goalId, 'different-runtime', 'same-id') } } })
  })
  await click('Open for claims')
  expect(assignment()!.textContent).toContain('another Goal owner')
  expect((await f.store.get(goalId))!.plan!.history).toHaveLength(2)
})

it('reads the authenticated claimant on its exact Host while the node still awaits dispatch', async () => {
  const f = await workbench()
  await f.store.changePlanAssignment(goalId, 1, 'open-node', { nodeId: 'build', assignment: { kind: 'open' } }, author, () => {})
  await f.store.changePlanAssignment(goalId, 2, 'agent-claimed', { nodeId: 'build', assignment: { kind: 'claim' } },
    { kind: 'agent', id: 'worker', hostId: 'remote', runtimeId: 'worker-runtime' }, () => {})
  const result = await bridge.api!.demands.delegation('goal.plan', { goalId, expectedOwner })
  await act(async () => applyGoalDelegationResult(result))
  expect(entry('build').parentElement!.querySelector('.goal-plan-node__name')?.textContent).toBe('Remote engineer')
  expect(entry('build').parentElement!.getAttribute('data-goal-plan-state')).toBe('ready')
  await act(async () => entry('build').click())
  expect(dom.container.querySelector('[data-goal-plan-detail="build"]')?.textContent).toContain('Claimed · Awaiting dispatch')
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(0)
})
