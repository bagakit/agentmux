// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'

type FixtureTerminal = HeadlessTerminal & {
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
  attach: vi.fn(),
  detach: vi.fn(),
  acknowledge: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await import('@xterm/headless')
  return { Terminal: class extends Terminal {
    element?: HTMLElement
    refresh = vi.fn()
    written: string[] = []
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      this.dispose = vi.fn(() => super.dispose())
      fixture.terminals.push(this as unknown as FixtureTerminal)
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      super.write(data, callback)
    }
    open(root: HTMLElement) { this.element = document.createElement('div'); root.append(this.element) }
    focus() {}
    onRender() { return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
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
  attach: fixture.attach,
  detach: fixture.detach,
  acknowledge: fixture.acknowledge,
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
vi.mock('../src/renderer/src/lib/terminal-viewport-sync', () => ({
  TerminalViewportSynchronizer: class {
    beginReplay() {}
    endReplay() {}
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
  vi.clearAllMocks()
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-retained', currentSize: { cols: 80, rows: 24 },
    gap: null, replay: [{ data: 'before ', endByte: 7 }] })
  fixture.detach.mockResolvedValue(undefined)
  fixture.acknowledge.mockResolvedValue(undefined)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function render(visible: boolean) {
  await act(async () => {
    root!.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} visible={visible} autoFocus={false} linkOrigin={linkOrigin} />)
  })
  await act(async () => {
    await vi.waitFor(() => expect(fixture.acknowledge).toHaveBeenCalledWith(session.control, 7))
  })
}
async function hiddenOutput(data: string, startByte: number) {
  expect(fixture.receive).not.toBeNull()
  await act(async () => {
    fixture.receive!({ type: 'core', hostId: 'local', event: {
      type: 'terminal-output', run: session.control.run, data,
      evidence: { outputByteRange: { startByte, endByte: startByte + data.length } }
    } } as RuntimeEvent)
    await vi.waitFor(() => expect(fixture.acknowledge).toHaveBeenCalledWith(session.control, startByte + data.length))
  })
}

it('releases only the GPU when hidden, parses ordered hidden bytes, and refreshes the same terminal on reveal', async () => {
  await render(true)
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(1)
  const terminal = fixture.terminals[0]!
  const first = fixture.webgl[0]!
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 4, terminalListeners: 8 })

  await render(false)
  expect(first.disposed).toHaveBeenCalledOnce()
  expect(first.contextLossDisposed).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 3, terminalListeners: 8 })
  // Split an ANSI parser sequence across separate hidden writes, in byte order.
  await hiddenOutput('\u001b[3', 7)
  await hiddenOutput('1mhidden\u001b[0m', 10)
  expect(terminal.written).toEqual(['before ', '\u001b[3', '1mhidden\u001b[0m'])
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('before hidden')
  expect(terminal.dispose).not.toHaveBeenCalled()
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(fixture.detach).not.toHaveBeenCalled()
  expect(fixture.unsubscribe).not.toHaveBeenCalled()

  terminal.refresh.mockClear()
  await render(true)
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.webgl).toHaveLength(2)
  expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1)
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('before hidden')
  expect(terminalResourceOwnerCounts().terminalAddons).toBe(4)
  const second = fixture.webgl[1]!
  await act(async () => second.loseContext())
  expect(second.disposed).toHaveBeenCalledOnce()
  expect(second.contextLossDisposed).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts().terminalAddons).toBe(3)
  await render(false)
  expect(second.disposed).toHaveBeenCalledOnce()
  await act(async () => root!.unmount())
  root = null
  expect(terminal.dispose).toHaveBeenCalledOnce()
  expect(fixture.detach).toHaveBeenCalledExactlyOnceWith('attachment-retained')
  expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
})

it('mounts an initially hidden terminal without allocating a GPU context', async () => {
  await render(false)
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(0)
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 1, terminalAddons: 3, terminalListeners: 8 })
  await render(true)
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.webgl).toHaveLength(1)
  expect(fixture.terminals[0]!.refresh).toHaveBeenCalledWith(0, 23)
})
