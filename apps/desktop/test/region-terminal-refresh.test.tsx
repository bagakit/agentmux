// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxTerminalViewObservation } from '@agentmux/core/control'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { AgentLifecycleFeedback } from '../src/renderer/src/components/AgentLifecycleFeedback'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation, registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Browser xterm open/parser/buffers/selection and owner-size adoption are real; layout, addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null, refresh: null as (() => Promise<void>) | null }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    refresh() {}
    focus() {}
    onRender = () => ({ dispose() {} })
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', async () => {
  const { TerminalViewportSynchronizer } = await vi.importActual<typeof import('../src/renderer/src/lib/terminal-viewport-sync')>('../src/renderer/src/lib/terminal-viewport-sync')
  // Actual owner-size adoption and xterm resize; only synthetic DOM fit scheduling is excluded.
  return { TerminalViewportSynchronizer: class extends TerminalViewportSynchronizer {
    observeViewport() {} async startLiveSynchronization() {}
  } }
})
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const originalState = useAppStore.getState()
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: 'observed-agent', hostId: 'local', workspacePath: '/synthetic', label: 'Observed', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'observed-agent', run: { runId: 'observed-run' } }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'observed-region' }
let root: Root
let container: HTMLElement
let releases: (() => void)[]
let attach: MockInstance<typeof api.sessions.attach>
let write: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof api.sessions.recover>
let resize: MockInstance<typeof api.sessions.resize>

function surfaceState(current: SessionSnapshot = session, regionId = origin.regionId) {
  const tab = createWorkbenchTab(origin.tabId, { regionId, kind: current.kind, phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config: null, closingWorkbenchViews: {}, regionCaretFocus: null })
}
async function inspect(regionId = origin.regionId) {
  const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
    requestId: 'inspect-observed', operation: 'inspect.region', target: { kind: 'region', regionId } })
  expect(result.operation).toBe('inspect.region')
  if (result.operation !== 'inspect.region') throw new Error('Unexpected real Control operation')
  return result.region
}
function replay(data: string): SessionAttachResult {
  return { attachmentId: 'observed-attachment', session: { ...session, latestOutputBytes: data.length }, currentSize: { cols: 80, rows: 24 }, gap: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
async function render(current: SessionSnapshot = session, props: { visible?: boolean; readOnly?: boolean; regionId?: string } = {}) {
  await act(async () => root.render(createElement(TerminalView, { session: current, themeId: 'graphite',
    interactiveResize: false, visible: props.visible ?? true, readOnly: props.readOnly ?? false, autoFocus: false,
    linkOrigin: { ...origin, regionId: props.regionId ?? origin.regionId }, onObservationRefresh: refresh => { fixture.refresh = refresh } })))
}
async function ready(data: string) {
  attach.mockResolvedValue(replay(data))
  await render()
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)))
  expect(fixture.terminals).toHaveLength(1)
  return fixture.terminals[0]!
}
const lines = Array.from({ length: 600 }, (_, i) => `private-${i}\r\n`).join('')
function observed(runId = session.control.run.runId): AgentMuxTerminalViewObservation {
  return { runId, sampledAt: 1, visible: true, readOnly: false, liveReady: true, acceptsInput: true,
    viewGrid: { cols: 80, rows: 24 }, buffer: { type: 'normal', baseY: 10, viewportY: 5, length: 34 }, mouseTrackingMode: 'any' }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('xterm-char-measure-element') ? 256 : 640 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 640, height: 384, right: 640, bottom: 384, toJSON() {} })
  fixture.terminals.length = 0; fixture.receive = null; releases = []
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(lines))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(receive => { fixture.receive = receive; return () => { fixture.receive = null } })
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  resize = vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  recover = vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  surfaceState()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  releases.forEach(release => release())
  useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})


