const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { tmpdir } from 'node:os'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentMuxRunAttachment, AgentMuxTerminalContinuation } from '@agentmux/core'
import type { RuntimeEvent, AppConfig, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import type { TerminalSessionSource } from '../src/renderer/src/lib/terminal-session-source'
import { TERMINAL_REPLAY_BATCH_BYTES } from '@agentmux/client-ui/terminal/replay'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { parseRendererPerformanceSnapshot } from '@agentmux/core/control'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})

// Real public xterm parser/buffers/modes, TerminalView, Store and viewport synchronizer.
// DOM painting/addons and Runtime IPC transport are fixture boundaries. Root's Native gate
// separately owns the real PTY checkpoint/SDK and Chromium wheel delivery.
const fixture = vi.hoisted(() => ({
  terminals: [] as BrowserTerminal[],
  beforeCallback: null as (() => void) | null, holdCallbacks: false, callbacks: [] as Array<() => void>,
  focus: vi.fn(), writes: [] as Uint8Array[], grids: [] as Array<{cols:number;rows:number}>,
  writeFacts: [] as Array<{ cols: number; rows: number; scrollback: number | undefined }>
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
      fixture.writeFacts.push({ cols: this.cols, rows: this.rows, scrollback: this.options.scrollback })
      super.write(data, () => {
        const complete = () => { fixture.beforeCallback?.(); callback?.() }
        if (fixture.holdCallbacks) fixture.callbacks.push(complete); else complete()
      })
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
  id: 'wheel-agent', hostId: 'local', workspacePath: _hygiene_fixturePath("synthetic"), label: 'Wheel Agent', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
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
let refreshObservation: (() => Promise<void>) | null = null
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
async function render(current: SessionSnapshot = session, visible = true, linkOrigin = origin, sessionSource?: TerminalSessionSource) {
  await act(async () => root.render(createElement(TerminalView, { session: current,
    interactiveResize: false, visible, autoFocus: false, ...(sessionSource ? { sessionSource } : {}), themeId: configuration.appearance.terminalTheme, linkOrigin,
    onObservationRefresh: (refresh: (() => Promise<void>) | null) => { refreshObservation = refresh } })))
}
async function ready(result: SessionAttachResult) {
  state(result.session); attach.mockResolvedValue(result); await render(result.session)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: result.session.id, runId: result.session.control.run.runId})).toMatchObject({liveReady:true})))
  expect(fixture.terminals).toHaveLength(1); return fixture.terminals[0]!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.beforeCallback = null; fixture.holdCallbacks = false; fixture.callbacks.length = 0
  fixture.terminals.length = 0; fixture.writes.length = 0; fixture.grids.length = 0; fixture.writeFacts.length = 0; fixture.focus.mockClear()
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


const fence = 10 * 1024 * 1024
const encoder = new TextEncoder()
function continuation(seed: string, tail = '', resizes: Extract<AgentMuxTerminalContinuation, {type:'basic-vt'}>['resizes'] = []): SessionAttachResult {
  const dataBytes = encoder.encode(tail)
  const endByte = fence + dataBytes.byteLength
  return {
    attachmentId:'wheel-attachment', session:{...session, latestOutputBytes:endByte},
    currentSize:resizes.at(-1)?.size ?? {cols:80,rows:24}, gap:null, resizeRevision:resizes.at(-1)?.resizeRevision ?? 3,
    terminal:{type:'basic-vt',checkpoint:{runId:session.control.run.runId,throughByte:fence,resizeRevision:3,size:{cols:80,rows:24},
      restoreSize:{cols:80,rows:24},restoreScrollbackRows:null,resizeAfterRestoreBytes:0,historyPolicy:{status:'observed',scrollbackRows:10_000}},
      restoreBytes:encoder.encode(seed),resizes},
    replay:dataBytes.length ? [{type:'data',runId:session.control.run.runId,startByte:fence,endByte,dataBytes,data:tail}] : []
  }
}
function output(startByte: number, data: string): RuntimeEvent {
  const dataBytes = encoder.encode(data)
  return {type:'core',hostId:'local',event:{type:'terminal-output',agentSessionId:session.id,run:session.control.run,data,dataBytes,
    evidence:{source:'terminal-output',observedAt:1,outputByteRange:{startByte,endByte:startByte+dataBytes.byteLength}}}}
}
function resized(throughByte: number, resizeRevision: number, cols: number, rows: number): RuntimeEvent {
  return {type:'core',hostId:'local',event:{type:'terminal-resized',agentSessionId:session.id,run:session.control.run,throughByte,resizeRevision,cols,rows}}
}
function contents(terminal: BrowserTerminal) {
  const buffer = terminal.buffer.active
  return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)!.translateToString(true)).join('\n')
}

it('imports prefix and suffix at their distinct owner grids with temporary scrollback before live bytes and input continue', async () => {
  const prefix = '0123456789ABC\r\nfirst line\r\n', suffix = 'final-seed'
  const result = continuation(prefix + suffix)
  if (result.terminal.type !== 'basic-vt') throw new Error('Missing test checkpoint')
  result.terminal.checkpoint.restoreSize = { cols: 12, rows: 6 }
  result.terminal.checkpoint.restoreScrollbackRows = 31
  result.terminal.checkpoint.resizeAfterRestoreBytes = encoder.encode(prefix).length
  const terminal = await ready(result)
  expect(fixture.writeFacts.slice(0, 2)).toEqual([
    { cols: 12, rows: 6, scrollback: 31 }, { cols: 80, rows: 24, scrollback: 10_000 }
  ])
  expect(terminal.options.scrollback).toBe(10_000)
  const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  const reference = new actual.Terminal({ cols: 12, rows: 6, scrollback: 31 })
  try {
    await new Promise<void>(resolve => reference.write(prefix, resolve))
    reference.options.scrollback = 10_000
    reference.resize(80, 24)
    await new Promise<void>(resolve => reference.write(suffix, resolve))
    reference.options.scrollback = terminal.options.scrollback!
    expect(contents(terminal)).toBe(contents(reference))
    await delivered(output(fence, 'RAW'))
    expect(contents(terminal)).toContain('final-seedRAW')
    await act(async () => terminal.input('z'))
    expect(write).toHaveBeenCalledExactlyOnceWith(session.control, 'z', 'user', expect.objectContaining({ source: 'user' }))
  } finally { reference.dispose() }
})
async function delivered(event: RuntimeEvent) {
  await act(async () => { receive(event); await new Promise(resolve => setTimeout(resolve,25)) })
}

it('reports ordinary writes by exact terminal instance, cause and real parser completion without retaining mutable counters', async () => {
  const seed = 'checkpoint seed\r\n', tail = 'history tail'
  const result = continuation(seed, tail)
  const terminal = await ready(result)
  const read = () => parseRendererPerformanceSnapshot(rendererPerformance.snapshot()).terminals.find(row => row.runId === session.control.run.runId)!
  const initial = read()
  expect(initial).toMatchObject({ hostId: session.control.hostId, sessionId: session.id, regionId: origin.regionId,
    writes: { checkpoint: { started: 1, completed: 1, bytes: encoder.encode(seed).length, stringCodeUnits: 0, callbackWall: { count: 1 } },
      history: { started: 1, completed: 1, bytes: encoder.encode(tail).length, callbackWall: { count: 1 } },
      live: { started: 0, completed: 0, bytes: 0, callbackWall: { count: 0 } } } })
  expect(initial.instanceId).toBeGreaterThan(0)
  fixture.holdCallbacks = true
  await act(async () => { receive(output(result.session.latestOutputBytes, 'ordinary')); await vi.waitFor(() => expect(fixture.callbacks).toHaveLength(1)) })
  expect(read().writes.live).toMatchObject({ started: 1, completed: 0, bytes: 8, callbackWall: { count: 0 } })
  await act(async () => { fixture.holdCallbacks = false; fixture.callbacks.splice(0).forEach(callback => callback()); await vi.waitFor(() => expect(read().writes.live.completed).toBe(1)) })
  const completed = read()
  expect(completed.writes.live.callbackWall.count).toBe(1)
  expect(completed.writes.live.callbackWall.totalMs).toBeGreaterThan(0)
  expect(completed.writes.live.callbackWall.maxMs).toBe(completed.writes.live.callbackWall.totalMs)
  completed.writes.live.started = 999
  completed.writes.live.callbackWall.count = 999
  expect(read().writes.live).toMatchObject({ started: 1, completed: 1, callbackWall: { count: 1 } })
  await render(result.session, false)
  await delivered(output(result.session.latestOutputBytes + 8, ' hidden'))
  expect(read()).toMatchObject({ visible: false, instanceId: initial.instanceId, writes: { live: { started: 2, completed: 2, bytes: 15 } } })
  expect(contents(terminal)).toContain('history tailordinary hidden')
  expect(initial.writes.live).toMatchObject({ started: 0, completed: 0, bytes: 0 })
  const second = { ...session, id: 'second-agent', hostId: 'second-host', control: { ...session.control, hostId: 'second-host', agentSessionId: 'second-core-session', run: { runId: 'second-run' } } }
  state(second); attach.mockResolvedValue(replay('second', second)); await render(second)
  await act(async () => await vi.waitFor(() => expect(rendererPerformance.snapshot().terminals.find(row => row.runId === 'second-run')?.liveReady).toBe(true)))
  const replaced = parseRendererPerformanceSnapshot(rendererPerformance.snapshot()).terminals
  expect(replaced.some(row => row.instanceId === initial.instanceId)).toBe(false)
  const secondRow = replaced.find(row => row.runId === 'second-run')!
  expect(secondRow.hostId).toBe('second-host'); expect(secondRow.sessionId).toBe('second-core-session')
  expect(secondRow.instanceId).toBeGreaterThan(initial.instanceId)
  expect(secondRow.writes).toMatchObject({ history: { started: 1, completed: 1, bytes: 6 }, live: { started: 0, completed: 0 } })
  expect(recover).not.toHaveBeenCalled()
})

