import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, nativeImage, webContents, type WebContents } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserCdpSession } from '../../../src/main/browser-cdp-session.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { BrowserResultArtifactStore } from '@agentmux/browser/operations'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../../../packages/core/src/public-rpc-client.js'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { BrowserScreenshotCapture } from '@agentmux/browser/model'

const root = process.env.AGENTMUX_CLEAN_CAPTURE_ROOT!, out = process.env.AGENTMUX_CLEAN_CAPTURE_OUT!
const paintOnly = process.env.AGENTMUX_CLEAN_CAPTURE_PAINT_ONLY === '1'
const iframeOnly = process.env.AGENTMUX_CLEAN_CAPTURE_IFRAME_ONLY === '1'
assert.ok(root && out && process.env.AGENTMUX_CLEAN_CAPTURE_CLI && process.env.AGENTMUX_CLEAN_CAPTURE_NODE)
app.setPath('userData', join(root, 'user-data'))
app.setPath('sessionData', join(root, 'session-data'))
// This private producer closes its only Window before the receipt is flushed.
// Keep Electron's default last-window quit from racing the explicit app.exit below.
app.on('window-all-closed', () => {})
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
app.commandLine.appendSwitch('no-proxy-server')
const receipt: any = { schema: 'agentmux.browser-clean-capture.native-process.v1', passed: false, pid: process.pid,
  scope: paintOnly ? 'paint-only-http-visible-hidden' : iframeOnly ? 'iframe-only-http-public' : 'full-native-slice',
  versions: process.versions, cases: [], frames: [], calls: [], boundary: 'Private actual BVM/Native page/input/feedback and Source RPC/CLI. No user data, Provider, OS foreground or installation.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let manager: BrowserViewManager | undefined, window: BrowserWindow | undefined, control: AgentMuxControlServer | undefined
let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
let releasePending: (() => Promise<unknown>) | undefined
let releaseSelection: (() => Promise<unknown>) | undefined
const http = createServer(async (request, response) => {
  const name = request.url === '/frame.html' ? 'frame.html' : 'page.html'
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(await readFile(join(root, 'pages', name)))
})
async function observe<T>(label: string, read: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(20) }
  throw new Error('Original private observation did not settle: ' + label)
}
const feedbackExpression = `(()=>{const read=key=>{const s=globalThis[key],h=s?.host,style=h?getComputedStyle(h):null;return {present:!!h?.isConnected,visibility:style?.visibility??null,display:style?.display??null,opacity:style?.opacity??null,owner:s?.ownerId??s?.operationId??null,phase:s?.phase??null}};return {tokens:globalThis.__agentMuxBrowserFeedbackPresentation?.tokens.size??0,hasDisplay:globalThis.__agentMuxBrowserFeedbackPresentation?.hasDisplay?.()??false,control:read('__agentMuxBrowserControlFeedback'),operation:read('__agentMuxBrowserOperationFeedback')}})()`
const hiddenFeedback = (host: any) => !host.present || host.visibility === 'hidden' || host.display === 'none' || Number(host.opacity) === 0
async function feedback(contents: WebContents) {
  return await contents.executeJavaScriptInIsolatedWorld(1209, [{ code: feedbackExpression }])
}
async function selectionFeedback(contents: WebContents) {
  return await contents.executeJavaScriptInIsolatedWorld(1208, [{ code: `(()=>{const s=globalThis.__agentMuxBrowserSelection,h=s?.host,style=h?getComputedStyle(h):null;return {present:!!h?.isConnected,revision:s?.revision??null,selected:s?.selectedTarget!=null,visibility:style?.visibility??null,display:style?.display??null,opacity:style?.opacity??null}})()` }])
}
async function embeddedFeedback(contents: WebContents, send = contents.debugger.sendCommand.bind(contents.debugger)) {
  const tree = await send('Page.getFrameTree') as { frameTree: { childFrames?: { frame: { id: string } }[] } }
  const frameId = tree.frameTree.childFrames?.[0]?.frame.id; assert.ok(frameId, 'The actual original iframe is present')
  const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'agentmux-browser-operation-feedback' }) as { executionContextId: number }
  const result = await send('Runtime.evaluate', { contextId: world.executionContextId, expression: feedbackExpression, returnByValue: true }) as { result: { value: any }; exceptionDetails?: unknown }
  assert.equal(result.exceptionDetails, undefined); return { frameId, worldId: world.executionContextId, ...result.result.value }
}
async function pageFacts(contents: WebContents) {
  return await contents.executeJavaScript(`(()=>{const input=document.querySelector('#draft');return {url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollX,scrollY},historyLength:history.length,input:{value:input?.value,start:input?.selectionStart,end:input?.selectionEnd,active:document.activeElement===input},frameCount:frames.length}})()`)
}
async function stableFacts(id: string, contents: WebContents) {
  return { target: manager!.target(id), page: await pageFacts(contents), bounds: manager!.nativeOwner(id)!.view.getBounds(),
    contentsId: contents.id, nativeFocus: webContents.getFocusedWebContents()?.id ?? null }
}
function assertPreserved(before: any, after: any, allowOriginalHumanRelease = false) {
  assert.equal(after.contentsId, before.contentsId); assert.deepEqual(after.bounds, before.bounds)
  assert.equal(after.target.id, before.target.id); assert.equal(after.target.workspaceId, before.target.workspaceId); assert.equal(after.target.mode, before.target.mode)
  assert.ok(typeof before.target.profile?.id === 'string' && before.target.profile.id.length > 0, 'The private normal fixture has a Main-confirmed original Profile')
  assert.equal(after.target.profile?.id, before.target.profile.id)
  assert.equal(after.target.navigationId, before.target.navigationId)
  if (allowOriginalHumanRelease) {
    const { inputIsolation: a, ...afterControl } = after.target.control, { inputIsolation: b, ...beforeControl } = before.target.control
    assert.equal(beforeControl.owner, 'human'); assert.deepEqual(afterControl, beforeControl)
    assert.ok(a === b || b === 'unconfirmed' && a === 'inactive', 'Only the original explicit TakeControl release may finish; capture cannot claim another input owner or isolation')
  } else assert.deepEqual(after.target.control, before.target.control)
  assert.deepEqual(after.page, before.page); assert.equal(after.nativeFocus, before.nativeFocus)
}
async function savePng(label: string, bytes: Buffer, evidence: Record<string, unknown> = {}) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  const path = join(out, label + '.png'); await writeFile(path, bytes, { flag: 'wx' })
  const row = { label, path, sha256: sha(bytes), bytes: bytes.length, dimensions, ...evidence }
  receipt.frames.push(row); return row
}
async function saveCapture(label: string, capture: BrowserScreenshotCapture) {
  return await savePng(label, pngBytes(capture.image), { browserId: capture.browserId, navigationId: capture.navigationId,
    source: capture.source, method: 'original-BrowserViewManager-captureScreenshot' })
}
function calibrationPixels(bytes: Buffer, center: { x: number; y: number }) {
  const image = nativeImage.createFromBuffer(bytes), size = image.getSize(), pixels = image.toBitmap()
  assert.ok(center.x >= 0 && center.y >= 0 && center.x < size.width && center.y < size.height)
  const sample = (Math.floor(center.y) * size.width + Math.floor(center.x)) * 4
  // Native output can carry the display ICC transform. Locate the same rendered
  // solid rectangle, rather than treating CSS sRGB bytes as raw bitmap bytes.
  const color = [pixels[sample + 2], pixels[sample + 1], pixels[sample]]
  assert.ok(color[2] > color[0] + 80 && color[2] > color[1] + 60, 'The expected calibration center contains the original page blue, not background or text')
  let left = size.width, top = size.height, right = -1, bottom = -1, count = 0
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const p = (y * size.width + x) * 4
    if (Math.abs(pixels[p + 2] - color[0]) > 2 || Math.abs(pixels[p + 1] - color[1]) > 2 || Math.abs(pixels[p] - color[2]) > 2) continue
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++
  }
  assert.ok(count > 0, 'The original page blue calibration is present in encoded pixels')
  return { left, top, width: right - left + 1, height: bottom - top + 1, count, image: size, sampledNativeRGB: color }
}
function verifyCalibration(bytes: Buffer, css: { x: number; y: number; width: number; height: number }, ratio: number, clip = { x: 0, y: 0 }) {
  const expected = { left: (css.x - clip.x) * ratio, top: (css.y - clip.y) * ratio, width: css.width * ratio, height: css.height * ratio }
  const pixels = calibrationPixels(bytes, { x: expected.left + expected.width / 2, y: expected.top + expected.height / 2 })
  for (const key of ['left', 'top', 'width', 'height'] as const) assert.ok(Math.abs(pixels[key] - expected[key]) <= 2, `Original CSS calibration ${key} maps to the requested output pixels (${pixels[key]} versus ${expected[key]})`)
  return { css, clip, pixelRatio: ratio, pixels, expected, tolerance: 'At most 2 output pixels for native edge rasterization; does not allow a page-zoom offset.' }
}
async function capture(id: string) {
  if (!paintOnly) return await manager!.captureScreenshot(id)
  const contents = manager!.nativeOwner(id)!.view.webContents, original = contents.capturePage, calls: any[] = []
  contents.capturePage = (async function (this: WebContents, ...args: Parameters<WebContents['capturePage']>) {
    const facts = await contents.executeJavaScriptInIsolatedWorld(1209, [{ code: `(()=>{const s=globalThis.__agentMuxBrowserControlFeedback,h=s?.host,p=globalThis.__agentMuxBrowserFeedbackPresentation;return {tokens:p?.tokens.size??0,hasDisplay:p?.hasDisplay()??false,host:{present:!!h?.isConnected,browserId:h?.getAttribute('data-browser-id'),ownerId:h?.getAttribute('data-owner-id'),navigationId:h?.getAttribute('data-navigation-id'),inlineOpacity:h?.style.getPropertyValue('opacity'),opacityPriority:h?.style.getPropertyPriority('opacity'),computedOpacity:h?getComputedStyle(h).opacity:null},state:{browserId:s?.browserId,ownerId:s?.ownerId,navigationId:s?.navigationId,revision:s?.revision}}})()` }])
    calls.push({ nativeCall: calls.length + 1, args, facts })
    assert.ok(facts.tokens > 0, 'The original suppression token is active at the real native capture boundary')
    if (facts.host.present) { assert.equal(facts.host.browserId, id); assert.equal(facts.host.inlineOpacity, '0'); assert.equal(facts.host.computedOpacity, '0'); assert.equal(facts.host.opacityPriority, 'important'); assert.equal(facts.host.ownerId, facts.state.ownerId); assert.equal(facts.host.navigationId, facts.state.navigationId) }
    return await original.apply(this, args)
  }) as WebContents['capturePage']
  try {
    const result = await manager!.captureScreenshot(id)
    assert.equal(calls.length, calls[0].facts.hasDisplay ? 2 : 1, 'Exactly the original primer plus official capture, or no-host official capture')
    receipt.cases.push({ label: 'paint-boundary-native-pixel-calls', browserId: id, calls, observation: 'Read-only original 1209 host/token facts before each native call, only in paint-only scope.' })
    return result
  } finally { contents.capturePage = original }
}
async function readOriginalResult(id: string, label: string, value: any) {
  if (value?.kind !== 'browser-result-artifact') return { value, reads: [] }
  const reference = value, parts: Buffer[] = [], reads: any[] = []
  assert.equal(reference.browserId, id); assert.equal(reference.workspaceId, manager!.target(id)!.workspaceId)
  assert.ok(reference.byteLength > 0 && reference.byteLength <= 8 * 1024 * 1024)
  let offset = 0
  while (offset < reference.byteLength) {
    assert.ok(reads.length < 128, 'Original artifact continuation remains within its unchanged read budget')
    const report = await rpc!.call('browser.run', { browserId: id, operationId: label + '-read-' + offset,
      code: `return await readResult(${JSON.stringify(reference)},{offset:${offset},maxBytes:65536})` })
    assert.equal(report.outcome.kind, 'completed', JSON.stringify(report.outcome))
    const chunk = report.result as any, bytes = Buffer.from(chunk.data, 'base64')
    assert.deepEqual(chunk.reference, reference); assert.equal(chunk.offset, offset); assert.equal(bytes.length, chunk.returnedBytes)
    assert.equal(chunk.totalBytes, reference.byteLength); assert.ok(bytes.length > 0)
    reads.push({ operationId: report.runOperation?.id, offset, returnedBytes: bytes.length, nextOffset: chunk.nextOffset, readCost: chunk.readCost })
    parts.push(bytes); offset += bytes.length
    assert.equal(chunk.nextOffset, offset === reference.byteLength ? null : offset)
  }
  return { value: JSON.parse(Buffer.concat(parts).toString('utf8')), reads, reference }
}
async function programCapture(id: string, label: string, options: unknown, hoverIframe = false) {
  const contents = manager!.nativeOwner(id)!.view.webContents, original = contents.debugger.sendCommand
  const originalCapture = manager!.captureScreenshot
  const captures: any[] = [], geometryCalls: any[] = [], layoutMetrics: any[] = []
  let originalCue: any = null
  // The original public hover safety refusal is retained in a7a6c5ca and 74e5af1c.
  // This bounded screenshot fixture uses that exact live operation's original
  // display owner and sender; it neither sends input nor claims hover completion.
  if (hoverIframe && !iframeOnly) manager!.captureScreenshot = async function (browserId, transport, captureOptions) {
    assert.equal(browserId, id); assert.ok(transport)
    const entry = (manager as any).entries.get(id), owner = entry.feedback
    assert.ok(owner, 'The admitted original Browser program owns its existing feedback instance')
    const tree = await transport.sendCommand('Page.getFrameTree') as { frameTree: { childFrames?: { frame: { id: string } }[] } }
    const frameId = tree.frameTree.childFrames?.[0]?.frame.id; assert.ok(frameId)
    const world = await transport.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'agentmux-structured-observation' }) as { executionContextId: number }
    const button = await transport.sendCommand('Runtime.evaluate', { contextId: world.executionContextId,
      expression: 'document.querySelector("button")', returnByValue: false }) as { result: { objectId: string } }
    assert.ok(button.result.objectId)
    let backendNodeId: number
    try {
      const described = await transport.sendCommand('DOM.describeNode', { objectId: button.result.objectId }) as { node: { backendNodeId: number } }
      backendNodeId = described.node.backendNodeId
    } finally { await transport.sendCommand('Runtime.releaseObject', { objectId: button.result.objectId }) }
    const action = await owner.begin('hover')
    await owner.showTarget({ ref: '@private-original-feedback-target', role: 'button', name: 'Embedded action', depth: 1, frameId, backendNodeId }, transport.sendCommand, action)
    originalCue = { operationId: entry.activity.operation.id, frameId, backendNodeId, action,
      before: await embeddedFeedback(contents, transport.sendCommand),
      boundary: 'Original current BVM BrowserOperationFeedback instance and original public-capture Frame sender. Display-only injection; no physical hover success claimed.' }
    assert.equal(originalCue.before.operation.present, true); assert.equal(hiddenFeedback(originalCue.before.operation), false)
    return await originalCapture.call(this, browserId, transport, captureOptions)
  }
  contents.debugger.sendCommand = (async function (this: Electron.Debugger, ...args: Parameters<Electron.Debugger['sendCommand']>) {
    if (args[0] === 'Page.captureScreenshot') {
      const control = manager!.target(id)!.control, ownedFeedback = await feedback(contents)
      assert.equal(control?.owner, 'agent'); assert.equal(control.inputIsolation, 'isolated')
      assert.ok(hiddenFeedback(ownedFeedback.control))
      assert.ok(hiddenFeedback(ownedFeedback.operation))
      const child = hoverIframe ? await embeddedFeedback(contents, original.bind(this)) : null
      if (hoverIframe) { assert.ok(child.operation.present, 'The actual hovered child keeps its original feedback identity'); assert.ok(hiddenFeedback(child.operation), 'The child named-world cursor is hidden during original capture') }
      captures.push({ control, feedback: ownedFeedback, child, params: args[1] })
    }
    const result = await original.apply(this, args)
    if (args[0] === 'Page.getLayoutMetrics') layoutMetrics.push({ method: args[0], result,
      nativeZoomFactor: contents.getZoomFactor(), document: await contents.executeJavaScript('({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,scrollX,scrollY})') })
    if (hoverIframe && ['DOM.getContentQuads', 'DOM.getNodeForLocation', 'DOM.getFrameOwner', 'DOM.getBoxModel'].includes(args[0])) geometryCalls.push({ method: args[0], params: args[1], result })
    return result
  }) as Electron.Debugger['sendCommand']
  try {
    const code = (hoverIframe ? `const tree=await snapshot();const node=tree.nodes.find(node=>node.name==='Embedded action');if(!node)throw new Error('Original iframe button missing');console.log(JSON.stringify({fixtureIframeTarget:node}));${iframeOnly ? 'await hover(node.ref);' : ''}` : '') + `return await captureScreenshot(${options === undefined ? '' : JSON.stringify(options)})`
    const result = await rpc!.call('browser.run', { browserId: id, operationId: label, code })
    const caseRow: any = { label, report: { ...result, result: (result.result as any)?.kind === 'browser-result-artifact' ? result.result : undefined }, originalCaptureCommands: captures, geometryCalls, layoutMetrics, originalCue }; receipt.cases.push(caseRow)
    assert.equal(result.outcome.kind, 'completed', JSON.stringify(result.outcome)); assert.equal(captures.length, 1)
    let childRestored = null
    if (hoverIframe) { const observation = BrowserCdpSession.attach(contents); try { childRestored = await embeddedFeedback(contents, observation.sendCommand) } finally { observation.detach() } }
    if (hoverIframe) { assert.equal(childRestored.operation.present, true); assert.equal(hiddenFeedback(childRestored.operation), false) }
    caseRow.childRestored = childRestored
    const recovered = await readOriginalResult(id, label, result.result); caseRow.resultReads = recovered.reads
    return recovered.value as BrowserScreenshotCapture
  } finally { contents.debugger.sendCommand = original; manager!.captureScreenshot = originalCapture }
}
async function cli(args: string[]) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.env.AGENTMUX_CLEAN_CAPTURE_NODE!, [process.env.AGENTMUX_CLEAN_CAPTURE_CLI!, '--endpoint', 'unix:' + control!.path, ...args],
      { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }))
  })
}
async function withCaptureBoundary(contents: WebContents, work: (calls: any[], release: (error?: Error) => void) => Promise<void>, expectedFormalRequests = 1) {
  const original = contents.capturePage, real = original.bind(contents), calls: any[] = []
  const release = (error?: Error) => { const call = calls.find(row => !row.released); assert.ok(call, 'There is an exact pending native pixel request'); call.released = true; error ? call.reject(error) : call.resolve() }
  contents.capturePage = ((...args: Parameters<WebContents['capturePage']>) => new Promise<void>((resolve, reject) => calls.push({ phase: calls.length === 0 ? 'primer' : 'formal', args, resolve, reject, released: false })).then(() => real(...args))) as WebContents['capturePage']
  try { await work(calls, release); assert.equal(calls.length, 1 + expectedFormalRequests, 'One shared primer and exactly the original formal requests') }
  finally { contents.capturePage = original; for (const row of calls) if (!row.released) { row.released = true; row.reject(new Error('Private capture boundary cleanup')) }; receipt.cases.push({ label: 'exact-native-capture-stage-boundary', calls: calls.map(({ phase, args, released }) => ({ phase, args, released })), expectedFormalRequests }) }
}
async function documentCase(id: string, url: string, protocol: string) {
  const initial = await manager!.create(id, url, 'private-capture-workspace')
  manager!.setBounds(id, { x: 12, y: 42, width: 720, height: 660 })
  const contents = manager!.nativeOwner(id)!.view.webContents
  await observe('original ' + protocol + ' document and iframe', async () => !contents.isLoading() && await contents.executeJavaScript('document.readyState === "complete" && frames.length === 1'))
  // Input/selection setup is explicit private fixture state, not a manufactured input-isolation fact.
  await contents.executeJavaScript(`document.querySelector('#draft').focus();document.querySelector('#draft').setSelectionRange(3,12)`)
  const baseline = await savePng(protocol + '-page-before-agent', (await contents.capturePage()).toPNG(), { method: 'original-WebContents-capturePage', browserId: id })
  if (iframeOnly) {
    const geometry = await contents.executeJavaScript(`(()=>{const f=document.querySelector('iframe'),button=f.contentDocument.querySelector('button'),rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},frame:rect(f),button:rect(button),frameViewport:{width:f.contentWindow.innerWidth,height:f.contentWindow.innerHeight},frameButtonVisible:button.checkVisibility()}})()`)
    receipt.cases.push({ label: 'readonly-fixture-iframe-geometry', geometry })
    await saveCapture('http-iframe-hover-clean', await programCapture(id, 'http-public-iframe-hover', undefined, true))
    manager!.setBounds(id, null); return
  }
  const pending = rpc!.call('browser.run', { browserId: id, operationId: protocol + '-actual-wait', code: `await waitForElement('Complete capture probe'); return 'original-page-ready';` })
  void pending.catch(() => {})
  releasePending = async () => { await contents.executeJavaScript(`(()=>{if(!document.querySelector('#release')){const button=document.createElement('button');button.id='release';button.textContent='Complete capture probe';document.body.append(button)}})()`); return await pending }
  await observe('actual Agent input isolation', () => manager!.target(id)?.control?.inputIsolation === 'isolated')
  assert.equal(manager!.target(id)!.control!.owner, 'agent')
  const decorated = await observe('actual original control feedback', async () => { const value = await feedback(contents); return value.control.present ? value : null })
  const before = await stableFacts(id, contents)
  const raw = await savePng(protocol + '-agent-decoration-before', (await contents.capturePage()).toPNG(), { method: 'original-WebContents-capturePage', feedback: decorated })
  const full = await capture(id); const fullFrame = await saveCapture(protocol + '-clean-visible', full)
  assertPreserved(before, await stableFacts(id, contents))
  assert.equal(full.image.width, baseline.dimensions.width); assert.equal(full.image.height, baseline.dimensions.height)
  window!.hide(); assert.equal(window!.isVisible(), false)
  const backgroundBefore = await stableFacts(id, contents)
  const background = await capture(id); await saveCapture(protocol + '-clean-background', background)
  assertPreserved(backgroundBefore, await stableFacts(id, contents))
  window!.showInactive()
  await observe('original visible input isolation restored', () => manager!.target(id)?.control?.inputIsolation === 'isolated')
  const resumed = await stableFacts(id, contents)
  const bitmap = nativeImage.createFromBuffer(pngBytes(full.image)), pixels = bitmap.toBitmap(), size = bitmap.getSize()
  const scale = fullFrame.dimensions.width / before.page.viewport.width, x = Math.floor(4 * scale), y = Math.floor(150 * scale), offset = (y * size.width + x) * 4
  const authoredBorder = [pixels[offset + 2], pixels[offset + 1], pixels[offset]]
  assert.ok(Math.abs(authoredBorder[0] - 22) <= 5 && Math.abs(authoredBorder[1] - 131) <= 5 && Math.abs(authoredBorder[2] - 77) <= 5, 'The page-authored green border remains exact in clean original pixels')
  if (paintOnly) {
    const afterFeedback = await feedback(contents); assert.ok(afterFeedback.control.present && !hiddenFeedback(afterFeedback.control))
    const done = await releasePending(); releasePending = undefined; assert.equal((done as any).outcome.kind, 'completed')
    receipt.cases.push({ label: 'http-visible-and-hidden-paint-only', before, backgroundBefore, resumed, authoredBorder,
      baseline: baseline.sha256, decorated: raw.sha256, visible: fullFrame.sha256, afterFeedback,
      boundary: 'HTTP default GUI only. No public clip/HD/iframe/CLI/selection/failure/concurrency qualification.' })
    manager!.setBounds(id, null); return
  }
  if (protocol === 'http') {
    await withCaptureBoundary(contents, async (calls, release) => {
      const failed = capture(id); const rejection = assert.rejects(failed, /private primer rejection/)
      await observe('original native primer failure request', () => calls.length === 1)
      release(new Error('private primer rejection')); await rejection
      const restored = await feedback(contents); assert.equal(restored.control.present, true); assert.equal(hiddenFeedback(restored.control), false); assert.equal(restored.tokens, 0)
      receipt.cases.push({ label: 'native-primer-failure-restores-owned-feedback', restored })
    }, 0)
    await withCaptureBoundary(contents, async (calls, release) => {
      const failed = capture(id); const rejection = assert.rejects(failed, /private pixel rejection/)
      await observe('original native primer before formal failure', () => calls.length === 1); release()
      await observe('original native formal failure request', () => calls.length === 2)
      release(new Error('private pixel rejection')); await rejection
      const restored = await feedback(contents); assert.equal(restored.control.present, true); assert.equal(hiddenFeedback(restored.control), false)
      receipt.cases.push({ label: 'native-failure-restores-owned-feedback', restored })
    })
    await withCaptureBoundary(contents, async (calls, release) => {
      const settled = new Set<string>(), a = capture(id).then(value => { settled.add('a'); return value }), b = capture(id).then(value => { settled.add('b'); return value }); void a.catch(() => {}); void b.catch(() => {})
      await observe('one shared original pending primer', () => calls.length === 1)
      const during = await observe('two exact overlapping suppression tokens', async () => { const value = await feedback(contents); return value.tokens === 2 ? value : null }); assert.ok(hiddenFeedback(during.control))
      release()
      await observe('two original formal pixel requests', () => calls.length === 3)
      release(); await Promise.race([a, b]); assert.equal(settled.size, 1)
      const held = await feedback(contents); assert.ok(hiddenFeedback(held.control)); assert.equal(held.tokens, 1)
      release(); await Promise.all([a, b])
      const after = await feedback(contents); assert.ok(after.control.present && !hiddenFeedback(after.control))
      receipt.cases.push({ label: 'overlapping-captures-keep-feedback-hidden-until-last', calls: calls.length, during, held, after })
    }, 2)
    assertPreserved(resumed, await stableFacts(id, contents))
  }
  const afterFeedback = await feedback(contents); assert.ok(afterFeedback.control.present && !hiddenFeedback(afterFeedback.control))
  const done = await releasePending(); releasePending = undefined
  assert.equal((done as any).outcome.kind, 'completed')
  await saveCapture(protocol + '-iframe-cue-clean', await programCapture(id, protocol + '-public-iframe-cue', undefined, true))
  const clip = { x: 24, y: 24, width: 320, height: 240 }
  const calibration = await contents.executeJavaScript(`(()=>{const r=document.querySelector('.calibration').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
  const region = await programCapture(id, protocol + '-public-region', { clip, pixelRatio: 2 })
  const regionFrame = await saveCapture(protocol + '-region-2x', region)
  receipt.cases.push({ label: protocol + '-clip-calibration-pixels', ...verifyCalibration(pngBytes(region.image), calibration, 2, clip) })
  assert.deepEqual(regionFrame.dimensions, { width: 640, height: 480 })
  const fullBounds = manager!.nativeOwner(id)!.view.getBounds(), fullNativeZoom = contents.getZoomFactor()
  const fullExpectedPixels = { width: Math.ceil(fullBounds.width / fullNativeZoom * 2), height: Math.ceil(fullBounds.height / fullNativeZoom * 2) }
  const hd = await programCapture(id, protocol + '-public-hd', { pixelRatio: 2 }), hdFrame = await saveCapture(protocol + '-full-2x', hd)
  const fullMetrics = receipt.cases.findLast((row: any) => row.label === protocol + '-public-hd').layoutMetrics[0].result.cssVisualViewport
  assert.deepEqual(hd.source.region, { x: 0, y: 0, width: fullMetrics.clientWidth, height: fullMetrics.clientHeight, pixelRatio: 2 })
  receipt.cases.push({ label: protocol + '-hd-calibration-pixels', ...verifyCalibration(pngBytes(hd.image), calibration, 2) })
  assert.deepEqual(hdFrame.dimensions, fullExpectedPixels)
  receipt.cases.push({ label: protocol + '-entire-actual-visual-viewport', fullBounds, fullNativeZoom, fullMetrics, region: hd.source.region, fullExpectedPixels,
    boundary: 'Actual native view/zoom gives the full CSS edge including its fractional bottom. Ceil raster pixels; no rounded innerHeight substitute.' })
  // A new program owns its new operation/revision; page content, viewport, resource and draft stay original.
  const afterPrograms = await stableFacts(id, contents); assert.deepEqual(afterPrograms.page, before.page)
  assert.equal(afterPrograms.contentsId, before.contentsId); assert.deepEqual(afterPrograms.bounds, before.bounds)
  assert.equal(afterPrograms.target.navigationId, before.target.navigationId)
  if (protocol === 'http') {
    const invalid = await rpc!.call('browser.run', { browserId: id, operationId: 'public-out-of-bounds',
      code: `return await captureScreenshot({clip:{x:${before.page.viewport.width - 1},y:0,width:100,height:100}})` })
    assert.notEqual(invalid.outcome.kind, 'completed'); receipt.cases.push({ label: 'actual-public-out-of-bounds', report: invalid })
    assert.deepEqual((await stableFacts(id, contents)).page, before.page)
    const within = await programCapture(id, 'public-within-iframe', { within: 'iframe', pixelRatio: 2 })
    await saveCapture('http-within-iframe-2x', within)
    assert.equal(within.image.width, 840); assert.equal(within.image.height, 300)
  }
  const exported = join(out, protocol + '-cli-region-2x.png')
  const cliResult = await cli(['browser', 'capture', '--browser', id, '--operation-id', protocol + '-cli-capture', '--clip', JSON.stringify(clip), '--pixel-ratio', '2', '--output', exported])
  assert.equal(cliResult.code, 0, cliResult.stderr + cliResult.stdout)
  const exportedBytes = await readFile(exported); assert.equal(exportedBytes.readUInt32BE(16), 640); assert.equal(exportedBytes.readUInt32BE(20), 480)
  receipt.cases.push({ label: protocol + '-cli-calibration-pixels', ...verifyCalibration(exportedBytes, calibration, 2, clip) })
  receipt.frames.push({ label: protocol + '-cli-region-2x', path: exported, sha256: sha(exportedBytes), bytes: exportedBytes.length, dimensions: { width: 640, height: 480 }, method: 'actual-compiled-CLI-browser-capture' })
  const cliOperation = await manager!.getOperation(protocol + '-cli-capture'); assert.equal(cliOperation?.phase, 'completed')
  const duplicate = await cli(['browser', 'capture', '--browser', id, '--output', exported]); assert.notEqual(duplicate.code, 0); assert.equal(sha(await readFile(exported)), sha(exportedBytes))
  if (protocol === 'http') {
    const path = join(out, 'http-cli-hd-original-artifact.png')
    const original = manager!.captureScreenshot; let logicalCaptures = 0, cliMetrics: any
    manager!.captureScreenshot = async function (...args: Parameters<BrowserViewManager['captureScreenshot']>) {
      logicalCaptures++; assert.ok(args[1]); cliMetrics = await args[1].sendCommand('Page.getLayoutMetrics')
      return await original.apply(this, args)
    }
    let result: Awaited<ReturnType<typeof cli>>
    try { result = await cli(['browser', 'capture', '--browser', id, '--operation-id', 'http-cli-hd-artifact', '--pixel-ratio', '2', '--output', path]) }
    finally { manager!.captureScreenshot = original }
    assert.equal(result.code, 0, result.stderr + result.stdout)
    const bytes = await readFile(path), parsed = JSON.parse(result.stdout)
    assert.equal(logicalCaptures, 1, 'Original result continuation never recaptures the page')
    assert.equal(parsed.result.resultArtifact.kind, 'browser-result-artifact', 'Large CLI result identifies its retained original artifact')
    assert.equal(parsed.result.resultArtifact.operationId, 'http-cli-hd-artifact'); assert.ok(parsed.result.resultArtifact.byteLength > 128 * 1024)
    assert.deepEqual(parsed.result.result.source.region, { x: 0, y: 0, width: cliMetrics.cssVisualViewport.clientWidth, height: cliMetrics.cssVisualViewport.clientHeight, pixelRatio: 2 })
    assert.equal(bytes.readUInt32BE(16), fullExpectedPixels.width); assert.equal(bytes.readUInt32BE(20), fullExpectedPixels.height)
    receipt.frames.push({ label: 'http-cli-hd-original-artifact', path, sha256: sha(bytes), bytes: bytes.length,
      dimensions: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, method: 'actual-compiled-CLI-original-result-continuation' })
    receipt.cases.push({ label: 'http-cli-hd-original-artifact', logicalCaptures, output: parsed, ...verifyCalibration(bytes, calibration, 2) })
  }
  if (protocol === 'http') await withCaptureBoundary(contents, async (calls, release) => {
    const oldNavigation = manager!.target(id)!.navigationId, stale = capture(id)
    const rejected = assert.rejects(stale, /changed|navigation|document/i)
    await observe('original primer before navigation', () => calls.length === 1); release()
    await observe('original formal pixel request before navigation', () => calls.length === 2)
    const laterNavigation = await rpc!.call('browser.run', { browserId: id, operationId: 'http-authorized-later-navigation',
      code: `await gotoUrl(${JSON.stringify(url + '?later-document')});return await pageInfo()` })
    assert.equal(laterNavigation.outcome.kind, 'completed', JSON.stringify(laterNavigation.outcome))
    await observe('real later document', async () => !contents.isLoading() && contents.getURL() === url + '?later-document')
    const later = await stableFacts(id, contents); assert.notEqual(later.target.navigationId, oldNavigation)
    release(); await rejected
    assert.equal(manager!.nativeOwner(id)!.view.webContents.id, contents.id)
    assert.equal(contents.getURL(), url + '?later-document')
    const currentFeedback = await feedback(contents)
    receipt.cases.push({ label: 'navigation-during-native-capture-retains-later-document', oldNavigation, later, currentFeedback, laterNavigation })
  })
  manager!.takeControl(id)
  const human = manager!.target(id)!.control, humanBefore = await stableFacts(id, contents)
  const originalNative = contents.capturePage, humanNativeCalls: any[] = []
  contents.capturePage = (async function (this: WebContents, ...args: Parameters<WebContents['capturePage']>) {
    const row: any = { nativeCall: humanNativeCalls.length + 1, args, pixelRequestStartedBeforeObservation: true }; humanNativeCalls.push(row)
    const pixels = originalNative.apply(this, args); void pixels.catch(() => {})
    row.feedback = await feedback(contents); row.selection = await selectionFeedback(contents)
    return await pixels
  }) as WebContents['capturePage']
  let humanCapture: BrowserScreenshotCapture
  try { humanCapture = await capture(id) } finally { contents.capturePage = originalNative }
  await saveCapture(protocol + '-human-readonly-clean', humanCapture)
  const humanBitmap = nativeImage.createFromBuffer(pngBytes(humanCapture.image)).toBitmap(), humanScale = humanCapture.image.width / humanBefore.page.viewport.width
  const humanOffset = (Math.floor(150 * humanScale) * humanCapture.image.width + Math.floor(4 * humanScale)) * 4
  const humanBorder = [humanBitmap[humanOffset + 2], humanBitmap[humanOffset + 1], humanBitmap[humanOffset]]
  assert.ok(Math.abs(humanBorder[0] - 22) <= 5 && Math.abs(humanBorder[1] - 131) <= 5 && Math.abs(humanBorder[2] - 77) <= 5, 'Immediate original TakeControl readonly pixels keep the page-authored border without stale host glow')
  const humanAfter = await stableFacts(id, contents)
  assertPreserved(humanBefore, humanAfter, true)
  receipt.cases.push({ label: protocol + '-immediate-original-human-takeover-readonly', humanBefore, humanAfter, humanNativeCalls, humanBorder,
    noOwnedHostAtNativePixelBoundary: humanNativeCalls.length === 1 && humanNativeCalls.every(row => !row.feedback.hasDisplay && !row.feedback.control.present && !row.feedback.operation.present && !row.selection.present),
    boundary: 'Pixels are requested before read-only host observations; no fixture wait or selection overlay is used to flush them. Original explicit TakeControl unconfirmed→inactive release may settle, without changing its owner/revision.' })
  if (protocol === 'http') {
    const selected = manager!.selectElement(id); void selected.catch(() => {})
    releaseSelection = async () => { await manager!.cancelElementSelection(id); return await selected }
    await observe('original trusted element selector', async () => (await selectionFeedback(contents)).present)
    const target = await contents.executeJavaScript(`(()=>{const r=document.querySelector('#target').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    const nativeTarget = { x: Math.round(target.x * contents.getZoomFactor()), y: Math.round(target.y * contents.getZoomFactor()) }
    contents.sendInputEvent({ type: 'mouseMove', ...nativeTarget })
    const moved = await observe('original trusted pointermove reaches selection target', () => contents.executeJavaScript(`fixtureEvents.findLast(event=>event.type==='pointermove'&&event.trusted&&event.target==='target')`))
    await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const selectionBefore = await selectionFeedback(contents), factsBefore = await stableFacts(id, contents)
    assert.equal(selectionBefore.present, true); assert.equal(hiddenFeedback(selectionBefore), false)
    await savePng('http-selection-decoration-before', (await contents.capturePage()).toPNG(), { method: 'original-WebContents-capturePage', selection: selectionBefore, trustedPointer: moved, cssTarget: target, nativeTarget })
    await withCaptureBoundary(contents, async (calls, release) => {
      const clean = capture(id); void clean.catch(() => {})
      await observe('original selector screenshot primer', () => calls.length === 1); release()
      await observe('original selector screenshot formal native pixel call', () => calls.length === 2)
      const during = await selectionFeedback(contents)
      assert.equal(during.present, true); assert.equal(during.revision, selectionBefore.revision); assert.equal(hiddenFeedback(during), true)
      assert.deepEqual(manager!.target(id)!.control, factsBefore.target.control)
      release(); await saveCapture('http-selection-clean', await clean)
      receipt.cases.push({ label: 'original-trusted-element-selection-presentation-excluded', selectionBefore, during, trustedPointer: moved })
    })
    const selectionAfter = await selectionFeedback(contents); assert.deepEqual(selectionAfter, selectionBefore)
    assertPreserved(factsBefore, await stableFacts(id, contents))
    await savePng('http-selection-decoration-restored', (await contents.capturePage()).toPNG(), { method: 'original-WebContents-capturePage', selection: selectionAfter })
    assert.equal(await releaseSelection(), null); releaseSelection = undefined
  }
  receipt.cases.push({ label: protocol + '-clean-native-and-public-cli', browserId: id, originalProfile: initial.profileId, contentsId: contents.id,
    baseline: baseline.sha256, decorated: raw.sha256, before, after: await stableFacts(id, contents), authoredBorder,
    full: { ...full, image: { ...full.image, dataUrl: undefined } }, region: { ...region, image: { ...region.image, dataUrl: undefined } },
    cli: cliResult, duplicateOutput: duplicate, cliOperation, afterFeedback, humanControlAfterReadonly: manager!.target(id)!.control,
    readonlyBoundary: 'Original GUI capture after explicit takeover; no new Agent program was admitted over human control.' })
  manager!.setBounds(id, null)
}
async function run() {
  await app.whenReady(); await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  window = new BrowserWindow({ show: false, width: 800, height: 760, title: 'Private clean screenshot proof', webPreferences: { sandbox: true, contextIsolation: true } })
  await window.loadURL('data:text/html,<body>Private clean screenshot fixture</body>')
  const profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json'))); await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('External application not used') } },
    new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json'))), undefined,
    new BrowserResultArtifactStore(join(root, 'browser-results')))
  control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], async execute(request) {
    receipt.calls.push({ operation: request.operation, requestId: request.requestId, browserId: 'browserId' in request ? request.browserId : null })
    if (request.operation === 'browser.targets') return { operation: request.operation, targets: manager!.targets(), coverage: 'complete' }
    if (request.operation === 'browser.run') return { operation: request.operation, ...await manager!.runScript(request.browserId, request.code,
      { id: 'private-capture-operator', name: 'Capture proof' }, undefined, request.operationId) }
    if (request.operation === 'browser.operation') return { operation: request.operation, runOperation: await manager!.getOperation(request.operationId) }
    throw new Error('Unexpected fixture RPC: ' + request.operation)
  } }); await control.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: control.path } })
  window.showInactive()
  await documentCase('private-http-capture', `http://127.0.0.1:${(http.address() as { port: number }).port}/page.html`, 'http')
  if (!paintOnly && !iframeOnly) await documentCase('private-file-capture', pathToFileURL(join(root, 'pages/page.html')).href, 'file')
  receipt.passed = true
}
void run().catch(error => { receipt.failure = { message: error.message, stack: error.stack } }).finally(async () => {
  try { if (releasePending) await releasePending() } catch { /* Original failure remains. */ }
  try { if (releaseSelection) await releaseSelection() } catch { /* Original failure remains. */ }
  await rpc?.dispose(); await control?.stop(); manager?.dispose(); if (window && !window.isDestroyed()) window.destroy()
  await new Promise<void>(done => http.close(() => done()))
  await writeFile(join(out, 'native-process.json'), JSON.stringify(receipt, null, 2) + '\n'); app.exit(receipt.passed ? 0 : 1)
})
