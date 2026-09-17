// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { SessionSnapshot } from '../src/shared/contracts'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { observeOverlays } from '../src/renderer/src/lib/native-surface-overlay'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

type FixtureTerminal = HeadlessTerminal & { element?: HTMLElement }
type FixtureObserver = { targets: Set<Element>; callback: ResizeObserverCallback }
const fixture = vi.hoisted(() => ({
  terminals: [] as FixtureTerminal[],
  fit: vi.fn(), resize: vi.fn(), attach: vi.fn(), detach: vi.fn(),
  webglCreated: 0, webglDisposed: 0,
  proposed: { cols: 80, rows: 24 },
  pixels: { width: 800, height: 480 },
  frames: new Map<number, FrameRequestCallback>(), nextFrame: 0,
  observers: [] as FixtureObserver[]
}))
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

// The real parser, TerminalView and its viewport synchronizer remain mounted. Only the browser
// rendering adapters have controlled cell metrics: this reproduces a metric change at unchanged
// CSS pixels, without inventing another resize policy in the test.
vi.mock('@xterm/xterm', async () => {
  const { Terminal } = await import('@xterm/headless')
  return { Terminal: class extends Terminal {
    element?: HTMLElement
    constructor(options: ConstructorParameters<typeof Terminal>[0]) {
      super(options)
      fixture.terminals.push(this as FixtureTerminal)
    }
    open(root: HTMLElement) {
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      root.append(this.element)
      root.getBoundingClientRect = () => ({ ...fixture.pixels, x: 0, y: 0, top: 0, left: 0,
        right: fixture.pixels.width, bottom: fixture.pixels.height, toJSON() {} })
    }
    focus() {}
    refresh() {}
    onRender() { return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
    getSelection() { return '' }
    hasSelection() { return false }
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
  } }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  private terminal?: FixtureTerminal
  activate(terminal: FixtureTerminal) { this.terminal = terminal }
  dispose() {}
  fit() { fixture.fit(); this.terminal?.resize(fixture.proposed.cols, fixture.proposed.rows) }
  proposeDimensions() { return { ...fixture.proposed } }
} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  activate() {}
  dispose() {}
  onDidChangeResults() { return { dispose() {} } }
} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} dispose() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {
  constructor() { fixture.webglCreated += 1 }
  activate() {}
  dispose() { fixture.webglDisposed += 1 }
  onContextLoss() { return { dispose() {} } }
} }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { sessions: {
  attach: fixture.attach, detach: fixture.detach, resize: fixture.resize,
  acknowledge: vi.fn().mockResolvedValue(undefined),
  onEvent: () => () => {}
} } }))
// SessionPane contributes agent chrome. The Workbench's actual visibility decision is forwarded
// unchanged into the production TerminalView, the same seam SessionPane owns in the application.
vi.mock('../src/renderer/src/components/SessionPane', async () => {
  const { TerminalView } = await import('../src/renderer/src/components/TerminalView')
  return { SessionPane: ({ sessionId, visible, interactiveResize, linkOrigin }: {
    sessionId: string; visible: boolean; interactiveResize: boolean; linkOrigin: never
  }) => <TerminalView session={useAppStore.getState().sessions.find((s) => s.id === sessionId)!}
    themeId="graphite" visible={visible} interactiveResize={interactiveResize}
    autoFocus={false} linkOrigin={linkOrigin} /> }
})
vi.mock('../src/renderer/src/components/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => children
}))
// These adapters expose exactly the visibility the real recursive Workbench tree gives each
// surface. Native Browser bounds/IPC behavior is covered by its existing owner tests.
vi.mock('../src/renderer/src/components/BrowserPane', () => ({
  BrowserPane: ({ visible }: { visible: boolean }) => <div data-fixture-browser data-visible={String(visible)} />
}))
vi.mock('../src/renderer/src/components/EditorPane', () => ({
  EditorPane: ({ visible, surface }: { visible: boolean; surface: { path: string } }) =>
    <div data-fixture-editor={surface.path} data-visible={String(visible)} />
}))
vi.mock('../src/renderer/src/components/NewTabSurface', () => ({
  NewTabSurface: ({ visible }: { visible: boolean }) => <div data-fixture-launcher data-visible={String(visible)} />
}))

