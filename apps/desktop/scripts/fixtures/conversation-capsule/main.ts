import { app, BrowserWindow, ipcMain, webContents } from 'electron'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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
const [html, profile, evidence, preload, phase = 'green', cssProofPath, scope = 'full'] = process.argv.slice(2)
const presentationOnly = scope === 'presentation'
app.setPath('userData', profile!)
app.on('window-all-closed', () => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const execute = promisify(execFile)
const frontmost = async () => Number((await execute('/usr/bin/osascript', ['-e', 'tell application "System Events"\nset originalProcess to first application process whose frontmost is true\nreturn unix id of originalProcess\nend tell'], { timeout: 10000 })).stdout.trim())
const focusProcess = async (pid: number) => { assert.ok(Number.isSafeInteger(pid) && pid > 0); await execute('/usr/bin/osascript', ['-e', `tell application "System Events"\nset originalProcess to first application process whose unix id is ${pid}\nset frontmost of originalProcess to true\nend tell`], { timeout: 10000 }) }
const report: any = { passed: false, phase, scope, created: [], releases: [], geometries: [], activations: [], windowFocus: [], userRunTouched: false,
  inputBoundary: presentationOnly ? 'Hidden native capture and actual Renderer controls only. CDP focus is not native Window input qualification. Native first press, used-page lifecycle and input clipping remain in the full scope.' : 'Full native first press and used-page lifecycle.' }
const title = 'Capsule · 一页 HTML 的持久生命：保存结果、在对话中阅读与原身份恢复'
const question = '关于 Capsule 架构，你希望接下来展开哪一部分？'
const draft = '我想先看：应用重启后，Core 如何找回原服务 Run 和页面？（页面预填草稿，等待本人在 App 控件中确认）\n同时希望保留原始 Session、页面中尚未提交的内容，以及已经保存的答案和操作身份。'
const editedDraft = `${draft}\n本人补充：先查看原服务的恢复路径。`
const retainedDraft = `${draft}\n这段输入尚未确认，切换阅读位置与窗口尺寸也应完整保留。`
const principal = { kind: 'user' as const, id: 'private-proof-human' }
const unknownDelivery = (prepared: any) => ({ status: 'unknown' as const, inputOperationId: prepared.inputOperationId,
  expectedRun: prepared.expectedRun, reason: 'The private input observation is unavailable. The original answer and operation are retained.' })
report.nativeScope = { pid: process.pid, profile, main: process.argv[1] }
const step = async (stage: string) => { report.stage = stage; await writeFile(join(evidence!, `${phase}.progress.json`), JSON.stringify(report, null, 2)) }
let owner: NodeCapsuleOwner | null = null, manager: BrowserViewManager | null = null, win: BrowserWindow | null = null, windows: WorkbenchWindows | null = null
let metadataUnavailable = false
try {
  await app.whenReady()
  await step('ready-before-native-focus-observation')
  if (presentationOnly) {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  } else {
    report.initialFrontmostPid = await frontmost()
    report.previousFrontmostPid = report.initialFrontmostPid
    if (process.platform === 'darwin') { app.setActivationPolicy('regular'); await app.dock!.show() }
  }
  await step('ready')
  const source = join(profile!, 'source'); await mkdir(source, { recursive: true })
  await writeFile(join(source, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Original page</title><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#edf4ef;color:#20392b;font:15px/1.5 system-ui}h1{font-size:24px;margin:0 0 12px}input{display:block;width:100%;padding:12px;border:1px solid #9cb4a4;border-radius:5px;background:#fff;font:inherit}button{margin-top:12px;padding:9px 15px;border:0;border-radius:5px;background:#2d6549;color:white;font:inherit}output{margin-left:10px}</style><h1>A saved result, right in the conversation</h1><input id="draft" aria-label="Page draft" placeholder="Keep a thought here"><button id="increment">Count</button><output id="count">0</output><p id="bridge"></p><script>let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++count);document.querySelector('#bridge').textContent=window.capsule?'Injected: original App SDK':'Isolated: independent page';</script>`)
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(profile!, 'capsules'), replies: {
    prepare: async ({ interaction, answer, inputOperationId, operationId }, context) => ({ version: 1, operationId,
      capsuleId: interaction.capsuleId, interactionId: interaction.interactionId, inputOperationId, target: interaction.target!,
      expectedRun: { runId: 'private-proof-run' }, principal: context.principal!, prompt: answer }),
    submit: async prepared => { (report.replySubmissions ??= []).push(structuredClone(prepared)); return unknownDelivery(prepared) },
    inspect: async prepared => unknownDelivery(prepared)
  } })
  const isolated = await owner.call('capsule.create', { operationId: 'create-isolated', sourcePath: source, title, mode: 'isolated' })
  const injected = await owner.call('capsule.create', { operationId: 'create-injected', sourcePath: source, title, mode: 'injected', target: { hostId: 'local', agentSessionId: 'private-proof-recipient' } })
  const unbound = await owner.call('capsule.create', { operationId: 'create-unbound', sourcePath: source, title, mode: 'injected' })
  win = new BrowserWindow({ width: 1040, height: 820, show: !presentationOnly, focusable: !presentationOnly, skipTaskbar: presentationOnly, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
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
    if (method === 'reply') { (report.replyRequests ??= []).push(structuredClone(args[0])); return owner!.call('capsule.interaction.reply', args[0], { principal }) }
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
    if (method === 'activatePresentation') { if (presentationOnly) { report.activations.push({ request: args[1] }); throw new Error('Native input activation is outside presentation-only scope') }; const result = await manager!.activatePresentation(event.sender, event.senderFrame, args[0], args[1]); (report.activations ??= []).push({ request: args[1], result }); return result }
    if (method === 'release') { const result = await manager!.release(args[0], args[1]); report.releases.push(result); return result }
    throw new Error('Unexpected private proof transport method: ' + method)
  })
  const evaluate = async (code: string) => {
    const result = await win!.webContents.executeJavaScript(code, true)
    // Presenting a different page models the reader returning to its start. Answer screenshots
    // may have scrolled the retained Feed; leave the explicit clipping scenario untouched.
    if (code.startsWith('conversationCapsuleProbe.set(')) await win!.webContents.executeJavaScript("(() => {const feed=document.querySelector('.activity-feed');if(feed)feed.scrollTop=0})()", true)
    return result
  }
  const until = async (expression: string, reason: string) => {
    const deadline = Date.now() + 25000
    while (!await evaluate(expression)) {
      if (Date.now() >= deadline) {
        report.mediaAtTimeout = await evaluate(`(() => {const video=document.querySelector('video'),stream=video?.srcObject;return {hidden:document.hidden,focused:document.hasFocus(),readyState:video?.readyState,paused:video?.paused,networkState:video?.networkState,streamActive:stream?.active,tracks:stream?.getTracks().map(track=>({kind:track.kind,enabled:track.enabled,muted:track.muted,readyState:track.readyState,settings:track.getSettings()}))}})()`)
        report.nativeAtTimeout = [...(manager as any).entries.values()].map((entry: any) => ({ id: entry.id, visible: entry.visible,
          nativeVisible: entry.view.getVisible(), bounds: entry.view.getBounds(), loading: entry.view.webContents.isLoading(),
          captureId: entry.captureId, url: entry.view.webContents.getURL() }))
        assert.fail(reason)
      }
      await delay(30)
    }
    await delay(50)
  }
  const facts = () => evaluate('conversationCapsuleProbe.facts()')
  const assertCardLayout = (value: any) => {
    assert.equal(value.layout.headerDisplay, 'flex', 'The formal Renderer CSS entry must supply the Capsule header layout')
    assert.ok(value.layout.headerGap > 0 && value.layout.actionsGap > 0, 'The original title, mode and actions must have visible spacing')
    assert.ok(value.presentationHeight >= 180 && value.presentationHeight <= 320 && value.height > 0, 'The actual card uses a bounded positive native page stage')
    assert.equal(value.layout.overflow, false, 'Long original titles and controls must stay within the card')
    const { title, mode } = value.layout
    if (title && mode) assert.ok(title.right <= mode.x + 1 || mode.right <= title.x + 1 || title.bottom <= mode.y + 1 || mode.bottom <= title.y + 1, 'The original title and mode badge must not overlap')
    for (const button of value.layout.buttons) assert.ok(button.width > 0 && button.height >= 24 && button.x >= value.layout.card.x - 1 && button.right <= value.layout.card.right + 1, 'Every original action must keep a readable hit target inside the card')
  }
  const assertFrame = (value: any) => {
    assert.equal(value.ready, true, 'The original native page must supply a decoded preview')
    const expected = [237, 244, 239, 255]
    for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(value.pixels[index] - expected[index]!) <= 6, 'The preview pixels must come from the actual original Capsule page')
  }
  const focusReader = async () => {
    if (presentationOnly) {
      const value = { focused: win!.isFocused(), visible: win!.isVisible() }; report.windowFocus.push(value)
      assert.equal(value.focused, false); assert.equal(value.visible, false); return
    }
    report.previousFrontmostPid ??= report.initialFrontmostPid
    app.show(); app.focus({ steal: true }); await focusProcess(process.pid)
    win!.show(); win!.moveTop(); win!.focus()
    win!.webContents.focus()
    const deadline = Date.now() + 5000
    while ((!win!.isFocused() || await frontmost() !== process.pid) && Date.now() < deadline) { win!.focus(); await delay(100) }
    const observed = { frontmost: await frontmost(), pid: process.pid, focused: win!.isFocused(),
      visible: win!.isVisible(), minimized: win!.isMinimized(), focusable: win!.isFocusable(), appHidden: app.isHidden(),
      focusedWindow: BrowserWindow.getFocusedWindow()?.id, focusedContents: webContents.getFocusedWebContents()?.id }
    ;(report.readerFocus ??= []).push(observed)
    assert.ok(observed.focused && observed.frontmost === process.pid, 'The loaded private reader must own focus before explicitly presenting the next page')
  }
  const captureAnswer = async (name: string) => {
    const value = await evaluate(`(() => {const form=document.querySelector('.capsule-question'),actions=form?.querySelector('.capsule-question__actions'),answer=form?.querySelector('textarea');if(!form||!actions||!answer)throw new Error('The original answer form must exist');actions.scrollIntoView({block:'center'});answer.scrollTop=0;return true})()`)
    assert.equal(value, true)
    await delay(100)
    const visible = await evaluate(`(() => {const form=document.querySelector('.capsule-question'),answer=form.querySelector('textarea'),actions=form.querySelector('.capsule-question__actions'),chrome=form.closest('.capsule-chrome'),feed=form.closest('.activity-feed');const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}};const a=rect(answer),b=rect(actions),c=rect(chrome),d=rect(feed),top=Math.max(0,c.top,d.top),bottom=Math.min(innerHeight,c.bottom,d.bottom);return {answer:a,actions:b,top,bottom,answerVisible:a.bottom>top&&a.top<bottom,actionsVisible:b.top>=top-1&&b.bottom<=bottom+1}})()`)
    assert.ok(visible.answerVisible && visible.actionsVisible, 'The actual screenshot must expose the original draft and its confirmation or inspection actions')
    ;(report.answerViews ??= []).push({ name, visible })
    await writeFile(join(evidence!, `${phase}-${name}-answer.png`), (await win!.webContents.capturePage()).toPNG())
  }
  await win.loadFile(html!)
  if (presentationOnly) { win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }) }
  const hostClick = async (point: { x: number; y: number }) => {
    if (presentationOnly) {
      await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await win!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    } else {
      win!.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      win!.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
  }
  const hostAction = async (label: string) => {
    const point = await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')??node.textContent.trim())===${JSON.stringify(label)});if(!button)throw new Error('Missing original Host action');button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    await hostClick(point)
  }
  const hostText = async (text: string) => {
    if (presentationOnly) await win!.webContents.debugger.sendCommand('Input.insertText', { text })
    else await win!.webContents.insertText(text)
  }
  await step('renderer-loaded')
  await until('Boolean(window.conversationCapsuleProbe)', 'The real conversation fixture must mount')
  await step('fixture-mounted')
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify('```mermaid\nflowchart TD\n A-->B-->C-->D-->E-->F-->A\n```')},true,'light')`)
  await until('conversationCapsuleProbe.facts().diagram?.naturalHeight===1200', 'The production Markdown host must decode the retained vector output')
  const thumbnail = (await facts()).diagram
  assert.ok(thumbnail.height <= 300 && thumbnail.height <= 820 / 2, 'The formal Renderer entry must bound the complete diagram thumbnail')
  await evaluate('document.querySelector(".md-diagram-image").click()')
  await until('conversationCapsuleProbe.facts().diagram?.full?.naturalHeight===1200', 'The original production viewer must open the complete vector output')
  report.diagram = await facts()
  assert.equal(report.diagram.diagram.full.src, thumbnail.src, 'The viewer reuses the original renderer output without another engine or read')
  await writeFile(join(evidence!, `${phase}-diagram-viewer.png`), (await win.webContents.capturePage()).toPNG())
  if (presentationOnly) {
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  } else { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }) }
  await until('!document.querySelector(".md-conversation-image__lightbox")', 'Escape closes the original viewer')
  assert.equal((await facts()).diagram.activeTrigger, true, 'Viewer close restores the original diagram trigger')
  assert.equal(report.created.length, 0, 'Diagram viewing must not acquire another native Browser')
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify('Page ' + 'amux://capsule/' + isolated.record.capsuleId)})`)
  await delay(100); assert.equal(report.created.length, 0, 'An ordinary Capsule link cannot acquire a native page')
  const content = (id: string) => `![${title}](amux://capsule/${id})`
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('!!document.querySelector(".browser-stage")', 'The real Capsule consumer must mount its original Stage before capture')
  report.initialLayout = await facts(); assertCardLayout(report.initialLayout)
  const verifyStyles = async (capsuleId: string) => { if (phase === 'green' && cssProofPath) {
    // The answer panel otherwise pushes the diagram below the real visible-work boundary.
    if (await evaluate(`Boolean(document.querySelector('[aria-label="Page questions"][aria-expanded="true"]'))`)) {
      await hostAction('Page questions')
      await until(`document.querySelector('[aria-label="Page questions"]')?.getAttribute('aria-expanded') === 'false'`, 'Collapse the original question panel so both CSS consumers are in the reading viewport')
    }
    await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(capsuleId) + '\n\n```mermaid\nflowchart TD\n A-->B-->C-->D-->E-->F-->A\n```')})`)
    await until('conversationCapsuleProbe.facts().ready && conversationCapsuleProbe.facts().diagram?.naturalHeight===1200', 'Both current production consumers must mount before CSS counterexamples')
    const original = await facts(), created = report.created.length
    report.cssProof = { boundary: 'Current formal Desktop CSS applied to the same actual production DOM and native capture owner, without snapshots.', phases: [] }
    await evaluate(`(() => {const link=document.querySelector('link[rel="stylesheet"]');if(!link)throw new Error('Formal stylesheet link is required');window.originalProofStylesheet=link;const style=document.createElement('style');style.id='formal-style-counterexample';document.head.append(style)})()`)
    try {
      for (const item of JSON.parse(await readFile(cssProofPath, 'utf8'))) {
        await evaluate(`(() => {document.getElementById('formal-style-counterexample').textContent=${JSON.stringify(item.css)};window.originalProofStylesheet.disabled=true})()`)
        await delay(100)
        const value = await facts(); let failure: any
        try {
          assert.equal(value.layout.headerDisplay, 'flex', 'The formal Capsule stylesheet import must provide the header layout')
          assert.ok(value.presentationHeight >= 180 && value.presentationHeight <= 320 && value.height > 0, 'The formal Capsule stylesheet import must provide bounded positive page geometry')
          assert.ok(value.diagram.height <= 300 && value.diagram.height <= value.viewport.height / 2, 'The formal diagram stylesheet import must cap the retained thumbnail height')
        } catch (error) { failure = { name: (error as Error).name, message: (error as Error).message } }
        report.cssProof.phases.push({ mode: item.mode, sourceSHA256: item.sourceSHA256, loadedSHA256: item.loadedSHA256, value, failure })
        if (item.mode === 'without-capsule') { assert.equal(failure?.name, 'AssertionError'); assert.match(failure.message, /formal Capsule stylesheet import/) }
        else if (item.mode === 'without-diagram') { assert.equal(failure?.name, 'AssertionError'); assert.match(failure.message, /formal diagram stylesheet import/) }
        else { assert.equal(failure, undefined, failure?.message); await until('conversationCapsuleProbe.facts().ready', 'Restored CSS must preserve the original decoded page'); assertFrame(await facts()) }
        assert.equal(value.browserId, original.browserId); assert.equal(report.created.length, created)
      }
    } finally { await evaluate(`window.originalProofStylesheet.disabled=false;document.getElementById('formal-style-counterexample').remove()`) }
  } }
  await until('conversationCapsuleProbe.facts().ready', 'Actual native WebContentsView capture must decode into the production card video')
  await step('native-video-ready')
  const first = await facts(); report.isolated = first; assertFrame(first)
  const createdBeforeFrame = report.created.length
  await until('conversationCapsuleProbe.facts().cachedFrame?.startsWith("data:image/")', 'The actual timeline hook must cache an already-painted native video keyframe')
  report.nativeKeyframe = { srcPrefix: (await facts()).cachedFrame.slice(0, 40), createdBefore: createdBeforeFrame, createdAfter: report.created.length }
  assert.equal(report.created.length, createdBeforeFrame, 'Caching a painted native page must not acquire another Browser')
  assertCardLayout(first)
  await evaluate("conversationCapsuleProbe.click('Expand')")
  await until('conversationCapsuleProbe.facts().height>320', 'Expand must give the original live page a larger bounded reading surface')
  report.expanded = await facts()
  assert.ok(report.expanded.height <= 700 && report.expanded.browserId === first.browserId)
  assert.equal(report.created.length, createdBeforeFrame, 'Expanding the original stage must not acquire another Browser')
  await writeFile(join(evidence!, `${phase}-expanded.png`), (await win.webContents.capturePage()).toPNG())
  await evaluate("conversationCapsuleProbe.click('Compact')")
  await until('conversationCapsuleProbe.facts().height<=320 && conversationCapsuleProbe.facts().ready', 'Compact restores the original bounded live stage')
  const nativePage = webContents.getAllWebContents().find(contents => contents.getURL() === (isolated.endpoint as any).url)!
  assert.ok(nativePage, 'The page comes from an actual native owner, not a screenshot fixture')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("h1").textContent'), 'A saved result, right in the conversation')
  assert.equal(await nativePage.executeJavaScript('Boolean(window.capsule)'), false)
  await until('conversationCapsuleProbe.facts().ready && !document.querySelector(".browser-presentation-notice button")', 'The original Stage must finish its capture and playback handshake before trusted input')
  await delay(200)
  const navigation = report.created[0].navigationId
  if (!presentationOnly) {
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
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready', 'The remounted original message reconnects its retained native owner')
  assert.equal((await facts()).browserId, first.browserId, 'Message remount must preserve its exact native presentation identity')
  assert.equal(report.created.at(-1).navigationId, navigation)
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#draft").value'), 'Original unsent thought')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#count").textContent'), '1')
  }
  await writeFile(join(evidence!, `${phase}-isolated.png`), (await win.webContents.capturePage()).toPNG())
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready && document.querySelector(".conversation-capsule__mode")?.textContent==="Injected"', 'Injected native page and trusted chrome must mount')
  const connected = webContents.getAllWebContents().find(contents => contents.getURL() === (injected.endpoint as any).url)!
  assert.ok(connected)
  report.injectedCapabilities = await connected.executeJavaScript('capsule.capabilities()')
  assert.equal(report.injectedCapabilities.interaction, true); assert.equal(report.injectedCapabilities.humanReply, false)
  await connected.executeJavaScript(`capsule.request(${JSON.stringify(question)}, ${JSON.stringify(draft)}, capsule.createOperationId())`)
  await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
  await until(`document.body.textContent.includes(${JSON.stringify(question)})`, 'Trusted original question must be readable from the card')
  report.pending = await facts(); assertCardLayout(report.pending)
  assert.equal(report.pending.questions[0].answer, draft, 'The complete long Chinese draft must remain in the original trusted editor')
  assert.ok(report.pending.layout.questionChip.includes('Questions'), 'Embedded questions must use the concise host chip')
  await evaluate("conversationCapsuleProbe.click('Open in Browser')")
  assert.equal(report.opened, `amux://capsule/${injected.record.capsuleId}`, 'The original explicit Browser action retains the exact Capsule link')
  assert.ok((await owner.call('capsule.interaction.ls', { capsuleId: injected.record.capsuleId })).interactions.length === 1)
  await writeFile(join(evidence!, `${phase}-injected.png`), (await win.webContents.capturePage()).toPNG())
  await captureAnswer('injected')
  const trustedEditor = await evaluate(`(() => { const node=document.querySelector('.capsule-question textarea'); window.originalTrustedEditor=node; node.scrollIntoView({block:'nearest'}); const r=node.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
  await hostClick(trustedEditor)
  assert.equal(await evaluate('document.activeElement===window.originalTrustedEditor'), true, 'The trusted original host question must actually own keyboard focus')
  await evaluate('window.originalTrustedEditor.select()'); await hostText(editedDraft)
  await evaluate("conversationCapsuleProbe.click('Hide')")
  assert.equal(await evaluate('window.originalTrustedEditor.isConnected'), true, 'Hide keeps the original trusted host editor connected')
  await evaluate("conversationCapsuleProbe.click('Show page')")
  assert.equal(await evaluate('document.querySelector(".capsule-question textarea")===window.originalTrustedEditor'), true)
  assert.equal(await evaluate('window.originalTrustedEditor.value'), editedDraft)
  report.trustedEditor = { actualKeyboardInput: true, hideShowSameNode: true, bytes: editedDraft, retentionPort: 'private memory port; actual Workbench writer verified by T004' }
  metadataUnavailable = !presentationOnly
  await evaluate('window.originalTrustedEditor.focus();window.originalTrustedEditor.select()'); await hostText(retainedDraft)
  await evaluate('conversationCapsuleProbe.unmount()')
  await until('!document.querySelector(".conversation-capsule")', 'The injected original message fully unmounts')
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))})`)
  await until(`conversationCapsuleProbe.facts().ready && !!document.querySelector('[aria-label="Page questions"]')`, 'Original questions remain reachable after native restore despite failed page metadata')
  await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
  if (presentationOnly) {
    await until(`conversationCapsuleProbe.facts().questions[0]?.answer===${JSON.stringify(retainedDraft)}`, 'The original Host draft must survive a real message remount')
    await until("Boolean([...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Refresh' && !button.disabled))", 'The original Refresh action must be available before injecting a metadata failure')
    metadataUnavailable = true; await evaluate("conversationCapsuleProbe.click('Refresh')")
  }
  await until(`document.body.textContent.includes(${JSON.stringify(question)}) && document.body.textContent.includes("Original page metadata observation is unavailable")`, 'Independent saved-question reads survive metadata failure')
  report.injectedMetadataFailure = { browserId: (await facts()).browserId, questionReadable: true, sourceFailed: 'capsule.inspect', scenario: presentationOnly ? 'visible original page refresh after Host draft remount' : 'used original page remount', independentOwnerRead: 'capsule.interaction.ls' }
  assert.equal(await evaluate('document.querySelector(".capsule-question textarea").value'), retainedDraft, 'True message unmount retains trusted editable bytes without resuming autosave')
  report.trustedEditor.remountBytes = retainedDraft

  await writeFile(join(evidence!, `${phase}-metadata-unavailable.png`), (await win.webContents.capturePage()).toPNG())
  await until("Boolean([...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Refresh' && !button.disabled))", 'The original failed metadata refresh must settle before recovery')
  metadataUnavailable = false
  await focusReader()
  if (!presentationOnly) await evaluate("conversationCapsuleProbe.click('Retry original page')")
  await until("Boolean([...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Refresh' && !button.disabled))", 'The original Refresh action must be available for explicit recovery')
  await evaluate("conversationCapsuleProbe.click('Refresh')")
  await until('conversationCapsuleProbe.facts().ready && !conversationCapsuleProbe.facts().text.includes("Original page metadata observation is unavailable")', 'The explicit original-page retry and question refresh clear the recovered metadata observation')
  report.presentationCases = []
  for (const [name, width, height, theme] of [['wide-light', 1040, 820, 'light'], ['wide-dark', 1040, 820, 'dark'], ['narrow', 420, 760, 'light'], ['short', 1040, 480, 'dark']] as const) {
    win.setContentSize(width, height)
    await focusReader()
    await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))},true,${JSON.stringify(theme)})`)
    await evaluate("document.querySelector('.activity-feed').scrollTop=0;document.querySelector('.capsule-chrome').scrollTop=0")
    await delay(120)
    await until('conversationCapsuleProbe.facts().ready', 'The original native frame remains readable across viewport and theme changes')
    const value = await facts(); assertCardLayout(value); assertFrame(value)
    assert.equal(value.appearance, theme)
    assert.equal(value.questions[0].answer, retainedDraft, 'Presentation changes retain the original unsent editor bytes')
    report.presentationCases.push({ name, value })
    await writeFile(join(evidence!, `${phase}-${name}.png`), (await win.webContents.capturePage()).toPNG())
    await captureAnswer(name)
  }
  win.setContentSize(1040, 820)
  await delay(80)
  await hostAction('Confirm answer')
  await until('conversationCapsuleProbe.facts().text.includes("input unconfirmed")', 'An actual private-owner unknown delivery remains visible with its saved answer')
  report.unknown = await facts()
  assert.equal(report.replySubmissions.length, 1)
  assert.equal(report.unknown.questions[0].answer, retainedDraft)
  assert.equal(report.unknown.questions[0].readOnly, true)
  const savedUnknown = (await owner.call('capsule.interaction.inspect', { capsuleId: injected.record.capsuleId,
    interactionId: report.replySubmissions[0].interactionId })).interaction
  assert.equal(savedUnknown.answer, retainedDraft)
  assert.ok(savedUnknown.reply)
  assert.equal(savedUnknown.reply.delivery.status, 'unknown', 'The UI unknown state must consume the private owner structured result')
  assert.equal(savedUnknown.reply.operationId, report.replyRequests[0].operationId)
  assert.equal(savedUnknown.reply.delivery.inputOperationId, report.replySubmissions[0].inputOperationId)
  report.unknownSaved = savedUnknown
  if (presentationOnly) {
    await evaluate('conversationCapsuleProbe.unmount()')
    await until('!document.querySelector(".conversation-capsule")', 'The unknown Host answer message must actually unmount')
    await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(injected.record.capsuleId))})`)
    await until(`conversationCapsuleProbe.facts().ready && !!document.querySelector('[aria-label="Page questions"]')`, 'The original Capsule questions must return after message remount')
    await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
    await until('conversationCapsuleProbe.facts().text.includes("input unconfirmed")', 'The exact saved unknown answer must remain inspectable after remount')
    assert.equal((await facts()).questions[0].answer, retainedDraft)
    const restored = (await owner.call('capsule.interaction.inspect', { capsuleId: injected.record.capsuleId, interactionId: savedUnknown.interactionId })).interaction
    assert.equal(restored.reply?.operationId, savedUnknown.reply.operationId)
    assert.equal(restored.reply?.delivery.inputOperationId, savedUnknown.reply.delivery.inputOperationId)
    report.unknownRemount = { originalOperationId: restored.reply?.operationId, originalInputOperationId: restored.reply?.delivery.inputOperationId, bytes: restored.answer }
  }
  await hostAction('Inspect original operation')
  await delay(100)
  assert.equal(report.replySubmissions.length, 1, 'Inspection of the exact unknown operation must not resend its answer')
  const operation = await owner.call('capsule.operation.inspect', { operationId: report.replyRequests[0].operationId })
  report.unknownOperation = { operationId: operation.operation?.operationId, submissions: report.replySubmissions.length,
    inputOwnerBoundary: 'Private prepared-input port returns explicit unknown; no user Core Session or Run is called.' }
  assert.equal(report.unknownOperation.operationId, report.replyRequests[0].operationId)
  await writeFile(join(evidence!, `${phase}-unknown.png`), (await win.webContents.capturePage()).toPNG())
  await captureAnswer('unknown')
  await owner.call('capsule.interaction.request', { capsuleId: unbound.record.capsuleId, operationId: 'request-without-recipient', question, draft })
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(unbound.record.capsuleId))},true,'dark')`)
  await until(`conversationCapsuleProbe.facts().ready && !!document.querySelector('[aria-label="Page questions"]')`, 'The original unbound private page is displayed')
  await evaluate(`document.querySelector('[aria-label="Page questions"]').click()`)
  await until(`conversationCapsuleProbe.facts().questions[0]?.answer===${JSON.stringify(draft)}`, 'An unbound original request retains its complete draft')
  report.noRecipient = await facts(); assertCardLayout(report.noRecipient)
  const unboundRequest = (await owner.call('capsule.interaction.ls', { capsuleId: unbound.record.capsuleId })).interactions[0]!
  assert.equal(unboundRequest.target, undefined, 'The no-recipient form must consume a genuinely unbound original owner record')
  assert.equal(report.noRecipient.questions[0].confirmDisabled, true, 'A missing original recipient disables only this explicit confirmation')
  assert.equal(report.replySubmissions.length, 1, 'Displaying an unbound request must not submit any input')
  await writeFile(join(evidence!, `${phase}-no-recipient.png`), (await win.webContents.capturePage()).toPNG())
  await captureAnswer('no-recipient')
  if (!presentationOnly) {
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))},true,'dark')`)
  await until('conversationCapsuleProbe.facts().ready', 'The original used page is still available before service shutdown')
  await owner.close()
  let stillServing = false
  try { stillServing = (await fetch((isolated.endpoint as any).url)).ok } catch { /* Actual private HTTP owner is stopped. */ }
  assert.equal(stillServing, false)
  await evaluate('conversationCapsuleProbe.unmount()')
  await until('!document.querySelector(".conversation-capsule")', 'The original message fully unmounts while its service is stopped')
  await focusReader()
  await evaluate(`conversationCapsuleProbe.set(${JSON.stringify(content(isolated.record.capsuleId))})`)
  await until('conversationCapsuleProbe.facts().ready && document.body.textContent.includes("The original page remains available")', 'The retained native document reconnects independently of unavailable service observation')
  assert.equal((await facts()).browserId, first.browserId)
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#draft").value'), 'Original unsent thought')
  assert.equal(await nativePage.executeJavaScript('document.querySelector("#count").textContent'), '1')
  report.stoppedServiceRemount = { stillServing, browserId: (await facts()).browserId, navigationId: navigation, retainedDraft: true }
  await writeFile(join(evidence!, `${phase}-stopped.png`), (await win.webContents.capturePage()).toPNG())
  }
  await verifyStyles(presentationOnly ? unbound.record.capsuleId : isolated.record.capsuleId)
  if (presentationOnly) {
    await focusReader(); assert.equal(report.activations.length, 0)
    report.noticeReceipts = (await facts()).noticeReceipts
    assert.ok(report.noticeReceipts.selectors > 0 && report.noticeReceipts.reads > 0 && report.noticeReceipts.writes > 0); assert.equal(report.noticeReceipts.rejected, 0)
  }
  report.unusedAvatarCalls = (await facts()).unusedAvatarCalls
  assert.equal(report.unusedAvatarCalls, 0, 'The real supplied provider avatar must keep the global identity fallback unused')
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
  try {
    if (presentationOnly) {
      if (win && !win.isDestroyed()) { const value = { focused: win.isFocused(), visible: win.isVisible() }; report.windowFocus.push(value); assert.equal(value.focused, false); assert.equal(value.visible, false) }
    } else {
    const before = await frontmost()
    if (report.previousFrontmostPid && before === process.pid) await focusProcess(report.previousFrontmostPid)
    const observed = await frontmost()
    report.focusRestoration = { original: report.previousFrontmostPid, before, observed, userFocusPreserved: before !== process.pid }
    report.focusReturned = observed === report.previousFrontmostPid
    }
  } catch (error) { report.focusReturnIssue = String(error); if (presentationOnly) report.passed = false }
  manager?.dispose(); windows?.dispose(); if (win && !win.isDestroyed()) win.destroy(); await owner?.close()
  report.remainingWindows = BrowserWindow.getAllWindows().length
  await writeFile(join(evidence!, `${phase}.native.json`), JSON.stringify(report, null, 2))
  // Let this imported ESM's evaluation settle before Electron tears down its loader.
  setImmediate(() => app.exit(report.passed ? 0 : 1))
}
