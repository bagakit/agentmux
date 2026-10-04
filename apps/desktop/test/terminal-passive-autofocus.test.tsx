const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'

// Native parser, buffers, modes and viewport methods are real; DOM paint/addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    open(root: HTMLElement) { this.element = document.createElement('div'); const input = document.createElement('textarea'); input.className = 'xterm-helper-textarea'; this.element.append(input); root.append(this.element) }
    refresh() {}
    focus() { this.element?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }
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

const originalState = useAppStore.getState()
const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  id: 'observed-agent', hostId: 'local', workspacePath: _hygiene_fixturePath("synthetic"), label: 'Observed', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: 1, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'observed-agent', run: { runId: 'observed-run' } }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'observed-region' }
let root: Root
let releases: (() => void)[]
let attach: MockInstance<typeof api.sessions.attach>
let write: MockInstance<typeof api.sessions.write>

function surfaceState(current: SessionSnapshot = session, regionId = origin.regionId) {
  const tab = createWorkbenchTab(origin.tabId, { regionId, kind: current.kind, phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config: null, closingWorkbenchViews: {}, regionCaretFocus: null })
}
function replay(data: string): SessionAttachResult {
  return { attachmentId: 'observed-attachment', session, currentSize: { cols: 80, rows: 24 }, gap: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
const lines = Array.from({ length: 600 }, (_, i) => `private-${i}\r\n`).join('')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0; fixture.receive = null; releases = []
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(lines))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(receive => { fixture.receive = receive; return () => { fixture.receive = null } })
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  surfaceState()
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  releases.forEach(release => release())
  useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})


const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0, completeAttach: (result: SessionAttachResult) => void
let submit: ReturnType<typeof vi.fn>
let composer: HTMLElement
async function mountFocusSurface() {
  attach.mockImplementation(() => new Promise<SessionAttachResult>(resolve => { completeAttach = resolve }))
  submit = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  await act(async () => root.render(createElement('div', null,
    createElement(TerminalView, { session, themeId: 'graphite', interactiveResize: false, visible: true,
      autoFocus: true, linkOrigin: origin }),
    createElement(AgentComposer, { value: 'Original draft', disabled: false, placeholder: 'Message Agent',
      onChange: () => {}, onSubmit: submit }))))
  composer = document.querySelector<HTMLElement>('[contenteditable="true"]')!
  expect(composer).not.toBeNull()
  expect(composer.textContent).toBe('Original draft')
  expect(fixture.terminals).toHaveLength(1)
}
async function runFrames() {
  const current = [...frames]; frames.clear()
  await act(async () => { current.forEach(([, callback]) => callback(1)) })
}
function activeKey() {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
}
afterEach(() => { frames.clear(); nextFrame = 0 })
it('initial terminal autofocus remains available with no active editable owner', async () => {
  await mountFocusSurface()
  expect(document.activeElement).toBe(document.body)
  await runFrames()
  expect(document.activeElement).toBe(fixture.terminals[0]!.element!.querySelector('textarea'))
  expect(write).not.toHaveBeenCalled()
})
it('a pending attach animation frame preserves an already-focused actual Composer editor', async () => {
  await mountFocusSurface()
  composer.focus()
  expect(document.activeElement).toBe(composer)
  await runFrames()
  expect.soft(document.activeElement).toBe(composer)
  await act(async () => activeKey())
  expect.soft(submit).toHaveBeenCalledTimes(1)
  expect(composer.textContent).toBe('Original draft')
  expect(write).not.toHaveBeenCalled()
})
it('late attach hydration reveal preserves the focused actual Composer editor and its CmdEnter route', async () => {
  await mountFocusSurface()
  composer.focus()
  expect(document.activeElement).toBe(composer)
  await act(async () => { completeAttach(replay('Retained history\r\n')); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(document.querySelector('.terminal-view__xterm--hydrating')).toBeNull()
  expect.soft(document.activeElement).toBe(composer)
  await act(async () => activeKey())
  expect.soft(submit).toHaveBeenCalledTimes(1)
  expect(composer.textContent).toBe('Original draft')
  expect(write).not.toHaveBeenCalled()
})

it('already-focused original terminal keeps passive attach/reveal focus', async () => {
  await mountFocusSurface()
  const input = fixture.terminals[0]!.element!.querySelector<HTMLTextAreaElement>('textarea')!
  input.focus()
  await runFrames()
  await act(async () => { completeAttach(replay('Retained history\r\n')); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(document.activeElement).toBe(input)
  expect(submit).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
for (const tag of ['input', 'button'] as const) it(`passive attach/reveal preserves a later focused external ${tag}`, async () => {
  await mountFocusSurface()
  const active = document.createElement(tag); active.setAttribute('aria-label', 'Other original work'); document.body.append(active); active.focus()
  expect(document.activeElement).toBe(active)
  await runFrames()
  expect.soft(document.activeElement).toBe(active)
  await act(async () => { completeAttach(replay('Retained history\r\n')); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect.soft(document.activeElement).toBe(active)
  expect(composer.textContent).toBe('Original draft')
  expect(submit).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
it('explicit exact Region caret intent still transfers focus from Composer to its original terminal', async () => {
  await mountFocusSurface()
  composer.focus()
  expect(document.activeElement).toBe(composer)
  await act(async () => useAppStore.setState({ regionCaretFocus: { regionId: origin.regionId, nonce: 25 } }))
  expect(document.activeElement).toBe(fixture.terminals[0]!.element!.querySelector('textarea'))
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(composer.textContent).toBe('Original draft')
  expect(write).not.toHaveBeenCalled()
})
