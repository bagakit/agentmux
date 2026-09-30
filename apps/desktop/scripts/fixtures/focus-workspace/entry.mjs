import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { FocusWorkbenchFixture, absoluteFocusFixtureInputs } from '../../../test/fixtures/focus-workbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { restorePersistedUiState } from '../../../src/renderer/src/store'
import { restoreAgentFocus } from '../../../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

const snapshot = await api.sessions.snapshot()
const inputs = absoluteFocusFixtureInputs(await api.config.get(), snapshot.sessions)
const config = inputs.config
snapshot.sessions = inputs.sessions
const selected = snapshot.sessions.find(session => session.id === 'session-codex')
const workspaceId = 'workspace-demo'
const projects = Array.from({ length: 24 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/fixture/project-${index}`, hostId: 'local', kind: 'folder' }))
const scratch = { id: '__scratch__', name: 'Scratch', path: '/fixture/scratch', hostId: 'local', kind: 'folder' }
const topics = ['Planning', 'Focus design', 'Runtime recovery'].map((title, index) => ({ id: `launcher:topic${index}`, title, directoryPath: `${scratch.path}/topic--launcher--topic${index}`, topicPath: '', summary: '', collaborators: [] }))
config.workspaces.push(...projects, scratch)
api.scratch.listTopics = async () => topics
const listBranches = api.workspaces.listBranches
api.workspaces.listBranches = async id => projects.some(project => project.id === id)
  ? { kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(workspace => workspace.id === id).path }
  : listBranches(id)
const recovery = topics.flatMap((topic, group) => Array.from({ length: 12 }, (_, index) => ({ ...selected, id: `recovery-${group}-${index}`, label: `Saved task ${index + 1}`, workspacePath: topic.directoryPath, processState: 'disconnected', status: { ...selected.status, state: 'disconnected' } })))
const sessions = [selected, ...recovery, ...projects.map((workspace, index) => ({ ...selected, id: `context-${index}`, label: `Context ${index}`, workspacePath: workspace.path }))]
const tab = createWorkbenchTab('fixture-tab', { regionId: 'fixture-region', workspaceId, kind: 'agent', phase: 'attached', sessionId: selected.id })
const now = Date.now()
const fixtureUserMessage = { id: 'fixture-user-message', agentSessionId: selected.id, kind: 'user_message', status: 'complete', source: 'user', createdAt: now - 45 * 60000, updatedAt: now - 45 * 60000, title: 'User prompt', content: 'Inspect the original Context at this time.' }
snapshot.timelines[selected.id] = { ...snapshot.timelines[selected.id], items: [...snapshot.timelines[selected.id].items, fixtureUserMessage] }
const seed = {
  config, sessions, focusTimelineHeight: 96, timelines: snapshot.timelines, providerCatalog: [], agentNames: {},
  tabs: { [tab.id]: tab }, layouts: { [workspaceId]: { root: { type: 'leaf', groupId: 'fixture-group' }, groups: [{ id: 'fixture-group', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'fixture-group' } },
  mainSurface: 'agents', activeWorkspaceId: workspaceId,
  agentFocus: { execution: { sessionId: selected.id, history: [...sessions.map((session, index) => ({ sessionId: session.id, focusedAt: now - index * 60000 })), { sessionId: selected.id, focusedAt: now - 2 * 3600000 }] }, pmo: { sessionId: null } }
}
useAppStore.setState(seed)
window.focusProbeWheels = []
document.addEventListener('wheel', event => window.focusProbeWheels.push({ trusted: event.isTrusted, tracks: Boolean(event.target.closest('.recent-focus__viewport')), lanes: Boolean(event.target.closest('.focus-project-lanes__rows')), deltaX: event.deltaX, deltaY: event.deltaY }), true)
window.restoreFocusProbe = state => useAppStore.setState({ ...state, config, ...restorePersistedUiState(config, state), agentFocus: restoreAgentFocus(state.agentFocus) })
window.focusProbeInputReceipt = async () => (await api.sessions.snapshot()).timelines['session-codex'].items.at(-1)
window.focusProbeState = () => {
  const { tabs, layouts, agentFocus, sessions, timelines, focusTimelineHeight } = useAppStore.getState()
  return { tabs, layouts, agentFocus, sessions, timelines, focusTimelineHeight }
}
function Fixture() {
  useEffect(() => { window.focusProbeReady = true }, [])
  return createElement('section', { className: 'workspace-main-surface', style: { width: '100vw', height: '100vh', position: 'relative' } },
    createElement(FocusWorkbenchFixture, { workspaceId }))
}
createRoot(document.getElementById('root')).render(createElement(Fixture))
window.focusProbeGeometry = () => {
  const inspect = selector => {
    const node = document.querySelector(selector)
    if (!node) throw new Error(`Missing rendered Focus node: ${selector}`)
    const rect = node.getBoundingClientRect()
    return { height: rect.height, width: rect.width, top: rect.top, left: rect.left, scrollHeight: node.scrollHeight, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX, overflowY: getComputedStyle(node).overflowY }
  }
  const lanes = document.querySelector('.focus-project-lanes__rows')
  const rect = lanes.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + 30, rect.top + Math.min(20, rect.height / 2))
  const right = document.querySelector('.focused-tab-workspace .workbench-region')
  const rightRect = right.getBoundingClientRect()
  const rightHit = document.elementFromPoint(rightRect.left + rightRect.width / 2, rightRect.top + rightRect.height / 2)
  return { toolbar: inspect('.focus-toolbar'), contextHeader: inspect('.focus-toolbar__context'), laneNames: [...document.querySelectorAll('.focus-project-lanes__axis')].map(node => node.textContent), disconnectedToggles: [...document.querySelectorAll('.focus-recovery-toggle')].map(node => node.textContent), visibleRecovery: document.querySelectorAll('[data-session-id^=recovery-]').length, lanes: inspect('.focus-project-lanes__rows'), tracks: inspect('.recent-focus__viewport'), track: inspect('.focus-project-lanes__track'), body: inspect('.focused-tab-workspace .workbench-region'), slot: inspect('.focused-tab-workspace'), timeline: inspect('.recent-focus'), main: inspect('.global-focus-layout'), leftHit: Boolean(hit?.closest('.focus-project-lanes')), rightHit: Boolean(rightHit?.closest('.focused-tab-workspace')), terminal: Boolean(document.querySelector('.focused-tab-workspace .xterm')), hydrating: Boolean(document.querySelector('.focused-tab-workspace .terminal-view__xterm--hydrating')), regionIds: [...document.querySelectorAll('.focused-tab-workspace [data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId) }
}
