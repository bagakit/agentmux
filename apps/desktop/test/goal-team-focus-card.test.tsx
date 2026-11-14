// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { demandAgentReferenceKey } from '@agentmux/demand/relations'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { GoalExecution } from '../src/renderer/src/components/GoalExecution'
import * as contexts from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import type { AgentTimelineSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { openHostGoalTransport } from './helpers/host-goal-transport'
import { readPmoTeamsTopicFloatingState, requestAgentConversationFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'

const dom = composerDOM({ agentInformation: true }), actorId = 'original-team-agent', viewId = 'original-team-view'
const goal = (): DemandProjection => ({ id: 'team-goal', title: 'Keep original responsibility', description: 'The original Goal text',
  status: 'in_progress', priority: 'normal', projectId: null, projectName: null, workspacePath: null, sessions: [], source: 'default-topic',
  sessionIds: [actorId], assigneeSessionIds: [actorId], supervisorSessionId: actorId,
  creationOrigin: { operationId: 'original-goal-creation', requesterAsSupervisor: true, requesterParticipationId: 'original-requester', supervisorDefaultPending: false },
  participations: [{ id: 'original-requester', operationId: 'original-goal-creation', kind: 'create', agentSessionId: actorId, hostId: 'local', entryPoint: 'goal.create', recordedAt: 1 }], createdAt: 1, updatedAt: 1 })
const agent = (id = viewId, canonical = actorId, hostId = 'local', runId = 'original-team-run') => ({ ...composerSession(id), label: 'Atlas', hostId,
  control: { kind: 'agent' as const, hostId, agentSessionId: canonical, run: { runId } } })
function seed(record = goal(), sessions = [agent()]) {
  useAppStore.setState({ config: composerConfig, demands: { [record.id]: record }, selectedDemandId: record.id, mainSurface: 'board', sessions,
    tabs: {}, layouts: {}, agentNames: { [viewId]: 'Atlas' }, timelines: {}, scratchTopicSnapshots: {},
    goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, agentComposerDrafts: { [viewId]: 'Keep the original unsent input' } })
}
const team = () => dom.container.querySelector<HTMLElement>('.goal-team')!
const cards = () => [...team().querySelectorAll<HTMLButtonElement>('button.focus-context')]
async function editSupervisor() {
  const editor = team().querySelector<HTMLDetailsElement>('.goal-team__edit')!
  await act(async () => { editor.open = true; editor.dispatchEvent(new Event('toggle')) })
  await act(async () => team().querySelector<HTMLButtonElement>('[aria-label="Choose Goal Supervisor"]')!.click())
}
beforeEach(() => {
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  vi.spyOn(api.demands, 'onChanged').mockReturnValue(() => {})
  seed()
})

it('the real Goal detail merges three roles into one full Focus card with its original preview and menu', async () => {
  const reply = 'Original retained reply, with evidence and the next responsibility.'
  const original = agent(), timeline = { agentSessionId: actorId, revision: 1, items: [
    { id: 'original-prompt', agentSessionId: actorId, kind: 'user_message', title: 'Prompt', content: 'Original work', source: 'native-hook', status: 'complete', createdAt: 1, updatedAt: 1 },
    { id: 'original-reply', agentSessionId: actorId, kind: 'assistant_message', title: 'Reply', content: reply, source: 'native-hook', status: 'complete', createdAt: 2, updatedAt: 2 }
  ] } as AgentTimelineSnapshot
  useAppStore.setState({ sessions: [original], timelines: { [viewId]: timeline } })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: actorId, source: { providerId: 'codex', nativeSessionId: 'native-team-original' }, items: [], nextCursor: null })
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'native-team-original' }))
  await dom.render(<GlobalBoardSurface />)
  expect(dom.container.querySelector('.goals-detail')).not.toBeNull()
  expect(cards(), 'One physical Actor is one real shared card').toHaveLength(1)
  expect(team().querySelectorAll('[data-goal-team-role]')).toHaveLength(3)
  expect(cards()[0]!.textContent).toContain('Atlas')
  expect(cards()[0]!.querySelector('.focus-context__detail')!.textContent, 'The original recap remains the standard second layer').toContain(reply)
  await act(async () => { cards()[0]!.focus(); cards()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await waitForAgentCardReading(() => expect(document.querySelector('.focus-context-hover')).not.toBeNull())
  expect(document.querySelector('.focus-context-hover')!.textContent).toContain('Atlas')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await act(async () => cards()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 60, clientY: 50 })))
  expect(document.querySelector('.focus-context-menu')?.getAttribute('data-agent-session-id')).toBe(viewId)
  expect(useAppStore.getState().agentComposerDrafts[viewId]).toBe('Keep the original unsent input')
})

