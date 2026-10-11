import assert from 'node:assert/strict'
import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const root = process.env.AGENTMUX_OVERLAY_MOTION_ROOT!
app.setPath('userData', join(root, 'user-data'))
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
app.on('window-all-closed', () => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const receipt: any = { nativeQualification: false, cases: [], publications: [], nativeFrames: [], warnings: [], passed: false }
const progress = (stage: string) => { receipt.progress = stage; console.error('overlay-motion:' + stage) }
let window: BrowserWindow, page: WebContentsView, overlays: NativeOverlaySurfaces
async function run() {
  progress('waiting-for-electron')
  await app.whenReady()
  progress('electron-ready')
  window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
    preload: join(root, 'preload.cjs'), sandbox: true, backgroundThrottling: false } })
  page = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false, focusOnNavigation: false } })
  const bounds = { x: 0, y: 80, width: 800, height: 520 }
  window.contentView.addChildView(page); page.setBounds(bounds)
  await page.webContents.loadURL('data:text/html,<input value="original native page">')
  let observing = true
  let finalOnlyEntry: { x: number; y: number; width: number; height: number } | undefined
  let publication = 0
  let nativeFrame: { publication: number; regions: number; projected: number } | undefined
  overlays = new NativeOverlaySurfaces(window, { visibleNativeBounds: () => page.getVisible() ? [bounds] : [], nativeOwner: () => undefined }, warning => receipt.warnings.push(warning), () => {})
  ipcMain.handle('motion:publish', async (event, value) => {
    assert.equal(event.sender, window.webContents)
    const sequence = ++publication
    receipt.publications.push(value)
    try {
      for (const surface of value.surfaces) if (observing && page.getVisible() && (finalOnlyEntry || surface.bounds.y + surface.bounds.height > bounds.y)) {
        assert.equal(surface.opacity, '1', 'first overlapping entry must be opaque before capture')
        assert.equal(surface.animation, 'none', 'first overlapping entry must use stable capture geometry')
        const region = value.regions.find((region: any) => region.bounds.x === surface.bounds.x && region.bounds.y === surface.bounds.y)
        assert.ok(region, 'first overlapping entry must be published, including its independently portaled submenu')
        assert.deepEqual(region.bounds, surface.bounds, 'the original final geometry must reach the native capture')
      }
      assert.equal(value.warning, undefined, 'opaque original menu must not be degraded')
      const result = await overlays.update(value.regions)
      nativeFrame = { publication: sequence, regions: value.regions.length, projected: result.projected }
      receipt.nativeFrames.push(nativeFrame)
      return result
    } catch (error: any) { receipt.publicationFailure ??= { message: error.message, stack: error.stack }; throw error }
  })
  await window.loadFile(join(root, 'index.html'))
  progress('original-renderer-loaded')
  const read = (source: string) => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => { const end = Date.now() + 6000
    while (Date.now() < end) {
      if (receipt.publicationFailure) throw new Error(receipt.publicationFailure.message)
      if (await read(source)) return; await delay(25)
    }
    throw new Error('Original overlay consumer did not settle: ' + source) }
  await wait('!!window.motionProbe && !!document.querySelector("#menu-trigger")')
  window.webContents.debugger.attach('1.3')
  // Background CDP proves the product DOM/capture path, never OS focus or native input.
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const key = async (key: string, code: number) => { for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code }) }
  const settled = async () => { await read('motionProbe.settled()') }
  const layers = () => window.contentView.children.filter(view => view !== page && view.getVisible())
  const nativeReady = async (count: number) => {
    const end = Date.now() + 6000
    while (Date.now() < end) {
      if (receipt.publicationFailure) throw new Error(receipt.publicationFailure.message)
      if (nativeFrame?.publication === publication && nativeFrame.regions === count && nativeFrame.projected === count && layers().length === count) return
      await delay(20)
    }
    throw new Error('Matching original publication did not finish native paint: ' + JSON.stringify({ nativeFrame, publication, layers: layers().length, count }))
  }
  await read('document.querySelector("#menu-trigger").focus()'); await key('ArrowDown', 40)
  await wait('motionProbe.read().surfaces.length === 1 && motionProbe.read().surfaces[0].static === "static"'); await settled()
  await nativeReady(1)
  const originalMenuBounds = await read('motionProbe.read().surfaces[0].bounds')
  assert.equal(layers().length, 1, 'original publication must reach actual Main native projection')
  await writeFile(join(root, 'toolbar.png'), (await window.webContents.capturePage()).toPNG())
  receipt.cases.push('toolbar-first-entry-native-projection')
  await delay(180); await settled()
  const before = await read('motionProbe.read().observations.length')
  await read('motionProbe.churn()'); await delay(100); await settled()
  assert.equal(await read('motionProbe.read().observations.length'), before, 'unrelated terminal churn must schedule no overlay work')
  receipt.cases.push('unrelated-terminal-zero-work')
  await key('Enter', 13); await wait('motionProbe.read().actions.length === 1 && !document.querySelector("[role=menu]")'); await settled()
  await nativeReady(0)
  assert.equal(layers().length, 0); assert.equal(await read('motionProbe.read().markedOriginalSurfaces'), 0)
  receipt.cases.push('original-action-and-exit')
  bounds.y = originalMenuBounds.y + originalMenuBounds.height - 1
  bounds.height = 600 - bounds.y; page.setBounds(bounds)
  finalOnlyEntry = originalMenuBounds
  await read('motionProbe.demand(true,' + JSON.stringify(bounds) + '); motionProbe.edgeEntry(true); document.querySelector("#menu-trigger").focus()')
  await key('ArrowDown', 40)
  await wait('motionProbe.read().surfaces.length === 1 && motionProbe.read().surfaces[0].static === "static"'); await settled()
  await nativeReady(1)
  assert.equal(layers().length, 1, 'final-only one-pixel overlap must reach the native projection')
  receipt.edge = { nativeBounds: { ...bounds }, actualSurface: await read('motionProbe.read().surfaces[0]') }
  receipt.cases.push('final-only-overlap-first-entry')
  await key('Escape', 27); await wait('!document.querySelector("[role=menu]")'); await settled()
  await nativeReady(0)
  finalOnlyEntry = undefined
  await read('motionProbe.edgeEntry(false)')
  bounds.y = 80; bounds.height = 520; page.setBounds(bounds)
  await read('motionProbe.demand(true,' + JSON.stringify(bounds) + ')'); await settled()
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 50, button: 'right', clickCount: 1 })
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 50, button: 'right', clickCount: 1 })
  await wait('!!document.querySelector("[role=menu]")')
  // The actual Region menu's original SubTrigger consumes the keyboard, not a copied submenu.
  await key('End', 35); await key('ArrowRight', 39)
  await wait('motionProbe.read().surfaces.length === 2 && motionProbe.read().surfaces.every(n => n.static === "static")'); await settled()
  await nativeReady(2)
  assert.equal(layers().length, 2)
  await writeFile(join(root, 'region-submenu.png'), (await window.webContents.capturePage()).toPNG())
  receipt.cases.push('original-region-independent-submenu')
  page.setVisible(false)
  await read('motionProbe.demand(false)'); await settled()
  await nativeReady(0)
  assert.equal(await read('motionProbe.read().markedOriginalSurfaces'), 0); assert.equal(layers().length, 0)
  assert.equal(await read('motionProbe.read().surfaces.every(n => n.animation === "menu-in")'), true, 'no native demand retains authored entry motion')
  page.setVisible(true)
  await read('motionProbe.demand(true)'); await wait('motionProbe.read().surfaces.every(n => n.static === "static")'); await settled()
  await nativeReady(2)
  assert.equal(layers().length, 2)
  receipt.cases.push('native-demand-release-and-reentry')
  observing = false
  await read('motionProbe.dispose()'); await settled()
  await nativeReady(0)
  assert.equal(await read('motionProbe.read().markedOriginalSurfaces'), 0); assert.equal(layers().length, 0)
  assert.equal(await page.webContents.executeJavaScript('document.querySelector("input").value'), 'original native page')
  assert.deepEqual(receipt.warnings, [])
  receipt.cases.push('dispose-preserves-original-native-page')
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack } }).finally(async () => {
  ipcMain.removeHandler('motion:publish'); overlays?.dispose(); page?.webContents.close(); window?.destroy()
  await writeFile(join(root, 'result.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
})
