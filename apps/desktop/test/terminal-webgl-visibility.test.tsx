import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { appendFileSync } from 'node:fs'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { IBufferRange, ISelectionSnapshot } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'
import * as terminalResourceOwners from '../src/renderer/src/lib/terminal-resource-owners'

type FixtureTerminal = HeadlessTerminal & {
  refresh: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  written: string[]
  completed: string[]
  restoreSelection: ReturnType<typeof vi.fn>
}
type FixtureWebgl = {
  disposed: ReturnType<typeof vi.fn>
  loseContext(): void
  contextLossDisposed: ReturnType<typeof vi.fn>
}
const fixture = vi.hoisted(() => ({
  terminals: [] as FixtureTerminal[],
  webgl: [] as FixtureWebgl[],
  receive: null as ((event: RuntimeEvent) => void) | null,
  attach: vi.fn(),
  detach: vi.fn(),
  unsubscribe: vi.fn(),
  resize: vi.fn(),
  write: vi.fn(),
  realViewport: false,
  selection: undefined as IBufferRange | undefined,
  snapshot: undefined as ISelectionSnapshot | undefined,
  grid: { cols: 80, rows: 24 }
}))

vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await import('@xterm/headless')
  return { Terminal: class extends Terminal {
    element?: HTMLElement
    refresh = vi.fn()
    written: string[] = []
    completed: string[] = []
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      this.dispose = vi.fn(() => super.dispose())
      fixture.terminals.push(this as unknown as FixtureTerminal)
    }
    write(data: string | Uint8Array, callback?: () => void) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      this.written.push(text)
      super.write(data, () => { this.completed.push(text); callback?.() })
    }
    open = vi.fn((root: HTMLElement) => { this.element ??= root.ownerDocument.createElement('div'); root.append(this.element) })
    focus() {}
    onUserInput() { return { dispose() {} } }
    onRender() { return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
    getSelection() { return '' }
    getSelectionSnapshot() { return fixture.snapshot ?? (fixture.selection ? { anchor: fixture.selection.start, active: fixture.selection.end, mode: 'normal' as const, selectAll: false } : undefined) }
    restoreSelection = vi.fn()
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  private terminal: HeadlessTerminal | null = null
  activate(terminal: HeadlessTerminal) { this.terminal = terminal }
  dispose() {}
  fit() { this.terminal?.resize(fixture.grid.cols, fixture.grid.rows) }
  proposeDimensions() { return { ...fixture.grid } }
} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  activate() {}
  dispose() {}
  onDidChangeResults() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {
  activate() {}
  dispose() {}
} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {
  disposed = vi.fn()
  dispose() { this.disposed() }
  contextLossDisposed = vi.fn()
  private contextLoss: (() => void) | null = null
  constructor() { fixture.webgl.push(this) }
  activate() {}
  onContextLoss(listener: () => void) {
    this.contextLoss = listener
    return { dispose: this.contextLossDisposed }
  }
  loseContext() { this.contextLoss?.() }
} }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { sessions: {
  attach: fixture.attach,
  detach: fixture.detach,
  resize: fixture.resize,
  write: fixture.write,
  onEvent: (receive: (event: RuntimeEvent) => void) => {
    fixture.receive = receive
    return fixture.unsubscribe
  }
} } }))
vi.mock('../src/renderer/src/store', () => {
  const state = {
    config: null, regionCaretFocus: null, demandPmoTabIds: {}, demands: {}, sessions: [], tabs: {}, layouts: {}, noticeReadReceipts: {},
    clearRegionCaretFocus: vi.fn(), recoverSession: vi.fn(),
    openHttpLink: vi.fn(), openFile: vi.fn(), reportError: vi.fn()
  }
  return { useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state, setState: vi.fn()
  }) }
})
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/terminal-viewport-sync')>()
  return { TerminalViewportSynchronizer: class {
    constructor(options: ConstructorParameters<typeof actual.TerminalViewportSynchronizer>[0]) {
      if (fixture.realViewport) return new actual.TerminalViewportSynchronizer(options)
    }
    beginReplay() {}
    endReplay(_hasReplay: boolean) {}
    setInteractiveResize(_active: boolean) {}
    setVisible(_visible: boolean) {}
    synchronizeCellMetrics() {}
    observeViewport() {}
    acceptOwnerSize(_size: { cols: number; rows: number }) {}
    async startLiveSynchronization() {}
    dispose() {}
  } }
})
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))

const session: SessionSnapshot = {
  id: 'session-retained', hostId: 'local', workspacePath: _hygiene_fixturePath("fixture"), label: 'Retained',
  createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: _tailFixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
  kind: 'terminal', providerId: null,
  control: { kind: 'terminal', hostId: 'local', runId: 'run-retained', run: { runId: 'run-retained' } }
}
const linkOrigin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
const reference = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }
const switchTarget = { ...reference, presentationId: 'space' }
let root: Root | null = null
let rootContainer: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0
  fixture.webgl.length = 0
  fixture.receive = null
  fixture.realViewport = false
  fixture.write.mockResolvedValue(undefined)
  fixture.selection = undefined
  fixture.snapshot = undefined
  fixture.grid = { cols: 80, rows: 24 }
  vi.clearAllMocks()
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-retained', currentSize: { cols: 80, rows: 24 },
    session: { ...session, latestOutputBytes: 7 }, terminal: { type: 'unavailable', reason: 'source_gap' },
    resizeRevision: 0, gap: null,
    replay: [{ runId: session.control.run.runId, data: 'before ', dataBytes: new TextEncoder().encode('before '), startByte: 0, endByte: 7 }] })
  fixture.detach.mockResolvedValue(undefined)
  fixture.resize.mockImplementation(async (_attachmentId: string, cols: number, rows: number) => ({ cols, rows }))
  rootContainer = document.createElement('div')
  document.body.append(rootContainer)
  root = createRoot(rootContainer)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function render(visible: boolean) {
  await act(async () => {
    root!.render(<WorkbenchPresentationContext.Provider value={{ active: visible, retainedRegionId: null, reference, surface: 'space' }}>
      <TerminalView session={session} themeId="graphite" interactiveResize={false} visible={visible} autoFocus={false} linkOrigin={linkOrigin} />
    </WorkbenchPresentationContext.Provider>)
  })
  await act(async () => {
    await vi.waitFor(() => expect(fixture.terminals[0]?.completed).toContain('before '))
  })
}
async function hiddenOutput(data: string, startByte: number) {
  expect(fixture.receive).not.toBeNull()
  await act(async () => {
    fixture.receive!({ type: 'core', hostId: 'local', event: {
      type: 'terminal-output', run: session.control.run, data, dataBytes: new TextEncoder().encode(data),
      evidence: { outputByteRange: { startByte, endByte: startByte + data.length } }
    } } as RuntimeEvent)
    await vi.waitFor(() => expect(fixture.terminals[0]?.completed).toContain(data))
  })
}

it('startup loading consumes the actual TerminalView visible fact before CSS observation', async () => {
  fixture.attach.mockImplementation(() => new Promise(() => {}))
  const styles = vi.spyOn(window, 'getComputedStyle')
  const loadingReads = () => styles.mock.calls.filter(([node]) => node.matches('.full-page-loading, .full-page-loading__activity'))
  const terminal = (index: number, visible: boolean) => <TerminalView key={index} session={session} themeId="graphite"
    interactiveResize={false} visible={visible} autoFocus={false} linkOrigin={{ ...linkOrigin, regionId: `loading-region-${index}` }} />
  try {
    await act(async () => root!.render(<>{Array.from({ length: 25 }, (_, index) => terminal(index, false))}</>))
    expect(rootContainer.querySelectorAll('.full-page-loading')).toHaveLength(25)
    await act(async () => { rootContainer.className = 'retained-terminal-owner-changed' })
    expect(loadingReads(), 'Hidden Terminal loading CSS reads').toHaveLength(0)
    expect(rootContainer.querySelectorAll('[data-icon-animation="wait"]')).toHaveLength(0)
    await act(async () => root!.render(<>{terminal(0, true)}</>))
    expect(rootContainer.querySelectorAll('.full-page-loading')).toHaveLength(1)
    expect(loadingReads().length).toBeGreaterThan(0)
    expect(rootContainer.querySelector('[data-icon-animation="wait"]')).not.toBeNull()
  } finally { styles.mockRestore() }
})

