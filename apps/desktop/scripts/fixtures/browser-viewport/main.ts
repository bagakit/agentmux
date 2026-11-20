import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, type NativeImage, type WebContentsView } from 'electron'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { parseAgentMuxSpatialGraph, spatialCatalog } from '@agentmux/core/spatial-state'
import { browserColdDescriptor } from '../../../src/main/browser-cold-descriptor'
import { browserViewportSize, browserViewportsEqual } from '../../../src/shared/browser-viewport'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { installNativeOverlayFocus } from '../../../src/main/native-overlay-focus'
import { reducePersistedTab } from '../../../src/renderer/src/lib/workbench-persistence'
import { ipcResult } from '../../../src/shared/ipc-result'
import { normalizeBrowserBounds } from '../../../src/shared/browser-bounds'
import { BROWSER_EVENT_CHANNEL, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_BROWSER_VISIBILITY_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL,
  type BrowserViewport } from '../../../src/shared/contracts'

const root = process.env.AGENTMUX_VIEWPORT_ROOT!, out = process.env.AGENTMUX_VIEWPORT_OUT!, label = process.env.AGENTMUX_VIEWPORT_LABEL!
const deviceOnly = process.env.AGENTMUX_VIEWPORT_DEVICE_ONLY === '1'
const restart = process.env.AGENTMUX_VIEWPORT_RESTART === '1'
const preflight = process.env.AGENTMUX_VIEWPORT_RETURN_PREFLIGHT === '1'
assert.ok(root.includes('agentmux-viewport-'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('no-proxy-server'); app.commandLine.appendSwitch('disk-cache-size', '1048576')
const originalId = 'private-viewport-original', siblingId = 'private-viewport-sibling', workspaceId = 'private-viewport-workspace'
const receipt: any = { label, pid: process.pid, passed: false, cases: [], images: [], warnings: [], calls: [], events: [], public: [], transitions: [], publications: [], windowFocus: [] }
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, server: Server, rpcServer: AgentMuxControlServer
let original: WebContentsView, sibling: WebContentsView, baseline: any, siblingBaseline: any, baseUrl: string
let chromeReady = false
let uninstallNativeOverlayFocus: (() => void) | undefined
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (code: string) => window.webContents.executeJavaScript(code)
async function until(name: string, read: () => Promise<any>, budget = 4000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiration = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Viewport observation failed: ' + name)), budget)
  })
  try {
    for (;;) {
      const value = await Promise.race([read(), expiration])
      if (value) return value
      await Promise.race([delay(15), expiration])
    }
  } finally { clearTimeout(timer) }
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
const uiFacts = () => evaluate('window.viewportProbe.read()')
const pageFacts = () => original.webContents.executeJavaScript('window.viewportFacts()')
async function pointer(type: string, point: { x: number; y: number }) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
}
async function clickUi(selector: string, name: string) {
  const point = await until('actual Chrome control exists: ' + name, () => evaluate(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=nodes.find(n=>(n.getAttribute('aria-label')===${JSON.stringify(name)}||n.textContent.trim().startsWith(${JSON.stringify(name)}))&&n.getBoundingClientRect().width>0);if(!e)return null;if(e.getAttribute('role')==='menuitem')e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,hit:e.contains(hit),hitTag:hit?.tagName}})()`))
  assert.ok(point, 'Actual Viewport control exists: ' + name)
  assert.equal(point.hit, true, 'The actual Chrome trigger owns its Renderer hit: ' + name)
  await pointer('mouseMoved', point); await pointer('mousePressed', point); await pointer('mouseReleased', point)
}
function viewportTitle(mode: BrowserViewport) {
  if (browserViewportSize(mode)?.device === 'phone') return 'Phone · touch'
  return typeof mode === 'string' ? mode[0].toUpperCase() + mode.slice(1) : 'Custom'
}
async function choose(mode: BrowserViewport, narrow = false, title = viewportTitle(mode), imageName?: string) {
  const trigger = narrow ? 'More browser tools' : 'Viewport'
  app.focus({ steal: true }); window.focus()
  await until('the native application window is active before page focus', async () => window.isFocused())
  original.webContents.focus()
  await until('the original native page really owns focus before choosing ' + mode, async () => original.webContents.isFocused())
  const before = await uiFacts(), callStart = receipt.calls.length, publicationStart = receipt.publications.length
  const previousLayers = new Set(window.contentView.children.filter(view => view !== original && view !== sibling && 'webContents' in view)
    .map(view => (view as WebContentsView).webContents?.id))
  const transition: any = { mode, narrow, previous: before.viewport,
    beforeFocus: { window: window.isFocused(), original: original.webContents.isFocused(), renderer: window.webContents.isFocused(), document: await original.webContents.executeJavaScript('document.hasFocus()') }, nativeInputs: [] }
  receipt.transitions.push(transition)
  assert.equal(transition.beforeFocus.document, true, 'The real page document owns focus before this menu choice')
  // A real OS click on Chrome transfers native WebContents focus. CDP input alone
  // does not model that boundary; explicitly establish and observe its prerequisite.
  window.webContents.focus()
  await until('the real Chrome owns native focus before its trigger', async () => window.webContents.isFocused() && await evaluate('document.hasFocus()'))
  transition.chromeFocus = { fixturePrerequisite: 'native-Chrome-focus-before-trigger', renderer: window.webContents.isFocused(), document: await evaluate('document.hasFocus()'), original: original.webContents.isFocused() }
  await clickUi('button', trigger)
  if (narrow) await clickUi('[role=menuitem][aria-haspopup]', 'Viewport')
  const readMenu = () => evaluate(`window.viewportProbe.menu(${JSON.stringify(trigger)},${JSON.stringify(title)})`)
  const menu = await until('the exact Viewport Root and Content are currently open', readMenu)
  const previousTitle = viewportTitle(before.viewport)
  assert.equal(menu.radios.find((radio: any) => radio.text.startsWith(previousTitle))?.checked, 'true', 'The original Content selects the previously applied mode')
  const zoom = window.webContents.getZoomFactor()
  const nativeBounds = (bounds: any) => normalizeBrowserBounds({ x: bounds.x * zoom, y: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom })!
  const sameBounds = (a: any, b: any) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
  const prepared = await until('the current exact Content has a new native projection and completed publication', async () => {
    const current = await readMenu()
    if (!current || current.contentId !== menu.contentId || !current.hit) return null
    const desired = nativeBounds(current.contentBounds)
    const publication = receipt.publications.slice(publicationStart).findLast((row: any) => row.result?.projected > 0 && !row.result.warning &&
      row.regions.some((region: any) => sameBounds(normalizeBrowserBounds(region.bounds), desired)))
    if (!publication) return null
    const found = [...window.contentView.children].reverse().find(view => {
      if (view === original || view === sibling || !view.getVisible() || !('webContents' in view)) return false
      const contents = (view as WebContentsView).webContents
      return contents && !previousLayers.has(contents.id) && sameBounds(view.getBounds(), desired)
    }) as WebContentsView | undefined
    return found ? { layer: found, menu: current, publication } : null
  })
  const current = await readMenu()
  assert.equal(current?.contentId, prepared.menu.contentId, 'The exact Content remains open immediately before native input')
  assert.equal(current?.hit, true, 'The original Renderer hit names this exact current Radio')
  assert.deepEqual(nativeBounds(current.contentBounds), prepared.layer.getBounds(), 'The current Content still matches its new physical projection')
  transition.geometry = current
  if (imageName) await saveImage(imageName, await window.webContents.capturePage(), 'actual-renderer-viewport-menu', { menu: current })
  const contents = prepared.layer.webContents, bounds = prepared.layer.getBounds(), point = { x: Math.round(current.point.x * zoom - bounds.x), y: Math.round(current.point.y * zoom - bounds.y) }
  transition.projection = { webContentsId: contents.id, bounds, localPoint: point, windowZoom: zoom, publication: prepared.publication,
    association: 'unique open Content and matching new native/publication bounds', interactiveBeforeInput: 'unknown: public receipt exposes no per-projection interactive state' }
  const observeInput = (_event: Electron.Event, input: Electron.InputEvent) => transition.nativeInputs.push({ ...input })
  contents.on('input-event', observeInput)
  try {
    // Only the actual native projection receives these events. Its production forwarder
    // must deliver the complete trusted click to the original Radio and preload owner.
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    await until('the original Radio consumes native move before down', async () => (await uiFacts()).events.slice(before.events.length)
      .some((event: any) => event.type === 'pointermove' && event.trusted && event.target?.startsWith(title)))
    // Simulate the native projection focus prerequisite of an OS mouseDown. This
    // remains a programmatic native consumer, not a claim of physical OS input.
    contents.focus()
    await until('the hit projection owns real focus before down', async () => !contents.isDestroyed() && contents.isFocused())
    await settle()
    const afterFocus = await readMenu()
    assert.equal(afterFocus?.contentId, current.contentId, 'native-focus-handoff-keeps-original-menu-open')
    assert.equal(afterFocus?.hit, true, 'native-focus-handoff-keeps-original-menu-open: exact Radio still owns its hit')
    transition.focusHandoff = { simulation: 'projection-focus-before-native-mouseDown', layerFocused: contents.isFocused(),
      rendererFocused: window.webContents.isFocused(), windowFocused: window.isFocused(), originalContentId: afterFocus.contentId }
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    await delay(80)
    assert.equal((await readMenu())?.contentId, current.contentId, 'The same original menu remains open until native mouseUp')
    assert.equal(contents.isDestroyed(), false, 'The original projection retains the accepted button until release')
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await until('menu-call-must-apply-original-viewport: ' + mode, async () => {
      const current = await uiFacts(); return browserViewportsEqual(current.viewport, mode) && !current.menus
    })
    await settle()
  } finally {
    contents.removeListener('input-event', observeInput)
    const after = await uiFacts()
    transition.events = after.events.slice(before.events.length)
    transition.calls = receipt.calls.slice(callStart).filter((call: any) => call.channel === 'browser:setViewport')
    transition.after = { viewport: after.viewport, menus: after.menus, activeElement: after.activeElement, bodyPointerEvents: after.bodyPointerEvents,
      originalFocused: original.webContents.isFocused(), rendererFocused: window.webContents.isFocused() }
  }
  assert.deepEqual(transition.calls.map((call: any) => call.args), [[originalId, mode]], 'Actual production preload invokes the original Main setter exactly once for this choice')
  assert.deepEqual(transition.events.filter((event: any) => ['pointerdown', 'pointerup', 'click'].includes(event.type) && event.target?.startsWith(title))
    .map((event: any) => ({ type: event.type, trusted: event.trusted })), ['pointerdown', 'pointerup', 'click'].map(type => ({ type, trusted: true })),
  'The exact Radio consumes one complete trusted native click for this choice')
  transition.projection.inputConsumerConfirmed = true
}
// Chrome input exercises the same menu, preload and native viewport even when the
// private Electron app cannot become the OS foreground window.
async function chooseFromChrome(mode: BrowserViewport, narrow: boolean, title: string, imageName?: string) {
  const trigger = narrow ? 'More browser tools' : 'Viewport'
  const start = receipt.calls.length
  const before = await uiFacts()
  window.webContents.focus()
  await clickUi('button', trigger)
  if (narrow) await clickUi('[role=menuitem][aria-haspopup]', 'Viewport')
  const menu = await until('the original Chrome menu option is visible and owns its hit', async () => {
    const value = await evaluate(`window.viewportProbe.menu(${JSON.stringify(trigger)},${JSON.stringify(title)})`)
    return value?.hit ? value : null
  })
  if (imageName) await saveImage(imageName, await window.webContents.capturePage(), 'actual-renderer-viewport-menu', { menu })
  for (const kind of ['mouseMoved', 'mousePressed', 'mouseReleased']) await pointer(kind, menu.point)
  await until('menu-call-must-apply-original-viewport: ' + title, async () => {
    const current = await uiFacts()
    return browserViewportsEqual(current.viewport, mode) && !current.menus
  })
  assert.deepEqual(receipt.calls.slice(start).filter((call: any) => call.channel === 'browser:setViewport')
    .map((call: any) => call.args), [[originalId, mode]])
  const events = (await uiFacts()).events.slice(before.events.length)
  assert.ok(events.some((event: any) => event.type === 'click' && event.trusted && event.target?.startsWith(title)))
  receipt.transitions.push({ mode, narrow, input: 'trusted-Chromium-Chrome', menu })
}

async function ordinaryWindowBlur() {
  const mode = (await uiFacts()).viewport, title = viewportTitle(mode)
  window.webContents.focus(); await until('ordinary blur starts in focused Chrome', async () => window.webContents.isFocused())
  await clickUi('button', 'Viewport')
  await until('ordinary blur starts with the exact open menu', async () => evaluate(`window.viewportProbe.menu('Viewport',${JSON.stringify(title)})`))
  const callsBefore = receipt.calls.filter((call: any) => call.channel === 'browser:setViewport').length
  window.blur()
  await until('ordinary window blur dismisses the original menu', async () => {
    const state = await uiFacts(); return !window.isFocused() && !state.menus
  })
  assert.equal(receipt.calls.filter((call: any) => call.channel === 'browser:setViewport').length, callsBefore, 'Ordinary blur never applies a viewport')
  receipt.cases.push({ label: 'ordinary-window-blur-still-dismisses-the-original-menu', viewport: mode, windowFocused: window.isFocused() })
  // Establish native focus only for the next bounded scenario.
  app.focus({ steal: true }); window.focus(); window.webContents.focus()
}
async function returnChoices(page: string) {
  for (const narrow of [false, true]) {
    await resize(narrow ? 330 : 900, 650)
    const fixedBounds = manager.nativeOwner(originalId)!.bounds
    for (const [index, mode] of (['mobile', 'tablet', 'mobile', 'desktop', 'mobile', 'responsive'] as BrowserViewport[]).entries()) {
      const name = 'return-' + page + '-' + (narrow ? 'narrow-' : 'wide-') + index + '-' + mode
      await choose(mode, narrow)
      const metrics = await pageFacts(), expected = browserViewportSize(mode)
      if (expected) { assert.equal(metrics.screen.width, expected.width, 'native-apply-must-change-layout-width: ' + name); assert.equal(metrics.screen.height, expected.height) }
      else assert.ok(Math.abs(metrics.innerWidth * baseline.zoom - fixedBounds.width) <= 1)
      assert.deepEqual(manager.nativeOwner(originalId)!.bounds, fixedBounds, 'Viewport return choices never resize the original Pane')
      await identity(name)
      receipt.cases.push({ label: name, mode, metrics, bounds: fixedBounds })
    }
  }
}
async function resize(width: number, height: number) {
  await evaluate(`window.viewportProbe.resize(${width},${height})`); await settle()
  const bounds = await evaluate(`document.querySelector('[data-native-browser-stage="${originalId}"]').getBoundingClientRect().toJSON()`)
  const measured = normalizeBrowserBounds(bounds)
  assert.ok(measured && Math.abs(measured.width - width) <= 2 && measured.height < height, 'Product Stage has the requested pane geometry')
  // This fixture owns one native presentation. Apply the rendered Stage's measured
  // geometry through the original View manager, preserving its input and fit paths.
  manager.setBounds(originalId, measured)
  assert.deepEqual(manager.nativeOwner(originalId)?.bounds, measured)
  await settle()
}
async function identity(name: string) {
  const owner = manager.nativeOwner(originalId), other = manager.nativeOwner(siblingId)
  assert.equal(owner?.view, original, name + ': original physical View remains')
  assert.equal(other?.view, sibling, name + ': sibling physical View remains')
  const current = manager.targets().find(target => target.id === originalId)!, otherTarget = manager.targets().find(target => target.id === siblingId)!
  assert.equal(current.navigationId, baseline.navigationId); assert.equal(current.workspaceId, workspaceId)
  assert.equal(otherTarget.navigationId, siblingBaseline.navigationId)
  const snapshot = await manager.create(originalId, current.url, workspaceId)
  assert.equal(snapshot.profileId, baseline.profileId)
  assert.equal((await pageFacts()).draft, 'retained original draft')
  assert.equal(await sibling.webContents.executeJavaScript('document.querySelector("input").value'), 'retained sibling draft')
  assert.equal(original.webContents.getZoomFactor(), baseline.zoom)
  assert.equal(sibling.webContents.getZoomFactor(), siblingBaseline.zoom)
  assert.deepEqual(window.getContentSize(), [1200, 800], 'Choosing/resizing a Pane does not resize the App window')
}
const colors = { tl: [0, 230, 230], tr: [255, 220, 0], bl: [0, 220, 70], br: [230, 0, 220] }
function corners(image: NativeImage) {
  const { width, height } = image.getSize(), bitmap = image.toBitmap(), result: any = {}
  for (const [name, rgb] of Object.entries(colors)) {
    let count = 0, sx = 0, sy = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.abs(bitmap[i + 2] - rgb[0]) < 18 && Math.abs(bitmap[i + 1] - rgb[1]) < 18 && Math.abs(bitmap[i] - rgb[2]) < 18) { count++; sx += x; sy += y }
    }
    result[name] = { count, x: sx / count, y: sy / count }
  }
  return result
}
async function observe(name: string, mode: BrowserViewport, save = false) {
  const metrics = await pageFacts(), owner = manager.nativeOwner(originalId)!, image = await original.webContents.capturePage()
  const marks = corners(image)
  for (const [corner, mark] of Object.entries<any>(marks)) assert.ok(mark.count >= 4, 'fixed-viewport-must-fit-all-four-corners: ' + name + '/' + corner)
  const expected = browserViewportSize(mode)
  if (expected) {
    assert.equal(metrics.screen.width, expected.width, 'native-apply-must-change-layout-width: ' + name)
    assert.equal(metrics.screen.height, expected.height, 'native-apply-must-change-layout-height: ' + name)
    if (metrics.hasMeta || mode === 'desktop') {
      assert.ok(Math.abs(metrics.innerWidth - expected.width) <= 1, 'native-apply-must-change-layout-width: ' + name)
      assert.ok(Math.abs(metrics.innerHeight - expected.height) <= 1, 'native-apply-must-change-layout-height: ' + name)
    } else assert.ok(Math.abs(metrics.visual.width * metrics.visual.scale - expected.width) <= 1, 'No-meta standard mobile visual/layout relation remains')
  } else {
    assert.ok(Math.abs(metrics.innerWidth * baseline.zoom - owner.bounds.width) <= 1, 'Responsive follows actual Pane width')
    assert.ok(Math.abs(metrics.innerHeight * baseline.zoom - owner.bounds.height) <= 1, 'Responsive follows actual Pane height')
  }
  const size = image.getSize(), clicked: any[] = []
  for (const [corner, mark] of Object.entries<any>(marks)) {
    const point = { x: Math.round(mark.x * owner.bounds.width / size.width), y: Math.round(mark.y * owner.bounds.height / size.height) }
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) original.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
    await delay(12)
    const after = await pageFacts(), event = after.clicks.at(-1)
    assert.equal(event?.corner, corner, 'fit-native-input-must-hit-visible-corner: ' + name + '/' + corner)
    assert.equal(event.trusted, true); clicked.push(event)
  }
  await identity(name)
  receipt.cases.push({ label: name, mode, metrics, marks, trustedClicks: clicked, nativeBounds: owner.bounds, imageSize: size, browser: { ...baseline, webContentsId: original.webContents.id } })
  if (save) await shot(name)
}
async function saveImage(name: string, image: NativeImage, kind: string, extra: any = {}) {
  const bytes = image.toPNG(), path = label + '-' + name + '.png'
  await writeFile(join(out, path), bytes)
  const row = { path, kind, bytes: bytes.length, sha256: sha(bytes), size: image.getSize(), pid: process.pid, ...extra }
  receipt.images.push(row); return row
}
async function shot(name: string) {
  await settle()
  const chrome = await window.webContents.capturePage(), layers = []
  const sources = [await saveImage(name + '-renderer', chrome, 'actual-renderer')]
  for (const id of [originalId, siblingId]) {
    const owner = manager.nativeOwner(id)
    if (!owner || !owner.view.getVisible()) continue
    const capture = await owner.view.webContents.capturePage()
    sources.push(await saveImage(name + '-' + (id === originalId ? 'original' : 'sibling'), capture, 'actual-native-view', { browserId: id, bounds: owner.bounds, visible: true, webContentsId: owner.view.webContents.id }))
    layers.push({ dataUrl: capture.toDataURL(), ...owner.bounds })
  }
  const dataUrl = await evaluate(`window.viewportProbe.compose(${JSON.stringify(chrome.toDataURL())},${JSON.stringify(layers)})`)
  await saveImage(name, nativeImage.createFromDataURL(dataUrl), 'complete-workface-composite-from-actual-settled-surfaces', { sources: sources.map(s => ({ path: s.path, sha256: s.sha256 })), bounds: manager.nativeOwner(originalId)?.bounds })
}
async function cli(args: string[], input = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_RPC_ENDPOINT: 'unix:' + rpcServer.path,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'cli-runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'cli-state') })
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.AGENTMUX_VIEWPORT_CLI!, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 500) }, 8000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation)
      if (expired) reject(new Error('Exact private CLI child timed out and exited'))
      else { try { assert.equal(code, 0, stderr + stdout); const result = JSON.parse(stdout); assert.equal(result.ok, true); resolve({ pid: child.pid, code, signal, result, stderr }) } catch (error) { reject(error) } }
    }); child.stdin.end(input)
  })
}
async function publicRead(name: string, useCli: boolean) {
  const program = `const tree=await snapshot({interactiveOnly:true,maxNodes:64}); const target=tree.nodes.find(n=>n.name==='Corner br'); if(!target)throw Error('Original corner ref missing'); await click(target.ref); const geometry=await js('window.viewportFacts()'); const metrics=await cdp('Page.getLayoutMetrics'); const capture=await captureScreenshot(); return {geometry,metrics,browserId:capture.browserId,navigationId:capture.navigationId,source:capture.source,image:{width:capture.image.width,height:capture.image.height}}`
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: rpcServer.path } })
  let sdk: any
  try { sdk = await rpc.call('browser.run', { browserId: originalId, code: program, operationId: 'viewport-sdk-' + name }) } finally { await rpc.dispose() }
  assert.equal(sdk.outcome.kind, 'completed', 'Public SDK actual ref click completes: ' + name)
  const actual = await pageFacts()
  assert.equal(sdk.result.geometry.innerWidth, actual.innerWidth); assert.equal(sdk.result.geometry.innerHeight, actual.innerHeight)
  assert.equal(sdk.result.geometry.clicks.at(-1)?.corner, 'br', 'Public ref click hits the original corner after fit')
  assert.equal(sdk.result.geometry.clicks.at(-1)?.trusted, false, 'Existing public semantic DOM click is not a trusted human event')
  assert.equal(sdk.result.browserId, originalId); assert.equal(sdk.result.navigationId, baseline.navigationId)
  assert.ok(sdk.result.image.width > 0 && sdk.result.image.height > 0)
  let consumed: any
  if (useCli) {
    consumed = await cli(['browser', 'run', '--browser', originalId, '--operation-id', 'viewport-cli-' + name], program)
    const result = consumed.result.result
    assert.equal(result.outcome.kind, 'completed'); assert.equal(result.result.geometry.innerWidth, actual.innerWidth)
    assert.equal(result.result.geometry.clicks.at(-1)?.corner, 'br')
    assert.equal(result.result.browserId, originalId); assert.equal(result.result.navigationId, baseline.navigationId)
    assert.ok(result.result.image.width > 0 && result.result.image.height > 0)
  }
  receipt.public.push({ label: name, sdk, cli: consumed })
  assert.equal(manager.takeControl(originalId).control?.owner, 'human')
  await identity(name + '-public')
}
function html(meta: boolean, siblingPage = false) {
  return `<!doctype html>${meta ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}<title>${siblingPage ? 'Sibling' : meta ? 'Viewport meta page' : 'Viewport standard mobile layout'}</title><style>html,body{margin:0;background:${siblingPage ? '#173e34' : '#f4f6fb'};color:${siblingPage ? '#fff' : '#233248'};font:18px system-ui}main{padding:72px 55px}h1{font-size:24px}input{width:70%;font:16px system-ui;padding:10px}button{position:fixed;width:32px;height:32px;border:0;padding:0;font:9px system-ui;color:#111}#tl{left:8px;top:8px;background:rgb(0,230,230)}#tr{right:8px;top:8px;background:rgb(255,220,0)}#bl{left:8px;bottom:8px;background:rgb(0,220,70)}#br{right:8px;bottom:8px;background:rgb(230,0,220)}</style><main><h1>${siblingPage ? 'Retained sibling' : meta ? 'Responsive document' : 'Standard mobile layout'}</h1><p>The same page stays available.</p><input value="retained ${siblingPage ? 'sibling' : 'original'} draft"></main>${Object.keys(colors).map(key => `<button id="${key}" aria-label="Corner ${key}">${key}</button>`).join('')}<script>window.cornerClicks=[];window.touches=[];document.addEventListener('click',event=>{if(event.target.matches('button'))cornerClicks.push({corner:event.target.id,trusted:event.isTrusted})});document.addEventListener('pointerdown',event=>{if(event.pointerType==='touch')touches.push({corner:event.target.id,trusted:event.isTrusted})});window.viewportFacts=()=>({innerWidth,innerHeight,dpr:devicePixelRatio,touchPoints:navigator.maxTouchPoints,coarse:matchMedia('(pointer:coarse)').matches,portrait:matchMedia('(orientation:portrait)').matches,touches:touches.slice(),visual:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},screen:{width:screen.width,height:screen.height},hasMeta:!!document.querySelector('meta[name=viewport]'),draft:document.querySelector('input').value,clicks:cornerClicks.slice()})</script>`
}
async function verifyPhoneFit(orientation: string) {
  const bounds = manager.nativeOwner(originalId)!.bounds
  const image = await original.webContents.capturePage()
  const marks = corners(image)
  for (const [corner, mark] of Object.entries<{ count: number }>(marks)) {
    assert.ok(mark.count >= 4, 'fixed-viewport-must-fit-all-four-corners: phone-' + orientation + '/' + corner)
  }
  await identity('phone-' + orientation)
  receipt.cases.push({ label: 'phone-fit-' + orientation, bounds, marks, imageSize: image.getSize() })
}

