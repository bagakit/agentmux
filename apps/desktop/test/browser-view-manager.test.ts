import { describe, expect, it, vi } from 'vitest'

const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void

  class FakeWebContents {
    url = ''
    title = ''
    loading = false
    destroyed = false
    zoomFactor = 1
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

    setWindowOpenHandler() {}
    setZoomFactor(value: number) { this.zoomFactor = value }

    async loadURL(url: string) {
      this.loading = true
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
  return {
    children,
    sent: [] as unknown[],
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
        send(_channel: string, value: unknown) { this.sent?.push?.(value) },
        sent: [] as unknown[]
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
    expect(view.webContents.session.checkHandler?.(view.webContents, 'media', 'https://example.com', {})).toBe(false)
    const permissionCallback = vi.fn()
    view.webContents.session.requestHandler?.(view.webContents, 'notifications', permissionCallback, {})
    expect(permissionCallback).toHaveBeenCalledOnce()
    expect(permissionCallback).toHaveBeenCalledWith(false)

    manager.setBounds('browser-1', { x: 10.4, y: 20.6, width: 800.2, height: 500.8 })
    expect(view.visible).toBe(true)
    expect(view.bounds).toEqual({ x: 10, y: 21, width: 800, height: 501 })

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
})
