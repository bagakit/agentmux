const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { tabSwitchObservation } from '../src/renderer/src/lib/tab-switch-observation'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'

type FixtureTerminal = HeadlessTerminal & {
  refresh: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  written: string[]
  completed: string[]
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
  unsubscribe: vi.fn()
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
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  activate() {}
  dispose() {}
  fit() {}
  proposeDimensions() { return { cols: 80, rows: 24 } }
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
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({
  TerminalViewportSynchronizer: class {
    beginReplay() {}
    endReplay() {}
    setInteractiveResize() {}
    setVisible() {}
    synchronizeCellMetrics() {}
    observeViewport() {}
    acceptOwnerSize() {}
    async startLiveSynchronization() {}
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))

const session: SessionSnapshot = {
  id: 'session-retained', hostId: 'local', workspacePath: _hygiene_fixturePath("fixture"), label: 'Retained',
  createdAt: 1, updatedAt: 1, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
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
  vi.clearAllMocks()
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-retained', currentSize: { cols: 80, rows: 24 },
    session: { ...session, latestOutputBytes: 7 }, terminal: { type: 'unavailable', reason: 'source_gap' },
    resizeRevision: 0, gap: null,
    replay: [{ runId: session.control.run.runId, data: 'before ', dataBytes: new TextEncoder().encode('before '), startByte: 0, endByte: 7 }] })
  fixture.detach.mockResolvedValue(undefined)
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

it('reports a warm Terminal switch through its actual visibility hook without attaching again', async () => {
  await render(true); await render(false)
  const original = fixture.terminals[0], readySinceAt = rendererPerformance.snapshot().terminals[0]!.readySinceAt
  const release = tabSwitchObservation.registerPlacement(switchTarget, () => true)
  try {
    tabSwitchObservation.begin(switchTarget, 'terminal', performance.now()); tabSwitchObservation.selected(switchTarget)
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
  expect(rendererPerformance.snapshot().terminals).toMatchObject([{ runId: 'run-retained', visible: true, revealed: false, liveReady: false, acceptsInput: false, replaying: true, readySinceAt: null }])
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
