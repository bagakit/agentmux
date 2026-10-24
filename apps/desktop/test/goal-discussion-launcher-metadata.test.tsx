// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { client, runtime, session, config } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore, type AgentMuxAgentCreationInspection } from '@agentmux/core'
import { addTab, createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore, handoffOriginalGoalDiscussions, prepareRendererUpdate } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'

// The real preload and registered Main handler remain in use. The existing Native launch
// boundary returns an already-observed Core identity; these cases prove metadata isolation,
// not fresh PTY creation (the independent Node Host/public creator case uses actual ctxmux).
it.each(['missing', 'unreadable'] as const)('keeps the original native creation path available when Launcher metadata is %s', async fault => {
  const original = await client.inspectAgentCreation(session.agentSessionId)
  if (original.kind !== 'agent') throw new Error('The private fixture must retain its original healthy Agent.')
  const launch = vi.spyOn(runtime, 'launchAgent').mockResolvedValue({ created: original, projectionFailures: [] })
  const read = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'read')
  if (fault === 'missing') read.mockResolvedValue(null)
  else read.mockRejectedValue(new Error('Private spatial observation unavailable'))
  const input = { executorId: session.executorId, hostId: 'local', workspacePath: session.workspacePath,
    agentSessionId: session.agentSessionId, createOperationId: 'original-launch-operation',
    prompt: 'Original manual input', launchOptions: { originalOption: 'originalChoice' },
    launcher: { tabId: 'original-launch-tab', regionId: 'original-launch-region' },
    executionWorkspaceId: config.workspaces.find(workspace => workspace.hostId === 'local' && workspace.path === session.workspacePath)!.id }
  const creating = api.sessions.launchAgent(input)
  await expect(creating).resolves.toMatchObject({ created: original })
  const result = await creating
  expect(launch).toHaveBeenCalledExactlyOnceWith(input, expect.any(Object), { ...input.launcher, executionWorkspaceId: input.executionWorkspaceId })
  expect(result.created).toEqual(original)
  expect(result.placementIssue).toMatch(/original Launcher/i)
  expect(result.projectionFailures).toEqual([])
  expect(client.agentSession(session.agentSessionId).run).toEqual(original.run)
})

it('keeps the exact failed saved-source notice through unrelated layout saves and retrying the normal save', async () => {
  await act(async () => {
  const tab = createWorkbenchTab('ordinary-readable-tab', { kind: 'launcher', regionId: 'ordinary-readable-region', workspaceId: SCRATCH_WORKSPACE_ID })
  useAppStore.setState(current => {
    const layout = current.layouts[SCRATCH_WORKSPACE_ID] ?? createWorkspaceLayout('ordinary-readable-group')
    return { tabs: { ...current.tabs, [tab.id]: tab }, layouts: { ...current.layouts, [SCRATCH_WORKSPACE_ID]: addTab(layout, layout.activeGroupId, tab.id) } }
  })
  await prepareRendererUpdate()
  useAppStore.setState({ demandPmoTabIds: { goal: 'original-source-not-yet-observed' } })
  await expect(handoffOriginalGoalDiscussions()).rejects.toBeTruthy()
  const notice = useAppStore.getState().notificationEvents.find(event => event.context?.event?.source === 'goal-discussion-binding')!
  expect(notice).toBeDefined()
  await expect(useAppStore.getState().retryWorkbenchSave()).resolves.toBeUndefined()
  await prepareRendererUpdate()
  expect(useAppStore.getState().notificationEvents.some(event => event.id === notice.id)).toBe(true)
  expect(useAppStore.getState().demandPmoTabIds).toEqual({ goal: 'original-source-not-yet-observed' })
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.demandPmoTabIds).toEqual({ goal: 'original-source-not-yet-observed' })
  expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  })
})

it('rejects a late original Main inspection after its exact Core client route changes', async () => {
  await act(async () => {
    const tab = createWorkbenchTab('late-owner-tab', { kind: 'agent', phase: 'attached', regionId: 'late-owner-region', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.agentSessionId })
    useAppStore.setState(current => {
      const layout = current.layouts[SCRATCH_WORKSPACE_ID] ?? createWorkspaceLayout('late-owner-group')
      return { tabs: { ...current.tabs, [tab.id]: tab }, layouts: { ...current.layouts, [SCRATCH_WORKSPACE_ID]: addTab(layout, layout.activeGroupId, tab.id) } }
    })
    await prepareRendererUpdate()
    const original = await client.inspectAgentCreation(session.agentSessionId)
    let release!: (value: AgentMuxAgentCreationInspection) => void
    const inspect = vi.spyOn(client, 'inspectAgentCreation').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = api.goals.handoffDiscussion({ goalId: 'goal', binding: { schema: 'agentmux.goal-discussion-binding.v1', tabId: tab.id, regionId: 'late-owner-region',
      recipient: { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId } } })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const before = runtime.rpcClients(), replacement = { ...before[0]!, client: {} as typeof client }
    const clients = vi.spyOn(runtime, 'rpcClients').mockReturnValue([replacement])
    release(original)
    await expect(pending).rejects.toMatchObject({ code: 'GOAL_DISCUSSION_UNCONFIRMED' })
    clients.mockRestore(); inspect.mockRestore()
    expect((await new AgentMuxSpatialStateStore().read())!.graph.resources['owned:goal-discussion:goal']).toBeUndefined()
    expect(client.agentSession(session.agentSessionId).run).toEqual(session.run)
  })
})
