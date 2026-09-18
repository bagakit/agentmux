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
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation, registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Native parser, buffers, modes and viewport methods are real; DOM paint/addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    open(root: HTMLElement) { this.element = document.createElement('div'); root.append(this.element) }
    refresh() {}
    focus() {}
    onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} })
    getSelection() { return '' }
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
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
  return { attachmentId: 'observed-attachment', session, currentSize: { cols: 80, rows: 24 }, gap: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
async function render(current: SessionSnapshot = session, props: { visible?: boolean; readOnly?: boolean; regionId?: string } = {}) {
  await act(async () => root.render(createElement(TerminalView, { session: current, themeId: 'graphite',
    interactiveResize: false, visible: props.visible ?? true, readOnly: props.readOnly ?? false, autoFocus: false,
    linkOrigin: { ...origin, regionId: props.regionId ?? origin.regionId } })))
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
  fixture.terminals.length = 0; fixture.receive = null; releases = []
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(lines))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(receive => { fixture.receive = receive; return () => { fixture.receive = null } })
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  resize = vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  recover = vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  surfaceState()
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  releases.forEach(release => release())
  useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('reads current normal+mouse parser and public viewport through actual TerminalView and Store inspect without an input/resize/recovery', async () => {
  const terminal = await ready(lines + '\x1b[?1003h\x1b[?1006h')
  terminal.scrollToLine(300)
  const value = (await inspect()).terminalView
  expect(value).toEqual({ runId: session.control.run.runId, sampledAt: expect.any(Number), visible: true, readOnly: false,
    liveReady: true, acceptsInput: true, viewGrid: { cols: terminal.cols, rows: terminal.rows },
    buffer: { type: 'normal', baseY: terminal.buffer.active.baseY, viewportY: 300, length: terminal.buffer.active.length }, mouseTrackingMode: 'any' })
  expect(value!.buffer.baseY).toBeGreaterThan(300)
  expect(value!.buffer.length).toBeGreaterThan(500)
  const expectedKeys = ['acceptsInput','buffer','liveReady','mouseTrackingMode','readOnly','runId','sampledAt','viewGrid','visible']
  expect(Object.keys(value!).sort()).toEqual(expectedKeys.sort())
  const clock = vi.spyOn(Date, 'now').mockReturnValue(value!.sampledAt + 123)
  expect((await inspect()).terminalView?.sampledAt).toBe(value!.sampledAt + 123); clock.mockRestore()
  expect(write).not.toHaveBeenCalled(); expect(resize).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledTimes(1)
})

it('reads real alternate+vt200/normal transitions and current hidden/readOnly/pending gates from the same instance', async () => {
  const terminal = await ready(lines + '\x1b[?1049h\x1b[?1000h\x1b[?1006h')
  expect((await inspect()).terminalView).toMatchObject({ buffer: { type: 'alternate', baseY: 0, viewportY: 0 }, mouseTrackingMode: 'vt200' })
  await render(session, { visible: false, readOnly: true })
  expect(api.sessions.onEvent).toHaveBeenCalledExactlyOnceWith(expect.any(Function), session.control)
  expect((await inspect()).terminalView).toMatchObject({ visible: false, readOnly: true, acceptsInput: false, liveReady: true })
  const hiddenData = '\x1b[1;1Hprivate-hidden-live-output'
  const hiddenBytes = new TextEncoder().encode(hiddenData)
  const replayLength = lines.length + '\x1b[?1049h\x1b[?1000h\x1b[?1006h'.length
  await act(async () => {
    fixture.receive!({ type: 'core', hostId: session.hostId, event: { type: 'terminal-output',
      run: { ...session.control.run }, data: hiddenData, dataBytes: hiddenBytes,
      evidence: { source: 'terminal-output', observedAt: 2, run: { ...session.control.run },
        outputByteRange: { startByte: replayLength, endByte: replayLength + hiddenBytes.length } } } })
    await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('private-hidden-live-output'))
  })
  const pending: typeof session = { ...session, pendingInteraction: { id: 'private-request', kind: 'permission', agentSessionId: session.id,
    title: 'Private synthetic permission', options: [], evidence: { source: 'native-hook', observedAt: 1 } } }
  surfaceState(pending); await render(pending)
  expect((await inspect()).terminalView).toMatchObject({ visible: true, readOnly: false, acceptsInput: true })
  await act(async () => await new Promise<void>(resolve => terminal.write('\x1b[?1049l\x1b[?1000l', resolve)))
  surfaceState(); await render()
  expect((await inspect()).terminalView).toMatchObject({ buffer: { type: 'normal' }, mouseTrackingMode: 'none', acceptsInput: true })
  expect(fixture.terminals).toHaveLength(1); expect(attach).toHaveBeenCalledTimes(1)
})

