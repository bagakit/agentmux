import assert from 'node:assert/strict'
import { app, BrowserWindow, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import { CaptureSurface } from '../../../src/main/capture-surface'
import { GlobalScreenshot } from '../../../src/main/global-screenshot'
import { ScreenCapture } from '../../../src/main/screen-capture'
import { registerScreenshotShortcut } from '../../../src/main/screenshot-shortcut'
import { NativeDesktop } from '@agentmux/native-desktop'
import type { CaptureBackground, CaptureSurfaceInput } from '../../../src/shared/capture-surface'

const out = process.env.AGENTMUX_CAPTURE_REAL_OUT!
const executablePath = process.env.AGENTMUX_CAPTURE_REAL_EXECUTABLE!
const userData = process.env.AGENTMUX_CAPTURE_REAL_USER_DATA!
const variant = process.env.AGENTMUX_CAPTURE_REAL_VARIANT! as 'baseline' | 'candidate'
const background = process.env.AGENTMUX_CAPTURE_REAL_BACKGROUND! as CaptureBackground
const iteration = Number(process.env.AGENTMUX_CAPTURE_REAL_ITERATION)
assert.ok(out && executablePath && userData && ['baseline', 'candidate'].includes(variant) && ['included', 'excluded'].includes(background) && [1, 2].includes(iteration))
app.setPath('userData', userData)
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.capture-real-startup-sample.v1', passed: false, variant, background, iteration, topology: [], captures: [], opacityWrites: [], cleanup: {} }
let host: BrowserWindow, native: NativeDesktop, surface: CaptureSurface, shortcut: { dispose(): void }, active: any
const callbacks: Array<() => void> = []
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T> | T, budget = 20000): Promise<NonNullable<T>> {
  const started = performance.now()
  while (performance.now() - started < budget) { const result = await read(); if (result) return result as NonNullable<T>; await wait(10) }
  throw new Error('Observation timed out: ' + label)
}
app.on('browser-window-created', (_event, window) => {
  if (!active) return
  const row = active, item: any = { window, shownMs: null, showEventMs: null }
  row.windows.push(item)
  window.on('show', () => { item.showEventMs ??= performance.now() - row.startedAt })
  const observe = setInterval(() => {
    if (window.isDestroyed()) { clearInterval(observe); return }
    if (window.isVisible()) { item.shownMs ??= performance.now() - row.startedAt; clearInterval(observe) }
  }, 5)
  window.once('closed', () => clearInterval(observe))
})
async function captureDisplays(input: { includeHostWindows: boolean }) {
  const row = active, startedMs = performance.now() - row.startedAt
  const frames = await native.captureDisplays(input)
  row.exposures.push({ included: input.includeHostWindows, startedMs, completedMs: performance.now() - row.startedAt,
    displays: frames.displays.map(frame => ({ displayId: frame.displayId, engine: frame.engine, width: frame.width, height: frame.height })) })
  return frames
}
async function capture(number: number, warmup = false) {
  const row: any = { startedAt: performance.now(), windows: [], exposures: [], promise: null, error: null }
  active = row
  callbacks[background === 'included' ? 0 : 1]!()
  await until('registered shortcut started its original capture', () => Boolean(row.promise))
  let settled = false
  void row.promise.then(() => { settled = true }, (error: unknown) => { row.error = String(error); settled = true })
  const windows = await until('all real display surfaces show a decoded selected frame', async () => {
    if (row.error) throw new Error(row.error)
    if (row.windows.length !== receipt.topology.length || row.windows.some((entry: any) => entry.shownMs === null || entry.window.isDestroyed())) return null
    for (const entry of row.windows) {
      const ready = await entry.window.webContents.executeJavaScript("Boolean(document.querySelector('img')?.naturalWidth && document.querySelector('canvas')?.width)")
      if (!ready) return null
    }
    return row.windows.map((entry: any) => entry.window as BrowserWindow)
  })
  const actualShownMs = Math.max(...row.windows.map((entry: any) => entry.shownMs))
  for (const window of windows) {
    const input = await window.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
    assert.equal(input.background, background, 'the exact requested background is displayed')
  }
  await until('both real native exposures settled', () => row.exposures.length === 2)
  const original = windows[0]!
  await original.webContents.executeJavaScript('window.captureSurface.load().then(i=>{void window.captureSurface.cancel(i.requestId)}); true').catch((error: unknown) => { if (!original.isDestroyed()) throw error })
  await until('the original capture settled after cancellation', () => settled)
  if (row.error) throw new Error(row.error)
  assert.ok(windows.every((window: BrowserWindow) => window.isDestroyed()), 'all original capture surfaces closed')
  if (!warmup) receipt.captures.push({ iteration: number, actualShownMs, showEventMs: row.windows.map((entry: any) => entry.showEventMs), exposures: row.exposures })
  active = null
}
async function run() {
  await app.whenReady()
  receipt.topology = screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor }))
  assert.ok(receipt.topology.length > 0, 'real display topology is required')
  host = new BrowserWindow({ width: 320, height: 220, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body style="background:%231b2630;color:white;font:18px -apple-system;padding:24px">Screenshot performance check</body>')
  host.setOpacity(0.65)
  const setOpacity = host.setOpacity.bind(host)
  host.setOpacity = value => { receipt.opacityWrites.push(value); setOpacity(value) }
  native = new NativeDesktop({ executablePath, connectTimeoutMs: 15000, requestTimeoutMs: 45000 })
  surface = new CaptureSurface({ native: () => ({ captureDisplays }), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    pin: async () => { throw new Error('Pin is outside this performance sample.') }, copyText: async () => {}, returnFocus: () => {} })
  const screenCapture = new ScreenCapture({ home: userData, native: () => ({ captureScreenshot: async () => { throw new Error('Source picking is outside this sample.') }, writeClipboardImage: async () => {} }),
    appActive: () => true, edit: async () => { throw new Error('Editing is outside this sample.') }, present: session => surface.present(session), reportIssue: error => { throw error } })
  const globalCapture = new GlobalScreenshot({ contents: { isDestroyed: () => true, mainFrame: {} } as never, focusedWindow: () => null,
    windowForDocument: () => { throw new Error('No draft is available in this sample.') }, capture: (attach, selected, timing) => screenCapture.capture(attach, 'selection', {}, selected, timing),
    reportIssue: error => { throw error }, remindPending: () => {} })
  shortcut = registerScreenshotShortcut({ platform: 'darwin', shortcuts: { register: (_key, callback) => { callbacks.push(callback); return true }, unregister: () => {} },
    request: (selected, timing) => { active.promise = globalCapture.run(selected, timing) } })
  if (iteration === 2) await capture(1, true)
  await capture(iteration)
  assert.equal(receipt.captures.length, 1)
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { name: (error as Error).name, message: (error as Error).message }; process.exitCode = 1 }).finally(async () => {
  try { shortcut?.dispose() } catch {}
  try { surface?.dispose() } catch {}
  try { await native?.dispose(); receipt.cleanup.nativeDisposed = true } catch (error) { receipt.cleanup.nativeDisposeError = String(error) }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  receipt.cleanup.windowsRemaining = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length
  await writeFile(out + '/native.json', JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
