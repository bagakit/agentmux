// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalPlanRevisionInput, GoalPlanState } from '@agentmux/demand/goal-plan'
import { parseGoalDelegationParams } from '@agentmux/core/goal-delegation'
import type { AppConfig } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { readGoalDiscussionBinding } from '../../host/src/goal-discussion-bindings'

// The original Unix Host, Core input journal and Demand file are real. Only
// Electron IPC and Native I/O are controlled. No model or Native daemon is run.
let useAppStore: typeof import('../src/renderer/src/store')['useAppStore']
let currentCoreSpatialGraph: typeof import('../src/renderer/src/store')['currentCoreSpatialGraph']
let prepareRendererUpdate: typeof import('../src/renderer/src/store')['prepareRendererUpdate']
let GlobalBoardSurface: typeof import('../src/renderer/src/components/GlobalBoardSurface')['GlobalBoardSurface']
let api: typeof import('../src/renderer/src/lib/api')['api']
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Host' }],
  workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Private Mote', path: '.', hostId: 'local', kind: 'scratch' }],
  executors: { private: { label: 'Private Agent', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } },
  goals: { requesterAsSupervisor: false }, appearance: { terminalTheme: 'graphite' } } as unknown as AppConfig
const proposal = { summary: 'Preserve the same original work.', criteria: [{ id: 'original', text: 'The original intent and work stay readable.' }], openQuestions: [] }
const originalDescription = 'Keep my original work, including the unsent draft.'
let fixture: Awaited<ReturnType<typeof import('./helpers/host-goal-discussion-fixture')['openHostGoalDiscussionFixture']>>, root: Root, container: HTMLDivElement
let userRoot: string, user: WorkbenchUserStateStore, userWrites: Array<{ payload: string; receipt: unknown }>
let evidence: unknown[], caseName: string
beforeEach(async context => {
  caseName = context.task.name; evidence = []; fixture = undefined as never; container = undefined as never
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.resetModules(); window.localStorage.clear()
  userRoot = await mkdtemp(join(tmpdir(), 'amux-goal-plan-user-')); user = new WorkbenchUserStateStore(join(userRoot, 'workbench-user-state.json')); userWrites = []
  await user.write(JSON.stringify({ state: {}, version: 1 }))
  // The controlled IPC loads as the Web preview; the store is the shipping Desktop
  // one, whose user state lives in the original native document.
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); api = (await import('../src/renderer/src/lib/api')).api
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(async payload => { const receipt = await user.write(payload); userWrites.push({ payload, receipt }); return receipt })
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  ;({ useAppStore, currentCoreSpatialGraph, prepareRendererUpdate } = await import('../src/renderer/src/store'))
  ;({ GlobalBoardSurface } = await import('../src/renderer/src/components/GlobalBoardSurface'))
  useAppStore.setState({ config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board', demandPmoTabIds: {} })
  fixture = await (await import('./helpers/host-goal-discussion-fixture')).openHostGoalDiscussionFixture(config)
  // Main forwards Goal delegation reads to the Host's public RPC as the user; so does this controlled IPC.
  vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) =>
    await fixture.host.rpc.call(method, parseGoalDelegationParams(method, input) as never) as never)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  // DOM geometry is the only graph layout input missing in happy-dom. Positions
  // follow actual rendered columns; neither nodes nor dependency facts are seeded.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const card = this.closest<HTMLElement>('[data-goal-plan-node]'), column = card?.closest<HTMLElement>('[data-goal-plan-column]')
    const left = column ? Number(column.dataset.goalPlanColumn) * 280 : 0
    return { x: left, y: 20, left, top: 20, right: left + (card ? 220 : 800), bottom: 100, width: card ? 220 : 800, height: 80, toJSON: () => ({}) }
  })
})
afterEach(async () => {
  if (!fixture) { if (userRoot) await rm(userRoot, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); return }
  const directory = fixture.host.directory
  try {
    evidence.push({ phase: 'final-owner', goal: await fixture.host.demands.get('discovery'), requests: fixture.host.executed('demand.discuss'),
      controlledNativeWrites: [...fixture.core.writes], nativeUserWrites: userWrites, dom: container.innerHTML })
    await act(async () => root.unmount())
    await fixture.dispose()
    await rm(userRoot, { recursive: true, force: true })
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    evidence.push({ phase: 'cleanup', removedPrivateRoot: true, unixServerAndCoreDisposed: true, nativeDaemonStarted: false })
    if (process.env.GOAL_PLAN_DISCOVERY_EVIDENCE) {
      const directory = process.env.GOAL_PLAN_DISCOVERY_EVIDENCE; await mkdir(directory, { recursive: true })
      await writeFile(join(directory, caseName.replace(/[^a-z0-9]+/giu, '-').slice(0, 100) + '.json'), JSON.stringify({ caseName, evidence }, null, 2) + '\n')
    }
  } finally { container.remove(); vi.restoreAllMocks(); vi.unstubAllEnvs() }
})
async function mount() { await act(async () => root.render(<GlobalBoardSurface />)) }
async function save(alignment = true, supervisor: string | null = fixture.primary.agentSessionId) {
  await seedStoredDemand(fixture.host.demands, { id: 'discovery', title: 'Preserve the same work', description: originalDescription,
    supervisorSessionId: supervisor, assigneeSessionIds: supervisor ? [supervisor] : [], sessionIds: [], status: 'in_progress' })
  await useAppStore.getState().refreshDemand('discovery')
  if (alignment) await useAppStore.getState().updateDemand('discovery', { alignment: proposal })
  useAppStore.setState({ selectedDemandId: 'discovery' }); fixture.host.clear(); await mount()
  expect((await fixture.host.demands.get('discovery'))?.plan).toBeUndefined()
  expect(renderedStates()).toEqual([['discovery', 'goal']])
}
async function requestPlan() {
  const button = container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')
  expect(button, 'The single Goal node exposes its split action').not.toBeNull()
  await act(async () => { button!.click(); await fixture.host.settle() })
  await vi.waitFor(async () => { await act(async () => {}); expect(button!.isConnected && button!.disabled).toBe(false) }, { timeout: 10_000 })
  const request = fixture.host.executed('demand.discuss').at(-1)!
  expect(request).toMatchObject({ operation: 'demand.discuss', demandId: 'discovery', mode: 'plan', requestId: expect.any(String) })
  return request
}
function binding() {
  const original = readGoalDiscussionBinding(currentCoreSpatialGraph()!, 'discovery')!
  expect(original?.recipient.kind).toBe('agent')
  if (original.recipient.kind !== 'agent') throw Error('An exact original discussion Agent is required')
  return { ...original, recipient: original.recipient }
}
function revision(operationId = 'original-plan'): GoalPlanRevisionInput {
  return { operationId, expectedRevision: 0, alignmentRevision: 1,
    nodes: [{ id: 'inspect', title: 'Inspect the original work', outcome: 'Read the original intent', dependsOn: [], criterionIds: ['original'], check: 'node --test checks/original.test.mjs', executor: null },
      { id: 'preserve', title: 'Preserve the same work', outcome: 'Keep the original work', dependsOn: ['inspect'], criterionIds: ['original'], check: 'node --test checks/preserve.test.mjs', executor: null }] }
}
async function cli(args: string[], input?: unknown, caller?: { id: string; capability: string }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|CODEX_)/u.test(key)))
  Object.assign(env, { AGENTMUX_STATE_DIRECTORY: join(fixture.host.directory, 'cli-state'), AGENTMUX_RUNTIME_DIRECTORY: join(fixture.host.directory, 'cli-runtime'),
    AGENTMUX_HOST_CONFIGURATION_PATH: fixture.host.configurationPath, ...(caller ? { AGENTMUX_AGENT_SESSION_ID: caller.id, AGENTMUX_AGENT_CAPABILITY: caller.capability } : {}) })
  if (process.env.GOAL_PLAN_DISCOVERY_CLI_LOADED) env.GOAL_CROSS_HOST_LOADED = process.env.GOAL_PLAN_DISCOVERY_CLI_LOADED
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve('apps/host/test/goal-cross-host-node-loader.mjs'), resolve('packages/core/bin/amux'),
      '--endpoint', 'unix:' + join(fixture.host.directory, 'rpc.sock'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Private CLI exceeded its bounded deadline')) }, 20_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); no(error) }); child.once('close', code => { clearTimeout(timer); yes({ code, stdout, stderr }) })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
  evidence.push({ phase: 'original-public-cli', args, input, actor: caller?.id ?? 'transport-user', ...result })
  return result
}
const renderedStates = () => [...container.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(node => [node.dataset.goalPlanNode, node.dataset.goalPlanState])
async function expectSavedGraph() {
  // Original product refresh reads the same Host owner; the mounted component is
  // retained. No test writes any Renderer plan or Domain plan field.
  await vi.waitFor(() => {
    expect([...container.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(node => node.dataset.goalPlanNode)).toEqual(['inspect', 'preserve'])
    expect([...container.querySelectorAll<HTMLElement>('[data-goal-plan-edge]')].map(edge => edge.dataset.goalPlanEdge)).toEqual(['inspect>preserve'])
    // States and progress are the Host owner's derivation returned with the record.
    expect(renderedStates()).toEqual([['inspect', 'ready'], ['preserve', 'waiting']])
    expect(container.querySelector('[data-goal-meta-plan]')?.textContent).toBe('Plan 0 of 2 done')
    expect(container.querySelector('[data-goal-plan-progress]')?.textContent).toBe('Revision 1')
  })
  const goal = (await fixture.host.demands.get('discovery'))!
  expect(goal.plan?.nodes.map(node => [node.id, node.dependsOn])).toEqual([['inspect', []], ['preserve', ['inspect']]])
  expect(goal.alignment?.confirmedAt).toBeNull(); expect(goal.description).toBe(originalDescription)
  expect(goal.delegations ?? []).toEqual([]); expect(goal.dispatches ?? []).toEqual([])
  evidence.push({ phase: 'real-owner-to-mounted-graph', goal, nodes: ['inspect', 'preserve'], edge: 'inspect>preserve', states: renderedStates() })
}

it('the original Goal record reaches the store and mounted graph before a delegation observer can repair it', async () => {
  const supervisor = fixture.primary.agentSessionId
  await seedStoredDemand(fixture.host.demands, { id: 'discovery', title: 'Preserve the same work', description: originalDescription,
    supervisorSessionId: supervisor, assigneeSessionIds: [supervisor], sessionIds: [], status: 'in_progress' })
  await useAppStore.getState().refreshDemand('discovery')
  await useAppStore.getState().updateDemand('discovery', { alignment: proposal })
  const saved = await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() }, supervisorCredentials())
  expect(saved.code, saved.stderr).toBe(0)
  const owned = await fixture.host.rpc.call('goal.plan', { goalId: 'discovery' })
  expect(owned.planState).toBeDefined()
  await useAppStore.getState().refreshDemand('discovery')
  // No component or delegation observer has been mounted. This exact record path
  // must retain the owner state before another legitimate observation can supply it.
  expect(useAppStore.getState().demands.discovery?.planState).toEqual(owned.planState)
  useAppStore.setState({ selectedDemandId: 'discovery' }); await mount()
  await expectSavedGraph()
})

