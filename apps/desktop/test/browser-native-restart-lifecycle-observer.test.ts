import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { createNativeRestartLifecycleObserver } from '../scripts/browser-native-restart-lifecycle-observer.mjs'

function fixture(ready = false) {
  class View {
    children: View[] = []
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = false
    returnValue: unknown = undefined
    failure: unknown = undefined
    received: unknown[] = []
    addChildView(child: View, index?: number) { this.received = [child, index]; this.children.push(child); return this.returnValue }
    removeChildView(child: View) { this.children = this.children.filter(item => item !== child) }
    setBounds(bounds: typeof this.bounds) { this.received = [bounds]; if (this.failure) throw this.failure; this.bounds = bounds; return this.returnValue }
    setVisible(visible: boolean) { this.visible = visible }
    getBounds() { return this.bounds }
    getVisible() { return this.visible }
  }
  class Contents extends EventEmitter {
    id: number
    url = ''; loading = true; policy = true; destroyed = false
    setterCalls: boolean[] = []
    owner: Window | null = null
    mainFrame = { isDestroyed: () => false, processId: 17, osProcessId: 1700, routingId: 3, frameTreeNodeId: 41, url: '' }
    constructor(id: number) { super(); this.id = id }
    isDestroyed() { return this.destroyed }
    getURL() { return this.url }
    isLoading() { return this.loading }
    getBackgroundThrottling() { return this.policy }
    setBackgroundThrottling(value: boolean) { this.setterCalls.push(value); this.policy = value }
  }
  class Window extends EventEmitter {
    id = 1; contentView = new View(); visible = false; focused = false
    isDestroyed() { return false }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    isMinimized() { return false }
    static existing: Window[] = []
    static getAllWindows() { return this.existing }
    static fromWebContents(wc: Contents) { return wc.owner }
  }
  const app = Object.assign(new EventEmitter(), { isReady: () => ready })
  const methods = Object.fromEntries(['addChildView', 'removeChildView', 'setBounds', 'setVisible'].map(name => [name, Object.getOwnPropertyDescriptor(View.prototype, name)]))
  let clock = 0
  // These Node models only represent public method/event contracts. They do not prove
  // Electron native lifecycle, compositor frames or a real startup/restart.
  const observer = createNativeRestartLifecycleObserver({ app, View, BrowserWindow: Window, enabled: true, now: () => ++clock } as unknown as Parameters<typeof createNativeRestartLifecycleObserver>[0])
  const goReady = () => { ready = true; app.emit('ready') }
  const page = (wc: Contents) => Object.assign(new View(), { webContents: wc })
  return { app, View, Contents, Window, observer, methods, goReady, page }
}

it('is default-off with zero listeners, prototype writes or public getter calls', () => {
  const unavailable = new Proxy({}, { get() { throw new Error('Default off touched native API') } })
  const observer = createNativeRestartLifecycleObserver({ app: unavailable, View: unavailable, BrowserWindow: unavailable } as unknown as Parameters<typeof createNativeRestartLifecycleObserver>[0])
  expect(observer.drain()).toMatchObject({ enabled: false, active: false, installed: false, events: [], readFailures: 0 })
  expect(observer.restore()).toMatchObject({ enabled: false, events: [] })
})

it('can be serialized at the imports-complete Main pause without importing or closing over another module', () => {
  const construct = new Function(`return (${createNativeRestartLifecycleObserver.toString()})`)() as typeof createNativeRestartLifecycleObserver
  const unavailable = new Proxy({}, { get() { throw new Error('Default off touched native API') } })
  const observer = construct({ app: unavailable, View: unavailable, BrowserWindow: unavailable } as unknown as Parameters<typeof construct>[0])
  expect(observer.drain()).toMatchObject({ enabled: false, events: [] })
  expect(observer.restore()).toMatchObject({ installed: false, events: [] })
  const f = fixture(true)
  f.observer.restore()
  const active = construct({ app: f.app, View: f.View, BrowserWindow: f.Window, enabled: true } as unknown as Parameters<typeof construct>[0])
  const view = new f.View()
  view.setVisible(true)
  expect(active.restore().events.map(row => row.kind)).toEqual(['observer-installed', 'setVisible:call', 'setVisible:return'])
  expect(view.visible).toBe(true)
})

