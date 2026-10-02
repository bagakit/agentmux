import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import '../../../src/renderer/src/styles/index.css'

window.terminals = []
const request = window.remoteProof.request
const setup = await request('setup')
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.sessions.snapshot = async () => request('snapshot')
api.sessions.attach = async (control, byte) => request('attach', control, byte)
api.sessions.replay = async (id, byte) => request('replay', id, byte)
api.sessions.detach = async id => request('detach', id)
api.sessions.resize = async (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = async (control, data, source) => request('write', control, data, source)
api.sessions.paste = async (control, text, data) => request('paste', control, text, data)
api.sessions.resolve = async control => request('resolve', control)
api.sessions.refresh = async control => request('refresh', control)
api.sessions.submitPrompt = async (...args) => request('submitPrompt', ...args)
api.sessions.onEvent = createRendererSessionEvents(listener => window.remoteProof.onEvent(listener))
api.ui.requestStorageFlush = async () => request('flush')

let identity = setup.identity
if (setup.phase === 'seed') {
  if (setup.recovery) {
    // Seed only durable references supplied by the qualified owner. The ordinary App may restore
    // these Regions before its first remote handshake; live Session/Run authority comes from Core.
    if (!identity?.sessionId || !identity.run?.runId) throw Error('The original durable Session and Run references are required')
  } else {
    const session = (await request('launch')).session
    if (!session) throw Error('The original private local Session must exist before seeding its workface')
    identity = { ...identity, sessionId: session.id, run: session.control.run,
      tabId: identity?.tabId ?? 'local-proof-tab', regionId: identity?.regionId ?? 'local-proof-region', workspaceId: 'local-proof-workspace' }
  }
  await request('save-identity', identity)
  const tab = createWorkbenchTab(identity.tabId, { regionId: identity.regionId, kind: 'agent', phase: 'attached', workspaceId: identity.workspaceId, sessionId: identity.sessionId })
  let remoteTab = createWorkbenchTab('original-remote-tab', { regionId: 'original-remote-terminal', kind: 'terminal', phase: 'attached', workspaceId: 'remote-proof-workspace', sessionId: 'unconfirmed-remote-session' })
  remoteTab = addWorkbenchRegion(remoteTab, 'original-remote-terminal', 'right', { regionId: 'original-remote-agent', kind: 'agent', phase: 'attached', workspaceId: 'remote-proof-workspace', sessionId: 'unconfirmed-remote-agent' })
  const workbench = setup.recovery ? { tabs: { [tab.id]: tab }, layouts: {
    [identity.workspaceId]: createWorkspaceLayout('original-remote-group', [tab.id])
  } } : { tabs: { [tab.id]: tab, [remoteTab.id]: remoteTab }, layouts: {
    'local-proof-workspace': createWorkspaceLayout('local-proof-group', [tab.id]),
    'remote-proof-workspace': createWorkspaceLayout('original-remote-group', [remoteTab.id])
  } }
  if (setup.terminalReading || setup.splitTerminal) {
    const reading = setup.terminalReading ?? setup.splitTerminal
    if (!reading.sessionId || reading.sessionId !== reading.runId) throw Error('The original Terminal Run reference is required')
    const readingTab = createWorkbenchTab(reading.tabId, { regionId: reading.regionId, kind: 'terminal', phase: 'attached',
      workspaceId: reading.workspaceId, sessionId: reading.sessionId })
    workbench.tabs[readingTab.id] = readingTab
    const layout = moveTabToNewGroup(createWorkspaceLayout('original-remote-group', [tab.id, readingTab.id]),
      readingTab.id, 'original-remote-group', 'original-remote-group', 'down', 'original-terminal-group')
    workbench.layouts[reading.workspaceId] = { ...layout, activeGroupId: 'original-remote-group' }
  }
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench(workbench), activeWorkspaceId: identity.workspaceId,
    mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    agentComposerDrafts: setup.recovery ? { [identity.sessionId]: 'Original remote unsent draft' }
      : { [identity.sessionId]: 'Original local unsent draft', 'unconfirmed-remote-agent': 'Original remote unsent draft' }
  } }))
}

