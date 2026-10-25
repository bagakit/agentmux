// @vitest-environment happy-dom
import './helpers/goal-responsibility-product'
import { fixture, mount, container, settle, evidence } from './helpers/goal-responsibility-product'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createWorkspaceLayout } from '@agentmux/layout'
import { observeAgent } from '@agentmux/core'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { refreshGoalDelegations } from '../src/renderer/src/lib/goal-delegation-work'
import { readPmoTeamsTopicFloatingState, pmoTeamsTopicFloatingViewTargets, requestAgentConversationFloatingOpen, requestPmoTeamsTopicFloatingClose,
  requestPmoTeamsTopicFloatingOpen, usePmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { usePmoTeamsTopicTarget } from '../src/renderer/src/lib/pmo-teams-topic-target'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { publishWorkbenchTabRemoved } from '../src/renderer/src/lib/workbench-tab-removal'
import { seedMoteWorkface, moteTopics, customTab, scratchWorkspace } from './fixtures/mote-workface'

afterEach(() => window.localStorage.clear())
function current() { return useAppStore.getState().demands.goal! }
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
/** Mounted production navigation consumers; Chromium workbench composition is separately verified. */
function Conversation() {
  const [floating] = usePmoTeamsTopicFloatingState(), target = usePmoTeamsTopicTarget(floating)
  const tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  const catalog = spatialCatalog(useAppStore.getState(), moteTopics)
  const projected = moteWorkbenchProjection(catalog, tabs, floating, () => {}, layouts)
  const views = pmoTeamsTopicFloatingViewTargets(floating, tabs, layouts[scratchWorkspace.id], null, projected.projection)
  return createElement('output', { 'data-original-conversation': true, 'data-open': String(floating.open),
    'data-agent': floating.agentTarget?.agentSessionId ?? '', 'data-tab': target.tabId ?? '', 'data-session': target.session?.id ?? '',
    'data-region': target.region?.regionId ?? '', 'data-status': target.statusText,
    'data-retained-region': target.tabId ? views?.[target.tabId]?.[0]?.retainedRegionId ?? '' : '',
    'data-views': Object.keys(views ?? {}).join(','), 'data-projection': projected.projection?.entity.kind ?? '',
    'data-issue': target.identityIssue ?? projected.issue ?? '', 'data-message': floating.entryMessage ?? '' })
}
function Harness() { return createElement('div', null, createElement(GoalDelegationWork, { demand: current() }), createElement(Conversation)) }
function output() { return container.querySelector<HTMLOutputElement>('[data-original-conversation]')! }
function conversation(values: Record<string, string>) { for (const [key, value] of Object.entries(values)) expect(output().getAttribute('data-' + key), key).toBe(value) }
function recordedState(state: ReturnType<typeof useAppStore.getState>) {
  return Object.fromEntries(['config', 'tabs', 'layouts', 'sessions', 'demands', 'spaceZoneBindings', 'spatialRequests', 'agentComposerDrafts',
    'viewModes', 'agentNames', 'timelines', 'agentFocus', 'recentMoteAgents', 'scratchTopicSnapshots', 'activeWorkspaceId', 'mainSurface',
    'workbenchSpaceSelection', 'spaceObjectIcons'].map(key => [key, state[key as keyof typeof state]]))
}
async function idle() {
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.goal-patrol__actions > button')?.getAttribute('aria-busy')).toBe('false'), { timeout: 10_000 }) })
  await settle()
}
/** The original patrol action stays the same control as its label reflects its receipt. */
function patrolAction() {
  const found = container.querySelector<HTMLButtonElement>('.goal-patrol__actions > button[aria-busy]')
  expect(found, 'the original patrol request / receipt action').not.toBeNull(); return found!
}
async function prepared(placement: 'mote' | 'project' = 'project') {
  seedMoteWorkface()
  const f = await fixture({ patrol: true }); await f.finite(); await f.setNativeState('owner', 'done'); await f.publish()
  const projected = await f.capture('conversation-initial')
  const workspaceId = placement === 'mote' ? scratchWorkspace.id : 'project'
  const tab = { ...createWorkbenchTab('original-manager-tab', { kind: 'agent' as const, phase: 'attached' as const,
    workspaceId, regionId: 'original-manager-region', sessionId: 'owner' }), ...(placement === 'mote' ? { topicId: customTab.topicId } : {}) }
  const before = useAppStore.getState()
  await act(async () => useAppStore.setState({ sessions: [...before.sessions, ...projected.sessions],
    tabs: { ...before.tabs, [tab.id]: tab }, layouts: { ...before.layouts,
      [workspaceId]: createWorkspaceLayout('original-display-group', [tab.id, ...(workspaceId === scratchWorkspace.id ? Object.keys(before.tabs) : [])]) },
    agentComposerDrafts: { ...before.agentComposerDrafts, owner: 'Original unsent Supervisor input' }, viewModes: { ...before.viewModes, owner: 'terminal' } }))
  await mount(createElement(Harness))
  return { f, tab }
}

describe('single PMO inspection reaches its exact original conversation before business input', () => {
  for (const placement of ['mote', 'project'] as const) it(`${placement} original Supervisor opens immediately through shared production projection and retains cwd, drafts and background`, async () => {
    const { f, tab } = await prepared(placement), before = useAppStore.getState()
    const preserved = { tabs: before.tabs, layouts: before.layouts, drafts: before.agentComposerDrafts,
      focus: before.agentFocus, selection: before.workbenchSpaceSelection, recent: before.recentMoteAgents }
    const originalPort = vi.mocked(api.demands.delegation).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.demands.delegation).mockImplementation(async (method, params) => { if (method === 'goal.patrol') await gate; return await originalPort(method, params) })
    try {
      await act(async () => { patrolAction().click(); await Promise.resolve() })
      conversation({ open: 'true', agent: 'owner', tab: tab.id, session: 'owner', region: 'original-manager-region', views: tab.id, projection: 'tab', issue: '' })
      expect(f.attempts).toHaveLength(0)
      expect(output().dataset.message).toContain('正在请求原 PMO 巡查')
      expect(useAppStore.getState().viewModes.owner).toBe('activity')
      // Another click can still reach the original conversation while the owner is slow.
      await act(async () => button('核对原巡查…').click())
      expect(output().dataset.agent).toBe('owner')
    } finally { await act(async () => release()) }
    await act(async () => { await vi.waitFor(() => expect(current().patrols).toHaveLength(1), { timeout: 10_000 }); await f.flushPatrol(); await refreshGoalDelegations('goal') }); await idle()
    expect(f.attempts).toHaveLength(1); expect(f.attempts[0]).toMatchObject({ agentSessionId: 'owner', runId: 'owner-run' })
    expect(f.nativeWrites.length).toBeGreaterThan(0)
    expect(current().patrolObservations![0]!.state).toBe('delivered')
    expect(output().getAttribute('data-message')).toBe('')
    // Input acknowledgement cannot manufacture Working: original semantic Done remains visible.
    expect(output().dataset.status).not.toMatch(/Working|working/)
    const after = useAppStore.getState()
    expect({ tabs: after.tabs, layouts: after.layouts, drafts: after.agentComposerDrafts,
      focus: after.agentFocus, selection: after.workbenchSpaceSelection, recent: after.recentMoteAgents }).toEqual(preserved)
    expect(after.sessions.find(session => session.id === 'owner')!.workspacePath).toBe(f.metadata.get('owner')!.workspacePath)
    await act(async () => requestPmoTeamsTopicFloatingClose())
    const requests = vi.mocked(api.demands.delegation).mock.calls.filter(([method]) => method === 'goal.patrol').length
    await act(async () => patrolAction().click()); await idle()
    conversation({ open: 'true', agent: 'owner', tab: tab.id })
    expect(vi.mocked(api.demands.delegation).mock.calls.filter(([method]) => method === 'goal.patrol')).toHaveLength(requests)
    expect(f.attempts).toHaveLength(1)
    await mount(null); await mount(createElement(Harness))
    conversation({ open: 'true', agent: 'owner', tab: tab.id, region: 'original-manager-region', views: tab.id })
    const proof = await f.proof(), source = await evidence(`conversation-${placement}-original-projection-input-and-reopen`, { retained: readPmoTeamsTopicFloatingState(), proof }, 'patrol')
    const directory = process.env.AGENTMUX_GOAL_PATROL_RECEIPT_DIR
    if (placement === 'project' && source && directory) {
      const bytes = JSON.stringify({ schema: 'agentmux.goal-patrol-conversation-visual-source.v1', source,
        initialState: recordedState(before), afterState: recordedState(useAppStore.getState()), floating: readPmoTeamsTopicFloatingState(),
        proof, boundary: 'Actual persisted owners and compiled CLI/RPC exchanges. Only isolated Native transport/status and presentation metadata; visual replay cannot create a new receipt, input or model answer.' }, null, 2) + '\n'
      await fs.writeFile(join(directory, 'single-journey.json'), bytes)
      await fs.writeFile(join(directory, 'single-journey.json.sha256'), createHash('sha256').update(bytes).digest('hex') + '\n')
    }
  }, 30_000)

  it('unknown original target opens its own service window instead of a previously selected Mote, and never replays unknown input', async () => {
    const { f, tab } = await prepared('mote'); f.patrolState.loseReceiptAfterSubmit = true; f.patrolState.receiptUnavailable = true
    await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: customTab.topicId!, targetTabId: customTab.id }))
    await act(async () => patrolAction().click())
    await act(async () => { await vi.waitFor(() => expect(current().patrolObservations?.[0]?.state).toBe('unknown'), { timeout: 10_000 }) }); await idle()
    expect(f.attempts).toHaveLength(1)
    await act(async () => {
      useAppStore.setState(state => ({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== 'original-manager-tab')) }))
      publishWorkbenchTabRemoved(tab, { displayWorkspaceId: scratchWorkspace.id, groupId: 'original-display-group', tabOrder: [tab.id, customTab.id] }, error => { throw error })
    })
    await act(async () => { await vi.waitFor(() => expect(patrolAction()).toBeDefined(), { timeout: 10_000 }) })
    await act(async () => patrolAction().click()); await idle()
    conversation({ open: 'true', agent: 'owner', tab: 'original-manager-tab', session: '', views: '' })
    expect(readPmoTeamsTopicFloatingState()!.reference).toMatchObject({ tabId: 'original-manager-tab', regionId: 'original-manager-region' })
    expect(output().dataset.issue).toContain('原 Agent')
    expect(output().dataset.message).toBe(current().patrolObservations![0]!.reason)
    expect(f.attempts).toHaveLength(1)
    expect(current().patrols![0]!.attempts).toHaveLength(1)
    expect(useAppStore.getState().tabs[customTab.id]).toBeDefined()
    await evidence('conversation-original-unknown-target-and-unknown-input-no-replay', { retained: readPmoTeamsTopicFloatingState(), proof: await f.proof() }, 'patrol')
  }, 30_000)

  it('explicit inspection visibly resumes the ended same Session and continues only its never-attempted original patrol', async () => {
    const { f, tab } = await prepared(), original = f.statuses.get('owner')!
    f.runStates.set('owner-run', 'exited')
    f.statuses.set('owner', { ...original, run: { ...original.run, state: 'exited' }, observation: observeAgent({ process: 'exited', status: original.session.semanticStatus!,
      timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, Date.now()) })
    await act(async () => { useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'owner' ? { ...session, processState: 'exited' as const } : session) })); await refreshGoalDelegations('goal') })
    expect(current().responsibility!.supervisor.state).toBe('ended')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const recovery = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
      expect(control).toMatchObject({ kind: 'agent', agentSessionId: 'owner', run: { runId: 'owner-run' } })
      await gate; await f.advanceSession('owner', 'owner-recovered-run')
      const projection = await f.capture('same-session-recovered')
      return { kind: 'resumed', session: projection.sessions.find(session => session.id === 'owner')! }
    })
    try {
      await act(async () => patrolAction().click())
      await act(async () => { await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce(), { timeout: 10_000 }) })
      expect(output().dataset.message).toContain('通过 Core 恢复同一 Session')
      conversation({ agent: 'owner', tab: tab.id })
      expect(f.attempts).toHaveLength(0)
    } finally { await act(async () => release()) }
    await act(async () => { await vi.waitFor(() => expect(f.attempts).toHaveLength(1), { timeout: 10_000 }); await f.flushPatrol(); await refreshGoalDelegations('goal') }); await idle()
    expect(f.attempts[0]).toMatchObject({ agentSessionId: 'owner', runId: 'owner-recovered-run' })
    expect(current().patrols).toHaveLength(1)
    expect(current().patrols![0]!.attempts).toHaveLength(2)
    expect(current().patrols![0]!.attempts[0]!.attemptedAt).toBeFalsy()
    expect(current().patrols![0]!.attempts[1]!.attemptedAt).toBeGreaterThan(0)
    expect(useAppStore.getState().agentComposerDrafts.owner).toBe('Original unsent Supervisor input')
    expect(readPmoTeamsTopicFloatingState()!.reference).toMatchObject({ tabId: tab.id, regionId: 'original-manager-region' })
    expect(f.stop).not.toHaveBeenCalled()
    await evidence('conversation-explicit-same-session-recovery-never-attempted-continuation', { retained: readPmoTeamsTopicFloatingState(), proof: await f.proof() }, 'patrol')
  }, 30_000)

  it('the exact Supervisor Region wins over another active Region without changing the original split or background selection', async () => {
    const { f, tab } = await prepared()
    const split = addWorkbenchRegion(tab, 'original-manager-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: tab.workspaceId,
      regionId: 'neighbor-active-region', sessionId: 'worker-a' })
    expect(split.layout.activeRegionId).toBe('neighbor-active-region')
    await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: split } })))
    const before = useAppStore.getState()
    await act(async () => patrolAction().click())
    await act(async () => { await vi.waitFor(() => expect(current().patrols).toHaveLength(1), { timeout: 10_000 }); await f.flushPatrol() }); await idle()
    conversation({ open: 'true', agent: 'owner', tab: tab.id, session: 'owner', region: 'original-manager-region', 'retained-region': 'original-manager-region', views: tab.id })
    expect(useAppStore.getState().tabs[tab.id]).toBe(split)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(f.attempts).toHaveLength(1)
    await evidence('conversation-exact-region-preserves-other-active-split', { retained: readPmoTeamsTopicFloatingState(), proof: await f.proof() }, 'patrol')
  }, 30_000)

  it('an owner-supplied exact reference with no Session snapshot cannot display another Agent occupying that Region', async () => {
    const { f, tab } = await prepared(), before = useAppStore.getState()
    const reference = { displayWorkspaceId: 'project', groupId: 'original-display-group', tabId: tab.id, regionId: 'original-manager-region' }
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'owner') })))
    await act(async () => requestAgentConversationFloatingOpen('original-not-yet-observed', 'local', '原创建仍在准备', reference))
    conversation({ open: 'true', agent: 'original-not-yet-observed', tab: tab.id, session: '', views: '' })
    expect(output().dataset.issue).toContain('原 Agent 未在所选位置确认')
    expect(readPmoTeamsTopicFloatingState()!.reference).toEqual(reference)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(f.attempts).toHaveLength(0)
  }, 30_000)

  for (const late of ['clear', 'failure'] as const) it(`a late ${late} from Goal A cannot change Goal B feedback when both use the same original Supervisor`, async () => {
    const { f } = await prepared(); f.patrolState.inputOccupied = true
    await f.demands.create({ id: 'goal-b', title: 'Second original Goal', status: 'in_progress', assigneeSessionIds: ['owner', 'finite-worker'],
      sessionIds: ['owner', 'finite-worker'], supervisorSessionId: 'owner' })
    await f.demands.prepareDispatch('goal-b', { operationId: 'second-finite-start', agentSessionId: 'finite-worker', hostId: 'local', runId: 'finite-worker-run', execution: 'finite', prompt: 'Second original finite task' })
    await f.demands.recordDispatchPhase('goal-b', 'second-finite-start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:second-finite-start', createdAt: Date.now() } })
    await act(async () => { await useAppStore.getState().refreshDemand('goal-b'); await refreshGoalDelegations('goal-b') })
    function Both() {
      const goals = useAppStore(state => state.demands)
      return createElement('div', null, ...['goal', 'goal-b'].map(id => createElement('div', { key: id, 'data-case-goal': id },
        createElement(GoalDelegationWork, { demand: goals[id]! }))), createElement(Conversation))
    }
    await mount(createElement(Both))
    const action = (id: string) => container.querySelector<HTMLButtonElement>(`[data-case-goal="${id}"] .goal-patrol__actions > button`)!
    expect(action('goal-b')).not.toBeNull()
    const originalPort = vi.mocked(api.demands.delegation).getMockImplementation()!
    let releaseA!: () => void, releaseB!: () => void
    const gateA = new Promise<void>(resolve => { releaseA = resolve }), gateB = new Promise<void>(resolve => { releaseB = resolve })
    vi.mocked(api.demands.delegation).mockImplementation(async (method, params) => {
      const response = await originalPort(method, params)
      if (method === 'goal.patrol') {
        await (params.goalId === 'goal' ? gateA : gateB)
        if (params.goalId === 'goal' && late === 'failure') throw Error('Original Goal A acknowledgement is unavailable')
      }
      return response
    })
    try {
      await act(async () => action('goal').click())
      await act(async () => { await vi.waitFor(() => expect(current().patrols).toHaveLength(1), { timeout: 10_000 }) })
      const entryA = readPmoTeamsTopicFloatingState()!.conversationEntry
      await act(async () => action('goal').click())
      expect(readPmoTeamsTopicFloatingState()!.conversationEntry).toBe(entryA)
      await act(async () => action('goal-b').click())
      await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().demands['goal-b']!.patrols).toHaveLength(1), { timeout: 10_000 }) })
      const selectedB = readPmoTeamsTopicFloatingState()!
      expect(selectedB.entryContext?.goalId).toBe('goal-b'); expect(selectedB.conversationEntry).not.toBe(entryA)
      expect(selectedB.entryMessage).toContain('正在请求原 PMO 巡查')
      await act(async () => releaseA())
      await act(async () => { await vi.waitFor(() => expect(action('goal').getAttribute('aria-busy')).toBe('false'), { timeout: 10_000 }) })
      expect(readPmoTeamsTopicFloatingState()!.entryMessage).toBe(selectedB.entryMessage)
      expect(readPmoTeamsTopicFloatingState()!.entryContext?.goalId).toBe('goal-b')
      expect(f.attempts).toHaveLength(0)
    } finally {
      await act(async () => { releaseA(); releaseB() })
      await act(async () => { await vi.waitFor(() => expect(action('goal-b').getAttribute('aria-busy')).toBe('false'), { timeout: 10_000 }) })
      await settle()
    }
  }, 30_000)
})
