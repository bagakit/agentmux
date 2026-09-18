import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { focusExecution } from '../../../src/renderer/src/lib/agent-focus'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'
window.terminals = []
const request = window.topicTerminalBoundary.request
const setup = await request('setup')
const workspace = setup.config.workspaces[0]
const floatingStorageKey = 'agentmux.leader-topic-floating.v1'
if (setup.phase === 'seed') window.localStorage.setItem(floatingStorageKey, JSON.stringify({
  open: true, targetTabId: 'mote-tab', maximized: false,
  position: { left: 80, top: 72 }, size: { width: 720, height: 520 }
}))
window.topicTerminalSavedFloating = () => JSON.parse(window.localStorage.getItem(floatingStorageKey) ?? 'null')
window.topicTerminalFloatingAtStartup = window.topicTerminalSavedFloating()
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.sessions.snapshot = async () => request('snapshot')
api.sessions.launchTerminal = async input => request('launch', input)
api.sessions.attach = async (control, afterByte) => request('attach', control, afterByte)
api.sessions.detach = async id => request('detach', id)
api.sessions.replay = async (id, afterByte) => request('replay', id, afterByte)
api.sessions.resize = async (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = async (control, data) => request('write', control, data)
api.sessions.stop = async control => request('stop', control)
api.sessions.refresh = async control => request('refresh', control)
window.topicEventCounts = { raw: {}, delivered: {}, tracking: false }
const onEvent = createRendererSessionEvents(listener => window.topicTerminalBoundary.onEvent(event => {
  if (window.topicEventCounts.tracking && event.event.type === 'terminal-output') {
    const id = event.event.run.runId; window.topicEventCounts.raw[id] = (window.topicEventCounts.raw[id] ?? 0) + 1
  }
  listener(event)
}))
api.sessions.onEvent = (listener, control) => onEvent(event => {
  if (window.topicEventCounts.tracking && event.event.type === 'terminal-output') {
    const id = event.event.run.runId; window.topicEventCounts.delivered[id] = (window.topicEventCounts.delivered[id] ?? 0) + 1
  }
  listener(event)
}, control)
api.ui.requestStorageFlush = async () => request('flush')
api.scratch.readTopic = async (id, topic) => request('topic', id, topic)
api.scratch.listTopics = async id => request('topics', id)
api.scratch.ensureTopic = async (id, topic) => request('ensure-topic', id, topic)
api.scratch.ensureMote = async (id, topic) => request('ensure-mote', id, topic)
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
// A saved floating target refers to a durable workface that already exists before App mounts.
// Seed that existing Mote Run once, then let the real main launcher prewarm and ordinary Topic
// open claim its own Run through production store owners.
let seededMote
if (setup.phase === 'seed') {
  await api.scratch.ensureMote(workspace.id, PMO_TEAMS_TOPIC_ID)
  const session = await api.sessions.launchTerminal({ hostId: 'local', workspacePath: workspace.path })
  const launcher = { ...createWorkbenchTab('mote-launcher-tab', { regionId: 'mote-launcher-region', kind: 'launcher', workspaceId: workspace.id }), topicId: PMO_TEAMS_TOPIC_ID }
  const tab = { ...createWorkbenchTab('mote-tab', { regionId: 'mote-region', kind: 'terminal', phase: 'attached', workspaceId: workspace.id, sessionId: session.id }), topicId: PMO_TEAMS_TOPIC_ID }
  const layout = createWorkspaceLayout('original-group', [launcher.id, tab.id])
  layout.groups[0].activeTabId = null
  layout.groups[0].recentTabIds = []
  seededMote = { session, launcher, tab }
  const { name, version } = useAppStore.persist.getOptions()
  window.localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [launcher.id]: launcher, [tab.id]: tab }, layouts: { [workspace.id]: layout } }),
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false
  } }))
}
const initialize = useAppStore.getState().initialize
useAppStore.setState({ initialize: async () => {
  const dispose = await initialize()
  if (setup.phase === 'seed') {
    await api.scratch.ensureTopic(workspace.id, 'launcher:ordinary')
    await Promise.all([useAppStore.getState().openScratchTopic('launcher:ordinary'), useAppStore.getState().openScratchTopic('launcher:ordinary')])
    const ordinary = Object.values(useAppStore.getState().tabs).find(tab => tab.topicId === 'launcher:ordinary')
    if (!ordinary || Object.values(ordinary.regions).length !== 1) throw new Error('One default Topic Region required')
    window.topicDefault = { tabId: ordinary.id, regionId: ordinary.layout.activeRegionId,
      sessionId: ordinary.regions[ordinary.layout.activeRegionId].sessionId }
    const second = await api.sessions.launchTerminal({ hostId: 'local', workspacePath: workspace.path })
    const split = { ...ordinary, layout: splitWorkbenchRegion(ordinary.layout, ordinary.layout.activeRegionId, 'right', 'secondary-region'),
      regions: { ...ordinary.regions, 'secondary-region': { regionId: 'secondary-region', kind: 'terminal', phase: 'attached', workspaceId: workspace.id, sessionId: second.id } } }
    split.layout.root.ratio = 0.61
    const { session: moteSession, launcher: moteLauncher, tab: mote } = seededMote
    const closeSession = await api.sessions.launchTerminal({ hostId: 'local', workspacePath: workspace.path })
    const close = { ...createWorkbenchTab('close-tab', { regionId: 'close-region', kind: 'terminal', phase: 'attached', workspaceId: workspace.id, sessionId: closeSession.id }), topicId: 'launcher:ordinary' }
    const layout = createWorkspaceLayout('original-group', [ordinary.id, moteLauncher.id, mote.id, close.id])
    layout.groups[0].activeTabId = ordinary.id
    useAppStore.setState({ sessions: [await request('resolve', window.topicDefault.sessionId), second, moteSession, closeSession],
      tabs: { [split.id]: split, [moteLauncher.id]: moteLauncher, [mote.id]: mote, [close.id]: close }, layouts: { [workspace.id]: layout },
      agentFocus: focusExecution(useAppStore.getState().agentFocus, window.topicDefault.sessionId),
      activeWorkspaceId: workspace.id, mainSurface: 'workbench', agentComposerDrafts: { 'untouched-draft': 'An unsent draft remains' }, toolsOpen: false, projectRailOpen: false })
    await request('save-ids', { ...window.topicDefault, moteId: moteSession.id, secondId: second.id, closeId: closeSession.id })
  }
  window.topicTerminalReady = true
  return dispose
} })
window.topicTerminalState = () => {
  const state = useAppStore.getState()
  const workbench = projectPersistedWorkbench(state)
  return { tabs: workbench.tabs, layouts: workbench.layouts, focus: state.agentFocus, drafts: state.agentComposerDrafts,
    sessions: state.sessions.map(session => ({ id: session.id, state: session.processState, run: session.control.run })),
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, error: state.error }
}
window.topicTerminalUi = () => ({
  regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId).sort(),
  terminals: window.terminals.filter(terminal => terminal.element?.isConnected).map(terminal => ({ regionId: terminal.element.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId,
    visible: (() => { const rect = terminal.element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.x < innerWidth && rect.y < innerHeight && getComputedStyle(terminal.element).visibility !== 'hidden' })(),
    baseY: terminal.buffer.active.baseY, viewportY: terminal.buffer.active.viewportY, rows: terminal.rows,
    point: (() => { const rect = terminal.element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })() })),
  sessionPanes: document.querySelectorAll('.agent-surface').length,
  close: [...document.querySelectorAll('.workbench-tab__close,.workbench-region__close')].map(button => ({ label: button.getAttribute('aria-label'), opacity: getComputedStyle(button).opacity })),
  floating: {
    open: document.querySelector('[data-pmo-teams-topic-floating]')?.getAttribute('aria-hidden') === 'false',
    saved: window.topicTerminalSavedFloating(),
    activeTabIds: [...document.querySelectorAll('[data-pmo-teams-topic-floating] .workbench-tab--active')].map(button => button.dataset.workbenchTabId)
  }
})
window.topicTerminalOpenFloat = () => requestPmoTeamsTopicFloatingOpen({ targetTabId: 'mote-tab' })
window.topicTerminalCloseFloat = () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
window.topicTerminalBoard = () => useAppStore.getState().setMainSurface('board')
window.topicTerminalWorkbench = () => useAppStore.getState().setMainSurface('workbench')
window.topicTerminalRestoreWorkspace = () => useAppStore.setState({ activeWorkspaceId: workspace.id, mainSurface: "workbench" })
window.topicTerminalNoWorkspace = () => useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: null })
createRoot(document.getElementById('root')).render(createElement(App))
