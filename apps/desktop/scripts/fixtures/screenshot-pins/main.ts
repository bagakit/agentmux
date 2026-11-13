import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { ScreenshotPins } from '../../../src/main/screenshot-pins'

const out = process.env.SCREENSHOT_PINS_OUT!, cli = process.env.SCREENSHOT_PINS_CLI!, node = process.env.SCREENSHOT_PINS_NODE!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
let owner: ScreenshotPins, server: AgentMuxControlServer, client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
let endpointDirectory: string | undefined
let appearance: 'light' | 'dark' = 'dark', window: BrowserWindow
const copies: any[] = [], screenshots: any[] = [], cases: any[] = []
const receipt: any = { passed: false, captureOnly: true, aestheticReview: 'not-performed', screenshots, cases,
  boundary: 'Actual public Unix service/client/CLI → production Main pin owner → BrowserWindow/preload/PinView, private copy sink and file chooser. No user clipboard, screen/TCC capture, existing Session, packaging or installation.' }
async function until<T>(read: () => Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value as NonNullable<T>; await new Promise(done => setTimeout(done, 20)) }
  throw new Error('Timed out waiting for ' + label)
}
async function evaluate<T = any>(script: string): Promise<T> { return await window.webContents.executeJavaScript(script) }
async function settle() { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))') }
async function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point: { x: number; y: number }) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function hover() {
  const [width, height] = window.getContentSize() as [number, number]
  await mouse('mouseMoved', { x: width / 2, y: height / 2 })
  await until(async () => await evaluate(`getComputedStyle(document.querySelector('.screenshot-pin__controls')).opacity==='1'`), 'hover-revealed pin controls')
}
async function click(label: string) {
  await hover()
  const point = await until(async () => await evaluate<{ x: number; y: number } | null>(`(()=>{const b=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), label)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) await mouse(type, point)
}
/** Resize through the production zoom action, then capture with or without the hover controls. */
async function shot(name: string, width: number, controls: boolean) {
  const [current] = window.getContentSize() as [number, number]
  await evaluate(`window.screenshotPin.zoom(${JSON.stringify((await window.webContents.executeJavaScript('window.screenshotPin.load()')).pinId)}, ${width / current}, { x: 0, y: 0 })`)
  await until(async () => Math.abs(window.getContentSize()[0]! - width) <= 1, 'zoomed pin width')
  if (controls) await hover(); else await mouse('mouseMoved', { x: -20, y: -20 })
  await settle(); await new Promise(done => setTimeout(done, 200))
  const file = name + '.png', pixels = await window.webContents.capturePage()
  await writeFile(join(out, file), pixels.toPNG())
  const layout = await evaluate(`(()=>{const image=document.querySelector('img'),r=image.getBoundingClientRect(),nav=document.querySelector('.screenshot-pin__controls');return {width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,objectFit:getComputedStyle(image).objectFit,image:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},controls:getComputedStyle(nav).opacity,buttons:[...nav.querySelectorAll('button')].map(b=>{const x=b.getBoundingClientRect();return {label:b.getAttribute('aria-label'),left:x.left,right:x.right,top:x.top,bottom:x.bottom}})}})()`)
  screenshots.push({ file, appearance, contentSize: window.getContentSize(), layout })
  assert.ok(layout.scrollWidth <= layout.width, 'the pin never scrolls sideways')
  assert.equal(layout.objectFit, 'contain', 'the reference preserves the complete source image proportion')
  assert.ok(Math.abs(layout.height - layout.width * 360 / 640) <= 2, 'the pin window keeps the source proportion, so the image fills it')
  assert.ok(layout.image.left === 0 && layout.image.top === 0 && Math.abs(layout.image.right - layout.width) <= 1, 'the image is the whole window')
  assert.equal(layout.controls, controls ? '1' : '0', controls ? 'hover reveals the controls' : 'controls stay hidden without the pointer')
  if (controls) {
    assert.ok(layout.buttons.every((b: any) => b.left >= 0 && b.right <= layout.width && b.top >= 0 && b.bottom <= layout.height), 'every pin action stays inside its own window')
    assert.equal(new Set(layout.buttons.map((b: any) => Math.round(b.top))).size, 1, 'the controls stay one compact row over the image')
  }
}
async function command(action: string, input: unknown) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    const child = spawn(node, [cli, '--endpoint', 'unix:' + server.path, 'image', action, '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input))
  })
}
async function open(operationId: string, image: ReturnType<typeof pngFromBytes>) {
  // A 640x360 capture of a 320x180 point area, so the pin opens at logical size and offers Save PNG at 1x.
  const input = { hostId: 'local', operationId, image: { format: 'png' as const, data: image.dataUrl.split(',')[1]!, width: image.width, height: image.height, scale: 1 },
    origin: { x: 80, y: 80, width: 320, height: 180 } }
  const result = await client.call('image.pin', input)
  window = await until(async () => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      try { if (await candidate.webContents.executeJavaScript('window.screenshotPin?.load().then(value=>value.pinId)') === result.pinId) return candidate } catch {}
    }
    return null
  }, 'the exact production pin document')
  window.webContents.debugger.attach('1.3')
  await until(async () => await evaluate('document.querySelector("img")?.naturalWidth>0'), 'decoded production PinView')
  assert.deepEqual(await evaluate('Object.keys(window.screenshotPin).sort()'), ['clickThrough', 'close', 'copy', 'drag', 'load', 'move', 'opacity', 'save', 'zoom'])
  assert.equal(await evaluate('typeof window.agentmux'), 'undefined', 'the full workbench bridge is absent')
  assert.equal(window.isAlwaysOnTop(), true)
  return { input, result, window }
}
async function sourceImage() {
  const source = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { sandbox: true, contextIsolation: true } })
  await source.loadURL('data:text/html,<canvas width="640" height="360"></canvas>')
  const data = await source.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#eef3f4';x.fillRect(0,0,640,360);x.fillStyle='#253b42';x.fillRect(0,0,640,62);x.fillStyle='#fff';x.font='600 22px -apple-system';x.fillText('Capture review',28,40);x.fillStyle='#fff';x.fillRect(24,86,592,242);x.fillStyle='#344e56';x.font='600 24px -apple-system';x.fillText('One fixed image',48,135);x.font='15px -apple-system';x.fillStyle='#6b8087';x.fillText('Compare the evidence while the work continues.',48,166);for(let i=0;i<3;i++){x.fillStyle=['#d6e9e2','#e1e8f4','#f1e4d6'][i];x.fillRect(48+i*184,195,164,90);x.fillStyle='#2b4b48';x.font='600 24px -apple-system';x.fillText(['3','12','86%'][i],64+i*184,234);x.font='12px -apple-system';x.fillText(['Regions','Notes','Reviewed'][i],64+i*184,260)}return c.toDataURL('image/png')})()`)
  source.destroy(); return pngFromBytes(Buffer.from(data.split(',')[1], 'base64'))
}
const chooseFile = dialog.showSaveDialog
async function run() {
  await app.whenReady()
  owner = new ScreenshotPins({ hostId: 'local', appearance: () => ({ terminalTheme: 'graphite', appAppearance: appearance }), copy: async image => { copies.push(structuredClone(image)) } })
  endpointDirectory = await mkdtemp(join(app.getPath('temp'), 'amp-'))
  server = new AgentMuxControlServer({ socketPath: join(endpointDirectory, 'control.sock'), coreClients: () => [], images: owner })
  await server.start(); client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const image = await sourceImage(), dark = await open('dark-reference', image)
  assert.deepEqual(window.getContentSize(), [320, 180], 'the pin opens at the logical size of its origin')
  await shot('wide-dark', 640, true); await shot('plain-dark', 640, false); await shot('narrow-dark', 200, true)
  await click('Copy'); await until(async () => copies.length === 1, 'private PNG sink')
  assert.equal(copies[0].dataUrl, image.dataUrl)
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(out, 'processed.png') })) as typeof dialog.showSaveDialog
  await click('Save PNG'); await until(async () => { try { return (await readFile(join(out, 'processed.png'))).equals(Buffer.from(image.dataUrl.split(',')[1]!, 'base64')) } catch { return false } }, 'exact fixed PNG file')
  assert.deepEqual(nativeImage.createFromBuffer(await readFile(join(out, 'processed.png'))).getSize(), { width: 640, height: 360 })
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(out, 'logical.png') })) as typeof dialog.showSaveDialog
  await click('Save PNG at 1×'); await until(async () => { try { return nativeImage.createFromBuffer(await readFile(join(out, 'logical.png'))).getSize().width === 320 } catch { return false } }, '1x PNG file')
  assert.deepEqual(nativeImage.createFromBuffer(await readFile(join(out, 'logical.png'))).getSize(), { width: 320, height: 180 })
  await click('Opacity'); await until(async () => Math.abs(window.getOpacity() - 0.8) < 0.01, '80% pin opacity')
  await click('Click-through'); await until(async () => await evaluate(`!!document.querySelector('button[aria-label="Stop click-through"]')`), 'click-through restore handle')
  await settle(); await new Promise(done => setTimeout(done, 200))
  await writeFile(join(out, 'click-through-dark.png'), (await window.webContents.capturePage()).toPNG()); screenshots.push({ file: 'click-through-dark.png', appearance })
  const restore = await evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector('button[aria-label="Stop click-through"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) await mouse(type, restore)
  await until(async () => await evaluate(`!document.querySelector('.screenshot-pin[data-click-through]')`), 'click-through restored from its handle')
  cases.push({ name: 'actual PinView copy, PNG and 1x save, opacity and click-through restore keep fixed source pixels', copies: copies.length })

  appearance = 'light'; const light = await open('light-reference', image)
  await shot('wide-light', 640, true)
  const closed = await command('close', { hostId: 'local', pinId: light.result.pinId, operationId: 'close-light-reference' })
  assert.equal(closed.code, 0, closed.stdout + closed.stderr)
  assert.equal(JSON.parse(closed.stdout).result.recordedOperation.effect, 'closed')
  assert.equal(light.window.isDestroyed(), true); assert.equal(dark.window.isDestroyed(), false)
  const inspected = await command('inspect', { hostId: 'local', operationId: 'light-reference' })
  assert.equal(inspected.code, 0, inspected.stdout + inspected.stderr)
  assert.equal(JSON.parse(inspected.stdout).result.recordedOperation.effect, 'opened')
  assert.equal(JSON.parse(inspected.stdout).result.state, 'closed')
  cases.push({ name: 'actual public CLI closes only its exact pin and preserves original creation effect' })

  window = dark.window
  const closingContents = window.webContents
  await Promise.race([closingContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }),
    new Promise<void>(resolve => closingContents.once('destroyed', resolve))])
  await until(async () => dark.window.isDestroyed(), 'production Escape close')
  const repeated = await client.call('image.pin', dark.input)
  assert.equal(repeated.state, 'closed'); assert.equal(BrowserWindow.getAllWindows().length, 0)
  const final = await open('dispose-reference', image)
  owner.dispose(); assert.equal(final.window.isDestroyed(), true)
  cases.push({ name: 'actual Escape, duplicate operation and owner dispose release only original reference windows' })
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { if (window && !window.isDestroyed()) { receipt.failure.dom = await evaluate('document.body.innerText'); await writeFile(join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()) } } catch {}
}).finally(async () => {
  dialog.showSaveDialog = chooseFile
  owner?.dispose(); await client?.dispose(); await server?.stop()
  if (endpointDirectory) await rm(endpointDirectory, { recursive: true, force: true })
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed ? 0 : 1)
})
