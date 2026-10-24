// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { bridge, client, config, directory, runtime, hostService, root, container, demands, session, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core'
import { addTab, createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore, handoffOriginalGoalDiscussions, prepareRendererUpdate } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { goalDiscussionBindingKey, readGoalDiscussionBinding } from '../../host/src/goal-discussion-bindings'
import { MobileGoalsSurface } from '../../mobile/src/goals/MobileGoalsSurface'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { injectedContextCore } from './helpers/injected-context-core'

const spatial = () => new AgentMuxSpatialStateStore()
const savedSource = () => JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.demandPmoTabIds
async function savedDiscussion(kind: 'agent' | 'launcher' = 'agent') {
  const tab = { ...createWorkbenchTab('retained-discussion', kind === 'agent'
    ? { kind, regionId: 'retained-recipient', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.agentSessionId }
    : { kind, regionId: 'retained-recipient', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
  await act(async () => useAppStore.setState(current => {
    const layout = current.layouts[SCRATCH_WORKSPACE_ID] ?? createWorkspaceLayout('retained-group')
    return { tabs: { ...current.tabs, [tab.id]: tab }, layouts: { ...current.layouts,
      [SCRATCH_WORKSPACE_ID]: addTab(layout, layout.activeGroupId, tab.id) }, demandPmoTabIds: { ...current.demandPmoTabIds, goal: tab.id } }
  }))
  await prepareRendererUpdate()
  expect(savedSource()).toEqual({ goal: tab.id })
  const original = (await spatial().read())!
  expect(original.graph.regions.find(region => region.regionId === 'retained-recipient')?.kind).toBe(kind)
  return { tab, original }
}

it('exports the actual nonempty saved relationship through trusted Main and removes it only after the same Core durable ACK', async () => {
  const { tab } = await savedDiscussion(), before = await demands.get('goal'), accepted = [...writes]
  await handoffOriginalGoalDiscussions()
  const state = (await spatial().read())!, binding = readGoalDiscussionBinding(state.graph, 'goal')!
  expect(binding).toEqual({ schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'retained-recipient',
    recipient: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId } })
  expect(bridge.invoke).toHaveBeenCalledWith('goals:handoffDiscussion', { goalId: 'goal', binding })
  expect(useAppStore.getState().demandPmoTabIds).toEqual({})
  await prepareRendererUpdate()
  expect(savedSource()).toBeUndefined()
  expect((JSON.parse(await readFile(spatial().path, 'utf8'))).graph.resources[goalDiscussionBindingKey('goal')]).toEqual(binding)
  expect(await demands.get('goal')).toEqual(before)
  expect(writes).toEqual(accepted)
  expect(await useAppStore.getState().openDemandPmo('goal')).toBe(tab.id)
  expect(useAppStore.getState().tabs[tab.id]?.regions['retained-recipient']).toMatchObject({ kind: 'agent', sessionId: session.agentSessionId })
  expect(writes).toEqual(accepted)
  const forwardRpc = vi.fn((method: any, params: any) => hostService.call(method, params, { principal: { kind: 'device', id: 'private-original-phone' } }))
  const mobile = { forwardRpc, runtimeOwnerIdentity: () => ({ runtimeId: 'private-runtime', ownerInstanceId: 'original-goal-owner', availability: 'connected' }) } as unknown as AgentMuxHostedClient
  const openSession = vi.fn(), context = vi.fn()
  await act(async () => root.render(<MobileGoalsSurface client={mobile} visible connected openSession={openSession} onContextChange={context}
    initialContext={{ goalId: 'goal', mode: 'detail', discussion: null }} />))
  const open = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '打开目标原讨论')
  await vi.waitFor(() => expect(open()).toBeDefined())
  await act(async () => open()!.click())
  await vi.waitFor(() => expect(container.querySelector('.mobile-zone-workface .mobile-agent-row__open')).not.toBeNull())
  expect(forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { tabId: tab.id }, presentation: true })
  expect(context).toHaveBeenCalledWith(expect.objectContaining({ discussion: { goalId: 'goal', tabId: tab.id,
    regionId: binding.regionId, hostId: 'local', agentSessionId: session.agentSessionId } }))
  expect(openSession).toHaveBeenCalledWith(session.agentSessionId, expect.any(Object))
  expect(writes).toEqual(accepted)
})

