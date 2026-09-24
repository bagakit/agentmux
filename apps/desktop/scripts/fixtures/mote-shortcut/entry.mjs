import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

// Only the public Session/data boundary is controlled. App, persistence, target resolution,
// entry, floating workbench, existing View ownership and input components are production code.
const phase = new URLSearchParams(location.search).get('phase')
window.moteSetup.phase = 'read-public-preview-data'
const initialConfig = await api.config.get()
const prototype = (await api.sessions.snapshot()).sessions.find(one => one.kind === 'agent')
if (!prototype) throw new Error('A nonempty typed preview Agent is required')
const project = { id: 'private-project', hostId: 'local', path: '/private/mote-proof/project', name: 'Recovery', kind: 'folder' }
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/mote-proof/topics', name: 'Topics', kind: 'folder' }
const config = { ...initialConfig, hosts: initialConfig.hosts.filter(one => one.id === 'local'), workspaces: [project, scratch] }
const targetId = 'mote-primary-tab', neighborId = 'mote-neighbor-tab'
const title = 'Keep the same workspace and Agent when I return'
const longTitle = 'Keep the original workspace, every Agent, all tabs and split regions, and every unsent message when I return after a process restart'
const calls = []
const sessions = ['project-worker', 'project-reader', 'mote-primary', 'mote-neighbor'].map((id, index) => ({
  ...prototype, id, hostId: 'local', label: index < 2 ? `Agent · Recovery ${index + 1}` : 'Agent · Mote',
  workspacePath: index < 2 ? project.path : `${scratch.path}/topic--launcher--leader`,
  processState: 'running', status: { state: index === 3 ? 'waiting' : 'working', source: 'native-hook', observedAt: Date.now() },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `original-run-${id}` } }
}))
const item = (id, kind, content) => ({ id, agentSessionId: 'mote-primary', kind, content, title: content, status: 'complete', source: 'native-hook', createdAt: 1000, updatedAt: 1000 })
const timelines = Object.fromEntries(sessions.map(one => [one.id, { agentSessionId: one.id, revision: 1, items: one.id === 'mote-primary' ? [
  item('request', 'user_message', 'Help me keep the same work after I restart.'),
  item('reply', 'assistant_message', 'I am checking the original workspace and Agent. Your current tabs, split layout and unsent draft stay in place while we clarify the next step.')
] : [] }]))
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: 'Coordinate and clarify work', directoryPath: 'topic--launcher--leader', topicPath: 'topic--launcher--leader/topic.md', collaborators: [] }
// This private key models the controlled external Goal store, whose title is the
// production owner of Goal Tab names; it is not another product persistence path.
const goalTitleKey = 'private-mote-proof-goal-title'
const goal = { id: 'private-goal', title: localStorage.getItem(goalTitleKey) ?? title, description: 'Return to the same work after restarting the application.', status: 'in_progress', priority: 'normal', projectId: project.id, projectName: project.name, executorId: null, plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, sessionIds: [], tags: [], activities: [], decisions: [], createdAt: 1000, updatedAt: 1000 }
api.config.get = async () => structuredClone(config)
api.demands.list = async () => [goal]
api.scratch.listTopics = async () => [topic]
api.scratch.ensureTopic = async () => topic
api.scratch.readTopic = async () => topic
let originalContextReattached = phase !== 'restore'
api.sessions.snapshot = async () => ({ sessions: structuredClone(sessions).map(one => !originalContextReattached && one.id === 'mote-primary'
  ? { ...one, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: Date.now() },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() } }
  : one), timelines: structuredClone(timelines), recoveryCandidates: [] })
