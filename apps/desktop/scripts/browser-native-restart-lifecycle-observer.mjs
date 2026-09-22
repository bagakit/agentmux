/**
 * @typedef {{ app: import('electron').App, View: typeof import('electron').View,
 *   BrowserWindow: typeof import('electron').BrowserWindow, enabled?: boolean,
 *   now?: () => number }} RestartObserverOptions
 * @typedef {{ sequence: number, relativeMs: number, kind: string,
 *   detail: Record<string, unknown> }} RestartLifecycleRow
 */

/**
 * Private diagnostic only. Serialize this function at the existing imports-complete
 * Main pause. It waits for the public app ready event, never schedules work, and
 * never changes Browser policy, geometry, visibility, input or frame readiness.
 * @param {RestartObserverOptions} options
 */
export function createNativeRestartLifecycleObserver({ app, View, BrowserWindow, enabled = false, now = () => performance.now() }) {
  /** @type {RestartLifecycleRow[]} */ const events = []
  /** @type {Array<() => void>} */ const cleanups = []
  /** @type {Array<{method: string, reason: string}>} */ const restoreConflicts = []
  /** @type {WeakMap<object, number>} */ const viewIds = new WeakMap()
  /** @type {Map<import('electron').WebContents, true>} */ const contents = new Map()
  /** @type {Map<import('electron').BrowserWindow, true>} */ const windows = new Map()
  let active = enabled, installed = false, awaitingReady = false, dropped = 0, readFailures = 0
  let ignoredContents = 0, ignoredWindows = 0, ignoredViews = 0, viewSerial = 0, callSerial = 0
  let existingWindowsAtInstall = 0, installError = '', started = 0
  const limits = { events: 512, contents: 32, windows: 8, views: 64 }
  const errorKind = (/** @type {unknown} */ error) => {
    try { const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'name')?.value : null; return typeof value === 'string' ? value.slice(0, 80) : 'Error' }
    catch { return 'UnknownError' }
  }
  const fact = (/** @type {() => unknown} */ read) => {
    try { return { value: read() } } catch (error) { readFailures++; return { unavailable: errorKind(error) } }
  }
  const safeUrl = (/** @type {string} */ raw) => {
    try { const url = new URL(raw); return url.protocol === 'data:' ? 'data:' : `${url.protocol}${url.host || url.protocol === 'file:' ? `//${url.host}` : ''}${url.pathname}`.slice(0, 240) }
    catch { return raw === '' ? '' : 'unparseable-url' }
  }
  const viewId = (/** @type {object} */ view) => {
    const known = viewIds.get(view); if (known) return known
    if (viewSerial >= limits.views) { ignoredViews++; return null }
    const id = ++viewSerial; viewIds.set(view, id); return id
  }
  const windowFacts = (/** @type {import('electron').BrowserWindow} */ window) => ({
    id: window.id, destroyed: fact(() => window.isDestroyed()), visible: fact(() => window.isVisible()),
    focused: fact(() => window.isFocused()), minimized: fact(() => window.isMinimized())
  })
  const frameFacts = (/** @type {import('electron').WebFrameMain} */ frame) => ({
    destroyed: frame.isDestroyed(), processId: frame.processId, osProcessId: frame.osProcessId,
    routingId: frame.routingId, frameTreeNodeId: frame.frameTreeNodeId, url: safeUrl(frame.url)
  })
  const contentsFacts = (/** @type {import('electron').WebContents} */ wc) => ({
    id: wc.id, destroyed: fact(() => wc.isDestroyed()), url: fact(() => safeUrl(wc.getURL())),
    loading: fact(() => wc.isLoading()), backgroundThrottling: fact(() => wc.getBackgroundThrottling()),
    owner: fact(() => { const owner = BrowserWindow.fromWebContents(wc); return owner ? windowFacts(owner) : null }),
    mainFrame: fact(() => frameFacts(wc.mainFrame))
  })
  const viewFacts = (/** @type {import('electron').View} */ view) => {
    const native = /** @type {import('electron').View & {webContents?: import('electron').WebContents}} */ (view)
    return { id: viewId(view), bounds: fact(() => { const b = view.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } }),
      visible: fact(() => view.getVisible()), ...(native.webContents ? { contents: contentsFacts(native.webContents) } : {}) }
  }
  const record = (/** @type {string} */ kind, /** @type {() => Record<string, unknown>} */ read) => {
    if (!active) return
    if (events.length >= limits.events) { dropped++; return }
    try { events.push({ sequence: events.length + 1, relativeMs: now() - started, kind, detail: read() }) }
    catch { readFailures++ }
  }
  const rectArg = (/** @type {unknown} */ value) => {
    if (!value || typeof value !== 'object') return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, typeof descriptors[key]?.value === 'number' ? descriptors[key].value : null]))
  }
  /** Preserve exact receiver, arguments, return/Promise identity and thrown object. */
  const wrap = (/** @type {object} */ owner, /** @type {string} */ name,
    /** @type {(receiver: unknown, args: unknown[]) => Record<string, unknown>} */ describe,
    /** @type {(receiver: unknown) => boolean} */ eligible = () => true) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    if (!descriptor || typeof descriptor.value !== 'function') throw new Error('Native method descriptor unavailable')
    const original = descriptor.value
    /** @this {unknown} @param {...unknown} args */
    function observed(...args) {
      if (!active || !eligible(this)) return Reflect.apply(original, this, args)
      const callId = ++callSerial
      record(`${name}:call`, () => ({ callId, ...describe(this, args) }))
      try {
        const value = Reflect.apply(original, this, args)
        record(`${name}:return`, () => ({ callId, ...describe(this, args) }))
        return value
      } catch (error) {
        record(`${name}:throw`, () => ({ callId, errorKind: errorKind(error) }))
        throw error
      }
    }
    Object.defineProperty(owner, name, { ...descriptor, value: observed })
    cleanups.push(() => {
      if (Object.getOwnPropertyDescriptor(owner, name)?.value === observed) Object.defineProperty(owner, name, descriptor)
      else if (restoreConflicts.length < 64) restoreConflicts.push({ method: name, reason: 'method-replaced' })
    })
  }
  const listen = (/** @type {import('node:events').EventEmitter} */ emitter, /** @type {string} */ name,
    /** @type {(...args: any[]) => void} */ callback) => {
    emitter.on(name, callback); cleanups.push(() => emitter.removeListener(name, callback))
  }
  const watchContents = (/** @type {import('electron').WebContents} */ wc) => {
    if (contents.has(wc)) return
    if (contents.size >= limits.contents) { ignoredContents++; return }
    contents.set(wc, true)
    record('web-contents-created', () => ({ contents: contentsFacts(wc) }))
    let prototype = /** @type {object | null} */ (wc)
    for (let depth = 0; prototype && depth < 8 && !Object.hasOwn(prototype, 'setBackgroundThrottling'); depth++) prototype = Object.getPrototypeOf(prototype)
    // Follow the actual own/prototype descriptor; a shared descriptor is wrapped once.
    if (prototype && !wrappedContentsPrototypes.has(prototype)) {
      wrap(prototype, 'setBackgroundThrottling', (receiver, args) => ({
        requestedPolicy: typeof args[0] === 'boolean' ? args[0] : null,
        contents: contentsFacts(/** @type {import('electron').WebContents} */ (receiver))
      }), receiver => contents.has(/** @type {import('electron').WebContents} */ (receiver)))
      wrappedContentsPrototypes.add(prototype)
    }
    listen(wc, 'frame-created', (_event, details) => record('contents:frame-created', () => ({
      contents: contentsFacts(wc), createdFrame: fact(() => details.frame ? frameFacts(details.frame) : null)
    })))
    for (const name of ['dom-ready', 'did-start-loading', 'did-stop-loading', 'did-finish-load', 'did-fail-load',
      'did-start-navigation', 'did-navigate', 'did-frame-navigate', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) {
      listen(wc, name, (...args) => record(`contents:${name}`, () => {
        const event = args[0] && typeof args[0] === 'object' ? Object.getOwnPropertyDescriptors(args[0]) : {}
        const url = typeof event.url?.value === 'string' ? event.url.value : typeof args[1] === 'string' ? args[1] : null
        return { contents: contentsFacts(wc), navigation: { url: url === null ? null : safeUrl(url),
          isMainFrame: typeof event.isMainFrame?.value === 'boolean' ? event.isMainFrame.value : typeof args[4] === 'boolean' ? args[4] : null,
          isSameDocument: typeof event.isSameDocument?.value === 'boolean' ? event.isSameDocument.value : null } }
      }))
    }
  }
  /** @type {Set<object>} */ const wrappedContentsPrototypes = new Set()
  const watchWindow = (/** @type {import('electron').BrowserWindow} */ window) => {
    if (windows.size >= limits.windows) { ignoredWindows++; return }
    windows.set(window, true)
    record('browser-window-created', () => ({ window: windowFacts(window), rootViewId: viewId(window.contentView) }))
    for (const name of ['show', 'hide', 'focus', 'blur', 'closed']) listen(window, name, () => record(`window:${name}`, () => ({ window: windowFacts(window) })))
  }
  const restoreMethods = () => {
    for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup() } catch { readFailures++ } }
    contents.clear(); windows.clear()
  }
  const install = () => {
    awaitingReady = false
    if (!active) return
    try {
      existingWindowsAtInstall = BrowserWindow.getAllWindows().length
      for (const name of ['addChildView', 'removeChildView', 'setBounds', 'setVisible']) {
        wrap(View.prototype, name, (receiver, args) => ({ view: viewFacts(/** @type {import('electron').View} */ (receiver)),
          ...(name === 'addChildView' || name === 'removeChildView' ? { child: args[0] instanceof View ? viewFacts(args[0]) : null,
            ...(name === 'addChildView' ? { index: typeof args[1] === 'number' ? args[1] : null } : {}) } : {}),
          ...(name === 'setBounds' ? { requestedBounds: rectArg(args[0]) } : {}),
          ...(name === 'setVisible' ? { requestedVisible: typeof args[0] === 'boolean' ? args[0] : null } : {}) }))
      }
      listen(app, 'web-contents-created', (_event, wc) => { try { watchContents(wc) } catch { readFailures++ } })
      listen(app, 'browser-window-created', (_event, window) => { try { watchWindow(window) } catch { readFailures++ } })
      installed = true; record('observer-installed', () => ({ existingWindowsAtInstall }))
    } catch (error) { installError = errorKind(error); restoreMethods() }
  }
  const drain = () => ({ schema: 'agentmux.native-restart-lifecycle-observer.v1', enabled, active, installed, awaitingReady,
    existingWindowsAtInstall, installError: installError || null, events: structuredClone(events), limits,
    dropped, ignoredContents, ignoredWindows, ignoredViews, readFailures, restoreConflicts: restoreConflicts.map(item => ({ ...item })) })
  if (enabled) {
    started = now()
    try {
      if (app.isReady()) install()
      else { awaitingReady = true; app.once('ready', install); cleanups.push(() => app.removeListener('ready', install)) }
    } catch (error) { installError = errorKind(error); restoreMethods() }
  }
  return { drain, restore() { active = false; awaitingReady = false; restoreMethods(); return drain() } }
}
