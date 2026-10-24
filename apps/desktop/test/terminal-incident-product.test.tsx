const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { ClientIncidentIpcOwner } from '../src/main/client-incident-ipc'
import { AgentMuxControlServer } from '@agentmux/core'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxTerminalViewObservation } from '@agentmux/core/control'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { AgentLifecycleFeedback } from '../src/renderer/src/components/AgentLifecycleFeedback'
import { useSessionRestart } from '../src/renderer/src/components/SessionRestart'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation, registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { TERMINAL_REVEAL_DEADLINE_MS } from '../src/renderer/src/lib/terminal-reveal'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'

// Browser xterm open/parser/buffers/selection and owner-size adoption are real; layout, addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null, refresh: null as (() => Promise<void>) | null, diagnosticRegionFailure: false, contextLoss: null as (() => void) | null, renderListeners: [] as Array<() => void>,
  gpuReleaseFault: null as { listener: boolean; addon: boolean; first: unknown; second: unknown } | null }))
vi.mock('../src/renderer/src/lib/client-incident-recorder', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/lib/client-incident-recorder')>('../src/renderer/src/lib/client-incident-recorder')
  return { ...actual, createClientIncidentRecorder(input: Parameters<typeof actual.createClientIncidentRecorder>[0]) {
    return actual.createClientIncidentRecorder({ ...input, regionId: () => {
      if (fixture.diagnosticRegionFailure) throw Error('private diagnostic location unavailable')
      return input.regionId()
    } })
  } }
})
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options); fixture.terminals.push(this)
      Object.defineProperty(this, 'onRender', { value: (listener: (event: { start: number; end: number }) => void) => {
        const notify = () => listener({ start: 0, end: 23 })
        fixture.renderListeners.push(notify)
        return { dispose() { fixture.renderListeners = fixture.renderListeners.filter(item => item !== notify) } }
      } })
    }
    refresh() {}
    focus() {}
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {
  const fault = fixture.gpuReleaseFault
  if (fault?.addon) { fault.addon = false; throw fault.second }
} onContextLoss(listener: () => void) {
  fixture.contextLoss = listener
  return { dispose() {
    fixture.contextLoss = null
    const fault = fixture.gpuReleaseFault
    if (fault?.listener) { fault.listener = false; throw fault.first }
  } }
} } }))
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
  id: 'observed-agent', hostId: 'local', workspacePath: _hygiene_fixturePath("synthetic"), label: 'Observed', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 1, processState: 'running',
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
async function render(current: SessionSnapshot = session, props: { autoFocus?: boolean; visible?: boolean; readOnly?: boolean; regionId?: string } = {}) {
  await act(async () => root.render(createElement(TerminalView, { session: current, themeId: 'graphite',
    interactiveResize: false, visible: props.visible ?? true, readOnly: props.readOnly ?? false, autoFocus: props.autoFocus ?? false,
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
  // The shared Realm dispatcher consumes the actual preload transport, with a fresh owner per fixture.
  vi.stubGlobal('agentmux', { clientIncidents: {
    open: () => api.clientIncidents.open(),
    report: (...args: Parameters<typeof api.clientIncidents.report>) => api.clientIncidents.report(...args)
  } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '',
    measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 }) }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('xterm-char-measure-element') ? 256 : 640 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, width: 640, height: 384, right: 640, bottom: 384, toJSON() {} })
  fixture.terminals.length = 0; fixture.receive = null; fixture.diagnosticRegionFailure = false; fixture.contextLoss = null; fixture.renderListeners = []; fixture.gpuReleaseFault = null; releases = []
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
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
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
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((r, fail) => { resolve = r; reject = fail })
  return { promise, resolve, reject }
}

it('archives the real Terminal failure and frozen refresh before default-Host CLI discovery and original read', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? join(process.cwd(), 'packages/core/bin/amux'))
  const directory = await mkdtemp(join(tmpdir(), 'amx-terminal-incident-'))
  const archive = new ClientIncidentArchive(join(directory, 'archive'))
  await archive.flush()
  const frame = {}, contents = { isDestroyed: () => false, get mainFrame() { return frame } }
  const ipc = new ClientIncidentIpcOwner({ archive, contents: contents as never, windowId: 1, generation: () => 1,
    buildId: () => 'shell-build', rendererBuildId: () => 'renderer-build' })
  const event = { sender: contents, senderFrame: frame } as never
  vi.spyOn(api.clientIncidents, 'open').mockImplementation(async () => ipc.open(event))
  const delivery = vi.spyOn(api.clientIncidents, 'report').mockImplementation(async (token, report) => ipc.report(event, token, report))
  const capture = vi.spyOn(api.performance, 'captureScene')
  const initialError = Object.assign(new Error('private native error body'), { code: 'EIO' })
  attach.mockRejectedValueOnce(initialError)
  let server: AgentMuxControlServer | undefined, host: AgentMuxControlServer | undefined
  const clients: Array<{ dispose(): Promise<void> }> = []
  try {
    await render()
    await vi.waitFor(() => expect(delivery.mock.calls.filter(([, report]) => report.kind === 'terminal-attach-failed')).toHaveLength(1))
    const terminal = fixture.terminals[0]!
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('')
    const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue(replay('RECOVERED ORIGINAL OUTPUT'))
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
    const snapshotsBeforeRefresh: string[] = []
    refresh.mockImplementation(async () => {
      // The product's new request has already frozen the previous state before replacing the connection.
      snapshotsBeforeRefresh.push(JSON.stringify(delivery.mock.calls.map(([, report]) => report)))
      return replay('RECOVERED ORIGINAL OUTPUT')
    })
    await act(async () => { refreshButton().click(); await fixture.refresh!() })
    await vi.waitFor(() => expect(delivery.mock.calls.filter(([, report]) => report.stage === 'refresh-completed')).toHaveLength(1))
    await archive.flush()
    expect(fixture.terminals).toEqual([terminal])
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('RECOVERED ORIGINAL OUTPUT')
    expect(refresh).toHaveBeenCalledExactlyOnceWith(session.control, null, 0)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
    const reports = delivery.mock.calls.map(([, report]) => report)
    const failed = reports.find(report => report.kind === 'terminal-attach-failed')!
    const requested = reports.find(report => report.stage === 'refresh-requested')!
    const completed = reports.find(report => report.stage === 'refresh-completed')!
    expect(failed).toMatchObject({ code: 'EIO', hostId: 'local', agentSessionId: session.id, runId: session.control.run.runId,
      metadata: { liveReady: false, cursorBytes: 0 } })
    expect(requested.relatedOccurrenceId).toBe(failed.occurrenceId)
    expect(completed.relatedOccurrenceId).toBe(requested.occurrenceId)
    expect(snapshotsBeforeRefresh).toHaveLength(1)
    // Freezing is synchronous; async transport need not have acknowledged this new occurrence yet.
    expect(requested.metadata.cursorBytes).toBe(0)
    const desktopPath = join(directory, 'desktop.sock'), hostPath = join(directory, 'host.sock')
    server = new AgentMuxControlServer({ socketPath: desktopPath, coreClients: () => [], clientIncidents: () => archive })
    await server.start()
    const owner = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath } }); clients.push(owner)
    host = new AgentMuxControlServer({ socketPath: hostPath, coreClients: () => [],
      forwardControl: (method, params, context) => owner.call(method, params, context) })
    await host.start()
    const env = objectCliEnvironment(directory), prefix = ['--endpoint', `unix://${hostPath}`, 'system', 'diagnostics', 'inspect']
    const result = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--recent'], env)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.reads[0].availability).toBe('found')
    const page = JSON.parse(result.stdout).result.reads[0].data
    expect(page.kind).toBe('client-incident-page')
    expect(page.items).toHaveLength(3)
    expect(page.items.map((item: { stage: string }) => item.stage)).toContain('attach-failed')
    const first = page.items.find((item: { kind: string }) => item.kind === 'terminal-attach-failed')!
    const exact = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local',
      '--logid', first.recordRef.logId, '--authority', first.recordRef.authority.id], env)
    expect(exact.code, exact.stderr).toBe(0)
    const record = JSON.parse(exact.stdout).result.reads[0]
    expect(record).toMatchObject({ persistence: 'confirmed', data: { producer: { kind: 'renderer', buildId: 'renderer-build' }, report: failed } })
    expect(exact.stdout).not.toContain('private native error body')
    expect(exact.stdout).not.toContain('RECOVERED ORIGINAL OUTPUT')
    expect(exact.stdout).not.toContain(session.workspacePath)
  } finally {
    for (const client of clients.reverse()) await client.dispose()
    await host?.stop(); await server?.stop(); await archive.flush()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)


