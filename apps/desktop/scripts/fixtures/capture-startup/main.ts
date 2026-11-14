import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadavg, freemem, totalmem } from 'node:os'
import { createHash } from 'node:crypto'
import { CaptureSurface } from '../../../src/main/capture-surface'

const out = process.env.AGENTMUX_CAPTURE_STARTUP_OUT!
const variant = process.env.AGENTMUX_CAPTURE_STARTUP_VARIANT!
const count = Number(process.env.AGENTMUX_CAPTURE_STARTUP_DISPLAYS)
assert.ok(out && ['baseline', 'candidate'].includes(variant) && [1, 2].includes(count))
assert.ok(process.env.AGENTMUX_CAPTURE_STARTUP_USER_DATA)
app.setPath('userData', process.env.AGENTMUX_CAPTURE_STARTUP_USER_DATA!)
app.on('window-all-closed', () => {})
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 960, height: 640 }, scaleFactor: 1, displayFrequency: 60 },
  { id: 7, bounds: { x: 960, y: 0, width: 800, height: 640 }, scaleFactor: 1, displayFrequency: 60 }].slice(0, count)
const receipt: any = { schema: 'agentmux.capture-startup-electron.v1', passed: false, variant, count, captures: [],
  boundary: 'Actual production CaptureSurface, isolated preload and shared Renderer in Electron; native pixels, display list and 200 ms producer delay are controlled. No OS pixels, clipboard, TCC or physical multi-monitor proof.',
  conditions: { loadavg: loadavg(), freeMemory: freemem(), totalMemory: totalmem(), electron: process.versions.electron },
  visibilityObservation: 'Native BrowserWindow.isVisible() sampled every 5 ms; show event offset retained separately because macOS panels shown inactive may omit it.' }
