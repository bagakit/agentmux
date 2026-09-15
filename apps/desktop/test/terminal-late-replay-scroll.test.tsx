// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as BrowserTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners'

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
  attach: vi.fn(),
  detach: vi.fn(),
  acknowledge: vi.fn(),
  unsubscribe: vi.fn(),
  blockFirstWrite: false,
  releaseWrite: null as (() => void) | null,
  reveal: null as (() => void) | null
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
  fixture.releaseWrite = null
  fixture.reveal = null
  fixture.blockFirstWrite = false
  vi.clearAllMocks()
  const original = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 6_000) fixture.reveal = callback as () => void
    return original(callback, delay, ...args)
  })
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-retained', currentSize: { cols: 80, rows: 24 },
    gap: null, replay: [{ data: 'before ', dataBytes: new TextEncoder().encode('before '), endByte: 7 }] })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Use the pinned browser parser and public viewport API; only DOM rendering/addons are stubbed.
const retained = Array.from({ length: 2_000 }, (_,i) => `retained-${String(i).padStart(5, '0')} ${'.'.repeat(60)}\r\n`).join('')

async function mountReplay(blockFirstWrite: boolean) {
  fixture.blockFirstWrite = blockFirstWrite
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-retained', currentSize: { cols: 80, rows: 24 },
    gap: null, replay: [{ data: retained, dataBytes: new TextEncoder().encode(retained), endByte: retained.length }] })
  await act(async () => root!.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} visible={true} autoFocus={false} linkOrigin={linkOrigin} />))
  expect(fixture.terminals).toHaveLength(1)
  return fixture.terminals[0]!
}
async function awaitHandoff() {
  await act(async () => await vi.waitFor(() => expect(fixture.acknowledge).toHaveBeenCalledWith(session.control, retained.length)))
}

it('keeps the line read after overdue partial reveal when the remaining replay completes', async () => {
  const terminal = await mountReplay(true)
  await act(async () => await vi.waitFor(() => expect(fixture.releaseWrite).not.toBeNull()))
  expect(terminal.buffer.active.baseY).toBeGreaterThan(100)
  expect(fixture.reveal).not.toBeNull()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000)
  await act(async () => fixture.reveal!())
  clock.mockRestore()
  expect(document.querySelector('.terminal-view__xterm--hydrating')).toBeNull()
  terminal.scrollToLine(5)
  const line = terminal.buffer.active.getLine(5)?.translateToString(true)
  expect(line).toContain('retained-00005')
  expect(terminal.buffer.active.viewportY).toBe(5)
  await act(async () => fixture.releaseWrite!())
  await awaitHandoff()
  expect(terminal.buffer.active.viewportY).toBe(5)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toBe(line)
  expect(terminal.buffer.active.baseY).toBeGreaterThan(1_900)
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(fixture.detach).not.toHaveBeenCalled()
})

it('positions the first still-hidden hydration at the latest output', async () => {
  const terminal = await mountReplay(false)
  await awaitHandoff()
  expect(document.querySelector('.terminal-view__xterm--hydrating')).toBeNull()
  expect(terminal.buffer.active.baseY).toBeGreaterThan(1_900)
  expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY)
  expect(terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true)).toContain('retained-019')
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
})