it('keeps the original Terminal error, reveal and refresh usable when diagnostic code or location observations fail', async () => {
  const current: SessionSnapshot = { ...session, kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: session.control.run.runId, run: session.control.run } }
  surfaceState(current)
  let getters = 0
  const error = Object.defineProperty(new Error('original output observation unavailable'), 'code', {
    get() { getters++; throw Error('private diagnostic code accessor') }
  })
  vi.spyOn(api.clientIncidents, 'open').mockResolvedValue({ token: 'original-producer' })
  const delivery = vi.spyOn(api.clientIncidents, 'report').mockResolvedValue({ accepted: true })
  attach.mockRejectedValueOnce(error)
  useAppStore.setState({ agentComposerDrafts: { [session.id]: 'original unsent draft' } })
  const before = frozenState()
  await render(current)
  await act(async () => await vi.waitFor(() => expect(container.textContent).toContain('original output observation unavailable')))
  expect(getters).toBe(0)
  expect(container.querySelector('.terminal-view__xterm--hydrating')).toBeNull()
  await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce())
  expect(delivery.mock.calls[0]![1]).toMatchObject({ code: null, metadata: { recorderReadFailures: 1 } })
  const terminal = fixture.terminals[0]!
  const metadata = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(current)
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue({ ...replay('ORIGINAL RECOVERED OUTPUT'), session: current })
  fixture.diagnosticRegionFailure = true
  await act(async () => {
    const completion = await fixture.refresh!().then(() => 'completed', () => 'rejected')
    expect(completion).toBe('completed')
  })
  expect(metadata).toHaveBeenCalledExactlyOnceWith(current.control)
  expect(refresh).toHaveBeenCalledExactlyOnceWith(current.control, null, 0)
  expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('ORIGINAL RECOVERED OUTPUT')
  expect(container.textContent).not.toContain('original output observation unavailable')
  expect(delivery).toHaveBeenCalledOnce()
  fixture.diagnosticRegionFailure = false
  await act(async () => await fixture.refresh!())
  await vi.waitFor(() => expect(delivery.mock.calls.some(([, report]) => (report.metadata.reporterDropped ?? 0) >= 2)).toBe(true))
  expect(frozenState()).toEqual(before)
  expect(fixture.terminals).toEqual([terminal])
  expect(attach).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  expect(getters).toBe(0)
  expect(JSON.stringify(delivery.mock.calls)).not.toContain('private diagnostic')
})

