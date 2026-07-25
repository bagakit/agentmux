import { describe, expect, it, vi } from 'vitest'

function png(width = 2, height = 3): Buffer {
  const value = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.writeUInt32BE(13, 8)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  value[24] = 8
  value[25] = 6
  return value
}

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    zoomFactor = 1
    deviceEmulation: Record<string, unknown> | null = null
    readonly disableDeviceEmulation = vi.fn(() => { this.deviceEmulation = null })
    readonly enableDeviceEmulation = vi.fn((parameters: Record<string, unknown>) => {
      this.deviceEmulation = parameters
    })
    readonly openDevTools = vi.fn()
    executeJavaScriptInIsolatedWorldImpl = async (_worldId: number, scripts: Array<{ code: string }>) =>
      scripts[0]?.code.includes('Select an element') ? null : true
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async (
      worldId: number,
      scripts: Array<{ code: string }>
    ) => await this.executeJavaScriptInIsolatedWorldImpl(worldId, scripts))
    capturePageImpl = async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => png()
    })
    readonly capturePage = vi.fn(async () => await this.capturePageImpl())
    readonly session = {
      checkHandler: null as null | ((...args: any[]) => boolean),
      requestHandler: null as null | ((...args: any[]) => void),
      setPermissionCheckHandler: vi.fn((handler: (...args: any[]) => boolean) => {
        this.session.checkHandler = handler
      }),
      setPermissionRequestHandler: vi.fn((handler: (...args: any[]) => void) => {
        this.session.requestHandler = handler
      })
    }
    readonly listeners = new Map<string, Listener[]>()
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn()
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }

    removeListener(event: string, listener: Listener) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const listener of this.listeners.get(event) ?? []) listener({}, ...args)
    }

    emitDetails(event: string, details: Record<string, unknown>) {
      for (const listener of this.listeners.get(event) ?? []) listener(details)
    }

    setWindowOpenHandler() {}
    setZoomFactor(value: number) { this.zoomFactor = value }

    async loadURL(url: string) {
      this.loading = true
      this.emitDetails('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.url = url
      this.title = url === 'about:blank' ? '' : new URL(url).hostname
      this.emit('did-navigate', url)
      this.loading = false
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }

    getURL() { return this.url }
    getTitle() { return this.title }
    isLoading() { return this.loading }
    isDestroyed() { return this.destroyed }
    reload() {
      this.emitDetails('did-start-navigation', { url: this.url, isSameDocument: false, isMainFrame: true })
      this.emit('did-start-loading')
      this.zoomFactor = 1
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
    }
    close() { this.destroyed = true; this.emit('destroyed') }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    readonly webContents = new FakeWebContents()
    visible = true
    bounds = { x: 0, y: 0, width: 0, height: 0 }

    constructor() {
      FakeWebContentsView.instances.push(this)
    }

    setVisible(value: boolean) { this.visible = value }
    setBounds(value: typeof this.bounds) { this.bounds = value }
  }

  return { FakeWebContentsView }
})

vi.mock('electron', () => ({ WebContentsView: fakeElectron.FakeWebContentsView }))

import {
  assertAllowedBrowserUrl,
  BrowserViewManager,
  DEFAULT_BROWSER_ZOOM_FACTOR,
  normalizeBrowserUrl
} from '../src/main/browser-view-manager.js'

function fakeWindow() {
  const children: InstanceType<typeof fakeElectron.FakeWebContentsView>[] = []
  const sent: unknown[] = []
  return {
    children,
    sent,
    window: {
      contentView: {
        addChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) { children.push(view) },
        removeChildView(view: InstanceType<typeof fakeElectron.FakeWebContentsView>) {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      },
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send(_channel: string, value: unknown) { sent.push(value) }
      }
    }
  }
}

