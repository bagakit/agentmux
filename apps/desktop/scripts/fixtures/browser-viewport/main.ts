import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, type NativeImage, type WebContentsView } from 'electron'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { parseAgentMuxSpatialGraph, spatialCatalog } from '@agentmux/core/spatial-state'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { BROWSER_EVENT_CHANNEL, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_BROWSER_VISIBILITY_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL,
  BROWSER_VIEWPORT_PRESETS, type BrowserViewport } from '../../../src/shared/contracts'

const root = process.env.AGENTMUX_VIEWPORT_ROOT!, out = process.env.AGENTMUX_VIEWPORT_OUT!, label = process.env.AGENTMUX_VIEWPORT_LABEL!
assert.ok(root.includes('agentmux-viewport-'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('no-proxy-server'); app.commandLine.appendSwitch('disk-cache-size', '1048576')
const originalId = 'private-viewport-original', siblingId = 'private-viewport-sibling', workspaceId = 'private-viewport-workspace'
const receipt: any = { label, pid: process.pid, passed: false, cases: [], images: [], warnings: [], calls: [], events: [], public: [] }
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, server: Server, rpcServer: AgentMuxControlServer
let original: WebContentsView, sibling: WebContentsView, baseline: any, siblingBaseline: any, baseUrl: string
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (code: string) => window.webContents.executeJavaScript(code)
async function until(name: string, read: () => Promise<any>, budget = 4000) {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(15) }
  throw new Error('Viewport observation failed: ' + name)
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))') }
const uiFacts = () => evaluate('window.viewportProbe.read()')
const pageFacts = () => original.webContents.executeJavaScript('window.viewportFacts()')
async function pointer(type: string, point: { x: number; y: number }) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point,
    ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
}
async function clickUi(selector: string, name: string) {
  const point = await evaluate(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=nodes.find(n=>(n.getAttribute('aria-label')===${JSON.stringify(name)}||n.textContent.trim().startsWith(${JSON.stringify(name)}))&&n.getBoundingClientRect().width>0);if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  assert.ok(point, 'Actual Viewport control exists: ' + name)
  await pointer('mouseMoved', point); await pointer('mousePressed', point); await pointer('mouseReleased', point)
}
async function choose(mode: BrowserViewport, narrow = false) {
  const title = mode[0].toUpperCase() + mode.slice(1)
  await clickUi('button', narrow ? 'More browser tools' : 'Viewport')
  await until('actual Viewport radio menu', async () => await evaluate('document.querySelectorAll("[role=menuitemradio]").length===4'))
  await clickUi('[role=menuitemradio]', title)
  await until('menu-call-must-apply-original-viewport: ' + mode, async () => (await uiFacts()).viewport === mode && !(await uiFacts()).menus)
  assert.ok(receipt.calls.some((call: any) => call.channel === 'browser:setViewport' && call.args[0] === originalId && call.args[1] === mode), 'Actual production preload calls the original Main setter')
  await settle()
  const facts = await uiFacts()
  for (const type of ['pointerdown', 'pointerup', 'click']) assert.ok(facts.events.some((e: any) => e.type === type && e.trusted && e.target?.startsWith(title)), 'Actual Radio consumes the complete trusted ' + type)
}
async function resize(width: number, height: number) {
  await evaluate(`window.viewportProbe.resize(${width},${height})`); await settle()
  await until('the original Pane publishes its resized native bounds', async () => {
    const owner = manager.nativeOwner(originalId); return owner && Math.abs(owner.bounds.width - width) <= 2 && owner.bounds.height < height ? owner : null
  })
  await settle()
}
async function identity(name: string) {
  const owner = manager.nativeOwner(originalId), other = manager.nativeOwner(siblingId)
  assert.equal(owner?.view, original, name + ': original physical View remains')
  assert.equal(other?.view, sibling, name + ': sibling physical View remains')
  const current = manager.targets().find(target => target.id === originalId)!, otherTarget = manager.targets().find(target => target.id === siblingId)!
  assert.equal(current.navigationId, baseline.navigationId); assert.equal(current.workspaceId, workspaceId)
  assert.equal(otherTarget.navigationId, siblingBaseline.navigationId)
  const snapshot = await manager.create(originalId, current.url, workspaceId)
  assert.equal(snapshot.profileId, baseline.profileId)
  assert.equal((await pageFacts()).draft, 'retained original draft')
  assert.equal(await sibling.webContents.executeJavaScript('document.querySelector("input").value'), 'retained sibling draft')
  assert.equal(original.webContents.getZoomFactor(), baseline.zoom)
  assert.equal(sibling.webContents.getZoomFactor(), siblingBaseline.zoom)
  assert.deepEqual(window.getContentSize(), [1200, 800], 'Choosing/resizing a Pane does not resize the App window')
}
const colors = { tl: [0, 230, 230], tr: [255, 220, 0], bl: [0, 220, 70], br: [230, 0, 220] }
function corners(image: NativeImage) {
  const { width, height } = image.getSize(), bitmap = image.toBitmap(), result: any = {}
  for (const [name, rgb] of Object.entries(colors)) {
    let count = 0, sx = 0, sy = 0
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.abs(bitmap[i + 2] - rgb[0]) < 18 && Math.abs(bitmap[i + 1] - rgb[1]) < 18 && Math.abs(bitmap[i] - rgb[2]) < 18) { count++; sx += x; sy += y }
    }
    result[name] = { count, x: sx / count, y: sy / count }
  }
  return result
}
async function observe(name: string, mode: BrowserViewport, save = false) {
  const metrics = await pageFacts(), owner = manager.nativeOwner(originalId)!, image = await original.webContents.capturePage()
  const marks = corners(image)
  for (const [corner, mark] of Object.entries<any>(marks)) assert.ok(mark.count >= 4, 'fixed-viewport-must-fit-all-four-corners: ' + name + '/' + corner)
  const expected = BROWSER_VIEWPORT_PRESETS[mode]
  if (expected) {
    assert.equal(metrics.screen.width, expected.width, 'native-apply-must-change-layout-width: ' + name)
    assert.equal(metrics.screen.height, expected.height, 'native-apply-must-change-layout-height: ' + name)
    if (metrics.hasMeta || mode === 'desktop') {
      assert.ok(Math.abs(metrics.innerWidth - expected.width) <= 1, 'native-apply-must-change-layout-width: ' + name)
      assert.ok(Math.abs(metrics.innerHeight - expected.height) <= 1, 'native-apply-must-change-layout-height: ' + name)
    } else assert.ok(Math.abs(metrics.visual.width * metrics.visual.scale - expected.width) <= 1, 'No-meta standard mobile visual/layout relation remains')
  } else {
    assert.ok(Math.abs(metrics.innerWidth * baseline.zoom - owner.bounds.width) <= 1, 'Responsive follows actual Pane width')
    assert.ok(Math.abs(metrics.innerHeight * baseline.zoom - owner.bounds.height) <= 1, 'Responsive follows actual Pane height')
  }
  const size = image.getSize(), clicked: any[] = []
  for (const [corner, mark] of Object.entries<any>(marks)) {
    const point = { x: Math.round(mark.x * owner.bounds.width / size.width), y: Math.round(mark.y * owner.bounds.height / size.height) }
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) original.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 })
    await delay(12)
    const after = await pageFacts(), event = after.clicks.at(-1)
    assert.equal(event?.corner, corner, 'fit-native-input-must-hit-visible-corner: ' + name + '/' + corner)
    assert.equal(event.trusted, true); clicked.push(event)
  }
  await identity(name)
  receipt.cases.push({ label: name, mode, metrics, marks, trustedClicks: clicked, nativeBounds: owner.bounds, imageSize: size, browser: { ...baseline, webContentsId: original.webContents.id } })
  if (save) await shot(name)
}
async function saveImage(name: string, image: NativeImage, kind: string, extra: any = {}) {
  const bytes = image.toPNG(), path = label + '-' + name + '.png'
  await writeFile(join(out, path), bytes)
  const row = { path, kind, bytes: bytes.length, sha256: sha(bytes), size: image.getSize(), pid: process.pid, ...extra }
  receipt.images.push(row); return row
}
async function shot(name: string) {
  await settle()
  const chrome = await window.webContents.capturePage(), layers = []
  const sources = [await saveImage(name + '-renderer', chrome, 'actual-renderer')]
  for (const id of [originalId, siblingId]) {
    const owner = manager.nativeOwner(id)
    if (!owner || !owner.view.getVisible()) continue
    const capture = await owner.view.webContents.capturePage()
    sources.push(await saveImage(name + '-' + (id === originalId ? 'original' : 'sibling'), capture, 'actual-native-view', { browserId: id, bounds: owner.bounds, visible: true, webContentsId: owner.view.webContents.id }))
    layers.push({ dataUrl: capture.toDataURL(), ...owner.bounds })
  }
  const dataUrl = await evaluate(`window.viewportProbe.compose(${JSON.stringify(chrome.toDataURL())},${JSON.stringify(layers)})`)
  await saveImage(name, nativeImage.createFromDataURL(dataUrl), 'complete-workface-composite-from-actual-settled-surfaces', { sources: sources.map(s => ({ path: s.path, sha256: s.sha256 })), bounds: manager.nativeOwner(originalId)?.bounds })
}
async function cli(args: string[], input = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_RPC_ENDPOINT: 'unix:' + rpcServer.path,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'cli-runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'cli-state') })
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.AGENTMUX_VIEWPORT_CLI!, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 500) }, 8000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation)
      if (expired) reject(new Error('Exact private CLI child timed out and exited'))
      else { try { assert.equal(code, 0, stderr + stdout); const result = JSON.parse(stdout); assert.equal(result.ok, true); resolve({ pid: child.pid, code, signal, result, stderr }) } catch (error) { reject(error) } }
    }); child.stdin.end(input)
  })
}
async function publicRead(name: string, useCli: boolean) {
  const program = `const tree=await snapshot({interactiveOnly:true,maxNodes:64}); const target=tree.nodes.find(n=>n.name==='Corner br'); if(!target)throw Error('Original corner ref missing'); await click(target.ref); const geometry=await js('window.viewportFacts()'); const metrics=await cdp('Page.getLayoutMetrics'); const capture=await captureScreenshot(); return {geometry,metrics,browserId:capture.browserId,navigationId:capture.navigationId,source:capture.source,image:{width:capture.image.width,height:capture.image.height}}`
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: rpcServer.path } })
  let sdk: any
  try { sdk = await rpc.call('browser.run', { browserId: originalId, code: program, operationId: 'viewport-sdk-' + name }) } finally { await rpc.dispose() }
  assert.equal(sdk.outcome.kind, 'completed', 'Public SDK actual ref click completes: ' + name)
  const actual = await pageFacts()
  assert.equal(sdk.result.geometry.innerWidth, actual.innerWidth); assert.equal(sdk.result.geometry.innerHeight, actual.innerHeight)
  assert.equal(sdk.result.geometry.clicks.at(-1)?.corner, 'br', 'Public ref click hits the original corner after fit')
  assert.equal(sdk.result.geometry.clicks.at(-1)?.trusted, false, 'Existing public semantic DOM click is not a trusted human event')
  assert.equal(sdk.result.browserId, originalId); assert.equal(sdk.result.navigationId, baseline.navigationId)
  assert.ok(sdk.result.image.width > 0 && sdk.result.image.height > 0)
  let consumed: any
  if (useCli) {
    consumed = await cli(['browser', 'run', '--browser', originalId, '--operation-id', 'viewport-cli-' + name], program)
    const result = consumed.result.result
    assert.equal(result.outcome.kind, 'completed'); assert.equal(result.result.geometry.innerWidth, actual.innerWidth)
    assert.equal(result.result.geometry.clicks.at(-1)?.corner, 'br')
    assert.equal(result.result.browserId, originalId); assert.equal(result.result.navigationId, baseline.navigationId)
    assert.ok(result.result.image.width > 0 && result.result.image.height > 0)
  }
  receipt.public.push({ label: name, sdk, cli: consumed }); await identity(name + '-public')
}
function html(meta: boolean, siblingPage = false) {
  return `<!doctype html>${meta ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}<title>${siblingPage ? 'Sibling' : meta ? 'Viewport meta page' : 'Viewport standard mobile layout'}</title><style>html,body{margin:0;background:${siblingPage ? '#173e34' : '#f4f6fb'};color:${siblingPage ? '#fff' : '#233248'};font:18px system-ui}main{padding:72px 55px}h1{font-size:24px}input{width:70%;font:16px system-ui;padding:10px}button{position:fixed;width:32px;height:32px;border:0;padding:0;font:9px system-ui;color:#111}#tl{left:8px;top:8px;background:rgb(0,230,230)}#tr{right:8px;top:8px;background:rgb(255,220,0)}#bl{left:8px;bottom:8px;background:rgb(0,220,70)}#br{right:8px;bottom:8px;background:rgb(230,0,220)}</style><main><h1>${siblingPage ? 'Retained sibling' : meta ? 'Responsive document' : 'Standard mobile layout'}</h1><p>The same page stays available.</p><input value="retained ${siblingPage ? 'sibling' : 'original'} draft"></main>${Object.keys(colors).map(key => `<button id="${key}" aria-label="Corner ${key}">${key}</button>`).join('')}<script>window.cornerClicks=[];document.addEventListener('click',event=>{if(event.target.matches('button'))cornerClicks.push({corner:event.target.id,trusted:event.isTrusted})});window.viewportFacts=()=>({innerWidth,innerHeight,visual:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},screen:{width:screen.width,height:screen.height},hasMeta:!!document.querySelector('meta[name=viewport]'),draft:document.querySelector('input').value,clicks:cornerClicks.slice()})</script>`
}
async function run() {
  await app.whenReady()
  receipt.compiled = Object.fromEntries(await Promise.all(['main.mjs', 'renderer.js', 'renderer.css', 'preload.cjs'].map(async name => [name, sha(await readFile(join(root, name)))])))
  server = createServer((request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html(request.url !== '/no-meta', request.url === '/sibling')) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = 'http://127.0.0.1:' + (server.address() as any).port
  window = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, backgroundColor: '#171d24', webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  window.webContents.on('console-message', event => { if (event.level === 'error') receipt.warnings.push({ kind: 'renderer', message: event.message }) })
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'private-viewport-profile', resolvePartition: () => 'viewport-' + process.pid }, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('Private viewport fixture cannot open system links') } })
  overlays = new NativeOverlaySurfaces(window, manager, message => { receipt.warnings.push({ kind: 'native-overlay', message }); window.webContents.send(NATIVE_OVERLAY_WARNING_CHANNEL, message) }, input => window.webContents.send(NATIVE_BROWSER_INPUT_CHANNEL, input))
  manager.onNativeVisibilityChange = visibility => window.webContents.send(NATIVE_BROWSER_VISIBILITY_CHANNEL, visibility)
  manager.onNativeInput = (owner, input) => overlays.forwardBrowserInput(owner, input)
  await manager.create(originalId, baseUrl + '/meta', workspaceId); await manager.create(siblingId, baseUrl + '/sibling', workspaceId)
  manager.setBounds(originalId, { x: 20, y: 110, width: 800, height: 590 }); manager.setBounds(siblingId, { x: 930, y: 80, width: 240, height: 600 })
  original = manager.nativeOwner(originalId)!.view; sibling = manager.nativeOwner(siblingId)!.view
  await until('both original native pages ready', async () => !original.webContents.isLoading() && !sibling.webContents.isLoading() && await pageFacts())
  baseline = { ...await manager.create(originalId, baseUrl + '/meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  siblingBaseline = { ...await manager.create(siblingId, baseUrl + '/sibling', workspaceId), zoom: sibling.webContents.getZoomFactor() }
  ipcMain.on('ui:themeBootstrap', event => { event.returnValue = null })
  ipcMain.handle('viewport:setup', () => ({ original: baseline }))
  const handle = (channel: string, action: (...args: any[]) => any) => ipcMain.handle(channel, (event, ...args) => {
    assert.equal(event.sender, window.webContents); receipt.calls.push({ channel, args }); return action(...args)
  })
  handle('browser:setViewport', (id, mode) => manager.setViewport(id, mode))
  handle('browser:setBounds', (id, bounds) => manager.setBounds(id, bounds))
  handle('browser:cancelElementSelection', id => manager.cancelElementSelection(id))
  handle('browser:setAnnotationMarkers', (id, navigationId, marks) => manager.setAnnotationMarkers(id, navigationId, marks))
  handle('browser:listInputHistory', () => ({ entries: [] }))
  handle('browser:release', id => manager.release(id))
  handle('browser:restore', (id, input) => manager.restore(id, input))
  handle('ui:nativeBrowserVisibility', () => manager.nativeBrowserVisibility())
  handle('ui:publishNativeOverlays', regions => overlays.update(regions))
  const spatial = parseAgentMuxSpatialGraph({ spaces: [], zones: [{ zoneId: 'viewport-zone', workspaceId, kind: 'directory', hostId: 'local', directoryPath: root, branch: null }],
    tabs: [{ tabId: 'viewport-tab', zoneId: 'viewport-zone', workspaceId, name: null, regionIds: ['private-viewport-region'] }],
    regions: [{ regionId: 'private-viewport-region', tabId: 'viewport-tab', kind: 'browser', agentSessionId: null, runId: null, execution: null }], bindings: [],
    layouts: { [workspaceId]: createWorkspaceLayout('viewport-group', ['viewport-tab']) }, tabLayouts: { 'viewport-tab': { root: { type: 'leaf', regionId: 'private-viewport-region' }, activeRegionId: 'private-viewport-region' } }, resources: { 'viewport-tab': { browserId: originalId } } })
  rpcServer = new AgentMuxControlServer({ coreClients: () => [], execute: async request => {
    if (request.operation === 'browser.targets') return { operation: 'browser.targets', targets: manager.targets() }
    if (request.operation === 'space.inspect') return { operation: 'space.inspect', catalog: spatialCatalog(spatial, request.target as any) }
    assert.equal(request.operation, 'browser.run'); if (request.operation !== 'browser.run') throw new Error('Outside the bounded viewport public fixture')
    const result = await manager.runScript(request.browserId, request.code, undefined, undefined, request.operationId)
    return { operation: 'browser.run', ...result }
  } }, join(root, 'control.sock')); await rpcServer.start()
  await window.loadFile(join(root, 'index.html')); window.show(); window.webContents.focus(); window.webContents.debugger.attach('1.3')
  await until('mounted original product Viewport button', async () => evaluate('!!document.querySelector("button[aria-label=Viewport]")'))
  await settle()
  receipt.discovery = { targets: await cli(['browser', 'targets']), space: await cli(['space', 'inspect', '--zone', 'viewport-zone']) }
  assert.ok(receipt.discovery.targets.result.result.targets.some((row: any) => row.id === originalId))
  assert.equal(receipt.discovery.space.result.result.catalog.regions[0].regionId, 'private-viewport-region')
  for (const page of ['meta', 'no-meta']) {
    if (page === 'no-meta') { await manager.navigate(originalId, baseUrl + '/no-meta'); await until('second generic document ready', async () => !original.webContents.isLoading() && (await pageFacts()).hasMeta === false) }
    baseline = { ...await manager.create(originalId, baseUrl + '/' + page, workspaceId), zoom: original.webContents.getZoomFactor() }
    for (const mode of ['mobile', 'tablet', 'desktop', 'responsive'] as BrowserViewport[]) {
      await resize(800, 650); await choose(mode); await observe(page + '-wide-' + mode, mode, true)
      await publicRead(page + '-' + mode, mode === 'mobile' || mode === 'desktop')
      await resize(650, 510); await observe(page + '-resized-' + mode, mode)
    }
    await resize(330, 620); await choose('desktop', true); await observe(page + '-narrow-desktop', 'desktop', true)
    await choose('responsive', true); await observe(page + '-narrow-responsive', 'responsive')
  }
  await resize(800, 650); await choose('tablet')
  const beforeReload = baseline.navigationId
  await manager.reload(originalId); await until('actual reload applies the retained viewport', async () => !original.webContents.isLoading() && (await pageFacts()).innerWidth > 0)
  baseline = { ...await manager.create(originalId, baseUrl + '/no-meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  assert.notEqual(baseline.navigationId, beforeReload); await observe('reload-retains-tablet', 'tablet')
  await evaluate('window.viewportProbe.released(true)')
  await until('original client releases its native owner', async () => !original.webContents || original.webContents.isDestroyed())
  await evaluate('window.viewportProbe.released(false)')
  await until('original client restores the logical Browser', async () => manager.nativeOwner(originalId)?.view && !manager.nativeOwner(originalId)!.view.webContents.isLoading())
  const oldView = original; original = manager.nativeOwner(originalId)!.view
  assert.notEqual(original, oldView)
  baseline = { ...await manager.create(originalId, baseUrl + '/no-meta', workspaceId), zoom: original.webContents.getZoomFactor() }
  await settle(); assert.equal(baseline.viewport, 'tablet'); await observe('restore-retains-logical-browser-profile-and-mode', 'tablet')
  receipt.events = (await uiFacts()).events; assert.deepEqual((await uiFacts()).errors, []); assert.deepEqual(receipt.warnings, [])
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack } }).finally(async () => {
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  if (window && !window.isDestroyed()) { await evaluate('window.viewportProbe?.dispose()').catch(() => {}); await delay(40) }
  await rpcServer?.stop(); overlays?.dispose(); manager?.dispose(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