it('keeps the exact original Launcher and its draft without manufacturing a Session or sending', async () => {
  const { tab } = await savedDiscussion('launcher'), before = await demands.get('goal'), accepted = [...writes]
  useAppStore.setState({ agentComposerDrafts: { 'retained-recipient': 'Original unsubmitted Launcher text' } })
  await handoffOriginalGoalDiscussions()
  expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')).toEqual({
    schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'retained-recipient', recipient: { kind: 'launcher' } })
  expect(await useAppStore.getState().openDemandPmo('goal')).toBe(tab.id)
  await expect(useAppStore.getState().requestDemandPmoTask('goal', 'grill')).rejects.toBeTruthy()
  expect(useAppStore.getState().agentComposerDrafts['retained-recipient']).toBe('Original unsubmitted Launcher text')
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(await demands.get('goal')).toEqual(before); expect(writes).toEqual(accepted)
  // A later graph occupant alone is not an explicit Core creation receipt.
  const current = (await spatial().read())!, graph = structuredClone(current.graph)
  const region = graph.regions.find(item => item.regionId === 'retained-recipient')!
  Object.assign(region, { kind: 'agent', agentSessionId: session.agentSessionId, runId: session.run.runId,
    execution: { hostId: 'local', cwd: session.workspacePath } })
  await spatial().commit({ expectedRevision: current.revision, graph })
  await expect(useAppStore.getState().openDemandPmo('goal')).rejects.toBeTruthy()
  expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')?.recipient).toEqual({ kind: 'launcher' })
  expect(await demands.get('goal')).toEqual(before); expect(writes).toEqual(accepted)
})

it('retains the source before a failed write and after a durable write with a lost producer reply, then reconfirms the same binding', async () => {
  const { tab } = await savedDiscussion(), original = AgentMuxSpatialStateStore.prototype.commitOwnedResource
  let fault: 'before' | 'after' | null = 'before'
  const write = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'commitOwnedResource').mockImplementation(async function (input) {
    if (fault === 'before') { fault = null; throw Error('Private original producer write refused before application') }
    const result = await original.call(this, input)
    if (fault === 'after') { fault = null; throw Error('Private original producer reply withheld after its durable write') }
    return result
  })
  await expect(handoffOriginalGoalDiscussions()).rejects.toBeTruthy()
  expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')).toBeNull()
  expect(useAppStore.getState().demandPmoTabIds.goal).toBe(tab.id); expect(savedSource()).toEqual({ goal: tab.id })
  fault = 'after'
  await expect(handoffOriginalGoalDiscussions()).rejects.toBeTruthy()
  const afterUnknown = (await new AgentMuxSpatialStateStore(spatial().path).read())!
  expect(readGoalDiscussionBinding(afterUnknown.graph, 'goal')?.tabId).toBe(tab.id)
  expect(useAppStore.getState().demandPmoTabIds.goal).toBe(tab.id); expect(savedSource()).toEqual({ goal: tab.id })
  await prepareRendererUpdate()
  const calls = write.mock.calls.length
  const retry = await handoffOriginalGoalDiscussions().then(() => ({ ok: true }), error => ({ ok: false, errors: error.errors?.map(String) }))
  expect(retry).toEqual({ ok: true })
  expect(write).toHaveBeenCalledTimes(calls + 1)
  expect((await spatial().read())!.revision).toBeGreaterThan(afterUnknown.revision)
  expect(useAppStore.getState().demandPmoTabIds).toEqual({})
})