let host: BrowserWindow, surface: CaptureSurface, active: any = null
const latestPath = join(out, 'latest-timing.json')
const info = console.info
console.info = (...args) => {
  if (active && typeof args[0] === 'string' && args[0].startsWith('capture-surface timing '))
    active.timing = JSON.parse(args[0].slice('capture-surface timing '.length))
  info(...args)
}
app.on('browser-window-created', (_event, window) => {
  // Only production present() constructs windows while this exact capture is active.
  if (active) {
    const row = active, entry: any = { window, constructedMs: performance.now() - row.startedAt, shownMs: null, showEventMs: null }
    row.windows.push(entry)
    window.on('show', () => { entry.showEventMs ??= performance.now() - row.startedAt })
    const observe = setInterval(() => {
      if (window.isDestroyed()) { clearInterval(observe); return }
      if (window.isVisible()) { entry.shownMs = performance.now() - row.startedAt; clearInterval(observe) }
    }, 5)
    window.once('closed', () => clearInterval(observe))
  }
})
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T>): Promise<NonNullable<T>> {
  const start = performance.now()
  while (performance.now() - start < 10000) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await wait(10)
  }
  throw new Error('Observation timed out: ' + label)
}
function image(width: number, height: number, nonce: number) {
  const rgba = [40 + nonce * 13, 70 + nonce * 7, 110 + nonce * 5]
  const bitmap = Buffer.alloc(width * height * 4)
  for (let at = 0; at < bitmap.length; at += 4) {
    bitmap[at] = rgba[2]!; bitmap[at + 1] = rgba[1]!; bitmap[at + 2] = rgba[0]!; bitmap[at + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG().toString('base64')
}
async function capture(iteration: number) {
  const row: any = { iteration, startedAt: performance.now(), windows: [], grabs: [], timing: null, diagnostic: null }
  active = row
  let captureError: unknown
  const outcome = surface.present({ background: 'included', attachToDraft: false, expandable: false, returnFocus: false,
    complete: async () => { throw new Error('This startup proof never delivers pixels or writes a clipboard.') } })
  void outcome.catch(error => { captureError = error })
  const overlays = await until('all current overlays shown with their current frame', async () => {
    if (captureError) throw captureError
    if (row.windows.length !== count || !row.timing) return null
    const windows = row.windows.map((entry: any) => entry.window as BrowserWindow)
    if (windows.some((window: BrowserWindow) => window.isDestroyed() || !window.isVisible()) || row.windows.some((entry: any) => entry.shownMs === null)) return null
    for (const window of windows) {
      const input = await window.webContents.executeJavaScript('window.captureSurface.load()')
      const expected = row.grabs.find((grab: any) => grab.includeHostWindows).sources[input.displayId]
      const actual = await window.webContents.executeJavaScript(`(()=>{const i=document.querySelector('img'),c=document.querySelector('canvas');return {src:i?.src,width:i?.naturalWidth,canvasWidth:c?.width}})()`)
      assert.equal(actual.src, 'data:image/png;base64,' + expected, 'the DOM source is this capture nonce, never a previous frame')
      assert.equal(actual.width, input.backgrounds.included.image.width)
      assert.ok(actual.canvasWidth > 0, 'the shared editor allocated its actual canvas')
    }
    return windows
  })
  const observedShownMs = performance.now() - row.startedAt
  assert.ok(row.windows.every((entry: any) => typeof entry.shownMs === 'number'), 'actual native window visibility must be observed')
  const actualShownMs = Math.max(...row.windows.map((entry: any) => entry.shownMs))
  assert.equal(row.windows.length, count, 'exactly the current displays get overlays')
  assert.deepEqual(row.grabs.map((grab: any) => grab.includeHostWindows), [true, false])
  assert.deepEqual(row.grabs.map((grab: any) => grab.opacity), [0.65, 0], 'exposures match the actual visible host state')
  assert.equal(host.getOpacity(), 0)
  assert.ok(row.grabs.every((grab: any) => grab.returnedMs - grab.startedMs >= 200), 'native delay uses real elapsed time')
  assert.ok(row.timing.presentedMs.length === count && row.timing.presentedMs.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)), 'every actual current frame reported presented')
  assert.ok(typeof row.timing.framesMs === 'number' && typeof row.timing.shownMs === 'number')
  const lastNative = row.grabs.at(-1).returnedMs
  assert.ok(row.timing.shownMs >= Math.floor(lastNative) - 1 && row.timing.shownMs <= observedShownMs + 1, 'logged shown time stays between actual native return and fresh-DOM observation')
  assert.ok(row.timing.framesMs >= Math.floor(lastNative) - 1 && row.timing.framesMs <= row.timing.shownMs, 'native return must agree with the measured frame phase')
  if (variant === 'baseline') assert.ok(row.windows.every((entry: any) => entry.constructedMs >= lastNative), 'unoptimized source creates shells only after native returns')
  else {
    assert.ok(row.windows.every((entry: any) => entry.constructedMs < row.grabs[0].returnedMs), 'candidate boots every hidden shell while current native work is pending')
    const diagnostic = await until('latest small timing write after showing', async () => {
      try {
        const record = JSON.parse(await readFile(latestPath, 'utf8'))
        return record.recordedAt === row.timing.recordedAt ? record : null
      } catch { return null }
    })
    const fields = ['schema', 'recordedAt', 'windowsStartedMs', 'windowsLoadedMs', 'includedMs', 'excludedMs', 'dataReadyMs', 'settleMs', 'framesMs', 'presentedMs', 'shownMs', 'displays']
    assert.deepEqual(Object.keys(diagnostic).sort(), fields.sort(), 'only the declared phase fields are persisted')
    assert.equal(diagnostic.schema, 'agentmux.capture-timing.v1')
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) < 4096, 'diagnostic stays small without pixels, filenames or draft content')
    for (const [key, value] of Object.entries(diagnostic)) if (key !== 'schema') {
      const values = Array.isArray(value) ? value : [value]
      assert.ok(values.every(item => item === null || (typeof item === 'number' && Number.isFinite(item))), 'no text/pixels/path can enter phase diagnostics: ' + key)
    }
    assert.equal(row.diagnosticAfterVisible, true, 'diagnostic I/O starts only after showing every overlay')
    row.diagnostic = diagnostic
  }
  if (iteration === 1) {
    overlays[0]!.webContents.debugger.attach('1.3')
    await overlays[0]!.webContents.executeJavaScript('document.querySelector("canvas").focus()')
    await overlays[0]!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(error => { if (!overlays[0]!.isDestroyed()) throw error })
  } else {
    // Cancellation destroys this exact Renderer, so its JS response is not the operation receipt.
    await Promise.race([outcome, overlays[0]!.webContents.executeJavaScript('window.captureSurface.load().then(i=>window.captureSurface.cancel(i.requestId))')])
  }
  assert.deepEqual(await outcome, { state: 'cancelled' })
  assert.equal(host.getOpacity(), 0.65, 'both Esc and exact bridge cancellation restore original host opacity')
  assert.ok(overlays.every((window: BrowserWindow) => window.isDestroyed()), 'the capture releases all of its shells')
  const sourceHashes = row.grabs.map((grab: any) => Object.fromEntries(Object.entries(grab.sources).map(([id, png]) => [id, createHash('sha256').update(String(png)).digest('hex')])))
  if (receipt.captures.length) assert.notDeepEqual(sourceHashes, receipt.captures[0].sourceHashes, 'repeat capture actually freezes different pixels')
  receipt.captures.push({ iteration, actualShownMs, showEventMs: row.windows.map((entry: any) => entry.showEventMs), loggedShowOffsetMs: row.timing.shownMs - actualShownMs, constructedMs: row.windows.map((entry: any) => entry.constructedMs),
    grabs: row.grabs.map(({ sources, ...grab }: any) => grab), sourceHashes, timing: row.timing, diagnostic: row.diagnostic,
    observedShownMs })
  active = null
}
async function run() {
  await app.whenReady()
  screen.getAllDisplays = (() => displays) as typeof screen.getAllDisplays
  screen.getDisplayNearestPoint = (() => displays[0]) as typeof screen.getDisplayNearestPoint
  screen.getCursorScreenPoint = () => ({ x: 200, y: 150 })
  host = new BrowserWindow({ width: 320, height: 220, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body style="background:%231b2630;color:white;font:18px -apple-system;padding:24px">Startup proof host · 65% opacity</body>')
  host.setOpacity(0.65)
  surface = new CaptureSurface({ native: () => ({ captureDisplays: async ({ includeHostWindows = false } = {}) => {
    assert.ok(active, 'native pixels belong to one exact active capture')
    const grab: any = { includeHostWindows, opacity: host.getOpacity(), capturedAt: Date.now(), startedMs: performance.now() - active.startedAt, sources: {} }
    assert.equal(grab.opacity, includeHostWindows ? 0.65 : 0)
    active.grabs.push(grab)
    const frames = displays.map((display, index) => {
      const { width, height } = display.bounds
      const png = image(width, height, active.iteration * 4 + index + (includeHostWindows ? 0 : 2))
      grab.sources[display.id] = png
      return { displayId: display.id, frame: display.bounds, scale: 1, safeTop: 0, windows: [], timing: { captureMs: 1, pngMs: 1, base64Ms: 0, totalMs: 2 }, png, width, height, engine: 'controlled-startup-' + (includeHostWindows ? 'included' : 'excluded') }
    })
    await wait(200)
    grab.returnedMs = performance.now() - active.startedAt
    return { state: 'captured' as const, capturedAt: grab.capturedAt, timing: { contentMs: 1, windowListMs: 1, totalMs: 3, requestMs: 4, validationMs: 1 }, displays: frames }
  } }), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    pin: async () => { throw new Error('No pin output in a startup proof.') }, copyText: async () => {}, returnFocus: () => {},
    recordTiming: async timing => {
      active.diagnosticAfterVisible = active.windows.length === count && active.windows.every((entry: any) => entry.window.isVisible())
      await writeFile(latestPath, JSON.stringify(timing))
    } })
  for (const iteration of [1, 2]) await capture(iteration)
  receipt.passed = true
}
// Electron's ESM entry must finish evaluation before app readiness can resolve.
void run().catch(error => {
  receipt.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
  process.exitCode = 1
}).finally(async () => {
  surface?.dispose()
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
