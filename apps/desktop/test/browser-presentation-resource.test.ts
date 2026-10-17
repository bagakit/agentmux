const { fixtureFileUrl: _hygiene_fixtureFileUrl, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
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
    setDevicePermissionHandler = vi.fn()
    on = vi.fn()
    removeListener = vi.fn()
  }
  class Contents {
    readonly session = new Session()
    url = _hygiene_fixtureFileUrl("app/renderer/index.html")
    dead = false
    readonly mainFrame = { url: this.url, detached: false, parent: null, processId: 1, frameToken: 'original-frame' }
    documentRevision = 0
    readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    send = vi.fn()
    focus = vi.fn()
    setWindowOpenHandler = vi.fn()
    zoom = 0.9
    getZoomFactor = () => this.zoom
    sendInputEvent = vi.fn((input: any) => { this.emit('input-event', {}, input) })
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
      this.mainFrame.frameToken = 'frame-' + ++this.documentRevision
      this.emit('did-navigate', {}, url)
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
  const shells: BaseWindow[] = []
  class BaseWindow {
    readonly views: View[] = []
    readonly contentView = {
      children: this.views,
      addChildView: (view: View) => { this.views.push(view) },
      removeChildView: (view: View) => { const index = this.views.indexOf(view); if (index !== -1) this.views.splice(index, 1) }
    }
    dead = false
    constructor(readonly options: Record<string, unknown>) { shells.push(this) }
    isDestroyed = () => this.dead
    destroy = vi.fn(() => { this.dead = true })
  }
  return { Session, Contents, View, BaseWindow, shells }
})
vi.mock('electron', () => ({ BaseWindow: native.BaseWindow, WebContentsView: native.View, app: { getPath: () => _hygiene_fixturePath("unused-private-ledger") } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { BrowserRefLedgerStore } from '../src/main/browser-ref-ledger-store.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const release of cleanup.splice(0)) release()
  expect(native.shells.filter(shell => !shell.isDestroyed())).toEqual([])
})
const geometry = { visible: true as const, bounds: { x: 24, y: 36, width: 480, height: 240 } }
const occurrence = (id: string): BrowserPresentationOccurrence => ({ presentationId: id,
  location: { displayWorkspaceId: 'foreign-space', groupId: 'group-' + id, tabId: 'same-tab', regionId: 'same-region' } })
async function fixture(focused = true) {
  const root = mkdtempSync(join(tmpdir(), 'browser-presentation-resource-'))
  const app = new native.Contents(), views: InstanceType<typeof native.View>[] = []
  const addChildView = vi.fn((view: InstanceType<typeof native.View>, index = views.length) => {
    const previous = views.indexOf(view)
    if (previous !== -1) views.splice(previous, 1)
    views.splice(index, 0, view)
  })
  const window = { webContents: app, getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }), isDestroyed: () => false, isFocused: () => focused, contentView: {
    get children() { return views },
    addChildView,
    removeChildView: (view: InstanceType<typeof native.View>) => { views.splice(views.indexOf(view), 1) }
  } }
  const manager = new BrowserViewManager(window as never,
    { defaultProfileId: () => 'original', resolvePartition: id => 'persist:' + id },
    new BrowserRefLedgerStore(join(root, 'ledger.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => {} })
  cleanup.push(() => { manager.dispose(); rmSync(root, { recursive: true }) })
  const browser = await manager.create('browser', 'https://generic.example/one', 'resource-space')
  const source = views[0]!, frame = app.mainFrame
  const identity = () => ({ processId: frame.processId, frameToken: frame.frameToken })
  const register = (id: string, value = geometry) => manager.registerPresentation(app as never, frame as never,
    { browserId: 'browser', occurrence: occurrence(id), geometry: value }, identity())
  const events = (): BrowserPresentationEvent[] => app.send.mock.calls
    .filter(([channel]) => channel === 'agentmux:browser-presentation-event').map(([, value]) => value)
    .filter(value => value.type !== 'native-coverage-changed')
  const coverage = () => app.send.mock.calls
    .filter(([channel, value]) => channel === 'agentmux:browser-presentation-event' && value.type === 'native-coverage-changed')
    .map(([, value]) => value.coverage)
  const request = (change = {}) => {
    const result: unknown[] = []
    expect(app.session.display).not.toBeNull()
    app.session.display!({ frame, securityOrigin: 'file://', videoRequested: true, audioRequested: false,
      userGesture: false, ...change }, value => result.push(value))
    expect(result).toHaveLength(1)
    return result[0]
  }
  return { manager, app, frame, source, views, identity, register, events, coverage, request, browser, addChildView, window }
}

it('confirms native coverage only after the exact source capture is acknowledged', async () => {
  const f = await fixture(), lease = f.register('A')
  await f.manager.activatePresentation(f.app as never, f.frame as never, lease.leaseId, { kind: 'select', focus: 'preserve' })
  expect(f.coverage().at(-1)).toBeNull()
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.setBounds('browser', geometry.bounds)
  expect(f.coverage().at(-1)).toBeNull()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  expect(f.coverage().at(-1)).toEqual({ leaseId: lease.leaseId, captureId: capture.captureId })
  expect(f.events()).toEqual([{ type: 'input-owner-changed', browserId: 'browser', leaseId: lease.leaseId }])
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
})

it('withdraws physical coverage on direct hide or move while retaining the logical input owner', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, lease.leaseId, { kind: 'select', focus: 'preserve' })
  const confirmed = { leaseId: lease.leaseId, captureId: capture.captureId }
  expect(f.coverage().at(-1)).toEqual(confirmed)
  const control = f.events()
  f.manager.setBounds('browser', null)
  expect(f.coverage().at(-1)).toBeNull()
  expect(f.source.getVisible()).toBe(false)
  f.manager.setBounds('browser', geometry.bounds)
  expect(f.coverage().at(-1)).toEqual(confirmed)
  const moved = { ...geometry.bounds, x: 600 }
  f.manager.setBounds('browser', moved)
  expect(f.coverage().at(-1)).toBeNull()
  expect(f.manager.nativeOwner('browser')?.bounds).toEqual(moved)
  expect(f.events()).toEqual(control)
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
})