function reportSink() {
  vi.spyOn(api.clientIncidents, 'open').mockResolvedValue({ token: 'document-token' })
  return vi.spyOn(api.clientIncidents, 'report').mockResolvedValue({ accepted: true })
}
function output(startByte: number, data: string): RuntimeEvent {
  const dataBytes = new TextEncoder().encode(data)
  return { type: 'core', hostId: 'local', event: { type: 'terminal-output', agentSessionId: session.id, run: session.control.run,
    data, dataBytes, evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } }
}
it.each(['success', 'failure'] as const)('retains a pending reveal deadline and late original %s as distinct original observations', async outcome => {
  const sent = reportSink(), pending = deferred<SessionAttachResult>()
  attach.mockReturnValue(pending.promise)
  let deadline: (() => void) | undefined
  const timer = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === TERMINAL_REVEAL_DEADLINE_MS) deadline = callback
    return timer(callback, delay, ...args)
  }) as typeof setTimeout)
  await render()
  expect(deadline).toBeTypeOf('function')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TERMINAL_REVEAL_DEADLINE_MS + 1)
  await act(async () => deadline!())
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
  expect(sent.mock.calls[0]![1]).toMatchObject({ kind: 'terminal-reveal-deadline', metadata: { liveReady: false, revealed: false } })
  const deadlineReport = structuredClone(sent.mock.calls[0]![1])
  await act(async () => {
    if (outcome === 'success') pending.resolve(replay('late original output'))
    else pending.reject(Object.assign(new Error('private late attachment failure'), { code: 'EIO' }))
  })
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
  expect(sent.mock.calls[0]![1]).toEqual(deadlineReport)
  expect(sent.mock.calls[1]![1]).toMatchObject({ kind: outcome === 'success' ? 'terminal-recovered' : 'terminal-attach-failed',
    relatedOccurrenceId: deadlineReport.occurrenceId, attemptId: deadlineReport.attemptId,
    metadata: { liveReady: outcome === 'success', revealed: true } })
  expect(fixture.terminals).toHaveLength(1)
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it.each([0, 100])('freezes context, visibility and resize with %s unrelated Sessions and constant diagnostic reads', async unrelated => {
  const sent = reportSink(), terminal = await ready('original')
  for (const listener of [...fixture.renderListeners]) listener()
  const length = vi.spyOn(terminal.buffer.active, 'length', 'get')
  for (let i = 0; i < 1000; i++) for (const listener of [...fixture.renderListeners]) listener()
  expect(length).not.toHaveBeenCalled()
  expect(sent).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ sessions: [session, ...Array.from({ length: unrelated }, (_, i) => ({ ...session,
    id: `unrelated-${i}`, control: { ...session.control, agentSessionId: `unrelated-${i}`, run: { runId: `unrelated-run-${i}` } } }))] }))
  await render(session, { visible: false })
  await render(session, { visible: true })
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { type: 'terminal-resized',
    agentSessionId: session.id, run: session.control.run, throughByte: 8, resizeRevision: 1, cols: 81, rows: 24 } }))
  await vi.waitFor(() => expect(terminal.cols).toBe(81))
  length.mockClear()
  await act(async () => fixture.contextLoss!())
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
  const report = sent.mock.calls[0]![1]
  expect(report).toMatchObject({ kind: 'terminal-context-lost', metadata: { liveReady: true, visible: true, renderer: 'webgl', cols: 81 } })
  expect(report.stages.map(item => item.stage)).toEqual(expect.arrayContaining(['visibility', 'resize', 'replay-started', 'replay-applied', 'revealed', 'live-ready']))
  expect(report.metadata.renderCallbacks).toBe(1001)
  // One ring snapshot and one immutable trigger snapshot, independent of unrelated consumers.
  expect(length).toHaveBeenCalledTimes(2)
  expect(attach).toHaveBeenCalledTimes(1); expect(fixture.terminals).toHaveLength(1)
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('archives failed live history recovery and the actual output gap once per episode without closing healthy input', async () => {
  const sent = reportSink(), terminal = await ready('original')
  vi.spyOn(api.sessions, 'replay').mockRejectedValue(Object.assign(new Error('private history message'), { code: 'EIO' }))
  await act(async () => fixture.receive!(output(20, 'tail')))
  await vi.waitFor(() => expect(sent.mock.calls.map(([, report]) => report.kind)).toEqual(['terminal-replay-failed', 'terminal-output-gap']))
  await act(async () => fixture.receive!(output(40, 'later')))
  await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('later'))
  expect(sent).toHaveBeenCalledTimes(2)
  expect(sent.mock.calls[0]![1]).toMatchObject({ stage: 'replay-failed', code: 'EIO', metadata: { liveReady: true } })
  expect(JSON.stringify(sent.mock.calls)).not.toContain('private history message')
  await act(async () => terminal.input('x'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control, 'x', 'user', expect.objectContaining({ source: 'user' }))
  expect(recover).not.toHaveBeenCalled()
})

it('retains invalid reconnect replay separately from continuation absence and keeps its canvas', async () => {
  const sent = reportSink(), terminal = await ready('original')
  const run = { nativeService: null, runId: session.control.run.runId, kind: 'agent' as const, providerId: 'codex', executorId: 'codex',
    agentSessionId: session.id, workspacePath: session.workspacePath, pid: 123, state: 'running' as const,
    cols: 80, rows: 24, observedAt: 2, latestOutputBytes: 8, acceptedInputBytes: 0 }
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { type: 'terminal-snapshot', agentSessionId: session.id,
    afterByte: 8, run, terminal: { type: 'basic-vt', checkpoint: { runId: run.runId, throughByte: 8, resizeRevision: 3,
      size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
      restoreBytes: new Uint8Array(), resizes: [] }, replay: [], gap: null, resizeRevision: 4 } }))
  await vi.waitFor(() => expect(sent.mock.calls.some(([, report]) => report.kind === 'terminal-replay-failed')).toBe(true))
  expect(sent.mock.calls.find(([, report]) => report.kind === 'terminal-replay-failed')![1]).toMatchObject({ stage: 'replay-failed', code: 'CTXMUX_EVENT_INVALID' })
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('original')
  expect(attach).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('retains typed connection observations without upgrading unknown continuation to a byte gap', async () => {
  const sent = reportSink(), terminal = await ready('original')
  const evidence = { source: 'terminal-output' as const, observedAt: 2 }
  const core = { type: 'attachment-state' as const, run: session.control.run, agentSessionId: session.id, afterByte: 8, evidence }
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { ...core, state: 'unavailable',
    diagnostic: { code: 'ECONNRESET', message: 'private connection message' } } }))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
  const originalFailure = sent.mock.calls[0]![1]
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { ...core, state: 'restored' } }))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
  expect(sent.mock.calls[1]![1]).toMatchObject({ kind: 'terminal-recovered', stage: 'observation-restored', relatedOccurrenceId: originalFailure.occurrenceId })
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { type: 'terminal-snapshot', afterByte: 8,
    agentSessionId: session.id, run: { nativeService: null, ...session.control.run, kind: 'agent', providerId: 'codex', executorId: 'codex',
      agentSessionId: session.id, workspacePath: session.workspacePath, pid: 123, state: 'running', cols: 80, rows: 24, observedAt: 2,
      latestOutputBytes: 8, acceptedInputBytes: 0 }, terminal: { type: 'unknown', reason: 'origin_unknown' }, replay: [], gap: null, resizeRevision: 0 } }))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(3))
  expect(sent.mock.calls[2]![1]).toMatchObject({ kind: 'terminal-continuation-unavailable', stage: 'observation-unavailable',
    metadata: { continuationType: 'unknown', continuationReason: 'origin_unknown', liveReady: true } })
  expect(sent.mock.calls.some(([, report]) => report.kind === 'terminal-output-gap')).toBe(false)
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('original')
  const absence = sent.mock.calls[2]![1]
  const continued: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'terminal-snapshot', afterByte: 8,
    agentSessionId: session.id, run: { nativeService: null, ...session.control.run, kind: 'agent', providerId: 'codex', executorId: 'codex',
      agentSessionId: session.id, workspacePath: session.workspacePath, pid: 123, state: 'running', cols: 80, rows: 24, observedAt: 3,
      latestOutputBytes: 8, acceptedInputBytes: 0 }, terminal: { type: 'basic-vt', checkpoint: { runId: session.control.run.runId,
        throughByte: 8, resizeRevision: 0, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 },
        restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: new TextEncoder().encode('original'), resizes: [] },
    replay: [], gap: null, resizeRevision: 0 } }
  await act(async () => fixture.receive!(continued))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(4))
  expect(sent.mock.calls[3]![1]).toMatchObject({ kind: 'terminal-recovered', relatedOccurrenceId: absence.occurrenceId,
    metadata: { continuationType: 'basic-vt', liveReady: true } })
  // The next original attachment observation begins an independent attempt in TerminalView.
  await act(async () => fixture.receive!(continued))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(5))
  expect(sent.mock.calls[4]![1]).toMatchObject({ kind: 'terminal-recovered', relatedOccurrenceId: null,
    metadata: { continuationType: 'basic-vt', liveReady: true } })
  expect(sent.mock.calls[4]![1].attemptId).not.toBe(sent.mock.calls[3]![1].attemptId)
  expect(attach).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