it('a node delegation read returns the Host owner derivation to the mounted graph', async () => {
  const owner = fixture.primary.agentSessionId
  const worker = await fixture.core.core.createAgent({ agentSessionId: 'worker', providerId: 'codex', executorId: 'private',
    workspacePath: fixture.topic.physicalDirectoryPath!, createOperationId: 'fixture-worker', injectAgentMuxGuide: false })
  await seedStoredDemand(fixture.host.demands, { id: 'discovery', title: 'Preserve the same work', description: originalDescription, status: 'in_progress',
    supervisorSessionId: owner, assigneeSessionIds: [owner, worker.agentSessionId], sessionIds: [owner, worker.agentSessionId] })
  await useAppStore.getState().refreshDemand('discovery')
  await useAppStore.getState().updateDemand('discovery', { alignment: proposal })
  await fixture.host.rpc.call('goal.plan.revise', { goalId: 'discovery', revision: revision('delegated-plan') })
  const supervisor = fixture.core.core.agentSession(owner)
  const capability = fixture.core.start.mock.calls.map(([spec]) => (spec as { env?: Record<string, string | undefined> }).env)
    .find(env => env?.AGENTMUX_AGENT_SESSION_ID === owner)?.AGENTMUX_AGENT_CAPABILITY
  expect(capability, 'The real Core issued the Supervisor Run its capability').toEqual(expect.any(String))
  const { connectAgentMuxRpc } = await import('@agentmux/core')
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(fixture.host.directory, 'rpc.sock') }, credentials: { agentSessionId: owner, capability: capability! } })
  try {
    await client.call('goal.delegation.prepare', { goalId: 'discovery', intent: { operationId: 'delegate-inspect', sourceMessageId: 'source-inspect', hostId: 'local',
      ownerAgentSessionId: owner, workerAgentSessionId: worker.agentSessionId, ownerRunId: supervisor.run.runId, workerRunId: worker.run.runId,
      threadId: 'thread-inspect', text: 'Inspect the original work.', alignmentRevision: 1, criterionIds: ['original'], planNodeId: 'inspect' } })
  } finally { await client.dispose() }
  useAppStore.setState({ selectedDemandId: 'discovery' }); await mount()
  await act(async () => useAppStore.getState().refreshDemand('discovery'))
  // The mounted delegation work reads goal.delegations; that result replaces the plan and its derivation together.
  await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().demands.discovery?.delegationObservations).toBeDefined() }, { timeout: 15_000 })
  const goal = useAppStore.getState().demands.discovery!
  expect(goal.delegationObservationIssue).toBeUndefined()
  expect(goal.delegations?.map(item => item.planNodeId)).toEqual(['inspect'])
  const owned = await fixture.host.rpc.call('goal.plan', { goalId: 'discovery' })
  expect(owned.planState, 'The Host returns its derivation with the plan').toBeDefined()
  expect(renderedStates()).toEqual(owned.planState!.nodes.map(node => [node.id, node.state]))
  expect(renderedStates().map(([, state]) => state)).not.toContain('unavailable')
  evidence.push({ phase: 'delegation-read-to-mounted-graph', goal, owned, rendered: renderedStates() })
})


