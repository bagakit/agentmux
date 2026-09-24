import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererControlApi } from '../../../src/renderer/src/lib/control-api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { dispatchWorkbenchCommand, focusedSessionId } from '../../../src/renderer/src/lib/workbench-shortcuts'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { SessionObservationRegions } from '../../../src/renderer/src/components/SessionObservationRegions'
import '../../../src/renderer/src/styles/index.css'
window.terminals = []
window.spaceFocusEvents = []
for (const type of ['focusin', 'focusout']) document.addEventListener(type, event => {
  window.spaceFocusEvents.push({ type, at: performance.now(), tag: event.target?.tagName,
    regionId: event.target?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null,
    relatedRegionId: event.relatedTarget?.closest?.('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null })
})
const request = window.spaceBoundary.request
const setup = await request('setup')
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.scratch.listTopics = async () => request('topics')
api.workspaces.createZoneResource = async input => request('create-resource', input)
api.sessions.snapshot = async () => request('snapshot')
api.sessions.launchAgent = async input => request('launch', input)
// Keep this explicitly excluded optional slot pending. Rejecting it makes the production
// NewTabSurface legitimately try prewarming again, which would create a fixture-only render loop.
api.sessions.launchTerminal = async () => new Promise(() => {})
api.sessions.creation = async (host, id) => request('creation', host, id)
api.sessions.recover = async (control, cwd) => request('recover', control, cwd)
api.sessions.attach = async (control, byte) => request('attach', control, byte)
api.sessions.replay = async (id, byte) => request('replay', id, byte)
api.sessions.detach = async id => request('detach', id)
api.sessions.resize = async (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = async (control, data, source) => request('write', control, data, source)
api.sessions.paste = async (control, text, data) => request('paste', control, text, data)
api.sessions.respondInteraction = async (control, response) => request('respond', control, response)
api.sessions.resolve = async control => request('resolve', control)
api.sessions.refresh = async control => request('refresh', control)
api.sessions.stop = async control => request('stop', control)
api.sessions.submitPrompt = async (control, prompt, operationId, condition, author, choice) => request('submit', control, prompt, operationId, condition, author, choice)
api.sessions.onEvent = createRendererSessionEvents(listener => window.spaceBoundary.onEvent(listener))
api.control = createRendererControlApi(window.spaceBoundary.control)
api.ui.requestStorageFlush = async () => request('flush')
window.spaceState = () => {
  const state = useAppStore.getState()
  const workbench = projectPersistedWorkbench(state)
  return { ...workbench, loading: state.loading, activeWorkspaceId: state.activeWorkspaceId,
    agentFocus: state.agentFocus, retainedSpatialFocus: state.retainedSpatialFocus,
    spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests,
    focusedSessionId: focusedSessionId(state), sessions: state.sessions, error: state.error,
    caretRegionId: document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null,
    caretElementTag: document.activeElement?.tagName ?? null,
    regionCaretFocus: state.regionCaretFocus,
    focusEvents: window.spaceFocusEvents,
    terminalInstances: window.terminals.map((one, index) => ({ index, connected: Boolean(one.element?.isConnected),
      regionId: one.element?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null })),
    domRegions: [...document.querySelectorAll('[data-workbench-region-id]')].map(region => ({
      regionId: region.dataset.workbenchRegionId, inertAncestor: Boolean(region.closest('[inert]')),
      visibility: getComputedStyle(region).visibility, bounds: { width: region.getBoundingClientRect().width, height: region.getBoundingClientRect().height }
    })),
    neutralNotice: document.querySelector('[data-workbench-moved-focus]')?.textContent ?? null,
    terminalCount: window.terminals.filter(one => one.element?.isConnected).length }
}
window.spaceFocus = address => {
  const state = useAppStore.getState()
  const layout = state.layouts[address.workspaceId]
  const group = layout.groups.find(one => one.tabOrder.includes(address.tabId))
  state.activateTab(address.workspaceId, group.id, address.tabId)
  useAppStore.getState().focusRegion(address.workspaceId, address.tabId, address.regionId)
}
window.spaceCommands = () => {
  const before = projectPersistedWorkbench(useAppStore.getState())
  const results = [dispatchWorkbenchCommand({ kind: 'close-region' }, useAppStore.getState()),
    dispatchWorkbenchCommand({ kind: 'split', direction: 'right' }, useAppStore.getState())]
  return { before, after: projectPersistedWorkbench(useAppStore.getState()), results,
    focusedSessionId: focusedSessionId(useAppStore.getState()) }
}
window.spaceFlush = async () => { prepareRendererUpdate(); await request('flush') }
window.spaceSelectCaller = async () => useAppStore.getState().selectWorkspace('caller')
// Mount the actual observation consumer, rather than calling selectSession from the fixture.
// Its existing Open Session button must resolve the persisted projection after a process restart.
let observationRoot
let observationHost
window.spaceObserveSession = sessionId => {
  useAppStore.getState().setMainSurface('board')
  observationHost = document.createElement('aside')
  observationHost.dataset.spaceProofObservation = sessionId
  document.body.append(observationHost)
  observationRoot = createRoot(observationHost)
  observationRoot.render(createElement(SessionObservationRegions, { sessionIds: [sessionId], contextId: 'private-restart-consumer' }))
}
window.spaceCloseObservation = () => {
  observationRoot?.unmount()
  observationHost?.remove()
  observationRoot = observationHost = undefined
}
window.spaceNativeReady = (regionId, sessionId, runId) => readTerminalViewObservation({ regionId, sessionId, runId })?.liveReady === true
window.spaceRegionObservation = regionId => {
  const region = [...document.querySelectorAll('[data-workbench-region-id]')].find(one => one.dataset.workbenchRegionId === regionId)
  const terminal = window.terminals.find(one => one.element?.isConnected && one.element.closest('[data-workbench-region-id]') === region)
  const bounds = region?.getBoundingClientRect()
  const buffer = terminal?.buffer.active
  return { regionId, visible: Boolean(bounds?.width && bounds?.height && getComputedStyle(region).visibility === 'visible'),
    focused: region?.classList.contains('workbench-region--active') ?? false,
    caretRegionId: document.activeElement?.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null,
    viewportText: buffer ? Array.from({ length: terminal.rows }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '').join('\n') : '' }
}
window.spaceReady = true
createRoot(document.getElementById('root')).render(createElement(App))