it('reports a warm Terminal switch through its actual visibility hook without attaching again', async () => {
  await render(true); await render(false)
  const original = fixture.terminals[0], readySinceAt = rendererPerformance.snapshot().terminals[0]!.readySinceAt
  const release = tabSwitchObservation.registerPlacement(switchTarget, () => true)
  try {
    tabSwitchObservation.begin(switchTarget, 'terminal', performance.now()); tabSwitchObservation.selected(switchTarget, 'layout-effect')
    expect(tabSwitchObservation.snapshot().at(-1)!.terminal?.visible).toBe(false)
    await render(true)
    await vi.waitFor(() => expect(tabSwitchObservation.snapshot().at(-1)!.frameMs).not.toBeNull())
    expect(rendererPerformance.snapshot().tabSwitches.at(-1)).toMatchObject({ state: 'observed', mode: 'terminal',
      target: switchTarget, terminal: { sessionId: session.id, runId: session.control.run.runId, readySinceAt,
        visible: true, revealed: true, liveReady: true, acceptsInput: true, readOnly: false, replaying: false } })
    expect(tabSwitchObservation.snapshot().at(-1)!.inputReadyMs).not.toBeNull()
    expect(fixture.terminals[0]).toBe(original); expect(fixture.attach).toHaveBeenCalledTimes(1)
    expect(fixture.detach).not.toHaveBeenCalled()
  } finally { release() }
})

it('releases only the GPU when hidden, parses ordered hidden bytes, and refreshes the same terminal on reveal', async () => {
  const beforeCosts = rendererPerformance.snapshot().terminalWrites.hidden.count
  await render(true)
  expect(rendererPerformance.snapshot().terminals).toMatchObject([{ sessionId: session.id, runId: session.control.run.runId, visible: true }])
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(1)
  const terminal = fixture.terminals[0]!
  const first = fixture.webgl[0]!
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 4, terminalListeners: 11 })

  await render(false)
  expect(first.disposed).toHaveBeenCalledOnce()
  expect(first.contextLossDisposed).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 3, terminalListeners: 11 })
  // Split an ANSI parser sequence across separate hidden writes, in byte order.
  await hiddenOutput('\u001b[3', 7)
  await hiddenOutput('1mhidden\u001b[0m', 10)
  expect(rendererPerformance.snapshot().terminalWrites.hidden.count).toBeGreaterThan(beforeCosts)
  expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({ visible: false, visibleSinceAt: null, liveReady: true, acceptsInput: true, queuedBytes: 0 })
  expect(terminal.written).toEqual(['before ', '\u001b[3', '1mhidden\u001b[0m'])
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('before hidden')
  expect(terminal.dispose).not.toHaveBeenCalled()
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(fixture.detach).not.toHaveBeenCalled()
  expect(fixture.unsubscribe).not.toHaveBeenCalled()

  terminal.refresh.mockClear()
  await render(true)
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.webgl).toHaveLength(2)
  expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1)
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('before hidden')
  expect(terminalResourceOwnerCounts().terminalAddons).toBe(4)
  const second = fixture.webgl[1]!
  await act(async () => second.loseContext())
  expect(second.disposed).toHaveBeenCalledOnce()
  expect(second.contextLossDisposed).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts().terminalAddons).toBe(3)
  await render(false)
  expect(second.disposed).toHaveBeenCalledOnce()
  await act(async () => root!.unmount())
  root = null
  expect(rendererPerformance.snapshot().terminals).toEqual([])
  expect(terminal.dispose).toHaveBeenCalledOnce()
  expect(fixture.detach).toHaveBeenCalledExactlyOnceWith('attachment-retained')
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
})

// The actual mounted consumer owns these operations. Only native-leaf work advances
// the controlled clock; these measurements are not Electron or GPU timings.
function cleanupSample(phase: string, value: unknown): void {
  const destination = process.env.AGENTMUX_TERMINAL_CLEANUP_SAMPLES
  if (destination) appendFileSync(destination, JSON.stringify({ phase, value }) + '\n')
}
function cleanupEventsAfter(id: number) {
  return rendererPerformance.snapshot().slowEvents.filter(event => event.kind === 'terminal-cleanup' && event.id > id)
}
function lastSlowEventId(): number {
  return rendererPerformance.snapshot().slowEvents.at(-1)?.id ?? 0
}

it('records cleanup spans while hide and reveal preserve the same Terminal, Run, ordered bytes and healthy input', async () => {
  let mono = Math.ceil(performance.now())
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const observation = vi.spyOn(rendererPerformance, 'terminalCleanup')
  try {
    await render(true)
    const terminal = fixture.terminals[0]!, firstGpu = fixture.webgl[0]!, firstId = lastSlowEventId(), start = mono
    firstGpu.disposed.mockImplementation(() => { mono += 75 })
    await render(false)
    const slow = cleanupEventsAfter(firstId)
    cleanupSample('slow-webgl-hide', { slow, calls: observation.mock.calls, disposerCalls: firstGpu.disposed.mock.calls.length, terminalDisposeCalls: terminal.dispose.mock.calls.length, detachCalls: fixture.detach.mock.calls.length, owners: terminalResourceOwnerCounts(), terminals: rendererPerformance.snapshot().terminals })
    expect(slow).toHaveLength(1)
    expect(slow[0]).toMatchObject({ durationMs: 75, occurredAtMonoMs: start, deliveredAtMonoMs: start + 75, terminal: null,
      cleanup: { hostId: 'local', sessionId: session.id, runId: session.control.run.runId, regionId: linkOrigin.regionId,
        instanceId: expect.any(Number), operation: 'webgl-dispose', outcome: 'returned' } })
    expect(firstGpu.disposed).toHaveBeenCalledOnce()
    expect(firstGpu.contextLossDisposed).toHaveBeenCalledOnce()
    expect(observation).toHaveBeenCalledTimes(1)
    await hiddenOutput('still ordered', 7)
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('before still ordered')
    expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({ runId: session.control.run.runId, liveReady: true, acceptsInput: true, visible: false })
    terminal.input('HEALTHY_AFTER_GPU_RELEASE', true)
    expect(fixture.write).toHaveBeenCalledWith(session.control, 'HEALTHY_AFTER_GPU_RELEASE', 'terminal-protocol', expect.anything())
    expect(fixture.terminals).toEqual([terminal]); expect(terminal.dispose).not.toHaveBeenCalled()
    expect(fixture.attach).toHaveBeenCalledTimes(1); expect(fixture.detach).not.toHaveBeenCalled()
    await render(true)
    const secondGpu = fixture.webgl[1]!
    secondGpu.disposed.mockImplementation(() => { mono += 3 })
    await act(async () => secondGpu.loseContext())
    const fastEnd = rendererPerformance.snapshot(), callsAfterFast = observation.mock.calls.length
    cleanupSample('fast-webgl-context-loss', { slow: cleanupEventsAfter(firstId), calls: observation.mock.calls, snapshot: fastEnd })
    expect(observation).toHaveBeenCalledTimes(2)
    expect(cleanupEventsAfter(firstId)).toHaveLength(1)
    expect(observation.mock.calls[1]![1]).toMatchObject({ operation: 'webgl-dispose', outcome: 'returned', instanceId: slow[0]!.cleanup!.instanceId })
    await render(false)
    expect(observation).toHaveBeenCalledTimes(callsAfterFast) // No addon means no dispose observation.
    await render(true)
    expect(fixture.terminals).toEqual([terminal]); expect(fixture.attach).toHaveBeenCalledTimes(1)
    expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({ runId: session.control.run.runId, liveReady: true, acceptsInput: true, visible: true })
    expect(slow[0]!.cleanup!.instanceId).toBeGreaterThan(0)
  } finally {
    await act(async () => root?.unmount()); root = null
    observation.mockRestore(); clock.mockRestore()
  }
})

