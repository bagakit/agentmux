import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

// Only the api.ts export is privately transformed. Every product desktop branch,
// App, View owner, input component and persistence path remains production code.
const phase = new URLSearchParams(location.search).get('phase')
window.moteSetup.phase = 'read-public-fixture-data'
if (!window.moteNative) throw new Error('The isolated native preload is required')
Object.assign(api.browser, window.moteNative.browser)
Object.assign(api.ui, window.moteNative.ui)
const initialConfig = await api.config.get()
const prototype = (await api.sessions.snapshot()).sessions.find(one => one.kind === 'agent')
if (!prototype) throw new Error('A nonempty typed preview Agent is required')
const project = { id: 'private-project', hostId: 'local', path: '/private/mote-proof/project', name: 'Recovery', kind: 'folder' }
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/mote-proof/topics', name: 'Topics', kind: 'folder' }
const config = { ...initialConfig, hosts: initialConfig.hosts.filter(one => one.id === 'local'), workspaces: [project, scratch] }
// Build one typed terminal result through the private mock's maintained public
// factory. It is controlled data, never a Core/ctxmux process or real shell.
const warmPrototype = await api.sessions.launchTerminal({ hostId: 'local', workspacePath: scratch.path })
const warmId = 'private-controlled-warm-terminal'
const controlledWarm = { ...warmPrototype, id: warmId,
  control: { kind: 'terminal', hostId: 'local', runId: warmId, run: { runId: warmId } } }
const customId = 'launcher:custom-coordinator', quietId = 'launcher:custom-research', ordinaryId = 'launcher:ordinary-notes'
const targetId = 'mote-primary-tab', neighborId = 'mote-neighbor-tab', customTabId = 'custom-mote-tab'
const title = 'Keep the same workspace and Agent when I return'
const longTitle = 'Keep the original workspace, every Agent, all tabs and split regions, and every unsent message when I return after a process restart'
const customName = 'Planning and reviewing the next meaningful step'
const calls = [], resizes = []
let directoryFailure = false, directoryReads = 0
const sessions = [
  ['project-worker', null, 'working'], ['project-reader', null, 'working'],
  ['mote-primary', PMO_TEAMS_TOPIC_ID, 'working'], ['mote-neighbor', PMO_TEAMS_TOPIC_ID, 'waiting'],
  ['custom-mote', customId, 'idle'], ['ordinary-agent', ordinaryId, 'idle']
].map(([id, topicId, state]) => ({
  ...prototype, id, hostId: 'local', label: topicId ? 'Agent · Topic' : 'Agent · Recovery',
  workspacePath: topicId ? scratch.path + '/' + scratchTopicDirectoryName(topicId) : project.path,
  processState: 'running', status: { state, source: 'native-hook', observedAt: Date.now() },
  semanticStatus: { state, source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run-' + id } }
}))
const item = (sessionId, id, kind, content) => ({ id, agentSessionId: sessionId, kind, content, title: content, status: 'complete', source: 'native-hook', createdAt: 1000, updatedAt: 1000 })
const timelines = Object.fromEntries(sessions.map(one => [one.id, { agentSessionId: one.id, revision: 1, items: ['mote-primary', 'custom-mote'].includes(one.id) ? [
  item(one.id, 'request', 'user_message', 'Help me keep the same work after I restart.'),
  item(one.id, 'reply', 'assistant_message', 'I am checking the original workspace and Agent. Your current tabs, split layout and unsent draft stay in place while we clarify the next step.')
] : [] }]))
const topicFor = (id, title, mote = false) => {
  const directoryPath = scratchTopicDirectoryName(id)
  return { id, title, summary: 'Private controlled topic content', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
    ...(mote ? { soul: { path: directoryPath + '/SOUL.md', content: '# SOUL\nCoordinate this topic.', version: 'private-source-v1' } } : {}) }
}
const topics = [topicFor(PMO_TEAMS_TOPIC_ID, 'Mote'), topicFor(customId, customName, true), topicFor(quietId, 'Research and evidence', true), topicFor(ordinaryId, 'Ordinary notes')]
const topicById = id => topics.find(one => one.id === id)
// Controlled external Goal content is not another product UI owner.
const goalTitleKey = 'private-mote-proof-goal-title'
const goal = { id: 'private-goal', title: localStorage.getItem(goalTitleKey) ?? title, description: 'Return to the same work after restarting the application.', status: 'in_progress', priority: 'normal', projectId: project.id, projectName: project.name, executorId: null, plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, sessionIds: [], tags: [], activities: [], decisions: [], createdAt: 1000, updatedAt: 1000 }
api.config.get = async () => structuredClone(config)
api.demands.list = async () => [goal]
api.scratch.listTopics = async () => {
  directoryReads += 1
  if (directoryFailure) throw new Error('The private Topic directory could not be read')
  return structuredClone(topics)
}
api.scratch.ensureTopic = async (_workspaceId, id) => {
  calls.push({ operation: 'ensureTopic', topicId: id })
  const topic = topicById(id)
  if (!topic) throw new Error('Unknown private topic: ' + id)
  return structuredClone(topic)
}
api.scratch.ensureMote = async (_workspaceId, id) => {
  calls.push({ operation: 'ensureMote', topicId: id })
  const topic = topicById(id)
  if (!topic || id === ordinaryId) throw new Error('Only an existing private Mote may prepare')
  return structuredClone(topic)
}
api.scratch.readTopic = async (_workspaceId, id) => structuredClone(topicById(id) ?? null)
let originalContextReattached = phase !== 'restore'
api.sessions.snapshot = async () => ({ sessions: structuredClone(sessions).map(one => !originalContextReattached && one.id === 'custom-mote'
  ? { ...one, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: Date.now() }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() } }
  : one), timelines: structuredClone(timelines), recoveryCandidates: [] })