it.each(['lost-reply', 'placement-issue'] as const)('the original Desktop Launcher preserves pending topology, options and the created Session (%s)', async outcome => {
  const { tab } = await savedDiscussion('launcher')
  await handoffOriginalGoalDiscussions()
  const spatialPath = spatial().path, coreRoot = join(directory, 'launcher-core'); await mkdir(coreRoot)
  const namespace = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const f = await injectedContextCore(coreRoot, session)
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !Object.hasOwn(namespace, key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(namespace)) vi.stubEnv(key, value)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', spatialPath)
  // This original Goal Tab displays an explicit execution Workspace. Display and cwd remain separate.
  const workspace = { id: 'original-execution', hostId: 'local', name: 'Original execution Workspace', path: directory, kind: 'folder' as const }
  const next = await api.config.save({ ...config, workspaces: [...config.workspaces, workspace], executors: { ...config.executors,
    'original-claude': { providerId: 'claude', label: 'Original explicit executor', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }, config)
  useAppStore.setState(current => ({ config: next, tabs: { ...current.tabs, [tab.id]: { ...tab,
    regions: { ...tab.regions, 'retained-recipient': { kind: 'launcher', regionId: 'retained-recipient', workspaceId: workspace.id } } } } }))
  await prepareRendererUpdate()
  runtime.commit({ hosts: [{ id: 'local', config: next.hosts.find(host => host.id === 'local')!, client: f.core,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  ;(runtime as any).agentSessionStore = f.store
  vi.spyOn((f.core as any).screenEvidence, 'wait').mockResolvedValue(0)
  const original = runtime.launchAgent.bind(runtime), launchOptions = { model: 'sonnet', effort: 'low', 'permission-mode': 'manual' }
  const originalOwnedWrite = AgentMuxSpatialStateStore.prototype.commitOwnedResource
  let refusedPlacement = false
  if (outcome === 'placement-issue') vi.spyOn(AgentMuxSpatialStateStore.prototype, 'commitOwnedResource').mockImplementation(async function (input) {
    if (input.agentRegion && !refusedPlacement) { refusedPlacement = true; throw Error('Private original owned placement write refused before application') }
    return originalOwnedWrite.call(this, input)
  })
  let release!: () => void, entered = false
  const blocked = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(runtime, 'launchAgent').mockImplementationOnce(async (...args) => { entered = true; await blocked; return original(...args) })
  const invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args)
    if (channel === 'sessions:launchAgent') {
      if (outcome === 'lost-reply') throw Object.assign(Error('Private original native creation reply withheld'), { controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
    }
    return result
  })
  const groupId = useAppStore.getState().layouts[SCRATCH_WORKSPACE_ID]!.activeGroupId
  const launching = useAppStore.getState().launchAgent('original-claude', 'Original explicit Launcher task.', groupId,
    { tabId: tab.id, regionId: 'retained-recipient' }, launchOptions)
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    await prepareRendererUpdate()
    const pending = (await spatial().read())!
    expect(pending.graph.regions.find(region => region.regionId === 'retained-recipient')).toMatchObject({ kind: 'launcher', agentSessionId: null })
    expect(readGoalDiscussionBinding(pending.graph, 'goal')?.recipient).toEqual({ kind: 'launcher' })
    const input = bridge.invoke.mock.calls.find(([channel]) => channel === 'sessions:launchAgent')![1]
    expect(input).toMatchObject({ launcher: { tabId: tab.id, regionId: 'retained-recipient' }, executionWorkspaceId: workspace.id, hostId: 'local', workspacePath: workspace.path, launchOptions,
      agentSessionId: expect.any(String), createOperationId: expect.any(String), prompt: 'Original explicit Launcher task.' })
    expect(vi.mocked(runtime.launchAgent).mock.calls[0]![2]).toEqual({ ...input.launcher, executionWorkspaceId: workspace.id })
    release()
    if (outcome === 'lost-reply') await expect(launching).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' }, agentSessionId: input.agentSessionId, createOperationId: input.createOperationId })
    else {
      const completion = await launching.then(() => ({ state: 'confirmed' }), async error => ({ state: 'unconfirmed', error: String(error),
        surface: useAppStore.getState().tabs[tab.id]?.regions['retained-recipient'], canonical: readGoalDiscussionBinding((await spatial().read())!.graph, 'goal') }))
      expect(completion).toEqual({ state: 'confirmed' })
      const notice = () => useAppStore.getState().notificationEvents.find(notice => notice.context?.event?.source === 'goal-discussion-binding' &&
        notice.context.event.key === JSON.stringify(['native-creation', input.createOperationId]))
      expect(notice()?.context).toMatchObject({ kind: 'indeterminate', subject: { kind: 'agent', hostId: 'local', agentSessionId: input.agentSessionId,
        run: f.core.agentSession(input.agentSessionId).run }, event: { object: { kind: 'region', id: 'retained-recipient', workspaceId: workspace.id } } })
      expect(refusedPlacement).toBe(true)
      expect(JSON.stringify(notice())).toContain('Private original owned placement write refused before application')
      expect(useAppStore.getState().tabs[tab.id]!.regions['retained-recipient']).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: input.agentSessionId })
      await prepareRendererUpdate()
      expect(notice()).toBeDefined()
    }
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: workspace.path, args: expect.arrayContaining(['--model', 'sonnet', '--effort', 'low', '--permission-mode', 'manual']) }))
    const creation = await f.core.inspectAgentCreation(input.agentSessionId), state = (await spatial().read())!
    expect(creation.creation).toMatchObject({ createOperationId: input.createOperationId, createdRun: expect.objectContaining({ runId: expect.any(String) }),
      spatialIntent: { ...input.launcher, executionWorkspaceId: workspace.id } })
    expect(readGoalDiscussionBinding(state.graph, 'goal')?.recipient).toEqual(outcome === 'placement-issue'
      ? { kind: 'launcher' } : { kind: 'agent', hostId: 'local', agentSessionId: input.agentSessionId })
    expect(await useAppStore.getState().openDemandPmo('goal')).toBe(tab.id)
    expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')).toEqual({ schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'retained-recipient',
      recipient: { kind: 'agent', hostId: 'local', agentSessionId: input.agentSessionId } })
    expect(useAppStore.getState().tabs[tab.id]!.regions['retained-recipient']).toMatchObject({ kind: 'agent', sessionId: input.agentSessionId })
    await useAppStore.getState().requestDemandPmoTask('goal', 'grill')
    const request = bridge.invoke.mock.calls.find(([channel, request]) => channel === 'goals:execute' && request.operation === 'demand.discuss' && request.mode === 'grill')![1]
    expect((await f.core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: input.agentSessionId,
      expectedRun: f.core.agentSession(input.agentSessionId).run, submissionId: request.requestId }))?.admission?.acknowledged).toBe(true)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect((await demands.get('goal'))?.discussionOperationId).toBeUndefined()
    expect((await demands.get('goal'))?.supervisorSessionId).toBe(session.agentSessionId)
  } finally { release(); await launching.catch(() => {}); await f.dispose() }
})

