// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { SessionPane } from '../src/renderer/src/components/SessionPane'

type FixtureTerminal = BrowserTerminal & {
  refresh: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  written: string[]
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
  attach: vi.fn(), replay: vi.fn(), historyPage: vi.fn(), write: vi.fn(), resize: vi.fn(), redraw: vi.fn(),
  detach: vi.fn(),
  acknowledge: vi.fn(),
  unsubscribe: vi.fn(),
  blockFirstWrite: false,
  releaseWrite: null as (() => void) | null,
  reveal: null as (() => void) | null,
  state: {sessions: [] as SessionSnapshot[],config:{appearance:{terminalTheme:'graphite'},executors:{},workspaces:[]},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null,clearRegionCaretFocus:vi.fn(),appendAgentComposerDraft:vi.fn(),refreshSession:vi.fn(),recoverSession:vi.fn(),respondInteraction:vi.fn(),openFile:vi.fn(),reportError:vi.fn(),openHttpLink:vi.fn()}
}))

vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    refresh = vi.fn()
    written: string[] = []
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      this.dispose = vi.fn(() => super.dispose())
      fixture.terminals.push(this as unknown as FixtureTerminal)
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      super.write(data, () => {
        if (fixture.blockFirstWrite) {
          fixture.blockFirstWrite = false
          fixture.releaseWrite = () => callback?.()
        } else callback?.()
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
  attach: fixture.attach, replay: fixture.replay, historyPage: fixture.historyPage, write: fixture.write, resize: fixture.resize,
  detach: fixture.detach,
  acknowledge: fixture.acknowledge,
  onEvent: (receive: (event: RuntimeEvent) => void) => {
    fixture.receive = receive
    return fixture.unsubscribe
  }
} } }))
vi.mock('../src/renderer/src/store', () => ({useAppStore: Object.assign(
  (select: (state: typeof fixture.state) => unknown) => select(fixture.state), {getState:()=>fixture.state}
)}))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({AgentSessionComposer:()=> <textarea aria-label="Original Agent composer"/>}))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({SessionResultReview:()=>null}))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ActivityView:()=> <div>Captured Activity</div>}))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({
  TerminalViewportSynchronizer: class {
    beginReplay() {}
    endReplay() {}
    acceptOwnerSize() {}
    setInteractiveResize() {}
    setVisible() {}
    observeViewport() {}
    async startLiveSynchronization() {}
    async requestContentRedraw() { return await fixture.redraw() }
    dispose() {}
  }
}))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))

const session: SessionSnapshot = {
  id:'agent-history-retained',hostId:'local',workspacePath:'/synthetic',label:'Retained',createdAt:1,updatedAt:1,
  processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,
  kind:'agent',providerId:'codex',executorId:'codex',
  capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},
  control:{kind:'agent',hostId:'local',agentSessionId:'agent-history-retained',run:{runId:'run-history-retained'}}
}
let root:Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.clearAllMocks();fixture.terminals.length=0;fixture.webgl.length=0;fixture.receive=null
  fixture.blockFirstWrite=false;fixture.releaseWrite=null;fixture.state.sessions=[session]
  fixture.attach.mockResolvedValue({attachmentId:'retained-attachment',currentSize:{cols:80,rows:24},gap:null,
    replay:[{startByte:0,endByte:1,data:'',dataBytes:new Uint8Array([0xe4])}]})
  fixture.historyPage.mockResolvedValue({agentSessionId:session.id,source:{providerId:'codex',nativeSessionId:'native-main'},
    items:[{id:'history-entry',kind:'assistant-message',contentParts:[{kind:'text',text:'Persisted conversation entry'}]}],nextCursor:null})
  fixture.acknowledge.mockResolvedValue(undefined);fixture.detach.mockResolvedValue(undefined);fixture.write.mockResolvedValue(undefined)
  fixture.redraw.mockResolvedValue(true)
  const container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals()})
function action(text:string){const found=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===text);expect(found).toBeDefined();return found!}
function historyEntries() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(item => item.textContent?.trim() === 'Conversation history')
}