it('keeps coverage unknown after a detached source or failed native hide without changing input', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, lease.leaseId, { kind: 'select', focus: 'preserve' })
  expect(f.coverage().at(-1)).toEqual({ leaseId: lease.leaseId, captureId: capture.captureId })
  f.views.splice(f.views.indexOf(f.source), 1)
  f.manager.setBounds('browser', geometry.bounds)
  expect(f.coverage().at(-1)).toBeNull()
  f.views.push(f.source)
  f.manager.setBounds('browser', geometry.bounds)
  expect(f.coverage().at(-1)).not.toBeNull()
  const control = f.events()
  const hide = vi.spyOn(f.source, 'setVisible').mockImplementationOnce(() => { throw new Error('Native hide unavailable') })
  expect(() => f.manager.setBounds('browser', null)).toThrow('Native hide unavailable')
  expect(f.coverage().at(-1)).toBeNull()
  expect(f.events()).toEqual(control)
  hide.mockRestore()
})

it('retires coverage with the original capture and confirms a fresh source generation independently', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, lease.leaseId, { kind: 'select', focus: 'preserve' })
  expect(f.coverage().at(-1)).toEqual({ leaseId: lease.leaseId, captureId: capture.captureId })
  await f.manager.switchProfile('browser', 'another')
  expect(f.coverage().at(-1)).toBeNull()
  const source = f.views[0]!
  expect(source).not.toBe(f.source)
  const next = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(next.captureId).not.toBe(capture.captureId)
  expect(f.request()).toEqual({ video: source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, next.captureId, { outcome: 'ready', trackIds: ['new-video'] })
  expect(f.coverage().at(-1)).toEqual({ leaseId: lease.leaseId, captureId: next.captureId })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, next.captureId, { outcome: 'stopped', trackIds: ['new-video'] })
  expect(f.coverage().at(-1)).toBeNull()
})

it('reconciles coverage after selection rolls back without replacing the original failure', async () => {
  const f = await fixture(), a = f.register('A'), b = f.register('B', { visible: true, bounds: { ...geometry.bounds, x: 600 } })
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId, { kind: 'select', focus: 'preserve' })
  const control = f.events(), failure = new Error('Native visibility observer failed')
  f.manager.onNativeVisibilityChange = () => { throw failure }
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId, { kind: 'select', focus: 'preserve' })).rejects.toBe(failure)
  expect(f.coverage().at(-1)).toBeNull()
  expect(f.source.getBounds().x).toBe(600)
  expect(f.events()).toEqual(control)
  f.manager.onNativeVisibilityChange = undefined
})

it('keeps failed hidden source return observable without destroying the original page', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  f.request()
  const failure = new Error('Native preparation placement failed')
  f.addChildView.mockImplementationOnce(() => { throw failure })
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId,
    { outcome: 'ready', trackIds: ['video'] })).toThrow(AggregateError)
  expect(f.coverage().at(-1)).toBeNull()
  expect(f.source.webContents.dead).toBe(false)
})

it('keeps a stale native window document from confirming coverage without hiding the original page', async () => {
  const f = await fixture(), host = f.manager.windowForView(f.source as never)
  let current = true
  f.manager.setPresentationWindowOwner(() => { if (!current) throw new Error('Original host document changed'); return host })
  const lease = f.register('A'), capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, lease.leaseId, { kind: 'select', focus: 'preserve' })
  expect(f.coverage().at(-1)).not.toBeNull()
  current = false
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(() => f.manager.setBounds('browser', geometry.bounds)).not.toThrow()
    expect(f.coverage().at(-1)).toBeNull()
    expect(f.manager.nativeOwner('browser')?.view).toBe(f.source)
    expect(warn).toHaveBeenCalledOnce()
  } finally { warn.mockRestore() }
})

