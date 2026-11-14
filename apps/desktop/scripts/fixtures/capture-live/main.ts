import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeDesktop } from '@agentmux/native-desktop'
import { CaptureSurface } from '../../../src/main/capture-surface'
import type { CaptureBackground, CaptureSurfaceInput } from '../../../src/shared/capture-surface'

const out = process.env.AGENTMUX_CAPTURE_LIVE_OUT!
const executablePath = process.env.AGENTMUX_CAPTURE_LIVE_EXECUTABLE!
assert.ok(out && executablePath && process.env.AGENTMUX_CAPTURE_LIVE_USER_DATA)
app.setPath('userData', process.env.AGENTMUX_CAPTURE_LIVE_USER_DATA!)
app.on('window-all-closed', () => {})

const receipt: any = {
  schema: 'agentmux.capture-live-fixture.v1', passed: false, checks: [], cases: [], nativeCalls: [], opacityWrites: [],
  boundary: 'Actual CaptureSurface, real NativeDesktop/ScreenCaptureKit, visible Electron hosts, production preload and Renderer. Pixel evidence is reduced to in-memory color counts; no desktop PNG, draft text or user path is persisted.',
  cleanup: { nativeDisposed: false, windowsRemaining: null }
}
let native: NativeDesktop | undefined
let surface: CaptureSurface | undefined
let host: BrowserWindow | undefined
let pin: BrowserWindow | undefined
let hidden: BrowserWindow | undefined
let minimized: BrowserWindow | undefined
let releaseHeld: (() => void) | undefined
let currentPhase = 'startup'
const nativeResults: Array<{ phase: string; includeHostWindows: boolean; result: any }> = []
const overlayEvents = new WeakMap<BrowserWindow, Array<{ kind: string; value?: boolean; protected?: boolean }>>()
let created: BrowserWindow[] | null = null

app.on('browser-window-created', (_event, window) => {
  if (!created) return
  created.push(window)
  const events: Array<{ kind: string; value?: boolean; protected?: boolean }> = []
  overlayEvents.set(window, events)
  const protect = window.setContentProtection.bind(window)
  window.setContentProtection = value => { events.push({ kind: 'content-protection', value }); protect(value) }
  const show = window.show.bind(window)
  window.show = () => { events.push({ kind: 'show', protected: window.isContentProtected() }); show() }
  const showInactive = window.showInactive.bind(window)
  window.showInactive = () => { events.push({ kind: 'showInactive', protected: window.isContentProtected() }); showInactive() }
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T> | T, budgetMs = 20000): Promise<NonNullable<T>> {
  const started = performance.now()
  while (performance.now() - started < budgetMs) {
    const value = await read()
    if (value) return value as NonNullable<T>
    await wait(25)
  }
  throw new Error('Timed out: ' + label)
}
function check(name: string, value: unknown, details: Record<string, unknown> = {}): asserts value {
  receipt.checks.push({ name, passed: Boolean(value), ...details })
  assert.ok(value, name)
}
function observeOpacity(window: BrowserWindow, label: string): void {
  const original = window.setOpacity.bind(window)
  window.setOpacity = value => { receipt.opacityWrites.push({ window: label, value }); original(value) }
}
function exactHostOpacity(): boolean {
  return host?.getOpacity() === 1 && pin?.getOpacity() === 0.4 && hidden?.getOpacity() === 0.8 && minimized?.getOpacity() === 0.6
    && receipt.opacityWrites.length === 0
}
function frameFor(frames: any, displayId: number): any {
  const frame = frames.displays.find((candidate: any) => candidate.displayId === displayId)
  check('the host display has real captured pixels', frame && typeof frame.png === 'string')
  return frame
}
function hostRegion(frame: any, content: { x: number; y: number; width: number; height: number }) {
  const scaleX = frame.width / frame.frame.width, scaleY = frame.height / frame.frame.height
  const inset = 16
  const left = Math.max(content.x, frame.frame.x) + inset, top = Math.max(content.y, frame.frame.y) + inset
  const right = Math.min(content.x + content.width, frame.frame.x + frame.frame.width) - inset
  const bottom = Math.min(content.y + content.height, frame.frame.y + frame.frame.height) - inset
  return { x: (left - frame.frame.x) * scaleX, y: (top - frame.frame.y) * scaleY,
    width: (right - left) * scaleX, height: (bottom - top) * scaleY }
}
type Color = 'host-initial' | 'host-changed' | 'overlay-marker'
function colorPixels(png: string, region: { x: number; y: number; width: number; height: number }, color: Color) {
  const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
  const size = image.getSize(), bytes = image.toBitmap()
  const x0 = Math.max(0, Math.floor(region.x)), y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(size.width, Math.ceil(region.x + region.width)), y1 = Math.min(size.height, Math.ceil(region.y + region.height))
  let matches = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * size.width + x) * 4
    const first = bytes[offset]!, green = bytes[offset + 1]!, third = bytes[offset + 2]!, alpha = bytes[offset + 3]!
    const high = Math.max(first, third), low = Math.min(first, third)
    const matched = color === 'host-initial'
      ? high > 240 && low > 170 && low < 230 && green < 30 && alpha > 245
      : color === 'host-changed'
        ? high > 240 && low < 30 && green > 170 && green < 230 && alpha > 245
        : high > 120 && high < 200 && low < 30 && green > 240 && alpha > 245
    if (matched) matches++
  }
  return { matches, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) }
}
async function painted(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
}
async function captureForSurface(options: { includeHostWindows?: boolean } = {}): Promise<any> {
  const includeHostWindows = options.includeHostWindows === true
  const result = await native!.captureDisplays({ includeHostWindows })
  receipt.nativeCalls.push({ phase: currentPhase, includeHostWindows, capturedAt: result.capturedAt })
  nativeResults.push({ phase: currentPhase, includeHostWindows, result })
  if (currentPhase === 'cancelled-old' && includeHostWindows) {
    heldNativeResult = true
    await new Promise<void>(resolve => { releaseHeld = resolve })
  }
  return result
}
let heldNativeResult = false