it('keeps retiring xterm cleanup on the original Run and instance while its Region accepts the replacement Run', async () => {
  let mono = Math.ceil(performance.now())
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
  try {
    await render(true)
    const first = fixture.terminals[0]!, firstId = lastSlowEventId(), disposeFirst = first.dispose.getMockImplementation()!
    first.dispose.mockImplementation(() => { mono += 90; disposeFirst() })
    const next: SessionSnapshot = { ...session, control: { kind: 'terminal', hostId: 'local', runId: 'replacement-run', run: { runId: 'replacement-run' } } }
    fixture.attach.mockResolvedValueOnce({ attachmentId: 'attachment-replacement', currentSize: { cols: 80, rows: 24 },
      session: { ...next, latestOutputBytes: 6 }, terminal: { type: 'unavailable', reason: 'source_gap' }, resizeRevision: 0, gap: null,
      replay: [{ runId: next.control.run.runId, data: 'after ', dataBytes: new TextEncoder().encode('after '), startByte: 0, endByte: 6 }] })
    const retiredStart = mono
    await act(async () => root!.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference, surface: 'space' }}>
      <TerminalView session={next} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin} />
    </WorkbenchPresentationContext.Provider>))
    await act(async () => { await vi.waitFor(() => expect(fixture.terminals[1]?.completed).toContain('after ')) })
    const retired = cleanupEventsAfter(firstId), second = fixture.terminals[1]!
    cleanupSample('retiring-xterm-run', { retired, terminals: rendererPerformance.snapshot().terminals, owners: terminalResourceOwnerCounts() })
    expect(retired).toHaveLength(1)
    expect(retired[0]).toMatchObject({ durationMs: 90, occurredAtMonoMs: retiredStart, deliveredAtMonoMs: retiredStart + 90, terminal: null,
      cleanup: { hostId: 'local', sessionId: session.id, runId: session.control.run.runId, regionId: linkOrigin.regionId,
        instanceId: expect.any(Number), operation: 'xterm-dispose', outcome: 'returned' } })
    expect(first.dispose).toHaveBeenCalledOnce(); expect(second).not.toBe(first)
    expect(fixture.detach).toHaveBeenCalledExactlyOnceWith('attachment-retained')
    expect(fixture.attach).toHaveBeenLastCalledWith(next.control, 0)
    expect(rendererPerformance.snapshot().terminals).toMatchObject([{ sessionId: next.id, runId: next.control.run.runId, liveReady: true, acceptsInput: true }])
    second.input('HEALTHY_REPLACEMENT_RUN', true)
    expect(fixture.write).toHaveBeenLastCalledWith(next.control, 'HEALTHY_REPLACEMENT_RUN', 'terminal-protocol', expect.anything())
    const disposeSecond = second.dispose.getMockImplementation()!
    second.dispose.mockImplementation(() => { mono += 80; disposeSecond() })
    await act(async () => root!.unmount()); root = null
    const final = rendererPerformance.snapshot(), events = cleanupEventsAfter(firstId)
    cleanupSample('replacement-xterm-unregistered', { events, final, owners: terminalResourceOwnerCounts() })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ durationMs: 80, cleanup: { hostId: 'local', sessionId: next.id, runId: next.control.run.runId,
      regionId: linkOrigin.regionId, operation: 'xterm-dispose', outcome: 'returned' } })
    expect(events[1]!.cleanup!.instanceId).toBeGreaterThan(events[0]!.cleanup!.instanceId)
    expect(final.terminals).toEqual([])
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(fixture.detach.mock.calls).toEqual([['attachment-retained'], ['attachment-replacement']])
    expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
  } finally {
    await act(async () => root?.unmount()); root = null
    clock.mockRestore()
  }
})

it('records a throwing WebGL dispose without swallowing its original error or revoking the retained Terminal', async () => {
  let mono = Math.ceil(performance.now())
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
  try {
    await render(true)
    const terminal = fixture.terminals[0]!, gpu = fixture.webgl[0]!, firstId = lastSlowEventId(), started = mono
    const failure = new Error('Original controlled WebGL disposal failure')
    gpu.disposed.mockImplementationOnce(() => { mono += 70; throw failure })
    let caught: unknown
    try { gpu.loseContext() } catch (error) { caught = error }
    const events = cleanupEventsAfter(firstId)
    cleanupSample('throwing-webgl', { caughtOriginal: caught === failure, events, terminals: rendererPerformance.snapshot().terminals,
      disposeCalls: gpu.disposed.mock.calls.length, terminalDisposeCalls: terminal.dispose.mock.calls.length, detachCalls: fixture.detach.mock.calls.length })
    expect(caught).toBe(failure)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ durationMs: 70, occurredAtMonoMs: started, deliveredAtMonoMs: started + 70, terminal: null,
      cleanup: { hostId: 'local', sessionId: session.id, runId: session.control.run.runId, regionId: linkOrigin.regionId,
        operation: 'webgl-dispose', outcome: 'threw' } })
    expect(gpu.disposed).toHaveBeenCalledOnce(); expect(gpu.contextLossDisposed).toHaveBeenCalledOnce()
    expect(terminal.dispose).not.toHaveBeenCalled(); expect(fixture.detach).not.toHaveBeenCalled()
    terminal.input('HEALTHY_AFTER_DISPOSE_ERROR', true)
    expect(fixture.write).toHaveBeenCalledWith(session.control, 'HEALTHY_AFTER_DISPOSE_ERROR', 'terminal-protocol', expect.anything())
    await render(false); await render(true)
    expect(fixture.terminals).toEqual([terminal]); expect(fixture.attach).toHaveBeenCalledTimes(1)
    expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({ runId: session.control.run.runId, liveReady: true, acceptsInput: true, visible: true })
    expect(events[0]!.cleanup!.instanceId).toBeGreaterThan(0)
  } finally {
    await act(async () => root?.unmount()); root = null
    clock.mockRestore()
  }
})

