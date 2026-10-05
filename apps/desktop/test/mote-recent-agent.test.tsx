// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseAgentMuxControlRequest } from '../../../packages/core/src/control-codec'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, readPmoTeamsTopicFloatingState,
  createPmoTeamsTopicTargetSelector } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { restoredRecentMoteAgents } from '../src/renderer/src/lib/mote-quick-preferences'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, defaultAgent, defaultTab, neighborAgent, neighborTab, ordinaryTab,
  quietTab, savedMoteKey, moteTopics } from './fixtures/mote-workface'

let app: MoteAppFixture
const reference = (tab = neighborTab, regionId = tab.layout.activeRegionId) => ({
  displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: tab.id, regionId
})
const visit = (tab = neighborTab) => useAppStore.getState().activateTab(SCRATCH_WORKSPACE_ID, 'mote-group', tab.id, 'local')
async function open(topicId = PMO_TEAMS_TOPIC_ID) {
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId })); await settleMoteApp()
}
async function close() { await act(async () => requestPmoTeamsTopicFloatingClose()); await settleMoteApp() }
const saved = () => JSON.parse(localStorage.getItem(savedMoteKey)!)
function assertSelected(tab = neighborTab, sessionId = neighborAgent.id, regionId = tab.layout.activeRegionId) {
  expect(app.panel().dataset.moteTargetTab).toBe(tab.id)
  expect(app.panel().dataset.moteTargetSession).toBe(sessionId)
  expect(saved().reference).toEqual(reference(tab, regionId))
  const inputs = app.panel().querySelectorAll(`[data-workbench-region-id="${regionId}"] [aria-label="Message Agent"]`)
  expect(inputs).toHaveLength(1)
  expect(app.panel().textContent).not.toContain('Choose a discussion')
}
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

it('Space visits are remembered per Mote, override main-conversation preferences and preserve original Composer/drafts', async () => {
  const state = useAppStore.getState(), topics = moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic,
    quickMode: { status: 'saved' as const, version: 'fixture', defaults: { conversation: { ...reference(defaultTab), hostId: 'local', sessionId: defaultAgent.id } } } } : topic)
  useAppStore.setState({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
    [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics } } })
  app.listTopics.mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  visit(); visit(customTab)
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject({ ...reference(), hostId: 'local', sessionId: neighborAgent.id, presentationSessionId: neighborAgent.id })
  await app.mount(); await open(); assertSelected()
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${customMoteId}"]`)!)
  assertSelected(customTab, 'custom-agent')
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)!)
  assertSelected()
  expect(useAppStore.getState().agentComposerDrafts).toEqual(state.agentComposerDrafts)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics).toEqual(topics)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

it('original floating Tab-strip selection records the actual Agent, and reopening restores it', async () => {
  await app.mount(); await open()
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${neighborTab.id}"]`)!)
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject(reference())
  await close(); await open(); assertSelected()
})

it('actual Footer click opens the recent Agent instead of passing its stale displayed Tab as an explicit target', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID,
    targetTabId: defaultTab.id, reference: reference(defaultTab) }))
  visit(); await app.mount()
  expect(app.entry().dataset.moteTargetTab).toBe(defaultTab.id)
  await moteClick(app.entry()); assertSelected()
})

it('actual Footer initial entry does not invent a visit before the human selects an Agent', async () => {
  await app.mount(); await moteClick(app.entry()); assertSelected(defaultTab, defaultAgent.id)
  expect(useAppStore.getState().recentMoteAgents).toEqual({})
})

it('retained Tab recovery records the exact Agent only after the original recovery Tab is clicked', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: null }))
  await app.mount()
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBeNull()
  expect(useAppStore.getState().recentMoteAgents).toEqual({})
  await moteClick(app.panel().querySelector<HTMLButtonElement>(`button[data-workbench-tab-id="${neighborTab.id}"]`)!)
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject(reference())
  await close(); await open(); assertSelected()
})