function pausedFrames(owner: Window) {
  const callbacks = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.spyOn(owner, 'requestAnimationFrame').mockImplementation(callback => {
    callbacks.set(++sequence, callback)
    return sequence
  })
  vi.spyOn(owner, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id) })
  return callbacks
}

function RestartTerminalConsumer() {
  const current = useAppStore(state => state.sessions.find(value => value.id === session.id) as typeof session)
  const restart = useSessionRestart()
  return <><button data-restart-trigger onClick={event => restart.requestRestart(current, 'Original work', event.currentTarget)}>Restart Session</button>
    <TerminalView session={current} themeId="graphite" interactiveResize={false} autoFocus={false} linkOrigin={origin} />{restart.dialog}</>
}
async function openRestart() {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-restart-trigger]')!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original work')
}
async function confirmRestart() {
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!.click())
}
async function readyRun(runId: string) {
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({
    regionId: origin.regionId, sessionId: session.id, runId
  })?.liveReady).toBe(true)))
}

it('retires suspended terminal frames and obsolete buffers through repeated original Session restart confirmations', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc')
  const frames = pausedFrames(window)
  const retired: WeakRef<BrowserTerminal>[] = []
  const counts: number[] = []
  const neighbor = { ...session, id: 'neighbor-agent', control: { ...session.control, agentSessionId: 'neighbor-agent', run: { runId: 'neighbor-run' } } }
  useAppStore.setState({ sessions: [session, neighbor], agentComposerDrafts: { [session.id]: 'Unsent original draft' } })
  const original = useAppStore.getState()
  let generation = 0
  const restart = vi.spyOn(api.sessions, 'restart').mockImplementation(async (control, operationId) => {
    const newRun = { runId: `replacement-run-${++generation}` }
    return { agentSessionId: session.id, expectedRun: control.run, operationId, previousRun: control.run,
      phase: 'restarted', canRetry: false, observedAt: generation, newRun,
      session: { ...session, control: { ...session.control, run: newRun } } }
  })
  attach.mockImplementation(async control => {
    const data = `ORIGINAL OUTPUT ${control.run.runId}`
    const result = replay(data)
    return { ...result, attachmentId: `lease-${control.run.runId}`,
      replay: result.replay.map(item => ({ ...item, runId: control.run.runId })),
      session: { ...session, control: control as typeof session.control, latestOutputBytes: data.length } }
  })
  await act(async () => root.render(<RestartTerminalConsumer />))
  for (let index = 0; index < 6; index++) {
    if (index) { await openRestart(); await confirmRestart() }
    const runId = index ? `replacement-run-${index}` : session.control.run.runId
    await readyRun(runId)
    expect(fixture.terminals.at(-1)!.buffer.active.getLine(0)?.translateToString(true)).toContain(`ORIGINAL OUTPUT ${runId}`)
    retired.push(new WeakRef(fixture.terminals.at(-1)!))
    counts.push(frames.size)
    const current = useAppStore.getState()
    expect(current.sessions.find(value => value.id === neighbor.id)).toBe(neighbor)
    for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'activeWorkspaceId'] as const) expect(current[key]).toBe(original[key])
  }
  expect(restart).toHaveBeenCalledTimes(5)
  expect(new Set(restart.mock.calls.map(call => call[1])).size).toBe(5)
  expect(restart.mock.calls.every(call => call[2] === false)).toBe(true)
  expect(api.sessions.detach).toHaveBeenCalledTimes(5)
  expect(vi.mocked(api.sessions.detach).mock.calls.map(call => call[0])).toEqual([
    `lease-${session.control.run.runId}`, ...[1, 2, 3, 4].map(index => `lease-replacement-run-${index}`)
  ])
  await act(async () => root.render(null))
  expect(api.sessions.detach).toHaveBeenCalledTimes(6)
  fixture.terminals.length = 0
  // Spy histories are test-owned roots (callback arguments and DOM receivers), not product retention.
  vi.clearAllMocks()
  for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
  const obsoleteAlive = retired.slice(0, -1).map(reference => reference.deref() !== undefined)
  if (process.env.AGENTMUX_TERMINAL_FRAME_SAMPLE) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.AGENTMUX_TERMINAL_FRAME_SAMPLE, JSON.stringify({ counts, pendingAfterUnmount: frames.size, obsoleteAlive }) + '\n')
  }
  // The latest generation can remain in the test/React unmount job; only the five replaced Runs are the reachability oracle.
  expect(obsoleteAlive).toEqual([false, false, false, false, false])
  expect(counts).toEqual(Array(6).fill(counts[0]))
  expect(frames.size).toBe(0)
})

