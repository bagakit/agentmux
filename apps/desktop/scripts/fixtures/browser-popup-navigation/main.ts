import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, type WebContents, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserPopupWindows } from '../../../src/main/browser-popup-windows'
import { themeBootstrap } from '../../../src/main/theme-bootstrap'

const home = process.env.AGENTMUX_POPUP_HOME!, out = process.env.AGENTMUX_POPUP_OUT!, assets = process.env.AGENTMUX_POPUP_ASSETS!
assert.ok(home && out && assets, 'This fixture needs its own explicit private namespace')
const receipt: any = { schema: 'agentmux.browser-popup-navigation.native.v1', passed: false, pid: process.pid,
  cases: [], requests: [], windows: [], calls: [], images: [], cleanup: [], clipboardWrites: 0, runtimeConnections: 0,
  boundary: 'Actual BVM native window-open consumer, dedicated preload and original navigation Renderer. Native programmatic input is not physical OS input. No user App, Agent, Runtime or clipboard writer.' }
// Electron's default uncaught handler opens a modal crash dialog. Retain the exact
// exception for the negative constructor proof, then let the owning assertion clean up.
process.on('uncaughtException', error => { (receipt.uncaughtExceptions ??= []).push({ name: error.name, message: error.message }); console.error(error) })
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let rootWindow: BrowserWindow | undefined, manager: BrowserViewManager | undefined, server: Server | undefined
const captureManagers: BrowserViewManager[] = []
let origin = '', appearance: 'light' | 'dark' = 'light'
const children = new Set<BrowserWindow>()
const closePrompts: Array<{ window: BrowserWindow; resolve(value: boolean): void }> = []
const created = (window: BrowserWindow) => {
  if (window === rootWindow) return
  children.add(window)
  const ipc = window.webContents.ipc, handle = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) => handle(channel, (event, ...args) => {
    const row: any = { channel, args, senderId: event.sender.id, frame: event.senderFrame?.url ?? null }
    receipt.calls.push(row)
    return Promise.resolve(listener(event, ...args)).then(result => { row.result = result; row.finished = true; return result }, error => { row.error = String(error); row.finished = true; throw error })
  })
  const row: any = { windowId: window.id, shellId: window.webContents.id, mediaSourceId: window.getMediaSourceId() }
  receipt.windows.push(row)
  window.once('ready-to-show', () => { row.chromeReadyToShow = true })
  window.once('closed', () => { row.closed = true; children.delete(window) })
}
async function checkpoint(step: string) {
  receipt.step = step
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
}
async function until<T>(name: string, read: () => Promise<T | false> | T | false, budget = 4000): Promise<T> {
  const end = performance.now() + budget
  while (performance.now() < end) { const value = await read(); if (value) return value; await delay(15) }
  throw new Error('Popup prerequisite was not observed: ' + name)
}
function actualPage(window: BrowserWindow): WebContents | undefined {
  return window.contentView.children.flatMap(view => 'webContents' in view ? [(view as WebContentsView).webContents] : [])
    .find(contents => contents !== window.webContents && !contents.isDestroyed())
}
async function openedAction(action: () => Promise<unknown>, name: string) {
  const before = new Set(children)
  const failuresBefore = receipt.constructionFailures?.length ?? 0
  await action()
  const window = await until(name + ' creates an actual native child', () => {
    assert.equal(receipt.constructionFailures?.length ?? 0, failuresBefore, 'Actual native popup construction succeeds without the original undefined-WebContents exception')
    return [...children].find(child => !before.has(child) && !child.isDestroyed()) || false
  })
  const page = await until(name + ' attaches its original native page', () => actualPage(window) || false)
  await until(name + ' loads actual production navigation', async () => {
    if (window.webContents.isDestroyed()) return false
    return await window.webContents.executeJavaScript("Boolean(document.querySelector('input[aria-label=\"Browser address\"]'))").catch(() => false)
  })
  assert.notEqual(page, window.webContents, 'The website stays outside the trusted navigation document')
  return { window, page }
}
async function opened(parent: WebContents, code: string, name: string) {
  return openedAction(() => parent.executeJavaScript(code, true), name)
}
async function nativeLink(parent: WebContents, path: string, name: string, button: 'left' | 'middle' = 'left', modified = true, frame?: Electron.WebFrameMain) {
  const target = origin + path, owner = frame ?? parent.mainFrame
  const beforeURL = parent.getURL(), beforeDraft = await parent.executeJavaScript('document.querySelector("#original-draft")?.value ?? null')
  const callbacksBefore = receipt.originalCallbacks?.length ?? 0, eventsBefore = receipt.nativeWindowOpens?.length ?? 0
  const point = await owner.executeJavaScript(`(()=>{const input=[];window.__nativeInputEvents=input;for(const type of ['mousedown','mouseup','click','auxclick'])document.addEventListener(type,e=>input.push({type,target:e.target.id,button:e.button,meta:e.metaKey,control:e.ctrlKey,x:e.clientX,y:e.clientY}),{once:true,capture:true});const a=document.createElement('a');a.id='native-link';a.href=${JSON.stringify(target)};a.textContent='Open original native child';a.style.cssText='display:block;padding:16px';document.body.append(a);a.scrollIntoView();const r=a.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  if (frame) {
    const offset = await parent.executeJavaScript('(()=>{const r=document.querySelector("#sandbox-frame").getBoundingClientRect();return{x:r.x+2,y:r.y+2}})()')
    point.x += offset.x; point.y += offset.y
  }
  const zoom = parent.getZoomFactor()
  const cssPoint = { ...point }
  point.x = Math.round(point.x * zoom); point.y = Math.round(point.y * zoom)
  rootWindow!.show(); app.focus({ steal: true }); rootWindow!.focus(); parent.focus()
  const modifiers = modified ? [process.platform === 'darwin' ? 'meta' : 'control'] : []
  await delay(50)
  const child = await openedAction(async () => {
    if (frame) {
      const attached = parent.debugger.isAttached()
      if (!attached) parent.debugger.attach('1.3')
      try {
        const cdpModifiers = modified ? process.platform === 'darwin' ? 4 : 2 : 0
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cssPoint })
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...cssPoint, button, clickCount: 1, modifiers: cdpModifiers })
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...cssPoint, button, clickCount: 1, modifiers: cdpModifiers })
      } finally { if (!attached) parent.debugger.detach() }
    } else {
      parent.sendInputEvent({ type: 'mouseMove', ...point })
      parent.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1, modifiers: [...modifiers, button === 'middle' ? 'middleButtonDown' : 'leftButtonDown'] })
      parent.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1, modifiers })
    }
    await delay(100)
    ;(receipt.nativeInputEvents ??= []).push({ name, point, cssPoint, zoom, inputSource: frame ? 'Chromium Input.dispatchMouseEvent for actual OOPIF' : 'Electron WebContents.sendInputEvent',
      sourceProcessId: parent.mainFrame.processId, frameProcessId: owner.processId,
      hit: await parent.executeJavaScript(`document.elementFromPoint(${cssPoint.x},${cssPoint.y})?.id`), input: await owner.executeJavaScript('window.__nativeInputEvents') })
  }, name)
  // Observe the actual native page for a bounded interval, then assert its URL.
  // A dropped continuation is an owning assertion failure, never a timeout prerequisite.
  const deadline = performance.now() + 2500
  while (performance.now() < deadline && (child.page.isLoading() || child.page.getURL() !== target)) await delay(15)
  const callback = receipt.originalCallbacks.slice(callbacksBefore).find((row: any) => row.pageId === child.page.id)
  const events = receipt.nativeWindowOpens.slice(eventsBefore).filter((row: any) => row.sourceId === parent.id && row.url === target)
  ;(receipt.nativeLinkObservations ??= []).push({ name, target, sourceId: parent.id, childId: child.page.id, button, modifiers, callback, events, actualURL: child.page.getURL(), sourceURL: parent.getURL() })
  await checkpoint('native-link-observed-' + name)
  assert.equal(child.page.getURL(), target, 'Actual native continuation navigates the original guestless child URL: ' + name)
  assert.equal(events.length, 1, 'One original native OpenURLFromTab event belongs to the exact source and target: ' + name)
  assert.equal(events[0].hasNavigate, true, 'The native input supplies its original Chromium continuation: ' + name)
  assert.equal(callback.guestId, null, 'This actual native link exercises the guestless creation branch: ' + name)
  assert.equal(callback.navigations.filter((row: any) => row.url === target).length, 1, 'The original guestless child starts its exact target navigation once: ' + name)
  const input = receipt.nativeInputEvents.find((row: any) => row.name === name).input
  assert.ok(input.some((row: any) => row.target === 'native-link' && row.type === 'mousedown' && row.button === (button === 'middle' ? 1 : 0) &&
    (!modified || (process.platform === 'darwin' ? row.meta : row.control))), 'The original page receives the exact native mouse input: ' + name)
  assert.equal(child.page.session, parent.session, 'Guestless native input retains the original source Session: ' + name)
  assert.equal(parent.getURL(), beforeURL, 'Opening a native child preserves the original source URL: ' + name)
  assert.equal(await parent.executeJavaScript('document.querySelector("#original-draft")?.value ?? null'), beforeDraft, 'Opening a native child preserves the unsent source draft: ' + name)
  const prefs = (child.page as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false)
  assert.equal(await child.page.executeJavaScript('typeof window.agentmux'), 'undefined')
  assert.equal(await child.page.executeJavaScript('typeof window.browserPopup'), 'undefined')
  return child
}
async function settlePage(page: WebContents, path: string) {
  await until('exact original native document ' + path, async () => !page.isDestroyed() && !page.isLoading() && new URL(page.getURL()).pathname === path)
}
async function navigationFacts(window: BrowserWindow, page: WebContents) {
  const view = window.contentView.children.find(view => 'webContents' in view && (view as WebContentsView).webContents === page)
  assert.ok(view, 'Navigation observations belong to the original native page and shell')
  const chrome = await window.webContents.executeJavaScript(`(async()=>{
    const snapshot=await browserPopup.inspect();
    const address=document.querySelector('input[aria-label="Browser address"]');
    const button=label=>document.querySelector('button[aria-label="'+label+'"]');
    return{snapshot:{url:snapshot.url,title:snapshot.title,canGoBack:snapshot.canGoBack,canGoForward:snapshot.canGoForward,loading:snapshot.loading,error:snapshot.error,warning:snapshot.warning,mode:snapshot.mode},
      document:{url:location.href,visibilityState:document.visibilityState,focused:document.hasFocus(),readyState:document.readyState},
      dom:{address:address?.value??null,addressFocused:document.activeElement===address,backDisabled:button('Back')?.disabled??null,forwardDisabled:button('Forward')?.disabled??null,reload:Boolean(button('Reload')),stop:Boolean(button('Stop loading'))}};
  })()`)
  return {
    page: { nativeUrl: page.getURL(), loading: page.isLoading(), processId: page.mainFrame.processId, frameToken: page.mainFrame.frameToken,
      ...await page.executeJavaScript('({title:document.title,url:location.href,width:innerWidth,height:innerHeight,visibilityState:document.visibilityState,focused:document.hasFocus(),heading:document.querySelector("h1")?.textContent})') },
    chrome,
    nativeWindow: { visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), bounds: window.getBounds(), contentBounds: window.getContentBounds() },
    pageView: { bounds: view.getBounds(), visible: view.getVisible(), memberOfOriginalWindow: true }
  }
}
async function navigationAcknowledged(window: BrowserWindow, page: WebContents, expected: { url: string; canGoBack: boolean; canGoForward: boolean }, name: string) {
  const deadline = performance.now() + 4000
  let observed = await navigationFacts(window, page)
  while (performance.now() < deadline) {
    const { snapshot, dom } = observed.chrome
    if (snapshot.url === expected.url && snapshot.canGoBack === expected.canGoBack && snapshot.canGoForward === expected.canGoForward && !snapshot.loading &&
      dom.address === expected.url && dom.backDisabled === !expected.canGoBack && dom.forwardDisabled === !expected.canGoForward && dom.reload && !dom.stop) break
    await delay(15)
    observed = await navigationFacts(window, page)
  }
  ;(receipt.navigationObservations ??= []).push({ name, expected, ...observed })
  await checkpoint('navigation-observed-' + name)
  assert.equal(observed.page.nativeUrl, expected.url, 'Navigation acknowledgement keeps the exact original native URL: ' + name)
  assert.deepEqual({ url: observed.chrome.snapshot.url, canGoBack: observed.chrome.snapshot.canGoBack, canGoForward: observed.chrome.snapshot.canGoForward, loading: observed.chrome.snapshot.loading },
    { ...expected, loading: false }, 'Actual Main navigation snapshot acknowledges the original page: ' + name)
  assert.deepEqual({ address: observed.chrome.dom.address, backDisabled: observed.chrome.dom.backDisabled, forwardDisabled: observed.chrome.dom.forwardDisabled, reload: observed.chrome.dom.reload, stop: observed.chrome.dom.stop },
    { address: expected.url, backDisabled: !expected.canGoBack, forwardDisabled: !expected.canGoForward, reload: true, stop: false }, 'Actual navigation Renderer acknowledges address and history: ' + name)
  return observed
}
async function click(window: BrowserWindow, label: string) {
  window.webContents.focus()
  const point = await until('the actual enabled navigation control ' + label, () => window.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`))
  assert.ok(point, 'Actual navigation button is available: ' + label)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