function refreshButton(): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('button')].filter(b => b.textContent === 'Refresh observation')
  expect(buttons.length).toBeGreaterThan(0)
  return buttons.at(-1)!
}
function frozenState() {
  const state = useAppStore.getState()
  return structuredClone({ draft: state.agentComposerDrafts, queues: state.agentSteerQueues, sending: state.agentSteerInFlight,
    tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

it('actual attach failure remains in its Region with the readable cause and unknown delivery; clicking refresh consumes a live attachment result', async () => {
  attach.mockRejectedValueOnce(new Error('Native observation registration failed'))
  await render()
  await act(async () => await vi.waitFor(() => expect(container.textContent).toContain('Native observation registration failed')))
  expect(container.textContent).toContain('input delivery are unconfirmed')
  const terminal = fixture.terminals[0]!
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).not.toContain('Attach failed')
  const metadata = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue({ ...replay('ACTUAL REFRESH OUTPUT'),
    terminal: { type: 'basic-vt', checkpoint: { runId: session.control.run.runId, throughByte: 0, resizeRevision: 0,
      size: { cols: 80, rows: 24 } }, restoreBytes: new Uint8Array(), resizes: [] } })
  await act(async () => { refreshButton().click(); await fixture.refresh!() })
  expect(container.textContent).not.toContain('Native observation registration failed')
  expect(metadata).toHaveBeenCalledExactlyOnceWith(session.control)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(session.control, null, 0)
  expect(fixture.terminals).toEqual([terminal])
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('ACTUAL REFRESH OUTPUT')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('refresh failure keeps the original nonempty history, viewport, draft, message identities and lease; repeat clicks reuse the in-flight attempt', async () => {
  const terminal = await ready(lines)
  await act(async () => terminal.scrollToLine(300))
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  const pending = deferred<SessionAttachResult>()
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockReturnValueOnce(pending.promise)
  useAppStore.setState({ agentComposerDrafts: { [session.id]: 'exact unsent draft' }, agentSteerQueues: {
    [session.id]: [{ operationId: 'unknown-input', text: 'exact bytes', enqueuedAt: 1, runId: session.control.run.runId,
      status: 'deferred', error: 'delivery unconfirmed', submissionAttempted: true } as never] } })
  const before = frozenState(), history = terminal.buffer.active.length
  await act(async () => { refreshButton().click(); refreshButton().click(); await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce()) })
  expect(attach).toHaveBeenCalledOnce(); expect(api.sessions.detach).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ ...replay('must not replace retained history'),
    terminal: { type: 'unavailable', reason: 'source_gap' }, session: { ...session, latestOutputBytes: lines.length } })
    await fixture.refresh!() })
  expect(fixture.terminals).toEqual([terminal]); expect(terminal.buffer.active.length).toBe(history)
  expect(terminal.buffer.active.viewportY).toBe(300)
  expect(terminal.buffer.active.getLine(300)?.translateToString(true)).toBe('private-300')
  expect(frozenState()).toEqual(before)
  expect(container.textContent).toContain('state could not be continued')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  refresh.mockRejectedValueOnce(new Error('Run observed-run does not exist in this Runtime'))
  await act(async () => { refreshButton().click(); await fixture.refresh!() })
  expect(container.textContent).toContain('Run observed-run does not exist in this Runtime')
  expect(frozenState()).toEqual(before)
  expect(terminal.buffer.active.viewportY).toBe(300); expect(api.sessions.detach).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
})

it('same-subject lifecycle failure stays visible after a different global notice or inbox dismissal and is wired to the Region refresh action', async () => {
  const retry = vi.fn(), refresh = vi.fn()
  useAppStore.setState({ error: 'actual resume registration failure', errorDismissed: false,
    errorNoticeContext: { lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } } as never })
  const show = async (current = session) => act(async () => root.render(createElement(AgentLifecycleFeedback,
    { owner: { subject: current.control as typeof session.control }, retry, refreshObservation: refresh })))
  await show()
  expect(container.textContent).toContain('actual resume registration failure')
  await act(async () => useAppStore.setState({ error: 'unrelated notification', errorDismissed: true, errorNoticeContext: null }))
  expect(container.textContent).toContain('actual resume registration failure')
  expect(container.textContent).not.toContain('unrelated notification')
  await act(async () => refreshButton().click())
  expect(refresh).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled()
  await show({ ...session, control: { ...session.control, run: { runId: 'new-run' } } })
  expect(container.textContent).not.toContain('actual resume registration failure')
})