it('converges original restart resources with queued output and independent cleanup failures', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc')
  const frames = pausedFrames(window), generations = 36
  const retired: Array<{ terminal: WeakRef<BrowserTerminal>; buffer: WeakRef<object>;
    element: WeakRef<HTMLElement>; addon: WeakRef<object> }> = []
  const samples: Array<{ generation: number; frames: number; queuedBytes: number;
    owners: ReturnType<typeof terminalResourceOwnerCounts>; readers: number; renderListeners: number }> = []
  const faults: Array<{ generation: number; kind: string }> = []
  const neighbor = { ...session, id: 'restart-neighbor', control: { ...session.control,
    agentSessionId: 'restart-neighbor', run: { runId: 'restart-neighbor-run' } } }
  useAppStore.setState({ sessions: [session, neighbor], agentComposerDrafts: { [session.id]: 'Unsent original draft' } })
  const original = useAppStore.getState()
  let generation = 0
  const restart = vi.spyOn(api.sessions, 'restart').mockImplementation(async (control, operationId) => {
    const newRun = { runId: `memory-replacement-${++generation}` }
    return { agentSessionId: session.id, expectedRun: control.run, operationId, previousRun: control.run,
      phase: 'restarted', canRetry: false, observedAt: generation, newRun,
      session: { ...session, control: { ...session.control, run: newRun } } }
  })
  attach.mockImplementation(async control => {
    const result = replay(`ORIGINAL OUTPUT ${control.run.runId}`)
    return { ...result, attachmentId: `memory-lease-${control.run.runId}`,
      replay: result.replay.map(item => ({ ...item, runId: control.run.runId })),
      session: { ...session, control: control as typeof session.control, latestOutputBytes: result.session.latestOutputBytes } }
  })
  const encoder = new TextEncoder(), liveBytes = encoder.encode('\x1b[31mLIVE中\x1b[0m')
  const event = (runId: string, startByte: number, dataBytes: Uint8Array): RuntimeEvent => ({
    type: 'core', hostId: session.hostId, event: { type: 'terminal-output', agentSessionId: session.id,
      run: { runId }, data: '', dataBytes, evidence: { source: 'terminal-output', observedAt: 1,
        outputByteRange: { startByte, endByte: startByte + dataBytes.length } } }
  })
  await act(async () => root.render(<RestartTerminalConsumer />))
  for (let index = 0; index < generations; index++) {
    let queuedBytes = 0
    if (index) {
      await openRestart()
      const oldRunId = useAppStore.getState().sessions.find(value => value.id === session.id)!.control.run.runId
      const pending = encoder.encode(`QUEUED OLD ${index}`)
      const start = encoder.encode(`ORIGINAL OUTPUT ${oldRunId}`).length + liveBytes.length
      // The old parser has accepted queued work when the original restart receipt replaces it.
      await act(async () => {
        fixture.receive!(event(oldRunId, start, pending))
        queuedBytes = rendererPerformance.snapshot().terminals.find(value => value.runId === oldRunId)!.queuedBytes
        expect(queuedBytes).toBe(pending.length)
        document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!.click()
      })
    }
    const runId = index ? `memory-replacement-${index}` : session.control.run.runId
    await readyRun(runId)
    const terminal = fixture.terminals.at(-1)!, start = encoder.encode(`ORIGINAL OUTPUT ${runId}`).length
    // Original Runtime chunks split ANSI and UTF8. The existing composer/parser owns continuation.
    await act(async () => {
      for (const [from, to] of [[0, 3], [3, 10], [10, liveBytes.length]] as const) {
        fixture.receive!(event(runId, start + from, liveBytes.subarray(from, to)))
      }
    })
    await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(`ORIGINAL OUTPUT ${runId}LIVE中`))
    const addon = (terminal as unknown as { _addonManager: { _addons: Array<{ instance: object }> } })._addonManager._addons.at(-1)!.instance
    retired.push({ terminal: new WeakRef(terminal), buffer: new WeakRef(terminal.buffer.normal),
      element: new WeakRef(terminal.element!), addon: new WeakRef(addon) })
    const owners = terminalResourceOwnerCounts(), readers = rendererPerformance.snapshot().terminals.length
    samples.push({ generation: index, frames: frames.size, queuedBytes, owners, readers, renderListeners: fixture.renderListeners.length })
    expect(owners).toEqual({ terminalViews: 1, terminalAddons: 4, terminalListeners: 11 })
    expect(readers).toBe(1)
    expect(fixture.renderListeners).toHaveLength(2)
    if (index % 4 !== 0) {
      const first = index % 4 === 3 ? undefined : new Error('Original listener release failure')
      const second = new Error('Original GPU addon release failure')
      fixture.gpuReleaseFault = { listener: index % 4 !== 2, addon: index % 4 !== 1, first, second }
      let threw = false, caught: unknown
      try { fixture.contextLoss!() } catch (error) { threw = true; caught = error }
      expect(threw).toBe(true)
      expect(caught).toBe(index % 4 === 2 ? second : first)
      fixture.gpuReleaseFault = null
      faults.push({ generation: index, kind: index % 4 === 1 ? 'listener' : index % 4 === 2 ? 'addon' : 'undefined-first-both' })
    }
    await act(async () => terminal.input(`CURRENT INPUT ${index}`, true))
    const current = useAppStore.getState()
    expect(write.mock.calls.at(-1)!.slice(0, 3)).toEqual([
      current.sessions.find(value => value.id === session.id)!.control, `CURRENT INPUT ${index}`, 'user'
    ])
    expect(current.sessions.find(value => value.id === neighbor.id)).toBe(neighbor)
    for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'activeWorkspaceId'] as const) expect(current[key]).toBe(original[key])
  }
  expect(restart).toHaveBeenCalledTimes(generations - 1)
  expect(new Set(restart.mock.calls.map(call => call[1])).size).toBe(generations - 1)
  expect(restart.mock.calls.every(call => call[2] === false)).toBe(true)
  const detachments = vi.mocked(api.sessions.detach).mock.calls.map(call => call[0])
  expect(detachments).toEqual([`memory-lease-${session.control.run.runId}`,
    ...Array.from({ length: generations - 2 }, (_, index) => `memory-lease-memory-replacement-${index + 1}`)])
  // Check old generations while the original current view is still mounted. Fixture arrays and
  // spy receiver/argument histories are test-owned strong roots, not product retention.
  const activeTerminal = fixture.terminals.at(-1)!
  fixture.terminals.length = 0; fixture.terminals.push(activeTerminal)
  vi.clearAllMocks()
  const collectObsolete = async () => {
    for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
    return retired.slice(0, -1).map(refs => ({ terminal: refs.terminal.deref() !== undefined,
      buffer: refs.buffer.deref() !== undefined, element: refs.element.deref() !== undefined,
      addon: refs.addon.deref() !== undefined }))
  }
  const activeObsolete = await collectObsolete()
  const active = { owners: terminalResourceOwnerCounts(), readers: rendererPerformance.snapshot().terminals.length, frames: frames.size }
  await act(async () => root.render(null))
  expect(api.sessions.detach).toHaveBeenCalledExactlyOnceWith(`memory-lease-memory-replacement-${generations - 1}`)
  fixture.terminals.length = 0
  vi.clearAllMocks()
  const afterObsolete = await collectObsolete()
  const after = { owners: terminalResourceOwnerCounts(), readers: rendererPerformance.snapshot().terminals.length,
    renderListeners: fixture.renderListeners.length, frames: frames.size }
  if (process.env.AGENTMUX_TERMINAL_RESTART_SAMPLE) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.AGENTMUX_TERMINAL_RESTART_SAMPLE, JSON.stringify({ kind: 'restart-cycle', samples, faults, detachments, activeObsolete, active, afterObsolete, after }) + '\n')
  }
  const collected = Array.from({ length: generations - 1 }, () => ({ terminal: false, buffer: false, element: false, addon: false }))
  expect.soft(activeObsolete).toEqual(collected)
  expect.soft(afterObsolete).toEqual(collected)
  expect(samples.map(sample => sample.frames)).toEqual(Array(generations).fill(samples[0]!.frames))
  expect(active).toEqual({ owners: { terminalViews: 1, terminalAddons: 4, terminalListeners: 11 }, readers: 1, frames: samples[0]!.frames })
  expect(after).toEqual({ owners: { terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }, readers: 0, renderListeners: 0, frames: 0 })
  // These are controlled object-reachability facts. The latest React generation and physical
  // GPU/native/allocator memory are outside this oracle; no RSS or all-App leak claim follows.
})

