// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import type { RuntimeEvent, AppConfig, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'
import { terminalOptions, terminalTheme } from '../src/renderer/src/lib/terminal-theme'

// Real xterm parser/buffers/modes and product SessionPane/TerminalView/reader/Store.
// DOM paint/addons and delivery to xterm's public custom-wheel callback are fixture boundaries;
// the separate Native gate owns actual Chromium wheel delivery and Provider helper transport.
const fixture = vi.hoisted(() => ({
  terminals: [] as BrowserTerminal[],
  handlers: [] as Array<{ terminal: BrowserTerminal; handle: (event: WheelEvent) => boolean }>,
  wheelResults: [] as boolean[], focus: vi.fn()
}))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    open(root: HTMLElement) {
      this.element = document.createElement('div'); this.element.dataset.privateWheelSurface = 'true'; root.append(this.element)
      this.element.addEventListener('wheel', event => {
        const handler = fixture.handlers.find(entry => entry.terminal === this)?.handle
        if (handler) fixture.wheelResults.push(handler(event))
      })
    }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
      super.attachCustomWheelEventHandler(handler); fixture.handlers.push({ terminal: this, handle: handler })
    }
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
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {} endReplay() {} acceptOwnerSize() {} setInteractiveResize() {} setVisible() {} observeViewport() {}
  async startLiveSynchronization() {} dispose() {}
} }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({ TerminalContextMenu: ({ children }: { children: ReactNode }) => children }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => createElement('textarea', { 'aria-label': 'Private composer' }) }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))

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
const lines = Array.from({ length: 100 }, (_, i) => `private-${i}\r\n`).join('')
let root: Root
let container: HTMLDivElement
let attach: MockInstance<typeof api.sessions.attach>
let history: MockInstance<typeof api.sessions.historyPage>
let write: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof api.sessions.recover>
let resize: MockInstance<typeof api.sessions.resize>
let configuration: AppConfig
function state(current: SessionSnapshot = session) {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: current.kind, phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config: configuration, closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: {}, agentNames: {} })
}
function replay(data: string, current: SessionSnapshot = session): SessionAttachResult {
  return { attachmentId: 'wheel-attachment', session: current, currentSize: { cols: 80, rows: 24 }, gap: null,
    replay: [{ type: 'data', runId: current.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
function page(id: string, nextCursor: string | null): AgentSessionHistoryPage {
  return { agentSessionId: session.id, source: { providerId: 'codex', nativeSessionId: 'private-native-records' },
    items: [{ id, kind: 'assistant-message', contentParts: [{ kind: 'text', text: `Private record ${id}` }] }], nextCursor }
}
async function render(current: SessionSnapshot = session, readOnly = false, visible = true) {
  await act(async () => root.render(createElement(SessionPane, { sessionId: current.id, surfaceKind: current.kind,
    interactiveResize: false, visible, readOnly, linkOrigin: origin })))
}
async function ready(data = repaint, current: SessionSnapshot = session, readOnly = false) {
  state(current); attach.mockResolvedValue(replay(data, current)); await render(current, readOnly)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: current.id, runId: current.control.run.runId})).toMatchObject({liveReady:true})))
  expect(fixture.terminals).toHaveLength(1); return fixture.terminals[0]!
}
async function wheel(init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, ...init })
  // happy-dom WheelEvent does not implement MouseEvent modifier fields; supply the standard fields.
  for (const key of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? false })
  const terminal = fixture.terminals.at(-1)!
  expect(terminal.element).toBeDefined()
  await act(async () => terminal.element!.dispatchEvent(event))
  return event
}
function button(text: string) {
  const result = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === text)
  expect(result, `reachable ${text}`).toBeDefined(); return result!
}
async function parser(terminal: BrowserTerminal, text: string) {
  await act(async () => await new Promise<void>(resolve => terminal.write(text, resolve)))
}
function noExecution() { expect(write).not.toHaveBeenCalled(); expect(resize).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled() }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0; fixture.handlers.length = 0; fixture.wheelResults.length = 0; fixture.focus.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(repaint))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation((_receive: (event: RuntimeEvent) => void) => () => {})
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  resize = vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  recover = vi.spyOn(api.sessions, 'recover')
  history = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page('latest', 'older-page'))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  configuration = await api.config.get()
  state(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps an active zero-history repaint in its actual Terminal without automatic record navigation', async () => {
  const terminal = await ready()
  expect(terminal.buffer.active.baseY).toBe(0); expect(terminal.buffer.active.length).toBe(24)
  const event = await wheel()
  expect(event.defaultPrevented).toBe(false); expect(fixture.handlers).toEqual([])
  expect(history).not.toHaveBeenCalled()
  expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(fixture.terminals).toEqual([terminal]); expect(attach).toHaveBeenCalledTimes(1); noExecution()
})

