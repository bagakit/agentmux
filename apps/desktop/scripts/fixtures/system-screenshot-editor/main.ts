import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { ScreenshotOriginalFiles } from '../../../src/main/screenshot-original-files'
import { ScreenshotPins } from '../../../src/main/screenshot-pins'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { SystemScreenshotEditor } from '../../../src/main/system-screenshot-editor'

const out = process.env.AGENTMUX_SCREENSHOT_EDITOR_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, boundary: 'Actual independent production BrowserWindow, isolated preload, Renderer, shared ImageAnnotationEditor, trusted CDP input and real PNG composition; capture/TCC, user clipboard, Agent attachment, packaging and installation are outside this fixture.', cases: [], screenshots: [] }
const deliveries: any[] = [], draftDeliveries: string[] = []
let capture: ScreenCapture, nextImage: ReturnType<typeof pngFromBytes>
const contexts: string[] = []
let pins: ScreenshotPins, dropPinReceipt = true
let editor: SystemScreenshotEditor, window: BrowserWindow, appearance: 'light' | 'dark' = 'dark', failDelivery = false
let closed: Promise<void>
async function waitFor<T>(label: string, read: () => Promise<T>): Promise<NonNullable<T>> {
  const start = Date.now()
  while (Date.now() - start < 8000) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('Timed out: ' + label)
}
async function evaluate<T = any>(script: string): Promise<T> { return await window.webContents.executeJavaScript(script) }
async function settle() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
async function control(name: string) {
  return await evaluate<{ x: number; y: number; disabled: boolean }>(`(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});if(!b)throw Error('Missing actual control '+${JSON.stringify(name)});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled||b.getAttribute('aria-disabled')==='true'}})()`)
}
async function mouse(type: string, x: number, y: number, buttons = 0) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function click(name: string) {
  process.stdout.write('native-editor: click '+name+'\n')
  const button = await control(name); assert.equal(button.disabled, false, name + ' remains available')
  await mouse('mouseMoved', button.x, button.y); await mouse('mousePressed', button.x, button.y, 1);
  if (name === 'Cancel') void mouse('mouseReleased', button.x, button.y).catch(() => {}); else await mouse('mouseReleased', button.x, button.y)
  process.stdout.write('native-editor: dispatched '+name+'\n')
  if (!['Copy', 'Copy & attach', 'Cancel'].includes(name) && !window.isDestroyed()) await settle()
}
async function sourcePoint(x: number, y: number) {
  return await evaluate<{ x: number; y: number }>(`(()=>{const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),m=c.getContext('2d').getTransform(),d=c.width/r.width;return {x:r.x+(m.e+m.a*${x})/d,y:r.y+(m.f+m.d*${y})/d}})()`)
}
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await sourcePoint(from.x, from.y), b = await sourcePoint(to.x, to.y)
  await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y, 1)
  for (let index = 1; index <= 12; index++) await mouse('mouseMoved', a.x + (b.x - a.x) * index / 12, a.y + (b.y - a.y) * index / 12, 1)
  await mouse('mouseReleased', b.x, b.y); await settle()
}
async function shot(name: string) {
  await settle()
  await evaluate(`Promise.all([...document.querySelectorAll('[role=menu]')].flatMap(menu=>menu.getAnimations()).map(animation=>animation.finished.catch(()=>{})))`)
  const header = await evaluate(`(()=>{const h=document.querySelector('.image-annotation-editor__header'),t=h.querySelector('.image-annotation-editor__title'),s=t.querySelector('[role=status]'),r=t.getBoundingClientRect(),sr=s.getBoundingClientRect();return {width:innerWidth,title:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},actions:[...h.querySelectorAll('button')].map(b=>b.getBoundingClientRect()).filter(b=>b.width&&b.height).map(b=>({left:b.left,right:b.right,top:b.top,bottom:b.bottom})),statusRight:sr.right,fullStatus:s.title,status:s.textContent}})()`)
  assert.ok(header.actions.every(action => header.title.bottom <= action.top || header.title.top >= action.bottom || header.title.right <= action.left || header.title.left >= action.right), 'title and output actions never overlap')
  assert.ok(header.statusRight <= header.title.right && (!header.status || header.fullStatus === header.status), 'long status stays in its own column and remains fully available')
  process.stdout.write('native-editor: capturing '+name+'\n')
  const file = name + '.png'
  await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG())
  receipt.screenshots.push({ file, appearance, contentSize: window.getContentSize() })
}
async function open(image: ReturnType<typeof pngFromBytes>, attach: boolean) {
  process.stdout.write('native-editor: allocating next image editor\n')
  const existingWindows = new Set(BrowserWindow.getAllWindows())
  nextImage = image
  closed = capture.capture(attach).then(path => { if (path) draftDeliveries.push(path) })
  void closed.catch(error => { receipt.editError = String(error) })
  window = await waitFor('production editor allocated', async () => BrowserWindow.getAllWindows().find(candidate => !existingWindows.has(candidate)))
  process.stdout.write('native-editor: exact new editor allocated\n')
  window.webContents.debugger.attach('1.3')
  await waitFor('shared editor image decoded', async () => {
    try { return await evaluate(`(()=>{const c=document.querySelector('canvas'),i=document.querySelector('img'),b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.textContent.trim()===${JSON.stringify(attach ? 'Copy & attach' : 'Copy')});return c?.width>0&&i?.complete&&i.naturalWidth>0&&b&&!b.disabled})()`) } catch { return false }
  })
  await settle()
  process.stdout.write('native-editor: decoded editor ready\n')
  assert.deepEqual(await evaluate('Object.keys(window.screenshotEditor).sort()'), ['cancel', 'copyContext', 'finish', 'inspectOriginal', 'inspectOriginalOperation', 'inspectPin', 'load', 'onNotice', 'openOriginal', 'pin', 'recognizeText', 'retake', 'saveOriginal', 'savePng'])
  assert.equal(await evaluate('typeof window.agentmux'), 'undefined', 'the full application preload is absent')
  const glyphs = await evaluate(`(()=>{const svg=document.querySelector('[aria-label="Crop"] svg use');return !!svg&&!!document.getElementById(svg.getAttribute('href').slice(1))})()`)
  assert.equal(glyphs, true, 'the shared theme runtime installs actual semantic glyphs')
  return window
}