it.each(['normal', 'alternate', 'Runtime gap', 'retained read failure', 'line boundary'] as const)(
  'keeps one real Session-owned history entry through the %s terminal state', async (state) => {
    const output = state === 'alternate' ? '\x1b[?1049hPrivate full-screen fixture'
      : state === 'line boundary' ? 'line\r\n'.repeat(5_030) : 'Private terminal fixture'
    const dataBytes = new TextEncoder().encode(output)
    const startByte = state === 'Runtime gap' ? 17 : 0
    fixture.attach.mockResolvedValue({ attachmentId: 'retained-attachment', currentSize: { cols: 80, rows: 24 },
      gap: state === 'Runtime gap' ? { requestedAfterByte: 0, firstAvailableByte: startByte } : null,
      replay: [{ startByte, endByte: startByte + dataBytes.length, data: output, dataBytes }] })
    await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />))
    await act(async () => await vi.waitFor(() => expect(fixture.acknowledge).toHaveBeenCalledWith(session.control, startByte + dataBytes.length)))
    expect(fixture.terminals).toHaveLength(1)
    const terminal = fixture.terminals[0]!
    expect(historyEntries()).toHaveLength(1)
    expect(historyEntries()[0]?.classList.contains('terminal-history-action')).toBe(true)
    if (state === 'retained read failure') {
      fixture.replay.mockResolvedValue({ run: session.control.run, replay: [], gap: null })
      const later = new TextEncoder().encode('Later live output')
      const startByte = dataBytes.length + 10, endByte = startByte + later.length
      await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { type: 'terminal-output', run: session.control.run,
        data: 'Later live output', dataBytes: later, evidence: { source: 'terminal-output', observedAt: 2, run: session.control.run,
          outputByteRange: { startByte, endByte } } } }))
      await act(async () => await vi.waitFor(() => expect(fixture.replay).toHaveBeenCalledExactlyOnceWith('retained-attachment', dataBytes.length)))
      await act(async () => await vi.waitFor(() => expect(document.body.textContent).toContain('Retained history could not be read')))
      expect(document.body.textContent).toContain('Live input remains available')
    } else if (state === 'alternate') {
      expect(terminal.buffer.active.type).toBe('alternate')
      expect(document.querySelector('.terminal-replay-gap--compact')?.textContent).toContain('Full-screen history')
    } else if (state === 'line boundary') {
      expect(terminal.buffer.active.length).toBe(terminal.rows + terminal.options.scrollback!)
      expect(document.querySelector('.terminal-replay-gap--compact')?.textContent).toContain('History line limit')
    } else if (state === 'Runtime gap') {
      expect(document.querySelector('.terminal-replay-gap')?.textContent).toContain('Earlier scrollback is unavailable')
      const redraw = document.querySelector<HTMLButtonElement>('[aria-label="Redraw current terminal screen"]')
      expect(redraw).not.toBeNull()
      const before = fixture.redraw.mock.calls.length
      await act(async () => redraw!.click())
      expect(fixture.redraw).toHaveBeenCalledTimes(before + 1)
      expect(document.querySelector('.terminal-replay-gap')?.getAttribute('title')).toContain('missing history')
    } else {
      expect(document.querySelector('.terminal-replay-gap')).toBeNull()
    }
    expect(historyEntries()).toHaveLength(1)
    expect(historyEntries()[0]?.classList.contains('terminal-history-action')).toBe(true)
    expect(fixture.historyPage).not.toHaveBeenCalled()
    fixture.write.mockClear(); fixture.resize.mockClear(); fixture.detach.mockClear()
    await act(async () => historyEntries()[0]!.click())
    expect(historyEntries()).toEqual([])
    expect(fixture.historyPage).toHaveBeenCalledExactlyOnceWith(session.control, undefined)
    expect(document.body.textContent).toContain('Persisted conversation entry')
    expect(fixture.terminals).toEqual([terminal])
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(fixture.write).not.toHaveBeenCalled(); expect(fixture.resize).not.toHaveBeenCalled(); expect(fixture.detach).not.toHaveBeenCalled()
    await act(async () => action('Terminal').click())
    expect(historyEntries()).toHaveLength(1)
    expect(document.querySelector('[aria-label="Conversation history"]')).toBeNull()
    expect(fixture.terminals).toEqual([terminal])
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(fixture.attach).toHaveBeenCalledOnce()
  }
)

it('history open/live output/return keeps the actual xterm parser, Session and healthy input',async()=>{
  await act(async()=>root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}}/>))
  await act(async()=>await vi.waitFor(()=>expect(fixture.acknowledge).toHaveBeenCalledWith(session.control,1)))
  expect(fixture.terminals).toHaveLength(1)
  const terminal=fixture.terminals[0]!
  fixture.resize.mockClear();fixture.write.mockClear();fixture.detach.mockClear();fixture.acknowledge.mockClear()
  await act(async()=>action('Conversation history').click())
  expect(document.body.textContent).toContain('Persisted conversation entry')
  expect(fixture.historyPage).toHaveBeenCalledExactlyOnceWith(session.control,undefined)
  expect(fixture.write).not.toHaveBeenCalled();expect(fixture.resize).not.toHaveBeenCalled();expect(fixture.detach).not.toHaveBeenCalled()
  expect(fixture.acknowledge).not.toHaveBeenCalled()
  const suffix=new Uint8Array([0xb8,0xad,...new TextEncoder().encode('\x1b[31mR\x1b[0m')])
  const endByte=1+suffix.byteLength
  await act(async()=>fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-output',run:session.control.run,
    data:'中\x1b[31mR\x1b[0m',dataBytes:suffix,evidence:{outputByteRange:{startByte:1,endByte}}}} as RuntimeEvent))
  await act(async()=>await vi.waitFor(()=>expect(fixture.acknowledge).toHaveBeenCalledWith(session.control,endByte)))
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('中R')
  expect(terminal.buffer.active.getLine(0)?.getCell(2)?.getFgColor()).toBe(1)
  await act(async()=>action('Terminal').click())
  expect(document.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(fixture.terminals).toEqual([terminal]);expect(terminal.dispose).not.toHaveBeenCalled()
  expect(fixture.attach).toHaveBeenCalledOnce();expect(fixture.detach).not.toHaveBeenCalled();expect(fixture.resize).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Original Agent composer"]')).not.toBeNull()
  await act(async()=>terminal.input('healthy synthetic input',true))
  expect(fixture.write).toHaveBeenCalledWith(session.control,expect.stringContaining('healthy synthetic input'))
})