async function address(window: BrowserWindow, value: string, acknowledge = true) {
  const before = receipt.calls.length
  window.webContents.focus()
  await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('input[aria-label="Browser address"]');e.focus();e.select()})()`)
  window.webContents.insertText(value)
  await until('the original address input consumes inserted text', async () => await window.webContents.executeJavaScript(`document.querySelector('input[aria-label="Browser address"]').value===${JSON.stringify(value)}`))
  await window.webContents.executeJavaScript("document.querySelector('input[aria-label=\"Browser address\"]').dispatchEvent(new Event('input',{bubbles:true}))")
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  if (acknowledge) await until('dedicated preload receives navigation acknowledgement', () => receipt.calls.slice(before).find((row: any) => row.channel === 'browser-popup:command' && row.args[0]?.kind === 'navigate' && row.finished) || false)
}
const frameProbeScript = `(()=>{const probe={timeOrigin:performance.timeOrigin,installedAt:performance.now(),count:0,lastTimestamp:null};
  globalThis.__popupFrameProbe=probe;const tick=time=>{probe.count++;probe.lastTimestamp=time;requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`
const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:32px;font:16px system-ui;background:#f4f7f8;color:#24323b}main{max-width:640px}h1{font-size:28px}input,button{font:inherit;padding:8px}p{line-height:1.6}</style><main><h1>${title}</h1>${body}</main>${process.env.AGENTMUX_POPUP_CAPTURE_HANDOFF === '1' ? '<script>' + frameProbeScript + '</script>' : ''}`
function serve() {
  return createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url!, origin || 'http://localhost'), body = Buffer.concat(chunks).toString()
      receipt.requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie ?? '', referrer: request.headers.referer ?? '', body,
        fetchSite: request.headers['sec-fetch-site'] ?? null, fetchMode: request.headers['sec-fetch-mode'] ?? null, fetchDest: request.headers['sec-fetch-dest'] ?? null })
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/opener') {
        const mode = url.searchParams.get('mode') ?? 'normal'
        response.setHeader('set-cookie', [`fixture=${mode}; Path=/; SameSite=Lax`, `strict_fixture=${mode}; Path=/; SameSite=Strict`])
        response.end(html('Original browser page', '<p>Independent windows retain this original page and session.</p><input id="original-draft" value="Original unsent page draft"><script>window.messages=[];addEventListener("message",e=>messages.push({data:e.data,origin:e.origin}));</script>'))
      } else if (url.pathname === '/slow') {
        response.write(html('Loading page', '<p>Waiting for the server response.</p>'))
        // The original response stays unfinished until native Stop or final server cleanup.
      } else {
        const context = /^\/capture-(normal|narrow|short)-(light|dark)$/u.exec(url.pathname)
        const title = context ? `Popup ${context[1]} ${context[2]}` : url.pathname === '/two' ? 'Second page' : url.pathname === '/javascript-disabled' ? 'JavaScript initially disabled' : 'Child browser page'
        response.end(html(title, '<p>A real native child document. Address and navigation above belong to AgentMux.</p><input value="A page remains interactive"><script>window.fixtureReady=true;' + (url.pathname === '/javascript-disabled' ? 'document.title="Unexpected enabled script"' : '') + '</script>'))
      }
    })
  })
}
async function pictures(window: BrowserWindow, page: WebContents) {
  if (process.env.AGENTMUX_POPUP_IMAGES !== '1') return
  const observer = process.env.AGENTMUX_POPUP_NATIVE_OBSERVER
  if (!observer) { receipt.visualUnavailable = { reason: 'The exact native-window observer is unavailable on this platform' }; return }
  window.show()
  const mediaSourceId = window.getMediaSourceId(), match = /^window:(\d+):\d+$/u.exec(mediaSourceId)
  assert.ok(match, 'The actual native child identifies its original window')
  const readNative = () => {
    const fact = JSON.parse(execFileSync(observer, [match[1], String(process.pid)], { encoding: 'utf8', timeout: 3000 }))
    assert.equal(fact.pid, process.pid); assert.equal(fact.windowId, Number(match[1]))
    return fact
  }
  for (const theme of ['light', 'dark'] as const) {
    appearance = theme
    await click(window, 'Reload')
    await settlePage(page, '/two')
    assert.equal(await page.executeJavaScript('document.querySelector("h1")?.textContent'), 'Second page', 'Native window capture uses its actual readable website document')
    await until('the actual navigation snapshot carries the selected theme', async () => (await window.webContents.executeJavaScript('browserPopup.inspect()')).theme?.appearance === theme)
    for (const shape of [{ name: 'normal', width: 1024, height: 700 }, { name: 'narrow', width: 360, height: 740 }, { name: 'short', width: 920, height: 360 }]) {
      window.setContentSize(shape.width, shape.height)
      await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const view = window.contentView.children.find(view => 'webContents' in view && (view as WebContentsView).webContents === page)
      assert.ok(view, 'Captured original page remains attached to its actual shell')
      assert.ok(view.getBounds().height > 0 && view.getBounds().width > 0, 'The navigation chrome leaves positive original page area')
      const before = readNative()
      if (before.screenLocked === true || before.onScreen !== true) {
        receipt.visualUnavailable = { reason: 'Exact native window is not in an eligible unlocked on-screen graphical session', native: before, mediaSourceId }
        return
      }
      const file = shape.name + '-' + theme + '-os-window.png', target = join(out, file)
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', '-l', match[1], target], { timeout: 5000, stdio: 'pipe' })
        const bytes = await readFile(target), image = nativeImage.createFromBuffer(bytes), after = readNative()
        assert.equal(image.isEmpty(), false, 'Exact native system capture decodes')
        receipt.images.push({ ...shape, theme, file, sha256: hash(bytes), size: image.getSize(), pageBounds: view.getBounds(),
          native: before, after, mediaSourceId, pageId: page.id, shellId: window.webContents.id,
          surface: 'Original screencapture bytes for the exact private PID/CGWindowID. Includes actual native composition; no crop, composition, re-encoding or physical input claim.' })
      } catch (error) {
        receipt.visualUnavailable = { reason: 'Exact native system capture was unavailable', error: String(error), native: before, mediaSourceId }
        return
      }
    }
  }
}

