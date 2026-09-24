// @vitest-environment happy-dom
import { agentHistoryMenuEntry, openAgentHistory } from './helpers/agent-history-menu'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot, SessionAttachResult } from '../src/shared/contracts'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
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
  reveal: null as (() => void) | null,
  state: {sessions: [] as SessionSnapshot[],config:{appearance:{terminalTheme:'graphite'},executors:{},workspaces:[]},pendingAgentLaunches:{},recoveryCandidates:[],timelines:{},agentNames:{},viewModes:{},regionCaretFocus:null,clearRegionCaretFocus:vi.fn(),focusRegion:vi.fn(),appendAgentComposerDraft:vi.fn(),refreshSession:vi.fn(),recoverSession:vi.fn(),respondInteraction:vi.fn(),openFile:vi.fn(),reportError:vi.fn(),openHttpLink:vi.fn()}
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
  id:'agent-history-retained',hostId:'local',workspacePath:'/synthetic',label:'Retained',createdAt:1,updatedAt:1,agentSessionUpdatedAt:1,
  processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,
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
function action(text:string){const found=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===text);expect(found).toBeDefined();return found!}
async function terminalReady() {
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({
    regionId: 'region', sessionId: session.id, runId: session.control.run.runId
  })).toMatchObject({ liveReady: true })))
}
function historyEntries() {
  return Array.from(document.querySelectorAll<HTMLElement>('.agent-region-menu [role="menuitem"]')).filter(item => item.textContent?.trim() === 'Conversation history')
}

it.each(['normal', 'alternate', 'Runtime gap', 'retained read failure', 'line boundary'] as const)(
  'keeps one real Session-owned history entry through the %s terminal state', async (state) => {
    const output = state === 'alternate' ? '\x1b[?1049hPrivate full-screen fixture'
      : state === 'line boundary' ? 'line\r\n'.repeat(5_030) : 'Private terminal fixture'
    const dataBytes = new TextEncoder().encode(output)
    const startByte = state === 'Runtime gap' ? 17 : 0
    fixture.attach.mockResolvedValue({ session: { ...session, latestOutputBytes: startByte + dataBytes.length }, attachmentId: 'retained-attachment', currentSize: { cols: 80, rows: 24 },
      terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
      gap: state === 'Runtime gap' ? { requestedAfterByte: 0, firstAvailableByte: startByte } : null,
      replay: [{ type: 'data', runId: session.control.run.runId, startByte, endByte: startByte + dataBytes.length, data: output, dataBytes }] } satisfies SessionAttachResult)
    await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible
      linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }} />))
    await terminalReady()
    expect(fixture.terminals).toHaveLength(1)
    const terminal = fixture.terminals[0]!
    await agentHistoryMenuEntry()
    expect(historyEntries()).toHaveLength(1)
    expect(historyEntries()[0]?.closest('.agent-region-menu')).not.toBeNull()
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
    await agentHistoryMenuEntry()
    expect(historyEntries()).toHaveLength(1)
    expect(historyEntries()[0]?.closest('.agent-region-menu')).not.toBeNull()
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
    await agentHistoryMenuEntry()
    expect(historyEntries()).toHaveLength(1)
    expect(document.querySelector('[aria-label="Conversation history"]')).toBeNull()
    expect(fixture.terminals).toEqual([terminal])
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(fixture.attach).toHaveBeenCalledOnce()
  }
)

