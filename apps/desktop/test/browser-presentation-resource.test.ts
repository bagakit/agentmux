import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserPresentationEvent, BrowserPresentationOccurrence } from '../src/shared/contracts.js'

// Main resource tests isolate Electron transport; they do not claim Native pixels or physical input.
const native = vi.hoisted(() => {
  class Session {
    display: ((request: any, callback: (streams: any) => void) => void) | null = null
    setDisplayMediaRequestHandler = vi.fn((handler: ((request: any, callback: (streams: any) => void) => void) | null) => { this.display = handler })
    setPermissionCheckHandler = vi.fn()
    setPermissionRequestHandler = vi.fn()
    on = vi.fn()
    removeListener = vi.fn()
  }
  class Contents {
    readonly session = new Session()
    url = 'file:///app/renderer/index.html'
    dead = false
    readonly mainFrame = { url: this.url, detached: false, parent: null }
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    focus = vi.fn()
    setWindowOpenHandler = vi.fn()
    getZoomFactor = () => 0.9
    setZoomFactor = vi.fn()
    disableDeviceEmulation = vi.fn()
    enableDeviceEmulation = vi.fn()
    getBackgroundThrottling = () => true
    setBackgroundThrottling = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
    getURL = () => this.url
    getTitle = () => 'Original Browser'
    isLoading = () => false
    isLoadingMainFrame = () => false
    isDestroyed = () => this.dead
    on(event: string, listener: (...args: any[]) => void) {
      const set = this.listeners.get(event) ?? new Set()
      set.add(listener); this.listeners.set(event, set); return this
    }
    once(event: string, listener: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => { this.removeListener(event, wrapped); listener(...args) }
      return this.on(event, wrapped)
    }
    removeListener(event: string, listener: (...args: any[]) => void) { this.listeners.get(event)?.delete(listener) }
    emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
    async loadURL(url: string) {
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
      this.url = url; this.mainFrame.url = url
      this.emit('did-finish-load'); this.emit('did-stop-loading')
    }
    reload() { void this.loadURL(this.url) }
    close() { this.dead = true; this.emit('destroyed') }
  }
  class View {
    readonly webContents = new Contents()
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setVisible(value: boolean) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value } }
    getBounds() { return this.bounds }
  }
  return { Session, Contents, View }
})
vi.mock('electron', () => ({ WebContentsView: native.View, app: { getPath: () => '/unused-private-ledger' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'

const cleanup: Array<() => void> = []
afterEach(() => { for (const release of cleanup.splice(0)) release() })
const geometry = { visible: true as const, bounds: { x: 24, y: 36, width: 480, height: 240 } }
const occurrence = (id: string): BrowserPresentationOccurrence => ({ presentationId: id,
  location: { displayWorkspaceId: 'foreign-space', groupId: 'group-' + id, tabId: 'same-tab', regionId: 'same-region' } })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-presentation-resource-'))
  const app = new native.Contents(), views: InstanceType<typeof native.View>[] = []
  const window = { webContents: app, isDestroyed: () => false, contentView: {
    addChildView: (view: InstanceType<typeof native.View>) => views.push(view),
    removeChildView: (view: InstanceType<typeof native.View>) => { views.splice(views.indexOf(view), 1) }
  } }
  const manager = new BrowserViewManager(window as never,
    { defaultProfileId: () => 'original', resolvePartition: id => 'persist:' + id },
    new BrowserRefLedgerStore(join(root, 'ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
  cleanup.push(() => { manager.dispose(); rmSync(root, { recursive: true }) })
  await manager.create('browser', 'https://generic.example/one', 'resource-space')
  const source = views[0]!, frame = app.mainFrame
  const register = (id: string, value = geometry) => manager.registerPresentation(app as never, frame as never,
    { browserId: 'browser', occurrence: occurrence(id), geometry: value })
  const events = (): BrowserPresentationEvent[] => app.send.mock.calls
    .filter(([channel]) => channel === 'agentmux:browser-presentation-event').map(([, value]) => value)
  const request = (change = {}) => {
    const result: unknown[] = []
    expect(app.session.display).not.toBeNull()
    app.session.display!({ frame, securityOrigin: 'file://', videoRequested: true, audioRequested: false,
      userGesture: false, ...change }, value => result.push(value))
    expect(result).toHaveLength(1)
    return result[0]
  }
  return { manager, app, frame, source, views, register, events, request }
}

it('rejects foreign requester, child frame and invalid occurrence/bounds without touching the original page', async () => {
  const f = await fixture()
  for (const [sender, frame] of [[new native.Contents(), f.frame], [f.app, { ...f.frame, parent: f.frame }]]) {
    expect(() => f.manager.registerPresentation(sender as never, frame as never,
      { browserId: 'browser', occurrence: occurrence('A'), geometry })).toThrow('Untrusted')
  }
  expect(() => f.manager.registerPresentation(f.app as never, f.frame as never,
    { browserId: 'browser', occurrence: occurrence('A'), geometry: { visible: true, bounds: { ...geometry.bounds, width: 0 } } })).toThrow('bounds')
  expect(f.views).toEqual([f.source]); expect(f.source.webContents.dead).toBe(false)
})
it('arms one capture from a visible exact lease and waits for actual media acknowledgement', async () => {
  const f = await fixture(), a = f.register('A'), b = f.register('B')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(() => f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)).toThrow('pending')
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['actual-video-id'] })
  expect(f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)).toEqual(capture)
})
it('denies a same-session child frame, other origin or audio without consuming the trusted pending arm', async () => {
  const f = await fixture(), lease = f.register('A')
  f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(f.request({ frame: { ...f.frame, parent: f.frame } })).toBeNull()
  expect(f.request({ securityOrigin: 'https://other.example' })).toBeNull()
  expect(f.request({ audioRequested: true })).toBeNull()
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
})
it('keeps capture authorized through the original source reload and new URL navigation', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  await f.source.webContents.loadURL('https://generic.example/two')
  f.source.webContents.reload()
  expect(f.events()).toEqual([])
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  expect(f.views).toEqual([f.source]); expect(f.source.webContents.getURL()).toBe('https://generic.example/two')
})
it('hides/removes one lease without revoking another visible consumer or closing the entity', async () => {
  const f = await fixture(), a = f.register('A'), b = f.register('B')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId)
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, { visible: false })
  f.manager.removePresentation(f.app as never, f.frame as never, a.leaseId)
  expect(f.events()).toEqual([
    { type: 'input-owner-changed', browserId: 'browser', leaseId: a.leaseId },
    { type: 'input-owner-changed', browserId: 'browser', leaseId: null }
  ])
  expect(f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)).toEqual(capture)
  expect(f.source.webContents.dead).toBe(false)
})
it('moves only the original Native view on explicit selection and updates only the active geometry', async () => {
  const f = await fixture(), a = f.register('A'), b = f.register('B')
  f.manager.updatePresentation(f.app as never, f.frame as never, b.leaseId,
    { visible: true, bounds: { ...geometry.bounds, x: 550 } })
  expect(f.source.bounds.width).toBe(0)
  f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId)
  expect(f.source.bounds).toEqual({ ...geometry.bounds, x: 550 })
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, geometry)
  expect(f.source.bounds.x).toBe(550)
  expect(f.views).toEqual([f.source]); expect(f.source.webContents.focus).toHaveBeenCalledTimes(1)
})
it('revokes capture at the last visible lease but keeps the source and accepts stopped without fake ready', async () => {
  const f = await fixture(), a = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, { visible: false })
  expect(f.events()).toEqual([{ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'no-visible-presentations' }])
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })).toThrow('authorized')
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'stopped', trackIds: ['video'] })
  expect(f.source.webContents.dead).toBe(false)
})
it('invalidates same-URL requester reload before grant and keeps the original source working', async () => {
  const f = await fixture(), a = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.app.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: f.app.url })
  expect(f.request()).toBeNull()
  expect(f.events()).toEqual([{ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'requester-ended' }])
  expect(() => f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, geometry)).toThrow('Unknown')
  expect(f.source.webContents.dead).toBe(false); expect(f.views).toEqual([f.source])
})
it('retains exact requester lifetime on same-document navigation', async () => {
  const f = await fixture(), a = f.register('A')
  f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.app.url += '#view'; f.frame.url = f.app.url
  f.app.emit('did-navigate-in-page', {}, f.app.url, true)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame }); expect(f.events()).toEqual([])
})
it('releases the resource rather than closing the projection and rejects stale leases after restore', async () => {
  const f = await fixture(), a = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  await f.manager.release('browser')
  expect(f.events()).toEqual([{ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'source-released' }])
  expect(f.manager.resourceOwnerCounts()).toEqual({ browserViews: 0, releasedBrowserViews: 1 })
  await f.manager.restore('browser')
  expect(() => f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, geometry)).toThrow('Unknown')
  expect(f.manager.resourceOwnerCounts()).toEqual({ browserViews: 1, releasedBrowserViews: 0 })
})
it('revokes only a committed source Profile replacement and preserves original source permissions', async () => {
  const f = await fixture(), a = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  await f.manager.switchProfile('browser', 'other-profile')
  expect(f.events()).toEqual([{ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'source-replaced' }])
  expect(f.source.webContents.dead).toBe(true)
  expect(f.views).toHaveLength(1)
  expect(f.views[0]!.webContents.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  expect(f.app.session.setPermissionCheckHandler).not.toHaveBeenCalled()
})
it('does not let an obsolete failed ACK revoke a newer capture and requires nonempty exact track IDs', async () => {
  const f = await fixture(), a = f.register('A')
  const old = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, { visible: false })
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, geometry)
  const current = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(current.captureId).not.toBe(old.captureId)
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, old.captureId, { outcome: 'failed', message: 'late' })).toThrow('Unknown')
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, current.captureId, { outcome: 'ready', trackIds: [] as never })).toThrow('actual track ids')
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, current.captureId, { outcome: 'ready', trackIds: ['video'] })
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, current.captureId, { outcome: 'stopped', trackIds: ['other'] })).toThrow('changed')
})
it('disposes only its requester handler/listeners and cannot arm an ended owner', async () => {
  const f = await fixture(), a = f.register('A')
  f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.manager.dispose()
  expect(f.app.session.display).toBeNull()
  expect(f.app.listeners.get('did-start-navigation')?.size).toBe(0)
  expect(() => f.register('after')).toThrow('Untrusted')
})
