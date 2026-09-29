// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'

// Mount the product owner; only xterm's canvas/parser and the private API are fixtures.
// This proves provider callbacks and rendered menus, not native hit testing or a real Run.
const renderer = vi.hoisted(() => {
  const disposable = () => ({ dispose: vi.fn() })
  class Terminal {
    static instances: Terminal[] = []
    options: { linkHandler?: ILinkHandler; scrollback: number }
    cols = 80
    rows = 24
    element?: HTMLElement
    selection = ''
    line = 'src/example.ts:3'
    provider?: ILinkProvider
    selectionChanged = () => {}
    scrolled = () => {}
    data = (_data: string) => {}
    userInput = () => {}
    modes = { mouseTrackingMode: 'none' }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 24, getLine: () => ({ translateToString: () => this.line }) } }
    constructor(options: Terminal['options']) { this.options = options; Terminal.instances.push(this) }
    loadAddon() {}
    open(root: HTMLElement) { this.element = root; root.innerHTML = '<div class="xterm-screen"></div>' }
    registerLinkProvider(provider: ILinkProvider) { this.provider = provider; return disposable() }
    onSelectionChange(callback: () => void) { this.selectionChanged = callback; return disposable() }
    onScroll(callback: () => void) { this.scrolled = callback; return disposable() }
    onRender() { return disposable() }
    onData(callback: (data: string) => void) { this.data = callback; return disposable() }
    onUserInput(callback: () => void) { this.userInput = callback; return disposable() }
    onBinary() { return disposable() }
    parser = { registerOscHandler: disposable, registerCsiHandler: disposable }
    attachCustomKeyEventHandler() {}
    getSelection() { return this.selection }
    hasSelection() { return this.selection.length > 0 }
    write(_data: unknown, callback: () => void) { callback() }
    focus = vi.fn()
    dispose = vi.fn()
    refresh() {}
    scrollToBottom() {}
    scrollToLine() {}
    clear() {}
    resize() {}
    paste() {}
  }
  class WebLinksAddon {
    static instances: WebLinksAddon[] = []
    constructor(public activate: (event: MouseEvent, uri: string) => void,
      public callbacks: { hover: (event: MouseEvent, uri: string) => void; leave: () => void }) {
      WebLinksAddon.instances.push(this)
    }
  }
  return { Terminal, WebLinksAddon, disposable }
})
vi.mock('@xterm/xterm', () => ({ Terminal: renderer.Terminal }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: renderer.WebLinksAddon }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {}; proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults = renderer.disposable } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss = renderer.disposable; dispose() {} } }))
vi.mock('../src/renderer/src/lib/terminal-theme.js', async (original) => ({
  ...await original<typeof import('../src/renderer/src/lib/terminal-theme.js')>(),
  activateTerminalUnicodeWidth: () => '11'
}))
vi.mock('../src/renderer/src/lib/terminal-viewport-sync.js', () => ({ TerminalViewportSynchronizer: class {
  beginReplay() {}; endReplay() {}; setInteractiveResize() {}; setVisible() {}; observeViewport() {}
  acceptOwnerSize() {}; dispose() {}; synchronizeCellMetrics() {}
  async startLiveSynchronization() {}
} }))
import { TerminalView } from '../src/renderer/src/components/TerminalView.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners.js'
import type { SessionSnapshot } from '../src/shared/contracts.js'

