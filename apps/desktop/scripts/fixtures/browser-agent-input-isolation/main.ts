import assert from 'node:assert/strict'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { app, BrowserWindow, ipcMain, webContents, type WebContentsView, type View } from 'electron'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal'
import { projectBrowserControlResult } from '../../../src/main/browser-completion-control'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

// Closing the last private window must not race the final asynchronous receipt.
app.on('window-all-closed', () => {})

const root = process.env.AGENTMUX_ISOLATION_PROOF_ROOT!, source = process.env.AGENTMUX_ISOLATION_SOURCE!, node = process.env.AGENTMUX_ISOLATION_NODE!
const receipt: any = { schema: 'agentmux.browser-agent-input-isolation.native.v1', passed: false, cases: [], cli: [], input: [], paths: {},
  boundary: 'Private actual Electron BrowserViewManager, page/child-frame DOM, native input surfaces, production BrowserOperationStatus and original Renderer control branches; public RPC service/client and built CLI. AppKit NSEvents enter the exact private NSWindow dispatcher for real native hit-testing; Electron native input independently establishes actual DOM pointer capture. This fixture admits only its synchronous native source and actual in-flight CDP mouse commands at its private before-mouse boundary; unrelated physical mouse input cannot corrupt the source. Physical hardware button-state and OS IME routing are not asserted. No user App or Run is used; no clipboard contents are inspected or recorded.' }
let nativeSourceDepth = 0, agentMouseCommands = 0
const nativeSource = <T>(dispatch: () => T): T => { ++nativeSourceDepth; try { return dispatch() } finally { --nativeSourceDepth } }
receipt.nativeMouse = []
app.on('web-contents-created', (_event, target) => target.on('before-mouse-event', (event, input) => {
  if (!nativeSourceDepth && !agentMouseCommands) { event.preventDefault(); return }
  receipt.nativeMouse.push({ contents: target.id, input, caseCount: receipt.cases.length, dispatchCount: receipt.input.length,
    control: manager?.targets()[0]?.control })
}))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const saveReceipt = async () => { const pending = join(root, 'receipt.pending.json'); await writeFile(pending, JSON.stringify(receipt, null, 2)); await rename(pending, join(root, 'receipt.json')) }
let win: BrowserWindow, manager: BrowserViewManager, chrome: NativeOverlaySurfaces, control: AgentMuxControlServer, server: ReturnType<typeof createServer>
const pageDocument = (frame = false) => `<!doctype html><style>body{margin:12px;min-height:1800px}button{width:130px;height:42px}input{width:150px}#drag{width:130px;height:50px;background:#cce}iframe{display:block;width:500px;height:160px;border:0;margin-top:25px}</style>
<button id="action">${frame ? 'Frame' : 'Main'} action</button><input id="text" aria-label="Text field"><div id="drag">Capture drag</div>${frame ? '' : '<iframe src="/frame"></iframe>'}
<script>globalThis.proof={events:[],clicks:0,next:0,inFlightStarted:0,inFlightFinished:0};
for(const type of ['pointerdown','pointerup','pointermove','gotpointercapture','lostpointercapture','click','wheel','keydown','keyup','input','compositionstart','compositionupdate','compositionend','paste','drop'])addEventListener(type,e=>{proof.events.push({type,target:e.target.id,pointerId:e.pointerId});if(type==='pointerdown'&&e.target.id==='drag')e.target.setPointerCapture(e.pointerId);if(type==='drop')e.preventDefault()});
document.querySelector('#action').onclick=()=>proof.clicks++;</script>`