it('restores both buffers and declared mouse modes from an independent seed after raw prefix eviction', async () => {
  const history = Array.from({length:45},(_,i)=>'normal-'+i+'\r\n').join('')
  const result = continuation(history+'\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[1;1Halternate-restored')
  const terminal = await ready(result)
  expect(terminal.buffer.active.type).toBe('alternate')
  expect(terminal.modes.mouseTrackingMode).toBe('vt200')
  expect(terminal.modes.bracketedPasteMode).toBe(true)
  expect(contents(terminal)).toContain('alternate-restored')
  expect(terminal.buffer.normal.length).toBeGreaterThan(terminal.rows)
  expect(terminal.buffer.normal.getLine(0)!.translateToString(true)).toBe('normal-0')
  expect(write).not.toHaveBeenCalled()
  await delivered(output(fence,'\x1b[?1049l'))
  expect(terminal.buffer.active.type).toBe('normal')
  expect(contents(terminal)).toContain('normal-44')
  await act(async () => terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  expect(attach).toHaveBeenCalledExactlyOnceWith(session.control,0)
})

it('parses original tail and every same-byte resize at the checkpoint source grid', async () => {
  const result = continuation('start', 'ABCDEFGHIJKLMNOP', [
    {throughByte:fence+8,resizeRevision:4,size:{cols:4,rows:24}},
    {throughByte:fence+8,resizeRevision:5,size:{cols:80,rows:24}}
  ])
  const terminal = await ready(result)
  expect(fixture.grids.slice(0,3)).toEqual([{cols:80,rows:24},{cols:4,rows:24},{cols:80,rows:24}])
  // xterm owns shrink/expand reflow, including any lost cells. Compare with an uninterrupted
  // public parser at the same real byte fences rather than inventing a screen-layout expectation.
  const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  const reference = new actual.Terminal({ cols:80,rows:24,scrollback:5000 })
  try {
    await new Promise<void>(resolve=>reference.write('startABCDEFGH',resolve))
    reference.resize(4,24); reference.resize(80,24)
    await new Promise<void>(resolve=>reference.write('IJKLMNOP',resolve))
    expect(contents(terminal).trim().length).toBeGreaterThan(0)
    expect(contents(terminal)).toBe(contents(reference))
    expect(terminal.buffer.active.cursorX).toBe(reference.buffer.active.cursorX)
  } finally { reference.dispose() }
  expect([terminal.cols,terminal.rows]).toEqual([80,24])
  expect(write).not.toHaveBeenCalled()
})

it('uses the raw checkpoint fence rather than seed length and skips snapshot-covered live geometry', async () => {
  let release!: (value: SessionAttachResult) => void
  attach.mockReturnValue(new Promise(resolve => { release=resolve }))
  const result = continuation('seed-screen')
  state(result.session); await render(result.session)
  await act(async () => {
    receive(output(fence-4,'OLD!NEW'))
    receive(resized(fence,2,20,10))
    release(result)
  })
  await act(async () => await vi.waitFor(()=>expect(readTerminalViewObservation({regionId:origin.regionId,sessionId:session.id,runId:session.control.run.runId})).toMatchObject({liveReady:true})))
  const terminal=fixture.terminals[0]!
  await act(async()=>await vi.waitFor(()=>expect(contents(terminal)).toContain('seed-screenNEW')))
  expect(contents(terminal)).not.toContain('OLD!')
  expect(fixture.grids).not.toContainEqual({cols:20,rows:10})
  expect(write).not.toHaveBeenCalled()
  await act(async () => {
    receive(resized(fence+3,4,40,24))
    receive(resized(fence+3,5,80,24))
    await vi.waitFor(()=>expect(fixture.grids.slice(-2)).toEqual([{cols:40,rows:24},{cols:80,rows:24}]))
  })
  expect(container.textContent).not.toContain('Restoring terminal state')
})

it.each(['unknown','unavailable'] as const)('keeps %s continuation visible and a healthy Run usable without invented modes', async type => {
  const result=replay('retained-current-screen')
  result.terminal={type,reason:type==='unknown'?'origin_unknown':'checkpoint_too_large'}
  result.session={...session,latestOutputBytes:result.replay[0]!.endByte}
  const terminal=await ready(result)
  expect(container.textContent).toContain('Restoring terminal state')
  expect(container.textContent).toContain('Live input remains available')
  expect(contents(terminal)).toContain('retained-current-screen')
  expect(terminal.buffer.active.type).toBe('normal')
  expect(terminal.modes.mouseTrackingMode).toBe('none')
  await act(async () => terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  expect(recover).not.toHaveBeenCalled()
})

it('bounds synthetic parser writes without advancing the original byte cursor or inspecting input extensions', async () => {
  const seed='\x1b[>1u'+' '.repeat(TERMINAL_REPLAY_BATCH_BYTES+100)+'\x1b[1;1Hseed-tail'
  const terminal=await ready(continuation(seed))
  expect(fixture.writes.length).toBeGreaterThan(1)
  expect(Math.max(...fixture.writes.map(part=>part.byteLength))).toBeLessThanOrEqual(TERMINAL_REPLAY_BATCH_BYTES)
  expect(fixture.writes.reduce((sum,part)=>sum+part.length,0)).toBe(encoder.encode(seed).length)
  expect(write).not.toHaveBeenCalled()
  await delivered(output(fence,'RAW'))
  expect(contents(terminal)).toContain('seed-tailRAW')
  await act(async () => terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
})

it('shows a lost live geometry ordering proof without blocking the same Run input', async () => {
  const terminal=await ready(continuation('live'))
  await delivered(resized(fence,5,80,24))
  expect(container.textContent).toContain('source gap')
  await act(async () => terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  expect(recover).not.toHaveBeenCalled()
})

function snapshot(result: SessionAttachResult): RuntimeEvent {
  const run: AgentMuxRunAttachment['run'] = {nativeService:null,runId:session.control.run.runId,kind:'agent',providerId:'codex',executorId:'codex',
    agentSessionId:session.id,workspacePath:session.workspacePath,pid:123,state:'running',
    cols:result.currentSize?.cols ?? null,rows:result.currentSize?.rows ?? null,observedAt:2,
    latestOutputBytes:result.session.latestOutputBytes,acceptedInputBytes:0}
  return {type:'core',hostId:session.hostId,event:{type:'terminal-snapshot',agentSessionId:session.id,afterByte:fence,run,
    terminal:result.terminal,replay:result.replay,gap:result.gap,resizeRevision:result.resizeRevision}}
}
function holdWrite(terminal: BrowserTerminal, marker: string) {
  let release: () => void = () => {}
  let landed!: () => void
  const started = new Promise<void>(resolve => {landed=resolve})
  const original=terminal.write.bind(terminal)
  const spy=vi.spyOn(terminal,'write').mockImplementation((data, callback) => {
    const text=typeof data==='string' ? data : new TextDecoder().decode(data)
    if (text!==marker) { original(data,callback); return }
    original(data,()=>{release=()=>callback?.(); landed()})
  })
  releases.push(()=>{release();spy.mockRestore()})
  return {started, release:()=>release()}
}

it('retains the existing drain after a held write, reports a newer checkpoint gap and keeps later live bytes', async () => {
  const terminal=await ready(continuation('old-canvas'))
  const held=holdWrite(terminal,'HELD')
  await act(async()=>{receive(output(fence,'HELD'));await held.started})
  const first=continuation('\x1bcobsolete-seed');
  if(first.terminal.type==='basic-vt') first.terminal.checkpoint.throughByte=fence+100
  first.session={...session,latestOutputBytes:fence+100}
  const latest=continuation('\x1bclatest-seed','TAIL',[
    {throughByte:fence+200,resizeRevision:4,size:{cols:40,rows:24}},
    {throughByte:fence+200,resizeRevision:5,size:{cols:80,rows:24}}])
  if(latest.terminal.type==='basic-vt') latest.terminal.checkpoint.throughByte=fence+200
  latest.replay=latest.replay.map(chunk=>({...chunk,startByte:fence+200,endByte:fence+204}))
  latest.session={...session,latestOutputBytes:fence+204}
  await act(async()=>{
    receive(snapshot(first)); receive(output(fence+204,'FUTURE')); receive(snapshot(latest))
    receive(resized(fence+100,4,20,10))
    expect(new TextDecoder().decode(Uint8Array.from(fixture.writes.flatMap(bytes=>[...bytes])))).not.toContain('latest-seed')
    held.release()
    await vi.waitFor(()=>expect(contents(terminal)).toContain('old-canvasHELDFUTURE'))
  })
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.writes.map(bytes=>new TextDecoder().decode(bytes))).toEqual(['old-canvas','HELD','FUTURE'])
  expect(contents(terminal)).not.toContain('obsolete-seed')
  expect(fixture.grids).not.toContainEqual({cols:40,rows:24})
  expect(fixture.grids).not.toContainEqual({cols:20,rows:10})
  expect(attach).toHaveBeenCalledTimes(1)
  expect(recover).not.toHaveBeenCalled()
  expect(container.textContent).toContain('existing display may be incomplete')
})

it('keeps healthy raw input available during a held reconnect suffix and suppresses its OSC side effects', async () => {
  const terminal=await ready(continuation('original'))
  const tail='held-tail\x1b]10;?\x07'
  const held=holdWrite(terminal,tail)
  await act(async()=>{receive(snapshot(continuation('\x1bcnew-canvas',tail)));await held.started})
  expect(readTerminalViewObservation({regionId:origin.regionId,sessionId:session.id,runId:session.control.run.runId}))
    .toMatchObject({liveReady:true,acceptsInput:true})
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  await act(async()=>{held.release();await vi.waitFor(()=>expect(contents(terminal)).toContain('originalheld-tail'))})
  expect(contents(terminal)).not.toContain('new-canvas')
  expect(write).toHaveBeenCalledTimes(1)
  expect(fixture.terminals).toEqual([terminal])
})

it.each(['unknown','unavailable'] as const)('keeps the canvas on %s reconnect, skips uncertain historical geometry and resumes real new output', async type => {
  const terminal=await ready(continuation('keep-canvas'))
  const uncertain=replay('UNCERTAIN-HISTORICAL-TAIL')
  uncertain.replay=uncertain.replay.map(chunk=>({...chunk,startByte:fence,endByte:fence+chunk.dataBytes.length}))
  uncertain.session={...session,latestOutputBytes:uncertain.replay[0]!.endByte}
  uncertain.terminal={type,reason:type==='unknown'?'origin_unknown':'source_gap'}
  uncertain.currentSize={cols:60,rows:24};uncertain.resizeRevision=8
  const replaySpy=vi.spyOn(api.sessions,'replay')
  await delivered(snapshot(uncertain))
  expect(contents(terminal)).toContain('keep-canvas')
  expect(contents(terminal)).not.toContain('UNCERTAIN-HISTORICAL-TAIL')
  expect([terminal.cols,terminal.rows]).toEqual([60,24])
  expect(container.textContent).toContain('existing display may be incomplete')
  await delivered(output(uncertain.session.latestOutputBytes,'NEW-LIVE'))
  expect(contents(terminal)).toContain('keep-canvasNEW-LIVE')
  expect(container.textContent).toContain('existing display may be incomplete')
  expect(replaySpy).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  const known=continuation('\x1bcproven-canvas')
  if(known.terminal.type==='basic-vt') known.terminal.checkpoint.throughByte=uncertain.session.latestOutputBytes+8
  known.session={...session,latestOutputBytes:uncertain.session.latestOutputBytes+8}
  await delivered(snapshot(known))
  expect(contents(terminal)).toContain('keep-canvasNEW-LIVE')
  expect(contents(terminal)).not.toContain('proven-canvas')
  expect(container.textContent).toContain('existing display may be incomplete')
  expect(fixture.terminals).toEqual([terminal])
  expect(recover).not.toHaveBeenCalled()
})

it('uses an empty unknown snapshot processing fence without historical backfill or redraw, while new output and input stay usable', async () => {
  const terminal=await ready(continuation('unchanged'))
  const unknown=replay(''); unknown.terminal={type:'unknown',reason:'origin_unknown'}
  unknown.session={...session,latestOutputBytes:fence+500};unknown.resizeRevision=9
  const replaySpy=vi.spyOn(api.sessions,'replay')
  const resizeCalls=vi.mocked(api.sessions.resize).mock.calls.length
  await delivered(snapshot(unknown))
  await delivered(output(fence+500,'REAL-NEW'))
  expect(contents(terminal)).toContain('unchangedREAL-NEW')
  expect(container.textContent).toContain('existing display may be incomplete')
  expect(replaySpy).not.toHaveBeenCalled()
  expect(api.sessions.resize).toHaveBeenCalledTimes(resizeCalls)
  expect(write).not.toHaveBeenCalled()
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
})

it('reports an invalid reconnect checkpoint without closing healthy input or retrying unproven history', async () => {
  const terminal=await ready(continuation('initial'))
  const invalid=continuation('\x1bcreceived-but-unproven')
  invalid.session={...session,latestOutputBytes:fence+500}
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{})
  const replaySpy=vi.spyOn(api.sessions,'replay')
  await delivered(snapshot(invalid))
  expect(contents(terminal)).toContain('initial')
  expect(contents(terminal)).not.toContain('received-but-unproven')
  expect(container.textContent).toContain('could not validate the terminal checkpoint')
  expect(container.textContent).toContain('existing display may be incomplete')
  expect(warning).toHaveBeenCalledTimes(1)
  await delivered(output(fence+500,'LIVE-AFTER-FAILURE'))
  expect(contents(terminal)).toContain('LIVE-AFTER-FAILURE')
  expect(replaySpy).not.toHaveBeenCalled()
  expect(container.textContent).toContain('existing display may be incomplete')
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user', expect.objectContaining({ source: 'user' }))
  expect(fixture.terminals).toEqual([terminal])
  expect(recover).not.toHaveBeenCalled()
})


it('preserves the same history reading line through ordered row shrink and growth, while latest keeps following', async () => {
  const history = Array.from({ length: 600 }, (_, i) => `ROW${String(i).padStart(3, '0')}\r\n`).join('')
  const terminal = await ready(continuation(history))
  const populated = () => {
    const buffer = terminal.buffer.active
    const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true))
    while (lines.at(-1) === '') lines.pop()
    return lines
  }
  const before = populated()
  expect(before).toEqual(Array.from({ length: 600 }, (_, i) => `ROW${String(i).padStart(3, '0')}`))
  await act(async () => terminal.scrollToLine(300))
  expect(terminal.buffer.active.viewportY).toBe(300)
  await delivered(resized(fence, 4, 80, 9))
  expect(terminal.rows).toBe(9)
  expect(terminal.buffer.active.baseY).toBe(terminal.buffer.active.length - terminal.rows)
  expect(terminal.buffer.active.viewportY).toBe(300)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true)).toBe('ROW300')
  expect(populated()).toEqual(before)
  await delivered(resized(fence, 5, 80, 24))
  expect(terminal.rows).toBe(24)
  expect(terminal.buffer.active.viewportY).toBe(300)
  expect(populated()).toEqual(before)
  await act(async () => terminal.scrollToBottom())
  await delivered(resized(fence, 6, 80, 9))
  expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  await delivered(resized(fence, 7, 80, 24))
  expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  expect(populated()).toEqual(before)
  expect(write).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
})


