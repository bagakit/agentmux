import React from 'react'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import type { RuntimeEvent, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

// Only preview API facts are controlled. The production pane, terminal, input handlers and CSS run unchanged.
await useAppStore.getState().initialize()
const originals = (await api.sessions.snapshot()).sessions.filter(s => s.kind === 'agent').slice(0, 2)
if (originals.length !== 2) throw new Error('The scene requires two distinct preview Agent Sessions')
const workspaceId = useAppStore.getState().config!.workspaces[0]!.id
const tabId = 'result-input-tab', regionId = 'result-input-owner', neighborId = 'result-input-neighbor'
const root = createRoot(document.getElementById('root')!)
const output = Array.from({ length: 100 }, (_, i) => `Original terminal history ${String(i + 1).padStart(3, '0')}`).join('\r\n') + '\r\nagent > half typed prompt'
const outputBytes = new TextEncoder().encode(output)
const writes: unknown[] = [], pastes: unknown[] = [], resizes: unknown[] = [], inputs: unknown[] = [], routes: unknown[] = []
const cursors = new Map<string, number>()
const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
const attach = api.sessions.attach, resize = api.sessions.resize
let generation = 0, degraded = false
api.sessions.onEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.sessions.attach = async (...args) => {
  const base = await attach(...args)
  const control = args[0], current = useAppStore.getState().sessions.find(session => session.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))
  const attached = { ...base, session: current ?? base.session }, runId = attached.session.control.run.runId
  cursors.set(runId, outputBytes.length)
  return { ...attached, session: { ...attached.session, latestOutputBytes: outputBytes.length },
    currentSize: { cols: 80, rows: 24 }, resizeRevision: 0,
    terminal: degraded ? { type: 'unknown' as const, reason: 'origin_unknown' as const }
      : { type: 'basic-vt' as const, checkpoint: { runId, throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 } }, restoreBytes: new Uint8Array(), resizes: [] },
    replay: [{ type: 'data' as const, runId, startByte: 0, endByte: outputBytes.length, data: output, dataBytes: outputBytes }], gap: null }
}
function echo(control: Parameters<typeof api.sessions.write>[0], text: string) {
  const runId = control.run.runId, startByte = cursors.get(runId)!
  if (!Number.isFinite(startByte)) throw new Error('The original attached Run must own the output cursor')
  const dataBytes = new TextEncoder().encode(text), endByte = startByte + dataBytes.length
  cursors.set(runId, endByte)
  const event: RuntimeEvent = { type: 'core', hostId: control.hostId, event: {
    type: 'terminal-output', run: control.run, ...(control.kind === 'agent' ? { agentSessionId: control.agentSessionId } : {}),
    data: text, dataBytes, evidence: { source: 'terminal-output', observedAt: Date.now(), run: control.run, outputByteRange: { startByte, endByte } }
  } }
  for (const listener of listeners) listener(event)
}
api.sessions.write = async (control, data, source) => {
  writes.push({ control, data: typeof data === 'string' ? data : Array.from(data), source })
  echo(control, typeof data === 'string' ? data : String.fromCharCode(...data))
}
api.sessions.paste = async (control, text, terminalData) => { pastes.push({ control, text, terminalData }); echo(control, terminalData) }
api.sessions.resize = async (...args) => { resizes.push(args); return resize(...args) }
api.ui.readClipboardText = async () => ' bounded paste'
api.continuousProgress.list = async () => []
const gitCalls: unknown[] = []
Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: {
  status: async (id: string) => { gitCalls.push(['status', id]); return { kind: 'git-repository', hostId: 'local', repoPath: originals[0]!.workspacePath,
    repoRelativePrefix: '', branch: 'main', changes: [{ path: 'result.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }] } },
  diff: async (...args: unknown[]) => { gitCalls.push(['diff', ...args]); return { path: 'result.txt', old: { present: true, binary: false, text: 'before\n' }, new: { present: true, binary: false, text: 'after\n' }, binary: false, change: 'modified' } }
} } })
const openFileDiff = useAppStore.getState().openFileDiff, openHttpLink = useAppStore.getState().openHttpLink
useAppStore.setState({
  openFileDiff: async (...args) => { routes.push(['diff', ...args]); await openFileDiff(...args) },
  openHttpLink: async (...args) => { routes.push(['preview', ...args]); await openHttpLink(...args) }
})
for (const type of ['keydown', 'beforeinput', 'input', 'pointerdown', 'click', 'focusin']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : null
  if (!target?.closest('.agent-surface, .terminal-context-menu')) return
  inputs.push({ type, trusted: event.isTrusted, key: (event as KeyboardEvent).key,
    label: target.closest('button, [role="menuitem"]')?.textContent?.trim(),
    terminal: target.classList.contains('xterm-helper-textarea'), composer: Boolean(target.closest('.composer [role="textbox"]')) })
}, true)
const probe = {
  workspaceId, tabId, regionId, neighborId, sessionId: originals[0]!.id,
  seed(mode: 'healthy' | 'degraded' | 'readonly' = 'healthy') {
    degraded = mode === 'degraded'
    const sessions = structuredClone(originals).map(session => ({ ...session, pendingInteraction: undefined,
      processState: 'running' as const, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
    let tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[0]!.id })
    tab = addWorkbenchRegion(tab, regionId, 'right', { regionId: neighborId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[1]!.id })
    flushSync(() => useAppStore.setState({ sessions, tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('result-input-group', [tabId]) },
      activeWorkspaceId: workspaceId, mainSurface: 'workbench', retainedSpatialFocus: null,
      viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])), pendingAgentLaunches: {}, error: null,
      agentNames: { [sessions[0]!.id]: 'Original Agent', [sessions[1]!.id]: 'Neighbor Agent' },
      timelines: { [sessions[0]!.id]: { agentSessionId: sessions[0]!.id, revision: 1, items: [{
        id: 'result-preview', kind: 'assistant_message', status: 'complete', source: 'native-hook',
        content: 'Preview https://preview.example.test/result', createdAt: 1, updatedAt: 1
      }] } }, agentComposerDrafts: { [sessions[0]!.id]: 'This original draft stays unsent while the Agent result becomes ready.', [sessions[1]!.id]: 'Neighbor draft' } }))
    generation += 1
    flushSync(() => root.render(<React.Fragment key={generation}>
      {mode === 'readonly' ? <div style={{ width: '100%', height: '100%' }}><SessionPane sessionId={sessions[0]!.id} surfaceKind="agent" interactiveResize={false} visible readOnly
        linkOrigin={{ workspaceId, tabId, regionId }} /></div> : <WorkspaceWorkbench workspaceId={workspaceId} />}
      <span hidden data-result-input-generation={generation} />
    </React.Fragment>))
    return generation
  },
  done() { flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === originals[0]!.id
    ? { ...session, status: { state: 'done', source: 'native-hook', observedAt: Date.now() } } : session) }))) },
  working() { flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === originals[0]!.id
    ? { ...session, status: { state: 'working', source: 'native-hook', observedAt: Date.now() } } : session) }))) },
  visible(value: boolean) {
    flushSync(() => root.render(<React.Fragment key={generation}><WorkspaceWorkbench workspaceId={workspaceId} visible={value} />
      <span hidden data-result-input-generation={generation} /></React.Fragment>))
  },
  facts() {
    const state = useAppStore.getState()
    return { sessions: state.sessions.map(session => ({ id: session.id, control: session.control, processState: session.processState })),
      tab: state.tabs[tabId], layout: state.layouts[workspaceId], drafts: state.agentComposerDrafts, writes, pastes, resizes, inputs, routes, gitCalls,
      nativeOverlays: state.nativeSurfaceOverlayCount, tabs: state.tabs, editorDiffs: state.editorRegionDiffs }
  },
  terminal() {
    const element = document.querySelector(`[data-workbench-region-id="${regionId}"] .xterm`) ?? document.querySelector('.xterm')
    const records = (window as any).resultReadyTerminals as Array<{ id: number; disposed: boolean; terminal: any }>
    const record = records?.find(record => record.terminal.element === element && !record.disposed)
    if (!record) throw new Error('The actual original xterm is absent')
    const buffer = record.terminal.buffer.active
    return { id: record.id, cols: record.terminal.cols, rows: record.terminal.rows, baseY: buffer.baseY, viewportY: buffer.viewportY,
      cursorX: buffer.cursorX, cursorY: buffer.cursorY,
      cursorLine: buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true),
      visibleLines: Array.from({ length: record.terminal.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '') }
  }
}


