import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureParams, NativeDesktop } from '@agentmux/native-desktop'
import { ScreenshotSourcePicker } from '../../../src/main/screenshot-source-picker'
import { ScreenshotCountdown } from '../../../src/main/screenshot-countdown'

const out = process.env.SCREENSHOT_SOURCES_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, captureOnly: true, aestheticReview: 'not-performed', cases: [], screenshots: [],
  boundary: 'Actual production Main source owner, BrowserWindow, isolated preload and SourceView with trusted CDP input. Native discovery is controlled; desktop pixels, TCC, clipboard, existing Sessions, packaging and installation are outside this proof.' }
let picker: ScreenshotSourcePicker, window: BrowserWindow, appearance: 'light' | 'dark' = 'dark'
let failNextDisplay = false, failNextWindows = false, heldApps: (() => void) | null = null, holdApps = false
const calls: { method: string; params?: unknown }[] = []
const displays = [
  { id: 11, width: 1440, height: 900, scale: 2, isMain: true },
  { id: 22, width: 2560, height: 1440, scale: 1.5, isMain: false },
  { id: 33, width: 1920, height: 1080, isMain: false }
]
const apps = [{ pid: 42, processStartedAt: 102, name: 'Workspace' }, { pid: 84, processStartedAt: 208, name: 'Workspace' }]
const windows = [{ id: 71, title: 'Research notes', width: 920, height: 640 }, { id: 72, title: 'Capture review · Delivery checklist', width: 1280, height: 800 }]
/** A distinct solid PNG per target, so each thumbnail shows its own exact source. */
const colors: Record<number, string> = { 11: '#3d6f8f', 22: '#7a5c9e', 33: '#4f8a63', 71: '#9a6b3d', 72: '#3d7f86' }
function targetPng(id: number, width: number, height: number): string {
  const pixels = Buffer.alloc(width * height * 4), hex = colors[id] ?? '#666666'
  for (let index = 0; index < pixels.length; index += 4) pixels.set([parseInt(hex.slice(5, 7), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(1, 3), 16), 255], index)
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG().toString('base64')
}
let failThumbnail = new Set<number>()
const native = { async captureScreenshot(target: CaptureParams) {
  calls.push({ method: 'captureScreenshot', params: target })
  const id = target.mode === 'display' ? target.displayId : target.mode === 'window' ? target.windowId : 0
  if (failThumbnail.has(id)) return { state: 'failed', error: { code: 'permission', message: 'Screen Recording is not allowed for this source.' } }
  return { state: 'captured', screenshot: { format: 'png', data: targetPng(id, 480, 300), width: 480, height: 300, scale: 1 } }
}, async request(method: string, params?: unknown) {
  calls.push({ method, params })
  if (method === 'listDisplays') {
    if (failNextDisplay) { failNextDisplay = false; throw new Error('The private display discovery is unavailable. Retry this original selection.') }
    return { displays }
  }
  if (method === 'listApps') {
    if (holdApps) await new Promise<void>(resolve => { heldApps = resolve })
    return { apps }
  }
  if (method === 'listWindows') {
    if (failNextWindows) { failNextWindows = false; throw new Error('The private window discovery is unavailable. Retry this original application.') }
    return { windows }
  }
  throw new Error('Unexpected native discovery: ' + method)
} } as unknown as Pick<NativeDesktop, 'request' | 'captureScreenshot'>

