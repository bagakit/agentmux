import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { writeFile, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import type { NativeOverlayRegion } from '../../../src/shared/native-overlay'
import { createAvatarLayeringSeed } from './avatar-seed'

const root = process.env.AGENTMUX_UI_LAYERING_ROOT!, html = process.env.AGENTMUX_UI_LAYERING_HTML!
app.setPath('userData', join(root, 'user-data')); app.setPath('sessionData', join(root, 'session-data'))
app.on('window-all-closed', () => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const exec = promisify(execFile)
const withoutSystemFullscreen = process.env.AGENTMUX_UI_LAYERING_WITHOUT_SYSTEM_FULLSCREEN === '1'
const qaScope = process.env.AGENTMUX_UI_LAYERING_MOBILE_ONLY === '1' ? 'mobile-only' : process.env.AGENTMUX_UI_LAYERING_FULLSCREEN_ONLY === '1' ? 'system-fullscreen-only'
  : withoutSystemFullscreen ? 'partial-without-system-fullscreen' : 'complete'
const receipt: any = { passed: false, availableChecksPassed: false, completeGate: false, scope: qaScope,
  uncovered: [...(withoutSystemFullscreen ? ['native-system-fullscreen'] : []),
    ...(qaScope === 'mobile-only' ? ['desktop-native-window-matrix'] : qaScope === 'system-fullscreen-only' ? ['desktop-native-mobile-matrix'] : []),
    ...(!process.env.AGENTMUX_VISUAL_ORCA_CLI ? ['OS-composition'] : [])],
  ...(withoutSystemFullscreen ? { systemFullscreen: { status: 'not-requested', reason: 'explicit-without-system-fullscreen', includedInCompleteGate: false } } : {}),
  cases: [], publications: [], frames: [], chromeFrames: [], osFrames: [], warnings: [], userRunTouched: false }
function failureDetails(error: unknown) {
  const value = error as { name?: unknown; message?: unknown; stack?: unknown } | null
  return { name: typeof value?.name === 'string' ? value.name : typeof error,
    message: typeof value?.message === 'string' && value.message ? value.message : String(error),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}) }
}
function finishAvailableChecks() {
  receipt.availableChecksPassed = true
  if (!receipt.osFrames.length && !receipt.uncovered.includes('OS-composition')) receipt.uncovered.push('OS-composition')
  receipt.completeGate = qaScope === 'complete' && receipt.uncovered.length === 0
  receipt.passed = receipt.completeGate
}
let window: BrowserWindow, page: WebContentsView, overlays: NativeOverlaySurfaces, browsers: BrowserViewManager, pageServer: Server
let revision = 0, publishing = 0, last: any, fault: 'none' | 'content' | 'hold' | 'attachment' = 'none'
let held = false, release: (() => void) | undefined, captureFaults = 0
let failedAccessoryId: string | undefined
const pageBounds = { x: 0, y: 56, width: 1, height: 1 }
const pageId = 'layering-original-browser'
const independentWindows = new Map<number, { window: BrowserWindow; page: WebContentsView; browsers: BrowserViewManager; overlays: NativeOverlaySurfaces; bounds: typeof pageBounds; revision: number; last?: any; publishing: number; publications: any[] }>()
const read = (source: string) => window.webContents.executeJavaScript(source)
const facts = () => read('layeringProbe.read()')
const visibleNativeBounds = (target: BrowserWindow, view: WebContentsView) => target.contentView.children.includes(view) && view.getVisible() && !view.webContents.isDestroyed() ? [view.getBounds()] : []
const owners = (target = window, nativePage = page) => {
  const browserOwner = target === window ? browsers?.nativeOwner(pageId) : [...independentWindows.values()].find(entry => entry.window === target)?.browsers.nativeOwner('independent-original-browser')
  return target.contentView.children.filter(view => 'webContents' in view).map((view: any) => ({ id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds(), page: view === nativePage, inputBarrier: view === browserOwner?.inputShield }))
}
const positive = (target = window, nativePage = page) => owners(target, nativePage).filter(owner => !owner.page && !owner.inputBarrier && owner.visible && owner.bounds.x >= 0 && owner.bounds.y >= 0 && owner.bounds.width > 0 && owner.bounds.height > 0)
const nativeProjections = (manager = overlays) => (manager as unknown as { projections: Map<string, { view: WebContentsView; region: NativeOverlayRegion }> }).projections
const atPoint = (bounds: any, point: any) => point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
const topAt = (point: any) => [...window.contentView.children].reverse().find(view => view.getVisible() && atPoint(view.getBounds(), point)) as WebContentsView | undefined
async function wait(test: () => Promise<any> | any, message: string) {
  const end = Date.now() + 10000
  while (Date.now() < end) { if (await test()) return; await delay(25) }
  receipt.waitState = { owners: owners(), last, facts: await facts().catch(() => null) }; assert.fail(message)
}
async function painted() { await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(120) }
function visibility() {
  const value = { revision: ++revision, zoomFactor: window.webContents.getZoomFactor(), bounds: visibleNativeBounds(window, page) }
  receipt.nativeVisibility ??= []
  receipt.nativeVisibility.push({ ...value, pageVisible: page.getVisible(), browserId: page.webContents.id, windowId: window.id })
  return value
}
async function setNativePageVisible(visible: boolean) {
  const publicationsBefore = receipt.publications.length
  browsers.setBounds(pageId, visible ? pageBounds : null)
  const demand = visibility(); window.webContents.send('layering:visibility', demand)
  await wait(() => receipt.publications.length > publicationsBefore && publishing === 0 &&
    (visible || last?.projected === 0 && positive().length === 0), 'Actual Browser visibility must reach its original Renderer and native projection owner')
  return { demand, pageVisible: page.getVisible(), publicationsBefore, publicationsAfter: receipt.publications.length, last }
}
function layout() {
  const { width, height } = window.getContentBounds()
  Object.assign(pageBounds, { x: Math.floor(width * .48), y: 56, width: width - Math.floor(width * .48), height: height - 56 })
  browsers.setBounds(pageId, pageBounds)
  window.webContents.send('layering:visibility', visibility())
}
async function nativeReady() {
  await wait(() => publishing === 0 && last && last.projected >= 2 && positive().length === last.projected,
    'The matching original modal publication must finish native paint')
}
async function nativeModalClosed() {
  await wait(async () => {
    const publication = receipt.publications.at(-1)
    if (publishing !== 0 || !last || !publication || positive().length !== last.projected ||
      publication.regions.some((region: NativeOverlayRegion) => region.modal) || [...nativeProjections().values()].some(projection => projection.region.modal)) return false
    return await read(`!document.querySelector('[data-overlay-modal-scope]:not([hidden]) [data-overlay-modal-part="content"][data-state="open"]')`)
  }, 'The original modal DOM and exact native scrim/content projections must retire while unrelated Chrome remains available')
  receipt.modalClosures ??= []
  receipt.modalClosures.push({ publication: receipt.publications.length - 1, last, remainingOwners: owners(), remainingDOM: (await facts()).nodes })
}
async function point(selector: string, text?: string) {
  const target = await read(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})],node=nodes.find(node=>${text === undefined ? 'true' : `node.textContent.trim()===${JSON.stringify(text)}`});if(node){const r=node.getBoundingClientRect();return{point:{x:r.x+r.width/2,y:r.y+r.height/2}}}const describe=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return{tag:node.tagName,id:node.id,role:node.getAttribute('role'),state:node.getAttribute('data-state'),text:node.textContent,innerText:node.innerText,ariaLabel:node.getAttribute('aria-label'),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,visibility:s.visibility,html:node.outerHTML.slice(0,2400)}};return{point:null,candidates:nodes.map(describe),menus:[...document.querySelectorAll('[role="menu"]')].map(describe),invokers:[...document.querySelectorAll('[data-pmo-teams-topic-launcher] button')].map(describe)}})()`)
  if (!target.point) {
    receipt.targetFailures ??= []; receipt.targetFailures.push({ selector, expectedText: text, ...target })
    throw new Error('Actual target missing: ' + JSON.stringify({ selector, expectedText: text }))
  }
  const cssPoint = target.point
  const zoom = window.webContents.getZoomFactor()
  return { x: Math.round(cssPoint.x * zoom), y: Math.round(cssPoint.y * zoom) }
}
async function click(selector: string, text?: string, native = false) {
  const p = await point(selector, text)
  if (native) {
    const owner = topAt(p)
    assert.ok(owner && owner !== page, 'The original modal is the top native hit owner above the Browser')
    const bounds = owner.getBounds()
    for (const type of ['mouseDown', 'mouseUp'] as const) owner.webContents.sendInputEvent({ type, x: p.x - bounds.x, y: p.y - bounds.y, button: 'left', clickCount: 1 })
    receipt.nativeClicks ??= []; receipt.nativeClicks.push({ selector, text, point: p, owner: owner.webContents.id })
  } else {
    const zoom = window.webContents.getZoomFactor()
    for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: p.x / zoom, y: p.y / zoom, button: 'left', clickCount: 1 })
  }
  await painted()
}
async function key(key: string, virtual: number) {
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: virtual, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) })
  await painted()
}
async function chromeFrames(label: string, target: BrowserWindow) {
  const manager = target === window ? overlays : [...independentWindows.values()].find(entry => entry.window === target)?.overlays
  assert.ok(manager, 'The exact captured Window must retain its original native overlay manager')
  // This isolated fixture reads the sole existing owner, rather than inferring a
  // projection from DOM, colours or the last publication's similar rectangles.
  const projections = (manager as unknown as { projections: Map<string, { view: WebContentsView; region: NativeOverlayRegion }> }).projections
  const result: any[] = []
  for (const [regionId, projection] of projections) {
    const view = projection.view, bounds = view.getBounds()
    if (!target.contentView.children.includes(view) || !view.getVisible() || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0) continue
    const identity = () => ({ regionId, webContentsId: view.webContents.id, windowId: target.id,
      ownerWindowId: BrowserWindow.fromWebContents(view.webContents)?.id, visible: view.getVisible(), bounds: view.getBounds(), region: structuredClone(projection.region) })
    const before = identity()
    assert.equal(before.ownerWindowId, target.id, 'Chrome compositor readback belongs to the exact attached Window')
    const pixels = await view.webContents.capturePage()
    assert.equal(pixels.isEmpty(), false, 'The actual native Chrome compositor must return a nonempty image')
    const size = pixels.getSize(), bitmap = pixels.toBitmap(), png = pixels.toPNG()
    assert.ok(size.width > 0 && size.height > 0 && bitmap.length > 0 && bitmap.length % 4 === 0)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    let paintedPixels = 0, opaquePixels = 0, minimumAlpha = 255, maximumAlpha = 0
    for (let offset = 3; offset < bitmap.length; offset += 4) {
      const alpha = bitmap[offset]!
      if (alpha > 0) paintedPixels++
      if (alpha === 255) opaquePixels++
      minimumAlpha = Math.min(minimumAlpha, alpha); maximumAlpha = Math.max(maximumAlpha, alpha)
    }
    // A scrim is an SVG of only uncovered Browser pixels. Its authoritative
    // declaration may legitimately yield a fully transparent compositor image.
    const scrim = projection.region.scrim !== undefined
    if (!scrim) assert.ok(paintedPixels > 0, 'The actual native Chrome content compositor must contain painted pixels')
    assert.equal(projections.get(regionId), projection, 'Readback must retain the original physical projection owner')
    assert.equal(target.contentView.children.includes(view), true)
    const after = identity(); assert.deepEqual(after, before, 'Compositor readback preserves the original owner, geometry and declaration')
    const file = `${label}-chrome-${view.webContents.id}-${projection.region.modal?.part ?? 'accessory'}.png`
    await writeFile(join(root, file), png)
    const captured = { label, file, before, after, size, scaleFactors: pixels.getScaleFactors(), sha256: createHash('sha256').update(png).digest('hex'),
      bitmapSHA256: createHash('sha256').update(bitmap).digest('hex'), bitmapBytes: bitmap.length, pixelCount: bitmap.length / 4, paintedPixels, opaquePixels, minimumAlpha, maximumAlpha,
      scrim, scope: 'Actual original Chrome WebContents compositor readback. capturePage may request a frame; this proves readable pixels, not first presentation or host-window OS composition.' }
    result.push(captured); receipt.chromeFrames.push(captured)
  }
  return result
}
async function frame(label: string, target = window, nativePage: WebContentsView | null = page) {
  await painted()
  const renderer = label + '-renderer.png', native = label + '-native-page.png'
  await writeFile(join(root, renderer), (await target.webContents.capturePage()).toPNG())
  if (nativePage) await writeFile(join(root, native), (await nativePage.webContents.capturePage()).toPNG())
  const chrome = await chromeFrames(label, target)
  if (nativePage && !nativePage.getVisible()) assert.equal(chrome.length, 0, 'A hidden original Browser must not retain native Chrome projections for document-only scenarios')
  receipt.frames.push({ label, renderer, ...(nativePage ? { native } : {}), chrome, owners: owners(target, nativePage ?? page),
    nativeDemand: { ...(nativePage ? { pageVisible: nativePage.getVisible(), bounds: visibleNativeBounds(target, nativePage) } : { bounds: [] }), ...(target === window ? { sourceRevision: revision } : {}) },
    fact: await target.webContents.executeJavaScript('layeringProbe.read()'), scope: nativePage ? 'Independent actual Renderer, native page and original Chrome compositor readbacks; never an OS composition.' : 'Actual Mobile browser Renderer. Original Desktop native page is retained hidden; never an OS composition.' })
  if (process.env.AGENTMUX_VISUAL_ORCA_CLI && !receipt.osCaptureFailure) {
    const cli = process.env.AGENTMUX_VISUAL_ORCA_CLI, appSelector = `pid:${process.pid}`
    const call = async (args: string[]) => {
      let stdout: string
      try { ({ stdout } = await exec(cli, ['computer', ...args, '--json'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 })) }
      catch (error: any) {
        const failure = { label, command: [cli, 'computer', ...args, '--json'], message: error.message, stdout: error.stdout, stderr: error.stderr }
        receipt.osCaptureFailure = failure; await writeFile(join(root, label + '-os-capture-failure.json'), JSON.stringify(failure, null, 2)); throw error
      }
      const result = JSON.parse(stdout); assert.equal(result.ok, true, stdout); return result
    }
    const listed = await call(['list-windows', '--app', appSelector])
    await writeFile(join(root, label + '-os-list.json'), JSON.stringify(listed, null, 2))
    const candidates = listed.result.windows.filter((entry: any) => entry.app.pid === process.pid && !entry.isMinimized && !entry.isOffscreen)
    const selected = candidates.find((entry: any) => entry.title === target.getTitle()) ?? (candidates.length === 1 ? candidates[0] : undefined)
    assert.ok(selected, 'The exact private PID must expose an on-screen native window')
    const before = owners(target, nativePage ?? page), captured = await call(['get-app-state', '--app', appSelector, '--window-id', String(selected.id)])
    assert.equal(captured.result.snapshot.app.pid, process.pid)
    assert.equal(captured.result.snapshot.window.id, selected.id)
    assert.equal(captured.result.screenshotStatus.state, 'captured', JSON.stringify(captured.result.screenshotStatus))
    const screenshot = captured.result.screenshot, bytes = screenshot.path ? await readFile(screenshot.path) : Buffer.from(screenshot.data, 'base64')
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const file = label + '-os-window.png', metadata = label + '-os-window.json'
    await writeFile(join(root, file), bytes)
    assert.deepEqual(owners(target, nativePage ?? page), before, 'Read-only OS capture preserves the original native owners')
    await writeFile(join(root, metadata), JSON.stringify({ api: 'orca computer get-app-state', pid: process.pid, selected, listed, captured: { ...captured, result: { ...captured.result, screenshot: { ...screenshot, data: undefined } } }, before, after: owners(target, nativePage ?? page) }, null, 2))
    receipt.osFrames.push({ label, file, metadata, pid: process.pid, windowId: selected.id, sha256: createHash('sha256').update(bytes).digest('hex'), scope: 'Actual OS window, no composite' })
  }
  if (process.env.AGENTMUX_UI_LAYERING_REVIEW_HOLD?.split(',').includes(label)) {
    const releaseFile = join(root, 'review-release-' + label + '.json'), before = owners(target, nativePage ?? page)
    const handoff = { label, pid: process.pid, windowId: target.id, title: target.getTitle(), bounds: target.getBounds(),
      sourceIdentityFile: join(root, 'inputs.json'), before, releaseFile }
    receipt.reviewHolds ??= []; receipt.reviewHolds.push(handoff)
    await writeFile(join(root, 'review-hold.json'), JSON.stringify(handoff, null, 2))
    const deadline = Date.now() + 60000
    let released = false
    while (Date.now() < deadline) {
      const acknowledgement = await readFile(releaseFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (acknowledgement !== null) {
        const original = JSON.parse(acknowledgement)
        assert.equal(original.label, label); assert.equal(original.windowId, target.id)
        released = true; break
      }
      await delay(50)
    }
    assert.ok(released, 'The exact private OS review hold requires its original acknowledgement')
    assert.deepEqual(owners(target, nativePage ?? page), before, 'Independent OS image review preserves the original native owner objects')
  }
}
async function openStop(seed = true) {
  if (seed) await read('layeringProbe.seed()')
  await wait(() => read('!!document.querySelector(".workbench-tab__close")'), 'Actual Workbench close control must exist')
  await painted()
  await click('[data-workbench-tab-id="result-input-tab"] .workbench-tab__close')
  await wait(() => read('document.querySelector(".confirmation-dialog__title")?.textContent === "Stop Agent Session?" || !!document.querySelector(".modal-presentation-note")'), 'Actual Workbench must open or retain the Stop confirmation request')
}
async function assertModal(label: string) {
  await nativeReady(); const value = await facts(), modal = value.nodes.filter((node: any) => node.part)
  assert.equal(modal.filter((node: any) => node.part === 'scrim').length, 1, 'One original modal scrim is required')
  assert.equal(modal.filter((node: any) => node.part === 'content').length, 1, 'One original modal content is required')
  const content = modal.find((node: any) => node.part === 'content'), scrim = modal.find((node: any) => node.part === 'scrim')
  assert.equal(content.modal, scrim.modal, 'Content and scrim share their authoritative original modal identity')
  assert.equal(content.hit, true, 'Original Stop content must be above its own DOM scrim')
  const p = await point('.confirmation-dialog button', 'Stop & Close'), owner = topAt(p)
  assert.ok(owner && owner !== page, 'Stop content must remain above the native Browser')
  const layer = owners().find(item => item.id === owner.webContents.id)!
  assert.ok(layer.bounds.width < window.getContentBounds().width, 'The foreground hit owner must be the content, not a window scrim')
  assert.equal(await read('document.activeElement.textContent'), 'Cancel', 'The actual destructive confirmation initially focuses Cancel')
  const viewport = await read('({width:innerWidth,height:innerHeight})')
  assert.ok(content.bounds.x >= 0 && content.bounds.y >= 0 && content.bounds.x + content.bounds.width <= viewport.width + 1 && content.bounds.y + content.bounds.height <= viewport.height + 1, 'Stop confirmation fits the actual window and zoom')
  receipt.cases.push({ label, modal, viewport, owners: owners() })
}
async function verifySystemFullscreen() {
  assert.equal(process.platform, 'darwin', 'This scenario must observe the actual macOS system fullscreen transition')
  assert.equal(window.isSimpleFullScreen(), false, 'Simple fullscreen is not a system fullscreen receipt')
  await openStop(); await nativeReady()
  const before = { windowBounds: window.getBounds(), contentBounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor(),
    capabilities: { fullscreenable: window.isFullScreenable(), visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), simpleFullscreen: window.isSimpleFullScreen() },
    modalId: await read('document.querySelector("[data-overlay-modal-scope]").id'), workbench: (await facts()).workbench,
    browser: { id: page.webContents.id, url: page.webContents.getURL(), bounds: page.getBounds(), input: await page.webContents.executeJavaScript('document.querySelector("input").value') } }
  const proof: any = receipt.systemFullscreen = { status: 'requested', windowId: window.id, before, events: [], observations: [], nativeInput: [] }
  assert.equal(before.capabilities.fullscreenable, true, 'The exact private native window must expose system fullscreen capability')
  assert.equal(before.capabilities.visible, true, 'The exact private native window must remain visible for system fullscreen')
  const enter = () => proof.events.push({ event: 'enter-full-screen', observedAt: Date.now(), fullscreen: window.isFullScreen(), bounds: window.getBounds(), contentBounds: window.getContentBounds() })
  const leave = () => proof.events.push({ event: 'leave-full-screen', observedAt: Date.now(), fullscreen: window.isFullScreen(), bounds: window.getBounds(), contentBounds: window.getContentBounds() })
  window.on('enter-full-screen', enter); window.on('leave-full-screen', leave)
  const stable = async (fullscreen: boolean, expected?: typeof before.windowBounds) => {
    let prior = '', since = Date.now()
    await wait(() => {
      const observation = { observedAt: Date.now(), fullscreen: window.isFullScreen(), bounds: window.getBounds(), contentBounds: window.getContentBounds() }
      proof.observations.push(observation)
      const signature = JSON.stringify({ fullscreen: observation.fullscreen, bounds: observation.bounds, contentBounds: observation.contentBounds })
      if (signature !== prior) { prior = signature; since = Date.now() }
      return observation.fullscreen === fullscreen && Date.now() - since >= 240 &&
        (!expected || JSON.stringify(observation.bounds) === JSON.stringify(expected))
    }, fullscreen ? 'macOS must enter actual system fullscreen with stable new bounds' : 'macOS must restore the exact original window bounds after system fullscreen')
  }
  const retained = async () => {
    assert.equal(await read('document.querySelector("[data-overlay-modal-scope]").id'), before.modalId, 'System fullscreen keeps the original modal attempt and request')
    assert.equal(window.webContents.getZoomFactor(), before.zoom, 'System fullscreen keeps the original document zoom')
    assert.equal(page.webContents.id, before.browser.id, 'System fullscreen keeps the original native Browser owner')
    assert.equal(page.webContents.getURL(), before.browser.url, 'System fullscreen keeps the original Browser history identity')
    assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), before.browser.input, 'System fullscreen keeps the original Browser draft')
    const current = (await facts()).workbench
    for (const key of ['sessions', 'drafts', 'tabs', 'layout', 'stops', 'writes', 'pastes']) assert.deepEqual(current[key], before.workbench[key], 'System fullscreen preserves original ' + key)
  }
  const nativeTab = async (shift = false) => {
    const p = await point('.confirmation-dialog__cancel'), owner = topAt(p)
    assert.ok(owner && owner !== page, 'System fullscreen keeps the original modal as native keyboard input owner')
    for (const type of ['keyDown', 'keyUp'] as const) owner.webContents.sendInputEvent({ type, keyCode: 'Tab', modifiers: shift ? ['shift'] : [] })
    await painted()
    const focused = await read('document.activeElement?.textContent')
    proof.nativeInput.push({ ownerId: owner.webContents.id, shift, focused })
    assert.equal(focused, shift ? 'Cancel' : 'Keep Session & Close', 'System fullscreen native keyboard input reaches the same original modal focus scope')
  }
  try {
    proof.enterRequestedAt = Date.now(); window.setFullScreen(true)
    await wait(() => proof.events.some((event: any) => event.event === 'enter-full-screen') && window.isFullScreen(), 'macOS must confirm enter-full-screen on this exact private window')
    await stable(true); layout(); await painted(); await assertModal('system-fullscreen-enter')
    assert.notDeepEqual(window.getContentBounds(), before.contentBounds, 'System fullscreen must observe new actual native content geometry')
    await retained(); await nativeTab(); await nativeTab(true); await retained(); await frame('system-fullscreen-enter')
    proof.leaveRequestedAt = Date.now(); window.setFullScreen(false)
    await wait(() => proof.events.some((event: any) => event.event === 'leave-full-screen') && !window.isFullScreen(), 'macOS must confirm leave-full-screen on this exact private window')
    await stable(false, before.windowBounds); layout(); await painted(); await assertModal('system-fullscreen-restored')
    assert.deepEqual(window.getContentBounds(), before.contentBounds, 'System fullscreen restores the original content geometry')
    assert.deepEqual(page.getBounds(), before.browser.bounds, 'System fullscreen restores the original Browser attachment bounds')
    await retained(); await nativeTab(); await nativeTab(true); await retained(); await frame('system-fullscreen-restored')
    proof.status = 'complete'; proof.after = { bounds: window.getBounds(), contentBounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor(), owners: owners() }
    receipt.cases.push({ label: 'system-fullscreen-preserves-original-input-and-draft', proof })
    await key('Escape', 27); await nativeModalClosed()
  } catch (error: any) {
    proof.status = 'unconfirmed'; proof.failure = { message: error.message, fullscreen: window.isFullScreen(), simpleFullscreen: window.isSimpleFullScreen(), bounds: window.getBounds() }
    throw error
  } finally {
    if (window.isFullScreen()) {
      window.setFullScreen(false)
      try { await wait(() => !window.isFullScreen(), 'The private fixture must leave system fullscreen during cleanup') }
      catch (error: any) { proof.cleanupFailure = error.message }
    }
    window.off('enter-full-screen', enter); window.off('leave-full-screen', leave)
  }
}
async function verifyCrossDocumentWorkbench() {
  const probe = 'layeringProbe.crossDocument', samples: any[] = []
  let primaryFailed = false
  const value = () => read(probe + '.read()')
  const stage = async (step: string, source?: string, state?: unknown) => appendFile(join(root, 'cross-document-progress.jsonl'), JSON.stringify({ at: Date.now(), step, source, state,
    native: { pageVisible: page.getVisible(), sourceRevision: revision, bounds: visibleNativeBounds(window, page), publishing, last, owners: owners(), publication: receipt.publications.at(-1) } }) + '\n')
  const act = async (source: string) => {
    await stage('operation-start', source); await read(probe + '.' + source); await stage('operation-returned', source)
    await painted(); const state = await value(); await stage('painted', source, state); return state
  }
  const assertRetained = (state: any, destination: 'A' | 'B') => {
    for (const fact of ['sameHost', 'sameEditor', 'sameForm', 'sameContent', 'sameIdentity', 'frameSameDocument']) assert.equal(state[fact], true, 'Actual cross-document placement retains the original ' + fact)
    assert.equal(state.hostDocument, destination, 'The actual retained Workbench host moves into the exact document')
    assert.equal(state.members.moving.document, destination, 'Committed product document context follows the original host')
    assert.equal(state.modal, state.retainedModal, 'The original modal request identity survives the actual Workbench placement')
    assert.equal(state.editorText, 'Original cross-document unsent draft')
    assert.equal(state.members.moving.draft, 'Original cross-document unsent draft', 'The original form component keeps its local React draft state')
    assert.equal(state.members.moving.cancels, 0, 'Cross-document presentation must not invoke business cancellation')
    assert.equal(state.members.moving.confirms, 0)
    const previous = destination === 'A' ? 'B' : 'A'
    assert.equal(state.documents[previous].liveModals.length, 0, 'The departed document has no live original modal')
    assert.notEqual(state.documents[previous].pointerEvents, 'none', 'The departed document releases its own background input lock')
    assert.equal(state.documents[destination].liveModals.length, 1)
    assert.equal(state.documents[destination].pointerEvents, 'none')
  }
  receipt.crossDocumentNativeDemand = {}
  try {
    receipt.crossDocumentNativeDemand.hidden = await setNativePageVisible(false)
    await act('start()')
    await wait(() => read('!!document.querySelector("[data-cross-document-form=moving] [role=textbox]")'), 'The actual retained workface must mount its original AgentComposer')
    await click('[data-cross-document-form=moving] [role=textbox]')
    await window.webContents.debugger.sendCommand('Input.insertText', { text: 'Original cross-document unsent draft' }); await painted()
    const initial = await act('remember()'); assertRetained(initial, 'A'); samples.push({ step: 'original', state: initial })
    for (const destination of ['B', 'A'] as const) {
      const moved = await act('move(' + JSON.stringify(destination) + ')'); assertRetained(moved, destination)
      const previous = destination === 'A' ? 'B' : 'A'
      const outside = await act('focusBackground(' + JSON.stringify(previous) + ')')
      assert.equal(outside.documents[previous].backgroundActive, true, 'The old document remains independently focusable after the exact modal departs')
      const lateEscape = await act('escape(' + JSON.stringify(previous) + ')')
      assertRetained(lateEscape, destination)
      const oldScroll = await read(probe + '.wheelBackground(' + JSON.stringify(previous) + ')')
      assert.equal(oldScroll.defaultPrevented, false, 'The exact departed document no longer consumes background wheel input')
      const destinationScroll = await read(probe + '.wheelBackground(' + JSON.stringify(destination) + ')')
      assert.equal(destinationScroll.defaultPrevented, true, 'Only the actual destination document retains background scroll input ownership')
      const focused = await act('focusEditor("moving")')
      assert.equal(focused.members.moving.activeInContent, true)
      const trapped = await act('focusBackground(' + JSON.stringify(destination) + ')')
      assert.equal(trapped.documents[destination].backgroundActive, false, 'Only the exact destination document traps programmatic background focus')
      assert.equal(trapped.members.moving.activeInContent, true, 'Focus returns inside the migrated original actual form')
      assertRetained(trapped, destination); samples.push({ step: 'moved-to-' + destination, state: moved, outside, lateEscape, oldScroll, destinationScroll, trapped })
      await frame('workbench-original-form-document-' + destination)
    }
    receipt.cases.push({ label: 'stable-workbench-original-form-cross-document-roundtrip', boundary: initial.boundary, samples })

    // A real iframe is placed within A's actual content boundary so the outer
    // document legitimately contains it. Key events are intentionally synthetic
    // ownerDocument events; this does not claim physical/native Window input.
    await act('nestFrame()'); await act('open("independent")')
    await wait(async () => { const state = await value(); return state.documents.A.liveModals.length === 1 && state.documents.B.liveModals.length === 1 }, 'The same React runtime must keep a real modal in each original document')
    const both = await value()
    const independentModal = both.members.independent.modal
    assert.ok(independentModal, 'B has its own original live modal request')
    const assertIndependentRetained = (state: any) => {
      assert.equal(state.frameConnected, true, 'The original iframe remains connected while its parent modal changes')
      assert.equal(state.frameSameDocument, true, 'The original B document survives each state-preserving iframe placement')
      assert.equal(state.members.independent.formConnected, true, 'B keeps the original connected form')
      assert.equal(state.members.independent.modal, independentModal, 'B keeps its original live modal request identity')
      assert.deepEqual(state.documents.B.liveModals, [independentModal])
      assert.equal(state.members.independent.cancels, 0)
      assert.equal(state.members.independent.confirms, both.members.independent.confirms)
      assert.equal(state.members.independent.draft, both.members.independent.draft)
      assert.equal(state.members.independent.open, true)
    }
    assertIndependentRetained(both)
    assert.equal(both.documents.A.pointerEvents, 'none'); assert.equal(both.documents.B.pointerEvents, 'none')
    const parentTrap = await act('focusBackground("A")')
    assert.equal(parentTrap.members.moving.activeInContent, true, 'A modal keeps its own focus lease while the same runtime also owns a B modal')
    await act('focusEditor("independent")')
    const childTrap = await act('focusBackground("B")')
    assert.equal(childTrap.members.independent.activeInContent, true, 'B modal has its own document-local focus trap')
    await act('focusEditor("moving")')
    const parkedBeforeParentEscape = await act('parkFrame()'); assertIndependentRetained(parkedBeforeParentEscape)
    assert.equal(parkedBeforeParentEscape.members.moving.activeInContent, true, 'The exact A editor remains the target of the next A Escape')
    const parentEscape = await act('escape("A")'); assertIndependentRetained(parentEscape)
    assert.equal(parentEscape.members.moving.cancels, 1); assert.equal(parentEscape.members.moving.open, false)
    assert.equal(parentEscape.members.independent.cancels, 0); assert.equal(parentEscape.members.independent.open, true, 'A single A Escape never closes the B business request')
    await act('open("moving")')
    const renested = await act('nestFrame()'); assertIndependentRetained(renested)
    await act('focusEditor("independent")')
    const childEscape = await act('escape("B")')
    assert.equal(childEscape.members.independent.cancels, 1); assert.equal(childEscape.members.independent.open, false)
    assert.equal(childEscape.members.moving.cancels, 1); assert.equal(childEscape.members.moving.open, true, 'A single B Escape never closes the A business request')
    assert.notEqual(childEscape.documents.B.pointerEvents, 'none'); assert.equal(childEscape.documents.A.pointerEvents, 'none')
    await frame('workbench-document-local-modal-after-child-escape')
    // A's final Cancel must likewise leave B's original document available for
    // the final document-local input-release assertions below.
    const parkedBeforeCancel = await act('parkFrame()')
    assert.equal(parkedBeforeCancel.frameConnected, true); assert.equal(parkedBeforeCancel.frameSameDocument, true)
    const cancelled = await act('cancel("moving")')
    assert.equal(cancelled.frameConnected, true); assert.equal(cancelled.frameSameDocument, true)
    assert.equal(cancelled.members.moving.cancels, 2, 'The exact original A Cancel invokes its own callback once')
    assert.equal(cancelled.members.independent.cancels, 1)
    assert.equal(cancelled.documents.A.liveModals.length, 0); assert.equal(cancelled.documents.B.liveModals.length, 0)
    const finalScroll = { A: await read(probe + '.wheelBackground("A")'), B: await read(probe + '.wheelBackground("B")') }
    assert.equal(finalScroll.A.defaultPrevented, false); assert.equal(finalScroll.B.defaultPrevented, false)
    receipt.cases.push({ label: 'same-runtime-two-document-modal-focus-and-single-dismissal', boundary: initial.boundary, both, parentTrap, childTrap,
      parkedBeforeParentEscape, parentEscape, renested, childEscape, parkedBeforeCancel, cancelled, finalScroll })
  } catch (error) { primaryFailed = true; throw error }
  finally {
    const failures: Array<{ step: string; error: unknown }> = []
    try { await stage('dispose-start'); await read(probe + '.dispose()'); await stage('dispose-returned') } catch (error) { failures.push({ step: 'dispose-original-documents', error }) }
    try { receipt.crossDocumentNativeDemand.restored = await setNativePageVisible(true); layout(); await painted() } catch (error) { failures.push({ step: 'restore-original-native-page', error }) }
    if (failures.length) {
      receipt.crossDocumentCleanupFailures = failures.map(({ step, error }) => ({ step, ...failureDetails(error) }))
      if (!primaryFailed) throw new Error('Cross-document fixture cleanup failed: ' + JSON.stringify(receipt.crossDocumentCleanupFailures))
    }
  }
  await nativeModalClosed()
}
async function verifyMobile() {
  await setNativePageVisible(false); await overlays.update([])
  window.setContentSize(390, 844); window.webContents.setZoomFactor(1)
  await window.loadFile(process.env.AGENTMUX_UI_LAYERING_MOBILE_HTML!)
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await wait(() => read('!!document.querySelector(".mobile-message-tools__trigger")'), 'The real MobileMailbox product trigger must mount')
  await click('.mobile-message-tools__trigger')
  await wait(() => read('!!document.querySelector(".mobile-message-tools [data-input-history-id]")'), 'The real mobile sheet must expose its original IO message')
  const mobileSheetId = await read('document.querySelector(".mobile-message-tools").closest("[data-overlay-modal-scope]").id')
  await click('.mobile-message-tools [data-input-history-id] summary')
  await wait(() => read('(()=>{const image=document.querySelector(".mobile-message-tools .md-conversation-image img");return image?.complete && image.naturalWidth > 0})()'), 'The original Mobile record image must decode through its real reader')
  await frame('mobile-original-mailbox-sheet', window, null)
  for (const close of ['escape', 'control']) {
    await read('document.querySelector(".mobile-message-tools .md-conversation-image").scrollIntoView({block:"nearest"})'); await painted()
    await click('.mobile-message-tools .md-conversation-image')
    await wait(() => read('!!document.querySelector(".md-conversation-image__lightbox")'), 'The original Mobile thumbnail must open the shared real image lightbox')
    // Each retained Portal owns a display:contents host. The hosts are window-root
    // siblings; comparing the scope's immediate parent would compare distinct hosts.
    const mobile = await read('(()=>{const sheet=document.querySelector(".mobile-message-tools"),lightbox=document.querySelector(".md-conversation-image__lightbox"),scope=lightbox.closest("[data-overlay-modal-scope]"),sheetScope=sheet.closest("[data-overlay-modal-scope]"),host=scope.closest("[data-overlay-modal-host]"),sheetHost=sheetScope.closest("[data-overlay-modal-host]"),r=lightbox.getBoundingClientRect();return{sheetId:sheetScope.id,scopeId:scope.id,sibling:!!host&&!!sheetHost&&host!==sheetHost&&host.parentElement===sheetHost.parentElement&&host.parentElement?.id==="mobile-overlays",notInSheet:!!sheetHost&&!!host&&!sheetScope.contains(scope)&&!sheetHost.contains(host),hit:!!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(".md-conversation-image__lightbox"),source:lightbox.querySelector("img.md-conversation-image__full")?.getAttribute("src"),viewport:{width:innerWidth,height:innerHeight},bounds:{x:r.x,y:r.y,width:r.width,height:r.height},layer:getComputedStyle(lightbox).zIndex,token:getComputedStyle(document.documentElement).getPropertyValue("--layer-dialog")}})()')
    receipt.mobileAttempts ??= []; receipt.mobileAttempts.push({ close, ...mobile, source: mobile.source ? { sha256: createHash('sha256').update(mobile.source).digest('hex') } : null })
    assert.equal(mobile.sheetId, mobileSheetId, 'Mobile image opening preserves the original sheet identity')
    assert.ok(mobile.sibling && mobile.notInSheet && mobile.hit, 'The real mobile lightbox is a window sibling above the original sheet')
    assert.ok(mobile.source?.startsWith('data:image/'), 'The real mobile lightbox shows the same retained original image bytes')
    assert.equal(mobile.source, await read('layeringProbe.read().imageSource'), 'Mobile enlargement keeps the exact original byte reference')
    assert.ok(mobile.token.trim() && mobile.layer !== 'auto', 'Mobile consumes the actual shared dialog layer token')
    assert.ok(mobile.bounds.x >= 0 && mobile.bounds.y >= 0 && mobile.bounds.x + mobile.bounds.width <= mobile.viewport.width + 1 && mobile.bounds.y + mobile.bounds.height <= mobile.viewport.height + 1, 'The real mobile lightbox fits its actual 390px viewport')
    await frame('mobile-image-lightbox-' + close, window, null)
    if (close === 'escape') await key('Escape', 27)
    else await click('.md-conversation-image__lightbox [aria-label="Close image"]')
    await wait(() => read('!document.querySelector(".md-conversation-image__lightbox")'), 'Only the original Mobile lightbox closes')
    assert.equal(await read('document.querySelector(".mobile-message-tools")?.closest("[data-overlay-modal-scope]")?.id'), mobileSheetId)
    await wait(() => read('document.activeElement === document.querySelector(".mobile-message-tools .md-conversation-image")'), 'Image close restores focus to the exact original mobile thumbnail')
    receipt.cases.push({ label: 'mobile-mailbox-image-window-sibling-' + close, mobile })
  }
  await frame('mobile-sheet-after-image-close', window, null)
  await click('.mobile-message-tools [aria-label="关闭通信记录"]')
  await wait(() => read('!document.querySelector(".mobile-message-tools")'), 'Explicit Mobile sheet close retires only its original sheet')


}

async function verifyAvatar() {
  const originalBounds = window.getContentBounds(), originalBrowser = { id: page.webContents.id, url: page.webContents.getURL(),
    input: await page.webContents.executeJavaScript('document.querySelector("input").value'), clicks: await page.webContents.executeJavaScript('clicks') }
  const originalWork = (await facts()).workbench, fixture = await createAvatarLayeringSeed(root), samples: any[] = []
  receipt.avatar = { target: fixture.seed.baseline.target, sourceInputs: fixture.seed.sourceInputs, samples }
  const avatar = () => read('layeringProbe.avatar.read()')
  const brief = (state: any) => ({ ...state, png: state.png ? { sha256: createHash('sha256').update(state.png).digest('hex'), bytes: state.png.length } : null })
  const projections = () => (overlays as any).projections as Map<string, { view: WebContentsView; region: NativeOverlayRegion; revision: number }>
  let primaryFailed = false
  async function nativeDrag(selector: string, from: number, to: number) {
    const rect = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    const zoom = window.webContents.getZoomFactor(), p = { x: (rect.x + rect.width * from) * zoom, y: (rect.y + rect.height / 2) * zoom }
    const view = topAt(p); assert.ok(view && view !== page, 'The original Avatar control must be owned by native modal content above the Browser')
    const modalId = (await avatar()).modalId, declaration = receipt.publications.at(-1)?.regions.find((region: NativeOverlayRegion) => region.modal?.id === modalId && region.modal?.part === 'content')
    assert.equal(view, projections().get(declaration?.id)?.view, 'The original Avatar gesture belongs to its exact current content View')
    const bounds = view.getBounds()
    for (const [type, fraction] of [['mouseMove', from], ['mouseDown', from], ['mouseMove', to], ['mouseUp', to]] as const)
      view.webContents.sendInputEvent({ type, x: Math.round((rect.x + rect.width * fraction) * zoom - bounds.x), y: Math.round(p.y - bounds.y), button: 'left', clickCount: 1 })
    await painted()
  }
  async function sample(label: string, previous?: any) {
    const state = await avatar(), parent = (await facts()).nodes.find((node: any) => node.modal === state.modalId && node.part === 'content')
    assert.ok(state.sameModal && state.sameCanvas && state.draftReady === 'true' && state.png?.startsWith('data:image/png;'), 'The original Avatar request must retain its real nonempty canvas and editable PNG draft')
    assert.deepEqual(state.target, fixture.seed.baseline.target)
    assert.equal(state.invokerTargetKey, fixture.seed.baseline.target.objectKey); assert.equal(state.seriesTargetKey, fixture.seed.baseline.target.objectKey)
    assert.deepEqual(state.originalChoice, fixture.seed.baseline.choice, 'Series changes remain an unsaved draft on the original target')
    const renderFacts = JSON.parse(state.renderFacts)
    assert.ok(renderFacts.meshCount > 0 && renderFacts.triangles > 0 && renderFacts.renderCalls > 0 && !renderFacts.contextLost, 'The original GLB renderer must draw real meshes and triangles')
    assert.deepEqual(JSON.parse(state.frameSource), fixture.seed.prepared.find(value => value.definition.kind === 'glb')!.source, 'The actual GLB frame remains bound to its original source revision')
    const pair = receipt.publications.at(-1)?.regions.filter((region: NativeOverlayRegion) => region.modal?.id === state.modalId) ?? []
    assert.deepEqual(pair.map((region: NativeOverlayRegion) => region.modal?.part).sort(), ['content', 'scrim'], 'Avatar content and scrim belong to one original complete modal request')
    const declaration = pair.find((region: NativeOverlayRegion) => region.modal?.part === 'content'), projection = projections().get(declaration.id)
    assert.ok(projection && projection.view.getVisible() && window.contentView.children.includes(projection.view), 'Avatar must have its exact attached original native content projection')
    assert.ok(parent.bounds.x < pageBounds.x + pageBounds.width && parent.bounds.x + parent.bounds.width > pageBounds.x &&
      parent.bounds.y < pageBounds.y + pageBounds.height && parent.bounds.y + parent.bounds.height > pageBounds.y, 'The real Avatar modal must overlap the actually visible Browser')
    assert.equal(page.getVisible(), true)
    const zoom = window.webContents.getZoomFactor(), roi = { x: Math.ceil(state.canvas.x * zoom + 8), y: Math.ceil(state.canvas.y * zoom + 8),
      width: Math.floor(state.canvas.width * zoom) - 16, height: Math.floor(state.canvas.height * zoom) - 16 }
    const bounds = projection.view.getBounds(), local = { ...roi, x: roi.x - bounds.x, y: roi.y - bounds.y }
    assert.equal(topAt({ x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 }), projection.view, 'The original Avatar canvas is covered by its exact content View, never the scrim or Browser')
    assert.ok(state.material?.hit, 'The Avatar material sample must hit the original dialog itself, outside text, controls and rounded corners')
    assert.equal(state.material.rgba[3], 255, 'The original projected Avatar content must provide its actual opaque material')
    const materialPoint = { x: Math.floor(state.material.point.x * zoom), y: Math.floor(state.material.point.y * zoom), width: 1, height: 1 }
    const rendererMaterial = (await window.webContents.capturePage(materialPoint)).toBitmap()
    const chromeMaterial = (await projection.view.webContents.capturePage({ ...materialPoint, x: materialPoint.x - bounds.x, y: materialPoint.y - bounds.y })).toBitmap()
    const expected = [state.material.rgba[2], state.material.rgba[1], state.material.rgba[0], 255]
    receipt.avatarMaterial = { modalId: state.modalId, point: materialPoint, expectedBGRA: expected, rendererBGRA: [...rendererMaterial.subarray(0, 4)], chromeBGRA: [...chromeMaterial.subarray(0, 4)] }
    for (const pixels of [rendererMaterial, chromeMaterial]) assert.ok(pixels.subarray(0, 4).every((value, channel) => Math.abs(value - expected[channel]) <= 2),
      'The actual Avatar material remains undimmed above its scrim in Renderer and native Chrome')
    const renderer = await window.webContents.capturePage(roi), chrome = await projection.view.webContents.capturePage(local)
    const rendererFile = label + '-canvas-renderer.png', chromeFile = label + '-canvas-chrome.png'
    await writeFile(join(root, rendererFile), renderer.toPNG()); await writeFile(join(root, chromeFile), chrome.toPNG())
    const current: any = { label, state: brief(state), regionId: declaration.id, webContentsId: projection.view.webContents.id, revision: projection.revision,
      roi, rendererFile, chromeFile, rendererSHA256: createHash('sha256').update(renderer.toBitmap()).digest('hex'), chromeSHA256: createHash('sha256').update(chrome.toBitmap()).digest('hex') }
    samples.push(current)
    assert.deepEqual(chrome.getSize(), renderer.getSize())
    assert.equal(current.chromeSHA256, current.rendererSHA256, 'The original Avatar native compositor pixels must match the latest real Renderer canvas, not an older bitmap')
    if (previous) {
      assert.equal(state.modalId, previous.state.modalId); assert.equal(state.frameSource, previous.state.frameSource)
      assert.equal(current.webContentsId, previous.webContentsId, 'Continuous Avatar edits retain the original native View')
      assert.notEqual(current.state.png.sha256, previous.state.png.sha256, 'The real Avatar parameter edit must change its original PNG draft')
      assert.ok(renderFacts.frames > JSON.parse(previous.state.renderFacts).frames, 'Continuous edits must commit a newer frame in the original GLB renderer')
      assert.ok(current.revision > previous.revision, 'A committed Avatar canvas change must advance its original native paint revision')
      assert.notEqual(current.chromeSHA256, previous.chromeSHA256, 'Continuous Avatar edits must change the original native compositor pixels')
    }
    await frame(label)
    return current
  }
  try {
    window.setContentSize(1280, 960); layout(); await painted()
    await read('layeringProbe.avatar.start(' + JSON.stringify(fixture.seed) + ')'); await painted()
    await wait(() => read('!!document.querySelector("[data-pmo-teams-topic-launcher] button[data-space-icon-target]")'), 'The original Mote entry must resolve its exact directory/avatar target')
    // The gallery retains Workbench behind this launcher. Reuse the production
    // navigation slot's chrome placement, rather than placing a bare invoker below it.
    const inspectInvoker = () => read(`(()=>{
      const nodes=[...document.querySelectorAll('[data-pmo-teams-topic-launcher] button')].filter(node=>node.dataset.spaceIconTarget===${JSON.stringify(fixture.seed.baseline.target.objectKey)});
      if(nodes.length!==1)return{count:nodes.length};
      const node=nodes[0],slot=node.closest('[data-pmo-teams-topic-launcher]');slot.classList.add('surface-navigation__slot--launcher');
      for(const property of ['position','left','top'])slot.style.removeProperty(property);
      node.setAttribute('data-ui-layering-avatar-invoker','');
      const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      const chain=node=>{const values=[];for(;node;node=node.parentElement){const s=getComputedStyle(node),r=node.getBoundingClientRect();values.push({tag:node.tagName,id:node.id,className:node.className,role:node.getAttribute('role'),position:s.position,zIndex:s.zIndex,isolation:s.isolation,pointerEvents:s.pointerEvents,visibility:s.visibility,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}})}return values};
      return{count:nodes.length,targetKey:node.dataset.spaceIconTarget,slot:'surface-navigation__slot--launcher',layer:getComputedStyle(slot).zIndex,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit===node||node.contains(hit),invokerChain:chain(node),hitChain:chain(hit),topLayers:[...document.querySelectorAll(':popover-open,dialog[open]')].map(node=>({tag:node.tagName,id:node.id,className:node.className}))}
    })()`)
    receipt.avatarInvokerBeforeMove = await inspectInvoker()
    assert.equal(receipt.avatarInvokerBeforeMove.count, 1, 'The exact original Avatar target has one fixture Mote invoker')
    const invoker = await point('[data-ui-layering-avatar-invoker]')
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: invoker.x / window.webContents.getZoomFactor(), y: invoker.y / window.webContents.getZoomFactor(), button: 'none' })
    await painted(); receipt.avatarInvoker = await inspectInvoker()
    assert.equal(receipt.avatarInvoker.count, 1, 'The exact original Avatar target has one fixture Mote invoker')
    assert.equal(receipt.avatarInvoker.hit, true, 'The original Mote invoker must own the actual pointer hit before its context menu opens')
    for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type,
      x: invoker.x / window.webContents.getZoomFactor(), y: invoker.y / window.webContents.getZoomFactor(), button: 'right', clickCount: 1 })
    await wait(() => read('!!document.querySelector("[role=menu][data-state=open]")'), 'The original Mote context menu must open')
    receipt.avatarMenu = await read(`(()=>{const trigger=document.querySelector('[data-ui-layering-avatar-invoker]')?.closest('[data-pmo-teams-topic-launcher]'),menus=[...document.querySelectorAll('[role=menu][data-state=open]')];return{triggerOpen:trigger?.getAttribute('data-state')==='open',targetKey:trigger?.querySelector('button')?.dataset.spaceIconTarget,menus:menus.map(node=>({className:node.className,labels:[...node.querySelectorAll('[role=menuitem]')].map(item=>item.textContent.trim())}))}})()`)
    assert.equal(receipt.avatarMenu.triggerOpen, true, 'The exact original Mote trigger must own the open context menu')
    assert.equal(receipt.avatarMenu.targetKey, fixture.seed.baseline.target.objectKey); assert.equal(receipt.avatarMenu.menus.length, 1)
    await click('[role=menu][data-state=open] [role=menuitem]', 'Change avatar…')
    await wait(() => read('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady === "true"'), 'The real Avatar editor must read the original isolated saved identity')
    await nativeReady(); assert.equal((await avatar()).menuOpen, false, 'The original menu releases focus before opening Avatar')
    await click('[data-avatar-source=series]', undefined, true)
    const seriesSelect = JSON.stringify('select[aria-label="Avatar series"]')
    await wait(() => read('document.querySelectorAll(' + JSON.stringify('select[aria-label="Avatar series"] option') + ').length > 0'), 'The original source owner must supply a nonempty Avatar catalog')
    // Use the real select's keyboard input, preserving the product's onChange.
    await read('document.querySelector(' + seriesSelect + ').focus()'); await key('Home', 36)
    const series = fixture.seed.catalog.series.map(value => JSON.stringify([value.origin, value.seriesId])).indexOf(JSON.stringify(['builtin', 'geometry']))
    assert.ok(series >= 0)
    for (let index = 0; index < series; index++) await key('ArrowDown', 40)
    await key('Enter', 13)
    assert.equal(await read('document.querySelector(' + seriesSelect + ').value'), JSON.stringify(['builtin', 'geometry']), 'Original catalog keyboard selection reaches the real Series onChange')
    const source = fixture.seed.prepared.find(value => value.definition.kind === 'glb')!
    await wait(() => read('!!document.querySelector(' + JSON.stringify('[data-series-entry="' + source.source.entryId + '"]') + ')'), 'The actual GLB entry must belong to the original selected collection')
    await click('[data-series-entry="' + source.source.entryId + '"]', undefined, true)
    await wait(() => read('document.querySelector(".space-icon-picker")?.dataset.seriesDraftReady === "true" && !!document.querySelector(".mote-series__preview canvas[data-series-render-facts]")'), 'The original real GLB renderer must commit its nonempty editable draft')
    await nativeReady(); await read('layeringProbe.avatar.remember()')
    let previous = await sample('avatar-series-initial')
    for (const [label, action, control] of [
      ['avatar-series-toon', async () => click('[data-series-material=toon]', undefined, true), 'material'],
      ['avatar-series-expression', async () => nativeDrag('[data-series-morph]', .3, .8), 'morphs'],
      ['avatar-series-rotation', async () => nativeDrag('[aria-label="Series model rotation"]', .5, .72), 'yaw'],
      ['avatar-series-drag', async () => nativeDrag('.mote-series__preview canvas', .45, .65), 'yaw']
    ] as const) {
      const oldPng = (await avatar()).png
      await action()
      await wait(async () => { const state = await avatar(); return state.draftReady === 'true' && state.png && state.png !== oldPng }, 'The original Avatar parameter interaction must commit a newer real PNG')
      assert.notDeepEqual((await avatar()).controls[control], previous.state.controls[control], 'Native input must change the original Avatar control value')
      await painted(); await nativeReady(); previous = await sample(label, previous)
    }
    await click('.space-icon-picker footer button', 'Cancel', true); await nativeModalClosed()
    const cancelled = await avatar(); assert.equal(cancelled.modalId, undefined); assert.equal(cancelled.activeInvoker, true, 'Avatar Cancel returns focus to its exact original Mote entry')
    assert.equal(await read('document.activeElement?.matches("[data-ui-layering-avatar-invoker]")'), true, 'Avatar Cancel focuses the exact target-bound original invoker')
    assert.ok(cancelled.calls.every((call: any) => !['save', 'config.save'].includes(call.method)), 'Avatar Cancel never invokes a saved-avatar/configuration write')
    await fixture.verifyUnchanged()
    for (const field of ['sessions', 'drafts', 'tabs', 'layout', 'stops', 'writes', 'pastes']) assert.deepEqual((await facts()).workbench[field], originalWork[field], 'Avatar retains original workbench ' + field)
    assert.deepEqual({ id: page.webContents.id, url: page.webContents.getURL(), input: await page.webContents.executeJavaScript('document.querySelector("input").value'), clicks: await page.webContents.executeJavaScript('clicks') }, originalBrowser)
    receipt.cases.push({ label: 'mote-avatar-series-native-layer-and-continuous-paint', samples, cancelled: brief(cancelled), savedAvatarUnchanged: true })
  } catch (error) { primaryFailed = true; receipt.avatarFailureState = brief(await avatar().catch(() => ({}))); throw error }
  finally {
    try { await read('layeringProbe.avatar.dispose()'); window.setContentSize(originalBounds.width, originalBounds.height); layout(); await painted(); await nativeModalClosed() }
    catch (error) { receipt.avatarCleanupFailure = failureDetails(error); if (!primaryFailed) throw error }
  }
}

async function run() {
  await app.whenReady()
  if (process.env.AGENTMUX_VISUAL_ORCA_CLI) { app.setAccessibilitySupportEnabled(true); receipt.privateAccessibilitySupport = app.accessibilitySupportEnabled }
  window = new BrowserWindow({ show: false, width: 1180, height: 760, title: 'AgentMux isolated UI layering proof', webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, ...details) => { receipt.console ??= []; receipt.console.push(details) })
  window.webContents.on('preload-error', (_event, path, error) => { receipt.preloadError = { path, message: error.message } })
  window.webContents.on('did-fail-load', (_event, code, description, url) => { receipt.loadFailure = { code, description, url } })
  const originalHTML = '<!doctype html><style>body{background:#17313d;color:#eaf5f8;font:16px system-ui;padding:28px}input{display:block;width:85%;margin:24px 0;padding:8px}button{padding:10px}</style><h2>Original Browser</h2><p>The page, its input and history remain intact.</p><input value="Original Browser draft stays here"><button id="background">Background action</button><output id="count">0</output><script>window.clicks=0;document.querySelector("button").onclick=()=>{document.querySelector("output").textContent=String(++window.clicks)}</script>'
  pageServer = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(originalHTML) })
  await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve))
  const originalURL = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/`
  const createBrowsers = (host: BrowserWindow, name: string) => new BrowserViewManager(host,
    { defaultProfileId: () => name, resolvePartition: () => name }, new BrowserRefLedgerStore(join(root, name + '-refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  browsers = createBrowsers(window, 'layering-original-profile')
  await browsers.create(pageId, originalURL, 'isolated-workspace'); browsers.setBounds(pageId, { x: 0, y: 56, width: 1, height: 1 })
  page = browsers.nativeOwner(pageId)!.view
  overlays = new NativeOverlaySurfaces(window, browsers, (message, modalId) => {
    receipt.warnings.push({ message, modalId }); if (!window.isDestroyed()) window.webContents.send('layering:warning', { message, modalId })
  }, input => window.webContents.send('layering:input', input))
  const capture = window.webContents.capturePage.bind(window.webContents)
  window.webContents.capturePage = (async (...args: any[]) => {
    if (args[0] && fault === 'content') { fault = 'none'; captureFaults++; throw new Error('Injected original Chrome capture failure') }
    if (args[0] && fault === 'attachment' && receipt.publications.at(-1)?.regions.some((region: NativeOverlayRegion) => !region.modal && region.id === failedAccessoryId &&
      Math.abs(region.bounds.x - args[0].x) < 1 && Math.abs(region.bounds.y - args[0].y) < 1 && Math.abs(region.bounds.width - args[0].width) < 1)) {
      fault = 'none'; captureFaults++; throw new Error('Injected original modal accessory capture failure')
    }
    if (args[0] && fault === 'hold') { fault = 'none'; held = true; await new Promise<void>(resolve => { release = resolve }) }
    return capture(...args)
  }) as typeof window.webContents.capturePage
  ipcMain.handle('layering:visibility', event => {
    const independent = independentWindows.get(event.sender.id)
    return independent ? { revision: ++independent.revision, zoomFactor: independent.window.webContents.getZoomFactor(), bounds: visibleNativeBounds(independent.window, independent.page) } : visibility()
  })
  ipcMain.handle('layering:publish', async (event, regions: NativeOverlayRegion[]) => {
    const independent = independentWindows.get(event.sender.id)
    if (independent) {
      const publication: any = { regions, started: Date.now(), before: owners(independent.window, independent.page) }; independent.publications.push(publication); independent.publishing++
      try { independent.last = await independent.overlays.update(regions); publication.receipt = independent.last; return independent.last }
      finally { independent.publishing--; publication.after = owners(independent.window, independent.page); publication.finished = Date.now() }
    }
    assert.equal(event.sender, window.webContents)
    const publication: any = { regions, started: Date.now(), before: owners() }; receipt.publications.push(publication); publishing++
    try { last = await overlays.update(regions); publication.receipt = last; return last }
    finally { publishing--; publication.after = owners(); publication.finished = Date.now() }
  })
  await window.loadFile(html); layout(); window.showInactive(); page.webContents.setBackgroundThrottling(false)
  window.on('resize', layout)
  window.webContents.debugger.attach('1.3'); await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await wait(() => read('!!window.layeringProbe'), 'Actual fixture Renderer must load')
  if (qaScope === 'mobile-only') { await verifyMobile(); finishAvailableChecks(); return }
  if (qaScope === 'system-fullscreen-only') { await verifySystemFullscreen(); finishAvailableChecks(); return }
  await openStop(); await assertModal('normal-stop-original-caller'); await frame('normal-stop')
  const original = (await facts()).workbench
  await key('Enter', 13); await nativeModalClosed()
  assert.equal(await read('!!document.querySelector(".confirmation-dialog")'), false, 'Initial Enter cancels the destructive action')
  assert.deepEqual((await facts()).workbench.stops, original.stops, 'Cancel never stops a Run')
  receipt.cases.push({ label: 'initial-enter-cancels', originalRetained: true })

  await openStop(); await nativeReady(); await click('.confirmation-dialog button', 'Keep Session & Close', true); await nativeModalClosed()
  const kept = (await facts()).workbench
  assert.deepEqual(kept.stops, original.stops, 'Keep leaves the original Agent running')
  for (const field of ['drafts', 'sessions']) assert.deepEqual(kept[field], original[field], 'Keep preserves original ' + field)
  assert.ok(!kept.tabs['result-input-tab'], 'Keep closes only the chosen View')
  receipt.cases.push({ label: 'native-keep-original-session', kept })

  await openStop(); await nativeReady(); await read('dialogCraft.busy(true)'); await click('.confirmation-dialog button', 'Stop & Close', true)
  await wait(() => read('document.querySelector(".confirmation-dialog")?.closest("[data-overlay-modal-boundary]")?.getAttribute("aria-busy")==="true"'), 'Actual Stop must become busy')
  const busyControls = await read('(()=>{const content=document.querySelector(".confirmation-dialog"),boundary=content?.closest("[data-overlay-modal-boundary]");return{modalId:content?.dataset.overlayModalId,busy:boundary?.getAttribute("aria-busy"),buttons:[...content.querySelectorAll("button")].map(button=>({label:button.textContent.trim(),disabled:button.disabled,confirm:button.hasAttribute("data-confirm-label")}))}})()')
  assert.equal(busyControls.buttons.find((button: any) => button.confirm)?.label, 'Working…', 'The original painted Stop control must display its pending action')
  assert.ok(busyControls.buttons.length > 0 && busyControls.buttons.every((button: any) => button.disabled), 'Every original confirmation control must be disabled while Stop is pending')
  await click('.confirmation-dialog button', 'Working…', true); await key('Escape', 27)
  const during = (await facts()).workbench
  assert.equal(during.stops.length, original.stops.length + 1, 'Busy Stop reaches its original owner exactly once')
  assert.equal(await read('!!document.querySelector(".confirmation-dialog")'), true, 'Busy Escape preserves the same pending action')
  await frame('normal-stop-busy'); await read('dialogCraft.busy(false)'); await nativeModalClosed()
  assert.ok((await facts()).events.some((event: any) => event.type === 'click' && event.trusted && event.label?.includes('Stop & Close')), 'Native projection input must reach the original trusted DOM handler')
  receipt.cases.push({ label: 'native-stop-busy-exactly-once', busyControls, during })

  for (const [label, width, height, zoom] of [['narrow-short', 640, 410, 1], ['zoom-125', 960, 680, 1.25]] as const) {
    await openStop(); await nativeReady()
    const identity = await read('document.querySelector("[data-overlay-modal-scope]").id')
    window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); layout()
    await painted(); await assertModal(label); await frame(label)
    assert.equal(await read('document.querySelector("[data-overlay-modal-scope]").id'), identity, 'Window resize and zoom retain the original modal identity and request')
    await key('Escape', 27); await nativeModalClosed()
  }
  window.setContentSize(1180, 740); window.webContents.setZoomFactor(1); layout()

  await openStop(); await nativeReady()
  const beforeShift = await read('document.querySelector(".confirmation-dialog").getBoundingClientRect().x')
  const shiftedModalId = await read('document.querySelector("[data-overlay-modal-scope]").id')
  await read('layeringProbe.shiftModal(24)')
  await wait(() => { const content = receipt.publications.at(-1)?.regions.find((region: NativeOverlayRegion) => region.modal?.part === 'content'); return content && Math.abs(content.bounds.x - beforeShift - 24) < 1 && publishing === 0 }, 'Pure CSSOM layout displacement must update the original native content bounds')
  await assertModal('pure-layout-displacement'); await frame('pure-layout-displacement')
  assert.equal(await read('document.querySelector("[data-overlay-modal-scope]").id'), shiftedModalId)
  await read('layeringProbe.shiftModal(0)'); await painted(); await key('Escape', 27); await nativeModalClosed()

  for (let iteration = 0; iteration < 2; iteration++) {
    await read('layeringProbe.foreignPopover(true)'); await openStop(); await assertModal('repeated-top-layer-' + iteration)
    assert.equal(await read('document.getElementById("fixture-foreign-popover")?.matches(":popover-open")'), true, 'Opening a newer modal preserves the already open native HTML popover')
    await key('Escape', 27); await read('layeringProbe.foreignPopover(false)'); await nativeModalClosed()
  }

  if (process.platform === 'darwin') {
    await openStop(); await nativeReady(); const originalModal = await read('document.querySelector("[data-overlay-modal-scope]").id')
    window.setSimpleFullScreen(true); layout(); await painted()
    await wait(() => window.isSimpleFullScreen(), 'The isolated native window must enter simple fullscreen')
    await assertModal('simple-fullscreen'); await frame('simple-fullscreen')
    window.setSimpleFullScreen(false); layout(); await painted()
    await wait(() => !window.isSimpleFullScreen(), 'The isolated native window must restore from fullscreen')
    await assertModal('simple-fullscreen-restored')
    assert.equal(await read('document.querySelector("[data-overlay-modal-scope]").id'), originalModal, 'Fullscreen and restore retain the same original modal request')
    await key('Escape', 27); await nativeModalClosed()
    if (!withoutSystemFullscreen) await verifySystemFullscreen()
  }

  const independent = new BrowserWindow({ show: false, width: 820, height: 600, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, backgroundThrottling: false } })
  const independentBrowsers = createBrowsers(independent, 'layering-independent-profile')
  const independentBounds = { x: 394, y: 56, width: 426, height: 512 }
  await independentBrowsers.create('independent-original-browser', originalURL, 'isolated-workspace'); independentBrowsers.setBounds('independent-original-browser', independentBounds)
  const independentPage = independentBrowsers.nativeOwner('independent-original-browser')!.view
  const independentOverlays = new NativeOverlaySurfaces(independent, independentBrowsers,
    (message, modalId) => independent.webContents.send('layering:warning', { message, modalId }), input => independent.webContents.send('layering:input', input))
  const independentContext = { window: independent, page: independentPage, browsers: independentBrowsers, overlays: independentOverlays, bounds: independentBounds, revision: 0, publishing: 0, publications: [] as any[], last: undefined as any }
  independentWindows.set(independent.webContents.id, independentContext)
  await independent.loadFile(html); independent.setTitle('AgentMux isolated independent document'); independent.showInactive(); independentPage.webContents.setBackgroundThrottling(false)
  independent.webContents.debugger.attach('1.3'); await independent.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const childRead = (source: string) => independent.webContents.executeJavaScript(source)
  await wait(() => childRead('!!window.layeringProbe'), 'Independent window must load its own original Renderer document')
  await childRead('layeringProbe.seed()'); await delay(160)
  const childClose = await childRead('(()=>{const r=document.querySelector(".workbench-tab__close").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
  for (const type of ['mousePressed', 'mouseReleased']) await independent.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...childClose, button: 'left', clickCount: 1 })
  await wait(() => independentContext.publishing === 0 && independentContext.last &&
    positive(independent, independentPage).length === independentContext.last.projected &&
    [...nativeProjections(independentOverlays).values()].filter(projection => projection.region.modal).length === 2,
  'Independent actual document must publish its own required native pair')
  const independentFacts = await childRead('layeringProbe.read()')
  assert.equal(independentFacts.nodes.filter((node: any) => node.part).length, 2)
  assert.ok(independentFacts.nodes.find((node: any) => node.part === 'content').hit, 'Independent document content remains above its own scrim')
  assert.equal((await facts()).nodes.filter((node: any) => node.part).length, 0, 'Independent window opening cannot create a modal in the original document')
  assert.equal([...nativeProjections().values()].filter(projection => projection.region.modal).length, 0, 'Independent modal cannot allocate its native pair in the original native window')
  await frame('independent-document', independent, independentPage)
  const cancelPoint = await childRead('(()=>{const r=document.querySelector(".confirmation-dialog__cancel").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
  const independentTop = [...independent.contentView.children].reverse().find(view => view.getVisible() && atPoint(view.getBounds(), cancelPoint)) as WebContentsView
  assert.ok(independentTop && independentTop !== independentPage)
  const independentTopBounds = independentTop.getBounds()
  for (const type of ['mouseDown', 'mouseUp'] as const) independentTop.webContents.sendInputEvent({ type, x: cancelPoint.x - independentTopBounds.x, y: cancelPoint.y - independentTopBounds.y, button: 'left', clickCount: 1 })
  await wait(async () => {
    if (independentContext.publishing !== 0 || !independentContext.last ||
      positive(independent, independentPage).length !== independentContext.last.projected ||
      independentContext.publications.at(-1)?.regions.some((region: NativeOverlayRegion) => region.modal) ||
      [...nativeProjections(independentOverlays).values()].some(projection => projection.region.modal)) return false
    return await childRead(`!document.querySelector('[data-overlay-modal-scope]:not([hidden]) [data-overlay-modal-part="content"][data-state="open"]')`)
  }, 'Independent cancel removes only the original independent modal')
  assert.equal(await independentPage.webContents.executeJavaScript('document.querySelector("input").value'), 'Original Browser draft stays here')
  receipt.cases.push({ label: 'independent-document-native-scope-and-cancel', facts: independentFacts, publications: independentContext.publications,
    rootBrowserId: page.webContents.id, independentBrowserId: independentPage.webContents.id })
  independentWindows.delete(independent.webContents.id); independentOverlays.dispose(); independentBrowsers.dispose(); independent.destroy()

  fault = 'hold'; held = false; await openStop()
  await wait(() => held, 'The original content capture must reach the held external IO boundary')
  const preparingModalId = await read('document.querySelector("[data-overlay-modal-scope]").id')
  assert.ok(preparingModalId, 'Held preparation must retain its original modal identity')
  assert.equal([...nativeProjections().values()].filter(projection => projection.region.modal?.id === preparingModalId).length, 0, 'Required modal pair has no orphan scrim while content prepares')
  receipt.preparingPair = { modalId: preparingModalId, native: [...nativeProjections().values()].map(projection => ({ region: projection.region, webContentsId: projection.view.webContents.id })), owners: owners() }
  const backgroundBefore = await page.webContents.executeJavaScript('clicks')
  const p = await page.webContents.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
  const hit = topAt({ x: pageBounds.x + p.x, y: pageBounds.y + p.y })!
  assert.notEqual(hit, page, 'Modal preparation installs its original Browser owner native input barrier')
  const hitBounds = hit.getBounds()
  for (const type of ['mouseDown', 'mouseUp'] as const) hit.webContents.sendInputEvent({ type, x: pageBounds.x + p.x - hitBounds.x, y: pageBounds.y + p.y - hitBounds.y, button: 'left', clickCount: 1 })
  await delay(80)
  assert.equal(await page.webContents.executeJavaScript('clicks'), backgroundBefore, 'Modal preparation blocks only its original background Browser native input')
  page.webContents.debugger.attach('1.3')
  for (const type of ['mousePressed', 'mouseReleased']) await page.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
  assert.equal(await page.webContents.executeJavaScript('clicks'), backgroundBefore + 1, 'Modal preparation preserves the original Browser CDP action')
  page.webContents.debugger.detach()
  release?.(); release = undefined; await nativeReady(); await assertModal('atomic-pair-preparation'); await key('Escape', 27); await nativeModalClosed()
  receipt.cases.push({ label: 'atomic-preparation-background-input-guard', backgroundBefore, captureFaults })

  fault = 'content'; await openStop()
  await wait(() => read('document.querySelectorAll(".modal-presentation-note").length===1'), 'Presentation failure must retain one nonblocking retry service window')
  await wait(() => publishing === 0 && receipt.publications.at(-1)?.regions.every((region: NativeOverlayRegion) => !region.modal), 'Failed required pair must withdraw its modal declarations')
  assert.ok([...nativeProjections().values()].every(projection => !projection.region.modal), 'A failed required content leaves no isolated native scrim or content')
  await wait(() => read('document.querySelector("[data-overlay-modal-scope]")?.hidden === true'), 'Failed modal must pause its retained original business DOM')
  assert.equal((await facts()).nodes.filter((node: any) => node.part).length, 0, 'Failed DOM modal releases its unavailable presentation and retains its hidden original body')
  assert.notEqual(await read('getComputedStyle(document.body).pointerEvents'), 'none', 'Failed modal releases its background DOM input guard')
  const failed = await facts()
  assert.ok(failed.workbench.tabs['result-input-tab'], 'Presentation failure keeps the original View and pending request')
  assert.equal(failed.workbench.stops.length, during.stops.length, 'Presentation failure never authorizes Stop')
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), 'Original Browser draft stays here')
  await frame('content-failure-retry'); await click('.modal-presentation-note button', 'Retry', true); await assertModal('same-request-retry'); await frame('same-request-retry')
  await key('Escape', 27); await nativeModalClosed()
  receipt.cases.push({ label: 'required-content-failure-retry-retains-request', failed })

  await read('layeringProbe.nested()'); await nativeReady()
  await wait(() => read('!!document.querySelector("#nested-tooltip")'), 'Actual modal attachment slot must mount')
  let nested = await facts(), tooltip = nested.nodes.find((node: any) => node.id === 'nested-tooltip')
  assert.ok(tooltip?.inSlot && tooltip.hit, 'A portaled tooltip stays above its parent modal in the original non-scrolling attachment slot')
  failedAccessoryId = receipt.publications.at(-1)?.regions.find((region: NativeOverlayRegion) => !region.modal &&
    Math.abs(region.bounds.x - tooltip.bounds.x) < 1 && Math.abs(region.bounds.y - tooltip.bounds.y) < 1)?.id
  assert.ok(failedAccessoryId, 'The exact original modal tooltip must have a non-required native projection')
  const parentId = await read('document.querySelector("[data-overlay-modal-scope]").id')
  fault = 'attachment'; const faultsBeforeAttachment = captureFaults
  await click('#nested-menu-trigger', undefined, true)
  await wait(() => read('!!document.querySelector("[role=menu]")'), 'Original nested menu must open')
  await nativeReady(); nested = await facts()
  await wait(() => captureFaults > faultsBeforeAttachment, 'An actual non-required accessory capture must exercise its own failure boundary')
  assert.equal(await read('document.querySelector("[data-overlay-modal-scope]").id'), parentId, 'Accessory capture failure must not revoke its original parent modal')
  assert.ok(!last.failures?.length, 'An accessory capture failure cannot invent a required-modal failure')
  receipt.cases.push({ label: 'accessory-failure-retains-parent-modal', parentId, captureFaults })
  await key('Escape', 27); await click('#nested-menu-trigger', undefined, true)
  await wait(() => read('!!document.querySelector("[role=menu]")'), 'The same original accessory must reopen after its own capture failure')
  await nativeReady(); nested = await facts()
  const menu = nested.nodes.find((node: any) => node.role === 'menu')
  assert.ok(menu?.inSlot && menu.hit, 'Actual nested menu stays above the parent modal')
  assert.ok(menu.bounds.x < pageBounds.x + pageBounds.width && menu.bounds.x + menu.bounds.width > pageBounds.x &&
    menu.bounds.y < pageBounds.y + pageBounds.height && menu.bounds.y + menu.bounds.height > pageBounds.y,
  'The actual nested menu must overlap the original native Browser before its independent projection is required')
  assert.ok(receipt.publications.at(-1)?.regions.some((region: NativeOverlayRegion) => !region.modal &&
    Math.abs(region.bounds.x - menu.bounds.x) < 1 && Math.abs(region.bounds.y - menu.bounds.y) < 1 && Math.abs(region.bounds.width - menu.bounds.width) < 1),
  'The original Popper-wrapped nested menu has its own native projection, independent of parent content capture')
  await frame('nested-menu-tooltip'); await click('[role="menu"] [role="menuitem"]', undefined, true)
  await wait(() => read('layeringProbe.actions().includes("nested-action")'), 'Native Popper menu input reaches its original nested action')
  assert.equal(await read('!!document.querySelector(".confirmation-dialog")'), true, 'Nested selection keeps the original parent modal')
  await click('#nested-menu-trigger', undefined, true); await wait(() => read('!!document.querySelector("[role=menu]")'), 'Original nested menu can reopen in the same parent')
  await nativeReady(); await key('Escape', 27)
  assert.equal(await read('!!document.querySelector(".confirmation-dialog")'), true, 'One Escape dismisses only the child menu')
  await key('Escape', 27); await nativeModalClosed()
  receipt.cases.push({ label: 'nested-menu-tooltip-scope-and-one-escape', nested })

  await read('layeringProbe.completion()'); await nativeReady()
  await click('.confirmation-dialog [role="textbox"]', undefined, true)
  await window.webContents.debugger.sendCommand('Input.insertText', { text: '/' })
  await wait(() => read('!!document.querySelector(".composer-completion-popover [role=option]")'), 'Original modal composer must show nonempty real completion choices')
  await nativeReady()
  assert.equal(await read('!!document.querySelector(".composer-completion-popover")?.closest("[data-overlay-modal-slot]")'), true, 'Real completion Portal belongs to the original modal slot')
  await key('ArrowDown', 40)
  assert.equal(await read('document.activeElement?.getAttribute("role")'), 'option', 'Modal focus ownership allows a real portaled completion choice to receive keyboard focus')
  await frame('modal-focusable-completion')
  const completionFrame = receipt.frames.at(-1), completion = completionFrame.fact.nodes.find((node: any) => node.kind === 'composer-completion')
  const completionParent = completionFrame.fact.nodes.find((node: any) => node.part === 'content')
  assert.ok(completion?.inSlot && completionParent, 'The original painted completion box belongs to its actual modal slot')
  const dip = (box: any) => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value) * window.webContents.getZoomFactor()])) as { x: number; y: number; width: number; height: number }
  const popupBounds = dip(completion.bounds), parentBounds = dip(completionParent.bounds)
  const left = Math.max(popupBounds.x, pageBounds.x), top = Math.max(popupBounds.y, pageBounds.y)
  const right = Math.min(popupBounds.x + popupBounds.width, pageBounds.x + pageBounds.width)
  const bottom = Math.min(popupBounds.y + popupBounds.height, pageBounds.y + pageBounds.height)
  const overlap = { x: left, y: top, width: right - left, height: bottom - top }
  const overhang = [
    { x: left, y: top, width: Math.min(right, parentBounds.x) - left, height: bottom - top },
    { x: Math.max(left, parentBounds.x + parentBounds.width), y: top, width: right - Math.max(left, parentBounds.x + parentBounds.width), height: bottom - top },
    { x: left, y: top, width: right - left, height: Math.min(bottom, parentBounds.y) - top },
    { x: left, y: Math.max(top, parentBounds.y + parentBounds.height), width: right - left, height: bottom - Math.max(top, parentBounds.y + parentBounds.height) }
  ].find(box => box.width > 0 && box.height > 0)
  const matching = (receipt.publications.at(-1)?.regions ?? []).filter((region: NativeOverlayRegion) => !region.modal &&
    ['x', 'y', 'width', 'height'].every(key => Math.abs(region.bounds[key as keyof typeof region.bounds] - popupBounds[key as keyof typeof popupBounds]) < 1))
  const proof: any = receipt.completionProjection = { label: 'modal-focusable-completion', popupBounds, parentBounds, browserBounds: { ...pageBounds }, overlap, overhang,
    matchingDeclarations: matching, chromeOwners: completionFrame.chrome.map((owner: any) => ({ file: owner.file, before: owner.before, paintedPixels: owner.paintedPixels })) }
  assert.ok(overlap.width > 0 && overlap.height > 0 && overhang, 'The original completion must actually extend outside modal content over the native Browser')
  assert.equal(matching.length, 1, 'The original overhanging completion has its own complete native projection, independent of parent content capture')
  const completionChrome = completionFrame.chrome.find((owner: any) => owner.before.regionId === matching[0].id)
  assert.ok(completionChrome && !completionChrome.scrim && completionChrome.paintedPixels > 0, 'The exact completion projection supplies painted compositor pixels from its original attached View')
  const hitPoint = { x: overhang.x + overhang.width / 2, y: overhang.y + overhang.height / 2 }
  const hitOwner = topAt(hitPoint)
  proof.hitPoint = hitPoint; proof.hitWebContentsId = hitOwner?.webContents.id; proof.chromeFile = completionChrome.file
  assert.equal(hitOwner?.webContents.id, completionChrome.before.webContentsId, 'The exact completion View is the top native hit owner at its original overhang above the Browser')
  await key('Enter', 13)
  await wait(() => read('layeringProbe.actions().includes("completion:/inspect")'), 'Original completion keyboard selection must reach its own callback')
  assert.equal(await read('document.querySelector(".confirmation-dialog [role=textbox]")?.textContent'), '/inspect ', 'Completion edits the original unsent modal draft')
  assert.equal(await read('layeringProbe.actions().includes("send")'), false, 'Choosing completion does not send or confirm the original draft')
  await read('window.retainedCompletionEditor = document.querySelector(".confirmation-dialog [role=textbox]")')
  fault = 'content'; await overlays.refresh()
  await wait(() => read('!!document.querySelector(".modal-presentation-note")'), 'Original editor modal must retain a recovery surface after native repaint failure')
  await wait(() => publishing === 0 && receipt.publications.at(-1)?.regions.every((region: NativeOverlayRegion) => !region.modal) && positive().length === last?.projected, 'Original modal editor failure must finish its nonblocking native service window')
  assert.equal(await read('document.querySelector(".confirmation-dialog [role=textbox]") === window.retainedCompletionEditor'), true, 'Presentation failure preserves the original maintained editor instance')
  assert.equal(await read('window.retainedCompletionEditor.textContent'), '/inspect ')
  await click('.modal-presentation-note button', 'Retry', true); await nativeReady()
  assert.equal(await read('document.querySelector(".confirmation-dialog [role=textbox]") === window.retainedCompletionEditor'), true, 'Retry resumes the original maintained editor instance')
  assert.equal(await read('window.retainedCompletionEditor.textContent'), '/inspect ')
  await frame('modal-retained-draft-retry'); await click('.confirmation-dialog__cancel', undefined, true); await nativeModalClosed()
  receipt.cases.push({ label: 'focusable-completion-and-editor-retained-through-retry', actions: await read('layeringProbe.actions()') })

  await verifyAvatar()
  await verifyCrossDocumentWorkbench()
  await verifyMobile()

  assert.equal(page.webContents.getURL(), originalURL, 'All scenarios retain the original native Browser history identity')
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), 'Original Browser draft stays here')
  receipt.browser = { id: page.webContents.id, url: page.webContents.getURL(), clicks: await page.webContents.executeJavaScript('clicks') }
  receipt.captureFaults = captureFaults; finishAvailableChecks()
}
void run().catch(async error => { receipt.failure = failureDetails(error); try { await frame('failure') } catch (captureError) { receipt.failureFrameError = failureDetails(captureError) } }).finally(async () => {
  release?.(); ipcMain.removeHandler('layering:visibility'); ipcMain.removeHandler('layering:publish')
  for (const independent of independentWindows.values()) { independent.overlays.dispose(); independent.browsers.dispose(); independent.window.destroy() }
  overlays?.dispose(); browsers?.dispose(); pageServer?.close(); window?.destroy()
  if ((!receipt.osFrames.length || receipt.osCaptureFailure) && !receipt.uncovered.includes('OS-composition')) receipt.uncovered.push('OS-composition')
  await writeFile(join(root, 'result.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.availableChecksPassed && (qaScope !== 'complete' || receipt.completeGate) ? 0 : 1)
})