it('history open/live output/return keeps the actual xterm parser, Session and healthy input',async()=>{
  await act(async()=>root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'workspace',tabGroupId:'group',tabId:'tab',regionId:'region'}}/>))
  await terminalReady()
  expect(fixture.terminals).toHaveLength(1)
  const terminal=fixture.terminals[0]!
  fixture.resize.mockClear();fixture.write.mockClear();fixture.detach.mockClear()
  await openAgentHistory()
  expect(document.body.textContent).toContain('Persisted conversation entry')
  expect(fixture.historyPage).toHaveBeenCalledExactlyOnceWith(session.control,undefined)
  expect(fixture.write).not.toHaveBeenCalled();expect(fixture.resize).not.toHaveBeenCalled();expect(fixture.detach).not.toHaveBeenCalled()
  const suffix=new Uint8Array([0xb8,0xad,...new TextEncoder().encode('\x1b[31mR\x1b[0m')])
  const endByte=1+suffix.byteLength
  await act(async()=>fixture.receive!({type:'core',hostId:'local',event:{type:'terminal-output',run:session.control.run,
    data:'中\x1b[31mR\x1b[0m',dataBytes:suffix,evidence:{outputByteRange:{startByte:1,endByte}}}} as RuntimeEvent))
  await act(async () => await vi.waitFor(() => expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('中R')))
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('中R')
  expect(terminal.buffer.active.getLine(0)?.getCell(2)?.getFgColor()).toBe(1)
  await act(async()=>action('Terminal').click())
  expect(document.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(fixture.terminals).toEqual([terminal]);expect(terminal.dispose).not.toHaveBeenCalled()
  expect(fixture.attach).toHaveBeenCalledOnce();expect(fixture.detach).not.toHaveBeenCalled();expect(fixture.resize).not.toHaveBeenCalled()
  expect(document.querySelector('[aria-label="Original Agent composer"]')).not.toBeNull()
  await act(async()=>terminal.input('healthy synthetic input',true))
  expect(fixture.write).toHaveBeenCalledExactlyOnceWith(session.control, 'healthy synthetic input', 'user')
})

