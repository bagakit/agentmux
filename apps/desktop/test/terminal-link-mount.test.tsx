const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IBufferCell, IBufferLine, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'
import { createWorkspaceLayout } from '@agentmux/layout'

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
    cellLines: IBufferLine[] = []
    nullCell!: IBufferCell
    provider?: ILinkProvider
    selectionChanged = () => {}
    scrolled = () => {}
    data = (_data: string) => {}
    userInput = () => {}
    modes = { mouseTrackingMode: 'none' }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 24, getLine: (index: number) => this.cellLines[index], getNullCell: () => this.nullCell } }
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
    write = vi.fn((_data: unknown, callback: () => void) => { callback() })
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
import { WorkbenchPresentationContext, type WorkbenchPresentation } from '../src/renderer/src/lib/workbench-presentation.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import * as sessionLinkOpening from '../src/renderer/src/lib/session-link-opening.js'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts.js'

const initial = useAppStore.getState()
const origin = { workspaceId: 'private-workspace', tabGroupId: 'private-group', tabId: 'private-tab', regionId: 'private-region' }
const session = {
  id: 'private-session', kind: 'terminal', hostId: 'local', workspacePath: _hygiene_fixturePath("private/project"),
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
let receive: (event: RuntimeEvent) => void
let resized: () => void

async function installCells(text: string, cols = 80) {
  const { Terminal: NativeTerminal } = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
  const { Unicode11Addon } = await import('@xterm/addon-unicode11')
  const parsed = new NativeTerminal({ cols, rows: 24, allowProposedApi: true })
  parsed.loadAddon(new Unicode11Addon()); parsed.unicode.activeVersion = '11'
  const written = new Promise<void>(resolve => parsed.write(text, resolve))
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1)
  await written
  terminal.cols = cols; terminal.nullCell = parsed.buffer.active.getNullCell()
  terminal.cellLines = Array.from({ length: parsed.buffer.active.length }, (_, y) => {
    const row = parsed.buffer.active.getLine(y)!, cells = Array.from({ length: row.length }, (_, x) => row.getCell(x)!)
    const content = row.translateToString(false)
    return { isWrapped: row.isWrapped, length: row.length, getCell: (x: number) => cells[x], translateToString: (trim = false) => trim ? content.trimEnd() : content }
  })
  parsed.dispose()
}

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
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { receive = listener; return () => {} })
  vi.spyOn(api.sessions, 'write').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}; unobserve() {}; disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const readout = this.classList.contains('terminal-link-preview')
    const x = readout ? 4 : 0, y = readout ? (this.dataset.placement === 'top' ? 4 : 436) : 0
    const width = readout ? 200 : 240, height = readout ? 40 : 480
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }
  })
  openHttp = vi.fn().mockResolvedValue(undefined)
  openFile = vi.fn<typeof initial.openFile>().mockImplementation(async (_path, _group, _location, _workspace, _preview, placement) => {
    placement?.onResult?.({ placement: { status: 'created', tabId: 'file-result', regionId: 'file-result-region' },
      data: { kind: 'text', reason: null }, navigation: 'applied' })
    return true
  })
  const tab = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, workspaceId: origin.workspaceId,
    kind: 'terminal', phase: 'attached', sessionId: session.id })
  useAppStore.setState({ openHttpLink: openHttp, openFile, config: {
    ...initial.config, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    workspaces: [{ id: origin.workspaceId, hostId: 'local', name: 'Source project', kind: 'folder', path: session.workspacePath }]
  } as NonNullable<typeof initial.config>, sessions: [session], tabs: { [tab.id]: tab },
    layouts: { [origin.workspaceId]: createWorkspaceLayout(origin.tabGroupId, [tab.id]) } })
  element = document.createElement('div'); host = document.createElement('div')
  host.id = 'agentmux-window-overlay-host'; host.className = 'window-overlay-host'; host.dataset.overlayHost = ''
  document.body.append(element, host); root = createRoot(element)
  await act(async () => { root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />) })
  expect(renderer.Terminal.instances).toHaveLength(1)
  expect(renderer.WebLinksAddon.instances).toHaveLength(1)
  terminal = renderer.Terminal.instances[0]!; web = renderer.WebLinksAddon.instances[0]!
  await installCells('src/example.ts:3')
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
  await installCells(path)
  let links: ILink[] | undefined
  terminal.provider!.provideLinks(1, (result) => { links = result })
  expect(links).toHaveLength(1)
  return links![0]!
}