it('prepares a never-selected source in a hidden native shell without covering the Renderer', async () => {
  const f = await fixture(), lease = f.register('A')
  expect(f.source.getBounds().width).toBe(f.window.getContentBounds().width)
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  const shell = native.shells.at(-1)!
  expect(shell.options).toMatchObject({ show: false, focusable: false, width: geometry.bounds.width, height: geometry.bounds.height })
  expect(shell.views).toEqual([f.source])
  expect(f.views).toEqual([])
  expect(f.manager.windowForView(f.source as never)).toBe(f.window)
  expect(f.source.getBounds()).toEqual({ ...geometry.bounds, x: 0, y: 0 })
  expect(f.source.getVisible()).toBe(true)
  expect(f.manager.nativeOwner('browser')).toBeUndefined()
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
  expect(f.events()).toEqual([])
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  expect(f.source.getVisible()).toBe(false)
  expect(shell.views).toEqual([])
  expect(shell.destroy).toHaveBeenCalledOnce()
  expect(f.addChildView).toHaveBeenLastCalledWith(f.source, 1)
  expect(f.views).toEqual([f.source])
})

it.each(['failed', 'stopped', 'revoked'] as const)('ends passive source preparation on %s without navigation or input transfer', async outcome => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(f.source.getVisible()).toBe(true)
  if (outcome === 'revoked') f.manager.updatePresentation(f.app as never, f.frame as never, lease.leaseId, { visible: false })
  else f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, outcome === 'failed'
    ? { outcome, message: 'Video source timed out' } : { outcome, trackIds: ['late-track'] })
  expect(f.source.getVisible()).toBe(false)
  expect(native.shells.at(-1)!.isDestroyed()).toBe(true)
  expect(f.views).toEqual([f.source])
  expect(f.manager.nativeOwner('browser')).toBeUndefined()
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
  expect(f.source.webContents.getURL()).toBe('https://generic.example/one')
  expect(f.source.webContents.dead).toBe(false)
})

it.each(['release', 'profile-replacement', 'dispose', 'source-destroyed', 'host-destroyed'] as const)(
  'releases a pending passive shell after %s without leaking a native window', async action => {
    const f = await fixture(), lease = f.register('A')
    const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
    const shell = native.shells.at(-1)!
    if (action === 'release') {
      expect(await f.manager.release('browser', f.browser.navigationId)).toMatchObject({ reasons: expect.arrayContaining(['presentation']) })
      expect(shell.isDestroyed()).toBe(false)
      expect(f.events()).toEqual([])
      f.source.webContents.close()
    }
    else if (action === 'profile-replacement') await f.manager.switchProfile('browser', 'another')
    else if (action === 'dispose') f.manager.dispose()
    else if (action === 'source-destroyed') f.source.webContents.close()
    else {
      f.window.isDestroyed = () => true
      f.app.emit('render-process-gone')
    }
    expect(shell.isDestroyed()).toBe(true)
    expect(shell.views).toEqual([])
    expect(f.source.webContents.focus).not.toHaveBeenCalled()
    if (action === 'host-destroyed') expect(f.source.webContents.dead).toBe(false)
    else expect(f.events().some(event => event.type === 'capture-revoked' && event.captureId === capture.captureId)).toBe(true)
  }
)

it('keeps source viewport on passive rearm and preserves selection made during acquisition', async () => {
  const f = await fixture(), a = f.register('A')
  const first = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, first.captureId, { outcome: 'failed', message: 'First acquisition failed' })
  const mirrorBounds = { ...geometry.bounds, x: 550, width: 220 }
  const b = f.register('B', { visible: true, bounds: mirrorBounds })
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)
  expect(capture.captureId).not.toBe(first.captureId)
  expect(f.source.getBounds()).toEqual({ ...geometry.bounds, x: 0, y: 0 })
  await f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId, { kind: 'select', focus: 'preserve' })
  expect(f.source.getBounds()).toEqual(mirrorBounds)
  expect(f.addChildView).toHaveBeenLastCalledWith(f.source, 1)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  expect(f.source.getVisible()).toBe(true)
  expect(native.shells.at(-1)!.isDestroyed()).toBe(true)
  expect(f.source.getBounds()).toEqual(mirrorBounds)
  expect(f.manager.nativeOwner('browser')?.view).toBe(f.source)
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
})