it('tracks retained reading and selection coordinates when a full normal buffer trims during row resize', async () => {
  const history = Array.from({ length: 11000 }, (_, i) => `LONG${String(i).padStart(4, '0')}\r\n`).join('')
  const terminal = await ready(continuation(history))
  expect(terminal.buffer.active.length).toBe(10024)
  expect(terminal.markers).toEqual([])
  await act(async () => terminal.scrollToLine(300))
  const anchor = terminal.buffer.active.getLine(300)!.translateToString(true)
  expect(anchor).toBe('LONG1277')
  await render(session, false)
  vi.spyOn(terminal, 'getSelectionSnapshot').mockReturnValue({ mode: 'normal', selectAll: false, anchor: { x: 0, y: 300 }, active: { x: 8, y: 300 } })
  // open() omits DOM SelectionService; only selection API delivery is a fixture boundary.
  // The public parser, markers, trim and reading viewport remain real.
  const selected = vi.spyOn(terminal, 'restoreSelection').mockImplementation(() => {})
  await delivered(resized(fence, 4, 80, 9))
  expect(terminal.rows).toBe(9)
  expect(terminal.buffer.active.length).toBe(10009)
  expect(terminal.buffer.active.viewportY).toBe(285)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true)).toBe(anchor)
  expect(selected).toHaveBeenCalledExactlyOnceWith({ mode: 'normal', selectAll: false, anchor: { x: 0, y: 285 }, active: { x: 8, y: 285 } })
  await render(session, true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true)).toBe(anchor)
  expect(terminal.markers).toEqual([])
  expect(write).not.toHaveBeenCalled()
})

it('keeps the tracked reading line when a successful observation refresh applies a full-buffer row resize', async () => {
  const history = Array.from({ length: 11000 }, (_, i) => `LONG${String(i).padStart(4, '0')}\r\n`).join('')
  const terminal = await ready(continuation(history))
  expect(terminal.buffer.active.length).toBe(10024)
  await act(async () => terminal.scrollToLine(300))
  expect(terminal.buffer.active.getLine(300)!.translateToString(true)).toBe('LONG1277')
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue({ ...session, latestOutputBytes: fence })
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue(continuation('\x1bc', '', [
    { throughByte: fence, resizeRevision: 4, size: { cols: 80, rows: 9 } }
  ]))
  expect(refreshObservation).toBeTypeOf('function')
  await act(async () => { await refreshObservation!() })
  expect(refresh).toHaveBeenCalledExactlyOnceWith(session.control, 'wheel-attachment', fence)
  expect(terminal.rows).toBe(9)
  expect(terminal.buffer.active.viewportY).toBe(285)
  expect(terminal.buffer.active.getLine(285)!.translateToString(true)).toBe('LONG1277')
  expect(terminal.markers).toEqual([])
  expect(write).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
})