async function captureHandoff(lightSource: WebContents) {
  const windows: Array<{ id: string; theme: 'light' | 'dark'; width: number; height: number; window: BrowserWindow; page: WebContents }> = []
  const darkManager = new BrowserViewManager(rootWindow!, { defaultProfileId: () => 'popup-normal-profile', resolvePartition: () => 'persist:popup-normal-profile' }, new BrowserRefLedgerStore(join(home, 'dark-refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Fixture cannot open external applications') } },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { rendererUrl: () => pathToFileURL(join(assets, 'renderer/browser-popup.html')).href, preloadPath: join(assets, 'browser-popup.cjs'),
      readTheme: () => themeBootstrap({ appAppearance: 'dark', terminalTheme: 'graphite' }, true) })
  captureManagers.push(darkManager)
  await darkManager.create('popup-dark-source', origin + '/opener?mode=normal')
  darkManager.setBounds('popup-dark-source', { x: 0, y: 0, width: 880, height: 620 })
  const darkSource = darkManager.nativeOwner('popup-dark-source')!.view.webContents
  await settlePage(darkSource, '/opener')
  for (const theme of ['light', 'dark'] as const) {
    const source = theme === 'light' ? lightSource : darkSource
    for (const shape of [{ name: 'normal', width: 1024, height: 732 }, { name: 'narrow', width: 360, height: 772 }, { name: 'short', width: 920, height: 392 }]) {
      const id = shape.name + '-' + theme, target = origin + '/capture-' + id
      const child = await opened(source, `window.open(${JSON.stringify(target)},${JSON.stringify('capture-' + id)},${JSON.stringify(`width=${shape.width},height=${shape.height}`)});true`, 'static ' + id)
      await settlePage(child.page, '/capture-' + id)
      await until('the original static chrome has its fixed theme ' + id, async () => await child.window.webContents.executeJavaScript(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`))
      child.window.hide()
      windows.push({ id, theme, ...shape, window: child.window, page: child.page })
    }
  }
  const file = join(out, 'handoff.json'), release = join(out, 'release.json'), command = join(out, 'capture-select.json')
  const observer = process.env.AGENTMUX_POPUP_NATIVE_OBSERVER
  let active = '', applied: string | null = null
  let lastStates: any[] = []
  const facts = async (row: typeof windows[number]) => {
    const mediaSourceId = row.window.getMediaSourceId(), id = /^window:(\d+):\d+$/u.exec(mediaSourceId)?.[1]
    assert.ok(id, 'The static native child has an exact native source identity')
    const view = row.window.contentView.children.find(view => 'webContents' in view && (view as WebContentsView).webContents === row.page)
    assert.ok(view, 'The original page belongs to this exact static native window')
    const viewBounds = view.getBounds(), contentBounds = row.window.getContentBounds()
    assert.ok(viewBounds.width > 0 && viewBounds.height > 0, 'Static native page keeps positive native bounds')
    let native: unknown = null
    if (row.id === active) {
      try { if (observer) native = JSON.parse(execFileSync(observer, [id, String(process.pid)], { encoding: 'utf8', timeout: 3000 })) }
      catch (error) { native = { unavailable: String(error) } }
    }
    const observed = await navigationFacts(row.window, row.page)
    return { id: row.id, theme: row.theme, requestedWindow: { width: row.width, height: row.height }, windowId: Number(id), mediaSourceId,
      title: row.window.getTitle(), url: row.page.getURL(), windowBounds: row.window.getBounds(), contentBounds,
      focused: row.window.isFocused(), visible: row.window.isVisible(), minimized: row.window.isMinimized(), alwaysOnTop: row.window.isAlwaysOnTop(),
      applicationHidden: process.platform === 'darwin' ? app.isHidden() : null, pageId: row.page.id, shellId: row.window.webContents.id,
      pageView: { bounds: viewBounds, visible: view.getVisible(), memberOfOriginalWindow: true },
      chromeReadyToShow: receipt.windows.find((item: any) => item.windowId === row.window.id)?.chromeReadyToShow === true,
      page: observed.page, chrome: observed.chrome, native }
  }
  const publish = async (provided?: any[]) => {
    const states = provided ?? await Promise.all(windows.map(facts))
    lastStates = states
    const selected = states.find(row => row.id === active)!
    await writeFile(file, JSON.stringify({ schema: 'agentmux.browser-popup-static-capture-handoff.v1', pid: process.pid,
      appPath: process.execPath.split('/Contents/MacOS/')[0], ...selected, active, applied, windows: states, release, command,
      boundary: 'Six original BVM-created website children, each with creation-time dimensions and a fixed original Host theme. Selection only shows/focuses an existing original window. The explicit navigate action performs native input once and then publishes cached samples. No resizing, Run holding or constructed image pixels.' }, null, 2) + '\n')
  }
  const select = async (id: string, requestId: string) => {
    const row = windows.find(row => row.id === id)
    assert.ok(row, 'A capture selection must name one already prepared original window')
    for (const other of windows) if (other !== row) { other.window.setAlwaysOnTop(false); other.window.hide() }
    row.window.setAlwaysOnTop(true)
    row.window.show(); app.focus({ steal: true }); row.window.focus()
    active = id; applied = requestId
    await publish()
  }
  const navigateNaturally = async (id: string, requestId: string) => {
    const row = windows.find(row => row.id === id)
    assert.ok(row && active === id, 'Natural navigation observes the already selected original window')
    const target = origin + '/two', before = lastStates.find(item => item.id === id)
    const input = await row.window.webContents.executeJavaScript(`(()=>{${frameProbeScript};const e=document.querySelector('input[aria-label="Browser address"]');e.focus();e.select();return{active:document.activeElement===e,value:e.value,start:e.selectionStart,end:e.selectionEnd}})()`)
    assert.equal(input.active, true, 'The original address input is the explicit native insertion target')
    assert.equal(input.start, 0, 'The original address is selected before native insertion')
    assert.equal(input.end, input.value.length, 'Native insertion replaces the complete original address')
    const pageBefore = await row.page.executeJavaScript('({sampledAt:performance.now(),timeOrigin:performance.timeOrigin,raf:globalThis.__popupFrameProbe?{...globalThis.__popupFrameProbe}:null,visibilityState:document.visibilityState,url:location.href})')
    const callsBefore = receipt.calls.length
    row.window.webContents.focus()
    await row.window.webContents.insertText(target)
    row.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    row.window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    row.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    const deadline = performance.now() + 4000
    while (performance.now() < deadline && (row.page.isLoading() || row.page.getURL() !== target)) await delay(15)
    await delay(500)
    // These synchronous first statements copy the already accrued counters and DOM before any await or inspect.
    const [chromeSample, pageSample] = await Promise.all([
      row.window.webContents.executeJavaScript(`(()=>{const sample={sampledAt:performance.now(),timeOrigin:performance.timeOrigin,raf:globalThis.__popupFrameProbe?{...globalThis.__popupFrameProbe}:null,visibilityState:document.visibilityState,focused:document.hasFocus(),url:location.href,address:document.querySelector('input[aria-label="Browser address"]')?.value??null,backDisabled:document.querySelector('button[aria-label="Back"]')?.disabled??null,forwardDisabled:document.querySelector('button[aria-label="Forward"]')?.disabled??null,reload:Boolean(document.querySelector('button[aria-label="Reload"]')),stop:Boolean(document.querySelector('button[aria-label="Stop loading"]'))};return sample})()`),
      row.page.executeJavaScript('(()=>{const sample={sampledAt:performance.now(),timeOrigin:performance.timeOrigin,raf:globalThis.__popupFrameProbe?{...globalThis.__popupFrameProbe}:null,visibilityState:document.visibilityState,focused:document.hasFocus(),url:location.href,title:document.title,heading:document.querySelector("h1")?.textContent,width:innerWidth,height:innerHeight};return sample})()')
    ])
    const snapshot = await row.window.webContents.executeJavaScript('browserPopup.inspect()')
    const command = structuredClone(receipt.calls.slice(callsBefore).find((item: any) => item.channel === 'browser-popup:command' && item.args[0]?.kind === 'navigate'))
    const expected = { pageUrl: target, snapshotUrl: target, address: target, backDisabled: false, forwardDisabled: true, reload: true, stop: false }
    const actual = { pageUrl: row.page.getURL(), snapshotUrl: snapshot.url, address: chromeSample.address, backDisabled: chromeSample.backDisabled, forwardDisabled: chromeSample.forwardDisabled, reload: chromeSample.reload, stop: chromeSample.stop }
    let failure: unknown = null
    try { assert.deepEqual(actual, expected, 'Actual six-popup native navigation updates its original page, Main snapshot and chrome DOM') }
    catch (error: any) { failure = { name: error.name, message: error.message, actual: error.actual, expected: error.expected } }
    receipt.captureNavigation = { requestId, id, target, passed: failure === null, failure, before, inputSelection: input, pageBefore, chromeSample, pageSample,
      snapshotAfterSamples: snapshot, command, window: { visible: row.window.isVisible(), focused: row.window.isFocused(), minimized: row.window.isMinimized(), alwaysOnTop: row.window.isAlwaysOnTop(), applicationHidden: process.platform === 'darwin' ? app.isHidden() : null },
      boundary: 'Native input and native URL/loading observation, followed by one 500ms dwell without Renderer eval. Each final synchronous sample copies pre-existing RAF/DOM before later inspect. Missing RAF data is unknown; counters and DOM do not certify composed pixels.' }
    active = id; applied = requestId
    const observed = { ...before, title: row.window.getTitle(), url: row.page.getURL(), focused: row.window.isFocused(), visible: row.window.isVisible(),
      page: { ...pageSample, nativeUrl: row.page.getURL(), loading: row.page.isLoading() },
      chrome: { snapshotAfterSamples: snapshot, synchronousSample: chromeSample }, naturalNavigation: receipt.captureNavigation }
    await checkpoint('capture-native-navigation-sampled')
    await publish(lastStates.map(item => item.id === id ? observed : item))
  }
  await select('normal-light', 'initial')
  const deadline = performance.now() + 300000
  while (performance.now() < deadline) {
    try { await readFile(release); receipt.captureReleased = true; break } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    try {
      const request = JSON.parse(await readFile(command, 'utf8'))
      if (typeof request.requestId === 'string' && request.requestId !== applied) {
        assert.equal(typeof request.id, 'string')
        if (request.action === 'navigate') await navigateNaturally(request.id, request.requestId)
        else { assert.equal(request.action, undefined, 'Capture selection only supports its explicit native-navigation observation'); await select(request.id, request.requestId) }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    await delay(75)
  }
  receipt.cases.push({ name: 'six-static-original-popup-capture-handoff', handoff: file, released: receipt.captureReleased === true, windows: lastStates })
  if (receipt.captureNavigation) assert.equal(receipt.captureNavigation.passed, true, JSON.stringify(receipt.captureNavigation.failure))
}

async function run() {
  app.setPath('userData', join(home, 'user-data'))
  app.commandLine.appendSwitch('no-proxy-server')
  await app.whenReady()
  app.on('web-contents-created', (_event, source) => {
    // Read original native events without replacing, emitting or wrapping their continuation.
    ;(source as any).prependListener('-new-window', (_event: Electron.Event, url: string, frameName: string, disposition: string,
      _features: string, referrer: unknown, postData: unknown, sandboxFlags: number, navigate: unknown) => {
      ;(receipt.nativeWindowOpens ??= []).push({ sourceId: source.id, url, frameName, disposition, referrer,
        hasPostData: Boolean(postData), sandboxFlags, hasNavigate: typeof navigate === 'function' })
    })
  })
  app.on('window-all-closed', () => { /* The original fixture owns its receipt and final exit status. */ })
  rootWindow = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await rootWindow.loadURL('data:text/html,<title>Private popup source</title>')
  await checkpoint('native-root-created')
  app.on('browser-window-created', (_event, window) => created(window))
  const originalCreatePopup = BrowserPopupWindows.prototype.create
  BrowserPopupWindows.prototype.create = function(options, creation) {
    const supplied = (options as typeof options & { webContents?: WebContents }).webContents
    let actual: WebContents
    try { actual = originalCreatePopup.call(this, options, creation) }
    catch (error: any) {
      ;(receipt.constructionFailures ??= []).push({ name: error.name, message: error.message, guestId: supplied?.id ?? null })
      throw error
    }
    if (supplied) assert.equal(actual, supplied, "The actual BVM callback returns Electron's exact original child WebContents")
    const projection = Object.fromEntries(Object.entries(options).map(([key, value]) => [key,
      key === 'webContents' ? supplied ? { id: supplied.id } : null : key === 'webPreferences' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
        item === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof item) ? item : '[native object]'])) :
      value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value) ? value : '[native object]']))
    const callback = { pageId: actual.id, guestId: supplied?.id ?? null, exactGuest: supplied ? actual === supplied : null,
      sameSession: supplied ? actual.session === supplied.session : null, options: projection, optionsSha256: hash(JSON.stringify(projection)), mode: creation.mode, navigations: [] as Array<{ url: string }> }
    actual.on('did-start-navigation', event => { if (event.isMainFrame) callback.navigations.push({ url: event.url }) })
    ;(receipt.originalCallbacks ??= []).push(callback)
    return actual
  }
  manager = new BrowserViewManager(rootWindow, { defaultProfileId: () => 'popup-normal-profile', resolvePartition: () => 'persist:popup-normal-profile' }, new BrowserRefLedgerStore(join(home, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Fixture cannot open external applications') } },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { rendererUrl: () => pathToFileURL(join(assets, 'renderer/browser-popup.html')).href, preloadPath: join(assets, 'browser-popup.cjs'), readTheme: () => themeBootstrap({ appAppearance: appearance, terminalTheme: 'graphite' }, appearance === 'dark'),
      confirmLeave: window => new Promise<boolean>(resolve => closePrompts.push({ window, resolve })) })
  server = serve()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as any).port
  await manager.create('popup-original', origin + '/opener?mode=normal')
  manager.setBounds('popup-original', { x: 0, y: 0, width: 880, height: 620 })
  const opener = manager.nativeOwner('popup-original')!.view.webContents
  await settlePage(opener, '/opener')
  await checkpoint('real-bvm-source-ready')
  if (process.env.AGENTMUX_POPUP_CAPTURE_HANDOFF === '1') { await captureHandoff(opener); receipt.passed = true; return }
  const modifiedChild = await nativeLink(opener, '/modifier-native', 'command-control-click')
  const middleChild = await nativeLink(opener, '/middle-native', 'middle-click', 'middle', false)
  for (const [name, page] of [['/modifier-native', modifiedChild.page], ['/middle-native', middleChild.page]] as const) {
    const requests = receipt.requests.filter((row: any) => row.path === name)
    assert.equal(requests.length, 1, 'Original native continuation sends its target request exactly once: ' + name)
    assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].referrer, origin + '/opener?mode=normal')
    assert.equal(requests[0].fetchSite, 'same-origin', 'Original initiating frame identity survives the native continuation')
    assert.equal(requests[0].fetchMode, 'navigate'); assert.equal(requests[0].fetchDest, 'document')
    assert.match(requests[0].cookie, /strict_fixture=normal/u, 'SameSite=Strict uses the original native source context')
    assert.equal(await page.executeJavaScript('document.referrer'), origin + '/opener?mode=normal')
  }
  receipt.cases.push({ name: 'native-command-and-middle-original-request-session-security', pages: [modifiedChild.page.id, middleChild.page.id] })

  const noopener = await opened(opener, `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(origin + '/noopener')};a.target='_blank';a.rel='noopener';document.body.append(a);a.click();return true})()`, 'native target blank noopener')
  await settlePage(noopener.page, '/noopener')
  assert.equal(await noopener.page.executeJavaScript('window.opener===null'), true, 'Target blank noopener keeps its original detached opener policy')
  assert.equal(noopener.page.session, opener.session)
  receipt.cases.push({ name: 'native-target-blank-noopener' })

  const sandboxFrame = await opener.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.id='sandbox-frame';f.sandbox='allow-scripts allow-popups';f.style.cssText='position:fixed;left:20px;top:100px;width:650px;height:350px;z-index:99999;background:white';f.src=${JSON.stringify(origin + '/sandbox-source')};document.body.append(f);return true})()`)
  assert.equal(sandboxFrame, true)
  const sourceFrame = await until('the real sandbox source frame loads', () => opener.mainFrame.frames.find(frame => !frame.isDestroyed() && frame.url.startsWith(origin + '/sandbox-source')) || false)
  await until('the real sandbox frame completes its original document', async () => await sourceFrame.executeJavaScript('document.readyState === "complete"'))
  const sandboxChild = await nativeLink(opener, '/sandbox-native', 'sandbox-command-click', 'left', true, sourceFrame)
  assert.equal(await sandboxChild.page.executeJavaScript('(()=>{try{localStorage.getItem("native-sandbox-proof");return "allowed"}catch(e){return e.name}})()'), 'SecurityError', 'Guestless child preserves its initiating opaque sandbox restrictions')
  assert.ok(receipt.nativeWindowOpens.find((row: any) => row.url === origin + '/sandbox-native').sandboxFlags > 0)
  const sandboxNative = receipt.nativeLinkObservations.find((row: any) => row.name === 'sandbox-command-click')
  assert.equal(sandboxNative.callback.options.webPreferences.openerSandboxFlags, sandboxNative.events[0].sandboxFlags, 'Native constructor retains the exact original sandbox flags')
  await opener.executeJavaScript('document.querySelector("#sandbox-frame").remove();true')
  receipt.cases.push({ name: 'native-sandbox-frame-retains-original-restrictions', pageId: sandboxChild.page.id })

  const nativeNested = await nativeLink(middleChild.page, '/nested-modifier-native', 'nested-command-click')
  let nestedDestroyed = 0, middleDestroyed = 0
  nativeNested.page.on('destroyed', () => nestedDestroyed++)
  middleChild.page.on('destroyed', () => middleDestroyed++)
  middleChild.window.close()
  await until('the exact native source close destroys its original guestless nested page and shell', () => middleChild.page.isDestroyed() && nativeNested.page.isDestroyed() && nativeNested.window.isDestroyed())
  assert.equal(nestedDestroyed, 1); assert.equal(middleDestroyed, 1)
  assert.equal(modifiedChild.page.isDestroyed(), false, 'Native nested owner closure preserves the unrelated healthy child')
  receipt.cases.push({ name: 'native-guestless-nested-source-lifecycle-exactly-once', nestedDestroyed, middleDestroyed })

  const child = await opened(opener, `window.originalChild=window.open(${JSON.stringify(origin + '/one')},'original-child','width=800,height=600'); Boolean(originalChild)`, 'normal popup')
  await settlePage(child.page, '/one')
  assert.equal(child.page.session, opener.session, 'Native popup consumes the complete original same-session request')
  assert.equal(await child.page.executeJavaScript('Boolean(window.opener)'), true, 'Original native opener survives local chrome hosting')
  await child.page.executeJavaScript('opener.postMessage("original-child-ready",location.origin)')
  await until('original opener receives real postMessage', async () => await opener.executeJavaScript('messages.some(e=>e.data==="original-child-ready")'))
  assert.match(await child.page.executeJavaScript('document.cookie'), /fixture=normal/u)
  assert.equal(await child.page.executeJavaScript('window.fixtureReady'), true, 'The normal native child executes the fixture inline script')
  const namedBefore = children.size
  assert.equal(await opener.executeJavaScript('window.open("", "original-child") === originalChild', true), true, 'An existing named native child retains its original renderer identity')
  assert.equal(children.size, namedBefore, 'Reusing an original named child creates no duplicate shell')
  receipt.cases.push({ name: 'normal-original-opener-session-postmessage', pageId: child.page.id, shellId: child.window.webContents.id })
  await checkpoint('normal-child-confirmed')

  const blank = await opened(opener, `window.blankChild=window.open('about:blank','synchronous-child');blankChild.document.write('<title>Synchronous child</title><h1 id="sync">Original synchronous content</h1>');blankChild.document.close();true`, 'synchronous aboutblank')
  assert.equal(await blank.page.executeJavaScript('document.getElementById("sync")?.textContent'), 'Original synchronous content', 'about:blank synchronous script uses original returned child')
  receipt.cases.push({ name: 'aboutblank-original-synchronous-document', pageId: blank.page.id })
  const noScript = await opened(opener, `window.noScriptChild=window.open(${JSON.stringify(origin + '/javascript-disabled')},'javascript-disabled-child','javascript=no');true`, 'native child with JavaScript disabled')
  await settlePage(noScript.page, '/javascript-disabled')
  assert.equal((noScript.page as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences().javascript, false, 'Guestful native child retains its original javascript=no preference')
  assert.equal(noScript.page.getTitle(), 'JavaScript initially disabled', 'Native page scripts remain disabled by the original child request')
  receipt.cases.push({ name: 'guestful-native-child-javascript-disabled', pageId: noScript.page.id })
  const post = await opened(opener, `(()=>{const f=document.createElement('form');f.method='POST';f.target='_blank';f.action=${JSON.stringify(origin + '/posted')};const i=document.createElement('input');i.name='payload';i.value='original-body';f.append(i);document.body.append(f);f.submit();return true})()`, 'native target blank form')
  await settlePage(post.page, '/posted')
  const posted = receipt.requests.find((row: any) => row.path === '/posted')
  assert.ok(posted, 'The real server observes the original target=_blank request')
  assert.equal(posted.method, 'POST', 'Original window-open options preserve POST rather than replaying GET')
  assert.equal(posted.body, 'payload=original-body'); assert.equal(posted.referrer, origin + '/opener?mode=normal')
  assert.equal(receipt.requests.filter((row: any) => row.path === '/posted').length, 1, 'Native form submission sends the original body exactly once')
  assert.equal(posted.fetchSite, 'same-origin'); assert.match(posted.cookie, /strict_fixture=normal/u)
  receipt.cases.push({ name: 'native-form-post-and-referrer', request: posted })

  child.window.show(); app.focus({ steal: true }); child.window.focus()
  receipt.focus = { shown: child.window.isVisible(), focused: child.window.isFocused() }
  await checkpoint('before-actual-navigation')
  await address(child.window, origin + '/two')
  await until('native navigation acknowledgement settles loading', () => !child.page.isLoading())
  assert.equal(child.page.getURL(), origin + '/two', 'Actual navigation dispatch changes the original child URL')
  assert.equal(child.page, actualPage(child.window), 'Actual navigation dispatch keeps the same original native page')
  await settlePage(child.page, '/two')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/two', canGoBack: true, canGoForward: false }, 'address-navigation')
  await click(child.window, 'Back'); await settlePage(child.page, '/one')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/one', canGoBack: false, canGoForward: true }, 'back')
  await click(child.window, 'Forward'); await settlePage(child.page, '/two')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/two', canGoBack: true, canGoForward: false }, 'forward')
  const count = receipt.requests.filter((row: any) => row.path === '/two').length
  await click(child.window, 'Reload')
  await until('actual reload reaches the same native child', () => receipt.requests.filter((row: any) => row.path === '/two').length > count)
  await address(child.window, origin + '/slow', false)
  await until('actual loading exposes Stop', async () => await child.window.webContents.executeJavaScript(`Boolean(document.querySelector('button[aria-label="Stop loading"]'))`))
  await click(child.window, 'Stop loading'); await until('original native stop ends loading', () => !child.page.isLoading())
  await address(child.window, origin + '/two'); await settlePage(child.page, '/two')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/two', canGoBack: true, canGoForward: false }, 'after-stop')
  await child.window.webContents.executeJavaScript('document.querySelector(\'input[aria-label="Browser address"]\').blur()')
  await child.page.executeJavaScript(`location.assign(${JSON.stringify(origin + '/one')});true`)
  await settlePage(child.page, '/one')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/one', canGoBack: true, canGoForward: false }, 'original-page-navigation')
  await address(child.window, origin + '/two'); await settlePage(child.page, '/two')
  await navigationAcknowledged(child.window, child.page, { url: origin + '/two', canGoBack: true, canGoForward: false }, 'address-after-page-navigation')
  receipt.cases.push({ name: 'actual-navigation-address-history-reload-stop', pageId: child.page.id })
  await checkpoint('actual-navigation-confirmed')
  child.page.focus()
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
  child.page.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers })
  child.page.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers })
  const selection = await until('native Cmd/Ctrl+L selects the actual original address', async () => {
    const value = await child.window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('input[aria-label="Browser address"]');return{active:document.activeElement===e,value:e.value,start:e.selectionStart,end:e.selectionEnd}})()`)
    return value.active && value.start === 0 && value.end === value.value.length ? value : false
  })
  await child.window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('input[aria-label="Browser address"]');e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'x'}));const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'Unsent address draft');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'Unsent address draft'}));})()`)
  await child.page.loadURL(origin + '/one')
  assert.equal(await child.window.webContents.executeJavaScript(`document.querySelector('input[aria-label="Browser address"]').value`), 'Unsent address draft', 'Native document changes preserve the actively edited address draft')
  await address(child.window, origin + '/two'); await settlePage(child.page, '/two')
  receipt.cases.push({ name: 'native-location-shortcut-selection-and-unsent-draft', selection, boundary: 'Native keyboard event and Renderer composition consumer; no OS clipboard write or physical IME claim' })

  const unregistered = new BrowserWindow({ show: false, webPreferences: { preload: join(assets, 'browser-popup.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await unregistered.loadFile(join(assets, 'renderer/browser-popup.html'))
  const requestsBeforeForeign = receipt.requests.length
  const foreign = await unregistered.webContents.executeJavaScript(`browserPopup.command({kind:'navigate',address:${JSON.stringify(origin + '/wrong-sender')}}).then(()=>({rejected:false}),e=>({rejected:true,message:String(e)}))`)
  assert.equal(foreign.rejected, true, 'The actual Main handler rejects a different native sender even with the same local shell/preload')
  assert.equal(receipt.requests.length, requestsBeforeForeign, 'Rejected foreign navigation performs no network request')
  unregistered.destroy()
  receipt.cases.push({ name: 'actual-dedicated-preload-wrong-sender-is-rejected', foreign })

  let prevented = 0
  post.page.on('will-prevent-unload', () => { prevented++ })
  await post.page.executeJavaScript('window.onbeforeunload=()=>false;true', true)
  post.window.close()
  await until('original page beforeunload reaches its exact native Close confirmation', () => prevented > 0 && closePrompts.length === 1)
  assert.equal(closePrompts[0].window, post.window, 'Stay/Leave belongs to the exact original native child')
  closePrompts[0].resolve(false)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(post.window.isDestroyed(), false, 'Explicit Stay keeps the original usable native child')
  assert.equal(post.page.isDestroyed(), false)
  post.window.close()
  await until('the next explicit Close observes the same original beforeunload', () => closePrompts.length === 2)
  assert.equal(closePrompts[1].window, post.window)
  closePrompts[1].resolve(true)
  await until('explicit Leave destroys the same original child and native shell', () => post.window.isDestroyed() && post.page.isDestroyed())
  receipt.cases.push({ name: 'original-native-close-beforeunload-veto-and-allow', prevented, confirmations: 2 })

  const nested = await opened(child.page, `window.nested=window.open(${JSON.stringify(origin + '/nested')},'nested-child');true`, 'nested popup')
  await settlePage(nested.page, '/nested')
  assert.equal(nested.page.session, opener.session)
  assert.equal(await nested.page.executeJavaScript('Boolean(opener)'), true)
  await nested.page.executeJavaScript('window.close()'); await until('original script-close disposes nested native shell', () => nested.window.isDestroyed())
  receipt.cases.push({ name: 'nested-original-policy-and-script-close' })

  blank.window.hide()
  const accountReplies: Array<string | null | undefined> = []
  const originalFrame = blank.page.mainFrame, originalFrameIdentity = { processId: blank.page.mainFrame.processId, frameToken: blank.page.mainFrame.frameToken }
  const eventConsumed = blank.page.session.emit('select-webauthn-account', {} as Electron.Event, {
    frame: originalFrame, relyingPartyId: '127.0.0.1',
    accounts: [{ credentialId: 'fixture-first', name: 'Fixture first', displayName: 'Fixture first' },
      { credentialId: 'fixture-second', name: 'Fixture second', displayName: 'Fixture second' }]
  }, (credential: string | null | undefined) => accountReplies.push(credential))
  assert.equal(eventConsumed, true, 'Actual Browser Session has its production account-selection consumer')
  assert.equal(accountReplies.length, 0, 'Actual BVM popup resolver retains the hidden original account request rather than returning null')
  const pendingAccount = await blank.window.webContents.executeJavaScript('browserPopup.inspect()')
  assert.equal(typeof pendingAccount.warning, 'string'); assert.ok(pendingAccount.warning.length > 0, 'The exact original popup reports its pending local account selection')
  await blank.page.loadURL(origin + '/auth-finished')
  assert.deepEqual(accountReplies, [null], 'Real original-page navigation cancels that pending native account request')
  receipt.cases.push({ name: 'actual-bvm-popup-auth-owner-pending-and-navigation-cancel', pageId: blank.page.id,
    frame: originalFrameIdentity, eventConsumed, accountReplies,
    boundary: 'Synthetic two-account provider event through the real native Session/registered BVM resolver and service; no hardware authenticator, OS credential selection or real account.' })


  await manager.create('popup-private', origin + '/opener?mode=private', null, undefined, 'private')
  manager.setBounds('popup-private', { x: 0, y: 0, width: 880, height: 620 })
  const privateOpener = manager.nativeOwner('popup-private')!.view.webContents
  await settlePage(privateOpener, '/opener')
  const privateChild = await opened(privateOpener, `window.privateChild=window.open(${JSON.stringify(origin + '/private')},'private-child');true`, 'private popup')
  await settlePage(privateChild.page, '/private')
  assert.equal(privateChild.page.session, privateOpener.session)
  assert.notEqual(privateChild.page.session, opener.session)
  assert.match(await privateChild.page.executeJavaScript('document.cookie'), /fixture=private/u)
  const privateModified = await nativeLink(privateOpener, '/private-modifier-native', 'private-command-click')
  assert.notEqual(privateModified.page.session, opener.session)
  assert.match(await privateModified.page.executeJavaScript('document.cookie'), /strict_fixture=private/u)
  const privateRequest = receipt.requests.filter((row: any) => row.path === '/private-modifier-native')
  assert.equal(privateRequest.length, 1); assert.equal(privateRequest[0].fetchSite, 'same-origin')
  assert.doesNotMatch(privateRequest[0].cookie, /(?:^|; )fixture=normal(?:;|$)/u)
  let privateDestroyed = 0
  privateModified.page.on('destroyed', () => privateDestroyed++)
  const privateNested = await opened(privateChild.page, `window.nestedPrivate=window.open(${JSON.stringify(origin + '/private-nested')},'nested-private-child');true`, 'nested private popup')
  await settlePage(privateNested.page, '/private-nested')
  assert.equal(privateNested.page.session, privateOpener.session, 'Nested private child retains the original temporary session')
  await manager.close('popup-private')
  await until('private owner close destroys its actual child', () => privateChild.window.isDestroyed() && privateChild.page.isDestroyed() && privateNested.window.isDestroyed() && privateNested.page.isDestroyed() && privateModified.window.isDestroyed() && privateModified.page.isDestroyed())
  assert.equal(privateDestroyed, 1, 'Closing the original private owner destroys its exact guestless child once')
  assert.equal(opener.isDestroyed(), false, 'Closing a private owner preserves unrelated healthy normal Browser')
  receipt.cases.push({ name: 'private-original-session-and-owner-close', privateDestroyed })

  await address(modifiedChild.window, origin + '/two'); await settlePage(modifiedChild.page, '/two')
  receipt.nativeTriggerCapture = { sourceId: opener.id, pageId: modifiedChild.page.id, trigger: 'command-control-click', target: origin + '/modifier-native' }
  await pictures(modifiedChild.window, modifiedChild.page)
  assert.deepEqual(receipt.uncaughtExceptions ?? [], [], 'The real native popup input has no uncaught process exception')
  assert.ok(receipt.calls.length > 0, 'The actual dedicated preload invokes the production Main handlers')
  assert.equal(await child.page.executeJavaScript('typeof window.agentmux'), 'undefined', 'Untrusted website never gains Desktop APIs')
  assert.equal(await child.page.executeJavaScript('typeof window.browserPopup'), 'undefined', 'Dedicated navigation bridge never leaks into the original website')
  receipt.passed = true
}
try { await run() }
catch (error: any) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) }
finally {
  const cleanup = async (name: string, action: () => unknown) => { try { await action() } catch (error) { receipt.cleanup.push({ name, error: String(error) }) } }
  for (const captureManager of captureManagers) await cleanup('capture-manager', () => captureManager.dispose())
  await cleanup('manager', () => manager?.dispose())
  for (const child of children) await cleanup('child', () => { if (!child.isDestroyed()) child.destroy() })
  await cleanup('root', () => { if (rootWindow && !rootWindow.isDestroyed()) rootWindow.destroy() })
  await cleanup('server', async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } })
  receipt.cleanupComplete = true
  await checkpoint('complete')
  app.exit(receipt.passed && receipt.cleanup.length === 0 ? 0 : 1)
}
