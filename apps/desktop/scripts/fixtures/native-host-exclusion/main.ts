import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, screen } from 'electron'
import { NativeDesktop } from '@agentmux/native-desktop'

const out = process.env.AGENTMUX_NATIVE_HOST_EXCLUSION_OUT!
const executablePath = process.env.AGENTMUX_NATIVE_HOST_EXCLUSION_EXECUTABLE!
app.setPath('userData', join(out, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = {
  schema: 'agentmux.native-host-exclusion-fixture.v1', passed: false, checks: [],
  boundary: 'One real Electron Main owns the visible host BrowserWindow and NativeDesktop. Real native discovery and display PNGs are decoded in memory; no pixels, paths or draft text are retained.'
}
let host: BrowserWindow | undefined
let native: NativeDesktop | undefined
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function check(name: string, value: unknown): asserts value {
  receipt.checks.push({ name, passed: Boolean(value) })
  assert.ok(value, name)
}
function boundedTiming(value: any, keys: string[]): boolean {
  return value && keys.every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 150_000)
}
function colorPixels(png: string, region: { x: number; y: number; width: number; height: number }) {
  const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
  const size = image.getSize(), bytes = image.toBitmap()
  const x0 = Math.max(0, Math.floor(region.x)), y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(size.width, Math.ceil(region.x + region.width)), y1 = Math.min(size.height, Math.ceil(region.y + region.height))
  let matches = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * size.width + x) * 4
    const first = bytes[offset]!, green = bytes[offset + 1]!, third = bytes[offset + 2]!, alpha = bytes[offset + 3]!
    // nativeImage's byte order is platform-owned. The fixture's #ff00c8 has one
    // dominant red/blue channel, one strong companion and essentially no green.
    const high = Math.max(first, third), companion = Math.min(first, third)
    if (high > 240 && companion > 170 && companion < 230 && green < 30 && alpha > 245) matches++
  }
  return { matches, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), size }
}
function frameFor(frames: any, displayId: number) {
  const frame = frames.displays.find((candidate: any) => candidate.displayId === displayId)
  check('the host display has captured pixels', frame && typeof frame.png === 'string')
  return frame
}
function hostRegion(frame: any, content: { x: number; y: number; width: number; height: number }) {
  const scaleX = frame.width / frame.frame.width, scaleY = frame.height / frame.frame.height
  const inset = 12
  const left = Math.max(content.x, frame.frame.x) + inset, top = Math.max(content.y, frame.frame.y) + inset
  const right = Math.min(content.x + content.width, frame.frame.x + frame.frame.width) - inset
  const bottom = Math.min(content.y + content.height, frame.frame.y + frame.frame.height) - inset
  return { x: (left - frame.frame.x) * scaleX, y: (top - frame.frame.y) * scaleY,
    width: (right - left) * scaleX, height: (bottom - top) * scaleY }
}
async function run() {
  await app.whenReady()
  const primary = screen.getPrimaryDisplay()
  host = new BrowserWindow({ show: false, frame: false, roundedCorners: false, hasShadow: false, resizable: false,
    x: primary.workArea.x + 100, y: primary.workArea.y + 100, width: 360, height: 260, useContentSize: true,
    backgroundColor: '#ff00c8', title: `Native host exclusion ${process.pid}`,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  await host.loadURL('data:text/html,<html><body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:%23ff00c8"></body></html>')
  host.show(); host.focus()
  await host.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await wait(150)
  check('the uniquely colored host window is visible', host.isVisible())
  const content = host.getContentBounds(), display = screen.getDisplayMatching(content)
  const own = colorPixels((await host.webContents.capturePage()).toPNG().toString('base64'),
    { x: 20, y: 20, width: content.width - 40, height: content.height - 40 })
  check('the painted host contains its unique color before native capture', own.matches > own.area * 0.9)

  native = new NativeDesktop({ executablePath, connectTimeoutMs: 15_000, requestTimeoutMs: 30_000 })
  const apps: any = await native.request('listApps', {})
  const identity = apps.apps.find((candidate: any) => candidate.pid === process.pid)
  check('actual app discovery identifies this Electron Main process', identity && Number.isFinite(identity.processStartedAt))
  let discovered: any
  for (const deadline = Date.now() + 10_000; !discovered && Date.now() < deadline;) {
    const listed: any = await native.request('listWindows', { app: `pid:${process.pid}`, processStartedAt: identity.processStartedAt })
    const matches = listed.windows.filter((window: any) => Math.abs(window.x - content.x) <= 1 && Math.abs(window.y - content.y) <= 1
      && Math.abs(window.width - content.width) <= 1 && Math.abs(window.height - content.height) <= 1)
    if (matches.length === 1) discovered = matches[0]
    else await wait(50)
  }
  check('actual window discovery binds the exact visible host geometry', discovered?.id > 0)
  await wait(250)

  const included = await native.captureDisplays({ includeHostWindows: true })
  const includedFrame = frameFor(included, display.id), includedRegion = hostRegion(includedFrame, content)
  const includedPixels = colorPixels(includedFrame.png, includedRegion)
  const includedWholeDisplay = colorPixels(includedFrame.png, { x: 0, y: 0, width: includedFrame.width, height: includedFrame.height })
  receipt.included = { colorPixels: includedPixels.matches, regionArea: includedPixels.area, fullDisplayColorPixels: includedWholeDisplay.matches,
    region: includedRegion, timing: included.timing }
  check('included window list contains the discovered host', includedFrame.windows.some((window: any) => window.windowId === discovered.id))
  check('included isolated-region unique color is present', includedPixels.area > 100 && includedPixels.matches > includedPixels.area * 0.9)

  // The host stays fully visible. Exclusion is native filtering, not opacity or hiding.
  check('the host remains visible for the excluded capture', host.isVisible() && host.getOpacity() === 1)
  const excluded = await native.captureDisplays({ includeHostWindows: false })
  const excludedFrame = frameFor(excluded, display.id), excludedRegion = hostRegion(excludedFrame, content)
  const excludedPixels = colorPixels(excludedFrame.png, excludedRegion)
  receipt.excluded = { colorPixels: excludedPixels.matches, regionArea: excludedPixels.area, timing: excluded.timing }
  check('excluded isolated-region unique color is absent', excludedPixels.area > 100 && excludedPixels.matches === 0)
  check('excluded window list omits the discovered host', excludedFrame.windows.every((window: any) => window.windowId !== discovered.id))
  check('included native and Node timing are bounded', boundedTiming(included.timing, ['contentMs', 'windowListMs', 'totalMs', 'requestMs', 'validationMs'])
    && boundedTiming(includedFrame.timing, ['captureMs', 'pngMs', 'base64Ms', 'totalMs']))
  check('excluded native and Node timing are bounded', boundedTiming(excluded.timing, ['contentMs', 'windowListMs', 'totalMs', 'requestMs', 'validationMs'])
    && boundedTiming(excludedFrame.timing, ['captureMs', 'pngMs', 'base64Ms', 'totalMs']))
  receipt.hostWindowId = discovered.id
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { name: error instanceof Error ? error.message : String(error) } }).finally(async () => {
  try { await native?.dispose() } catch {}
  if (host && !host.isDestroyed()) host.destroy()
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
