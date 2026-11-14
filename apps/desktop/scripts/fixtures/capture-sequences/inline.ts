import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen, type NativeImage, type Rectangle } from 'electron'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { CaptureSequenceOwner } from '../../../src/main/capture-sequence'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { NativeDesktop } from '@agentmux/native-desktop'
import { AgentMuxRpcService } from '@agentmux/core'

const out = process.env.CAPTURE_SEQUENCE_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const result: any = { passed: false, mode: 'scroll', observations: [], screenshots: [] }
let native: NativeDesktop, surface: CaptureSurface, source: BrowserWindow
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(name: string, read: () => T | Promise<T>, external = false): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < (external ? 600000 : 15000)) { const value = await read(); if (value) return value as NonNullable<T>; await wait(40) }
  throw new Error('Timed out: ' + name)
}
const humanInput = process.env.CAPTURE_SEQUENCE_OPERATOR === 'human'
const execute = promisify(execFile)
type Point = { x: number; y: number }
let originalCursor: Point | undefined
let lastWarp: Point | undefined

// AppKit asks WindowServer which actual window would receive a mouse-down here.
// Move the cursor via Quartz, but never post clicks or wheel events to the global desktop.
const probe = `
import AppKit
import CoreGraphics
let _ = NSApplication.shared
let args = CommandLine.arguments
let point = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
if args[1] == "move" {
    guard CGWarpMouseCursorPosition(point) == .success else { exit(1) }
}
let top = NSScreen.screens[0].frame.maxY
let hit = NSWindow.windowNumber(at: NSPoint(x: point.x, y: top - point.y), belowWindowWithWindowNumber: 0)
print(hit)
`
async function nativeWindowAt(point: Point, move = false) {
  const { stdout } = await execute('swift', ['-e', probe, move ? 'move' : 'hit', String(point.x), String(point.y)])
  return Number(stdout.trim())
}
async function routeTo(window: BrowserWindow, point: Point) {
  originalCursor ??= screen.getCursorScreenPoint()
  lastWarp = point
  const initial = await nativeWindowAt(point, true)
  const expected = Number(window.getMediaSourceId().split(':')[1])
  const hit = initial === expected ? initial : await nativeWindowAt(point)
  assert.equal(hit, expected, 'WindowServer must route the global point ' + JSON.stringify(point) + ' to the expected fixture window')
  const bounds = window.getContentBounds()
  const at = { x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y) }
  window.webContents.focus()
  window.webContents.sendInputEvent({ type: 'mouseMove', ...at })
  return { at, hit }
}
async function clickAt(window: BrowserWindow, point: Point) {
  const { at, hit } = await routeTo(window, point)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at })
  return hit
}
const js = async (window: BrowserWindow, code: string) => { try { return await window.webContents.executeJavaScript(code) } catch (error) { throw new Error('Renderer evaluation failed: ' + code + ': ' + error) } }
async function click(window: BrowserWindow, label: string) {
  await js(window, `(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b||b.disabled)throw Error('Missing enabled '+${JSON.stringify(label)});b.click()})()`)
}
function assertSourcePixels(actual: Buffer, expected: Buffer, context: string) {
  assert.equal(actual.length, expected.length, context + ' must have the source dimensions')
  let changed = 0
  for (let i = 0; i < expected.length; i += 4) {
    if ([0, 1, 2].some(channel => Math.abs(actual[i + channel] - expected[i + channel]) > 12)) changed++
  }
  const fraction = changed / (expected.length / 4)
  assert.ok(fraction < .001, `${context} must contain only source pixels, ${(fraction * 100).toFixed(3)}% differ`)
}
function assertStitchedSource(image: NativeImage, first: NativeImage, last: NativeImage, context: string) {
  const appended = image.getSize().height - first.getSize().height
  assert.ok(appended > 0 && appended <= last.getSize().height, 'scroll must append source rows')
  const stripBytes = appended * image.getSize().width * 4
  assertSourcePixels(image.toBitmap(), Buffer.concat([first.toBitmap(), last.toBitmap().subarray(-stripBytes)]), context)
}
async function readPreview(overlay: BrowserWindow, previous?: string, expectedSize?: { width: number; height: number }) {
  return await until('decoded accepted image preview', () => js(overlay, `(() => {
    const preview = document.querySelector('.capture-live-preview img')
    if (!preview?.complete || !preview.naturalWidth || preview.src === ${JSON.stringify(previous ?? '')}) return null
    const expected = ${JSON.stringify(expectedSize ?? null)}
    if (expected && Math.abs(preview.naturalWidth * expected.height / expected.width - preview.naturalHeight) > 2) return null
    return { src: preview.src, width: preview.naturalWidth, height: preview.naturalHeight }
  })()`))
}
function assertThumbnail(preview: { src: string; width: number; height: number }, full: NativeImage) {
  const size = full.getSize()
  assert.ok(Math.abs(preview.width * size.height / size.width - preview.height) <= 2, 'preview aspect ratio must follow accepted long-image pixels')
  // Probe the underlying row colors, well inside the source image and away from
  // text boundaries. Different color bands detect blank, stale or repeated art.
  const thumb = nativeImage.createFromDataURL(preview.src).toBitmap()
  const source = full.resize({ width: preview.width, height: preview.height }).toBitmap()
  let matches = 0, count = 0
  for (let y = 3; y < preview.height - 3; y += 4) {
    for (let x = 3; x < preview.width - 3; x += 5) {
      const i = (preview.width * y + x) * 4
      if (![0, 1, 2].every(c => [-2, 2, -2 * preview.width, 2 * preview.width].every(d => Math.abs(source[i + c] - source[i + d * 4 + c]) < 3))) continue
      if ([0, 1, 2].every(c => Math.abs(thumb[i + c] - source[i + c]) <= 8)) matches++
      count++
    }
  }
  assert.ok(count >= 8 && matches / count > .95, `thumbnail must show accepted source rows (${matches}/${count})`)
}
async function run() {
  await app.whenReady()
  native = new NativeDesktop({ executablePath: process.env.CAPTURE_SEQUENCE_HELPER!, connectTimeoutMs: 15000, requestTimeoutMs: 15000 })
  const area = screen.getPrimaryDisplay().workArea
  source = new BrowserWindow({ x: area.x + 40, y: area.y + 40, width: Math.min(area.width, 1060), height: Math.min(area.height - 60, 750), webPreferences: { backgroundThrottling: false } })
  source.setAlwaysOnTop(true, 'floating')
  const rows = Array.from({ length: 24 }, (_, i) => `<section style="height:85px;box-sizing:border-box;padding:14px 24px;background:hsl(${i * 47 % 360} 30% 92%);color:#213044;border-bottom:1px solid #aebbc7"><b>${i + 1} · Capture evidence</b><div>Scroll the real source while the original screenshot surface stays in place.</div><small id="counter-${i}">Screen capture</small></section>`).join('')
  await source.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body style="margin:0;font:14px/1.5 system-ui;user-select:none"><main style="height:calc(100vh + 85px);overflow:clip">' + rows + '</main></body>'))
  await js(source, "window.sourceClicks=0;window.sourceWheels=[];window.scrollSettled=false;document.addEventListener('scrollend',()=>{window.scrollSettled=true});document.body.addEventListener('pointerdown',()=>{window.sourceClicks++;document.querySelector('#counter-4').textContent='Click received'});document.body.addEventListener('wheel',e=>window.sourceWheels.push(e.deltaY),{passive:true})")
  const bounds = source.getContentBounds(), rect = { x: bounds.x + 32, y: bounds.y + 32, width: 480, height: 260 }
  surface = new CaptureSurface({ appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }), native: () => native,
    returnFocus: () => {}, copyText: async () => {}, pin: async () => { throw new Error('Not used') } })
  let observeCandidate: ((image: NativeImage) => void) | undefined
  const sampling = {
    captureScreenshot: async (params: Parameters<NativeDesktop['captureScreenshot']>[0]) => {
      const observer = observeCandidate
      const result = await native.captureScreenshot(params)
      if (observer && result.screenshot) observer(nativeImage.createFromBuffer(Buffer.from(result.screenshot.data, 'base64')))
      return result
    }
  }
  async function sourcePixels(selection: Rectangle) {
    return nativeImage.createFromBuffer((await source.webContents.capturePage({
      x: selection.x - bounds.x, y: selection.y - bounds.y, width: selection.width, height: selection.height
    })).toPNG())
  }
  const owner = new CaptureSequenceOwner({ directory: join(out, 'captures'), home: join(out, 'home'), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }), native: () => sampling,
    select: async mode => {
      const outcome = await surface.present({ attachToDraft: false, expandable: false, ...(mode === 'scroll' ? { sequenceMode: mode } : {}), returnFocus: false, complete: async () => {} })
      return outcome.state === 'sequence' ? outcome : null
    } })
  let delivered: any
  const capture = new ScreenCapture({ home: join(out, 'home'), appActive: () => true, native: () => native, present: session => surface.present(session),
    sequence: (mode, selection) => owner.edit(mode, selection), edit: async image => { delivered = image }, reportIssue: error => { throw error } })
  const overlays = () => BrowserWindow.getAllWindows().filter(window => window !== source && window.webContents.getURL().includes('screenshot-editor'))
  async function selectAndStart(publicEntry: boolean) {
    const overlay = await until('original screenshot overlay', () => overlays().find(window => window.webContents.getURL().includes('index.html')))
    await until('frozen screenshot presented', () => overlay.isVisible() && js(overlay, "document.querySelector('img[alt=\"Captured image\"]')?.naturalWidth > 0"))
    const offset = overlay.getBounds()
    overlay.webContents.debugger.attach('1.3')
    // A virtual touch has its own pointer identity; trackpad motion during this
    // fixture cannot move the test's pen to another native window mid-drag.
    await overlay.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const from = { x: rect.x - offset.x, y: rect.y - offset.y, id: 1 }
    const to = { x: from.x + rect.width, y: from.y + rect.height, id: 1 }
    for (const [type, touchPoints] of [['touchStart', [from]], ['touchMove', [to]], ['touchEnd', []]] as const)
      await overlay.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints })
    await overlay.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    await until('selection toolbar', () => js(overlay, "!!document.querySelector('.image-annotation-editor__capture-bar')"))
    if (!publicEntry) await click(overlay, 'Scrolling')
    await until('scrolling Start is ready', () => js(overlay, "[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Start scrolling capture'&&!b.disabled)"))
    const originalWindows = BrowserWindow.getAllWindows().map(window => window.id).sort()
    const toolbar = await js(overlay, "document.querySelector('.image-annotation-editor__capture-bar').getBoundingClientRect().toJSON()")
    if (publicEntry) await click(overlay, 'Start scrolling capture')
    else {
      const start = await js(overlay, `(() => {
        const button = document.querySelector('button[aria-label="Start scrolling capture"]')
        const r = button.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, nativeTitle: button.closest('[title]')?.title }
      })()`)
      assert.equal(start.nativeTitle, undefined, 'Start must not create an unowned native tooltip')
      const startPoint = { x: Math.round(offset.x + start.x), y: Math.round(offset.y + start.y) }
      await routeTo(overlay, startPoint)
      await until('Start hint painted inside the owned overlay', () => js(overlay, `[...document.querySelectorAll('[role="tooltip"]')].some(el => el.textContent.includes('Start scrolling capture') && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getBoundingClientRect().width > 0)`))
      await clickAt(overlay, startPoint)
      result.observations.push({ startHover: 'visible in capture overlay', nativeTitle: false })
    }
    await until('original overlay became live without a new window', async () => {
      assert.deepEqual(BrowserWindow.getAllWindows().map(window => window.id).sort(), originalWindows, 'Start must not create a capture, preview or border window')
      return await js(overlay, "!!document.querySelector('.capture-live-toolbar')")
    })
    assert.equal(await js(overlay, "!!document.querySelector('.image-annotation-editor') || !!document.querySelector('.capture-live-controls')"), false, 'frozen pixels, dim and separate preview are absent')
    const liveAnchor = await js(overlay, "(()=>{const r=document.querySelector('.capture-live-toolbar').getBoundingClientRect();return {right:r.right,top:r.top}})()")
    assert.ok(Math.abs(liveAnchor.right - toolbar.x - toolbar.width) < 1 && Math.abs(liveAnchor.top - toolbar.y) < 1, 'the original toolbar anchor remains in place: ' + JSON.stringify({ toolbar, liveAnchor }))
    result.observations.push({ entry: publicEntry ? 'public' : 'gui', originalOverlayId: overlay.id, originalWindows, startWindowIds: BrowserWindow.getAllWindows().map(window => window.id).sort(), originalToolbar: toolbar, liveAnchor })
    return overlay
  }
  const closed = capture.capture(false)
  void closed.catch(error => { result.captureFailure = { name: error.name, message: error.message } })
  const overlay = await selectAndStart(false)
  const originalWindows = BrowserWindow.getAllWindows().map(window => window.id)
  const sourceSelection = await js(overlay, 'window.captureSequence.load().then(s=>s.source)')
  const selected = sourceSelection.rect
  await until('fresh native baseline before input', () => js(overlay, 'window.captureSequence.load().then(s=>s.frames[0].capturedAt>s.source.capturedAt)'))
  const firstPreview = await readPreview(overlay)
  const firstGuiSource = await sourcePixels(selected)
  assertThumbnail(firstPreview, firstGuiSource)
  const sourcePoint = { x: Math.round(selected.x + selected.width / 2), y: Math.round(selected.y + selected.height / 2) }
  await writeFile(join(out, 'awaiting-input.json'), JSON.stringify({ phase: 'source-input', pid: process.pid, sourceBounds: source.getBounds(), requested: rect, selected, sourcePoint, overlayId: overlay.id }))
  const initialOffset = await js(source, 'document.scrollingElement.scrollTop')
  if (!humanInput) {
    const sourceHit = await clickAt(source, sourcePoint)
    const { at } = await routeTo(source, sourcePoint)
    source.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY: -85, ...at })
    result.observations.push({ input: 'WindowServer hit test and Electron input', sourceHit, sourcePoint })
  }
  await until('source received click and wheel', () => js(source, 'window.sourceClicks===1&&window.sourceWheels.length>0&&window.scrollSettled&&document.scrollingElement.scrollTop>0'), humanInput)
  await until('actual scrolled pixels accepted', async () => (await js(overlay, 'window.captureSequence.load()')).frames.length >= 2)
  const sourceInput = await js(source, '({clicks:window.sourceClicks,wheels:window.sourceWheels,scroll:document.scrollingElement.scrollTop})')
  assert.ok(sourceInput.scroll > initialOffset, 'the original source must actually scroll after input')
  const lastGuiSource = await sourcePixels(selected)
  const expectedGuiSize = {
    width: firstGuiSource.getSize().width,
    height: firstGuiSource.getSize().height + Math.round((sourceInput.scroll - initialOffset) * sourceSelection.scale)
  }
  // scrollend settles the source, while accepted native exposures can still lag behind it.
  const nextPreview = await readPreview(overlay, firstPreview.src, expectedGuiSize)
  const chromeBounds = await js(overlay, `[...document.querySelectorAll('.capture-live-toolbar, .capture-live-preview')].map(el => el.getBoundingClientRect().toJSON())`)
  const overlayFrame = overlay.getBounds()
  const left = Math.max(0, Math.min(selected.x, ...chromeBounds.map((r: DOMRect) => overlayFrame.x + r.left)) - 8)
  const top = Math.max(0, Math.min(selected.y, ...chromeBounds.map((r: DOMRect) => overlayFrame.y + r.top)) - 8)
  const shotRect = { x: Math.floor(left), y: Math.floor(top),
    width: Math.ceil(Math.max(selected.x + selected.width, ...chromeBounds.map((r: DOMRect) => overlayFrame.x + r.right)) - left + 8),
    height: Math.ceil(Math.max(selected.y + selected.height, ...chromeBounds.map((r: DOMRect) => overlayFrame.y + r.bottom)) - top + 8) }
  // The actual overlay is capture-protected. Allow photos of this fixture's own
  // synthetic surface only, then restore protection before testing delivery.
  const stop = await js(overlay, "document.querySelector('.capture-live-toolbar button.primary-button').getBoundingClientRect().toJSON()")
  const stopGlobal = { x: Math.round(overlayFrame.x + stop.left + stop.width / 2), y: Math.round(overlayFrame.y + stop.top + stop.height / 2) }
  if (!humanInput) await routeTo(overlay, stopGlobal)
  overlay.setContentProtection(false)
  try {
    const shots = []
    for (const theme of ['dark', 'light']) {
      await js(overlay, `window.setCaptureFixtureTheme('${theme}')`)
      await js(overlay, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const stopStyle = await js(overlay, `(() => {
        const button = document.querySelector('.capture-live-toolbar button.primary-button')
        const style = getComputedStyle(button)
        return { disabled: button.disabled, hovered: button.matches(':hover'), text: style.color, background: style.backgroundColor }
      })()`)
      assert.equal(stopStyle.disabled, false, 'stable recording must allow Stop')
      if (!humanInput) assert.equal(stopStyle.hovered, true, 'composed screenshot must exercise the enabled Stop hover appearance')
      result.observations.push({ theme, stopStyle })
      const file = `scroll-inline-${theme}.png`
      await execute('/usr/sbin/screencapture', ['-x', '-R' + [shotRect.x, shotRect.y, shotRect.width, shotRect.height].join(','), join(out, file)])
      result.screenshots.push(file)
      shots.push(nativeImage.createFromPath(join(out, file)).toBitmap())
    }
    assert.ok(shots[0].length > 0 && !shots[0].equals(shots[1]), 'both themes must be visible in the composed desktop screenshots')
  } finally {
    overlay.setContentProtection(true)
  }
  await writeFile(join(out, 'awaiting-stop.json'), JSON.stringify({ phase: 'toolbar-stop', stopGlobal, screenshot: 'scroll-inline-dark.png' }))
  if (!humanInput) {
    const stopHit = await clickAt(overlay, stopGlobal)
    result.observations.push({ stopHit, stopGlobal })
  }
  const review = await until('Stop opened review', () => BrowserWindow.getAllWindows().find(window => window !== source && !originalWindows.includes(window.id)), humanInput)
  await until('review ready', () => js(review, "document.body.textContent.includes('Confirm') && !document.querySelector('button.primary-button').disabled"))
  assert.equal(overlay.isVisible(), false, 'the original surface is retained hidden for Resume until this original operation ends')
  await click(review, 'Confirm'); await closed
  const guiImage = nativeImage.createFromDataURL(delivered.dataUrl)
  assert.deepEqual(guiImage.getSize(), expectedGuiSize, 'the confirmed PNG includes the settled scroll distance')
  assertThumbnail(nextPreview, guiImage)
  assertStitchedSource(guiImage, firstGuiSource, lastGuiSource, 'Confirmed GUI PNG')
  result.observations.push({ acceptedPreview: [[firstPreview.width, firstPreview.height], [nextPreview.width, nextPreview.height]] })
  assert.equal(delivered.height, Math.round((selected.height + sourceInput.scroll - initialOffset) * sourceSelection.scale), 'the original editor gets the actual native long image')
  await until('confirm released original windows', () => review.isDestroyed() && overlay.isDestroyed())
  assert.deepEqual(BrowserWindow.getAllWindows().map(window => window.id), [source.id], 'delivery releases all original overlays and the review')
  result.observations.push({ physicalInput: humanInput, toolbarStopped: true, sourceInput, originalEditor: true, guiOutput: [delivered.width, delivered.height] })

  // The public selector uses the same original surface, without a GUI-only handoff shortcut.
  await js(source, 'window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const service = new AgentMuxRpcService({ coreClients: () => [], sequences: owner }), input = { hostId: 'local', operationId: 'inline-public-scroll', mode: 'scroll' as const }, context = { principal: { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` } }
  assert.equal((await service.call('capture.sequence.open', input, context)).state, 'selecting')
  const identity = { hostId: input.hostId, operationId: input.operationId }
  const publicOverlay = await selectAndStart(true)
  const publicSelection = await js(publicOverlay, 'window.captureSequence.load().then(s=>s.source)')
  await until('public native baseline', async () => await js(publicOverlay, 'window.captureSequence.load().then(s=>s.frames[0].capturedAt>s.source.capturedAt)'))
  const firstSource = await sourcePixels(publicSelection.rect)
  const surfaceBounds = publicOverlay.getBounds()
  // Force the real preview over the selected region on this controlled source.
  // Disable OS capture protection on this fixture only so explicit window
  // exclusion has to work even when the host capture API can see the chrome.
  await readPreview(publicOverlay)
  await js(publicOverlay, `(() => {
    const preview = document.querySelector('.capture-live-preview')
    Object.assign(preview.style, {position:'fixed', left:'${publicSelection.rect.x - surfaceBounds.x + 12}px', top:'${publicSelection.rect.y - surfaceBounds.y + 12}px', right:'auto', bottom:'auto', transform:'none'})
    return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  })()`)
  const overlap = await js(publicOverlay, "document.querySelector('.capture-live-preview img').getBoundingClientRect().toJSON()")
  assert.ok(overlap.width >= 12 && overlap.height >= 12 && overlap.left + surfaceBounds.x >= publicSelection.rect.x && overlap.top + surfaceBounds.y >= publicSelection.rect.y &&
    overlap.left + surfaceBounds.x + 12 < publicSelection.rect.x + publicSelection.rect.width && overlap.top + surfaceBounds.y + 12 < publicSelection.rect.y + publicSelection.rect.height, 'visible preview must actually overlap the native source')
  publicOverlay.setContentProtection(false)
  try {
    let candidate: NativeImage | undefined
    observeCandidate = image => { candidate = image }
    const sampled = await until('native sample with overlapping preview', () => candidate)
    assertSourcePixels(sampled.toBitmap(), firstSource.toBitmap(), 'Native sample with overlapping preview')
  } finally {
    observeCandidate = undefined
    publicOverlay.setContentProtection(true)
  }
  await js(source, 'window.scrollTo(0,85);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await until('public changed native frame', async () => (await service.call('capture.sequence.inspect', identity, context)).frameCount >= 2)
  const afterScroll = await sourcePixels(publicSelection.rect)
  const accepted = await js(publicOverlay, 'window.captureSequence.load().then(s=>s.frames.at(-1).image.dataUrl)')
  assertSourcePixels(nativeImage.createFromDataURL(accepted).toBitmap(), afterScroll.toBitmap(), 'Accepted native frame')
  await service.call('capture.sequence.stop', identity, context)
  const publicReview = await until('public review', () => BrowserWindow.getAllWindows().find(window => window !== source && window !== publicOverlay && !window.webContents.getURL().startsWith('data:') && window.isVisible()))
  await until('public review ready', () => js(publicReview, "document.body.textContent.includes('Confirm') && !document.querySelector('button.primary-button').disabled"))
  await click(publicReview, 'Confirm')
  await until('public artifact completed', async () => (await service.call('capture.sequence.inspect', identity, context)).state === 'completed')
  const artifact = await service.call('capture.sequence.read', identity, context)
  const image = nativeImage.createFromBuffer(Buffer.from(artifact.artifact!.data, 'base64'))
  assert.equal(image.getSize().height, Math.round((publicSelection.rect.height + 85) * publicSelection.scale))
  assertStitchedSource(image, firstSource, afterScroll, 'Exported public PNG')
  result.observations.push({ cleanNativeAndExportedPixels: true, forcedPreviewOverlap: overlap })
  result.observations.push({ publicOpenInspectStopRead: true, publicOutput: image.getSize(), originalOperationsPreserved: true })
  result.passed = true
}
void run().catch(error => { result.failure = { name: error.name, message: error.message, stack: error.stack } }).finally(async () => {
  if (originalCursor && lastWarp) {
    const now = screen.getCursorScreenPoint()
    if (now.x === lastWarp.x && now.y === lastWarp.y) await nativeWindowAt(originalCursor, true).catch(() => {})
  }
  surface?.dispose(); await native?.dispose(); source?.destroy()
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1)
})