it('legacy Mote bootstrap preserves its confirmed active Group when the same Tab has two locations', async () => {
  const first = createWorkspaceLayout('first-group', [defaultTab.id]), second = createWorkspaceLayout('mote-group', [defaultTab.id, neighborTab.id])
  useAppStore.setState(state => ({ mainSurface: 'board', layouts: { ...state.layouts, [SCRATCH_WORKSPACE_ID]: {
    root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: first.root, second: second.root },
    groups: [...first.groups, ...second.groups], activeGroupId: 'mote-group' } } }))
  const before = useAppStore.getState()
  await app.mount(); await open(); assertSelected(defaultTab, defaultAgent.id)
  expect(useAppStore.getState().recentMoteAgents).toBe(before.recentMoteAgents)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
})

it.each(['pointer', 'floating-pointer', 'navigation'] as const)('original %s Region focus retains the exact non-active Agent Region', async cause => {
  const split = addWorkbenchRegion(defaultTab, defaultTab.layout.activeRegionId, 'right', {
    kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'split-agent', sessionId: neighborAgent.id })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [defaultTab.id]: { ...split, layout: { ...split.layout, activeRegionId: defaultTab.layout.activeRegionId } } } }))
  useAppStore.getState().focusRegion(SCRATCH_WORKSPACE_ID, defaultTab.id, 'split-agent', cause, 'mote-group')
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject(reference(defaultTab, 'split-agent'))
  await app.mount(); await open(); assertSelected(defaultTab, neighborAgent.id, 'split-agent')
})

it('existing public focus receipt records the same exact bookmark without adding a business API', async () => {
  const result = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5,
    requestId: 'recent-mote-public-focus', operation: 'focus', target: { kind: 'space', regionId: neighborTab.layout.activeRegionId } }))
  expect(result.operation).toBe('focus')
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject(reference())
})

it('explicit Goal/Focus targets win and become the next recent Agent; automatic rendering never rewrites it', async () => {
  visit(); await app.mount()
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, reference: reference(defaultTab) }))
  await settleMoteApp(); assertSelected(defaultTab, defaultAgent.id)
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toMatchObject(reference(defaultTab))
  await close(); await open(); assertSelected(defaultTab, defaultAgent.id)
})

