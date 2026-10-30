// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, neighborAgent, neighborTab, customAgent, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { readPmoTeamsTopicFloatingState } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { moteMembers, moteMemberSnapshot } from '../src/renderer/src/lib/mote-team'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import * as goalPresentation from '../src/renderer/src/lib/mote-goals'

let app: MoteAppFixture
const main = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const request = { kind: 'permission' as const, id: 'original-scope-decision', agentSessionId: neighborAgent.id,
  title: 'Review the original scope', options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' as const }],
  evidence: { source: 'native-hook' as const, observedAt: 2, run: neighborAgent.control.run, hookReceiptId: 'original-scope-decision' } }
const button = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
const header = () => app.container.querySelector<HTMLElement>('.mote-space-frame__header [data-mote-cooperation]')!
beforeEach(() => {
  app = createMoteApp()
  const topics = moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic,
    quickMode: { status: 'saved' as const, version: 'original-preference', defaults: { conversation: main } } } : topic)
  app.listTopics.mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id
    ? { ...session, pendingInteraction: request } : session), scratchTopicSnapshots: {
    ...state.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics }
  } }))
})
afterEach(async () => { await app.dispose() })

it('the real Space header reveals only this Mote team and its original request without sending input', async () => {
  await app.mount()
  expect(header()).not.toBeNull()
  expect(header().textContent).toContain('Main Agent')
  expect(header().textContent).toContain('Ship the target goal')
  expect(header().querySelector('[data-mote-team]')).toBeNull()
  expect(button(header(), 'Team work').textContent).toContain('1 needs you')
  await moteClick(button(header(), 'Team work'))
  const team = header().querySelector('[data-mote-team]')!
  expect([...team.querySelectorAll('[data-mote-member]')].map(row => row.getAttribute('data-mote-member'))).toEqual([neighborAgent.id, defaultAgent.id])
  expect(team.textContent).toContain(request.title)
  expect(team.textContent).not.toContain(customAgent.id)
  expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('the real Space team opens the original member and returns to main without losing either draft or layout', async () => {
  await app.mount()
  const before = useAppStore.getState()
  await moteClick(button(header(), 'Team work'))
  await moteClick(button(header(), 'Open Other goal'))
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId })
  expect(header().textContent).toContain('Team member')
  expect(header().textContent).toContain('Other goal')
  await moteClick(button(header(), 'Return to main Agent'))
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ tabId: main.tabId, regionId: main.regionId })
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('the actual floating team keeps navigation in its own workface and can return to the original main Agent', async () => {
  await app.mount(); await moteClick(app.entry())
  const panel = app.panel(), selected = useAppStore.getState().workbenchSpaceSelection
  await moteClick(button(panel, 'Team work')); await moteClick(button(panel, 'Open Other goal'))
  expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ tabId: neighborTab.id, regionId: neighborTab.layout.activeRegionId })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selected)
  expect(panel.querySelector('[data-mote-cooperation]')?.textContent).toContain('Team member')
  await moteClick(button(panel, 'Return to main Agent'))
  expect(readPmoTeamsTopicFloatingState()?.reference).toMatchObject({ tabId: main.tabId, regionId: main.regionId })
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selected)
  expect(app.send).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})

it('a stale Run request is not promoted into a current human task and unrelated activity does not change the team', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id
    ? { ...session, pendingInteraction: { ...request, evidence: { ...request.evidence, run: { runId: 'previous-run' } } } } : session) }))
  await app.mount()
  expect(button(header(), 'Team work').textContent).not.toContain('needs you')
  await moteClick(button(header(), 'Team work'))
  const row = header().querySelector('[data-mote-member="default-agent"]')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === customAgent.id
    ? { ...session, status: { ...session.status, state: 'error' as const } } : session) })))
  expect(header().querySelector('[data-mote-member="default-agent"]')).toBe(row)
  expect(header().querySelectorAll('[data-mote-member]')).toHaveLength(2)
})