async function nativeState(state: 'done' | 'working', id = fixture.primary.agentSessionId) {
  const previous = (await fixture.core.store.readMetadata(id))!, now = Date.now()
  await fixture.core.store.compareAndSwapMetadata(previous, { ...previous, semanticStatus: { state, source: 'native-hook', observedAt: now, stateEnteredAt: now,
    nativeTurnId: 'planning-' + now }, updatedAt: now })
  await (fixture.core.core as unknown as { registry: { load(host: string): Promise<void> } }).registry.load('local')
}
function supervisorCredentials() {
  const id = fixture.primary.agentSessionId
  const capability = fixture.core.start.mock.calls.map(([spec]) => (spec as { env?: Record<string, string | undefined> }).env)
    .find(env => env?.AGENTMUX_AGENT_SESSION_ID === id)?.AGENTMUX_AGENT_CAPABILITY
  expect(capability).toEqual(expect.any(String)); return { id, capability: capability! }
}
function planningRequest() {
  return (useAppStore.getState().demands.discovery?.patrols ?? []).find(item => item.purpose === 'plan')!
}

it('only the Supervisor’s saved public plan replaces the single Goal node with the owner DAG', async () => {
  await save(); await nativeState('done')
  const before = (await fixture.host.demands.get('discovery'))!, starts = fixture.core.start.mock.calls.length
  const originalCanvas = container.querySelector('[aria-label="Execution graph"]')
  expect(originalCanvas).not.toBeNull()
  const request = await requestPlan(), original = planningRequest()
  expect(original, 'The new planning request belongs to the Supervisor request owner').toBeDefined()
  const attempt = original.attempts[0]!
  expect(original).toMatchObject({ purpose: 'plan', operationId: request.requestId, supervisorAgentSessionId: fixture.primary.agentSessionId, planRevision: 0 })
  expect(attempt.target.agentSessionId).toBe(fixture.primary.agentSessionId)
  const admitted = await fixture.core.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: attempt.target.agentSessionId,
    expectedRun: { runId: attempt.target.runId }, submissionId: attempt.operationId })
  expect(admitted?.admission?.acknowledged).toBe(true)
  expect(admitted?.admission?.intent?.message?.systemContext).toContain('goal plan revise')
  expect(admitted?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect(container.querySelector('[data-goal-plan-request-feedback]')?.textContent).toContain('waiting for a saved plan')
  expect(container.querySelector('[aria-label="PMO 巡查"]')).toBeNull()
  expect(fixture.core.start.mock.calls.length).toBe(starts)
  expect((await fixture.host.demands.get('discovery'))!.discussionIntent).toBeUndefined()
  expect((await fixture.host.demands.get('discovery'))!.discussionOperationId).toBe(before.discussionOperationId)
  expect(renderedStates()).toEqual([['discovery', 'goal']])
  const saved = await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() }, supervisorCredentials())
  expect(saved.code, saved.stderr).toBe(0)
  expect(JSON.parse(saved.stdout).result.plan.history[0].author).toMatchObject({ kind: 'agent', id: fixture.primary.agentSessionId })
  await expectSavedGraph()
  expect(container.querySelector('[aria-label="Execution graph"]')).toBe(originalCanvas)
  await vi.waitFor(() => expect(container.querySelector<HTMLDetailsElement>('.goal-plan__request > details')?.open).toBe(false))
  const listed = await cli(['goal', 'ls', '--goal', 'discovery'])
  expect(listed.code, listed.stderr).toBe(0)
  const [record] = JSON.parse(listed.stdout).result.goals as Array<{ id: string; planState?: GoalPlanState }>
  expect(record?.planState?.nodes.map(node => [node.id, node.state])).toEqual(renderedStates())
})

