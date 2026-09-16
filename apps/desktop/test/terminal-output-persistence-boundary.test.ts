// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { RuntimeEvent, SessionAttachResult, SessionSnapshot } from '../src/shared/contracts'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { readTerminalViewObservation } from '../src/renderer/src/lib/terminal-view-observation'

// Native parser, buffers, modes and viewport methods are real; DOM paint/addons and Run boundary are not.
const fixture = vi.hoisted(() => ({ terminals: [] as BrowserTerminal[], receive: null as ((event: RuntimeEvent) => void) | null }))
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  return { Terminal: class extends Terminal {
    element: HTMLElement | undefined = undefined
    constructor(options: ConstructorParameters<typeof Terminal>[0]) { super(options); fixture.terminals.push(this) }
    open(root: HTMLElement) { this.element = document.createElement('div'); root.append(this.element) }
    refresh() {}
    focus() {}
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
  id: 'observed-agent', hostId: 'local', workspacePath: '/synthetic', label: 'Observed', createdAt: 1, updatedAt: 1,
  kind: 'agent', providerId: 'codex', executorId: 'codex', processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'observed-agent', run: { runId: 'observed-run' } }
}
const origin = { workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId: 'observed-region' }
let root: Root
let attach: MockInstance<typeof api.sessions.attach>
let write: MockInstance<typeof api.sessions.write>
let recover: MockInstance<typeof api.sessions.recover>

function surfaceState(current: SessionSnapshot = session, regionId = origin.regionId) {
  const tab = createWorkbenchTab(origin.tabId, { regionId, kind: current.kind, phase: 'attached', workspaceId: origin.workspaceId, sessionId: current.id })
  useAppStore.setState({ sessions: [current], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(origin.tabGroupId, [tab.id]) },
    activeWorkspaceId: origin.workspaceId, config: null, closingWorkbenchViews: {}, regionCaretFocus: null })
}
function replay(data: string): SessionAttachResult {
  return { attachmentId: 'observed-attachment', session, currentSize: { cols: 80, rows: 24 }, gap: null,
    replay: [{ type: 'data', runId: session.control.run.runId, startByte: 0, endByte: data.length, data, dataBytes: new TextEncoder().encode(data) }] }
}
async function render(current: SessionSnapshot = session, props: { visible?: boolean; readOnly?: boolean; regionId?: string } = {}) {
  await act(async () => root.render(createElement(TerminalView, { session: current, themeId: 'graphite',
    interactiveResize: false, visible: props.visible ?? true, readOnly: props.readOnly ?? false, autoFocus: false,
    linkOrigin: { ...origin, regionId: props.regionId ?? origin.regionId } })))
}
async function ready(data: string) {
  attach.mockResolvedValue(replay(data))
  await render()
  await act(async () => await vi.waitFor(() => expect(readTerminalViewObservation({ regionId: origin.regionId, sessionId: session.id, runId: session.control.run.runId })?.liveReady).toBe(true)))
  expect(fixture.terminals).toHaveLength(1)
  return fixture.terminals[0]!
}
const lines = Array.from({ length: 600 }, (_, i) => `private-${i}\r\n`).join('')
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fixture.terminals.length = 0; fixture.receive = null
  attach = vi.spyOn(api.sessions, 'attach').mockResolvedValue(replay(lines))
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(receive => { fixture.receive = receive; return () => { fixture.receive = null } })
  write = vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'resize').mockResolvedValue({ cols: 80, rows: 24 })
  recover = vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  surfaceState()
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  useAppStore.setState(originalState, true)
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('actual Terminal replay and 64 live batches parse nonempty bytes without sending a display acknowledgement', async () => {
  const forbiddenAck = vi.fn(async () => {})
  // A test-only trap makes a reverted production ACK call fail by count, rather than TypeError.
  Object.defineProperty(api.sessions, 'acknowledge', { value: forbiddenAck, configurable: true })
  try {
    const terminal = await ready('initial\r\n')
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('initial')
    expect(fixture.receive).toEqual(expect.any(Function))
    const firstByte='initial\r\n'.length
    await act(async () => {
      for (let i=0;i<64;i++) {
        const text=`batch-${String(i).padStart(2,'0')}\r\n`
        fixture.receive!({type:'core',hostId:session.hostId,event:{type:'terminal-output',agentSessionId:session.id,
          run:session.control.run,data:text,dataBytes:new TextEncoder().encode(text),evidence:{source:'terminal-output',observedAt:1,
            run:session.control.run,outputByteRange:{startByte:firstByte+i*10,endByte:firstByte+(i+1)*10}}}})
      }
      await vi.waitFor(() => expect(terminal.buffer.active.getLine(64)?.translateToString(true)).toBe('batch-63'))
    })
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('batch-00')
    expect(forbiddenAck).toHaveBeenCalledTimes(0)
    expect(write).toHaveBeenCalledTimes(0);expect(recover).toHaveBeenCalledTimes(0)
    expect(api.sessions).not.toHaveProperty('acknowledgeAgentOutput')
  } finally { Reflect.deleteProperty(api.sessions, 'acknowledge') }
})
