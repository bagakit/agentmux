import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { SystemScreenshotEditor } from '../../../src/main/system-screenshot-editor'
import type { CaptureBackground } from '../../../src/shared/capture-surface'
import type { BrowserPng } from '../../../src/shared/contracts'

const out = process.env.AGENTMUX_CAPTURE_SURFACE_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const protectionAtShow = new WeakMap<BrowserWindow, boolean[]>()
app.on('browser-window-created', (_event, window) => {
  const showInactive = window.showInactive.bind(window)
  window.showInactive = () => {
    const states = protectionAtShow.get(window) ?? []
    states.push(window.isContentProtected())
    protectionAtShow.set(window, states)
    showInactive()
  }
})
const receipt: any = { passed: false, boundary: 'Production CaptureSurface, isolated preload, Renderer, shared editor and PNG composition in real Electron. Only native screen pixels/window geometry and clipboard/pin sinks are controlled; no OS screen recording, user clipboard, physical multi-monitor/TCC, packaging or installation proof.', cases: [], screenshots: [], timings: [], grabs: [], opacityChanges: [] }
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 960, height: 640 }, scaleFactor: 1, displayFrequency: 60 },
  { id: 7, bounds: { x: 960, y: 0, width: 800, height: 600 }, scaleFactor: 1, displayFrequency: 60 }]