api.sessions.onEvent = () => () => {}
const sessionForControl = control => control.kind === 'terminal' && control.runId === warmId
  ? controlledWarm : sessions.find(one => one.id === control.agentSessionId)
api.sessions.attach = async control => {
  const session = sessionForControl(control)
  if (!session || session.control.run.runId !== control.run.runId) throw new Error('Only the original private Run may attach')
  calls.push({ operation: 'attach', sessionId: session.id, runId: control.run.runId })
  const data = session.id === warmId ? 'Controlled terminal snapshot. No actual shell is running.\r\n' :
    'Original terminal output for ' + session.id + '\r\nThe workspace and Run remain the same.\r\n'
  const dataBytes = new TextEncoder().encode(data)
  return { attachmentId: 'attachment-' + session.id, session, currentSize: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: control.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }], gap: null }
}
api.sessions.refreshAttachment = async control => api.sessions.attach(control)
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (attachment, cols, rows) => { resizes.push({ attachment, cols, rows }); return { cols, rows } }
api.sessions.refresh = async control => sessionForControl(control)
api.sessions.recover = async control => {
  calls.push({ operation: 'recover', sessionId: control.agentSessionId, runId: control.run.runId })
  const session = sessions.find(one => one.id === control.agentSessionId)
  if (!session) throw new Error('No private Session to recover')
  if (session.id === 'custom-mote') originalContextReattached = true
  return { kind: 'reattachable', session }
}
// Pinning a real empty launcher may invoke its existing warm-shell owner. Keep
// the exact call/presentation and supply the typed controlled terminal result;
// any invocation during hover remains an assertion failure.
api.sessions.launchTerminal = async input => {
  calls.push({ operation: 'launchTerminal', presentation: document.getElementById('pmo-teams-topic-floating-panel')?.dataset.motePresentation, input, controlledResult: 'typed-mock-terminal-no-core-run-created' })
  if (input.hostId !== controlledWarm.hostId || input.workspacePath !== controlledWarm.workspacePath) throw new Error('A warm terminal may not borrow another workspace')
  return structuredClone(controlledWarm)
}
api.sessions.stop = async control => {
  if (control.kind === 'terminal' && control.runId === warmId) { calls.push({ operation: 'disposeControlledWarm', runId: warmId }); return }
  calls.push({ operation: 'stop' }); throw new Error('Shortcut proof must never stop an original Session')
}
for (const operation of ['launchAgent', 'write', 'submitPrompt']) api.sessions[operation] = async () => {
  calls.push({ operation }); throw new Error('Shortcut proof must never ' + operation)
}
window.moteSetup.phase = 'ordinary-initialize'
const dispose = await useAppStore.getState().initialize()
window.moteSetup.phase = 'seed-original-workface'
const fixtureBrowser = async (id, label, workspaceId) => {
  const url = new URL(window.moteNative.fixturePageUrl)
  url.searchParams.set('owner', id); url.searchParams.set('label', label)
  return api.browser.create(id, url.href, workspaceId)
}
if (phase === 'seed') {
  const worker = createWorkbenchTab('original-project-tab', { regionId: 'original-worker-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-worker' })
  worker.layout = splitWorkbenchRegion(worker.layout, 'original-worker-region', 'right', 'original-reader-region')
  worker.layout.root.ratio = 0.63
  worker.regions['original-reader-region'] = { regionId: 'original-reader-region', workspaceId: project.id, kind: 'agent', phase: 'attached', sessionId: 'project-reader' }
  const agentTab = (id, regionId, sessionId, topicId, name) => ({ ...createWorkbenchTab(id, { regionId, workspaceId: scratch.id, kind: 'agent', phase: 'attached', sessionId }), topicId, name })
  const primary = agentTab(targetId, 'mote-primary-region', 'mote-primary', PMO_TEAMS_TOPIC_ID, title)
  const neighbor = agentTab(neighborId, 'mote-neighbor-region', 'mote-neighbor', PMO_TEAMS_TOPIC_ID, 'Another goal waiting for permission')
  const custom = agentTab(customTabId, 'custom-mote-region', 'custom-mote', customId, 'Review the next step')
  const ordinary = agentTab('ordinary-topic-tab', 'ordinary-topic-region', 'ordinary-agent', ordinaryId, 'Ordinary execution notes')
  const quiet = { ...createWorkbenchTab('quiet-mote-tab', { regionId: 'quiet-mote-region', workspaceId: scratch.id, kind: 'launcher' }), topicId: quietId, name: 'Research and evidence' }
  const browserTab = (id, regionId, browser, workspaceId, topicId) => ({ ...createWorkbenchTab(id, { ...browser, regionId, workspaceId, kind: 'browser', browserId: browser.id }), ...(topicId ? { topicId } : {}) })
  const backdrop = browserTab('project-browser-tab', 'project-browser-region', await fixtureBrowser('private-browser-behind', 'Original Browser behind Mote', project.id), project.id)
  const inside = browserTab('custom-browser-tab', 'custom-browser-region', await fixtureBrowser('private-browser-inside', 'Browser inside the selected Mote', scratch.id), scratch.id, customId)
  const moteLayout = createWorkspaceLayout('original-mote-group', [neighborId, targetId, customTabId, inside.id, quiet.id, ordinary.id])
  moteLayout.groups[0].activeTabId = neighborId
  const allTabs = [worker, backdrop, primary, neighbor, custom, inside, quiet, ordinary]
  useAppStore.setState({ mainSurface: 'board', activeWorkspaceId: project.id, projectRailOpen: false, toolsOpen: false,
    tabs: Object.fromEntries(allTabs.map(one => [one.id, one])),
    layouts: { [project.id]: createWorkspaceLayout('original-project-group', [worker.id, backdrop.id]), [scratch.id]: moteLayout },
    agentFocus: { execution: { sessionId: 'project-worker', history: [{ sessionId: 'project-worker', focusedAt: 1000 }] }, pmo: { sessionId: 'mote-primary' } },
    viewModes: { 'project-worker': 'activity', 'project-reader': 'terminal' },
    demandPmoTabIds: { [goal.id]: targetId }, agentNames: { 'mote-primary': 'Coordinator', 'mote-neighbor': 'Permission review', 'custom-mote': 'Planning coordinator' } })
  useAppStore.getState().setAgentComposerDraft('project-worker', 'Original project draft stays unsent')
  useAppStore.getState().setAgentComposerDraft('mote-primary', 'Keep my original Mote draft')
  useAppStore.getState().setAgentComposerDraft('custom-mote', 'Keep the custom Mote draft')
  useAppStore.getState().setAgentComposerDraft('quiet-mote-region', 'Keep the original launcher draft')
  localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: targetId }))
}
// App mounts the production tree; ordinary initialization above runs exactly once.
useAppStore.setState({ initialize: async () => () => {} })
function rect(element) {
  if (!element) return null
  const one = element.getBoundingClientRect()
  return { x: one.x, y: one.y, width: one.width, height: one.height, right: one.right, bottom: one.bottom }
}
function facts() {
  const current = useAppStore.getState(), workbench = projectPersistedWorkbench(current)
  const tabs = Object.fromEntries(Object.entries(workbench.tabs).map(([id, tab]) => [id, { ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => {
    const { phase: _phase, ...durable } = surface; return [id, durable]
  })) }]))
  const entry = document.querySelector('[data-pmo-teams-topic-launcher] button'), panel = document.getElementById('pmo-teams-topic-floating-panel'), active = document.activeElement
  return { tabs, layouts: workbench.layouts, activeWorkspaceId: current.activeWorkspaceId, mainSurface: current.mainSurface,
    focus: current.agentFocus, drafts: current.agentComposerDrafts, viewModes: current.viewModes, outbox: current.agentSteerQueues,
    runs: current.sessions.map(one => one.control), calls: [...calls], resizes: [...resizes], directoryReads,
    floating: JSON.parse(localStorage.getItem('agentmux.leader-topic-floating.v1') ?? 'null'),
    ui: { entryTitle: document.getElementById(entry?.getAttribute('aria-describedby'))?.textContent, expanded: entry?.getAttribute('aria-expanded'), entryRect: rect(entry),
      entryTarget: entry?.closest('[data-mote-target-tab]')?.getAttribute('data-mote-target-tab'),
      panelTarget: panel?.getAttribute('data-mote-target-tab'), panelTopic: panel?.getAttribute('data-mote-target-topic'), panelSession: panel?.getAttribute('data-mote-target-session'), panelStatus: panel?.getAttribute('data-mote-status'),
      panelVisible: !!panel && panel.matches(':popover-open'), panelRect: rect(panel), panelText: panel?.textContent, titleRows: panel?.querySelectorAll('.pmo-teams-topic-floating__titlebar').length,
      globalChrome: panel?.querySelectorAll('.top-row-leading-chrome').length, footerHeight: document.querySelector('.window-status-bar')?.getBoundingClientRect().height,
      activeElement: { tag: active?.tagName, id: active?.id, label: active?.getAttribute('aria-label'), editable: active?.isContentEditable, text: active?.isContentEditable ? active?.textContent : undefined, value: active?.value, start: active?.selectionStart, end: active?.selectionEnd,
        selection: { anchorOffset: window.getSelection()?.anchorOffset, focusOffset: window.getSelection()?.focusOffset, anchorText: window.getSelection()?.anchorNode?.textContent, focusText: window.getSelection()?.focusNode?.textContent } },
      choices: [...(panel?.querySelectorAll('[data-mote-topic-id]') ?? [])].map(one => ({ topicId: one.dataset.moteTopicId, text: one.textContent, selected: one.getAttribute('aria-pressed'), rect: rect(one) })),
      regions: [...document.querySelectorAll('[data-workbench-region-id]')].map(one => one.dataset.workbenchRegionId),
      actions: [...(panel?.querySelectorAll('.mote-chooser__actions button') ?? [])].map(one => ({ label: one.getAttribute('aria-label'), ...rect(one) })) } }
}
const surfaceEvents = []
const recordSurfaceEvent = event => {
  const element = event.target instanceof Element ? event.target : null
  if (!element?.closest('[data-pmo-teams-topic-launcher], [data-pmo-teams-topic-floating]')) return
  if (['pointerenter', 'pointerleave'].includes(event.type) && !element.matches('[data-pmo-teams-topic-floating], [data-pmo-teams-topic-launcher] button')) return
  const panel = document.getElementById('pmo-teams-topic-floating-panel')
  const one = { at: performance.now(), type: event.type, target: element.tagName,
    role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
    trusted: event.isTrusted, key: event.key, composing: event.isComposing,
    newState: event.newState, oldState: event.oldState,
    visible: panel?.matches(':popover-open'), presentation: panel?.dataset.motePresentation,
    saved: JSON.parse(localStorage.getItem('agentmux.leader-topic-floating.v1') ?? 'null') }
  surfaceEvents.push(one)
  if (surfaceEvents.length > 480) surfaceEvents.shift()
}
const surfaceEventTypes = ['pointerenter', 'pointerleave', 'pointerdown', 'pointerup', 'click', 'focusin', 'toggle', 'keydown', 'keyup']
for (const type of surfaceEventTypes) document.addEventListener(type, recordSurfaceEvent, true)
window.moteProof = { ready: false, targetId, customTabId, customId, quietId, ordinaryId, title, longTitle, facts,
  surfaceEvents: () => structuredClone(surfaceEvents),
  background: () => useAppStore.getState().focusPmoSession('mote-neighbor'),
  longName: () => {
    goal.title = longTitle; localStorage.setItem(goalTitleKey, longTitle)
    useAppStore.setState(state => ({ demands: { ...state.demands, [goal.id]: { ...state.demands[goal.id], title: longTitle } }, tabs: { ...state.tabs, [targetId]: { ...state.tabs[targetId], name: longTitle } } }))
  },
  status: state => useAppStore.setState(current => ({ sessions: current.sessions.map(one => one.id === 'mote-primary' ? { ...one, status: { ...one.status, state, observedAt: Date.now() }, semanticStatus: undefined } : one) })),
  pending: () => useAppStore.setState(current => ({ sessions: current.sessions.filter(one => one.id !== 'mote-primary') })),
  restoreFacts: () => useAppStore.setState({ sessions: structuredClone(sessions) }),
  directory: failed => {
    directoryFailure = failed
    useAppStore.setState(current => ({ workspaceFileRevisions: { ...current.workspaceFileRevisions, [scratch.id]: (current.workspaceFileRevisions[scratch.id] ?? 0) + 1 } }))
  },
  showProject: async (tabId = 'original-project-tab') => {
    await useAppStore.getState().selectWorkspace(project.id)
    useAppStore.getState().activateTab(project.id, 'original-project-group', tabId)
  },
  showGoals: () => useAppStore.getState().setMainSurface('board'),
  dispose: () => {
    for (const type of surfaceEventTypes) document.removeEventListener(type, recordSurfaceEvent, true)
    renderRoot.unmount(); dispose(); window.moteProof.ready = false
  } }
window.moteSetup.phase = 'render-production-app'
const renderRoot = createRoot(document.getElementById('root'))
renderRoot.render(createElement(App))
window.moteProof.ready = true
