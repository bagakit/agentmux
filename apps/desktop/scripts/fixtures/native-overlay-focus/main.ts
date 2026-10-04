import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView, ipcMain, webContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const root = process.env.AGENTMUX_OVERLAY_FOCUS_ROOT!
app.setPath('userData', join(root, 'user-data'))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const receipt: any = { cases: [], calls: [], passed: false, versions: process.versions }
let window: BrowserWindow, page: WebContentsView, overlays: NativeOverlaySurfaces
async function run() {
  await app.whenReady()
  window = new BrowserWindow({ width: 640, height: 500, show: false, webPreferences: {
    preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false
  } })
  page = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } })
  const bounds = { x: 20, y: 98, width: 560, height: 360 }
  window.contentView.addChildView(page); page.setBounds(bounds)
  await page.webContents.loadURL('data:text/html,<input aria-label="Page input"><p>Original page</p>')
  overlays = new NativeOverlaySurfaces(window, {
    visibleNativeBounds: () => [bounds], nativeOwner: id => ({ browserId: id, bounds, view: page })
  }, warning => { throw new Error(warning) }, () => {})
  ipcMain.handle('browser:listInputHistory', () => ({ scope: { workspaceId: 'probe', profileId: 'probe' }, entries: [{ text: 'ab previous input', submittedAt: 1 }] }))
  ipcMain.handle('browser:recordInputHistory', (_event, _target, text) => ({ outcome: 'recorded', scope: { workspaceId: 'probe', profileId: 'probe' }, entries: [{ text, submittedAt: 2 }] }))
  let projected = 0
  ipcMain.handle('ui:publishNativeOverlays', async (_event, regions) => {
    const result = await overlays.update(regions); projected = result.projected
    receipt.calls.push({ projected, focused: webContents.getFocusedWebContents()?.id, warning: result.warning })
    return result
  })
  await window.loadFile(join(root, 'index.html'))
  await window.webContents.executeJavaScript('window.historyProbe.configure({kind:"workspace",workspaceId:"probe"},560)')
  // A real native-focus oracle needs a key window. Run only during an input idle period.
  window.show(); app.focus(); window.focus(); window.webContents.focus(); await wait(150)
  assert.ok(window.isFocused() && window.webContents.isFocused(), 'Private window and original Renderer must be focused before the test starts')
  window.webContents.debugger.attach('1.3')
  const box = await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector('input'),r=e.getBoundingClientRect();window.originalInput=e;return {x:r.x+20,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 })
  await wait(700)
  const read = () => window.webContents.executeJavaScript('({...window.historyProbe.read(),sameInput:window.originalInput===document.querySelector("input"),connected:window.originalInput.isConnected})')
  const clicked = await read()
  receipt.cases.push({ label: 'address-history-load', windowFocused: window.isFocused(), mainFocused: window.webContents.isFocused(), focused: webContents.getFocusedWebContents()?.id, state: clicked, projected })
  assert.ok(window.isFocused(), 'Private window must remain active during native focus observation')
  assert.ok(window.webContents.isFocused(), 'History projection must preserve native Renderer focus')
  assert.ok(clicked.focused && clicked.sameInput && clicked.connected, 'Original address input remains focused and mounted')
  assert.equal(clicked.expanded, 'true', 'History must remain open after its native document loads')
  assert.ok(projected > 0, 'The actual history must cross the native overlay boundary')
  for (const keyCode of ['a', 'b']) {
    const owner = webContents.getFocusedWebContents()!
    assert.equal(owner, window.webContents, 'Continuous typing follows the actual native focus owner')
    owner.sendInputEvent({ type: 'char', keyCode }); await wait(200)
  }
  const typed = await read()
  receipt.cases.push({ label: 'continuous-address-input', state: typed, mainFocused: window.webContents.isFocused() })
  assert.equal(typed.value, 'ab'); assert.deepEqual(typed.selection, [2, 2]); assert.equal(typed.expanded, 'true')
  assert.ok(window.webContents.isFocused() && typed.focused, 'History repaint must preserve both native and DOM focus')
  // Actual input into the native painted layer still reaches the original component's handler.
  const option = await window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.browser-address-history__choose').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const layer = [...window.contentView.children].reverse().find(view => {
    const r = view.getBounds(); return view.getVisible() && option.x >= r.x && option.x < r.x + r.width && option.y >= r.y && option.y < r.y + r.height
  }) as WebContentsView
  receipt.layerFacts = { option, layers: window.contentView.children.map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), id: (view as WebContentsView).webContents?.id })) }
  assert.ok(layer && layer !== page && layer.webContents !== window.webContents, 'Option point must belong to the actual native overlay')
  const layerBounds = layer.getBounds()
  for (const type of ['mouseDown', 'mouseUp'] as const) layer.webContents.sendInputEvent({ type, x: option.x - layerBounds.x, y: option.y - layerBounds.y, button: 'left', clickCount: 1 })
  await wait(250)
  const chosen = await read()
  receipt.cases.push({ label: 'explicit-native-history-click', state: chosen, mainFocused: window.webContents.isFocused() })
  assert.equal(chosen.submissions.at(-1)?.text, 'ab previous input', 'Native overlay click must submit through the original Renderer handler')
  assert.ok(window.webContents.isFocused(), 'Explicit overlay input returns focus to the original Renderer')
  // Now create a passive float while the original page is editing.
  page.webContents.focus(); await page.webContents.executeJavaScript('document.querySelector("input").focus()')
  assert.ok(page.webContents.isFocused())
  const float = await overlays.update([{ id: 'chrome-901', bounds: { x: 30, y: 180, width: 200, height: 80 }, radius: 8 }])
  await wait(200)
  receipt.cases.push({ label: 'page-input-passive-float', projected: float.projected, pageFocused: page.webContents.isFocused(), focused: webContents.getFocusedWebContents()?.id })
  assert.equal(float.projected, 1, 'Generic float must actually load and paint')
  assert.ok(page.webContents.isFocused(), 'Passive float must preserve original page native focus')
  webContents.getFocusedWebContents()!.sendInputEvent({ type: 'char', keyCode: 'z' }); await wait(100)
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), 'z', 'Original page continues editing')
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }).finally(async () => {
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  overlays?.dispose(); page?.webContents.close(); window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