it.each(['webgl', 'xterm', 'both', 'undefined', 'later owners'] as const)(
  'finishes mounted TerminalView teardown in order and preserves its first thrown value: %s', async failureKind => {
    const calls: string[] = [], failure = failureKind === 'undefined' ? undefined : new Error('Original controlled disposal failure')
    const registerTerminal = rendererPerformance.registerTerminal
    const acquireOwners = terminalResourceOwners.acquireTerminalResourceOwners
    const reader = vi.spyOn(rendererPerformance, 'registerTerminal').mockImplementation(read => {
      const release = registerTerminal(read)
      return () => {
        calls.push('reader-release'); release()
        if (failureKind === 'later owners') throw new Error('Later reader release failure')
      }
    })
    const owners = vi.spyOn(terminalResourceOwners, 'acquireTerminalResourceOwners').mockImplementation(input => {
      const owner = acquireOwners(input)
      return { ...owner, release() {
        calls.push('counts-release'); owner.release()
        if (failureKind === 'later owners') throw new Error('Later count release failure')
      } }
    })
    const observation = vi.spyOn(rendererPerformance, 'terminalCleanup')
    try {
      await render(true)
      const terminal = fixture.terminals[0]!, gpu = fixture.webgl[0]!, dispose = terminal.dispose.getMockImplementation()!
      terminal.input('HEALTHY_BEFORE_EFFECT_EXIT', true)
      expect(fixture.write).toHaveBeenCalledWith(session.control, 'HEALTHY_BEFORE_EFFECT_EXIT', 'terminal-protocol', expect.anything())
      gpu.disposed.mockImplementationOnce(() => {
        calls.push('webgl')
        if (failureKind !== 'xterm') throw failure
      })
      fixture.unsubscribe.mockImplementationOnce(() => { calls.push('unsubscribe') })
      fixture.detach.mockImplementationOnce(async attachment => { calls.push(`detach:${attachment}`) })
      terminal.dispose.mockImplementationOnce(() => {
        calls.push('xterm'); dispose()
        if (failureKind === 'xterm') throw failure
        if (failureKind === 'both' || failureKind === 'undefined' || failureKind === 'later owners') throw new Error('Later xterm failure')
      })
      let caught: unknown, threw = false
      try { await act(async () => root!.unmount()) } catch (error) { threw = true; caught = error }
      root = null
      cleanupSample(`effect-teardown-${failureKind}`, { threw, caughtOriginal: caught === failure, calls,
        observation: observation.mock.calls, terminals: rendererPerformance.snapshot().terminals, owners: terminalResourceOwnerCounts() })
      expect(threw).toBe(true)
      expect(caught).toBe(failure)
      expect(calls).toEqual(['webgl', 'unsubscribe', 'detach:attachment-retained', 'xterm', 'reader-release', 'counts-release'])
      expect(gpu.disposed).toHaveBeenCalledOnce(); expect(gpu.contextLossDisposed).toHaveBeenCalledOnce()
      expect(terminal.dispose).toHaveBeenCalledOnce(); expect(fixture.unsubscribe).toHaveBeenCalledOnce()
      expect(fixture.detach).toHaveBeenCalledExactlyOnceWith('attachment-retained')
      expect(observation.mock.calls.map(([, context]) => ({ operation: context.operation, outcome: context.outcome, runId: context.runId }))).toEqual([
        { operation: 'webgl-dispose', outcome: failureKind === 'xterm' ? 'returned' : 'threw', runId: session.control.run.runId },
        { operation: 'xterm-dispose', outcome: failureKind === 'webgl' ? 'returned' : 'threw', runId: session.control.run.runId }
      ])
      expect(rendererPerformance.snapshot().terminals).toEqual([])
      expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
    } finally {
      await act(async () => root?.unmount()); root = null
      reader.mockRestore(); owners.mockRestore(); observation.mockRestore()
      fixture.unsubscribe.mockReset()
    }
  }
)

it('releases the exact retiring owners when Run replacement encounters a native disposal failure', async () => {
  const observation = vi.spyOn(rendererPerformance, 'terminalCleanup')
  try {
    await render(true)
    const first = fixture.terminals[0]!, gpu = fixture.webgl[0]!, dispose = first.dispose.getMockImplementation()!
    const failure = new Error('Original retiring WebGL failure')
    gpu.disposed.mockImplementationOnce(() => { throw failure })
    first.dispose.mockImplementationOnce(() => { dispose(); throw new Error('Later retiring xterm failure') })
    const next: SessionSnapshot = { ...session, control: { kind: 'terminal', hostId: 'local', runId: 'replacement-run', run: { runId: 'replacement-run' } } }
    let caught: unknown
    try {
      await act(async () => root!.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference, surface: 'space' }}>
        <TerminalView session={next} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin} />
      </WorkbenchPresentationContext.Provider>))
    } catch (error) { caught = error }
    expect(caught).toBe(failure)
    // React propagates the original effect error and retires its replacement tree.
    // Both generations must release their own readers and count owners; only the
    // original generation reached attachment before React retired the tree.
    expect(fixture.terminals).toHaveLength(2)
    expect(fixture.terminals.map(terminal => terminal.dispose.mock.calls.length)).toEqual([1, 1])
    expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
    expect(fixture.detach.mock.calls).toEqual([['attachment-retained']])
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(2)
    const retired = observation.mock.calls.map(([, context]) => context).filter(context => context.runId === session.control.run.runId)
    expect(retired).toMatchObject([
      { operation: 'webgl-dispose', outcome: 'threw', sessionId: session.id, regionId: linkOrigin.regionId },
      { operation: 'xterm-dispose', outcome: 'threw', sessionId: session.id, regionId: linkOrigin.regionId }
    ])
    expect(retired[0]!.instanceId).toBe(retired[1]!.instanceId)
    expect(rendererPerformance.snapshot().terminals).toEqual([])
    expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
    cleanupSample('effect-run-replacement-failure', { caughtOriginal: caught === failure, retired,
      attachments: fixture.detach.mock.calls, terminals: rendererPerformance.snapshot().terminals, owners: terminalResourceOwnerCounts() })
  } finally {
    await act(async () => root?.unmount()); root = null
    observation.mockRestore()
  }
})

it('mounts an initially hidden terminal without allocating a GPU context', async () => {
  await render(false)
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(0)
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 3, terminalListeners: 11 })
  await render(true)
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(1)
  expect(fixture.terminals[0]!.refresh).toHaveBeenCalledWith(0, 23)
})

it('reports a visible terminal awaiting attachment as unready, then observes the same Run becoming interactive', async () => {
  const attached = await fixture.attach.getMockImplementation()!()
  let resolveAttach!: (value: unknown) => void
  fixture.attach.mockReturnValue(new Promise(resolve => { resolveAttach = resolve }))
  await act(async () => root!.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin} />))
  expect(rendererPerformance.snapshot().terminals).toMatchObject([{ runId: 'run-retained', visible: true, revealed: false, liveReady: false, acceptsInput: true, replaying: true, readySinceAt: null }])
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: {
    type: 'terminal-output', run: session.control.run, data: 'live', dataBytes: new TextEncoder().encode('live'),
    evidence: { outputByteRange: { startByte: 7, endByte: 11 } }
  } } as RuntimeEvent))
  expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({ pendingItems: 1, pendingBytes: 4 })
  await act(async () => { resolveAttach(attached); await vi.waitFor(() => expect(fixture.terminals[0]?.completed).toContain('before ')) })
  const current = rendererPerformance.snapshot().terminals[0]!
  expect(current).toMatchObject({ runId: 'run-retained', visible: true, liveReady: true, acceptsInput: true, replaying: false, pendingItems: 0, pendingBytes: 0 })
  expect(current.readySinceAt).toBeGreaterThanOrEqual(current.visibleSinceAt!)
  expect(fixture.attach).toHaveBeenCalledOnce(); expect(fixture.detach).not.toHaveBeenCalled()
})

it('moves only the retained Terminal view to its actual document and keeps the original attachment and parser', async () => {
  let currentDocument=document
  const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>
  await act(async()=>root!.render(tree()))
  await act(async()=>vi.waitFor(()=>expect(fixture.terminals[0]?.completed).toContain('before ')))
  const original=fixture.terminals[0]!, originalElement=(original as unknown as {element:HTMLElement}).element, originalGpu=fixture.webgl[0]!
  expect(fixture.webgl).toHaveLength(1)
  const frame=document.createElement('iframe');document.body.append(frame)
  const child=frame.contentDocument!
  child.body.append(child.adoptNode(rootContainer));currentDocument=child
  await act(async()=>root!.render(tree()))
  expect(fixture.terminals).toHaveLength(1);expect(fixture.terminals[0]).toBe(original);expect(original.open).toHaveBeenCalledTimes(2)
  expect(originalGpu.disposed).toHaveBeenCalledOnce();expect(fixture.webgl).toHaveLength(2);expect(terminalResourceOwnerCounts().terminalAddons).toBe(4)
  expect((original as unknown as {element:HTMLElement}).element).toBe(originalElement);expect(originalElement.ownerDocument).toBe(child)
  await hiddenOutput('continued',7)
  expect(original.buffer.active.getLine(0)?.translateToString(true)).toBe('before continued')
  expect(original.dispose).not.toHaveBeenCalled();expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0)
  expect(fixture.detach).not.toHaveBeenCalled();expect(fixture.unsubscribe).not.toHaveBeenCalled()
  // The headless fixture proves the product consumer's attachment lifecycle. The real
  // native-window gate separately verifies public xterm reparenting and GPU rendering.
  await act(async()=>root!.unmount());root=null;frame.remove()
})

