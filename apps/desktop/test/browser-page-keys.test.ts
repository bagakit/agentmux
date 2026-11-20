// @vitest-environment happy-dom
import { tmpdir } from 'node:os'
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_KEY_CHANNEL, type AppConfig, type BrowserPageKeyEvent } from '../src/shared/contracts.js'
import { browserPageShortcut, type BrowserPageKeyInput } from '../src/shared/browser-page-shortcuts.js'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return { views: [] as any[] }
})
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {} })
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    getURL() { return this.url } getTitle() { return 'Current native document' }
    isLoading() { return false } isDestroyed() { return this.destroyed } isFocused() { return false }
    getBackgroundThrottling() { return true } setBackgroundThrottling() {}
    async capturePage() { return { isEmpty: () => true } }
    setWindowOpenHandler() {} setZoomFactor() {} getZoomFactor() { return 1 }
    disableDeviceEmulation() {} enableDeviceEmulation() {}
    async executeJavaScriptInIsolatedWorld() { return true }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.url = url
      this.emit('did-navigate', {}, url)
      this.emit('dom-ready')
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed', {}) }
  }
  return {
    app: { getPath: () => tmpdir() },
    WebContentsView: class {
      webContents = new Contents()
      visible = false
      bounds = { x: 0, y: 0, width: 0, height: 0 }
      setVisible(value: boolean) { this.visible = value } setBounds(value: typeof this.bounds) { this.bounds = value }
      getVisible() { return this.visible } getBounds() { return this.bounds }
      constructor() { fixture.views.push(this) }
    }
  }
})

