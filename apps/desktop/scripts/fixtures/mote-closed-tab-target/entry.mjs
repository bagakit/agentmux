import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

const phase = new URLSearchParams(location.search).get('phase')
window.closedTabSetup.phase = 'controlled-public-data'
const publicConfig = await api.config.get()
const prototype = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')
if (!prototype) throw new Error('A nonempty typed Session prototype is required')
const project = { id: 'private-project', hostId: 'local', path: '/private/closed-tab/project', name: 'Original project', kind: 'folder' }
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/closed-tab/topics', name: 'Topics', kind: 'folder' }
const customId = 'launcher:reviewer', targetId = 'mote-primary-tab', neighborId = 'mote-neighbor-tab', customTabId = 'custom-mote-tab'
const floatingKey = 'agentmux.leader-topic-floating.v1', durableKey = 'agentmux-workbench-v1'
const calls = [], recovered = new Set(), initialDurable = JSON.parse(localStorage.getItem(durableKey) ?? 'null')
const initialFloating = JSON.parse(localStorage.getItem(floatingKey) ?? 'null')
const sessions = [ ['project-worker', null], ['project-reader', null], ['mote-primary', PMO_TEAMS_TOPIC_ID],
  ['mote-neighbor', PMO_TEAMS_TOPIC_ID], ['custom-mote', customId] ].map(([id, topicId]) => ({
  ...prototype, id, hostId: 'local', label: topicId ? 'Agent · Mote' : 'Agent · Project',
  workspacePath: topicId ? scratch.path + '/' + scratchTopicDirectoryName(topicId) : project.path,
  processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run-' + id } }
}))
const topic = (id, title) => {
  const directoryPath = scratch.path + '/' + scratchTopicDirectoryName(id)
  return { id, title, directoryPath, topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
    soul: { path: directoryPath + '/SOUL.md', content: '# Coordinate this original Topic', version: 'private-original-v1' } }
}
const topics = [topic(PMO_TEAMS_TOPIC_ID, 'Mote'), topic(customId, 'Review the next step')]
api.config.get = async () => structuredClone({ ...publicConfig, hosts: publicConfig.hosts.filter(host => host.id === 'local'), workspaces: [project, scratch] })
api.demands.list = async () => []
api.scratch.listTopics = async () => structuredClone(topics)
api.scratch.ensureMote = async (_workspace, id) => {
  calls.push({ operation: 'ensureMote', topicId: id })
  const found = topics.find(one => one.id === id)
  if (!found) throw new Error('Unknown private Mote')
  return structuredClone(found)
}
api.scratch.readTopic = async (_workspace, id) => structuredClone(topics.find(one => one.id === id) ?? null)
api.sessions.snapshot = async () => ({ sessions: structuredClone(sessions).map(one => phase === 'restore' &&
  ['mote-neighbor', 'project-worker'].includes(one.id) && !recovered.has(one.id) ? {
    ...one, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: Date.now() },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() }
  } : one), timelines: {}, recoveryCandidates: [] })