it('same Actor and Run presentation aliases are one confirmed card rather than a false Host ambiguity', async () => {
  seed(goal(), [agent('alias-one'), agent('alias-two')])
  vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'demand.show', goalContinuations: [] } as never)
  await dom.render(<GoalExecution demand={goal()} onUpdate={async () => true} />)
  expect(cards()).toHaveLength(1)
  expect(team().querySelector('[data-goal-team-unconfirmed]')).toBeNull()
  expect(cards()[0]!.dataset.sessionId).toBe('alias-one')
  expect(team().querySelectorAll('[data-goal-team-role]')).toHaveLength(3)
  const supervisor = team().querySelector<HTMLElement>('.goals-supervisor-identity')!
  expect(supervisor).not.toBeNull()
  expect(supervisor.textContent).toContain('Atlas')
  expect(supervisor.querySelector('strong')?.title).not.toContain('ambiguous')
})

it('different Hosts or Runs keep the exact bare reference unknown without a first-Host menu while healthy Actors remain usable', async () => {
  const record = { ...goal(), participations: [{ id: 'healthy-source', operationId: 'healthy-source', kind: 'discussion' as const,
    agentSessionId: 'healthy-agent', hostId: 'local', entryPoint: 'goal.discuss', recordedAt: 1 }], sessionIds: [actorId, 'unobserved-original', 'healthy-agent'], assigneeSessionIds: [actorId, 'healthy-agent'] }
  delete record.creationOrigin
  seed(record, [agent('host-a-view', actorId, 'host-a'), agent('host-b-view', actorId, 'host-b'), agent('healthy-view', 'healthy-agent')])
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await dom.render(<GlobalBoardSurface />)
  expect(cards()).toHaveLength(1); expect(cards()[0]!.dataset.sessionId).toBe('healthy-view')
  const unknown = [...team().querySelectorAll<HTMLElement>('[data-goal-team-unconfirmed]')].find(node => node.getAttribute('data-goal-team-unconfirmed') === demandAgentReferenceKey(actorId))!
  expect(unknown).toBeDefined()
  expect(unknown.textContent).toContain(actorId); expect(unknown.textContent).toContain('Host is not confirmed')
  expect(unknown.querySelector('.focus-context')).toBeNull(); expect(unknown.querySelector('[data-session-id]')).toBeNull()
  const retained = [...team().querySelectorAll<HTMLElement>('[data-goal-team-unconfirmed]')].find(node => node.getAttribute('data-goal-team-unconfirmed') === demandAgentReferenceKey('unobserved-original'))
  expect(retained).toBeDefined(); expect(retained?.textContent).toContain('reference')
  await act(async () => cards()[0]!.click())
  expect(select).not.toHaveBeenCalled()
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: 'healthy-agent', hostId: 'local' } })
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().selectedDemandId).toBe(record.id)
  expect(useAppStore.getState().demands[record.id]!.sessionIds).toEqual(record.sessionIds)
})

