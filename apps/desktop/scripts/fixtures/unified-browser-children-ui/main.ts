import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, ipcMain, desktopCapturer, screen, nativeImage } from 'electron'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { NativeOverlayWindows } from '../../../src/main/native-overlay-windows'
import { browserColdDescriptor } from '../../../src/main/browser-cold-descriptor'
import { senderTrust, assertSenderTrusted } from '../../../src/main/ipc-sender-trust'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'
import { WORKBENCH_WINDOW_RESPONSE } from '../../../src/shared/workbench-windows'
import { surveyAliasScene } from './survey-alias'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap'

const [compiled, privateRoot, output, phase, pageUrl, scenario = 'unified-children'] = process.argv.slice(2)
assert.ok(privateRoot.includes('amx-child-ui-') && ['seed', 'restore', 'survey'].includes(phase))
app.setPath('userData', join(privateRoot, 'userData'))
app.setPath('sessionData', join(privateRoot, 'sessionData'))
app.commandLine.appendSwitch('no-proxy-server')
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const exec = promisify(execFile)
const spatial = new AgentMuxSpatialStateStore(join(privateRoot, 'spatial.json'))
const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'repo', name: 'Browser child UI proof', hostId: 'local', kind: 'folder', path: privateRoot }, ...(scenario === 'survey-alias' ? [{ id: 'alias', name: 'Research display', hostId: 'local', kind: 'folder', path: join(privateRoot, 'alias') }] : [])],
  browser: { ...structuredClone(DEFAULT_CONFIG.browser), agentAutomation: true } }
const receipt: any = { schema: 'agentmux.unified-browser-children-ui.phase.v1', phase, scenario, pid: process.pid, passed: false,
  calls: [], assertions: [], images: [], warnings: [], boundary: 'Actual App/Store/WorkspaceWorkbench/StableWorkbenchView/BrowserPane, production preload mappings, WorkbenchWindows shell/portal, NativeOverlayWindows, exact BVM presentations and Core spatial durability. Unrelated provider/files/settings data uses existing browser-preview APIs; no user App, Agent Session, Runtime or clipboard.' }