async function until<T>(label: string, read: () => Promise<T>): Promise<NonNullable<T>> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await read()
    if (result) return result as NonNullable<T>
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out: ' + label)
}
async function evaluate<T = any>(script: string): Promise<T> {
  const contents = window.webContents
  if (contents.isDestroyed()) throw new Error('The private source window closed before observation.')
  let destroyed!: () => void
  const closed = new Promise<never>((_, reject) => { destroyed = () => reject(new Error('The private source window closed during observation.')); contents.once('destroyed', destroyed) })
  try { return await Promise.race([contents.executeJavaScript(script), closed]) }
  finally { if (!contents.isDestroyed()) contents.removeListener('destroyed', destroyed) }
}
async function input(method: string, params: Record<string, unknown>) {
  const contents = window.webContents
  let destroyed!: () => void
  const closed = new Promise<void>(resolve => { destroyed = resolve; contents.once('destroyed', destroyed) })
  try { await Promise.race([contents.debugger.sendCommand(method, params), closed]) }
  catch (error) { if (!contents.isDestroyed()) throw error }
  finally { if (!contents.isDestroyed()) contents.removeListener('destroyed', destroyed) }
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
async function textIncludes(text: string) {
  return await until('rendered ' + text, async () => { try { return await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`) } catch { return false } })
}
async function click(text: string, within = 'button') {
  const point = await until('actual enabled control ' + text, async () => await evaluate<{ x: number; y: number } | null>(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(within)})].find(button=>button.textContent.includes(${JSON.stringify(text)}));if(!button||button.disabled)return null;const r=button.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`))
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', {
    type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1
  })
}
async function filter(value: string) {
  const point = await evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector('[aria-label="Filter capture sources"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
  await input('Input.insertText', { text: value })
  await settle()
}
async function open(kind: 'display' | 'window') {
  const result = picker.choose(kind)
  void result.catch(error => { receipt.chooseError = String(error) })
  window = await until('production source window', async () => BrowserWindow.getAllWindows().at(-1))
  window.webContents.debugger.attach('1.3')
  await until('production source view mounted', async () => { try { return await evaluate('!!document.querySelector(".screenshot-source")') } catch { return false } })
  await until('original main frame finishes loading', async () => !window.webContents.isLoadingMainFrame())
  assert.deepEqual(await evaluate('Object.keys(window.screenshotSources).sort()'), ['cancel', 'list', 'load', 'select', 'thumbnail', 'windows'])
  assert.equal(await evaluate('typeof window.agentmux'), 'undefined', 'the full application bridge is absent')
  assert.equal(await evaluate('typeof window.screenshotEditor'), 'undefined', 'the source view has no image output authority')
  return { result, window }
}
async function shot(name: string, width: number, height: number) {
  window.setContentSize(width, height)
  await settle()
  const file = name + '.png'
  await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG())
  const geometry = await evaluate(`(()=>{const rows=document.querySelector('.screenshot-source__choices').getBoundingClientRect();return {width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,rowsHeight:rows.height,controls:[...document.querySelectorAll('button,input,footer')].map(node=>{const r=node.getBoundingClientRect();return {name:node.getAttribute('aria-label')||node.textContent.trim(),card:!!node.closest('.screenshot-source__choices'),left:r.left,right:r.right,top:r.top,bottom:r.bottom}})}})()`)
  assert.ok(geometry.bodyWidth <= geometry.width, 'the actual source window has no horizontal overflow')
  assert.ok(geometry.rowsHeight > 80, 'available source rows retain a readable area')
  // Cards past the fold scroll into view; every control must fit the window width and the first row must be visible.
  assert.ok(geometry.controls.every((control: any) => control.left >= 0 && control.right <= geometry.width), 'each source choice and action fits the actual window width')
  assert.ok(geometry.controls.filter((control: any) => !control.card).every((control: any) => control.top >= 0 && control.bottom <= geometry.height), 'each action outside the card grid is visible')
  const cards = geometry.controls.filter((control: any) => control.card)
  assert.ok(cards.length === 0 || cards.some((control: any) => control.bottom <= geometry.height), 'the first row of sources is visible')
  receipt.screenshots.push({ file, appearance, contentSize: window.getContentSize(), geometry })
}