it('the confirmed card opens the original conversation within the Goal without sending or replacing its draft', async () => {
  const workspace = composerConfig.workspaces[0]!, tab = createWorkbenchTab('original-team-tab', { kind: 'agent', phase: 'attached', regionId: 'original-team-region', workspaceId: workspace.id, sessionId: viewId })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-team-group', [tab.id]) }, activeWorkspaceId: workspace.id })
  await initializeSpatialControlFixture()
  const before = useAppStore.getState().agentComposerDrafts
  const focusBefore = useAppStore.getState().agentFocus
  const input = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<GlobalBoardSurface />)
  await act(async () => cards()[0]!.click())
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().selectedDemandId).toBe(goal().id)
  expect(useAppStore.getState().agentFocus).toBe(focusBefore)
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true,
    agentTarget: { agentSessionId: actorId, hostId: 'local' },
    targetAgent: { hostId: 'local', sessionId: actorId, presentationSessionId: viewId },
    reference: { displayWorkspaceId: workspace.id, tabId: tab.id, regionId: 'original-team-region' } })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before)
  expect(input).not.toHaveBeenCalled()
})

it('a source-qualified remote Agent opens its own conversation instead of a local namesake', async () => {
  const record = goal()
  record.participations = record.participations!.map(participation => ({ ...participation, hostId: 'original-remote-host' }))
  seed(record, [agent('remote-view', actorId, 'original-remote-host'), agent('local-namesake', actorId, 'local', 'different-local-run')])
  const input = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<GlobalBoardSurface />)
  const original = cards().find(card => card.dataset.sessionId === 'remote-view')
  expect(original).toBeDefined()
  expect(cards().some(card => card.dataset.sessionId === 'local-namesake')).toBe(false)
  await act(async () => original!.click())
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true,
    agentTarget: { agentSessionId: actorId, hostId: 'original-remote-host' },
    targetAgent: { hostId: 'original-remote-host', sessionId: actorId, presentationSessionId: 'remote-view' } })
  expect(useAppStore.getState().selectedDemandId).toBe(record.id)
  expect(input).not.toHaveBeenCalled()
})

it.each([1, 2])('presentation aliases retain the unique original occurrence or explicit position uncertainty (%s positions)', async positions => {
  const canonical = `aliases-actor-${positions}`, record = goal(), workspace = composerConfig.workspaces[0]!
  record.supervisorSessionId = canonical; record.sessionIds = [canonical]; record.assigneeSessionIds = [canonical]
  record.participations = record.participations!.map(participation => ({ ...participation, agentSessionId: canonical }))
  seed(record, [agent('alias-one', canonical), agent('alias-two', canonical)])
  const tabs = Array.from({ length: positions }, (_, index) => createWorkbenchTab(`aliases-tab-${index}`, {
    kind: 'agent', phase: 'attached', regionId: `aliases-region-${index}`, workspaceId: workspace.id,
    sessionId: index === 0 ? 'alias-two' : 'alias-one' }))
  useAppStore.setState({ tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
    layouts: { [workspace.id]: createWorkspaceLayout('aliases-group', tabs.map(tab => tab.id)) }, activeWorkspaceId: workspace.id })
  const input = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<GlobalBoardSurface />)
  expect(cards()).toHaveLength(1)
  await act(async () => cards()[0]!.click())
  const floating = readPmoTeamsTopicFloatingState()!
  expect(floating.agentTarget).toEqual({ agentSessionId: canonical, hostId: 'local' })
  if (positions === 1) {
    expect(floating.reference).toMatchObject({ displayWorkspaceId: workspace.id, tabId: 'aliases-tab-0', regionId: 'aliases-region-0' })
    expect(floating.targetAgent).toEqual({ hostId: 'local', sessionId: canonical, presentationSessionId: 'alias-two' })
  } else {
    expect(floating.reference).toBeNull(); expect(floating.targetTabId).toBeNull()
    expect(floating.targetAgent).toBeUndefined()
  }
  expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().selectedDemandId).toBe(record.id)
  expect(input).not.toHaveBeenCalled()
})