const session: SessionSnapshot = {
  id: 'session-hover', hostId: 'local', workspacePath: '/fixture', label: 'Hover fixture',
  createdAt: 1, updatedAt: 1, processState: 'running',
  status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
  kind: 'terminal', providerId: null,
  control: { kind: 'terminal', hostId: 'local', runId: 'run-hover', run: { runId: 'run-hover' } }
}
let root: Root | null = null
let container: HTMLElement
let disconnect: (() => void) | undefined

function renderWorkbench(visible = true): ReactNode {
  return <><WorkspaceWorkbench workspaceId="workspace-hover" visible={visible} /><SurfaceSwitch onOpenSettings={() => {}} /></>
}
function observeTerminalViewport(terminal: FixtureTerminal): void {
  const target = terminal.element!.parentElement!
  const owners = fixture.observers.filter((observer) => observer.targets.has(target))
  expect(owners, 'the mounted TerminalView owns a real ResizeObserver subscription').toHaveLength(1)
  for (const observer of owners) observer.callback([], {} as ResizeObserver)
}
function surfaceVisibility(): Record<string, string | undefined> {
  return {
    browser: container.querySelector<HTMLElement>('[data-fixture-browser]')?.dataset.visible,
    editor: container.querySelector<HTMLElement>('[data-fixture-editor="visible.txt"]')?.dataset.visible,
    inactiveEditor: container.querySelector<HTMLElement>('[data-fixture-editor="inactive.txt"]')?.dataset.visible,
    launcher: container.querySelector<HTMLElement>('[data-fixture-launcher]')?.dataset.visible
  }
}
async function frames(): Promise<void> {
  for (let i = 0; i < 20 && fixture.frames.size; i += 1) {
    const pending = [...fixture.frames.values()]
    fixture.frames.clear()
    await act(async () => { for (const callback of pending) callback(i * 16) })
  }
  expect(fixture.frames.size, 'the production viewport reached a settled frame').toBe(0)
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++fixture.nextFrame
    fixture.frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => fixture.frames.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) { fixture.observers.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  fixture.terminals.length = 0
  fixture.frames.clear()
  fixture.observers.length = 0
  fixture.proposed = { cols: 80, rows: 24 }
  fixture.pixels = { width: 800, height: 480 }
  fixture.webglCreated = 0
  fixture.webglDisposed = 0
  vi.clearAllMocks()
  fixture.attach.mockResolvedValue({ attachmentId: 'attachment-hover', currentSize: { cols: 80, rows: 24 },
    gap: null, replay: [] })
  fixture.detach.mockResolvedValue(undefined)
  fixture.resize.mockImplementation(async (_lease: string, cols: number, rows: number) => ({ cols, rows }))
  const tab = createWorkbenchTab('tab-hover', { regionId: 'region-hover', workspaceId: 'workspace-hover',
    kind: 'terminal', phase: 'attached', sessionId: session.id })
  tab.regions['region-browser'] = { regionId: 'region-browser', workspaceId: 'workspace-hover', kind: 'browser',
    browserId: 'browser-hover', id: 'browser-hover', navigationId: 'navigation-hover', profileId: 'default',
    url: 'https://fixture.invalid/', title: 'Browser fixture', loading: false, canGoBack: false, canGoForward: false,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }
  tab.regions['region-launcher'] = { regionId: 'region-launcher', workspaceId: 'workspace-hover', kind: 'launcher' }
  tab.layout.root = { type: 'split', direction: 'horizontal', ratio: 0.5,
    first: { type: 'leaf', regionId: 'region-hover' }, second: { type: 'split', direction: 'vertical', ratio: 0.5,
      first: { type: 'leaf', regionId: 'region-browser' }, second: { type: 'leaf', regionId: 'region-launcher' } } }
  const editor = createWorkbenchTab('tab-editor', { regionId: 'region-editor', workspaceId: 'workspace-hover',
    kind: 'file', path: 'visible.txt' })
  const inactive = createWorkbenchTab('tab-inactive', { regionId: 'region-inactive', workspaceId: 'workspace-hover',
    kind: 'file', path: 'inactive.txt' })
  const layout = createWorkspaceLayout('group-hover', [tab.id])
  layout.root = { type: 'split', direction: 'horizontal', ratio: 0.5,
    first: layout.root, second: { type: 'leaf', groupId: 'group-editor' } }
  layout.groups.push({ id: 'group-editor', tabOrder: [editor.id, inactive.id], activeTabId: editor.id,
    recentTabIds: [editor.id] })
  useAppStore.setState({ config: null, mainSurface: 'workbench', sessions: [session],
    tabs: { [tab.id]: tab, [editor.id]: editor, [inactive.id]: inactive }, layouts: { 'workspace-hover': layout },
    portalOverlayCount: 0, nativeSurfaceOverlayCount: 0 })
  container = document.createElement('div')
  container.id = 'root'
  document.body.append(container)
  root = createRoot(container)
  disconnect = observeOverlays(document.body, useAppStore.getState().setPortalOverlayCount, MutationObserver)
  await act(async () => {
    root!.render(renderWorkbench())
  })
  await frames()
  expect(fixture.terminals).toHaveLength(1)
  expect(fixture.resize).toHaveBeenCalledWith('attachment-hover', 80, 24)
  expect(surfaceVisibility()).toEqual({ browser: 'true', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  fixture.resize.mockClear()
  fixture.fit.mockClear()
})
afterEach(async () => {
  disconnect?.()
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('hovering Work preserves terminal pixels, parser grid, PTY size and the existing GPU owner', async () => {
  const terminal = fixture.terminals[0]!
  const pixels = terminal.element!.parentElement!.getBoundingClientRect()
  const work = container.querySelector('button[aria-label^="Work:"]') as HTMLButtonElement
  expect(work).toBeTruthy()
  // A one-column cell-metric wobble at identical pixels is already rejected by the production
  // synchronizer. An unrelated tooltip must not clear that settled pixel baseline.
  fixture.proposed = { cols: 79, rows: 24 }
  await act(async () => observeTerminalViewport(terminal))
  await frames()
  expect(fixture.resize).not.toHaveBeenCalled()
  expect(fixture.fit).not.toHaveBeenCalled()
  await new Promise<void>((resolve) => terminal.write(Array.from({ length: 60 }, (_, i) => `line-${i}\r\n`).join(''), resolve))
  terminal.scrollToLine(5)
  expect(terminal.buffer.active.baseY).toBeGreaterThan(5)
  expect(terminal.buffer.active.viewportY).toBe(5)
  await act(async () => work.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().portalOverlayCount).toBe(1)) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Show requests and ideas')
  expect(surfaceVisibility()).toEqual({ browser: 'false', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  await act(async () => work.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().portalOverlayCount).toBe(0)) })
  await frames()
  expect(terminal.element!.parentElement!.getBoundingClientRect()).toMatchObject({
    width: pixels.width, height: pixels.height, left: pixels.left, top: pixels.top
  })
  expect.soft(fixture.fit, 'hover must not refit an unchanged container').not.toHaveBeenCalled()
  expect.soft({ cols: terminal.cols, rows: terminal.rows }, 'the real parser grid stays settled').toEqual({ cols: 80, rows: 24 })
  expect.soft(fixture.resize, 'a tooltip cannot rewrite authoritative PTY dimensions').not.toHaveBeenCalled()
  expect.soft(fixture.webglCreated, 'a visible terminal retains its GPU owner through hover').toBe(1)
  expect.soft(fixture.webglDisposed).toBe(0)
  expect(terminal.buffer.active.viewportY).toBe(5)
  expect(surfaceVisibility()).toEqual({ browser: 'true', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(fixture.detach).not.toHaveBeenCalled()
  expect(useAppStore.getState().mainSurface).toBe('workbench')
})

it('opening and dismissing the real Split menu only occludes the native Browser', async () => {
  const terminal = fixture.terminals[0]!
  fixture.proposed = { cols: 79, rows: 24 }
  const trigger = container.querySelector('button[aria-label="Choose split direction"]') as HTMLButtonElement
  expect(trigger).toBeTruthy()
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', {
    bubbles: true, pointerType: 'mouse', buttons: 0
  })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().portalOverlayCount).toBe(1)) })
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.textContent).toContain('Split Right')
  expect(surfaceVisibility()).toEqual({ browser: 'false', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  expect(fixture.webglDisposed).toBe(0)
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => { await vi.waitFor(() => expect(useAppStore.getState().portalOverlayCount).toBe(0)) })
  await frames()
  expect(surfaceVisibility()).toEqual({ browser: 'true', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 80, rows: 24 })
  expect(fixture.fit).not.toHaveBeenCalled()
  expect(fixture.resize).not.toHaveBeenCalled()
  expect(fixture.webglCreated).toBe(1)
  expect(fixture.webglDisposed).toBe(0)
  expect(fixture.attach).toHaveBeenCalledOnce()
  expect(fixture.detach).not.toHaveBeenCalled()
})

