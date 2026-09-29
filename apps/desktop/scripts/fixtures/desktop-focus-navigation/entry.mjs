import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererControlApi } from '../../../src/renderer/src/lib/control-api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { bindingById, chordForPlatform } from '../../../src/renderer/src/lib/shortcut-registry'
import { isMacPlatform } from '../../../src/renderer/src/lib/host-platform'
import { REGION_FOCUS_CLASS } from '../../../src/renderer/src/lib/region-focus'
import '../../../src/renderer/src/styles/index.css'

// These are instrumentation, never a router, input owner or Runtime projection.
window.terminals = []
window.focusProofEvents = []
let coldDiagnostic = null
const coldPoint = (kind, facts = {}) => {
  if (!coldDiagnostic || coldDiagnostic.events.length >= 256) return
  coldDiagnostic.events.push({ kind, at: Date.now(), clock: performance.now(), ...facts })
}
const coldTarget = () => {
  if (!coldDiagnostic) return null
  const region = document.querySelector(`[data-workbench-region-id=${CSS.escape(coldDiagnostic.regionId)}]`)
  const input = region?.querySelector('.xterm-helper-textarea')
  const style = input && getComputedStyle(input)
  const rect = input?.getBoundingClientRect()
  const active = document.activeElement
  return { regionPresent: Boolean(region), regionConnected: Boolean(region?.isConnected),
    sameRegion: region === coldDiagnostic?.originalRegion, inputPresent: Boolean(input),
    sameInput: input === coldDiagnostic?.originalInput, inputConnected: Boolean(input?.isConnected),
    inputInert: Boolean(input?.closest('[inert]')), inputVisibility: style?.visibility ?? null,
    inputDisplay: style?.display ?? null, inputBounds: rect ? { width: rect.width, height: rect.height } : null,
    inputActive: input === active,
    actualInputRegion: active?.closest?.('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null,
    pageVisibility: document.visibilityState, documentHasFocus: document.hasFocus() }
}
window.focusProofBeginColdDiagnostics = regionId => {
  if (coldDiagnostic) throw new Error('A cold diagnostic window is already active')
  const originalRegion = document.querySelector(`[data-workbench-region-id=${CSS.escape(regionId)}]`)
  coldDiagnostic = { regionId, originalRegion, originalInput: originalRegion?.querySelector('.xterm-helper-textarea'), events: [] }
  const originalTimeout = window.setTimeout
  const originalClearTimeout = window.clearTimeout
  const observedTimers = new Map()
  window.setTimeout = function (callback, duration, ...args) {
    if (duration !== 700 || typeof callback !== 'function') return originalTimeout.call(window, callback, duration, ...args)
    const scheduledAt = Date.now()
    let id
    id = originalTimeout.call(window, (...values) => {
      coldPoint('renderer-700ms-timer-fired', { timerId: id, scheduledAt, elapsed: Date.now() - scheduledAt, target: coldTarget() })
      observedTimers.delete(id)
      return callback.apply(window, values)
    }, duration, ...args)
    observedTimers.set(id, scheduledAt)
    coldPoint('renderer-700ms-timer-scheduled', { timerId: id, scheduledAt, target: coldTarget() })
    return id
  }
  window.clearTimeout = function (id) {
    if (observedTimers.has(id)) {
      coldPoint('renderer-700ms-timer-cleared', { timerId: id, elapsed: Date.now() - observedTimers.get(id) })
      observedTimers.delete(id)
    }
    return originalClearTimeout.call(window, id)
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.regionCaretFocus === previous.regionCaretFocus) return
    coldPoint('store-caret-nonce-changed', { before: previous.regionCaretFocus, after: state.regionCaretFocus,
      selectedRegionId: state.workbenchSpaceSelection?.regionId ?? null, inputPolicy: state.workbenchNavigationInputPolicy,
      target: coldTarget() })
  })
  coldDiagnostic.dispose = () => { unsubscribe(); window.setTimeout = originalTimeout; window.clearTimeout = originalClearTimeout }
  coldPoint('renderer-diagnostic-begin', { target: coldTarget() })
}
window.focusProofColdPoint = kind => coldPoint(kind, { target: coldTarget() })
window.focusProofColdTarget = () => coldTarget()
window.focusProofEndColdDiagnostics = () => {
  if (!coldDiagnostic) return null
  coldPoint('renderer-diagnostic-end', { nonce: useAppStore.getState().regionCaretFocus, target: coldTarget() })
  const { regionId, events, dispose } = coldDiagnostic
  dispose()
  coldDiagnostic = null
  return { regionId, events }
}
for (const type of ['focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
  document.addEventListener(type, event => {
    const regionId = event.target?.closest?.('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null
    window.focusProofEvents.push({ type, regionId, at: performance.now(), tag: event.target?.tagName ?? null,
      editableTarget: Boolean(event.target?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(event.target?.tagName)), inputType: event.inputType ?? null,
      isComposing: event.isComposing ?? null, data: type.startsWith('composition') ? event.data : null })
  }, true)
}
const request = window.focusProofBoundary.request
const setup = await request('setup')
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => request('demands')
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.scratch.listTopics = async () => request('topics')
api.scratch.ensureTopic = async (workspace, id) => request('ensure-topic', workspace, id)
api.scratch.ensureMote = async (workspace, id) => request('ensure-mote', workspace, id)
api.scratch.readTopic = async (workspace, id) => request('read-topic', workspace, id)
api.workspaces.createZoneResource = async input => request('create-resource', input)
api.sessions.snapshot = async () => request('snapshot')
api.sessions.launchAgent = async input => request('launch-agent', input)
// Optional warm shells are real. Navigation is required to leave their owner alone.
api.sessions.launchTerminal = async input => request('launch-terminal', input)
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
api.sessions.onEvent = createRendererSessionEvents(listener => window.focusProofBoundary.onEvent(listener))
const control = window.focusProofBoundary.control
api.control = createRendererControlApi({
  onRequest: listener => control.onRequest(request => {
    if (coldDiagnostic) coldPoint('renderer-control-request', { requestId: request.requestId, operation: request.operation, target: coldTarget() })
    listener(request)
  }),
  onCancellation: listener => control.onCancellation(cancellation => {
    if (coldDiagnostic) coldPoint('renderer-control-cancel', { requestId: cancellation.requestId, code: cancellation.code, target: coldTarget() })
    listener(cancellation)
  }),
  respond: response => {
    if (coldDiagnostic) coldPoint('renderer-control-response', { requestId: response.requestId, ok: response.ok,
      outcome: response.ok ? response.result.input?.outcome ?? null : response.error.code, target: coldTarget() })
    control.respond(response)
  }
})
api.ui.requestStorageFlush = async () => request('flush')
api.executors.detect = async (executor, host) => request('detect', executor, host)

function caret() {
  const element = document.activeElement
  const selection = document.getSelection()
  const rect = element?.getBoundingClientRect()
  return { tag: element?.tagName ?? null,
    regionId: element?.closest?.('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null,
    floating: Boolean(element?.closest?.('[data-pmo-teams-topic-floating]')),
    connected: Boolean(element?.isConnected), inert: Boolean(element?.closest?.('[inert]')),
    visible: Boolean(rect?.width && rect?.height && getComputedStyle(element).visibility !== 'hidden'),
    anchorOffset: selection?.anchorOffset ?? null, focusOffset: selection?.focusOffset ?? null,
    selectionStart: typeof element?.selectionStart === 'number' ? element.selectionStart : null,
    selectionEnd: typeof element?.selectionEnd === 'number' ? element.selectionEnd : null }
}
window.focusProofState = () => {
  const state = useAppStore.getState()
  return { ...projectPersistedWorkbench(state), loading: state.loading, activeWorkspaceId: state.activeWorkspaceId,
    mainSurface: state.mainSurface, workbenchSpaceSelection: state.workbenchSpaceSelection,
    selectedDemandId: state.selectedDemandId, agentFocus: state.agentFocus,
    agentComposerDrafts: state.agentComposerDrafts, viewModes: state.viewModes, sessions: state.sessions,
    regionCaretFocus: state.regionCaretFocus, navigationInputPolicy: state.workbenchNavigationInputPolicy,
    retainedSpatialFocus: state.retainedSpatialFocus,
    floating: readPmoTeamsTopicFloatingState(), caret: caret(), events: window.focusProofEvents, error: state.error }
}
window.focusProofPersistedModes = () => {
  const state = useAppStore.getState()
  const projection = useAppStore.persist.getOptions().partialize(state)
  return { present: Object.hasOwn(projection, 'viewModes'), modes: projection.viewModes ?? null }
}
window.focusProofInitializeMote = (tabId, sessionId) => {
  useAppStore.getState().setViewMode(sessionId, 'activity')
  requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
}
window.focusProofMoteInput = () => {
  const panel = document.querySelector('[data-pmo-teams-topic-floating]')
  const regionId = panel?.dataset.moteTargetRegion
  return regionId ? panel.querySelector(`[data-workbench-region-id=${CSS.escape(regionId)}] .composer__editor [contenteditable="true"]`) : null
}
window.focusProofCaptureMoteRegions = (leftId, rightId) => {
  const panel = document.querySelector('[data-pmo-teams-topic-floating]')
  const read = regionId => {
    const region = panel?.querySelector(`[data-workbench-region-id=${CSS.escape(regionId)}]`)
    const input = region?.querySelector('.composer__editor [contenteditable="true"]')
    if (!region || !input) throw new Error(`Actual Mote projection absent: ${regionId}`)
    return { regionId, region, input, value: input.textContent }
  }
  window.focusProofMoteRegionRefs = { left: read(leftId), right: read(rightId) }
  const rect = window.focusProofMoteRegionRefs.right.input.getBoundingClientRect()
  return { leftId, rightId, rightValue: window.focusProofMoteRegionRefs.right.value,
    box: { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + Math.min(9, rect.height / 2), width: rect.width, height: rect.height } }
}
window.focusProofCheckMoteRegions = () => {
  const { left, right } = window.focusProofMoteRegionRefs
  const panel = document.querySelector('[data-pmo-teams-topic-floating]')
  const same = one => panel?.querySelector(`[data-workbench-region-id=${CSS.escape(one.regionId)}]`) === one.region &&
    one.region.querySelector('.composer__editor [contenteditable="true"]') === one.input && one.region.isConnected && one.input.isConnected
  const selection = document.getSelection()
  return { leftSame: same(left), rightSame: same(right), leftActive: left.region.classList.contains(REGION_FOCUS_CLASS),
    rightActive: right.region.classList.contains(REGION_FOCUS_CLASS), rightCaret: document.activeElement === right.input,
    rightSelection: right.input.contains(selection?.anchorNode) && right.input.contains(selection?.focusNode),
    rightValueSame: right.input.textContent === right.value, leftValueSame: left.input.textContent === left.value }
}
function inputSelectionFacts(element, selection) {
  const endpoint = (node, offset) => {
    const withinInput = Boolean(element?.isContentEditable && node && element.contains(node))
    let textOffset = null
    if (withinInput) {
      const range = document.createRange()
      range.setStart(element, 0)
      range.setEnd(node, offset)
      textOffset = range.toString().length
    }
    return { nodeType: node?.nodeType ?? null, offset: offset ?? null, withinInput, textOffset }
  }
  return { rangeCount: selection?.rangeCount ?? 0,
    anchor: endpoint(selection?.anchorNode, selection?.anchorOffset),
    focus: endpoint(selection?.focusNode, selection?.focusOffset) }
}
window.focusProofCaptureInput = () => {
  const element = document.activeElement
  const selection = document.getSelection()
  window.focusProofOriginalInput = { element, anchorNode: selection?.anchorNode, focusNode: selection?.focusNode,
    anchorOffset: selection?.anchorOffset, focusOffset: selection?.focusOffset, value: element?.isContentEditable ? element.textContent : element?.value,
    caret: caret(), selection: inputSelectionFacts(element, selection), eventCursor: window.focusProofEvents.length,
    view: element?.closest?.('[data-workbench-region-id]') }
  return { caret: window.focusProofOriginalInput.caret, selection: window.focusProofOriginalInput.selection, value: window.focusProofOriginalInput.value,
    eventCursor: window.focusProofOriginalInput.eventCursor }
}
window.focusProofPreservedInput = () => {
  const original = window.focusProofOriginalInput
  const element = document.activeElement
  const selection = document.getSelection()
  return { sameElement: element === original.element, sameView: element?.closest?.('[data-workbench-region-id]') === original.view,
    sameAnchor: selection?.anchorNode === original.anchorNode, sameFocus: selection?.focusNode === original.focusNode,
    sameOffsets: selection?.anchorOffset === original.anchorOffset && selection?.focusOffset === original.focusOffset,
    sameValue: (element?.isContentEditable ? element.textContent : element?.value) === original.value,
    caret: caret(), selection: inputSelectionFacts(element, selection), events: window.focusProofEvents.slice(original.eventCursor) }
}
window.focusProofMoteSelectionOwner = () => {
  const input = window.focusProofMoteInput(), editor = input?.editor, selection = document.getSelection()
  const anchorInside = Boolean(input && selection?.anchorNode && input.contains(selection.anchorNode))
  const focusInside = Boolean(input && selection?.focusNode && input.contains(selection.focusNode))
  const editorAttached = Boolean(editor && !editor.isDestroyed && editor.view.dom === input)
  return { inputPresent: Boolean(input?.isConnected), inputActive: Boolean(input && document.activeElement === input),
    editorAttached, anchorInside, focusInside,
    domModelAnchor: editorAttached && anchorInside ? editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) : null,
    domModelFocus: editorAttached && focusInside ? editor.view.posAtDOM(selection.focusNode, selection.focusOffset) : null,
    modelAnchor: editorAttached ? editor.state.selection.anchor : null,
    modelHead: editorAttached ? editor.state.selection.head : null }
}
let moteInputDiagnostics = null
window.focusProofBeginMoteInputDiagnostics = () => {
  if (moteInputDiagnostics) throw new Error('The original Mote input diagnostic is already active')
  const input = window.focusProofMoteInput(), editor = input?.editor
  if (!input?.isConnected || !editor || editor.isDestroyed || editor.view.dom !== input) throw new Error('The actual maintained Mote input is absent')
  const events = []
  const point = kind => {
    if (events.length < 64) events.push({ kind, at: Date.now(), clock: performance.now(),
      owner: window.focusProofMoteSelectionOwner(), selection: inputSelectionFacts(input, document.getSelection()) })
  }
  const domSelection = () => point('dom-selectionchange')
  const ownerSelection = () => point('editor-selection-update')
  document.addEventListener('selectionchange', domSelection)
  editor.on('selectionUpdate', ownerSelection)
  moteInputDiagnostics = { input, events, point, dispose: () => {
    document.removeEventListener('selectionchange', domSelection)
    editor.off('selectionUpdate', ownerSelection)
  } }
  point('mote-input-diagnostic-begin')
}
window.focusProofMoteInputDiagnosticPoint = kind => moteInputDiagnostics?.point(kind)
window.focusProofMoteInputReady = () => {
  const original = window.focusProofOriginalInput, diagnostic = moteInputDiagnostics
  if (!original || !diagnostic || original.element !== diagnostic.input) return false
  const input = window.focusProofPreservedInput(), owner = window.focusProofMoteSelectionOwner()
  if (!(input.sameElement && input.sameView && input.sameAnchor && input.sameFocus && input.sameOffsets && input.sameValue)) {
    diagnostic.point('original-keyboard-range-lost')
    throw new Error('The original real post-key input/Range changed before its owner completed')
  }
  return owner.inputPresent && owner.inputActive && owner.editorAttached && owner.anchorInside && owner.focusInside &&
    Number.isSafeInteger(owner.modelAnchor) && Number.isSafeInteger(owner.modelHead) &&
    owner.domModelAnchor === owner.modelAnchor && owner.domModelFocus === owner.modelHead
}
window.focusProofEndMoteInputDiagnostics = () => {
  if (!moteInputDiagnostics) return null
  moteInputDiagnostics.point('mote-input-diagnostic-end')
  const { input, events, dispose } = moteInputDiagnostics
  dispose()
  moteInputDiagnostics = null
  return { regionId: input.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId ?? null, events }
}
window.focusProofCapturedInputState = () => {
  const captured = window.focusProofOriginalInput?.element
  const active = document.activeElement
  const search = document.querySelector('.global-search-input input')
  return { capturedExists: Boolean(captured), capturedIsSearch: Boolean(captured && search && captured === search),
    capturedConnected: Boolean(captured?.isConnected), capturedHidden: Boolean(captured?.closest('[hidden], [aria-hidden="true"]')),
    capturedInert: Boolean(captured?.closest('[inert]')), activeSameCaptured: Boolean(captured && active === captured),
    activeConnected: Boolean(active?.isConnected), activeBody: active === document.body,
    activeEditable: Boolean(active?.isContentEditable || ['INPUT', 'TEXTAREA'].includes(active?.tagName)) }
}
window.focusProofReadyTerminal = (regionId, sessionId, runId) => readTerminalViewObservation({ regionId, sessionId, runId })?.liveReady === true
window.focusProofFocusMoteInput = () => {
  const element = window.focusProofMoteInput()
  if (!element) throw new Error('The original Mote composer is absent')
  element.focus()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  const selection = document.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}
window.focusProofHumanNavigate = surface => useAppStore.getState().setMainSurface(surface)
window.focusProofHoldTargetInput = regionId => {
  const region = document.querySelector(`[data-workbench-region-id=${CSS.escape(regionId)}]`)
  if (!region) throw new Error('The exact existing target Region host is absent')
  window.focusProofHeldRegion = region
  region.inert = true
  coldPoint('target-input-held-inert', { target: coldTarget() })
}
window.focusProofReleaseTargetInput = () => {
  if (!window.focusProofHeldRegion) throw new Error('No exact private Region hold exists')
  coldPoint('target-input-release-begin', { target: coldTarget() })
  window.focusProofHeldRegion.inert = false
  window.focusProofHeldRegion = null
  coldPoint('target-input-release-end', { target: coldTarget() })
}
window.focusProofHumanViewMode = (sessionId, mode) => useAppStore.getState().setViewMode(sessionId, mode)
window.focusProofOpenQuickSwitcher = () => {
  const mac = isMacPlatform()
  const chord = chordForPlatform(bindingById('quick-switch.toggle'), mac)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: chord.key, metaKey: chord.primary && mac,
    ctrlKey: chord.primary && !mac, shiftKey: chord.shift, altKey: chord.alt, bubbles: true, cancelable: true }))
}
window.focusProofOpenShortcuts = () => document.querySelector('.window-status-bar [data-shortcut-help-open]').click()
window.focusProofBeginInspect = () => {
  const before = useAppStore.getState()
  const originalElement = document.activeElement
  let writes = 0
  const release = useAppStore.subscribe(() => { writes += 1 })
  window.focusProofInspectEnd = () => {
    release()
    return { stateSame: useAppStore.getState() === before, writes, caretSame: document.activeElement === originalElement }
  }
}
window.focusProofRefreshDemands = async () => {
  const demands = await request('demands')
  useAppStore.setState({ demands: Object.fromEntries(demands.map(demand => [demand.id, demand])) })
}
window.focusProofFlush = async () => { prepareRendererUpdate(); await request('flush') }
window.focusProofReady = true
createRoot(document.getElementById('root')).render(createElement(App))