// Controlled Store input with actual SessionPane/TerminalView/xterm parser. Native focus is the
// observable boundary; the positive selected case proves a missing mount cannot pass the negatives.
it.each(['selected-region', 'retained-origin', 'background-split'] as const)(
  'allows caret focus only for the selected Region: %s through actual SessionPane and TerminalView', async mode => {
    const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
    const foreground = { ...session, id: 'foreground-agent', control: { ...session.control, agentSessionId: 'foreground-agent', run: { runId: 'foreground-run' } } }
    let tab = mode === 'background-split'
      ? createWorkbenchTab('tab', { regionId: 'foreground-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: foreground.id })
      : createWorkbenchTab('tab', { regionId: 'region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: session.id })
    if (mode === 'background-split') {
      tab = addWorkbenchRegion(tab, 'foreground-region', 'right', { regionId: 'region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: session.id })
      tab = { ...tab, layout: { ...tab.layout, activeRegionId: 'foreground-region' } }
    }
    Object.assign(fixture.state, {
      sessions: mode === 'background-split' ? [foreground, session] : [session],
      mainSurface: 'workbench', activeWorkspaceId: 'workspace',
      layouts: { workspace: createWorkspaceLayout('group', ['tab']) }, tabs: { tab },
      retainedSpatialFocus: mode === 'retained-origin'
        ? { workspaceId: 'workspace', tabId: 'tab', regionId: 'moved-origin-region' } : null
    })
    await act(async () => root.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible linkOrigin={origin} />))
    await terminalReady()
    await act(async () => await new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(fixture.terminals).toHaveLength(1)
    expect(fixture.attach).toHaveBeenCalledOnce()
    if (mode === 'selected-region') {
      expect(fixture.focus).toHaveBeenCalledWith(fixture.terminals[0])
      expect(document.activeElement).toBe(fixture.terminals[0]!.element?.querySelector('textarea'))
    } else {
      expect(fixture.focus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(document.body)
    }
  }
)

const caretOrigin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }
function pendingTerminal() {
  return <TerminalView session={session} themeId="graphite" interactiveResize={false} visible autoFocus={false} linkOrigin={caretOrigin} />
}
async function settleCaretFrame() {
  await act(async () => await new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
}

it.each(['inert parking', 'disconnected host'] as const)(
  'retains the exact pending caret until the first mounted terminal leaves %s', async mode => {
    Object.assign(fixture.state, { regionCaretFocus: { regionId: caretOrigin.regionId, nonce: 41 } })
    if (mode === 'inert parking') container.setAttribute('inert', '')
    else container.remove()
    await act(async () => root.render(pendingTerminal()))
    await terminalReady()
    await settleCaretFrame()
    expect(fixture.terminals).toHaveLength(1)
    expect(fixture.attach).toHaveBeenCalledOnce()
    expect(fixture.focus).not.toHaveBeenCalled()
    expect(fixture.state.clearRegionCaretFocus).not.toHaveBeenCalled()
    expect(fixture.state.regionCaretFocus).toEqual({ regionId: caretOrigin.regionId, nonce: 41 })
    await act(async () => {
      if (mode === 'inert parking') container.removeAttribute('inert')
      else document.body.append(container)
    })
    await act(async () => await vi.waitFor(() => expect(fixture.state.clearRegionCaretFocus).toHaveBeenCalledExactlyOnceWith(41)))
    expect(fixture.state.regionCaretFocus).toBeNull()
    expect(document.activeElement).toBe(fixture.terminals[0]!.element?.querySelector('textarea'))
    expect(fixture.attach).toHaveBeenCalledOnce()
  }
)

it('keeps the pending caret when native focus refuses it, then clears only after actual DOM focus', async () => {
  Object.assign(fixture.state, { regionCaretFocus: { regionId: caretOrigin.regionId, nonce: 42 } })
  fixture.nativeFocusAllowed = false
  await act(async () => root.render(pendingTerminal()))
  await terminalReady()
  await settleCaretFrame()
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.focus).toHaveBeenCalledWith(fixture.terminals[0])
  expect(document.activeElement).toBe(document.body)
  expect(fixture.state.clearRegionCaretFocus).not.toHaveBeenCalled()
  expect(fixture.state.regionCaretFocus).toEqual({ regionId: caretOrigin.regionId, nonce: 42 })
  fixture.nativeFocusAllowed = true
  await act(async () => { container.setAttribute('inert', ''); container.removeAttribute('inert') })
  await act(async () => await vi.waitFor(() => expect(fixture.state.clearRegionCaretFocus).toHaveBeenCalledExactlyOnceWith(42)))
  expect(document.activeElement).toBe(fixture.terminals[0]!.element?.querySelector('textarea'))
  expect(fixture.state.regionCaretFocus).toBeNull()
  expect(fixture.attach).toHaveBeenCalledOnce()
})

it('does not let the old pending caret observer consume a newer navigation nonce', async () => {
  container.setAttribute('inert', '')
  Object.assign(fixture.state, { regionCaretFocus: { regionId: caretOrigin.regionId, nonce: 43 } })
  await act(async () => root.render(pendingTerminal()))
  await terminalReady()
  await settleCaretFrame()
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.focus).not.toHaveBeenCalled()
  expect(fixture.state.clearRegionCaretFocus).not.toHaveBeenCalled()
  // Replace the actual Store input without refreshing the mounted effect. Its old callback
  // must dispose; only a render that observes nonce 44 may consume the new navigation.
  Object.assign(fixture.state, { regionCaretFocus: { regionId: caretOrigin.regionId, nonce: 44 } })
  await act(async () => container.removeAttribute('inert'))
  await settleCaretFrame()
  expect(fixture.focus).not.toHaveBeenCalled()
  expect(fixture.state.clearRegionCaretFocus).not.toHaveBeenCalled()
  expect(fixture.state.regionCaretFocus).toEqual({ regionId: caretOrigin.regionId, nonce: 44 })
  await act(async () => root.render(pendingTerminal()))
  await act(async () => await vi.waitFor(() => expect(fixture.state.clearRegionCaretFocus).toHaveBeenCalledExactlyOnceWith(44)))
  expect(fixture.state.regionCaretFocus).toBeNull()
  expect(document.activeElement).toBe(fixture.terminals[0]!.element?.querySelector('textarea'))
  expect(fixture.attach).toHaveBeenCalledOnce()
})