it.each(['resolve', 'reject'] as const)('releases a retired input observer while the original pending input reply will %s', async outcome => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc'), pending = deferred<void>(), frames = pausedFrames(window)
  let settled = false
  void pending.promise.then(() => { settled = true }, () => { settled = true })
  write.mockReturnValue(pending.promise)
  attach.mockResolvedValue(replay('ORIGINAL INPUT OWNER'))
  await render(); await readyRun(session.control.run.runId)
  const refs = { terminal: new WeakRef(fixture.terminals[0]!), buffer: new WeakRef(fixture.terminals[0]!.buffer.normal),
    element: new WeakRef(fixture.terminals[0]!.element!) }
  const pendingBefore = rendererPerformance.snapshot().inputRequests.user.pending
  await act(async () => fixture.terminals[0]!.input('ORIGINAL PENDING INPUT', true))
  expect(write.mock.calls.at(-1)!.slice(0, 3)).toEqual([session.control, 'ORIGINAL PENDING INPUT', 'user'])
  expect(settled).toBe(false)
  // Additional real generations exclude the current React/async job from this old-object oracle.
  for (let generation = 0; generation < 3; generation++) {
    const next = { ...session, control: { ...session.control, run: { runId: `pending-input-replacement-${generation}` } } }
    const result = replay('REPLACEMENT OUTPUT')
    attach.mockResolvedValue({ ...result, attachmentId: `pending-input-lease-${generation}`,
      session: { ...next, latestOutputBytes: result.session.latestOutputBytes },
      replay: result.replay.map(item => ({ ...item, runId: next.control.run.runId })) })
    await render(next); await readyRun(next.control.run.runId)
  }
  await act(async () => root.render(null))
  expect(api.sessions.detach).toHaveBeenCalledTimes(4)
  expect(fixture.receive).toBeNull(); expect(fixture.refresh).toBeNull(); expect(fixture.contextLoss).toBeNull()
  fixture.terminals.length = 0
  vi.clearAllMocks()
  const collectRetired = async () => {
    for (let index = 0; index < 4; index++) { await nextJob(); collect(); await nextJob() }
    return { terminal: refs.terminal.deref() !== undefined, buffer: refs.buffer.deref() !== undefined,
      element: refs.element.deref() !== undefined }
  }
  let whilePending: Awaited<ReturnType<typeof collectRetired>>
  try {
    whilePending = await collectRetired()
    expect(settled).toBe(false)
    expect(rendererPerformance.snapshot().inputRequests.user.pending).toBe(pendingBefore + 1)
  } finally {
    // Retirement never settles or cancels the original request. Both late outcomes remain observed.
    if (outcome === 'resolve') pending.resolve()
    else pending.reject(new Error('Original input reply failed after its view retired'))
    await pending.promise.catch(() => {})
  }
  const afterSettlement = await collectRetired()
  if (process.env.AGENTMUX_TERMINAL_RESTART_SAMPLE) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.AGENTMUX_TERMINAL_RESTART_SAMPLE, JSON.stringify({ kind: 'pending-input', outcome,
      whilePending, afterSettlement, frames: frames.size, owners: terminalResourceOwnerCounts(),
      readers: rendererPerformance.snapshot().terminals.length }) + '\n')
  }
  expect.soft(whilePending).toEqual({ terminal: false, buffer: false, element: false })
  expect(afterSettlement).toEqual({ terminal: false, buffer: false, element: false })
  expect(settled).toBe(true)
  expect(rendererPerformance.snapshot().inputRequests.user.pending).toBe(pendingBefore)
  expect(frames.size).toBe(0)
})

it('keeps the original terminal and draft when restart is cancelled or its original receipt is unknown', async () => {
  const frames = pausedFrames(window)
  const restart = vi.spyOn(api.sessions, 'restart').mockRejectedValue(new Error('Original restart reply unknown'))
  useAppStore.setState({ agentComposerDrafts: { [session.id]: 'Unsent original draft' } })
  const original = useAppStore.getState()
  await act(async () => root.render(<RestartTerminalConsumer />))
  await readyRun(session.control.run.runId)
  const terminal = fixture.terminals[0]!, pending = frames.size
  await openRestart()
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click())
  expect(restart).not.toHaveBeenCalled()
  await openRestart(); await confirmRestart()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original restart reply unknown')
  const operationId = restart.mock.calls[0]![1]
  await confirmRestart()
  expect(restart).toHaveBeenNthCalledWith(2, session.control, operationId, true)
  expect(fixture.terminals).toEqual([terminal])
  expect(frames.size).toBe(pending)
  expect(api.sessions.detach).not.toHaveBeenCalled()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts'] as const) expect(useAppStore.getState()[key]).toBe(original[key])
})

it('still focuses the live eligible terminal when its initialization frame executes', async () => {
  const frames = pausedFrames(window)
  await render(session, { autoFocus: true })
  await readyRun(session.control.run.runId)
  const focus = vi.spyOn(fixture.terminals[0]!, 'focus')
  const callbacks = [...frames.values()]
  frames.clear()
  await act(async () => callbacks.forEach(callback => callback(0)))
  expect(focus).toHaveBeenCalledTimes(1)
})