const initial = useAppStore.getState()
const origin = { workspaceId: 'private-workspace', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }
const session = {
  id: 'private-session', kind: 'terminal', hostId: 'local', workspacePath: '/private/project',
  providerId: null, label: 'Private terminal', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
  status: { state: 'running', source: 'run-process', observedAt: 1 },
  processState: 'running', control: { kind: 'terminal', hostId: 'local', runId: 'private-run', run: { runId: 'private-run' } }
} satisfies SessionSnapshot
const range = { start: { x: 1, y: 1 }, end: { x: 12, y: 1 } }
let root: Root
let element: HTMLElement
let host: HTMLElement
let terminal: InstanceType<typeof renderer.Terminal>
let web: InstanceType<typeof renderer.WebLinksAddon>
let openHttp: ReturnType<typeof vi.fn>
let openFile: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  renderer.Terminal.instances = []; renderer.WebLinksAddon.instances = []
  vi.spyOn(api.sessions, 'attach').mockResolvedValue({
    attachmentId: 'private-attachment', session,
    terminal: { type: 'unavailable', reason: 'source_gap' }, replay: [], resizeRevision: 0,
    currentSize: { cols: 80, rows: 24 }, gap: null
  })
  vi.spyOn(api.sessions, 'detach').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, width: 240, height: 480, right: 240, bottom: 480, toJSON: () => ({})
  })
  openHttp = vi.fn().mockResolvedValue(undefined); openFile = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({ openHttpLink: openHttp, openFile, config: {
    ...initial.config, workspaces: [{ id: origin.workspaceId, hostId: 'local', path: session.workspacePath }]
  } as NonNullable<typeof initial.config> })
  element = document.createElement('div'); host = document.createElement('div')
  host.id = 'agentmux-window-overlay-host'; host.className = 'window-overlay-host'; host.dataset.overlayHost = ''
  document.body.append(element, host); root = createRoot(element)
  await act(async () => { root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />) })
  expect(renderer.Terminal.instances).toHaveLength(1)
  expect(renderer.WebLinksAddon.instances).toHaveLength(1)
  terminal = renderer.Terminal.instances[0]!; web = renderer.WebLinksAddon.instances[0]!
  expect(terminal.options.linkHandler?.activate).toBeTypeOf('function')
  expect(element.querySelector('.terminal-view__xterm--hydrating')).toBeNull()
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  element.remove(); host.remove()
  expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 0, terminalAddons: 0, terminalListeners: 0 })
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

function pointer(button = 0, x = 50, y = 80) {
  const event = new MouseEvent('mouseup', { button, clientX: x, clientY: y })
  element.querySelector('.terminal-view__xterm')!.dispatchEvent(new PointerEvent('pointerdown', { button, clientX: x, clientY: y, bubbles: true }))
  return event
}
async function fileLink(path = 'src/example.ts:3'): Promise<ILink> {
  terminal.line = path
  let links: ILink[] | undefined
  terminal.provider!.provideLinks(1, (result) => { links = result })
  expect(links).toHaveLength(1)
  return links![0]!
}

describe('mounted Terminal link exits', () => {
  for (const provider of ['bare URL', 'OSC 8'] as const) {
    it(`${provider}: plain primary shows menu; modifier primary opens system`, async () => {
      const activate = provider === 'bare URL' ? web.activate : terminal.options.linkHandler!.activate
      await act(async () => { activate(pointer(), 'https://example.test/path', range) })
      expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Choose where to open the link')
      expect(host.textContent).toContain('https://example.test/path')
      expect(openHttp).not.toHaveBeenCalled()
      await act(async () => { host.querySelector('button[data-destination="tab"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/path', 'tab')
      await act(async () => { activate(new MouseEvent('mouseup', { button: 0, clientX: 50, clientY: 80, metaKey: true }), 'https://example.test/path', range) })
      expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/path', 'system')
    })
    it(`${provider}: right button, drag and selection never open`, async () => {
      const activate = provider === 'bare URL' ? web.activate : terminal.options.linkHandler!.activate
      await act(async () => { activate(pointer(2), 'https://example.test/path', range) })
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => { activate(new MouseEvent('mouseup', { button: 0, ctrlKey: true }), 'https://example.test/path', range) })
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => { pointer(); activate(new MouseEvent('mouseup', { button: 0, clientX: 150, clientY: 80 }), 'https://example.test/path', range) })
      terminal.selection = 'selected text'
      await act(async () => { activate(pointer(), 'https://example.test/path', range) })
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(openHttp).not.toHaveBeenCalled()
    })
  }
  it('file primary retains editor/system seam, while right-button and drag do not open', async () => {
    const file = await fileLink()
    await act(async () => { file.activate(pointer(2), file.text) })
    expect(openFile).not.toHaveBeenCalled()
    expect(api.files.openSystem).not.toHaveBeenCalled()
    await act(async () => { file.activate(new MouseEvent('mouseup', { button: 0, ctrlKey: true }), file.text) })
    expect(openFile).not.toHaveBeenCalled()
    await act(async () => { pointer(); file.activate(new MouseEvent('mouseup', { button: 0, clientX: 150, clientY: 80 }), file.text) })
    expect(openFile).not.toHaveBeenCalled()
    await act(async () => { file.activate(pointer(), file.text) })
    expect(openFile).toHaveBeenCalledWith('src/example.ts', origin.tabGroupId, { line: 3 }, origin.workspaceId)
    const artifact = await fileLink('release/Example.dmg')
    await act(async () => { artifact.activate(pointer(2), artifact.text) })
    expect(api.files.openSystem).not.toHaveBeenCalled()
    await act(async () => { artifact.activate(pointer(), artifact.text) })
    expect(api.files.openSystem).toHaveBeenCalledWith(origin.workspaceId, 'release/Example.dmg')
    expect(openHttp).not.toHaveBeenCalled()
  })
})