import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { BrowserPresentationStage, useBrowserPresentationCapture, type BrowserStagePresentation, type WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage.js'
import { claimSurfaceChords } from '../src/renderer/src/lib/surface-chord-owners.js'
import { api } from '../src/renderer/src/lib/api.js'
import { isMacPlatform } from '../src/renderer/src/lib/host-platform.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

const CHORDS = [['l', 'focus-address'], ['r', 'reload'], ['f', 'find']] as const

describe('one exact chord match for the page and its chrome', () => {
  const input = (key: string, modifiers: Partial<BrowserPageKeyInput> = {}): BrowserPageKeyInput =>
    ({ key, meta: false, control: false, shift: false, alt: false, ...modifiers })

  it('takes bare Cmd+L, R and F on macOS and Ctrl elsewhere, and nothing wider', () => {
    for (const [key, action] of CHORDS) {
      expect(browserPageShortcut(input(key, { meta: true }), true)).toBe(action)
      expect(browserPageShortcut(input(key.toUpperCase(), { meta: true }), true), 'Caps Lock is the same chord').toBe(action)
      expect(browserPageShortcut(input(key, { control: true }), false)).toBe(action)
      for (const wider of [{}, { control: true }, { meta: true, control: true }, { meta: true, shift: true }, { meta: true, alt: true }]) {
        expect(browserPageShortcut(input(key, wider), true), `macOS ${key} ${JSON.stringify(wider)}`).toBeNull()
      }
      for (const wider of [{}, { meta: true }, { meta: true, control: true }, { control: true, shift: true }, { control: true, alt: true }]) {
        expect(browserPageShortcut(input(key, wider), false), `other ${key} ${JSON.stringify(wider)}`).toBeNull()
      }
    }
    expect(browserPageShortcut(input('g', { meta: true }), true)).toBeNull()
    expect(browserPageShortcut(input('Enter', { control: true }), false)).toBeNull()
  })
})

// Main: the actual BrowserViewManager with only Electron's native views replaced.
const mac = process.platform === 'darwin'
const primary = mac ? { meta: true } : { control: true }
const otherPrimary = mac ? { control: true } : { meta: true }
const press = (key: string, modifiers: { meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean; isComposing?: boolean; type?: string } = {}) =>
  ({ type: 'keyDown', key, code: '', isAutoRepeat: false, isComposing: false, meta: false, control: false, shift: false, alt: false, ...modifiers })

function pages() {
  fixture.views = []
  const host = { isDestroyed: () => false, send: vi.fn(), focus: vi.fn() }
  const window = { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: { addChildView() {}, removeChildView() {} }, webContents: host }
  const manager = new BrowserViewManager(window as any, { defaultProfileId: () => 'default', resolvePartition: () => 'persist:private-page-keys' },
    new BrowserRefLedgerStore('unused-page-keys-ledger'), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  const entries = Reflect.get(manager, 'entries') as Map<string, any>
  const key = (index: number, input: object) => {
    const event = { preventDefault: vi.fn() }
    fixture.views[index].webContents.emit('before-input-event', event, input)
    return event.preventDefault
  }
  const routed = () => host.send.mock.calls.filter(([channel]) => channel === BROWSER_PAGE_KEY_CHANNEL).map(([, event]) => event)
  return { manager, host, entries, key, routed }
}

describe("Main's native key entry", () => {
  it('consumes the three chords on a shown page and hands them to that exact Browser workface', async () => {
    const { manager, host, key, routed } = pages()
    try {
      await manager.create('left', 'https://example.invalid/left')
      await manager.create('right', 'https://example.invalid/right')
      manager.setBounds('left', { x: 0, y: 70, width: 300, height: 300 })
      manager.setBounds('right', { x: 300, y: 70, width: 300, height: 300 })
      let focused = 0
      for (const [letter, action] of CHORDS) {
        expect(key(1, press(letter, primary)), `${action} does not reach the page`).toHaveBeenCalledOnce()
        expect(routed().at(-1)).toEqual({ browserId: 'right', leaseId: null, action } satisfies BrowserPageKeyEvent)
        if (action !== 'reload') focused++
        expect(host.focus, 'the address box and find row take keyboard focus; reload leaves it on the page').toHaveBeenCalledTimes(focused)
      }
      expect(routed()).toHaveLength(3)
    } finally { manager.dispose() }
  })

  it('passes every other key, wider chord, key up and IME composition to the page unchanged', async () => {
    const { manager, host, key, routed } = pages()
    try {
      await manager.create('page', 'https://example.invalid/')
      manager.setBounds('page', { x: 0, y: 70, width: 400, height: 300 })
      for (const input of [press('f'), press('g', primary), press('f', otherPrimary), press('f', { ...primary, ...otherPrimary }),
        press('f', { ...primary, shift: true }), press('r', { ...primary, alt: true }), press('l', { ...primary, isComposing: true }),
        press('f', { ...primary, type: 'keyUp' }), press('Escape')]) {
        expect(key(0, input), JSON.stringify(input)).not.toHaveBeenCalled()
      }
      expect(routed()).toEqual([])
      expect(host.focus).not.toHaveBeenCalled()
    } finally { manager.dispose() }
  })

  it('routes nothing while an Agent controls the page; an isolated page keeps its original isolation', async () => {
    const { manager, entries, key, routed } = pages()
    try {
      await manager.create('page', 'https://example.invalid/')
      manager.setBounds('page', { x: 0, y: 70, width: 400, height: 300 })
      const entry = entries.get('page'), shield = entry.inputShield
      entry.activity = { ...entry.activity, control: 'agent' }
      expect(key(0, press('r', primary)), 'the key goes where it was going').not.toHaveBeenCalled()
      entry.inputShield = { isolated: true, contents: { focus: vi.fn() } }
      expect(key(0, press('r', primary)), 'the original isolation still holds it').toHaveBeenCalledOnce()
      entry.inputShield = shield
      expect(routed()).toEqual([])
    } finally { manager.dispose() }
  })

  it('routes only from a page a Browser workface actually shows', async () => {
    const { manager, entries, key, routed } = pages()
    try {
      await manager.create('page', 'https://example.invalid/')
      expect(key(0, press('f', primary)), 'a page that is not shown').not.toHaveBeenCalled()
      manager.setBounds('page', { x: 0, y: 70, width: 400, height: 300 })
      const entry = entries.get('page'), leases = Reflect.get(manager, 'presentationLeases') as Map<string, unknown>
      const lease = (location: object) => ({ id: 'lease-1', entry, occurrence: { presentationId: 'presentation-1', location },
        geometry: { visible: true, bounds: { x: 0, y: 70, width: 400, height: 300 } } })
      entry.inputLeaseId = 'lease-1'
      expect(key(0, press('f', primary)), 'a presentation Main no longer knows').not.toHaveBeenCalled()
      leases.set('lease-1', lease({ kind: 'inline' }))
      expect(key(0, press('f', primary)), 'an inline card has no address box or find row').not.toHaveBeenCalled()
      leases.set('lease-1', lease({ displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }))
      expect(key(0, press('f', primary))).toHaveBeenCalledOnce()
      expect(routed()).toEqual([{ browserId: 'page', leaseId: 'lease-1', action: 'find' }])
      leases.delete('lease-1')
      entry.inputLeaseId = null
    } finally { manager.dispose() }
  })
})

// Renderer: the real BrowserPane with Main replaced at the preload boundary.
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const tab = {
  id: 'browser-1', navigationId: 'navigation-1', browserId: 'browser-1', regionId: 'region-1', workspaceId: 'workspace-1',
  kind: 'browser' as const, mode: 'normal' as const, profileId: 'profile-1', url: 'https://example.test/', title: 'Example',
  loading: false, canGoBack: true, canGoForward: true, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
}

async function mountPane() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(BrowserPane, { tab, visible: true })))
  const address = () => container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  const cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  return { container, address, cleanup }
}