it.each(['reading', 'latest', 'later wheel', 'later pointer', 'later key', 'later touch'])('keeps actual terminal reading intent across its document move, reflow and later input: %s', async mode => {
  let currentDocument=document
  const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>
  await act(async()=>root!.render(tree()))
  await act(async()=>vi.waitFor(()=>expect(fixture.terminals[0]?.completed).toContain('before ')))
  const terminal=fixture.terminals[0]!, originalElement=(terminal as unknown as {element:HTMLElement}).element
  const history=Array.from({length:300},(_,index)=>`ROW_${String(index).padStart(3,'0')} ${'x'.repeat(110)}\r\n`).join('')
  await hiddenOutput(history,7)
  if(mode==='latest')terminal.scrollToBottom();else terminal.scrollToLine(60)
  const originalLine=terminal.buffer.active.viewportY, marker=mode==='latest'?undefined:terminal.registerMarker(originalLine-terminal.buffer.active.baseY-terminal.buffer.active.cursorY)
  expect(mode==='latest'||terminal.buffer.active.baseY-originalLine>20).toBe(true)
  const frameElement=document.createElement('iframe');document.body.append(frameElement)
  const child=frameElement.contentDocument!, queued=new Map<number,FrameRequestCallback>();let frameId=0
  const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(callback=>{const id=++frameId;queued.set(id,callback);return id})
  const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)})
  try{
    child.body.append(child.adoptNode(rootContainer));currentDocument=child
    await act(async()=>root!.render(tree()))
    expect(terminal.buffer.active.viewportY).toBe(originalLine)
    expect(terminalResourceOwnerCounts()).toEqual({terminalViews:1,terminalAddons:4,terminalListeners:11})
    if(mode.startsWith('later ')){
      terminal.scrollToLine(75)
      const event=mode==='later wheel'?'wheel':mode==='later pointer'?'pointerdown':mode==='later key'?'keydown':'touchstart'
      originalElement.dispatchEvent(new child.defaultView!.Event(event,{bubbles:true}))
    }else{
      // Use the same retained public parser to reflow actual wrapped rows, then
      // deliver ordered live bytes before the delayed document restore runs.
      terminal.resize(160,20)
      await hiddenOutput('continued original output\r\n'.repeat(mode==='latest'?700:1),7+history.length)
    }
    await act(async()=>{const pending=[...queued.values()];queued.clear();for(const callback of pending)callback(0)})
    expect(terminal.buffer.active.viewportY).toBe(mode==='latest'?terminal.buffer.active.baseY:mode.startsWith('later ')?75:Math.max(0,marker!.line))
    expect(fixture.terminals).toEqual([terminal]);expect(originalElement.ownerDocument).toBe(child)
    expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(fixture.unsubscribe).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled()
  }finally{marker?.dispose();await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
})


it.each(['combined grid', 'column reflow', 'column continuation', 'narrow continuation', 'wide continuation', 'wide padding chain', 'first-frame continuation', 'first-frame narrow continuation', 'missing marker', 'later wheel', 'latest'])('preserves the original reading through a settled document fit: %s', async mode => {
  fixture.realViewport = true
  const firstFrame = mode.startsWith('first-frame')
  const wrapped = mode === 'column reflow' || mode.endsWith('continuation') || mode === 'wide padding chain'
  fixture.grid = wrapped ? { cols: mode === 'wide padding chain' ? 81 : 80, rows: 61 } : { cols: 136, rows: 61 }
  let currentDocument = document
  const tree = () => <WorkbenchDocumentContext.Provider value={{ document: currentDocument, window: null }}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>
  await act(async () => root!.render(tree()))
  await act(async () => vi.waitFor(() => {
    expect(fixture.terminals[0]?.completed).toContain('before ')
    expect(fixture.terminals[0]?.cols).toBe(fixture.grid.cols)
    expect(fixture.terminals[0]?.rows).toBe(fixture.grid.rows)
    expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)
  }))
  const terminal = fixture.terminals[0]!, originalElement = (terminal as unknown as { element: HTMLElement }).element
  const history = mode === 'wide padding chain'
    ? 'short original line\r\n'.repeat(100) + 'w'.repeat(80) + '界'.repeat(3000) + '\r\n' + 'following original line\r\n'.repeat(200)
    : mode === 'wide continuation'
    ? 'short original line\r\n'.repeat(100) + 'w'.repeat(79) + '界' + 'tail'.repeat(25) + '\r\n' + 'following original line\r\n'.repeat(200)
    : Array.from({ length: 300 }, (_, index) => `HISTORY_${String(index).padStart(4, '0')} ${wrapped ? 'x'.repeat(110) : ''}\r\n`).join('')
  await hiddenOutput(history, 7)
  if (mode === 'latest') terminal.scrollToBottom()
  else terminal.scrollToLine(mode === 'column reflow' ? 112 : mode === 'wide continuation' ? 101 : mode === 'wide padding chain' ? 150 : 113)
  const firstLine = terminal.buffer.active.viewportY
  const originalCols = terminal.cols
  const frameElement = document.createElement('iframe'); document.body.append(frameElement)
  const child = frameElement.contentDocument!, queued = new Map<number, FrameRequestCallback>(); let frameId = 0
  const schedule = vi.spyOn(child.defaultView!, 'requestAnimationFrame').mockImplementation(callback => { const id = ++frameId; queued.set(id, callback); return id })
  const cancel = vi.spyOn(child.defaultView!, 'cancelAnimationFrame').mockImplementation(id => { queued.delete(id) })
  const flushFrame = async () => { await act(async () => { const callbacks = [...queued.values()]; queued.clear(); for (const callback of callbacks) callback(0) }) }
  let marker: ReturnType<FixtureTerminal['registerMarker']>
  const unavailableMarker = mode === 'missing marker' ? vi.spyOn(terminal, 'registerMarker').mockReturnValue(undefined) : null
  if (firstFrame) {
    marker = terminal.registerMarker(112 - terminal.buffer.active.baseY - terminal.buffer.active.cursorY)
    fixture.grid = { cols: mode === 'first-frame narrow continuation' ? 40 : 160, rows: 61 }
  }
  try {
    child.body.append(child.adoptNode(rootContainer)); currentDocument = child
    await act(async () => root!.render(tree()))
    // A later proposal takes two stability frames; an already settled proposal
    // fits in the first frame, before the document's own reading restore.
    fixture.grid = wrapped ? { cols: mode === 'narrow continuation' || mode === 'wide continuation' || mode === 'wide padding chain' || mode === 'first-frame narrow continuation' ? 40 : 160, rows: 61 } : { cols: 157, rows: 54 }
    await flushFrame()
    expect(terminal.cols).toBe(firstFrame ? fixture.grid.cols : originalCols)
    expect(terminal.buffer.active.viewportY).toBe(firstFrame ? marker!.line + (mode === 'first-frame narrow continuation' ? 2 : 0) : firstLine)
    if (mode === 'later wheel') {
      terminal.scrollToLine(75)
      originalElement.dispatchEvent(new child.defaultView!.Event('wheel', { bubbles: true }))
    }
    const reading = terminal.buffer.active.viewportY
    const anchorLine = mode === 'wide continuation' || mode === 'wide padding chain' ? 100 : mode.endsWith('continuation') ? 112 : reading
    if (!firstFrame) marker = mode === 'latest' || mode === 'missing marker' ? undefined : terminal.registerMarker(anchorLine - terminal.buffer.active.baseY - terminal.buffer.active.cursorY)
    await hiddenOutput('LIVE original output\r\n', 7 + history.length)
    await flushFrame()
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(fixture.grid)
    const expectedLine = mode === 'latest' ? terminal.buffer.active.baseY : mode === 'missing marker' ? reading : marker!.line + (mode === 'wide padding chain' ? 100 : mode === 'narrow continuation' || mode === 'wide continuation' || mode === 'first-frame narrow continuation' ? 2 : 0)
    expect(terminal.buffer.active.viewportY).toBe(expectedLine)
    if (mode === 'wide continuation') expect(terminal.buffer.active.getLine(expectedLine)?.translateToString()).toMatch(/^界/)
    if (mode === 'column reflow') expect(marker!.line).toBeLessThan(reading)
    expect(fixture.resize).toHaveBeenCalledWith('attachment-retained', fixture.grid.cols, fixture.grid.rows)
    expect(fixture.terminals).toEqual([terminal]); expect(originalElement.ownerDocument).toBe(child)
    expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
    expect(fixture.detach).not.toHaveBeenCalled(); expect(fixture.unsubscribe).not.toHaveBeenCalled(); expect(terminal.dispose).not.toHaveBeenCalled()
  } finally {
    unavailableMarker?.mockRestore(); marker?.dispose(); await act(async () => root!.unmount()); root = null
    schedule.mockRestore(); cancel.mockRestore(); frameElement.remove()
  }
})


