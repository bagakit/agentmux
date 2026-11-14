import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  boundary: 'One real Electron Main owns the visible host BrowserWindow and NativeDesktop. Real native discovery and display PNGs are decoded in memory; only the controlled host preview is retained, never desktop pixels, user paths or draft text.'
}
let host: BrowserWindow | undefined
let native: NativeDesktop | undefined
const marker = { x: 32, y: 96, width: 160, height: 80 }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function check(name: string, value: unknown): asserts value {
  receipt.checks.push({ name, passed: Boolean(value) })
  assert.ok(value, name)
}
function boundedTiming(value: any, keys: string[]): boolean {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key))
    && keys.every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 150_000)
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
function markerRegion(frame: any, content: { x: number; y: number; width: number; height: number }) {
  const scaleX = frame.width / frame.frame.width, scaleY = frame.height / frame.frame.height
  return { x: (content.x + marker.x - frame.frame.x) * scaleX, y: (content.y + marker.y - frame.frame.y) * scaleY,
    width: marker.width * scaleX, height: marker.height * scaleY }
}
function finderWindowBounds(): Array<{ x: number; y: number; width: number; height: number }> {
  const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    'const finder = Application("Finder"); JSON.stringify(finder.windows().map(window => window.bounds()))'],
  { encoding: 'utf8' })
  return JSON.parse(output)
}
async function run() {
  await app.whenReady()
  const primary = screen.getPrimaryDisplay()
  host = new BrowserWindow({ show: false, frame: false, roundedCorners: false, hasShadow: false, resizable: false,
    x: primary.workArea.x + 100, y: primary.workArea.y + 100, width: 320, height: 220, useContentSize: true,
    backgroundColor: '#17191f', title: `Native host exclusion ${process.pid}`,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const hostMarkup = `<html><body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:#17191f;color:#aab0be;font:12px -apple-system,BlinkMacSystemFont,sans-serif">
    <div style="position:absolute;left:32px;top:28px;letter-spacing:.02em">Native capture check</div>
    <div style="position:absolute;left:32px;top:52px;color:#686f7d;font-size:11px">Controlled host-window fixture</div>
    <div style="position:absolute;left:${marker.x}px;top:${marker.y}px;width:${marker.width}px;height:${marker.height}px;background:#ff00c8"></div>
  </body></html>`
  await host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(hostMarkup))
  host.show(); app.focus({ steal: true }); host.focus()
  await host.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  for (const deadline = Date.now() + 5000; Date.now() < deadline && (!app.isActive() || !host.isFocused());) {
    app.focus({ steal: true }); host.focus()
    await wait(50)
  }
  await wait(150)
  check('the host with its exact colored marker is visible and frontmost', host.isVisible() && app.isActive() && host.isFocused())
  const content = host.getContentBounds(), display = screen.getDisplayMatching(content)
  const paintedHost = await host.webContents.capturePage(), paintedSize = paintedHost.getSize()
  await writeFile(join(out, 'host.png'), paintedHost.toPNG())
  const own = colorPixels(paintedHost.toPNG().toString('base64'), markerRegion(
    { width: paintedSize.width, height: paintedSize.height, frame: { x: 0, y: 0, width: content.width, height: content.height } },
    { x: 0, y: 0, width: content.width, height: content.height }))
  check('the painted host contains its exact marker before native capture', own.matches === own.area && own.area > 100)

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
  app.focus({ steal: true }); host.focus()
  for (const deadline = Date.now() + 5000; Date.now() < deadline && (!app.isActive() || !host.isFocused());) {
    app.focus({ steal: true }); host.focus()
    await wait(50)
  }
  await wait(100)
  check('the host is frontmost immediately before included capture', app.isActive() && host.isFocused())

  const included = await native.captureDisplays({ includeHostWindows: true })
  const includedFrame = frameFor(included, display.id), includedRegion = markerRegion(includedFrame, content)
  const includedPixels = colorPixels(includedFrame.png, includedRegion)
  const includedWholeDisplay = colorPixels(includedFrame.png, { x: 0, y: 0, width: includedFrame.width, height: includedFrame.height })
  receipt.included = { colorPixels: includedPixels.matches, regionArea: includedPixels.area, fullDisplayColorPixels: includedWholeDisplay.matches,
    region: includedRegion, capturedAt: included.capturedAt, engine: includedFrame.engine, timing: included.timing }
  check('included window list contains the discovered host', includedFrame.windows.some((window: any) => window.windowId === discovered.id))
  check('included isolated-region unique color is present', includedPixels.area > 100 && includedPixels.matches === includedPixels.area)

  // The host stays fully visible. Exclusion is native filtering, not opacity or hiding.
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    'const finder = Application("Finder"); finder.activate(); for (const window of finder.windows()) window.close()'])
  for (const deadline = Date.now() + 5000; Date.now() < deadline && app.isActive();) await wait(50)
  host.moveTop()
  check('the host remains visible while another app is frontmost', host.isVisible() && host.getOpacity() === 1 && !app.isActive() && !host.isFocused())
  const finderWindows = finderWindowBounds()
  const obscuringFinderWindows = finderWindows.filter(window => window.x < content.x + content.width && window.x + window.width > content.x
    && window.y < content.y + content.height && window.y + window.height > content.y)
  receipt.frontmost = { finderWindowCount: finderWindows.length, obscuringFinderWindowCount: obscuringFinderWindows.length }
  check('no Finder window obscures the visible host', host.isVisible() && obscuringFinderWindows.length === 0)
  const excluded = await native.captureDisplays({ includeHostWindows: false })
  const excludedFrame = frameFor(excluded, display.id), excludedRegion = markerRegion(excludedFrame, content)
  const excludedPixels = colorPixels(excludedFrame.png, excludedRegion)
  receipt.excluded = { colorPixels: excludedPixels.matches, regionArea: excludedPixels.area, capturedAt: excluded.capturedAt,
    engine: excludedFrame.engine, hostListed: excludedFrame.windows.some((window: any) => window.windowId === discovered.id), timing: excluded.timing }
  check('excluded isolated-region unique color is absent', excludedPixels.area > 100 && excludedPixels.matches === 0)
  check('excluded window list omits the discovered host', excludedFrame.windows.every((window: any) => window.windowId !== discovered.id))
  check('included native and Node timing are closed and bounded', boundedTiming(included.timing,
    ['contentMs', 'windowListMs', 'responseSerializationMs', 'totalMs', 'lazyConnectionMs', 'socketReadMs', 'jsonParseMs', 'requestMs', 'validationMs'])
    && included.timing.responseSerializationMs > 0 && boundedTiming(includedFrame.timing, ['captureMs', 'pngMs', 'base64Ms', 'totalMs']))
  check('excluded native and Node timing are closed and bounded', boundedTiming(excluded.timing,
    ['contentMs', 'windowListMs', 'responseSerializationMs', 'totalMs', 'lazyConnectionMs', 'socketReadMs', 'jsonParseMs', 'requestMs', 'validationMs'])
    && excluded.timing.responseSerializationMs > 0 && boundedTiming(excludedFrame.timing, ['captureMs', 'pngMs', 'base64Ms', 'totalMs']))
  receipt.hostWindowId = discovered.id
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { name: error instanceof Error ? error.message : String(error) } }).finally(async () => {
  try { await native?.dispose() } catch {}
  if (host && !host.isDestroyed()) host.destroy()
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  app.exit(receipt.passed ? 0 : 1)
})
