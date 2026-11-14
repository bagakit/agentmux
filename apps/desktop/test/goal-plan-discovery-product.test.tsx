// @vitest-environment happy-dom
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
  await useAppStore.getState().createDemand({ id: 'discovery', title: 'Preserve the same work', description: originalDescription,
    supervisorSessionId: supervisor, assigneeSessionIds: supervisor ? [supervisor] : [], sessionIds: [], status: 'in_progress' })
  if (alignment) await useAppStore.getState().updateDemand('discovery', { alignment: proposal })
  useAppStore.setState({ selectedDemandId: 'discovery' }); fixture.host.clear(); await mount()
  expect((await fixture.host.demands.get('discovery'))?.plan).toBeUndefined()
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
}
async function requestPlan() {
  const button = container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')
  expect(button, 'The real empty Goal exposes its planning action').not.toBeNull()
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
    expect(container.querySelector('[data-goal-plan-progress]')?.textContent).toBe('0 of 2 done · revision 1')
  })
  const goal = (await fixture.host.demands.get('discovery'))!
  expect(goal.plan?.nodes.map(node => [node.id, node.dependsOn])).toEqual([['inspect', []], ['preserve', ['inspect']]])
  expect(goal.alignment?.confirmedAt).toBeNull(); expect(goal.description).toBe(originalDescription)
  expect(goal.delegations ?? []).toEqual([]); expect(goal.dispatches ?? []).toEqual([])
  evidence.push({ phase: 'real-owner-to-mounted-graph', goal, nodes: ['inspect', 'preserve'], edge: 'inspect>preserve', states: renderedStates() })
}

it('the original Goal record reaches the store and mounted graph before a delegation observer can repair it', async () => {
  const supervisor = fixture.primary.agentSessionId
  await useAppStore.getState().createDemand({ id: 'discovery', title: 'Preserve the same work', description: originalDescription,
    supervisorSessionId: supervisor, assigneeSessionIds: [supervisor], sessionIds: [], status: 'in_progress' })
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
  await fixture.host.demands.create({ id: 'discovery', title: 'Preserve the same work', description: originalDescription, status: 'in_progress',
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

it('a planning input reaches the Supervisor and only its saved public plan replaces the real empty Goal with the owner DAG', async () => {
  await save(); await nativeState('done')
  const before = (await fixture.host.demands.get('discovery'))!, starts = fixture.core.start.mock.calls.length
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
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
  const saved = await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() }, supervisorCredentials())
  expect(saved.code, saved.stderr).toBe(0)
  expect(JSON.parse(saved.stdout).result.plan.history[0].author).toMatchObject({ kind: 'agent', id: fixture.primary.agentSessionId })
  await expectSavedGraph()
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
  expect(container.querySelector('[data-goal-plan-request]')?.textContent).toBe('Ask Planning Supervisor to plan')
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
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
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
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
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
