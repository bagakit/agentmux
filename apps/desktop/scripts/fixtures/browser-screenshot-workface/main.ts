import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const root = process.env.AGENTMUX_SCREENSHOT_PROBE_ROOT!, out = process.env.AGENTMUX_SCREENSHOT_PROBE_OUT!
const label = process.env.AGENTMUX_SCREENSHOT_PROBE_LABEL!
assert.ok(root.includes('agentmux-screenshot-workface-'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('no-proxy-server'); app.commandLine.appendSwitch('disk-cache-size', '1048576')
const originalId = 'private-screenshot-original', siblingId = 'private-screenshot-sibling', workspaceId = 'private-workspace'
const receipt: any = {
  schema: 'agentmux.browser-screenshot-workface-native-process.v1', label, pid: process.pid,
  scope: 'actual-BrowserPane-Editor-Canvas-native-overlay-and-BrowserViewManager-private-IO',
  passed: false, cases: [], images: [], warnings: [], calls: [], publications: [], clipboard: [],
  counters: { rendererCapture: 0, rendererEncode: 0, originalCapture: 0 }
}
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, server: Server
let original: WebContentsView, sibling: WebContentsView, originalSnapshot: any, siblingSnapshot: any
let baseUrl: string
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (code: string) => window.webContents.executeJavaScript(code)
async function until(label: string, read: () => Promise<any>, budget = 4000) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(15) }
  throw new Error('Native screenshot observation failed: ' + label)
}
async function facts() { return await evaluate('window.screenshotProbe.read()') }
async function mouse(type: string, x: number, y: number, button?: string) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y,
    ...(button ? { button, clickCount: 1 } : {}), ...(type === 'mouseMoved' && button ? { buttons: 1 } : {}) })
}
async function click(name: string, insideEditor = false) {
  const point = await evaluate(`(()=>{const root=${insideEditor ? "document.querySelector('.browser-screenshot-editor')" : 'document'},button=[...root.querySelectorAll('button,[role="menuitem"]')].find(b=>(b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)})&&b.getBoundingClientRect().width>0);if(!button)return null;const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:button.disabled}})()`)
  assert.ok(point, 'The actual mounted button exists: ' + name)
  await mouse('mouseMoved', point.x, point.y)
  await mouse('mousePressed', point.x, point.y, 'left'); await mouse('mouseReleased', point.x, point.y, 'left')
}
async function escape() {
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
async function keepOwners(caseLabel: string) {
  const current = manager.nativeOwner(originalId), other = manager.nativeOwner(siblingId)
  assert.equal(current?.view, original, caseLabel + ': restore the original native owner')
  assert.equal(other?.view, sibling, caseLabel + ': sibling owner remains visible')
  const value = await original.webContents.executeJavaScript('document.querySelector("input").value')
  const otherValue = await sibling.webContents.executeJavaScript('document.querySelector("input").value')
  assert.equal(value, 'retained original draft'); assert.equal(otherValue, 'retained sibling draft')
  const snapshot = await manager.create(originalId, baseUrl + '/original', workspaceId)
  assert.equal(snapshot.navigationId, originalSnapshot.navigationId); assert.equal(snapshot.profileId, originalSnapshot.profileId)
  assert.equal(original.webContents.id, receipt.owners.original.webContentsId)
  receipt.cases.push({ label: caseLabel, original: { id: originalId, navigationId: snapshot.navigationId,
    webContentsId: original.webContents.id, bounds: current!.bounds, value }, sibling: { id: siblingId,
    webContentsId: sibling.webContents.id, bounds: other!.bounds, value: otherValue } })
}
async function openEditor() {
  const toolbarVisible = await evaluate('document.querySelector("button[aria-label=Screenshot]")?.getBoundingClientRect().width > 0')
  if (!toolbarVisible) {
    await click('More browser tools')
    await until('narrow original More menu Screenshot action', async () => await evaluate('document.querySelector("[role=menuitem][aria-label=Screenshot]")?.getBoundingClientRect().width > 0'))
  }
  await click('Screenshot')
  const opened = await until('original Pane mounts loaded editor', async () => {
    const row = await facts(); return row.editor && row.imageLoaded && row.canvas?.width > 20 && row.canvas?.height > 20 ? row : null
  })
  await settle()
  assert.equal(original.getVisible(), false, 'screenshot-mode-must-hide-original-native-owner')
  assert.equal(manager.nativeOwner(originalId), undefined)
  assert.equal(manager.nativeOwner(siblingId)?.view, sibling, 'Screenshot mode must retain the sibling owner')
  assert.equal(opened.withinStage, true, 'The actual Editor stays in the original DOM stage')
  assert.equal(opened.cancelDisabled, false)
  return await facts()
}
async function closed(label: string) {
  await until(label + ': the original editor closes', async () => !(await facts()).editor)
  await until(label + ': the original native owner restores', async () => manager.nativeOwner(originalId)?.view === original)
  await keepOwners(label)
  const events = (await facts()).events
  if (label === 'trusted-keyboard-escape') {
    for (const type of ['keydown', 'keyup']) assert.ok(events.some((event: any) => event.type === type && event.trusted && event.key === 'Escape'), 'The original Renderer observes actual trusted Escape ' + type)
  } else if (label.includes('cancel') || label.startsWith('visual-')) {
    assert.ok(events.some((event: any) => event.type === 'click' && event.trusted && event.target === 'Cancel'), 'The actual Cancel button consumes a trusted pointer click')
  }
}
async function shot(kind: string) {
  // Explicit evidence capture is outside the measured drawing interval.
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), bytes = image.toPNG()
  assert.ok(!image.isEmpty() && bytes.length > 8)
  const path = label + '-' + kind + '.png'; await writeFile(join(out, path), bytes)
  receipt.images.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), size: image.getSize(),
    kind: 'actual-original-renderer', pid: process.pid, webContentsId: window.webContents.id, windowId: window.id })
}
async function run() {
  await app.whenReady()
  receipt.loadedCompiled = Object.fromEntries(await Promise.all(['main.mjs', 'renderer.js', 'renderer.css', 'preload.cjs'].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  server = createServer((request, response) => {
    const sibling = request.url === '/sibling'
    response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><style>body{margin:0;background:${sibling ? '#1f3f38' : '#f5f6fa'};color:${sibling ? 'white' : '#233248'};font:16px system-ui;padding:25px}input{font:14px system-ui;padding:10px;border:1px solid #bbc6d2;border-radius:6px;width:75%}h1{font-size:24px}p{line-height:1.8}</style><h1>${sibling ? 'Sibling page' : 'Browser screenshot canvas'}</h1><p>Original page identity and draft remain available.</p><input value="retained ${sibling ? 'sibling' : 'original'} draft"><p>Draw an arrow or highlight this content.</p>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = 'http://127.0.0.1:' + (server.address() as any).port
  window = new BrowserWindow({ width: 1040, height: 740, show: false, backgroundColor: '#181d24',
    webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  window.webContents.on('console-message', event => { if (event.level === 'error') receipt.warnings.push({ kind: 'renderer-console', message: event.message }) })
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'private-screenshot-profile',
    resolvePartition: () => 'screenshot-' + process.pid }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Private fixture cannot open system links') } })
  overlays = new NativeOverlaySurfaces(window, manager, message => {
    receipt.warnings.push({ kind: 'native-overlay', message }); window.webContents.send('screenshot:warning', message)
  }, input => window.webContents.send('screenshot:input', input))
  manager.onNativeVisibilityChange = visibility => window.webContents.send('screenshot:visibility', visibility)
  manager.onNativeInput = (owner, input) => overlays.forwardBrowserInput(owner, input)
  await manager.create(originalId, baseUrl + '/original', workspaceId)
  await manager.create(siblingId, baseUrl + '/sibling', workspaceId)
  manager.setBounds(originalId, { x: 20, y: 98, width: 660, height: 520 })
  manager.setBounds(siblingId, { x: 750, y: 75, width: 245, height: 535 })
  original = manager.nativeOwner(originalId)!.view; sibling = manager.nativeOwner(siblingId)!.view
  original.webContents.setBackgroundThrottling(false); sibling.webContents.setBackgroundThrottling(false)
  await until('both exact native documents ready', async () => !original.webContents.isLoading() && !sibling.webContents.isLoading() &&
    await original.webContents.executeJavaScript('!!document.querySelector("input")') && await sibling.webContents.executeJavaScript('!!document.querySelector("input")'))
  originalSnapshot = await manager.create(originalId, baseUrl + '/original', workspaceId)
  siblingSnapshot = await manager.create(siblingId, baseUrl + '/sibling', workspaceId)
  receipt.owners = { original: { ...originalSnapshot, webContentsId: original.webContents.id }, sibling: { ...siblingSnapshot, webContentsId: sibling.webContents.id } }
  const nativeCapture = original.webContents.capturePage.bind(original.webContents)
  original.webContents.capturePage = async (...args) => { receipt.counters.originalCapture++; return await nativeCapture(...args) }
  const chromeCapture = window.webContents.capturePage.bind(window.webContents)
  window.webContents.capturePage = async (...args) => {
    receipt.counters.rendererCapture++
    const image = await chromeCapture(...args), encode = image.toDataURL.bind(image)
    image.toDataURL = (...args) => { receipt.counters.rendererEncode++; return encode(...args) }
    return image
  }
  ipcMain.handle('screenshot:call', async (event, method, ...args) => {
    assert.equal(event.sender, window.webContents, 'Private bridge belongs to this exact Renderer')
    if (method === 'setup') return { original: originalSnapshot, sibling: siblingSnapshot }
    if (method === 'nativeBrowserVisibility') return manager.nativeBrowserVisibility()
    if (method === 'publishNativeOverlays') {
      const result = await overlays.update(args[0]); receipt.publications.push({ count: args[0].length, result }); return result
    }
    if (method === 'privateClipboard') {
      assert.equal(args[0].mimeType, 'image/png'); assert.ok(args[0].dataUrl.startsWith('data:image/png;base64,'))
      receipt.clipboard.push({ byteLength: args[0].byteLength, width: args[0].width, height: args[0].height }); return
    }
    assert.equal(args[0], originalId, 'The original Pane keeps its exact Browser target')
    receipt.calls.push({ method, args })
    if (method === 'captureScreenshot') return await manager.captureScreenshot(args[0])
    if (method === 'setBounds') return manager.setBounds(args[0], args[1])
    if (method === 'setAnnotationMarkers') return await manager.setAnnotationMarkers(args[0], args[1], args[2])
    if (method === 'cancelElementSelection') return await manager.cancelElementSelection(args[0])
    throw new Error('Unexpected private IO: ' + method)
  })
  await window.loadFile(join(root, 'index.html')); window.showInactive(); window.webContents.focus()
  receipt.rendererDocument = { url: window.webContents.getURL(), webContentsId: window.webContents.id, windowId: window.id }
  window.webContents.debugger.attach('1.3')
  await until('mounted production Pane and native frame', async () => await evaluate('!!document.querySelector("button[aria-label=Screenshot]")') && manager.nativeOwner(originalId))
  await settle(); await keepOwners('initial-original-and-sibling')
  const opened = await openEditor()
  assert.equal(receipt.calls.filter((row: any) => row.method === 'captureScreenshot').length, 1)
  const before = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts() }
  const box = opened.canvas, x = box.x + 30, y = box.y + 40, count = 300, start = Date.now()
  await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left')
  for (let i = 1; i <= count; i++) await mouse('mouseMoved', x + (i / count) * Math.min(300, box.width - 65), y + 40 * Math.sin(i / 25), 'left')
  await mouse('mouseReleased', x + Math.min(300, box.width - 65), y + 40 * Math.sin(count / 25), 'left')
  await settle()
  const after = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts(), ink: await evaluate('window.screenshotProbe.inkPixels()') }
  const trusted = after.facts.events.slice(before.facts.events.length).filter((event: any) => event.target === 'canvas' && event.trusted)
  assert.ok(trusted.filter((event: any) => event.type === 'pointermove').length >= count, 'Actual continuous CDP pointer samples reach the real Canvas')
  assert.equal(trusted.filter((event: any) => event.type === 'pointerdown').length, 1); assert.equal(trusted.filter((event: any) => event.type === 'pointerup').length, 1)
  assert.ok(after.ink.count > 100, 'Nonempty Canvas ink is rendered while the actual page is retained')
  assert.deepEqual(after.counters, before.counters, 'drawing-must-not-capture-or-encode-native-chrome')
  assert.equal(after.publications, before.publications, 'drawing-must-not-publish-native-chrome')
  receipt.cases.push({ label: 'continuous-pointer-ink-with-zero-native-chrome-work', samples: count, elapsedMs: Date.now() - start, before, after })
  await shot('editor-ink')
  await click('Cancel', true); await closed('native-pointer-cancel')
  await openEditor(); await escape(); await closed('trusted-keyboard-escape')
  await openEditor(); await evaluate('window.screenshotProbe.holdEncoding()')
  await click('Copy PNG', true)
  const pending = await until('actual Canvas PNG callback held', async () => { const row = await facts(); return row.encodingHeld && row.copying ? row : null })
  assert.equal(pending.cancelDisabled, false, 'busy-copy-must-keep-Cancel-action-available')
  await click('Cancel', true); await closed('cancel-during-actual-PNG-encoding')
  await evaluate('window.screenshotProbe.releaseEncoding()'); await settle()
  assert.equal(receipt.clipboard.length, 0, 'A cancelled actual PNG result never writes the private clipboard sink')
  assert.equal((await facts()).editor, false, 'Late encoding cannot resurrect the editor')
  receipt.cases.push({ label: 'late-native-PNG-after-cancel-keeps-clipboard-and-workface', pending, after: await facts(), clipboard: receipt.clipboard.slice() })
  await openEditor(); await click('Copy PNG', true); await closed('normal-copy-completes-through-private-clipboard')
  assert.equal(receipt.clipboard.length, 1, 'The actual success path writes exactly one PNG')
  assert.equal(receipt.counters.originalCapture, 4, 'Four real screenshot entries each capture their original page once')
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') {
    for (const [kind, width, height] of [['narrow', 450, 640], ['short', 880, 390]] as const) {
      window.setContentSize(width, height); await settle(); await openEditor(); await shot(kind); await click('Cancel', true); await closed('visual-' + kind)
    }
  }
  assert.deepEqual((await facts()).errors, [])
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack } }).finally(async () => {
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  try { if (window && !window.isDestroyed()) await evaluate('window.screenshotProbe?.dispose()') } catch {}
  overlays?.dispose(); manager?.dispose(); server?.close(); window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
