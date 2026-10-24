import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { SystemScreenshotEditor } from '../../../src/main/system-screenshot-editor'

const out = process.env.AGENTMUX_SCREENSHOT_EDITOR_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, boundary: 'Actual independent production BrowserWindow, isolated preload, Renderer, shared ImageAnnotationEditor, trusted CDP input and real PNG composition; capture/TCC, user clipboard, Agent attachment, packaging and installation are outside this fixture.', cases: [], screenshots: [] }
const deliveries: any[] = []
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
  return await evaluate<{ x: number; y: number; disabled: boolean }>(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)});if(!b)throw Error('Missing actual control '+${JSON.stringify(name)});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}})()`)
}
async function mouse(type: string, x: number, y: number, buttons = 0) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function click(name: string) {
  const button = await control(name); assert.equal(button.disabled, false, name + ' remains available')
  await mouse('mouseMoved', button.x, button.y); await mouse('mousePressed', button.x, button.y, 1); await mouse('mouseReleased', button.x, button.y)
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
  const file = name + '.png'
  await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG())
  receipt.screenshots.push({ file, appearance, contentSize: window.getContentSize() })
}
async function open(image: ReturnType<typeof pngFromBytes>, attach: boolean) {
  closed = editor.edit(image, attach, async result => {
    if (failDelivery) throw new Error('The private clipboard sink is unavailable.')
    deliveries.push(result)
  })
  void closed.catch(error => { receipt.editError = String(error) })
  window = await waitFor('production editor allocated', async () => BrowserWindow.getAllWindows().at(-1))
  window.webContents.debugger.attach('1.3')
  await waitFor('shared editor image decoded', async () => {
    try { return await evaluate(`(()=>{const c=document.querySelector('canvas'),i=document.querySelector('img'),b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(attach ? 'Copy & attach' : 'Copy')});return c?.width>0&&i?.complete&&i.naturalWidth>0&&b&&!b.disabled})()`) } catch { return false }
  })
  await settle()
  assert.deepEqual(await evaluate('Object.keys(window.screenshotEditor).sort()'), ['cancel', 'finish', 'load'])
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
  editor = new SystemScreenshotEditor(() => ({ terminalTheme: 'graphite', appAppearance: appearance }))
  const image = await sourceImage()
  await open(image, true); await shot('normal-dark')
  process.stdout.write('native-editor: opened original image\n')
  await click('Cover'); await drag({ x: 50, y: 388 }, { x: 350, y: 424 })
  await click('Crop'); await drag({ x: 28, y: 88 }, { x: 890, y: 516 })
  await shot('crop-cover-dark')
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

  appearance = 'light'; await open(image, false); window.setContentSize(420, 570); await settle()
  await shot('narrow-light')
  const layout = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Copy'),r=b.getBoundingClientRect(),c=document.querySelector('canvas').getBoundingClientRect();return {body:document.body.scrollWidth,width:innerWidth,copyVisible:r.width>0&&r.x>=0&&r.right<=innerWidth,canvasHeight:c.height}})()`)
  assert.ok(layout.body <= layout.width && layout.copyVisible && layout.canvasHeight > 200, 'the narrow real window keeps Copy and a readable canvas')
  await click('Cancel'); await closed
  process.stdout.write('native-editor: narrow Copy-only window cancelled\n')
  assert.equal(deliveries.length, 1)
  receipt.cases.push({ label: 'narrow-light-copy-only-and-cancel', layout })

  appearance = 'dark'; await open(image, false)
  await evaluate(`(()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb,...args){return original.call(this,blob=>{window.heldPng=()=>cb(blob)},...args)}})()`)
  await click('Copy')
  await waitFor('actual PNG encoding held', async () => await evaluate('typeof window.heldPng === "function"'))
  assert.equal((await control('Cancel')).disabled, false)
  await click('Cancel'); await closed
  assert.equal(deliveries.length, 1, 'cancelled physical renderer encoding does not deliver a new image')
  receipt.cases.push({ label: 'Cancel remains available during actual PNG composition' })
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { if (window && !window.isDestroyed()) { receipt.failure.dom = await evaluate('document.body.innerText'); await shot('failure') } } catch {}
}).finally(async () => {
  editor?.dispose()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