it('actual mounted checkpoint, history and live parser writers retain explicit cause, units and begin owner', async () => {
  let mono = performance.now() + 1
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  fixture.beforeCallback = () => { mono += 80 }
  const observed = vi.spyOn(rendererPerformance, 'terminalWrite')
  const result = continuation('checkpoint-seed', 'replayed-tail')
  if (result.terminal.type !== 'basic-vt') throw new Error('Expected checkpoint fixture')
  result.terminal.checkpoint.resizeAfterRestoreBytes = 5
  const terminal = await ready(result)
  await delivered(output(fence + 'replayed-tail'.length, 'LIVE'))
  const calls = observed.mock.calls
  expect(calls.length).toBeGreaterThanOrEqual(4)
  expect(calls.map(call => call[3].cause)).toEqual(['checkpoint', 'checkpoint', 'history', 'live'])
  const instanceId = calls[0]![3].instanceId
  expect(instanceId).toBeGreaterThan(0)
  for (const call of calls) expect(call[3]).toEqual({ hostId: 'local', sessionId: session.control.agentSessionId,
    runId: session.control.run.runId, regionId: origin.regionId, instanceId, cause: call[3].cause })
  const recorded = rendererPerformance.snapshot().slowEvents.filter(event => event.terminal?.instanceId === instanceId)
  expect(recorded.length).toBeGreaterThanOrEqual(4)
  expect(recorded.map(event => event.terminal!.cause)).toEqual(['checkpoint', 'checkpoint', 'history', 'live'])
  expect(recorded.every(event => event.terminal!.payload.unit === 'bytes')).toBe(true)
  expect(recorded.at(-1)!.terminal!.payload.length).toBe(4)
  expect(contents(terminal)).toContain('checkpoint-seedreplayed-tailLIVE')
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it('actual pending parser completion keeps its begin Region/Run and a replacement or remount gets a fresh recorder serial', async () => {
  let mono = performance.now() + 1
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  fixture.beforeCallback = () => { mono += 80 }
  const observed = vi.spyOn(rendererPerformance, 'terminalWrite')
  await ready(continuation('seed'))
  const originalInstance = observed.mock.calls[0]![3].instanceId
  fixture.holdCallbacks = true
  await act(async () => { receive(output(fence, 'PENDING')); await vi.waitFor(() => expect(fixture.callbacks).toHaveLength(1)) })
  const nextOrigin = { ...origin, regionId: 'replacement-region' }
  await render(session, false, nextOrigin)
  fixture.holdCallbacks = false
  const replacement = { ...session, control: { ...session.control, run: { runId: 'replacement-run' } } }
  attach.mockResolvedValue(replay('replacement', replacement))
  state(replacement)
  await render(replacement, false, nextOrigin)
  await act(async () => { await vi.waitFor(() => expect(observed.mock.calls.some(call => call[3].runId === 'replacement-run')).toBe(true)) })
  await act(async () => { mono += 100; fixture.callbacks.splice(0).forEach(done => done()); await Promise.resolve() })
  const late = observed.mock.calls.find(call => new TextDecoder().decode(call[1] as Uint8Array) === 'PENDING')!
  expect(late).toBeDefined()
  expect(late[3]).toEqual({ hostId: 'local', sessionId: session.control.agentSessionId, runId: 'wheel-run', regionId: origin.regionId, instanceId: originalInstance, cause: 'live' })
  const replacementInstance = observed.mock.calls.find(call => call[3].runId === 'replacement-run')![3].instanceId
  expect(replacementInstance).toBeGreaterThan(originalInstance)
  await act(async () => root.render(null))
  await render(replacement, false, nextOrigin)
  await act(async () => { await vi.waitFor(() => expect(observed.mock.calls.some(call => call[3].instanceId > replacementInstance)).toBe(true)) })
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})


it('actual retained backfill writer reports history and preserves the original continuous byte cursor', async () => {
  let mono = performance.now() + 1
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  fixture.beforeCallback = () => { mono += 80 }
  const observed = vi.spyOn(rendererPerformance, 'terminalWrite')
  const terminal = await ready(continuation('seed'))
  const instance = observed.mock.calls[0]![3].instanceId
  const history = encoder.encode('GAP')
  const read = vi.spyOn(api.sessions, 'replay').mockResolvedValue({ replay: [{ type: 'data', runId: 'wheel-run', startByte: fence, endByte: fence + 3, data: 'GAP', dataBytes: history }], gap: null })
  await delivered(output(fence + 3, 'LIVE'))
  expect(read).toHaveBeenCalledExactlyOnceWith('wheel-attachment', fence)
  expect(contents(terminal)).toContain('seedGAPLIVE')
  expect(observed.mock.calls.filter(call => call[3].instanceId === instance).map(call => call[3].cause)).toEqual(['checkpoint', 'history', 'live'])
  expect(write).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})

it.each([['normal', null], ['alternate', null], ['normal', 6000], ['alternate', 6000]] as const)('retained seed prefix stays readable after restore in %s with policy %s', async (mode, restoreRows) => {
  const seed = Array.from({length:6000},(_,i)=>`ORIGINAL-${String(i).padStart(4,'0')}\r\n`).join('')
    + (mode==='alternate'?'\x1b[?1049h\x1b[1;1HALTERNATE-ORIGINAL':'')
  const result=continuation(seed)
  if(result.terminal.type!=='basic-vt')throw Error('Original ABI fixture needs a checkpoint')
  result.terminal.checkpoint.restoreScrollbackRows=restoreRows
  result.terminal.checkpoint.historyPolicy={status:'observed',scrollbackRows:7331}
  const terminal=await ready(result)
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true),'Original imported normal history prefix is retained').toBe('ORIGINAL-0000')
  expect(terminal.options.scrollback).toBe(7331)
  expect(attach).toHaveBeenCalledExactlyOnceWith(session.control,0)
  expect(write).not.toHaveBeenCalled()
})

it.each(['unavailable', 'absent'] as const)('keeps %s policy observation separate from a byte Gap, preserves input and refreshes the same original history', async observation => {
  const seed='\x1bc'+Array.from({length:6000},(_,i)=>`ORIGINAL-${String(i).padStart(4,'0')}\r\n`).join('')
  const result=continuation(seed)
  if(result.terminal.type!=='basic-vt')throw Error('Expected original checkpoint')
  if(observation==='absent') delete result.terminal.checkpoint.historyPolicy
  else result.terminal.checkpoint.historyPolicy={status:'unavailable',message:'Original policy read was cancelled'}
  const terminal=await ready(result)
  expect(fixture.writes).toEqual([])
  expect(container.textContent).toContain('Confirming the original terminal history policy')
  expect(container.textContent).not.toContain('Runtime reported a history gap')
  await delivered(output(fence,'LIVE'))
  expect(contents(terminal)).toContain('LIVE')
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user',expect.objectContaining({source:'user'}))
  vi.spyOn(api.sessions,'refresh').mockResolvedValue({...session,latestOutputBytes:fence+4})
  const refreshed=vi.spyOn(api.sessions,'refreshAttachment').mockResolvedValue(continuation(seed,'LIVE'))
  await act(async()=>{await refreshObservation!()})
  expect(refreshed).toHaveBeenCalledExactlyOnceWith(session.control,'wheel-attachment',fence+4)
  expect(fixture.terminals).toEqual([terminal])
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  expect(contents(terminal).match(/LIVE/g)).toHaveLength(1)
  expect(container.textContent).not.toContain('Confirming the original terminal history policy')
  expect(recover).not.toHaveBeenCalled()
})

it('retains the imported normal prefix when the suffix parser fails, then recovers the same attachment explicitly', async () => {
  const prefix='\x1bc'+Array.from({length:6000},(_,i)=>`ORIGINAL-${String(i).padStart(4,'0')}\r\n`).join('')
  const result=continuation(prefix+'suffix')
  if(result.terminal.type!=='basic-vt')throw Error('Expected original checkpoint')
  result.terminal.checkpoint.restoreScrollbackRows=6000
  result.terminal.checkpoint.resizeAfterRestoreBytes=encoder.encode(prefix).length
  let failedWrite:MockInstance<BrowserTerminal['write']>|undefined
  fixture.beforeCallback=()=>{fixture.beforeCallback=null;failedWrite=vi.spyOn(fixture.terminals[0]!,'write').mockImplementation(()=>{throw Error('Original suffix parser failed')})}
  state(result.session);attach.mockResolvedValue(result);await render(result.session)
  await act(async()=>{await vi.waitFor(()=>expect(container.textContent).toContain('Original suffix parser failed'))})
  const terminal=fixture.terminals[0]!
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  expect(terminal.buffer.normal.length).toBe(6001)
  expect(terminal.options.scrollback).toBe(10_000)
  failedWrite!.mockRestore()
  vi.spyOn(api.sessions,'refresh').mockResolvedValue({...session,latestOutputBytes:fence})
  const refreshed=vi.spyOn(api.sessions,'refreshAttachment').mockResolvedValue(result)
  await act(async()=>{await refreshObservation!()})
  expect(refreshed).toHaveBeenCalledExactlyOnceWith(session.control,'wheel-attachment',0)
  expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  expect(contents(terminal)).toContain('suffix')
  expect(fixture.terminals).toEqual([terminal])
  expect(recover).not.toHaveBeenCalled()
})