let main: BrowserWindow, browsers: BrowserViewManager, windows: WorkbenchWindows, overlays: NativeOverlayWindows, profiles: BrowserProfileManager
let activationRequestCount = 0
async function js(expression: string) { return main.webContents.executeJavaScript(expression) }
async function until(label: string, read: () => unknown | Promise<unknown>, budget = 15000): Promise<any> {
  await writeFile(join(output, phase + '-progress.json'), JSON.stringify({ stage: label, pid: process.pid, at: Date.now() }))
  const deadline = Date.now() + budget
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await wait(30) }
  throw new Error('UI fact not observed: ' + label)
}
const facts = () => js('window.childrenUi.facts()')
async function sourceInputFacts() {
  return { mainFocused: main.isFocused(), input: await js(`(()=>{const input=document.querySelector('.browser-surface input[role="combobox"]');return input&&{active:document.activeElement===input,value:input.value,start:input.selectionStart,end:input.selectionEnd}})()`) }
}
function handle(channel: string, action: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSenderTrusted(senderTrust(channel as any, event.sender, main.webContents))
    const call: any = { channel, senderId: event.sender.id, frame: { processId: event.senderFrame?.processId, frameToken: event.senderFrame?.frameToken }, args, at: Date.now() }
    receipt.calls.push(call)
    try { return await action(event, ...args) } finally { call.returnedAt = Date.now() }
  })
}
async function ensure(id: string) {
  if (browsers.target(id)) { await browsers.prepareForConsumption(id); return }
  const saved = browserColdDescriptor((await spatial.read())?.graph ?? null, id)
  await browsers.create(id, saved.url, saved.workspaceId, saved.profileId, saved.mode, saved.viewport, saved)
}
async function click(window: BrowserWindow, selector: string) {
  // CDP dispatch alone does not perform the OS activation of a real human click.
  window.show(); app.focus({ steal: true }); window.focus()
  if (!await until('private candidate active before human UI input', () => window.isFocused(), 5000).catch(() => false)) {
    assert.equal(process.env.AGENTMUX_CHILD_UI_CAPTURE_HOLD, '1', 'The original private candidate requires actual human activation before UI input')
    const label = 'activation-' + ++activationRequestCount, release = join(output, `${phase}-${label}-release`)
    const request = { pid: process.pid, title: window.getTitle(), browserWindowId: window.id, mediaSourceId: window.getMediaSourceId(), nativeId: window.getMediaSourceId().split(':')[1],
      appPath: process.execPath, release, deadlineAt: Date.now() + 120000, purpose: 'Activate only this exact private candidate before the human action and before any automatic child-focus oracle.' }
    await writeFile(join(output, `${phase}-${label}-request.json`), JSON.stringify(request))
    process.stderr.write('UI_ACTIVATION_HOLD ' + JSON.stringify(request) + '\n')
    await until('independent activation of the original private candidate', () => window.isFocused(), 120000)
    receipt.assertions.push({ label: 'independent-private-candidate-human-activation', request, nativeFocused: window.isFocused() })
  }
  const point = await window.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return r&&r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
  assert.ok(point, 'Actual UI selector ' + selector)
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
  for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function capture(window: BrowserWindow, label: string) {
  await wait(160)
  const observe = async () => ({ at: Date.now(), nativeFocused: window.isFocused(), ...await window.webContents.executeJavaScript(`(()=>{const menu=document.querySelector('.browser-source-navigation__menu'),rect=menu?.getBoundingClientRect();return {appearance:document.documentElement.dataset.appearance,sourceMenuOpen:!!rect&&rect.width>0&&rect.height>0,sourceMenuText:menu?.textContent??null,sourceMenuBounds:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null}})()`) })
  const before = await observe()
  const layer = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  const filename = `${phase}-${label}-renderer.png`; await writeFile(join(output, filename), layer.toPNG())
  receipt.images.push({ label, kind: 'original-renderer-layer', filename, size: layer.getSize(), windowId: window.id, webContentsId: window.webContents.id })
  const nativeId = window.getMediaSourceId().split(':')[1], filenameOs = `${phase}-${label}-composed.png`
  const captureHold = process.env.AGENTMUX_CHILD_UI_CAPTURE_HOLD === '1'
  let composed = false
  if (!captureHold) {
  try {
    const bounds = window.getBounds(), scale = screen.getDisplayMatching(bounds).scaleFactor
    const sources = await Promise.race([desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.ceil(bounds.width * scale), height: Math.ceil(bounds.height * scale) }, fetchWindowIcons: false }), wait(8000).then(() => { throw new Error('Exact private window compositor observation timed out') })])
    const exact = sources.find(source => source.id === window.getMediaSourceId())
    assert.ok(exact && !exact.thumbnail.isEmpty(), 'Exact original private window has actual compositor pixels')
    const bytes = exact.thumbnail.toPNG(); await writeFile(join(output, filenameOs), bytes)
    receipt.images.push({ label, kind: 'actual-composed-native-window-desktopCapturer', filename: filenameOs, bytes: bytes.length, size: exact.thumbnail.getSize(), pid: process.pid, nativeId, windowId: window.id, sourceId: exact.id })
    composed = true
  } catch (error: any) { receipt.warnings.push({ step: 'self-owned-window-compositor-capture', label, message: error.message }) }
  }
  if (!composed && !captureHold) {
  try {
    await exec('/usr/sbin/screencapture', ['-x', '-l', nativeId, join(output, filenameOs)], { timeout: 15000 })
    const bytes = await readFile(join(output, filenameOs)); assert.ok(bytes.length > 100)
    receipt.images.push({ label, kind: 'actual-composed-native-window', filename: filenameOs, bytes: bytes.length, pid: process.pid, nativeId, windowId: window.id }); composed = true
  } catch (error: any) {
    receipt.warnings.push({ step: 'OS-composed-capture', label, message: error.message })
    try {
      const orca = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : 'orca')
      const env = { ...process.env, HOME: process.env.AGENTMUX_CHILD_UI_TOOL_HOME }
      const listed = JSON.parse((await exec(orca, ['computer', 'list-windows', '--app', `pid:${process.pid}`, '--json'], { timeout: 15000, env })).stdout)
      assert.equal(listed.result.app.pid, process.pid)
      const exact = listed.result.windows.find((row: any) => String(row.id) === nativeId)
      assert.ok(exact, 'Exact current native window listed by its own OS id')
      const captured = JSON.parse((await exec(orca, ['computer', 'get-app-state', '--app', `pid:${process.pid}`, '--window-id', String(exact.id), '--json'], { timeout: 15000, maxBuffer: 5 * 1024 * 1024, env })).stdout)
      assert.equal(captured.result.snapshot.app.pid, process.pid)
      const shot = captured.result.screenshot; assert.equal(captured.result.screenshotStatus.state, 'captured')
      const bytes = shot.path ? await readFile(shot.path) : Buffer.from(shot.data, 'base64'); await writeFile(join(output, filenameOs), bytes)
      receipt.images.push({ label, kind: 'actual-composed-native-window-orca', filename: filenameOs, bytes: bytes.length, pid: process.pid, nativeId, windowId: window.id }); composed = true
    } catch (failure: any) { receipt.warnings.push({ step: 'exact-pid-Orca-capture', label, message: failure.message }) }
  }
  }
  if (captureHold) {
    const captureProvider = process.env.AGENTMUX_CHILD_UI_CAPTURE_PROVIDER === 'agentmux' ? 'agentmux' : process.env.AGENTMUX_CHILD_UI_CAPTURE_PROVIDER === 'orca' ? 'orca' : 'cua'
    const release = join(output, `${phase}-${label}-capture-release`)
    const independentFilename = `${phase}-${label}-${captureProvider}.png`
    const request = { pid: process.pid, title: window.getTitle(), browserWindowId: window.id, mediaSourceId: window.getMediaSourceId(), nativeId,
      appPath: process.execPath, provider: captureProvider, output: join(output, independentFilename), release, deadlineAt: Date.now() + 120000, alreadyComposed: composed, observation: before }
    await writeFile(join(output, `${phase}-${label}-capture-request.json`), JSON.stringify(request))
    process.stderr.write('UI_CAPTURE_HOLD ' + JSON.stringify(request) + '\n')
    await until('bounded independent capture hold', () => readFile(release).then(() => true).catch(() => false), 120000).catch(() => { receipt.warnings.push({ step: 'capture-hold', outcome: 'deadline', request }) })
    try {
      const bytes = await readFile(join(output, independentFilename)), signature = bytes.subarray(0, 8).toString('hex')
      const mimeType = signature === '89504e470d0a1a0a' ? 'image/png' : signature.startsWith('ffd8ff') ? 'image/jpeg' : null
      assert.ok(mimeType, 'Raw independent capture file has an original PNG or JPEG signature')
      const provenance = captureProvider === 'agentmux' ? JSON.parse(await readFile(release, 'utf8')).provenance : undefined
      if (captureProvider === 'agentmux') {
        assert.equal(mimeType, 'image/png', 'AgentMux native capture retains its original PNG bytes')
        assert.ok(provenance && typeof provenance === 'object' && !Array.isArray(provenance) && Object.keys(provenance).length > 0, 'AgentMux capture release preserves its original operation and target provenance')
      }
      const pixels = nativeImage.createFromBuffer(bytes); assert.ok(!pixels.isEmpty(), 'Independent capture image has actual pixels')
      const filename = mimeType === 'image/jpeg' ? `${phase}-${label}-${captureProvider}.jpg` : independentFilename
      if (filename !== independentFilename) await rename(join(output, independentFilename), join(output, filename))
      receipt.images.push({ label, kind: `actual-composed-native-window-${captureProvider}`, method: `actual-composed-native-window-${captureProvider}`, filename, mimeType,
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), size: pixels.getSize(), pid: process.pid, nativeId, windowId: window.id, sourceId: window.getMediaSourceId(),
        ...(provenance === undefined ? {} : { provenance }) })
      composed = true
    } catch (error: any) { receipt.warnings.push({ step: 'independent-composed-capture', provider: captureProvider, label, message: error.message }) }
    assert.ok(composed, 'The exact private window requires a real independent compositor image in capture-hold mode')
  }
  const after = await observe()
  ;(receipt.captureObservations ??= []).push({ label, before, after })
  if (label === 'closed-source-notice') assert.equal(after.sourceMenuOpen, true, 'The original Source notice remains actually open after independent native capture')
}
async function childFromSource(sourceId: string, contents: Electron.WebContents) {
  const before = new Set(browsers.targets().map(row => row.id))
  assert.equal(contents.isDestroyed(), false, 'The original source page is retained before its actual Agent program')
  const opening = await browsers.runScript(sourceId, 'const page = await snapshot();const target = page.nodes.find(node => node.name === "Open related task");if(!target)throw new Error("The original link button was not observed");await click(target.ref)', { id: 'private-browser-operator', name: 'Research Agent' }, undefined, 'private-open-child-' + receipt.assertions.length)
  receipt.assertions.push({ label: 'actual-browser-program-opened-child', sourceId, originalContentsId: contents.id, opening })
  const child = await until('native child registered', () => browsers.targets().find(row => !before.has(row.id)))
  const nativeWindow = await until('original shared Pane portal owns native page', () => {
    const view = browsers.nativeOwner(child.id)?.view
    if (!view) return false
    const host = browsers.windowForView(view)
    return host !== main && !host.isDestroyed() && view.getVisible() && view.getBounds().width > 100 ? host : false
  }) as BrowserWindow
  await until('child source UI in shell', () => nativeWindow.webContents.executeJavaScript(`!!document.querySelector('button[aria-label="Go to source Browser"]')`))
  assert.equal(await nativeWindow.webContents.executeJavaScript('typeof window.agentmux'), 'undefined', 'Empty child shell has no second preload/App/Store')
  const pane = await nativeWindow.webContents.executeJavaScript(`({surfaces:document.querySelectorAll('.browser-surface').length,stages:[...document.querySelectorAll('[data-native-browser-stage]')].map(node=>({browserId:node.dataset.nativeBrowserStage,presentationId:node.dataset.browserPresentationId})),address:!!document.querySelector('input[role="combobox"]')})`)
  assert.ok(pane.surfaces > 0 && pane.address && pane.stages.some((stage: any) => stage.browserId === child.id && stage.presentationId), 'The original full BrowserPane and production native PresentationStage are mounted in the exact shell')
  const source = browsers.target(child.id)!.openedFrom
  assert.equal(source?.browserId, sourceId)
  receipt.assertions.push({ label: 'native-child-shared-workface', childId: child.id, webContentsId: browsers.nativeOwner(child.id)!.view.webContents.id,
    shellId: nativeWindow.id, source, pane, facts: await facts() })
  return { child, nativeWindow }
}
async function run() {
  await app.whenReady(); await mkdir(output, { recursive: true })
  main = new BrowserWindow({ width: 1180, height: 820, show: false, title: 'Private unified Browser proof', webPreferences: { preload: join(compiled, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  main.webContents.on('console-message', (_event, level, message) => { if (level >= 2) receipt.warnings.push({ step: 'renderer-console', level, message }) })
  windows = new WorkbenchWindows(main, new WorkbenchWindowStore(join(privateRoot, 'windows.json')), () => [{ x: 0, y: 0, width: 1512, height: 982 }])
  main.webContents.setWindowOpenHandler(details => windows.windowOpen(details, () => { throw new Error('External URL outside private proof') }))
  main.webContents.on('did-create-window', (window, details) => windows.createdWindow(window, details))
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(privateRoot, 'profiles.json'))); await profiles.initialize()
  browsers = new BrowserViewManager(main, profiles, new BrowserRefLedgerStore(join(privateRoot, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: () => { throw new Error('External app outside private proof') } }, new BrowserOperationJournal(new BrowserOperationFileStore(join(privateRoot, 'operations.sqlite'))))
  browsers.setPresentationWindowOwner((document, occurrence) => windows.presentationWindow(document, occurrence))
  overlays = new NativeOverlayWindows(main, browsers, windows)
  windows.setNativeOwner({ requestClose: window => browsers.requestNativeWindowClose(window), windowSize: async target => {
    const regions = (await spatial.read())?.graph.regions.filter(region => region.tabId === target.tabId && region.kind === 'browser' && (target.kind === 'tab' || region.regionId === target.regionId)) ?? []
    return regions.length === 1 && regions[0]?.browserId ? browsers.nativeWindowSize(regions[0].browserId) : null
  }, beforeClosing: async window => { await browsers.returnWindow(window); overlays.releaseWindow(window) } })
  browsers.onNativeVisibilityChange = (_visibility, window) => overlays.visibilityChanged(window)
  browsers.onNativeInput = (owner, input) => overlays.forwardBrowserInput(owner, input)
  ipcMain.on(THEME_BOOTSTRAP_CHANNEL, event => { event.returnValue = { status: 'unavailable', message: 'Private preview uses actual App theme runtime' } })
  ipcMain.on(WORKBENCH_WINDOW_RESPONSE, (event, value) => windows.accept(event, value))
  handle('ui:workbenchWindowsReady', event => windows.rendererReady(event))
  handle('ui:workbenchWindowsCall', (_event, method, input) => windows.call(method, input, { actor: { kind: 'user', id: 'desktop' } }))
  handle('ui:publishNativeOverlays', (_event, regions, document) => overlays.update(regions, document))
  handle('ui:nativeBrowserVisibility', (_event, document) => overlays.visibility(document))
  ipcMain.handle('children-ui:request', async (event, operation, ...args) => {
    assert.equal(event.sender, main.webContents, 'Private fixture operations address only the original privileged Renderer')
    assert.equal(event.senderFrame?.frameToken, main.webContents.mainFrame.frameToken, 'Private fixture operations preserve their exact original frame')
    if (operation === 'setup') return { config, phase, pageUrl, scenario }
    if (operation === 'spatial-read') return spatial.read()
    if (operation === 'spatial-commit') return spatial.commit(args[0])
    if (operation === 'flush') { main.webContents.session.flushStorageData(); return }
    throw new Error('Unknown private boundary ' + operation)
  })
  handle('browser:create', async (_event, id, url, workspaceId, profile, mode, viewport) => browsers.create(id, url, workspaceId, profile, mode, viewport))
  handle('browser:restore', async (_event, id, input) => { await ensure(id); return browsers.create(id, 'about:blank', input.workspaceId, input.profileId, input.mode, input.viewport) })
  handle('browser:registerPresentation', async (event, input) => {
    const original = event.senderFrame ? { processId: event.senderFrame.processId, frameToken: event.senderFrame.frameToken } : null
    await ensure(input.browserId); return browsers.registerPresentation(event.sender, event.senderFrame, input, original)
  })
  for (const method of ['updatePresentation', 'removePresentation', 'armPresentationCapture', 'ackPresentationCapture', 'activatePresentation']) handle('browser:' + method, (event, ...args) => (browsers as any)[method](event.sender, event.senderFrame, ...args))
  for (const method of ['setBounds', 'close', 'release', 'navigate', 'reload', 'back', 'forward', 'takeControl', 'returnControl', 'listOperationHistory', 'getOperation', 'getStepEvidence', 'getDemonstration', 'getTaskAssets', 'setAnnotationMarkers', 'setOperatorAvatar', 'cancelElementSelection']) handle('browser:' + method, (_event, ...args) => (browsers as any)[method](...args))
  handle('browser:listProfiles', () => profiles.listProfiles())
  handle('browser:listTargets', () => ({ targets: browsers.targets(), coverage: 'complete' }))
  handle('browser:getRecoveryPreview', () => ({ status: 'missing' }))
  handle('browser:listInputHistory', (_event, target) => ({ scope: browsers.inputHistoryScope(target.browserId, target.profileId), entries: [] }))
  handle('browser:recordInputHistory', (_event, target) => ({ scope: browsers.inputHistoryScope(target.browserId, target.profileId), entries: [], outcome: 'recorded' }))
  await main.loadFile(join(compiled, 'renderer/index.html')); main.showInactive()
  await until('real App initialized', async () => await js('!!window.childrenUi?.ready && !window.childrenUi.facts().loading'))
  if (scenario === 'survey-alias') {
    await surveyAliasScene({ main, browsers, windows, receipt, js, facts, until, wait, click, capture, output, pageUrl })
    receipt.passed = true; return
  }
  if (phase === 'seed') {
    await js('window.childrenUi.create()')
    const source = await until('source Browser', () => browsers.targets()[0])
    await until('source native visible', () => browsers.nativeOwner(source.id)?.view.getVisible())
    const sourceContents = browsers.nativeOwner(source.id)!.view.webContents
    await until('original page loaded', async () => sourceContents.executeJavaScript('!!document.querySelector("#open-child")'))
    const sourceTabBefore = Object.values((await facts()).tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === source.id)) as any
    await js(`window.childrenUi.split(${JSON.stringify(sourceTabBefore.id)},${JSON.stringify(source.id)})`)
    await js(`window.childrenUi.select(${JSON.stringify(sourceTabBefore.id)},${JSON.stringify(source.id)})`)
    await click(main, '.browser-surface input[role="combobox"]')
    await wait(60)
    await js(`(()=>{const input=document.querySelector('.browser-surface input[role="combobox"]');input.setSelectionRange(0,input.value.length)})()`)
    await main.webContents.insertText('Private source draft 42')
    await js(`(()=>{const input=document.querySelector('.browser-surface input[role="combobox"]');input.setSelectionRange(8,14)})()`)
    const sourceFocusBefore = await sourceInputFacts()
    assert.equal(sourceFocusBefore.mainFocused, true, 'The actual original native window is focused before the Agent opens the related page')
    assert.equal(sourceFocusBefore.input?.active, true, 'The original address input owns actual DOM focus')
    assert.equal(sourceFocusBefore.input?.value, 'Private source draft 42', 'The original input has a nonempty unsubmitted draft')
    const { child, nativeWindow } = await childFromSource(source.id, sourceContents)
    const sourceFocusAfter = await sourceInputFacts()
    assert.deepEqual(sourceFocusAfter, sourceFocusBefore, 'Automatic native child presentation preserves the original native focus, input draft and selection')
    assert.equal(nativeWindow.isVisible(), true, 'Automatic native child is visible')
    assert.equal(nativeWindow.isFocused(), false, 'Automatic native child does not steal native focus')
    assert.equal((await facts()).tabs[sourceTabBefore.id].layout.activeRegionId, source.id, 'Automatic child presentation preserves the original selected Region')
    receipt.assertions.push({ label: 'automatic-child-preserves-original-input-focus', before: sourceFocusBefore, after: sourceFocusAfter, childVisible: nativeWindow.isVisible(), childFocused: nativeWindow.isFocused() })
    const originalChildContents = browsers.nativeOwner(child.id)!.view.webContents
    await until('child page loaded', async () => originalChildContents.executeJavaScript('document.title === "Related task"'))
    let runResult: any
    const active = browsers.runScript(child.id, 'await waitForElement("Private UI proof holds this actual operation",30000)', { id: 'private-ui-agent-operation', name: 'Research Agent' }, undefined, 'private-ui-child-operation').then(result => { runResult = result }, error => { runResult = { failure: String(error) } })
    await until('actual Agent operation feedback in original shared BrowserPane', async () => nativeWindow.webContents.executeJavaScript(`(()=>{const status=document.querySelector('[data-operation-id="private-ui-child-operation"]');return status?.getAttribute('data-control')==='agent' && status.querySelector('button[aria-label^="Browser activity:"]')?.getAttribute('aria-label').includes('Research Agent') && !!document.querySelector('button[aria-label="Take control of Browser"]')})()`))
    await js('window.childrenUi.theme("light")')
    await until('actual child light theme mirrored', () => nativeWindow.webContents.executeJavaScript('document.documentElement.dataset.appearance === "light"'))
    const activeLayer = await nativeWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    const activeFilename = phase + '-agent-active-renderer.png'; await writeFile(join(output, activeFilename), activeLayer.toPNG())
    receipt.images.push({ label: 'agent-active', kind: 'original-renderer-layer', filename: activeFilename, size: activeLayer.getSize(), windowId: nativeWindow.id, webContentsId: nativeWindow.webContents.id })
    assert.equal(browsers.target(child.id)?.control?.activeOperationId, 'private-ui-child-operation', 'Take control acts on the actual in-flight operation')
    await click(nativeWindow, 'button[aria-label="Take control of Browser"]')
    await until('actual Take control handoff', () => browsers.target(child.id)?.control?.owner === 'human')
    await active
    assert.equal(browsers.nativeOwner(child.id)!.view.webContents, originalChildContents)
    receipt.assertions.push({ label: 'shared-pane-real-operation-feedback-and-human-handoff', control: browsers.target(child.id)!.control, runResult, facts: await facts(), boundary: 'Actual browser script operation; no Provider Session identity is claimed by the private operator display label.' })
    await capture(nativeWindow, 'normal-light')
    nativeWindow.setContentSize(520, 510); await js('window.childrenUi.theme("dark")')
    await until('actual child dark theme mirrored', () => nativeWindow.webContents.executeJavaScript('document.documentElement.dataset.appearance === "dark"'))
    await capture(nativeWindow, 'narrow-dark')
    await click(nativeWindow, 'button[aria-label="Go to source Browser"]')
    const sourceLocation = child.openedFrom?.location ?? browsers.target(child.id)!.openedFrom?.location
    assert.ok(sourceLocation)
    await until('source exact region selected', async () => (await facts()).tabs[sourceLocation.tabId]?.layout.activeRegionId === sourceLocation.regionId && main.isFocused())
    assert.equal(originalChildContents.isDestroyed(), false, 'Source navigation preserves child')
    receipt.assertions.push({ label: 'one-click-source-return', sourceLocation, facts: await facts(), mainFocused: main.isFocused() })
    await js(`window.childrenUi.promote(${JSON.stringify(sourceLocation.tabId)},${JSON.stringify(sourceLocation.regionId)})`)
    const movedSource = Object.values((await facts()).tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === source.id)) as any
    assert.notEqual(movedSource.id, sourceLocation.tabId, 'Actual promote moves original source Region to another Tab')
    await click(nativeWindow, 'button[aria-label="Go to source Browser"]')
    await until('source button follows moved original Region', async () => (await facts()).tabs[movedSource.id]?.layout.activeRegionId === sourceLocation.regionId && main.isFocused())
    receipt.assertions.push({ label: 'source-return-follows-moved-region', original: sourceLocation, movedTabId: movedSource.id, facts: await facts() })
    await click(nativeWindow, '.workbench-window-toolbar button')
    await until('Return moves the same child into original workspace', () => {
      const owner = browsers.nativeOwner(child.id)
      return nativeWindow.isDestroyed() && owner && browsers.windowForView(owner.view) === main
    })
    assert.equal(browsers.nativeOwner(child.id)!.view.webContents, originalChildContents)
    receipt.assertions.push({ label: 'return-preserves-native-page', childId: child.id, contentsId: originalChildContents.id, facts: await facts() })
    const sourceEntry = Object.values((await facts()).tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === source.id)) as any
    await js(`window.childrenUi.select(${JSON.stringify(sourceEntry.id)},${JSON.stringify(source.id)})`)
    const another = await childFromSource(source.id, sourceContents)
    another.nativeWindow.close()
    await until('native Close retires original child', () => !browsers.target(another.child.id) && another.nativeWindow.isDestroyed())
    await until('native Close removes only its original Region projection', async () => !Object.values((await facts()).tabs).some((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === another.child.id)))
    assert.equal(originalChildContents.isDestroyed(), false, 'Closing the second child preserves the returned first native page while its Tab is hidden')
    assert.equal(browsers.target(child.id)?.id, child.id, 'Closing the second child preserves the returned first Browser identity')
    receipt.assertions.push({ label: 'native-close-destroys-child', childId: another.child.id, facts: await facts() })
    const childTabToSave = Object.values((await facts()).tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === child.id)) as any
    await js(`window.childrenUi.split(${JSON.stringify(childTabToSave.id)},${JSON.stringify(child.id)})`)
    await js(`window.childrenUi.select(${JSON.stringify(childTabToSave.id)},${JSON.stringify(child.id)})`)
    assert.ok((await facts()).tabs[childTabToSave.id].layout.root.type === 'split', 'Persist a genuine original split through the real Store')
    const saved = await js('window.childrenUi.flush()')
    await writeFile(join(privateRoot, 'expected.json'), JSON.stringify({ sourceId: source.id, childId: child.id, tabs: saved.tabs, layouts: saved.layouts }))
    receipt.persisted = { sourceId: source.id, childId: child.id, tabs: saved.tabs, layouts: saved.layouts, spatial: await spatial.read() }
  } else {
    const expected = JSON.parse(await readFile(join(privateRoot, 'expected.json'), 'utf8')), recovered = await facts()
    assert.deepEqual(Object.keys(recovered.tabs).sort(), Object.keys(expected.tabs).sort(), 'A new Electron process restores original durable Tab identities')
    assert.deepEqual(recovered.layouts, expected.layouts, 'Original durable Group topology, Tab selection and order')
    for (const [tabId, tab] of Object.entries(expected.tabs) as any) {
      assert.deepEqual(recovered.tabs[tabId].layout, tab.layout, 'Original split/focus layout')
      assert.deepEqual(Object.keys(recovered.tabs[tabId].regions).sort(), Object.keys(tab.regions).sort(), 'Original durable Region identities')
    }
    const childTab = Object.values(recovered.tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === expected.childId)) as any
    assert.ok(childTab)
    await js(`window.childrenUi.select(${JSON.stringify(childTab.id)},${JSON.stringify(expected.childId)})`)
    await until('same child Browser cold restore', () => browsers.nativeOwner(expected.childId)?.view.getVisible())
    const restored = browsers.target(expected.childId)!
    assert.equal(restored.openedFrom?.browserId, expected.sourceId, 'Original source identity survives cold restoration')
    await capture(main, 'restored-workspace')
    receipt.assertions.push({ label: 'actual-process-restart-same-workface', previous: expected, recovered: await facts(), child: restored, spatial: await spatial.read() })
    const sourceTab = Object.values((await facts()).tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === expected.sourceId)) as any
    assert.equal(Object.keys(sourceTab.regions).length, 1, 'The original promoted source is a single-Region Tab')
    assert.equal(await js(`window.childrenUi.closeTab(${JSON.stringify(sourceTab.id)})`), true, 'The existing whole-Tab close owns removal of its last Region')
    await until('original source display actually closed', async () => !(await facts()).tabs[sourceTab.id])
    await click(main, 'button[aria-label="Go to source Browser"]')
    await until('closed source notice preserves original child', () => js('document.body.textContent.includes("source page no longer has an available display")'))
    const menuGeometry = await js(`(()=>{
      const menu=document.querySelector('.browser-source-navigation__menu');
      const item=[...menu.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.trim()==='Dismiss');
      if(!item)throw new Error('The original Source menu Dismiss item is unavailable');
      const read=()=>{const range=document.createRange();range.selectNodeContents(item);const textRects=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0).map(rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height})),rect=menu.getBoundingClientRect();return {textRects,lines:new Set(textRects.map(rect=>Math.round(rect.y*2)/2)).size,menu:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:innerWidth,withinViewport:rect.x>=0&&rect.right<=innerWidth,columns:getComputedStyle(item).gridTemplateColumns}};
      const rules=[];const visit=list=>{for(const rule of list){if(rule.selectorText==='.browser-source-navigation__menu .browser-menu__item')rules.push(rule);if(rule.cssRules)visit(rule.cssRules)}};
      for(const sheet of document.styleSheets)visit(sheet.cssRules);
      if(rules.length!==1)throw new Error('The original Source text-only CSS owner must be unique');
      const rule=rules[0],value=rule.style.getPropertyValue('grid-template-columns'),priority=rule.style.getPropertyPriority('grid-template-columns'),before=read();let mutant;
      try{rule.style.setProperty('grid-template-columns','14px minmax(0, 1fr) auto',priority);mutant=read()}
      finally{if(value)rule.style.setProperty('grid-template-columns',value,priority);else rule.style.removeProperty('grid-template-columns')}
      return {before,mutant,restored:read(),mutation:'Only the original Source menu item CSSOM grid columns were temporarily restored to the generic icon grid; original value and priority restored in finally.'}
    })()`)
    receipt.assertions.push({ label: 'real-source-menu-geometry-and-CSSOM-mutation', ...menuGeometry })
    assert.equal(menuGeometry.before.lines, 1, 'Dismiss is one readable text line in the real Source menu')
    assert.equal(menuGeometry.before.withinViewport, true, 'The real Source menu stays inside its current viewport')
    assert.notEqual(menuGeometry.mutant.lines, 1, 'The original generic 14px icon grid makes the same live Dismiss geometry fail')
    assert.equal(menuGeometry.restored.lines, 1, 'Original Source item geometry is restored after the CSSOM mutation')
    assert.equal(menuGeometry.restored.withinViewport, true, 'Original Source menu bounds are restored')
    assert.equal(browsers.target(expected.childId)?.id, expected.childId)
    receipt.assertions.push({ label: 'closed-source-remains-explicit-and-child-usable', child: browsers.target(expected.childId), facts: await facts() })
    await capture(main, 'closed-source-notice')
  }
  receipt.passed = true
}
app.on('window-all-closed', () => {})
run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { receipt.rawFailurePage = await js('({url:location.href,text:document.body.textContent,ready:document.readyState,probe:typeof window.childrenUi})') } catch {}
}).finally(async () => {
  try { receipt.final = main && !main.isDestroyed() ? await facts() : null } catch {}
  await mkdir(output, { recursive: true }); await writeFile(join(output, phase + '.json'), JSON.stringify(receipt, null, 2))
  try {
    if (scenario === 'survey-alias') {
      for (const target of browsers?.targets() ?? []) { const contents = browsers.nativeOwner(target.id)?.view.webContents; if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach() }
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    }
    windows?.dispose(); overlays?.dispose(); browsers?.dispose()
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    void profiles?.dispose().catch(() => {})
  } catch (error) { receipt.cleanupWarning = String(error); await writeFile(join(output, phase + '.json'), JSON.stringify(receipt, null, 2)) }
  finally { app.exit(receipt.passed ? 0 : 1) }
})
