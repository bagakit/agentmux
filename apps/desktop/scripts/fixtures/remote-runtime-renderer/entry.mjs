import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
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
// Use the real Core filesystem owner across ordinary Electron generations.
api.spatial = {
  read: async () => request('spatial-read'),
  commit: async input => request('spatial-commit', input),
  onChange: listener => window.remoteProof.onSpatialChange(listener)
}
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

const inVisibleViewport = node => {
  if (!node?.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
  const bounds = node.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
    bounds.left < innerWidth && bounds.top < innerHeight
}
const visibleEditor = () => [...document.querySelectorAll('[contenteditable="true"]')].find(inVisibleViewport)
window.remotePaintObservation = () => {
  const editor = visibleEditor()
  const ancestors = []
  for (let node = editor; node; node = node.parentElement) {
    const { x, y, width, height } = node.getBoundingClientRect(), style = getComputedStyle(node)
    ancestors.push({ tag: node.tagName, class: node.className, x, y, width, height,
      overflow: style.overflow, position: style.position, display: style.display, visibility: style.visibility })
  }
  const bounds = editor?.getBoundingClientRect()
  const hit = bounds ? document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) : null
  return { ancestors, hit: hit ? { tag: hit.tagName, class: hit.className, belongsToEditor: editor === hit || editor.contains(hit) } : null }
}
window.remoteNoticeObservation = () => {
  const panel = document.querySelector('.global-system-notices__details')
  const bounds = node => {
    const { x, y, width, height, top, bottom, left, right } = node.getBoundingClientRect()
    return { x, y, width, height, top, bottom, left, right }
  }
  const inputs = [...document.querySelectorAll('.agent-input-stack')].filter(inVisibleViewport).map(bounds)
  const expanded = panel?.matches(':popover-open') && inVisibleViewport(panel)
  const popup = expanded ? bounds(panel) : null
  const notice = [...document.querySelectorAll('.error-notice')].find(inVisibleViewport)
  const noticeStyle = notice ? getComputedStyle(notice) : null
  const panelStyle = panel ? getComputedStyle(panel) : null
  return { expanded, popup, inputs,
    inputClear: Boolean(popup) && inputs.length > 0 && inputs.every(input => popup.bottom <= input.top),
    notice: notice ? { kind: useAppStore.getState().errorNoticeContext?.kind ?? 'indeterminate',
      ariaLive: notice.getAttribute('aria-live'), color: noticeStyle.color, background: noticeStyle.backgroundColor,
      quiet: notice.getAttribute('aria-live') === 'polite' && noticeStyle.color === panelStyle.color &&
        noticeStyle.backgroundColor === panelStyle.backgroundColor } : null }
}
window.remoteState = () => {
  const state = useAppStore.getState(), workbench = projectPersistedWorkbench(state)
  const editor = visibleEditor()
  const selection = getSelection()
  return { loading: state.loading, tabs: workbench.tabs, layouts: workbench.layouts, drafts: state.agentComposerDrafts,
    activeWorkspaceId: state.activeWorkspaceId, focus: state.agentFocus, warnings: state.runtimeEndpointWarnings,
    ownershipWarnings: state.runtimeOwnershipWarnings,
    error: state.error, lastError: state.lastError, errorNoticeContext: state.errorNoticeContext,
    session: state.sessions.find(item => item.id === identity.sessionId),
    queue: state.agentSteerQueues[identity.sessionId] ?? [],
    terminalCount: window.terminals.filter(item => item.element?.isConnected).length,
    editor: editor ? { text: editor.textContent, focused: editor === document.activeElement || editor.contains(document.activeElement),
      originalNode: editor === window.originalEditor, anchor: selection?.anchorOffset, focus: selection?.focusOffset } : null }
}
window.remoteTerminalObservation = () => readTerminalViewObservation({ regionId: identity.regionId, sessionId: identity.sessionId, runId: identity.run.runId })
window.remoteAttachmentNotices = () => [identity.regionId, (setup.terminalReading ?? setup.splitTerminal)?.regionId]
  .filter(Boolean).map(regionId => {
    const region = document.querySelector(`[data-workbench-region-id="${regionId}"]`)
    const notice = [...(region?.querySelectorAll('.terminal-service-window') ?? [])].find(item =>
      [...item.querySelectorAll('.service-window__step')].some(step => step.textContent === 'Observing this Region’s output'))
    const recovery = notice?.querySelector('.service-disclosure__actions button')
    const panel = notice?.querySelector('.service-disclosure__details')
    let recoveryPainted = false
    if (recovery && panel?.matches(':popover-open')) {
      const button = recovery.getBoundingClientRect()
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let ancestor = recovery.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const bounds = ancestor.getBoundingClientRect(), style = getComputedStyle(ancestor)
        if (ancestor === panel || /^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right)
        }
        if (ancestor === panel || /^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom)
        }
        if (ancestor === panel) break
      }
      const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2)
      recoveryPainted = button.width > 0 && button.height > 0 && button.left >= clip.left && button.right <= clip.right &&
        button.top >= clip.top && button.bottom <= clip.bottom && Boolean(hit && (hit === recovery || recovery.contains(hit)))
    }
    return { regionId, regionPresent: Boolean(region), unavailable: Boolean(notice),
      noticeCount: notice?.querySelectorAll('.service-window').length ?? 0,
      recoveryAvailable: recovery?.textContent === 'Refresh observation' && !recovery.disabled,
      recoveryPainted }
  })
window.remoteOpenAttachmentNotice = regionId => {
  const region = document.querySelector(`[data-workbench-region-id="${regionId}"]`)
  const notice = [...(region?.querySelectorAll('.terminal-service-window') ?? [])].find(item =>
    [...item.querySelectorAll('.service-window__step')].some(step => step.textContent === 'Observing this Region’s output'))
  if (!notice) throw Error('The original reader notice must be present before it is opened')
  notice.querySelector('.service-disclosure__trigger').click()
}
window.remoteLiveReady = () => window.remoteTerminalObservation()?.liveReady === true
window.remoteWritersSettled = () => {
  const visible = window.terminals.filter(item => item.element?.getClientRects().length)
  return visible.length > 0 && visible.every(item => item.remoteProofMetrics.writeCalls > 0 &&
    item.remoteProofMetrics.completedWrites === item.remoteProofMetrics.writeCalls)
}
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
window.remoteFlush = async () => { await prepareRendererUpdate(); await request('flush') }
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
  const editor = visibleEditor()
  if (!editor) throw Error('One actual visible Agent editor is required')
  window.originalEditor = editor
  editor.focus()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT), text = walker.nextNode()
  if (!text || text.textContent.length < 7) throw Error('Nonempty original draft is required')
  const range = document.createRange(); range.setStart(text, 7); range.collapse(true)
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  return window.remoteState().editor
}
createRoot(document.getElementById('root')).render(createElement(DesktopClientUiProvider, null, createElement(App)))
window.remoteReady = true