describe('BrowserViewManager', () => {
  it('normalizes only embeddable web URLs', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('localhost:4173')).toBe('http://localhost:4173/')
    expect(normalizeBrowserUrl('agent runtime docs')).toBe('https://www.google.com/search?q=agent%20runtime%20docs')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow('Unsupported browser URL protocol')
    expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow('Unsupported browser URL protocol')
    expect(() => assertAllowedBrowserUrl('mailto:hello@example.com')).toThrow('Unsupported browser URL protocol')
  })

  it('owns WebContentsView bounds, navigation, and close lifecycle', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)

    const created = await manager.create('browser-1', 'about:blank')
    const view = fixture.children[0]!
    expect(created).toMatchObject({ id: 'browser-1', url: 'about:blank' })
    expect(view.visible).toBe(false)
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)
    expect(view.webContents.disableDeviceEmulation).toHaveBeenCalled()
    expect(view.webContents.session.checkHandler?.(view.webContents, 'media', 'https://example.com', {})).toBe(false)
    const permissionCallback = vi.fn()
    view.webContents.session.requestHandler?.(view.webContents, 'notifications', permissionCallback, {})
    expect(permissionCallback).toHaveBeenCalledOnce()
    expect(permissionCallback).toHaveBeenCalledWith(false)

    manager.setBounds('browser-1', { x: 10.4, y: 20.6, width: 800.2, height: 500.8 })
    expect(view.visible).toBe(true)
    expect(view.bounds).toEqual({ x: 10, y: 21, width: 800, height: 501 })
    manager.setBounds('browser-1', null)
    expect(view.visible).toBe(false)

    expect(manager.setViewport('browser-1', 'mobile')).toMatchObject({ viewport: 'mobile' })
    expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith({
      screenPosition: 'mobile',
      screenSize: { width: 390, height: 844 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 390, height: 844 },
      scale: 1
    })
    expect(manager.setViewport('browser-1', 'desktop')).toMatchObject({ viewport: 'desktop' })
    expect(view.webContents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      screenPosition: 'desktop',
      viewSize: { width: 1280, height: 800 }
    }))
    expect(manager.setViewport('browser-1', 'responsive')).toMatchObject({ viewport: 'responsive' })
    expect(view.webContents.deviceEmulation).toBeNull()
    expect(() => manager.setViewport('browser-1', 'watch' as never)).toThrow('Unknown browser viewport')

    manager.openDevTools('browser-1')
    expect(view.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })

    await expect(manager.captureScreenshot('browser-1')).resolves.toEqual({
      browserId: 'browser-1',
      navigationId: expect.any(String),
      image: {
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${png().toString('base64')}`,
        width: 2,
        height: 3,
        byteLength: png().byteLength
      }
    })

    expect(await manager.navigate('browser-1', 'example.com')).toMatchObject({
      url: 'https://example.com/',
      title: 'example.com'
    })
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)

    await manager.reload('browser-1')
    expect(view.webContents.zoomFactor).toBe(DEFAULT_BROWSER_ZOOM_FACTOR)

    manager.close('browser-1')
    expect(fixture.children).toHaveLength(0)
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(() => manager.setBounds('browser-1', null)).not.toThrow()
    expect(() => manager.setBounds('browser-1', { x: 0, y: 0, width: 100, height: 100 }))
      .not.toThrow()
  })

  it('blocks unsupported page navigation and redirects before commit', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    await manager.create('browser-guarded', 'https://example.com')
    const view = fixture.children[0]!
    const navigate = view.webContents.listeners.get('will-navigate')![0]!
    const redirect = view.webContents.listeners.get('will-redirect')![0]!
    const blockedNavigation = {
      url: 'file:///etc/passwd',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    const blockedRedirect = {
      url: 'javascript:alert(1)',
      isMainFrame: true,
      preventDefault: vi.fn()
    }

    navigate(blockedNavigation)
    redirect(blockedRedirect)

    expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce()
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce()

    const allowedNavigation = {
      url: 'https://agentmux.example.test/docs',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    navigate(allowedNavigation)
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled()
  })

  it('projects loading, title, load failure, and renderer loss as Browser events', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    await manager.create('browser-events', 'https://example.com')
    const view = fixture.children[0]!

    expect(fixture.sent).toContainEqual({
      type: 'updated',
      browser: expect.objectContaining({ id: 'browser-events', loading: true })
    })
    expect(fixture.sent).toContainEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-events',
        title: 'example.com',
        loading: false
      })
    })

    view.webContents.title = 'AgentMux Docs'
    view.webContents.emit('page-title-updated')
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ title: 'AgentMux Docs' })
    })

    view.webContents.emit('did-fail-load', -105, 'NAME_NOT_RESOLVED', 'https://missing.invalid/', true)
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ error: 'NAME_NOT_RESOLVED (-105)' })
    })

    view.webContents.emit('render-process-gone', { reason: 'crashed' })
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ error: 'Browser renderer stopped: crashed' })
    })
  })

  it('releases an externally destroyed WebContentsView before publishing closed', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    await manager.create('browser-destroyed', 'https://example.com')
    const view = fixture.children[0]!
    fixture.sent.length = 0

    view.webContents.close()

    expect(fixture.children).toHaveLength(0)
    expect(fixture.sent).toEqual([{ type: 'closed', id: 'browser-destroyed' }])
    expect(() => manager.setBounds('browser-destroyed', null)).not.toThrow()
  })

  it('rejects a screenshot that completes after the page navigation changes', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    const created = await manager.create('browser-capture', 'https://example.com')
    const view = fixture.children[0]!
    let resolveCapture!: (image: Awaited<ReturnType<typeof view.webContents.capturePage>>) => void
    view.webContents.capturePageImpl = async () => await new Promise((resolve) => { resolveCapture = resolve })

    const pending = manager.captureScreenshot('browser-capture')
    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/next',
      isSameDocument: false,
      isMainFrame: true
    })
    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-capture',
        navigationId: expect.not.stringMatching(created.navigationId)
      })
    })
    resolveCapture({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => Buffer.from('late-browser-png')
    })

    await expect(pending).rejects.toThrow('Browser page changed while the screenshot was being captured')
  })

  it('rotates navigation identity for same-document main-frame navigation', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    const created = await manager.create('browser-same-document', 'https://example.com/page')
    const view = fixture.children[0]!

    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://example.com/page#details',
      isSameDocument: true,
      isMainFrame: true
    })
    view.webContents.url = 'https://example.com/page#details'
    view.webContents.emit('did-navigate-in-page', 'https://example.com/page#details', true)

    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({
        id: 'browser-same-document',
        url: 'https://example.com/page#details',
        navigationId: expect.not.stringMatching(created.navigationId)
      })
    })
  })

  it('does not rotate navigation identity for subframe navigation', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    const created = await manager.create('browser-subframe', 'https://example.com/page')
    const view = fixture.children[0]!

    view.webContents.emitDetails('did-start-navigation', {
      url: 'https://frames.example.test/ad',
      isSameDocument: false,
      isMainFrame: false
    })

    expect(fixture.sent.at(-1)).toEqual({
      type: 'updated',
      browser: expect.objectContaining({ navigationId: created.navigationId })
    })
  })

  it('rejects a capture after close even when the id is recreated', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    await manager.create('browser-recreated', 'https://example.com/first')
    const firstView = fixture.children[0]!
    let resolveCapture!: (image: Awaited<ReturnType<typeof firstView.webContents.capturePage>>) => void
    firstView.webContents.capturePageImpl = async () => await new Promise((resolve) => { resolveCapture = resolve })

    const pending = manager.captureScreenshot('browser-recreated')
    manager.close('browser-recreated')
    await manager.create('browser-recreated', 'https://example.com/second')
    resolveCapture({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => Buffer.from('old-browser-png')
    })

    await expect(pending).rejects.toThrow('Browser page changed while the screenshot was being captured')
  })

  it('returns only the sanitized Main-owned element selection contract', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    const created = await manager.create('browser-selection', 'https://example.com/page')
    const view = fixture.children[0]!
    view.webContents.executeJavaScriptInIsolatedWorldImpl = async (_worldId, scripts) => (
      scripts[0]?.code.includes('Select an element')
        ? {
            pageTitle: 'Secret docs',
            pageUrl: 'https://user:password@example.com/page?token=secret#private',
            tagName: 'button',
            role: 'button',
            accessibleName: 'Open docs',
            selector: 'main > button',
            text: 'Open docs',
            nearbyText: ['Documentation'],
            attributes: { onclick: 'steal()', 'aria-label': 'Open docs' },
            html: '<button onclick="steal()" aria-label="Open docs">Open docs</button>',
            rectViewport: { x: 1, y: 2, width: 3, height: 4 },
            rectPage: { x: 5, y: 6, width: 3, height: 4 },
            isFixed: false
          }
        : true
    )

    await expect(manager.selectElement('browser-selection')).resolves.toEqual({
      browserId: 'browser-selection',
      navigationId: created.navigationId,
      pageTitle: 'Secret docs',
      pageUrl: 'https://example.com/page',
      tagName: 'button',
      role: 'button',
      accessibleName: 'Open docs',
      selector: 'main > button',
      text: 'Open docs',
      nearbyText: ['Documentation'],
      attributes: { 'aria-label': 'Open docs' },
      html: '<button aria-label="Open docs">Open docs</button>',
      rectViewport: { x: 1, y: 2, width: 3, height: 4 },
      rectPage: { x: 5, y: 6, width: 3, height: 4 },
      isFixed: false
    })
  })

  it('does not start selection after a newer cancel wins the preflight race', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    await manager.create('browser-selection-race', 'https://example.com/page')
    const view = fixture.children[0]!
    let resolvePreflight!: (value: boolean) => void
    let delayFirstCancel = true
    view.webContents.executeJavaScriptInIsolatedWorldImpl = async (_worldId, scripts) => {
      const script = scripts[0]?.code ?? ''
      if (delayFirstCancel && script.includes('const barrier =')) {
        delayFirstCancel = false
        return await new Promise<boolean>((resolve) => { resolvePreflight = resolve })
      }
      return script.includes('Select an element') ? null : true
    }
    view.webContents.executeJavaScriptInIsolatedWorld.mockClear()

    const pending = manager.selectElement('browser-selection-race')
    await manager.cancelElementSelection('browser-selection-race')
    resolvePreflight(true)

    await expect(pending).resolves.toBeNull()
    expect(view.webContents.executeJavaScriptInIsolatedWorld.mock.calls.filter((call) => (
      call[1][0]?.code.includes('Select an element')
    ))).toHaveLength(0)
  })

  it('validates annotation identity and geometry before isolated-world injection', async () => {
    const fixture = fakeWindow()
    const manager = new BrowserViewManager(fixture.window as never)
    const created = await manager.create('browser-markers', 'https://example.com/page')
    const view = fixture.children[0]!
    view.webContents.executeJavaScriptInIsolatedWorld.mockClear()

    await manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'annotation-1',
      index: 0,
      rectViewport: { x: -20_000_000, y: 2, width: 3, height: 4 },
      rectPage: { x: 5, y: 6, width: 3, height: 4 },
      isFixed: false
    }])

    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce()
    const script = view.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[1][0]?.code
    expect(script).toContain('annotation-1')
    expect(script).toContain('"x":-10000000')
    await expect(manager.setAnnotationMarkers('browser-markers', 'stale-navigation', []))
      .resolves.toBeUndefined()
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'annotation-2',
      index: 0,
      rectViewport: { x: Number.NaN, y: 0, width: 1, height: 1 },
      rectPage: { x: 0, y: 0, width: 1, height: 1 },
      isFixed: false
    }])).rejects.toThrow('geometry is invalid')
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, [{
      id: 'duplicate',
      index: 0,
      rectViewport: { x: 0, y: 0, width: 1, height: 1 },
      rectPage: { x: 0, y: 0, width: 1, height: 1 },
      isFixed: false
    }, {
      id: 'duplicate',
      index: 1,
      rectViewport: { x: 1, y: 1, width: 1, height: 1 },
      rectPage: { x: 1, y: 1, width: 1, height: 1 },
      isFixed: false
    }])).rejects.toThrow('duplicates an id or index')
    const sparse = Array.from({ length: 1 }) as never
    await expect(manager.setAnnotationMarkers('browser-markers', created.navigationId, sparse))
      .rejects.toThrow('marker 0 is invalid')
  })
})