it('hover reads recent Agent without saving, starting, changing mode or stealing focus', async () => {
  visit(); useAppStore.setState({ viewModes: { [neighborAgent.id]: 'terminal' } }); await app.mount()
  const before = useAppStore.getState(), disk = localStorage.getItem(savedMoteKey)
  await app.hover()
  expect(app.panel().dataset.moteTargetTab).toBe(neighborTab.id)
  expect(useAppStore.getState().recentMoteAgents).toBe(before.recentMoteAgents)
  expect(useAppStore.getState().viewModes).toBe(before.viewModes)
  expect(localStorage.getItem(savedMoteKey)).toBe(disk)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('background visits update only the next entry and never retarget the already-open exact surface', async () => {
  visit(defaultTab); await app.mount(); await open(); assertSelected(defaultTab, defaultAgent.id)
  await act(async () => visit()); await settleMoteApp()
  assertSelected(defaultTab, defaultAgent.id)
  await close(); await open(); assertSelected()
})

it('an already-open unconfirmed surface never follows a later background bookmark', () => {
  const current = useAppStore.getState(), layout = createWorkspaceLayout('mote-group', [customTab.id])
  const selector = createPmoTeamsTopicTargetSelector({ open: true, preview: false, targetTopicId: PMO_TEAMS_TOPIC_ID })
  const unresolved = { ...current, layouts: { [SCRATCH_WORKSPACE_ID]: layout } }
  expect(selector(unresolved)).toBeUndefined()
  expect(selector({ ...unresolved, recentMoteAgents: { [PMO_TEAMS_TOPIC_ID]: { ...reference(), hostId: 'local', sessionId: neighborAgent.id, presentationSessionId: neighborAgent.id } } })).toBeUndefined()
})

it.each(['missing-region', 'replacement-without-snapshot', 'replacement-with-snapshot'] as const)('retains exact last Agent identity under %s without substituting a healthy neighbor', async change => {
  visit()
  const state = useAppStore.getState(), old = neighborTab.regions[neighborTab.layout.activeRegionId]!
  if (old.kind !== 'agent') throw new Error('Agent fixture required')
  const remaining = createWorkbenchTab(neighborTab.id, { kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'remaining-agent', sessionId: defaultAgent.id })
  const changed = change === 'missing-region' ? { ...remaining, topicId: PMO_TEAMS_TOPIC_ID } : { ...neighborTab, regions: { [old.regionId]: { ...old, sessionId: 'replacement-agent' } } }
  useAppStore.setState({ tabs: { ...state.tabs, [neighborTab.id]: changed },
    sessions: change === 'replacement-with-snapshot' ? [...state.sessions, { ...neighborAgent, id: 'replacement-agent', control: { ...neighborAgent.control, kind: 'agent' as const, agentSessionId: 'replacement-agent' } }] : state.sessions })
  await app.mount(); await open()
  expect(saved()).toMatchObject({ targetTabId: neighborTab.id, reference: reference(), targetAgent: { sessionId: neighborAgent.id } })
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]?.sessionId).toBe(neighborAgent.id)
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBeNull()
  expect(app.panel().querySelector(`[data-activity-session="${defaultAgent.id}"]`)).toBeNull()
  expect(app.panel().querySelector(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)?.getAttribute('data-mote-status')).toBe('Original Agent retained')
  await open(customMoteId)
  expect(app.panel().querySelector(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)?.getAttribute('data-mote-status')).toBe('Original Agent retained')
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('non-Agent/ordinary-Topic/invalid visits and identical repeats preserve bookmark object identity', () => {
  visit(); const before = useAppStore.getState().recentMoteAgents
  visit(); visit(quietTab); visit(ordinaryTab)
  useAppStore.getState().rememberMoteAgent({ ...reference(), groupId: 'foreign-group' })
  for (let n = 0; n < 35; n++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: n })) }))
  expect(useAppStore.getState().recentMoteAgents).toBe(before)
  expect(Object.keys(before)).toEqual([PMO_TEAMS_TOPIC_ID])
})

it('original persistence retains valid unloaded references and rejects malformed storage without consulting live Session availability', async () => {
  visit(); const state = useAppStore.getState(), options = useAppStore.persist.getOptions()
  const persisted = options.partialize!(state)
  expect(persisted.recentMoteAgents).toBe(state.recentMoteAgents)
  const restored = options.merge!({ ...persisted }, { ...state, recentMoteAgents: {}, sessions: [], tabs: {}, layouts: {} })
  expect(restored.recentMoteAgents).toEqual(state.recentMoteAgents)
  for (const value of [null, [], 'bad', { [PMO_TEAMS_TOPIC_ID]: { tabId: null } }])
    expect(options.merge!({ recentMoteAgents: value }, state).recentMoteAgents).toEqual({})
  expect(restoredRecentMoteAgents(state.recentMoteAgents)).toEqual(state.recentMoteAgents)
})

it('only committed entity close clears its bookmark, without removing another Mote history', async () => {
  visit(); visit(customTab)
  const before = useAppStore.getState()
  expect(await before.closeTab(SCRATCH_WORKSPACE_ID, 'mote-group', neighborTab.id, { keepAgentSessions: true })).toBe(true)
  expect(useAppStore.getState().recentMoteAgents[PMO_TEAMS_TOPIC_ID]).toBeUndefined()
  expect(useAppStore.getState().recentMoteAgents[customMoteId]).toBe(before.recentMoteAgents[customMoteId])
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(app.stop).not.toHaveBeenCalled()
})
