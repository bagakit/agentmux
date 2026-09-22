import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Serialized into one private probe Main. No production API or renderer script is installed.
export function createNativeChromeStageObserver({ app, window, now = () => performance.now() }) {
  let active = true, dropped = 0, ignoredContents = 0, observationFailures = 0, callId = 0
  const started = now(), events = [], entries = new Map(), restoreFailures = []
  const chromeDocument = value => typeof value === 'string' && value.startsWith('data:text/html,') && value.includes('Content-Security-Policy')
  const record = (entry, stage, detail = {}) => {
    if (!active) return
    if (events.length >= 256) { dropped++; return }
    try {
      events.push({ sequence: events.length + 1, relativeMs: now() - started,
        contentsId: entry.id, role: entry.role, stage, ...detail })
    } catch { observationFailures++ }
  }
  const failure = error => ({ errorName: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'UnknownError' })
  const owned = contents => {
    try { return contents.getOwnerBrowserWindow() === window && window.contentView.children.some(view => view.webContents === contents) }
    catch { return false }
  }
  const restoreEntry = entry => {
    for (const [name, callback] of entry.listeners) entry.contents.removeListener(name, callback)
    entry.listeners.clear()
    for (const [name, saved] of entry.methods) {
      // Do not overwrite another observer that replaced this method after installation.
      if (Object.getOwnPropertyDescriptor(entry.contents, name)?.value !== saved.wrapper) {
        restoreFailures.push({ contentsId: entry.id, method: name, reason: 'method-replaced' })
        continue
      }
      if (saved.descriptor) Object.defineProperty(entry.contents, name, saved.descriptor)
      else delete entry.contents[name]
    }
    entry.methods.clear()
    entries.delete(entry.contents)
  }
  const wrap = (entry, name, classify) => {
    if (entry.methods.has(name)) return
    const original = entry.contents[name], descriptor = Object.getOwnPropertyDescriptor(entry.contents, name)
    if (typeof original !== 'function') throw new Error(`Probe method unavailable: ${name}`)
    function wrapper(...args) {
      let detail
      try { if (active) detail = classify(args) } catch { record(entry, 'observer-classification-failed', { method: name }) }
      if (!detail) return Reflect.apply(original, this, args)
      const id = ++callId
      record(entry, `${name}:start`, { callId: id, ...detail })
      let value
      try { value = Reflect.apply(original, this, args) }
      catch (error) { record(entry, `${name}:throw`, { callId: id, ...failure(error) }); throw error }
      let promiseObserved = false
      if (value && (typeof value === 'object' || typeof value === 'function')) {
        // This branch observes the native Promise. The caller receives that very same Promise.
        try {
          Promise.prototype.then.call(value,
            result => { record(entry, `${name}:fulfilled`, { callId: id, resultKind: typeof result }) },
            error => { record(entry, `${name}:rejected`, { callId: id, ...failure(error) }) })
          promiseObserved = true
        } catch { /* A synchronous value is not a native Promise; do not read its then getter. */ }
      }
      if (!promiseObserved) record(entry, `${name}:returned`, { callId: id, resultKind: typeof value })
      return value
    }
    Object.defineProperty(entry.contents, name, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper })
    entry.methods.set(name, { descriptor, wrapper })
  }
  const nativeEvents = entry => {
    for (const name of ['dom-ready', 'did-finish-load', 'did-fail-load', 'destroyed']) {
      const callback = () => {
        record(entry, `native:${name}`)
        if (name === 'destroyed') restoreEntry(entry)
      }
      entry.contents.on(name, callback)
      entry.listeners.set(name, callback)
    }
  }
  const observeChrome = entry => {
    if (entry.role === 'chrome-data-document') return
    entry.role = 'chrome-data-document'
    record(entry, 'owner-observed', { windowId: window.id })
    nativeEvents(entry)
    wrap(entry, 'capturePage', () => ({ classification: 'chrome-frame' }))
    wrap(entry, 'executeJavaScript', args => {
      if (typeof args[0] !== 'string') return
      if (/\bimage\.src\s*=/.test(args[0])) return { classification: 'image-source-command' }
      if (args[0].includes('document.body.style.backgroundColor=')) return { classification: 'scrim-command' }
    })
    wrap(entry, 'setBackgroundThrottling', args => ({ classification: 'platform-throttling', ...(typeof args[0] === 'boolean' ? { value: args[0] } : {}) }))
  }
  const entryFor = contents => {
    if (entries.has(contents)) return entries.get(contents)
    if (entries.size >= 32) { ignoredContents++; return }
    const entry = { contents, id: contents.id, role: 'unclassified', methods: new Map(), listeners: new Map() }
    entries.set(contents, entry)
    return entry
  }
  const watchCreated = (_event, contents) => {
    if (!active || contents === window.webContents) return
    const entry = entryFor(contents)
    if (!entry) return
    try {
      // Construction precedes attachment. Claim a Chrome only at its actual loadURL call.
      wrap(entry, 'loadURL', args => {
        if (!chromeDocument(args[0]) || !owned(contents)) { restoreEntry(entry); return }
        observeChrome(entry)
        return { classification: 'chrome-document' }
      })
    } catch { record(entry, 'observer-install-failed'); restoreEntry(entry) }
  }
  const snapshot = () => ({ schema: 'agentmux.native-chrome-stage-observer.v1', windowId: window.id,
    active, events: events.map(event => ({ ...event })), truncated: dropped > 0, dropped, ignoredContents, observationFailures,
    restoreFailures: restoreFailures.map(item => ({ ...item })) })
  const restore = () => {
    active = false
    app.removeListener('web-contents-created', watchCreated)
    for (const entry of [...entries.values()]) restoreEntry(entry)
    return snapshot()
  }
  try {
    const primary = entryFor(window.webContents)
    primary.role = 'original-renderer'
    wrap(primary, 'capturePage', args => ({ classification: args[0] ? 'rectangle-frame' : 'whole-frame' }))
    app.on('web-contents-created', watchCreated)
    for (const view of window.contentView.children) {
      const contents = view.webContents
      if (contents && contents !== window.webContents && owned(contents) && chromeDocument(contents.getURL())) {
        const entry = entryFor(contents)
        if (entry) observeChrome(entry)
      }
    }
  } catch (error) { restore(); throw error }
  return { drain: snapshot, restore }
}

export async function installNativeChromeStageObserver(ctx) {
  const key = `__privateNativeChromeStageObserver_${randomUUID().replaceAll('-', '')}`
  await ctx.probe.main.evaluate(`(()=>{
    const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot, 'package.json'))})('electron');
    const windows=BrowserWindow.getAllWindows();
    if(windows.length!==1)throw new Error('Stage observer requires the sole private probe window');
    globalThis[${JSON.stringify(key)}]=(${createNativeChromeStageObserver.toString()})({app,window:windows[0]});
    return {installed:true,windowId:windows[0].id};
  })()`)
  return {
    drain: () => ctx.probe.main.evaluate(`globalThis[${JSON.stringify(key)}].drain()`),
    restore: () => ctx.probe.main.evaluate(`(()=>{const key=${JSON.stringify(key)},observer=globalThis[key];try{return observer.restore()}finally{delete globalThis[key]}})()`)
  }
}
