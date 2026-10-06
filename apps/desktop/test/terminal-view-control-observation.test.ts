const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxTerminalViewObservation } from '@agentmux/core/control'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { initializeRunServiceProjection, useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
const { TerminalView } = await import(process.env.AGENTMUX_TEST_TERMINAL_ENTRY ?? '../src/renderer/src/components/TerminalView') as typeof import('../src/renderer/src/components/TerminalView')
import { observeTerminalInputGeometry, readTerminalInputOverlapTop, readTerminalViewObservation, registerTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'

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
  id: 'observed-agent', hostId: 'local', workspacePath: _hygiene_fixturePath("synthetic"), label: 'Observed', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1),
  kind: 'agent', providerId: 'codex', executorId: 'codex', processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
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
  return { runId, sampledAt: _reshape_fixtureEpoch(0, 0, 1), visible: true, readOnly: false, liveReady: true, acceptsInput: true,
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
  useAppStore.setState({ runtimeEndpointWarnings: [] })
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

it('consumes both connection origins through mounted TerminalView and explicitly reads storage for the same original Run', async () => {
  const storage = vi.spyOn(api.sessions, 'observeStorage').mockResolvedValue({ status: 'unsupported', run: session.control.run,
    runtime: { hostId: 'local', instanceId: 'native-original', buildIdentity: 'fixture', protocolVersion: 22, processId: 42 },
    observedAt: _reshape_fixtureEpoch(0, 0, 50), message: 'Exact Run storage is not advertised' })
  releases.push(initializeRunServiceProjection())
  const terminal = await ready('synthetic output\r\n')
  const nativeService = { revision: 7, owner: { type: 'serving' as const }, output: { type: 'serving' as const },
    input: { phase: { type: 'open' as const }, unsettledCommands: 0, unsettledRequestBytes: 0, writeBlocked: false,
      completedInputBytes: 0, activeConfirmedBytes: 0, currentSize: { cols: 80, rows: 24 } }, terminalFault: null }
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'run-service',
    run: session.control.run, agentSessionId: session.id, nativeService, evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 9), run: session.control.run } } }))
  const warning = (boundary: 'core-ctxmux' | 'consumer-core', hostId = 'local') => ({ hostId, scope: 'observation' as const,
    step: boundary === 'core-ctxmux' ? 'Core to ctxmux connection' : 'Core control connection', availability: 'unverified' as const,
    observationOrigin: { kind: 'runtime-connection' as const, boundary },
    evidence: { source: 'agentmux' as const, observedAt: _reshape_fixtureEpoch(0, 0, 20) }, code: 'RUNTIME_UNAVAILABLE', message: 'This connection is lost', recovery: 'Refresh original observation' })
  const originalDrafts = useAppStore.getState().agentComposerDrafts
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [warning('core-ctxmux'), warning('consumer-core'), warning('core-ctxmux', 'unrelated-host')] }))
  const container = document.body.querySelector('.terminal-view')!
  const connectionRows = () => [...container.querySelectorAll('.terminal-service-window .service-window')]
    .filter(row => row.querySelector('.service-window__step')?.textContent?.includes('connection'))
  expect(connectionRows()).toHaveLength(2)
  expect(container.textContent).toContain('Core to ctxmux connection')
  expect(container.textContent).toContain('Core control connection')
  expect(container.textContent).toContain('last observed running')
  expect(container.textContent).toContain('revision 7')
  expect(container.textContent).toContain('by run-process')
  expect(container.textContent).not.toContain('unrelated-host')
  expect(storage).not.toHaveBeenCalled()
  const check = container.querySelector<HTMLButtonElement>('.terminal-storage-details button')
  expect(check, 'the actual TerminalView must supply its original storageControl').not.toBeNull()
  await act(async () => check!.click())
  expect(storage).toHaveBeenCalledExactlyOnceWith(session.control)
  expect(container.textContent).toContain('Exact Run storage is not advertised')
  await act(async () => terminal.input('x', true))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control, 'x', 'user', expect.objectContaining({ source: 'user', sequence: 1 }))
  expect(recover).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toBe(originalDrafts)
  expect(fixture.terminals).toEqual([terminal])
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [warning('core-ctxmux')] }))
  expect(connectionRows()).toHaveLength(1)
  expect(container.textContent).toContain('Core to ctxmux connection')
  expect(storage).toHaveBeenCalledOnce()
  const pressured = { ...nativeService, revision: 8, output: { type: 'backpressured' as const } }
  await act(async () => {
    useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'run-service', run: session.control.run,
      agentSessionId: session.id, nativeService: pressured, evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 10), run: session.control.run } } })
    useAppStore.setState({ runtimeEndpointWarnings: [{ ...warning('core-ctxmux'), availability: 'connected',
      code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING', message: 'Native transport returned; Session recovery is pending' }] })
  })
  const nativeRow = [...container.querySelectorAll('.terminal-service-window .service-window')]
    .find(row => row.querySelector('.service-window__step')?.textContent?.includes('resource pressure'))
  expect(nativeRow).toBeDefined()
  expect(nativeRow!.getAttribute('data-kind')).toBe('indeterminate')
  expect(nativeRow!.textContent).toContain('last observed running')
  expect(container.textContent).toContain('Session recovery is pending')
  await act(async () => terminal.input('y', true))
  expect(write.mock.calls[1]).toEqual([session.control, 'y', 'user', expect.objectContaining({ source: 'user', sequence: 2 })])
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
      evidence: { source: 'terminal-output', observedAt: _reshape_fixtureEpoch(0, 0, 2), run: { ...session.control.run },
        outputByteRange: { startByte: replayLength, endByte: replayLength + hiddenBytes.length } } } })
    await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('private-hidden-live-output'))
  })
  const pending: typeof session = { ...session, pendingInteraction: { id: 'private-request', kind: 'permission', agentSessionId: session.id,
    title: 'Private synthetic permission', options: [], evidence: { source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1) } } }
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
    title: 'Private permission', options: [], evidence: { source: 'native-hook', observedAt: _reshape_fixtureEpoch(0, 0, 1), run: session.control.run } } }
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
  const latest = registerTerminalViewObservation(identity, () => ({ ...observed(), sampledAt: _reshape_fixtureEpoch(0, 0, 2) }))
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