it('keeps revocation observable when preparation cleanup fails and permits explicit rearm', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  const hide = vi.spyOn(f.source, 'setVisible').mockImplementationOnce(() => { throw new Error('Native hide unavailable') })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    f.manager.updatePresentation(f.app as never, f.frame as never, lease.leaseId, { visible: false })
    expect(f.events()).toEqual([{ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'no-visible-presentations' }])
    expect(f.views).toEqual([])
    expect(native.shells.at(-1)!.views).toEqual([])
    expect(native.shells.at(-1)!.isDestroyed()).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
    f.manager.updatePresentation(f.app as never, f.frame as never, lease.leaseId, geometry)
    const next = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
    expect(next.captureId).not.toBe(capture.captureId)
    expect(f.source.webContents.dead).toBe(false)
    expect(f.source.webContents.focus).not.toHaveBeenCalled()
  } finally { hide.mockRestore(); warn.mockRestore() }
})

it('rejects foreign requester, child frame and invalid occurrence/bounds without touching the original page', async () => {
  const f = await fixture()
  for (const [sender, frame] of [[new native.Contents(), f.frame], [f.app, { ...f.frame, parent: f.frame }]]) {
    expect(() => f.manager.registerPresentation(sender as never, frame as never,
      { browserId: 'browser', occurrence: occurrence('A'), geometry }, f.identity())).toThrow('Untrusted')
  }
  expect(() => f.manager.registerPresentation(f.app as never, f.frame as never,
    { browserId: 'browser', occurrence: occurrence('A'), geometry: { visible: true, bounds: { ...geometry.bounds, width: 0 } } }, f.identity())).toThrow('bounds')
  expect(f.views).toEqual([f.source]); expect(f.source.webContents.dead).toBe(false)
})

it.each(['frame-mismatch', 'document-url-mismatch'] as const)(
  'explains %s without consuming the occurrence or changing the original page', async reason => {
    const f = await fixture(), before = f.manager.target('browser')
    const frame = reason === 'frame-mismatch' ? { ...f.frame } : f.frame
    const url = f.frame.url
    if (reason === 'document-url-mismatch') f.frame.url += '?other-document'
    try {
      expect(() => f.manager.registerPresentation(f.app as never, frame as never,
        { browserId: 'browser', occurrence: occurrence('A'), geometry }, f.identity()))
        .toThrow(`Untrusted Browser presentation document (${reason})`)
      expect(f.manager.target('browser')).toEqual(before)
      expect(f.views).toEqual([f.source])
      expect(f.source.webContents.dead).toBe(false)
    } finally { f.frame.url = url }
    expect(f.register('A').leaseId).toBeTruthy()
    expect(f.views).toEqual([f.source])
  })

it('arms one capture from a visible exact lease and waits for actual media acknowledgement', async () => {
  const f = await fixture(), a = f.register('A'), b = f.register('B')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(() => f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)).toThrow('pending')
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['actual-video-id'] })
  expect(f.manager.armPresentationCapture(f.app as never, f.frame as never, b.leaseId)).toEqual(capture)
})
it('keeps the exact document eligible for registration and capture while resources load', async () => {
  const f = await fixture()
  const loading = vi.spyOn(f.app, 'isLoadingMainFrame').mockReturnValue(true)
  try {
    const lease = f.register('loading')
    const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
    expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
    f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['original-track'] })
    f.manager.updatePresentation(f.app as never, f.frame as never, lease.leaseId, geometry)
    expect(f.source.webContents.dead).toBe(false)
  } finally { loading.mockRestore() }
})

it('retires a document registered during navigation when the same native wrapper commits a new document', async () => {
  const f = await fixture()
  f.register('before-navigation')
  f.app.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: f.app.url })
  const during = f.register('during-navigation')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, during.leaseId)
  f.frame.frameToken = 'committed-document'
  // The real native wrapper mutates in place even for a same-URL reload.
  expect(f.app.mainFrame).toBe(f.frame)
  expect(f.request()).toBeNull()
  f.app.emit('did-navigate', {}, f.app.url)
  expect(f.events()).toContainEqual({ type: 'capture-revoked', browserId: 'browser', captureId: capture.captureId, reason: 'requester-ended' })
  expect(() => f.manager.updatePresentation(f.app as never, f.frame as never, during.leaseId, geometry)).toThrow('Unknown')
  expect(f.source.webContents.dead).toBe(false)
})

