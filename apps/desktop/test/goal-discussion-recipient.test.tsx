// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { demands, root, container, session, writes } from './helpers/current-demand-product'
import { act, Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore, handoffOriginalGoalDiscussions, prepareRendererUpdate } from '../src/renderer/src/store'
import { goalDiscussionTarget, useGoalDiscussionRecipient } from '../src/renderer/src/lib/goal-discussion-recipient'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

function Recipient() {
  const recipient = useGoalDiscussionRecipient('goal')
  return <div>{recipient.openLabel}|{recipient.requestLabel('grill')}|{recipient.requestLabel('grounding')}|{recipient.description}</div>
}
function bind(kind: 'agent' | 'launcher') {
  const tab = { ...createWorkbenchTab('original-discussion', kind === 'agent'
    ? { kind, regionId: 'original-recipient', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.agentSessionId }
    : { kind, regionId: 'original-recipient', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', [tab.id]) },
    demandPmoTabIds: { goal: tab.id }, agentNames: { [session.agentSessionId]: 'Original coordinator' } })
  return tab
}

it('the shared recipient projection names the dedicated Agent; opening only navigates while an explicit request reaches that exact original Core input', async () => {
  await act(async () => { root.render(null); bind('agent') })
  const before = (await demands.get('goal'))!
  useAppStore.setState(state => ({ demands: { ...state.demands, goal: { ...state.demands.goal!, supervisorSessionId: 'a-different-supervisor' } } }))
  await act(async () => root.render(<Recipient />))
  await act(async () => { await prepareRendererUpdate(); await handoffOriginalGoalDiscussions('goal') })
  expect(container.textContent).toContain('Open discussion with Original coordinator')
  expect(container.textContent).toContain('Ask Original coordinator to check results')
  expect(container.textContent).not.toContain('a-different-supervisor')
  const accepted = [...writes], draft = 'A draft the person is still editing'
  useAppStore.setState({ agentComposerDrafts: { [session.agentSessionId]: draft } })
  expect(await useAppStore.getState().openDemandPmo('goal')).toBe('original-discussion')
  expect(writes).toEqual(accepted)
  expect(useAppStore.getState().agentComposerDrafts[session.agentSessionId]).toBe(draft)
  await act(async () => { await useAppStore.getState().requestDemandPmoTask('goal', 'grill'); await useAppStore.getState().flushAgentSteerQueue(session.agentSessionId) })
  expect(writes.join('')).toContain('align the goal')
  expect(writes.join('')).toContain(before.id)
  expect(useAppStore.getState().agentSteerQueues['a-different-supervisor']).toBeUndefined()
  expect(useAppStore.getState().demandPmoTabIds.goal).toBeUndefined()
})

it('opening the handed-off launcher preserves its draft without starting an Agent; closing its Tab retains the original binding as unconfirmed', async () => {
  let tab!: ReturnType<typeof bind>
  await act(async () => { root.render(null); tab = bind('launcher') })
  useAppStore.setState({ agentComposerDrafts: { 'original-recipient': 'Unsubmitted original text' } })
  await act(async () => { await prepareRendererUpdate(); await handoffOriginalGoalDiscussions('goal') })
  const before = await demands.get('goal'), accepted = [...writes]
  expect(await useAppStore.getState().openDemandPmo('goal')).toBe(tab.id)
  expect(writes).toEqual(accepted)
  expect(useAppStore.getState().agentComposerDrafts['original-recipient']).toBe('Unsubmitted original text')
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'original-group', tab.id)).toBe(true)
  expect(useAppStore.getState().demandPmoTabIds.goal).toBeUndefined()
  await act(async () => prepareRendererUpdate())
  expect(goalDiscussionTarget(useAppStore.getState(), 'goal').kind).toBe('unconfirmed')
  expect(await demands.get('goal')).toEqual(before)
  expect(useAppStore.getState().sessions).toHaveLength(1)
  await expect(useAppStore.getState().openDemandPmo('goal')).rejects.toThrow()
  expect(await demands.get('goal')).toEqual(before)
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(writes).toEqual(accepted)
})

it('unknown discussion placement keeps its original binding and healthy Agent; unrelated output causes no recipient commits', async () => {
  await act(async () => { root.render(null); bind('agent') })
  await act(async () => { await prepareRendererUpdate(); await handoffOriginalGoalDiscussions('goal') })
  const render = vi.fn()
  await act(async () => root.render(<Profiler id="recipient" onRender={render}><Recipient /></Profiler>))
  render.mockClear()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { events: [], version: 1 } as never } })))
  expect(render).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ tabs: {} }))
  expect(container.textContent).toContain('Open original discussion')
  expect(container.textContent).not.toContain('Start goal discussion')
  const accepted = [...writes]
  expect(await useAppStore.getState().openDemandPmo('goal')).toBe('original-discussion')
  expect(useAppStore.getState().demandPmoTabIds.goal).toBeUndefined()
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(writes).toEqual(accepted)
})
