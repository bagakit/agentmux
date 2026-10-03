import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import React from 'react'
import { flushSync } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

// Read-only instrumentation of the actual xterm instances in this private
// producer. open, geometry, rendering, bytes and options retain their owner.
const terminalInstances: any[] = []
const actualTerminalOpen = Terminal.prototype.open
Terminal.prototype.open = function (...args: Parameters<typeof actualTerminalOpen>) {
  terminalInstances.push(this)
  return actualTerminalOpen.apply(this, args)
}
const terminalTimeline: unknown[] = []
const terminalAttachments: unknown[] = []
function terminalFacts() {
  return { sampledAt: Date.now(), dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
    terminals: terminalInstances.filter(t => t.element?.isConnected).map(t => {
      const regionId = t.element.closest('[data-workbench-region-id]')?.dataset.workbenchRegionId
      const core = t._core, screen = t.element.querySelector('.xterm-screen')
      const app = useAppStore.getState()
      const region = Object.values(app.tabs).flatMap(tab => Object.values(tab.regions)).find(r => r.regionId === regionId)
      const session = region?.kind === 'agent' ? app.sessions.find(s => s.id === region.sessionId) : null
      const viewObservation = session?.kind === 'agent' && regionId ? readTerminalViewObservation({ regionId, sessionId: session.id, runId: session.control.run.runId }) : null
      return { regionId, viewObservation, visible: Boolean(t.element.getBoundingClientRect().width), options: { fontSize: t.options.fontSize, fontFamily: t.options.fontFamily, lineHeight: t.options.lineHeight },
        grid: { cols: t.cols, rows: t.rows }, browserDpr: core?._coreBrowserService?.dpr,
        charSize: core?._charSizeService ? { width: core._charSizeService.width, height: core._charSizeService.height } : null,
        renderDimensions: core?._renderService?.dimensions,
        buffer: { baseY: t.buffer.active.baseY, viewportY: t.buffer.active.viewportY, length: t.buffer.active.length, cursorY: t.buffer.active.cursorY, lines: Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)) },
        element: t.element.getBoundingClientRect().toJSON(), screen: screen?.getBoundingClientRect().toJSON(),
        canvases: [...t.element.querySelectorAll('canvas')].map((c: any) => ({ width: c.width, height: c.height, rect: c.getBoundingClientRect().toJSON(), styleWidth: c.style.width, styleHeight: c.style.height })) }
    }), attachments: [...terminalAttachments], timeline: [...terminalTimeline] }
}
addEventListener('resize', () => terminalTimeline.push({ kind: 'window-resize', sampledAt: Date.now(), dpr: devicePixelRatio, width: innerWidth, height: innerHeight }))
const bridge = (window as any).takeoverNative
const boot = await bridge.boot()
const originalConfig = await api.config.get(), originalSnapshot = await api.sessions.snapshot()
const config = boot?.config ?? {
  ...originalConfig,
  hosts: originalConfig.hosts.filter(host => host.id === 'local'),
  executors: Object.fromEntries(['codex', 'claude', 'gemini', 'cursor', 'opencode', 'pi'].map(id => [id, originalConfig.executors[id]])),
  workspaces: [{ ...originalConfig.workspaces[0]!, id: 'takeover-private-project', name: 'Continuity lab', path: _hygiene_fixturePath("private/takeover-project") }]
}
const initialSnapshot = boot?.snapshot ?? {
  ...originalSnapshot,
  sessions: originalSnapshot.sessions.filter(session => session.kind === 'agent').slice(0, 2).map((session, index) => ({
    ...session, hostId: 'local', workspacePath: config.workspaces[0]!.path, processState: 'running',
    label: index === 0 ? 'Implementation coordinator' : 'Independent reviewer',
    control: { ...session.control, hostId: 'local' },
    status: { state: 'working', source: 'native-hook', observedAt: Date.now(), detail: 'Original Agent is healthy.' }
  })),
  browsers: []
}
let nativeSnapshot = structuredClone(initialSnapshot)
let creations = boot?.creations ?? {}
const launches: unknown[] = [], trusted: unknown[] = [], flushes: unknown[] = []
let failureMode = false
const launchApi = api.sessions.launchAgent
const attachApi = api.sessions.attach
const resizeApi = api.sessions.resize
api.sessions.resize = async (attachmentId, cols, rows) => {
  const result = await resizeApi(attachmentId, cols, rows)
  terminalTimeline.push({ kind: 'native-resize', sampledAt: Date.now(), attachmentId, requested: { cols, rows }, result, dpr: devicePixelRatio })
  return result
}
api.config.get = async () => structuredClone(config)
api.sessions.snapshot = async () => structuredClone(nativeSnapshot)
api.sessions.historySources = async () => nativeSnapshot.sessions.filter(session => session.kind === 'agent').map(session => ({
  agentSessionId: session.id, hostId: session.hostId, state: 'active', history: {
    providerId: session.providerId!, executorId: session.executorId!, workspacePath: session.workspacePath, createdAt: session.createdAt
  }
}))
api.sessions.timeline = async control => structuredClone(nativeSnapshot.timelines[control.agentSessionId] ?? { agentSessionId: control.agentSessionId, revision: 0, items: [] })
api.sessions.creation = async (_host, id) => {
  const creation = creations[id]
  if (!creation) throw new Error('The private Native owner has no confirmed receipt for this exact creation.')
  return structuredClone(creation)
}
api.sessions.attach = async (control, afterByte = 0) => {
  const id = control.kind === 'agent' ? control.agentSessionId : control.runId
  const session = nativeSnapshot.sessions.find(item => item.id === id)
  if (!session) throw new Error('The controlled Native API has no exact source Session for this attachment.')
  let result
  try { result = await attachApi(control, afterByte) }
  catch {
    // Native facts are the only controlled boundary. On the second process the
    // generic web API has no newly created Agent; return its preserved identity
    // with an explicit, synthetic readable terminal representation.
    const data = 'Ready to continue.\r\n', bytes = new TextEncoder().encode(data)
    result = { attachmentId: crypto.randomUUID(), session, gap: null, resizeRevision: 0,
      replay: afterByte ? [] : [{ type: 'data', runId: control.run.runId, startByte: 0, endByte: bytes.length, data, dataBytes: bytes }] }
  }
  // Controlled Native byte facts must agree with the complete replay; the
  // generic preview snapshot deliberately reports zero and cannot serve as a
  // basic-vt owner. This is fixture protocol completion, never a hidden notice.
  const endByte = result.replay.at(-1)?.endByte ?? afterByte
  terminalAttachments.push({ sampledAt: Date.now(), sessionId: id, runId: control.run.runId, afterByte, endByte, currentSize: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, resizeRevision: 0, dpr: devicePixelRatio })
  session.latestOutputBytes = endByte
  return { ...result, session: structuredClone(session), currentSize: { cols: 80, rows: 24 }, resizeRevision: 0,
    terminal: { type: 'basic-vt', checkpoint: { runId: control.run.runId, throughByte: afterByte, resizeRevision: 0,
      size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
      restoreBytes: new TextEncoder().encode('\u001bc'), resizes: [] } }
}
api.sessions.refreshAttachment = (control, _attachment, afterByte = 0) => api.sessions.attach(control, afterByte)
api.sessions.launchAgent = async input => {
  launches.push(structuredClone(input))
  if (failureMode) throw new Error('The private Native creation response is unavailable. The same request must be inspected; no automatic retry was sent.')
  const result = await launchApi(input)
  result.created.creation = { createOperationId: input.createOperationId!, initialPrompt: input.prompt?.trim() ? 'confirmed' : 'not-requested' }
  creations[result.created.agentSessionId] = result.created
  nativeSnapshot.sessions.push(result.session)
  nativeSnapshot.timelines[result.session.id] = result.timeline!
  await bridge.saveRuntime({ config, snapshot: nativeSnapshot, creations })
  return result
}
api.executors.detect = async (id, hostId) => {
  if (id === 'cursor') throw new Error('Private command discovery is unconfirmed; the configured choice remains usable.')
  const executor = config.executors[id]!, host = config.hosts.find(item => item.id === hostId)!
  return { input: structuredClone({ executorId: id, providerId: executor.providerId, command: executor.command, host }),
    executable: executor.command, availability: id === 'pi' ? 'missing' : 'available' }
}
api.spatial.read = () => bridge.spatialRead()
api.spatial.commit = input => bridge.spatialCommit(input)
api.spatial.onChange = () => () => {}
api.ui.requestStorageFlush = async () => { flushes.push(Date.now()); await bridge.flush() }
await useAppStore.getState().initialize()
const workspaceId = config.workspaces[0]!.id
await useAppStore.getState().selectWorkspace(workspaceId)
if (!boot) {
  // Set up the isolated first workface once. This is fixture preparation before
  // any operation; the second Renderer receives no tabs/layout/draft seed.
  const state = useAppStore.getState(), seeded = nativeSnapshot.sessions.slice(0, 2).map((session, index) =>
    createWorkbenchTab(`takeover-original-${index}`, { regionId: `takeover-original-region-${index}`,
      kind: 'agent', phase: 'attached', workspaceId, sessionId: session.id }))
  useAppStore.setState({ tabs: { ...state.tabs, ...Object.fromEntries(seeded.map(tab => [tab.id, tab])) },
    layouts: { ...state.layouts, [workspaceId]: createWorkspaceLayout('takeover-original-group',
      [...Object.values(state.tabs).filter(tab => tab.workspaceId === workspaceId).map(tab => tab.id), ...seeded.map(tab => tab.id)]) } })
}
function origin(index: number) {
  const id = nativeSnapshot.sessions[index]!.id, state = useAppStore.getState()
  const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === id))!
  if (!tab) throw new Error('Original fixture Agent has no actual production Workbench Region')
  const region = Object.values(tab.regions).find(region => region.kind === 'agent' && region.sessionId === id)!
  const group = state.layouts[workspaceId]!.groups.find(group => group.tabOrder.includes(tab.id))!
  return { tabId: tab.id, regionId: region.regionId, groupId: group.id, workspaceId, sessionId: id }
}
const initialOrigins = [origin(0), origin(1)]
if (!boot) {
  useAppStore.getState().renameAgent(initialOrigins[0].sessionId, 'Implementation coordinator')
  useAppStore.getState().renameAgent(initialOrigins[1].sessionId, 'Independent reviewer')
  for (const source of initialOrigins) useAppStore.getState().setAgentComposerDraft(source.sessionId, 'Unsent original draft — keep this work and its exact source.')
  await bridge.saveRuntime({ config, snapshot: nativeSnapshot, creations })
}
function focus(index: number) {
  const source = initialOrigins[index]
  flushSync(() => {
    useAppStore.getState().activateTab(workspaceId, source.groupId, source.tabId)
    useAppStore.getState().focusRegion(workspaceId, source.tabId, source.regionId, 'pointer', source.groupId)
  })
  return source
}
for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : null
  trusted.push({ type, key: event instanceof KeyboardEvent ? event.key : null, trusted: event.isTrusted, tag: target?.tagName, class: target?.className, executor: target?.closest('[data-executor-id]')?.getAttribute('data-executor-id'),
    takeover: Boolean(target?.closest('.session-takeover')), menu: Boolean(target?.closest('.agent-region-menu')) })
}, true)
const root = createClientUiRoot(document.getElementById('root')!)
let focusProjection = false
function render() {
  const source = initialOrigins[0]
  flushSync(() => root.render(<>
    <section hidden={!focusProjection} style={{ width: focusProjection ? '100%' : 0, height: '100%', display: focusProjection ? 'flex' : 'none', flexDirection: 'column' }} aria-label="Original Workbench View in Focus">
      <div id="takeover-focus-slot-header" className="focus-workspace__header" style={{ minHeight: 36, display: 'flex', justifyContent: 'flex-end' }} />
      <div id="takeover-focus-slot" style={{ flex: 1, minHeight: 0, display: 'flex' }} />
    </section>
    <div style={{ width: focusProjection ? 0 : '100%', height: '100%', overflow: 'hidden' }}>
      <WorkspaceWorkbench workspaceId={workspaceId} viewTargets={focusProjection ? { [source.tabId]: [{
        hostId: 'takeover-focus-slot', headerPortalTargetId: 'takeover-focus-slot-header', active: true, visible: true, surface: 'focus',
        reference: { displayWorkspaceId: workspaceId, groupId: source.groupId, tabId: source.tabId, regionId: source.regionId }
      }] } : undefined} />
    </div>
  </>))
}
render()
if (!boot) focus(0)
function facts() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
    sessions: state.sessions.map(session => ({ id: session.id, control: session.control })),
    requests: state.spatialRequests, origins: initialOrigins, launches: [...launches], trusted: [...trusted], flushes: [...flushes],
    workbenchSaveWarning: state.workbenchSaveWarning, persisted: localStorage.getItem('agentmux-workbench-v1'), bootRestored: Boolean(boot) }
}
Object.assign(window, { takeoverProbe: {
  focus, facts, terminalFacts, appearance: applyAppAppearance, failure(value: boolean) { failureMode = value },
  focusProjection(value: boolean) { focusProjection = value; render(); return true },
  async seal() {
    // A production read saves no replacement topology. flush() commits the already
    // admitted executeControl/presentation writer, then Chromium flushes its real profile.
    await bridge.saveRuntime({ config, snapshot: nativeSnapshot, creations })
    await bridge.flush()
    return facts()
  }
} })
document.documentElement.dataset.takeoverReady = boot ? 'restored' : 'first'