it('rejects an old request snapshot without revoking a new document registered before its commit notification', async () => {
  const f = await fixture(), original = f.identity()
  f.register('old-document')
  f.frame.frameToken = 'new-document'
  const current = f.register('new-document')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, current.leaseId)
  f.app.emit('did-navigate', {}, f.app.url)
  expect(() => f.manager.registerPresentation(f.app as never, f.frame as never,
    { browserId: 'browser', occurrence: occurrence('stale-request'), geometry }, original)).toThrow('document-changed')
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['new-track'] })
  f.manager.updatePresentation(f.app as never, f.frame as never, current.leaseId, geometry)
  expect(f.source.webContents.dead).toBe(false)
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
  await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId, { kind: 'select' })
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
  expect(f.source.bounds.width).toBe(f.window.getContentBounds().width)
  await f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId, { kind: 'select' })
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
it('retires only the ended requester capture token while keeping its Browser available', async () => {
  const f = await fixture(), lease = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['original-track'] })
  const entry = Reflect.get(f.manager, 'entries').get('browser')
  expect(entry.captureId).toBe(capture.captureId)
  f.app.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: f.app.url })
  expect(entry.captureId).toBeNull()
  expect(Reflect.get(f.manager, 'presentationCaptures').has(capture.captureId)).toBe(false)
  expect(f.source.webContents.dead).toBe(false)
  const nextLease = f.register('next')
  const next = f.manager.armPresentationCapture(f.app as never, f.frame as never, nextLease.leaseId)
  expect(next.captureId).not.toBe(capture.captureId)
  expect(entry.captureId).toBe(next.captureId)
  expect(() => f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'stopped', trackIds: ['original-track'] })).toThrow('Unknown')
  expect(entry.captureId).toBe(next.captureId)
})
it('retains an active presentation on resource release and rejects its stale lease after actual source destruction', async () => {
  const f = await fixture(), a = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(await f.manager.release('browser', f.browser.navigationId)).toMatchObject({ reasons: expect.arrayContaining(['presentation']) })
  expect(f.events()).toEqual([])
  expect(f.source.webContents.dead).toBe(false)
  f.source.webContents.close()
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


async function firstPressFixture() {
  const f = await fixture(), a = f.register('A'), b = f.register('B', { visible: true,
    bounds: { x: 560, y: 36, width: 720, height: 320 } })
  await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId, { kind: 'select' })
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['actual-video'] })
  const prepare = () => f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId, {
    kind: 'prepare-first-press', captureId: capture.captureId, navigationId: f.browser.navigationId,
    down: { x: 0.25, y: 0.5 }, button: 'left', clickCount: 1, modifiers: [] })
  const prepared = await prepare()
  expect(prepared.outcome).toBe('prepared')
  if (prepared.outcome !== 'prepared') throw new Error('Nonempty actual prepared scope')
  const commit = (id = prepared.inputScopeId) => f.manager.activatePresentation(f.app as never, f.frame as never, b.leaseId,
    { kind: 'commit-first-press', inputScopeId: id, up: { x: 0.3, y: 0.6 }, modifiers: ['shift'] })
  return { ...f, a, b, prepared, prepare, commit }
}

it('dispatches one complete gesture in the original viewport before resize, including nonunit zoom and different target size', async () => {
  const f = await firstPressFixture(), observed: any[] = []
  expect(f.source.webContents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.source.bounds).toEqual(geometry.bounds)
  f.source.webContents.sendInputEvent.mockImplementation(input => {
    observed.push({ input, bounds: { ...f.source.bounds }, zoom: f.source.webContents.getZoomFactor() })
    f.source.webContents.emit('input-event', {}, input)
  })
  expect(f.prepared.sourceViewport).toEqual({ width: 480, height: 240, zoomFactor: 0.9 })
  expect(await f.commit()).toEqual({ outcome: 'input-dispatched', inputScopeId: f.prepared.inputScopeId })
  expect(observed).toEqual([
    { input: { type: 'mouseDown', x: 120, y: 120, button: 'left', clickCount: 1, modifiers: [] }, bounds: geometry.bounds, zoom: 0.9 },
    { input: { type: 'mouseUp', x: 144, y: 144, button: 'left', clickCount: 1, modifiers: ['shift'] }, bounds: geometry.bounds, zoom: 0.9 }
  ])
  expect(f.source.bounds).toEqual({ x: 560, y: 36, width: 720, height: 320 })
  expect(await f.commit()).toEqual({ outcome: 'already-dispatched', inputScopeId: f.prepared.inputScopeId })
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
})
it('cancels a prepared scope with zero page input and preserves the healthy original view', async () => {
  const f = await firstPressFixture()
  expect(await f.manager.activatePresentation(f.app as never, f.frame as never, f.b.leaseId,
    { kind: 'cancel-first-press', inputScopeId: f.prepared.inputScopeId })).toEqual({ outcome: 'cancelled', inputScopeId: f.prepared.inputScopeId })
  expect((await f.commit()).outcome).toBe('cancelled')
  expect(f.source.webContents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.source.webContents.dead).toBe(false); expect(f.source.bounds).toEqual(geometry.bounds)
})
it.each(['navigation', 'target-geometry', 'source-zoom', 'target-hidden'] as const)('rejects a changed %s before any page input', async change => {
  const f = await firstPressFixture()
  if (change === 'navigation') await f.source.webContents.loadURL('https://generic.example/new')
  if (change === 'source-zoom') f.source.webContents.zoom = 1.2
  if (change === 'target-geometry') f.manager.updatePresentation(f.app as never, f.frame as never, f.b.leaseId,
    { visible: true, bounds: { x: 580, y: 36, width: 720, height: 320 } })
  if (change === 'target-hidden') f.manager.updatePresentation(f.app as never, f.frame as never, f.b.leaseId, { visible: false })
  expect((await f.commit()).outcome).toBe('input-unconfirmed')
  expect(f.source.webContents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.source.webContents.dead).toBe(false); expect(f.source.bounds).toEqual(geometry.bounds)
})
it('rejects an obsolete scope after a new prepare and prevents concurrent duplicate dispatch', async () => {
  const f = await firstPressFixture(), fresh = await f.prepare()
  expect(fresh.outcome).toBe('prepared')
  if (fresh.outcome !== 'prepared') throw new Error('Nonempty replacement scope')
  expect((await f.commit()).outcome).toBe('input-unconfirmed')
  const first = f.commit(fresh.inputScopeId), duplicate = f.commit(fresh.inputScopeId)
  expect((await first).outcome).toBe('input-dispatched')
  expect((await duplicate).outcome).toBe('input-unconfirmed')
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
})
it('does not move the healthy page when Native delivery cannot be observed, or replay an uncertain dispatch', async () => {
  const f = await firstPressFixture()
  f.source.webContents.sendInputEvent.mockImplementation(() => {})
  expect((await f.commit()).outcome).toBe('input-unconfirmed')
  expect((await f.commit()).outcome).toBe('input-unconfirmed')
  expect(f.source.bounds).toEqual(geometry.bounds)
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
  expect(f.source.webContents.dead).toBe(false)
})