async function run() {
  await app.whenReady()
  picker = new ScreenshotSourcePicker({ native: () => native, appearance: () => ({ terminalTheme: 'graphite', appAppearance: appearance }) })
  const display = await open('display')
  process.stdout.write('source-view: first display window mounted\n')
  await textIncludes('Display 2')
  await textIncludes('Available sources remain usable')
  await until('display thumbnails settle', async () => await evaluate(`[...document.querySelectorAll('.screenshot-source__thumbnail')].every(node=>node.dataset.state!=='loading')`))
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.screenshot-source__thumbnail')].map(node=>node.dataset.state)`), ['ready', 'ready'], 'each listed display shows its own preview')
  assert.deepEqual(calls.filter(call => call.method === 'captureScreenshot').map(call => call.params), [{ mode: 'display', displayId: 11 }, { mode: 'display', displayId: 22 }], 'previews use the exact listed display identities')
  await shot('displays-dark', 560, 520); await shot('displays-narrow-dark', 360, 430)
  await click('Display 2', '.screenshot-source__choices button')
  process.stdout.write('source-view: exact display action dispatched\n')
  await until('selected display window closes', async () => display.window.isDestroyed())
  assert.deepEqual(await display.result, { mode: 'display', displayId: 22 }, 'the actual Renderer selection resolves the exact second display identity')
  assert.equal(display.window.isDestroyed(), true)
  receipt.cases.push({ name: 'exact-second-display-with-partial-discovery', target: { mode: 'display', displayId: 22 } })
  process.stdout.write('source-view: exact display receipt accepted\n')

  appearance = 'light'
  const application = await open('window')
  process.stdout.write('source-view: application window mounted\n')
  await textIncludes('Process 84')
  await shot('applications-light', 560, 520); await shot('applications-narrow-light', 360, 430)
  await filter('84')
  assert.equal(await evaluate('document.querySelectorAll(".screenshot-source__choices button").length'), 1, 'filtering keeps the intended same-label process')
  failThumbnail = new Set([71])
  await click('Process 84', '.screenshot-source__choices button')
  await textIncludes('Capture review · Delivery checklist')
  assert.deepEqual(calls.find(call => call.method === 'listWindows')?.params, { app: 'pid:84', processStartedAt: 208 }, 'the actual native discovery request preserves the selected process incarnation')
  await until('window thumbnails settle', async () => await evaluate(`[...document.querySelectorAll('.screenshot-source__thumbnail')].every(node=>node.dataset.state!=='loading')`))
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.screenshot-source__thumbnail')].map(node=>node.dataset.state)`), ['unavailable', 'ready'], 'a failed preview is a placeholder beside a healthy one')
  await shot('windows-light', 560, 460); await shot('windows-narrow-light', 360, 460)
  failThumbnail = new Set()
  await click('Capture review · Delivery checklist', '.screenshot-source__choices button')
  const target: CaptureParams = { mode: 'window', app: 'pid:84', processStartedAt: 208, windowId: 72 }
  assert.deepEqual(await application.result, target, 'the actual Renderer selection resolves the exact process and window')
  await until('selected application window closes', async () => application.window.isDestroyed())
  receipt.cases.push({ name: 'same-label-application-filter-and-exact-window', target })
  process.stdout.write('source-view: exact process and window receipt accepted\n')

  failNextWindows = true
  const failedWindows = await open('window')
  await textIncludes('Process 84'); await click('Process 84', '.screenshot-source__choices button')
  await textIncludes('private window discovery is unavailable')
  assert.equal(await evaluate('!![...document.querySelectorAll(".screenshot-source__choices button")].find(button=>button.textContent.includes("Process 42")&&!button.disabled)'), true, 'A failed window read keeps other confirmed applications selectable')
  const beforeWindowsRetry = calls.length
  await click('Retry')
  const retried = await until('the original window discovery retry is observed', async () => calls.length > beforeWindowsRetry ? calls.at(-1) : null)
  assert.equal(retried.method, 'listWindows', 'Retry must retain the selected application window discovery target')
  assert.deepEqual(retried.params, { app: 'pid:84', processStartedAt: 208 }, 'Retry must retain the exact original process incarnation')
  await textIncludes('Capture review · Delivery checklist')
  await click('Cancel'); assert.equal(await failedWindows.result, null)
  await until('the retried window chooser closes', async () => failedWindows.window.isDestroyed())
  receipt.cases.push({ name: 'failed-window-discovery-retries-exact-original-application', retried })

  appearance = 'dark'; failNextDisplay = true
  const failed = await open('display')
  await textIncludes('private display discovery is unavailable')
  assert.equal(await evaluate('document.querySelector("[role=alert] button")?.textContent'), 'Retry')
  await shot('discovery-failure-dark', 420, 460)
  const beforeRetry = calls.filter(call => call.method === 'listDisplays').length
  await click('Retry'); await textIncludes('Display 2')
  assert.equal(calls.filter(call => call.method === 'listDisplays').length, beforeRetry + 1, 'Retry reads again in the original source owner')
  await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  assert.equal(await failed.result, null, 'Escape cancels only this actual selection')
  await until('cancelled display window closes', async () => failed.window.isDestroyed())
  receipt.cases.push({ name: 'failed-discovery-retry-and-escape', retryReads: 1 })

  holdApps = true
  const pending = await open('window')
  await textIncludes('Reading available sources')
  await until('controlled discovery is pending', async () => heldApps !== null)
  await click('Cancel')
  assert.equal(await pending.result, null, 'Cancel remains available while actual discovery is pending')
  await until('cancelled pending selection closes', async () => pending.window.isDestroyed())
  heldApps!(); holdApps = false
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'late discovery cannot reopen its cancelled source window')
  const next = await open('display'); await textIncludes('Display 2'); await click('Cancel')
  assert.equal(await next.result, null, 'a new exact selection remains usable after a cancelled late read')
  await until('final private source window closes', async () => next.window.isDestroyed())
  receipt.cases.push({ name: 'pending-discovery-cancel-late-read-and-next-selection' })

  const countdown = new ScreenshotCountdown(() => ({ terminalTheme: 'graphite', appAppearance: appearance }))
  for (const [theme, file] of [['dark', 'countdown-dark.png'], ['light', 'countdown-light.png']] as const) {
    appearance = theme
    const waiting = countdown.wait(3)
    window = await until('production countdown window', async () => BrowserWindow.getAllWindows().at(-1))
    await until('countdown shows its first second', async () => { try { return await evaluate(`document.querySelector('.screenshot-countdown__digit')?.textContent==='3'`) } catch { return false } })
    assert.equal(window.isFocusable(), false, 'the countdown never takes focus from the app being captured')
    assert.equal(window.isAlwaysOnTop(), true)
    await settle()
    await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG())
    receipt.screenshots.push({ file, appearance, contentSize: window.getContentSize() })
    if (theme === 'dark') {
      window.webContents.debugger.attach('1.3')
      await click('Cancel')
      assert.equal(await waiting, false, 'Cancel ends the countdown without starting selection')
    } else {
      const started = performance.now()
      assert.equal(await waiting, true, 'the elapsed countdown starts selection')
      assert.ok(performance.now() - started > 1500, 'selection waits for the remaining seconds')
    }
    await until('countdown window closes', async () => window.isDestroyed())
  }
  countdown.dispose()
  receipt.cases.push({ name: 'delayed-capture-countdown-cancel-and-elapse' })
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { if (window && !window.isDestroyed()) { receipt.failure.dom = await evaluate('document.body.innerText'); await writeFile(join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG()) } } catch {}
}).finally(async () => {
  picker?.dispose()
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed ? 0 : 1)
})
