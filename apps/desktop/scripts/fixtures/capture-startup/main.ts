import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadavg, freemem, totalmem } from 'node:os'
import { createHash } from 'node:crypto'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { GlobalScreenshot } from '../../../src/main/global-screenshot'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { registerScreenshotShortcut } from '../../../src/main/screenshot-shortcut'
import type { CaptureBackground, CaptureSurfaceInput } from '../../../src/shared/capture-surface'

declare const __CAPTURE_STARTUP_IPC_REGISTRATION__: string
const out = process.env.AGENTMUX_CAPTURE_STARTUP_OUT!
const variant = process.env.AGENTMUX_CAPTURE_STARTUP_VARIANT! as 'baseline' | 'candidate'
const count = Number(process.env.AGENTMUX_CAPTURE_STARTUP_DISPLAYS)
const background = process.env.AGENTMUX_CAPTURE_STARTUP_BACKGROUND! as CaptureBackground
const iteration = Number(process.env.AGENTMUX_CAPTURE_STARTUP_ITERATION), nonceStart = Number(process.env.AGENTMUX_CAPTURE_STARTUP_NONCE)
assert.ok(out && ['baseline', 'candidate'].includes(variant) && [1, 2].includes(count) && ['included', 'excluded'].includes(background))
assert.ok([1, 2].includes(iteration) && Number.isSafeInteger(nonceStart) && nonceStart > 0)
assert.ok(process.env.AGENTMUX_CAPTURE_STARTUP_USER_DATA)
const userData = process.env.AGENTMUX_CAPTURE_STARTUP_USER_DATA!
app.setPath('userData', userData)
app.on('window-all-closed', () => {})
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 960, height: 640 }, scaleFactor: 1, displayFrequency: 60 },
  { id: 7, bounds: { x: 960, y: 0, width: 800, height: 640 }, scaleFactor: 1, displayFrequency: 60 }].slice(0, count)
const receipt: any = { schema: 'agentmux.capture-startup-electron.v2', passed: false, variant, count, background, captures: [], opacityChanges: [],
  boundary: 'Real registered shortcut callback, GlobalScreenshot, ScreenCapture, CaptureSurface, production IPC timing sink, preload and Renderer. Native pixels and per-display producer delays are controlled; no real OS capture claim.',
  conditions: { loadavg: loadavg(), freeMemory: freemem(), totalMemory: totalmem(), electron: process.versions.electron },
  visibilityObservation: 'Native BrowserWindow.isVisible() sampled every 5 ms; show event offsets remain separate.' }