// This is the public range-adapter boundary, with actual parser/reflow/markers.
// Browser SelectionService/content preservation is qualified separately in the
// ordinary Electron App with trusted pointer selection, never simulated here.
it.each(['combined short', 'hard newline', 'wrapped continuation', 'wide continuation', 'cursor continuation', 'same columns', 'trailing newline', 'reverse', 'word minimum', 'wrapped minimum', 'column'])('maps the public retained selection range through actual document reflow: %s', async mode => {
  fixture.realViewport = true
  const wrapped = mode === 'wrapped continuation' || mode === 'wide continuation' || mode === 'cursor continuation' || mode === 'wrapped minimum'
  fixture.grid = { cols: wrapped ? 80 : 136, rows: 61 }
  let currentDocument = document
  const tree = () => <WorkbenchDocumentContext.Provider value={{ document: currentDocument, window: null }}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>
  await act(async () => root!.render(tree()))
  await act(async () => vi.waitFor(() => {
    expect(fixture.terminals[0]?.completed).toContain('before ')
    expect(fixture.terminals[0]?.cols).toBe(fixture.grid.cols)
    expect(fixture.terminals[0]?.rows).toBe(fixture.grid.rows)
    expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)
  }))
  const terminal = fixture.terminals[0]!
  const history = mode === 'cursor continuation'
    ? 'short original line\r\n'.repeat(100) + 'A'.repeat(80) + 'B'.repeat(40)
    : mode === 'wide continuation'
    ? 'short original line\r\n'.repeat(100) + 'w'.repeat(79) + '界' + 'tail'.repeat(25) + '\r\n' + 'following original line\r\n'.repeat(200)
    : Array.from({ length: 300 }, (_, index) => `HISTORY_${String(index).padStart(4, '0')} ${wrapped ? 'x'.repeat(110) : ''}\r\n`).join('')
  await hiddenOutput(history, 7)
  terminal.scrollToLine(mode === 'wide continuation' ? 101 : 113)
  fixture.selection = mode === 'cursor continuation'
    ? { start: { x: 2, y: 101 }, end: { x: 20, y: 101 } }
    : mode === 'wide continuation'
    ? { start: { x: 0, y: 101 }, end: { x: 2, y: 101 } }
    : mode === 'wrapped continuation'
      ? { start: { x: 2, y: 113 }, end: { x: 20, y: 113 } }
      : { start: { x: 1, y: 115 }, end: { x: 14, y: mode === 'hard newline' ? 116 : 115 } }
  if (mode === 'wrapped minimum') fixture.snapshot = { anchor: { x: 76, y: 112 }, active: { x: 2, y: 112 }, minimumEnd: { x: 6, y: 113 }, mode: 'word', selectAll: false }
  if (mode === 'trailing newline') fixture.snapshot = { anchor: { x: 1, y: 115 }, active: { x: 0, y: 116 }, mode: 'normal', selectAll: false }
  if (mode === 'reverse') fixture.snapshot = { anchor: { x: 14, y: 116 }, active: { x: 1, y: 115 }, mode: 'normal', selectAll: false }
  if (mode === 'word minimum') fixture.snapshot = { anchor: { x: 1, y: 115 }, active: { x: 1, y: 116 }, minimumEnd: { x: 14, y: 115 }, mode: 'word', selectAll: false }
  if (mode === 'column') fixture.snapshot = { anchor: { x: 14, y: 116 }, active: { x: 1, y: 115 }, mode: 'column', selectAll: false }
  const frameElement = document.createElement('iframe'); document.body.append(frameElement)
  const child = frameElement.contentDocument!, queued = new Map<number, FrameRequestCallback>(); let frameId = 0
  const schedule = vi.spyOn(child.defaultView!, 'requestAnimationFrame').mockImplementation(callback => { const id = ++frameId; queued.set(id, callback); return id })
  const cancel = vi.spyOn(child.defaultView!, 'cancelAnimationFrame').mockImplementation(id => { queued.delete(id) })
  const flushFrame = async () => { await act(async () => { const callbacks = [...queued.values()]; queued.clear(); for (const callback of callbacks) callback(0) }) }
  try {
    child.body.append(child.adoptNode(rootContainer)); currentDocument = child
    await act(async () => root!.render(tree()))
    fixture.grid = { cols: mode === 'wide continuation' ? 40 : mode === 'wrapped continuation' || mode === 'cursor continuation' || mode === 'wrapped minimum' ? 160 : mode === 'same columns' ? 136 : 157, rows: 54 }
    await flushFrame(); await flushFrame()
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(fixture.grid)
    const expected = mode === 'cursor continuation' ? [{ x: 2, y: 101 }, { x: 20, y: 101 }] : mode === 'wide continuation' ? [{ x: 0, y: 102 }, { x: 2, y: 102 }] : mode === 'wrapped continuation' ? [{ x: 82, y: 56 }, { x: 100, y: 56 }] : [{ x: 1, y: 115 }, { x: 14, y: mode === 'hard newline' ? 116 : 115 }]
    expect(terminal.restoreSelection).toHaveBeenLastCalledWith((mode === 'wrapped minimum' ? { anchor: { x: 76, y: 56 }, active: { x: 2, y: 56 }, minimumEnd: { x: 86, y: 56 }, mode: 'word', selectAll: false } : fixture.snapshot) ?? { anchor: expected[0], active: expected[1], mode: 'normal', selectAll: false })
    expect(fixture.terminals).toEqual([terminal]); expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
    expect(fixture.detach).not.toHaveBeenCalled(); expect(terminal.dispose).not.toHaveBeenCalled()
  } finally {
    await act(async () => root!.unmount()); root = null
    schedule.mockRestore(); cancel.mockRestore(); frameElement.remove()
  }
})

