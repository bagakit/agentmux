// @vitest-environment happy-dom
import './helpers/goal-responsibility-product'
import { fixture, mount, container, settle, evidence, record, cleanup } from './helpers/goal-responsibility-product'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '@agentmux/core'
import { rpcControlRequest, rpcControlResult, parseRpcControlResult, assertControlResultTarget } from '../../../packages/core/src/rpc-business-codec'
import type { CtxmuxAdapterRun } from '../../../packages/core/src/ctxmux-run-adapter'
import { MAX_AGENT_PROMPT_BYTES } from '../../../packages/core/src/agent-prompt-budget'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { requestGlobalGoalPatrol } from '../src/renderer/src/components/GlobalGoalPatrolControl'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose, subscribePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { publishWorkbenchTabRemoved } from '../src/renderer/src/lib/workbench-tab-removal'
import { moteTopics, seedMoteWorkface, scratchWorkspace } from './fixtures/mote-workface'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import type { AgentLaunchInput, AgentLaunchResult, SessionSnapshot } from '../src/shared/contracts'

afterEach(async () => { await act(async () => { localStorage.clear(); requestPmoTeamsTopicFloatingClose() }) })
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
async function prepared() {
  localStorage.clear()
  const f = await fixture({ patrol: true })
  seedMoteWorkface()
  const state = useAppStore.getState(), topics = structuredClone(moteTopics)
  topics[0]!.quickMode = { status: 'saved', defaults: { executorId: 'global-fixture' } }
  const workspace = { ...scratchWorkspace, path: f.directory }
  // Only Native transport/hooks/probe and the Desktop IPC wire are isolated.
  // Core owns the original creation reservation, caller, first input and persistence.
  const boundary = f.client as unknown as { kernel: Record<string, unknown>; hookServer: Record<string, unknown>;
    ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
  const nativeRuns: CtxmuxAdapterRun[] = []
  const oldList = boundary.kernel.list as () => Promise<CtxmuxAdapterRun[]>
  const oldStatus = boundary.kernel.status as (id: string) => Promise<CtxmuxAdapterRun>
  const start = vi.fn(async (input: { operationKey: string; cwd: string; program: string; args: string[] }) => {
    const run: CtxmuxAdapterRun = { nativeService: null, runId: 'global-run-' + nativeRuns.length,
      lifecycleOperationId: input.operationKey, program: input.program, args: input.args, workspacePath: input.cwd,
      pid: 1234, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
    nativeRuns.push(run); return run
  })
  Object.assign(boundary.kernel, { start, list: async () => [...await oldList(), ...nativeRuns],
    status: async (id: string) => nativeRuns.find(run => run.runId === id) ?? await oldStatus(id) })
  boundary.hookServer.isRunning = () => true
  boundary.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  boundary.ensureManagedHooks = async () => {}
  boundary.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  vi.spyOn(f.client, 'probeAgent').mockImplementation(async providerId => ({ providerId, executable: '/bin/sh', installed: true,
    capabilities: f.client.providers.get(providerId).catalog.capabilities }))
  useAppStore.setState({ config: { ...state.config!, executors: { 'global-fixture': { label: 'Saved PMO executor', providerId: 'claude', command: '/bin/sh', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [workspace, state.config!.workspaces.find(item => item.id === 'project')!] },
    spatialRequests: {}, spaceZoneBindings: {},
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'creation').mockImplementation(async (_host, id) => {
    const session = await f.sessions.readMetadata(id)
    if (!session) throw new Error('The exact original creation is not observed.')
    return session as AgentMuxAgentSession
  })
  const launches: Array<{ input: AgentLaunchInput; result: AgentLaunchResult }> = []
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const created = await f.client.createAgentWithDelivery({ ...input, providerId: 'claude', commandOverride: '/bin/sh', injectAgentMuxGuide: false })
    const original = created.session
    const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: original.agentSessionId, kind: 'agent', providerId: original.providerId,
      executorId: original.executorId, hostId: original.hostId, workspacePath: original.workspacePath, label: 'Global PMO',
      createdAt: original.createdAt, updatedAt: original.updatedAt, agentSessionUpdatedAt: original.updatedAt, latestOutputBytes: 0,
      processState: 'running', status: { state: 'running', source: 'run-process', observedAt: Date.now() },
      capabilities: f.client.providers.get('claude').catalog.capabilities, creation: created.creation,
      control: { kind: 'agent', hostId: original.hostId, agentSessionId: original.agentSessionId, run: original.run } }
    const result: AgentLaunchResult = { created: original, creation: created.creation, session,
      timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
    launches.push({ input: structuredClone(input), result }); return result
  })
  const seeded = useAppStore.getState()
  vi.spyOn(api.config, 'get').mockResolvedValue(seeded.config!)
  vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  let spatial: Awaited<ReturnType<typeof api.spatial.read>> = null
  vi.spyOn(api.spatial, 'read').mockImplementation(async () => structuredClone(spatial))
  vi.spyOn(api.spatial, 'commit').mockImplementation(async input => {
    if ((spatial?.revision ?? 0) !== input.expectedRevision) throw new Error('Original spatial version changed')
    spatial = { schemaVersion: 1, revision: input.expectedRevision + 1, graph: structuredClone(input.graph) }; return structuredClone(spatial)
  })
  vi.spyOn(api.spatial, 'onChange').mockImplementation(() => () => {})
  useAppStore.setState({ restoredWorkbench: null })
  cleanup.push(await useAppStore.getState().initialize())
  expect(useAppStore.getState().config, useAppStore.getState().error ?? '').not.toBeNull()
  useAppStore.setState({ config: seeded.config, tabs: seeded.tabs, layouts: seeded.layouts,
    sessions: seeded.sessions, scratchTopicSnapshots: seeded.scratchTopicSnapshots, activeWorkspaceId: seeded.activeWorkspaceId,
    mainSurface: seeded.mainSurface, spatialRequests: {}, spaceZoneBindings: {} })
  for (const status of ['backlog', 'done', 'cancelled', 'blocked'] as const) await f.demands.create({ id: 'global-' + status, title: 'Other project ' + status, status, projectId: 'other-project', projectName: 'Other actual project' })
  const all = (await f.demands.snapshot()).demands
  useAppStore.setState({ demands: Object.fromEntries(all.map(goal => [goal.id, { ...record(goal), projectId: goal.projectId, projectName: goal.projectName }])) })
  return { f, start, nativeRuns, launches, launch, all }
}
function scope(prompt: string) {
  const original = prompt.split('\n').find(line => line.startsWith('{"schema":"agentmux.goal-global-patrol-scope.v1"'))
  expect(original).toBeDefined()
  return JSON.parse(original!) as { state: string; totalCount?: number; inventory?: string; reason?: string }
}

describe('global PMO inspection uses one public creation/input owner and the original exact Tab', () => {
  it('mounted Goals action opens a new primary Mote Tab before slow launch, includes finished/other-project Goals, and sends one real Core first prompt', async () => {
    const p = await prepared(), before = useAppStore.getState()
    await mount(createElement(GlobalBoardSurface))
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search goals"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'no goal matches'); search.dispatchEvent(new Event('input', { bubbles: true })); search.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const originalLaunch = p.launch.getMockImplementation()!
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    p.launch.mockImplementation(async input => { await gate; return await originalLaunch(input) })
    try {
      await act(async () => button(container.textContent?.includes('新巡查') ? '新巡查' : '全局巡查').click())
      await act(async () => { await vi.waitFor(() => expect(p.launch).toHaveBeenCalledOnce()) })
      const floating = readPmoTeamsTopicFloatingState(), held = Object.values(useAppStore.getState().spatialRequests)[0]!
      expect(floating?.open).toBe(true); expect(floating?.reference?.tabId).toBe(held.tabId)
      expect(held.purpose).toBe('goal-global-patrol'); expect(before.tabs[held.tabId]).toBeUndefined()
      expect(useAppStore.getState().tabs[held.tabId]?.topicId).toBe(PMO_TEAMS_TOPIC_ID)
      expect(useAppStore.getState().activeWorkspaceId).toBe(before.activeWorkspaceId)
      expect(p.start).not.toHaveBeenCalled()
      expect(useAppStore.getState().viewModes[held.agentSessionId]).toBe('activity')
      // A later explicit mode choice wins over the eventual launch receipt.
      useAppStore.getState().setViewMode(held.agentSessionId, 'terminal', { focus: false })
    } finally { await act(async () => release()) }
    await act(async () => { await requestGlobalGoalPatrol(); await vi.waitFor(() => expect(p.launches).toHaveLength(1)) }); await settle()
    const { input, result } = p.launches[0]!, observed = scope(input.prompt!)
    expect(observed.state).toBe('observed')
    expect(observed.totalCount).toBe(p.all.length)
    expect(observed.inventory).toContain('not-inlined')
    const discovered = await p.f.cli('owner', ['goal', 'ls'])
    expect(discovered.result.goals.map((goal: { id: string }) => goal.id).sort()).toEqual(p.all.map(goal => goal.id).sort())
    expect(discovered.result.goals.some((goal: { status: string; projectId: string }) => goal.status === 'done' && goal.projectId === 'other-project')).toBe(true)
    expect(input.prompt).toContain('confirm selected actions'); expect(input.prompt).toContain('operations and effects')
    expect(result.creation?.initialPrompt).toBe('confirmed'); expect(p.start).toHaveBeenCalledOnce()
    expect(useAppStore.getState().viewModes[input.agentSessionId!]).toBe('terminal')
    expect(p.nativeRuns[0]!.args.join('\n')).toContain(input.prompt!)
    expect(await p.f.sessions.readMetadata(input.agentSessionId!)).toMatchObject({ agentSessionId: input.agentSessionId, creation: { createOperationId: input.createOperationId, initialPrompt: 'confirmed' } })
    const tabId = readPmoTeamsTopicFloatingState().reference!.tabId
    await act(async () => requestPmoTeamsTopicFloatingClose())
    await act(async () => button('检查本次巡查').click()); await settle()
    expect(readPmoTeamsTopicFloatingState().reference!.tabId).toBe(tabId)
    expect(p.launch).toHaveBeenCalledOnce(); expect(p.start).toHaveBeenCalledOnce()
    await evidence('global-patrol-gui-original-core-creation-and-first-input', { launches: p.launches, nativeRuns: p.nativeRuns,
      binding: useAppStore.getState().spatialRequests[input.createOperationId!], promptScope: observed, dom: container.innerHTML }, 'patrol')
    if (process.env.AGENTMUX_GOAL_PATROL_RECEIPT_DIR) {
      const current = useAppStore.getState()
      const state = { config: current.config, tabs: current.tabs, layouts: current.layouts, sessions: current.sessions,
        timelines: current.timelines, scratchTopicSnapshots: current.scratchTopicSnapshots, demands: current.demands,
        spatialRequests: current.spatialRequests, spaceZoneBindings: current.spaceZoneBindings, activeWorkspaceId: current.activeWorkspaceId,
        mainSurface: current.mainSurface, agentFocus: current.agentFocus, agentComposerDrafts: current.agentComposerDrafts,
        viewModes: current.viewModes, restoredWorkbench: current.restoredWorkbench }
      const bytes = JSON.stringify({ schema: 'agentmux.global-patrol-visual-source.v1', operationId: input.createOperationId,
        state, launch: p.launches[0], nativeRuns: p.nativeRuns, originalAgentMetadata: await p.f.sessions.readMetadata(input.agentSessionId!),
        boundary: 'Actual production GUI, original spatial owner and Core creation/initial input with controlled Native transport. Renderer consumes this exact immutable snapshot; no new creation or model inspection is claimed.' }, null, 2) + '\n'
      const file = resolve(process.env.AGENTMUX_GOAL_PATROL_RECEIPT_DIR, 'global-journey.json')
      await fs.writeFile(file, bytes); await fs.writeFile(file + '.sha256', createHash('sha256').update(bytes).digest('hex') + '\n')
    }
  }, 30_000)

  it('compiled public CLI discovers the command, preserves authenticated caller, and inspects the same operation without rereading scope or launching again', async () => {
    const p = await prepared(), operationId = 'global-public-original'
    const help = await promisify(execFile)(process.execPath, [resolve('packages/core/dist/agentmux.js'), 'goal', 'patrol', 'all', '--help'])
    expect(help.stdout).toContain('--operation-id')
    const skill = await promisify(execFile)(process.execPath, [resolve('packages/core/dist/agentmux.js'), 'goal', '--skill'])
    expect(skill.stdout).toContain('goal patrol all --operation-id')
    expect(skill.stdout).toContain('Only after that actual confirmation')
    const first = await p.f.cli('owner', ['goal', 'patrol', 'all', '--operation-id', operationId])
    expect(first.ok).toBe(true); expect(first.result.agent.initialPrompt).toBe('confirmed')
    expect(first.result.operationId).toBe(operationId); expect(p.launches).toHaveLength(1)
    expect(p.launches[0]!.result.creation?.createdBy?.agentSessionId).toBe('owner')
    const reads = vi.mocked(api.demands.list).mock.calls.length
    const repeat = await p.f.cli('owner', ['goal', 'patrol', 'all', '--operation-id', operationId])
    expect(repeat.result.agent.agentSessionId).toBe(first.result.agent.agentSessionId)
    expect(repeat.result.to.tabId).toBe(first.result.to.tabId)
    expect(vi.mocked(api.demands.list).mock.calls).toHaveLength(reads)
    expect(p.start).toHaveBeenCalledOnce(); expect(p.launch).toHaveBeenCalledOnce()
    await evidence('global-patrol-compiled-cli-same-operation-no-replay', { first, repeat, launches: p.launches, nativeRuns: p.nativeRuns, proof: await p.f.proof() }, 'patrol')
  }, 30_000)

  it('inventory observation failure still opens the original healthy PMO path and exposes unknown scope', async () => {
    const p = await prepared()
    vi.mocked(api.demands.list).mockRejectedValue(new Error('Original inventory read unavailable'))
    let result: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'global-unavailable-scope', operation: 'demand.patrol-all' }) })
    expect(result!.operation).toBe('demand.patrol-all')
    if (result!.operation !== 'demand.patrol-all') throw new Error('Wrong operation')
    expect(result!.outcome).toBe('partial'); expect(result!.issues.some(issue => issue.code === 'GOAL_INVENTORY_UNAVAILABLE')).toBe(true)
    expect(scope(p.launches[0]!.input.prompt!)).toEqual(expect.objectContaining({ state: 'unavailable', reason: 'Original inventory read unavailable' }))
    expect(p.start).toHaveBeenCalledOnce(); expect(readPmoTeamsTopicFloatingState().open).toBe(true)
  }, 30_000)

  it('lost launch acknowledgement retains exact original creation; same operation reconciles without a second launch or input', async () => {
    const p = await prepared(), actual = p.launch.getMockImplementation()!
    p.launch.mockImplementationOnce(async input => { await actual(input); throw new Error('Original Desktop launch acknowledgement lost') })
    let first: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { first = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'global-lost-ack', operation: 'demand.patrol-all' }) })
    expect(first!.operation).toBe('demand.patrol-all'); expect(p.start).toHaveBeenCalledOnce()
    const held = structuredClone(useAppStore.getState().spatialRequests['global-lost-ack']!)
    const second = await p.f.cli('owner', ['goal', 'patrol', 'all', '--operation-id', 'global-lost-ack'])
    expect(second.result.agent.agentSessionId).toBe(held.agentSessionId)
    expect(second.result.agent.initialPrompt).toBe('confirmed')
    expect(useAppStore.getState().spatialRequests['global-lost-ack']!.tabId).toBe(held.tabId)
    expect(p.launch).toHaveBeenCalledOnce(); expect(p.start).toHaveBeenCalledOnce()
  }, 30_000)

  it('public codecs require explicit original intent and refuse a receipt for another creation', async () => {
    const p = await prepared(), operationId = 'global-codec-original'
    expect(() => rpcControlRequest('goal.patrol.all', {})).toThrow('operationId')
    expect(() => rpcControlRequest('goal.patrol.all', { operationId, goalId: 'goal' })).toThrow()
    expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: operationId, operation: 'demand.patrol-all', destination: { newTab: true } })).toThrow()
    const request = rpcControlRequest('goal.patrol.all', { operationId })
    let result: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['executeControl']>>
    await act(async () => { result = await useAppStore.getState().executeControl(request) })
    expect(result!.operation).toBe('demand.patrol-all')
    if (result!.operation !== 'demand.patrol-all' || !result!.agent) throw new Error('Original global creation not observed')
    const body = rpcControlResult('goal.patrol.all', result!)
    expect(parseRpcControlResult('goal.patrol.all', body, { operationId })).toEqual(body)
    expect(() => assertControlResultTarget(request, { ...result!, agent: { ...result!.agent!, createOperationId: 'another-operation' } })).toThrow()
    expect(() => parseRpcControlResult('goal.patrol.all', body, { operationId: 'another-operation' })).toThrow()
    expect(() => parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: operationId, ok: true,
      operation: 'demand.patrol-all', result: { ...result!, operation: undefined, imaginaryResult: true } })).toThrow()
    expect(p.start).toHaveBeenCalledOnce()
  }, 30_000)

  it('missing or closed original Tab retains the exact global Agent/reference and opens an in-band service window without selecting a neighbor', async () => {
    const p = await prepared()
    await mount(createElement(GlobalBoardSurface))
    await act(async () => { await requestGlobalGoalPatrol(true) }); await settle()
    const held = Object.values(useAppStore.getState().spatialRequests)[0]!, state = useAppStore.getState(), tab = state.tabs[held.tabId]!
    const release = subscribePmoTeamsTopicFloatingState(() => {})
    try {
      await act(async () => {
        useAppStore.setState({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tab.id)) })
        publishWorkbenchTabRemoved(tab, { displayWorkspaceId: held.target.displayWorkspaceId!, groupId: held.target.groupId!, tabOrder: [tab.id, 'default-tab'] }, error => { throw error })
      })
      expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(held.tabId)
      expect(readPmoTeamsTopicFloatingState()?.agentTarget?.agentSessionId).toBe(held.agentSessionId)
      await act(async () => requestPmoTeamsTopicFloatingClose())
      await act(async () => button('打开巡查对话').click()); await settle()
      expect(readPmoTeamsTopicFloatingState()?.open).toBe(true)
      expect(readPmoTeamsTopicFloatingState()?.targetTabId).toBe(held.tabId)
      expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ tabId: held.tabId, regionId: held.regionId })
      expect(readPmoTeamsTopicFloatingState()?.entryMessage).toContain('全局 Demand 巡查')
      expect(p.launch).toHaveBeenCalledOnce(); expect(p.start).toHaveBeenCalledOnce()
    } finally { release() }
  }, 30_000)

  it('a complete inventory larger than the original Core first-prompt budget still starts one inspection and directs complete discovery to the original owner', async () => {
    const p = await prepared()
    for (let index = 0; index < 240; index++) await p.f.demands.create({ id: 'large-scope-' + index, title: '原目标完整范围'.repeat(40), status: index % 2 ? 'done' : 'todo' })
    const originals = (await p.f.demands.snapshot()).demands
    expect(Buffer.byteLength(JSON.stringify(originals.map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt }))))).toBeGreaterThan(MAX_AGENT_PROMPT_BYTES)
    const result = await p.f.cli('owner', ['goal', 'patrol', 'all', '--operation-id', 'global-large-inventory'])
    expect(result.result.agent.initialPrompt).toBe('confirmed')
    const prompt = p.launches[0]!.input.prompt!
    expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_AGENT_PROMPT_BYTES)
    expect(scope(prompt)).toMatchObject({ state: 'observed', totalCount: originals.length })
    expect(prompt).toContain('goal ls --all without filters or a limiting sample')
    expect(p.start).toHaveBeenCalledOnce()
  }, 30_000)
})
