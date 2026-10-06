import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const root = process.env.AGENTMUX_MENU_PROBE_ROOT!
app.setPath('userData', join(root, 'user-data'))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor<T>(read: () => Promise<T>, label: string): Promise<T> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(20) }
  throw new Error('Private native menu preparation failed: ' + label)
}
const receipt: any = { cases: [], warnings: [], passed: false }
let window: BrowserWindow, page: WebContentsView, overlays: NativeOverlaySurfaces
async function run() {
  await app.whenReady()
  window = new BrowserWindow({ width: 640, height: 500, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } })
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  page = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false, focusOnNavigation: false } })
  const pageBounds = { x: 0, y: 90, width: 640, height: 410 }
  window.contentView.addChildView(page); page.setBounds(pageBounds)
  await page.webContents.loadURL('data:text/html,<input value="original page"><p>Original native page</p>')
  overlays = new NativeOverlaySurfaces(window, { visibleNativeBounds: () => [pageBounds], nativeOwner: id => ({ browserId: id, bounds: pageBounds, view: page }) }, warning => receipt.warnings.push(warning), () => {})
  await window.loadFile(join(root, 'index.html'))
  await waitFor(() => window.webContents.executeJavaScript('!!document.querySelector("button")'), 'original menu trigger')
  window.show(); app.focus(); window.focus(); window.webContents.focus()
  window.webContents.debugger.attach('1.3')
  const read = () => window.webContents.executeJavaScript('window.menuProbe.read()')
  for (const [label, role, index, expected, hold, keyboard] of [
    ['ordinary-action', 'menuitem', 0, 'action', false, false],
    ['same-position-repaint-action', 'menuitem', 0, 'action', true, false],
    ['same-position-repaint-radio', 'menuitemradio', 0, 'mobile', true, false],
    ['same-position-repaint-keyboard', 'menuitem', 0, 'action', true, true]
  ] as const) {
    // Moving back into original Chrome and releasing the prior keyboard event keeps a
    // retained hover/close timer from becoming the next case's opening oracle.
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 25, y: 25 })
    await waitFor(() => window.webContents.executeJavaScript('!document.querySelector("[role=menu]")'), 'previous menu dismissed')
    window.webContents.focus()
    await window.webContents.executeJavaScript('document.querySelector("button").focus()')
    for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    const geometry = await waitFor(() => window.webContents.executeJavaScript(`(()=>{const menu=document.querySelector('[role=menu]'),item=document.querySelectorAll('[role=${role}]')[${index}];if(!menu||!item)return null;const r=menu.getBoundingClientRect(),i=item.getBoundingClientRect();if(r.width<=0||r.height<=0||i.width<=0)return null;return {bounds:{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)},point:{x:i.x+i.width/2,y:i.y+i.height/2}}})()`), 'original menu and item')
    const region = { id: 'chrome-1', bounds: geometry.bounds, radius: 0 }
    assert.equal((await overlays.update([region])).projected, 1)
    const layer = [...window.contentView.children].reverse().find(v => v !== page) as WebContentsView
    assert.ok(layer && layer.webContents !== window.webContents)
    const before = await read()
    let release: (() => void) | undefined, pending: Promise<unknown> | undefined
    const capture = window.webContents.capturePage.bind(window.webContents)
    if (hold) {
      const held = new Promise<void>(resolve => { release = resolve })
      let started!: () => void
      const captureStarted = new Promise<void>(resolve => { started = resolve })
      window.webContents.capturePage = async (...args) => { const image = await capture(...args); started(); await held; return image }
      pending = overlays.update([region])
      await captureStarted
    }
    const bounds = layer.getBounds(), point = { x: Math.round(geometry.point.x - bounds.x), y: Math.round(geometry.point.y - bounds.y) }
    try {
      if (keyboard) {
        assert.ok(await window.webContents.executeJavaScript('!!document.activeElement?.closest("[role=menu]")'), 'Keyboard retains the original menu focus during repaint')
        for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      } else for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) layer.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
      await delay(120)
    } finally { release?.(); await pending; window.webContents.capturePage = capture }
    await delay(120)
    const after = await read()
    receipt.cases.push({ label, region, point, before, after })
    assert.deepEqual(after.actions, [...before.actions, expected], `${label}: native click must execute the original menu handler exactly once`)
    const actualEvents = after.events.slice(before.events.length)
    if (keyboard) {
      for (const type of ['keydown', 'keyup']) assert.ok(actualEvents.some((event: any) => event.type === type && event.trusted && event.key === 'Enter'), `Original Renderer must observe trusted ${type}`)
    } else {
      const target = role === 'menuitemradio' ? 'Mobile viewport' : 'Original action'
      assert.deepEqual(actualEvents.filter((event: any) => event.trusted && event.target === target).map((event: any) => event.type), ['pointerdown', 'pointerup', 'click'], 'Original menu must receive the whole trusted native click')
    }
    assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), 'original page')
    await overlays.update([])
    await delay(100)
  }
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack } }).finally(async () => {
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  overlays?.dispose(); page?.webContents.close(); window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