describe('BrowserPane acts on the page keys of its own page', () => {
  beforeEach(() => { useAppStore.setState({ config: structuredClone(config) }) })
  afterEach(() => vi.restoreAllMocks())

  it('focuses and selects the address, reloads, or opens find for exactly its Browser', async () => {
    const listeners = new Set<(event: BrowserPageKeyEvent) => void>()
    vi.spyOn(api.browser, 'onPageKey').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
    const reload = vi.spyOn(api.browser, 'reload').mockReturnValue(new Promise(() => {}))
    const pane = await mountPane()
    const emit = (event: BrowserPageKeyEvent) => act(async () => { for (const listener of listeners) listener(event) })
    try {
      await emit({ browserId: 'other-browser', leaseId: null, action: 'focus-address' })
      await emit({ browserId: 'browser-1', leaseId: 'a-presentation-lease', action: 'focus-address' })
      expect(document.activeElement, 'another Browser or presentation is not this pane').not.toBe(pane.address())
      await emit({ browserId: 'browser-1', leaseId: null, action: 'focus-address' })
      expect(document.activeElement).toBe(pane.address())
      expect([pane.address().selectionStart, pane.address().selectionEnd]).toEqual([0, pane.address().value.length])
      await emit({ browserId: 'browser-1', leaseId: null, action: 'reload' })
      expect(reload).toHaveBeenCalledExactlyOnceWith('browser-1')
      await emit({ browserId: 'browser-1', leaseId: null, action: 'find' })
      expect(document.activeElement).toBe(pane.container.querySelector('.browser-find input'))
    } finally { await pane.cleanup() }
    expect(listeners.size, 'the pane stops listening when it goes away').toBe(0)
  })

  it('takes the same chords from its own toolbar and does not repeat a reload in flight', async () => {
    const reload = vi.spyOn(api.browser, 'reload').mockReturnValue(new Promise(() => {}))
    const pane = await mountPane()
    const chord = (key: string) => act(async () => {
      pane.container.querySelector<HTMLElement>('.browser-toolbar button')!.dispatchEvent(new KeyboardEvent('keydown',
        { key, bubbles: true, cancelable: true, metaKey: isMacPlatform(), ctrlKey: !isMacPlatform() }))
    })
    try {
      await chord('l')
      expect(document.activeElement).toBe(pane.address())
      await chord('r')
      await chord('r')
      expect(reload).toHaveBeenCalledExactlyOnceWith('browser-1')
    } finally { await pane.cleanup() }
  })

  it('leaves a chord to a surface inside it that claims it, or a control inside that already handled it', async () => {
    const reload = vi.spyOn(api.browser, 'reload').mockReturnValue(new Promise(() => {}))
    const pane = await mountPane()
    const surface = pane.container.querySelector<HTMLElement>('.browser-preview')!
    const release = claimSurfaceChords(surface, event => event.key.toLowerCase() === 'l')
    const chord = async (key: string) => {
      let delivered = true
      await act(async () => {
        delivered = surface.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown',
          { key, bubbles: true, cancelable: true, metaKey: isMacPlatform(), ctrlKey: !isMacPlatform() }))
      })
      return delivered
    }
    try {
      expect(await chord('l'), 'the claiming surface keeps its chord').toBe(true)
      expect(document.activeElement).not.toBe(pane.address())
      const handled = (event: Event) => event.preventDefault()
      surface.firstElementChild!.addEventListener('keydown', handled)
      await chord('f')
      surface.firstElementChild!.removeEventListener('keydown', handled)
      expect(pane.container.querySelector('.browser-find'), 'a key a control inside already handled is not acted on again').toBeNull()
      expect(await chord('r'), 'a chord the surface did not claim still reaches the Browser').toBe(false)
      expect(reload).toHaveBeenCalledExactlyOnceWith('browser-1')
    } finally { release(); await pane.cleanup() }
  })
})