api.sessions.onEvent = () => () => {}
api.sessions.attach = async control => {
  const session = sessions.find(one => one.id === control.agentSessionId)
  if (!session || session.control.run.runId !== control.run.runId) throw new Error('Only the original private Run may attach')
  calls.push({ operation: 'attach', sessionId: session.id, runId: control.run.runId })
  const data = `Original terminal output for ${session.id}\r\nThe workspace and Run remain the same.\r\n`
  const dataBytes = new TextEncoder().encode(data)
  return { attachmentId: `attachment-${session.id}`, session, currentSize: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: control.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }], gap: null }
}
api.sessions.refreshAttachment = async control => api.sessions.attach(control)
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.refresh = async control => sessions.find(one => one.id === control.agentSessionId)
api.sessions.recover = async control => {
  calls.push({ operation: 'recover', sessionId: control.agentSessionId, runId: control.run.runId })
  const session = sessions.find(one => one.id === control.agentSessionId)
  if (!session) throw new Error('No private Session to recover')
  if (session.id === 'mote-primary') originalContextReattached = true
  return { kind: 'reattachable', session }
}
for (const operation of ['launchAgent', 'launchTerminal', 'stop', 'write', 'submitPrompt']) api.sessions[operation] = async () => {
  calls.push({ operation }); throw new Error(`Shortcut proof must never ${operation}`)
}
window.moteSetup.phase = 'ordinary-initialize'
const dispose = await useAppStore.getState().initialize()
window.moteSetup.phase = 'render-production-app'
if (phase === 'seed') {
  const worker = createWorkbenchTab('original-project-tab', { regionId: 'original-worker-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-worker' })
  worker.layout = splitWorkbenchRegion(worker.layout, 'original-worker-region', 'right', 'original-reader-region')
  worker.layout.root.ratio = 0.63
  worker.regions['original-reader-region'] = { regionId: 'original-reader-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-reader' }
  const primary = { ...createWorkbenchTab(targetId, { regionId: 'mote-primary-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'mote-primary' }), topicId: PMO_TEAMS_TOPIC_ID, name: title }
  const neighbor = { ...createWorkbenchTab(neighborId, { regionId: 'mote-neighbor-region', workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId: 'mote-neighbor' }), topicId: PMO_TEAMS_TOPIC_ID, name: 'Another goal waiting for permission' }
  const moteLayout = createWorkspaceLayout('original-mote-group', [neighborId, targetId])
  moteLayout.groups[0].activeTabId = neighborId
  useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: project.id, projectRailOpen: false, toolsOpen: false,
    tabs: { [worker.id]: worker, [primary.id]: primary, [neighbor.id]: neighbor },
    layouts: { [project.id]: createWorkspaceLayout('original-project-group', [worker.id]), [scratch.id]: moteLayout },
    agentFocus: { execution: { sessionId: 'project-worker', history: [{ sessionId: 'project-worker', focusedAt: 1000 }] }, pmo: { sessionId: 'mote-primary' } },
    demandPmoTabIds: { [goal.id]: targetId }, agentNames: { 'mote-primary': 'Coordinator', 'mote-neighbor': 'Permission review' } })
  useAppStore.getState().setAgentComposerDraft('project-worker', 'Original project draft stays unsent')
  useAppStore.getState().setAgentComposerDraft('mote-primary', 'Keep my original Mote draft')
}
// The ordinary initializer above is the one restart entry; mounting App must not initialize twice.
useAppStore.setState({ initialize: async () => () => {} })
function facts() {
  const current = useAppStore.getState(), workbench = projectPersistedWorkbench(current)
  const tabs = Object.fromEntries(Object.entries(workbench.tabs).map(([id, tab]) => [id, { ...tab,
    regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => { const { phase: _phase, ...durable } = surface; return [id, durable] })) }]))
  const entry = document.querySelector('[data-pmo-teams-topic-launcher] button')
  const panel = document.getElementById('pmo-teams-topic-floating-panel')
  return { tabs, layouts: workbench.layouts, activeWorkspaceId: current.activeWorkspaceId, mainSurface: current.mainSurface,
    focus: current.agentFocus, drafts: current.agentComposerDrafts, runs: current.sessions.map(one => one.control), calls,
    floating: JSON.parse(localStorage.getItem('agentmux.leader-topic-floating.v1') ?? 'null'),
    ui: { entryTitle: entry?.title, expanded: entry?.getAttribute('aria-expanded'), description: entry?.getAttribute('aria-describedby'),
      entryTarget: entry?.closest('[data-mote-target-tab]')?.getAttribute('data-mote-target-tab'),
      panelTarget: panel?.getAttribute('data-mote-target-tab'),
      panelVisible: panel?.getAttribute('aria-hidden') === 'false', title: panel?.querySelector('.pmo-teams-topic-floating__titlebar')?.textContent,
      panelText: panel?.textContent, globalChrome: panel?.querySelectorAll('.top-row-leading-chrome').length,
      footerHeight: document.querySelector('.window-status-bar')?.getBoundingClientRect().height,
      regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(one => one.dataset.workbenchRegionId),
      actions: [...(panel?.querySelectorAll('.pmo-teams-topic-floating__actions button') ?? [])].map(one => { const r = one.getBoundingClientRect(); return { label: one.getAttribute('aria-label'), width: r.width, height: r.height, right: r.right, bottom: r.bottom } }) } }
}
window.moteProof = { ready: false, targetId, title, longTitle, facts,
  background: () => useAppStore.getState().focusPmoSession('mote-neighbor'),
  longName: () => {
    goal.title = longTitle
    localStorage.setItem(goalTitleKey, longTitle)
    useAppStore.setState(state => ({ demands: { ...state.demands, [goal.id]: { ...state.demands[goal.id], title: longTitle } }, tabs: { ...state.tabs, [targetId]: { ...state.tabs[targetId], name: longTitle } } }))
  },
  status: state => useAppStore.setState(current => ({ sessions: current.sessions.map(one => one.id === 'mote-primary' ? { ...one, status: { ...one.status, state, observedAt: Date.now() } } : one) })),
  pending: () => useAppStore.setState(current => ({ sessions: current.sessions.filter(one => one.id !== 'mote-primary') })),
  restoreFacts: () => useAppStore.setState({ sessions: structuredClone(sessions) }),
  dispose }
createRoot(document.getElementById('root')).render(createElement(App))
window.moteProof.ready = true
