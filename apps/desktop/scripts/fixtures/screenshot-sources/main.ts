import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CaptureParams, NativeDesktop } from '@agentmux/native-desktop'
import { ScreenshotSourcePicker } from '../../../src/main/screenshot-source-picker'

const out = process.env.SCREENSHOT_SOURCES_OUT!
app.setPath('userData', join(import.meta.dirname, 'user-data'))
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, captureOnly: true, aestheticReview: 'not-performed', cases: [], screenshots: [],
  boundary: 'Actual production Main source owner, BrowserWindow, isolated preload and SourceView with trusted CDP input. Native discovery is controlled; desktop pixels, TCC, clipboard, existing Sessions, packaging and installation are outside this proof.' }
let picker: ScreenshotSourcePicker, window: BrowserWindow, appearance: 'light' | 'dark' = 'dark'
let failNextDisplay = false, heldApps: (() => void) | null = null, holdApps = false
const calls: { method: string; params?: unknown }[] = []
const displays = [
  { id: 11, width: 1440, height: 900, scale: 2, isMain: true },
  { id: 22, width: 2560, height: 1440, scale: 1.5, isMain: false },
  { id: 33, width: 1920, height: 1080, isMain: false }
]
const apps = [{ pid: 42, processStartedAt: 102, name: 'Workspace' }, { pid: 84, processStartedAt: 208, name: 'Workspace' }]
const windows = [{ id: 71, title: 'Research notes', width: 920, height: 640 }, { id: 72, title: 'Capture review · Delivery checklist', width: 1280, height: 800 }]
const native = { async request(method: string, params?: unknown) {
  calls.push({ method, params })
  if (method === 'listDisplays') {
    if (failNextDisplay) { failNextDisplay = false; throw new Error('The private display discovery is unavailable. Retry this original selection.') }
    return { displays }
  }
  if (method === 'listApps') {
    if (holdApps) await new Promise<void>(resolve => { heldApps = resolve })
    return { apps }
  }
  if (method === 'listWindows') return { windows }
  throw new Error('Unexpected native discovery: ' + method)
} } as unknown as Pick<NativeDesktop, 'request'>

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
  assert.deepEqual(await evaluate('Object.keys(window.screenshotSources).sort()'), ['cancel', 'list', 'load', 'select', 'windows'])
  assert.equal(await evaluate('typeof window.agentmux'), 'undefined', 'the full application bridge is absent')
  assert.equal(await evaluate('typeof window.screenshotEditor'), 'undefined', 'the source view has no image output authority')
  return { result, window }
}
async function shot(name: string, width: number, height: number) {
  window.setContentSize(width, height)
  await settle()
  const file = name + '.png'
  await writeFile(join(out, file), (await window.webContents.capturePage()).toPNG())
  const geometry = await evaluate(`(()=>{const rows=document.querySelector('.screenshot-source__choices').getBoundingClientRect();return {width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,rowsHeight:rows.height,controls:[...document.querySelectorAll('button,input,footer')].map(node=>{const r=node.getBoundingClientRect();return {name:node.getAttribute('aria-label')||node.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom}})}})()`)
  assert.ok(geometry.bodyWidth <= geometry.width, 'the actual source window has no horizontal overflow')
  assert.ok(geometry.rowsHeight > 80, 'available source rows retain a readable area')
  assert.ok(geometry.controls.every((control: any) => control.left >= 0 && control.right <= geometry.width && control.top >= 0 && control.bottom <= geometry.height), 'each source choice and action is reachable inside the actual window')
  receipt.screenshots.push({ file, appearance, contentSize: window.getContentSize(), geometry })
}

async function run() {
  await app.whenReady()
  picker = new ScreenshotSourcePicker({ native: () => native, appearance: () => ({ terminalTheme: 'graphite', appAppearance: appearance }) })
  const display = await open('display')
  process.stdout.write('source-view: first display window mounted\n')
  await textIncludes('Display 2')
  await textIncludes('Available sources remain usable')
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
  await click('Process 84', '.screenshot-source__choices button')
  await textIncludes('Capture review · Delivery checklist')
  assert.deepEqual(calls.find(call => call.method === 'listWindows')?.params, { app: 'pid:84', processStartedAt: 208 }, 'the actual native discovery request preserves the selected process incarnation')
  await shot('windows-narrow-light', 360, 460)
  await click('Capture review · Delivery checklist', '.screenshot-source__choices button')
  const target: CaptureParams = { mode: 'window', app: 'pid:84', processStartedAt: 208, windowId: 72 }
  assert.deepEqual(await application.result, target, 'the actual Renderer selection resolves the exact process and window')
  await until('selected application window closes', async () => application.window.isDestroyed())
  receipt.cases.push({ name: 'same-label-application-filter-and-exact-window', target })
  process.stdout.write('source-view: exact process and window receipt accepted\n')

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