it.each([{ type: 'unknown', reason: 'origin_unknown' }, { type: 'unavailable', reason: 'source_gap' }] as const)(
  '$type refresh with a different owner size preserves real xterm history, viewport and nonempty selection', async (absence) => {
  const terminal = await ready(lines)
  await act(async () => { terminal.scrollToLine(300); terminal.select(0, 300, 'private-300'.length) })
  expect(terminal.getSelection()).toBe('private-300')
  const before = { cols: terminal.cols, rows: terminal.rows, viewportY: terminal.buffer.active.viewportY,
    selected: terminal.getSelection(), lines: Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)) }
  expect(before.lines).toContain('private-300')
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue({ ...replay('wrong geometry tail'),
    currentSize: { cols: 40, rows: 10 }, terminal: absence,
    session: { ...session, latestOutputBytes: lines.length } })
  await act(async () => await fixture.refresh!())
  expect({ cols: terminal.cols, rows: terminal.rows, viewportY: terminal.buffer.active.viewportY,
    selected: terminal.getSelection(), lines: Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)) }).toEqual(before)
  expect(container.textContent).toContain('state could not be continued')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('a refresh revealing a previously unobserved historical resize keeps the existing canvas and discloses unknown continuity', async () => {
  const terminalState = { type: 'basic-vt' as const, checkpoint: { runId: session.control.run.runId,
    throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 } }, restoreBytes: new Uint8Array(), resizes: [] }
  attach.mockResolvedValue({ ...replay(lines), terminal: terminalState })
  await render()
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId,
    sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)))
  const terminal = fixture.terminals[0]!, previousLine = terminal.buffer.active.getLine(300)?.translateToString(true)
  expect(previousLine).toBe('private-300')
  const length = terminal.buffer.active.length
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue({ ...replay(lines + 'late'), resizeRevision: 1,
    terminal: { ...terminalState, resizes: [{ run: session.control.run, throughByte: 1, resizeRevision: 1,
      size: { cols: 40, rows: 10 } }] } })
  await act(async () => await fixture.refresh!())
  expect(fixture.terminals).toEqual([terminal])
  expect(terminal.buffer.active.length).toBe(length)
  expect(terminal.buffer.active.getLine(300)?.translateToString(true)).toBe(previousLine)
  expect(terminal.buffer.active.getLine(length - 1)?.translateToString(true)).not.toContain('late')
  expect(container.textContent).toContain('state could not be continued')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('observation-origin fresh metadata is projected after the actual Core publisher without draining old input, while independent completion keeps automatic intent', async () => {
  const { AgentMuxClient } = await import('../../../packages/core/src/client.js')
  const { AgentMuxMemoryAgentSessionStore } = await import('../../../packages/core/src/agent-session-store.js')
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored = { kind: 'agent' as const, agentSessionId: session.id, providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [],
    createdAt: 1, updatedAt: 3, hookToken: 'private-token', hookBindingId: 'private-binding',
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 2 },
    terminalOutputChannel: { state: 'severed' as const, mode: 'degraded' as const, reason: 'reattach-failed' as const,
      run: session.control.run, observedAt: 3 } }
  await store.compareAndSwap(null, stored)
  const core = new AgentMuxClient({ store })
  const inner = core as never as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: unknown }
  inner.connected = true; await inner.registry.load('local')
  const originalKernel = inner.kernel
  const attached = { run: { runId: session.control.run.runId, lifecycleOperationId: null, program: 'codex', args: [],
    workspacePath: session.workspacePath, pid: 1234, state: { type: 'running' as const }, cols: 80, rows: 24,
    firstAvailableByte: 0, latestOutputBytes: 0, acceptedInputBytes: 0 }, replay: [], gap: null,
    terminal: { type: 'unknown' as const, reason: 'origin_unknown' as const }, resizeRevision: 0 }
  inner.kernel = { isConnected: () => true, attach: async (_id: string, _byte: number, beforeLive: (value: typeof attached) => void) => {
    beforeLive(attached); return attached }, detach: async () => {} }
  useAppStore.setState({ sessions: [{ ...session, status: { state: 'working', source: 'native-hook', observedAt: 1 } }],
    agentComposerDrafts: { [session.id]: 'exact draft' }, agentSteerInFlight: { [session.id]: 'sending-3' }, agentSteerQueues: { [session.id]: [
      { operationId: 'queued-1', text: 'queued bytes', enqueuedAt: 1, runId: session.control.run.runId, status: 'queued', promptCondition: null },
      { operationId: 'unknown-2', text: 'unknown bytes', enqueuedAt: 2, runId: session.control.run.runId, status: 'deferred',
        error: 'delivery unconfirmed' },
      { operationId: 'sending-3', text: 'sending exact bytes', enqueuedAt: 3, runId: session.control.run.runId,
        status: 'queued', promptCondition: { expectedRun: session.control.run, afterSubmissionId: null } }
    ] as never } })
  const before = frozenState(), submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  const wake = vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue')
  const projected: unknown[] = []
  const off = core.onEvent(event => { projected.push(event); useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event }) })
  try {
    await core.refreshRunAttachment(session.control.run, 0, 'terminal', 'core-observation')
    expect(projected).toHaveLength(2)
    expect(useAppStore.getState().sessions[0]!.status.state).toBe('done')
    expect(frozenState()).toEqual(before)
    expect(wake).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    wake.mockResolvedValue(undefined)
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: session.id,
      state: 'done', evidence: { source: 'native-hook', observedAt: 4, run: session.control.run } } })
    expect(wake).toHaveBeenCalledExactlyOnceWith(session.id)
  } finally { off(); inner.kernel = originalKernel; await core.dispose() }
})