it.each(['whole tail', 'wide partial tail', 'blank tail'])('restores retained native endpoints after wrapped prefix trimming: %s', async mode => {
 fixture.realViewport=true; fixture.grid={cols:80,rows:61}; let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));
 await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.completed).toContain('before ');expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\r\u001b[2K'+'A'.repeat(1200)+'SELECTED'+(mode === 'whole tail' ? 'A'.repeat(392) : mode === 'blank tail' ? 'A'.repeat(342) : 'A'.repeat(376) + '界 ')+'\r\n'+'short\r\n'.repeat(5040),7);
 const y=15;
 fixture.selection={start:{x:0,y},end:mode === 'blank tail' ? {x:70,y:19} : {x:8,y}};
 expect(terminal.buffer.active.getLine(y)?.translateToString(true,0,8)).toBe('SELECTED');
 const frameElement=document.createElement('iframe');document.body.append(frameElement);
 const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let frameId=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(callback=>{const id=++frameId;queued.set(id,callback);return id});
 const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flushFrame=async()=>{await act(async()=>{const callbacks=[...queued.values()];queued.clear();for(const callback of callbacks)callback(0)})};
 try{
  child.body.append(child.adoptNode(rootContainer));currentDocument=child;await act(async()=>root!.render(tree()));fixture.grid={cols:40,rows:54};await flushFrame();await flushFrame();
  expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);
  const retainedRow = mode === 'blank tail' ? 4 : 3;
  expect(terminal.buffer.active.getLine(retainedRow)?.translateToString(true,0,8),'selected original cells still retained').toBe('SELECTED');
  const calls=terminal.restoreSelection.mock.calls;expect(calls.length,'retained range must be restored').toBeGreaterThan(0);
  const snapshot=calls.at(-1)![0] as ISelectionSnapshot;
  expect(snapshot).toEqual({anchor:{x:0,y:retainedRow},active:mode === 'blank tail' ? {x:40,y:12} : {x:8,y:retainedRow},mode:'normal',selectAll:false});
  expect(terminal.buffer.active.getLine(snapshot.anchor.y)?.translateToString(true,snapshot.anchor.x,snapshot.anchor.x + 8),'selected retained content').toBe('SELECTED');
  expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});


it.each(['forward', 'reverse', 'column'])('clips only the discarded end of a native partial selection and keeps direction: %s', async direction => {
  const reverse = direction === 'reverse'
  const mode = direction === 'column' ? 'column' : 'normal'
  fixture.realViewport = true
  fixture.grid = { cols: 80, rows: 61 }
  let currentDocument = document
  const tree = () => <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>
  await act(async () => root!.render(tree()))
  await act(async () => vi.waitFor(() => expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)))
  const terminal = fixture.terminals[0]!
  await hiddenOutput('\r\u001b[2K' + Array.from({length: 5100}, (_, index) => `ROW${String(index).padStart(4,'0')}\r\n`).join(''), 7)
  fixture.snapshot = { anchor: reverse ? {x:5,y:10} : {x:direction === 'column' ? 5 : 0,y:0}, active: reverse ? {x:0,y:0} : {x:direction === 'column' ? 10 : 5,y:10}, mode, selectAll:false }
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentDocument!, queued = new Map<number, FrameRequestCallback>(); let nextFrame = 0
  const schedule = vi.spyOn(child.defaultView!, 'requestAnimationFrame').mockImplementation(callback => { queued.set(++nextFrame, callback); return nextFrame })
  const cancel = vi.spyOn(child.defaultView!, 'cancelAnimationFrame').mockImplementation(id => { queued.delete(id) })
  child.body.append(child.adoptNode(rootContainer)); currentDocument = child
  await act(async () => root!.render(tree()))
  fixture.grid = { cols:80, rows:54 }
  for (let i = 0; i < 2; i += 1) await act(async () => { const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach(callback => callback(0)) })
  expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid)
  expect(terminal.restoreSelection).toHaveBeenLastCalledWith({anchor:reverse ? {x:5,y:3} : {x:0,y:0},active:reverse ? {x:0,y:0} : {x:direction === 'column' ? 10 : 5,y:3},mode,selectAll:false})
  expect(fixture.terminals).toEqual([terminal]); expect(fixture.detach).not.toHaveBeenCalled()
  await act(async () => root!.unmount()); root = null
  schedule.mockRestore(); cancel.mockRestore(); frame.remove()
})

