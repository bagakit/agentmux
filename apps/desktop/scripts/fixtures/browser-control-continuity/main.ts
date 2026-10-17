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
  versions: process.versions, cases: [], checkpoints: [], preferenceChanges: [], nativeEvents: [], compositorFrames: [], cleanup: [],
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
async function persist(stage: string) { receipt.stage = stage; await writeFile(join(output, 'native.json'), JSON.stringify(receipt, null, 2) + '\n') }
async function rimCheckpoint(name: string, source: WebContentsView, shield: WebContentsView, operationId: string,
  original: { sourceId: number; shieldId: number; shieldToken: string; shieldTimeOrigin?: number }) {
  const control = manager!.target('original')!.control
  assert.equal(control?.owner, 'agent', 'The original operation retains native input ownership: ' + name)
  assert.equal(control.activeOperationId, operationId, 'The rim describes only the actual original operation: ' + name)
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
  const image = await shield.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false })
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
  if (name === 'navigation-in-flight') assert.ok(Object.entries(samples).filter(([edge]) => edge !== 'center').every(([, values]) => (values as number[][]).some(green)),
    'The same original operation keeps its rim during native navigation')
  return row
}
async function released(shield: WebContentsView, shieldContents: WebContents, source: WebContentsView, operationId: string, phase: string) {
  await until('original input shield destroyed after ' + phase, () => shieldContents.isDestroyed())
  assert.equal(window!.contentView.children.includes(shield), false)
  assert.equal(manager!.nativeOwner('original')!.inputShield, undefined, 'Ending the operation releases the original rim/input surface')
  assert.equal(source.webContents.isDestroyed(), false, 'Releasing the rim preserves the original healthy webpage')
  assert.equal(manager!.target('original')!.control?.owner, 'human')
  receipt.cases.push({ name: phase, operationId, shieldDestroyed: true, originalPageAlive: true, passed: true })
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
  const disabledImage = await shieldContents.capturePage(undefined, { stayHidden: true, stayAwake: false })
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
  await released(shield, shieldContents, source, operationId, 'completion-releases-rim')
  await delay(100)
  assert.equal(manager.nativeOwner('original')!.inputShield, undefined, 'Late display work cannot revive the ended original rim')
  const takeoverId = 'native-continuity-takeover'
  const takeover = manager.runScript('original', 'await waitForElement("Never dispatched private target",16000)', operator, undefined, takeoverId)
  programs.push(takeover); void takeover.catch(() => {})
  await until('second actual operation waiting', () => manager!.inputContext('original', 'local')?.activity?.phase === 'waiting')
  const secondShield = manager.nativeOwner('original')!.inputShield!
  assert.ok(secondShield && secondShield !== shield, 'A new operation gets a new exact input surface')
  const secondShieldContents = secondShield.webContents
  await rimCheckpoint('takeover-waiting', source, secondShield, takeoverId, { sourceId, shieldId: secondShield.webContents.id, shieldToken: secondShield.webContents.mainFrame.frameToken })
  await manager.stopOperationById(takeoverId)
  assert.equal((await takeover).outcome.kind, 'stopped')
  await released(secondShield, secondShieldContents, source, takeoverId, 'explicit-takeover-releases-rim')
  manager.returnControl('original')
  assert.equal(contents.id, sourceId); assert.equal(contents.session, sourceSession)
  assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'Replaced document contents')
  assert.equal(receipt.checkpoints.length, 5)
  assert.equal(receipt.cases.length, 4)
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