it('actual SessionPane lifecycle action reaches its existing TerminalView callback and preserves draft through observation failure', async () => {
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
    executors: { codex: { providerId: 'codex', label: 'Private Agent', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [], appearance: { terminalTheme: 'graphite' } } as never,
    agentComposerDrafts: { [session.id]: 'preserved Region draft' }, error: 'actual prior resume failure', errorDismissed: true,
    errorNoticeContext: { lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } } as never })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockRejectedValueOnce(new Error('actual output observation unavailable'))
  await act(async () => root.render(createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent',
    interactiveResize: false, visible: true, linkOrigin: origin })))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id,
    runId: session.control.run.runId })?.liveReady).toBe(true)))
  const before = frozenState(), terminal = fixture.terminals[0]!
  const action = container.querySelector<HTMLButtonElement>('.agent-launch-notice button')
  expect(action?.textContent).toBe('Refresh observation')
  await act(async () => { action!.click(); await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce()) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(container.textContent).toContain('actual output observation unavailable')
  expect(container.textContent).toContain('actual prior resume failure')
  expect(refresh).toHaveBeenCalledExactlyOnceWith(session.control, 'observed-attachment', lines.length)
  expect(frozenState()).toEqual(before)
  expect(fixture.terminals).toEqual([terminal]); expect(recover).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

it('an Activity Region keeps its lifecycle cause but offers no output-refresh action without a mounted observer', async () => {
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
    executors: { codex: { providerId: 'codex', label: 'Private Agent', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [], appearance: { terminalTheme: 'graphite' } } as never,
    viewModes: { [session.id]: 'activity' }, error: 'actual resume failure without an output observer', errorDismissed: false,
    errorNoticeContext: { lifecycle: { step: 'resume', subject: session.control, lastProcessState: 'running' } } as never })
  const metadata = vi.spyOn(api.sessions, 'refresh'), refresh = vi.spyOn(api.sessions, 'refreshAttachment')
  await act(async () => root.render(createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent',
    interactiveResize: false, visible: true, linkOrigin: origin })))
  expect(container.querySelector('[data-agent-surface-mode="activity"]')).not.toBeNull()
  expect(container.textContent).toContain('actual resume failure without an output observer')
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Refresh observation')).toEqual([])
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Retry Resume')).toHaveLength(1)
  expect(fixture.terminals).toEqual([])
  expect(attach).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled()
})

it('late observation reply after a subject change releases only the old lease and cannot replace the new Region display', async () => {
  const old = await ready(lines), pending = deferred<SessionAttachResult>()
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockReturnValue(pending.promise)
  await act(async () => { refreshButton().click(); await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce()) })
  const next = { ...session, control: { ...session.control, run: { runId: 'new-run' } } }
  attach.mockResolvedValue({ ...replay('NEW RUN DISPLAY'), session: { ...next, latestOutputBytes: 15 }, attachmentId: 'new-attachment' })
  surfaceState(next)
  await render(next)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: next.id,
    runId: next.control.run.runId })?.liveReady).toBe(true)))
  const terminal = fixture.terminals.at(-1)!
  expect(fixture.terminals).toHaveLength(2); expect(terminal).not.toBe(old)
  await act(async () => { pending.resolve({ ...replay('LATE OLD BYTES'), session }); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('NEW RUN DISPLAY')
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).not.toContain('LATE OLD')
  expect(api.sessions.detach).toHaveBeenCalledExactlyOnceWith('observed-attachment')
  expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('new-run')
})