it('without a Supervisor the original action is saved before the picker and only an explicit later click sends', async () => {
  await save(true, null)
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [fixture.primary.agentSessionId]: 'Planning Supervisor' } })))
  const before = (await fixture.host.demands.get('discovery'))!
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  const key = JSON.stringify(['discovery', 'plan']), reference = useAppStore.getState().goalDiscussionRequests[key]!
  expect((await user.read())!).toContain(reference.requestId)
  expect(fixture.host.executed('demand.discuss')).toEqual([])
  expect(await fixture.host.demands.get('discovery')).toEqual(before)
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!.click() })
  await act(async () => useAppStore.getState().updateDemand('discovery', { supervisorSessionId: fixture.primary.agentSessionId, assigneeSessionIds: [fixture.primary.agentSessionId] }))
  expect(fixture.host.executed('demand.discuss')).toEqual([])
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toBe('Ask Planning Supervisor to split work')
  await nativeState('done'); const request = await requestPlan()
  expect(request.requestId).toBe(reference.requestId)
  expect(planningRequest().supervisorAgentSessionId).toBe(fixture.primary.agentSessionId)
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toBe('Check request to Planning Supervisor')
})

it('missing alignment keeps its real gap in the Supervisor request and refuses a fabricated plan', async () => {
  await save(false); await nativeState('done'); await requestPlan()
  const goal = (await fixture.host.demands.get('discovery'))!, attempt = goal.patrols![0]!.attempts[0]!
  expect(goal.alignment).toBeUndefined(); expect(goal.plan).toBeUndefined()
  expect(attempt.agentMuxNote).toContain('If the proposal is missing')
  const rejected = await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() }, supervisorCredentials())
  expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('current Goal proposal version')
  expect(renderedStates()).toEqual([['discovery', 'goal']])
})

it('lost planning receipt retains the original request through Renderer rehydrate without repeating input', async () => {
  await save(); await nativeState('done')
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [fixture.primary.agentSessionId]: 'Original Supervisor' } })))
  const gate = fixture.host.once('demand.discuss', { kind: 'lose-receipt' }, request => request.mode === 'plan')
  const request = await requestPlan(); await gate.committed
  const accepted = [...fixture.core.writes], original = (await fixture.host.demands.get('discovery'))!.patrols!.find(item => item.purpose === 'plan')!
  const storage = (await user.read())!
  expect(storage).toContain(request.requestId)
  expect(userWrites.some(write => write.payload.includes(request.requestId))).toBe(true)
  expect(user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
  await act(async () => root.unmount()); await useAppStore.persist.rehydrate(); root = createRoot(container); await mount()
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toBe('Check request to Original Supervisor')
  await requestPlan()
  const attempts = fixture.host.executed('demand.discuss').filter(value => value.mode === 'plan')
  expect(attempts.map(value => value.requestId)).toEqual([request.requestId, request.requestId])
  expect(fixture.core.writes).toEqual(accepted)
  expect(planningRequest().operationId).toBe(original.operationId)
  expect((await fixture.host.demands.get('discovery'))!.plan).toBeUndefined()
  expect(renderedStates()).toEqual([['discovery', 'goal']])
})