window.remoteState = () => {
  const state = useAppStore.getState(), workbench = projectPersistedWorkbench(state)
  const editor = [...document.querySelectorAll('[contenteditable="true"]')].find(node => node.getClientRects().length)
  const selection = getSelection()
  return { loading: state.loading, tabs: workbench.tabs, layouts: workbench.layouts, drafts: state.agentComposerDrafts,
    activeWorkspaceId: state.activeWorkspaceId, focus: state.agentFocus, warnings: state.runtimeEndpointWarnings,
    error: state.error, lastError: state.lastError,
    session: state.sessions.find(item => item.id === identity.sessionId),
    queue: state.agentSteerQueues[identity.sessionId] ?? [],
    terminalCount: window.terminals.filter(item => item.element?.isConnected).length,
    editor: editor ? { text: editor.textContent, focused: editor === document.activeElement || editor.contains(document.activeElement),
      originalNode: editor === window.originalEditor, anchor: selection?.anchorOffset, focus: selection?.focusOffset } : null }
}
window.remoteTerminalObservation = () => readTerminalViewObservation({ regionId: identity.regionId, sessionId: identity.sessionId, runId: identity.run.runId })
window.remoteLiveReady = () => window.remoteTerminalObservation()?.liveReady === true
window.remoteFocusAgentTerminal = () => {
  const candidates = window.terminals.filter(item => item.element?.getClientRects().length &&
    item.element.closest(`[data-workbench-region-id="${identity.regionId}"]`))
  if (candidates.length !== 1) throw Error('Exactly the original Agent terminal must receive input')
  candidates[0].focus()
}
window.remoteReadingWheels = []
document.addEventListener('wheel', event => {
  if (!setup.terminalReading || !event.target.closest(`[data-workbench-region-id="${setup.terminalReading.regionId}"]`)) return
  window.remoteReadingWheels.push({ deltaY: event.deltaY, trusted: event.isTrusted, targetTerminal: Boolean(event.target.closest('.xterm')) })
}, { capture: true, passive: true })
window.remoteReadingState = () => {
  const reading = setup.terminalReading
  if (!reading) throw Error('A private actual terminal reading input is required')
  const state = useAppStore.getState()
  const visible = window.terminals.filter(item => item.element?.getClientRects().length &&
    item.element.closest(`[data-workbench-region-id="${reading.regionId}"]`))
  const terminal = visible.length === 1 ? visible[0] : null
  const view = readTerminalViewObservation({ regionId: reading.regionId, sessionId: reading.sessionId, runId: reading.runId })
  const bounds = terminal?.element.getBoundingClientRect()
  return { visibleTerminals: visible.length, terminalId: terminal ? window.terminals.indexOf(terminal) : null, view,
    lines: terminal ? Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)?.translateToString()) : [],
    point: bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, height: bounds.height } : null,
    metrics: terminal ? { ...terminal.remoteProofMetrics } : null,
    allMetrics: window.terminals.map((item, terminalId) => ({ terminalId, ...item.remoteProofMetrics })),
    session: state.sessions.find(item => item.id === reading.sessionId),
    historyCount: terminal?.element.closest(`[data-workbench-region-id="${reading.regionId}"]`)?.querySelectorAll('.session-history').length ?? 0,
    wheels: window.remoteReadingWheels.slice() }
}
window.remoteFocusReadingTerminal = () => {
  const observed = window.remoteReadingState()
  if (observed.visibleTerminals !== 1) throw Error('Exactly the original reading terminal must receive input')
  window.terminals[observed.terminalId].focus()
}
window.remoteFlush = async () => { prepareRendererUpdate(); await request('flush') }
window.remoteSeedUnconfirmed = () => {
  const session = useAppStore.getState().sessions.find(item => item.id === identity.sessionId)
  if (!session || session.kind !== 'agent') throw Error('The actual original Agent is required')
  useAppStore.setState({ agentSteerQueues: { [identity.sessionId]: [{ operationId: 'private-original-unconfirmed',
    text: 'Keep the original uncertain operation', runId: identity.run.runId, status: 'deferred',
    promptCondition: { expectedRun: identity.run, afterSubmissionId: session.promptSubmissionPredecessor }, error: 'The original delivery result is unknown.' }] } })
}
window.remoteRemoveUnconfirmed = () => useAppStore.getState().removeAgentSteer(identity.sessionId, 'private-original-unconfirmed')
window.remoteResync = () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
  type: 'agent-status', agentSessionId: 'controlled-membership-gap', state: 'working', evidence: { source: 'agentmux', observedAt: Date.now() }
} })
window.remoteSetCaret = () => {
  const editor = [...document.querySelectorAll('[contenteditable="true"]')].find(node => node.getClientRects().length)
  if (!editor) throw Error('One actual visible Agent editor is required')
  window.originalEditor = editor
  editor.focus()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT), text = walker.nextNode()
  if (!text || text.textContent.length < 7) throw Error('Nonempty original draft is required')
  const range = document.createRange(); range.setStart(text, 7); range.collapse(true)
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  return window.remoteState().editor
}
createRoot(document.getElementById('root')).render(createElement(App))
window.remoteReady = true
