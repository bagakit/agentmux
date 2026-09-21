// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
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
import { TERMINAL_REPLAY_BATCH_BYTES } from '../src/renderer/src/lib/terminal-replay'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Real public xterm parser/buffers/modes, TerminalView, Store and viewport synchronizer.
// DOM painting/addons and Runtime IPC transport are fixture boundaries. Root's Native gate
// separately owns the real PTY checkpoint/SDK and Chromium wheel delivery.
const fixture = vi.hoisted(() => ({
  terminals: [] as BrowserTerminal[],
  focus: vi.fn(), writes: [] as Uint8Array[], grids: [] as Array<{cols:number;rows:number}>
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
async function render(current: SessionSnapshot = session, visible = true) {
  await act(async () => root.render(createElement(TerminalView, { session: current,
    interactiveResize: false, visible, autoFocus: false, themeId: configuration.appearance.terminalTheme, linkOrigin: origin,
    onObservationRefresh: (refresh: (() => Promise<void>) | null) => { refreshObservation = refresh } })))
}
async function ready(result: SessionAttachResult) {
  state(result.session); attach.mockResolvedValue(result); await render(result.session)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: result.session.id, runId: result.session.control.run.runId})).toMatchObject({liveReady:true})))
  expect(fixture.terminals).toHaveLength(1); return fixture.terminals[0]!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0; fixture.writes.length = 0; fixture.grids.length = 0; fixture.focus.mockClear()
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
    terminal:{type:'basic-vt',checkpoint:{runId:session.control.run.runId,throughByte:fence,resizeRevision:3,size:{cols:80,rows:24}},
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
async function delivered(event: RuntimeEvent) {
  await act(async () => { receive(event); await new Promise(resolve => setTimeout(resolve,25)) })
}

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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
})

it('shows a lost live geometry ordering proof without blocking the same Run input', async () => {
  const terminal=await ready(continuation('live'))
  await delivered(resized(fence,5,80,24))
  expect(container.textContent).toContain('source gap')
  await act(async () => terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
  expect(recover).not.toHaveBeenCalled()
})

function snapshot(result: SessionAttachResult): RuntimeEvent {
  const run: AgentMuxRunAttachment['run'] = {runId:session.control.run.runId,kind:'agent',providerId:'codex',executorId:'codex',
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

it('refreshes in the existing drain after a held write, coalescing only covered work and keeping later live bytes', async () => {
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
    await vi.waitFor(()=>expect(contents(terminal)).toContain('latest-seedTAILFUTURE'))
  })
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.writes.map(bytes=>new TextDecoder().decode(bytes))).toEqual(['old-canvas','HELD','\x1bclatest-seed','TAIL','FUTURE'])
  expect(contents(terminal)).not.toContain('obsolete-seed')
  expect(fixture.grids.slice(-3)).toEqual([{cols:80,rows:24},{cols:40,rows:24},{cols:80,rows:24}])
  expect(fixture.grids).not.toContainEqual({cols:20,rows:10})
  expect(attach).toHaveBeenCalledTimes(1)
  expect(recover).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Restoring terminal state')
})

it('keeps healthy raw input available during a held reconnect seed and suppresses its OSC side effects', async () => {
  const terminal=await ready(continuation('original'))
  const seed='\x1bcnew-canvas\x1b]10;?\x07'
  const held=holdWrite(terminal,seed)
  await act(async()=>{receive(snapshot(continuation(seed)));await held.started})
  expect(readTerminalViewObservation({regionId:origin.regionId,sessionId:session.id,runId:session.control.run.runId}))
    .toMatchObject({liveReady:true,acceptsInput:true})
  await act(async()=>terminal.input('z'))
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
  await act(async()=>{held.release();await vi.waitFor(()=>expect(contents(terminal)).toContain('new-canvas'))})
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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
  const known=continuation('\x1bcproven-canvas')
  if(known.terminal.type==='basic-vt') known.terminal.checkpoint.throughByte=uncertain.session.latestOutputBytes+8
  known.session={...session,latestOutputBytes:uncertain.session.latestOutputBytes+8}
  await delivered(snapshot(known))
  expect(contents(terminal)).toContain('proven-canvas')
  expect(container.textContent).not.toContain('Restoring terminal state')
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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
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
  expect(write).toHaveBeenCalledExactlyOnceWith(session.control,'z','user')
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
  const history = Array.from({ length: 6000 }, (_, i) => `LONG${String(i).padStart(4, '0')}\r\n`).join('')
  const terminal = await ready(continuation(history))
  expect(terminal.buffer.active.length).toBe(5024)
  expect(terminal.markers).toEqual([])
  await act(async () => terminal.scrollToLine(300))
  const anchor = terminal.buffer.active.getLine(300)!.translateToString(true)
  expect(anchor).toBe('LONG1277')
  await render(session, false)
  vi.spyOn(terminal, 'getSelectionPosition').mockReturnValue({ start: { x: 0, y: 300 }, end: { x: 8, y: 300 } })
  // open() omits DOM SelectionService; only selection API delivery is a fixture boundary.
  // The public parser, markers, trim and reading viewport remain real.
  const selected = vi.spyOn(terminal, 'select').mockImplementation(() => {})
  await delivered(resized(fence, 4, 80, 9))
  expect(terminal.rows).toBe(9)
  expect(terminal.buffer.active.length).toBe(5009)
  expect(terminal.buffer.active.viewportY).toBe(285)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true)).toBe(anchor)
  expect(selected).toHaveBeenCalledExactlyOnceWith(0, 285, 8)
  await render(session, true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)!.translateToString(true)).toBe(anchor)
  expect(terminal.markers).toEqual([])
  expect(write).not.toHaveBeenCalled()
})

it('keeps the tracked reading line when a successful observation refresh applies a full-buffer row resize', async () => {
  const history = Array.from({ length: 6000 }, (_, i) => `LONG${String(i).padStart(4, '0')}\r\n`).join('')
  const terminal = await ready(continuation(history))
  expect(terminal.buffer.active.length).toBe(5024)
  await act(async () => terminal.scrollToLine(300))
  expect(terminal.buffer.active.getLine(300)!.translateToString(true)).toBe('LONG1277')
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue({ ...session, latestOutputBytes: fence })
  const refresh = vi.spyOn(api.sessions, 'refreshAttachment').mockResolvedValue(continuation('', '', [
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
