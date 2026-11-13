// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalPlanRevisionInput } from '@agentmux/demand/goal-plan'
import type { AppConfig } from '../src/shared/contracts'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
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
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(async payload => { const receipt = await user.write(payload); userWrites.push({ payload, receipt }); return receipt })
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  ;({ useAppStore, currentCoreSpatialGraph, prepareRendererUpdate } = await import('../src/renderer/src/store'))
  ;({ GlobalBoardSurface } = await import('../src/renderer/src/components/GlobalBoardSurface'))
  useAppStore.setState({ config, demands: {}, selectedDemandId: null, sessions: [], tabs: {}, layouts: {}, mainSurface: 'board', demandPmoTabIds: {} })
  fixture = await (await import('./helpers/host-goal-discussion-fixture')).openHostGoalDiscussionFixture(config)
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
async function save(alignment = true) {
  await useAppStore.getState().createDemand({ id: 'discovery', title: 'Preserve the same work', description: originalDescription,
    supervisorSessionId: null, assigneeSessionIds: [], sessionIds: [], status: 'in_progress' })
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
async function expectSavedGraph() {
  // Original product refresh reads the same Host owner; the mounted component is
  // retained. No test writes any Renderer plan or Domain plan field.
  await act(async () => useAppStore.getState().refreshDemand('discovery'))
  await vi.waitFor(() => {
    expect([...container.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(node => node.dataset.goalPlanNode)).toEqual(['inspect', 'preserve'])
    expect([...container.querySelectorAll<HTMLElement>('[data-goal-plan-edge]')].map(edge => edge.dataset.goalPlanEdge)).toEqual(['inspect>preserve'])
  })
  const goal = (await fixture.host.demands.get('discovery'))!
  expect(goal.plan?.nodes.map(node => [node.id, node.dependsOn])).toEqual([['inspect', []], ['preserve', ['inspect']]])
  expect(goal.alignment?.confirmedAt).toBeNull(); expect(goal.description).toBe(originalDescription)
  expect(goal.delegations ?? []).toEqual([]); expect(goal.dispatches ?? []).toEqual([])
  evidence.push({ phase: 'real-owner-to-mounted-graph', goal, nodes: ['inspect', 'preserve'], edge: 'inspect>preserve' })
}

it('first planning input ACK leaves the real empty Goal empty until a person uses the public plan producer', async () => {
  await save(); const before = (await fixture.host.demands.get('discovery'))!
  const request = await requestPlan(), original = binding(), recipient = fixture.core.core.agentSession(original.recipient.agentSessionId)
  const creation = await fixture.core.core.inspectAgentCreation(recipient.agentSessionId)
  expect(creation.creation?.createOperationId).toBe(before.discussionOperationId)
  const intent = (await fixture.host.demands.get('discovery'))!.discussionIntent!
  expect(intent).toMatchObject({ requestOperationId: request.requestId, mode: 'plan' })
  expect(intent.prompt).toBe('Make a plan for this existing Goal: discovery.')
  expect(JSON.stringify(fixture.core.start.mock.calls.at(-1)?.[0])).toContain(intent.prompt)
  expect(intent.agentMuxNote).toContain('goal plan revise')
  expect((await fixture.host.demands.get('discovery'))!.plan).toBeUndefined()
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
  expect((await fixture.host.demands.get('discovery'))!.supervisorSessionId).toBe(before.supervisorSessionId)
  expect((await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() })).code).toBe(0)
  await expectSavedGraph()
})