it('does not mistake an unrelated mouse-up for the one-shot delivery barrier', async () => {
  const f = await firstPressFixture()
  f.source.webContents.sendInputEvent.mockImplementation(input => {
    if (input.type === 'mouseUp') f.source.webContents.emit('input-event', {}, { ...input, x: 3, y: 4 })
  })
  expect((await f.commit()).outcome).toBe('input-unconfirmed')
  expect(f.source.bounds).toEqual(geometry.bounds)
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
})
it('rejects out-of-frame points, invented modifiers and an unknown scope before page input', async () => {
  const f = await firstPressFixture()
  expect((await f.commit('foreign-scope')).outcome).toBe('input-unconfirmed')
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, f.b.leaseId,
    { kind: 'commit-first-press', inputScopeId: f.prepared.inputScopeId, up: { x: 1, y: 0.5 }, modifiers: [] })).rejects.toThrow('captured frame')
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, f.b.leaseId,
    { kind: 'commit-first-press', inputScopeId: f.prepared.inputScopeId, up: { x: 0.5, y: 0.5 }, modifiers: ['invented'] as never })).rejects.toThrow('modifiers')
  expect(f.source.webContents.sendInputEvent).not.toHaveBeenCalled()
})

// Narrow regressions for the actual App A-hidden/B-visible input condition.
// Electron transport is isolated here; this does not sign an OS foreground or page-effect result.
async function hiddenSourceFixture(focused = true) {
  const f = await fixture(focused), a = f.register('A'), b = f.register('B', {visible:true,bounds:{x:560,y:36,width:720,height:320}})
  await f.manager.activatePresentation(f.app as never,f.frame as never,a.leaseId,{kind:'select'})
  const capture=f.manager.armPresentationCapture(f.app as never,f.frame as never,a.leaseId)
  expect(f.request()).toEqual({video:f.source.webContents.mainFrame})
  f.manager.ackPresentationCapture(f.app as never,f.frame as never,capture.captureId,{outcome:'ready',trackIds:['original-track']})
  f.manager.updatePresentation(f.app as never,f.frame as never,a.leaseId,{visible:false})
  expect(f.source.getVisible()).toBe(false)
  expect(f.source.getBounds()).toEqual(geometry.bounds)
  expect(f.events().filter(event=>event.type==='capture-revoked')).toEqual([])
  const prepare=()=>f.manager.activatePresentation(f.app as never,f.frame as never,b.leaseId,{kind:'prepare-first-press',captureId:capture.captureId,navigationId:f.browser.navigationId,down:{x:0.25,y:0.5},button:'left',clickCount:1,modifiers:[]})
  return {...f,b,prepare}
}
it('hidden original source permits the visible exact B gesture in the original viewport with a focused requester',async()=>{
  const f=await hiddenSourceFixture(),prepared=await f.prepare()
  expect(prepared.outcome).toBe('prepared')
  if(prepared.outcome!=='prepared')throw Error('Actual prepared scope is nonempty')
  const observations:unknown[]=[]
  f.source.webContents.sendInputEvent.mockImplementation(input=>{observations.push({input,bounds:f.source.getBounds(),visible:f.source.getVisible()});f.source.webContents.emit('input-event',{},input)})
  const result=await f.manager.activatePresentation(f.app as never,f.frame as never,f.b.leaseId,{kind:'commit-first-press',inputScopeId:prepared.inputScopeId,up:{x:0.3,y:0.6},modifiers:[]})
  expect(result).toEqual({outcome:'input-dispatched',inputScopeId:prepared.inputScopeId})
  expect(observations).toEqual([
    {input:{type:'mouseDown',x:120,y:120,button:'left',clickCount:1,modifiers:[]},bounds:geometry.bounds,visible:false},
    {input:{type:'mouseUp',x:144,y:144,button:'left',clickCount:1,modifiers:[]},bounds:geometry.bounds,visible:false}])
  expect(f.source.getVisible()).toBe(true);expect(f.views).toEqual([f.source]);expect(f.source.webContents.dead).toBe(false)
})
it('hidden original source still refuses an unfocused requester without page input',async()=>{
  const f=await hiddenSourceFixture(false)
  expect(await f.prepare()).toMatchObject({outcome:'input-unconfirmed',reason:'window-not-focused'})
  expect(f.source.webContents.sendInputEvent).not.toHaveBeenCalled()
  expect(f.source.getVisible()).toBe(false);expect(f.source.webContents.dead).toBe(false)
})