it('cancels the View after actual prefix parsing without clipping its normal buffer, and reattaches the same original', async () => {
  const prefix='\x1bc'+Array.from({length:6000},(_,i)=>`ORIGINAL-${String(i).padStart(4,'0')}\r\n`).join('')
  const result=continuation(prefix+'suffix')
  if(result.terminal.type!=='basic-vt')throw Error('Expected original checkpoint')
  result.terminal.checkpoint.restoreScrollbackRows=6000
  result.terminal.checkpoint.resizeAfterRestoreBytes=encoder.encode(prefix).length
  fixture.holdCallbacks=true
  state(result.session);attach.mockResolvedValue(result);await render(result.session)
  await act(async()=>{await vi.waitFor(()=>expect(fixture.callbacks).toHaveLength(1))})
  const cancelled=fixture.terminals[0]!
  expect(cancelled.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  await act(async()=>root.render(null))
  await act(async()=>{fixture.holdCallbacks=false;fixture.callbacks.splice(0).forEach(complete=>complete());await Promise.resolve()})
  expect(cancelled.buffer.normal.length).toBe(6001)
  expect(cancelled.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  expect(cancelled.options.scrollback).toBe(10_000)
  await render(result.session)
  await act(async()=>{await vi.waitFor(()=>expect(readTerminalViewObservation({regionId:origin.regionId,sessionId:session.id,runId:session.control.run.runId})).toMatchObject({liveReady:true}))})
  expect(attach.mock.calls).toEqual([[session.control,0],[session.control,0]])
  expect(fixture.terminals[1]!.buffer.normal.getLine(0)?.translateToString(true)).toBe('ORIGINAL-0000')
  expect(write).not.toHaveBeenCalled();expect(recover).not.toHaveBeenCalled()
})

it.each(['unavailable', 'absent'] as const)('continues an already authoritative canvas from original tail bytes when optional policy is %s', async observation => {
  const terminal=await ready(continuation('original-canvas'))
  const refresh=continuation('\x1bcPOISON-REPLACEMENT','TAIL')
  if(refresh.terminal.type!=='basic-vt')throw Error('Expected original checkpoint')
  if(observation==='absent') delete refresh.terminal.checkpoint.historyPolicy
  else refresh.terminal.checkpoint.historyPolicy={status:'unavailable',message:'This optional policy reader failed'}
  vi.spyOn(api.sessions,'refresh').mockResolvedValue({...session,latestOutputBytes:fence+4})
  vi.spyOn(api.sessions,'refreshAttachment').mockResolvedValue(refresh)
  await act(async()=>{await refreshObservation!()})
  expect(contents(terminal)).toContain('original-canvasTAIL')
  expect(contents(terminal)).not.toContain('POISON-REPLACEMENT')
  expect(fixture.terminals).toEqual([terminal])
  expect(container.textContent).toContain('Confirming the original terminal history policy')
  expect(recover).not.toHaveBeenCalled()
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user',expect.objectContaining({source:'user'}))
})

it('releases unused local default capacity to the current owner policy without clipping actual normal history', async () => {
  const result=continuation('\x1bcORIGINAL')
  if(result.terminal.type!=='basic-vt')throw Error('Expected original checkpoint')
  result.terminal.checkpoint.historyPolicy={status:'observed',scrollbackRows:7}
  const terminal=await ready(result)
  expect(terminal.options.scrollback).toBe(7)
  expect(contents(terminal)).toContain('ORIGINAL')
})

it('an explicit member source runs the real Terminal reader through original Core and trusted Main without observer-local IO',async()=>{
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { AgentProviderRegistry } = await import('../../../packages/core/src/agent-provider')
  const { DEFAULT_CONFIG } = await import('../src/main/config-store')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const { spaceMemberTerminalSource } = await import('../src/renderer/src/lib/space-member-terminal')
  const cleanup:Array<()=>unknown|Promise<unknown>>=[]
  try {
    const f=await createSpaceSessionsFixture(cleanup),sid='original-scoped-terminal'
    f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
    const original=await f.d.put(sid),admitted=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'scoped-terminal-creation')
    const subject=await f.d.core.runtimeSubject({kind:'agent-session',agentSessionId:sid})
    if(subject.kind!=='agent')throw Error('Expected original Agent subject')
    const data='source-D-only\r\n',bytes=new TextEncoder().encode(data)
    const attachment:AgentMuxRunAttachment={run:subject.run,gap:null,resizeRevision:0,terminal:{type:'unknown',reason:'origin_unknown'},
      replay:[{type:'data',runId:original.run.runId,startByte:0,endByte:bytes.length,data,dataBytes:bytes}]}
    const nativeReader=vi.spyOn(f.d.core,'refreshRunAttachment').mockResolvedValue(attachment)
    const nativeRelease=vi.spyOn(f.d.core,'releaseRunAttachment').mockResolvedValue()
    const nativeWrite=vi.spyOn(f.d.core,'writeAgent').mockResolvedValue({runId:original.run.runId,appliedByteRange:{startByte:0,endByte:4},acceptedThroughByte:4})
    const carrier={forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}
    const main=spaceMountTransport(cleanup,[{id:'source-b-carrier',carrier}],structuredClone(DEFAULT_CONFIG))
    const listeners=new Set<(event:RuntimeEvent)=>void>()
    const surface=await main.api.member({hostId:'source-b-carrier',target:{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:original.run}},event=>{if(event.type==='runtime')listeners.forEach(listener=>listener(event.event))})
    cleanup.push(()=>surface.dispose())
    const current=await surface.call('read',{})
    if(current.kind!=='agent')throw Error('Expected the original Agent snapshot')
    const source=spaceMemberTerminalSource(surface,{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:original.run},listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}})
    const before=useAppStore.getState(),localDetach=vi.mocked(api.sessions.detach)
    attach.mockClear();write.mockClear();localDetach.mockClear()
    await render(current,true,origin,source)
    await act(async()=>{await vi.waitFor(()=>expect(fixture.terminals).toHaveLength(1));await vi.waitFor(()=>expect(contents(fixture.terminals[0]!)).toContain('source-D-only'))})
    fixture.terminals[0]!.input('ping')
    await vi.waitFor(()=>expect(nativeWrite).toHaveBeenCalledTimes(1))
    expect(nativeWrite.mock.calls[0]![0]).toMatchObject({agentSessionId:sid,expectedRun:original.run,data:'ping'})
    const openExternal=vi.spyOn(api.ui,'openExternal').mockResolvedValue()
    const activate=fixture.terminals[0]!.options.linkHandler?.activate
    if(!activate)throw Error('Expected the actual original Terminal link handler')
    const range={start:{x:1,y:1},end:{x:5,y:1}}
    await act(async()=>activate(new MouseEvent('mouseup',{button:0}),'https://example.test/original-public',range))
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/original-public')
    for(const url of ['http://localhost:3000','http://LOCALHOST.:3000','http://127.42.0.1:3000','http://127.1:3000','http://0x7f000001:3000','http://2130706433:3000','http://[::1]:3000','http://[0:0:0:0:0:0:0:1]:3000','http://[::ffff:127.2.3.4]:3000']){
      await act(async()=>activate(new MouseEvent('mouseup',{button:0}),url,range))
      expect(openExternal).toHaveBeenCalledTimes(1)
    }
    expect(useAppStore.getState().error).toContain('original Agent device')
    const openObject=vi.spyOn(api.ui,'openObjectLink').mockResolvedValue()
    for(const uri of ['amux://agent/same-id','amux://capsule/same-id','amux://host/original-node/agent/same-id']){
      await act(async()=>activate(new MouseEvent('mouseup',{button:0}),uri,range))
      expect(openObject).not.toHaveBeenCalled()
    }
    for(const uri of ['amux://host/original-node/agent/same-id?runtime=exact-D-runtime','amux://host/original-node/capsule/same-id?runtime=exact-D-runtime']){
      await act(async()=>activate(new MouseEvent('mouseup',{button:0}),uri,range))
      expect(openObject).toHaveBeenLastCalledWith(uri)
    }
    expect(openObject).toHaveBeenCalledTimes(2)

    const wrong={...current, id:'another-visible-view', control:{...current.control,agentSessionId:'other-visible-sid',run:{runId:'other-visible-run'}}}
    for(const control of [{...current.control,hostId:'another-visible-host'},{...current.control,agentSessionId:'another-visible-sid'},{...current.control,run:{runId:'another-visible-run'}}])
      await expect(source.sessions.write(control,'must-not-reach-D','user')).rejects.toThrow('another original Session or Run')
    expect(nativeWrite).toHaveBeenCalledTimes(1)
    await render(wrong,true,origin,source)
    await act(async()=>{await vi.waitFor(()=>expect(container.textContent).toContain('another original Session or Run'))})
    fixture.terminals.at(-1)!.input('wrong')
    await act(async()=>{await Promise.resolve()})
    expect(nativeWrite).toHaveBeenCalledTimes(1)
    await expect(source.sessions.attach(wrong.control,0)).rejects.toThrow('another original Session or Run')
    await expect(source.sessions.refreshAttachment(wrong.control,null,0)).rejects.toThrow('another original Session or Run')
    await expect(source.sessions.paste(wrong.control,'bad','bad')).rejects.toThrow('another original Session or Run')
    await expect(source.refresh(wrong.control)).rejects.toThrow('another original Session or Run')
    expect(()=>source.sessions.onEvent(()=>{},wrong.control)).toThrow('another original Session or Run')
    await source.sessions.write(current.control,'ping','user')
    expect(nativeWrite).toHaveBeenCalledTimes(2)

    expect(nativeReader).toHaveBeenCalledExactlyOnceWith(original.run,0,'terminal')
    expect(attach).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    await act(async()=>root.render(null))
    await vi.waitFor(()=>expect(nativeRelease).toHaveBeenCalledTimes(1))
    expect(localDetach).not.toHaveBeenCalled();expect(listeners.size).toBe(0)
  }finally{for(const close of cleanup.reverse())await close()}
})

