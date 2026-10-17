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
async function opened(parent: WebContents, code: string, name: string) {
  const before = new Set(children)
  await parent.executeJavaScript(code, true)
  const window = await until(name + ' creates an actual native child', () => [...children].find(child => !before.has(child) && !child.isDestroyed()) || false)
  const page = await until(name + ' attaches its original native page', () => actualPage(window) || false)
  await until(name + ' loads actual production navigation', async () => {
    if (window.webContents.isDestroyed()) return false
    return await window.webContents.executeJavaScript("Boolean(document.querySelector('input[aria-label=\"Browser address\"]'))").catch(() => false)
  })
  assert.notEqual(page, window.webContents, 'The website stays outside the trusted navigation document')
  return { window, page }
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
      receipt.requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie ?? '', referrer: request.headers.referer ?? '', body })
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/opener') {
        response.setHeader('set-cookie', `fixture=${url.searchParams.get('mode') ?? 'normal'}; Path=/; SameSite=Lax`)
        response.end(html('Original browser page', '<p>Independent windows retain this original page and session.</p><input value="Original unsent page draft"><script>window.messages=[];addEventListener("message",e=>messages.push({data:e.data,origin:e.origin}));</script>'))
      } else if (url.pathname === '/slow') {
        response.write(html('Loading page', '<p>Waiting for the server response.</p>'))
        // The original response stays unfinished until native Stop or final server cleanup.
      } else {
        const context = /^\/capture-(normal|narrow|short)-(light|dark)$/u.exec(url.pathname)
        const title = context ? `Popup ${context[1]} ${context[2]}` : url.pathname === '/two' ? 'Second page' : 'Child browser page'
        response.end(html(title, '<p>A real native child document. Address and navigation above belong to AgentMux.</p><input value="A page remains interactive"><script>window.fixtureReady=true</script>'))
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
  app.on('window-all-closed', () => { /* The original fixture owns its receipt and final exit status. */ })
  rootWindow = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await rootWindow.loadURL('data:text/html,<title>Private popup source</title>')
  await checkpoint('native-root-created')
  app.on('browser-window-created', (_event, window) => created(window))
  const originalCreatePopup = BrowserPopupWindows.prototype.create
  BrowserPopupWindows.prototype.create = function(options, creation) {
    const supplied = (options as typeof options & { webContents?: WebContents }).webContents
    const actual = originalCreatePopup.call(this, options, creation)
    assert.ok(supplied, 'Electron supplies its original native guest to the real callback')
    assert.equal(actual, supplied, "The actual BVM callback returns Electron's exact original child WebContents")
    const projection = Object.fromEntries(Object.entries(options).map(([key, value]) => [key,
      key === 'webContents' ? { id: supplied.id } : key === 'webPreferences' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
        item === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof item) ? item : '[native object]'])) :
      value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value) ? value : '[native object]']))
    ;(receipt.originalCallbacks ??= []).push({ pageId: actual.id, guestId: supplied.id, exactGuest: actual === supplied,
      sameSession: actual.session === supplied.session, options: projection, optionsSha256: hash(JSON.stringify(projection)), mode: creation.mode })
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
  const child = await opened(opener, `window.originalChild=window.open(${JSON.stringify(origin + '/one')},'original-child','width=800,height=600'); Boolean(originalChild)`, 'normal popup')
  await settlePage(child.page, '/one')
  assert.equal(child.page.session, opener.session, 'Native popup consumes the complete original same-session request')
  assert.equal(await child.page.executeJavaScript('Boolean(window.opener)'), true, 'Original native opener survives local chrome hosting')
  await child.page.executeJavaScript('opener.postMessage("original-child-ready",location.origin)')
  await until('original opener receives real postMessage', async () => await opener.executeJavaScript('messages.some(e=>e.data==="original-child-ready")'))
  assert.match(await child.page.executeJavaScript('document.cookie'), /fixture=normal/u)
  receipt.cases.push({ name: 'normal-original-opener-session-postmessage', pageId: child.page.id, shellId: child.window.webContents.id })
  await checkpoint('normal-child-confirmed')

  const blank = await opened(opener, `window.blankChild=window.open('about:blank','synchronous-child');blankChild.document.write('<title>Synchronous child</title><h1 id="sync">Original synchronous content</h1>');blankChild.document.close();true`, 'synchronous aboutblank')
  assert.equal(await blank.page.executeJavaScript('document.getElementById("sync")?.textContent'), 'Original synchronous content', 'about:blank synchronous script uses original returned child')
  receipt.cases.push({ name: 'aboutblank-original-synchronous-document', pageId: blank.page.id })
  const post = await opened(opener, `(()=>{const f=document.createElement('form');f.method='POST';f.target='_blank';f.action=${JSON.stringify(origin + '/posted')};const i=document.createElement('input');i.name='payload';i.value='original-body';f.append(i);document.body.append(f);f.submit();return true})()`, 'native target blank form')
  await settlePage(post.page, '/posted')
  const posted = receipt.requests.find((row: any) => row.path === '/posted')
  assert.ok(posted, 'The real server observes the original target=_blank request')
  assert.equal(posted.method, 'POST', 'Original window-open options preserve POST rather than replaying GET')
  assert.equal(posted.body, 'payload=original-body'); assert.equal(posted.referrer, origin + '/opener?mode=normal')
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
  const privateNested = await opened(privateChild.page, `window.nestedPrivate=window.open(${JSON.stringify(origin + '/private-nested')},'nested-private-child');true`, 'nested private popup')
  await settlePage(privateNested.page, '/private-nested')
  assert.equal(privateNested.page.session, privateOpener.session, 'Nested private child retains the original temporary session')
  await manager.close('popup-private')
  await until('private owner close destroys its actual child', () => privateChild.window.isDestroyed() && privateChild.page.isDestroyed() && privateNested.window.isDestroyed() && privateNested.page.isDestroyed())
  assert.equal(opener.isDestroyed(), false, 'Closing a private owner preserves unrelated healthy normal Browser')
  receipt.cases.push({ name: 'private-original-session-and-owner-close' })

  await pictures(child.window, child.page)
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