describe('mounted passive link readout', () => {
  it('delays a stable edge readout away from the link, without changing grid or input', async () => {
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path') })
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(element.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(500) })
    const readout = element.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(readout.textContent).toContain('https://example.test/path')
    expect(readout.dataset.placement).toBe('bottom')
    expect(readout.style.left).toBe('')
    expect(readout.querySelector('button, kbd, svg')).toBeNull()
    expect(renderer.Terminal.instances).toEqual([terminal])
    expect([terminal.cols, terminal.rows]).toEqual([80, 24])
    await act(async () => { terminal.userInput(); terminal.data('still usable') })
    expect(api.sessions.write).toHaveBeenCalledWith(session.control, 'still usable', 'user')
  })
  it('OSC 8 and file callbacks share the delayed passive readout and leave cleanup', async () => {
    const file = await fileLink()
    for (const link of [terminal.options.linkHandler!, file]) {
      await act(async () => { link.hover!(new MouseEvent('mousemove', { clientX: 50, clientY: 400 }), link === file ? file.text : 'https://example.test/path', range); vi.advanceTimersByTime(500) })
      expect(element.querySelector<HTMLElement>('[role="tooltip"]')?.dataset.placement).toBe('top')
      await act(async () => { link.leave!(new MouseEvent('mouseleave'), '', range) })
      expect(element.querySelector('[role="tooltip"]')).toBeNull()
    }
  })
  it('unmount cancels the pending hover timer with the terminal owner', async () => {
    // Drain the mount's one-time focus animation frame before isolating the hover timer.
    await act(async () => { vi.advanceTimersByTime(20) })
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path') })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => { root.unmount() })
    expect(vi.getTimerCount()).toBe(0)
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })
  for (const action of ['leave', 'press', 'selection', 'wheel', 'scroll', 'hide'] as const) {
    it(`${action} clears both shown readout and pending hover`, async () => {
      for (const shown of [false, true]) {
        await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path'); if (shown) vi.advanceTimersByTime(500) })
        if (shown) expect(element.querySelector('[role="tooltip"]')).not.toBeNull()
        await act(async () => {
          if (action === 'leave') web.callbacks.leave()
          if (action === 'press') pointer()
          if (action === 'selection') { terminal.selection = 'selected'; terminal.selectionChanged() }
          if (action === 'wheel') element.querySelector('.terminal-view__xterm')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
          if (action === 'scroll') terminal.scrolled()
          if (action === 'hide') root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} visible={false} autoFocus={false} />)
          vi.advanceTimersByTime(500)
        })
        expect(element.querySelector('[role="tooltip"]')).toBeNull()
        terminal.selection = ''
        if (action === 'hide') await act(async () => { root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} visible autoFocus={false} />) })
      }
    })
  }
})