it('installs at ready before the first Window and retains unattached contents and same-policy setter ordering', () => {
  const f = fixture()
  expect(f.observer.drain()).toMatchObject({ installed: false, awaitingReady: true, events: [] })
  expect(Object.getOwnPropertyDescriptor(f.View.prototype, 'setBounds')).toEqual(f.methods.setBounds)
  f.goReady()
  const wc = new f.Contents(2)
  f.app.emit('web-contents-created', {}, wc)
  wc.setBackgroundThrottling(true)
  const window = new f.Window(), view = f.page(wc)
  f.app.emit('browser-window-created', {}, window)
  wc.owner = window
  window.contentView.addChildView(view, 1)
  view.setBounds({ x: 51, y: 74, width: 200, height: 400 }); view.setVisible(true)
  wc.url = 'http://localhost/form?private=ignored#fragment'; wc.loading = false
  wc.mainFrame.url = wc.url; window.visible = true
  wc.emit('did-start-navigation', { url: wc.url, isMainFrame: true, isSameDocument: false })
  wc.emit('did-finish-load')
  wc.setBackgroundThrottling(wc.getBackgroundThrottling())
  const trace = f.observer.restore()
  expect(trace.existingWindowsAtInstall).toBe(0)
  expect(trace.readFailures).toBe(0)
  expect(trace.events.map(row => row.kind)).toEqual(['observer-installed', 'web-contents-created', 'setBackgroundThrottling:call',
    'setBackgroundThrottling:return', 'browser-window-created', 'addChildView:call', 'addChildView:return', 'setBounds:call',
    'setBounds:return', 'setVisible:call', 'setVisible:return', 'contents:did-start-navigation', 'contents:did-finish-load',
    'setBackgroundThrottling:call', 'setBackgroundThrottling:return'])
  expect(trace.events[1]!.detail).toMatchObject({ contents: { id: 2, owner: { value: null }, backgroundThrottling: { value: true } } })
  expect(trace.events[5]!.detail).toMatchObject({ index: 1, child: { contents: { id: 2 } } })
  expect(trace.events.at(-1)!.detail).toMatchObject({ requestedPolicy: true, contents: { url: { value: 'http://localhost/form' },
    loading: { value: false }, backgroundThrottling: { value: true }, owner: { value: { id: 1, visible: { value: true }, focused: { value: false } } },
    mainFrame: { value: { processId: 17, osProcessId: 1700, routingId: 3, frameTreeNodeId: 41, url: 'http://localhost/form' } } } })
  expect(JSON.stringify(trace)).not.toContain('private=ignored')
  expect(wc.setterCalls).toEqual([true, true])
  expect(Object.getOwnPropertyDescriptor(f.View.prototype, 'setBounds')).toEqual(f.methods.setBounds)
  expect(f.app.listenerCount('web-contents-created')).toBe(0)
  expect(wc.eventNames()).toEqual([])
})

it('preserves the exact receiver, argument object, returned Promise and thrown object', () => {
  const f = fixture(true), view = new f.View()
  const promise = Promise.resolve('same value')
  view.returnValue = promise
  const bounds = { x: 1, y: 2, width: 30, height: 40 }
  expect(view.setBounds(bounds)).toBe(promise)
  expect(view.received).toEqual([bounds]); expect(view.received[0]).toBe(bounds)
  const failure = new Error('Original native error')
  view.failure = failure
  let caught: unknown
  try { view.setBounds(bounds) } catch (error) { caught = error }
  expect(caught).toBe(failure)
  const trace = f.observer.restore()
  expect(trace.events.map(row => row.kind)).toEqual(['observer-installed', 'setBounds:call', 'setBounds:return', 'setBounds:call', 'setBounds:throw'])
})