it.each(['retained rows', 'top trimmed'])('restores native alternate selection from actual synchronous cursor movement: %s',async mode=>{
 fixture.realViewport=true;fixture.grid={cols:80,rows:61};let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\u001b[?1049h'+Array.from({length:20},(_,i)=>'ALT_'+String(i).padStart(4,'0')+'\r\n').join('')+(mode === 'top trimmed' ? '\u001b[61;1H' : ''),7);
 expect(terminal.buffer.active.type).toBe('alternate');expect(terminal.buffer.active.getLine(10)?.translateToString(true)).toBe('ALT_0010');expect(terminal.buffer.active.getLine(11)?.translateToString(true)).toBe('ALT_0011');
 fixture.selection={start:{x:1,y:10},end:{x:8,y:11}};
 const frameElement=document.createElement('iframe');document.body.append(frameElement);const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let id=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flush=async()=>act(async()=>{const all=[...queued.values()];queued.clear();for(const fn of all)fn(0)});
 try{
 child.body.append(child.adoptNode(rootContainer));currentDocument=child;await act(async()=>root!.render(tree()));fixture.grid={cols:100,rows:54};await flush();await flush();
 expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);expect(terminal.buffer.active.type).toBe('alternate');
 const first = mode === 'top trimmed' ? 3 : 10;
 expect(terminal.buffer.active.getLine(first)?.translateToString(true)).toBe('ALT_0010');expect(terminal.buffer.active.getLine(first+1)?.translateToString(true)).toBe('ALT_0011');
 expect(terminal.restoreSelection,'retained native alt-buffer range is restored').toHaveBeenLastCalledWith({anchor:{x:1,y:first},active:{x:8,y:first+1},mode:'normal',selectAll:false});
 expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});

it('does not invent a row before a fully evicted wrapped group and keeps healthy input', async () => {
 fixture.realViewport=true; fixture.grid={cols:80,rows:61}; let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));
 await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.completed).toContain('before ');expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\r\u001b[2K'+'A'.repeat(160)+'\r\n'+'short\r\n'.repeat(5053),7);
 terminal.scrollToLine(1);
 fixture.snapshot={anchor:{x:79,y:1},active:{x:80,y:1},mode:'normal',selectAll:false};
 expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('A'.repeat(80));
 const frameElement=document.createElement('iframe');document.body.append(frameElement);
 const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let frameId=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(callback=>{const id=++frameId;queued.set(id,callback);return id});
 const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flushFrame=async()=>{await act(async()=>{const callbacks=[...queued.values()];queued.clear();for(const callback of callbacks)callback(0)})};
 try{
  child.body.append(child.adoptNode(rootContainer));currentDocument=child;await act(async()=>root!.render(tree()));fixture.grid={cols:40,rows:54};await flushFrame();await flushFrame();
  expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('short');
  expect(terminal.buffer.active.viewportY,'evicted original reading resumes at first retained row').toBe(0);
  const snapshot=terminal.restoreSelection.mock.calls.at(-1)![0] as ISelectionSnapshot;
  expect(snapshot).toEqual({anchor:{x:0,y:0},active:{x:0,y:0},mode:'normal',selectAll:false});
  expect(rendererPerformance.snapshot().terminals[0]).toMatchObject({liveReady:true,acceptsInput:true});
  terminal.input('HEALTHY_AFTER_TRIM',true);
  expect(fixture.write).toHaveBeenCalledWith(session.control,'HEALTHY_AFTER_TRIM','terminal-protocol',expect.anything());
  expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});


it('keeps native alternate physical cells and minimum length through narrowing and return',async()=>{
 fixture.realViewport=true;fixture.grid={cols:80,rows:61};let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\u001b[?1049h\r'+Array.from({length:78},(_,index)=>String.fromCharCode(65+index%26)).join(''),7);
 expect(terminal.buffer.active.getLine(0)?.translateToString(true,60,65)).toBe('IJKLM');
 fixture.snapshot={anchor:{x:60,y:0},minimumEnd:{x:65,y:0},mode:'normal',selectAll:false};
 const frameElement=document.createElement('iframe');document.body.append(frameElement);const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let id=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flush=async()=>act(async()=>{const all=[...queued.values()];queued.clear();for(const fn of all)fn(0)});
 try{
 child.body.append(rootContainer);currentDocument=child;await act(async()=>root!.render(tree()));fixture.grid={cols:40,rows:54};await flush();await flush();
 expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);expect(terminal.buffer.active.type).toBe('alternate');
 expect(terminal.buffer.active.getLine(0)?.length).toBe(80);
 const narrowed: ISelectionSnapshot={anchor:{x:60,y:0},minimumEnd:{x:25,y:1},mode:'normal',selectAll:false};
 expect(terminal.restoreSelection.mock.calls.length,'the retained native selection is restored').toBeGreaterThan(0);
 const sent=terminal.restoreSelection.mock.calls.at(-1)![0] as ISelectionSnapshot;
 expect(sent.anchor).toEqual({x:60,y:0}); expect(sent.mode).toBe('normal');
 expect((sent.minimumEnd!.y-sent.anchor.y)*40+sent.minimumEnd!.x-sent.anchor.x).toBe(5);
 // The actual native getter encodes its unchanged five-cell minimum in the
 // narrower grid. That encoding is metadata, not a new physical content row.
 fixture.snapshot=narrowed;
 const mainSchedule=vi.spyOn(document.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});
 const mainCancel=vi.spyOn(document.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 try{
 document.body.append(rootContainer);currentDocument=document;
 await act(async()=>root!.render(tree()));fixture.grid={cols:80,rows:61};await flush();await flush();
 const returned=terminal.restoreSelection.mock.calls.at(-1)![0] as ISelectionSnapshot;
 expect(returned.anchor).toEqual({x:60,y:0}); expect(returned.mode).toBe('normal');
 expect((returned.minimumEnd!.y-returned.anchor.y)*80+returned.minimumEnd!.x-returned.anchor.x).toBe(5);
 expect(terminal.buffer.active.getLine(0)?.translateToString(true,60,65)).toBe('IJKLM');
 }finally{mainSchedule.mockRestore();mainCancel.mockRestore()}
 expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});


it('keeps the native cursor-group word minimum length through narrowing and return',async()=>{
 fixture.realViewport=true;fixture.grid={cols:80,rows:61};let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\r\u001b[2K'+'short original line\r\n'.repeat(100)+'A'.repeat(37)+' WORD5 '+'A'.repeat(36)+'B'.repeat(40),7);
 expect(terminal.buffer.active.getLine(100)?.translateToString(true,38,43)).toBe('WORD5');
 fixture.snapshot={anchor:{x:38,y:100},minimumEnd:{x:43,y:100},mode:'word',selectAll:false};
 const frameElement=document.createElement('iframe');document.body.append(frameElement);const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let id=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flush=async()=>act(async()=>{const all=[...queued.values()];queued.clear();for(const fn of all)fn(0)});
 try{
 child.body.append(rootContainer);currentDocument=child;await act(async()=>root!.render(tree()));fixture.grid={cols:40,rows:54};await flush();await flush();
 expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);expect(terminal.buffer.active.type).toBe('normal');
 expect(terminal.buffer.active.getLine(100)?.translateToString(true,38,40)).toBe('WO');
 expect(terminal.restoreSelection.mock.calls.length,'the retained native selection is restored').toBeGreaterThan(0);
 const sent=terminal.restoreSelection.mock.calls.at(-1)![0] as ISelectionSnapshot;
 expect(sent.anchor).toEqual({x:38,y:100}); expect(sent.mode).toBe('word');
 expect((sent.minimumEnd!.y-sent.anchor.y)*40+sent.minimumEnd!.x-sent.anchor.x).toBe(5);
 const narrowed: ISelectionSnapshot={anchor:{x:38,y:100},minimumEnd:{x:3,y:101},mode:'word',selectAll:false};
 // The actual native getter encodes its unchanged five-cell minimum in the
 // narrower grid. That encoding is metadata, not a new physical content row.
 fixture.snapshot=narrowed;
 const mainSchedule=vi.spyOn(document.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});
 const mainCancel=vi.spyOn(document.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 try{
 document.body.append(rootContainer);currentDocument=document;
 await act(async()=>root!.render(tree()));fixture.grid={cols:80,rows:61};await flush();await flush();
 const returned=terminal.restoreSelection.mock.calls.at(-1)![0] as ISelectionSnapshot;
 expect(returned.anchor).toEqual({x:38,y:100}); expect(returned.mode).toBe('word');
 expect((returned.minimumEnd!.y-returned.anchor.y)*80+returned.minimumEnd!.x-returned.anchor.x).toBe(5);
 // Native shrinking already discarded the tail; never manufacture WORD5 back.
 expect(terminal.buffer.active.getLine(100)?.translateToString(true,38,43)).toBe('WO');
 }finally{mainSchedule.mockRestore();mainCancel.mockRestore()}
 expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});


it('does not submit discarded cursor-group cells as a restored range or stop healthy input',async()=>{
 fixture.realViewport=true;fixture.grid={cols:80,rows:61};let currentDocument=document;
 const tree=()=> <WorkbenchDocumentContext.Provider value={{document:currentDocument,window:null}}><TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={linkOrigin}/></WorkbenchDocumentContext.Provider>;
 await act(async()=>root!.render(tree()));await act(async()=>vi.waitFor(()=>{expect(fixture.terminals[0]?.cols).toBe(80);expect(fixture.terminals[0]?.rows).toBe(61);expect(rendererPerformance.snapshot().terminals[0]?.liveReady).toBe(true)}));
 const terminal=fixture.terminals[0]!;
 await hiddenOutput('\r\u001b[2K'+'short original line\r\n'.repeat(100)+'A'.repeat(37)+' WORD5 '+'A'.repeat(36)+'B'.repeat(40),7);
 expect(terminal.buffer.active.getLine(100)?.translateToString(true,60,65)).toBe('AAAAA');
 fixture.snapshot={anchor:{x:60,y:100},active:{x:65,y:100},mode:'normal',selectAll:false};
 const frameElement=document.createElement('iframe');document.body.append(frameElement);const child=frameElement.contentDocument!,queued=new Map<number,FrameRequestCallback>();let id=0;
 const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame').mockImplementation(fn=>{queued.set(++id,fn);return id});const cancel=vi.spyOn(child.defaultView!,'cancelAnimationFrame').mockImplementation(id=>{queued.delete(id)});
 const flush=async()=>act(async()=>{const all=[...queued.values()];queued.clear();for(const fn of all)fn(0)});
 try{
 child.body.append(rootContainer);currentDocument=child;await act(async()=>root!.render(tree()));terminal.restoreSelection.mockClear();fixture.grid={cols:40,rows:54};await flush();await flush();
 expect({cols:terminal.cols,rows:terminal.rows}).toEqual(fixture.grid);expect(terminal.buffer.active.type).toBe('normal');
 expect(terminal.buffer.active.getLine(100)?.length).toBe(40);
 expect(terminal.buffer.active.getLine(100)?.getCell(60)).toBeUndefined();
 expect(terminal.restoreSelection).not.toHaveBeenCalled();
 terminal.input('HEALTHY_AFTER_CELL_TRIM',true);
 expect(fixture.write).toHaveBeenCalledWith(session.control,'HEALTHY_AFTER_CELL_TRIM','terminal-protocol',expect.anything());
 expect(fixture.terminals).toEqual([terminal]);expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control,0);expect(fixture.detach).not.toHaveBeenCalled();expect(terminal.dispose).not.toHaveBeenCalled();
 }finally{await act(async()=>root!.unmount());root=null;schedule.mockRestore();cancel.mockRestore();frameElement.remove()}
});
