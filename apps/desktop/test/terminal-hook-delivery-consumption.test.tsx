import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot, SessionAttachResult } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

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
  attach: vi.fn(), replay: vi.fn(), historyPage: vi.fn(), write: vi.fn(), resize: vi.fn(), redraw: vi.fn(), focus: vi.fn(),
  detach: vi.fn(),
  unsubscribe: vi.fn(),
  blockFirstWrite: false,
  nativeFocusAllowed: true,
  releaseWrite: null as (() => void) | null,
  menuHistoryBoundary: null as string | null,
  reveal: null as (() => void) | null,
  state: {noticeReadReceipts:{},sessions: [] as SessionSnapshot[],config:{appearance:{terminalTheme:'graphite'},executors:{},workspaces:[],hosts:[]},sessionNameMetadata:{},agentSteerQueues:{},capsuleQuestionEditors:{},localHome:'',demands:{},spaceZoneBindings:{},spatialRequests:{},scratchTopicSnapshots:{},runtimeEndpointWarnings:[],notificationEvents:[],continuityControlIntents:{},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null,clearRegionCaretFocus:vi.fn(),focusRegion:vi.fn(),appendAgentComposerDraft:vi.fn(),refreshSession:vi.fn(),recoverSession:vi.fn(),respondInteraction:vi.fn(),openFile:vi.fn(),reportError:vi.fn(),openHttpLink:vi.fn()}
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
    open(root: HTMLElement) {
      this.element = document.createElement('div')
      this.element.append(document.createElement('textarea'))
      root.append(this.element)
    }
    focus() {
      fixture.focus(this)
      if (fixture.nativeFocusAllowed) this.element?.querySelector('textarea')?.focus()
    }
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
  onEvent: (receive: (event: RuntimeEvent) => void) => {
    fixture.receive = receive
    return fixture.unsubscribe
  }
} } }))
vi.mock('../src/renderer/src/store', () => ({useAppStore: Object.assign(
  (select: (state: typeof fixture.state) => unknown) => select(fixture.state), {getState:()=>fixture.state,subscribe:()=>()=>{},setState:(update:Partial<typeof fixture.state>|((value:typeof fixture.state)=>Partial<typeof fixture.state>))=>Object.assign(fixture.state,typeof update==='function'?update(fixture.state):update)}
), compareAndSwapCapsuleQuestionEditor: vi.fn(), flushCapsuleQuestionEditors: vi.fn(),
  currentCoreSpatialGraph: () => null, agentRegionExecution: () => null, lifecycleNotification: () => undefined}))
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
  TerminalContextMenu: ({ children, historyBoundary }: { children: ReactNode; historyBoundary: string | null }) => {
    fixture.menuHistoryBoundary = historyBoundary
    return children
  }
}))

const session: SessionSnapshot = {
  id:'agent-history-retained',hostId:'local',workspacePath:_hygiene_fixturePath("synthetic"),label:'Retained',createdAt:_tailFixtureEpoch(0, 0, 1),updatedAt:_tailFixtureEpoch(0, 0, 1),agentSessionUpdatedAt:_tailFixtureEpoch(0, 0, 1),
  processState:'running',status:{state:'running',source:'run-process',observedAt:_tailFixtureEpoch(0, 0, 1)},latestOutputBytes:0,
  kind:'agent',providerId:'codex',executorId:'codex',
  capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},
  control:{kind:'agent',hostId:'local',agentSessionId:'agent-history-retained',run:{runId:'run-history-retained'}}
}
let root:Root
let container:HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.clearAllMocks();fixture.terminals.length=0;fixture.webgl.length=0;fixture.receive=null
  fixture.blockFirstWrite=false;fixture.releaseWrite=null;fixture.nativeFocusAllowed=true;fixture.state.sessions=[session]
  fixture.state.noticeReadReceipts = {}
  Object.assign(fixture.state, { mainSurface: 'board', activeWorkspaceId: undefined, layouts: {}, tabs: {}, retainedSpatialFocus: null, regionCaretFocus: null })
  fixture.state.clearRegionCaretFocus.mockImplementation((nonce: number) => {
    const request = fixture.state.regionCaretFocus as { regionId: string; nonce: number } | null
    if (request?.nonce === nonce) Object.assign(fixture.state, { regionCaretFocus: null })
  })
  fixture.attach.mockResolvedValue({session: { ...session, latestOutputBytes: 1 }, attachmentId:'retained-attachment',currentSize:{cols:80,rows:24},gap:null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay:[{type: 'data', runId: session.control.run.runId, startByte:0,endByte:1,data:'',dataBytes:new Uint8Array([0xe4])}]} satisfies SessionAttachResult)
  fixture.historyPage.mockResolvedValue({agentSessionId:session.id,source:{providerId:'codex',nativeSessionId:'native-main'},
    items:[{id:'history-entry',kind:'assistant-message',contentParts:[{kind:'text',text:'Persisted conversation entry'}]}],nextCursor:null})
  fixture.detach.mockResolvedValue(undefined);fixture.write.mockResolvedValue(undefined)
  fixture.redraw.mockResolvedValue(true)
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals()})
const caretOrigin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
async function terminalReady() {
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({
    regionId: 'region', sessionId: session.id, runId: session.control.run.runId
  })).toMatchObject({ liveReady: true })))
}

