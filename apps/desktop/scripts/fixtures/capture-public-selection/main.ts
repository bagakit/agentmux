import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { createNativeDesktopPublicOwner } from '../../../src/main/native-desktop-public'
import type { CaptureBackground } from '../../../src/shared/capture-surface'
import type { BrowserPng } from '../../../src/shared/contracts'

const out = process.env.AGENTMUX_CAPTURE_PUBLIC_SELECTION_OUT!
const cliEntry = process.env.AGENTMUX_CAPTURE_PUBLIC_SELECTION_CLI!, node = process.env.AGENTMUX_CAPTURE_PUBLIC_SELECTION_NODE!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const instanceId = 'native-instance-public-selection'
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 640, height: 480 }, scaleFactor: 1, displayFrequency: 60 },
  { id: 7, bounds: { x: 640, y: 0, width: 640, height: 480 }, scaleFactor: 1, displayFrequency: 60 }]
let pointer = { x: 200, y: 150 }, failExcluded = false
const sources = new Map<string, BrowserPng>(), grabs: any[] = [], cases: any[] = [], children = new Set<ChildProcess>(), focusCalls: number[] = []
app.on('browser-window-created', (_event, window) => {
  const focus = window.focus.bind(window)
  window.focus = () => { focusCalls.push(window.getBounds().x); focus() }
})
const receipt: any = { passed: false, boundary: 'Actual amux CLI --data → Unix AgentMuxControlServer → production ipc.ts adapter/createNativeDesktopPublicOwner → CaptureSurface → production preload/Renderer. Native pixels and window geometry are controlled; no OS/TCC, physical multi-monitor, packaging or installation proof.', cases, grabs }
let surface: CaptureSurface, server: AgentMuxControlServer, host: BrowserWindow, current: BrowserWindow
let captureBefore = new Set<BrowserWindow>(), endpointDirectory: string | undefined
const native = {
  async captureDisplays({ includeHostWindows = false }: { includeHostWindows?: boolean } = {}) {
    const background: CaptureBackground = includeHostWindows ? 'included' : 'excluded', capturedAt = Date.now()
    grabs.push({ includeHostWindows, background, capturedAt })
    if (failExcluded && background === 'excluded') throw Object.assign(new Error('CoreGraphics cannot exclude the visible host from this display'), { code: 'host_window_exclusion_unavailable' })
    return { state: 'captured' as const, capturedAt,
      timing: { contentMs: 1, windowListMs: 1, responseSerializationMs: 1, totalMs: 3, lazyConnectionMs: 1, socketReadMs: 1, jsonParseMs: 1, requestMs: 4, validationMs: 1 },
      displays: displays.map(display => {
        const image = sources.get(background + ':' + display.id)!
        return { displayId: display.id, frame: display.bounds, scale: 1, safeTop: 0, windows: [],
          timing: { captureMs: 1, pngMs: 1, base64Ms: 0, totalMs: 2 }, png: image.dataUrl.split(',')[1]!, width: image.width, height: image.height, engine: 'controlled-' + background }
      }) }
  },
  async request() { throw new Error('A public region selection must not reach a native picker.') },
  inspectOperation(operationId: string) { return { operationId, instanceId, state: 'unknown' as const, reason: 'original_receipt_unavailable' } }
}
async function waitFor<T>(label: string, read: () => Promise<T>): Promise<NonNullable<T>> {
  const started = performance.now()
  while (performance.now() - started < 10000) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('Timed out: ' + label)
}
async function evaluate<T = any>(script: string): Promise<T> {
  try { return await current.webContents.executeJavaScript(script) }
  catch (error) { process.stderr.write('Failed public renderer script: ' + script + '\n'); throw error }
}
async function settle() { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))') }
async function mouse(type: string, x: number, y: number, buttons = 0) {
  await current.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
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
async function keyEscape() {
  await current.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  if (!current.isDestroyed()) await current.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
async function clickDone() {
  const point = await evaluate<{x:number;y:number}>(`(()=>{const buttons=[...document.querySelectorAll('button')],b=buttons.find(b=>b.getAttribute('aria-label')==='Done'||b.textContent.trim()==='Done');if(!b)throw Error('Missing public Done: '+document.body.innerText+' :: '+buttons.map(b=>b.textContent.trim()).join('|'));const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await mouse('mouseMoved', point.x, point.y); await mouse('mousePressed', point.x, point.y, 1)
  await mouse('mouseReleased', point.x, point.y).catch(error => { if (!current.isDestroyed()) throw error })
}
async function command(action: string[], input: unknown) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string; body: any }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    const child = spawn(node, [cliEntry, '--endpoint', 'unix:' + server.path, ...action, '--data', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    child.stdin.end(JSON.stringify(input))
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject)
    child.once('close', code => {
      children.delete(child)
      process.stdout.write(`public CLI ${action.join(' ')} exit ${code} (stdout ${stdout.length} bytes): ${stderr}\n`)
      let body: any = null
      try { body = stdout.trim() ? JSON.parse(stdout) : null } catch (error) { reject(new Error('CLI returned non-JSON output: ' + stdout + stderr)); return }
      resolve({ code, stdout, stderr, body })
    })
  })
}
function capture(operationId: string) {
  captureBefore = new Set(BrowserWindow.getAllWindows())
  return command(['native', 'capture'], { hostId: 'local', instanceId, operationId, capture: { mode: 'selection' } })
}
async function waitPublicSurface(label: string) {
  const before = captureBefore
  const overlays = await waitFor(label + ' overlays', async () => {
    const fresh = BrowserWindow.getAllWindows().filter(candidate => !before.has(candidate))
    return fresh.length === displays.length ? fresh : null
  })
  const infos: any[] = []
  for (const overlay of overlays) {
    await waitFor(label + ' real Renderer', async () => {
      try { return overlay.isVisible() && await overlay.webContents.executeJavaScript(`document.querySelector('img')?.naturalWidth>0&&document.querySelector('canvas')?.width>0`) } catch { return false }
    })
    infos.push(await overlay.webContents.executeJavaScript(`window.captureSurface.load()`))
  }
  cases.push({ label, displays: overlays.length, grabs: grabs.length })
  assert.deepEqual(infos.map(input => input.background), ['excluded', 'excluded'], 'public selection always requests the excluded frozen source')
  assert.deepEqual(infos.map(input => input.initialCrop), [undefined, undefined], 'every fresh public capture starts without initialCrop')
  current = overlays.find(window => window.getBounds().x === 0)!
  return { overlays, infos }
}
async function sourceImages() {
  const drawing = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await drawing.loadURL('data:text/html,<body><canvas></canvas>')
  for (const display of displays) for (const background of ['included', 'excluded'] as const) {
    const dataUrl = await drawing.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas');c.width=640;c.height=480;const x=c.getContext('2d');x.fillStyle=${JSON.stringify(background === 'included' ? '#d9e8ef' : '#efe2cf')};x.fillRect(0,0,640,480);x.fillStyle='#243b47';x.font='600 24px -apple-system';x.fillText(${JSON.stringify(background + ' display ' + display.id)},40,60);x.fillStyle='#ffffff';x.fillRect(40,100,560,300);return c.toDataURL('image/png')})()`)
    sources.set(background + ':' + display.id, { mimeType: 'image/png', dataUrl, width: 640, height: 480, byteLength: Buffer.byteLength(dataUrl.split(',')[1]!, 'base64') })
  }
  drawing.destroy()
}
async function run() {
  await app.whenReady()
  screen.getAllDisplays = (() => displays) as typeof screen.getAllDisplays
  screen.getCursorScreenPoint = () => pointer
  screen.getDisplayNearestPoint = ((point: { x: number; y: number }) => displays.find(display => point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width) ?? displays[0]) as typeof screen.getDisplayNearestPoint
  await sourceImages()
  host = new BrowserWindow({ width: 480, height: 320, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body>Public selection fixture host</body>')
  surface = new CaptureSurface({ native: () => native, appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    pin: async () => { throw new Error('Pin is outside this public selection fixture.') }, copyText: async () => {}, returnFocus: () => {} })
  const adapterText = process.env.AGENTMUX_CAPTURE_PUBLIC_SELECTION_IPC!
  const adapter = new Function('createNativeDesktopPublicOwner', 'getNativeDesktopOwner', 'captureSurface', 'BrowserWindow', `return { ${adapterText} }`)(
    createNativeDesktopPublicOwner, () => native, surface, BrowserWindow) as { nativeDesktop: any }
  endpointDirectory = await mkdtemp(join(app.getPath('temp'), 'ampub-'))
  server = new AgentMuxControlServer({ socketPath: join(endpointDirectory, 'public.sock'), coreClients: () => [], nativeDesktop: adapter.nativeDesktop })
  await server.start()

  const firstPending = capture('public-captured-first')
  const first = await waitPublicSurface('first-captured')
  current = first.overlays.find(window => window.getBounds().x === 0)!
  current.webContents.debugger.attach('1.3')
  current.webContents.on('console-message', event => process.stdout.write('public renderer: ' + event.message + '\n'))
  await evaluate(`window.captureEvents=[];for(const type of ['pointerdown','pointerup','lostpointercapture'])document.addEventListener(type,event=>window.captureEvents.push({type,x:event.clientX,y:event.clientY,target:event.target.tagName,button:event.button}),true)`)
  await drag(120, 140, 280, 180)
  assert.ok(await evaluate(`document.querySelector('.image-annotation-editor__capture-bar')!==null`), 'actual public drag created a crop: '+JSON.stringify(await evaluate('({events:window.captureEvents,text:document.body.innerText})')))
  await clickDone()
  const firstResult = await firstPending
  assert.equal(firstResult.code, 0, firstResult.stdout + firstResult.stderr)
  assert.deepEqual(firstResult.body.result.result.selectionRect, { x: 120, y: 140, width: 280, height: 180 })
  assert.equal(firstResult.body.result.result.state, 'captured')
  assert.equal(firstResult.body.result.result.engine, 'controlled-excluded')
  assert.deepEqual({ width: firstResult.body.result.result.screenshot.width, height: firstResult.body.result.result.screenshot.height, scale: firstResult.body.result.result.screenshot.scale }, { width: 280, height: 180, scale: 1 })
  assert.ok(firstResult.body.result.result.screenshot.data.length > 100)

  pointer = { x: 740, y: 150 }
  const secondPending = capture('public-captured-second')
  const second = await waitPublicSurface('second-captured-empty')
  const side = second.overlays.find(window => window.getBounds().x === 640)!
  await waitFor('second capture focuses the pointer display, not the old crop display', async () => focusCalls.at(-1) === 640 ? true : null)
  current = side; current.webContents.debugger.attach('1.3')
  await drag(50, 60, 100, 80); await clickDone()
  const secondResult = await secondPending
  assert.equal(secondResult.code, 0, secondResult.stdout + secondResult.stderr)
  assert.deepEqual(secondResult.body.result.result.selectionRect, { x: 690, y: 60, width: 100, height: 80 })
  assert.equal(secondResult.body.result.result.state, 'captured')
  assert.equal(secondResult.body.result.result.engine, 'controlled-excluded')

  const switchPending = capture('public-background-switch-rejected')
  const switching = await waitPublicSurface('public-background-switch-rejected')
  current = switching.overlays[0]!; current.webContents.debugger.attach('1.3')
  await drag(120, 140, 280, 180)
  await evaluate(`window.originalPublicCanvas=document.querySelector('canvas');window.publicEvents=[];window.captureSurface.onEvent(event=>window.publicEvents.push(event));void 0`)
  const switchReply = await evaluate(`window.captureSurface.load().then(input=>window.captureSurface.switchBackground(input.requestId,'included')).then(()=>'resolved',error=>'rejected: '+String(error))`)
  process.stdout.write('public switch reply: ' + switchReply + '\n')
  const switchState = await waitFor('public background refusal or forbidden included event', async () => await evaluate(`(()=>{if(window.publicEvents.some(event=>event.kind==='notice'&&event.message.includes('original excluded screenshot background')))return 'refused';if(window.publicEvents.some(event=>event.kind==='background'&&event.background==='included'))return 'included';return null})()`))
  assert.equal(switchState, 'refused', 'public selection must not switch from excluded to included')
  assert.equal(await evaluate(`window.originalPublicCanvas===document.querySelector('canvas')`), true, 'the refused switch preserves the original editor document')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Selection size"]')?.textContent`), '280 × 180 px', 'the refused switch preserves the current crop')
  await clickDone()
  const switchResult = await switchPending
  assert.equal(switchResult.code, 0, switchResult.stdout + switchResult.stderr)
  assert.equal(switchResult.body.result.result.state, 'captured')
  assert.equal(switchResult.body.result.result.engine, 'controlled-excluded')

  const grabsBeforeDuplicate = grabs.length
  const duplicate = await capture('public-captured-first')
  assert.equal(duplicate.code, 1)
  assert.deepEqual(duplicate.body.result, { hostId: 'local', instanceId, state: 'responded', operationId: 'public-captured-first',
    error: { code: 'duplicate_operation', message: 'Inspect the original operation; it will not be executed again' } })
  const inspected = await command(['native', 'operation', 'inspect'], { hostId: 'local', instanceId, operationId: 'public-captured-first' })
  assert.equal(inspected.code, 0, inspected.stdout + inspected.stderr)
  assert.deepEqual(inspected.body.result, { hostId: 'local', instanceId, state: 'responded', result: { operationId: 'public-captured-first', instanceId, method: 'captureScreenshot', state: 'completed' } })
  assert.equal(grabs.length, grabsBeforeDuplicate, 'duplicate and inspect never open another surface')
  cases.push({ label: 'duplicate-and-inspect-preserve-original-receipt' })

  pointer = { x: 200, y: 150 }
  const cancelledPending = capture('public-cancelled')
  const cancelled = await waitPublicSurface('cancelled-empty')
  current = cancelled.overlays[0]!; current.webContents.debugger.attach('1.3')
  await keyEscape()
  const cancelledResult = await cancelledPending
  assert.equal(cancelledResult.code, 0, cancelledResult.stdout + cancelledResult.stderr)
  assert.deepEqual(cancelledResult.body.result.result, { state: 'cancelled' })

  failExcluded = true
  const failedPending = capture('public-excluded-unavailable')
  let failedSettled = false
  void failedPending.then(() => { failedSettled = true }, () => { failedSettled = true })
  const failureState = await waitFor('typed excluded failure or forbidden included fallback', async () => {
    const visibleFallback = BrowserWindow.getAllWindows().some(window => window !== host && !window.isDestroyed() && window.isVisible())
    if (visibleFallback) return 'fallback'
    return failedSettled ? 'settled' : null
  })
  assert.equal(failureState, 'settled', 'public excluded unavailable must return typed failed instead of offering included pixels')
  const failed = await failedPending
  assert.equal(failed.code, 1)
  assert.deepEqual(failed.body.result.result, { state: 'failed', error: { code: 'host_window_exclusion_unavailable', message: 'CoreGraphics cannot exclude the visible host from this display' } })
  cases.push({ label: 'excluded-unavailable-is-typed-failed' })
  assert.equal(grabs.length, 10)
  assert.equal(cases.length, 6)
  receipt.focusCalls = focusCalls
  receipt.passed = true
}
void run().catch(error => {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  process.stderr.write(JSON.stringify(receipt.failure) + '\n')
}).finally(async () => {
  surface?.dispose()
  for (const child of children) child.kill('SIGTERM')
  await server?.stop()
  if (endpointDirectory) await rm(endpointDirectory, { recursive: true, force: true })
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
