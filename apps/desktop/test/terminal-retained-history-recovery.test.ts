// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { AgentMuxClient } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller'
import { recoverTerminalRetainedOutput, terminalHistoryBoundary } from '../src/renderer/src/lib/terminal-replay'
import type { SessionReplayResult } from '../src/shared/contracts'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'

type FixtureTerminal = BrowserTerminal & {
  refresh: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  written: string[]
  writtenBytes: Uint8Array[]
  parsedBytes: Uint8Array[]
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
  replay: vi.fn(),
  detach: vi.fn(),
  resize: vi.fn(),
  unsubscribe: vi.fn(),
  blockFirstWrite: false,
  releaseWrite: null as (() => void) | null,
  reveal: null as (() => void) | null,
  proposedGrid: { cols: 80, rows: 24 }
}))

vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    refresh = vi.fn()
    written: string[] = []
    writtenBytes: Uint8Array[] = []
    parsedBytes: Uint8Array[] = []
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      this.dispose = vi.fn(() => super.dispose())
      fixture.terminals.push(this as unknown as FixtureTerminal)
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      this.writtenBytes.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice())
      const parsed = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice()
      super.write(data, () => {
        const complete = (): void => { this.parsedBytes.push(parsed); callback?.() }
        if (fixture.blockFirstWrite) {
          fixture.blockFirstWrite = false
          fixture.releaseWrite = complete
        } else complete()
      })
    }
    open(root: HTMLElement) { this.element = document.createElement('div'); root.append(this.element) }
    focus() {}
    onRender = () => ({ dispose() {} })
    onSelectionChange = () => ({ dispose() {} })
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
  proposeDimensions() { return fixture.proposedGrid }
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
  replay: fixture.replay,
  detach: fixture.detach,
  resize: fixture.resize,
  onEvent: (receive: (event: RuntimeEvent) => void) => {
    fixture.receive = receive
    return fixture.unsubscribe
  }
} } }))
vi.mock('../src/renderer/src/store', () => {
  const state = {
    config: null, regionCaretFocus: null,
    clearRegionCaretFocus: vi.fn(), recoverSession: vi.fn(),
    openHttpLink: vi.fn(), openFile: vi.fn(), reportError: vi.fn()
  }
  return { useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state
  }) }
})
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))

const session: SessionSnapshot = {
  id: 'session-retained', hostId: 'local', workspacePath: '/fixture', label: 'Retained',
  createdAt: 1, updatedAt: 1, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  kind: 'terminal', providerId: null,
  control: { kind: 'terminal', hostId: 'local', runId: 'run-retained', run: { runId: 'run-retained' } }
}
const linkOrigin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0
  fixture.webgl.length = 0
  fixture.receive = null
  fixture.releaseWrite = null
  fixture.reveal = null
  fixture.blockFirstWrite = false
  fixture.proposedGrid = { cols: 80, rows: 24 }
  vi.clearAllMocks()
  const original = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 6_000) fixture.reveal = callback as () => void
    return original(callback, delay, ...args)
  })
  fixture.attach.mockResolvedValue(attachment(replay('before ',0)))
  fixture.detach.mockResolvedValue(undefined)
  fixture.resize.mockImplementation(async (_attachment, cols, rows) => ({ cols, rows }))
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

vi.mock('../src/renderer/src/lib/terminal-live-output', async (original) => {
  const actual = await original<typeof import('../src/renderer/src/lib/terminal-live-output')>()
  return { ...actual, TerminalLiveOutputQueue: class extends actual.TerminalLiveOutputQueue { constructor() { super(80) } } }
})