it('a real Region size change synchronizes the existing parser and PTY even while Browser occlusion is leased', async () => {
  const terminal = fixture.terminals[0]!
  await act(async () => useAppStore.getState().acquireNativeSurfaceOverlay())
  expect(surfaceVisibility()).toEqual({ browser: 'false', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  fixture.pixels = { width: 900, height: 600 }
  fixture.proposed = { cols: 90, rows: 30 }
  await act(async () => observeTerminalViewport(terminal))
  await frames()
  expect(fixture.fit).toHaveBeenCalledOnce()
  expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 90, rows: 30 })
  expect(fixture.resize).toHaveBeenCalledExactlyOnceWith('attachment-hover', 90, 30)
  await act(async () => useAppStore.getState().releaseNativeSurfaceOverlay())
  await frames()
  expect(surfaceVisibility()).toEqual({ browser: 'true', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  expect(fixture.resize).toHaveBeenCalledOnce()
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.webglCreated).toBe(1)
  expect(fixture.webglDisposed).toBe(0)
  expect(fixture.detach).not.toHaveBeenCalled()
})

it('an actually hidden Workbench still parks its surfaces and catches up real geometry on reveal', async () => {
  const terminal = fixture.terminals[0]!
  await act(async () => root!.render(renderWorkbench(false)))
  expect(surfaceVisibility()).toEqual({ browser: 'false', editor: 'false', inactiveEditor: 'false', launcher: 'false' })
  expect(fixture.webglDisposed).toBe(1)
  fixture.pixels = { width: 1000, height: 700 }
  fixture.proposed = { cols: 100, rows: 35 }
  await act(async () => observeTerminalViewport(terminal))
  await frames()
  expect(fixture.resize).not.toHaveBeenCalled()
  expect(fixture.fit).not.toHaveBeenCalled()
  await act(async () => root!.render(renderWorkbench(true)))
  await frames()
  expect(surfaceVisibility()).toEqual({ browser: 'true', editor: 'true', inactiveEditor: 'false', launcher: 'true' })
  expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 100, rows: 35 })
  expect(fixture.resize).toHaveBeenCalledExactlyOnceWith('attachment-hover', 100, 35)
  expect(fixture.terminals).toEqual([terminal])
  expect(fixture.webglCreated).toBe(2)
  expect(fixture.webglDisposed).toBe(1)
  expect(fixture.attach).toHaveBeenCalledExactlyOnceWith(session.control, 0)
  expect(fixture.detach).not.toHaveBeenCalled()
})
