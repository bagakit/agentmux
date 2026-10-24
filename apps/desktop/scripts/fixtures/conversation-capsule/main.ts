import { app, BrowserWindow, ipcMain, webContents } from 'electron'
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { createCapsuleBrowserDocument } from '../../../src/main/capsule-presentation'
import { capsuleDocumentIpc } from '../../../src/main/capsule-document-ipc'
import { sessionInputOperationResult } from '../../../src/shared/session-input-result'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
const [html, profile, evidence, preload, phase = 'green'] = process.argv.slice(2)
app.setPath('userData', profile!)
app.on('window-all-closed', () => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const execute = promisify(execFile)
const frontmost = async () => Number((await execute('/usr/bin/osascript', ['-e', 'tell application "System Events"\nset originalProcess to first application process whose frontmost is true\nreturn unix id of originalProcess\nend tell'], { timeout: 10000 })).stdout.trim())
const focusProcess = async (pid: number) => { assert.ok(Number.isSafeInteger(pid) && pid > 0); await execute('/usr/bin/osascript', ['-e', `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`], { timeout: 10000 }) }
const report: any = { passed: false, phase, created: [], releases: [], geometries: [], userRunTouched: false }
report.nativeScope = { pid: process.pid, profile, main: process.argv[1] }
const step = async (stage: string) => { report.stage = stage; await writeFile(join(evidence!, `${phase}.progress.json`), JSON.stringify(report, null, 2)) }
let owner: NodeCapsuleOwner | null = null, manager: BrowserViewManager | null = null, win: BrowserWindow | null = null, windows: WorkbenchWindows | null = null
let metadataUnavailable = false
try {
  await app.whenReady()
  await step('ready-before-native-focus-observation')
  report.initialFrontmostPid = await frontmost()
  if (process.platform === 'darwin') { app.setActivationPolicy('regular'); await app.dock!.show() }
  await step('ready')
  const source = join(profile!, 'source'); await mkdir(source, { recursive: true })
  await writeFile(join(source, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Original page</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#edf4ef;color:#20392b;font:15px/1.5 system-ui}h1{font-size:24px;margin:0 0 12px}input{display:block;width:100%;padding:12px;border:1px solid #9cb4a4;border-radius:5px;background:#fff;font:inherit}button{margin-top:12px;padding:9px 15px;border:0;border-radius:5px;background:#2d6549;color:white;font:inherit}output{margin-left:10px}</style><h1>A saved result, right in the conversation</h1><input id="draft" aria-label="Page draft" placeholder="Keep a thought here"><button id="increment">Count</button><output id="count">0</output><p id="bridge"></p><script>let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++count);document.querySelector('#bridge').textContent=window.capsule?'Injected: original App SDK':'Isolated: independent page';</script>`)
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(profile!, 'capsules') })
  const isolated = await owner.call('capsule.create', { operationId: 'create-isolated', sourcePath: source, title: 'Independent result', mode: 'isolated' })
  const injected = await owner.call('capsule.create', { operationId: 'create-injected', sourcePath: source, title: 'Connected result', mode: 'injected' })
  win = new BrowserWindow({ width: 1040, height: 820, show: true, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  for (const event of ['focus', 'blur', 'show', 'hide'] as const) win.on(event, () => { (report.windowEvents ??= []).push({ event, at: Date.now(), focused: win?.isFocused() }) })
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(profile!, 'workbench-windows.json')), () => [])
  win.webContents.on('console-message', (event, _level, message) => { const text = event.message ?? message; (report.console ??= []).push(text); void appendFile(join(evidence!, `${phase}.console.log`), String(text) + '\n') })
  manager = new BrowserViewManager(win, { defaultProfileId: () => 'unused', resolvePartition: () => 'unused' } as never,
    new BrowserRefLedgerStore(join(profile!, 'ledger.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  manager.setPresentationWindowOwner((document) => windows!.windowForDocument(document))
  const sdk = capsuleDocumentIpc({ browsers: manager, capsules: owner, theme: () => ({ mode: 'light', tokens: {} }) })
  ipcMain.handle('capsule:document', (event, action, params) => sessionInputOperationResult(() => sdk.call(event, action, params)))
  ipcMain.handle('capsule-proof', async (event, method, ...args) => {
    if (method === 'window') return await windows!.rendererReady(event)
    if (method === 'capsule') {
      if (metadataUnavailable && args[0] === 'capsule.inspect') throw new Error('Original page metadata observation is unavailable')
      return await owner!.call(args[0], args[1])
    }
    if (method === 'open') { report.opened = args[0]; return }
    if (method === 'restore') return manager!.ensure(args[0], async () => { throw new Error('The original inline presentation has no cold spatial Region') }, args[1])
    if (method === 'create') {
      const [id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId] = args
      const result = await createCapsuleBrowserDocument({ browsers: manager!, inspect: capsuleId => owner!.call('capsule.inspect', { capsuleId }) },
        { id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId })
      report.created.push({ id, capsuleId, navigationId: result.navigationId }); return result
    }
    if (method === 'registerPresentation') return manager!.registerPresentation(event.sender, event.senderFrame, args[0], event.senderFrame ? { processId: event.senderFrame.processId, frameToken: event.senderFrame.frameToken } : null)
    if (method === 'updatePresentation') { report.geometries.push(args[1]); return manager!.updatePresentation(event.sender, event.senderFrame, args[0], args[1]) }
    if (method === 'removePresentation') return manager!.removePresentation(event.sender, event.senderFrame, args[0])
    if (method === 'armPresentationCapture') return manager!.armPresentationCapture(event.sender, event.senderFrame, args[0])
    if (method === 'ackPresentationCapture') return manager!.ackPresentationCapture(event.sender, event.senderFrame, args[0], args[1])
    if (method === 'activatePresentation') { const result = await manager!.activatePresentation(event.sender, event.senderFrame, args[0], args[1]); (report.activations ??= []).push({ request: args[1], result }); return result }
    if (method === 'release') { const result = await manager!.release(args[0], args[1]); report.releases.push(result); return result }
    throw new Error('Unexpected private proof transport method: ' + method)
  })
  const evaluate = (code: string) => win!.webContents.executeJavaScript(code, true)
  const until = async (expression: string, reason: string) => {
    const deadline = Date.now() + 25000
    while (!await evaluate(expression)) { assert.ok(Date.now() < deadline, reason); await delay(30) }
    await delay(50)
  }
  const facts = () => evaluate('conversationCapsuleProbe.facts()')
  await win.loadFile(html!)
  await step('renderer-loaded')
  await until('Boolean(window.conversationCapsuleProbe)', 'The real conversation fixture must mount')
  await step('fixture-mounted')
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify('Page ' + 'amux://capsule/' + isolated.record.capsuleId)})`)
  await delay(100); assert.equal(report.created.length, 0, 'An ordinary Capsule link cannot acquire a native page')
  const content = (id: string) => `![Page result](amux://capsule/${id})`
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready', 'Actual native WebContentsView capture must decode into the production card video')
  await step('native-video-ready')
  const first = await facts(); report.isolated = first
  const createdBeforeFrame = report.created.length
  await until('conversationCapsuleProbe.facts().cachedFrame?.startsWith("data:image/")', 'The actual timeline hook must cache an already-painted native video keyframe')
  report.nativeKeyframe = { srcPrefix: (await facts()).cachedFrame.slice(0, 40), createdBefore: createdBeforeFrame, createdAfter: report.created.length }
  assert.equal(report.created.length, createdBeforeFrame, 'Caching a painted native page must not acquire another Browser')
  assert.ok(first.height > 150 && first.height <= 320, 'The actual card uses a bounded native page stage')
  const nativePage = webContents.getAllWebContents().find(contents => contents.getURL() === (isolated.endpoint as any).url)!
  assert.ok(nativePage, 'The page comes from an actual native owner, not a screenshot fixture')
  assert.equal(await nativePage.executeJavaScript('Boolean(window.capsule)'), false)
  await until('conversationCapsuleProbe.facts().ready && !document.querySelector(".browser-presentation-notice button")', 'The original Stage must finish its capture and playback handshake before trusted input')
  await delay(200)
  const input = await nativePage.executeJavaScript(`(() => { const r=document.querySelector('#draft').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight} })()`)
  const press = await evaluate(`(() => {const r=document.querySelector('.browser-stage').getBoundingClientRect();const s=Math.min(r.width/${input.width},r.height/${input.height});return {x:Math.round(r.x+(r.width-${input.width}*s)/2+${input.x}*s),y:Math.round(r.y+(r.height-${input.height}*s)/2+${input.y}*s)} })()`)
  const previous = await frontmost()
  report.previousFrontmostPid = previous === process.pid ? report.initialFrontmostPid : previous
  report.focusPreparation = { previous, originalPid: process.pid, windowId: win.id, visible: win.isVisible(), minimized: win.isMinimized(), focusable: win.isFocusable(), appHidden: app.isHidden() }
  if (!win.isFocused()) await focusProcess(process.pid)
  win.show(); win.moveTop(); win.focus(); win.webContents.focus()
  const focusDeadline = Date.now() + 5000
  while (!win.isFocused() && Date.now() < focusDeadline) { win.focus(); await delay(100) }
  report.focusPreparation.after = { frontmost: await frontmost(), focused: win.isFocused(), focusedWindow: BrowserWindow.getFocusedWindow()?.id, focusedContents: webContents.getFocusedWebContents()?.id }
  assert.ok(win.isFocused(), 'The original private native window must actually own focus before trusted input')
  report.beforePress = { facts: await facts(), nativeInput: input, press, windowFocused: win.isFocused() }
  win.webContents.sendInputEvent({ type: 'mouseDown', ...press, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...press, button: 'left', clickCount: 1 })
  await delay(100)
  assert.equal(await nativePage.executeJavaScript('document.activeElement.id'), 'draft', 'Trusted first press must activate the original native input')
  await nativePage.insertText('Original unsent thought')
  await nativePage.executeJavaScript(`document.querySelector('#increment').click()`)
  const entry = (manager as any).entries.get(first.browserId)
  assert.equal(entry.view.getVisible(), true, 'The selected native input owner is visible in the card')
  await evaluate(`document.querySelector('.activity-feed').style.height='230px'`)
  await delay(100)
  assert.ok(report.geometries.some((geometry: any) => geometry.visible && geometry.inputVisible === false), 'Actual scroll clipping must reach the native presentation owner')
  assert.equal(entry.view.getVisible(), false, 'A clipped card cannot cover adjacent conversation content with its native input view')
  await until('conversationCapsuleProbe.facts().ready', 'Clipped previews preserve the original live capture')
  report.clipped = await facts()
  await writeFile(join(evidence!, `${phase}-clipped.png`), (await win.webContents.capturePage()).toPNG())
  await evaluate(`document.querySelector('.activity-feed').style.height='calc(100dvh - 48px)'`)
  const navigation = report.created[0].navigationId
  await evaluate(`conversationCapsuleProbe.click('Hide')`)
  await until('!document.querySelector("video")', 'Hide removes this original live presentation')
  await delay(100)
  assert.equal(nativePage.isDestroyed(), false, 'A used native document survives automatic release')
  assert.ok(report.releases.some((receipt: any) => receipt.status === 'retained'), 'The actual native release owner confirms retention')
  await evaluate(`conversationCapsuleProbe.click('Show page')`)
  await until('conversationCapsuleProbe.facts().ready', 'Show reconnects the original page capture')
  assert.equal((await facts()).browserId, first.browserId)
  assert.equal(report.created.at(-1).navigationId, navigation)
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#draft").value'), 'Original unsent thought')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#count").textContent'), '1')
  await evaluate('conversationCapsuleProbe.unmount()')
  await until('!document.querySelector(".conversation-capsule")', 'The actual original message must be removed from the reading window')
  await delay(100)
  assert.equal(nativePage.isDestroyed(), false)
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready', 'The remounted original message reconnects its retained native owner')
  assert.equal((await facts()).browserId, first.browserId, 'Message remount must preserve its exact native presentation identity')
  assert.equal(report.created.at(-1).navigationId, navigation)
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#draft").value'), 'Original unsent thought')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#count").textContent'), '1')
  await writeFile(join(evidence!, `${phase}-isolated.png`), (await win.webContents.capturePage()).toPNG())
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready && document.querySelector(".conversation-capsule__mode")?.textContent==="Injected"', 'Injected native page and trusted chrome must mount')
  const connected = webContents.getAllWebContents().find(contents => contents.getURL() === (injected.endpoint as any).url)!
  assert.ok(connected)
  report.injectedCapabilities = await connected.executeJavaScript('capsule.capabilities()')
  assert.equal(report.injectedCapabilities.interaction, true); assert.equal(report.injectedCapabilities.humanReply, false)
  await connected.executeJavaScript('capsule.request("Review the original page", "Original draft answer", capsule.createOperationId())')
  await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
  await until('document.body.textContent.includes("Review the original page")', 'Trusted original question must be readable from the card')
  assert.ok((await owner.call('capsule.interaction.ls', { capsuleId: injected.record.capsuleId })).interactions.length === 1)
  await writeFile(join(evidence!, `${phase}-injected.png`), (await win.webContents.capturePage()).toPNG())
  const trustedEditor = await evaluate(`(() => { const node=document.querySelector('.capsule-question textarea'); window.originalTrustedEditor=node; node.scrollIntoView({block:'nearest'}); const r=node.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', ...trustedEditor, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...trustedEditor, button: 'left', clickCount: 1 })
  assert.equal(await evaluate('document.activeElement===window.originalTrustedEditor'), true, 'The trusted original host question must actually own keyboard focus')
  await evaluate('window.originalTrustedEditor.select()'); await win.webContents.insertText('Trusted unsaved answer')
  await evaluate("conversationCapsuleProbe.click('Hide')")
  assert.equal(await evaluate('window.originalTrustedEditor.isConnected'), true, 'Hide keeps the original trusted host editor connected')
  await evaluate("conversationCapsuleProbe.click('Show page')")
  assert.equal(await evaluate('document.querySelector(".capsule-question textarea")===window.originalTrustedEditor'), true)
  assert.equal(await evaluate('window.originalTrustedEditor.value'), 'Trusted unsaved answer')
  report.trustedEditor = { actualKeyboardInput: true, hideShowSameNode: true, bytes: 'Trusted unsaved answer', retentionPort: 'private memory port; actual Workbench writer verified by T004' }
  metadataUnavailable = true
  await evaluate('window.originalTrustedEditor.focus();window.originalTrustedEditor.select()'); await win.webContents.insertText('Trusted retained after unmount')
  await evaluate('conversationCapsuleProbe.unmount()')
  await until('!document.querySelector(".conversation-capsule")', 'The injected original message fully unmounts')
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))})`)
  await until(`conversationCapsuleProbe.facts().ready && !!document.querySelector('[aria-label="Page questions"]')`, 'Original questions remain reachable after native restore despite failed page metadata')
  await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
  await until('document.body.textContent.includes("Review the original page") && document.body.textContent.includes("Original page metadata observation is unavailable")', 'Independent saved-question reads survive metadata failure')
  report.injectedMetadataFailure = { browserId: (await facts()).browserId, questionReadable: true, sourceFailed: 'capsule.inspect', independentOwnerRead: 'capsule.interaction.ls' }
  assert.equal(await evaluate('document.querySelector(".capsule-question textarea").value'), 'Trusted retained after unmount', 'True message unmount retains trusted editable bytes without resuming autosave')
  report.trustedEditor.remountBytes = 'Trusted retained after unmount'

  await writeFile(join(evidence!, `${phase}-metadata-unavailable.png`), (await win.webContents.capturePage()).toPNG())
  metadataUnavailable = false
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))},true,'light')`)
  win.setContentSize(420, 760); await delay(100)
  report.narrow = await facts()
  assert.ok(report.narrow.height <= 320)
  await writeFile(join(evidence!, `${phase}-narrow.png`), (await win.webContents.capturePage()).toPNG())
  win.setContentSize(1040, 820)
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))},true,'dark')`)
  await until('conversationCapsuleProbe.facts().ready', 'The original used page is still available before service shutdown')
  await owner.close()
  let stillServing = false
  try { stillServing = (await fetch((isolated.endpoint as any).url)).ok } catch { /* Actual private HTTP owner is stopped. */ }
  assert.equal(stillServing, false)
  await evaluate('conversationCapsuleProbe.unmount()')
  await until('!document.querySelector(".conversation-capsule")', 'The original message fully unmounts while its service is stopped')
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready && document.body.textContent.includes("The original page remains available")', 'The retained native document reconnects independently of unavailable service observation')
  assert.equal((await facts()).browserId, first.browserId)
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#draft").value'), 'Original unsent thought')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#count").textContent'), '1')
  report.stoppedServiceRemount = { stillServing, browserId: (await facts()).browserId, navigationId: navigation, retainedDraft: true }
  await writeFile(join(evidence!, `${phase}-stopped.png`), (await win.webContents.capturePage()).toPNG())
  report.passed = true
} catch (error) { report.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
  await writeFile(join(evidence!, `${phase}.native.json`), JSON.stringify(report, null, 2))
  if (win && !win.isDestroyed()) {
    report.bodyAtFailure = await Promise.race([win.webContents.executeJavaScript('({body:document.body.innerText,error:window.fixtureError,facts:window.conversationCapsuleProbe?.facts()})').catch(() => ''), delay(1000).then(() => 'observation unavailable')])
    await Promise.race([win.webContents.capturePage().then(image => writeFile(join(evidence!, `${phase}-failure.png`), image.toPNG())).catch(() => {}), delay(1000)])
  }
}
finally {
  await step('cleanup')
  try { if (report.previousFrontmostPid && await frontmost() === process.pid) { await focusProcess(report.previousFrontmostPid); report.focusReturned = true } } catch (error) { report.focusReturnIssue = String(error) }
  manager?.dispose(); windows?.dispose(); if (win && !win.isDestroyed()) win.destroy(); await owner?.close()
  report.remainingWindows = BrowserWindow.getAllWindows().length
  await writeFile(join(evidence!, `${phase}.native.json`), JSON.stringify(report, null, 2))
  // Let this imported ESM's evaluation settle before Electron tears down its loader.
  setImmediate(() => app.exit(report.passed ? 0 : 1))
}