const control = session.control
function controllerFixture(readRunReplay: ReturnType<typeof vi.fn>) {
  const key = JSON.stringify([control.hostId, control.run.runId])
  const client: AgentMuxClient = Object.assign(Object.create(AgentMuxClient.prototype), {
    connected:true, runPids:new Map(), endedRuns:new Map(),
    registry:{isRetiredRun:()=>false,findByRun:()=>undefined},
    kernel:{isConnected:()=>true,replay:async (runId:string,afterByte:number) => {
      const result=await readRunReplay({runId},afterByte)
      return {...result,run:{...result.run,pid:42,state:{type:'running'},cols:80,rows:24,latestOutputBytes:result.replay.at(-1)?.endByte ?? afterByte}}
    }},
    resizeTerminal:vi.fn(async (_run,cols,rows)=>({cols,rows})),
    writeTerminal:vi.fn(async()=>({acceptedThroughByte:5})), runtimeIdentity:()=>({instanceId:'owner'}),
    releaseRunAttachment:vi.fn(async()=>{})
  })
  // The actual production method executes; fixture only supplies its established lease and Core.
  const controller: RuntimeController = Object.assign(Object.create(RuntimeController.prototype), {
    sessionAttachmentOwners: new Map([[key, { control, controlIdentity: '', attachmentIds: new Set(['attachment-retained']) }]]),
    sessionAttachmentLeases: new Map([['attachment-retained', { key, webContentsId: 7 }]]),
    sessionAttachmentTails: new Map(), sessionReplayReads: new Map(), terminalInputTails:new Map(), terminalInputCursors:new Map([[key,0]]), connectedClient: vi.fn(async () => client)
  })
  return { controller,client,key }
}
function replay(data: string | Uint8Array, afterByte: number, firstByte = 0): SessionReplayResult & {run: {runId:string}} {
  const startByte = Math.max(afterByte, firstByte)
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return { run: control.run, gap: afterByte < firstByte ? { requestedAfterByte: afterByte, firstAvailableByte: firstByte } : null,
    replay: startByte < bytes.length ? [{type:'data',runId:control.run.runId,startByte,endByte:bytes.length,data:new TextDecoder().decode(bytes.subarray(startByte)),dataBytes:bytes.subarray(startByte)}] : [] }
}
function attachment(source: SessionReplayResult): SessionAttachResult {
  return {attachmentId:'attachment-retained',currentSize:{cols:80,rows:24},
    session:{...session,latestOutputBytes:source.replay.at(-1)?.endByte ?? 0},
    terminal:{type:'unknown',reason:'origin_unknown'},resizeRevision:0,...source}
}
const initial = Array.from({length:100},(_,i) => `initial-${i}\r\n`).join('')
const tail = Array.from({length:40},(_,i) => `live-${i}\r\n`).join('')
const full = initial + tail
async function mountInitial(data = initial, block = false, overrides: Partial<Parameters<typeof TerminalView>[0]> = {}) {
  fixture.blockFirstWrite = block
  fixture.attach.mockResolvedValue(attachment(replay(data,0)))
  await act(async () => root!.render(createElement(TerminalView,{session,themeId:'graphite',interactiveResize:false,visible:true,autoFocus:false,linkOrigin,...overrides})))
  expect(fixture.terminals).toHaveLength(1)
  if (!block) await waitParsed(data)
  return fixture.terminals[0]!
}
async function waitParsed(expected: string | Uint8Array) {
  const bytes = typeof expected === 'string' ? new TextEncoder().encode(expected) : expected
  expect(bytes.byteLength).toBeGreaterThan(0)
  await act(async () => await vi.waitFor(() => {
    expect(fixture.terminals[0]?.parsedBytes.length).toBeGreaterThan(0)
    expect(Buffer.concat(fixture.terminals[0]!.parsedBytes)).toEqual(Buffer.from(bytes))
  }))
}
async function waitParsedTail(expected: string) {
  expect(expected.length).toBeGreaterThan(0)
  await act(async () => await vi.waitFor(() => {
    expect(fixture.terminals[0]?.parsedBytes.length).toBeGreaterThan(0)
    expect(Buffer.concat(fixture.terminals[0]!.parsedBytes).toString()).toContain(expected)
    expect(Buffer.concat(fixture.terminals[0]!.parsedBytes)).toEqual(Buffer.concat(fixture.terminals[0]!.writtenBytes))
  }))
}
function burst(data: string, startByte: number) {
  expect(fixture.receive).not.toBeNull()
  let cursor=startByte
  for (const line of data.match(/[^\n]*\n/g) ?? []) {
    fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-output',run:control.run,data:line,dataBytes:new TextEncoder().encode(line),evidence:{outputByteRange:{startByte:cursor,endByte:cursor+line.length}}}} as RuntimeEvent)
    cursor+=line.length
  }
}

