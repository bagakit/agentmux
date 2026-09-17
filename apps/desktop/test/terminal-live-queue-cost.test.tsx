// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { RuntimeEvent, AppConfig, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { TERMINAL_REPLAY_BATCH_BYTES } from '../src/renderer/src/lib/terminal-replay'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Real public xterm parser/buffers/modes, TerminalView, Store and viewport synchronizer.
// DOM painting/addons and Runtime IPC transport are fixture boundaries. Root's Native gate
// separately owns the real PTY checkpoint/SDK and Chromium wheel delivery.
const fixture = vi.hoisted(() => ({
  terminals: [] as BrowserTerminal[],
  focus: vi.fn(), writes: [] as Uint8Array[], grids: [] as Array<{cols:number;rows:number}>,
  boundaryReads: 0, composeCalls: 0
}))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    open(root: HTMLElement) {
      this.element = document.createElement('div'); this.element.dataset.privateWheelSurface = 'true'; root.append(this.element)
    }
    write(data: string | Uint8Array, callback?: () => void) {
      fixture.writes.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice())
      super.write(data, callback)
    }
    resize(cols: number, rows: number) { fixture.grids.push({cols,rows}); super.resize(cols,rows) }
    refresh() {}
    focus() { fixture.focus() }
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
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))

const originalState = useAppStore.getState()
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: 'wheel-agent', hostId: 'local', workspacePath: '/synthetic', label: 'Wheel Agent', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'wheel-agent', run: { runId: 'wheel-run' } }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'wheel-region' }
const repaint = '\x1b[1;1HPrivate screen\x1b[0K\x1b[0J'
let root: Root
let container: HTMLDivElement
let attach: MockInstance<typeof api.sessions.attach>
let write: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof api.sessions.recover>
const releases: Array<() => void> = []
let configuration: AppConfig
let receive: (event: RuntimeEvent) => void = () => {}
function state(current: SessionSnapshot = session) {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: current.kind, phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config: configuration, closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: {}, agentNames: {} })
}
function replay(data: string, current: SessionSnapshot = session): SessionAttachResult {
  return { attachmentId: 'wheel-attachment', session: current, currentSize: { cols: 80, rows: 24 }, gap: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: current.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
async function render(current: SessionSnapshot = session) {
  await act(async () => root.render(createElement(TerminalView, { session: current,
    interactiveResize: false, visible: true, autoFocus: false, themeId: configuration.appearance.terminalTheme, linkOrigin: origin })))
}
async function ready(result: SessionAttachResult) {
  state(result.session); attach.mockResolvedValue(result); await render(result.session)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: result.session.id, runId: result.session.control.run.runId})).toMatchObject({liveReady:true})))
  expect(fixture.terminals).toHaveLength(1); return fixture.terminals[0]!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0; fixture.writes.length = 0; fixture.grids.length = 0; fixture.focus.mockClear()
  fixture.boundaryReads = 0; fixture.composeCalls = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(repaint))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation((listener: (event: RuntimeEvent) => void) => { receive = listener; return () => {} })
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  recover = vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  configuration = await api.config.get()
  state(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { releases.splice(0).forEach(release => release()); await Promise.resolve() })
  await act(async () => root.unmount()); useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})


// Instrument actual incoming queue-item property reads and composition calls. The original
// production algorithms and original raw bytes still run; this does not substitute a queue.
vi.mock('../src/renderer/src/lib/terminal-live-output', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/terminal-live-output')>()
  return { ...actual,
    TerminalLiveOutputQueue: class extends actual.TerminalLiveOutputQueue {
      admit(incoming: Parameters<typeof actual.TerminalLiveOutputQueue.prototype.admit>[0]) {
        const measured = new Proxy(incoming, {get(target,property,receiver) {
          if (property === 'startByte' || property === 'endByte') fixture.boundaryReads += 1
          return Reflect.get(target,property,receiver)
        }})
        return super.admit(measured)
      }
    },
    composeTerminalLiveOutputWrite: (...args: Parameters<typeof actual.composeTerminalLiveOutputWrite>) => {
      fixture.composeCalls += 1
      return actual.composeTerminalLiveOutputWrite(...args)
    }
  }
})

function output(startByte: number, data: string): RuntimeEvent {
  const dataBytes = new TextEncoder().encode(data)
  return {type:'core',hostId:session.hostId,event:{type:'terminal-output',agentSessionId:session.id,run:session.control.run,data,dataBytes,
    evidence:{source:'terminal-output',observedAt:1,outputByteRange:{startByte,endByte:startByte+dataBytes.byteLength}}}}
}
function contents(terminal: BrowserTerminal) {
  const buffer = terminal.buffer.active
  return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)!.translateToString(true)).join('\n')
}
function holdWrite(terminal: BrowserTerminal, marker: string) {
  let release: () => void = () => {}
  let landed!: () => void
  const started = new Promise<void>(resolve => {landed=resolve})
  const original = terminal.write.bind(terminal)
  const spy = vi.spyOn(terminal,'write').mockImplementation((data, callback) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    if (text !== marker) { original(data,callback); return }
    original(data,()=>{release=()=>callback?.();landed()})
  })
  releases.push(()=>{release();spy.mockRestore()})
  return {started,release:()=>release()}
}

it.each([128,256])('admits %i real held-parser items with linear boundary work and preserves exact output and healthy input', async count => {
  const terminal = await ready(replay(repaint))
  const held = holdWrite(terminal,'HELD')
  await act(async()=>{receive(output(repaint.length,'HELD'));await held.started})
  fixture.boundaryReads = 0; fixture.composeCalls = 0
  await act(async()=>{
    for(let i=0;i<count;i++) receive(output(repaint.length+4+i,'Q'))
  })
  // This observes the actual production queue while the write callback holds its sole drain.
  // The old implementation rereads every old item on each admission (65,792 reads here).
  expect(fixture.boundaryReads).toBeGreaterThan(0)
  expect(fixture.boundaryReads).toBe(count*2)
  expect(fixture.composeCalls).toBe(0)
  await act(async()=>{held.release();await vi.waitFor(()=>expect(fixture.writes.at(-1)).toEqual(new TextEncoder().encode('Q'.repeat(count))))})
  expect(contents(terminal).replace(/\n/g,'')).toContain('Private screenHELD'+'Q'.repeat(count))
  expect(fixture.composeCalls).toBe(1)
  expect(fixture.terminals).toEqual([terminal])
  expect(recover).not.toHaveBeenCalled()
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z')
})

it('composes a normal nonempty same-turn batch only once through the mounted consumer', async () => {
  const terminal=await ready(replay(repaint))
  fixture.composeCalls=0
  await act(async()=>{
    receive(output(repaint.length,'NORMAL'))
    receive(output(repaint.length+6,'-TAIL'))
    await vi.waitFor(()=>expect(contents(terminal)).toContain('Private screenNORMAL-TAIL'))
  })
  expect(fixture.composeCalls).toBe(1)
  expect(fixture.writes.at(-1)).toEqual(new TextEncoder().encode('NORMAL-TAIL'))
  expect(fixture.terminals).toEqual([terminal])
  expect(recover).not.toHaveBeenCalled()
})