it('reused discussion receives canonical planning input without implicit management or execution', async () => {
  await save(); await act(async () => useAppStore.getState().openDemandPmo('discovery'))
  const original = binding(), agent = fixture.core.core.agentSession(original.recipient.agentSessionId)
  const starts = fixture.core.start.mock.calls.length
  const request = await requestPlan()
  const input = await fixture.core.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: agent.agentSessionId, expectedRun: agent.run, submissionId: request.requestId })
  expect(input?.admission?.acknowledged).toBe(true)
  expect(input?.admission?.intent?.message?.userContent).toBe('Make a plan for this existing Goal: discovery.')
  expect(input?.admission?.intent?.message?.systemContext).toContain('goal plan revise')
  expect(binding()).toEqual(original); expect(fixture.core.start.mock.calls.length).toBe(starts)
  expect((await fixture.host.demands.get('discovery'))!.supervisorSessionId).toBeNull()
  expect((await fixture.host.demands.get('discovery'))!.delegations ?? []).toEqual([])
  // The producer here is an actual transport-authenticated person. The separate
  // Host consumer proves a discussion Agent cannot sign as the Supervisor.
  expect((await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() })).code).toBe(0)
  await expectSavedGraph()
})

it('missing alignment preserves the undefined Goal and refuses a fabricated plan', async () => {
  await save(false); await requestPlan()
  const goal = (await fixture.host.demands.get('discovery'))!
  expect(goal.alignment).toBeUndefined(); expect(goal.plan).toBeUndefined()
  expect(goal.discussionIntent?.agentMuxNote).toMatch(/clarif|criteria|proposal/iu)
  const rejected = await cli(['goal', 'plan', 'revise', '--input', '-'], { goalId: 'discovery', revision: revision() })
  expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('current Goal proposal version')
  await act(async () => useAppStore.getState().refreshDemand('discovery'))
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
  expect((await fixture.host.demands.get('discovery'))!.alignment).toBeUndefined()
  expect((await fixture.host.demands.get('discovery'))!.supervisorSessionId).toBeNull()
})