it('the mounted Agent workface consumes the real member handle for original Terminal and rich Composer without joining observer Sessions',async()=>{
  const {createSpaceSessionsFixture}=await import('../../../packages/core/test/helpers/space-session-fixture')
  const {AgentProviderRegistry}=await import('../../../packages/core/src/agent-provider')
  const {DEFAULT_CONFIG}=await import('../src/main/config-store')
  const {spaceMountTransport}=await import('./helpers/space-mount-fixture')
  const {MountedSpaceAgent}=await import('../src/renderer/src/components/MountedSpaceAgent')
  const {DesktopClientUiProvider}=await import('../src/renderer/src/components/DesktopClientUiProvider')
  const {spaceMountKey}=await import('../src/shared/space-mount')
  const store=await import('../src/renderer/src/store')
  const cleanup:Array<()=>unknown|Promise<unknown>>=[]
  try{
    const f=await createSpaceSessionsFixture(cleanup),sid='original-visible-member'
    f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
    const original=await f.d.put(sid),admitted=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'visible-member-creation')
    const tabId=admitted.address.tabId,zoneId=admitted.address.zoneId;if(!zoneId)throw Error('Expected original admitted Zone');if(!tabId)throw Error('Expected original admitted Tab')
    const subject=await f.d.core.runtimeSubject({kind:'agent-session',agentSessionId:sid});if(subject.kind!=='agent')throw Error('Expected original Agent')
    const data='The original D terminal\r\n',dataBytes=new TextEncoder().encode(data)
    vi.spyOn(f.d.core,'refreshRunAttachment').mockResolvedValue({run:subject.run,gap:null,resizeRevision:0,terminal:{type:'unknown',reason:'origin_unknown'},replay:[{type:'data',runId:original.run.runId,startByte:0,endByte:dataBytes.length,data,dataBytes}]})
    const release=vi.spyOn(f.d.core,'releaseRunAttachment').mockResolvedValue()
    const bytes=vi.spyOn(f.d.core,'writeAgent').mockResolvedValue({runId:original.run.runId,appliedByteRange:null,acceptedThroughByte:1})
    const prompt=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
    const main=spaceMountTransport(cleanup,[{id:'original-B-carrier',carrier:{forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}}],structuredClone(DEFAULT_CONFIG))
    let memberToken:unknown
    const originalMemberOpen=main.handlers.get('spaceMounts:member')!
    main.handlers.set('spaceMounts:member',(event,...args)=>{memberToken=args[0];return originalMemberOpen(event,...args)})
    let deliver:Parameters<typeof api.spaceMounts.member>[1]=()=>{}
    // Only the general session event delivery is unavailable; the original fixed read/IO remain real.
    vi.spyOn(api.spaceMounts,'member').mockImplementation((input,listener,signal)=>{deliver=listener;listener({type:'observation-error',error:{code:'PRIVATE_UPDATES_UNAVAILABLE',message:'Private session updates unavailable'}});return main.api.member(input,event=>{if(event.type!=='session')listener(event)},signal)})
    const target={hostId:'original-B-carrier',target:{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:original.run}},key=spaceMountKey(f.reference)
    useAppStore.getState().mountSpace({hostId:target.hostId,reference:f.reference,zoneId,workspaceId:'original-b-project'})
    useAppStore.getState().editSpaceMountDraft(key,tabId,admitted.address.regionId,'Original visible rich message')
    const checkpoint=vi.spyOn(store,'checkpointMountedSpaceInputs').mockResolvedValue()
    const sessions=useAppStore.getState().sessions
    const view=(visible:boolean)=><DesktopClientUiProvider><MountedSpaceAgent target={target} visible={visible} active={visible} mountKey={key} tabId={tabId}/></DesktopClientUiProvider>
    await act(async()=>root.render(view(true)))
    await vi.waitFor(async()=>{await act(async()=>{});expect(container.querySelector('[aria-label="Send new message"]')).not.toBeNull();expect(fixture.terminals,container.textContent??'').toHaveLength(1);expect(contents(fixture.terminals[0]!)).toContain('The original D terminal')})
    expect(container.textContent).toContain('Private session updates unavailable')
    fixture.terminals[0]!.input('x');await vi.waitFor(()=>expect(bytes).toHaveBeenCalledOnce())
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send new message"]')!.click())
    await vi.waitFor(()=>expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]![0]).toMatchObject({agentSessionId:sid,expectedRun:original.run,prompt:'Original visible rich message'})
    expect(checkpoint).toHaveBeenCalledOnce();expect(useAppStore.getState().sessions).toBe(sessions)
    expect(attach).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Stop Agent');expect(container.textContent).not.toContain('Approve')
    const handle=await vi.mocked(api.spaceMounts.member).mock.results[0]!.value,confirmed=await handle.call('read',{})
    await act(async()=>deliver({type:'session',session:confirmed}))
    expect(container.textContent).not.toContain('Private session updates unavailable')
    expect(typeof memberToken).toBe('string')
    await act(async()=>{expect(()=>main.renderer.emit('spaceMounts:memberEvent',{}, {token:memberToken,observation:{type:'error',error:{code:'PRIVATE_READER_CLOSED',message:'Private member reader closed'}}})).not.toThrow()})
    await vi.waitFor(()=>expect(release).toHaveBeenCalledOnce())
    expect(container.textContent).toContain('Private member reader closed')
    const rich=container.querySelector<HTMLElement & {editor:import('@tiptap/core').Editor}>('[role="textbox"]')!
    expect(rich).not.toBeNull()
    await act(async()=>{rich.editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Explicit message after observer closed'}]}]})})
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send new message"]')!.click())
    await vi.waitFor(()=>expect(prompt).toHaveBeenCalledTimes(2))
    expect(prompt.mock.calls[1]![0]).toMatchObject({agentSessionId:sid,expectedRun:original.run,prompt:'Explicit message after observer closed'})
    expect(useAppStore.getState().sessions).toBe(sessions);expect(bytes).toHaveBeenCalledOnce()
    await act(async()=>root.render(view(false)))
    expect(await f.d.core.readAgentSession(sid)).toMatchObject({run:original.run})
    await act(async()=>root.render(null))
  }finally{for(const close of cleanup.reverse())await close()}
})