it('passive selection restores native geometry and input authority while preserving keyboard focus', async () => {
  const f = await fixture(), a = f.register('A')
  expect(f.source.bounds.width).toBe(f.window.getContentBounds().width)
  expect(await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId,
    { kind: 'select', focus: 'preserve' })).toEqual({ outcome: 'selected' })
  expect(f.source.bounds).toEqual(geometry.bounds)
  expect(f.source.getVisible()).toBe(true)
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
  const shifted = { ...geometry.bounds, x: 52 }
  f.manager.updatePresentation(f.app as never, f.frame as never, a.leaseId, { visible: true, bounds: shifted })
  expect(f.source.bounds).toEqual(shifted)
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, a.leaseId)
  expect(f.request()).toEqual({ video: f.source.webContents.mainFrame })
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['original-page'] })
  const prepared = await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId,
    { kind: 'prepare-first-press', navigationId: f.browser.navigationId, captureId: capture.captureId,
      down: { x: 0.25, y: 0.5 }, button: 'left', clickCount: 1, modifiers: [] })
  expect(prepared.outcome).toBe('prepared')
  if (prepared.outcome !== 'prepared') throw new Error('Actual original page input scope required')
  expect(await f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId,
    { kind: 'commit-first-press', inputScopeId: prepared.inputScopeId, up: { x: 0.25, y: 0.5 }, modifiers: [] }))
    .toEqual({ outcome: 'input-dispatched', inputScopeId: prepared.inputScopeId })
  expect(f.source.webContents.focus).toHaveBeenCalledTimes(1)
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
})
it('rejects an invalid selection focus policy before changing the original native owner', async () => {
  const f = await fixture(), a = f.register('A')
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, a.leaseId,
    { kind: 'select', focus: 'invented-policy' } as never)).rejects.toThrow('Unknown Browser presentation focus policy')
  expect(f.source.bounds.width).toBe(f.window.getContentBounds().width)
  expect(f.source.getVisible()).toBe(false)
  expect(f.source.webContents.focus).not.toHaveBeenCalled()
  expect(f.source.webContents.dead).toBe(false)
})

it('an invalid selection leaves an already-visible original and prepared human press usable', async () => {
  const f = await firstPressFixture()
  const originalBounds = { ...f.source.bounds }
  const originalEvents = f.events().length
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, f.b.leaseId,
    { kind: 'select', focus: 'invented-policy' } as never)).rejects.toThrow('Unknown Browser presentation focus policy')
  expect(f.source.bounds).toEqual(originalBounds)
  expect(f.source.getVisible()).toBe(true)
  expect(f.events()).toHaveLength(originalEvents)
  expect(f.source.webContents.dead).toBe(false)
  expect(await f.commit()).toEqual({ outcome: 'input-dispatched', inputScopeId: f.prepared.inputScopeId })
  expect(f.source.webContents.sendInputEvent).toHaveBeenCalledTimes(2)
})