it('unknown metadata retains the original member and healthy conversation with a local explanation', async () => {
  await app.mount(); await moteClick(button(header(), 'Team work'))
  app.listTopics.mockRejectedValue(new Error('Original directory unavailable'))
  useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics: state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.map(topic =>
      topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, readError: 'Original metadata unavailable' } : topic) }
  } }))
  await settleMoteApp()
  expect(header().querySelectorAll('[data-mote-member]')).toHaveLength(2)
  expect(header().textContent).toContain('Original metadata unavailable')
  expect(useAppStore.getState().tabs[defaultTab.id]).toBeDefined()
  expect(app.stop).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})

it('the original graph preserves multiple positions and qualifies equal Session ids by execution Host', () => {
  const state = useAppStore.getState(), catalog = spatialCatalog(state, moteTopics)
  const space = catalog.spaces.find(item => item.topicId === PMO_TEAMS_TOPIC_ID)!
  const original = catalog.regions.find(region => region.agentSessionId === defaultAgent.id)!
  const memberLocation = catalog.locations.find(location => location.regionId === original.regionId)!
  const graph = { ...catalog, regions: [...catalog.regions, { ...original, regionId: 'remote-original-region', execution: { hostId: 'remote', cwd: '/original' } }],
    locations: [...catalog.locations, { ...memberLocation, groupId: 'second-original-group' }] }
  const members = moteMembers(graph, space.spaceId), local = members.find(member => member.hostId === 'local' && member.agentSessionId === defaultAgent.id)!
  expect(local.locations).toHaveLength(2)
  const remote = members.find(member => member.hostId === 'remote' && member.agentSessionId === defaultAgent.id)!
  expect(remote.key).not.toBe(local.key)
  expect(moteMemberSnapshot(remote, state.tabs, state.sessions)).toBeUndefined()
  expect(moteMemberSnapshot(local, state.tabs, state.sessions)?.control.hostId).toBe('local')
  expect(members.some(member => member.agentSessionId === customAgent.id)).toBe(false)
})

it('the Mote team reserves human review for its original Goal owner and keeps foreign Host or manager work separate', async () => {
  const goal = (id: string, owner: 'human' | 'manager', hostId = 'local'): DemandRecord => ({ id, title: id, description: '', status: 'in_progress',
    priority: 'normal', projectId: null, projectName: null, sessionIds: [defaultAgent.id], createdAt: 1, updatedAt: 2, source: 'session',
    responsibility: { scope: 'original-goal-scope', observedAt: 2, supervisor: { agentSessionId: defaultAgent.id, hostId, state: 'available', reason: 'Original coordinator' },
      executions: [{ execution: { kind: 'start', operationId: 'original-' + id, hostId, agentSessionId: defaultAgent.id, runId: defaultAgent.control.run.runId },
        binding: 'confirmed', phase: 'result-review', reason: 'Original result', alert: null,
        nextOwner: { kind: owner, agentSessionId: owner === 'human' ? null : defaultAgent.id, action: 'Review original evidence' },
        basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null } }] }
  })
  const mixed = goal('Shared Goal with another Host', 'manager')
  mixed.responsibility!.executions.push(goal('Foreign human row', 'human', 'different-original-host').responsibility!.executions[0]!)
  await app.mount()
  await act(async () => useAppStore.setState({ demands: Object.fromEntries([goal('Human decision', 'human'), goal('Coordinator follow-up', 'manager'),
    goal('Foreign Host decision', 'human', 'different-original-host'), mixed].map(item => [item.id, item])) }))
  await moteClick(button(header(), 'Team work'))
  expect(header().querySelectorAll('.mote-cooperation__goal')).toHaveLength(1)
  expect(header().querySelector('.mote-cooperation__goal')?.textContent).toContain('Human decision')
  expect(header().textContent).not.toContain('Foreign Host decision')
  expect(header().querySelector('.mote-cooperation__team')?.textContent).toContain('2 needs you')
  expect(app.send).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled()
})

it('member activity never rescans the global Goal collection while a Goal change still refreshes it', async () => {
  const scan = vi.spyOn(goalPresentation, 'goalsForMote')
  await app.mount()
  expect(scan).toHaveBeenCalled()
  scan.mockClear()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id
    ? { ...session, status: { ...session.status, observedAt: 20, state: 'working' as const } } : session) })))
  expect(scan).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ demands: { ...state.demands } })))
  expect(scan).toHaveBeenCalled()
})