it('lost planning receipt retains the original request through Renderer rehydrate without repeating input', async () => {
  await save(); await act(async () => useAppStore.getState().openDemandPmo('discovery'))
  const original = binding(), agent = fixture.core.core.agentSession(original.recipient.agentSessionId)
  const gate = fixture.host.once('demand.discuss', { kind: 'lose-receipt' }, request => request.mode === 'plan')
  const request = await requestPlan(); await gate.committed
  const accepted = [...fixture.core.writes]
  const storage = (await user.read())!
  expect(storage).toContain(request.requestId)
  expect(userWrites.some(write => write.payload.includes(request.requestId))).toBe(true)
  expect(user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
  // A fresh production document owner reads the actual original native file.
  // The Store rehydrate below is a Renderer remount, not a claim of App restart.
  const { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY } = await import('../src/renderer/src/lib/workbench-user-storage')
  const freshDocument = createWorkbenchUserDocument({ readWorkbenchState: () => user.read(), importWorkbenchState: value => user.importIfAbsent(value), writeWorkbenchState: value => user.write(value) }, () => window.localStorage)
  const restored = await freshDocument.persistent.storage.getItem(WORKBENCH_USER_STATE_KEY)
  expect(JSON.stringify(restored)).toContain(request.requestId)
  evidence.push({ phase: 'native-original-request', storage, freshDocumentRead: restored, nativeInputCount: accepted.length })
  await act(async () => root.unmount()); await useAppStore.persist.rehydrate()
  root = createRoot(container); await mount(); await requestPlan()
  const attempts = fixture.host.executed('demand.discuss').filter(value => value.mode === 'plan')
  expect(attempts).toHaveLength(2); expect(attempts.map(value => value.requestId)).toEqual([request.requestId, request.requestId])
  expect(fixture.core.writes).toEqual(accepted)
  expect(binding()).toEqual(original); expect(fixture.core.core.agentSession(agent.agentSessionId).run).toEqual(agent.run)
  expect((await fixture.host.demands.get('discovery'))!.plan).toBeUndefined()
  expect(container.querySelectorAll('[data-goal-plan-node]')).toHaveLength(0)
})

it('finishes the original frozen clarification creation before sending a new planning request', async () => {
  await save()
  const creationOperationId = (await fixture.host.demands.get('discovery'))!.discussionOperationId
  const { AgentMuxControlServer } = await import('@agentmux/core')
  const call = AgentMuxControlServer.prototype.callRpc, starts = fixture.core.start.mock.calls.length
  let withheld = false
  // The real Core commits the original creation. Only its reply back to the
  // Host discussion owner is lost, before the Host can save its binding.
  vi.spyOn(AgentMuxControlServer.prototype, 'callRpc').mockImplementation(async function (method, ...args) {
    const result = await call.call(this, method, ...args)
    if (method === 'agent.open' && !withheld) { withheld = true; throw Error('Private original agent.open reply withheld after actual creation') }
    return result
  })
  await expect(useAppStore.getState().requestDemandPmoTask('discovery', 'grill')).rejects.toBeTruthy()
  expect(withheld).toBe(true); expect(fixture.core.start.mock.calls.length).toBe(starts + 1)
  const frozen = (await fixture.host.demands.get('discovery'))!.discussionIntent!
  expect(frozen.mode).toBe('grill')
  const request = await requestPlan(), original = binding(), agent = fixture.core.core.agentSession(original.recipient.agentSessionId)
  expect(request.requestId).not.toBe(frozen.requestOperationId)
  const created = await fixture.core.core.inspectAgentCreation(agent.agentSessionId)
  expect(created.creation?.createOperationId).toBe(creationOperationId)
  expect((await fixture.host.demands.get('discovery'))!.discussionIntent).toEqual(frozen)
  const input = await fixture.core.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: agent.agentSessionId, expectedRun: agent.run, submissionId: request.requestId })
  expect(input?.admission?.acknowledged).toBe(true)
  expect(input?.admission?.intent?.message?.userContent).toBe('Make a plan for this existing Goal: discovery.')
  const timeline = (await fixture.core.store.loadTimeline(agent.agentSessionId)).items.filter(item => item.kind === 'user_message')
  expect(timeline.filter(item => item.content === 'Clarify this existing Goal.')).toHaveLength(1)
  expect(timeline.filter(item => item.content === 'Make a plan for this existing Goal: discovery.')).toHaveLength(1)
  expect(fixture.core.core.agentSessions().filter(value => value.agentSessionId !== fixture.primary.agentSessionId)).toHaveLength(1)
  expect(fixture.core.start.mock.calls.length).toBe(starts + 1)
  expect((await fixture.host.demands.get('discovery'))!.plan).toBeUndefined()
  evidence.push({ phase: 'frozen-clarification-then-plan', creationOperationId, frozen, request, created, input, timeline })
})

it('a failed native planning-reference save sends no Host request and retry keeps the original reference', async () => {
  await save(); await act(async () => useAppStore.getState().openDemandPmo('discovery'))
  const original = binding(), accepted = [...fixture.core.writes]
  let rejectedPayload = ''
  vi.mocked(api.ui.writeWorkbenchState).mockImplementationOnce(async payload => { rejectedPayload = payload; throw Error('Private planning-reference save refused') })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-plan-request]')!.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('Private planning-reference save refused') }, { timeout: 10_000 })
  expect(fixture.host.executed('demand.discuss').filter(value => value.mode === 'plan')).toEqual([])
  expect(fixture.core.writes).toEqual(accepted)
  const persistedValues = Object.values(JSON.parse(rejectedPayload).state).flatMap(value => value && typeof value === 'object' ? Object.values(value) : [])
  const reference = persistedValues.find((value: any) => value?.goalId === 'discovery' && value?.mode === 'plan') as { requestId: string }
  expect(reference?.requestId).toEqual(expect.any(String))
  const request = await requestPlan()
  expect(request.requestId).toBe(reference.requestId)
  expect(binding()).toEqual(original)
  expect((await fixture.host.demands.get('discovery'))!.plan).toBeUndefined()
  expect((await fixture.host.demands.get('discovery'))!.supervisorSessionId).toBeNull()
  evidence.push({ phase: 'native-save-refusal-before-input', rejectedPayload, request, unchangedInputBeforeRetry: accepted })
})
