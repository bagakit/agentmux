import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain, BrowserWindow, type IpcMainInvokeEvent, type IpcMainEvent, type WebContents, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL, type BrowserBounds, type BrowserSnapshot, type BrowserViewport } from '../../../src/shared/contracts'
import type { NativeOverlayRegion } from '../../../src/shared/native-overlay'

const exec = promisify(execFile)
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const inside = (point: { x: number; y: number }, box: BrowserBounds) => point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height
const clone = <T>(value: T): T => structuredClone(value)

type Options = {
  window: BrowserWindow
  privateRoot: string
  evidence: string
  phase: string
  fixturePage: string
  osCli?: string
}
type NativeView = WebContentsView & { getVisible(): boolean }
type ChromeProjection = { view: NativeView; region: NativeOverlayRegion; interactive: boolean; paintStage: string }
type BrowserBinding = { view: NativeView; contents: WebContents; snapshot: BrowserSnapshot }

/** Private, bounded Main glue. Every native View is created and managed by the production owners. */
export async function installMoteNative(options: Options) {
  const { window, privateRoot, evidence, phase } = options
  assert.equal(app.getPath('userData'), join(privateRoot, 'user-data'))
  assert.equal(app.getPath('sessionData'), join(privateRoot, 'session-data'))
  assert.equal(window.webContents.getZoomFactor(), 1, 'The controlled fixture starts with actual window zoom 1')
  const fixturePage = resolve(options.fixturePage)
  const fixtureHtml = await readFile(fixturePage)
  const receipt: any = {
    schema: 'agentmux.mote-native-browser-proof.v1', phase, pid: process.pid, windowId: window.id,
    userRunTouched: false, userAppInput: false,
    boundary: 'Production BrowserViewManager, NativeOverlaySurfaces, BrowserProfileManager and ledger in one exact private BrowserWindow. Trusted DevTools input addresses an original native WebContents only after its actual topmost owner is observed; the UI bridge must be delivered by the real WebContents input-event, never manually called. OS captures come from the exact private PID/window; individual WebContents images never claim OS composition. Physical hardware, OS focus and Core/ctxmux Run survival are not tested.',
    fixturePage: { path: fixturePage, sha256: digest(fixtureHtml) },
    profiles: [], bindings: [], bounds: [], overlayUpdates: [], warnings: [], browserInputs: [], nativeInputEvents: [], keyboardEvents: [], inputs: [], nativeFrames: [], osFrames: [], failures: [], disposed: false
  }
  const profiles = new BrowserProfileManager(new BrowserProfileStore(join(privateRoot, 'user-data', 'browser-profiles.json')))
  await profiles.initialize()
  receipt.profiles = profiles.listProfiles()
  // A physical file URL intentionally drops query/hash when the production manager normalizes
  // it. Use an ordinary private HTTP page instead of changing Browser URL semantics for a probe.
  // The two sequential processes bind the same retained port so durable Browser URLs stay exact.
  const portFile = join(privateRoot, 'native-fixture-port.json')
  let port = 0
  try { port = JSON.parse(await readFile(portFile, 'utf8')).port } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535)
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/browser.html') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(fixtureHtml)
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); done() }) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  port = address.port
  await writeFile(portFile, JSON.stringify({ port }) + '\n')
  const fixturePageUrl = `http://127.0.0.1:${port}/browser.html`
  receipt.fixturePage.url = fixturePageUrl
  const browsers = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(privateRoot, 'user-data', 'browser-ref-ledger.json')), {
    rememberedSchemes: async () => ({}),
    rememberScheme: async () => { throw new Error('The private native proof never writes an app-link choice') },
    openExternal: () => { throw new Error('The private native proof never hands a link to the user system') }
  })
  let disposed = false
  const bindings = new Map<string, BrowserBinding>()
  const warn = (warning: string) => {
    receipt.warnings.push({ at: Date.now(), warning })
    if (!window.webContents.isDestroyed()) window.webContents.send(NATIVE_OVERLAY_WARNING_CHANNEL, warning)
  }
  const nativeChrome = new NativeOverlaySurfaces(window, browsers, warn, input => {
    receipt.browserInputs.push({ at: Date.now(), ...input })
    if (!window.webContents.isDestroyed()) window.webContents.send(NATIVE_BROWSER_INPUT_CHANNEL, input)
  })
  browsers.onNativeInput = (owner, input) => nativeChrome.forwardBrowserInput(owner, input)
  const handled: string[] = []
  const requireSender = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    assert.equal(disposed, false)
    assert.equal(event.sender, window.webContents, 'Only the original private Renderer may invoke this bridge')
    assert.equal(event.senderFrame, window.webContents.mainFrame, 'Private Browser pages and child frames cannot invoke the Main bridge')
  }
  const handle = (method: string, work: (...args: any[]) => unknown) => {
    const channel = `mote-native:${method}`
    ipcMain.handle(channel, (event, ...args) => { requireSender(event); return work(...args) })
    handled.push(channel)
  }
  const nativeChildren = () => window.contentView.children.filter((view): view is NativeView => {
    const contents = (view as Partial<NativeView>).webContents
    return !!contents && !contents.isDestroyed()
  })
  const checkUrl = (browserId: string, rawUrl: string) => {
    const url = new URL(rawUrl)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.origin, new URL(fixturePageUrl).origin)
    assert.equal(url.hostname, new URL(fixturePageUrl).hostname)
    assert.equal(url.pathname, new URL(fixturePageUrl).pathname, 'The private fixture cannot navigate arbitrary files or external sites')
    assert.equal(url.searchParams.get('owner'), browserId, 'The private page carries the exact Browser id requested from the actual manager')
    return url.href
  }
  const bind = async (id: string, operation: 'create' | 'restore', work: () => Promise<BrowserSnapshot>) => {
    const prior = new Set(nativeChildren())
    const snapshot = await work()
    const added = nativeChildren().filter(view => !prior.has(view))
    const previous = bindings.get(id)
    const view = added.length === 1 ? added[0] : previous?.view
    assert.ok(view, 'A public create/restore must expose an actual native owner')
    assert.ok(added.length === 1 || added.length === 0 && previous && !previous.contents.isDestroyed(), 'A handshake creates exactly one native owner or retains the exact previous one')
    assert.equal(snapshot.id, id)
    assert.equal(BrowserWindow.fromWebContents(view.webContents), window)
    assert.ok(window.contentView.children.includes(view))
    if (previous?.contents !== view.webContents) {
      view.webContents.on('input-event', (_event, input) => receipt.nativeInputEvents.push({ browserId: id, webContentsId: view.webContents.id, input: clone(input) }))
      view.webContents.on('before-input-event', (_event, input) => receipt.keyboardEvents.push({ browserId: id, webContentsId: view.webContents.id, input: clone(input) }))
    }
    bindings.set(id, { view, contents: view.webContents, snapshot })
    receipt.bindings.push({ at: Date.now(), operation, browserId: id, navigationId: snapshot.navigationId, webContentsId: view.webContents.id,
      ownerWindowId: BrowserWindow.fromWebContents(view.webContents)?.id, created: added.length === 1 })
    return snapshot
  }
  handle('browser:create', (id: string, url: string, workspaceId: string | null) => bind(id, 'create', () => browsers.create(id, checkUrl(id, url), workspaceId)))
  handle('browser:navigate', (id: string, url: string) => browsers.navigate(id, checkUrl(id, url)))
  handle('browser:back', (id: string) => browsers.back(id))
  handle('browser:forward', (id: string) => browsers.forward(id))
  handle('browser:reload', (id: string) => browsers.reload(id))
  handle('browser:listProfiles', () => profiles.listProfiles())
  handle('browser:setViewport', (id: string, viewport: BrowserViewport) => browsers.setViewport(id, viewport))
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => {
    receipt.bounds.push({ at: Date.now(), browserId: id, bounds: clone(bounds) })
    browsers.setBounds(id, bounds)
    // This is the ordinary ipc.ts bridge: Browser geometry returns immediately and requests
    // the current overlay owner to refresh; the private harness does not serialize or repair it.
    void nativeChrome.refresh().then(value => {
      receipt.overlayUpdates.push({ at: Date.now(), operation: 'geometry-refresh', receipt: clone(value) })
    }).catch(() => warn('Native floating content could not follow the Browser frame. The Browser remains available; close and reopen the floating panel.'))
  })
  handle('browser:release', (id: string) => browsers.release(id))
  handle('browser:restore', (id: string, input: Parameters<BrowserViewManager['restore']>[1]) => bind(id, 'restore', () => browsers.restore(id, input)))
  handle('browser:close', (id: string) => browsers.close(id))
  handle('browser:cancelElementSelection', (id: string) => browsers.cancelElementSelection(id))
  handle('browser:setAnnotationMarkers', (id: string, navigationId: string, markers: Parameters<BrowserViewManager['setAnnotationMarkers']>[2]) => browsers.setAnnotationMarkers(id, navigationId, markers))
  handle('ui:publishNativeOverlays', async (regions: NativeOverlayRegion[]) => {
    const published = clone(regions)
    const value = await nativeChrome.update(regions)
    receipt.overlayUpdates.push({ at: Date.now(), operation: 'publish', regions: published, receipt: clone(value) })
    return value
  })
  const pageUrl = (event: IpcMainEvent) => { requireSender(event); event.returnValue = fixturePageUrl }
  ipcMain.on('mote-native:page-url', pageUrl)

  function owners() {
    const all = nativeChildren()
    // Chrome has no public id->View query. This private diagnostic reads its existing owner Map;
    // it never routes input, copies ownership into the product, or changes the native order.
    const projections = Reflect.get(nativeChrome, 'projections') as Map<string, ChromeProjection>
    assert.ok(projections instanceof Map, 'The captured production Chrome owner exposes its actual private projection map')
    const describe = (view: NativeView) => ({ webContentsId: view.webContents.id, childIndex: window.contentView.children.indexOf(view),
      ownerWindowId: BrowserWindow.fromWebContents(view.webContents)?.id, bounds: view.getBounds(), drawn: view.getVisible(),
      attached: window.contentView.children.includes(view), processId: view.webContents.getOSProcessId(), url: view.webContents.getURL(), loading: view.webContents.isLoading() })
    return {
      window: { pid: process.pid, id: window.id, visible: window.isVisible(), focused: window.isFocused(), bounds: window.getBounds(), contentBounds: window.getContentBounds() },
      originalRenderer: { webContentsId: window.webContents.id, processId: window.webContents.getOSProcessId() },
      browsers: [...bindings].flatMap(([browserId, binding]) => binding.contents.isDestroyed() ? [] : [{ browserId, initialNavigationId: binding.snapshot.navigationId, ...describe(binding.view) }]),
      chrome: [...projections].flatMap(([regionId, projection]) => projection.view.webContents.isDestroyed() ? [] : [{ regionId, region: clone(projection.region), interactive: projection.interactive, paintStage: projection.paintStage, ...describe(projection.view) }]),
      orderedChildren: all.map(describe),
      resources: { ...browsers.resourceOwnerCounts(), browserProcessIds: browsers.resourceProcessIds(), chromeProcessIds: nativeChrome.resourceProcessIds() }
    }
  }
  const saveReceipt = () => writeFile(join(evidence, `${phase}-native.json`), JSON.stringify(receipt, null, 2))
  const labelName = (label: string) => { assert.match(label, /^[a-z0-9-]+$/); return label }
  async function captureOsWindow(label: string) {
    labelName(label)
    const before = owners()
    const attempt: any = { label, before, source: 'macos-os-window', pid: process.pid, physicalDeviceTested: false, cliCalls: [] }
    receipt.osFrames.push(attempt)
    try {
      assert.equal(process.platform, 'darwin')
      assert.ok(options.osCli, 'The explicitly selected native provider is required for an OS composition claim')
      const call = async (args: string[]) => {
        const argv = ['computer', ...args, '--json'], timeoutMs = 15000, maxBuffer = 8 * 1024 * 1024
        const invoked: any = { executable: options.osCli, argv, timeoutMs, maxBuffer, startedAt: Date.now() }
        attempt.cliCalls.push(invoked)
        let stdout = '', stderr = '', executionError: any
        try {
          ({ stdout, stderr } = await exec(options.osCli!, argv, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }))
        } catch (error) {
          executionError = error
          stdout = String(executionError.stdout ?? '')
          stderr = String(executionError.stderr ?? '')
        }
        const stem = `${phase}-${label}-os-cli-${attempt.cliCalls.length}`
        const stdoutFile = `${stem}-stdout.txt`, stderrFile = `${stem}-stderr.txt`
        await writeFile(join(evidence, stdoutFile), stdout)
        await writeFile(join(evidence, stderrFile), stderr)
        Object.assign(invoked, { finishedAt: Date.now(), code: executionError ? executionError.code ?? null : 0,
          signal: executionError?.signal ?? null, killed: executionError?.killed ?? false,
          stdoutFile, stderrFile, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
          stdoutSha256: digest(Buffer.from(stdout)), stderrSha256: digest(Buffer.from(stderr)) })
        if (executionError) {
          // execFile rejects nonzero exits with JSON diagnostics in stdout, not necessarily in
          // message. Preserve both complete bounded streams before returning a capture failure.
          Object.assign(invoked, { stdout, stderr, failure: { name: executionError.name, message: executionError.message } })
          throw executionError
        }
        const result = JSON.parse(stdout)
        assert.equal(result.ok, true, stdout)
        return result
      }
      const listed = await call(['list-windows', '--app', `pid:${process.pid}`])
      attempt.listed = listed
      assert.equal(listed.result.app.pid, process.pid)
      assert.equal(listed.result.windows.length, 1, 'The native provider chooses only the sole private window')
      const osWindow = listed.result.windows[0]
      attempt.selectedOsWindow = osWindow
      assert.equal(osWindow.app.pid, process.pid)
      assert.equal(osWindow.isMinimized, false)
      assert.equal(osWindow.isOffscreen, false)
      assert.equal(window.isVisible(), true, 'Only the already visible private fixture may acquire capture focus')
      assert.deepEqual(BrowserWindow.getAllWindows(), [window], 'Capture activation is restricted to the sole exact private window')
      attempt.activation = { mechanism: 'Electron app.focus and exact private BrowserWindow.focus; capture prerequisite only',
        before: { appActive: app.isActive(), windowFocused: window.isFocused() } }
      if (!window.isFocused()) { app.focus({ steal: true }); window.focus() }
      const deadline = Date.now() + 1500
      while (!window.isFocused() && Date.now() < deadline) await pause(20)
      attempt.activation.after = { appActive: app.isActive(), windowFocused: window.isFocused() }
      // Keep unforced native facts in before. The provider's documented restore-window is
      // bounded to the freshly listed PID/window. An unaccepted Electron focus request must
      // not erase the provider's own diagnostic; it gets this one documented restore attempt.
      const captureBefore = owners()
      attempt.captureBefore = captureBefore
      const captured = await call(['get-app-state', '--app', `pid:${process.pid}`, '--window-id', String(osWindow.id), '--restore-window'])
      assert.equal(captured.result.snapshot.app.pid, process.pid)
      assert.equal(captured.result.snapshot.window.id, osWindow.id)
      assert.equal(captured.result.screenshotStatus.state, 'captured', JSON.stringify(captured.result.screenshotStatus))
      const screenshot = captured.result.screenshot
      assert.equal(screenshot.format, 'png')
      const bytes = screenshot.path ? await readFile(screenshot.path) : Buffer.from(screenshot.data, 'base64')
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const file = `${phase}-${label}-os-compositor.png`
      await writeFile(join(evidence, file), bytes)
      const after = owners()
      attempt.activation.providerAfter = { appActive: app.isActive(), windowFocused: window.isFocused() }
      attempt.after = after
      assert.deepEqual({ ...after, window: { ...after.window, focused: captureBefore.window.focused } }, captureBefore,
        'Documented restore may acquire private focus; OS capture preserves original native owner order and geometry')
      Object.assign(attempt, { captured: true, file, sha256: digest(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
        listed, capture: { ...captured, result: { ...captured.result, screenshot: { ...screenshot, data: undefined } } }, after })
    } catch (error) {
      Object.assign(attempt, { captured: false, failure: { name: (error as Error).name, message: (error as Error).message } })
      attempt.failedOwners = owners()
      if (attempt.activation) attempt.activation.providerAfter = { appActive: app.isActive(), windowFocused: window.isFocused() }
    }
    await saveReceipt()
    return attempt
  }
  async function pageFacts(id: string) {
    const binding = bindings.get(id)
    assert.ok(binding && !binding.contents.isDestroyed(), 'Read the original actual native Browser owner')
    return await binding.contents.executeJavaScript('window.nativeFixture?.facts()')
  }
  async function withPageDebugger<T>(binding: BrowserBinding, work: (command: (method: string, params: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
    const debuggerApi = binding.contents.debugger, attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    try { return await work((method, params) => debuggerApi.sendCommand(method, params)) }
    finally { if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach() }
  }
  async function verifyPageInput(id: string, label: string, action: 'click' | 'move' = 'click') {
    labelName(label)
    const observation: any = { label, browserId: id, action, passed: false, before: owners(), mechanism: 'Trusted DevTools Input.dispatchMouseEvent on the actual original WebContents after topmost native owner verification; no forced OS focus or manual UI bridge. Physical hardware and OS composition are not tested.' }
    receipt.inputs.push(observation)
    try {
      const binding = bindings.get(id)
      assert.ok(binding && !binding.contents.isDestroyed())
      const view = binding.view
      assert.equal(BrowserWindow.fromWebContents(view.webContents), window)
      assert.equal(view.getVisible(), true, 'The original native page remains drawn')
      assert.ok(window.contentView.children.includes(view))
      const page = await view.webContents.executeJavaScript(`(()=>{const button=document.getElementById('native-proof-action');if(!button||!window.nativeFixture)throw new Error('Original private page not ready');const r=button.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2};return {owner:window.nativeFixture.owner,before:window.nativeFixture.facts(),point,hit:document.elementFromPoint(point.x,point.y)===button}})()`)
      assert.equal(page.owner, id)
      assert.equal(page.hit, true)
      const zoomFactor = view.webContents.getZoomFactor(), bounds = view.getBounds()
      const local = { x: Math.round(page.point.x * zoomFactor), y: Math.round(page.point.y * zoomFactor) }
      const world = { x: bounds.x + local.x, y: bounds.y + local.y }
      Object.assign(observation, { page, zoomFactor, bounds, local, world, expectedWebContentsId: view.webContents.id })
      assert.ok(inside(local, { x: 0, y: 0, width: bounds.width, height: bounds.height }), 'The actual original action is within native page bounds')
      const topmost = [...nativeChildren()].reverse().find(candidate => candidate.getVisible() && inside(world, candidate.getBounds()))
      observation.topmostWebContentsId = topmost?.webContents.id
      observation.topmostBounds = topmost?.getBounds()
      assert.equal(topmost, view, 'An original page action must hit its actual native owner; sending input through covered Chrome would bypass the defect')
      observation.focus = { appActive: app.isActive(), windowFocused: window.isFocused(), pageFocused: view.webContents.isFocused() }
      const eventStart = receipt.nativeInputEvents.length, noticeStart = receipt.browserInputs.length
      await withPageDebugger(binding, async command => {
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...page.point })
        if (action === 'click') for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...page.point, button: 'left', clickCount: 1 })
      })
      await pause(80)
      const after = await pageFacts(id)
      observation.pageAfter = after
      observation.nativeEvents = receipt.nativeInputEvents.slice(eventStart)
      observation.notices = receipt.browserInputs.slice(noticeStart)
      assert.ok(observation.nativeEvents.some((event: any) => event.browserId === id && event.input.type === 'mouseMove'), 'Trusted DevTools input actually reaches the public WebContents input-event boundary')
      assert.ok(observation.notices.some((event: any) => event.browserId === id && event.type === 'pointerMove'), 'Actual BrowserViewManager input reaches the original DOM-owner bridge without a manual callback')
      assert.equal(after.clicks, page.before.clicks + (action === 'click' ? 1 : 0))
      assert.deepEqual(after.events.slice(page.before.events.length), action === 'click' ? [
        { type: 'mousedown', target: 'native-proof-action', trusted: true },
        { type: 'mouseup', target: 'native-proof-action', trusted: true },
        { type: 'click', target: 'native-proof-action', trusted: true }
      ] : [])
      if (action === 'click') {
        assert.equal(after.lastTrusted, true)
        assert.ok(observation.notices.some((event: any) => event.browserId === id && event.type === 'pointerDown'))
      }
      observation.passed = true
      observation.after = owners()
    } catch (error) {
      observation.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
      observation.failedOwners = owners()
      receipt.failures.push({ label, ...observation.failure })
      // Preserve actual composition and native order before Root turns this result into an
      // assertion. Capture failure remains explicit; it cannot erase the owning native RED.
      observation.os = await captureOsWindow(`${label}-failure`)
    }
    await saveReceipt()
    return observation
  }
  async function verifyPageEscape(id: string, label: string, composing = false) {
    labelName(label)
    const observation: any = { label, browserId: id, action: 'escape', composing, passed: false, before: owners(),
      mechanism: 'Trusted DevTools mouse input focuses the observed original page editor after exact native topmost verification. Input.imeSetComposition starts/cancels real page composition; raw Escape has no invented isComposing parameter. Actual WebContents before-input-event and original DOM composition events are required. Physical hardware and OS IME are not tested.' }
    receipt.inputs.push(observation)
    try {
      const binding = bindings.get(id)
      assert.ok(binding && !binding.contents.isDestroyed())
      const view = binding.view
      assert.equal(BrowserWindow.fromWebContents(binding.contents), window)
      assert.equal(view.getVisible(), true)
      assert.ok(window.contentView.children.includes(view))
      const page = await binding.contents.executeJavaScript(`(()=>{const editor=document.getElementById('native-proof-editor');if(!editor||!window.nativeFixture)throw new Error('Original page editor not ready');const r=editor.getBoundingClientRect(),point={x:r.x+r.width/2,y:r.y+r.height/2};return {owner:window.nativeFixture.owner,before:window.nativeFixture.facts(),point,hit:document.elementFromPoint(point.x,point.y)===editor}})()`)
      assert.equal(page.owner, id)
      assert.equal(page.hit, true)
      const zoomFactor = binding.contents.getZoomFactor(), bounds = view.getBounds()
      const local = { x: Math.round(page.point.x * zoomFactor), y: Math.round(page.point.y * zoomFactor) }
      const world = { x: bounds.x + local.x, y: bounds.y + local.y }
      Object.assign(observation, { page, zoomFactor, bounds, local, world, expectedWebContentsId: binding.contents.id })
      assert.ok(inside(local, { x: 0, y: 0, width: bounds.width, height: bounds.height }))
      const topmost = () => [...nativeChildren()].reverse().find(candidate => candidate.getVisible() && inside(world, candidate.getBounds()))
      observation.topmostWebContentsId = topmost()?.webContents.id
      assert.equal(topmost(), view, 'Real editor input must reach the topmost original owner')
      const eventStart = receipt.nativeInputEvents.length, keyStart = receipt.keyboardEvents.length, noticeStart = receipt.browserInputs.length
      await withPageDebugger(binding, async command => {
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...page.point })
        for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...page.point, button: 'left', clickCount: 1 })
        await pause(80)
        observation.editorFocused = (await pageFacts(id)).editorFocused
        assert.equal(observation.editorFocused, true, 'Only actual native mouse input focuses the original editor')
        assert.equal(topmost(), view, 'Focus and pin preserve the exact native owner at the observed point')
        await command('Input.imeSetComposition', { text: composing ? '中' : '', selectionStart: 0, selectionEnd: composing ? 1 : 0 })
        observation.compositionBeforeEscape = await pageFacts(id)
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      })
      await pause(80)
      observation.pageAfter = await pageFacts(id)
      observation.nativeEvents = receipt.nativeInputEvents.slice(eventStart)
      observation.keyboardEvents = receipt.keyboardEvents.slice(keyStart)
      observation.notices = receipt.browserInputs.slice(noticeStart)
      assert.ok(observation.nativeEvents.some((event: any) => event.browserId === id && event.input.type === 'mouseDown'), 'Original editor input actually reaches the public native mouse boundary')
      const escapes = observation.keyboardEvents.filter((event: any) => event.browserId === id && event.input.type === 'keyDown' && event.input.key === 'Escape')
      assert.equal(escapes.length, 1, 'Actual Escape reaches the public WebContents before-input-event once')
      assert.equal(escapes[0].input.isComposing, composing, 'The composing fact comes from the actual native event, never an injected parameter')
      const notices = observation.notices.filter((input: any) => input.type === 'escape')
      assert.equal(notices.length, composing ? 0 : 1, 'Only ordinary native Escape reaches the original opened float owner')
      if (composing) {
        const compositionEvents = observation.compositionBeforeEscape.keyboardEvents.slice(page.before.keyboardEvents.length)
        assert.ok(compositionEvents.some((event: any) => event.type === 'compositionstart' && event.trusted === true), 'Real page composition starts through the trusted native boundary')
      } else assert.equal(notices[0].browserId, id)
      observation.after = owners()
      observation.passed = true
    } catch (error) {
      observation.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
      observation.failedOwners = owners()
      receipt.failures.push({ label, ...observation.failure })
      observation.os = await captureOsWindow(`${label}-failure`)
    }
    await saveReceipt()
    return observation
  }
  async function captureNativeFrames(label: string) {
    labelName(label)
    const attempt: any = { label, passed: false, before: owners(), source: 'individual-webcontents-frames', osComposition: false, frames: [] }
    receipt.nativeFrames.push(attempt)
    try {
      const projections = Reflect.get(nativeChrome, 'projections') as Map<string, ChromeProjection>
      const views = [...bindings].flatMap(([browserId, binding]) => binding.contents.isDestroyed() || !binding.view.getVisible() ? [] :
        [{ kind: 'native-page', id: browserId, view: binding.view, contents: binding.contents }]).concat(
        [...projections].map(([regionId, projection]) => ({ kind: 'native-chrome', id: regionId, view: projection.view, contents: projection.view.webContents })))
      assert.ok(views.some(view => view.kind === 'native-page'), 'Individual frame proof includes an actual original native page')
      assert.ok(views.some(view => view.kind === 'native-chrome'), 'Individual frame proof includes actual projected Chrome')
      for (const { kind, id, view, contents } of views) {
        assert.equal(BrowserWindow.fromWebContents(contents), window)
        const image = await contents.capturePage()
        assert.equal(image.isEmpty(), false)
        const bytes = image.toPNG(), file = `${phase}-${label}-${kind}-${contents.id}.png`
        assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        await writeFile(join(evidence, file), bytes)
        attempt.frames.push({ kind, id, file, webContentsId: contents.id, ownerWindowId: window.id, bounds: view.getBounds(),
          sha256: digest(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), osComposition: false })
      }
      attempt.after = owners()
      assert.deepEqual(attempt.after, attempt.before, 'Individual frame capture preserves original native ownership and geometry')
      attempt.passed = true
    } catch (error) { attempt.failure = { name: (error as Error).name, message: (error as Error).message }; attempt.failedOwners = owners() }
    await saveReceipt()
    return attempt
  }
  async function dispose() {
    if (disposed) return
    receipt.beforeDispose = owners()
    disposed = true
    for (const channel of handled) ipcMain.removeHandler(channel)
    ipcMain.off('mote-native:page-url', pageUrl)
    browsers.onNativeInput = undefined
    nativeChrome.dispose()
    browsers.dispose()
    await profiles.dispose()
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
    const deadline = Date.now() + 1500
    while ([...bindings.values()].some(binding => !binding.contents.isDestroyed()) && Date.now() < deadline) await pause(20)
    receipt.afterDispose = owners()
    receipt.disposed = true
    assert.deepEqual(receipt.afterDispose.browsers, [])
    assert.deepEqual(receipt.afterDispose.chrome, [])
    assert.equal(receipt.afterDispose.resources.browserViews, 0)
    await saveReceipt()
  }
  return { receipt, browsers, nativeChrome, fixturePageUrl, owners, pageFacts, verifyPageInput,
    verifyPageHover: (id: string, label: string) => verifyPageInput(id, label, 'move'), verifyPageEscape, captureNativeFrames, captureOsWindow, dispose }
}
