import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { createConversationReadApi } from '../../../src/renderer/src/lib/conversation-read-api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import producerData from '../focus-timeline-hover-inspection/public-producer.json'
import { fixtureData, fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

// Sealed original producer records enter the real private Core conversation owner.
// The UI Session/Run observations are typed fixture inputs, not actual native Runs.
const producer = fixtureData(producerData), now = producer.now
Date.now = () => now
const config = await api.config.get(), snapshot = await api.sessions.snapshot(), base = producer.sessions[0]
const alpha = { id: 'timeline-alpha', hostId: 'local', kind: 'folder', path: fixturePath('focus-project-timeline/alpha'), name: 'Alpha · 原项目与时间轴' }
const checkout = { ...alpha, id: 'timeline-checkout', kind: 'worktree', path: fixturePath('focus-project-timeline/checkout'), repoPath: alpha.path, branch: 'feature/history', name: 'Alpha checkout' }
const beta = { ...alpha, id: 'timeline-beta', path: fixturePath('focus-project-timeline/beta'), name: 'Beta · independent project' }
const empty = { ...alpha, id: 'timeline-empty', path: fixturePath('focus-project-timeline/empty'), name: 'Empty · no recorded activity' }
const projects = [alpha, checkout, beta, empty]
const actor = (id, workspace, label) => ({ ...base, id, label, hostId: 'local', workspacePath: workspace.path, processState: 'running',
  status: { state: 'done', source: 'native-hook', observedAt: now }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now - 20000 },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'project-timeline-run-' + id } } })
const recipient = producer.sessionId, other = producer.senderId
const sessions = [actor(recipient, checkout, 'Review original conversation · 保留草稿与阅读'), actor(other, beta, 'Independent design review')]
const captured = { ...producer.captured, agentSessionId: recipient, items: producer.captured.items.map(item => ({ ...item, agentSessionId: recipient, createdAt: now - 10000, updatedAt: now - 10000 })) }
const nativePage = { ...producer.nativePage, agentSessionId: recipient, items: [] }
const historyIdentity = (name, hostId, project) => ({ name, kind: 'agent', providerId: 'claude', hostId, workspacePath: alpha.path, project: { id: project.id, name: project.name } })
const history = [{ sessionId: recipient, focusedAt: now - 40000, identity: historyIdentity(sessions[0].label, 'local', alpha) },
  { sessionId: other, focusedAt: now - 30000, identity: { ...historyIdentity(sessions[1].label, 'local', beta), workspacePath: beta.path } },
  { sessionId: recipient, focusedAt: now - 60000, identity: historyIdentity('Archived same ID · original remote Host', 'remote-proof', alpha) },
  { sessionId: 'unrecorded-agent', focusedAt: now - 50000 }]
const tabs = Object.fromEntries(sessions.map((session, index) => {
  const workspace = index ? beta : checkout, tab = createWorkbenchTab('timeline-tab-' + index, { regionId: 'timeline-region-' + index, workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id }, session.label)
  return [tab.id, tab]
}))
tabs['timeline-empty-tab'] = createWorkbenchTab('timeline-empty-tab', { regionId: 'timeline-empty-region', workspaceId: empty.id, kind: 'launcher' }, 'Empty original project')
const candidate = { ...config, workspaces: projects, appearance: { ...config.appearance, appAppearance: 'dark' } }
const calls = Object.fromEntries(['stop', 'resume', 'recover', 'launchAgent', 'launchTerminal', 'write', 'interrupt'].map(name => [name, 0]))
for (const name of Object.keys(calls)) api.sessions[name] = async () => { calls[name]++; throw Error('No lifecycle or input action is authorized in a presentation scene') }
api.config.get = async () => candidate
api.scratch.listTopics = async () => []
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: projects.find(project => project.id === id)?.path ?? alpha.path })
api.sessions.historySources = async () => ({ sources: sessions.map(session => ({ hostId: 'local', agentSessionId: session.id, state: 'active', history: { providerId: session.providerId, executorId: session.executorId, workspacePath: session.workspacePath, createdAt: session.createdAt } })), warnings: [] })
api.sessions.snapshot = async () => ({ ...snapshot, sessions, timelines: { [recipient]: captured }, recoveryCandidates: [] })
await window.projectTimelineOwner.seed({ sessions, captured, nativePage })
Object.assign(api.conversation, createConversationReadApi(window.projectTimelineConversation))
window.presentationLeaves = { mounts: [], unmounts: [] }
useAppStore.setState({ loading: false, config: candidate, sessions, timelines: { [recipient]: captured }, activeWorkspaceId: checkout.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: true,
  tabs, layouts: Object.fromEntries(projects.map((project, index) => [project.id, createWorkspaceLayout('timeline-group-' + index, Object.values(tabs).filter(tab => tab.workspaceId === project.id).map(tab => tab.id))])),
  agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])), agentComposerDrafts: { [recipient]: 'Retain the original unsent draft', [other]: 'Another original draft' },
  focusTimelineHeight: 240, agentFocus: { execution: { sessionId: recipient, history }, pmo: { sessionId: null } }, error: null, lastError: null })