async function verifyPhone(spatial: ReturnType<typeof parseAgentMuxSpatialGraph>) {
  await manager.navigate(originalId, baseUrl + '/meta')
  await until('original test document ready for phone input', async () => !original.webContents.isLoading() && (await pageFacts()).hasMeta)
  baseline = { ...await manager.create(originalId, baseUrl + '/meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  const normal = await pageFacts()
  await resize(900, 650)
  const select = deviceOnly ? chooseFromChrome : choose
  await select('phone', false, 'Phone · touch', 'phone-menu-wide')
  await settle()
  const phone = await pageFacts()
  assert.equal(phone.dpr, 3, 'phone-native-dpr-is-three')
  assert.equal(phone.touchPoints, 5, 'phone-native-touch-points-are-five')
  assert.equal(phone.coarse, true)
  assert.equal(phone.portrait, true)
  assert.deepEqual(phone.screen, { width: 390, height: 844 })
  if (deviceOnly) await verifyPhoneFit('portrait')
  else await observe('phone-portrait', 'phone', true)
  await resize(330, 620)
  const landscape = { width: 844, height: 390, screenPosition: 'mobile', device: 'phone' } as const
  await select(landscape, true, 'Landscape', 'phone-menu-narrow')
  await settle()
  const rotated = await pageFacts()
  assert.deepEqual(rotated.screen, { width: 844, height: 390 })
  assert.equal(rotated.portrait, false)
  assert.equal(rotated.touchPoints, 5)
  assert.equal(rotated.dpr, 3)
  if (deviceOnly) await verifyPhoneFit('landscape')
  else await observe('phone-landscape', landscape, true)
  // The resource owner reads the exact shared connection, even when the
  // visible Browser has other unrelated retention reasons.
  const retention = () => manager.resourceTargets(null).find(row => row.id === originalId)!.resource!.retention.reasons
  const contents = original.webContents
  assert.equal(contents.debugger.isAttached(), true)
  assert.ok(!retention().includes('debugger'), 'phone-background-lease-must-not-pin-native-resource')
  const foreground = BrowserCdpSession.attach(contents)
  try { assert.ok(retention().includes('debugger'), 'foreground-debugger-lease-must-protect-original-page') }
  finally { foreground.detach() }
  assert.ok(!retention().includes('debugger'))

  contents.debugger.detach()
  const lostUi = await until('native-touch-disconnect-must-publish-visible-warning', async () => {
    const current = await uiFacts()
    return current.warningVisible && current.warning?.includes('Touch emulation is unconfirmed') ? current : null
  })
  assert.ok(browserViewportsEqual(lostUi.viewport, landscape))
  const disconnected = await cli(['browser', 'targets'])
  const originalTarget = disconnected.result.result.targets.find((row: any) => row.id === originalId)
  assert.equal(originalTarget.status, 'ready')
  assert.equal(originalTarget.navigationId, baseline.navigationId)
  assert.match(originalTarget.warning, /Touch emulation is unconfirmed/)
  assert.doesNotMatch(disconnected.result.result.targets.find((row: any) => row.id === siblingId)?.warning ?? '', /Touch emulation/)
  await until('original native touch ends while its geometry remains', async () => {
    const page = await pageFacts()
    return page.touchPoints === normal.touchPoints && page.dpr === 3 && page.screen.width === landscape.width
  })
  await identity('disconnected-touch-keeps-original-page')
  await settle()
  await saveImage('phone-touch-unconfirmed', await window.webContents.capturePage(), 'actual-renderer-touch-warning')
  await clickUi('.browser-operation-warning button', 'Dismiss this Browser notice')
  await until('dismissing the notice preserves the original diagnostic fact', async () => {
    const ui = await uiFacts()
    return !ui.warningVisible && ui.warning === lostUi.warning
  })

  const recover = async () => {
    await select(landscape, true, 'Phone · touch')
    await until('reselecting the checked touch preset reopens the original capability', async () => {
      const page = await pageFacts(), ui = await uiFacts()
      return page.touchPoints === 5 && !page.portrait && !ui.warning?.includes('Touch emulation is unconfirmed')
    })
    assert.doesNotMatch(manager.target(originalId)?.warning ?? '', /Touch emulation/)
  }
  await recover()
  contents.debugger.detach()
  await until('a new touch disconnect is visible after the earlier notice was dismissed', async () => (await uiFacts()).warningVisible)
  await recover()
  receipt.touchLoss = { warning: lostUi.warning, selected: lostUi.viewport, target: originalTarget, recovered: true, newOccurrenceVisible: true }
  const siblingEnvironment = await sibling.webContents.executeJavaScript('window.viewportFacts()')
  assert.equal(siblingEnvironment.touchPoints, normal.touchPoints)
  assert.equal(siblingEnvironment.dpr, normal.dpr)
  const tap = await cli(['browser', 'run', '--browser', originalId, '--operation-id', 'viewport-cli-phone-tap'],
    "const tree=await snapshot({interactiveOnly:true,maxNodes:64}); const node=tree.nodes.find(n=>n.name==='Corner br'); if(!node)throw Error('Missing touch target'); await tap(node.ref); return await js('window.viewportFacts()')")
  assert.equal(tap.result.result.outcome.kind, 'completed')
  assert.deepEqual(tap.result.result.result.touches.at(-1), { corner: 'br', trusted: true }, 'phone-native-tap-reaches-fit-original-corner')
  assert.equal(tap.result.result.result.portrait, false)
  const cliPhone = await cli(['browser', 'viewport', '--browser', originalId, '--preset', 'phone', '--operation-id', 'viewport-cli-phone'])
  assert.equal(cliPhone.result.result.outcome.kind, 'completed')
  assert.equal(cliPhone.result.result.result.viewport, 'phone')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: rpcServer.path } })
  try {
    const result = await rpc.call('browser.run', { browserId: originalId, operationId: 'viewport-save-phone-landscape',
      code: "return await setViewport({width:844,height:390,screenPosition:'mobile',device:'phone'})" })
    assert.equal(result.outcome.kind, 'completed')
    assert.equal(result.result.browserId, originalId)
    assert.equal(result.result.navigationId, baseline.navigationId)
    assert.ok(browserViewportsEqual(result.result.viewport, landscape))
  } finally { await rpc.dispose() }
  const selected = await manager.create(originalId, baseUrl + '/meta', workspaceId)
  await original.webContents.executeJavaScript("document.cookie='viewportRestore=original-profile; Max-Age=3600; Path=/'")
  await original.webContents.session.cookies.flushStore()
  const regionId = 'private-viewport-region'
  const layout = spatial.tabLayouts['viewport-tab']
  const persisted = reducePersistedTab({ id: 'viewport-tab', workspaceId, titleRegionId: regionId, layout,
    regions: { [regionId]: { ...selected, kind: 'browser', browserId: originalId, regionId, workspaceId } } })
  const graph = { ...spatial, regions: spatial.regions.map(region => ({ ...region, browserId: originalId })),
    resources: { ['region:' + regionId]: persisted.regions[regionId] } }
  await writeFile(join(root, 'saved-browser.json'), JSON.stringify({ pid: process.pid, url: baseline.url, profileId: selected.profileId, viewport: selected.viewport, graph }))
  receipt.phone = { phone, rotated, siblingEnvironment, cliPhone, tap }
  await assert.rejects(manager.setViewport(originalId, 'responsive'), /An Agent program owns this Browser/)
  assert.equal(manager.takeControl(originalId).control?.owner, 'human')
  await resize(900, 650)
  await select('responsive', false, 'Responsive')
  await until('responsive restores original native DPR and touch after leaving phone', async () => {
    const actual = await pageFacts(); return actual.touchPoints === normal.touchPoints && actual.dpr === normal.dpr
  })
  assert.ok(!(await uiFacts()).warningVisible, 'Intentional exit never emits an unexpected connection warning')
  const debuggerApi = original.webContents.debugger
  const sendCommand = debuggerApi.sendCommand
  debuggerApi.sendCommand = (method, ...params) => method === 'Emulation.setTouchEmulationEnabled'
    ? Promise.reject(new Error('Fixture native touch rejection'))
    : sendCommand.call(debuggerApi, method, ...params)
  try {
    await assert.rejects(manager.setViewport(originalId, 'phone'), /Fixture native touch rejection/)
    assert.equal((await manager.create(originalId, baseline.url, workspaceId)).viewport, 'responsive')
    await identity('phone-rejection-keeps-original-responsive-page')
  } finally { debuggerApi.sendCommand = sendCommand }
}