it('a bare Actor across Hosts stays unconfirmed even when only a local namesake has a visible occurrence', async () => {
  const canonical = 'unknown-source-actor', workspace = composerConfig.workspaces[0]!
  seed(goal(), [agent('local-namesake', canonical, 'local'), agent('remote-original', canonical, 'remote')])
  const tab = createWorkbenchTab('unrelated-local-tab', { kind: 'agent', phase: 'attached', regionId: 'unrelated-local-region',
    workspaceId: workspace.id, sessionId: 'local-namesake' })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('unknown-source-group', [tab.id]) } })
  await dom.render(<GlobalBoardSurface />)
  await act(async () => { requestAgentConversationFloatingOpen(canonical) })
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, agentTarget: { agentSessionId: canonical },
    reference: null, targetTabId: null })
  expect(readPmoTeamsTopicFloatingState()!.targetAgent).toBeUndefined()
  expect(useAppStore.getState().mainSurface).toBe('board')
})

it('the original role picker saves its exact relationship through the public Host owner and retains all other input', async () => {
  const host = await openHostGoalTransport({ config: composerConfig })
  try {
    const { creationOrigin: _origin, participations: _participants, ...input } = goal()
    const saved = (await host.demands.create({ ...input, assigneeSessionIds: [actorId, 'next-supervisor'], sessionIds: [actorId, 'next-supervisor'] })).demand
    seed({ ...saved, source: 'default-topic', sessions: [], workspacePath: null }, [agent(), agent('next-view', 'next-supervisor')])
    const before = useAppStore.getState().agentComposerDrafts
    await dom.render(<GlobalBoardSurface />)
    await editSupervisor()
    await act(async () => document.querySelector<HTMLInputElement>('[data-session-id="next-supervisor"] input')!.click())
    const save = [...document.querySelectorAll<HTMLButtonElement>('.goal-agent-picker button')].find(button => button.textContent === 'Save relationships')!
    await act(async () => { save.click(); await host.settle() })
    await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')).toBeNull())
    expect(host.bodies('demand.update').map(({ demandId, patch }) => [demandId, patch])).toEqual([[saved.id, { supervisorSessionId: 'next-supervisor' }]])
    expect(await host.demands.get(saved.id)).toMatchObject({ supervisorSessionId: 'next-supervisor', assigneeSessionIds: saved.assigneeSessionIds, sessionIds: saved.sessionIds })
    expect(useAppStore.getState().agentComposerDrafts).toBe(before)
    expect(team().querySelectorAll('[data-goal-team-role="supervisor"]')).toHaveLength(1)
    const retained = [...team().querySelectorAll('[data-goal-team-reference]')].find(node => node.getAttribute('data-goal-team-reference') === demandAgentReferenceKey('next-supervisor'))!
    expect(retained.textContent).toContain('Host not confirmed'); expect(retained.querySelector('.focus-context')).toBeNull()
  } finally { await host.dispose() }
})

it('a refused relationship write retains the original role and picker selection for the same Host retry', async () => {
  const host = await openHostGoalTransport({ config: composerConfig })
  try {
    const { creationOrigin: _origin, participations: _participants, ...input } = goal()
    const saved = (await host.demands.create({ ...input, assigneeSessionIds: [actorId, 'next-supervisor'], sessionIds: [actorId, 'next-supervisor'] })).demand
    seed({ ...saved, source: 'default-topic', sessions: [], workspacePath: null }, [agent(), agent('next-view', 'next-supervisor')])
    host.once('demand.update', { kind: 'reject', error: new Error('Original relationship owner unavailable') })
    await dom.render(<GlobalBoardSurface />)
    await editSupervisor()
    await act(async () => document.querySelector<HTMLInputElement>('[data-session-id="next-supervisor"] input')!.click())
    const save = [...document.querySelectorAll<HTMLButtonElement>('.goal-agent-picker button')].find(button => button.textContent === 'Save relationships')!
    await act(async () => { save.click(); await host.settle() })
    await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')?.textContent).toContain('Original relationship owner unavailable'))
    expect(document.querySelector<HTMLInputElement>('[data-session-id="next-supervisor"] input')!.checked).toBe(true)
    expect(await host.demands.get(saved.id)).toMatchObject({ supervisorSessionId: actorId })
    await act(async () => { save.click(); await host.settle() })
    await vi.waitFor(() => expect(document.querySelector('.goal-agent-picker')).toBeNull())
    expect(await host.demands.get(saved.id)).toMatchObject({ supervisorSessionId: 'next-supervisor' })
    expect(useAppStore.getState().agentComposerDrafts[viewId]).toBe('Keep the original unsent input')
  } finally { await host.dispose() }
})