it('reports not-live readiness before attach settles and never guesses success', async () => {
  let release!: (result: ReturnType<typeof replay>) => void
  attach.mockReturnValue(new Promise(resolve => { release = resolve }))
  await render()
  expect((await inspect()).terminalView).toMatchObject({ liveReady: false, acceptsInput: false })
  await act(async () => release(replay(lines)))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)))
  expect((await inspect()).terminalView).toMatchObject({ liveReady: true, acceptsInput: true })
})

it('the mounted terminal handler forwards native input with a permission present and preserves the same view', async () => {
  const terminal = await ready(lines)
  const pending: typeof session = { ...session, pendingInteraction: { id: 'native-pending', kind: 'permission', agentSessionId: session.id,
    title: 'Private permission', options: [], evidence: { source: 'native-hook', observedAt: 1, run: session.control.run } } }
  surfaceState(pending); await render(pending)
  await act(async () => terminal.input('\u001b'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control, '\u001b', 'user')
  expect(useAppStore.getState().sessions).toEqual([pending])
  expect((await inspect()).terminalView).toMatchObject({ liveReady: true, acceptsInput: true })
  expect(fixture.terminals).toEqual([terminal]); expect(attach).toHaveBeenCalledOnce()
  expect(recover).not.toHaveBeenCalled()
})

it('readdresses only the callback and releases unmounted views without rebuilding or mutating the Run', async () => {
  await ready(lines)
  surfaceState(session, 'moved-region'); await render(session, { regionId: 'moved-region' })
  expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })).toBeUndefined()
  expect((await inspect('moved-region')).terminalView?.runId).toBe(session.control.run.runId)
  expect(fixture.terminals).toHaveLength(1); expect(attach).toHaveBeenCalledTimes(1)
  await act(async () => root.render(null))
  expect((await inspect('moved-region')).terminalView).toBeUndefined()
})

it('omits an old Run callback against current Session facts until the actual new view is mounted', async () => {
  await ready(lines)
  const next: typeof session = { ...session, control: { ...session.control, run: { runId: 'new-observed-run' } } }
  surfaceState(next)
  expect((await inspect()).terminalView).toBeUndefined()
  await render(next)
  await act(async () => await vi.waitFor(() => expect(fixture.terminals).toHaveLength(2)))
  expect((await inspect()).terminalView?.runId).toBe(next.control.run.runId)
})

it('keeps only the latest exact callback, preserves it against older cleanup, and isolates getter failures', async () => {
  const identity = { regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId }
  const old = registerTerminalViewObservation(identity, () => observed())
  const latest = registerTerminalViewObservation(identity, () => ({ ...observed(), sampledAt: 2 }))
  releases.push(old, latest); old()
  expect((await inspect()).terminalView?.sampledAt).toBe(2)
  expect(readTerminalViewObservation({ ...identity, sessionId: 'foreign-session' })).toBeUndefined()
  expect(readTerminalViewObservation({ ...identity, runId: 'foreign-run' })).toBeUndefined()
  const failing = registerTerminalViewObservation(identity, () => { throw new Error('private view unavailable') }); releases.push(failing)
  expect((await inspect()).terminalView).toBeUndefined()
  expect(useAppStore.getState().sessions[0]?.processState).toBe('running')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('rechecks canonical Run after a synchronous getter reenters the Store', async () => {
  releases.push(registerTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId }, () => {
    surfaceState({ ...session, control: { ...session.control, run: { runId: 'changed-during-read' } } })
    return observed()
  }))
  expect((await inspect()).terminalView).toBeUndefined()
})

it('omits observations for presentation-only Regions even when a callback is present', async () => {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'launcher', workspaceId: origin.workspaceId })
  useAppStore.setState({ tabs: { [tab.id]: tab } })
  const getter = vi.fn(() => observed())
  releases.push(registerTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId }, getter))
  expect(await inspect()).toMatchObject({ kind: 'launcher' })
  expect((await inspect()).terminalView).toBeUndefined(); expect(getter).not.toHaveBeenCalled()
})