async function openCapture(background: CaptureBackground, phase: string) {
  currentPhase = phase
  const firstResult = nativeResults.length, displays = screen.getAllDisplays()
  created = []
  let captureError: unknown
  const outcome = surface!.present({ background, attachToDraft: false, expandable: false, returnFocus: false,
    complete: async () => { throw new Error('The lifecycle proof never writes a clipboard or delivers pixels.') } })
  void outcome.catch(error => { captureError = error })
  const overlays = await until('all real overlays allocated', () => {
    if (captureError) throw captureError
    return created!.length === displays.length ? [...created!] : null
  })
  created = null
  const inputs: CaptureSurfaceInput[] = []
  for (const overlay of overlays) {
    await until('real overlay shown with its decoded frozen frame', async () => {
      if (captureError) throw captureError
      try {
        return overlay.isVisible() && await overlay.webContents.executeJavaScript(`document.querySelector('img')?.naturalWidth>0&&document.querySelector('canvas')?.width>0`)
      } catch { return false }
    })
    const input = await overlay.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
    inputs.push(input)
    const events = overlayEvents.get(overlay) ?? []
    events.push({ kind: 'load-observed' })
    check('every real overlay is content protected', overlay.isContentProtected())
    const protection = events.findIndex(event => event.kind === 'content-protection' && event.value === true)
    const inputObservation = events.findIndex(event => event.kind === 'load-observed')
    const firstShow = events.findIndex(event => event.kind === 'show' || event.kind === 'showInactive')
    check('content protection precedes released input and every real show path', protection >= 0 && inputObservation > protection && firstShow > protection)
    const shows = events.filter(event => event.kind === 'show' || event.kind === 'showInactive')
    check('every observed real show was protected', shows.length > 0 && shows.every(event => event.protected === true))
  }
  const exposures = nativeResults.slice(firstResult)
  check('a visible host produces exact included then excluded native exposures', exposures.length === 2
    && exposures[0]?.includeHostWindows === true && exposures[1]?.includeHostWindows === false)
  for (const input of inputs) for (const background of ['included', 'excluded'] as const) {
    const exposure = exposures.find(row => row.includeHostWindows === (background === 'included'))!
    const frame = frameFor(exposure.result, input.displayId)
    check('the real preload receives the exact native ' + background + ' background', input.backgrounds[background].image?.dataUrl === 'data:image/png;base64,' + frame.png)
    check('the real background keeps native capturedAt and engine', input.backgrounds[background].capturedAt === exposure.result.capturedAt
      && input.backgrounds[background].engine === frame.engine)
  }
  check('all real hosts keep exact opacity after opening', exactHostOpacity())
  return { outcome, overlays, inputs, exposures }
}
async function cancelCapture(capture: { outcome: Promise<any>; overlays: BrowserWindow[]; inputs: CaptureSurfaceInput[] }): Promise<void> {
  const target = capture.overlays[0]!, input = capture.inputs[0]!
  await target.webContents.executeJavaScript(`window.captureSurface.cancel(${JSON.stringify(input.requestId)})`)
    .catch(error => { if (!target.isDestroyed()) throw error })
  assert.deepEqual(await capture.outcome, { state: 'cancelled' })
  check('cancellation destroys every real overlay', capture.overlays.every(window => window.isDestroyed()))
  await until('the original visible host regains real focus', () => host!.isFocused() && app.isActive())
  check('cancellation restores the original focused host', host!.isFocused() && app.isActive())
  check('cancellation never rewrites any host opacity', exactHostOpacity())
}