it('a failed native planning-reference save sends no Host request and retry keeps the original reference', async () => {
  await save(); await nativeState('done')
  const accepted = [...fixture.core.writes]; let rejectedPayload = ''
  vi.mocked(api.ui.writeWorkbenchState).mockImplementationOnce(async payload => { rejectedPayload = payload; throw Error('Private planning-reference save refused') })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  await vi.waitFor(() => expect(container.textContent).toContain('Private planning-reference save refused'))
  expect(fixture.host.executed('demand.discuss').filter(value => value.mode === 'plan')).toEqual([])
  expect(fixture.core.writes).toEqual(accepted)
  const reference = JSON.parse(rejectedPayload).state.goalDiscussionRequests[JSON.stringify(['discovery', 'plan'])]
  expect(reference.requestId).toEqual(expect.any(String))
  const request = await requestPlan(); expect(request.requestId).toBe(reference.requestId)
})

it('an existing dedicated discussion is retained while a new plan request goes only to its distinct Supervisor', async () => {
  await save(); await act(async () => useAppStore.getState().openDemandPmo('discovery'))
  const original = binding(), starts = fixture.core.start.mock.calls.length
  expect(original.recipient.agentSessionId).not.toBe(fixture.primary.agentSessionId)
  await nativeState('done'); await requestPlan()
  expect(planningRequest().attempts[0]!.target.agentSessionId).toBe(fixture.primary.agentSessionId)
  expect(binding()).toEqual(original); expect(fixture.core.start.mock.calls.length).toBe(starts)
  expect((await fixture.host.demands.get('discovery'))!.delegations ?? []).toEqual([])
})

/** Mount the same destination hook consumed by the floating conversation workface. */
async function mountPlanningDestination() {
  const { usePmoTeamsTopicFloatingState } = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const { usePmoTeamsTopicTarget } = await import('../src/renderer/src/lib/pmo-teams-topic-target')
  function Destination() {
    const [floating] = usePmoTeamsTopicFloatingState(), target = usePmoTeamsTopicTarget(floating)
    return <output data-planning-destination data-pmo-teams-topic-floating tabIndex={-1} data-host={target.session?.hostId ?? ''} data-session={target.session?.kind === 'agent' ? target.session.control.agentSessionId : ''}
      data-tab={target.tabId ?? ''} data-issue={target.identityIssue ?? ''}>{target.label}</output>
  }
  await act(async () => root.render(<><GlobalBoardSurface /><Destination /></>))
}
async function addPlanningNamesake() {
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  await act(async () => useAppStore.setState(state => {
    const primary = state.sessions.find(session => session.id === fixture.primary.agentSessionId)!
    if (primary.kind !== 'agent') throw Error('The original Supervisor presentation is required')
    const duplicate = { ...primary, id: 'other-host-primary', hostId: 'other-host', control: { ...primary.control, hostId: 'other-host' } }
    const original = state.tabs['primary-tab']!, region = original.regions['primary-region']!
    if (region.kind !== 'agent') throw Error('The original Agent Region is required')
    return { sessions: [...state.sessions, duplicate], tabs: { ...state.tabs, 'other-host-tab': createWorkbenchTab('other-host-tab', {
      ...region, regionId: 'other-host-region', sessionId: duplicate.id
    }) } }
  }))
}

it.each(['another-supervisor', 'no-supervisor'] as const)('checking a retained planning request opens its original Supervisor and Host after the Goal chooses %s', async choice => {
  await save(); await nativeState('done'); const request = await requestPlan()
  await useAppStore.getState().openDemandPmo('discovery')
  const replacement = binding().recipient.agentSessionId
  expect(replacement).not.toBe(fixture.primary.agentSessionId)
  await act(async () => useAppStore.getState().updateDemand('discovery', { supervisorSessionId: choice === 'no-supervisor' ? null : replacement, assigneeSessionIds: [fixture.primary.agentSessionId, replacement] }))
  await addPlanningNamesake(); await mountPlanningDestination()
  const before = structuredClone(planningRequest()), writes = [...fixture.core.writes], starts = fixture.core.start.mock.calls.length
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toContain('Check request')
  const { readPmoTeamsTopicFloatingState } = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const gate = fixture.host.once('demand.discuss', { kind: 'hold-receipt' }, request => request.mode === 'plan')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  try {
    await gate.committed
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: fixture.primary.agentSessionId, hostId: 'local' }, targetTabId: 'primary-tab' })
  } finally { gate.release(); await act(async () => fixture.host.settle()) }
  const replay = fixture.host.executed('demand.discuss').at(-1)!
  expect(replay.requestId).toBe(request.requestId)
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: fixture.primary.agentSessionId, hostId: 'local' }, targetTabId: 'primary-tab' })
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-host')).toBe('local')
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-session')).toBe(fixture.primary.agentSessionId)
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-tab')).toBe('primary-tab')
  expect(planningRequest()).toEqual(before); expect(fixture.core.writes).toEqual(writes); expect(fixture.core.start.mock.calls.length).toBe(starts)
})