it('recovers client live overflow through the actual lease→Core replay seam before parsing live, once, retaining the reading line', async () => {
  const readRunReplay = vi.fn(async (_run,afterByte) => replay(full,afterByte))
  const {controller} = controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte) => controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  terminal.scrollToLine(5)
  const reading=terminal.buffer.active.getLine(5)?.translateToString(true)
  await act(async () => burst(tail,initial.length))
  await waitParsed(full)
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length)
  expect(terminal.written.join('')).toBe(full)
  expect(terminal.buffer.active.viewportY).toBe(5)
  expect(terminal.buffer.active.getLine(5)?.translateToString(true)).toBe(reading)
  expect(document.body.textContent).not.toContain('Earlier scrollback is unavailable')
  expect(Buffer.concat(terminal.parsedBytes)).toEqual(Buffer.from(full))
})

it.each([
  {kind:'UTF-8',head:'中\r\n',split:1,visible:'中'},
  {kind:'ANSI',head:'\x1b[31mANSI-CONTENT\x1b[0m\r\n',split:2,visible:'ANSI-CONTENT'}
])('continues a $kind prefix already parsed before overflow through raw public Core replay', async ({kind,head,split,visible})=>{
  const encoder=new TextEncoder()
  const headBytes=encoder.encode(head)
  const all=encoder.encode(initial+head+tail)
  const readRunReplay=vi.fn(async (_run,afterByte)=>replay(all,afterByte))
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte)=>controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  const decoder=new TextDecoder()
  const receive=(dataBytes:Uint8Array,startByte:number)=>{
    fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-output',run:control.run,
      data:decoder.decode(dataBytes,{stream:true}),dataBytes,
      evidence:{outputByteRange:{startByte,endByte:startByte+dataBytes.byteLength}}}} as RuntimeEvent)
  }
  await act(async()=>receive(headBytes.subarray(0,split),initial.length))
  await waitParsed(all.subarray(0, initial.length+split))
  // The parser consumed a real prefix without a completed character/control sequence.
  expect(terminal.buffer.normal.getLine(100)?.translateToString(true)).toBe('')
  expect(terminal.writtenBytes.at(-1)).toEqual(headBytes.subarray(0,split))
  await act(async()=>{
    receive(headBytes.subarray(split),initial.length+split)
    burst(tail,initial.length+headBytes.byteLength)
  })
  await waitParsed(all)
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length+split)
  if(kind==='UTF-8') {
    // Core replay starts inside the character. Its independent semantic decoder cannot
    // reconstruct the original prefix; xterm's existing raw parser can continue it.
    expect(replay(all,initial.length+split).replay[0]?.data).toMatch(/^\ufffd/)
  }
  expect(terminal.buffer.normal.getLine(100)?.translateToString(true)).toBe(visible)
  if(kind==='ANSI') {
    const cell=terminal.buffer.normal.getLine(100)?.getCell(0)
    expect(cell?.isFgPalette()).toBeTruthy()
    expect(cell?.getFgColor()).toBe(1)
  }
  expect(Buffer.concat(terminal.writtenBytes)).toEqual(Buffer.from(all))
  expect(document.body.textContent).not.toContain('could not be read')
  expect(document.body.textContent).not.toContain('History gap')
})

