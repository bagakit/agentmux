import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import '../../../src/renderer/src/styles/index.css'
window.terminals = []
const request = window.nativeBoundary.request
const setup = await request('setup'), workspace = setup.config.workspaces[0]
api.config.get = async () => setup.config
api.providers.list = options => request('providers', options)
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.sessions.snapshot = () => request('snapshot')
api.sessions.historySources = options => request('history-sources', options)
api.sessions.attach = (control, byte) => request('attach', control, byte)
api.sessions.replay = (id, byte) => request('replay', id, byte)
api.sessions.detach = id => request('detach', id)
api.sessions.resize = (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = (control, data, source) => request('write', control, data, source)
api.sessions.paste = (control, text, data) => request('paste', control, text, data)
api.sessions.send = (...args) => request('send', ...args)
api.sessions.submitPrompt = (...args) => request('submit-prompt', ...args)
api.sessions.inspectInput = (...args) => request('inspect-input', ...args)
api.sessions.rejoinInputWaiting = (...args) => request('rejoin-input', ...args)
window.continuityRecoveryReceipts = []
api.sessions.recover = async (...args) => {
  const result = await request('recover', ...args)
  window.continuityRecoveryReceipts.push({ args, result })
  return result
}
api.sessions.resolve = control => request('resolve', control)
api.sessions.refresh = control => request('refresh', control)
const spatialEvent = event => event.kind === 'native-proof-spatial-state'
api.sessions.onEvent = createRendererSessionEvents(listener => window.nativeBoundary.onEvent(event => { if (!spatialEvent(event)) listener(event) }))
api.spatial.read = () => request('spatial-read')
api.spatial.commit = input => request('spatial-commit', input)
api.spatial.retainLabels = values => request('spatial-retain-labels', values)
api.spatial.onChange = listener => window.nativeBoundary.onEvent(event => { if (spatialEvent(event)) listener(event.state) })
api.ui.requestStorageFlush = () => request('flush')
if (setup.phase === 'seed') {
  const agent = (name) => ({ regionId: `continuity-${name}`, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: setup.ids[name].sessionId })
  let first = createWorkbenchTab('continuity-work', agent('working'))
  first = addWorkbenchRegion(first, 'continuity-working', 'right', agent('healthy'))
  const second = createWorkbenchTab('continuity-idle', agent('idle'))
  const tabs = { [first.id]: first, [second.id]: second }
  const layout = createWorkspaceLayout('continuity-group', Object.keys(tabs))
  if (await api.spatial.read() !== null) throw new Error('Private seed cannot overwrite an existing spatial document')
  await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config: setup.config, sessions: setup.sessions,
    tabs, layouts: { [workspace.id]: layout }, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: { activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    toolsOpen: false, projectRailOpen: false, agentComposerDrafts: Object.fromEntries(Object.entries(setup.ids).map(([key, id]) => [id.sessionId, `Unsent ${key} draft remains intact`])) } }))
}
window.continuityState = () => {
  const state = useAppStore.getState(), workbench = projectPersistedWorkbench(state)
  return { loading: state.loading, tabs: workbench.tabs, layouts: workbench.layouts, drafts: state.agentComposerDrafts,
    focus: state.agentFocus, activeWorkspaceId: state.activeWorkspaceId,
    sessions: state.sessions, queues: state.agentSteerQueues, recoveryReceipts: window.continuityRecoveryReceipts,
    error: state.error, dom: document.body.innerText }
}
window.continuitySendIdle = () => useAppStore.getState().send(setup.ids.idle.sessionId,
  'Fresh explicit input resumes the retained idle conversation', undefined, 'manual', undefined, { execution: 'immediate' })
window.continuityTerminalState = name => {
  const session = useAppStore.getState().sessions.find(one => one.id === setup.ids[name].sessionId)
  const regionId = 'continuity-' + name
  const terminal = window.terminals.find(one => one.element?.isConnected && one.element.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId === regionId)
  return { observation: session ? readTerminalViewObservation({ regionId, sessionId: session.id, runId: session.control.run.runId }) : null,
    text: terminal ? Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString() ?? '').join('\n') : '' }
}
window.continuityFlush = async () => { await prepareRendererUpdate('quit'); await request('flush') }
// Presentation-only fixture: replace a Renderer copy, never the Core receipt or
// a control fact. The real unknown-delivery behavior has its own Core gate.
window.continuityShowNotice = async () => {
  const sessions = useAppStore.getState().sessions
  const working = sessions.find(one => one.id === setup.ids.working.sessionId)
  const operation = Object.values(working.continuityOperations).find(one => one.recoveryDelivery?.phase === 'accepted')
  const projected = structuredClone(operation)
  projected.recoveryDelivery.phase = 'unknown'
  projected.recoveryDelivery.reason = 'The original native input receipt is temporarily unavailable'
  useAppStore.setState({ sessions: sessions.map(one => one === working ? { ...one,
    continuityOperations: { ...one.continuityOperations, [projected.operationId]: projected } } : one) })
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const region = document.querySelector('[data-workbench-region-id="continuity-working"]')
  const mailbox = region.querySelector('.composer-mailbox')
  mailbox.showPopover()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  mailbox.querySelector('[role="tab"][id$="-system-tab"]').click()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  Array.from(mailbox.querySelectorAll('button')).find(one => one.textContent.includes('Recovery input delivery is unconfirmed')).click()
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const detail = mailbox.querySelector('.composer-mailbox__detail')
  if (!detail?.textContent.includes(projected.recoveryDelivery.key.submissionId)) throw new Error('Original recovery input identity is absent from the actual notice')
  window.continuityHideNotice = () => { mailbox.hidePopover(); useAppStore.setState({ sessions }) }
  return { kind: 'presentation-only-renderer-copy', operationId: projected.operationId, inputKey: projected.recoveryDelivery.key,
    text: detail.textContent, receiptChangedInCore: false, draft: useAppStore.getState().agentComposerDrafts[working.id] }
}
createRoot(document.getElementById('root')).render(createElement(App))
window.continuityReady = true