it('retires the initialization frame on its scheduling Window after the terminal DOM moves', async () => {
  const originalFrames = pausedFrames(window)
  await ready('ORIGINAL OUTPUT')
  const next = document.createElement('iframe'); document.body.append(next)
  const nextWindow = next.contentWindow!
  const nextFrames = pausedFrames(nextWindow)
  nextWindow.requestAnimationFrame(() => {})
  next.contentDocument!.body.append(container)
  await act(async () => root.render(null))
  expect(originalFrames.size).toBe(0)
  expect(nextFrames.size).toBe(1)
  expect(api.sessions.detach).toHaveBeenCalledTimes(1)
  nextFrames.clear()
  document.body.append(container); next.remove()
})
it('keeps a slow original input request on its starting Region after the same terminal moves', async () => {
  await ready('Original attribution owner\r\n')
  const terminal = fixture.terminals[0]!, pending = deferred<void>()
  const before = rendererPerformance.snapshot(), instance = before.terminals.find(item => item.runId === session.control.run.runId)!.instanceId
  let mono = performance.now()
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  write.mockReturnValue(pending.promise)
  await act(async () => terminal.input('ORIGINAL ATTRIBUTED INPUT', true))
  expect(write.mock.calls.at(-1)!.slice(0, 3)).toEqual([session.control, 'ORIGINAL ATTRIBUTED INPUT', 'user'])
  mono += 90
  await render(session, { regionId: 'later-display-region' })
  expect(fixture.terminals).toHaveLength(1)
  expect(attach).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve(); await pending.promise })
  const row = rendererPerformance.snapshot().slowEvents.filter(item => item.kind === 'terminal-interaction' && item.detail === 'write-request').at(-1)!
  expect(row.durationMs).toBeGreaterThanOrEqual(90)
  expect(row.source).toEqual({ hostId: session.control.hostId, sessionId: session.id,
    runId: session.control.run.runId, regionId: origin.regionId, instanceId: instance })
  write.mockResolvedValue(undefined)
  await act(async () => terminal.input('STILL ACCEPTED INPUT', true))
  expect(write.mock.calls.at(-1)!.slice(0, 3)).toEqual([session.control, 'STILL ACCEPTED INPUT', 'user'])
  expect(fixture.terminals[0]).toBe(terminal)
  const replacement = { ...session, control: { ...session.control, run: { runId: 'source-replacement-run' } } }
  const result = replay('Replacement attribution owner\r\n')
  attach.mockResolvedValue({ ...result, attachmentId: 'source-replacement-attachment', session: replacement,
    replay: result.replay.map(item => ({ ...item, runId: replacement.control.run.runId })) })
  await render(replacement, { regionId: 'later-display-region' })
  expect(fixture.terminals).toHaveLength(2)
  expect(rendererPerformance.snapshot().slowEvents.find(item => item.id === row.id)?.source).toEqual(row.source)
})

it('releases retired original restart views while their exact attach replies remain pending', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc'), frames = pausedFrames(window)
  const generations = 14
  const retired: Array<{ terminal: WeakRef<BrowserTerminal>; buffer: WeakRef<object>; element: WeakRef<HTMLElement> }> = []
  const requests: Array<{ control: typeof session.control; promise: Promise<SessionAttachResult>;
    resolve(value: SessionAttachResult): void; reject(error: unknown): void }> = []
  const resultFor = (control: typeof session.control): SessionAttachResult => {
    const value = replay(`ORIGINAL ${control.run.runId}`)
    return { ...value, attachmentId: `pending-retirement-${control.run.runId}`,
      session: { ...session, control, latestOutputBytes: value.session.latestOutputBytes },
      replay: value.replay.map(item => ({ ...item, runId: control.run.runId })) }
  }
  let generation = 0, settled = 0
  attach.mockImplementation(control => {
    if (control.run.runId === `pending-restart-${generations}`) return Promise.resolve(resultFor(control as typeof session.control))
    const original = deferred<SessionAttachResult>()
    void original.promise.then(() => { settled++ }, () => { settled++ })
    requests.push({ control: control as typeof session.control, ...original })
    return original.promise
  })
  const restart = vi.spyOn(api.sessions, 'restart').mockImplementation(async (control, operationId) => {
    const newRun = { runId: `pending-restart-${++generation}` }
    return { agentSessionId: session.id, expectedRun: control.run, operationId, previousRun: control.run,
      phase: 'restarted', canRetry: false, observedAt: generation, newRun,
      session: { ...session, control: { ...session.control, run: newRun } } }
  })
  const neighbor = { ...session, id: 'pending-restart-neighbor', control: { ...session.control,
    agentSessionId: 'pending-restart-neighbor', run: { runId: 'pending-neighbor-run' } } }
  useAppStore.setState({ sessions: [session, neighbor], agentComposerDrafts: { [session.id]: 'Original pending draft' } })
  const original = frozenState()
  await act(async () => root.render(<RestartTerminalConsumer />))
  // This synchronous scope escapes only WeakRefs; it never returns a terminal or a nested async frame.
  const rememberRetired = () => {
    const terminal = fixture.terminals.at(-1)!
    retired.push({ terminal: new WeakRef(terminal), buffer: new WeakRef(terminal.buffer.normal), element: new WeakRef(terminal.element!) })
  }
  for (let index = 0; index < generations; index++) {
    expect(requests).toHaveLength(index + 1)
    rememberRetired()
    await openRestart(); await confirmRestart()
  }
  await readyRun(`pending-restart-${generations}`)
  expect(restart).toHaveBeenCalledTimes(generations)
  expect(new Set(restart.mock.calls.map(call => call[1])).size).toBe(generations)
  expect(settled).toBe(0)
  expect(frozenState()).toEqual(original)
  expect(useAppStore.getState().sessions.find(value => value.id === neighbor.id)).toBe(neighbor)
  // Preserve the current live owner only; spies and fixture histories must not root retired generations.
  fixture.terminals.splice(0, fixture.terminals.length - 1)
  vi.clearAllMocks()
  const collectObsolete = async () => {
    for (let index = 0; index < 5; index++) { await nextJob(); collect(); await nextJob() }
    // Exclude two newest retired generations from React/async job liveness; twelve older generations remain.
    return retired.slice(0, -2).map(refs => ({ terminal: refs.terminal.deref() !== undefined,
      buffer: refs.buffer.deref() !== undefined, element: refs.element.deref() !== undefined }))
  }
  let whilePending: Awaited<ReturnType<typeof collectObsolete>> = []
  try {
    whilePending = await collectObsolete()
    expect(settled).toBe(0)
    expect(rendererPerformance.snapshot().terminals).toHaveLength(1)
    await act(async () => fixture.terminals[0]!.input('CURRENT OWNER STILL WORKS', true))
    expect(write.mock.calls.at(-1)!.slice(0, 3)).toEqual([
      useAppStore.getState().sessions.find(value => value.id === session.id)!.control, 'CURRENT OWNER STILL WORKS', 'user'
    ])
    expect.soft(whilePending).toEqual(Array.from({ length: generations - 2 }, () => ({ terminal: false, buffer: false, element: false })))
  } finally {
    for (const request of requests) request.resolve(resultFor(request.control))
    await Promise.all(requests.map(request => request.promise))
    await nextJob(); await nextJob()
  }
  expect(settled).toBe(generations)
  const lateDetachments = vi.mocked(api.sessions.detach).mock.calls.map(call => call[0])
  expect(lateDetachments.sort()).toEqual(requests.map(value => `pending-retirement-${value.control.run.runId}`).sort())
  // Late real leases are released once; original requests were not cancelled or replaced.
  expect(new Set(lateDetachments).size).toBe(generations)
  vi.clearAllMocks()
  const afterSettlement = await collectObsolete()
  if (process.env.T081_MEMORY_SAMPLE) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.T081_MEMORY_SAMPLE, JSON.stringify({ kind: 'pending-attach-retirement', generations,
      whilePending, afterSettlement, pendingAtObservation: generations, settled, lateDetachments,
      resources: terminalResourceOwnerCounts(), readers: rendererPerformance.snapshot().terminals.length, frames: frames.size }) + '\n')
  }
  expect.soft(afterSettlement).toEqual(Array.from({ length: generations - 2 }, () => ({ terminal: false, buffer: false, element: false })))
})