it('keeps the real TerminalView and input while one Hook delivery notice repeats, escalates and clears', async () => {
  const loss = (accepted: false | 'unknown', code: string, since = _tailFixtureEpoch(0, 0, 1)): SessionSnapshot => ({ ...session,
    hookDeliveryObservation: { run: session.control.run, since, accepted, code } })
  const render = async (value: SessionSnapshot) => {
    await act(async () => root.render(<TerminalView session={value} themeId="graphite" interactiveResize={false}
      visible autoFocus={false} linkOrigin={caretOrigin} />))
  }
  const notice = () => container.querySelector<HTMLElement>('.terminal-service-window')!
  const collapse = async () => {
    const button = notice().querySelector<HTMLButtonElement>('button[aria-label^="Collapse service notice:"]')
    expect(button).not.toBeNull()
    await act(async () => button!.click())
  }
  await render(loss(false, 'HOOK_DELIVERY_BACKPRESSURE'))
  await terminalReady()
  expect(fixture.terminals).toHaveLength(1)
  const terminal = fixture.terminals[0]!
  expect(notice().textContent).toContain('Native Hook observations (HOOK_DELIVERY_BACKPRESSURE)')
  expect(notice().textContent).toContain('Recent Hook observations were refused before AgentMux processed them')
  expect(notice().textContent).toContain('This clears when the next Hook observation from this Run is delivered.')
  expect(notice().dataset.unread).toBe('true')
  await collapse()
  await render(loss(false, 'HOOK_DELIVERY_BACKPRESSURE'))
  expect(notice().dataset.unread, 'the same loss stays acknowledged').toBe('false')
  await render(loss('unknown', 'HOOK_DELIVERY_TIMEOUT'))
  expect(notice().textContent).toContain('Whether AgentMux recorded a recent Hook observation is unconfirmed')
  expect(notice().dataset.unread, 'owner uncertainty re-raises the existing loss').toBe('true')
  await collapse()
  await render(loss('unknown', 'HOOK_DELIVERY_TIMEOUT'))
  expect(notice().dataset.unread).toBe('false')
  // A new episode carries the same cause but a new owner occurrence, even if no clear was rendered.
  await render(loss('unknown', 'HOOK_DELIVERY_TIMEOUT', _tailFixtureEpoch(0, 0, 2)))
  expect(notice().dataset.unread).toBe('true')
  const suffix = new Uint8Array([0xb8, 0xad, ...new TextEncoder().encode(' original output')])
  await act(async () => fixture.receive!({ type: 'core', hostId: 'local', event: { type: 'terminal-output', run: session.control.run,
    dataBytes: suffix, evidence: { outputByteRange: { startByte: 1, endByte: 1 + suffix.length } } } } as RuntimeEvent))
  await act(async () => await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('中 original output')))
  fixture.write.mockClear()
  await act(async () => terminal.input('original healthy input', true))
  expect(fixture.write).toHaveBeenCalledExactlyOnceWith(session.control, 'original healthy input', 'user',
    { source: 'user', observerId: expect.any(String), sequence: 1 })
  await render(session)
  expect(container.textContent).not.toContain('Native Hook observations')
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.attach).toHaveBeenCalledOnce()
  expect(fixture.detach).not.toHaveBeenCalled()
  expect(terminal.dispose).not.toHaveBeenCalled()
})