const focusOrigin = { ...origin, sessionId: session.id }
const otherFocusOrigin = { workspaceId: 'private-other-display', tabGroupId: 'private-other-group',
  tabId: 'private-other-tab', regionId: 'private-other-region', sessionId: session.id }
const focusReference = (source: typeof focusOrigin | typeof otherFocusOrigin) => ({ displayWorkspaceId: source.workspaceId,
  groupId: source.tabGroupId, tabId: source.tabId, regionId: source.regionId })
async function focusTerminal(destination: 'region' | 'tab' = 'region') {
  const original = createWorkbenchTab(origin.tabId, { regionId: origin.regionId, kind: 'terminal', phase: 'attached',
    workspaceId: origin.workspaceId, sessionId: session.id }, 'Original terminal')
  const other = createWorkbenchTab(otherFocusOrigin.tabId, { regionId: otherFocusOrigin.regionId, kind: 'terminal', phase: 'attached',
    workspaceId: origin.workspaceId, sessionId: session.id }, 'Other occurrence')
  await act(async () => {
    const state = useAppStore.getState()
    useAppStore.setState({ mainSurface: 'agents', sessions: [session], agentComposerDrafts: { [session.id]: 'Original unsent input' },
      config: { ...state.config!, focus: { recentActivityHours: state.config?.focus?.recentActivityHours ?? 48, linkDestination: destination },
        workspaces: [...state.config!.workspaces, { id: otherFocusOrigin.workspaceId, name: 'Other display', kind: 'folder', hostId: 'local', path: _hygiene_fixturePath("private/display") }] },
      tabs: { [original.id]: original, [other.id]: other }, layouts: {
        [origin.workspaceId]: createWorkspaceLayout(origin.tabGroupId, [origin.tabId]),
        [otherFocusOrigin.workspaceId]: createWorkspaceLayout(otherFocusOrigin.tabGroupId, [otherFocusOrigin.tabId]) },
      agentFocus: { execution: { sessionId: session.id, reference: focusReference(focusOrigin),
        history: [{ sessionId: session.id, focusedAt: 1 }] }, pmo: { sessionId: null } } })
    root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={focusOrigin} autoFocus={false} />)
  })
}