async function waitFor<T>(read: () => T | Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) { const value = await read(); if (value) return value; await pause(20) }
  throw new Error('Native proof did not observe ' + label)
}
function cli(args: string[], code = ''): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), ELECTRON_RUN_AS_NODE: undefined })
    const child = spawn(node, [join(source, 'packages/core/bin/amux'), '--endpoint', `unix:${join(root, 'control.sock')}`, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private CLI exceeded its observation budget')) }, 15000)
    child.on('error', reject); child.on('exit', exitCode => {
      clearTimeout(timeout); const result = { args, code: exitCode, stdout, stderr }; receipt.cli.push(result); resolve(result)
    }); child.stdin.end(code)
  })
}
function topmost(view: View, x: number, y: number): WebContentsView | undefined {
  for (const child of [...view.children].reverse()) {
    const bounds = child.getBounds()
    if (!child.getVisible() || x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) continue
    return topmost(child, x - bounds.x, y - bounds.y) ?? ('webContents' in child ? child as WebContentsView : undefined)
  }
}
async function run() {
  console.log('native-proof:loaded')
  await app.whenReady()
  for (const key of ['home', 'appData', 'userData', 'sessionData']) {
    receipt.paths[key] = app.getPath(key as any)
    assert.equal(receipt.paths[key], join(root, key), 'Every Electron storage path is private before Main is imported')
  }
  server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pageDocument(req.url === '/frame')) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port, url = `http://127.0.0.1:${port}/page`
  win = new BrowserWindow({ width: 900, height: 780, show: false, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true } })
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.sqlite')))
  manager = new BrowserViewManager(win, { defaultProfileId: () => 'probe', resolvePartition: id => 'persist:input-proof-' + id }, new BrowserRefLedgerStore(join(root, 'refs.json')), {
    rememberedSchemes: async () => ({}), rememberScheme: async () => { throw new Error('Not part of this proof') }, openExternal: () => { throw new Error('Never open a user application') }
  }, journal)
  const originalSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel: string, ...args: any[]) => { originalSend(channel, ...args); if (channel === 'agentmux:browser-event' && args[0]?.browser?.id === 'page') originalSend('proof:snapshot', args[0].browser) }
  const initial = await manager.create('page', url, 'workspace')
  console.log('native-proof:created')
  manager.setBounds('page', { x: 12, y: 220, width: 850, height: 510 })
  const page = manager.nativeOwner('page')!.view, contents = page.webContents
  const nativeCommand = contents.debugger.sendCommand.bind(contents.debugger)
  contents.debugger.sendCommand = async (method: string, params?: any, sessionId?: string) => {
    if (method === 'Input.dispatchMouseEvent') ++agentMouseCommands
    try { return await nativeCommand(method, params, sessionId) }
    finally { if (method === 'Input.dispatchMouseEvent') --agentMouseCommands }
  }
  await waitFor(() => contents.executeJavaScript('!!document.querySelector("iframe")?.contentDocument?.querySelector("#action")'), 'same-process frame')
  await win.loadFile(join(root, 'index.html')); win.show(); win.focus(); win.webContents.focus()
  console.log('native-proof:renderer')
  const nativeWindowInput = createRequire(import.meta.url)(join(root, 'native-input.node'))
  originalSend('proof:snapshot', initial)
  const observe = () => contents.executeJavaScript('({events:proof.events.slice(),clicks:proof.clicks,text:document.querySelector("#text").value,frame:document.querySelector("iframe").contentWindow.proof,scroll:scrollY,next:proof.next,inFlightStarted:proof.inFlightStarted,inFlightFinished:proof.inFlightFinished})')
  // A previously accepted capture can naturally end after its original down.
  // Keep that lifecycle in receipts; only new page input/effects violate the lease.
  const inputEffects = (state: any): any => ({ ...state,
    events: state.events.filter((event: any) => !['gotpointercapture', 'lostpointercapture'].includes(event.type)),
    ...(state.frame ? { frame: inputEffects(state.frame) } : {}) })
  const focusPrivateWindow = async () => {
    try { await waitFor(() => { if (!win.isFocused()) { app.focus({ steal: true }); win.focus() }; return win.isFocused() }, 'exact private window focus before native input') }
    catch (error) {
      let native: unknown
      try { native = nativeWindowInput.focusState(win.getNativeWindowHandle()) }
      catch (observationError) { native = { unavailable: true, message: String(observationError) } }
      receipt.focusFailure = { window: win.isFocused(), visible: win.isVisible(), focusable: win.isFocusable(),
        native, privatePid: process.pid,
        focusedWindow: BrowserWindow.getFocusedWindow()?.id, focusedContents: webContents.getFocusedWebContents()?.id,
        renderer: { id: win.webContents.id, focused: win.webContents.isFocused() }, page: { id: contents.id, focused: contents.isFocused() },
        children: page.children.map((child: any) => ({ focused: child.webContents?.isFocused(), id: child.webContents?.id, window: child.webContents ? BrowserWindow.fromWebContents(child.webContents)?.id : null })) }
      throw error
    }
  }
  const point = async (selector: string, frame = false) => contents.executeJavaScript(`(()=>{const f=${frame ? 'document.querySelector("iframe")' : 'null'},d=f?f.contentDocument:document,r=d.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),o=f?f.getBoundingClientRect():{x:0,y:0};return{x:(o.x+r.x+r.width/2)*${contents.getZoomFactor()},y:(o.y+r.y+r.height/2)*${contents.getZoomFactor()}}})()`)
  const sendHuman = async (input: any) => {
    await focusPrivateWindow()
    const bounds = page.getBounds(), target = topmost(win.contentView, bounds.x + input.x, bounds.y + input.y)
    assert.ok(target, 'A real visible topmost native input owner must exist')
    assert.equal(target === page || target === manager.nativeOwner('page')?.inputShield, true, 'Only this original page or its native child may receive page input')
    receipt.input.push({ targetId: target.webContents.id, pageId: contents.id, type: input.type, active: manager.targets()[0]?.control })
    nativeSource(() => target.webContents.sendInputEvent(input.type === 'mouseDown' ? { modifiers: ['leftbuttondown'], ...input } : input)); await pause(40)
    return target
  }
  const clickHuman = async (p: any) => { await sendHuman({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); await sendHuman({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }) }
  const sendWindowMouse = async (kind: number, point: { x: number; y: number }) => {
    await focusPrivateWindow()
    const bounds = page.getBounds(), hit = nativeSource(() => nativeWindowInput.send(win.getNativeWindowHandle(), kind, bounds.x + point.x, bounds.y + point.y))
    receipt.input.push({ route: 'exact-private-NSWindow', kind, hit, active: manager.targets()[0]?.control })
    await pause(80)
  }
  const action = await point('#action'), frameAction = await point('#action', true), drag = await point('#drag')
  const lease = manager.registerPresentation(win.webContents, win.webContents.mainFrame, { browserId: 'page', occurrence: {
    presentationId: 'proof-original', location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }
  }, geometry: { visible: true, bounds: page.getBounds() } })
  const capture = manager.armPresentationCapture(win.webContents, win.webContents.mainFrame, lease.leaseId)
  const trackIds = await win.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia({video:true,audio:false}).then(stream=>{globalThis.proofStream=stream;return stream.getVideoTracks().map(track=>track.id)})', true)
  console.log('native-proof:capture')
  manager.ackPresentationCapture(win.webContents, win.webContents.mainFrame, capture.captureId, { outcome: 'ready', trackIds })
  const down = { x: action.x / page.getBounds().width, y: action.y / page.getBounds().height }
  await focusPrivateWindow()
  const prepared = await manager.activatePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId, {
    kind: 'prepare-first-press', navigationId: initial.navigationId, captureId: capture.captureId, down, button: 'left', clickCount: 1, modifiers: []
  })
  assert.equal(prepared.outcome, 'prepared', 'A genuine captured presentation prepares a one-shot gesture: ' + JSON.stringify(prepared))
  await clickHuman(action); await clickHuman(frameAction)
  assert.equal((await observe()).clicks, 1); assert.equal((await observe()).frame.clicks, 1)
  await sendWindowMouse(1, action); await sendWindowMouse(2, action)
  assert.equal((await observe()).clicks, 2, 'The actual native Window route must first reach the original page')
  receipt.cases.push({ name: 'normal-main-and-frame-native-input', passed: true })
  // Establish actual DOM pointer capture with Electron's native input source.
  // AppKit dispatch below independently proves Window hit-testing; its synthetic
  // NSEvent cannot attest the WindowServer's physical pressed-button state.
  await sendHuman({ type: 'mouseDown', button: 'left', clickCount: 1, ...drag })
  await sendHuman({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: drag.x + 5, y: drag.y })
  receipt.preCapture = await observe()
  await waitFor(async () => (await observe()).events.some((event: any) => event.type === 'gotpointercapture'), 'real pre-existing pointer capture')
  let dispatchGateRelease: (() => void) | undefined
  const stopOriginal = (id: string) => { const stopped = manager.stopOperationById(id); dispatchGateRelease?.(); return stopped }
  const resourceTargets = () => manager.resourceTargets(new Map(app.getAppMetrics().map(process => [process.pid, process.creationTime])))
  const api = { browser: { listTargets: async () => ({ targets: resourceTargets(), coverage: 'complete' }), runScript: (...args: any[]) => manager.runScript(args[0], args[1], args[2], undefined, args[3]),
    stopOperationById: stopOriginal, getOperation: (id: string) => manager.getOperation(id) } }
  const store = await readFile(join(source, 'apps/desktop/src/renderer/src/store.ts'), 'utf8')
  const from = store.indexOf("    if (request.operation === 'browser.targets')"), until = store.indexOf("    if (request.operation === 'browser.task.assets'", from)
  const stopFrom = store.indexOf("    if (request.operation === 'browser.stop')"), stopUntil = store.indexOf('    // browser.subscribe', stopFrom)
  assert.ok(from >= 0 && until > from && stopFrom >= 0 && stopUntil > stopFrom, 'Actual Renderer consumer slices are nonempty')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const execute = new AsyncFunction('request', 'api', 'requireActive', 'get', 'browserOperatorForSession', store.slice(from, until) + store.slice(stopFrom, stopUntil))
  control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => projectBrowserControlResult(await execute(request, api, () => {}, () => ({ sessions: [] }), () => { throw new Error('No forged Agent identity') })) })
  await control.start()
  const trusted = (event: any) => { assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame) }
  ipcMain.handle('proof:stop', (event, id) => { trusted(event); return stopOriginal(id) })
  ipcMain.handle('proof:return', event => { trusted(event); return manager.returnControl('page') })
  const running = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-held'], 'await js("new Promise(resolve => globalThis.releaseProgram = resolve)"); return "done"')
  await waitFor(() => contents.executeJavaScript('typeof releaseProgram === "function"'), 'real CLI program entered Chromium')
  const claimedIsolation = manager.targets()[0]!.control!.inputIsolation
  const shield = (manager.nativeOwner('page')?.inputShield ?? page) as WebContentsView
  const retainedRun = await manager.release('page', manager.targets()[0]!.navigationId!)
  assert.equal(retainedRun.status, 'retained', 'A resource budget release cannot tear down an active Agent program')
  // Child layering remains correct through actual production native Chrome rearrangement.
  chrome = new NativeOverlaySurfaces(win, manager, () => {}, () => {})
  await chrome.update([{ id: 'chrome-1', bounds: { x: 8, y: 208, width: 870, height: 534 }, radius: 0, browserStages: [{ browserId: 'page', bounds: page.getBounds() }] }])
  const before = await observe()
  await sendWindowMouse(3, { x: drag.x + 8, y: drag.y }); await sendWindowMouse(2, drag)
  await sendWindowMouse(1, action); await sendWindowMouse(2, action); await sendWindowMouse(0, frameAction)
  await sendHuman({ type: 'mouseMove', x: drag.x + 8, y: drag.y, modifiers: ['leftbuttondown'] })
  await sendHuman({ type: 'mouseUp', button: 'left', clickCount: 1, ...drag })
  await clickHuman(action); await clickHuman(frameAction)
  await sendHuman({ type: 'mouseMove', ...action }); await sendHuman({ type: 'mouseWheel', ...action, deltaY: 90, deltaX: 0 })
  assert.deepEqual(inputEffects(await observe()), inputEffects(before), 'Native input isolation: active human pointer/capture/hover/wheel must not alter either original document')
  assert.equal(win.contentView.children[win.contentView.children.indexOf(page) + 1], shield)
  assert.equal(claimedIsolation, 'isolated', 'The actual native shield must be admitted')
  assert.notEqual(shield, page)
  await focusPrivateWindow()
  await win.webContents.executeJavaScript('document.querySelector("input").focus()')
  win.webContents.focus()
  await waitFor(() => webContents.getFocusedWebContents() === win.webContents, 'original unrelated Composer focus')
  let lateNativeKeyObserved = false
  const lateKey = () => { lateNativeKeyObserved = true }
  contents.on('before-input-event', lateKey)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'a' })
  await pause(80)
  contents.off('before-input-event', lateKey)
  assert.equal(lateNativeKeyObserved, true, 'The late original-page key must reach the actual native pre-dispatch boundary')
  assert.equal(webContents.getFocusedWebContents(), win.webContents, 'A late key on the old page must not steal the Composer focus')
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("input").value'), 'unsent draft')
  assert.deepEqual(inputEffects(await observe()), inputEffects(before), 'The late original-page key must not alter its webpage')
  receipt.cases.push({ name: 'late-native-key-preserves-original-composer', passed: true })
  assert.equal((await manager.activatePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId, {
    kind: 'prepare-first-press', navigationId: initial.navigationId, captureId: capture.captureId, down, button: 'left', clickCount: 1, modifiers: []
  })).outcome, 'input-unconfirmed', 'A projected click is blocked during Agent ownership')
  await waitFor(() => { if (!win.isFocused()) { win.focus(); return false }; contents.focus(); return webContents.getFocusedWebContents() === shield.webContents }, 'native page focus yields to its own shield')
  for (const input of [{ type: 'keyDown', keyCode: 'a' }, { type: 'char', keyCode: 'a' }, { type: 'keyUp', keyCode: 'a' }]) shield.webContents.sendInputEvent(input as any)
  shield.webContents.insertText('manual native text'); shield.webContents.paste()
  shield.webContents.debugger.attach()
  let ime: string | null = null
  try { await shield.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 }) } catch (error) { ime = String(error) }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await shield.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 20, y: 20, data: { items: [{ mimeType: 'text/plain', data: 'manual drop' }], dragOperationsMask: 1 } })
  shield.webContents.debugger.detach(); await pause(80)
  assert.deepEqual(inputEffects(await observe()), inputEffects(before), 'Native keyboard/IME/edit/drop must not alter the original page')
  for (const change of [() => manager.navigate('page', url + '?manual'), () => manager.back('page'), () => manager.forward('page'), () => manager.reload('page'), () => manager.switchProfile('page', 'other'), () => manager.setViewport('page', 'responsive'), () => manager.selectElement('page'), () => manager.openDevTools('page')]) {
    await assert.rejects(async () => await change(), (error: any) => error.code === 'BROWSER_AGENT_CONTROL_ACTIVE')
  }
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
  const discovered: any = await client.call('browser.targets', {})
  const inspected: any = await client.call('browser.inspect', { operationId: 'native-held' })
  assert.deepEqual(discovered.targets[0].control, inspected.runOperation.control)
  const targets = await cli(['browser', 'targets']), inspect = await cli(['browser', 'inspect', '--operation-id', 'native-held'])
  assert.equal(targets.code, 0); assert.equal(inspect.code, 0)
  assert.equal(JSON.parse(inspect.stdout).result.runOperation.control.inputIsolation, 'isolated')
  receipt.cases.push({ name: 'active-native-isolation-and-public-consumers', passed: true, imeRefusalOnNoneditableShield: ime, control: inspected.runOperation.control })
  // Agent's protocol input still addresses the original page under the child shield.
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: drag.x / contents.getZoomFactor(), y: drag.y / contents.getZoomFactor() })
  await contents.executeJavaScript('releaseProgram()')
  assert.equal((await running).code, 0)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'inactive')
  assert.equal(win.contentView.children.includes(shield), false, 'Normal completion releases its native input surface')
  await chrome.update([])
  const beforeFirstPress = await observe()
  await focusPrivateWindow()
  assert.equal(prepared.outcome, 'prepared')
  const committed = await nativeSource(() => manager.activatePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId, {
    kind: 'commit-first-press', inputScopeId: (prepared as any).inputScopeId, up: down, modifiers: []
  }))
  assert.deepEqual(await observe(), beforeFirstPress, 'Final first-press qualification: an old control generation must never dispatch page input')
  assert.equal(committed.outcome, 'input-unconfirmed')
  receipt.cases.push({ name: 'real-media-first-press-rechecks-control-generation', passed: true, committed })
  const crossing = await manager.activatePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId, {
    kind: 'prepare-first-press', navigationId: initial.navigationId, captureId: capture.captureId, down, button: 'left', clickCount: 1, modifiers: []
  })
  assert.equal(crossing.outcome, 'prepared')
  let changedDuringPress = false
  const changeControl = (_event: any, input: any) => {
    if (input.type !== 'mouseDown') return
    changedDuringPress = true
    // The trusted owner changes generation while the actual native down is being
    // submitted. It does not cancel or invent acknowledgement of that down.
    manager.returnControl('page')
  }
  contents.on('before-mouse-event', changeControl)
  const beforeCrossing = await observe()
  const crossed = await nativeSource(() => manager.activatePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId, {
    kind: 'commit-first-press', inputScopeId: (crossing as any).inputScopeId, up: down, modifiers: []
  }))
  contents.off('before-mouse-event', changeControl)
  await pause(80)
  assert.equal(changedDuringPress, true, 'A real native down reaches the original boundary before control changes')
  assert.equal(crossed.outcome, 'input-unconfirmed')
  const afterCrossing = await observe(), eventCount = (state: any, type: string) => state.events.filter((event: any) => event.type === type).length
  assert.equal(eventCount(afterCrossing, 'pointerdown'), eventCount(beforeCrossing, 'pointerdown') + 1)
  assert.equal(eventCount(afterCrossing, 'pointerup'), eventCount(beforeCrossing, 'pointerup'), 'Cross-generation first press must not submit its remaining up')
  assert.equal(afterCrossing.clicks, beforeCrossing.clicks)
  assert.equal((crossed as any).inputDispatch, 'press-sent', 'The receipt preserves the already submitted down')
  // Explicitly release only this fixture's submitted down, outside the consumed
  // one-shot gesture. The product never replays or synthesizes this cleanup.
  nativeSource(() => contents.sendInputEvent({ type: 'mouseUp', ...action, button: 'left', clickCount: 1 }))
  await pause(80)
  receipt.cases.push({ name: 'native-down-control-generation-change-preserves-partial-fact', passed: true, crossed })
  const agentCode = `for (const type of ['mousePressed','mouseReleased']) await cdp('Input.dispatchMouseEvent',{type,x:${action.x / contents.getZoomFactor()},y:${action.y / contents.getZoomFactor()},button:'left',clickCount:1}); await js('document.querySelector("#text").focus()'); await cdp('Input.insertText',{text:'agent text'}); return 'agent-done'`
  const beforeAgent = (await observe()).clicks
  const agent = await cli(['browser', 'run', '--browser', 'page', '--operation-id', 'agent-cdp'], agentCode)
  assert.equal(agent.code, 0, agent.stderr); assert.equal((await observe()).text, 'agent text'); assert.equal((await observe()).clicks, beforeAgent + 1)
  const beforeNormal = (await observe()).clicks; await clickHuman(action); assert.equal((await observe()).clicks, beforeNormal + 1)
  receipt.cases.push({ name: 'agent-cdp-continues-and-normal-completion-unlocks', passed: true })
  const attachChild = win.contentView.addChildView.bind(win.contentView)
  win.contentView.addChildView = () => { throw new Error('Private native admission fault') }
  const unisolated = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-admission-fault'], 'await js("new Promise(resolve => globalThis.releaseUnisolated = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof releaseUnisolated === "function"'), 'healthy program after exact native admission failure')
  win.contentView.addChildView = attachChild
  assert.equal(manager.nativeOwner('page')?.view, page)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  assert.equal(manager.nativeOwner('page')?.inputShield, undefined)
  assert.match((await manager.getOperation('native-admission-fault'))!.warning!, /isolation is unconfirmed/)
  await contents.executeJavaScript('releaseUnisolated()')
  assert.equal((await unisolated).code, 0, 'A native observation failure must not close a healthy Browser or fail its Agent program')
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'inactive')
  receipt.cases.push({ name: 'native-admission-failure-retains-health-with-service-window', passed: true })
  const syncFault = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-sync-fault'], 'await js("new Promise(resolve => globalThis.releaseSyncFault = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof releaseSyncFault === "function"'), 'healthy program before exact native synchronization failure')
  const failedSurface = manager.nativeOwner('page')!.inputShield!
  failedSurface.setBounds = () => { throw new Error('Private native geometry fault') }
  const originalBounds = page.getBounds()
  manager.setBounds('page', { ...originalBounds, x: originalBounds.x + 1 })
  assert.equal(manager.nativeOwner('page')?.view, page)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  assert.equal(win.contentView.children.includes(failedSurface), false)
  assert.match((await manager.getOperation('native-sync-fault'))!.warning!, /isolation is unconfirmed/)
  manager.setBounds('page', originalBounds)
  await contents.executeJavaScript('releaseSyncFault()')
  assert.equal((await syncFault).code, 0, 'A native synchronization fault must preserve the healthy original program')
  receipt.cases.push({ name: 'native-synchronization-failure-retains-health-with-service-window', passed: true })
  const focusFault = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-focus-fault'], 'await js("new Promise(resolve => globalThis.releaseFocusFault = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof releaseFocusFault === "function"'), 'healthy program before native focus failure')
  await focusPrivateWindow()
  win.webContents.focus()
  await waitFor(() => webContents.getFocusedWebContents() === win.webContents, 'unrelated Renderer focus before native failure')
  manager.nativeOwner('page')!.inputShield!.webContents.focus = () => { throw new Error('Private native focus fault') }
  const sendProjection = win.webContents.send.bind(win.webContents)
  let projectionFailures = 0
  win.webContents.send = (channel, ...args) => {
    if (channel === 'agentmux:browser-event' && !projectionFailures) { ++projectionFailures; throw new Error('Private notification fault') }
    sendProjection(channel, ...args)
  }
  contents.focus()
  await waitFor(() => manager.targets()[0]!.control!.inputIsolation === 'unconfirmed', 'retained native failure despite notification failure')
  assert.equal(projectionFailures, 1)
  assert.match((await manager.getOperation('native-focus-fault'))!.warning!, /isolation is unconfirmed/)
  win.webContents.send = sendProjection
  await contents.executeJavaScript('releaseFocusFault()')
  assert.equal((await focusFault).code, 0, 'Native focus and notification failures cannot end the healthy original program')
  receipt.cases.push({ name: 'native-focus-and-notification-failure-retains-health', passed: true })
  const retiring = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-cleanup-fault'], 'await js("new Promise(resolve => globalThis.releaseCleanupFault = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof releaseCleanupFault === "function"'), 'program before native cleanup failure')
  const retainedSurface = manager.nativeOwner('page')!.inputShield!, retainedContents = retainedSurface.webContents
  const removeSurface = win.contentView.removeChildView.bind(win.contentView), closeSurface = retainedContents.close.bind(retainedContents)
  win.contentView.removeChildView = view => { if (view === retainedSurface) throw new Error('Private native removal fault'); removeSurface(view) }
  retainedContents.close = () => { throw new Error('Private native close fault') }
  await contents.executeJavaScript('releaseCleanupFault()'); assert.equal((await retiring).code, 0)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  const afterCleanup = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-cleanup-retry'], 'await js("new Promise(resolve => globalThis.releaseAfterCleanupFault = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof releaseAfterCleanupFault === "function"'), 'healthy fresh program while exact cleanup is still unavailable')
  const sameSurface = manager.nativeOwner('page')!.inputShield === retainedSurface
  win.contentView.removeChildView = removeSurface; retainedContents.close = closeSurface
  await contents.executeJavaScript('releaseAfterCleanupFault()'); assert.equal((await afterCleanup).code, 0)
  const beforeReleasedClick = (await observe()).clicks
  await sendWindowMouse(0, action); await sendWindowMouse(1, action); await sendWindowMouse(2, action)
  receipt.cleanupReference = { sameSurface, childStillAttached: win.contentView.children.includes(retainedSurface), surfaceDestroyed: retainedContents.isDestroyed(), beforeReleasedClick, after: await observe() }
  await waitFor(async () => (await observe()).clicks === beforeReleasedClick + 1, 'Retired native surface must not outlive its only cleanup reference and intercept normal page input')
  assert.equal(sameSurface, true, 'An unconfirmed retired surface retains its original cleanup identity')
  receipt.cases.push({ name: 'native-cleanup-failure-retains-reference-across-fresh-program', passed: true })
  const pending = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'gui-takeover'], 'await js("proof.inFlightStarted++; new Promise(resolve => globalThis.finishInFlight = () => { proof.inFlightFinished++; resolve() })"); await js("proof.next++")')
  await waitFor(() => contents.executeJavaScript('typeof finishInFlight === "function"'), 'held in-flight operation')
  async function clickUi(label: string, trigger = false) {
    await focusPrivateWindow()
    if (trigger && await win.webContents.executeJavaScript('!!document.querySelector("[role=menu]")')) return
    const p: any = await waitFor(() => win.webContents.executeJavaScript(`(()=>{const n=${trigger ? 'document.querySelector(".browser-operation-status__trigger")' : `[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`};if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`), label)
    for (const type of ['mouseDown', 'mouseUp'] as const) nativeSource(() => win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 }))
    await pause(80)
  }
  await clickUi('', true); await clickUi('Take control')
  assert.equal((await pending).code, 0)
  assert.equal(manager.targets()[0]!.control!.owner, 'human'); assert.equal(manager.nativeOwner('page')?.inputShield, undefined)
  await contents.executeJavaScript('finishInFlight()'); await pause(100)
  assert.equal((await observe()).inFlightFinished, 1, 'Stop must not claim to undo dispatched Chromium work')
  assert.equal((await observe()).next, 0, 'Stop fence: no later tool action may dispatch')
  const refused = await cli(['browser', 'run', '--browser', 'page', '--operation-id', 'human-refused'], 'return 1')
  assert.notEqual(refused.code, 0); assert.match(refused.stdout + refused.stderr, /BROWSER_HUMAN_CONTROL_ACTIVE/)
  await clickUi('', true); await clickUi('Return to Agent')
  assert.equal(manager.targets()[0]!.control!.owner, 'human'); assert.equal((await observe()).next, 0, 'Human Return never replays a stopped program')
  // Delay only the acknowledgement of a real successful DOM.resolveNode. Stop
  // and that original pending dispatch race while the real debugger is attached.
  const originalCommand = contents.debugger.sendCommand.bind(contents.debugger)
  let heldNode = false
  contents.debugger.sendCommand = async (method: string, params?: any, sessionId?: string) => {
    const response = await originalCommand(method, params, sessionId)
    if (!heldNode && method === 'DOM.resolveNode' && !params?.objectGroup?.startsWith('feedback-')) {
      heldNode = true
      await new Promise<void>(resolve => { dispatchGateRelease = resolve })
    }
    return response
  }
  const beforeFence = (await observe()).clicks
  const fenced = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-dispatch-fence'], 'const s=await snapshot(); await click(s.nodes.find(n=>n.role==="button" && n.name==="Main action").ref)')
  await waitFor(() => !!dispatchGateRelease, 'actual resolved target before action dispatch')
  const fenceStop = await cli(['browser', 'stop', '--operation-id', 'native-dispatch-fence'])
  assert.equal(fenceStop.code, 0)
  assert.equal((await fenced).code, 0)
  await pause(150)
  assert.equal((await observe()).clicks, beforeFence, 'Stop fence: resolved pending action must not reach the real page after takeover')
  contents.debugger.sendCommand = originalCommand
  dispatchGateRelease = undefined
  await clickUi('', true); await clickUi('Return to Agent')
  receipt.cases.push({ name: 'real-resolved-target-stop-race', passed: true, heldSuccessfulNativeResolution: heldNode })
  const stop = await cli(['browser', 'stop', '--operation-id', 'gui-takeover'])
  assert.equal(stop.code, 0); assert.equal(JSON.parse(stop.stdout).result.runOperation.phase, 'stopped')
  assert.equal((await client.call('browser.inspect', { operationId: 'unobserved-id' }) as any).runOperation, null)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'inactive', 'Unknown operation cannot invent a lock')
  await win.webContents.executeJavaScript('proofStream.getTracks().forEach(track=>track.stop())')
  manager.removePresentation(win.webContents, win.webContents.mainFrame, lease.leaseId)
  receipt.cases.push({ name: 'actual-gui-takeover-return-and-stop-fence', passed: true })
  chrome.dispose()
  manager.setBounds('page', null)
  manager.setBounds('page', originalBounds)
  let partiallyAdmitted: WebContentsView | undefined, closePartiallyAdmitted: (() => void) | undefined
  const addPartial = win.contentView.addChildView.bind(win.contentView), removePartial = win.contentView.removeChildView.bind(win.contentView)
  win.contentView.addChildView = (view, index) => {
    addPartial(view, index)
    partiallyAdmitted = view as WebContentsView
    closePartiallyAdmitted = partiallyAdmitted.webContents.close.bind(partiallyAdmitted.webContents)
    partiallyAdmitted.setVisible = () => { throw new Error('Private partial native preparation fault') }
    partiallyAdmitted.webContents.close = () => { throw new Error('Private partial native close fault') }
  }
  win.contentView.removeChildView = view => { if (view === partiallyAdmitted) throw new Error('Private partial native detach fault'); removePartial(view) }
  const partialProgram = await cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-partial-admission'], 'return await js("++proof.next")')
  assert.equal(partialProgram.code, 0, 'Partial native preparation failure cannot close a healthy Agent program')
  assert.equal(manager.nativeOwner('page')?.inputShield, partiallyAdmitted, 'Native initialization failure must retain its published cleanup identity')
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  assert.ok(win.contentView.children.includes(partiallyAdmitted!))
  win.contentView.addChildView = addPartial; win.contentView.removeChildView = removePartial
  partiallyAdmitted!.webContents.close = closePartiallyAdmitted!
  manager.returnControl('page')
  assert.equal(win.contentView.children.includes(partiallyAdmitted!), false)
  await waitFor(() => manager.targets()[0]!.control!.inputIsolation === 'inactive', 'original partial-admission surface destruction confirmation')
  receipt.cases.push({ name: 'partially-admitted-native-surface-retains-owner-before-fallible-setup', passed: true })

  const pendingClose = cli(['browser', 'run', '--browser', 'page', '--operation-id', 'native-close-unconfirmed'], 'await js("new Promise(resolve => globalThis.finishPendingClose = resolve)"); return "healthy"')
  await waitFor(() => contents.executeJavaScript('typeof finishPendingClose === "function"'), 'program before native close acknowledgement')
  const pendingSurface = manager.nativeOwner('page')!.inputShield!, pendingContents = pendingSurface.webContents
  const closePending = pendingContents.close.bind(pendingContents)
  let closeRequests = 0
  pendingContents.close = () => { ++closeRequests }
  await contents.executeJavaScript('finishPendingClose()'); assert.equal((await pendingClose).code, 0)
  assert.equal(manager.nativeOwner('page')?.inputShield, pendingSurface, 'A close return cannot sign off an undestroyed native input surface')
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  assert.ok(resourceTargets()[0]?.resource?.processes?.some(process => process.pid === pendingContents.getOSProcessId()))
  manager.returnControl('page')
  assert.equal(closeRequests, 1, 'Cleanup observation cannot automatically resend a close awaiting native destruction')
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'unconfirmed')
  // Complete this fixture's exact native fault source; product retries only observe
  // the original close until the cached WebContents confirms destruction.
  closePending()
  await waitFor(() => pendingContents.isDestroyed(), 'original native destruction completion')
  manager.returnControl('page')
  assert.equal(manager.nativeOwner('page')?.inputShield, undefined)
  assert.equal(manager.targets()[0]!.control!.inputIsolation, 'inactive')
  receipt.cases.push({ name: 'native-close-return-retains-reference-until-real-destruction', passed: true })
  manager.setBounds('page', null)
  await manager.create('retired-page', url, 'workspace')
  manager.setBounds('retired-page', originalBounds)
  const retiredPage = manager.nativeOwner('retired-page')!.view, retiredPageContents = retiredPage.webContents
  await waitFor(() => retiredPageContents.executeJavaScript('!!globalThis.proof'), 'second original page')
  const borrowed = new BrowserWindow({ width: 900, height: 780, show: false })
  manager.setPresentationWindowOwner(() => borrowed)
  const borrowedLease = manager.registerPresentation(win.webContents, win.webContents.mainFrame, {
    browserId: 'retired-page', occurrence: { presentationId: 'borrowed-page', location: {
      displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'borrowed-region' } },
    geometry: { visible: true, bounds: originalBounds }
  })
  await manager.activatePresentation(win.webContents, win.webContents.mainFrame, borrowedLease.leaseId, { kind: 'select', focus: 'preserve' })
  const moving = cli(['browser', 'run', '--browser', 'retired-page', '--operation-id', 'native-host-return'], 'await js("new Promise(resolve => globalThis.finishMoving = resolve)"); return "healthy"')
  await waitFor(() => retiredPageContents.executeJavaScript('typeof finishMoving === "function"'), 'program on borrowed native host')
  const movingShield = manager.nativeOwner('retired-page')!.inputShield!
  assert.ok(borrowed.contentView.children.includes(movingShield))
  await manager.returnWindow(borrowed)
  assert.equal(manager.windowForView(retiredPage), win)
  assert.equal(win.contentView.children.indexOf(movingShield), win.contentView.children.indexOf(retiredPage) + 1)
  assert.equal(movingShield.getVisible(), false, 'Returning a borrowed shell hides its original page and exact input shield together')
  assert.equal(retiredPage.getVisible(), false)
  borrowed.destroy()
  await retiredPageContents.executeJavaScript('finishMoving()'); assert.equal((await moving).code, 0)
  manager.setPresentationWindowOwner(() => win)
  manager.setBounds('retired-page', originalBounds)
  receipt.cases.push({ name: 'active-native-page-and-shield-return-from-borrowed-shell', passed: true })

  const destroyedRun = cli(['browser', 'run', '--browser', 'retired-page', '--operation-id', 'native-source-destroyed'], 'await js("new Promise(resolve => globalThis.holdRetiredPage = resolve)")')
  await waitFor(() => retiredPageContents.executeJavaScript('typeof holdRetiredPage === "function"'), 'program before source destruction')
  const orphanCandidate = manager.nativeOwner('retired-page')!.inputShield!, orphanContents = orphanCandidate.webContents
  const orphanPid = orphanContents.getOSProcessId()
  const removeRetired = win.contentView.removeChildView.bind(win.contentView), closeRetired = orphanContents.close.bind(orphanContents)
  win.contentView.removeChildView = view => { if (view === orphanCandidate) throw new Error('Private retired native removal fault'); removeRetired(view) }
  orphanContents.close = () => { throw new Error('Private retired native close fault') }
  retiredPageContents.close()
  await waitFor(() => retiredPageContents.isDestroyed(), 'original page destroyed independently of its sibling')
  await destroyedRun
  const releasedResources = resourceTargets().find(target => target.id === 'retired-page')
  await manager.restore('retired-page')
  manager.setBounds('retired-page', originalBounds)
  const restoredPage = manager.nativeOwner('retired-page')!.view, restoredContents = restoredPage.webContents
  await waitFor(() => restoredContents.executeJavaScript('!!globalThis.proof'), 'healthy same-id restored page')
  const transferredSurface = manager.nativeOwner('retired-page')?.inputShield === orphanCandidate
  const restoredRun = await cli(['browser', 'run', '--browser', 'retired-page', '--operation-id', 'native-restored-healthy'], 'return await js("++proof.next")')
  assert.equal(restoredRun.code, 0, 'Cleanup observation failure cannot close a healthy restored Browser')
  win.contentView.removeChildView = removeRetired; orphanContents.close = closeRetired
  manager.returnControl('retired-page')
  const restoredPoint = await restoredContents.executeJavaScript('(()=>{const r=document.querySelector("#action").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
  const restoredBounds = restoredPage.getBounds()
  await focusPrivateWindow()
  for (const kind of [0, 1, 2]) {
    nativeSource(() => nativeWindowInput.send(win.getNativeWindowHandle(), kind, restoredBounds.x + restoredPoint.x * restoredContents.getZoomFactor(), restoredBounds.y + restoredPoint.y * restoredContents.getZoomFactor()))
    await pause(80)
  }
  await waitFor(() => restoredContents.executeJavaScript('proof.clicks === 1'), 'Destroyed page must not orphan its native input surface and intercept restored page input')
  assert.equal(transferredSurface, true, 'Destroyed page must retain its native cleanup owner through restoration')
  assert.equal(releasedResources?.resource?.state, 'unknown', 'Page destruction cannot sign off a retained sibling resource')
  assert.equal(releasedResources?.resource?.retention?.status, 'unknown')
  assert.ok(releasedResources?.resource?.processes?.some(process => process.pid === orphanPid) ?? false)
  const publicResources = await client.call('browser.targets', {}) as any
  assert.equal(publicResources.coverage, 'complete')
  assert.equal(publicResources.targets.find((target: any) => target.id === 'retired-page').control.inputIsolation, 'inactive')
  receipt.destroyedCleanupReference = { releasedResources, transferredSurface, restoredPageId: restoredContents.id,
    orphanStillAttached: win.contentView.children.includes(orphanCandidate), orphanDestroyed: orphanContents.isDestroyed() }
  receipt.cases.push({ name: 'destroyed-source-retains-native-cleanup-owner-through-healthy-restore', passed: true })

  const closingRun = cli(['browser', 'run', '--browser', 'retired-page', '--operation-id', 'native-explicit-close'], 'await js("new Promise(resolve => globalThis.holdClosedPage = resolve)")')
  await waitFor(() => restoredContents.executeJavaScript('typeof holdClosedPage === "function"'), 'program before explicit Close')
  const closedSurface = manager.nativeOwner('retired-page')!.inputShield!, closedContents = closedSurface.webContents
  const removeClosed = win.contentView.removeChildView.bind(win.contentView), closeClosed = closedContents.close.bind(closedContents)
  win.contentView.removeChildView = view => { if (view === closedSurface) throw new Error('Private closed native removal fault'); removeClosed(view) }
  closedContents.close = () => { throw new Error('Private closed native close fault') }
  await manager.close('retired-page'); await closingRun
  await assert.rejects(manager.restore('retired-page'), /closed explicitly/, 'Only explicit Close retires restoration of this original page')
  assert.equal(resourceTargets().find(target => target.id === 'retired-page')?.resource?.state, 'unknown')
  win.contentView.removeChildView = removeClosed; closedContents.close = closeClosed
  await manager.close('retired-page')
  await waitFor(() => !resourceTargets().some(target => target.id === 'retired-page'), 'explicitly closed native cleanup receives its real destruction confirmation')
  assert.equal(contents.isDestroyed(), false, 'Another original healthy Browser remains available')
  assert.ok(manager.targets().some(target => target.id === 'page'))
  receipt.cases.push({ name: 'explicit-close-retains-cleanup-only-without-reviving-page', passed: true })
  await client.dispose()
  receipt.passed = true
}
void run().catch(async error => { receipt.failure = { message: error.message, stack: error.stack }; console.error('native-proof:failure', error); await saveReceipt() }).finally(async () => {
  const failures: string[] = []
  for (const close of [async () => { for (const target of manager?.targets() ?? []) { if (target.control?.activeOperationId) await manager.stopOperationById(target.control.activeOperationId) }; await pause(100) },
    () => control?.stop(), () => chrome?.dispose(), () => manager?.dispose(), () => { if (win && !win.isDestroyed()) win.destroy() }, () => { if (!server) return; server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }]) {
    try { await close() } catch (error) { failures.push(String(error)) }
  }
  receipt.cleanupFailures = failures
  await saveReceipt()
  app.exit(receipt.passed && failures.length === 0 ? 0 : 1)
})