api.sessions.onEvent = () => () => {}
const sessionFor = control => sessions.find(one => one.id === control.agentSessionId && one.control.run.runId === control.run.runId)
api.sessions.recover = async control => {
  const session = sessionFor(control)
  if (!session) throw new Error('Only the original private Session/Run may recover')
  calls.push({ operation: 'recover', sessionId: session.id, runId: control.run.runId })
  recovered.add(session.id)
  return { kind: 'reattachable', session }
}
api.sessions.attach = async control => {
  const session = sessionFor(control)
  if (!session) throw new Error('Only the original private Session/Run may attach')
  calls.push({ operation: 'attach', sessionId: session.id, runId: control.run.runId })
  const data = 'Original output · ' + session.id + '\r\nThe original work surface and draft remain.\r\n'
  const dataBytes = new TextEncoder().encode(data)
  return { attachmentId: 'original-attachment-' + session.id, session, currentSize: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: control.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }], gap: null }
}
api.sessions.refreshAttachment = async control => api.sessions.attach(control)
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.refresh = async control => sessionFor(control)
for (const operation of ['stop', 'launchAgent', 'launchTerminal', 'write', 'submitPrompt']) api.sessions[operation] = async () => {
  calls.push({ operation }); throw new Error('This close/restart proof must never ' + operation)
}
// This is the real ordinary initialize, including durable read, recovery and layout hydration.
// Seed runs once only after it; restore receives no manual layout/selection seed.
window.closedTabSetup.phase = 'ordinary-initialize'
let initializeCalls = 0
initializeCalls += 1
const dispose = await useAppStore.getState().initialize()
const afterOrdinaryInitialize = { tabIds: Object.keys(useAppStore.getState().tabs), focus: structuredClone(useAppStore.getState().agentFocus) }
if (phase === 'seed') {
  const projectTab = createWorkbenchTab('original-project-tab', { regionId: 'original-worker-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-worker' })
  projectTab.layout = splitWorkbenchRegion(projectTab.layout, 'original-worker-region', 'right', 'original-reader-region')
  projectTab.layout.root.ratio = 0.63
  projectTab.regions['original-reader-region'] = { regionId: 'original-reader-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-reader' }
  const agentTab = (id, regionId, sessionId, topicId, name) => ({ ...createWorkbenchTab(id, { regionId, workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId }, name), topicId })
  const primary = agentTab(targetId, 'mote-primary-region', 'mote-primary', PMO_TEAMS_TOPIC_ID, 'Review the current goal')
  const neighbor = agentTab(neighborId, 'mote-neighbor-region', 'mote-neighbor', PMO_TEAMS_TOPIC_ID, 'Continue the original plan')
  const custom = agentTab(customTabId, 'custom-mote-region', 'custom-mote', customId, 'Review the next step')
  useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: project.id, projectRailOpen: false, toolsOpen: false,
    tabs: Object.fromEntries([projectTab, primary, neighbor, custom].map(tab => [tab.id, tab])),
    layouts: { [project.id]: createWorkspaceLayout('original-project-group', [projectTab.id]),
      [scratch.id]: createWorkspaceLayout('original-mote-group', [targetId, neighborId, customTabId]) },
    agentFocus: { execution: { sessionId: 'project-worker', history: [{ sessionId: 'project-worker', focusedAt: 1000 }] }, pmo: { sessionId: 'mote-primary' } },
    viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])) })
  for (const session of sessions) useAppStore.getState().setAgentComposerDraft(session.id, 'Original unsent draft · ' + session.id)
  localStorage.setItem(floatingKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId }))
}
// App owns its ordinary tree. Its second mount hook uses the existing initialized owner.
useAppStore.setState({ initialize: async () => () => {} })
const facts = () => {
  const current = useAppStore.getState(), persisted = projectPersistedWorkbench(current)
  const tabs = Object.fromEntries(Object.entries(persisted.tabs).map(([id, tab]) => [id, { ...tab,
    regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => {
      const { phase: _phase, ...durable } = surface; return [regionId, durable]
    })) }]))
  const panel = document.getElementById('pmo-teams-topic-floating-panel')
  return { tabs, layouts: persisted.layouts, focus: current.agentFocus, drafts: current.agentComposerDrafts,
    outbox: current.agentSteerQueues, viewModes: current.viewModes, activeWorkspaceId: current.activeWorkspaceId,
    mainSurface: current.mainSurface, selection: current.workbenchSpaceSelection, calls: [...calls],
    runs: current.sessions.map(session => session.control), floating: JSON.parse(localStorage.getItem(floatingKey) ?? 'null'),
    ui: { target: panel?.dataset.moteTargetTab ?? null, topic: panel?.dataset.moteTargetTopic,
      visible: panel?.matches(':popover-open'), text: panel?.textContent,
      newTab: !!panel?.querySelector('[aria-label="New Tab"]') },
    initialization: { initializeCalls, seedApplied: phase === 'seed', initialDurable, initialFloating, afterOrdinaryInitialize } }
}
const root = createRoot(document.getElementById('root'))
window.closedTabProof = { ready: false, facts, ids: { targetId, neighborId, customId, customTabId },
  showGoals: () => useAppStore.getState().setMainSurface('board'),
  showUnknown: () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: 'saved-unavailable-tab' }),
  dispose: () => { root.unmount(); dispose(); window.closedTabProof.ready = false } }
window.closedTabSetup.phase = 'render-production-app'
root.render(createElement(App))
window.closedTabProof.ready = true
