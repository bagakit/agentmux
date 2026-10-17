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
import { ClientIncidentArchive } from '../src/main/client-incident-archive'
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
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation, registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Browser xterm open/parser/buffers/selection and owner-size adoption are real; layout, addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null, refresh: null as (() => Promise<void>) | null, diagnosticRegionFailure: false }))
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
  fixture.terminals.length = 0; fixture.receive = null; fixture.diagnosticRegionFailure = false; releases = []
  vi.stubGlobal('agentmux', { clientIncidents: api.clientIncidents })
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
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
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
    server = new AgentMuxControlServer({ socketPath: desktopPath, coreClients: () => [], clientIncidents: archive })
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
