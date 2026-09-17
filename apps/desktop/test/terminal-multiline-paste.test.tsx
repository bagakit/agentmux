// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { AppConfig, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// The real public xterm parser, paste encoder, onData and DOM paste listeners run here.
// Canvas text measurement/addons and IPC transport are fixtures; there is no PTY/model call.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[] }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} dispose() {} onDidChangeResults() { return { dispose() {} } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { activate() {} dispose() {} onContextLoss() { return { dispose() {} } } } }))
vi.mock('../src/renderer/src/components/TerminalContextMenu', async () => {
  const { createElement } = await import('react')
  return { TerminalContextMenu: ({ children, onPaste }: { children: ReactNode; onPaste: () => void }) =>
    createElement('div', null, children, createElement('button', { onClick: onPaste, 'data-private-menu-paste': true }, 'Paste')) }
})

const ESC = String.fromCharCode(27)
const originalText = `first\nsecond\r\nthird${ESC}[201~`
const sanitizedText = 'first\nsecond\r\nthird␛[201~'
const normalizedText = 'first\rsecond\rthird␛[201~'
const initialState = useAppStore.getState()
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: 'paste-agent', hostId: 'local', workspacePath: '/synthetic', label: 'Paste Agent', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'paste-agent', run: { runId: 'paste-run' } }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'paste-region' }
let root: Root
let container: HTMLDivElement
let config: AppConfig
let attach: MockInstance<typeof api.sessions.attach>
let paste: MockInstance<typeof api.sessions.paste>
let raw: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof api.sessions.recover>

function state(current: SessionSnapshot) {
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: current.kind,
    phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config, closingWorkbenchViews: {}, regionCaretFocus: null, timelines: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], viewModes: {}, agentNames: {} })
}
function snapshot(current: SessionSnapshot): SessionAttachResult {
  const data = 'live private screen'
  // A real retained suffix cannot prove the earlier 2004 mode. Preserve that byte-gap
  // fact instead of supplying the protocol18 terminal representation to protocol17.
  const firstAvailableByte = 64
  return { attachmentId: 'paste-attachment', session: { ...current, latestOutputBytes: firstAvailableByte + data.length },
    currentSize: { cols: 80, rows: 24 }, gap: { requestedAfterByte: 0, firstAvailableByte },
    replay: [{ type: 'data', runId: current.control.run.runId, startByte: firstAvailableByte, endByte: firstAvailableByte + data.length,
      data, dataBytes: new TextEncoder().encode(data) }] }
}
async function render(current: SessionSnapshot, readOnly = false) {
  await act(async () => root.render(createElement(TerminalView, { session: current, readOnly,
    interactiveResize: false, visible: true, autoFocus: false, themeId: config.appearance.terminalTheme, linkOrigin: origin })))
}
async function ready(current: SessionSnapshot = session, readOnly = false) {
  state(current); attach.mockResolvedValue(snapshot(current)); await render(current, readOnly)
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId,
    sessionId: current.id, runId: current.control.run.runId })).toMatchObject({ liveReady: true })))
  expect(fixture.terminals).toHaveLength(1)
  const terminal = fixture.terminals[0]!
  expect(terminal.textarea).toBeInstanceOf(HTMLTextAreaElement)
  const notice = container.querySelector('.terminal-replay-gap')
  expect(notice).toBeInstanceOf(HTMLElement)
  expect(notice!.getAttribute('title') ?? notice!.textContent).toContain('Earlier')
  return terminal
}
async function domPaste(terminal: BrowserTerminal, text = originalText) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? text : '' } })
  await act(async () => { terminal.textarea!.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
}
async function menuPaste() {
  const button = container.querySelector<HTMLButtonElement>('[data-private-menu-paste]')
  expect(button).toBeInstanceOf(HTMLButtonElement)
  await act(async () => { button!.click() })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('OffscreenCanvas', undefined)
  // Only glyph measurement is mocked. xterm's actual open constructs its public textarea,
  // installs its paste listeners and owns encoding; no private Core fields are replaced.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    font: '', measureText: () => ({ width: 8, actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 })
  }) as unknown as CanvasRenderingContext2D)
  attach = vi.spyOn(api.sessions, 'attach')
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  paste = vi.spyOn(api.sessions, 'paste').mockResolvedValue(undefined)
  raw = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  recover = vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'readClipboardText').mockResolvedValue(originalText)
  config = await api.config.get()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  useAppStore.setState(initialState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each([false, true])('routes DOM and menu paste exactly once with real xterm bracketedPasteMode=%s, preserving the original text', async bracketed => {
  const terminal = await ready()
  await act(async () => await new Promise<void>(resolve => terminal.write(`${ESC}[?2004${bracketed ? 'h' : 'l'}`, resolve)))
  expect(terminal.modes.bracketedPasteMode).toBe(bracketed)
  const encoded = bracketed ? `${ESC}[200~${normalizedText}${ESC}[201~` : normalizedText
  await domPaste(terminal)
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, encoded]])
  expect(raw).not.toHaveBeenCalled()
  paste.mockClear()
  await menuPaste()
  expect(api.ui.readClipboardText).toHaveBeenCalledOnce()
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, encoded]])
  expect(raw).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  await act(async () => terminal.input('z'))
  expect(raw.mock.calls).toEqual([[session.control, 'z']])
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, encoded]])
})

it('consumes the paste source before a synchronous callback reenters with an ordinary key', async () => {
  const terminal = await ready()
  expect(terminal.modes.bracketedPasteMode).toBe(false)
  // Only this first callback injects the nested key: a broken consume guard produces a
  // second paste call and a real assertion failure, rather than recursion/stack overflow.
  paste.mockImplementationOnce(async () => { terminal.input('z') })
  await domPaste(terminal)
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, normalizedText]])
  expect(raw.mock.calls).toEqual([[session.control, 'z']])
  await act(async () => terminal.input('q'))
  expect(raw.mock.calls).toEqual([[session.control, 'z'], [session.control, 'q']])
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, normalizedText]])
})

it.each(['read-only', 'permission'] as const)('keeps both paste entrances behind the existing %s input guard', async guard => {
  const current = guard === 'permission' ? { ...session, pendingInteraction: { id: 'private-permission', kind: 'permission' as const,
    agentSessionId: session.id, title: 'Private permission', options: [], evidence: { source: 'native-hook' as const, observedAt: 1 } } } : session
  const terminal = await ready(current, guard === 'read-only')
  await domPaste(terminal); await menuPaste(); await act(async () => terminal.input('z'))
  expect(paste).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  state(session); await render(session)
  await domPaste(terminal)
  expect(fixture.terminals).toEqual([terminal])
  expect(paste.mock.calls).toEqual([[session.control, sanitizedText, normalizedText]])
  expect(raw).not.toHaveBeenCalled()
})