it('does not inspect returned then getters, schedule Promise handlers or read requested rectangle getters', () => {
  const f = fixture(true), view = new f.View()
  let thenReads = 0, rectangleReads = 0
  const value = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('then read') } })
  view.returnValue = value
  const bounds = Object.defineProperty({ y: 2, width: 30, height: 40 }, 'x', { get() { rectangleReads++; return 1 } }) as typeof view.bounds
  expect(view.setBounds(bounds)).toBe(value)
  // The original model stores the request; its public getBounds then exposes it.
  // The observer may read that public result, but must not inspect the request before the call.
  expect(thenReads).toBe(0)
  expect(rectangleReads).toBe(1)
  const trace = f.observer.restore()
  expect(trace.events[1]!.detail).toMatchObject({ requestedBounds: { x: null, y: 2, width: 30, height: 40 } })
})

it('reports public facts unavailable without replacing a successful original call or mutating policy', () => {
  const f = fixture(true), wc = new f.Contents(2)
  wc.getURL = () => { throw new Error('Destroyed getter') }
  f.app.emit('web-contents-created', {}, wc)
  wc.setBackgroundThrottling(true)
  const trace = f.observer.restore()
  expect(trace.readFailures).toBeGreaterThan(0)
  expect(trace.events.at(-1)!.detail).toMatchObject({ contents: { url: { unavailable: 'Error' }, backgroundThrottling: { value: true } } })
  expect(wc.setterCalls).toEqual([true])
})

it('records incomplete installation without interrupting app ready or changing original descriptors', () => {
  const f = fixture()
  Object.defineProperty(f.View.prototype, 'setBounds', { value: null, configurable: true })
  expect(() => f.goReady()).not.toThrow()
  const trace = f.observer.restore()
  expect(trace).toMatchObject({ installed: false, installError: 'Error' })
  expect(Object.getOwnPropertyDescriptor(f.View.prototype, 'addChildView')).toEqual(f.methods.addChildView)
  expect(f.app.listenerCount('web-contents-created')).toBe(0)
})

it('restores only its own wrappers and does not overwrite a later private observer', () => {
  const f = fixture(true)
  const later = () => {}
  Object.defineProperty(f.View.prototype, 'setVisible', { ...f.methods.setVisible, value: later })
  const trace = f.observer.restore()
  expect(f.View.prototype.setVisible).toBe(later)
  expect(trace.restoreConflicts).toEqual([{ method: 'setVisible', reason: 'method-replaced' }])
  expect(Object.getOwnPropertyDescriptor(f.View.prototype, 'setBounds')).toEqual(f.methods.setBounds)
  expect(f.observer.restore().events).toEqual(trace.events)
})

it('can be removed before ready with no delayed reinstallation', () => {
  const f = fixture()
  f.observer.restore(); f.goReady()
  expect(f.observer.drain()).toMatchObject({ active: false, installed: false, awaitingReady: false, events: [] })
  expect(Object.getOwnPropertyDescriptor(f.View.prototype, 'setBounds')).toEqual(f.methods.setBounds)
})

it('bounds event output and stops extra public getter work after the budget is exhausted', () => {
  const f = fixture(true), view = new f.View()
  let reads = 0
  view.getBounds = () => { reads++; return view.bounds }
  for (let i = 0; i < 300; i++) view.setVisible(true)
  const atLimit = reads
  view.setVisible(false)
  const trace = f.observer.restore()
  expect(trace.events).toHaveLength(512)
  expect(trace.dropped).toBeGreaterThan(0)
  expect(reads).toBe(atLimit)
  expect(view.visible).toBe(false)
})