it('the ordinary Workbench consumes its original foreign Region through real Core and Main without mounted navigation or same-SID local IO', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { AgentProviderRegistry } = await import('../../../packages/core/src/agent-provider')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const { WorkspaceWorkbench } = await import('../src/renderer/src/components/WorkspaceWorkbench')
  const { DesktopClientUiProvider } = await import('../src/renderer/src/components/DesktopClientUiProvider')
  const { ordinaryAgentSpaceMember } = await import('../src/renderer/src/store')
  const store = await import('../src/renderer/src/store')
  const { mountedMemberDraft } = await import('../src/renderer/src/lib/space-member-input')
  const { spaceMountKey } = await import('../src/shared/space-mount')
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  try {
    const moveBefore = Object.getOwnPropertyDescriptor(Element.prototype, 'moveBefore')
    Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value(this: Element, node: Node, before: Node | null) { this.insertBefore(node, before) } })
    cleanup.push(() => { if (moveBefore) Object.defineProperty(Element.prototype, 'moveBefore', moveBefore); else Reflect.deleteProperty(Element.prototype, 'moveBefore') })
    const f = await createSpaceSessionsFixture(cleanup), sid = 'ordinary-shared-raw-SID'
    f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
    const original = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'ordinary-original-CID')
    await f.b.spatial.settleAgentOpen(admission.requestId, original, { workspaceId: 'original-b-project', phase: 'attached',
      agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
    const subject = await f.d.core.runtimeSubject({ kind: 'agent-session', agentSessionId: sid })
    if (subject.kind !== 'agent') throw Error('Expected original D Agent')
    const data = 'Ordinary B Region, original D terminal\r\n', dataBytes = new TextEncoder().encode(data)
    const nativeAttachment = vi.spyOn(f.d.core, 'refreshRunAttachment').mockResolvedValue({ run: subject.run, gap: null, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' },
      replay: [{ type: 'data', runId: original.run.runId, startByte: 0, endByte: dataBytes.length, data, dataBytes }] })
    const release = vi.spyOn(f.d.core, 'releaseRunAttachment').mockResolvedValue()
    const raw = vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue({ runId: original.run.runId, appliedByteRange: null, acceptedThroughByte: 1 })
    const submit = vi.spyOn(f.d.core, 'submitAgentPrompt').mockResolvedValue(undefined)
    const checkpoint = vi.spyOn(store, 'checkpointMountedSpaceInputs').mockResolvedValue()
    const config: AppConfig = { ...configuration, hosts: [{ id: 'local', kind: 'local', label: 'Original B device' }],
      workspaces: [{ id: 'original-b-project', hostId: 'local', path: '/b/project', name: 'Existing B project', kind: 'folder' }] }
    const main = spaceMountTransport(cleanup, [{ id: 'local', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }], config)
    const member = vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
    const metadata = vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
    const business = vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
    // Original spatial and initial Desktop delivery are controlled leaves; the accepted graph,
    // member RPC, Main registration, preload, original Terminal and Composer are real consumers.
    const originalSnapshot = await api.sessions.snapshot()
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    const sameSidLocal = { ...session, id: sid, control: { ...session.control, agentSessionId: sid } }
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...originalSnapshot, config, sessions: [sameSidLocal] })
    vi.spyOn(api.spatial, 'read').mockImplementation(() => f.b.spatial.readForLayout())
    vi.spyOn(api.spatial, 'commit').mockImplementation(input => f.b.spatial.commit(input))
    const dispose = await useAppStore.getState().initialize(); cleanup.push(dispose)
    const inputBefore = useAppStore.getState().mountedSpaceInputs
    useAppStore.setState({ sessions: [sameSidLocal], agentComposerDrafts: { [sid]: 'Unrelated local same-SID draft' }, selectedSpaceMount: null })
    const tabId = admission.address.tabId!, regionId = admission.address.regionId
    const occurrence = ordinaryAgentSpaceMember({ tabId, regionId, sessionId: sid })
    expect(occurrence.kind).toBe('foreign')
    if (occurrence.kind !== 'foreign') throw Error('Original foreign occurrence was not delivered')
    expect(useAppStore.getState().tabs[tabId]!.regions[regionId]).toMatchObject({ phase: 'attached', sessionId: sid })
    const layout = useAppStore.getState().layouts['original-b-project']
    const view = (visible: boolean) => <DesktopClientUiProvider><WorkspaceWorkbench workspaceId="original-b-project" visible={visible} /></DesktopClientUiProvider>
    attach.mockClear(); write.mockClear()
    await act(async () => root.render(view(true)))
    await vi.waitFor(async () => { await act(async () => {}); expect(fixture.terminals, container.textContent ?? '').toHaveLength(1); expect(contents(fixture.terminals[0]!)).toContain('Ordinary B Region, original D terminal') })
    expect(member).toHaveBeenCalledOnce()
    expect(member.mock.calls[0]![0]).toEqual(occurrence.member)
    expect(container.querySelector('.ordinary-space-member__header .agent-execution-relation')).not.toBeNull()
    expect(container.querySelector('.ordinary-space-member__header [data-execution-role="project"]')?.getAttribute('data-local')).toBe('true')
    expect(container.querySelector('.ordinary-space-member__header [data-execution-role="agent"]')?.hasAttribute('data-local')).toBe(false)
    expect(metadata).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce()
    expect(useAppStore.getState().mountedSpaceInputs).toBe(inputBefore)
    expect(useAppStore.getState().selectedSpaceMount).toBeNull()
    expect(useAppStore.getState().sessions).toContainEqual(sameSidLocal)
    expect(container.querySelector('[aria-label="Send new message"]')).not.toBeNull()
    const rich = container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('[role="textbox"]')!
    await act(async () => rich.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Only the original D member draft' }] }] }))
    expect(mountedMemberDraft(useAppStore.getState().mountedSpaceInputs, spaceMountKey(f.reference), tabId, occurrence.member)).toBe('Only the original D member draft')
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Unrelated local same-SID draft')
    expect(useAppStore.getState().selectedSpaceMount).toBeNull()
    fixture.terminals[0]!.input('x'); await vi.waitFor(() => expect(raw).toHaveBeenCalledOnce())
    expect(raw.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, expectedRun: original.run, data: 'x' })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send new message"]')!.click())
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, expectedRun: original.run, prompt: 'Only the original D member draft' })
    const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
    const restored = JSON.parse(JSON.stringify(persisted))
    expect(restored.mountedSpaceInputs).toEqual(useAppStore.getState().mountedSpaceInputs)
    expect(restored.mountedSpaceInputs[spaceMountKey(f.reference)].kind).toBe('space-member-input')
    expect(JSON.stringify(restored.mountedSpaceInputs)).toContain('Only the original D member draft')
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Unrelated local same-SID draft')
    expect(attach).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    expect(useAppStore.getState().layouts['original-b-project']).toBe(layout)
    await act(async () => root.render(view(false)))
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: original.run })
    await act(async () => root.render(null))
    const { GlobalFocusSurface } = await import('../src/renderer/src/components/GlobalFocusSurface')
    const selectOriginal = vi.fn()
    useAppStore.setState({ mainSurface: 'agents', focusView: 'list' })
    await act(async () => root.render(<DesktopClientUiProvider><GlobalFocusSurface onSelectLocation={selectOriginal} /></DesktopClientUiProvider>))
    await vi.waitFor(async () => {
      await act(async () => {})
      const source = container.querySelector('[aria-label="Original project Agents"]')
      expect(source).not.toBeNull()
      expect(source!.textContent).toContain(sid)
      expect(source!.textContent).not.toContain('Original Session state unconfirmed')
    })
    expect(metadata).toHaveBeenCalledTimes(2); expect(business).toHaveBeenCalledTimes(2); expect(member).toHaveBeenCalledOnce()
    expect(container.querySelector('[aria-label="Original project Agents"] .agent-execution-relation')).not.toBeNull()
    const focusInput = useAppStore.getState().mountedSpaceInputs
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Original project Agents"] .mounted-space-focus__member')!.click())
    expect(selectOriginal).toHaveBeenCalledExactlyOnceWith({ displayWorkspaceId: 'original-b-project', groupId: layout!.activeGroupId, tabId, regionId })
    expect(useAppStore.getState().selectedSpaceMount).toBeNull()
    expect(useAppStore.getState().mountedSpaceInputs).toBe(focusInput)
    expect(useAppStore.getState().sessions).toContainEqual(sameSidLocal)
    const newRun = await f.d.put(sid, 2, 'original-D-continued-run')
    await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceSessions[spaceMountKey(f.reference)]!.members)
      .some(fact => fact.state.status === 'observed' && fact.state.session.agentSessionId === sid && fact.state.session.run?.runId === newRun.run.runId)).toBe(true))
    expect((await f.b.spatial.readForLayout()).graph.regions.find(region => region.regionId === regionId)!.runId).toBe(original.run.runId)
    const currentSubject = await f.d.core.runtimeSubject({ kind: 'agent-session', agentSessionId: sid })
    if (currentSubject.kind !== 'agent') throw Error('Expected the same original Agent in its current Run')
    const continuedData = 'Same original D Session, current Run\r\n', continuedBytes = new TextEncoder().encode(continuedData)
    nativeAttachment.mockResolvedValue({ run: currentSubject.run, gap: null, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' },
      replay: [{ type: 'data', runId: newRun.run.runId, startByte: 0, endByte: continuedBytes.length, data: continuedData, dataBytes: continuedBytes }] })
    await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
    expect(metadata.mock.calls.at(-1)![2]!.aborted).toBe(true)
    await act(async () => root.render(null))
    await act(async () => root.render(view(true)))
    await vi.waitFor(() => expect(member.mock.calls.at(-1)![0].target.expectedRun).toEqual(newRun.run))
    await vi.waitFor(() => expect(contents(fixture.terminals.at(-1)!)).toContain('Same original D Session, current Run'))
    const handlesBeforeGap = member.mock.calls.length
    await act(async () => metadata.mock.calls.at(-1)![1]({ type: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'Private metadata reader unavailable' } }))
    expect(member).toHaveBeenCalledTimes(handlesBeforeGap)
    expect(contents(fixture.terminals.at(-1)!)).toContain('Same original D Session, current Run')
    // A missing ephemeral observation is not a new Run decision or loss of the
    // already usable exact handle. A new witness still has its own address.
    await act(async () => useAppStore.setState({ mountedSpaceSessions: {} }))
    expect(member).toHaveBeenCalledTimes(handlesBeforeGap)
    expect(contents(fixture.terminals.at(-1)!)).toContain('Same original D Session, current Run')
    const retainedInputs = JSON.stringify(useAppStore.getState().mountedSpaceInputs)
    expect(retainedInputs).toContain(original.run.runId)
    expect(retainedInputs).toContain('Only the original D member draft')
    expect(submit).toHaveBeenCalledOnce(); expect(raw).toHaveBeenCalledOnce()
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Unrelated local same-SID draft')
    await act(async () => root.render(null))
  } finally { for (const dispose of cleanup.reverse()) await dispose() }
})