describe('mounted Focus Terminal destinations', () => {
  it('plain HTTP from both real provider callbacks immediately uses the current Region or Tab preference', async () => {
    await focusTerminal()
    for (const destination of ['region', 'tab'] as const) {
      await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { recentActivityHours: state.config?.focus?.recentActivityHours ?? 48, linkDestination: destination } } })))
      for (const activate of [web.activate, terminal.options.linkHandler!.activate]) {
        await act(async () => activate(pointer(), 'https://example.test/focus', range))
        expect(host.querySelector('[role="dialog"]')).toBeNull()
        expect(openHttp).toHaveBeenLastCalledWith(focusOrigin, 'https://example.test/focus', destination === 'region' ? 'right' : 'tab')
      }
    }
    expect(openHttp).toHaveBeenCalledTimes(4)
    expect(renderer.Terminal.instances).toEqual([terminal]); expect(api.sessions.detach).not.toHaveBeenCalled()
  })

  it('Alt chooser belongs to its full same-Session occurrence and cannot drift after that reference changes', async () => {
    await focusTerminal('tab')
    const drafts = useAppStore.getState().agentComposerDrafts
    const callback = terminal.data, provider = terminal.provider, owners = terminalResourceOwnerCounts()
    const alt = () => { pointer(); return new MouseEvent('mouseup', { button: 0, clientX: 50, clientY: 80, altKey: true }) }
    await act(async () => web.activate(alt(), 'https://example.test/explicit'))
    expect(openHttp).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Choose where to open the link')
    await act(async () => host.querySelector<HTMLButtonElement>('button[data-destination="left"]')!.click())
    expect(openHttp).toHaveBeenCalledExactlyOnceWith(focusOrigin, 'https://example.test/explicit', 'left')
    await act(async () => terminal.options.linkHandler!.activate(alt(), 'https://example.test/stale', range))
    const oldChoice = host.querySelector<HTMLButtonElement>('button[data-destination="tab"]')!
    expect(oldChoice).not.toBeNull(); terminal.selection = 'Original terminal selection'
    await act(async () => {
      useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution,
        reference: focusReference(otherFocusOrigin) } } }))
      root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={otherFocusOrigin} autoFocus={false} />)
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => oldChoice.click())
    expect(openHttp).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(focusReference(otherFocusOrigin))
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(session.id)
    expect(terminal.getSelection()).toBe('Original terminal selection')
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(terminal.data).toBe(callback); expect(terminal.provider).toBe(provider)
    await act(async () => { terminal.userInput(); terminal.data('Input remains usable') })
    expect(api.sessions.write).toHaveBeenCalledExactlyOnceWith(session.control, 'Input remains usable', 'user')
    expect(renderer.Terminal.instances).toEqual([terminal]); expect(terminalResourceOwnerCounts()).toEqual(owners)
    expect(api.sessions.attach).toHaveBeenCalledOnce(); expect(api.sessions.detach).not.toHaveBeenCalled()
  })

  it('Focus preserves Cmd HTTP/file system exits and drag or selected-text protection with the original input owner', async () => {
    await focusTerminal()
    for (const activate of [web.activate, terminal.options.linkHandler!.activate]) {
      await act(async () => activate(new MouseEvent('mouseup', { button: 0, metaKey: true }), 'https://example.test/system', range))
      expect(openHttp).toHaveBeenLastCalledWith(focusOrigin, 'https://example.test/system', 'system')
      await act(async () => { pointer(); activate(new MouseEvent('mouseup', { button: 0, clientX: 150, clientY: 80 }), 'https://example.test/drag', range) })
      terminal.selection = 'Keep selected text'
      await act(async () => activate(pointer(), 'https://example.test/selection', range))
      expect(terminal.getSelection()).toBe('Keep selected text'); terminal.selection = ''
    }
    expect(openHttp).toHaveBeenCalledTimes(2)
    const file = await fileLink()
    await act(async () => file.activate(new MouseEvent('mouseup', { button: 0, metaKey: true }), file.text))
    expect(api.files.openSystem).toHaveBeenCalledExactlyOnceWith(origin.workspaceId, 'src/example.ts')
    expect(openFile).not.toHaveBeenCalled(); expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(renderer.Terminal.instances).toEqual([terminal]); expect(api.sessions.detach).not.toHaveBeenCalled()
  })
})