async function run(): Promise<void> {
  await app.whenReady()
  const primary = screen.getPrimaryDisplay(), area = primary.workArea
  check('the real primary work area can hold isolated hosts', area.width >= 800 && area.height >= 600)
  host = new BrowserWindow({ show: false, frame: false, roundedCorners: false, hasShadow: false, resizable: false,
    x: area.x + 80, y: area.y + 80, width: 420, height: 300, backgroundColor: '#ff00c8',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  pin = new BrowserWindow({ show: false, width: 180, height: 140, x: area.x + area.width - 260, y: area.y + 100,
    backgroundColor: '#ffd600', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  hidden = new BrowserWindow({ show: false, width: 200, height: 120, webPreferences: { sandbox: true, contextIsolation: true } })
  minimized = new BrowserWindow({ show: false, width: 220, height: 140, webPreferences: { sandbox: true, contextIsolation: true } })
  await host.loadURL('data:text/html,<body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:%23ff00c8"></body>')
  await pin.loadURL('data:text/html,<body style="margin:0;background:%23ffd600"></body>')
  await hidden.loadURL('data:text/html,<body>hidden</body>')
  await minimized.loadURL('data:text/html,<body>minimized</body>')
  host.setOpacity(1); pin.setOpacity(0.4); hidden.setOpacity(0.8); minimized.setOpacity(0.6)
  observeOpacity(host, 'workbench'); observeOpacity(pin, 'pin'); observeOpacity(hidden, 'hidden'); observeOpacity(minimized, 'minimized')
  pin.showInactive(); minimized.show(); minimized.minimize(); host.show(); app.focus({ steal: true }); host.focus()
  await until('real host visibility, minimization and focus', () => host!.isVisible() && host!.isFocused() && pin!.isVisible()
    && !hidden!.isVisible() && minimized!.isMinimized() && app.isActive())
  await painted(host)
  check('the real workbench and pin are visible with exact prior opacity', exactHostOpacity())

  native = new NativeDesktop({ executablePath, connectTimeoutMs: 15000, requestTimeoutMs: 45000 })
  surface = new CaptureSurface({ native: () => ({ captureDisplays: captureForSurface }), appearance: () => ({ terminalTheme: 'graphite', appAppearance: 'dark' }),
    pin: async () => { throw new Error('Pin output is outside the lifecycle proof.') }, copyText: async () => {}, returnFocus: () => {} })

  const initial = await openCapture('included', 'initial')
  const hostContent = host.getContentBounds(), hostDisplay = screen.getDisplayMatching(hostContent)
  const includedFrame = frameFor(initial.exposures[0]!.result, hostDisplay.id), excludedFrame = frameFor(initial.exposures[1]!.result, hostDisplay.id)
  const initialIncluded = colorPixels(includedFrame.png, hostRegion(includedFrame, hostContent), 'host-initial')
  const initialExcluded = colorPixels(excludedFrame.png, hostRegion(excludedFrame, hostContent), 'host-initial')
  check('initial included SCK pixels contain the untouched host', initialIncluded.area > 100 && initialIncluded.matches > initialIncluded.area * 0.8, initialIncluded)
  check('initial excluded SCK pixels omit the untouched host', initialExcluded.area > 100 && initialExcluded.matches === 0, initialExcluded)

  for (const overlay of initial.overlays) {
    await overlay.webContents.executeJavaScript(`(()=>{const marker=document.createElement('div');marker.id='capture-live-overlay-marker';marker.style='position:fixed;left:20px;top:20px;width:96px;height:96px;background:#00ff9d;pointer-events:none;z-index:2147483647';document.body.append(marker);return true})()`)
    await painted(overlay)
    const own = (await overlay.webContents.capturePage()).toPNG().toString('base64')
    const image = nativeImage.createFromBuffer(Buffer.from(own, 'base64')), size = image.getSize()
    const marker = colorPixels(own, { x: 0, y: 0, width: size.width, height: size.height }, 'overlay-marker')
    check('the unique overlay marker actually painted in its real Renderer', marker.matches > 100, marker)
  }
  await host.webContents.executeJavaScript(`document.body.style.background='#00c8ff'`)
  await painted(host)
  await wait(150)
  const visibleIncluded = await native.captureDisplays({ includeHostWindows: true })
  const visibleExcluded = await native.captureDisplays({ includeHostWindows: false })
  for (const [label, frames] of [['included', visibleIncluded], ['excluded', visibleExcluded]] as const) {
    for (const frame of frames.displays) {
      check(label + ' background probe has real PNG bytes', typeof frame.png === 'string')
      check(label + ' background probe has real dimensions', typeof frame.width === 'number' && typeof frame.height === 'number')
      const marker = colorPixels(frame.png, { x: 0, y: 0, width: frame.width, height: frame.height }, 'overlay-marker')
      check(label + ' background contains no visible overlay pixels on any real display', marker.matches === 0, { displayId: frame.displayId, matches: marker.matches })
    }
  }
  const liveIncludedFrame = frameFor(visibleIncluded, hostDisplay.id), liveExcludedFrame = frameFor(visibleExcluded, hostDisplay.id)
  const changedIncluded = colorPixels(liveIncludedFrame.png, hostRegion(liveIncludedFrame, hostContent), 'host-changed')
  const recursiveIncluded = colorPixels(liveIncludedFrame.png, hostRegion(liveIncludedFrame, hostContent), 'host-initial')
  const changedExcluded = colorPixels(liveExcludedFrame.png, hostRegion(liveExcludedFrame, hostContent), 'host-changed')
  const recursiveExcluded = colorPixels(liveExcludedFrame.png, hostRegion(liveExcludedFrame, hostContent), 'host-initial')
  check('included background shows the live host, not the frozen overlay image', changedIncluded.matches > changedIncluded.area * 0.8 && recursiveIncluded.matches === 0,
    { changedHostPixels: changedIncluded.matches, recursiveOverlayPixels: recursiveIncluded.matches })
  check('excluded background has neither the live host nor its frozen overlay copy', changedExcluded.matches === 0 && recursiveExcluded.matches === 0,
    { liveHostPixels: changedExcluded.matches, recursiveOverlayPixels: recursiveExcluded.matches })
  check('background probes do not request new CaptureSurface exposures', nativeResults.length === 2)
  check('all real hosts remain untouched after background probes', exactHostOpacity())
  await cancelCapture(initial)
  receipt.cases.push({ label: 'lifecycle', displays: initial.overlays.length, initialIncluded, initialExcluded,
    changedIncluded, recursiveIncluded, changedExcluded, recursiveExcluded })

  currentPhase = 'cancelled-old'
  created = []
  let captureError: unknown
  const oldOutcome = surface.present({ background: 'included', attachToDraft: false, expandable: false, returnFocus: false,
    complete: async () => { throw new Error('The cancelled request never delivers.') } })
  void oldOutcome.catch(error => { captureError = error })
  await until('the real old native result is held after capture', async () => {
    if (captureError) throw captureError
    return heldNativeResult
  })
  const oldOverlays = [...created!]
  check('the cancelled old request prepared real hidden overlays', oldOverlays.length === screen.getAllDisplays().length && oldOverlays.every(window => !window.isVisible()))
  oldOverlays[0]!.destroy()
  assert.deepEqual(await oldOutcome, { state: 'cancelled' })
  check('early cancellation destroys every old real overlay', oldOverlays.every(window => window.isDestroyed()))
  const replacement = await openCapture('included', 'replacement')
  const requestIds = replacement.inputs.map(input => input.requestId)
  const callsBeforeLateRelease = receipt.nativeCalls.length
  releaseHeld?.(); releaseHeld = undefined
  await wait(300)
  check('a cancelled request late real result starts no additional native exposure', receipt.nativeCalls.length === callsBeforeLateRelease)
  const currentIds: string[] = []
  for (const overlay of replacement.overlays) {
    const input = await overlay.webContents.executeJavaScript('window.captureSurface.load()') as CaptureSurfaceInput
    currentIds.push(input.requestId)
  }
  check('a cancelled request late real result cannot replace the active request', JSON.stringify(currentIds) === JSON.stringify(requestIds)
    && replacement.overlays.every(window => !window.isDestroyed() && window.isVisible()))
  check('late-result isolation leaves every host opacity untouched', exactHostOpacity())
  await cancelCapture(replacement)
  receipt.cases.push({ label: 'late-result-isolation', nativeCallsBeforeRelease: callsBeforeLateRelease, nativeCallsAfterRelease: receipt.nativeCalls.length })

  check('hidden and minimized windows were never touched', receipt.opacityWrites.every((row: any) => row.window !== 'hidden' && row.window !== 'minimized'))
  check('the entire lifecycle has zero host opacity writes', receipt.opacityWrites.length === 0)
  receipt.passed = true
}

void run().catch(error => {
  receipt.failure = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }
}).finally(async () => {
  releaseHeld?.()
  try { surface?.dispose() } catch {}
  try { await native?.dispose(); receipt.cleanup.nativeDisposed = true } catch (error) { receipt.cleanup.nativeDisposeError = String(error) }
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  receipt.cleanup.windowsRemaining = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