it('leaves actual retained scrollback and every wheel gesture with the library, even at the local top', async () => {
  const terminal = await ready(lines)
  expect(terminal.buffer.active.baseY).toBeGreaterThan(0)
  terminal.scrollToLine(20)
  expect((await wheel()).defaultPrevented).toBe(false); expect(terminal.buffer.active.viewportY).toBe(20)
  terminal.scrollToTop()
  const gestures: WheelEventInit[] = [{}, { deltaY: 120 }, { deltaY: 0 }, { deltaX: 1 }, { deltaZ: 1 },
    { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]
  for (const gesture of gestures) expect((await wheel(gesture)).defaultPrevented, JSON.stringify(gesture)).toBe(false)
  expect(fixture.handlers).toEqual([]); expect(history).not.toHaveBeenCalled(); noExecution()
})

it('keeps alternate and mouse modes on the real library route without automatic Provider reads', async () => {
  const terminal = await ready('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
  expect(terminal.buffer.active.type).toBe('alternate'); expect(terminal.modes.mouseTrackingMode).toBe('vt200')
  await wheel(); await parser(terminal, '\x1b[?1000l'); await wheel()
  await parser(terminal, '\x1b[?1049l\x1b[?1003h'); await wheel()
  await parser(terminal, '\x1b[?1003l'); expect((await wheel()).defaultPrevented).toBe(false)
  expect(fixture.handlers).toEqual([]); expect(history).not.toHaveBeenCalled(); noExecution()
})

it('keeps readOnly and pending-interaction active views in Terminal while replay finishes', async () => {
  let release!: (value: SessionAttachResult) => void
  attach.mockReturnValue(new Promise(resolve => { release = resolve }))
  const pending: typeof session = { ...session, pendingInteraction: { id: 'private-permission', kind: 'permission', agentSessionId: session.id,
    title: 'Private permission', options: [], evidence: { source: 'native-hook', observedAt: 1 } } }
  state(pending); await render(pending, true)
  expect((await wheel()).defaultPrevented).toBe(false)
  await act(async () => release(replay(repaint, pending)))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: pending.id, runId: pending.control.run.runId})).toMatchObject({liveReady:true})))
  expect((await wheel()).defaultPrevented).toBe(false)
  expect(history).not.toHaveBeenCalled(); expect(fixture.terminals).toHaveLength(1); noExecution()
})

function cold(): typeof session {
  const enteredAt = Date.now() - 3600001
  return { ...session, processState: 'exited', status: { state: 'exited', source: 'run-process', observedAt: Date.now() },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: enteredAt } }
}

it('uses the proven long-idle nonrunning policy for inline records with shared terminal appearance and the original composer', async () => {
  const dormant = cold(); state(dormant)
  await render(dormant)
  const reader = container.querySelector<HTMLElement>('[aria-label="Conversation history"]')!
  expect(reader).not.toBeNull(); expect(reader.classList.contains('session-history--inline')).toBe(true)
  expect(history).toHaveBeenCalledExactlyOnceWith(dormant.control, undefined)
  expect(container.textContent).toContain('Private record latest'); expect(container.textContent).toContain('Idle for over an hour')
  expect(container.querySelector('[aria-label="Private composer"]')).not.toBeNull()
  expect(Array.from(container.querySelectorAll('button'), b => b.textContent?.trim())).not.toContain('Session')
  expect(fixture.terminals).toEqual([]); expect(attach).not.toHaveBeenCalled(); noExecution()
  expect(reader.style.backgroundColor).toBe(terminalTheme(configuration.appearance.terminalTheme).background)
  const expectedFont = document.createElement('div')
  expectedFont.style.fontFamily = terminalOptions(configuration.appearance.terminalTheme).fontFamily!
  expect(expectedFont.style.fontFamily.length).toBeGreaterThan(0)
  expect(reader.style.fontFamily).toBe(expectedFont.style.fontFamily)
  expect(reader.style.fontSize).toBe(String(terminalOptions(configuration.appearance.terminalTheme).fontSize) + 'px')
  expect(reader.style.lineHeight).toBe(String(terminalOptions(configuration.appearance.terminalTheme).lineHeight))
  const alternative = { ...configuration, appearance: { ...configuration.appearance, terminalTheme: 'catppuccin-mocha' as const, terminalFontSize: 15 } }
  await act(async () => useAppStore.setState({ config: alternative }))
  expect(container.querySelector('[aria-label="Conversation history"]')).toBe(reader)
  expect(reader.style.backgroundColor).toBe(terminalTheme('catppuccin-mocha').background); expect(reader.style.fontSize).toBe('15px')
  expect(reader.style.getPropertyValue('--history-selection-background')).toBe(terminalTheme('catppuccin-mocha').selectionBackground)
  expect(history).toHaveBeenCalledTimes(1)
  await act(async () => reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[aria-label="Conversation history"]')).toBe(reader); noExecution()
})

it('retains the same already-read inline viewport and position through hidden/show without a fresh read', async () => {
  const dormant = cold(); state(dormant); await render(dormant)
  const reader = container.querySelector<HTMLElement>('[aria-label="Conversation history"]')!
  const viewport = reader.querySelector<HTMLElement>('[aria-label="Native conversation records"]')!
  expect(viewport).not.toBeNull(); viewport.scrollTop = 127
  await render(dormant, false, false)
  expect(reader.hidden).toBe(true); expect(history).toHaveBeenCalledTimes(1)
  await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })))
  expect(history).toHaveBeenCalledTimes(1)
  await render(dormant)
  expect(reader.hidden).toBe(false); expect(container.querySelector('[aria-label="Conversation history"]')).toBe(reader)
  expect(viewport.scrollTop).toBe(127); expect(history).toHaveBeenCalledTimes(1); noExecution()
})