it('recovers a startup prefix omitted while replay was pending without advancing past missing bytes first', async () => {
  const startup = Array.from({length:300},(_,i) => `startup-${i}\r\n`).join('')
  const all=initial+startup
  const readRunReplay = vi.fn(async (_run,afterByte) => replay(all,afterByte))
  const {controller} = controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte) => controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial(initial,true)
  await act(async () => await vi.waitFor(() => expect(fixture.releaseWrite).not.toBeNull()))
  await act(async () => burst(startup,initial.length))
  expect(terminal.parsedBytes).toEqual([])
  await act(async () => fixture.releaseWrite!())
  await waitParsed(all)
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length)
  expect(terminal.written.join('')).toBe(all)
})

it('applies a dropped startup owner resize before replay parses alternate rows and columns on the real synchronizer', async () => {
  const alternate='\x1b[?1049h\x1b[40;100HWIDE-CONTENT'
  // Each NUL is a real byte event without changing the screen. This overflows the startup
  // event bound, including the resize and alternate-screen prefix that preceded the tail.
  const padding='\0'.repeat(300)
  const all=initial+alternate+padding
  const ownerSize=vi.spyOn(TerminalViewportSynchronizer.prototype,'acceptOwnerSize')
  const gridAtRead=vi.fn()
  const readRunReplay=vi.fn(async (_run,afterByte)=>{
    const terminal=fixture.terminals[0]!
    gridAtRead({cols:terminal.cols,rows:terminal.rows})
    return replay(all,afterByte)
  })
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte)=>controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial(initial,true)
  await act(async()=>await vi.waitFor(()=>expect(fixture.releaseWrite).not.toBeNull()))
  expect(ownerSize).toHaveBeenCalledExactlyOnceWith({cols:80,rows:24})
  ownerSize.mockClear()
  fixture.proposedGrid={cols:132,rows:45}
  await act(async()=>{
    fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-resized',run:control.run,cols:132,rows:45,throughByte:initial.length,resizeRevision:1}} as RuntimeEvent)
    let cursor=initial.length
    for(const data of [alternate,...padding]) {
      fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-output',run:control.run,data,dataBytes:new TextEncoder().encode(data),evidence:{outputByteRange:{startByte:cursor,endByte:cursor+data.length}}}} as RuntimeEvent)
      cursor+=data.length
    }
  })
  expect(ownerSize).not.toHaveBeenCalled()
  await act(async()=>fixture.releaseWrite!())
  await waitParsed(all)
  expect(ownerSize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({cols:132,rows:45}))
  expect(terminal.buffer.active.type).toBe('alternate')
  expect(terminal.buffer.active.getLine(39)?.translateToString(true).slice(99)).toBe('WIDE-CONTENT')
  expect(gridAtRead).toHaveBeenCalledExactlyOnceWith({cols:132,rows:45})
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length)
  expect(terminal.written.join('')).toBe(all)
})

it('keeps a genuine Runtime gap visible after successful current-screen repaint', async () => {
  const floor=initial.length+tail.indexOf('live-20')
  const readRunReplay = vi.fn(async (_run,afterByte) => replay(full,afterByte,floor))
  const {controller} = controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte) => controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  await act(async () => burst(tail,initial.length))
  await waitParsed(initial+tail.slice(tail.indexOf('live-20')))
  expect(terminal.written.join('')).toBe(initial+tail.slice(tail.indexOf('live-20')))
  const fact=document.querySelector('.terminal-replay-gap--compact')
  expect(fact).not.toBeNull()
  expect(fact?.getAttribute('title')).toContain('no longer retained')
  expect(document.body.textContent).not.toContain('could not be read')
})

it('times out an optional read, keeps parsing later live bytes, and admits no duplicate pending Core read', async () => {
  let settle!: (value: ReturnType<typeof replay>)=>void
  const readRunReplay=vi.fn(() => new Promise<ReturnType<typeof replay>>(resolve=>{settle=resolve}))
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte) => controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  await act(async () => burst(tail,initial.length))
  await act(async () => await vi.waitFor(() => expect(readRunReplay).toHaveBeenCalledOnce()))
  // Captured deadline is the recovery timer; it doesn't require faking the xterm parser clock.
  await act(async () => fixture.reveal!())
  await waitParsedTail('live-39\r\n')
  expect(document.body.textContent).toContain('earlier Runtime bytes may still exist')
  expect(document.body.textContent).toContain('Live input remains available.')
  expect(document.body.textContent).not.toContain('Runtime reported a history gap')
  const later=tail.replaceAll('live','more')
  await act(async () => burst(later,full.length))
  await waitParsedTail('more-39\r\n')
  expect(readRunReplay).toHaveBeenCalledOnce()
  expect(terminal.written.join('')).toContain('more-39')
  await act(async () => { settle(replay(full,initial.length)); await Promise.resolve() })
})