it('a planning receipt binds the exact Host while an unknown destination never chooses a namesake from inventory', async () => {
  await save(); await nativeState('done'); await addPlanningNamesake(); await mountPlanningDestination()
  const { readPmoTeamsTopicFloatingState } = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const frames: FrameRequestCallback[] = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  const gate = fixture.host.once('demand.discuss', { kind: 'hold-receipt' }, request => request.mode === 'plan')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  try {
    const result = await gate.committed
    expect(result.operation).toBe('demand.discuss')
    expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: null }, targetTabId: null })
    expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-session')).toBe('')
    expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-tab')).toBe('')
  } finally { gate.release(); await act(async () => fixture.host.settle()) }
  await vi.waitFor(() => expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-session')).toBe(fixture.primary.agentSessionId))
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: fixture.primary.agentSessionId, hostId: 'local' }, targetTabId: 'primary-tab' })
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-host')).toBe('local')
  await act(async () => { for (const frame of frames.splice(0)) frame(0) })
  expect(document.activeElement).toBe(container.querySelector('[data-planning-destination]'))
  expect(planningRequest().attempts).toHaveLength(1)
})

it.each(['another-conversation', 'closed'] as const)('a late planning destination receipt preserves the later %s choice, focus and unsent draft', async choice => {
  await save(); await nativeState('done'); await useAppStore.getState().openDemandPmo('discovery')
  const other = binding().recipient.agentSessionId
  await mountPlanningDestination()
  const floating = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const gate = fixture.host.once('demand.discuss', { kind: 'hold-receipt' }, request => request.mode === 'plan')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  await gate.committed
  const writes = [...fixture.core.writes], original = structuredClone((await fixture.host.demands.get('discovery'))!.patrols!)
  await act(async () => {
    if (choice === 'another-conversation') floating.requestAgentConversationFloatingOpen(other, 'local')
    else floating.requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  const selected = structuredClone(floating.readPmoTeamsTopicFloatingState())
  const draft = document.createElement('textarea'); draft.value = 'Keep my exact unsent words\nand the original focus.'; container.append(draft); draft.focus()
  gate.release(); await act(async () => fixture.host.settle())
  await new Promise(resolve => requestAnimationFrame(resolve))
  expect(floating.readPmoTeamsTopicFloatingState()).toEqual(selected)
  expect(document.activeElement).toBe(draft); expect(draft.value).toBe('Keep my exact unsent words\nand the original focus.')
  expect(fixture.core.writes).toEqual(writes)
  expect((await fixture.host.demands.get('discovery'))!.patrols).toEqual(original)
  expect(fixture.host.executed('demand.discuss').filter(request => request.mode === 'plan')).toHaveLength(1)
})

it('a late planning receipt never republishes an older Goal over a newer owner read', async () => {
  // An unopened Goal has no delegation read cut. Its real public write/refresh chain
  // must protect newer facts even without a mounted observer later healing a rollback.
  await seedStoredDemand(fixture.host.demands, { id: 'discovery', title: 'Original Goal', description: originalDescription,
    supervisorSessionId: fixture.primary.agentSessionId, assigneeSessionIds: [fixture.primary.agentSessionId], sessionIds: [], status: 'in_progress' })
  await useAppStore.getState().refreshDemand('discovery')
  await useAppStore.getState().updateDemand('discovery', { alignment: proposal })
  await nativeState('working')
  expect(useAppStore.getState().demands.discovery!.delegationReadCut).toBeUndefined()
  const held = fixture.host.once('demand.discuss', { kind: 'hold-receipt' })
  const pending = useAppStore.getState().requestDemandPmoTask('discovery', 'plan')
  await held.committed
  await fixture.host.demands.update('discovery', { title: 'Newer authoritative Goal' })
  await act(async () => useAppStore.getState().refreshDemand('discovery'))
  const current = useAppStore.getState().demands.discovery!
  expect(current.title).toBe('Newer authoritative Goal'); expect(current.delegationReadCut).toBeUndefined()
  const published: Array<{ title: string; at: number }> = []
  const release = useAppStore.subscribe(state => { const goal = state.demands.discovery; if (goal) published.push({ title: goal.title, at: goal.updatedAt }) })
  try {
    await act(async () => { held.release(); await pending; await fixture.host.settle() })
    expect(published.length).toBeGreaterThan(0)
    expect(published.every(goal => goal.at >= current.updatedAt && goal.title === current.title)).toBe(true)
    expect((await fixture.host.demands.get('discovery'))!.title).toBe(current.title)
    expect(fixture.host.executed('demand.discuss')).toHaveLength(1)
  } finally { release() }
})

it('an original planning request with no confirmed Host keeps navigation unknown despite a lone foreign namesake', async () => {
  await save(); await addPlanningNamesake()
  // Observation fails at the real Host's Core port; the durable request and healthy Core remain.
  const agentSession = fixture.core.core.agentSession.bind(fixture.core.core)
  vi.spyOn(fixture.core.core, 'agentSession').mockImplementation(id => {
    if (id === fixture.primary.agentSessionId) throw Error('The exact original Supervisor observation is unavailable.')
    return agentSession(id)
  })
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== fixture.primary.agentSessionId) })))
  await mountPlanningDestination()
  const { readPmoTeamsTopicFloatingState } = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const request = await requestPlan(), original = structuredClone(planningRequest()), writes = [...fixture.core.writes]
  expect(original.attempts).toEqual([])
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: null }, targetTabId: null })
  const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Open Supervisor conversation')!
  expect(open).toBeDefined(); await act(async () => open.click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: null }, targetTabId: null })
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-session')).toBe('')
  expect(container.querySelector('[data-planning-destination]')?.getAttribute('data-tab')).toBe('')
  const repeated = await requestPlan()
  expect(repeated.requestId).toBe(request.requestId); expect(planningRequest()).toEqual(original)
  expect(fixture.core.writes).toEqual(writes)
})