it('bounds created contents registration and never creates another owner or listener loop', () => {
  const f = fixture(true), actual: InstanceType<typeof f.Contents>[] = []
  for (let i = 1; i <= 34; i++) { const wc = new f.Contents(i); actual.push(wc); f.app.emit('web-contents-created', {}, wc) }
  expect(actual).toHaveLength(34)
  expect(actual.slice(32).map(wc => wc.eventNames())).toEqual([[], []])
  let ignoredReads = 0
  actual[33]!.getURL = () => { ignoredReads++; return '' }
  const before = f.observer.drain().events.length
  actual[33]!.setBackgroundThrottling(false)
  expect(ignoredReads).toBe(0)
  expect(f.observer.drain().events).toHaveLength(before)
  const trace = f.observer.restore()
  expect(trace.ignoredContents).toBe(2)
  expect(trace.events.filter(row => row.kind === 'web-contents-created')).toHaveLength(32)
  expect(actual.map(wc => wc.setterCalls)).toEqual([...Array.from({ length: 33 }, () => []), [false]])
})

it('observes an actual own setter descriptor without stacking shared wrappers or invoking the setter', () => {
  const f = fixture(true), own = new f.Contents(1), shared = new f.Contents(2), third = new f.Contents(3)
  const original = function (this: InstanceType<typeof f.Contents>, value: boolean) { this.setterCalls.push(value); this.policy = value }
  Object.defineProperty(own, 'setBackgroundThrottling', { value: original, writable: true, configurable: true })
  const descriptor = Object.getOwnPropertyDescriptor(own, 'setBackgroundThrottling')
  for (const wc of [own, shared, third]) f.app.emit('web-contents-created', {}, wc)
  expect([own.setterCalls, shared.setterCalls, third.setterCalls]).toEqual([[], [], []])
  own.setBackgroundThrottling(false); shared.setBackgroundThrottling(true); third.setBackgroundThrottling(false)
  const trace = f.observer.restore()
  expect(trace.events.filter(row => row.kind === 'setBackgroundThrottling:call').map(row => (row.detail.contents as { id: number }).id)).toEqual([1, 2, 3])
  expect(Object.getOwnPropertyDescriptor(own, 'setBackgroundThrottling')).toEqual(descriptor)
  expect([own.setterCalls, shared.setterCalls, third.setterCalls]).toEqual([[false], [true], [false]])
})

it('records public created-frame details and null after destruction without enumerating private frame internals', () => {
  const f = fixture(true), wc = new f.Contents(1)
  f.app.emit('web-contents-created', {}, wc)
  wc.emit('frame-created', {}, { frame: { ...wc.mainFrame, routingId: 8, frameTreeNodeId: 47, url: 'https://user:password@localhost/child?secret=ignored#fragment' } })
  wc.emit('frame-created', {}, { frame: null })
  const rows = f.observer.restore().events.filter(row => row.kind === 'contents:frame-created')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.detail).toMatchObject({ createdFrame: { value: { processId: 17, osProcessId: 1700, routingId: 8, frameTreeNodeId: 47, url: 'https://localhost/child' } } })
  expect(rows[1]!.detail).toMatchObject({ createdFrame: { value: null } })
  expect(JSON.stringify(rows)).not.toContain('password')
  expect(JSON.stringify(rows)).not.toContain('secret=ignored')
})

it('keeps public hostless URL schemes accurate while omitting payload and query values', () => {
  const f = fixture(true), wc = new f.Contents(1)
  f.app.emit('web-contents-created', {}, wc)
  for (const url of ['about:blank?private=ignored', 'data:text/html,private=ignored', 'file:///private/fixture?private=ignored']) {
    wc.url = url; wc.emit('did-finish-load')
  }
  const rows = f.observer.restore().events.filter(row => row.kind === 'contents:did-finish-load')
  expect(rows.map(row => (row.detail.contents as { url: { value: string } }).url.value)).toEqual(['about:blank', 'data:', 'file:///private/fixture'])
})

it('marks pre-existing windows as a coverage limitation rather than claiming complete startup', () => {
  const f = fixture()
  f.Window.existing = [new f.Window()]
  f.goReady()
  expect(f.observer.restore()).toMatchObject({ installed: true, existingWindowsAtInstall: 1 })
})