let host: BrowserWindow, surface: CaptureSurface, globalCapture: GlobalScreenshot, shortcut: { dispose(): void }, active: any = null, nonce = nonceStart
const shortcutCallbacks: Array<() => void> = []
let previousSourceHashes: any[] | null = null, nativeConnectionCalls = 0
const latestPath = join(userData, 'capture-timing.json')
const info = console.info
console.info = (...args) => {
  if (active && typeof args[0] === 'string' && args[0].startsWith('capture-surface timing ')) {
    const timing = JSON.parse(args[0].slice('capture-surface timing '.length))
    if (variant === 'candidate' && timing.final) active.finalTiming = timing
    else active.timing = timing
  }
  info(...args)
}
app.on('browser-window-created', (_event, window) => {
  if (!active) return
  const row = active, entry: any = { window, constructedMs: performance.now() - row.startedAt, shownMs: null, showEventMs: null, protectionAtShow: null }
  row.windows.push(entry)
  const showInactive = window.showInactive.bind(window)
  window.showInactive = () => { entry.protectionAtShow = window.isContentProtected(); showInactive() }
  window.on('show', () => { entry.showEventMs ??= performance.now() - row.startedAt })
  const observe = setInterval(() => {
    if (window.isDestroyed()) { clearInterval(observe); return }
    if (window.isVisible()) { entry.shownMs ??= performance.now() - row.startedAt; clearInterval(observe) }
  }, 5)
  window.once('closed', () => clearInterval(observe))
})
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T> | T, budgetMs = 15000): Promise<NonNullable<T>> {
  const start = performance.now()
  while (performance.now() - start < budgetMs) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await wait(5)
  }
  throw new Error('Observation timed out: ' + label)
}
function image(width: number, height: number, value: number) {
  const rgba = [40 + value * 13 % 180, 70 + value * 7 % 150, 110 + value * 5 % 120]
  const bitmap = Buffer.alloc(width * height * 4)
  for (let at = 0; at < bitmap.length; at += 4) {
    bitmap[at] = rgba[2]!; bitmap[at + 1] = rgba[1]!; bitmap[at + 2] = rgba[0]!; bitmap[at + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG().toString('base64')
}
async function captureDisplays({ includeHostWindows = false } = {}) {
  assert.ok(active, 'native pixels belong to the exact callback request')
  const row = active, requestStarted = performance.now(), lazyConnectionMs = nativeConnectionCalls === 0 ? 1 : 0
  nativeConnectionCalls++
  const grab: any = { includeHostWindows, opacity: host.getOpacity(), capturedAt: Date.now(), startedMs: requestStarted - row.startedAt, sources: {}, displayProducerMs: [] }
  row.grabs.push(grab)
  assert.equal(grab.opacity, variant === 'baseline' && !includeHostWindows ? 0 : 0.65, 'only the historical baseline fades its host')
  const frames = []
  for (const [index, display] of displays.entries()) {
    const displayStarted = performance.now(), delayMs = 200 + index * 40
    await wait(delayMs)
    const { width, height } = display.bounds, png = image(width, height, ++nonce)
    grab.sources[display.id] = png
    const totalMs = performance.now() - displayStarted
    grab.displayProducerMs.push({ displayId: display.id, delayMs, totalMs })
    frames.push({ displayId: display.id, frame: display.bounds, scale: 1, safeTop: 0, windows: [],
      timing: { captureMs: delayMs, pngMs: Math.max(0, totalMs - delayMs), base64Ms: 0, totalMs }, png, width, height,
      engine: 'controlled-startup-' + (includeHostWindows ? 'included' : 'excluded') })
  }
  const isAlternate = includeHostWindows !== (background === 'included')
  if (variant === 'candidate' && isAlternate) await row.alternateGate
  grab.returnedMs = performance.now() - row.startedAt
  return { state: 'captured' as const, capturedAt: grab.capturedAt,
    timing: { contentMs: 1, windowListMs: 1, responseSerializationMs: 0, totalMs: grab.returnedMs - grab.startedMs,
      lazyConnectionMs, socketReadMs: 0, jsonParseMs: 0, requestMs: performance.now() - requestStarted, validationMs: 0 }, displays: frames }
}
function productionSurface() {
  const write = async (path: string, contents: string) => {
    const timing = JSON.parse(contents)
    active.writes.push(timing)
    active.diagnosticAfterVisible = active.windows.length === count && active.windows.every((entry: any) => entry.window.isVisible())
    await writeFile(path, contents)
  }
  const bind = new Function('CaptureSurface', 'getNativeDesktopOwner', 'config', 'pinScreenshot', 'copyScreenshotText', 'returnScreenshotFocus', 'writeFile', 'join', 'app',
    __CAPTURE_STARTUP_IPC_REGISTRATION__ + '\nreturn captureSurface')
  return bind(CaptureSurface, () => ({ captureDisplays }), { appearance: { terminalTheme: 'graphite', appAppearance: 'dark' } },
    async () => { throw new Error('Pin output is outside this startup proof.') }, async () => {}, () => {}, write, join, { getPath: () => userData }) as CaptureSurface
}
async function capture(iteration: number, warmup = false) {
  const opacityStart = receipt.opacityChanges.length
  let releaseAlternate!: () => void
  const alternateGate = new Promise<void>(resolve => { releaseAlternate = resolve })
  const row: any = { iteration, startedAt: 0, windows: [], grabs: [], writes: [], timing: null, finalTiming: null, deliveries: 0, alternateGate, releaseAlternate }
  active = row
  let captureError: unknown
  row.startedAt = performance.now()
  const callback = background === 'included' ? 0 : 1
  shortcutCallbacks[callback]!()
  await until('the actual GlobalScreenshot promise exists', () => Boolean(row.globalPromise))
  void row.globalPromise.catch((error: unknown) => { captureError = error })
  const overlays = await until('selected current overlays shown with their current frame', async () => {
    if (captureError) throw captureError
    if (row.windows.length !== count || !row.timing) return null
    const windows = row.windows.map((entry: any) => entry.window as BrowserWindow)
    if (windows.some(window => window.isDestroyed() || !window.isVisible()) || row.windows.some((entry: any) => entry.shownMs === null)) return null
    for (const window of windows) {
      const input = await window.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
      const expected = row.grabs.find((grab: any) => grab.includeHostWindows === (background === 'included'))?.sources[input.displayId]
      if (!expected) return null
      const actual = await window.webContents.executeJavaScript(`(()=>{const i=document.querySelector('img'),c=document.querySelector('canvas');return {src:i?.src,width:i?.naturalWidth,canvasWidth:c?.width}})()`)
      if (actual.src !== 'data:image/png;base64,' + expected) return null
      assert.ok(actual.width > 0 && actual.canvasWidth > 0, 'the selected PNG decoded and the shared editor allocated its canvas')
    }
    return windows
  })
  const observedShownMs = performance.now() - row.startedAt
  const actualShownMs = Math.max(...row.windows.map((entry: any) => entry.shownMs))
  assert.equal(row.windows.length, count)
  const expectedOrder = variant === 'candidate' ? [background === 'included', background === 'excluded'] : [true, false]
  assert.deepEqual(row.grabs.map((grab: any) => grab.includeHostWindows), expectedOrder, 'the selected background leads only in the candidate')
  assert.deepEqual(row.grabs.map((grab: any) => grab.opacity), variant === 'candidate' ? [0.65, 0.65] : [0.65, 0])
  assert.equal(host.getOpacity(), variant === 'candidate' ? 0.65 : 0)
  assert.deepEqual(receipt.opacityChanges.slice(opacityStart).map((row: any) => row.value), variant === 'candidate' ? [] : [0])
  assert.ok(row.windows.every((entry: any) => entry.protectionAtShow === (variant === 'candidate') && entry.window.isContentProtected() === (variant === 'candidate')))
  const completedGrabs = variant === 'baseline' ? row.grabs : row.grabs.slice(0, 1)
  assert.ok(completedGrabs.every((grab: any) => grab.returnedMs - grab.startedMs >= 200), 'each returned native exposure really waits for its controlled pixels')
  assert.ok(row.grabs.every((grab: any) => grab.displayProducerMs.every((value: any, index: number) => value.delayMs === 200 + index * 40 && value.totalMs >= value.delayMs)),
    'each display has its own real producer delay')
  assert.ok(row.timing.presentedMs.length === count && row.timing.presentedMs.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)))
  assert.ok(row.timing.shownMs + 1 >= Math.max(...row.timing.presentedMs), 'the native show follows the selected canvas presentation, never a blank early shell')
  assert.ok(row.timing.shownMs <= observedShownMs + 20 && actualShownMs + 20 >= row.timing.shownMs, 'independent visibility and the exact DOM observation bracket the production show')
  if (variant === 'baseline') assert.ok(row.grabs.length === 2 && actualShownMs >= row.grabs[1].returnedMs, 'the old path shows only after both exposures')
  else {
    assert.equal(row.grabs[1].returnedMs, undefined, 'the alternate producer is still pending after the selected show')
    const pendingInput = await overlays[0]!.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
    const other = background === 'included' ? 'excluded' : 'included'
    assert.equal(pendingInput.backgrounds[other].status, 'pending', 'the deferred background is really pending after the selected show')
    assert.equal(await overlays[0]!.webContents.executeJavaScript(`window.captureSurface.select(${JSON.stringify(pendingInput.requestId)})`), true)
    await overlays[0]!.webContents.executeJavaScript(`window.captureSurface.switchBackground(${JSON.stringify(pendingInput.requestId)},${JSON.stringify(other)})`)
    const pendingOutput = await overlays[0]!.webContents.executeJavaScript(`window.captureSurface.finish(${JSON.stringify(pendingInput.requestId)},${JSON.stringify(other)},${JSON.stringify(pendingInput.backgrounds[background].image)},{x:0,y:0,width:1,height:1}).then(()=>null,error=>error.message)`)
    assert.ok(typeof pendingOutput === 'string' && pendingOutput.length > 0, 'pending output is refused by the real Main boundary')
    assert.equal(row.deliveries, 0)
    const stillSelected = await overlays[0]!.webContents.executeJavaScript(`document.querySelector('img')?.src`)
    assert.equal(stillSelected, pendingInput.backgrounds[background].image!.dataUrl, 'pending never changes the displayed document')
  }
  releaseAlternate()
  if (variant === 'candidate') await until('the deferred snapshot and exactly one final diagnostic', async () => {
    if (!row.finalTiming || row.writes.length !== 2) return null
    const latest = JSON.parse(await readFile(latestPath, 'utf8'))
    return latest.requestId === row.timing.requestId && latest.final === true ? latest : null
  })
  if (variant === 'candidate') assert.ok(actualShownMs < row.grabs[1].returnedMs, 'actual visibility precedes the deferred native return')
  const diagnostic = variant === 'candidate' ? row.finalTiming : await until('the production IPC diagnostic write', async () => {
    if (row.writes.length !== 1) return null
    return JSON.parse(await readFile(latestPath, 'utf8'))
  })
  assert.equal(row.diagnosticAfterVisible, true)
  if (variant === 'candidate') {
    assert.equal(row.timing.schema, 'agentmux.capture-timing.v2')
    assert.equal(row.finalTiming.schema, 'agentmux.capture-timing.v2')
    assert.equal(row.finalTiming.shownMs, row.timing.shownMs, 'the final record adds alternate timings without replacing the first show')
    assert.equal(row.writes.filter((write: any) => write.requestId === row.timing.requestId).length, 2, 'one initial and one final record for the same request')
    assert.deepEqual(row.writes.map((write: any) => write.final), [false, true])
    for (const key of ['callbackToPrepareMs', 'prepareMs', 'screenCaptureMs', 'presentMs', 'dataReadyMs', 'shownMs']) assert.ok(Number.isFinite(row.finalTiming[key]), key + ' is measured')
    assert.equal(row.finalTiming.physicalKeydownToCallbackMs, null, 'physical keydown before callback remains unknown')
    assert.equal(row.finalTiming.rendererMs.length, count)
    for (const renderer of row.finalTiming.rendererMs) for (const key of ['loadMs', 'decodeMs', 'paintMs', 'presentedMs']) assert.ok(Number.isFinite(renderer[key]), 'Renderer ' + key)
    for (const mode of ['included', 'excluded']) {
      const native = row.finalTiming['native' + mode[0]!.toUpperCase() + mode.slice(1)]
      for (const key of ['contentMs', 'windowListMs', 'responseSerializationMs', 'totalMs', 'lazyConnectionMs', 'socketReadMs', 'jsonParseMs', 'requestMs', 'validationMs']) assert.ok(Number.isFinite(native.response[key]), mode + ' native ' + key)
      assert.equal(native.response.lazyConnectionMs, mode === background && iteration === 1 ? 1 : 0, 'lazy native setup follows actual first/reused calls, including warm-up')
      assert.equal(native.displays.length, count)
      for (const frame of native.displays) for (const key of ['captureMs', 'pngMs', 'base64Ms', 'totalMs']) assert.ok(Number.isFinite(frame.timing[key]), mode + ' display ' + key)
    }
    assert.ok(row.finalTiming.actualVisible.every((value: unknown) => value === true), 'the final diagnostic reads real isVisible')
    assert.ok(Buffer.byteLength(JSON.stringify(row.finalTiming)) < 16384, 'diagnostics stay small')
    for (const window of overlays) {
      const input = await window.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
      assert.equal(input.revision, 2, 'load returns the latest settled snapshot')
      assert.equal(input.background, background, 'ready never auto-switches the request background')
      const expected = row.grabs.find((grab: any) => grab.includeHostWindows === (background === 'included')).sources[input.displayId]
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('img')?.src`), 'data:image/png;base64,' + expected, 'ready does not replace the current editor document')
    }
  }
  if (iteration === 1) {
    overlays[0]!.webContents.debugger.attach('1.3')
    await overlays[0]!.webContents.executeJavaScript('document.querySelector("canvas").focus()')
    await overlays[0]!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch((error: unknown) => { if (!overlays[0]!.isDestroyed()) throw error })
  } else await overlays[0]!.webContents.executeJavaScript('window.captureSurface.load().then(i=>window.captureSurface.cancel(i.requestId))').catch((error: unknown) => { if (!overlays[0]!.isDestroyed()) throw error })
  await row.globalPromise
  assert.equal(captureError, undefined)
  assert.equal(host.getOpacity(), 0.65)
  assert.deepEqual(receipt.opacityChanges.slice(opacityStart).map((row: any) => row.value), variant === 'candidate' ? [] : [0, 0.65])
  assert.ok(overlays.every(window => window.isDestroyed()), 'the capture releases all shells')
  const sourceHashes = row.grabs.map((grab: any) => Object.fromEntries(Object.entries(grab.sources).map(([id, png]) => [id, createHash('sha256').update(String(png)).digest('hex')])))
  if (previousSourceHashes) assert.notDeepEqual(sourceHashes, previousSourceHashes, 'every measured repeat freezes new pixels rather than reusing warm-up frames')
  previousSourceHashes = sourceHashes
  if (!warmup) receipt.captures.push({ iteration, actualShownMs, observedShownMs, showEventMs: row.windows.map((entry: any) => entry.showEventMs),
    constructedMs: row.windows.map((entry: any) => entry.constructedMs), grabs: row.grabs.map(({ sources, alternateGate, ...grab }: any) => grab), sourceHashes,
    timing: row.timing, finalTiming: row.finalTiming, diagnostic })
  active = null
}
async function run() {
  await app.whenReady()
  screen.getAllDisplays = (() => displays) as typeof screen.getAllDisplays
  screen.getDisplayNearestPoint = (() => displays[0]) as unknown as typeof screen.getDisplayNearestPoint
  screen.getCursorScreenPoint = () => ({ x: 200, y: 150 })
  host = new BrowserWindow({ width: 320, height: 220, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body style="background:%231b2630;color:white;font:18px -apple-system;padding:24px">Startup proof host</body>')
  host.setOpacity(0.65)
  const setHostOpacity = host.setOpacity.bind(host)
  host.setOpacity = value => { receipt.opacityChanges.push({ value, observedMs: performance.now() }); setHostOpacity(value) }
  surface = productionSurface()
  const screenCapture = new ScreenCapture({ home: userData, native: () => ({
    captureScreenshot: async () => { throw new Error('Source picking is outside this startup proof.') },
    writeClipboardImage: async () => { active.deliveries++ }
  }), appActive: () => true, edit: async () => { throw new Error('Independent editing is outside this startup proof.') },
    present: session => surface.present(session), reportIssue: error => { throw error } })
  globalCapture = new GlobalScreenshot({ contents: { isDestroyed: () => true, mainFrame: {} } as never,
    focusedWindow: () => null, windowForDocument: () => { throw new Error('No draft is available in this startup proof.') },
    capture: (attachToDraft, selected, timing) => screenCapture.capture(attachToDraft, 'selection', {}, selected, timing),
    reportIssue: error => { throw error }, remindPending: () => {} })
  shortcut = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register: (_accelerator, callback) => { shortcutCallbacks.push(callback); return true }, unregister: () => {} },
    request: (selected, timing) => {
      const promise = globalCapture.run(selected, timing)
      active.globalPromise = promise
      void promise.catch(error => console.error('Shortcut capture failed:', error))
    } })
  if (iteration === 2) await capture(1, true)
  await capture(iteration)
  assert.equal(receipt.opacityChanges.length, variant === 'candidate' ? 0 : iteration === 1 ? 2 : 4)
  receipt.passed = true
}
void run().catch(error => {
  receipt.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
  process.exitCode = 1
}).finally(async () => {
  try { active?.releaseAlternate?.() } catch {}
  try { shortcut?.dispose() } catch {}
  try { surface?.dispose() } catch {}
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