const arranged = useAppStore.getState(), spatial = await api.spatial.read(), originalSnapshot = api.sessions.snapshot
// Bootstrap the real spatial subscriber before publishing fixture Sessions. Empty
// startup has no saved Agent to recover; later presentation uses original bindings.
useAppStore.setState({ sessions: [], tabs: {}, layouts: {} })
api.sessions.snapshot = async () => ({ ...snapshot, sessions: [], timelines: {}, recoveryCandidates: [] })
await api.spatial.commit({ expectedRevision: spatial?.revision ?? 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
const dispose = await useAppStore.getState().initialize()
const started = await api.spatial.read()
await api.spatial.commit({ expectedRevision: started.revision, graph: desktopSpatialGraph(arranged, []) })
await new Promise(done => setTimeout(done, 0)); dispose(); api.sessions.snapshot = originalSnapshot
useAppStore.setState({ ...arranged, initialize: async () => () => {} }, true)
const inputEvents = []
document.addEventListener('click', event => { const button = event.target instanceof Element ? event.target.closest('button') : null; if (button) inputEvents.push({ trusted: event.isTrusted, label: button.getAttribute('aria-label'), text: button.textContent?.slice(0, 120), project: button.dataset.workspaceId, track: button.closest('[data-focus-timeline-id]')?.dataset.focusTimelineId }) }, true)
let initial
window.projectTimelineProof = {
  ready: true, recipient, other, alphaKey: JSON.stringify(['local', alpha.id]), betaKey: JSON.stringify(['local', beta.id]), emptyKey: JSON.stringify(['local', empty.id]),
  enter() { useAppStore.getState().focusRegion(checkout.id, 'timeline-tab-0', 'timeline-region-0', 'pointer', 'timeline-group-1'); initial = useAppStore.getState() },
  identities(width, working = false) { useAppStore.setState(state => ({ agentNames: { [recipient]: 'Original task identity with a deliberately long readable name · 保留原任务与草稿', [other]: 'I' }, focusTimelineNameWidth: width,
    ...(working ? { sessions: state.sessions.map(session => session.id === recipient ? { ...session, status: { state: 'working', source: 'native-hook', observedAt: now }, semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now - 20000 } } : session) } : {}) })) },
  theme(mode) { useAppStore.setState(state => ({ config: { ...state.config, appearance: { ...state.config.appearance, appAppearance: mode } } })) },
  state() { const state = useAppStore.getState(), node = document.querySelector('.recent-focus'); return { activeWorkspaceId: state.activeWorkspaceId, focus: state.agentFocus, selection: state.workbenchSpaceSelection, calls: { ...calls }, drafts: state.agentComposerDrafts,
    nameWidth: state.focusTimelineNameWidth, sameDrafts: state.agentComposerDrafts === initial?.agentComposerDrafts, sameRuns: sessions.every(session => state.sessions.find(item => item.id === session.id)?.control.run === session.control.run),
    scope: node ? JSON.parse(node.dataset.focusProjectScope) : null, projects: [...document.querySelectorAll('[data-timeline-project]')].filter(node => !node.hidden).map(node => node.dataset.timelineProject),
    markers: [...document.querySelectorAll('.recent-focus__message')].map(node => ({ id: node.dataset.messageId, count: node.dataset.recordCount })), events: [...inputEvents], mounts: window.presentationLeaves } }
}
createRoot(document.getElementById('root')).render(createElement(App))