it('selects the exact child lease before rehosting the same native page and scopes its return notifications', async () => {
  const f = await fixture(), childViews: InstanceType<typeof native.View>[] = []
  const child = { webContents: new native.Contents(), isDestroyed: () => false, isFocused: () => true, contentView: {
    get children() { return childViews },
    addChildView: (view: InstanceType<typeof native.View>) => { const previous=childViews.indexOf(view); if(previous!==-1)childViews.splice(previous,1); childViews.push(view) },
    removeChildView: (view: InstanceType<typeof native.View>) => { const index=childViews.indexOf(view); if(index!==-1)childViews.splice(index,1) }
  } }
  const identity = { windowId: 'child', documentGeneration: 'original-document' }
  f.manager.setPresentationWindowOwner(scope => scope?.windowId === identity.windowId && scope.documentGeneration === identity.documentGeneration ? child as never : f.window as never)
  const notify = vi.fn(); f.manager.onNativeVisibilityChange = notify
  const original = f.register('A')
  await f.manager.activatePresentation(f.app as never, f.frame as never, original.leaseId, { kind: 'select' })
  const borrowed = f.manager.registerPresentation(f.app as never, f.frame as never, { browserId: 'browser', occurrence: occurrence('B'), geometry, window: identity }, f.identity())
  await f.manager.activatePresentation(f.app as never, f.frame as never, borrowed.leaseId, { kind: 'select' })
  expect(childViews).toEqual([f.source]); expect(f.views).not.toContain(f.source)
  expect(f.manager.windowForView(f.source as never)).toBe(child)
  expect(f.source.webContents.dead).toBe(false)
  expect(f.source.webContents.getURL()).toBe('https://generic.example/one')
  notify.mockClear()
  await f.manager.returnWindow(child as never)
  expect(f.views).toContain(f.source); expect(childViews).toEqual([])
  expect(f.manager.windowForView(f.source as never)).toBe(f.window)
  expect(notify.mock.calls.length).toBeGreaterThan(0)
  expect(notify.mock.calls.every(([,window]) => window===f.window || window===child)).toBe(true)
  expect(notify.mock.calls.some(([,window]) => window===f.window)).toBe(true)
  expect(notify.mock.calls.some(([,window]) => window===child)).toBe(true)
  expect(f.source.webContents.dead).toBe(false)
})


it('keeps the original reachable viewport when the selected native child refuses admission', async () => {
  const f = await fixture(), original = f.register('A')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, original.leaseId)
  f.request()
  f.manager.ackPresentationCapture(f.app as never, f.frame as never, capture.captureId, { outcome: 'ready', trackIds: ['video'] })
  await f.manager.activatePresentation(f.app as never, f.frame as never, original.leaseId, { kind: 'select' })
  const confirmed = { leaseId: original.leaseId, captureId: capture.captureId }, control = f.events()
  expect(f.coverage().at(-1)).toEqual(confirmed)
  const failure = new Error('Native child admission unavailable')
  const child = { webContents: new native.Contents(), isDestroyed: () => false, isFocused: () => true, contentView: {
    addChildView: () => { throw failure }, removeChildView: vi.fn()
  } }
  const identity = { windowId: 'child', documentGeneration: 'original-document' }
  f.manager.setPresentationWindowOwner(scope => scope?.windowId === identity.windowId ? child as never : f.window as never)
  const borrowed = f.manager.registerPresentation(f.app as never, f.frame as never, { browserId: 'browser', occurrence: occurrence('B'), geometry: { visible: true, bounds: { x: 5000, y: 4000, width: 200, height: 100 } }, window: identity }, f.identity())
  await expect(f.manager.activatePresentation(f.app as never, f.frame as never, borrowed.leaseId, { kind: 'select' })).rejects.toBe(failure)
  expect(f.coverage().at(-1)).toEqual(confirmed)
  expect(f.events()).toEqual(control)
  expect(f.manager.windowForView(f.source as never)).toBe(f.window)
  expect(f.views).toContain(f.source); expect(f.source.getBounds()).toEqual(geometry.bounds)
  expect(f.source.getVisible()).toBe(true); expect(f.source.webContents.dead).toBe(false)
  expect(f.manager.nativeOwner('browser')?.view).toBe(f.source)
})

it('closed workbench owners revoke late media requests and release the exact original Session', async () => {
  const f = await fixture(), lease = f.register('departing-document')
  const capture = f.manager.armPresentationCapture(f.app as never, f.frame as never, lease.leaseId)
  expect(capture.captureId).toBeTruthy()
  const requesterSession = f.app.session, lateRequest = requesterSession.display!
  let departed = false
  Object.defineProperty(f.window, 'webContents', { configurable: true, get() {
    if (departed) throw new Error('Object has been destroyed')
    return f.app
  } })
  Object.defineProperty(f.app, 'session', { configurable: true, get() {
    if (departed) throw new Error('Object has been destroyed')
    return requesterSession
  } })
  vi.spyOn(f.window, 'isDestroyed').mockImplementation(() => departed)
  try {
    departed = true; f.app.dead = true
    const granted = vi.fn()
    expect(() => lateRequest({ frame: f.frame, securityOrigin: 'file://', videoRequested: true, audioRequested: false }, granted)).not.toThrow()
    expect(granted).toHaveBeenCalledExactlyOnceWith(null)
    expect(() => f.manager.dispose()).not.toThrow()
    expect(requesterSession.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null)
    for (const event of ['did-start-navigation', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) {
      expect(f.app.listeners.get(event)?.size ?? 0).toBe(0)
    }
  } finally {
    Object.defineProperty(f.window, 'webContents', { configurable: true, writable: true, value: f.app })
    Object.defineProperty(f.app, 'session', { configurable: true, writable: true, value: requesterSession })
  }
})