it('a bare current Supervisor never borrows a foreign Open target and the same unaligned Goal still reaches its real Host owner', async () => {
  await save(false); await nativeState('done'); await addPlanningNamesake()
  const { goalSupervisorHostWitnesses } = await import('@agentmux/demand/relations')
  expect(goalSupervisorHostWitnesses(useAppStore.getState().demands.discovery!)).toEqual([])
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== fixture.primary.agentSessionId),
    agentNames: { ...state.agentNames, 'other-host-primary': 'Foreign namesake' }, agentComposerDrafts: { original: 'Keep the original unsent draft' } })))
  await mountPlanningDestination()
  const floating = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const open = () => [...container.querySelectorAll<HTMLButtonElement>('.goal-plan__request button')].find(button => button.textContent?.trim().endsWith('conversation'))!
  expect(container.querySelector('.goal-plan__request')?.textContent).not.toContain('Foreign namesake')
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toBe('Ask Supervisor to split work')
  await act(async () => open().click())
  expect(floating.readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  expect(floating.readPmoTeamsTopicFloatingState()?.targetAgent).toBeUndefined()
  const starts = fixture.core.start.mock.calls.length
  const held = fixture.host.once('demand.discuss', { kind: 'hold-receipt' }, request => request.mode === 'plan')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  try {
    const receipt = await held.committed
    expect(receipt.operation).toBe('demand.discuss')
    expect(floating.readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  } finally { held.release(); await act(async () => fixture.host.settle()) }
  await vi.waitFor(() => expect(floating.readPmoTeamsTopicFloatingState()?.agentTarget).toEqual({ agentSessionId: fixture.primary.agentSessionId, hostId: 'local' }))
  await act(async () => open().click())
  expect(floating.readPmoTeamsTopicFloatingState()?.agentTarget).toEqual({ agentSessionId: fixture.primary.agentSessionId, hostId: 'local' })
  const saved = (await fixture.host.demands.get('discovery'))!
  expect(saved.alignment).toBeUndefined(); expect(saved.patrols).toHaveLength(1)
  expect(saved.patrols![0]!.attempts[0]!.target).toMatchObject({ agentSessionId: fixture.primary.agentSessionId, hostId: 'local' })
  expect(fixture.host.executed('demand.discuss')).toHaveLength(1)
  expect(fixture.core.start.mock.calls.length).toBe(starts)
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep the original unsent draft')
})

it.each(['same-entry', 'later-conversation'] as const)('an explicit first planning send keeps the original operation and respects the %s receipt entry', async choice => {
  await save(false); await nativeState('done')
  await useAppStore.getState().openDemandPmo('discovery')
  const other = binding().recipient.agentSessionId
  const agentSession = fixture.core.core.agentSession.bind(fixture.core.core)
  let available = false
  vi.spyOn(fixture.core.core, 'agentSession').mockImplementation(id => {
    if (id === fixture.primary.agentSessionId && !available) throw Error('The original route is unavailable.')
    return agentSession(id)
  })
  const before = [...fixture.core.writes], request = await requestPlan()
  expect(planningRequest().attempts).toEqual([]); expect(fixture.core.writes).toEqual(before)
  available = true
  const { refreshGoalDelegations } = await import('../src/renderer/src/lib/goal-delegation-work')
  await act(async () => refreshGoalDelegations('discovery'))
  const floating = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const send = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send planning request')
  expect(send).toBeDefined(); expect(send!.disabled).toBe(false)
  expect(container.querySelector('.goal-plan__request')?.textContent).toContain('First send to')
  const feedback = container.querySelector('.goal-plan__request > [role="status"]')!
  expect(feedback.textContent).toBe('Planning request saved · Not sent yet')
  expect(feedback.classList.contains('goals-service')).toBe(false)
  const observation = container.querySelector('.goal-plan__request > details')!
  expect(observation.querySelector('summary')?.textContent).toBe('Original request observation')
  expect(observation.textContent).toContain(useAppStore.getState().demands.discovery!.patrolObservations!.find(item => item.operationId === request.requestId)!.reason)
  evidence.push({ phase: 'first-destination-candidate', goal: structuredClone(useAppStore.getState().demands.discovery),
    sessions: structuredClone(useAppStore.getState().sessions), config: structuredClone(useAppStore.getState().config),
    tabs: structuredClone(useAppStore.getState().tabs), layouts: structuredClone(useAppStore.getState().layouts) })
  expect(planningRequest().attempts).toEqual([]); expect(fixture.core.writes).toEqual(before)
  const open = [...container.querySelectorAll<HTMLButtonElement>('.goal-plan__request button')].find(button => button.textContent?.trim() === 'Open Supervisor conversation')!
  expect(open).toBeDefined(); await act(async () => open.click())
  expect(floating.readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null }, targetTabId: null })
  const invoke = vi.mocked(api.demands.delegation).getMockImplementation()!
  let release!: () => void, committed!: () => void
  const returned = new Promise<void>(resolve => { committed = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.demands.delegation).mockImplementation(async (method, input) => {
    const result = await invoke(method, input)
    if (method === 'goal.patrol.continue') { committed(); await held }
    return result
  })
  await act(async () => send!.click())
  await returned
  const index = vi.mocked(api.demands.delegation).mock.calls.findLastIndex(([method]) => method === 'goal.patrol.continue')
  const pending = vi.mocked(api.demands.delegation).mock.results[index]!.value
  expect(floating.readPmoTeamsTopicFloatingState()).toMatchObject({ agentTarget: { agentSessionId: null } })
  if (choice === 'later-conversation') await act(async () => { floating.requestAgentConversationFloatingOpen(other, 'local') })
  const selected = structuredClone(floating.readPmoTeamsTopicFloatingState())
  const draft = document.createElement('textarea'); draft.value = 'Keep the later unsent draft'; container.append(draft); draft.focus()
  try { await act(async () => { release(); await pending }) } finally { release() }
  if (choice === 'same-entry') expect(floating.readPmoTeamsTopicFloatingState()?.agentTarget).toEqual({ agentSessionId: fixture.primary.agentSessionId, hostId: 'local' })
  else expect(floating.readPmoTeamsTopicFloatingState()).toEqual(selected)
  expect(document.activeElement).toBe(draft); expect(draft.value).toBe('Keep the later unsent draft')
  expect(planningRequest().operationId).toBe(request.requestId); expect(planningRequest().attempts).toHaveLength(1)
  expect(planningRequest().attempts[0]!.target).toMatchObject({ agentSessionId: fixture.primary.agentSessionId, hostId: 'local' })
  expect(fixture.host.executed('demand.discuss').filter(request => request.mode === 'plan')).toHaveLength(1)
  expect(vi.mocked(api.demands.delegation).mock.calls.filter(([method]) => method === 'goal.patrol.continue')).toHaveLength(1)
})