async function run() {
  const stage = async (value: string) => {
    receipt.stages ??= []; receipt.stages.push(value)
    await writeFile(join(out, label + '.progress.json'), JSON.stringify({ stage: value }))
  }
  await stage('module-loaded')
  await app.whenReady()
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular')
    await app.dock!.show()
  }
  await stage('electron-ready')
  receipt.compiled = Object.fromEntries(await Promise.all(['main.mjs', 'renderer.js', 'renderer.css', 'preload.cjs'].map(async name => [name, sha(await readFile(join(root, name)))])))
  server = createServer((request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html(request.url !== '/no-meta', request.url === '/sibling')) })
  const saved = restart ? JSON.parse(await readFile(join(root, 'saved-browser.json'), 'utf8')) : null
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(saved ? Number(new URL(saved.url).port) : 0, '127.0.0.1', resolve)
  })
  baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  ipcMain.on('ui:themeBootstrap', event => { event.returnValue = null })
  window = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, backgroundColor: '#171d24', webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  for (const event of ['focus', 'blur'] as const) window.on(event, () => receipt.windowFocus.push({ event,
    at: performance.now(), transition: receipt.transitions.length, focused: window.isFocused() }))
  window.webContents.on('console-message', event => { if (event.level === 'error') receipt.warnings.push({ kind: 'renderer', message: event.message }) })
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'private-viewport-profile', resolvePartition: () => 'persist:private-viewport-profile' }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Private viewport fixture cannot open system links') } })
  overlays = new NativeOverlaySurfaces(window, manager, message => { receipt.warnings.push({ kind: 'native-overlay', message }); window.webContents.send(NATIVE_OVERLAY_WARNING_CHANNEL, message) }, input => window.webContents.send(NATIVE_BROWSER_INPUT_CHANNEL, input))
  uninstallNativeOverlayFocus = installNativeOverlayFocus(window, overlays)
  manager.onNativeVisibilityChange = visibility => window.webContents.send(NATIVE_BROWSER_VISIBILITY_CHANNEL, visibility)
  manager.onNativeInput = (owner, input) => overlays.forwardBrowserInput(owner, input)
  if (saved) {
    await window.loadURL('about:blank')
    window.showInactive()
    await stage('restart-chrome-ready')
    const graph = parseAgentMuxSpatialGraph(saved.graph)
    await stage('restart-graph-parsed')
    const restored = await manager.ensure(originalId, async () => browserColdDescriptor(graph, originalId), { workspaceId })
    await stage('restart-original-owner-ensured')
    manager.setBounds(originalId, { x: 20, y: 110, width: 900, height: 590 })
    original = manager.nativeOwner(originalId)!.view
    const metrics = await until('phone viewport reapplies on the restored native page', async () => {
      if (original.webContents.isLoading()) return null
      const facts = await original.webContents.executeJavaScript('window.viewportFacts?.()')
      return facts?.touchPoints === 5 && facts.dpr === 3 ? facts : null
    })
    assert.equal(restored.id, originalId)
    assert.equal(restored.url, saved.url)
    assert.equal(restored.profileId, saved.profileId)
    assert.ok(browserViewportsEqual(restored.viewport, saved.viewport))
    assert.equal(metrics.dpr, 3)
    assert.equal(metrics.touchPoints, 5)
    assert.deepEqual(metrics.screen, { width: 844, height: 390 })
    assert.equal(metrics.portrait, false)
    assert.equal(await original.webContents.executeJavaScript('document.cookie'), 'viewportRestore=original-profile')
    assert.notEqual(process.pid, saved.pid)
    receipt.restart = { originalPid: saved.pid, graph: { tabId: graph.tabs[0]?.tabId, regionId: graph.regions[0]?.regionId }, restored, metrics }
    receipt.passed = true
    return
  }
  window.showInactive()
  await manager.create(originalId, baseUrl + '/meta', workspaceId); await manager.create(siblingId, baseUrl + '/sibling', workspaceId)
  manager.setBounds(originalId, { x: 20, y: 110, width: 900, height: 590 }); manager.setBounds(siblingId, { x: 930, y: 80, width: 240, height: 600 })
  original = manager.nativeOwner(originalId)!.view; sibling = manager.nativeOwner(siblingId)!.view
  await stage('native-pages-created')
  await until('both original native pages ready', async () => !original.webContents.isLoading() && !sibling.webContents.isLoading() && await pageFacts())
  baseline = { ...await manager.create(originalId, baseUrl + '/meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  siblingBaseline = { ...await manager.create(siblingId, baseUrl + '/sibling', workspaceId), zoom: sibling.webContents.getZoomFactor() }
  ipcMain.handle('viewport:setup', () => ({ original: baseline }))
  const handle = (channel: string, action: (...args: any[]) => any) => ipcMain.handle(channel, (event, ...args) => {
    assert.equal(event.sender, window.webContents); receipt.calls.push({ channel, args }); return action(...args)
  })
  handle('browser:readProfiles', () => ipcResult(() => ({ revision: 1, sequence: 1, folders: [], views: [],
    profiles: [{ id: baseline.profileId, label: 'Fixture profile', isDefault: true, agentAccess: true }] })))
  handle('browser:setViewport', (id, mode) => manager.setViewport(id, mode))
  handle('browser:setBounds', (id, bounds) => manager.setBounds(id, bounds))
  handle('browser:cancelElementSelection', id => manager.cancelElementSelection(id))
  handle('browser:setAnnotationMarkers', (id, navigationId, marks) => manager.setAnnotationMarkers(id, navigationId, marks))
  handle('browser:listInputHistory', () => ({ entries: [] }))
  handle('browser:release', id => manager.release(id))
  handle('browser:restore', (id, input) => manager.restore(id, input))
  handle('ui:nativeBrowserVisibility', () => manager.nativeBrowserVisibility())
  handle('ui:publishNativeOverlays', async regions => {
    const publication: any = { sequence: receipt.publications.length + 1, regions }
    receipt.publications.push(publication)
    publication.result = await overlays.update(regions)
    return publication.result
  })
  const spatial = parseAgentMuxSpatialGraph({ spaces: [], zones: [{ zoneId: 'viewport-zone', workspaceId, kind: 'directory', hostId: 'local', directoryPath: root, branch: null }],
    tabs: [{ tabId: 'viewport-tab', zoneId: 'viewport-zone', workspaceId, name: null, regionIds: ['private-viewport-region'] }],
    regions: [{ regionId: 'private-viewport-region', tabId: 'viewport-tab', kind: 'browser', agentSessionId: null, runId: null, execution: null }], bindings: [],
    layouts: { [workspaceId]: createWorkspaceLayout('viewport-group', ['viewport-tab']) }, tabLayouts: { 'viewport-tab': { root: { type: 'leaf', regionId: 'private-viewport-region' }, activeRegionId: 'private-viewport-region' } }, resources: { 'viewport-tab': { browserId: originalId } } })
  rpcServer = new AgentMuxControlServer({ coreClients: () => [], execute: async request => {
    if (request.operation === 'browser.targets') return { operation: 'browser.targets', coverage: 'complete', targets: manager.targets() }
    if (request.operation === 'space.inspect') return { operation: 'space.inspect', catalog: spatialCatalog(spatial, request.target as any) }
    assert.equal(request.operation, 'browser.run'); if (request.operation !== 'browser.run') throw new Error('Outside the bounded viewport public fixture')
    const result = await manager.runScript(request.browserId, request.code, undefined, undefined, request.operationId)
    return { operation: 'browser.run', ...result }
  } }, join(root, 'control.sock')); await rpcServer.start()
  await window.loadFile(join(root, 'index.html')); window.show(); window.webContents.focus(); window.webContents.debugger.attach('1.3')
  await until('mounted original product Viewport button', async () => evaluate('!!document.querySelector("button[aria-label=Viewport]")'))
  chromeReady = true
  await settle()
  await stage('original-renderer-ready')
  if (!preflight) {
    receipt.discovery = { targets: await cli(['browser', 'targets']), space: await cli(['space', 'inspect', '--zone', 'viewport-zone']) }
    assert.ok(receipt.discovery.targets.result.result.targets.some((row: any) => row.id === originalId))
    assert.equal(receipt.discovery.space.result.result.catalog.regions[0].regionId, 'private-viewport-region')
  }
  if (deviceOnly) {
    await verifyPhone(spatial)
    assert.deepEqual((await uiFacts()).errors, [])
    assert.deepEqual(receipt.warnings, [])
    receipt.passed = true
    return
  }
  for (const page of ['meta', 'no-meta']) {
    if (page === 'no-meta') { await manager.navigate(originalId, baseUrl + '/no-meta'); await until('second generic document ready', async () => !original.webContents.isLoading() && (await pageFacts()).hasMeta === false) }
    baseline = { ...await manager.create(originalId, baseUrl + '/' + page, workspaceId), zoom: original.webContents.getZoomFactor() }
    await returnChoices(page)
    if (preflight) continue
    for (const mode of ['mobile', 'tablet', 'desktop', 'responsive'] as BrowserViewport[]) {
      await resize(900, 650); await choose(mode); await observe(page + '-wide-' + mode, mode, true)
      await publicRead(page + '-' + mode, mode === 'mobile' || mode === 'desktop')
      await resize(650, 510); await observe(page + '-resized-' + mode, mode)
    }
    await resize(330, 620); await choose('desktop', true); await observe(page + '-narrow-desktop', 'desktop', true)
    await choose('responsive', true); await observe(page + '-narrow-responsive', 'responsive')
  }
  await resize(900, 650); await ordinaryWindowBlur()
  if (preflight) { receipt.events = (await uiFacts()).events; assert.deepEqual((await uiFacts()).errors, []); assert.deepEqual(receipt.warnings, []); receipt.passed = true; return }
  await verifyPhone(spatial)
  await manager.navigate(originalId, baseUrl + '/no-meta')
  await until('original second document ready', async () => !original.webContents.isLoading() && !(await pageFacts()).hasMeta)
  baseline = { ...await manager.create(originalId, baseUrl + '/no-meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  await choose('tablet')
  const beforeReload = baseline.navigationId
  await manager.reload(originalId); await until('actual reload applies the retained viewport', async () => !original.webContents.isLoading() && (await pageFacts()).innerWidth > 0)
  baseline = { ...await manager.create(originalId, baseUrl + '/no-meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  assert.notEqual(baseline.navigationId, beforeReload); await observe('reload-retains-tablet', 'tablet')
  await evaluate('window.viewportProbe.released(true)')
  await until('original client releases its native owner', async () => !original.webContents || original.webContents.isDestroyed())
  await evaluate('window.viewportProbe.released(false)')
  await until('original client restores the logical Browser', async () => manager.nativeOwner(originalId)?.view && !manager.nativeOwner(originalId)!.view.webContents.isLoading())
  const oldView = original; original = manager.nativeOwner(originalId)!.view
  assert.notEqual(original, oldView)
  baseline = { ...await manager.create(originalId, baseUrl + '/no-meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  await settle(); assert.equal(baseline.viewport, 'tablet'); await observe('restore-retains-logical-browser-profile-and-mode', 'tablet')
  receipt.events = (await uiFacts()).events; assert.deepEqual((await uiFacts()).errors, []); assert.deepEqual(receipt.warnings, [])
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  if (chromeReady && window && !window.isDestroyed()) {
    try { receipt.failure.windowFocused = window.isFocused(); receipt.failure.ui = await uiFacts(); receipt.failure.menus = await evaluate(`[...document.querySelectorAll('[role=menu]')].map(e=>({state:e.getAttribute('data-state'),children:[...e.querySelectorAll('[role=menuitem],[role=menuitemradio]')].map(n=>({name:n.textContent.trim(),popup:n.getAttribute('aria-haspopup'),expanded:n.getAttribute('aria-expanded')}))}))`); receipt.failure.layers = window.contentView.children.filter(view => view.getVisible()).map(view => ({ bounds: view.getBounds(), original: view === original, sibling: view === sibling })) } catch {}
  }
}).finally(async () => {
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  if (chromeReady && window && !window.isDestroyed()) { await evaluate('window.viewportProbe?.dispose()').catch(() => {}); await delay(40) }
  await rpcServer?.stop(); uninstallNativeOverlayFocus?.(); overlays?.dispose(); manager?.dispose(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  if (window && !window.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