it('the Team keeps the original continuation operation and Agent when the current Supervisor changes', async () => {
  const loop = { loopId: 'original-loop', creationOperationId: 'original-start', revision: 4, hostId: 'original-host', agentSessionId: 'original-supervisor',
    status: 'active', intervalMs: 1800000, taskSource: { kind: 'goal', goalId: goal().id, alignmentRevision: 7 },
    initialDelivery: { state: 'unconfirmed', operationId: 'original-start' } }
  const control = vi.spyOn(useAppStore.getState(), 'executeControl').mockImplementation(async request => {
    if (request.operation === 'demand.show') return { operation: 'demand.show', goalContinuations: [loop] } as never
    throw new Error('Original start receipt is still unknown')
  })
  await dom.render(<GoalExecution demand={goal()} onUpdate={async () => true} />)
  const retry = [...team().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Inspect and retry original start')!
  expect(retry).toBeDefined()
  await act(async () => retry.click())
  expect(control.mock.calls.filter(([request]) => request.operation === 'demand.start').map(([request]) => request)).toEqual([
    { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-start', operation: 'demand.start', demandId: goal().id, sessionId: 'original-supervisor', continuation: { intervalMs: 1800000, alignmentRevision: 7 } }
  ])
  expect(team().textContent).toContain('This loop keeps its original Agent')
  expect(useAppStore.getState().agentComposerDrafts[viewId]).toBe('Keep the original unsent input')
})

it.each([1, 1000])('the mounted Team with %i Sessions adds no derive, render or history scan for unrelated output', async count => {
  const costs = { inventory: 0, history: 0, render: 0 }, raw = [agent(), ...Array.from({ length: count - 1 }, (_, i) => agent('other-view-' + i, 'other-actor-' + i))]
  const sessions = new Proxy(raw, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) costs.inventory++; return Reflect.get(target, key, receiver) } })
  const items = new Proxy([{ id: 'original-name', kind: 'user_message', content: 'First original task' }], { get(target, key, receiver) { if (key === 'find' || key === Symbol.iterator) costs.history++; return Reflect.get(target, key, receiver) } })
  const timeline = { agentSessionId: actorId, revision: 1, items } as unknown as AgentTimelineSnapshot
  seed(goal(), sessions); useAppStore.setState({ timelines: { [viewId]: timeline } })
  const derive = vi.spyOn(contexts, 'agentContextForSession')
  await dom.render(<Profiler id="goal-team" onRender={() => costs.render++}><GoalExecution demand={goal()} onUpdate={async () => true} /></Profiler>)
  expect(cards()).toHaveLength(1)
  costs.inventory = costs.history = costs.render = 0; derive.mockClear()
  for (let revision = 1; revision <= 4; revision++) await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines,
    'unrelated-output': { agentSessionId: 'unrelated-output', revision, items: [] } as unknown as AgentTimelineSnapshot } })))
  expect(costs).toEqual({ inventory: 0, history: 0, render: 0 })
  expect(derive).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ sessions: [agent(viewId, actorId, 'local', 'next-original-run'), ...raw.slice(1)] }))
  expect(derive).toHaveBeenCalled(); expect(cards()).toHaveLength(1)
})