describe('a presentation acts only on the page keys of the lease that holds the page', () => {
  beforeEach(() => { useAppStore.setState({ config: structuredClone(config) }) })
  afterEach(() => vi.restoreAllMocks())

  const presentation = (id: string): WorkbenchBrowserPresentation => ({
    occurrence: { presentationId: id, location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: id } },
    stageHostId: id, visible: true, active: true, yieldToFocusRing: false, target: { hostId: id, surface: 'space', active: true }
  })
  const inlineCard: BrowserStagePresentation = { ...presentation('inline'), occurrence: { presentationId: 'inline', location: { kind: 'inline' } } }
  /** Main's presentation bridge: each registration gets `lease-<presentation id>`, and page keys come from `emit`. */
  function presentationBridge() {
    const listeners = new Set<(event: BrowserPageKeyEvent) => void>()
    const subscribe = vi.spyOn(api.browser, 'onPageKey').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
    vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => ({ leaseId: `lease-${request.occurrence.presentationId}` }) as never)
    vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue()
    vi.spyOn(api.browser, 'removePresentation').mockResolvedValue()
    vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' } as never)
    vi.spyOn(api.browser, 'armPresentationCapture').mockReturnValue(new Promise(() => {}))
    vi.spyOn(api.browser, 'onPresentationEvent').mockReturnValue(() => {})
    const emit = (event: BrowserPageKeyEvent) => act(async () => { for (const listener of listeners) listener(event) })
    return { listeners, subscribe, emit }
  }
  async function mountRegistered(element: ReturnType<typeof createElement>) {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(element))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove() } }
  }

  it('reaches the presentation whose lease Main named, and one without page actions never listens', async () => {
    const bridge = presentationBridge()
    const actions = { a: vi.fn(), b: vi.fn() }
    function Stages() {
      const media = useBrowserPresentationCapture('browser-1')
      return createElement('div', null, ...(['a', 'b', 'inline'] as const).map(id => createElement(BrowserPresentationStage, {
        key: id, browserId: 'browser-1', navigationId: 'navigation-1', presentation: id === 'inline' ? inlineCard : presentation(id), inputSelected: id === 'a', blocked: false, media,
        ...(id === 'inline' ? {} : { onPageKey: actions[id] })
      })))
    }
    const stages = await mountRegistered(createElement(Stages))
    try {
      expect(bridge.subscribe, 'an inline card without page actions does not listen').toHaveBeenCalledTimes(2)
      await bridge.emit({ browserId: 'browser-1', leaseId: 'lease-b', action: 'find' })
      expect(actions.b).toHaveBeenCalledExactlyOnceWith('find')
      await bridge.emit({ browserId: 'browser-1', leaseId: null, action: 'reload' })
      await bridge.emit({ browserId: 'other-browser', leaseId: 'lease-a', action: 'reload' })
      await bridge.emit({ browserId: 'browser-1', leaseId: 'lease-inline', action: 'reload' })
      expect(actions.a, 'a page placed directly, another Browser or another lease is not this presentation').not.toHaveBeenCalled()
      expect(actions.b).toHaveBeenCalledOnce()
    } finally { await stages.cleanup() }
    expect(bridge.listeners.size).toBe(0)
  })

  it('BrowserPane shown through a presentation acts in that presentation, not as a directly placed page', async () => {
    const bridge = presentationBridge()
    const reload = vi.spyOn(api.browser, 'reload').mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
    try {
      const pane = await mountRegistered(createElement(BrowserPane, { tab, visible: true, presentations: [presentation('a')], presentationTargetId: 'a' }))
      const address = () => pane.container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')
      try {
        await bridge.emit({ browserId: 'browser-1', leaseId: null, action: 'focus-address' })
        await bridge.emit({ browserId: 'browser-1', leaseId: null, action: 'reload' })
        expect(document.activeElement, 'a page placed directly is not this presentation').not.toBe(address())
        expect(reload).not.toHaveBeenCalled()
        await bridge.emit({ browserId: 'browser-1', leaseId: 'lease-a', action: 'reload' })
        expect(reload).toHaveBeenCalledExactlyOnceWith('browser-1')
        await bridge.emit({ browserId: 'browser-1', leaseId: 'lease-a', action: 'focus-address' })
        expect(document.activeElement).toBe(address())
        await bridge.emit({ browserId: 'browser-1', leaseId: 'lease-a', action: 'find' })
        expect(document.activeElement).toBe(pane.container.querySelector('.browser-find input'))
      } finally { await pane.cleanup() }
    } finally { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) }
  })
})
