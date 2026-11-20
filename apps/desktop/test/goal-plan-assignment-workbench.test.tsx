// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
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
  await seedStoredDemand(store, { id: goalId, title: 'Ship the board', status: 'in_progress', sessionIds: ['worker'], assigneeSessionIds: ['worker'] })
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
async function selectExecutor(label: string) {
  await act(async () => assignment()!.querySelector<HTMLButtonElement>('[aria-label="Agent for this node"]')!.click())
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')]
  expect(options.some(option => option.textContent?.includes('Remote engineer') && option.textContent.includes('remote · worker'))).toBe(true)
  const option = options.find(item => item.textContent?.includes(label))
  expect(option).toBeDefined(); await act(async () => option!.click())
}

async function choose() {
  await click('Assign agent…')
  await selectExecutor('Release engineer')
}

it('restores the selected executor after the first assignment checkpoint fails before IPC', async () => {
  const f = await workbench()
  await act(async () => entry('build').click())
  await click('Assign agent…')
  await selectExecutor('Remote engineer')
  await act(async () => editGoalDraft(goalId, 'description', 'Keep this edit'))
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(Error('Desktop storage is busy'))
  await click('Assign')
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(0)
  expect(assignment()?.textContent).toContain('Assignment was not sent.')
  const key = JSON.stringify([address.runtimeId, address.namespace, 'build'])
  expect(useAppStore.getState().goalEditDrafts[goalId]?.assignments?.[key],
    'A known-unsent choice must be editable').toEqual({ choice: { executor: { hostId: 'remote', agentSessionId: 'worker' }, revision: 1 } })
  expect(assignment()?.querySelector('[aria-label="Agent for this node"]')?.textContent).toContain('Remote engineer')
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
  await selectExecutor('Release engineer')
  await click('Assign')
  const saved = (await f.store.get(goalId))!.plan!
  expect(saved.revision).toBe(2)
  expect(saved.nodes[0]!.executor).toEqual({ hostId: 'local', agentSessionId: 'worker' })
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(1)
  expect(useAppStore.getState().goalEditDrafts[goalId]?.description?.value).toBe('Keep this edit')
})

it('preserves the original unknown assignment when a retry fails its own local checkpoint', async () => {
  const f = await workbench()
  await act(async () => entry('build').click())
  // The renderer observes a lost transport before the owner receives this particular request.
  f.calls.mockRejectedValueOnce(Error('Original assignment transport interrupted'))
  await click('Open for claims')
  const key = JSON.stringify([address.runtimeId, address.namespace, 'build'])
  const original = useAppStore.getState().goalEditDrafts[goalId]?.assignments?.[key]?.request
  expect(original?.operationId).toBeTruthy()
  await click('Check original request')
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(Error('Desktop storage is busy'))
  await click('Retry original request')
  expect(useAppStore.getState().goalEditDrafts[goalId]?.assignments?.[key]?.request,
    'A failed retry must keep the earlier unknown operation').toEqual(original)
  expect(assignment()?.textContent).toContain('Retry was not sent.')
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(1)
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
  await click('Check original request')
  await click('Retry original request')
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment').map(([, request]) => request)).toEqual([original, original])
  const saved = (await f.store.get(goalId))!.plan!
  expect(saved.history).toHaveLength(2)
  expect(saved.history[1]!.operationId).toBe(original!.operationId)
})

it('keeps the remounted retry when the older first checkpoint settles late', async () => {
  const f = await workbench()
  await act(async () => entry('build').click())
  let release!: () => void, markReached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { markReached = resolve })
  // The first flush is an observation. Delay the final durability acknowledgement of the first attempt.
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    markReached()
    await held
    throw Error('First checkpoint failed late')
  })
  const openButton = [...assignment()!.querySelectorAll('button')].find(button => button.textContent === 'Open for claims')!
  await act(async () => { openButton.click(); await reached })
  const key = JSON.stringify([address.runtimeId, address.namespace, 'build'])
  const original = useAppStore.getState().goalEditDrafts[goalId]?.assignments?.[key]?.request
  expect(original?.operationId).toBeTruthy()
  try {
    await dom.render(null)
    await dom.render(<GlobalBoardSurface />)
    await act(async () => entry('build').click())
    await click('Check original request')
    f.calls.mockRejectedValueOnce(Error('Retry lost its transport'))
    await click('Retry original request')
  } finally {
    await act(async () => { release(); await held })
  }
  expect(useAppStore.getState().goalEditDrafts[goalId]?.assignments?.[key]?.request,
    'A late completion cannot remove the remounted request').toEqual(original)
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(1)
  await click('Check original request')
  await click('Retry original request')
  expect((await f.store.get(goalId))!.plan!.history[1]!.operationId).toBe(original!.operationId)
})

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
  const opened = await bridge.api!.demands.delegation('goal.plan', { goalId, expectedOwner })
  const token = opened.planState?.nodes.find(node => node.id === 'build')?.claimToken
  expect(token).toBeTruthy()
  await f.store.changePlanAssignment(goalId, token!, 'agent-claimed', { nodeId: 'build', assignment: { kind: 'claim' } },
    { kind: 'agent', id: 'worker', hostId: 'remote', runtimeId: 'worker-runtime' }, () => {}, expectedOwner)
  const result = await bridge.api!.demands.delegation('goal.plan', { goalId, expectedOwner })
  await act(async () => applyGoalDelegationResult(result))
  expect(entry('build').parentElement!.querySelector('.goal-plan-node__name')?.textContent).toBe('Remote engineer')
  expect(entry('build').parentElement!.getAttribute('data-goal-plan-state')).toBe('ready')
  await act(async () => entry('build').click())
  expect(dom.container.querySelector('[data-goal-plan-detail="build"]')?.textContent).toContain('Claimed · Awaiting dispatch')
  expect(f.calls.mock.calls.filter(([method]) => method === 'goal.plan.assignment')).toHaveLength(0)
})
