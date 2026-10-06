import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, type WebContentsView } from 'electron'
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
  passed: false, cases: [], images: [], warnings: [], calls: [], publications: [], clipboard: [], clipboardText: [], captures: [],
  counters: { rendererCapture: 0, rendererEncode: 0, originalCapture: 0 }
}
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, server: Server
let original: WebContentsView, sibling: WebContentsView, originalSnapshot: any, siblingSnapshot: any
let baseUrl: string
let publicServer: AgentMuxControlServer
let scriptCapture: any
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = (code: string) => window.webContents.executeJavaScript(code)
async function stage(value: string) {
  const progress = { label, pid: process.pid, stage: value, at: Date.now() }
  receipt.stages ??= []; receipt.stages.push(progress)
  await writeFile(join(out, label + '.progress.json'), JSON.stringify(progress))
  process.stdout.write(value + '\n')
}
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
  const point = await evaluate(`(()=>{const root=${insideEditor ? "document.querySelector('.image-annotation-editor')" : 'document'},button=[...root.querySelectorAll('button,[role="menuitem"]')].find(b=>(b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)})&&b.getBoundingClientRect().width>0);if(!button)return null;const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:button.disabled}})()`)
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
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, samples = 12) {
  await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, 'left')
  for (let i = 1; i <= samples; i++) await mouse('mouseMoved', from.x + (to.x - from.x) * i / samples, from.y + (to.y - from.y) * i / samples, 'left')
  await mouse('mouseReleased', to.x, to.y, 'left'); await settle()
}
async function fillField(name: string, text: string) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`[aria-label="${name}"]`)});if(!e)return null;const r=e.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}}const x=(left+right)/2,y=(top+bottom)/2;return right>left&&bottom>top?{x,y,hit:document.elementFromPoint(x,y)===e}:null})()`)
  assert.equal(point?.hit, true, 'The visible input point names this exact real field: ' + name)
  assert.ok(point, 'The actual editable field exists: ' + name)
  await mouse('mousePressed', point.x, point.y, 'left'); await mouse('mouseReleased', point.x, point.y, 'left')
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, ...(type === 'keyDown' ? { commands: ['selectAll'] } : {}) })
  await window.webContents.debugger.sendCommand('Input.insertText', { text })
  await until('the real Note field consumes input', async () => await evaluate(`window.screenshotProbe.field(${JSON.stringify(name)})`) === text)
  await settle()
}
async function capabilityEdits(opened: any) {
  const box = opened.canvas
  const from = { x: box.x + 40, y: box.y + 45 }, to = { x: box.x + 120, y: box.y + 70 }
  await drag(from, to)
  const beforeMove = await evaluate('window.screenshotProbe.inkPixels()')
  assert.ok(beforeMove.count > 100 && beforeMove.redBounds, 'The actual object exists before selecting it')
  await click('Select', true)
  await drag(from, { x: from.x + 50, y: from.y + 55 })
  const afterMove = await evaluate('window.screenshotProbe.inkPixels()')
  const sx = afterMove.width / box.width, sy = afterMove.height / box.height
  assert.ok(Math.abs(afterMove.redBounds.x - beforeMove.redBounds.x - 50 * sx) < 5 && Math.abs(afterMove.redBounds.y - beforeMove.redBounds.y - 55 * sy) < 5,
    'actual-Select-move-must-move-the-original-ink')
  await click('Delete selected', true); await settle()
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count < 20, 'The actual selected object is deleted')
  await click('Undo', true); await settle()
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count > 100, 'Undo restores the original moved object')
  await click('Erase', true)
  const movedStart = { x: from.x + 50, y: from.y + 55 }; await drag(movedStart, movedStart, 1)
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count < 20, 'The actual Erase tool removes the original hit object')
  await click('Undo', true); await settle()
  const pattern = await original.webContents.executeJavaScript('(()=>{const r=document.querySelector("#pattern").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()')
  const nativeBounds = original.getBounds(), zoom = original.webContents.getZoomFactor()
  const patch = { x: pattern.x * zoom / nativeBounds.width * box.width,
    y: pattern.y * zoom / nativeBounds.height * box.height,
    width: pattern.width * zoom / nativeBounds.width * box.width, height: pattern.height * zoom / nativeBounds.height * box.height }
  // Inspect the interior of the real captured striped patch, excluding edit handles/borders.
  const interior = { x: patch.x + 8, y: patch.y + 8, width: patch.width - 16, height: patch.height - 16 }
  await click('Pixelate', true); await settle()
  const beforeMask = await evaluate(`window.screenshotProbe.patchStats(${JSON.stringify(interior)})`)
  assert.ok(beforeMask.transitions > beforeMask.adjacent * 0.15, 'The actual source patch contains visible fine structure')
  await drag({ x: box.x + patch.x - 2, y: box.y + patch.y - 2 }, { x: box.x + patch.x + patch.width + 2, y: box.y + patch.y + patch.height + 2 })
  const afterMask = await evaluate(`window.screenshotProbe.patchStats(${JSON.stringify(interior)})`)
  assert.ok(afterMask.opaque > afterMask.width * afterMask.height * 0.99 && afterMask.transitions < beforeMask.transitions * 0.7,
    'actual-Pixelate-must-replace-fine-source-pixels-with-blocks')
  await click('Numbered note', true)
  const notePoint = { x: box.x + box.width * 0.72, y: box.y + box.height * 0.58 }
  await drag(notePoint, { x: box.x + box.width * 0.88, y: box.y + box.height * 0.78 })
  await fillField('Note text', 'Check original control')
  await click('Copy context', true)
  await until('the actual context handler writes its private text receipt', async () => receipt.clipboardText.length === 1)
  assert.ok(receipt.clipboardText[0].includes('Check original control') && receipt.clipboardText[0].includes(baseUrl + '/original'),
    'The actual edited note and original source reach Copy context')
  const parseContext = (text: string) => JSON.parse(text.slice(text.indexOf('{')))
  const firstContext = parseContext(receipt.clipboardText[0]), captured = receipt.captures.at(-1)
  assert.equal(firstContext.browserId, originalId); assert.equal(firstContext.navigationId, originalSnapshot.navigationId)
  assert.deepEqual(firstContext.source, captured.source)
  assert.deepEqual(firstContext.originalImagePixels, { width: captured.image.width, height: captured.image.height })
  assert.deepEqual(firstContext.annotations.map((annotation: any) => annotation.kind).sort(), ['note', 'pen', 'pixelate'])
  const firstNote = firstContext.annotations.find((annotation: any) => annotation.kind === 'note')
  assert.equal(firstNote.number, 1); assert.equal(firstNote.note, 'Check original control')
  await shot('tools-note-pixelate')
  await click('Copy PNG', true)
  await until('first real edited PNG keeps the Editor', async () => receipt.clipboard.length === 1 && (await facts()).editor && !(await facts()).copying)
  const uncropped = receipt.clipboard[0]
  assert.deepEqual(firstContext.outputPng, { width: uncropped.width, height: uncropped.height })
  await click('Crop', true); await settle()
  const cropBox = (await facts()).canvas
  await drag({ x: cropBox.x + 20, y: cropBox.y + 20 }, { x: cropBox.x + cropBox.width - 20, y: cropBox.y + cropBox.height - 20 })
  await click('Copy PNG', true)
  await until('the actual crop reaches the private PNG consumer', async () => receipt.clipboard.length === 2 && !(await facts()).copying)
  const cropped = receipt.clipboard[1]
  assert.ok(cropped.width < uncropped.width && cropped.height < uncropped.height,
    'actual-Crop-must-change-the-consumed-PNG-dimensions')
  await click('Copy context', true)
  await until('the same cropped document reaches the context consumer', async () => receipt.clipboardText.length === 2)
  assert.ok(receipt.clipboardText[1].includes('Check original control'))
  const croppedContext = parseContext(receipt.clipboardText[1])
  assert.deepEqual(croppedContext.outputPng, { width: cropped.width, height: cropped.height })
  const croppedNote = croppedContext.annotations.find((annotation: any) => annotation.kind === 'note')
  assert.equal(croppedNote.id, firstNote.id)
  for (const axis of ['x', 'y']) assert.ok(Math.abs(croppedNote.pngPixels[axis] -
    (croppedNote.originalImagePixels[axis] * croppedContext.transform.sourceScale - croppedContext.transform.cropOffsetPixels[axis]) * croppedContext.transform.finalScale[axis]) < 0.000001,
    'Copied note coordinates use the same crop/scale as the actual PNG')
  receipt.cases.push({ label: 'actual-tools-move-delete-erase-pixelate-note-crop-and-context', beforeMove, afterMove, beforeMask, afterMask,
    clipboard: receipt.clipboard.slice(), context: [firstContext, croppedContext], after: await facts() })
  // Trusted tools change the same processed output; hidden/masked note text must
  // disappear from the actual context consumer, then Undo restores that original note.
  await click('Crop', true)
  const hiddenBox = (await facts()).canvas
  await drag({ x: hiddenBox.x + 3, y: hiddenBox.y + 3 }, { x: hiddenBox.x + hiddenBox.width * 0.35, y: hiddenBox.y + hiddenBox.height * 0.3 })
  await click('Copy context', true)
  await until('the actual cropped-away note is absent from context', async () => receipt.clipboardText.length === 3)
  const hiddenContext = parseContext(receipt.clipboardText[2])
  assert.ok(!hiddenContext.annotations.some((annotation: any) => annotation.id === firstNote.id))
  assert.ok(!receipt.clipboardText[2].includes('Check original control'))
  await click('Undo', true); await settle(); await click('Pixelate', true)
  const maskedBox = (await facts()).canvas, natural = firstNote.originalImagePixels
  const map = (x: number, y: number) => ({ x: maskedBox.x + x / captured.image.width * maskedBox.width,
    y: maskedBox.y + y / captured.image.height * maskedBox.height })
  await drag(map(natural.x - 12, natural.y - 12), map(natural.x + natural.width + 12, natural.y + natural.height + 12))
  await click('Copy context', true)
  await until('the actual pixelate-covered note is absent from context', async () => receipt.clipboardText.length === 4)
  const maskedContext = parseContext(receipt.clipboardText[3])
  assert.ok(!maskedContext.annotations.some((annotation: any) => annotation.id === firstNote.id))
  assert.ok(!receipt.clipboardText[3].includes('Check original control'))
  assert.equal(maskedContext.annotations.filter((annotation: any) => annotation.kind === 'pixelate').length, 2)
  await click('Undo', true); await click('Copy context', true)
  await until('Undo restores the original note in the actual context', async () => receipt.clipboardText.length === 5)
  const restoredContext = parseContext(receipt.clipboardText[4])
  assert.deepEqual(restoredContext.annotations, croppedContext.annotations)
  assert.deepEqual(restoredContext.outputPng, croppedContext.outputPng)
  receipt.cases.push({ label: 'actual-crop-hidden-pixelate-masked-note-context-and-Undo', hiddenContext, maskedContext, restoredContext })
}
async function visualScene(kind: string, width: number, height: number, appearance: 'dark' | 'light') {
  window.setContentSize(width, height)
  assert.equal((await evaluate(`window.screenshotProbe.appearance(${JSON.stringify(appearance)})`)).applied, true)
  await settle(); const opened = await openEditor(), box = opened.canvas
  await click('Numbered note', true)
  await drag({ x: box.x + box.width * 0.55, y: box.y + box.height * 0.4 }, { x: box.x + box.width * 0.82, y: box.y + box.height * 0.65 })
  await fillField('Note text', 'Review this captured control')
  await shot(kind + '-notes')
  await click('Pixelate', true)
  const property = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify('select[aria-label="Pixel size"]')}),r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
  assert.ok(property, 'Actual Pixelate parameter is visible in ' + kind)
  // One trusted Tab enters the real parameter after its tool. Pointer hover keeps the
  // actual hover treatment visible; no style class or synthetic focus is inserted.
  for (let i = 0; i < 6 && (await facts()).activeElement !== 'Pixel size'; i++) {
    for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  }
  assert.equal((await facts()).activeElement, 'Pixel size', 'Trusted Tab reaches the actual parameter in ' + kind)
  await mouse('mouseMoved', property.x, property.y); await settle()
  await shot(kind + '-parameter')
  const final = await facts()
  assert.equal(final.appearance, appearance)
  receipt.cases.push({ label: 'visual-' + kind, appearance, width, height, facts: final })
  await click('Cancel', true); await closed('visual-' + kind + '-cancel'); await stage('visual-' + kind + '-complete')
}
async function publicScreenshot(program: string) {
  publicServer = new AgentMuxControlServer({
    coreClients: () => [],
    execute: async request => {
      assert.equal(request.operation, 'browser.run', 'The real public service delegates only this requested operation')
      if (request.operation !== 'browser.run') throw new Error('Unexpected private public request')
      assert.equal(request.browserId, originalId)
      const result = await manager.runScript(request.browserId, request.code, undefined, undefined, request.operationId)
      receipt.publicExecutions ??= []
      receipt.publicExecutions.push({ requestId: request.requestId, browserId: request.browserId, operationId: request.operationId,
        outcome: result.outcome, runOperation: result.runOperation, webContentsId: original.webContents.id })
      return { operation: 'browser.run', ...result }
    }
  }, join(root, 'control.sock'))
  await publicServer.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: publicServer.path } })
  let sdk: any
  try { sdk = await rpc.call('browser.run', { browserId: originalId, code: program, operationId: 'private-screenshot-sdk' }) }
  finally { await rpc.dispose() }
  assert.equal(sdk.outcome.kind, 'completed')
  assert.deepEqual(sdk.result, scriptCapture, 'The real SDK preserves original capture metadata and image facts')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_RPC_ENDPOINT: 'unix:' + publicServer.path,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'cli-runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'cli-state') })
  const cli = await new Promise<{ code: number | null; signal: string | null; pid: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.AGENTMUX_SCREENSHOT_CLI!, 'browser', 'run', '--browser', originalId,
      '--operation-id', 'private-screenshot-cli'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', bytes => { stdout += bytes; assert.ok(stdout.length < 1_000_000) })
    child.stderr.on('data', bytes => { stderr += bytes; assert.ok(stderr.length < 1_000_000) })
    const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 500) }, 7000)
    child.once('error', error => { clearTimeout(timeout); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout); clearTimeout(escalation)
      if (expired) reject(new Error('The exact private CLI child exited after timeout: ' + stdout + stderr))
      else resolve({ code, signal, pid: child.pid!, stdout, stderr })
    })
    child.stdin.end(program)
  })
  assert.equal(cli.code, 0, cli.stderr + cli.stdout)
  const cliResult = JSON.parse(cli.stdout)
  assert.equal(cliResult.ok, true); assert.equal(cliResult.operation, 'browser.run')
  assert.equal(cliResult.result.outcome.kind, 'completed')
  assert.deepEqual(cliResult.result.result, scriptCapture, 'The actual CLI preserves original source through the public service')
  assert.equal(receipt.publicExecutions.length, 2)
  receipt.cases.push({ label: 'actual-Core-SDK-and-CLI-browser-run-share-original-capture-owner', sdk, cli,
    endpoint: publicServer.path, runtimeDirectory: env.AGENTMUX_RUNTIME_DIRECTORY, stateDirectory: env.AGENTMUX_STATE_DIRECTORY })
  await keepOwners('public-SDK-and-CLI-retain-original-native-owner')
}
async function run() {
  await stage('private-process-start')
  await app.whenReady(); await stage('electron-ready')
  receipt.loadedCompiled = Object.fromEntries(await Promise.all(['main.mjs', 'renderer.js', 'renderer.css', 'preload.cjs'].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  server = createServer((request, response) => {
    const sibling = request.url === '/sibling'
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<!doctype html><title>${sibling ? 'Sibling source' : 'Original screenshot source'}</title><style>body{margin:0;background:${sibling ? '#1f3f38' : '#f5f6fa'};color:${sibling ? 'white' : '#233248'};font:16px system-ui;padding:25px}input{font:14px system-ui;padding:10px;border:1px solid #bbc6d2;border-radius:6px;width:75%}h1{font-size:24px}p{line-height:1.8}#pattern{position:absolute;left:25px;top:245px;width:320px;height:100px;background:repeating-linear-gradient(90deg,#24425f 0 2px,#ffffff 2px 4px)}</style><h1>${sibling ? 'Sibling page' : 'Browser screenshot canvas'}</h1><p>Original page identity and draft remain available.</p><input value="retained ${sibling ? 'sibling' : 'original'} draft"><p>Draw an arrow or highlight this content.</p><div id="pattern"></div>`)
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
  await stage('original-and-sibling-documents-ready')
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
      const decoded = nativeImage.createFromDataURL(args[0].dataUrl), size = decoded.getSize(), png = decoded.toPNG()
      assert.ok(!decoded.isEmpty()); assert.equal(size.width, args[0].width); assert.equal(size.height, args[0].height)
      const path = label + '-clipboard-' + (receipt.clipboard.length + 1) + '.png'; await writeFile(join(out, path), png)
      receipt.clipboard.push({ byteLength: args[0].byteLength, width: size.width, height: size.height,
        png: { path, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } }); return
    }
    if (method === 'privateClipboardText') { assert.equal(typeof args[0], 'string'); receipt.clipboardText.push(args[0]); return }
    assert.equal(args[0], originalId, 'The original Pane keeps its exact Browser target')
    receipt.calls.push({ method, args })
    if (method === 'captureScreenshot') {
      const captured = await manager.captureScreenshot(args[0])
      assert.ok(captured.source, 'The Desktop capture carries its exact Main-owned source metadata')
      assert.equal(captured.source.url, original.webContents.getURL()); assert.equal(captured.source.title, original.webContents.getTitle())
      if (receipt.captures.length === 0) assert.deepEqual(captured.source, scriptCapture.source, 'Desktop and runner consume the same original source metadata')
      receipt.captures.push({ browserId: captured.browserId, navigationId: captured.navigationId, source: captured.source,
        image: { width: captured.image.width, height: captured.image.height, byteLength: captured.image.byteLength } })
      return captured
    }
    if (method === 'setBounds') return manager.setBounds(args[0], args[1])
    if (method === 'setAnnotationMarkers') return await manager.setAnnotationMarkers(args[0], args[1], args[2])
    if (method === 'cancelElementSelection') return await manager.cancelElementSelection(args[0])
    throw new Error('Unexpected private IO: ' + method)
  })
  await window.loadFile(join(root, 'index.html')); window.showInactive(); window.webContents.focus()
  receipt.rendererDocument = { url: window.webContents.getURL(), webContentsId: window.webContents.id, windowId: window.id }
  window.webContents.debugger.attach('1.3')
  await until('mounted production Pane and native frame', async () => await evaluate('!!document.querySelector("button[aria-label=Screenshot]")') && manager.nativeOwner(originalId))
  await settle(); await keepOwners('initial-original-and-sibling'); await stage('original-renderer-mounted')
  const program = 'const capture=await captureScreenshot(); return {browserId:capture.browserId,navigationId:capture.navigationId,source:capture.source,image:{mimeType:capture.image.mimeType,width:capture.image.width,height:capture.image.height,byteLength:capture.image.byteLength}}'
  const runner = await manager.runScript(originalId, program)
  assert.equal(runner.outcome.kind, 'completed', 'The actual Browser runner screenshot call completes')
  scriptCapture = runner.result
  assert.equal(scriptCapture.browserId, originalId); assert.equal(scriptCapture.navigationId, originalSnapshot.navigationId)
  assert.ok(scriptCapture.source, 'The actual runner return carries source metadata from the original capture owner')
  assert.equal(scriptCapture.source.url, original.webContents.getURL()); assert.equal(scriptCapture.source.title, original.webContents.getTitle())
  assert.ok(scriptCapture.source.viewport?.width > 0 && scriptCapture.source.viewport?.height > 0)
  assert.equal(scriptCapture.source.viewportWarning, null)
  assert.ok(scriptCapture.image.width > 0 && scriptCapture.image.height > 0 && scriptCapture.image.byteLength > 0)
  receipt.cases.push({ label: 'actual-runner-captureScreenshot-consumes-original-source', result: scriptCapture, outcome: runner.outcome, operation: runner.runOperation })
  await keepOwners('runner-retains-original-native-owner')
  await publicScreenshot(program); await stage('real-SDK-and-CLI-consumed-original-source')
  const opened = await openEditor()
  assert.equal(receipt.calls.filter((row: any) => row.method === 'captureScreenshot').length, 1)
  await evaluate('window.screenshotProbe.rememberPixels()')
  const before = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts(), ink: await evaluate('window.screenshotProbe.inkPixels()') }
  const box = opened.canvas, x = box.x + 30, y = box.y + 40, count = 300, start = Date.now()
  await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 'left')
  for (let i = 1; i <= count; i++) await mouse('mouseMoved', x + (i / count) * Math.min(300, box.width - 65), y + 40 * Math.sin(i / 25), 'left')
  await mouse('mouseReleased', x + Math.min(300, box.width - 65), y + 40 * Math.sin(count / 25), 'left')
  await settle()
  const after = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts(), ink: await evaluate('window.screenshotProbe.inkPixels()') }
  const trusted = after.facts.events.slice(before.facts.events.length).filter((event: any) => event.target === 'canvas' && event.trusted)
  assert.ok(trusted.filter((event: any) => event.type === 'pointermove').length >= count, 'Actual continuous CDP pointer samples reach the real Canvas')
  assert.equal(trusted.filter((event: any) => event.type === 'pointerdown').length, 1); assert.equal(trusted.filter((event: any) => event.type === 'pointerup').length, 1)
  assert.ok(after.ink.count > before.ink.count + 100 && after.ink.changed > 100, 'Actual red drawing changes the captured base page; opaque source alpha is not ink')
  assert.deepEqual(after.counters, before.counters, 'drawing-must-not-capture-or-encode-native-chrome')
  assert.equal(after.publications, before.publications, 'drawing-must-not-publish-native-chrome')
  receipt.cases.push({ label: 'continuous-pointer-ink-with-zero-native-chrome-work', samples: count, elapsedMs: Date.now() - start, before, after })
  await shot('editor-ink'); await stage('actual-continuous-pointer-cost-oracle-complete')
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
  await openEditor(); await evaluate('window.screenshotProbe.holdEncoding()'); await click('Copy context', true)
  const contextPending = await until('actual context PNG callback held', async () => { const row = await facts(); return row.encodingHeld && row.copying ? row : null })
  assert.equal(contextPending.cancelDisabled, false)
  await click('Cancel', true); await closed('cancel-during-actual-context-encoding')
  await evaluate('window.screenshotProbe.releaseEncoding()'); await settle()
  assert.equal(receipt.clipboardText.length, 0, 'Cancelled actual context composition never reaches the private text sink')
  assert.equal((await facts()).editor, false)
  receipt.cases.push({ label: 'late-native-context-after-cancel-keeps-text-sink-and-workface', contextPending, after: await facts() })
  const editing = await openEditor(); await capabilityEdits(editing)
  await until('normal Copy completes and keeps the same Editor available', async () => receipt.clipboard.length === 2 && (await facts()).editor && !(await facts()).copying)
  assert.equal(original.getVisible(), false, 'Copy PNG keeps the original screenshot working surface')
  await click('Copy PNG', true)
  await until('the real Editor supports another explicit Copy', async () => receipt.clipboard.length === 3 && !(await facts()).copying)
  receipt.cases.push({ label: 'normal-copy-keeps-editor-and-allows-explicit-recopy', clipboard: receipt.clipboard.slice(), after: await facts() })
  await click('Cancel', true); await closed('copy-followed-by-explicit-cancel')
  await stage('actual-edits-and-pending-copy-Cancel-complete')
  assert.equal(receipt.counters.originalCapture, 8, 'Five Desktop entries plus direct runner, real SDK and CLI capture exactly once each')
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') {
    for (const [kind, width, height, appearance] of [
      ['normal-dark', 1040, 740, 'dark'], ['narrow-dark', 450, 640, 'dark'], ['short-dark', 880, 390, 'dark'],
      ['normal-light', 1040, 740, 'light'], ['narrow-light', 450, 640, 'light'], ['short-light', 880, 390, 'light']
    ] as const) await visualScene(kind, width, height, appearance)
  }
  assert.deepEqual((await facts()).errors, [])
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { receipt.failure.facts = await facts(); receipt.failure.fields = await evaluate('[...document.querySelectorAll("textarea,select")].map(e=>({label:e.getAttribute("aria-label"),value:e.value,rect:e.getBoundingClientRect().toJSON()}))'); await shot('failure') } catch {}
}).finally(async () => {
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  try { if (window && !window.isDestroyed()) await evaluate('window.screenshotProbe?.dispose()') } catch {}
  await publicServer?.stop()
  overlays?.dispose(); manager?.dispose(); server?.close(); window?.destroy(); app.exit(receipt.passed ? 0 : 1)
})