it('binds replay to the current lease, refuses a different renderer/Run and keeps resize/input independent of pending history', async () => {
  let settle!: (value: ReturnType<typeof replay>)=>void
  const readRunReplay=vi.fn(() => new Promise<ReturnType<typeof replay>>(resolve=>{settle=resolve}))
  const {controller,client}=controllerFixture(readRunReplay)
  const denied=controller.readSessionReplay(8,'attachment-retained',0).catch(error=>error)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(readRunReplay).not.toHaveBeenCalled()
  expect(await denied).toMatchObject({message:expect.stringContaining('lease')})
  const pending=controller.readSessionReplay(7,'attachment-retained',0)
  await Promise.resolve()
  const busy=controller.readSessionReplay(7,'attachment-retained',100).catch(error=>error)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(readRunReplay).toHaveBeenCalledOnce()
  expect(await busy).toMatchObject({message:expect.stringContaining('still pending')})
  expect(await controller.resizeSessionAttachment(7,'attachment-retained',90,30)).toEqual({cols:90,rows:30})
  await controller.write(control,'input')
  expect(client.writeTerminal).toHaveBeenCalledWith(control.run,expect.objectContaining({data:'input',expectedByte:0}))
  expect(client.resizeTerminal).toHaveBeenCalledWith(control.run,90,30)
  expect(readRunReplay).toHaveBeenCalledOnce()
  settle(replay(full,0)); await pending
  readRunReplay.mockResolvedValueOnce({...replay(full,0),run:{runId:'different'}})
  await expect(controller.readSessionReplay(7,'attachment-retained',0)).rejects.toThrow('different Run')
  readRunReplay.mockResolvedValueOnce(replay(full,0))
  await expect(controller.readSessionReplay(7,'attachment-retained',0)).resolves.toMatchObject({gap:null})
})

it('reports actual normal row limits and alternate semantics without inventing Provider history', () => {
  expect(terminalHistoryBoundary({type:'normal',length:5_024},24,5_000)).toContain('5000')
  expect(terminalHistoryBoundary({type:'normal',length:200},24,5_000)).toBeNull()
  expect(terminalHistoryBoundary({type:'alternate',length:24},24,5_000)).toContain('no terminal scrollback')
})

it('shows alternate semantics from the actual parser without transferring alternate output to normal history', async () => {
  const terminal=await mountInitial()
  const normalLength=terminal.buffer.normal.length
  const alternate='\x1b[?1049h'+Array.from({length:40},(_,i)=>`alternate-${i}\r\n`).join('')
  fixture.replay.mockResolvedValue(replay(initial+alternate,initial.length))
  await act(async()=>burst(alternate,initial.length))
  await waitParsed(initial+alternate)
  expect(terminal.buffer.active.type).toBe('alternate')
  expect(terminal.buffer.active.baseY).toBe(0)
  expect(terminal.buffer.normal.length).toBe(normalLength)
  const fact=document.querySelector('[aria-label*="full-screen buffer"]')
  expect(fact).not.toBeNull()
  expect(fact?.getAttribute('aria-label')).toContain('no terminal scrollback')
})