it('does not read a hidden cold Region until it first becomes visible', async () => {
  const dormant = cold(); state(dormant); await render(dormant, false, false)
  expect(history).not.toHaveBeenCalled(); expect(fixture.terminals).toEqual([])
  await render(dormant)
  expect(history).toHaveBeenCalledExactlyOnceWith(dormant.control, undefined); noExecution()
})

it('does not call unknown, unverified, recent or non-done state long idle', async () => {
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now)
  const dormant = cold()
  const unknown = { ...dormant }; delete unknown.semanticStatus
  const inputs: Array<{ current: typeof session; warning?: boolean }> = [
    { current: unknown },
    { current: dormant, warning: true },
    { current: { ...dormant, semanticStatus: { ...dormant.semanticStatus!, stateEnteredAt: now - 3600000 } } },
    { current: { ...dormant, semanticStatus: { ...dormant.semanticStatus!, stateEnteredAt: Date.now() + 3600000 } } },
    { current: { ...dormant, semanticStatus: { ...dormant.semanticStatus!, state: 'working' } } }
  ]
  expect(inputs).toHaveLength(5)
  for (const { current, warning } of inputs) {
    await act(async () => { state(current)
      if (warning) useAppStore.setState({ runtimeOwnershipWarnings: ['local'] }) })
    await render(current)
    expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
    expect(container.textContent).toContain('Ready to restore')
    expect(Array.from(container.querySelectorAll('button'), b => b.textContent?.trim())).toContain('Conversation history')
  }
  expect(history).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); noExecution()
})

it('gives a healthy running Run precedence over its old idle epoch and rejects a late cold page', async () => {
  let resolve!: (value: AgentSessionHistoryPage) => void
  history.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>(done => { resolve = done }))
  const dormant = cold(); state(dormant); await render(dormant)
  expect(history).toHaveBeenCalledExactlyOnceWith(dormant.control, undefined)
  const live: typeof session = { ...dormant, processState: 'running', control: { ...dormant.control, run: { runId: 'fresh-run' } }, status: session.status }
  attach.mockResolvedValue(replay(repaint, live))
  await act(async () => useAppStore.setState({ sessions: [live] }))
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({regionId: origin.regionId, sessionId: live.id, runId: live.control.run.runId})).toMatchObject({liveReady:true})))
  await act(async () => resolve(page('late-cold', 'late-cursor')))
  expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(container.textContent).not.toContain('late-cold'); expect(fixture.terminals).toHaveLength(1)
  expect((await wheel()).defaultPrevented).toBe(false); expect(history).toHaveBeenCalledTimes(1); noExecution()
})

it('keeps a failed inline reader beside the draft and restore action without executing', async () => {
  history.mockRejectedValue(new Error('Private native reader unavailable'))
  const dormant = cold(); state(dormant); await render(dormant)
  expect(container.textContent).toContain('History read failed: Private native reader unavailable')
  expect(container.querySelector('[aria-label="Private composer"]')).not.toBeNull()
  expect(Array.from(container.querySelectorAll('button'), b => b.textContent?.trim())).toContain('Resume')
  expect(fixture.terminals).toEqual([]); expect(attach).not.toHaveBeenCalled(); noExecution()
})

it('keeps explicit records reachable for active Agents and returns to the original Terminal', async () => {
  const terminal = await ready()
  await act(async () => button('Conversation history').click())
  expect(history).toHaveBeenCalledExactlyOnceWith(session.control, undefined)
  expect(container.textContent).toContain('Private record latest')
  await act(async () => button('Terminal').click())
  expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
  expect(fixture.terminals).toEqual([terminal]); expect(attach).toHaveBeenCalledTimes(1); noExecution()
})

it('does not offer Agent records for an ordinary Terminal', async () => {
  const terminal: Extract<SessionSnapshot, { kind: 'terminal' }> = { ...session, kind: 'terminal', providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: session.control.run.runId, run: session.control.run } }
  await ready(repaint, terminal)
  expect((await wheel()).defaultPrevented).toBe(false); expect(fixture.handlers).toEqual([])
  expect(history).not.toHaveBeenCalled(); noExecution()
})