describe('mounted Terminal link exits', () => {
  it('the wrapped continuation context menu resolves the same full file in its source workspace', async () => {
    await installCells('说明 src/example.ts:3:2,', 12)
    const reveal = vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
    await act(async () => {
      pointer(2, 70, 30)
      element.querySelector('.terminal-view__xterm')!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 70, clientY: 30, bubbles: true }))
    })
    const action = host.querySelector<HTMLElement>('[role="menuitem"][title*="src/example.ts"]')
    expect(action, host.textContent ?? '').not.toBeNull()
    await act(async () => action!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(reveal).toHaveBeenCalledWith(origin.workspaceId, 'src/example.ts')
    expect(openFile).not.toHaveBeenCalled(); expect(api.files.openSystem).not.toHaveBeenCalled()
  })
  it('the actual provider consumes Unicode cell ranges and a wrapped full path from either row, keeping click owner and no IPC on hover', async () => {
    for (const [text, start] of [['说明 src/example.ts:3:2', 6], ['e\u0301 src/example.ts:3:2', 3], ['😀 src/example.ts:3:2', 4]] as const) {
      await installCells(text)
      let links: ILink[] | undefined
      terminal.provider!.provideLinks(1, value => { links = value })
      expect(links).toHaveLength(1); expect(links![0]!.range).toEqual({ start: { x: start, y: 1 }, end: { x: start + 17, y: 1 } })
    }
    await installCells('说明 src/example.ts:3:2,', 12)
    let first: ILink[] | undefined, second: ILink[] | undefined
    terminal.provider!.provideLinks(1, value => { first = value }); terminal.provider!.provideLinks(2, value => { second = value })
    expect(first).toHaveLength(1); expect(second).toHaveLength(1)
    expect(second![0]!.range).toEqual(first![0]!.range)
    expect(second![0]!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 11, y: 2 } })
    expect(api.files.openSystem).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled(); expect(openHttp).not.toHaveBeenCalled()
    await act(async () => second![0]!.activate(pointer(), second![0]!.text))
    expect(openFile).toHaveBeenCalledWith('src/example.ts', origin.tabGroupId, { line: 3, column: 2 }, origin.workspaceId,
      undefined, expect.objectContaining({ resource: { hostId: session.hostId, path: session.workspacePath } }), undefined)
    expect(renderer.Terminal.instances).toEqual([terminal]); expect(api.sessions.detach).not.toHaveBeenCalled()
  })
  for (const provider of ['bare URL', 'OSC 8'] as const) {
    it(`${provider}: plain primary shows menu; modifier primary opens system`, async () => {
      const activate = provider === 'bare URL' ? web.activate : terminal.options.linkHandler!.activate
      await act(async () => { activate(pointer(), 'https://example.test/path', range) })
      expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Choose where to open the link')
      expect(host.textContent).toContain('https://example.test/path')
      expect(openHttp).not.toHaveBeenCalled()
      await act(async () => { host.querySelector('button[data-destination="tab"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/path', 'tab', expect.objectContaining({ active: true, retainedRegionId: null }))
      await act(async () => { activate(new MouseEvent('mouseup', { button: 0, clientX: 50, clientY: 80, metaKey: true }), 'https://example.test/path', range) })
      expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/path', 'system', expect.objectContaining({ active: true, retainedRegionId: null }))
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
  it.each(['bare URL', 'OSC 8'] as const)('%s keeps the terminal mounted while its Mote presentation owns modifier and chooser navigation above Focus', async provider => {
    const focus: WorkbenchPresentation = { active: true, retainedRegionId: null, surface: 'focus', onSelectRegion: vi.fn() }
    const mote: WorkbenchPresentation = { active: true, retainedRegionId: null, surface: 'mote', onSelectRegion: vi.fn() }
    const render = (presentation: WorkbenchPresentation) => <WorkbenchPresentationContext.Provider value={presentation}>
      <TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />
    </WorkbenchPresentationContext.Provider>
    await act(async () => {
      useAppStore.setState({ mainSurface: 'agents' })
      root.render(render(focus))
    })
    terminal = renderer.Terminal.instances.at(-1)!
    web = renderer.WebLinksAddon.instances.at(-1)!
    const mounted = [...renderer.Terminal.instances]
    vi.mocked(api.sessions.attach).mockClear(); vi.mocked(api.sessions.detach).mockClear()
    await act(async () => root.render(render(mote)))
    const activate = provider === 'bare URL' ? web.activate : terminal.options.linkHandler!.activate
    await act(async () => activate(new MouseEvent('mouseup', { button: 0, metaKey: true }), 'https://example.test/mote', range))
    expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/mote', 'system', mote)
    await act(async () => activate(pointer(), 'https://example.test/held-mote', range))
    await act(async () => root.render(render(focus)))
    await act(async () => host.querySelector('button[data-destination="right"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openHttp).toHaveBeenLastCalledWith(origin, 'https://example.test/held-mote', 'right', mote)
    expect(renderer.Terminal.instances).toEqual(mounted)
    expect(api.sessions.attach).not.toHaveBeenCalled(); expect(api.sessions.detach).not.toHaveBeenCalled()
  })
  it.each(['bare URL', 'OSC 8'] as const)('%s uses a foreign display occurrence for navigation and keeps OS files in the original resource without rebuilding the terminal', async provider => {
    const reference = { displayWorkspaceId: 'foreign-display', groupId: 'foreign-group', tabId: origin.tabId, regionId: 'another-selected-region' }
    const presentation: WorkbenchPresentation = { active: true, retainedRegionId: null, surface: 'mote', reference, onSelectRegion: vi.fn() }
    const render = (value: WorkbenchPresentation) => <WorkbenchPresentationContext.Provider value={value}>
      <TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />
    </WorkbenchPresentationContext.Provider>
    await act(async () => root.render(render({ ...presentation, reference: undefined })))
    terminal = renderer.Terminal.instances.at(-1)!
    web = renderer.WebLinksAddon.instances.at(-1)!
    const mounted = [...renderer.Terminal.instances]
    const resource = useAppStore.getState().config!.workspaces[0]!
    await act(async () => {
      const config = useAppStore.getState().config!
      useAppStore.setState({ mainSurface: 'agents', config: { ...config,
        hosts: [...config.hosts, { id: 'foreign-host', kind: 'ssh', label: 'Foreign Host', hostname: 'foreign.invalid' } as typeof config.hosts[number]],
        workspaces: [...config.workspaces, { ...resource, id: reference.displayWorkspaceId, hostId: 'foreign-host', path: _hygiene_fixturePath("foreign/display") }] },
        layouts: { [reference.displayWorkspaceId]: createWorkspaceLayout(reference.groupId, [origin.tabId]) } })
      root.render(render(presentation))
    })
    vi.mocked(api.sessions.attach).mockClear(); vi.mocked(api.sessions.detach).mockClear()
    const expectedOrigin = { ...origin, workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId, tabId: reference.tabId }
    const activate = provider === 'bare URL' ? web.activate : terminal.options.linkHandler!.activate
    await act(async () => activate(new MouseEvent('mouseup', { button: 0, metaKey: true }), 'https://example.test/foreign-display', range))
    expect(openHttp).toHaveBeenLastCalledWith(expectedOrigin, 'https://example.test/foreign-display', 'system', presentation)
    await act(async () => activate(pointer(), 'https://example.test/foreign-chooser', range))
    await act(async () => host.querySelector('button[data-destination="right"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openHttp).toHaveBeenLastCalledWith(expectedOrigin, 'https://example.test/foreign-chooser', 'right', presentation)
    await act(async () => root.render(render({ ...presentation, surface: 'space' })))
    const file = await fileLink()
    await act(async () => file.activate(pointer(), file.text))
    expect(openFile).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith('src/example.ts', expect.any(String), { line: 3 }, origin.workspaceId,
      undefined, expect.objectContaining({ resource: { hostId: session.hostId, path: session.workspacePath } }), undefined)
    const artifact = await fileLink('release/Example.dmg')
    await act(async () => artifact.activate(pointer(), artifact.text))
    expect(api.files.openSystem).toHaveBeenCalledWith(origin.workspaceId, 'release/Example.dmg')
    expect(renderer.Terminal.instances).toEqual(mounted)
    expect(api.sessions.attach).not.toHaveBeenCalled(); expect(api.sessions.detach).not.toHaveBeenCalled()
  })
  it.each(['mote', 'survey'] as const)('%s ordinary File links stay in the local Region and consume only the latest callback for the same occurrence', async surface => {
    const reference = { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId: origin.tabId, regionId: origin.regionId }
    const originalSelect = vi.fn(), latestSelect = vi.fn(), foreignSelect = vi.fn()
    const presentation: WorkbenchPresentation = { active: true, retainedRegionId: null, surface, reference, onSelectRegion: originalSelect }
    const render = (value: WorkbenchPresentation) => <WorkbenchPresentationContext.Provider value={value}>
      <TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />
    </WorkbenchPresentationContext.Provider>
    const open = vi.spyOn(sessionLinkOpening, 'openSessionFileLink').mockResolvedValue(undefined)
    await act(async () => root.render(render(presentation)))
    terminal = renderer.Terminal.instances.at(-1)!
    const mounted = [...renderer.Terminal.instances]
    vi.mocked(api.sessions.attach).mockClear(); vi.mocked(api.sessions.detach).mockClear()
    const file = await fileLink()
    await act(async () => file.activate(pointer(), file.text))
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith({ ...origin, sessionId: session.id }, expect.objectContaining({ kind: 'session' }),
      'src/example.ts', { line: 3 }, 'right', surface, expect.objectContaining({ reference, surface }))
    const callback = open.mock.calls[0]![6]!.onSelectRegion!
    await act(async () => root.render(render({ ...presentation, reference: { ...reference, regionId: 'sibling-region' }, onSelectRegion: latestSelect })))
    await act(async () => callback('file-region'))
    expect(latestSelect).toHaveBeenCalledWith('file-region')
    expect(originalSelect).not.toHaveBeenCalled()
    await act(async () => root.render(render({ ...presentation, reference: undefined, onSelectRegion: foreignSelect })))
    await act(async () => callback('unconfirmed-parent-region'))
    expect(foreignSelect).not.toHaveBeenCalled()
    await act(async () => root.render(render({ ...presentation, reference: { ...reference, groupId: 'another-occurrence' }, onSelectRegion: foreignSelect })))
    await act(async () => callback('late-file-region'))
    expect(foreignSelect).not.toHaveBeenCalled()
    expect(latestSelect).toHaveBeenCalledOnce()
    expect(renderer.Terminal.instances).toEqual(mounted)
    expect(api.sessions.attach).not.toHaveBeenCalled(); expect(api.sessions.detach).not.toHaveBeenCalled()
  })
  it('keeps an unaddressed legacy File callback only while both presentations stay unaddressed', async () => {
    const originalSelect = vi.fn(), latestSelect = vi.fn(), addressedSelect = vi.fn()
    const presentation: WorkbenchPresentation = { active: true, retainedRegionId: null, surface: 'space', onSelectRegion: originalSelect }
    const render = (value: WorkbenchPresentation) => <WorkbenchPresentationContext.Provider value={value}>
      <TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />
    </WorkbenchPresentationContext.Provider>
    const open = vi.spyOn(sessionLinkOpening, 'openSessionFileLink').mockResolvedValue(undefined)
    await act(async () => root.render(render(presentation)))
    terminal = renderer.Terminal.instances.at(-1)!
    const file = await fileLink()
    await act(async () => file.activate(pointer(), file.text))
    expect(open).toHaveBeenCalledOnce()
    const callback = open.mock.calls[0]![6]!.onSelectRegion!
    await act(async () => root.render(render({ ...presentation, onSelectRegion: latestSelect })))
    await act(async () => callback('legacy-file-region'))
    expect(latestSelect).toHaveBeenCalledWith('legacy-file-region')
    expect(originalSelect).not.toHaveBeenCalled()
    await act(async () => root.render(render({ ...presentation, onSelectRegion: addressedSelect,
      reference: { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId: origin.tabId, regionId: origin.regionId } })))
    await act(async () => callback('late-legacy-file-region'))
    expect(addressedSelect).not.toHaveBeenCalled()
    expect(latestSelect).toHaveBeenCalledOnce()
  })
  it.each([['region', 'right'], ['tab', 'tab']] as const)('Focus ordinary File links consume the existing %s preference', async (preference, destination) => {
    const presentation: WorkbenchPresentation = { active: true, retainedRegionId: null, surface: 'focus' }
    const open = vi.spyOn(sessionLinkOpening, 'openSessionFileLink').mockResolvedValue(undefined)
    await act(async () => {
      const config = useAppStore.getState().config!
      useAppStore.setState({ mainSurface: 'agents', config: { ...config, focus: { recentActivityHours: 48, linkDestination: preference } } })
      root.render(<WorkbenchPresentationContext.Provider value={presentation}>
        <TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />
      </WorkbenchPresentationContext.Provider>)
    })
    terminal = renderer.Terminal.instances.at(-1)!
    const file = await fileLink()
    await act(async () => file.activate(pointer(), file.text))
    expect(open).toHaveBeenCalledWith({ ...origin, sessionId: session.id }, expect.objectContaining({ kind: 'session' }),
      'src/example.ts', { line: 3 }, destination, 'focus', expect.objectContaining({ surface: 'focus' }))
  })
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
    expect(openFile).toHaveBeenCalledWith('src/example.ts', origin.tabGroupId, { line: 3 }, origin.workspaceId,
      undefined, expect.objectContaining({ resource: { hostId: session.hostId, path: session.workspacePath } }), undefined)
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
    await installCells('\r\n'.repeat(12) + 'src/example.ts:3')
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
  it('suppresses a readout over real dense corner cells without changing the link exit or grid', async () => {
    await installCells(Array.from({ length: 24 }, (_, y) => `history ${y} src/example.ts`).join('\r\n'))
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path'); vi.advanceTimersByTime(500) })
    expect(element.querySelector('[role="tooltip"]')).toBeNull()
    expect(terminal.cellLines).toHaveLength(24)
    expect(terminal.cellLines[23]!.getCell(0)!.getChars()).toBe('h')
    await act(async () => web.activate(new MouseEvent('mouseup', { metaKey: true }), 'https://example.test/path'))
    expect(openHttp).toHaveBeenCalledWith(origin, 'https://example.test/path', 'system', expect.objectContaining({ active: true, retainedRegionId: null }))
    expect(renderer.Terminal.instances).toEqual([terminal]); expect([terminal.cols, terminal.rows]).toEqual([80, 24])
    expect(api.sessions.detach).not.toHaveBeenCalled()
  })
  it('clears before live bytes paint and blocks a new readout throughout a deferred in-flight write', async () => {
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path'); vi.advanceTimersByTime(500) })
    const oldReadout = element.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(oldReadout.style.visibility).toBe('visible')
    let complete!: () => void
    terminal.write.mockImplementation((_data, callback) => { expect(oldReadout.style.visibility).toBe('hidden'); complete = callback })
    const data = new TextEncoder().encode('later bytes')
    await act(async () => {
      receive({ type: 'core', hostId: session.hostId, event: { type: 'terminal-output', run: session.control.run,
        data: 'later bytes', dataBytes: data, evidence: { source: 'terminal-output', observedAt: 2, run: session.control.run,
          outputByteRange: { startByte: 0, endByte: data.byteLength } } } })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(terminal.write).toHaveBeenCalledOnce(); expect(complete).toBeTypeOf('function')
    expect(element.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path'); vi.advanceTimersByTime(500) })
    expect(element.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { complete(); await vi.advanceTimersByTimeAsync(1) })
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/path'); vi.advanceTimersByTime(500) })
    expect(element.querySelector<HTMLElement>('[role="tooltip"]')?.style.visibility).toBe('visible')
    expect(renderer.Terminal.instances).toEqual([terminal])
  })
  it('a disposed owner with an unresolved write cannot suppress or clear the new Terminal owner readout', async () => {
    let completeOldWrite!: () => void
    const oldTerminal = terminal
    oldTerminal.write.mockImplementation((_data, callback) => { completeOldWrite = callback })
    const dataBytes = new TextEncoder().encode('pending old bytes')
    await act(async () => {
      receive({ type: 'core', hostId: session.hostId, event: { type: 'terminal-output', run: session.control.run,
        data: 'pending old bytes', dataBytes, evidence: { source: 'terminal-output', observedAt: 2, run: session.control.run,
          outputByteRange: { startByte: 0, endByte: dataBytes.byteLength } } } })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(oldTerminal.write).toHaveBeenCalledOnce(); expect(completeOldWrite).toBeTypeOf('function')
    await act(async () => { root.render(<TerminalView session={session} themeId="catppuccin-mocha" interactiveResize={false} linkOrigin={origin} autoFocus={false} />) })
    expect(oldTerminal.dispose).toHaveBeenCalledOnce(); expect(renderer.Terminal.instances).toHaveLength(2)
    terminal = renderer.Terminal.instances[1]!; web = renderer.WebLinksAddon.instances[1]!
    await installCells('new owner')
    await act(async () => { web.callbacks.hover(new MouseEvent('mousemove', { clientX: 50, clientY: 80 }), 'https://example.test/new'); vi.advanceTimersByTime(500) })
    const readout = element.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(readout?.style.visibility).toBe('visible'); expect(readout.textContent).toContain('https://example.test/new')
    // Real xterm disposal may drop this callback forever. If it arrives, it still belongs to the old owner.
    await act(async () => { completeOldWrite(); await vi.advanceTimersByTimeAsync(1) })
    expect(element.querySelector('[role="tooltip"]')).toBe(readout)
    expect(readout.style.visibility).toBe('visible')
  })
  for (const action of ['leave', 'press', 'selection', 'wheel', 'scroll', 'hide', 'font', 'resize'] as const) {
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
          if (action === 'font') root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} fontSize={18} autoFocus={false} />)
          if (action === 'resize') resized()
          vi.advanceTimersByTime(500)
        })
        expect(element.querySelector('[role="tooltip"]')).toBeNull()
        terminal.selection = ''
        if (action === 'hide') await act(async () => { root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} visible autoFocus={false} />) })
        if (action === 'font') await act(async () => { root.render(<TerminalView session={session} themeId="graphite" interactiveResize={false} linkOrigin={origin} autoFocus={false} />) })
      }
    })
  }
})
