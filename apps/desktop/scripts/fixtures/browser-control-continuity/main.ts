import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, type WebContents, type WebContentsView } from 'electron'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ConfigOwner } from '../../../src/main/config-owner'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { resolveBrowserAgentControl } from '../../../src/shared/browser-agent-control'

const privateRoot = process.env.AGENTMUX_CONTINUITY_PRIVATE!, output = process.env.AGENTMUX_CONTINUITY_OUTPUT!
assert.ok(privateRoot && output, 'The native scene requires its own explicit private namespace')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const receipt: any = { schema: 'agentmux.browser-control-continuity.native.v1', passed: false, pid: process.pid,
  versions: process.versions, cases: [], checkpoints: [], preferenceChanges: [], nativeEvents: [], inputDelivery: [], compositorFrames: [], cleanup: [],
  boundary: 'Actual BVM/runScript/child worker/CDP and exact native input shield. Original layer PNGs verify the stable normal rim, not webpage halo blending, a composed OS window, passive mirrors, physical input or installation. No user Browser, Agent, Runtime or clipboard.' }
let window: BrowserWindow | undefined, manager: BrowserViewManager | undefined, unsubscribe: (() => void) | undefined
let heldResponse: ServerResponse | undefined, requestedNavigation!: () => void
const navigationRequested = new Promise<void>(resolve => { requestedNavigation = resolve })
const programs: Array<Promise<unknown>> = [], subscriptions = new Set<WebContents>()
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until<T>(name: string, read: () => Promise<T | false> | T | false, budget = 6000): Promise<T> {
  const deadline = performance.now() + budget
  while (performance.now() < deadline) { const result = await read(); if (result !== false) return result; await delay(15) }
  throw new Error('Native scene prerequisite was not observed: ' + name)
}
const html = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;min-height:100%;background:#edf3ef;color:#1a2920;font:16px system-ui}main{padding:48px}button{font:inherit;padding:12px}</style><main><h1>${title}</h1><p>Original native page stays available.</p></main>`
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  if (request.url === '/next') { heldResponse = response; requestedNavigation(); return }
  response.end(html('Original live document'))
})
const boundaryExpression = `(()=>{const element=document.querySelector('[data-browser-control-boundary]'),style=element&&getComputedStyle(element),rect=element?.getBoundingClientRect();
return{timeOrigin:performance.timeOrigin,url:location.href,visibilityState:document.visibilityState,viewport:{width:innerWidth,height:innerHeight},
boundary:element?{connected:element.isConnected,display:style.display,visibility:style.visibility,opacity:style.opacity,boxShadow:style.boxShadow,borderTop:style.borderTop,borderRight:style.borderRight,borderBottom:style.borderBottom,borderLeft:style.borderLeft,
rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}:null}})()`
function paintedEdges(image: Electron.NativeImage) {
  const pixels = image.toBitmap(), { width, height } = image.getSize()
  assert.equal(pixels.length, width * height * 4, 'Original native bitmap dimensions are unambiguous')
  const rgba = (x: number, y: number) => { const i = (y * width + x) * 4; return [pixels[i + 2]!, pixels[i + 1]!, pixels[i]!, pixels[i + 3]!] }
  const near = Math.min(4, Math.floor(Math.min(width, height) / 2))
  return { top: Array.from({ length: near }, (_, i) => rgba(Math.floor(width / 2), i)),
    bottom: Array.from({ length: near }, (_, i) => rgba(Math.floor(width / 2), height - 1 - i)),
    left: Array.from({ length: near }, (_, i) => rgba(i, Math.floor(height / 2))),
    right: Array.from({ length: near }, (_, i) => rgba(width - 1 - i, Math.floor(height / 2))),
    center: rgba(Math.floor(width / 2), Math.floor(height / 2)) }
}
const green = (pixel: number[]) => pixel[3]! > 24 && pixel[1]! > pixel[0]! + 24 && pixel[1]! > pixel[2]! + 12
async function shieldFrame(shield: WebContents, painted: boolean) {
  let image!: Electron.NativeImage
  for (let attempt = 0; attempt < 15; attempt++) {
    image = await shield.capturePage(undefined, { stayHidden: true, stayAwake: false })
    const samples = paintedEdges(image), edges = Object.entries(samples).filter(([edge]) => edge !== 'center')
    if (edges.every(([, values]) => painted ? values.some(green) : values.every(pixel => pixel[3]! < 12))) break
    await delay(25)
  }
  return image
}
async function persist(stage: string) { receipt.stage = stage; await writeFile(join(output, 'native.json'), JSON.stringify(receipt, null, 2) + '\n') }
async function rimCheckpoint(name: string, source: WebContentsView, shield: WebContentsView, operationId: string | null,
  original: { sourceId: number; shieldId: number; shieldToken: string; shieldTimeOrigin?: number }) {
  const control = manager!.target('original')!.control
  assert.equal(control?.owner, 'agent', 'The original operation retains native input ownership: ' + name)
  assert.equal(control.activeOperationId, operationId, 'Execution identity is independent of retained Browser control: ' + name)
  assert.equal(control.inputIsolation, 'isolated', 'Rim display does not replace actual native input isolation: ' + name)
  assert.equal(manager!.nativeOwner('original')!.view, source)
  assert.equal(manager!.nativeOwner('original')!.inputShield, shield, 'Navigation preserves the same original native shield')
  assert.equal(source.webContents.id, original.sourceId); assert.equal(shield.webContents.id, original.shieldId)
  assert.equal(shield.webContents.mainFrame.frameToken, original.shieldToken, 'Website navigation must not replace the original shield document')
  const children = window!.contentView.children
  assert.equal(children.indexOf(shield), children.indexOf(source) + 1)
  assert.deepEqual(shield.getBounds(), source.getBounds(), 'Stable boundary follows the original native page bounds')
  const facts = await shield.webContents.executeJavaScript(boundaryExpression)
  original.shieldTimeOrigin ??= facts.timeOrigin
  assert.equal(facts.timeOrigin, original.shieldTimeOrigin)
  const image = await shieldFrame(shield.webContents, true)
  assert.equal(image.isEmpty(), false, 'Original native shield produces compositor pixels')
  const file = name + '-shield.png', bytes = image.toPNG(), samples = paintedEdges(image)
  await writeFile(join(output, file), bytes)
  const row = { name, operationId, sourceId: source.webContents.id, shieldId: shield.webContents.id,
    nativeWindow: { id: window!.id, mediaSourceId: window!.getMediaSourceId(), visible: window!.isVisible(), focused: window!.isFocused(), minimized: window!.isMinimized() },
    sourceBounds: source.getBounds(), shieldBounds: shield.getBounds(), shieldVisible: shield.getVisible(), control,
    facts, file, sha256: sha(bytes), pixels: image.getSize(), samples,
    boundary: 'Unmodified exact shield WebContents layer PNG. Transparent center and normal one-pixel rim only; this is not a native-window composite or halo blend proof.' }
  receipt.checkpoints.push(row)
  await persist('rim-' + name)
  assert.ok(facts.boundary?.connected, 'Original native rim remains connected: ' + name)
  for (const [edge, values] of Object.entries(samples)) if (edge !== 'center') {
    assert.ok((values as number[][]).some(green), 'Actual native shield paints all four stable rim edges: ' + name + ' ' + edge)
  }
  assert.ok(samples.center[3]! < 12, 'The native boundary keeps the original page center transparent')
  if (!source.webContents.isLoading()) {
    const glow = await source.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[data-agentmux-browser-control-feedback]'),s=e&&getComputedStyle(e);return e?{connected:e.isConnected,operationId:e.getAttribute('data-operation-id'),navigationId:e.getAttribute('data-navigation-id'),display:s.display,opacity:s.opacity,blend:s.mixBlendMode}:null})()`)
    assert.ok(glow?.connected, 'The actual native page retains its inner glow host: ' + name)
    const pageImage = await source.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false })
    const pageFile = name + '-page.png', pageBytes = pageImage.toPNG()
    await writeFile(join(output, pageFile), pageBytes)
    Object.assign(row, { glow, page: { file: pageFile, sha256: sha(pageBytes), pixels: pageImage.getSize(),
      boundary: 'Unmodified complete original page WebContents frame, including its actual page-blended inner glow; excludes the sibling shield, outer Renderer and OS window.' } })
    await persist('page-' + name)
  } else Object.assign(row, { page: { status: 'not-captured', reason: 'Held native navigation defers source JavaScript and capture; the independent original shield pixels above remain available.' } })
  if (name === 'navigation-in-flight') assert.ok(Object.entries(samples).filter(([edge]) => edge !== 'center').every(([, values]) => (values as number[][]).some(green)),
    'The same original operation keeps its rim during native navigation')
  return row
}
async function released(shield: WebContentsView, shieldContents: WebContents, source: WebContentsView, operationId: string, phase: string) {
  await until('original input shield destroyed after ' + phase, () => shieldContents.isDestroyed())
  assert.equal(window!.contentView.children.includes(shield), false)
  assert.equal(manager!.nativeOwner('original')!.inputShield, undefined, 'Explicit takeover releases the original rim/input surface')
  assert.equal(source.webContents.isDestroyed(), false, 'Releasing the rim preserves the original healthy webpage')
  assert.equal(manager!.target('original')!.control?.owner, 'human')
  receipt.cases.push({ name: phase, operationId, shieldDestroyed: true, originalPageAlive: true, passed: true })
}
async function ordinaryNativeInput(name: string, source: WebContentsView, shield: WebContentsView) {
  const control = manager!.target('original')!.control
  const expected = name === 'waiting' ? ['mousedown', 'wheel', 'keydown'] : ['mousedown']
  await source.webContents.executeJavaScript(`window.fixtureNativeInput=[];for(const type of ['mousedown','wheel','keydown'])addEventListener(type,e=>window.fixtureNativeInput.push({type:e.type,trusted:e.isTrusted}),{once:true})`)
  await shield.webContents.executeJavaScript(`window.fixtureNativeInput=[];for(const type of ['mousedown','wheel','keydown'])addEventListener(type,e=>window.fixtureNativeInput.push({type:e.type,trusted:e.isTrusted}),{once:true})`)
  // Select the target WebContents without activating the private native window.
  shield.webContents.focus()
  await shield.webContents.executeJavaScript('document.hasFocus()')
  shield.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
  shield.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
  if (name === 'waiting') {
    shield.webContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 20 })
    shield.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
    shield.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
  }
  const delivered = await until('exact shield receives native ' + expected.join('/') + ' ' + name, async () => {
    const events = await shield.webContents.executeJavaScript('window.fixtureNativeInput')
    return expected.every(type => events.some((event: any) => event.type === type)) ? events : false
  })
  assert.deepEqual(await source.webContents.executeJavaScript('window.fixtureNativeInput'), [], 'Ordinary input delivered to the shield does not reach the source page')
  assert.deepEqual(manager!.target('original')!.control, control, 'Ordinary native input does not take over or stop the current operation: ' + name)
  assert.equal(manager!.nativeOwner('original')!.inputShield, shield)
  receipt.inputDelivery.push({ name, expected, sourceId: source.webContents.id, shieldId: shield.webContents.id, delivered, control,
    boundary: 'Real Electron sendInputEvent into the exact native shield, with DOM delivery receipts and no source delivery. Native sibling order and bounds are checked separately. This does not certify OS coordinate routing or physical hardware input.' })
}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  assert.equal(app.getPath('home'), process.env.HOME)
  app.setActivationPolicy?.('accessory')
  const store = new ConfigStore(join(privateRoot, 'config.json'))
  let config = await store.save({ ...structuredClone(DEFAULT_CONFIG), browser: { ...DEFAULT_CONFIG.browser,
    agentControl: { ...resolveBrowserAgentControl(), glowEnabled: true, glowColor: '#22cc66', glowOpacity: 1, glowAnimation: 'none' } } })
  const configOwner = new ConfigOwner({ read: () => config, save: value => store.save(value), publish: value => { config = value } })
  window = new BrowserWindow({ width: 820, height: 620, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,<!doctype html><title>Private control continuity</title>')
  window.showInactive()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'private', resolvePartition: () => 'control-continuity-' + process.pid },
    new BrowserRefLedgerStore(join(privateRoot, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('External applications are outside this private scene') } },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => resolveBrowserAgentControl(configOwner.current.browser.agentControl))
  unsubscribe = configOwner.subscribe((saved, previous) => { if (JSON.stringify(saved.browser.agentControl) !== JSON.stringify(previous.browser.agentControl)) manager!.refreshAgentFeedback() })
  await manager.create('original', origin + '/original')
  manager.setBounds('original', { x: 12, y: 12, width: 780, height: 550 })
  const source = manager.nativeOwner('original')!.view, contents = source.webContents, sourceSession = contents.session
  await until('original local page ready', async () => !contents.isLoading() && await contents.executeJavaScript('Boolean(document.querySelector("h1"))'))
  const sourceId = contents.id, bounds = source.getBounds(), originalNavigation = manager.target('original')!.navigationId
  for (const event of ['did-start-navigation', 'dom-ready', 'did-navigate', 'did-stop-loading'] as const) contents.on(event as any, () => receipt.nativeEvents.push({ event, navigationId: manager!.target('original')?.navigationId,
    shieldId: manager!.nativeOwner('original')?.inputShield?.webContents.id ?? null, control: manager!.target('original')?.control }))
  const operator = { id: 'original-operator', name: 'Original Agent' }, operationId = 'native-continuity-original'
  const redraw = `(()=>{const head=document.createElement('head');const body=document.createElement('body');body.innerHTML='<main><h1>Replaced document contents</h1><p>Same document, same Browser.</p><button id="action" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Original action</button></main>';document.documentElement.replaceChildren(head,body);return true})()`
  let programFailure: unknown
  const running = manager.runScript('original', `await waitForElement('Continue to navigation',16000);await gotoUrl(${JSON.stringify(origin + '/next')});await waitForElement('Continue to redraw',16000);await js(${JSON.stringify(redraw)});await waitForElement('Finish original operation',16000);const s=await snapshot();const n=s.nodes.find(n=>n.name==='Original action');await click(n.ref);return await js('document.body.dataset.clicks')`, operator, undefined, operationId)
  programs.push(running); void running.catch(error => { programFailure = error })
  const waitPhase = () => until('original operation waiting', () => { if (programFailure) throw programFailure; return manager!.inputContext('original', 'local')?.activity?.phase === 'waiting' })
  await waitPhase()
  const shield = manager.nativeOwner('original')!.inputShield!
  assert.ok(shield, 'The real BVM owns a nonempty input shield')
  const shieldContents = shield.webContents
  const original: { sourceId: number; shieldId: number; shieldToken: string; shieldTimeOrigin?: number } = {
    sourceId, shieldId: shield.webContents.id, shieldToken: shield.webContents.mainFrame.frameToken }
  subscriptions.add(shield.webContents)
  shield.webContents.beginFrameSubscription(false, image => {
    if (!image.isEmpty() && receipt.compositorFrames.length < 40) receipt.compositorFrames.push({ shieldId: original.shieldId, pixels: image.getSize(), samples: paintedEdges(image),
      nativeNavigation: manager!.target('original')?.navigationId, activeOperationId: manager!.target('original')?.control?.activeOperationId })
  })
  receipt.cases.push({ name: 'original-program-started', passed: true, operationId, original, sourceBounds: bounds })
  await rimCheckpoint('waiting', source, shield, operationId, original)
  await ordinaryNativeInput('waiting', source, shield)
  manager.setBounds('original', null)
  assert.equal(source.getVisible(), false); assert.equal(shield.getVisible(), false)
  const saved = await configOwner.update(current => ({ ...current, browser: { ...current.browser,
    agentControl: { ...resolveBrowserAgentControl(current.browser.agentControl), glowEnabled: false, glowColor: '#cc7722' } } }))
  const hiddenAppearance = await shieldContents.executeJavaScript(boundaryExpression)
  assert.equal(hiddenAppearance.boundary?.opacity, '0', 'Saving disabled appearance updates the exact hidden active-run shield')
  assert.equal(hiddenAppearance.boundary?.connected, true)
  assert.equal(await shieldContents.executeJavaScript('getComputedStyle(document.querySelector("[data-browser-control-boundary]")).color'), 'rgb(204, 119, 34)',
    'Saving a color while hidden reaches the same native appearance owner')
  manager.setBounds('original', bounds)
  assert.equal(manager.nativeOwner('original')!.inputShield, shield, 'Returning to the Browser keeps its original run and shield')
  assert.equal(manager.target('original')!.control?.activeOperationId, operationId)
  assert.equal(shieldContents.mainFrame.frameToken, original.shieldToken)
  const restoredAppearance = await shieldContents.executeJavaScript(boundaryExpression)
  assert.equal(restoredAppearance.timeOrigin, original.shieldTimeOrigin)
  assert.equal(restoredAppearance.boundary?.opacity, '0', 'Returning to the Browser cannot revive its earlier enabled rim')
  const disabledImage = await shieldFrame(shieldContents, false)
  assert.equal(disabledImage.isEmpty(), false)
  const disabledSamples = paintedEdges(disabledImage), disabledBytes = disabledImage.toPNG()
  for (const [edge, values] of Object.entries(disabledSamples)) if (edge !== 'center') {
    assert.ok((values as number[][]).every(pixel => pixel[3]! < 12), 'Saved disabled appearance removes the native rim pixels: ' + edge)
  }
  await writeFile(join(output, 'saved-disabled-shield.png'), disabledBytes)
  receipt.preferenceChanges.push({ operationId, sourceId, shieldId: original.shieldId,
    saved: saved.browser.agentControl, hiddenAppearance, restoredAppearance, file: 'saved-disabled-shield.png', sha256: sha(disabledBytes), samples: disabledSamples })
  await configOwner.update(current => ({ ...current, browser: { ...current.browser,
    agentControl: { ...resolveBrowserAgentControl(current.browser.agentControl), glowEnabled: true, glowColor: '#22cc66' } } }))
  assert.equal((await shieldContents.executeJavaScript(boundaryExpression)).boundary?.opacity, '1', 'Explicitly enabling appearance updates the original run without replacing it')
  await contents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Continue to navigation</button>")')
  await Promise.race([navigationRequested, delay(6000).then(() => { throw new Error('Original program did not reach its actual navigation request') })])
  assert.equal(contents.isLoading(), true, 'The real native navigation is in progress before releasing its response')
  await rimCheckpoint('navigation-in-flight', source, shield, operationId, original)
  heldResponse!.end(html('Second live document')); heldResponse = undefined
  await until('new actual native document loaded', async () => !contents.isLoading() && contents.getURL() === origin + '/next')
  await waitPhase()
  assert.notEqual(manager.target('original')!.navigationId, originalNavigation)
  await rimCheckpoint('new-document', source, shield, operationId, original)
  const newDocument = await contents.executeJavaScript('performance.timeOrigin')
  await contents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Continue to redraw</button>")')
  await until('same-document root contents replaced by the real Agent script', async () => await contents.executeJavaScript('document.querySelector("h1")?.textContent === "Replaced document contents"'))
  await waitPhase()
  assert.equal(await contents.executeJavaScript('performance.timeOrigin'), newDocument, 'DOM replacement does not fabricate another native document')
  await rimCheckpoint('dom-replaced', source, shield, operationId, original)
  assert.equal(contents.session, sourceSession); assert.deepEqual(source.getBounds(), bounds)
  shield.webContents.endFrameSubscription(); subscriptions.delete(shield.webContents)
  receipt.cases.push({ name: 'same-owner-navigation-and-dom-replacement', passed: true, operationId, shieldId: original.shieldId })
  await contents.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<button>Finish original operation</button>")')
  const report = await running
  assert.equal(report.outcome.kind, 'completed'); assert.equal(report.result, '1', 'The real original program dispatches its resolved click once')
  await rimCheckpoint('completed-idle', source, shield, null, original)
  await ordinaryNativeInput('completed-idle', source, shield)
  receipt.cases.push({ name: 'completion-retains-control-and-original-shield', operationId, passed: true })
  const failureId = 'native-continuity-failure'
  const failed = await manager.runScript('original', 'throw new Error("Declared private program failure")', operator, undefined, failureId)
  assert.equal(failed.outcome.kind, 'script-failed')
  await rimCheckpoint('failed-idle', source, shield, null, original)
  receipt.cases.push({ name: 'failure-retains-control-and-original-shield', operationId: failureId, passed: true })
  const stopId = 'native-continuity-stop'
  const stoppedProgram = manager.runScript('original', 'await waitForElement("Never dispatched private target",16000);await js("document.body.dataset.late=\\"yes\\"")', operator, undefined, stopId)
  programs.push(stoppedProgram); void stoppedProgram.catch(() => {})
  await until('next actual operation waiting', () => manager!.inputContext('original', 'local')?.activity?.phase === 'waiting')
  await rimCheckpoint('next-run-waiting', source, shield, stopId, original)
  await manager.stopOperationById(stopId)
  assert.equal((await stoppedProgram).outcome.kind, 'stopped')
  await rimCheckpoint('stopped-idle', source, shield, null, original)
  await ordinaryNativeInput('stopped-idle', source, shield)
  receipt.cases.push({ name: 'next-run-reuses-shield-and-stop-retains-control', operationId: stopId, passed: true })
  const idleTaken = manager.takeControl('original')
  assert.equal(idleTaken.control?.owner, 'human')
  await released(shield, shieldContents, source, stopId, 'explicit-idle-takeover-releases-rim')
  const returned = manager.returnControl('original')
  assert.equal(returned.control?.owner, 'agent'); assert.equal(returned.control.activeOperationId, null)
  const newShield = await until('return prepares a new isolation surface without a program', () => {
    const owner = manager!.nativeOwner('original')!, control = manager!.target('original')!.control
    return owner.inputShield && control?.inputIsolation === 'isolated' ? owner.inputShield : false
  })
  assert.notEqual(newShield, shield)
  const newOriginal = { sourceId, shieldId: newShield.webContents.id, shieldToken: newShield.webContents.mainFrame.frameToken }
  const newShieldContents = newShield.webContents
  await rimCheckpoint('returned-idle', source, newShield, null, newOriginal)
  assert.equal(await contents.executeJavaScript('document.body.dataset.clicks'), '1')
  assert.equal(await contents.executeJavaScript('document.body.dataset.late??null'), null, 'Return does not replay the stopped program')
  receipt.cases.push({ name: 'return-reisolates-without-replay', passed: true })
  const activeId = 'native-continuity-active-takeover'
  const active = manager.runScript('original', 'await waitForElement("Never dispatched after return",16000);await js("document.body.dataset.late=\\"yes\\"")', operator, undefined, activeId)
  programs.push(active); void active.catch(() => {})
  await until('returned active operation waiting', () => manager!.inputContext('original', 'local')?.activity?.phase === 'waiting')
  await rimCheckpoint('active-takeover-waiting', source, newShield, activeId, newOriginal)
  assert.equal(manager.takeControl('original').control?.owner, 'human')
  assert.equal((await active).outcome.kind, 'stopped')
  await released(newShield, newShieldContents, source, activeId, 'explicit-active-takeover-releases-rim')
  manager.returnControl('original')
  const finalShield = await until('second return creates its new isolated surface', () => {
    const owner = manager!.nativeOwner('original')!, control = manager!.target('original')!.control
    return owner.inputShield && control?.inputIsolation === 'isolated' ? owner.inputShield : false
  })
  assert.notEqual(finalShield, newShield)
  assert.equal(await contents.executeJavaScript('document.body.dataset.late??null'), null)
  receipt.cases.push({ name: 'second-return-reisolates-without-replay', passed: true })
  const fresh = await manager.runScript('original', 'return await js("document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1)")', operator, undefined, 'native-continuity-fresh')
  assert.equal(fresh.outcome.kind, 'completed'); assert.equal(fresh.result, '2', 'Only the new explicit program adds a new effect')
  await rimCheckpoint('final-idle', source, finalShield, null, { sourceId, shieldId: finalShield.webContents.id, shieldToken: finalShield.webContents.mainFrame.frameToken })
  assert.equal(contents.id, sourceId); assert.equal(contents.session, sourceSession)
  assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'Replaced document contents')
  receipt.cases.push({ name: 'fresh-program-uses-returned-original-page', passed: true })
  assert.equal(receipt.checkpoints.length, 11)
  assert.equal(receipt.cases.length, 10)
  assert.equal(receipt.inputDelivery.length, 3)
  receipt.passed = true
}).catch(error => { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }).finally(async () => {
  for (const contents of subscriptions) { try { if (!contents.isDestroyed()) contents.endFrameSubscription() } catch (error) { receipt.cleanup.push(String(error)) } }
  if (heldResponse && !heldResponse.writableEnded) heldResponse.end(html('Private scene ended'))
  try { for (const target of manager?.targets() ?? []) if (target.control?.activeOperationId) await manager!.stopOperationById(target.control.activeOperationId) } catch (error) { receipt.cleanup.push(String(error)) }
  await Promise.allSettled(programs)
  for (const release of [() => unsubscribe?.(), () => manager?.dispose(), () => { if (window && !window.isDestroyed()) window.destroy() },
    async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }]) {
    try { await release() } catch (error) { receipt.cleanup.push(String(error)) }
  }
  receipt.cleanupComplete = !window || window.isDestroyed()
  await persist('complete')
  app.exit(receipt.passed && receipt.cleanupComplete && receipt.cleanup.length === 0 ? 0 : 1)
})