it('releases retired original restart views while their exact retained-history replies remain pending', async () => {
  const { setFlagsFromString } = await import('node:v8')
  const { runInNewContext } = await import('node:vm')
  const { setImmediate: nextJob } = await import('node:timers/promises')
  setFlagsFromString('--expose_gc')
  const collect: () => void = runInNewContext('gc'), frames = pausedFrames(window), generations = 14
  const retired: Array<{ terminal: WeakRef<BrowserTerminal>; buffer: WeakRef<object>; element: WeakRef<HTMLElement> }> = []
  const requests: Array<{ attachmentId: string; promise: Promise<{ replay: []; gap: null }>;
    resolve(value: { replay: []; gap: null }): void; reject(error: unknown): void }> = []
  const resultFor = (control: typeof session.control): SessionAttachResult => {
    const value = replay(lines)
    return { ...value, attachmentId: `pending-history-${control.run.runId}`,
      session: { ...session, control, latestOutputBytes: value.session.latestOutputBytes },
      replay: value.replay.map(item => ({ ...item, runId: control.run.runId })) }
  }
  attach.mockImplementation(async control => resultFor(control as typeof session.control))
  let generation = 0, settled = 0
  const history = vi.spyOn(api.sessions, 'replay').mockImplementation(attachmentId => {
    const original = deferred<{ replay: []; gap: null }>()
    void original.promise.then(() => { settled++ }, () => { settled++ })
    requests.push({ attachmentId, ...original })
    return original.promise
  })
  vi.spyOn(api.sessions, 'restart').mockImplementation(async (control, operationId) => {
    const newRun = { runId: `history-restart-${++generation}` }
    return { agentSessionId: session.id, expectedRun: control.run, operationId, previousRun: control.run,
      phase: 'restarted', canRetry: false, observedAt: generation, newRun,
      session: { ...session, control: { ...session.control, run: newRun } } }
  })
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original pending history draft' } })
  const original = frozenState()
  const rememberRetired = () => {
    const terminal = fixture.terminals.at(-1)!
    retired.push({ terminal: new WeakRef(terminal), buffer: new WeakRef(terminal.buffer.normal), element: new WeakRef(terminal.element!) })
  }
  await act(async () => root.render(<RestartTerminalConsumer />))
  for (let index = 0; index < generations; index++) {
    const runId = index ? `history-restart-${index}` : session.control.run.runId
    await readyRun(runId)
    expect(fixture.terminals.at(-1)!.buffer.normal.length).toBeGreaterThan(500)
    const dataBytes = new TextEncoder().encode('AFTER ORIGINAL GAP')
    const startByte = new TextEncoder().encode(lines).length + 128
    await act(async () => fixture.receive!({ type: 'core', hostId: session.hostId,
      event: { type: 'terminal-output', agentSessionId: session.id, run: { runId }, data: '', dataBytes,
        evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } }))
    await vi.waitFor(() => expect(requests).toHaveLength(index + 1))
    expect(history.mock.calls.at(-1)![0]).toBe(`pending-history-${runId}`)
    rememberRetired()
    await openRestart(); await confirmRestart()
  }
  await readyRun(`history-restart-${generations}`)
  expect(settled).toBe(0)
  expect(frozenState()).toEqual(original)
  const detachmentsBeforeReply = vi.mocked(api.sessions.detach).mock.calls.map(call => call[0])
  expect(detachmentsBeforeReply.sort()).toEqual(requests.map(value => value.attachmentId).sort())
  // Deliver the fixture's paused native frames once, as a browser would. Xterm may have
  // posted a DOM-only accessibility frame before disposal; withholding it is a test root.
  let deliveredPausedFrames = 0
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id)
      callback(performance.now())
      deliveredPausedFrames++
    }
  })
  fixture.terminals.splice(0, fixture.terminals.length - 1)
  vi.clearAllMocks()
  const collectObsolete = async () => {
    for (let index = 0; index < 5; index++) { await nextJob(); collect(); await nextJob() }
    return retired.slice(0, -2).map(refs => ({ terminal: refs.terminal.deref() !== undefined,
      buffer: refs.buffer.deref() !== undefined, element: refs.element.deref() !== undefined }))
  }
  let whilePending: Awaited<ReturnType<typeof collectObsolete>> = []
  try {
    whilePending = await collectObsolete()
    expect(settled).toBe(0)
    expect(rendererPerformance.snapshot().terminals).toHaveLength(1)
    await act(async () => fixture.terminals[0]!.input('CURRENT HISTORY OWNER WORKS', true))
    expect(write.mock.calls.at(-1)![1]).toBe('CURRENT HISTORY OWNER WORKS')
    expect.soft(whilePending).toEqual(Array.from({ length: generations - 2 }, () => ({ terminal: false, buffer: false, element: false })))
  } finally {
    for (const request of requests) request.resolve({ replay: [], gap: null })
    await Promise.all(requests.map(request => request.promise))
    await nextJob(); await nextJob()
  }
  expect(settled).toBe(generations)
  expect(api.sessions.detach).not.toHaveBeenCalled()
  vi.clearAllMocks()
  const afterSettlement = await collectObsolete()
  if (process.env.T081_MEMORY_SAMPLE) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.T081_MEMORY_SAMPLE, JSON.stringify({ kind: 'pending-history-retirement', generations,
      whilePending, afterSettlement, pendingAtObservation: generations, settled, detachmentsBeforeReply,
      deliveredPausedFrames,
      resources: terminalResourceOwnerCounts(), readers: rendererPerformance.snapshot().terminals.length, frames: frames.size }) + '\n')
  }
  expect.soft(afterSettlement).toEqual(Array.from({ length: generations - 2 }, () => ({ terminal: false, buffer: false, element: false })))
})