async function sourceImage() {
  const source = new BrowserWindow({ width: 920, height: 560, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await source.loadURL('data:text/html,<body style="margin:0"><canvas width="920" height="560"></canvas>')
  const url = await source.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas'),x=c.getContext('2d');
x.fillStyle='#f2f5f8';x.fillRect(0,0,920,560);x.fillStyle='#172532';x.fillRect(0,0,920,64);x.font='600 19px -apple-system';x.fillStyle='#fff';x.fillText('Quarterly review',32,40);x.font='13px -apple-system';x.fillStyle='#a7b9c6';x.fillText('Product · Research · Delivery',615,40);
x.fillStyle='#fff';x.fillRect(28,92,864,424);x.fillStyle='#263f50';x.font='600 25px -apple-system';x.fillText('From insight to delivery',54,140);x.font='14px -apple-system';x.fillStyle='#687d8c';x.fillText('One image, the same annotation tools, every workspace.',54,169);
for(let i=0;i<4;i++){x.fillStyle=['#e7f1ee','#eaf0f8','#f4ece2','#ecebf6'][i];x.fillRect(54+i*205,200,188,98);x.fillStyle='#2c4c54';x.font='600 26px -apple-system';x.fillText(['86%','24','12','4'][i],70+i*205,242);x.font='12px -apple-system';x.fillText(['Completion','Contributors','Validated ideas','Milestones'][i],70+i*205,274)}
x.font='600 15px -apple-system';x.fillStyle='#304a5e';x.fillText('Next milestone',54,344);x.font='13px -apple-system';x.fillStyle='#718391';x.fillText('Review findings and share the final capture with your team.',54,370);x.fillText('Access code: 4281  ·  private',54,408);x.fillStyle='#e6eef4';x.fillRect(54,445,810,1);x.fillStyle='#607b8c';x.fillText('Research notes',54,476);x.fillText('Validated · Ready for review',652,476);return c.toDataURL('image/png')})()`)
  source.destroy()
  return pngFromBytes(Buffer.from(url.split(',')[1], 'base64'))
}

async function run() {
  await app.whenReady()
  pins = new ScreenshotPins({ hostId: 'local', appearance: () => ({ terminalTheme: 'graphite', appAppearance: appearance }), copy: async () => {} })
  // The production save owner opens the native sheet; this private chooser answers it with the proof file.
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(out, 'processed.png') })) as typeof dialog.showSaveDialog
  editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: appearance }), {
    inspectPin: operationId => pins.call('image.inspect', { hostId: 'local', operationId }, { actor: { kind: 'user', id: 'private-editor-user' } }),
    copyText: async text => { contexts.push(text) },
    pin: async (image, operationId) => {
      const result = await pins.call('image.pin', { hostId: 'local', operationId, image: { format: 'png', data: image.dataUrl.split(',')[1]!, width: image.width, height: image.height, scale: 1 } }, { actor: { kind: 'user', id: 'private-editor-user' } })
      if (dropPinReceipt) { dropPinReceipt = false; throw new Error('The private pin reader lost its first response.') }
      return result
    },
    originalFiles: () => new ScreenshotOriginalFiles({ chooseOpen: async () => join(out, 'original.json'), chooseSave: async () => join(out, 'original.json'),
      worker: { helperPath: process.env.AGENTMUX_SCREENSHOT_FILE_HELPER! } })
  })
  capture = new ScreenCapture({ home: out, appActive: () => true, native: () => ({
    captureScreenshot: async () => { throw new Error('This fixture opens the editor through a region capture only.') },
    writeClipboardImage: async result => { if (failDelivery) throw new Error('The private clipboard sink is unavailable.'); deliveries.push(result) }
  }), edit: (...args) => editor.edit(...args),
  // The person pressed ⌘E on the capture surface with the whole frame selected and no marks: the window editor takes over.
  present: async () => ({ state: 'expanded', image: nextImage, source: { rect: { x: 0, y: 0, width: nextImage.width, height: nextImage.height }, scale: 1, capturedAt: Date.now() },
    handoff: { shapes: [], crop: { x: 0, y: 0, width: nextImage.width, height: nextImage.height }, tool: 'select' }, delivered: () => {} }),
  reportIssue: issue => { (receipt.reportedIssues ??= []).push(String(issue)) } })
  const image = await sourceImage()
  const started = performance.now()
  receipt.metrics = { sourcePixels: image.width * image.height, sourcePngBytes: image.byteLength, outputLatenciesMs: {} }
  await open(image, true); await shot('normal-dark')
  process.stdout.write('native-editor: opened original image\n')
  await click('Cover'); await drag({ x: 50, y: 388 }, { x: 350, y: 424 })
  await click('Crop'); await drag({ x: 28, y: 88 }, { x: 890, y: 516 })
  await shot('crop-cover-dark')
  const saveStart = performance.now()
  await click('Save PNG')
  await waitFor('real processed PNG file', async () => { try { return (await readFile(join(out, 'processed.png'))).length > 100 } catch { return false } })
  receipt.metrics.outputLatenciesMs.processedPngSave = performance.now() - saveStart
  const exported = nativeImage.createFromBuffer(await readFile(join(out, 'processed.png')))
  assert.ok(exported.getSize().width < image.width && exported.getSize().height < image.height)
  assert.equal(deliveries.length, 0, 'Save PNG does not copy or attach')
  await waitFor('PNG output settled', async () => !(await control('Copy context')).disabled)
  const contextStart = performance.now()
  await click('Copy context'); await waitFor('actual context sink', async () => contexts.length === 1)
  receipt.metrics.outputLatenciesMs.contextCopy = performance.now() - contextStart
  const context = JSON.parse(contexts[0].slice(contexts[0].indexOf('{')))
  assert.equal(context.sourceKind, 'system'); assert.equal(context.source, null); assert.equal(context.browserId, null)
  assert.deepEqual(context.outputPng, exported.getSize())
  await waitFor('context output settled', async () => !(await control('Original file actions')).disabled)
  await click('Original file actions'); await shot('original-menu-dark')
  await click('Save original…')
  await waitFor('real editable original saved', async () => { try { return JSON.parse(await readFile(join(out, 'original.json'), 'utf8')) } catch { return false } })
  const saved = await readFile(join(out, 'original.json'), 'utf8')
  assert.ok(saved.includes('cover') && saved.includes('data:image/png;base64,'), 'the original retains editable shapes and source pixels')
  await waitFor('original save finished', async () => await evaluate('document.body.innerText.includes("Original saved")'))
  await click('Clear all')
  await click('Original file actions'); await click('Open original…')
  await waitFor('actual original reopened', async () => await evaluate('document.body.innerText.includes("Opened original")&&document.querySelector("canvas")?.width>0'))
  await shot('reopened-original-dark')
  await click('Pin image')
  await waitFor('actual separate pin presentation', async () => {
    for (const candidate of BrowserWindow.getAllWindows()) if (candidate !== window) {
      try { if (await candidate.webContents.executeJavaScript('document.querySelector(".screenshot-pin img")?.naturalWidth>0')) return candidate } catch {}
    }
    return null
  })
  await waitFor('lost pin receipt offers original operation query', async () => { try { return !(await control('Check pin')).disabled } catch { return false } })
  await shot('pin-unconfirmed-dark')
  window.setContentSize(420, 570); await shot('pin-unconfirmed-narrow-dark')
  window.setContentSize(1040, 728); await settle()
  await click('Check pin')
  await waitFor('same original pin reconciled', async () => await evaluate('document.body.innerText.includes("Original reference pinned")'))
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'querying the original operation never creates a second pin')
  await shot('pin-reconciled-dark')
  pins.dispose()
  receipt.cases.push({ label: 'real-editor-processed-save-system-context-original-roundtrip-and-pin', output: exported.getSize(), contextSource: context.sourceKind })
  await waitFor('pin output settled', async () => !(await control('Copy & attach')).disabled)
  failDelivery = true
  await click('Copy & attach')
  await waitFor('failure visible in the same editing window', async () => await evaluate('document.querySelector("[role=alert]")?.textContent.includes("private clipboard")'))
  assert.equal((await control('Cancel')).disabled, false)
  await shot('delivery-failure-dark')
  process.stdout.write('native-editor: failed delivery retained original edits\n')
  failDelivery = false
  await click('Copy & attach'); await closed
  process.stdout.write('native-editor: explicit copy completed\n')
  assert.equal(deliveries.length, 1, 'only the explicitly successful completion reaches the private sink')
  assert.ok(deliveries[0].width < image.width && deliveries[0].height < image.height, 'actual shared composition crops output pixels')
  const bitmap = nativeImage.createFromDataURL(deliveries[0].dataUrl), bytes = bitmap.toBitmap()
  let black = 0
  for (let index = 0; index < bytes.length; index += 4) if (bytes[index] < 45 && bytes[index + 1] < 45 && bytes[index + 2] < 45 && bytes[index + 3] > 245) black++
  assert.ok(black > 5000, 'actual opaque Cover must survive shared PNG composition')
  await writeFile(join(out, 'composed.png'), bitmap.toPNG())
  receipt.cases.push({ label: 'real-crop-cover-failed-delivery-keeps-editor-then-explicit-copy', width: deliveries[0].width, height: deliveries[0].height, blackPixels: black })

  process.stdout.write('native-editor: composed bitmap inspected\n')
  assert.equal(draftDeliveries.length, 1, 'only the original capture receives a draft image')
  const originalDraftBytes = await readFile(draftDeliveries[0])
  assert.ok(originalDraftBytes.equals(Buffer.from(deliveries[0].dataUrl.split(',')[1], 'base64')), 'the actual pasted owner stores the processed original image')
  const retained = window
  assert.equal(retained.isDestroyed(), false, 'successful Copy retains the original editable window')
  appearance = 'light'; await open(image, false); window.setContentSize(420, 570); await settle()
  assert.equal(retained.isDestroyed(), false, 'a retained image does not block another capture editor')
  const newer = window
  window = retained; retained.show(); retained.focus(); await settle()
  await click('Clear all'); await click('Copy')
  // Copy is enabled again only after the whole completion settled, including any draft write it started.
  await waitFor('retained editor copies a changed image independently', async () => deliveries.length === 2
    && await evaluate<boolean>(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Copy'&&!b.disabled)`))
  assert.equal(deliveries[1].width, image.width, 'the later clipboard image is independently edited')
  assert.equal(draftDeliveries.length, 1, 'later copies do not redeliver into the original draft')
  assert.ok((await readFile(draftDeliveries[0])).equals(originalDraftBytes), 'later editing cannot overwrite the original draft image')
  assert.equal((await readdir(dirname(draftDeliveries[0]))).filter(name => name.endsWith('.png')).length, 1, 'the later clipboard image creates no second draft file')
  receipt.cases.push({ label: 'actual-capture-editor-pasted-owner-delivers-original-once-and-retains-next-capture', originalDraft: draftDeliveries[0], files: 1 })
  window = newer; newer.show(); newer.focus(); await settle()
  await shot('narrow-light')
  const layout = await evaluate(`(()=>{const b=[...document.querySelectorAll('button,[role=menuitem]')].find(b=>b.textContent.trim()==='Copy'),r=b.getBoundingClientRect(),c=document.querySelector('canvas').getBoundingClientRect();return {body:document.body.scrollWidth,width:innerWidth,copyVisible:r.width>0&&r.x>=0&&r.right<=innerWidth,canvasHeight:c.height}})()`)
  assert.ok(layout.body <= layout.width && layout.copyVisible && layout.canvasHeight > 200, 'the narrow real window keeps Copy and a readable canvas')
  await click('Original file actions'); await shot('original-menu-narrow-light')
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  assert.equal(window.isDestroyed(), false, 'Escape dismisses only the Original menu and preserves image editing')
  await settle()
  await click('Cancel'); await closed
  retained.close()
  process.stdout.write('native-editor: narrow Copy-only window cancelled\n')
  assert.equal(deliveries.length, 2)
  receipt.cases.push({ label: 'narrow-light-copy-only-and-cancel', layout })

  appearance = 'dark'; await open(image, false)
  await evaluate(`(()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb,...args){return original.call(this,blob=>{window.heldPng=()=>cb(blob)},...args)}})()`)
  await click('Copy')
  await waitFor('actual PNG encoding held', async () => await evaluate('typeof window.heldPng === "function"'))
  assert.equal((await control('Cancel')).disabled, false)
  await click('Cancel'); await closed
  assert.equal(deliveries.length, 2, 'cancelled physical renderer encoding does not deliver a new image')
  receipt.cases.push({ label: 'Cancel remains available during actual PNG composition' })
  editor.dispose()
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'closing the original capture and references releases every owned window')
  receipt.metrics.closedWindows = BrowserWindow.getAllWindows().length
  receipt.metrics.elapsedMs = performance.now() - started
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }; process.stderr.write(JSON.stringify(receipt.failure)+'\n')
  try { if (window && !window.isDestroyed()) { receipt.failure.dom = await evaluate('document.body.innerText'); await shot('failure') } } catch {}
}).finally(async () => {
  editor?.dispose(); pins?.dispose()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