it('the ordinary Region viewer does not inherit A grants and a denied foreign member leaves its healthy local neighbour usable', async () => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { createHostRouteInventoryFixture } = await import('../../../packages/core/test/helpers/host-route-inventory-fixture')
  const { AgentMuxControlServer } = await import('../../../packages/core/src/public-rpc-server')
  const { connectAgentMuxRpc } = await import('../../../packages/core/src/public-rpc-client')
  const { spaceMountTransport } = await import('./helpers/space-mount-fixture')
  const { OrdinarySpaceMemberViewport } = await import('../src/renderer/src/components/OrdinarySpaceMemberViewport')
  const { SessionPane } = await import('../src/renderer/src/components/SessionPane')
  const { DesktopClientUiProvider } = await import('../src/renderer/src/components/DesktopClientUiProvider')
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  try {
    const routeCleanup: Array<() => Promise<void>> = []
    cleanup.push(async () => { for (const close of routeCleanup.reverse()) await close() })
    const route = await createHostRouteInventoryFixture(routeCleanup), f = await createSpaceSessionsFixture(cleanup)
    // Match the explicit metadata Runtime leaves to the real signed route authorities.
    // No current actor, route grant or receiver decision is stubbed.
    f.b.owner.runtimeId = route.b.identity.runtimeId; f.d.owner.runtimeId = route.d.identity.runtimeId
    const reference = { ...f.reference, runtimeId: f.b.owner.runtimeId }
    // These real grants name actor.source A, even though both local Unix user IDs are equal.
    expect(route.actor.source.runtimeId).toBe('runtime-A')
    await route.configure(route.b, [{ id: 'collision', route: route.route }], [route.grant('A-only-member', route.a.identity, route.b.identity, ['space.member.call', 'space.member.watch'])])
    const sid = 'B-viewer-ungranted-D', original = await f.d.put(sid)
    const admission = await f.admit('collision', f.d.owner.runtimeId, sid, 'A-original-route-CID', route.route)
    await f.b.spatial.settleAgentOpen(admission.requestId, original, { workspaceId: 'original-b-project', phase: 'attached',
      agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'collision', runtimeId: f.d.owner.runtimeId } })
    const dWrite = vi.spyOn(f.d.core, 'writeAgent')
    const dRouteWrite = vi.spyOn(route.original.client, 'writeAgent')
    const authorizations = vi.spyOn(route.b.gateway, 'authorizeMemberControl')
    const server = new AgentMuxControlServer({ spatialState: f.b.spatial, hostRoutes: route.b.gateway,
      coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted }, f.b.root + '/B-viewer.sock')
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
    const config: AppConfig = { ...configuration, hosts: [{ id: 'local', kind: 'local', label: 'B viewer' }],
      workspaces: [{ id: 'original-b-project', name: 'B project', hostId: 'local', path: '/b/project', kind: 'folder' }] }
    const main = spaceMountTransport(cleanup, [{ id: 'local', carrier: { forwardRpc: rpc.call.bind(rpc), subscribeRpc: rpc.subscribe.bind(rpc) } }], config)
    const target = { hostId: 'local', target: { reference, regionId: admission.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: original.run } }
    const surface = await main.api.member(target, () => {}); cleanup.push(() => surface.dispose())
    await expect(surface.call('read', {})).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
    await expect(surface.call('write', { data: 'must-not-reach-D', source: 'user' })).rejects.toMatchObject({ code: 'HOST_ROUTE_NOT_DELEGATED' })
    const currentViewer = await authorizations.mock.results[0]!.value
    expect(currentViewer.actor.source).toEqual(route.b.identity)
    expect(currentViewer.actor.source).not.toEqual(route.actor.source)
    expect(authorizations.mock.calls[0]![1].principal).toMatchObject({ kind: 'user', id: route.actor.id })
    expect(dWrite).not.toHaveBeenCalled(); expect(dRouteWrite).not.toHaveBeenCalled()
    vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
    const snapshot = await api.sessions.snapshot()
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, config, sessions: [session] })
    vi.spyOn(api.spatial, 'read').mockImplementation(() => f.b.spatial.readForLayout())
    vi.spyOn(api.spatial, 'commit').mockImplementation(input => f.b.spatial.commit(input))
    const dispose = await useAppStore.getState().initialize(); cleanup.push(dispose)
    useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Healthy local input' }, selectedSpaceMount: null })
    await act(async () => root.render(<DesktopClientUiProvider>
      <OrdinarySpaceMemberViewport tabId={admission.address.tabId!} regionId={admission.address.regionId} sessionId={sid} visible active><div>Must not borrow a local Session</div></OrdinarySpaceMemberViewport>
      <SessionPane sessionId={session.id} surfaceKind="agent" linkOrigin={origin} visible />
    </DesktopClientUiProvider>))
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('has not delegated'); expect(fixture.terminals).toHaveLength(1) })
    fixture.terminals[0]!.input('healthy-local')
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write.mock.calls[0]![0]).toEqual(session.control)
    expect(dWrite).not.toHaveBeenCalled(); expect(dRouteWrite).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions.map(current => current.id)).toEqual([session.id])
    expect(useAppStore.getState().selectedSpaceMount).toBeNull()
    expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: original.run })
    await act(async () => root.render(null))
  } finally { for (const close of cleanup.reverse()) await close() }
})

it.each(['missing-admission', 'old-optional-fields'] as const)('an already observed direct remote legacy Session keeps its original Host control without requiring a new Space admission (%s)', async legacyKind => {
  const { createSpaceSessionsFixture } = await import('../../../packages/core/test/helpers/space-session-fixture')
  const { OrdinarySpaceMemberViewport } = await import('../src/renderer/src/components/OrdinarySpaceMemberViewport')
  const { SessionPane } = await import('../src/renderer/src/components/SessionPane')
  const { DesktopClientUiProvider } = await import('../src/renderer/src/components/DesktopClientUiProvider')
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  try {
    const f = await createSpaceSessionsFixture(cleanup), sid = 'legacy-direct-remote-original'
    const original = await f.d.put(sid), admission = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'fixture-only-original-admission')
    await f.b.spatial.settleAgentOpen(admission.requestId, original, { workspaceId: 'original-b-project', phase: 'attached',
      agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
    const legacy = await f.b.spatial.readForLayout()
    // Original pre-admission Desktop delivery is the explicit leaf: it has the exact
    // remote Host/SID/control/descriptor, but no new source-qualified admission witness.
    const legacyRegion = legacy.graph.regions.find(region => region.regionId === admission.address.regionId)!
    if (legacyKind === 'missing-admission') delete legacyRegion.creationOperationId
    else {
      const { spatialAgentOpenRecord } = await import('@agentmux/core/spatial-graph')
      const oldRecord = spatialAgentOpenRecord(legacy.graph, admission.requestId)!
      delete oldRecord.placement; delete oldRecord.execution.runtimeId; delete oldRecord.execution.executorRevision
      if (legacyRegion.execution) delete legacyRegion.execution.runtimeId
      expect(spatialAgentOpenRecord(legacy.graph, admission.requestId)).toMatchObject({ requestId: admission.requestId, agentSessionId: sid })
    }
    const remote: Extract<SessionSnapshot, { kind: 'agent' }> = { ...session, id: sid, hostId: 'D-in-B', workspacePath: original.workspacePath,
      control: { kind: 'agent', hostId: 'D-in-B', agentSessionId: sid, run: original.run } }
    const config: AppConfig = { ...configuration, hosts: [{ id: 'local', kind: 'local', label: 'B' },
      { id: 'D-in-B', kind: 'ssh', label: 'Original D', hostname: 'private-unconnected-fixture.invalid' }],
      workspaces: [{ id: 'original-b-project', hostId: 'local', path: '/b/project', kind: 'folder', name: 'B project' }] }
    const snapshot = await api.sessions.snapshot()
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, config, sessions: [remote] })
    vi.spyOn(api.spatial, 'read').mockResolvedValue(legacy)
    const dispose = await useAppStore.getState().initialize(); cleanup.push(dispose)
    useAppStore.setState({ sessions: [remote], agentComposerDrafts: { [sid]: 'Original remote unsent draft' } })
    attach.mockResolvedValue(replay('The original direct D terminal\r\n', remote)); attach.mockClear(); write.mockClear()
    const member = vi.spyOn(api.spaceMounts, 'member')
    const linkOrigin = { workspaceId: 'original-b-project', tabId: admission.address.tabId!, regionId: admission.address.regionId }
    const view = <DesktopClientUiProvider><OrdinarySpaceMemberViewport {...linkOrigin} sessionId={sid} visible active>
      <SessionPane sessionId={sid} surfaceKind="agent" linkOrigin={linkOrigin} visible />
    </OrdinarySpaceMemberViewport></DesktopClientUiProvider>
    await act(async () => root.render(view))
    await vi.waitFor(async () => { await act(async () => {}); expect(fixture.terminals).toHaveLength(1) })
    expect(contents(fixture.terminals[0]!)).toContain('The original direct D terminal')
    fixture.terminals[0]!.input('same-original-remote')
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write.mock.calls[0]![0]).toEqual(remote.control)
    expect(write.mock.calls[0]![0].hostId).toBe('D-in-B')
    expect(member).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original remote unsent draft')
    const originalAttachments = attach.mock.calls.length
    // Same raw SID from this observer's local Core is a different control owner.
    await act(async () => useAppStore.setState({ sessions: [{ ...remote, hostId: 'local', control: { ...remote.control, hostId: 'local' } }] }))
    expect(container.textContent).toContain('Original Agent reference unconfirmed')
    expect(container.querySelector('[data-private-wheel-surface]')).toBeNull()
    expect(attach).toHaveBeenCalledTimes(originalAttachments)
    expect(write).toHaveBeenCalledOnce(); expect(member).not.toHaveBeenCalled()
    expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: original.run })
    await act(async () => root.render(null))
  } finally { for (const close of cleanup.reverse()) await close() }
})
