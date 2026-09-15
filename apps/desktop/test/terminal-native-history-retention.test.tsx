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
  attach: vi.fn(), historyPage: vi.fn(), write: vi.fn(), resize: vi.fn(),
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
  attach: fixture.attach, historyPage: fixture.historyPage, write: fixture.write, resize: fixture.resize,
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
  const container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals()})
function action(text:string){const found=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===text);expect(found).toBeDefined();return found!}

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