// The service scene runs the same actual Workspace/Session/Terminal consumers. Only API facts are controlled.
let serviceMode = 'projection', annotationReason = 'Marker synchronization denied. FINAL ANNOTATION CAUSE.', annotationAttempts = 0
const originalSession = () => useAppStore.getState().sessions.find(session => session.id === originals[0]!.id)!
const browser = { kind: 'browser' as const, regionId: neighborId, browserId: 'service-browser', workspaceId,
  navigationId: 'service-document', profileId: 'default', url: 'about:blank', title: 'Retained page',
  loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const,
  driving: false, appLinkPrompt: null, error: null }
api.browser.setAnnotationMarkers = async () => { annotationAttempts += 1; if (annotationReason) throw new Error(annotationReason) }
api.sessions.refresh = async () => { throw new Error('Projection read unavailable. FINAL PROJECTION CAUSE.') }
const recoveries: unknown[] = []
api.sessions.recover = async control => { recoveries.push(control); throw new Error('Resume observation did not complete. FINAL LIFECYCLE CAUSE.') }
function projection(message: string) {
  const session = originalSession()
  flushSync(() => useAppStore.setState({ error: null, lastError: null, errorNoticeContext: null,
    pendingAgentLaunches: { [session.id]: { events: [], overflowed: false,
      created: { hostId: session.hostId, agentSessionId: session.id, run: session.control.run } as never,
      projectionFailures: [{ step: 'session', message }] } } }))
}
function lifecycle(message: string) {
  const session = originalSession()
  flushSync(() => useAppStore.setState({ pendingAgentLaunches: {}, error: message, lastError: message,
    errorNoticeContext: { lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } } as never }))
}
function currentNotice() {
  if (serviceMode === 'projection') projection('Projection read unavailable. FINAL PROJECTION CAUSE.')
  else if (serviceMode === 'lifecycle') lifecycle('Resume observation did not complete. FINAL LIFECYCLE CAUSE.')
}
function renderCurrent() {
  flushSync(() => root.render(<React.Fragment key={generation}><WorkspaceWorkbench workspaceId={workspaceId} />
    <span hidden data-result-input-generation={generation} /></React.Fragment>))
}
const serviceProbe = {
  seed(mode = 'projection') {
    serviceMode = mode; annotationReason = 'Marker synchronization denied. FINAL ANNOTATION CAUSE.'; annotationAttempts = 0
    probe.seed()
    flushSync(() => useAppStore.setState(state => ({ tabs: { [tabId]: { ...state.tabs[tabId]!,
      regions: { ...state.tabs[tabId]!.regions, [neighborId]: browser } } },
      noticeReadReceipts: {}, pendingAgentLaunches: {}, error: null, lastError: null, errorNoticeContext: null })))
    currentNotice()
  },
  activate(mode: string) { serviceMode = mode; currentNotice() },
  projection, lifecycle,
  remount() { generation += 1; renderCurrent() },
  repeat() {
    if (serviceMode === 'projection') projection('Projection read unavailable. FINAL PROJECTION CAUSE. Diagnostic: cursor=' + Date.now())
    else lifecycle('Resume observation did not complete. FINAL LIFECYCLE CAUSE. Diagnostic: cursor=' + Date.now())
  },
  cause() {
    if (serviceMode === 'projection') projection('Projection access denied. NEW PROJECTION CAUSE.')
    else lifecycle('Resume access denied. NEW LIFECYCLE CAUSE.')
  },
  subject() {
    flushSync(() => useAppStore.setState(state => {
      const current = originalSession(), control = { ...current.control, run: { runId: current.control.run.runId + '-next' } }
      const sessions = state.sessions.map(session => session.id === current.id ? { ...session, control } : session) as SessionSnapshot[]
      if (serviceMode === 'projection') return { sessions, pendingAgentLaunches: { [current.id]: {
        events: [], overflowed: false, created: { hostId: current.hostId, agentSessionId: current.id, run: control.run } as never,
        projectionFailures: [{ step: 'session', message: 'Projection read unavailable. FINAL PROJECTION CAUSE.' }] } } }
      return { sessions, error: 'Resume observation did not complete. FINAL LIFECYCLE CAUSE.',
        lastError: 'Resume observation did not complete. FINAL LIFECYCLE CAUSE.',
        errorNoticeContext: { lifecycle: { step: 'resume', subject: control, lastProcessState: 'running' } } as never }
    }))
  },
  resolved() { flushSync(() => useAppStore.setState({ pendingAgentLaunches: {}, error: null, lastError: null, errorNoticeContext: null })) },
  focusMoved(value = true) {
    flushSync(() => useAppStore.setState({ retainedSpatialFocus: value
      ? { workspaceId, tabId, regionId: 'background-moved-region' } : null }))
  },
  annotationSuccess() { annotationReason = '' },
  annotationRepeat() {
    flushSync(() => useAppStore.setState(state => ({ browserAnnotationsByBrowserId: {
      ...state.browserAnnotationsByBrowserId, [browser.browserId]: [] } })))
  },
  visible: probe.visible,
  facts() { return { ...probe.facts(), receipts: useAppStore.getState().noticeReadReceipts,
    pending: useAppStore.getState().pendingAgentLaunches, error: useAppStore.getState().error,
    retainedSpatialFocus: useAppStore.getState().retainedSpatialFocus, annotationAttempts, recoveries } },
  terminal: probe.terminal
}
Object.assign(window, { resultReady: probe, serviceReady: serviceProbe })
createRoot(document.getElementById('global-notices')!).render(<GlobalSystemNotices />)
serviceProbe.seed()
