import { app, BaseWindow, BrowserWindow, ipcMain, webContents } from 'electron'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { createCapsuleBrowserDocument } from '../../../src/main/capsule-presentation'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'

const [html, profile, evidence, preload, cssProof] = process.argv.slice(2)
app.setPath('userData', profile!); app.on('window-all-closed', () => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const report: any = { passed: false, created: [], activations: [], phases: [], screenshots: [], windowFocus: [], userRunTouched: false,
  boundary: 'Actual Capsule HTTP owner, acquisition helper, BrowserViewManager, presentation lease and native frame capture. The original notice Hook reads/writes only a private Zustand UI acknowledgement receipt map; it owns no Runtime facts. No activation/input operation is authorized; renderer-only CDP focus emulation never replaces BrowserWindow.isFocused.' }
let owner: NodeCapsuleOwner | null = null, manager: BrowserViewManager | null = null, windows: WorkbenchWindows | null = null, win: BrowserWindow | null = null
try {
  await app.whenReady()
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  const source = join(profile!, 'source'); await mkdir(source, { recursive: true })
  await writeFile(join(source, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Original style proof page</title><style>html,body{margin:0;height:100%;font:15px/1.5 system-ui;color:#20392b}.half{position:absolute;top:0;bottom:0;width:50%}.left{left:0;background:rgb(217,238,226)}.right{right:0;background:rgb(225,235,248)}main{position:relative;padding:24px}h1{margin:0 0 12px;font-size:22px}p{max-width:420px}</style><div class="half left"></div><div class="half right"></div><main><h1>保存一页结果，留住完整上下文</h1><p>这是由原始 Capsule HTTP 服务提供的真实页面。对话卡片保留页面身份，阅读时展示同一个原生页面的画面。</p><p>Original Capsule · Live native preview</p></main>')
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(profile!, 'capsules') })
  const capsule = await owner.call('capsule.create', { operationId: 'style-entry-original', sourcePath: source, title: '一页 HTML 的持久生命：保存结果与原始阅读现场', mode: 'injected' })
  win = new BrowserWindow({ width: 1040, height: 1050, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  report.windowFocus.push({ stage: 'created', focused: win.isFocused(), visible: win.isVisible() })
  windows = new WorkbenchWindows(win, new WorkbenchWindowStore(join(profile!, 'windows.json')), () => [])
  manager = new BrowserViewManager(win, { defaultProfileId: () => 'unused', resolvePartition: () => 'unused' } as never,
    new BrowserRefLedgerStore(join(profile!, 'ledger.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  manager.setPresentationWindowOwner(document => windows!.windowForDocument(document))
  win.webContents.on('console-message', (event, _level, message) => { (report.console ??= []).push(event.message ?? message) })
  ipcMain.handle('capsule-proof', async (event, method, ...args) => {
    if (method === 'window') return windows!.rendererReady(event)
    if (method === 'capsule') return owner!.call(args[0], args[1])
    if (method === 'restore') return manager!.ensure(args[0], async () => { throw new Error('This private inline page has no cold Region') }, args[1])
    if (method === 'create') {
      const [id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId] = args
      const value = await createCapsuleBrowserDocument({ browsers: manager!, inspect: capsuleId => owner!.call('capsule.inspect', { capsuleId }) },
        { id, url, workspaceId, rememberedProfileId, mode, viewport, capsuleId })
      report.created.push({ id, capsuleId, navigationId: value.navigationId }); return value
    }
    if (method === 'registerPresentation') return manager!.registerPresentation(event.sender, event.senderFrame, args[0], event.senderFrame ? { processId: event.senderFrame.processId, frameToken: event.senderFrame.frameToken } : null)
    if (method === 'updatePresentation') return manager!.updatePresentation(event.sender, event.senderFrame, args[0], args[1])
    if (method === 'removePresentation') return manager!.removePresentation(event.sender, event.senderFrame, args[0])
    if (method === 'armPresentationCapture') return manager!.armPresentationCapture(event.sender, event.senderFrame, args[0])
    if (method === 'ackPresentationCapture') return manager!.ackPresentationCapture(event.sender, event.senderFrame, args[0], args[1])
    if (method === 'release') return manager!.release(args[0], args[1])
    if (method === 'activatePresentation') { report.activations.push(args); throw new Error('Native input activation is outside this CSS-only proof') }
    throw new Error('Unexpected stylesheet proof IO: ' + method)
  })
  const evaluate = (code: string) => win!.webContents.executeJavaScript(code, true)
  const facts = () => evaluate('conversationStyleProbe.facts()')
  const until = async (code: string, message: string) => {
    const deadline = Date.now() + 18000
    while (!await evaluate(code)) { assert.ok(Date.now() < deadline, message); await delay(30) }
    await delay(80)
  }
  const capture = async (name: string) => { await writeFile(join(evidence!, name + '.png'), (await win!.webContents.capturePage()).toPNG()); report.screenshots.push(name + '.png') }
  const assertGeometry = (value: any) => {
    assert.equal(value.headerDisplay, 'flex', 'The formal Capsule import must supply the real header layout')
    assert.ok(value.headerGap > 0)
    assert.ok(value.presentation.height >= 180 && value.presentation.height <= 320 && value.stage.height > 0,
      'The formal Capsule import must bound the presentation while keeping its actual native Stage positive')
    assert.equal(value.overflow, false)
    assert.ok(value.image.height > 0 && value.image.height <= 300, 'The formal Diagram import must bound the actual decoded image')
    assert.ok(value.image.height <= value.viewport.height / 2, 'The complete thumbnail must stay within half the actual viewport')
    assert.ok(Math.abs(value.image.width / value.image.height - value.image.naturalWidth / value.image.naturalHeight) < .003,
      'The original image must retain its complete natural aspect ratio')
  }
  const assertPixels = (value: any) => {
    assert.equal(value.ready, true, 'The actual native page must supply a decoded preview frame')
    for (const [index, expected] of [[0, [217, 238, 226]], [1, [225, 235, 248]]] as const) {
      assert.equal(value.pixels[index]?.[3], 255)
      for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(value.pixels[index][channel] - expected[channel]!) <= 6,
        'The actual preview pixels must come from the original Capsule HTTP page, not an empty or substituted surface')
    }
  }
  await win.loadFile(html!)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await until('Boolean(window.conversationStyleProbe)', 'The original production component fixture must mount')
  await evaluate(`conversationStyleProbe.show(${JSON.stringify(capsule.record.capsuleId)},'dark')`)
  await until('Boolean(document.querySelector(".browser-stage")) && conversationStyleProbe.facts().image?.naturalHeight===1200', 'Both original production consumers must mount')
  report.initialGeometry = await facts(); assertGeometry(report.initialGeometry)
  await until('conversationStyleProbe.facts().ready', 'The original native page preview did not provide a real frame; focus and capture state remain unconfirmed')
  const first = await facts(); assertPixels(first)
  const originalPage = webContents.getAllWebContents().find(contents => contents.getURL() === capsule.endpoint.url)!
  assert.ok(originalPage, 'The preview must belong to the original HTTP page owner')
  assert.equal(await originalPage.executeJavaScript('document.querySelector("h1").textContent'), '保存一页结果，留住完整上下文')
  report.original = { browserId: first.browserId, navigationId: report.created[0].navigationId, url: originalPage.getURL(), webContentsId: originalPage.id }
  for (const [name, width, height, theme] of [['wide-dark', 1040, 1050, 'dark'], ['narrow-light', 420, 1100, 'light'], ['wide-light', 1040, 1050, 'light']] as const) {
    win.setContentSize(width, height); await evaluate(`conversationStyleProbe.theme(${JSON.stringify(theme)})`)
    await until('conversationStyleProbe.facts().ready', 'The same original frame remains available after theme/viewport changes')
    const value = await facts(); assertGeometry(value); assertPixels(value)
    assert.equal(value.browserId, report.original.browserId); assert.ok(value.documentWidth <= width + 1)
    await capture(name); report.windowFocus.push({ stage: name, focused: win.isFocused(), visible: win.isVisible() })
  }
  await evaluate('document.querySelector(".md-diagram-image").click()')
  await until('conversationStyleProbe.facts().viewer?.naturalHeight===1200', 'The original production image viewer must open')
  report.viewer = await facts(); assert.equal(report.viewer.viewer.src, report.viewer.image.src); await capture('diagram-viewer')
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until('!conversationStyleProbe.facts().viewer', 'Escape must close the original viewer')
  assert.equal((await facts()).activeTrigger, true)
  // Replace the real stylesheet link on the same production DOM. No snapshots or surrogate Stage.
  for (const item of JSON.parse(await readFile(cssProof!, 'utf8'))) {
    await evaluate(`new Promise((resolve,reject)=>{const link=document.querySelector('link[rel="stylesheet"]');link.onload=()=>resolve(true);link.onerror=()=>reject(new Error('Stylesheet load failed'));link.href=${JSON.stringify(item.href)}})`)
    await delay(100)
    const value = await facts(); let failure: any
    try { assertGeometry(value) } catch (error) { failure = { name: (error as Error).name, message: (error as Error).message } }
    report.phases.push({ mode: item.mode, value, failure })
    if (item.mode === 'without-capsule') { assert.equal(failure?.name, 'AssertionError'); assert.match(failure.message, /formal Capsule import/) }
    else if (item.mode === 'without-diagram') { assert.equal(failure?.name, 'AssertionError'); assert.match(failure.message, /formal Diagram import/) }
    else { assert.equal(failure, undefined); await until('conversationStyleProbe.facts().ready', 'Restored formal CSS must recover the same original preview'); assertPixels(await facts()) }
  }
  assert.equal(report.phases.length, 4); assert.equal(report.created.length, 1); assert.equal(report.activations.length, 0)
  report.noticeReceipts = (await facts()).noticeReceipts
  assert.ok(report.noticeReceipts.selectors > 0 && report.noticeReceipts.reads > 0, 'The original notice consumer must actually read its private acknowledgement port')
  assert.equal(report.noticeReceipts.rejected, 0, 'The original notice consumer must not request any unrelated Store state or action')
  for (const value of report.windowFocus) { assert.equal(value.focused, false, 'The private proof must not take native window focus'); assert.equal(value.visible, false) }
  assert.equal((await facts()).browserId, report.original.browserId)
  await capture('restored'); report.passed = true
} catch (error) {
  report.failure = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }
  if (win && !win.isDestroyed()) {
    report.observation = await win.webContents.executeJavaScript('({hidden:document.hidden,focused:document.hasFocus(),facts:window.conversationStyleProbe?.facts(),videos:[...document.querySelectorAll("video")].map(video=>({readyState:video.readyState,paused:video.paused,streamActive:video.srcObject?.active,tracks:video.srcObject?.getTracks().map(track=>({state:track.readyState,muted:track.muted,settings:track.getSettings()}))}))})').catch(() => null)
    await writeFile(join(evidence!, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {})
  }
} finally {
  if (win && !win.isDestroyed()) report.windowFocus.push({ stage: 'cleanup', focused: win.isFocused(), visible: win.isVisible() })
  if (report.windowFocus.some((value: any) => value.focused || value.visible)) { report.passed = false; report.failure ??= { name: 'FocusConditionError', message: 'A private proof window acquired native focus or became visible' } }
  manager?.dispose(); windows?.dispose(); if (win && !win.isDestroyed()) win.destroy(); await owner?.close()
  report.remainingWindows = BaseWindow.getAllWindows().length
  await writeFile(join(evidence!, 'native.json'), JSON.stringify(report, null, 2))
  setImmediate(() => app.exit(report.passed ? 0 : 1))
}