let surface: CaptureSurface, editor: SystemScreenshotEditor, host: BrowserWindow, current: BrowserWindow
const originalInfo = console.info
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('capture-surface timing ')) receipt.timings.push(JSON.parse(args[0].slice('capture-surface timing '.length)))
  originalInfo(...args)
}
const sources = new Map<string, BrowserPng>(), deliveries: any[] = []
let deliveryGate: Promise<void> | null = null
async function waitFor<T>(label: string, read: () => Promise<T>): Promise<NonNullable<T>> {
  const started = performance.now()
  while (performance.now() - started < 10000) {
    const result = await read()
    if (result) return result as NonNullable<T>
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('Timed out: ' + label)
}
async function evaluate<T = any>(script: string): Promise<T> { try { return await current.webContents.executeJavaScript(script) } catch (error) { process.stderr.write('Failed renderer script: '+script+'\n'); throw error } }
async function isolatePointerEvents() {
  await evaluate(`window.captureEvents=[];for(const type of ['pointermove','pointerdown','pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,event=>{if(event.pointerType!=='pen'){event.stopImmediatePropagation();return}window.captureEvents.push({type,x:event.clientX,y:event.clientY,target:event.target.tagName,button:event.button,trusted:event.isTrusted})},true)`)
}
async function settle() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
async function mouse(type: string, x: number, y: number, buttons = 0) {
  await current.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function key(key: string, code: string, virtual: number, modifiers = 0) {
  await current.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers })
  if (!current.isDestroyed()) await current.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers })
}
async function click(name: string, awaitReply = true) {
  const point = await waitFor('available control ' + name, async () => await evaluate(`(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:false}})()`))
  assert.equal(point.disabled, false, name + ' is available')
  await mouse('mouseMoved', point.x, point.y); await pointerClick(point, awaitReply)
  if (awaitReply && !current.isDestroyed() && !['Done', 'Cancel', 'Expand editor'].includes(name)) await settle()
}
async function sourcePoint(x: number, y: number) {
  return await evaluate<{x:number;y:number}>(`(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),m=c.getContext('2d').getTransform(),d=c.width/r.width;return {x:r.x+(m.e+m.a*${x})/d,y:r.y+(m.f+m.d*${y})/d}})()`)
}
async function drag(x: number, y: number, width: number, height: number) {
  const a = await sourcePoint(x, y), b = await sourcePoint(x + width, y + height)
  await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y, 1)
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', a.x + (b.x-a.x)*step/8, a.y + (b.y-a.y)*step/8, 1)
  await mouse('mouseReleased', b.x, b.y); await settle()
}
async function pointerClick(point: { x: number; y: number }, awaitReply = true) {
  const target = current
  const pressed = target.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1 })
  const released = target.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, pointerType: 'pen', button: 'left', buttons: 0, clickCount: 1 })
  const completion = Promise.all([pressed, released.catch(error => { if (!target.isDestroyed()) throw error })])
  // CDP preserves this command order; a window transition has its own business receipt instead of an old-window mouse reply.
  if (awaitReply) await completion
  else void completion.catch(error => { receipt.captureError = String(error) })
}
async function clickPoint(x: number, y: number) {
  const point = await sourcePoint(x, y)
  await mouse('mouseMoved', point.x, point.y); await pointerClick(point); await settle()
}
async function switchedTo(background: CaptureBackground) {
  await key('Tab', 'Tab', 9)
  await waitFor('the other already frozen source is displayed', async () => await evaluate(`document.querySelector('img')?.src===${JSON.stringify(sources.get(background + ':1')!.dataUrl)}`))
  await settle()
}
async function loupeMatchesSource(background: CaptureBackground): Promise<boolean> {
  const observed = await evaluate(`(()=>{const root=document.querySelector('.image-annotation-editor__loupe');if(!root)return null;const spans=root.querySelectorAll(':scope > span');
    return {hex:spans[0]?.firstChild?.textContent,rgb:spans[0]?.querySelector('span')?.textContent?.split(',').map(Number),
      point:spans[2]?.textContent?.replace(/[^0-9,-]/g,'').split(',').map(Number)}})()`)
  if (!observed) return true
  const [x,y] = observed.point ?? []
  if (typeof observed.hex !== 'string' || observed.rgb?.length !== 3 || !Number.isInteger(x) || !Number.isInteger(y)) return false
  const source = sources.get(background + ':1')!, image = nativeImage.createFromDataURL(source.dataUrl), size = image.getSize()
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return false
  const bytes = image.toBitmap(), offset = (y * size.width + x) * 4, first = bytes[offset]!, green = bytes[offset + 1]!, third = bytes[offset + 2]!
  if (bytes[offset + 3] !== 255) return false
  // nativeImage's channel order is platform-owned; accept only an exact source sample in its actual order.
  return [[first, green, third], [third, green, first]].some(rgb => observed.rgb.every((value, index) => value === rgb[index])
    && observed.hex === '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase())
}
async function sceneMarkPixels(): Promise<number> {
  return await evaluate(`(()=>{const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]>180&&p[i+1]<130&&p[i+2]<130&&p[i+3]>245)count++;return count})()`)
}
async function shot(name: string) {
  process.stdout.write('capture-proof: '+name+'\n')
  await settle()
  const file = name + '.png'
  await writeFile(join(out, file), (await current.webContents.capturePage()).toPNG())
  receipt.screenshots.push({ file, contentSize: current.getContentSize() })
}
async function sourceImages() {
  const drawing = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await drawing.loadURL('data:text/html,<body><canvas></canvas>')
  for (const display of displays) for (const background of ['included', 'excluded'] as const) {
    const { width, height } = display.bounds
    const dataUrl = await drawing.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas');c.width=${width};c.height=${height};const x=c.getContext('2d');
      x.fillStyle=${JSON.stringify(background === 'included' ? '#c9e6ef' : '#f0dfc9')};x.fillRect(0,0,c.width,c.height);
      x.fillStyle='#334757';x.fillRect(0,0,c.width,30);x.fillStyle='#e3edf3';x.font='12px -apple-system';x.fillText('Workspace review · frozen desktop',20,20);
      x.fillStyle='#ffffff';x.fillRect(80,92,c.width-160,c.height-170);x.fillStyle='#304c5d';x.font='600 26px -apple-system';x.fillText('Project overview',112,138);
      x.font='15px -apple-system';x.fillStyle='#718391';x.fillText('Review findings, annotate and share.',112,166);
      for(let i=0;i<3;i++){x.fillStyle=['#dbece8','#e0e7f5','#eee3d5'][i];x.fillRect(112+i*205,200,180,84);x.fillStyle='#38555f';x.font='600 23px -apple-system';x.fillText(['86%','24','12'][i],130+i*205,236);x.font='12px -apple-system';x.fillText(['Completion','Contributors','Validated ideas'][i],130+i*205,264)}
      ${background === 'included' ? "x.fillStyle='#1b2630';x.fillRect(460,310,350,230);x.fillStyle='#a7bbca';x.font='600 14px -apple-system';x.fillText('AgentMux',480,340);x.fillStyle='#e4edf3';x.font='15px -apple-system';x.fillText('Capture includes this workbench',480,385);x.fillStyle='#344955';x.fillRect(480,420,310,66);x.fillStyle='#a9bdca';x.font='13px -apple-system';x.fillText('Draft remains in its original input',495,452);" : "x.fillStyle='#718391';x.font='14px -apple-system';x.fillText('Desktop without AgentMux windows',112,370);"}
      return c.toDataURL('image/png')})()`)
    sources.set(background + ':' + display.id, { mimeType: 'image/png', dataUrl, width, height, byteLength: Buffer.byteLength(dataUrl.split(',')[1]!, 'base64') })
  }
  drawing.destroy()
}
async function waitOpen(background: CaptureBackground, before: Set<BrowserWindow>, expectedCrop: { displayId: number; crop: { x: number; y: number; width: number; height: number } } | undefined, firstGrab: number) {
  const start = performance.now()
  const overlays = await waitFor('production overlays allocated', async () => {
    if (receipt.captureError) throw new Error(receipt.captureError)
    const fresh = BrowserWindow.getAllWindows().filter(candidate => !before.has(candidate))
    return fresh.length === displays.length ? fresh : null
  })
  current = overlays.find(window => window.getBounds().x === 0)!
  const infos: any[] = []
  for (const overlay of overlays) {
    await waitFor('every production overlay painted and shown', async () => {
      if (receipt.captureError) throw new Error(receipt.captureError)
      try { return overlay.isVisible() && await overlay.webContents.executeJavaScript(`document.querySelector('img')?.naturalWidth>0&&document.querySelector('canvas')?.width>0`) } catch { return false }
    })
    infos.push(await overlay.webContents.executeJavaScript(`window.captureSurface.load()`))
  }
  const grabs = receipt.grabs.slice(firstGrab)
  // Record the real opened scene before any oracle can reject it; an empty executed set is never a mutation kill.
  receipt.cases.push({ label: expectedCrop ? 'retake-continuation' : 'opened-' + background, elapsedMs: performance.now()-start, displays: overlays.length, grabs })
  assert.deepEqual(overlays.map(window => protectionAtShow.get(window)), [[true], [true]], 'every real overlay is protected before showInactive')
  assert.equal(host.getOpacity(), 0.65, 'the visible host keeps its exact prior opacity while editing')
  assert.equal(receipt.opacityChanges.length, 0, 'CaptureSurface never writes host opacity')
  assert.deepEqual(grabs.map((row: any) => row.includeHostWindows), [background === 'included', background === 'excluded'], 'the selected background leads and the alternate follows once')
  assert.deepEqual(grabs.map((row: any) => row.opacity), [0.65, 0.65], 'both native exposures observe the unchanged host')
  for (const [index, overlay] of overlays.entries()) {
    assert.equal(infos[index].background, background)
    assert.deepEqual(infos[index].initialCrop, infos[index].displayId === expectedCrop?.displayId ? expectedCrop.crop : undefined,
      expectedCrop ? 'only the explicit same-capture Retake receives its crop' : 'every fresh capture starts without initialCrop')
    const actualSource = await overlay.webContents.executeJavaScript(`document.querySelector('img').src`)
    assert.ok(actualSource === sources.get(background + ':' + infos[index].displayId)!.dataUrl, 'the actual editor image is the requested frozen source')
  }
  current.webContents.debugger.attach('1.3')
  current.webContents.on('console-message', event => process.stdout.write('renderer: '+event.message+'\n'))
  await isolatePointerEvents()
  await settle()
  assert.equal(await evaluate('typeof window.agentmux'), 'undefined', 'capture never receives the full application bridge')
  return { overlays, infos }
}
async function open(background: CaptureBackground, expandable = true) {
  const before = new Set(BrowserWindow.getAllWindows()), firstGrab = receipt.grabs.length
  const outcome = surface.present({ background, attachToDraft: false, expandable, returnFocus: false,
    complete: async (image, source, engine) => {
      const delivery = { image, source, engine, settled: false }
      deliveries.push(delivery)
      const gate = deliveryGate
      deliveryGate = null
      if (gate) await gate
      delivery.settled = true
    } })
  void outcome.catch(error => { receipt.captureError = String(error); process.stderr.write('Capture outcome failed: ' + String(error?.stack ?? error) + '\n') })
  const { overlays } = await waitOpen(background, before, undefined, firstGrab)
  return { outcome, overlays }
}
async function run() {
  await app.whenReady()
  screen.getAllDisplays = (() => displays) as typeof screen.getAllDisplays
  screen.getDisplayNearestPoint = (() => displays[0]) as unknown as typeof screen.getDisplayNearestPoint
  screen.getCursorScreenPoint = () => ({ x: 200, y: 150 })
  await sourceImages()
  host = new BrowserWindow({ width: 640, height: 460, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body style="font:18px -apple-system;padding:32px;background:%231b2630;color:%23e4edf3"><h2>AgentMux test workbench</h2><p>Original window opacity: 65%</p>')
  host.setOpacity(0.65)
  const setHostOpacity = host.setOpacity.bind(host)
  host.setOpacity = value => { receipt.opacityChanges.push({ value, observedMs: performance.now() }); setHostOpacity(value) }
  surface = new CaptureSurface({ native: () => ({ captureDisplays: async ({ includeHostWindows = false } = {}) => {
    const background: CaptureBackground = includeHostWindows ? 'included' : 'excluded', capturedAt = Date.now()
    receipt.grabs.push({ includeHostWindows, opacity: host.getOpacity(), capturedAt, observedMs: performance.now() })
    return { state: 'captured' as const, capturedAt, timing: { contentMs: 1, windowListMs: 1, responseSerializationMs: 1, totalMs: 3, lazyConnectionMs: 1, socketReadMs: 1, jsonParseMs: 1, requestMs: 4, validationMs: 1 }, displays: displays.map(display => {
      const image = sources.get(background + ':' + display.id)!
      return { displayId: display.id, frame: display.bounds, scale: 1, safeTop: 0, timing: { captureMs: 1, pngMs: 1, base64Ms: 0, totalMs: 2 },
        windows: includeHostWindows ? [{ windowId: 1, frame: { x: display.bounds.x + 460, y: 310, width: 350, height: 230 } }] : [],
        png: image.dataUrl.split(',')[1]!, width: image.width, height: image.height, engine: 'controlled-' + background }
    }) }
  } }), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    pin: async () => { throw new Error('Pin is outside this bounded capture fixture.') }, copyText: async () => {}, returnFocus: () => {} })
  editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: 'dark' }), {
    pin: async () => { throw new Error('Pin is outside this fixture.') }, inspectPin: async () => { throw new Error('No pin operation.') }, copyText: async () => {}
  })
  for (const background of ['included', 'excluded'] as const) {
    const { outcome, overlays } = await open(background)
    await shot('opened-' + background)
    if (background === 'included') {
      const grabs = receipt.grabs.length, opacities = receipt.opacityChanges.length
      const point = await sourcePoint(500, 350)
      await mouse('mouseMoved', point.x, point.y)
      await clickPoint(500, 350)
      assert.equal(await evaluate(`document.querySelector('[aria-label="Selection size"]')?.textContent`), '350 × 230 px', 'the included window geometry supplies the clicked selection')
      await key('z', 'KeyZ', 90, 4); await settle()
      assert.equal(await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')`), null, 'undo restores the empty selection before testing the other geometry')
      await mouse('mouseMoved', point.x + 1, point.y); await shot('window-highlight-included')
      await switchedTo('excluded')
      // No new CDP mouse is sent after Tab, but focus changes may deliver a native pointermove with a fresh sample.
      await waitFor('Tab never keeps a sample from the old frozen source', () => loupeMatchesSource('excluded'))
      await shot('window-highlight-excluded')
      await clickPoint(500, 350)
      assert.equal(await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')`), null, 'the excluded background has no AgentMux window to select at that point')
      await switchedTo('included')
      assert.equal(receipt.grabs.length, grabs, 'geometry switches only consume the already frozen frames')
      assert.equal(receipt.opacityChanges.length, opacities, 'geometry switches never write host opacity')
      receipt.cases.push({ label: 'tab-switches-accurate-window-geometry-without-recapture', grabs, opacityChanges: opacities })
    }
    if (!await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')!==null`)) await drag(130, 178, 690, 380)
    assert.ok(await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')!==null`), 'actual drag created a crop: '+JSON.stringify(await evaluate('window.captureEvents')))
    await click('Rectangle'); await drag(180, 300, 230, 40)
    await shot('marked-' + background)
    const before = deliveries.length
    await click('Done'); assert.deepEqual(await outcome, { state: 'completed' })
    assert.equal(deliveries.length, before + 1, 'Done invokes the production completion exactly once')
    const delivered = deliveries.at(-1), bitmap = nativeImage.createFromDataURL(delivered.image.dataUrl), pixels = bitmap.toBitmap()
    assert.deepEqual(bitmap.getSize(), { width: 690, height: 380 }, 'the shared composition actually crops the selected pixels')
    let marked = 0
    for (let offset=0;offset<pixels.length;offset+=4) if (pixels[offset+2]! > 180 && pixels[offset+1]! < 130 && pixels[offset]! < 130 && pixels[offset+3]! > 245) marked++
    assert.ok(marked > 900, 'actual colored Rectangle stroke survives the final PNG: '+marked)
    assert.equal(delivered.engine, 'controlled-' + background)
    assert.equal(delivered.source.capturedAt, receipt.grabs.slice(-2).find((row: any) => row.includeHostWindows === (background === 'included')).capturedAt)
    assert.deepEqual(delivered.source.rect, { x: 130, y: 178, width: 690, height: 380 })
    assert.ok(overlays.every(window => window.isDestroyed()), 'a confirmed output destroys only this capture overlays')
    assert.equal(host.getOpacity(), 0.65, 'Done leaves the original host opacity untouched')
    await writeFile(join(out, 'composed-' + background + '.png'), bitmap.toPNG())
    receipt.cases.push({ label: 'composed-' + background, size: bitmap.getSize(), markedPixels: marked, source: delivered.source, engine: delivered.engine })
  }
  const switching = await open('included')
  await drag(130, 178, 690, 380)
  await evaluate(`window.originalCaptureCanvas=document.querySelector('canvas')`)
  const grabCount = receipt.grabs.length, opacityCount = receipt.opacityChanges.length
  await click('Rectangle'); await drag(180, 300, 230, 40)
  const marksBefore = await sceneMarkPixels()
  assert.ok(marksBefore > 900, 'the actual mark exists before Tab')
  await switchedTo('excluded')
  assert.equal(await evaluate(`window.originalCaptureCanvas===document.querySelector('canvas')`), true, 'Tab preserves the same editor canvas and document')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Selection size"]')?.textContent`), '690 × 380 px', 'Tab preserves the original selection')
  let marksAfter = 0
  await waitFor('the new frozen source paints the existing annotations', async () => (marksAfter = await sceneMarkPixels()) >= marksBefore * .95 ? marksAfter : null)
  assert.ok(marksAfter >= marksBefore * .95, 'Tab preserves the existing annotation pixels')
  await key('z', 'KeyZ', 90, 4)
  let undone = 0
  await waitFor('Undo paints without the previous mark', async () => (undone = await sceneMarkPixels()) < marksAfter / 4 ? true : null)
  assert.ok(undone < marksAfter / 4, 'Undo still removes the mark created before Tab')
  await key('Z', 'KeyZ', 90, 4 | 8)
  let redone = 0
  await waitFor('Redo paints the same mark again', async () => (redone = await sceneMarkPixels()) >= marksAfter * .95 ? redone : null)
  assert.ok(redone >= marksAfter * .95, 'Redo restores the same mark after Tab')
  assert.equal(receipt.grabs.length, grabCount, 'Tab/Undo/Redo never ask Native for another frame')
  assert.equal(receipt.opacityChanges.length, opacityCount, 'Tab/Undo/Redo never alter the host opacity')
  await shot('tab-excluded-edit-history')
  await click('Done'); assert.deepEqual(await switching.outcome, { state: 'completed' })
  const switchedOutput = deliveries.at(-1), switchedBitmap = nativeImage.createFromDataURL(switchedOutput.image.dataUrl), switchedPixels = switchedBitmap.toBitmap()
  assert.equal(switchedOutput.engine, 'controlled-excluded')
  assert.equal(switchedOutput.source.capturedAt, receipt.grabs.at(-1).capturedAt)
  assert.deepEqual(switchedOutput.source.rect, { x: 130, y: 178, width: 690, height: 380 })
  const sample = (322 * switchedBitmap.getSize().width + 470) * 4
  assert.ok(switchedPixels[sample]! > 245 && switchedPixels[sample + 1]! > 245 && switchedPixels[sample + 2]! > 245, 'the final PNG uses excluded pixels where the included image had the AgentMux panel')
  assert.equal(host.getOpacity(), .65)
  receipt.cases.push({ label: 'actual-tab-keeps-crop-mark-undo-redo-and-copies-excluded-pixels', marksBefore, marksAfter, undone, redone, source: switchedOutput.source, engine: switchedOutput.engine })

  const cancelled = await open('excluded')
  await drag(150, 210, 520, 260)
  let releaseLate!: () => void
  deliveryGate = new Promise<void>(resolve => { releaseLate = resolve })
  const lateDelivery = deliveries.length
  await click('Done')
  await waitFor('the cancellable delivery is in flight', async () => deliveries.length === lateDelivery + 1 && !deliveries.at(-1).settled ? true : null)
  // Cancellation destroys this exact Renderer, so its JS response is not the operation receipt.
  await Promise.race([cancelled.outcome, evaluate('window.captureSurface.load().then(i=>window.captureSurface.cancel(i.requestId))')])
  assert.deepEqual(await cancelled.outcome, { state: 'cancelled' })
  assert.ok(cancelled.overlays.every(window => window.isDestroyed()))
  assert.equal(host.getOpacity(), 0.65, 'Cancel leaves the original host opacity untouched')
  releaseLate()
  await waitFor('the cancelled request late delivery returned', async () => deliveries.at(-1).settled ? true : null)
  await new Promise(resolve => setImmediate(resolve))
  receipt.cases.push({ label: 'cancel-isolates-late-delivery-and-keeps-host' })

  const expanded = await open('included')
  const nextInput = await evaluate('window.captureSurface.load()')
  assert.equal(nextInput.initialCrop, undefined, 'a cancelled request late result must not supply the next capture selection')
  if (!await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')!==null`)) await drag(130, 178, 690, 380)
  await click('Rectangle'); await drag(180, 300, 230, 40)
  const captureWindow = current
  await key('e', 'KeyE', 69, 4)
  const expandedOutcome = await expanded.outcome
  assert.equal(expandedOutcome.state, 'expanded')
  if (expandedOutcome.state !== 'expanded') throw new Error('The actual Command E must hand off its document')
  assert.equal(expandedOutcome.handoff.shapes.length, 1, 'the actual rectangle remains editable across the handoff')
  assert.equal(expandedOutcome.image.dataUrl, sources.get('included:1')!.dataUrl, 'the handoff retains the current full frozen source')
  assert.ok(expanded.overlays.every(window => window.isDestroyed()))
  const beforeEditors = new Set(BrowserWindow.getAllWindows())
  const editing = editor.edit(expandedOutcome.image, false, async image => { deliveries.push({ image, source: expandedOutcome.source, engine: 'expanded' }) },
    { source: expandedOutcome.source, initialState: expandedOutcome.handoff, initialTool: expandedOutcome.handoff.tool })
  void editing.catch(error => { receipt.editorError = String(error) })
  current = await waitFor('production expanded editor', async () => BrowserWindow.getAllWindows().find(window => !beforeEditors.has(window)))
  current.webContents.debugger.attach('1.3')
  await isolatePointerEvents()
  await waitFor('expanded editor decoded', async () => { try { return await evaluate(`document.querySelector('img')?.naturalWidth>0&&[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Copy'&&!b.disabled)`) } catch { return false } })
  await shot('expanded-included')
  assert.notEqual(current, captureWindow)
  assert.equal(host.getOpacity(), 0.65)
  await click('Copy'); await editing
  assert.deepEqual({ width: deliveries.at(-1).image.width, height: deliveries.at(-1).image.height }, { width: 690, height: 380 })
  current.destroy()
  receipt.cases.push({ label: 'actual-command-e-production-window-editor-preserves-rectangle-and-crop' })

  const product = new ScreenCapture({ home: out, appActive: () => true, native: () => ({
    captureScreenshot: async () => { throw new Error('This continuation fixture uses the shared capture surface only.') },
    writeClipboardImage: async image => { deliveries.push({ image, engine: 'same-capture-product' }) }
  }), edit: (...args) => editor.edit(...args), present: session => surface.present(session),
    reportIssue: issue => { (receipt.reportedIssues ??= []).push(String(issue)) } })
  const productBefore = new Set(BrowserWindow.getAllWindows()), productGrab = receipt.grabs.length
  const productPending = product.capture(false, 'selection', {}, 'included')
  void productPending.catch(error => { receipt.captureError = String(error) })
  await waitOpen('included', productBefore, undefined, productGrab)
  await drag(130, 178, 690, 380)
  await key('e', 'KeyE', 69, 4)
  const productEditor = await waitFor('same-capture independent editor', async () => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (productBefore.has(candidate) || candidate.isDestroyed()) continue
      try { if (await candidate.webContents.executeJavaScript(`typeof window.screenshotEditor==='object'`)) return candidate } catch {}
    }
    return null
  })
  current = productEditor
  current.webContents.debugger.attach('1.3')
  await isolatePointerEvents()
  await waitFor('same-capture editor decoded', async () => { try { return await evaluate(`document.querySelector('img')?.naturalWidth>0&&[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Copy'&&!b.disabled)`) } catch { return false } })
  const beforeProductCopy = deliveries.length
  process.stdout.write('capture-proof stage: product Copy begin\n')
  await click('Copy')
  await waitFor('same-capture editor Copy consumed', async () => deliveries.length === beforeProductCopy + 1 ? true : null)
  process.stdout.write('capture-proof stage: product Copy consumed\n')
  assert.equal(productEditor.isDestroyed(), false, 'Copy retains the original editable document')
  const beforeRetake = new Set(BrowserWindow.getAllWindows()), retakeGrab = receipt.grabs.length
  const continuedCrop = await evaluate('window.screenshotEditor.load().then(input=>input.initialState.crop)')
  process.stdout.write('capture-proof stage: Retake begin\n')
  await click('Retake', false)
  process.stdout.write('capture-proof stage: Retake dispatched\n')
  const retaken = await waitOpen('included', beforeRetake, { displayId: 1, crop: continuedCrop }, retakeGrab)
  assert.equal(retaken.infos[0].initialState, undefined, 'the Retake surface receives crop only, not editor shapes or Undo')
  await shot('retake-continuation')
  const retakeCancelled = waitFor('Retake cancellation destroys every overlay', () => retaken.overlays.every(window => window.isDestroyed()) ? true : null)
  await Promise.race([retakeCancelled, evaluate('window.captureSurface.load().then(i=>window.captureSurface.cancel(i.requestId))')])
  await retakeCancelled
  assert.equal(productEditor.isDestroyed(), false, 'cancelling Retake returns to the original editor')
  current = productEditor
  await key('Escape', 'Escape', 27)
  await productPending
  const fresh = await open('included')
  await Promise.race([fresh.outcome, evaluate('window.captureSurface.load().then(i=>window.captureSurface.cancel(i.requestId))')])
  assert.deepEqual(await fresh.outcome, { state: 'cancelled' })
  assert.equal(receipt.reportedIssues, undefined)
  receipt.cases.push({ label: 'actual-expand-copy-retake-continuation-then-empty-fresh-capture', crop: retaken.infos[0].initialCrop })
  surface.dispose(); editor.dispose(); host.destroy()
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  const timingGroups = new Map<string, any[]>()
  for (const timing of receipt.timings) {
    const group = timingGroups.get(timing.requestId) ?? []
    group.push(timing); timingGroups.set(timing.requestId, group)
  }
  assert.equal(timingGroups.size, 8, 'each actual capture surface has its own diagnostic identity')
  for (const group of timingGroups.values()) {
    assert.deepEqual(group.map(timing => timing.final), [false, true], 'each surface records its first show and its final alternate')
    assert.equal(group[1].shownMs, group[0].shownMs, 'the final diagnostic preserves the original first-show time')
  }
  assert.ok(receipt.timings.every((timing: any) => timing.framesMs>=0&&timing.shownMs>=timing.framesMs&&timing.presentedMs.length===2&&timing.presentedMs.every((value: any) => value === null ? timing.shownMs >= 1500 : typeof value==='number'&&value>=0&&value<=timing.shownMs)))
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  process.stderr.write(JSON.stringify(receipt.failure) + '\n')
  try { if (current && !current.isDestroyed()) {
    receipt.failure.dom = await evaluate('document.body.innerText'); receipt.failure.events = await evaluate('window.captureEvents')
    await Promise.race([shot('failure'), new Promise(resolve => setTimeout(resolve, 2000))])
  } } catch {}
}).finally(async () => {
  surface?.dispose(); editor?.dispose()
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