it('protects the actual current row after the caret moves left, including a wide continuation cell, without changing control facts', async () => {
  const terminal = await ready('AAAAAAAA界')
  const element = terminal.element!
  const screen = document.createElement('div'); screen.className = 'xterm-screen'; element.append(screen)
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, terminal.cols * 10, terminal.rows * 20))
  const popup = new DOMRect(100, 21, 9, 18), line = terminal.buffer.active.getLine(0)!
  expect(line.getCell(8)!.getWidth()).toBe(2); expect(line.getCell(9)!.getWidth()).toBe(0)
  const before = terminalResourceOwnerCounts(), changed = vi.fn()
  const stop = observeTerminalInputGeometry(origin.regionId, element, changed); releases.push(stop)
  expect(terminalResourceOwnerCounts().terminalListeners).toBe(before.terminalListeners + 3)
  changed.mockClear()
  await act(async () => await new Promise<void>(resolve => terminal.write('\x1b[9D', resolve)))
  expect(terminal.buffer.active.cursorX).toBe(1); expect(line.translateToString(true)).toBe('AAAAAAAA界')
  expect(changed).toHaveBeenCalled()
  expect(readTerminalInputOverlapTop(origin.regionId, element, popup)).toBe(20)
  expect(readTerminalInputOverlapTop(origin.regionId, document.createElement('div'), popup)).toBeUndefined()
  expect(Object.keys((await inspect()).terminalView!).sort()).toEqual(['acceptsInput','buffer','liveReady','mouseTrackingMode','readOnly','runId','sampledAt','viewGrid','visible'].sort())
  await act(async () => await new Promise<void>(resolve => terminal.write('\x1b[2J\x1b[HAAA', resolve)))
  expect(readTerminalInputOverlapTop(origin.regionId, element, popup)).toBeUndefined()
  stop(); stop(); expect(terminalResourceOwnerCounts()).toEqual(before)
  await render(session, { visible: false })
  expect(readTerminalInputOverlapTop(origin.regionId, element, popup)).toBeUndefined()
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('binds a floating consumer before its view registers and replaces a same-element Run owner without keeping stale subscriptions', () => {
  const regionId = 'late-geometry-region', element = document.createElement('div'), popup = new DOMRect(1, 2, 3, 4)
  const changed = vi.fn(), firstStop = vi.fn(), nextStop = vi.fn()
  let firstEvent: (() => void) | undefined, nextEvent: (() => void) | undefined
  const firstSubscribe = vi.fn((_element: HTMLElement, notify: () => void) => { firstEvent = notify; return firstStop })
  const nextSubscribe = vi.fn((_element: HTMLElement, notify: () => void) => { nextEvent = notify; return nextStop })
  const floatStop = observeTerminalInputGeometry(regionId, element, changed); releases.push(floatStop)
  expect(readTerminalInputOverlapTop(regionId, element, popup)).toBeUndefined()
  const identity = { regionId, sessionId: session.id, runId: session.control.run.runId }
  const old = registerTerminalViewObservation(identity, () => observed(), { readOverlapTop: () => 20, subscribe: firstSubscribe }); releases.push(old)
  expect(firstSubscribe).toHaveBeenCalledExactlyOnceWith(element, expect.any(Function))
  expect(readTerminalInputOverlapTop(regionId, element, popup)).toBe(20)
  const latest = registerTerminalViewObservation({ ...identity, runId: 'next-geometry-run' }, () => observed('next-geometry-run'), { readOverlapTop: () => 30, subscribe: nextSubscribe }); releases.push(latest)
  expect(firstStop).toHaveBeenCalledTimes(1); expect(nextSubscribe).toHaveBeenCalledExactlyOnceWith(element, expect.any(Function))
  changed.mockClear(); firstEvent!(); expect(changed).not.toHaveBeenCalled()
  nextEvent!(); expect(changed).toHaveBeenCalledTimes(1)
  old(); expect(readTerminalInputOverlapTop(regionId, element, popup)).toBe(30)
  latest(); expect(nextStop).toHaveBeenCalledTimes(1)
  expect(readTerminalInputOverlapTop(regionId, element, popup)).toBeUndefined()
  floatStop(); expect(nextStop).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})