it('first planning send remains eligible when unrelated worker facts change before the responsibility snapshot refreshes', async () => {
  await save(false); await nativeState('done')
  const agentSession = fixture.core.core.agentSession.bind(fixture.core.core)
  let available = false
  vi.spyOn(fixture.core.core, 'agentSession').mockImplementation(id => {
    if (id === fixture.primary.agentSessionId && !available) throw Error('The original route is unavailable.')
    return agentSession(id)
  })
  const request = await requestPlan()
  available = true
  const { refreshGoalDelegations } = await import('../src/renderer/src/lib/goal-delegation-work')
  const { demandPatrolScope } = await import('@agentmux/demand/goal-patrol')
  const { demandResponsibilityScope } = await import('@agentmux/demand/responsibility')
  await act(async () => refreshGoalDelegations('discovery'))
  const original = structuredClone(planningRequest()), manager = structuredClone(useAppStore.getState().demands.discovery!.responsibility!)
  const invoke = vi.mocked(api.demands.delegation).getMockImplementation()!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.demands.delegation).mockImplementation(async (method, input) => { if (method === 'goal.delegations') await held; return invoke(method, input) })
  try {
    await fixture.host.demands.update('discovery', { assigneeSessionIds: [fixture.primary.agentSessionId, 'unrelated-worker'], sessionIds: [fixture.primary.agentSessionId, 'unrelated-worker'] })
    await fixture.host.demands.prepareDispatch('discovery', { operationId: 'unrelated-worker-intent', agentSessionId: 'unrelated-worker', hostId: 'local', runId: 'unrelated-worker-run', execution: 'finite', prompt: 'A separate retained task intent' })
    await act(async () => useAppStore.getState().refreshDemand('discovery'))
    const current = useAppStore.getState().demands.discovery!
    expect(current.responsibility?.scope).toBe(manager.scope)
    expect(current.responsibility?.scope).not.toBe(demandResponsibilityScope({ ...current, supervisorSessionId: current.supervisorSessionId ?? null }))
    expect(demandPatrolScope((await fixture.host.demands.get('discovery'))!, 'plan')).toBe(original.expectedScope)
    const send = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send planning request')
    expect(send, 'Unrelated worker facts are outside the original planning scope').toBeDefined()
    const callsBefore = vi.mocked(api.demands.delegation).mock.calls.length
    await act(async () => send!.click())
    await vi.waitFor(() => expect(vi.mocked(api.demands.delegation).mock.calls.slice(callsBefore).some(([method]) => method === 'goal.patrol.continue')).toBe(true))
    const index = vi.mocked(api.demands.delegation).mock.calls.findLastIndex(([method]) => method === 'goal.patrol.continue')
    await act(async () => { await vi.mocked(api.demands.delegation).mock.results[index]!.value })
    expect(planningRequest().operationId).toBe(request.requestId)
    expect(planningRequest().attempts).toHaveLength(1)
    expect(planningRequest().attempts[0]!.target).toMatchObject({ agentSessionId: fixture.primary.agentSessionId, hostId: manager.supervisor.hostId, runId: manager.supervisor.runId })
  } finally { release(); await act(async () => refreshGoalDelegations('discovery')) }
})
