import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { formatRegionAddress } from '../../../src/renderer/src/lib/agent-address'
import '../../../src/renderer/src/styles/index.css'

// Only the existing public preview API boundary is synthetic. Production views, effects, xterm and CSS are actual.
await useAppStore.getState().initialize()
const originals = (await api.sessions.snapshot()).sessions.filter(s => s.kind === 'agent').slice(0, 2)
if (originals.length !== 2) throw new Error('Two actual preview Session consumers are required')
const workspaceId = useAppStore.getState().config!.workspaces[0]!.id
const root = createRoot(document.getElementById('root')!)
const output = Array.from({ length: 100 }, (_, n) => `OUTPUT ${String(n).padStart(3, '0')} ${n === 0 ? 'FIRST' : n === 50 ? 'MIDDLE' : n === 99 ? 'LATEST' : 'retained original byte line'}`).join('\r\n') + '\r\n'
const bytes = new TextEncoder().encode(output)
const originalAttach = api.sessions.attach, originalWrite = api.sessions.write, originalRefresh = api.sessions.refresh, originalRefreshAttachment = api.sessions.refreshAttachment, originalEvents = api.sessions.onEvent
let mode = 'normal', generation = 0, screenshots = 0, observationFailures = 0
const terminalEvents = new Set<{ listener: Parameters<typeof api.sessions.onEvent>[0]; control: Parameters<typeof api.sessions.onEvent>[1] }>()
api.sessions.onEvent = (listener, control) => {
  const registration = { listener, control }, dispose = originalEvents(listener, control)
  terminalEvents.add(registration)
  return () => { terminalEvents.delete(registration); dispose() }
}
const writes: unknown[] = [], refreshes: unknown[] = [], attachmentRefreshes: unknown[] = [], recoveries: unknown[] = [], actions: unknown[] = [], events: unknown[] = [], clipboard: string[] = []
const loops = originals.map(session => ({ loopId: 'loop-' + session.id, hostId: session.hostId, agentSessionId: session.id,
  providerId: session.providerId, workspacePath: session.workspacePath, intervalMs: 60_000, prompt: 'Continue the original task',
  nextCheckAt: 60_000, status: 'active' as const, lastOutcome: 'unknown' as const, lastDecision: 'Original automatic progress cause FINAL PROGRESS CAUSE' }))
api.ui.captureScreenshot = async () => { screenshots += 1; throw new Error('System capture forbidden in this private UI proof') }
api.ui.chooseFiles = async () => []
api.ui.writeClipboardText = async text => { clipboard.push(text) }
api.continuousProgress.list = async target => {
  if (mode === 'list-rejected') throw new Error('Original list cause FINAL LIST CAUSE')
  return ['progress-unknown', 'progress-action', 'progress-busy'].includes(mode) ? loops.filter(loop => loop.agentSessionId === target.agentSessionId) : []
}
api.continuousProgress.action = async (...args) => { actions.push(args); if (mode === 'progress-busy') return new Promise(() => {}); throw new Error('Original action cause FINAL ACTION CAUSE') }
api.continuousProgress.onChanged = () => () => {}
api.sessions.attach = async (...args) => {
  const attached = await originalAttach(...args), runId = attached.session.control.run.runId
  const session = { ...attached.session, latestOutputBytes: bytes.byteLength }
  const healthy = ['normal', 'list-rejected', 'progress-unknown', 'progress-action', 'progress-busy', 'lifecycle', 'unknown', 'readonly', 'observation'].includes(mode)
  return { ...attached, session, currentSize: mode === 'concurrent' ? null : { cols: 80, rows: 24 }, resizeRevision: 0,
    terminal: healthy ? { type: 'basic-vt' as const, checkpoint: { runId, throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 } }, restoreBytes: new Uint8Array(), resizes: [] }
      : { type: 'unknown' as const, reason: 'origin_unknown' as const },
    replay: [{ type: 'data' as const, runId, startByte: 0, endByte: bytes.byteLength, data: output, dataBytes: bytes }], gap: null }
}
api.sessions.write = async (...args) => { writes.push(args); await originalWrite(...args) }
api.sessions.refresh = async (...args) => {
  refreshes.push(args)
  const observed = await originalRefresh(...args)
  // Controlled Core observation marker remains uncertain until the explicitly failing attachment operation is retried.
  return mode === 'observation' && observationFailures > 0
    ? structuredClone(useAppStore.getState().sessions.find(session => session.id === observed.id)!) : observed
}
api.sessions.refreshAttachment = async (...args) => {
  attachmentRefreshes.push(args)
  if (mode === 'observation' && observationFailures > 0) {
    observationFailures -= 1
    throw new Error('Original attachment refresh cause FINAL ATTACHMENT CAUSE')
  }
  const attached = await originalRefreshAttachment(...args)
  // Exercise the original preview lease validation while keeping this fixture's known basic-vt boundary.
  return { ...attached, currentSize: { cols: 80, rows: 24 }, resizeRevision: 0,
    terminal: { type: 'basic-vt' as const, checkpoint: { runId: attached.session.control.run.runId, throughByte: args[2],
      resizeRevision: 0, size: { cols: 80, rows: 24 } }, restoreBytes: new Uint8Array(), resizes: [] }, replay: [], gap: null }
}
api.sessions.recover = async (...args) => {
  recoveries.push(args)
  const session = useAppStore.getState().sessions.find(session => session.control.kind === args[0].kind && session.control.run.runId === args[0].run.runId)
  if (!session) throw new Error('Original controlled resume target absent')
  return { kind: 'reattachable', session: structuredClone(session) }
}
for (const type of ['click', 'keydown', 'wheel']) document.addEventListener(type, event => events.push({ type, trusted: event.isTrusted,
  target: event.target instanceof Element ? event.target.className : '' }), true)