it('keeps a pending exact-Run read owned after the original pane lease is detached and replaced', async () => {
  let settle!: (value:ReturnType<typeof replay>)=>void
  const readRunReplay=vi.fn(()=>new Promise<ReturnType<typeof replay>>(resolve=>{settle=resolve}))
  const {controller,key}=controllerFixture(readRunReplay)
  const pending=controller.readSessionReplay(7,'attachment-retained',0)
  await Promise.resolve()
  await controller.detachSession(7,'attachment-retained')
  Object.assign(controller,{
    sessionAttachmentOwners:new Map([[key,{control,controlIdentity:'',attachmentIds:new Set(['replacement'])}]]),
    sessionAttachmentLeases:new Map([['replacement',{key,webContentsId:9}]])
  })
  const busy=controller.readSessionReplay(9,'replacement',100).catch(error=>error)
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(readRunReplay).toHaveBeenCalledOnce()
  expect(await busy).toMatchObject({message:expect.stringContaining('still pending')})
  settle(replay(full,0)); await pending
  readRunReplay.mockResolvedValueOnce(replay(full,100))
  await expect(controller.readSessionReplay(9,'replacement',100)).resolves.toMatchObject({gap:null})
  expect(readRunReplay).toHaveBeenCalledTimes(2)
})

it.each(['complete','partial'])('deduplicates %s overlapping Core replay before parsing later queued output', async (overlap) => {
  const start=overlap==='complete'?0:initial.length-100
  const readRunReplay=vi.fn(async()=>replay(full,start))
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte)=>controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  await act(async()=>burst(tail,initial.length))
  await waitParsed(full)
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length)
  expect(terminal.written.join('')).toBe(full)
  expect(Buffer.concat(terminal.parsedBytes)).toEqual(Buffer.from(full))
})

it('treats an empty no-Gap Core read as unknown continuity, keeping live output and a truthful failure notice', async () => {
  const readRunReplay=vi.fn(async()=>({...replay('',0),run:control.run}))
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte)=>controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial()
  await act(async()=>burst(tail,initial.length))
  await waitParsedTail('live-39\r\n')
  expect(readRunReplay).toHaveBeenCalledExactlyOnceWith(control.run,initial.length)
  expect(terminal.written.join('')).not.toBe(full)
  expect(terminal.written.join('')).toContain('live-39')
  expect(document.body.textContent).toContain('earlier Runtime bytes may still exist')
  expect(document.body.textContent).not.toContain('Runtime reported a history gap')
  expect(document.querySelector('.terminal-replay-gap--compact')).toBeNull()
})

it.each(['read-only','exited'])('does not advertise live input after a failed optional history read in a %s terminal', async (mode)=>{
  const readRunReplay=vi.fn(async()=>({...replay('',0),run:control.run}))
  const {controller}=controllerFixture(readRunReplay)
  fixture.replay.mockImplementation((attachmentId,afterByte)=>controller.readSessionReplay(7,attachmentId,afterByte))
  const terminal=await mountInitial(initial,false,mode==='read-only'?{readOnly:true}:{session:{...session,processState:'exited'}})
  await act(async()=>burst(tail,initial.length))
  await waitParsedTail('live-39\r\n')
  expect(terminal.written.join('')).toContain('live-39')
  expect(document.body.textContent).toContain('earlier Runtime bytes may still exist')
  expect(document.body.textContent).toContain('This terminal is not currently accepting input.')
  expect(document.body.textContent).not.toContain('Live input remains available.')
})

it('uses byte suffixes for multibyte partial overlap and never advances an empty replay cursor to the requested future byte', async()=> {
  const body='先前✅\r\n后续🙂\r\n'
  const prior='先前✅\r\n'
  const cursor=new TextEncoder().encode(prior).length
  const throughByte=new TextEncoder().encode(body).length
  const write=vi.fn(async()=>{})
  const result=await recoverTerminalRetainedOutput({cursor,throughByte,read:async()=>replay(body,0),write})
  expect(write).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode('后续🙂\r\n'))
  expect(result).toEqual({cursor:throughByte,gap:false,incomplete:false})
  write.mockClear()
  const empty=await recoverTerminalRetainedOutput({cursor,throughByte,read:async()=>({replay:[],gap:null}),write})
  expect(write).not.toHaveBeenCalled()
  expect(empty).toEqual({cursor,gap:false,incomplete:true})
})