it('does not delete the actual saved source when a successful write loses its durable ACK field', async () => {
  const { tab } = await savedDiscussion(), invoke = bridge.invoke.getMockImplementation()!
  bridge.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args)
    return channel === 'goals:handoffDiscussion' ? { ...result, diskDurability: 'unconfirmed' } : result
  })
  await expect(handoffOriginalGoalDiscussions()).rejects.toBeTruthy()
  expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')?.tabId).toBe(tab.id)
  expect(useAppStore.getState().demandPmoTabIds.goal).toBe(tab.id)
  expect(savedSource()).toEqual({ goal: tab.id })
})

it('rejects an untrusted export without changing the canonical owner or the retained source', async () => {
  const { tab, original } = await savedDiscussion()
  const handler = bridge.handlers.get('goals:handoffDiscussion')!
  await expect(handler({ sender: { id: -1 }, senderFrame: {} }, { goalId: 'goal', binding: {
    schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'retained-recipient',
    recipient: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId } } })).rejects.toBeTruthy()
  expect(await spatial().read()).toEqual(original)
  expect(useAppStore.getState().demandPmoTabIds.goal).toBe(tab.id)
  const graph = structuredClone(original.graph), region = graph.regions.find(item => item.regionId === 'retained-recipient')!
  region.execution!.hostId = 'foreign'
  await spatial().commit({ expectedRevision: original.revision, graph })
  const localRead = vi.spyOn(client, 'agentSession'); localRead.mockClear()
  await expect(handler({ sender: bridge.sender, senderFrame: bridge.sender.mainFrame }, { goalId: 'goal', binding: {
    schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'retained-recipient',
    recipient: { kind: 'agent', hostId: 'foreign', agentSessionId: session.agentSessionId } } })).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
  expect(localRead).not.toHaveBeenCalled()
  expect(readGoalDiscussionBinding((await spatial().read())!.graph, 'goal')).toBeNull()
  expect(useAppStore.getState().demandPmoTabIds.goal).toBe(tab.id)
})

it('an actually empty saved source performs no handoff or Core write', async () => {
  const before = await spatial().read(), invoke = bridge.invoke.mock.calls.length
  const write = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'commitOwnedResource')
  await handoffOriginalGoalDiscussions()
  expect(bridge.invoke.mock.calls.slice(invoke).filter(([method]) => method === 'goals:handoffDiscussion')).toEqual([])
  expect(write).not.toHaveBeenCalled(); expect(await spatial().read()).toEqual(before)
})