const probe = {
  mode(next: string, windowMode = false) {
    mode = next
    observationFailures = mode === 'observation' ? 1 : 0
    const sessions = structuredClone(originals).map(session => ({ ...session, pendingInteraction: undefined,
      processState: 'running' as const, status: { state: 'running' as const, source: 'run-process' as const, observedAt: Date.now() } }))
    if (mode === 'observation') sessions[0]!.terminalOutputChannel = { state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: sessions[0]!.control.run, observedAt: Date.now() }
    let tab = createWorkbenchTab('quality-tab', { regionId: 'quality-target', kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[0]!.id })
    if (windowMode) tab = addWorkbenchRegion(tab, 'quality-target', 'right', { regionId: 'quality-neighbor', kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[1]!.id })
    const lifecycle = ['lifecycle', 'unknown'].includes(mode)
    const pending = lifecycle ? { [sessions[0]!.id]: { events: [], overflowed: false,
      request: { executorId: sessions[0]!.executorId }, created: sessions[0]!.control,
      projectionFailures: [{ step: 'timeline' as const, message: 'Original accepted launch projection cause FINAL LAUNCH CAUSE' }] } } : {}
    flushSync(() => useAppStore.setState({ sessions, tabs: { 'quality-tab': tab }, layouts: { [workspaceId]: createWorkspaceLayout('quality-group', ['quality-tab']) },
      activeWorkspaceId: workspaceId, mainSurface: 'workbench', viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])),
      pendingAgentLaunches: pending, error: lifecycle ? 'Original recovery observation cause. '.repeat(7) + 'FINAL LIFECYCLE CAUSE' : null,
      errorDismissed: false, errorNoticeContext: lifecycle ? { kind: mode === 'unknown' ? 'indeterminate' : 'process-degraded',
        lifecycle: { step: 'resume', subject: sessions[0]!.control, lastProcessState: mode === 'unknown' ? 'interrupted' : 'running' } } : undefined,
      agentNames: { [sessions[0]!.id]: 'Original Agent — keep the precise identity while reading and restoring this workspace', [sessions[1]!.id]: 'Neighbor Agent' },
      agentComposerDrafts: { [sessions[0]!.id]: 'Preserved draft', [sessions[1]!.id]: 'Neighbor draft' } }))
    generation += 1
    flushSync(() => root.render(windowMode ? <WorkspaceWorkbench key={generation} workspaceId={workspaceId} /> :
      <div style={{ width: '100%', minWidth: 0, height: '100%' }}><SessionPane key={generation} sessionId={sessions[0]!.id} surfaceKind="agent" interactiveResize={false} visible readOnly={mode === 'readonly'}
        linkOrigin={{ workspaceId, tabId: 'quality-tab', regionId: 'quality-target' }} /></div>))
    return generation
  },
  terminal() {
    const element = document.querySelector('[data-workbench-region-id="quality-target"] .xterm') ?? document.querySelector('.xterm')
    const records = (window as any).qualityTerminals as Array<{ id: number; disposed: boolean; terminal: any }>
    const record = records?.find(record => record.terminal.element === element && !record.disposed)
    if (!record) return null
    const buffer = record.terminal.buffer.active
    return { id: record.id, cols: record.terminal.cols, rows: record.terminal.rows, viewportY: buffer.viewportY,
      visibleLines: Array.from({ length: record.terminal.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? ''),
      length: buffer.length, baseY: buffer.baseY }
  },
  selection() {
    const id = probe.terminal()?.id
    const records = (window as any).qualityTerminals as Array<{ id: number; disposed: boolean; terminal: any }>
    return records.find(record => record.id === id && !record.disposed)?.terminal.getSelection() ?? ''
  },
  arriveLifecycle() {
    const session = useAppStore.getState().sessions.find(session => session.id === originals[0]!.id)!
    flushSync(() => useAppStore.setState({ error: 'Original recovery observation cause. '.repeat(7) + 'FINAL LIFECYCLE CAUSE', errorDismissed: false,
      errorNoticeContext: { kind: 'indeterminate', lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'interrupted' } } }))
  },
  header(next: string) {
    probe.mode(next === 'readonly' ? 'readonly' : next === 'notice' ? 'unknown' : 'normal', next !== 'readonly')
    const name = next === 'long' || next === 'full' ? 'Original Agent — preserve the complete investigation name and precise Session while reading this wide Terminal' : 'Agent'
    flushSync(() => useAppStore.setState(state => ({ agentNames: { [originals[0]!.id]: name, [originals[1]!.id]: name },
      sessions: state.sessions.map(session => session.id === originals[1]!.id ? { ...session, providerId: originals[0]!.providerId, executorId: originals[0]!.executorId } : session) })))
    return name
  },
  paintFirstLine() {
    const terminal = probe.terminal(), session = useAppStore.getState().sessions.find(s => s.id === originals[0]!.id)!
    if (!terminal || terminal.cols < 20) throw new Error('Actual retained Terminal geometry required')
    const line = 'FIRST-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(Math.ceil(terminal.cols / 26)).slice(0, terminal.cols - 10) + '-END'
    const data = '\x1b[2J\x1b[H' + line, dataBytes = new TextEncoder().encode(data)
    const targets = [...terminalEvents].filter(r => r.control?.hostId === session.hostId && r.control.run.runId === session.control.run.runId)
    if (targets.length !== 1) throw new Error('Exactly one original Terminal event consumer required')
    targets[0]!.listener({ type: 'core', hostId: session.hostId, event: { type: 'terminal-output', run: session.control.run, data, dataBytes,
      evidence: { source: 'terminal-output', observedAt: Date.now(), run: session.control.run,
        outputByteRange: { startByte: bytes.byteLength, endByte: bytes.byteLength + dataBytes.byteLength } } } })
    return { line, cols: terminal.cols, ownerCount: targets.length, startByte: bytes.byteLength, endByte: bytes.byteLength + dataBytes.byteLength }
  },
  focusNeighbor() { flushSync(() => useAppStore.getState().focusRegion(workspaceId, 'quality-tab', 'quality-neighbor', 'pointer')) },
  facts() { return { generation, mode, writes, refreshes, attachmentRefreshes, recoveries, actions, events, screenshots,
    clipboard, regionAddress: formatRegionAddress('quality-target'), tab: useAppStore.getState().tabs['quality-tab'],
    draft: useAppStore.getState().agentComposerDrafts[originals[0]!.id], session: useAppStore.getState().sessions.find(session => session.id === originals[0]!.id)?.control } }
}
Object.assign(window, { qualityProbe: probe })
probe.mode('normal')
