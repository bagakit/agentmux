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
async function click(label: string) {
  const point = await until(async () => await evaluate<{ x: number; y: number } | null>(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), 'enabled production ' + label + ' action')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function shot(name: string, width: number, height: number) {
  window.setContentSize(width, height); await settle()
  const file = name + '.png', pixels = await window.webContents.capturePage()
  await writeFile(join(out, file), pixels.toPNG())
  const layout = await evaluate(`(()=>{const r=document.querySelector('img').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,imageHeight:r.height,buttons:[...document.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {name:b.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom}})}})()`)
  assert.ok(layout.scrollWidth <= layout.width && layout.imageHeight > 100, 'actual narrow pin keeps its image and action area')
  assert.ok(layout.buttons.every((b: any) => b.left >= 0 && b.right <= layout.width && b.top >= 0 && b.bottom <= layout.height), 'every actual pin action remains inside its own window')
  screenshots.push({ file, appearance, contentSize: window.getContentSize(), layout })
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
  const input = { hostId: 'local', operationId, image: { format: 'png' as const, data: image.dataUrl.split(',')[1]!, width: image.width, height: image.height, scale: 1 } }
  const result = await client.call('image.pin', input)
  window = await until(async () => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      try { if (await candidate.webContents.executeJavaScript('window.screenshotPin?.load().then(value=>value.pinId)') === result.pinId) return candidate } catch {}
    }
    return null
  }, 'the exact production pin document')
  window.webContents.debugger.attach('1.3')
  await until(async () => await evaluate('document.querySelector("img")?.naturalWidth>0'), 'decoded production PinView')
  assert.deepEqual(await evaluate('Object.keys(window.screenshotPin).sort()'), ['close', 'copy', 'load', 'save'])
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
  await shot('wide-dark', 720, 430); await shot('narrow-dark', 300, 430)
  await click('Copy'); await until(async () => copies.length === 1, 'private PNG sink')
  assert.equal(copies[0].dataUrl, image.dataUrl)
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(out, 'processed.png') })) as typeof dialog.showSaveDialog
  await click('Save PNG'); await until(async () => { try { return (await readFile(join(out, 'processed.png'))).equals(Buffer.from(image.dataUrl.split(',')[1]!, 'base64')) } catch { return false } }, 'exact fixed PNG file')
  assert.deepEqual(nativeImage.createFromBuffer(await readFile(join(out, 'processed.png'))).getSize(), { width: 640, height: 360 })
  cases.push({ name: 'actual PinView copy and PNG save preserve fixed source pixels after resize', copies: copies.length })

  appearance = 'light'; const light = await open('light-reference', image)
  await shot('wide-light', 720, 430); await shot('narrow-light', 300, 430)
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
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
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
