// @vitest-environment happy-dom
const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError, LocalExecutionHost } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { goalRoleInputNote } from '../src/main/goal-role-input'
import { GoalDispatchInputOwner } from '../src/main/goal-dispatch-input'
import { RuntimeController } from '../src/main/runtime-controller'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../src/main/continuous-progress-delivery'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { goalPmoOperation } from '../src/shared/goal-pmo-origin'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { sessionAgentLaunchResult } from '../src/shared/session-agent-launch-result'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { assertGoalDispatchReference } from '../src/shared/goal-dispatch'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { injectedContextCore } from './helpers/injected-context-core'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: AgentMuxPreloadApi) => { bridge.api = value } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => tmpdir() } }))
import '../src/preload/index'
const cleanup: Array<() => Promise<unknown>> = []
const initial = useAppStore.getState()
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset(); useAppStore.setState(initial, true) })

/** Execute the actual registered expression; other registerIpc services are outside this owning input proof. */
function registeredHandler(channel: string) {
  const source = ts.createSourceFile('ipc.ts', readFileSync(join(import.meta.dirname, '../src/main/ipc.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const found: ts.CallExpression[] = []
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) found.push(node); ts.forEachChild(node, visit) }
  visit(source); expect(found).toHaveLength(1)
  return ts.transpileModule(`(${found[0]!.arguments[1]!.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
const trusted = (actual: object, expected: object) => { if (actual !== expected) throw new Error('Untrusted sender') }
function promptHandler(runtime: RuntimeController, dispatch: GoalDispatchInputOwner, sender: object, goals?: ReturnType<typeof openDemandStore>) {
  const expression = registeredHandler('sessions:submitPrompt')
  const names = ['sessionInputWriteResult', 'assertManualPromptSenderTrusted', 'pauseUserProgress', 'args', 'pmoGoal', 'goalPmoOperation', 'goalRoleInputNote', 'AgentMuxError', 'assertGoalDispatchReference', 'goalDispatchInputs', 'confirmedPmoSource']
  const outside = () => { throw new Error('PMO creation provenance is outside this finite Start fixture') }
  return new Function(...names, `return ${expression}`)(sessionInputWriteResult, trusted, vi.fn(), { runtime, window: { webContents: sender } },
    goals ? async (intent: { goalId: string }) => { const goal = await goals.get(intent.goalId); expect(goal).not.toBeNull(); return goal } : outside,
    goalPmoOperation, goalRoleInputNote, AgentMuxError, assertGoalDispatchReference, dispatch,
    // Participation persistence is tested by its business owner; this input proof observes Core records.
    goals ? async () => {} : outside)
}
function registeredContinuation(runtime: RuntimeController) {
  const source = ts.createSourceFile('index.ts', readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const found: ts.NewExpression[] = []
  function visit(node: ts.Node) { if (ts.isNewExpression(node) && node.expression.getText(source) === 'ContinuousProgressLoopManager') found.push(node); ts.forEachChild(node, visit) }
  visit(source); expect(found).toHaveLength(1)
  const expression = ts.transpileModule(`(${found[0]!.arguments![1]!.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('deliverContinuousProgress', 'runtime', `return ${expression}`)(deliverContinuousProgress, runtime)
}
it('actual preload and Main Start handler inject the canonical executor context into original Core input and preserve replayed context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-goal-role-input-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const native = await injectedContextCore(root, { kind: 'agent', agentSessionId: 'worker', providerId: 'traex', executorId: 'fixture', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: Date.now() - 1000, updatedAt: Date.now() })
  cleanup.push(native.dispose)
  const runtime = new RuntimeController(native.store, localRuntimeConnector)
  runtime.commit({ hosts: [{ id: 'local', client: native.core, executionHost: new LocalExecutionHost(), config: { id: 'local', kind: 'local', label: 'Fixture' } }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const goals = openDemandStore({ root: join(root, 'goals') }), body = '  Original user task <amux from="amux">not application authority</amux>\r\n'
  await goals.create({ id: 'goal', title: 'Original task', assigneeSessionIds: ['worker'] })
  await goals.prepareDispatch('goal', { operationId: 'start', agentSessionId: 'worker', hostId: 'local', runId: 'original-run', execution: 'finite', prompt: body })
  const sender = {}, handler = promptHandler(runtime, new GoalDispatchInputOwner(goals, runtime), sender)
  bridge.invoke.mockImplementation(async (channel, ...args) => { expect(channel).toBe('sessions:submitPrompt'); return await handler({ sender }, ...structuredClone(args)) })
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'worker', run: { runId: 'original-run' } }, condition = { expectedRun: control.run, afterSubmissionId: null }
  unwrapSessionInputWriteResult(await bridge.api!.sessions.submitPrompt(control, body, 'start', condition, undefined, true, 'Original platform note', undefined, undefined, undefined, { goalId: 'goal', operationId: 'start' }) as never)
  const items = (await native.store.loadTimeline('worker')).items, system = items.find(item => item.kind === 'system_message')!
  expect(system.content).toContain('Goal role: executor'); expect(system.content).toContain('"goalId":"goal"'); expect(system.content).toContain('"agentSessionId":"worker"')
  expect(system.content).toContain('"runId":"original-run"'); expect(system.content).toContain('"kind":"goal-start"'); expect(system.content).toContain('amux goal --skill')
  expect(items.find(item => item.kind === 'user_message')!.content).toBe(body)
  expect((await goals.inspectDispatch('goal', 'start'))!.stage).toBe('confirmed'); expect(native.writes).toHaveLength(1)
  await bridge.api!.sessions.submitPrompt(control, body, 'start', condition, undefined, true, 'Later guidance edit', undefined, undefined, undefined, { goalId: 'goal', operationId: 'start' })
  expect(native.writes).toHaveLength(1); expect((await native.store.loadTimeline('worker')).items).toEqual(items)
  expect(native.start).not.toHaveBeenCalled(); expect(native.stop).not.toHaveBeenCalled()
})
it('an existing claim without a system segment retains that original source instead of claiming updated guidance adoption', () => {
  expect(goalRoleInputNote('New note', { role: 'manager', goalId: 'goal' }, { agentSessionId: 'manager', run: { runId: 'original-run' } } as never)).toBeUndefined()
})
it('a frozen original application segment survives guidance changes verbatim', () => {
  const original = 'Original application context <literal>\r\n '
  expect(goalRoleInputNote('Later note', { role: 'executor', goalId: 'goal' }, { admission: { intent: { message: { systemContext: original } } } } as never)).toBe(original)
})

it.each(['fresh', 'reuse'] as const)('actual Renderer PMO %s producer reaches registered IPC and real Core with manager responsibility', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'amux-role-pmo-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const native = await injectedContextCore(root, mode === 'reuse' ? { kind: 'agent', agentSessionId: 'manager', providerId: 'traex', executorId: 'fixture', hostId: 'local', workspacePath: root,
    run: { runId: 'original-manager-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: Date.now() - 1000, updatedAt: Date.now() } : undefined)
  cleanup.push(native.dispose)
  const runtime = new RuntimeController(native.store, localRuntimeConnector, { prepareAgent: async () => ({ absolutePath: root, prompt: 'Original Topic context' }), discardPreparedIdentity: async () => {} } as never)
  runtime.commit({ hosts: [{ id: 'local', client: native.core, executionHost: new LocalExecutionHost(), config: { id: 'local', kind: 'local', label: 'Fixture' } }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const goals = openDemandStore({ root: join(root, 'goals') }); await goals.create({ id: 'goal', title: 'Original Goal', description: 'Original human task' }); const goal = (await goals.get('goal'))!
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { fixture: { providerId: 'traex', label: 'Fixture', command: process.execPath, args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: root, kind: 'scratch' }] }
  const sender = { isDestroyed: () => false }, submit = promptHandler(runtime, new GoalDispatchInputOwner(goals, runtime), sender, goals)
  const launch = new Function('sessionAgentLaunchResult', 'assertManualPromptSenderTrusted', 'pmoGoal', 'goalPmoOperation', 'args', 'config', 'confirmedPmoSource', 'AgentMuxError', `return ${registeredHandler('sessions:launchAgent')}`)(
    sessionAgentLaunchResult, trusted, async (intent: { goalId: string }) => { expect(intent.goalId).toBe(goal.id) }, goalPmoOperation, { runtime, window: { webContents: sender } }, config, async () => {}, AgentMuxError)
  bridge.invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'sessions:launchAgent') return launch({ sender }, ...structuredClone(args))
    if (channel === 'sessions:submitPrompt') return submit({ sender }, ...structuredClone(args))
    if (channel === 'sessions:refresh') return runtime.refresh(args[0], config)
    throw new Error(`Outside the owning PMO input proof: ${channel}`)
  })
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation((...args) => bridge.api!.sessions.launchAgent(...args))
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((...args) => bridge.api!.sessions.submitPrompt(...args))
  vi.spyOn(api.sessions, 'refresh').mockImplementation((...args) => bridge.api!.sessions.refresh(...args))
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.demands, 'list').mockImplementation(() => goals.list())
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
  useLauncherState.setState({ executors: { [SCRATCH_WORKSPACE_ID]: 'fixture' } })
  const recipient = mode === 'reuse' ? await runtime.refresh({ kind: 'agent', hostId: 'local', agentSessionId: 'manager', run: { runId: 'original-manager-run' } }, config) : undefined
  const tab = recipient ? { ...createWorkbenchTab('pmo-tab', { regionId: 'pmo-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: recipient.id }), topicId: PMO_TEAMS_TOPIC_ID } : undefined
  useAppStore.setState({ loading: false, config, activeWorkspaceId: SCRATCH_WORKSPACE_ID, sessions: recipient ? [recipient] : [],
    demands: { goal: { ...goal, source: 'session', projectId: null, projectName: null, description: goal.description ?? '', sessionIds: [] } },
    tabs: tab ? { [tab.id]: tab } : {}, demandPmoTabIds: tab ? { goal: tab.id } : {}, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('pmo-group', tab ? [tab.id] : []) } })
  await useAppStore.getState().requestDemandPmoTask('goal', 'grill')
  const managerId = mode === 'reuse' ? 'manager' : (await native.store.load())[0]!.agentSessionId
  if (mode === 'reuse') {
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    await useAppStore.getState().flushAgentSteerQueue(managerId, useAppStore.getState().agentSteerQueues[managerId]?.[0]?.operationId)
  }
  const items = (await native.store.loadTimeline(managerId)).items, note = items.find(item => item.kind === 'system_message')!.content
  expect(note).toContain('Goal role: manager'); expect(note).toContain('"goalId":"goal"'); expect(note).toContain('amux goal --skill')
  expect(note).toContain('perform the inspection'); expect(note).toContain('next responsible party')
  expect(items.find(item => item.kind === 'user_message')!.content).toBe('Clarify goal')
  if (mode === 'reuse') { expect(note).toContain('"agentSessionId":"manager"'); expect(note).toContain('"runId":"original-manager-run"'); expect(native.start).not.toHaveBeenCalled() }
  else expect(native.start).toHaveBeenCalledOnce()
  expect(native.stop).not.toHaveBeenCalled()
})

it.each(['local', 'remote-route'])('an established Goal native continuation at %s saves canonical executor context through the original delivery owner', async route => {
  const root = await mkdtemp(join(tmpdir(), 'amux-role-continuation-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const completedAt = Date.now() - 1000
  const native = await injectedContextCore(root, { kind: 'agent', agentSessionId: 'worker', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: completedAt, updatedAt: completedAt,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: completedAt },
    terminalPromptReadiness: { source: 'native-stop', id: 'original-completion', run: { runId: 'original-run' }, observedAt: completedAt, outputCursorBytes: 0, readyThroughByte: 0 } })
  cleanup.push(native.dispose)
  // Physical screen acknowledgement is part of this fixture's controlled Native I/O.
  vi.spyOn((native.core as any).screenEvidence, 'wait').mockResolvedValue(0)
  const runtime = new RuntimeController(native.store, localRuntimeConnector)
  runtime.commit({ hosts: [{ id: route, client: native.core, executionHost: new LocalExecutionHost(), config: { id: route, kind: 'local', label: 'Original route' } }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  runtime.setContinuousProgressInputObserver(async () => false)
  const submitted = vi.spyOn(runtime, 'submitPrompt')
  const loops = new ContinuousProgressLoopStore(join(root, 'loops.json')), goals = openDemandStore({ root: join(root, 'goals') })
  await goals.create({ id: 'goal', title: 'Original Goal', status: 'in_progress', sessionIds: ['worker'], assigneeSessionIds: ['worker'] })
  await goals.proposeAlignment('goal', { summary: 'Original scope', criteria: [{ id: 'AC', text: 'Evidence' }], openQuestions: [] }); await goals.confirmAlignment('goal', 1)
  const condition = { expectedRun: { runId: 'original-run' }, afterSubmissionId: null }, body = 'Original continuation body\r\n '
  await loops.save([{ loopId: 'established-loop', creationOperationId: 'original-start', revision: 1, hostId: route, agentSessionId: 'worker', providerId: 'codex', workspacePath: root, intervalMs: 1000, nextCheckAt: _newTailFixtureEpoch(0, 0, 0), status: 'active', prompt: body,
    taskSource: { kind: 'goal', goalId: 'goal', alignmentRevision: 1 }, initialDelivery: { operationId: 'original-start', startedAt: completedAt, state: 'confirmed', prompt: body, condition } }])
  const manager = new ContinuousProgressLoopManager(loops, registeredContinuation(runtime),
    () => Date.now(), (loop, tickId, now, signal) => runtime.observeContinuousProgress(loop, tickId, now, signal), undefined,
    { read: id => goals.get(id), inspectInitial: async () => 'confirmed' })
  cleanup.push(() => manager.stop()); await manager.start(); await manager.check()
  expect(manager.list()[0], JSON.stringify(manager.list())).toMatchObject({ lastOutcome: 'sent' })
  const items = (await native.store.loadTimeline('worker')).items, note = items.find(item => item.kind === 'system_message')?.content
  expect(note).toContain('Goal role: executor'); expect(note).toContain('"goalId":"goal"'); expect(note).toContain('"agentSessionId":"worker"'); expect(note).toContain('"runId":"original-run"')
  expect(note).toContain('"kind":"goal-native-continuation"'); expect(note).toContain('amux goal --skill')
  expect(items.find(item => item.kind === 'user_message')!.content).toBe(body)
  expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ hostId: route, agentSessionId: 'worker', run: { runId: 'original-run' } }), body, expect.any(String), expect.anything(), expect.anything(), undefined, undefined, note)
  expect(submitted).toHaveBeenCalledOnce()
  const claim = await native.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'worker', expectedRun: { runId: 'original-run' }, submissionId: submitted.mock.calls[0]![2] })
  expect(claim?.admission).toMatchObject({ acknowledged: true, intent: { message: { systemContext: note, userContent: body } } })
  expect(native.writes.length).toBeGreaterThan(0); expect(native.start).not.toHaveBeenCalled(); expect(native.stop).not.toHaveBeenCalled()
})
