import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { parseAgentMuxSpatialGraph, spatialCatalog } from '@agentmux/core/spatial-state'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, type WebContentsView } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { ScreenshotPins } from '../../../src/main/screenshot-pins'
import { exportScreenshotPng, writeScreenshotFile } from '../../../src/main/screenshot-files'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import type { WorkspaceRecord } from '../../../src/shared/contracts'

const root = process.env.AGENTMUX_SCREENSHOT_PROBE_ROOT!, out = process.env.AGENTMUX_SCREENSHOT_PROBE_OUT!
const label = process.env.AGENTMUX_SCREENSHOT_PROBE_LABEL!
assert.ok(root.includes('agentmux-screenshot-workface-'))
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('no-proxy-server'); app.commandLine.appendSwitch('disk-cache-size', '1048576')
const originalId = 'private-screenshot-original', siblingId = 'private-screenshot-sibling', workspaceId = 'private-workspace'
const receipt: any = {
  schema: 'agentmux.browser-screenshot-workface-native-process.v1', label, pid: process.pid,
  scope: 'actual-BrowserPane-Editor-Canvas-native-overlay-and-BrowserViewManager-private-IO',
  passed: false, cases: [], images: [], warnings: [], calls: [], publications: [], clipboard: [], clipboardText: [], captures: [], exports: [], pins: [], pinInspections: [], expectedErrors: [],
  counters: { rendererCapture: 0, rendererEncode: 0, originalCapture: 0 }
}
let window: BrowserWindow, manager: BrowserViewManager, overlays: NativeOverlaySurfaces, server: Server
let original: WebContentsView, sibling: WebContentsView, originalSnapshot: any, siblingSnapshot: any
let pendingOverlayPublications = 0
let baseUrl: string
let publicServer: AgentMuxControlServer
let scriptCapture: any
let files: WorkspaceFiles
let workspace: WorkspaceRecord
let pins: ScreenshotPins, loseNextPinReply = false
const pinActor = { kind: 'user' as const, id: 'private-browser-renderer' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function evaluate(code: string) {
  const result = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
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
function imagePointOnScreen(facts: any, x: number, y: number) {
  assert.ok(facts.imageView?.scale > 0 && facts.canvas, 'The actual Canvas exposes its painted image transform')
  return { x: facts.canvas.x + facts.imageView.x + x * facts.imageView.scale,
    y: facts.canvas.y + facts.imageView.y + y * facts.imageView.scale }
}
async function mouse(type: string, x: number, y: number, button?: string) {
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y,
    button: type === 'mouseMoved' ? 'none' : button ?? 'left', buttons: type === 'mouseReleased' ? 0 : button ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1 })
}
async function click(name: string, insideEditor: boolean | 'file' = false) {
  if (insideEditor === true && (name === 'Open original' || name === 'Save original')) {
    await click('Original file actions', true)
    const point = await until('actual Original menu action ' + name, async () => await evaluate(`(()=>{const item=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(name + '…')});if(!item)return null;const r=item.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width>0?{x,y,hit:item.contains(document.elementFromPoint(x,y))}:null})()`))
    assert.equal(point.hit, true, 'The actual Original menu action owns its trusted pointer hit: ' + name)
    if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') { await settle(); await shot('original-file-actions') }
    await mouse('mouseMoved', point.x, point.y); await mouse('mousePressed', point.x, point.y, 'left'); await mouse('mouseReleased', point.x, point.y, 'left')
    return
  }
  if (insideEditor === true && await evaluate(`(()=>{const tool=[...document.querySelectorAll('.image-annotation-toolbar__tools button')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(name)}),menu=document.querySelector('button[aria-label="Markup tool"]');return !!tool&&tool.getBoundingClientRect().width===0&&!!menu&&menu.getBoundingClientRect().width>0})()`)) {
    await click('Markup tool', true)
    const point = await until('actual compact markup menu item ' + name, async () => await evaluate(`(()=>{const item=[...document.querySelectorAll('[role="menuitemradio"]')].find(node=>node.querySelector('span')?.textContent.trim()===${JSON.stringify(name)});if(!item||item.getAttribute('aria-disabled')==='true')return null;const r=item.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width>0?{x,y,hit:item.contains(document.elementFromPoint(x,y))}:null})()`))
    assert.equal(point.hit, true, 'The actual compact tool owns its pointer hit: ' + name)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await mouse(type, point.x, point.y, type === 'mouseMoved' ? undefined : 'left')
    await settle()
    return
  }
  const point = await until('actual enabled mounted button ' + name, async () => await evaluate(`(()=>{const root=${insideEditor === 'file' ? "document.querySelector('.confirmation-dialog')" : insideEditor ? "document.querySelector('.image-annotation-editor')" : 'document'},button=[...(root?.querySelectorAll('button,[role="menuitem"]')??[])].find(b=>(b.getAttribute('aria-label')===${JSON.stringify(name)}||b.textContent.trim()===${JSON.stringify(name)})&&b.getBoundingClientRect().width>0);if(!button||button.disabled)return null;const r=button.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,disabled:button.disabled,hit:!!hit&&button.contains(hit),hitTag:hit?.tagName,bodyPointerEvents:document.body.style.pointerEvents}})()`))
  assert.ok(point, 'The actual mounted button exists: ' + name)
  receipt.clicks ??= []; receipt.clicks.push({ name, insideEditor, ...point })
  assert.equal(point.hit, true, 'The actual control owns its trusted pointer hit: ' + name + ' ' + JSON.stringify(point))
  await mouse('mouseMoved', point.x, point.y)
  await mouse('mousePressed', point.x, point.y, 'left'); await mouse('mouseReleased', point.x, point.y, 'left')
  await settle()
}
async function escape() {
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
async function key(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
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
    const publications = receipt.publications.length
    await click('More browser tools')
    await until('narrow original More menu Screenshot action', async () => await evaluate('document.querySelector("[role=menuitem][aria-label=Screenshot]")?.getBoundingClientRect().width > 0'))
    await until('the native More overlay is ready', async () => pendingOverlayPublications === 0 &&
      receipt.publications.length > publications &&
      receipt.publications.at(-1)?.result.projected > 0)
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
  // Capture the exact Renderer surface through the same debugger that owns trusted input.
  const captured = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const bytes = Buffer.from(captured.data, 'base64'), image = nativeImage.createFromBuffer(bytes)
  assert.ok(!image.isEmpty() && bytes.length > 8)
  const path = label + '-' + kind + '.png'; await writeFile(join(out, path), bytes)
  receipt.images.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), size: image.getSize(),
    kind: 'actual-original-renderer', capture: 'CDP-Page.captureScreenshot', pid: process.pid, webContentsId: window.webContents.id, windowId: window.id })
}
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, samples = 12) {
  await mouse('mouseMoved', from.x, from.y); await mouse('mousePressed', from.x, from.y, 'left')
  for (let i = 1; i <= samples; i++) await mouse('mouseMoved', from.x + (to.x - from.x) * i / samples, from.y + (to.y - from.y) * i / samples, 'left')
  await mouse('mouseReleased', to.x, to.y, 'left'); await settle()
}
async function fillField(name: string, text: string) {
  const point = await until('the real input appears: ' + name, () => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`[aria-label="${name}"]`)})??[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(name)})?.control;if(!e)return null;const r=e.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}}const x=(left+right)/2,y=(top+bottom)/2;return right>left&&bottom>top?{x,y,hit:document.elementFromPoint(x,y)===e}:null})()`))
  assert.equal(point?.hit, true, 'The visible input point names this exact real field: ' + name)
  assert.ok(point, 'The actual editable field exists: ' + name)
  await mouse('mousePressed', point.x, point.y, 'left'); await mouse('mouseReleased', point.x, point.y, 'left')
  for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, ...(type === 'keyDown' ? { commands: ['selectAll'] } : {}) })
  await window.webContents.debugger.sendCommand('Input.insertText', { text })
  await until('the real Note field consumes input', async () => await evaluate(`window.screenshotProbe.field(${JSON.stringify(name)})`) === text)
  await settle()
}
async function capabilityEdits() {
  const capturedImage = receipt.captures.at(-1).image
  await click('Pen', true)
  const drawing = await facts()
  const from = imagePointOnScreen(drawing, capturedImage.width * .08, capturedImage.height * .12)
  const to = imagePointOnScreen(drawing, capturedImage.width * .22, capturedImage.height * .18)
  await drag(from, to)
  await click('Select', true)
  await settle()
  const moving = await facts()
  const beforeMove = await evaluate('window.screenshotProbe.inkPixels()')
  assert.ok(beforeMove.count > 100 && beforeMove.redBounds, 'The actual object exists before selecting it')
  // Drag the body of the line. The ends belong to the selection's resize handles.
  const selectedFrom = imagePointOnScreen(moving, capturedImage.width * .15, capturedImage.height * .15)
  await drag(selectedFrom, { x: selectedFrom.x + 50, y: selectedFrom.y + 55 })
  const afterMove = await evaluate('window.screenshotProbe.inkPixels()')
  const afterMoveFacts = await facts(), sx = afterMove.width / afterMoveFacts.canvas.width, sy = afterMove.height / afterMoveFacts.canvas.height
  receipt.selectMove = { beforeMove, afterMove, from, selectedFrom, painted: afterMoveFacts.imageView }
  assert.ok(Math.abs(afterMove.redBounds.x - beforeMove.redBounds.x - 50 * sx) < 5 && Math.abs(afterMove.redBounds.y - beforeMove.redBounds.y - 55 * sy) < 5,
    'actual-Select-move-must-move-the-original-ink')
  await click('Delete selected', true); await settle()
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count < 20, 'The actual selected object is deleted')
  await click('Undo', true); await settle()
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count > 100, 'Undo restores the original moved object')
  await click('Erase', true)
  const movedCenter = imagePointOnScreen(await facts(), capturedImage.width * .15 + 50 / moving.imageView.scale,
    capturedImage.height * .15 + 55 / moving.imageView.scale)
  await drag(movedCenter, movedCenter, 1)
  assert.ok((await evaluate('window.screenshotProbe.inkPixels()')).count < 20, 'The actual Erase tool removes the original hit object')
  await click('Undo', true); await settle()
  const pattern = await original.webContents.executeJavaScript('(()=>{const r=document.querySelector("#pattern").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()')
  const nativeBounds = original.getBounds(), zoom = original.webContents.getZoomFactor()
  const current = await facts(), patternTop = imagePointOnScreen(current, pattern.x * zoom / nativeBounds.width * capturedImage.width, pattern.y * zoom / nativeBounds.height * capturedImage.height)
  const patch = { x: patternTop.x - current.canvas.x, y: patternTop.y - current.canvas.y,
    width: pattern.width * zoom / nativeBounds.width * capturedImage.width * current.imageView.scale,
    height: pattern.height * zoom / nativeBounds.height * capturedImage.height * current.imageView.scale }
  // Inspect the interior of the real captured striped patch, excluding edit handles/borders.
  const interior = { x: patch.x + 8, y: patch.y + 8, width: patch.width - 16, height: patch.height - 16 }
  await click('Pixelate', true); await settle()
  const beforeMask = await evaluate(`window.screenshotProbe.patchStats(${JSON.stringify(interior)})`)
  assert.ok(beforeMask.transitions > beforeMask.adjacent * 0.15, 'The actual source patch contains visible fine structure')
  await drag({ x: current.canvas.x + patch.x - 2, y: current.canvas.y + patch.y - 2 }, { x: current.canvas.x + patch.x + patch.width + 2, y: current.canvas.y + patch.y + patch.height + 2 })
  const afterMask = await evaluate(`window.screenshotProbe.patchStats(${JSON.stringify(interior)})`)
  assert.ok(afterMask.opaque > afterMask.width * afterMask.height * 0.99 && afterMask.transitions < beforeMask.transitions * 0.7,
    'actual-Pixelate-must-replace-fine-source-pixels-with-blocks')
  await click('Numbered note', true)
  const notePoint = imagePointOnScreen(await facts(), capturedImage.width * .72, capturedImage.height * .58)
  await drag(notePoint, imagePointOnScreen(await facts(), capturedImage.width * .88, capturedImage.height * .78))
  await fillField('Marker note', 'Check original control')
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
  const cropFacts = await facts()
  await drag(imagePointOnScreen(cropFacts, 20, 20), imagePointOnScreen(cropFacts, capturedImage.width - 20, capturedImage.height - 20))
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
  const hiddenFacts = await facts()
  await drag(imagePointOnScreen(hiddenFacts, 3, 3), imagePointOnScreen(hiddenFacts, capturedImage.width * .35, capturedImage.height * .3))
  await click('Copy context', true)
  await until('the actual cropped-away note is absent from context', async () => receipt.clipboardText.length === 3)
  const hiddenContext = parseContext(receipt.clipboardText[2])
  assert.ok(!hiddenContext.annotations.some((annotation: any) => annotation.id === firstNote.id))
  assert.ok(!receipt.clipboardText[2].includes('Check original control'))
  await click('Undo', true); await settle(); await click('Pixelate', true)
  const maskedFacts = await facts(), natural = firstNote.originalImagePixels
  const map = (x: number, y: number) => imagePointOnScreen(maskedFacts, x, y)
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
  await processedOutputs(cropped)
}
async function measurePointerWork(opened: any) {
  const box = opened.canvas, startPoint = imagePointOnScreen(opened, receipt.captures.at(-1).image.width * .08, receipt.captures.at(-1).image.height * .16)
  const x = startPoint.x, y = startPoint.y, count = 300
  await mouse('mouseMoved', x, y)
  // A narrow Pane opens the screenshot from More. Wait for that menu's exact
  // native removal receipt before measuring work caused by the stroke.
  await until('the editor is idle with no original menu projection', async () =>
    pendingOverlayPublications === 0 && receipt.publications.at(-1)?.count === 0 &&
    receipt.publications.at(-1)?.result.projected === 0)
  await evaluate('window.screenshotProbe.rememberPixels()')
  const before = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts(), ink: await evaluate('window.screenshotProbe.inkPixels()') }
  const start = Date.now()
  await mouse('mousePressed', x, y, 'left')
  for (let i = 1; i <= count; i++) await mouse('mouseMoved', x + (i / count) * Math.min(300, box.width - 65), y + 40 * Math.sin(i / 25), 'left')
  await mouse('mouseReleased', x + Math.min(300, box.width - 65), y + 40 * Math.sin(count / 25), 'left')
  await settle()
  const after = { counters: { ...receipt.counters }, publications: receipt.publications.length, facts: await facts(), ink: await evaluate('window.screenshotProbe.inkPixels()') }
  const trusted = after.facts.events.slice(before.facts.events.length).filter((event: any) => event.target === 'canvas' && event.trusted)
  assert.ok(trusted.filter((event: any) => event.type === 'pointermove').length >= count, 'Actual continuous CDP pointer samples reach the real Canvas')
  assert.equal(trusted.filter((event: any) => event.type === 'pointerdown').length, 1); assert.equal(trusted.filter((event: any) => event.type === 'pointerup').length, 1)
  assert.ok(after.ink.count > before.ink.count + 100 && after.ink.changed > 100, 'Actual red drawing changes the captured base page; opaque source alpha is not ink')
  assert.deepEqual(after.counters, before.counters, 'drawing-must-not-capture-or-encode-native-chrome')
  assert.equal(pendingOverlayPublications, 0, 'drawing-must-not-request-native-chrome')
  assert.equal(after.publications, before.publications, 'drawing-must-not-publish-native-chrome')
  const renderLatency = after.facts.canvasCost.scene.pointerToRenderMs.filter((value: number) => Number.isFinite(value) && value >= 0)
  assert.ok(renderLatency.length > 0 && renderLatency.length <= count + 1, 'Trusted Canvas pointer receipts produce nonempty observed render latency samples')
  const sortedLatency = renderLatency.slice().sort((a: number, b: number) => a - b)
  receipt.cases.push({ label: 'continuous-pointer-ink-with-zero-native-chrome-work', samples: count, elapsedMs: Date.now() - start, before, after,
    latency: { boundary: 'Trusted Renderer pointer receipt to observed scene Canvas render completion; excludes compositor presentation and unpainted intermediate samples.',
      samples: renderLatency.length, medianMs: sortedLatency[Math.floor(sortedLatency.length / 2)], p95Ms: sortedLatency[Math.ceil(sortedLatency.length * .95) - 1], maxMs: sortedLatency.at(-1) } })
  await shot('editor-ink'); await stage('actual-continuous-pointer-cost-oracle-complete')
}
async function processedOutputs(expected: any) {
  const before = { counters: { ...receipt.counters }, captures: receipt.captures.length }
  const captured = receipt.captures.at(-1).image
  await click('Save PNG', true)
  await until('the actual PNG save returns to the same editor', async () => receipt.exports.length === 1 && !(await facts()).copying)
  const saved = receipt.exports.at(-1)
  assert.equal(saved.result.status, 'saved')
  const png = await readFile(saved.result.path), exported = nativeImage.createFromBuffer(png)
  if (expected) {
    assert.deepEqual(exported.getSize(), { width: expected.width, height: expected.height }, 'actual-Save-PNG-must-use-current-processed-pixels')
    assert.equal(exported.toBitmap().equals(nativeImage.createFromPath(join(out, expected.png.path)).toBitmap()), true, 'actual-Save-PNG-must-use-current-processed-pixels')
  } else {
    const size = exported.getSize(), bytes = exported.toBitmap(), coverAt = (100 * size.width + 120) * 4
    assert.ok(Math.abs(size.width - (captured.width - 80)) <= 2 && Math.abs(size.height - (captured.height - 80)) <= 2,
      'actual-Save-PNG-must-use-current-processed-pixels')
    assert.deepEqual([...bytes.subarray(coverAt, coverAt + 4)], [39, 24, 17, 255], 'actual-Save-PNG-must-use-current-processed-pixels')
  }
  const expectedSize = exported.getSize(), expectedPixels = exported.toBitmap()
  await click('Pin image', true)
  await until('the actual pin owner returns its original opened receipt', async () => receipt.pins.length === 1 && !(await facts()).copying)
  const pinned = receipt.pins.at(-1)
  assert.equal(pinned.result.recordedOperation?.effect, 'opened')
  const reference = await until('the exact production pin window', async () => {
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (candidate === window) continue
      try {
        const document = await candidate.webContents.executeJavaScript('window.screenshotPin?.load()')
        if (document?.pinId === pinned.result.pinId) return { window: candidate, document }
      } catch {}
    }
    return null
  })
  const fixed = nativeImage.createFromDataURL(reference.document.image.dataUrl)
  assert.deepEqual(fixed.getSize(), expectedSize, 'actual-Pin-must-use-current-processed-pixels')
  assert.equal(fixed.toBitmap().equals(expectedPixels), true, 'actual-Pin-must-use-current-processed-pixels')
  assert.equal(reference.window.isAlwaysOnTop(), true)
  assert.equal((await facts()).editor, true, 'Pin retains the original editable image')
  assert.equal(original.getVisible(), false, 'Pin keeps the screenshot in its original Browser workface')
  await shot('processed-output-actions')
  await until('actual fixed reference image decodes', async () => await reference.window.webContents.executeJavaScript('document.querySelector("img")?.naturalWidth > 0'))
  const referenceBytes = (await reference.window.webContents.capturePage()).toPNG(), referencePath = label + '-processed-reference.png'
  await writeFile(join(out, referencePath), referenceBytes)
  receipt.images.push({ path: referencePath, bytes: referenceBytes.length, sha256: createHash('sha256').update(referenceBytes).digest('hex'),
    size: nativeImage.createFromBuffer(referenceBytes).getSize(), kind: 'actual-pinned-window', capture: 'WebContents.capturePage', pid: process.pid,
    webContentsId: reference.window.webContents.id, windowId: reference.window.id })
  const firstClose = await pins.call('image.close', { hostId: 'local', pinId: pinned.result.pinId, operationId: 'close-browser-processed-reference' }, { actor: pinActor })
  assert.equal(firstClose.recordedOperation?.effect, 'closed'); assert.equal(reference.window.isDestroyed(), true)

  loseNextPinReply = true
  await click('Pin image', true)
  await until('lost pin receipt exposes the original read-only recovery action', async () => receipt.pins.length === 2 && await evaluate('!![...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Check pin")') && !(await facts()).copying)
  const originalCreation = receipt.pins.at(-1), errors = (await facts()).errors
  assert.equal(errors.length, receipt.expectedErrors.length + 1)
  assert.match(errors.at(-1), /Pin creation is unconfirmed \(operation /)
  assert.ok(errors.at(-1).includes(originalCreation.operationId), 'The unconfirmed image retains the exact creation operation')
  receipt.expectedErrors.push(errors.at(-1))
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Pin image"]')}).disabled`), false, 'An unconfirmed reference retains an independent explicit pin action')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Save PNG"]')}).disabled`), false, 'An unconfirmed pin retains independent PNG output')
  assert.equal(receipt.counters.originalCapture, before.counters.originalCapture, 'PNG save and pin reuse the original frozen Browser pixels')
  assert.equal(receipt.captures.length, before.captures, 'Independent image outputs never recapture the Browser')
  await click('Cancel', true); await closed('unconfirmed-pin-keeps-original-Browser-after-cancel')
  await openEditor()
  const capturedAgain = { counters: { ...receipt.counters }, captures: receipt.captures.length }
  await until('the new capture retains the earlier unconfirmed reference', async () => await evaluate('!![...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Check pin")'))
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Pin image"]')}).textContent.trim()`), 'Pin another')
  await click('Save PNG', true)
  await until('independent PNG save completes while the original pin remains unconfirmed', async () => receipt.exports.length === 2 && !(await facts()).copying)
  await click('Pin image', true)
  await until('another explicit pin completes without discarding the earlier original operation', async () => receipt.pins.length === 3 && !(await facts()).copying)
  const independentCreation = receipt.pins.at(-1)
  assert.equal(independentCreation.result.recordedOperation?.effect, 'opened')
  assert.notEqual(independentCreation.operationId, originalCreation.operationId)
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Check pin")'), true, 'A successful new reference keeps the earlier original inspection')
  const beforeCheck = BrowserWindow.getAllWindows().length
  await click('Check pin', true)
  await until('read-only inspection restores the original creation receipt', async () => receipt.pinInspections.length === 1 && !await evaluate('!![...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Check pin")') && !(await facts()).copying)
  assert.equal(receipt.pinInspections[0].operationId, originalCreation.operationId)
  assert.equal(receipt.pinInspections[0].result.pinId, originalCreation.result.pinId)
  assert.equal(BrowserWindow.getAllWindows().length, beforeCheck, 'Read-only pin inspection cannot create another window')
  assert.equal(receipt.pins.length, 3, 'A lost creation receipt is never replayed by inspection or a new explicit pin')
  await pins.call('image.close', { hostId: 'local', pinId: originalCreation.result.pinId, operationId: 'close-browser-reconciled-reference' }, { actor: pinActor })
  const retained = await pins.call('image.inspect', { hostId: 'local', pinId: independentCreation.result.pinId }, { actor: pinActor })
  assert.equal(retained.state, 'open', 'Closing the earlier reference retains the separately created healthy pin')
  await pins.call('image.close', { hostId: 'local', pinId: independentCreation.result.pinId, operationId: 'close-browser-independent-reference' }, { actor: pinActor })
  assert.equal(receipt.counters.originalCapture, capturedAgain.counters.originalCapture, 'Further outputs reuse only the second explicitly captured image')
  assert.equal(receipt.captures.length, capturedAgain.captures, 'Pin recovery does not recapture either document')
  await settle()
  const idleBefore = await facts(); await delay(100); const idleAfter = await facts()
  assert.deepEqual(idleAfter.canvasCost, idleBefore.canvasCost, 'Idle image output windows do not continuously repaint the original editor')
  receipt.cases.push({ label: 'actual-processed-PNG-pin-and-original-pin-receipt-recovery', exported: { width: exported.getSize().width, height: exported.getSize().height, bytes: png.length },
    originalCreation: originalCreation.operationId, originalPinId: originalCreation.result.pinId, independentCreation: independentCreation.operationId,
    inspection: receipt.pinInspections[0], before, capturedAgain, after: { counters: { ...receipt.counters }, captures: receipt.captures.length }, idle: { before: idleBefore.canvasCost, after: idleAfter.canvasCost } })
}
function assertSameContextGeometry(actual: any, expected: any, message: string) {
  const { originalImagePixels: actualOriginal, pngPixels: actualPng, ...actualObject } = actual
  const { originalImagePixels: expectedOriginal, pngPixels: expectedPng, ...expectedObject } = expected
  assert.deepEqual(actualObject, expectedObject, message)
  for (const [observed, original] of [[actualOriginal, expectedOriginal], [actualPng, expectedPng]]) {
    assert.deepEqual(Object.keys(observed), Object.keys(original), message)
    for (const key of Object.keys(original)) {
      // Canvas transforms make a float32 round trip. Keep every coordinate within a thousandth of an image pixel.
      assert.ok(Math.abs(observed[key] - original[key]) < .001, message + ': ' + key)
    }
  }
}
async function advancedAnnotationEdits() {
  let opened = await openEditor()
  const captured = receipt.captures.at(-1), width = captured.image.width, height = captured.image.height
  const point = async (x: number, y: number) => imagePointOnScreen(await facts(), x, y)
  const snapshots: any[] = []
  const context = async () => {
    const before = receipt.clipboardText.length
    await click('Copy context', true)
    await until('advanced document reaches its actual context consumer', async () => receipt.clipboardText.length === before + 1 && !(await facts()).copying)
    const text = receipt.clipboardText.at(-1), value = JSON.parse(text.slice(text.indexOf('{')))
    snapshots.push(value); return value
  }
  const from = { x: width * .25, y: height * .3 }, to = { x: width * .55, y: height * .6 }
  await click('Rectangle', true); await drag(await point(from.x, from.y), await point(to.x, to.y))
  const first = await context(), rectangle = first.annotations.find((shape: any) => shape.kind === 'rect')
  assert.ok(rectangle, 'The real Rectangle tool creates a context object before resizing')
  await click('Select', true); await drag(await point(from.x, from.y), await point(from.x, from.y), 1)
  await drag(await point(to.x, to.y), await point(to.x + 100, to.y + 60))
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') await shot('selected-object-handles')
  const resized = (await context()).annotations.find((shape: any) => shape.id === rectangle.id)
  assert.ok(resized.originalImagePixels.width > rectangle.originalImagePixels.width + 90 && resized.originalImagePixels.height > rectangle.originalImagePixels.height + 50,
    'actual-selected-handle-must-resize-the-original-object')
  await click('Undo', true)
  const restored = (await context()).annotations
  assert.equal(restored.length, 1)
  assertSameContextGeometry(restored[0], rectangle, 'Actual Undo restores the same original geometry and ID')
  await click('Redo', true)
  const beforeZoom = await facts(); await click('Zoom in', true); await settle()
  const afterZoom = await facts(); assert.ok(afterZoom.imageView.scale > beforeZoom.imageView.scale, 'The actual zoom action changes painted magnification')
  await click('Pan', true)
  const panStart = { x: afterZoom.canvas.x + afterZoom.canvas.width / 2, y: afterZoom.canvas.y + afterZoom.canvas.height / 2 }
  await drag(panStart, { x: panStart.x + 20, y: panStart.y + 15 })
  const panned = await facts()
  assert.ok(Math.abs(panned.imageView.x - afterZoom.imageView.x - 20) < .1 && Math.abs(panned.imageView.y - afterZoom.imageView.y - 15) < .1,
    'actual-pan-must-translate-the-painted-image')
  assert.deepEqual(panned.canvasPixels, beforeZoom.canvasPixels, 'View changes keep the real Canvas viewport allocation bounded')
  await click('Fit image', true)
  await escape()
  const textAt = { x: width * .2, y: height * .12 }
  await click('Text', true); await drag(await point(textAt.x, textAt.y), await point(textAt.x, textAt.y), 1)
  await fillField('Screenshot text', 'Original editable text'); await key('Enter', 'Enter', 13, process.platform === 'darwin' ? 4 : 2); await settle()
  await click('Select', true); await drag(await point(textAt.x + 4, textAt.y + 4), await point(textAt.x + 4, textAt.y + 4), 1)
  const originalText = (await context()).annotations.find((shape: any) => shape.kind === 'text')
  assert.ok(originalText, 'Existing text has an original annotation identity before editing')
  await click('Edit text', true); await fillField('Screenshot text', 'Edited existing text')
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') await shot('pending-existing-text')
  await key('Enter', 'Enter', 13, process.platform === 'darwin' ? 4 : 2); await settle()
  const editedText = (await context()).annotations.find((shape: any) => shape.id === originalText.id)
  assert.ok(editedText, 'Actual text editing retains the original annotation ID')
  const edited = editedText.originalImagePixels
  await click('Color #ffffff', true)
  await drag(await point(edited.x + edited.width * .1, edited.y + edited.height * .5), await point(width - 8, height - 8))
  const edgeText = (await context()).annotations.find((shape: any) => shape.id === originalText.id)
  assert.ok(edgeText?.originalImagePixels.x > width * .75 && edgeText.originalImagePixels.y > height * .8,
    'The actual selected text moves to the original image edge')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Color #ffffff"]')})?.getAttribute('aria-pressed')`), 'true',
    'The actual selected edge annotation uses the white palette color')
  const previousAppearance = (await facts()).appearance
  assert.equal((await evaluate('window.screenshotProbe.appearance("light")')).applied, true)
  await click('Actual image size', true)
  for (let index = 0; index < 6; index++) await click('Zoom in', true)
  await settle(); const edgeView = (await facts()).imageView
  await click('Edit text', true); await settle()
  const edgeUi = await evaluate(`(()=>{const input=document.querySelector('[aria-label="Screenshot text"]'),viewport=document.querySelector('.image-annotation-editor__viewport');if(!input||!viewport)return null;const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},style=getComputedStyle(input);return{input:rect(input),viewport:rect(viewport),fontSize:parseFloat(style.fontSize),color:style.color,background:style.backgroundColor,focused:document.activeElement===input,scroll:[viewport,viewport.parentElement].map(e=>({left:e.scrollLeft,top:e.scrollTop}))}})()`)
  assert.ok(edgeUi?.focused, 'The actual edge text field owns keyboard input')
  assert.ok(edgeUi.input.left >= edgeUi.viewport.left - .5 && edgeUi.input.top >= edgeUi.viewport.top - .5 &&
    edgeUi.input.right <= edgeUi.viewport.right + .5 && edgeUi.input.bottom <= edgeUi.viewport.bottom + .5,
    'actual-existing-edge-text-input-must-fit-the-viewport')
  assert.ok(edgeUi.fontSize >= 12 && edgeUi.fontSize <= 32)
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    assert.equal(channels?.length, 3, 'The real text control resolves an RGB color')
    return channels!.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [.2126, .7152, .0722][index]!, 0)
  }
  const foreground = luminance(edgeUi.color), background = luminance(edgeUi.background)
  assert.ok((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) >= 4.5,
    'The actual light-theme input remains readable while editing a white annotation')
  assert.deepEqual(edgeUi.scroll, [{ left: 0, top: 0 }, { left: 0, top: 0 }], 'Actual field focus never scrolls the hidden viewport')
  assert.deepEqual((await facts()).imageView, edgeView, 'Pending text focus preserves the painted view transform')
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') await shot('pending-edge-existing-text-light')
  await key('Enter', 'Enter', 13, process.platform === 'darwin' ? 4 : 2); await settle()
  assertSameContextGeometry((await context()).annotations.find((shape: any) => shape.id === originalText.id), edgeText,
    'UI input clamping retains the original object identity and processed image coordinates')
  receipt.edgeText = { ui: edgeUi, originalAnnotation: edgeText, paintedView: edgeView }
  await click('Undo', true); await click('Color #ef4444', true); await click('Fit image', true)
  assert.equal((await evaluate(`window.screenshotProbe.appearance(${JSON.stringify(previousAppearance)})`)).applied, true)
  const noteFrom = { x: width * .7, y: height * .15 }, noteTo = { x: width * .85, y: height * .3 }
  await click('Numbered note', true); await drag(await point(noteFrom.x, noteFrom.y), await point(noteTo.x, noteTo.y))
  await fillField('Marker note', 'MASKED_EDITABLE_NOTE_MUST_NOT_REACH_CONTEXT')
  // macOS Tab preferences differ. Give the visible select focus, then change it through native keys.
  const focusedIntent = await evaluate(`(() => {
    const field = document.querySelector('select[aria-label="Note template"]');
    if (!field || !field.getBoundingClientRect().width) return false;
    field.focus({ preventScroll: true }); return document.activeElement === field;
  })()`)
  assert.equal(focusedIntent, true, 'The real note intent selector receives focus')
  await key('Home', 'Home', 36); await key('ArrowDown', 'ArrowDown', 40); await key('ArrowDown', 'ArrowDown', 40)
  await key('Enter', 'Enter', 13)
  if (await evaluate('window.screenshotProbe.field("Note template")') !== 'expected') {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, text: 'e', unmodifiedText: 'e' })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 })
    await key('Enter', 'Enter', 13)
  }
  assert.equal(await evaluate('window.screenshotProbe.field("Note template")'), 'expected', 'Native keyboard changes the actual note template')
  await click('Locate', true); await click('Fit image', true)
  await click('Cover', true)
  // Start clear of the existing note's hit area so Cover creates a new mark.
  await drag(await point(width * .57, height * .06), await point(width * .94, height * .4))
  const processed = await context()
  assert.ok(processed.annotations.some((shape: any) => shape.kind === 'cover'), 'The real cover reaches the processed output')
  assert.ok(!JSON.stringify(processed).includes('MASKED_EDITABLE_NOTE_MUST_NOT_REACH_CONTEXT') && !processed.annotations.some((shape: any) => shape.kind === 'note'),
    'actual-cover-must-omit-the-masked-note-from-Agent-context')
  const pngCount = receipt.clipboard.length
  await click('Copy PNG', true); await until('actual covered PNG reaches the private sink', async () => receipt.clipboard.length === pngCount + 1 && !(await facts()).copying)
  const png = receipt.clipboard.at(-1), decoded = nativeImage.createFromPath(join(out, png.png.path)), bitmap = decoded.toBitmap()
  const px = Math.floor(noteFrom.x + 10), py = Math.floor(noteFrom.y + 10), offset = (py * png.width + px) * 4
  assert.deepEqual([...bitmap.subarray(offset, offset + 4)], [39, 24, 17, 255], 'actual-Copy-PNG-must-contain-opaque-cover-pixels')
  const filePath = 'annotation original.json', writesBefore = receipt.fileCalls?.filter((row: any) => row.method === 'filesWrite').length ?? 0
  await click('Save original', true); await fillField('Workspace file', filePath)
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') await shot('save-original-file-dialog')
  await click('Save original', 'file')
  await until('the actual file owner writes and closes the request dialog', async () => !(await evaluate('!!document.querySelector(".confirmation-dialog")')))
  const bytes = await readFile(join(workspace.path, filePath)), document = JSON.parse(bytes.toString('utf8'))
  assert.equal(receipt.fileCalls.filter((row: any) => row.method === 'filesWrite').length, writesBefore + 1)
  assert.deepEqual(Object.keys(document), ['schema', 'image', 'shapes', 'crop', 'source'])
  const savedText = document.shapes.find((shape: any) => shape.kind === 'text'), savedNote = document.shapes.find((shape: any) => shape.kind === 'note')
  assert.equal(savedText.id, originalText.id); assert.equal(savedText.text, 'Edited existing text', 'Actual Edit text replaces the same saved object')
  assert.equal(savedNote.note, 'MASKED_EDITABLE_NOTE_MUST_NOT_REACH_CONTEXT'); assert.equal(savedNote.template, 'expected')
  const { url, title, viewport, viewportWarning, hostOverlays } = captured.source
  assert.equal(hostOverlays, 'excluded', 'The live receipt carries native overlay evidence')
  assert.deepEqual(document.source, { url, title, viewport, viewportWarning })
  assert.equal(document.shapes.find((shape: any) => shape.kind === 'rect').id, rectangle.id)
  const savedCorner = document.shapes.find((shape: any) => shape.kind === 'rect').to
  assert.ok(Math.abs(savedCorner.x - to.x - 100) < .001 && Math.abs(savedCorner.y - to.y - 60) < .001,
    'Actual saved resize retains its trusted pointer endpoint in original pixels')
  const savedHeaderStatus = await evaluate('document.querySelector(".image-annotation-editor__header [role=status]")?.textContent')
  assert.equal(savedHeaderStatus, 'Original saved', 'Actual save completion must replace the earlier PNG copy feedback')
  receipt.savedHeaderStatus = savedHeaderStatus
  await shot('advanced-edits-saved-original')
  await click('Cancel', true); await closed('saved-original-cancel')
  const captureCount = receipt.captures.length
  await click('More browser tools')
  await until('the actual More Open item mounts', async () => await evaluate(`document.querySelector(${JSON.stringify('[role="menuitem"][aria-label="Open annotation original"]')})?.getBoundingClientRect().width > 0`))
  await click('Open annotation original')
  await until('the actual More entry opens the file dialog', async () => await evaluate('!!document.querySelector(".confirmation-dialog")'))
  await fillField('Workspace file', filePath); await click('Open original', 'file')
  opened = await until('saved document fully decodes into a fresh editor', async () => { const value = await facts(); return value.editor && value.imageLoaded && !await evaluate('!!document.querySelector(".confirmation-dialog")') ? value : null })
  await settle(); assert.equal(receipt.captures.length, captureCount, 'Opening a saved original never captures the current Browser page')
  const reopened = await context()
  assert.equal(reopened.browserId, null); assert.equal(reopened.navigationId, null); assert.equal(reopened.sourceKind, 'saved-document')
  assert.deepEqual(reopened.source, document.source); assert.deepEqual(reopened.annotations, processed.annotations)
  await shot('reopened-editable-original')
  await click('Cancel', true); await closed('first-reopened-original-cancel')
  const changed = await publicEditOriginal(filePath, document)
  await click('More browser tools')
  await until('the actual More Open item mounts for the public edit', async () => await evaluate(`document.querySelector(${JSON.stringify('[role="menuitem"][aria-label="Open annotation original"]')})?.getBoundingClientRect().width > 0`))
  await click('Open annotation original')
  await until('publicly edited original opens through the actual request dialog', async () => await evaluate('!!document.querySelector(".confirmation-dialog")'))
  await fillField('Workspace file', filePath); await click('Open original', 'file')
  await until('the public file fully decodes into the original GUI consumer', async () => (await facts()).editor && !await evaluate('!!document.querySelector(".confirmation-dialog")'))
  await settle()
  const publicContext = await context(), publicNote = publicContext.annotations.find((shape: any) => shape.id === changed.shapes.find((shape: any) => shape.kind === 'note').id)
  assert.ok(publicNote, 'The explicitly reopened public edit reaches the actual GUI processed context')
  assert.equal(publicNote.note, 'PUBLIC_FILE_EDIT_REOPENED_IN_GUI'); assert.equal(publicNote.template, 'expected')
  assert.deepEqual(publicContext.source, document.source); assert.equal(publicContext.browserId, null); assert.equal(publicContext.navigationId, null)
  assert.equal(receipt.captures.length, captureCount, 'Public file reopen retains the Browser capture owner without another screenshot')
  await shot('public-file-edit-reopened-in-GUI')
  receipt.cases.push({ label: 'actual-handles-view-existing-text-note-template-cover-save-and-More-reopen',
    source: captured.source, snapshots, zoom: { before: beforeZoom.imageView, after: afterZoom.imageView, panned: panned.imageView },
    originalFile: { path: filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), shapeIds: document.shapes.map((shape: any) => shape.id),
      originalImage: { width: document.image.width, height: document.image.height }, retainedHiddenNote: true }, reopened, publicContext, captureCount })
  await click('Cancel', true); await closed('reopened-original-cancel')
}
async function toolbarFocus() {
  const compact = await evaluate(`document.querySelector(${JSON.stringify('button[aria-label="Markup tool"]')})?.getBoundingClientRect().width > 0`)
  if (compact) { await click('Markup tool', true); await escape(); await settle() }
  else await click('Pen', true)
  await key('Tab', 'Tab', 9, 8); await key('Tab', 'Tab', 9); await settle()
  const readFocus = () => evaluate(`(()=>{const node=document.activeElement,toolbar=node?.closest('[role="toolbar"]'),r=node?.getBoundingClientRect(),t=toolbar?.getBoundingClientRect();return {name:node?.getAttribute('aria-label')||node?.textContent.trim(),visible:!!toolbar&&node.checkVisibility({checkVisibilityCSS:true})&&r.width>0&&r.height>0&&r.left>=t.left&&r.right<=t.right&&r.top>=t.top&&r.bottom<=t.bottom}})()`)
  const entry = await readFocus(), moves: any[] = []
  assert.equal(entry.name, compact ? 'Markup tool' : 'Pen', 'Native toolbar entry focuses its actual visible current control')
  assert.equal(entry.visible, true, 'Native toolbar entry cannot focus a CSS-hidden control')
  for (const [value, code, number] of [['Home', 'Home', 36], ['ArrowRight', 'ArrowRight', 39], ['ArrowLeft', 'ArrowLeft', 37], ['End', 'End', 35]] as const) {
    await key(value, code, number); await settle()
    const focused = await readFocus()
    assert.equal(focused.visible, true, 'Native ' + value + ' cannot focus a hidden or clipped toolbar control')
    moves.push({ key: value, ...focused })
  }
  return { compact, entry, moves }
}
async function visualLayout(kind: string, withNoteInput: boolean) {
  const layout = await evaluate(`(()=>{const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},panel=document.querySelector('.image-annotation-editor__notes');return {editor:rect(document.querySelector('.image-annotation-editor')),canvas:rect(document.querySelector('.image-annotation-editor canvas')),panel:rect(panel),fields:[...panel.querySelectorAll('textarea,select,button')].map(node=>({name:node.getAttribute('aria-label')||node.textContent.trim(),...rect(node)})),history:[...document.querySelectorAll('.image-annotation-toolbar__history button')].map(node=>({name:node.getAttribute('aria-label')||node.textContent.trim(),...rect(node)}))}})()`)
  const minimumCanvasHeight = kind.startsWith('short') ? 120 : kind.startsWith('narrow') ? 200 : 220
  assert.ok(layout.canvas.height >= minimumCanvasHeight, kind + ': the real editing Canvas retains a readable height budget')
  assert.ok(layout.panel && layout.fields.length >= (withNoteInput ? 4 : 1), kind + ': the real note controls exist')
  assert.ok(layout.fields.every((field: any) => field.left >= layout.panel.left - 1 && field.right <= layout.panel.right + 1 && field.top >= layout.panel.top - 1 && field.bottom <= layout.panel.bottom + 1), kind + ': no note control is clipped by its actual panel')
  const noteInput = layout.fields.find((field: any) => field.name === 'Note text')
  if (withNoteInput) assert.ok(noteInput?.height >= 40, kind + ': the note input retains its own usable editing area')
  assert.ok(layout.history.every((button: any) => button.left >= layout.editor.left && button.right <= layout.editor.right && button.top >= layout.editor.top && button.bottom <= layout.editor.bottom), kind + ': history remains visible beside the current tool controls')
  return { ...layout, minimumCanvasHeight }
}
async function visualScene(kind: string, width: number, height: number, appearance: 'dark' | 'light') {
  window.setContentSize(width, height)
  assert.equal((await evaluate(`window.screenshotProbe.appearance(${JSON.stringify(appearance)})`)).applied, true)
  await settle(); const opened = await openEditor(), box = opened.canvas, source = receipt.captures.at(-1).image
  const focus = await toolbarFocus()
  await click('Numbered note', true)
  const noteView = await facts()
  await drag(imagePointOnScreen(noteView, source.width * .55, source.height * .4), imagePointOnScreen(noteView, source.width * .82, source.height * .65))
  await fillField('Marker note', 'Review this captured control')
  const noteLayout = await visualLayout(kind, true)
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
  const layout = await visualLayout(kind, false)
  const exportsBefore = receipt.exports.length
  let busyPan: any = null
  if (kind.startsWith('narrow')) {
    await evaluate('window.screenshotProbe.holdEncoding()'); await click('Save PNG', true)
    await until('the actual narrow PNG encoder is held', async () => (await facts()).encodingHeld)
    await click('Pan', true)
    const before = await facts(), at = { x: before.canvas.x + before.canvas.width / 2, y: before.canvas.y + before.canvas.height / 2 }
    await drag(at, { x: at.x + 18, y: at.y + 12 })
    const after = await facts()
    assert.equal(after.copying, true, 'Pan remains independent of the held PNG output')
    assert.ok(Math.abs(after.imageView.x - before.imageView.x - 18) < 1 && Math.abs(after.imageView.y - before.imageView.y - 12) < 1, 'The actual busy narrow Pan remains usable through the tool selector')
    busyPan = { before: before.imageView, after: after.imageView }
  }
  receipt.cases.push({ label: 'visual-' + kind, appearance, width, height, facts: final, layout, noteLayout, minimumCanvasHeight: layout.minimumCanvasHeight, focus, busyPan })
  await click('Cancel', true); await closed('visual-' + kind + '-cancel'); await stage('visual-' + kind + '-complete')
  if (busyPan) {
    await evaluate('window.screenshotProbe.releaseEncoding()'); await settle()
    assert.equal(receipt.exports.length, exportsBefore, 'A cancelled narrow output never reaches the file owner after late encoding')
  }
}
async function visualScenes() {
  for (const [kind, width, height, appearance] of [
    ['normal-dark', 1040, 740, 'dark'], ['narrow-dark', 450, 640, 'dark'], ['short-dark', 880, 390, 'dark'],
    ['normal-light', 1040, 740, 'light'], ['narrow-light', 450, 640, 'light'], ['short-light', 880, 390, 'light']
  ] as const) await visualScene(kind, width, height, appearance)
}
async function publicScreenshot(program: string) {
  const graph = parseAgentMuxSpatialGraph({ spaces: [], zones: [{ zoneId: 'annotation-zone', workspaceId, kind: 'directory', hostId: 'local', directoryPath: workspace.path, branch: null }],
    tabs: [{ tabId: 'annotation-tab', zoneId: 'annotation-zone', workspaceId, name: null, regionIds: ['private-original-region'] }],
    regions: [{ regionId: 'private-original-region', tabId: 'annotation-tab', kind: 'browser', agentSessionId: null, runId: null, execution: null }], bindings: [],
    layouts: { [workspaceId]: createWorkspaceLayout('annotation-group', ['annotation-tab']) },
    tabLayouts: { 'annotation-tab': { root: { type: 'leaf', regionId: 'private-original-region' }, activeRegionId: 'private-original-region' } }, resources: { 'annotation-tab': { browserId: originalId } } })
  publicServer = new AgentMuxControlServer({
    coreClients: () => [],
    files: new FileReadOwner({ files, workspace: id => id === workspaceId ? workspace : undefined, catalog: async () => spatialCatalog(graph) }),
    execute: async request => {
      if (request.operation === 'space.inspect') return { operation: 'space.inspect', catalog: spatialCatalog(graph, request.target as any) }
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
async function publicEditOriginal(path: string, originalDocument: any) {
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: publicServer.path } })
  let read: any
  try { read = await rpc.call('file.read', { zoneId: 'annotation-zone', path,
    expectedResource: { hostId: 'local', workspaceId, workspacePath: workspace.path } }) }
  finally { await rpc.dispose() }
  assert.equal(read.result.status, 'read', 'The actual public SDK reads the file created by the original GUI owner')
  assert.deepEqual(JSON.parse(read.result.document.content), originalDocument)
  assert.deepEqual(read.resource, { hostId: 'local', workspaceId, workspacePath: workspace.path, zoneId: 'annotation-zone', zonePath: workspace.path, path })
  const changed = structuredClone(originalDocument), note = changed.shapes.find((shape: any) => shape.kind === 'note')
  note.note = 'PUBLIC_FILE_EDIT_REOPENED_IN_GUI'; note.from = { x: 60, y: 110 }; note.to = { x: 300, y: 230 }
  const content = JSON.stringify(changed), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_RPC_ENDPOINT: 'unix:' + publicServer.path,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'file-cli-runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'file-cli-state') })
  const cli = await new Promise<{ code: number | null; stdout: string; stderr: string; pid: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.AGENTMUX_SCREENSHOT_CLI!, 'file', 'write', '--zone', 'annotation-zone', '--path', path,
      '--resource', JSON.stringify(read.resource), '--expected-revision', read.result.document.revision], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation: ReturnType<typeof setTimeout> | undefined
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 500) }, 7000)
    child.once('error', error => { clearTimeout(timeout); clearTimeout(escalation); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); clearTimeout(escalation); expired ? reject(new Error('The exact private file CLI child timed out and exited')) : resolve({ code, stdout, stderr, pid: child.pid! }) })
    child.stdin.end(content)
  })
  assert.equal(cli.code, 0, cli.stderr + cli.stdout)
  const result = JSON.parse(cli.stdout)
  assert.equal(result.ok, true); assert.equal(result.operation, 'file.write'); assert.equal(result.result.result.status, 'written')
  assert.deepEqual(result.result.resource, read.resource)
  assert.equal(await readFile(join(workspace.path, path), 'utf8'), content, 'Actual CLI writes bytes to the same original GUI file owner')
  receipt.publicFiles = { sdk: { resource: read.resource, revision: read.result.document.revision,
    bytes: Buffer.byteLength(read.result.document.content), sha256: createHash('sha256').update(read.result.document.content).digest('hex') },
    cli: { ...cli, result }, changedShapeId: note.id, contentSha256: createHash('sha256').update(content).digest('hex') }
  return changed
}
async function run() {
  await stage('private-process-start')
  await app.whenReady(); await stage('electron-ready')
  receipt.loadedCompiled = Object.fromEntries(await Promise.all(['app/out/main/main.mjs', 'app/resources/bin/agentmux-workspace-move', 'renderer.js', 'renderer.css', 'preload.cjs',
    'app/out/preload/screenshot-pin.cjs', 'app/out/renderer/screenshot-pin/entry.js', 'app/out/renderer/screenshot-pin/entry.css', 'app/out/renderer/screenshot-pin/index.html']
    .map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  const workspacePath = join(root, 'workspace'); await mkdir(workspacePath)
  workspace = { id: workspaceId, name: 'Private annotation files', hostId: 'local', path: workspacePath, kind: 'folder' }
  files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local', label: 'Private local files', run: async () => { throw new Error('Remote execution is outside this file proof') }, dispose: async () => {} }))
  pins = new ScreenshotPins({ hostId: 'local', appearance: () => ({ terminalTheme: 'graphite' }), copy: async () => { throw new Error('Pin clipboard is outside this Browser output proof') } })
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
    const image = await chromeCapture(...args), encode = image.toPNG.bind(image)
    image.toPNG = (...args) => { receipt.counters.rendererEncode++; return encode(...args) }
    return image
  }
  ipcMain.handle('screenshot:call', async (event, method, ...args) => {
    assert.equal(event.sender, window.webContents, 'Private bridge belongs to this exact Renderer')
    const frame = event.senderFrame
    if (method === 'registerPresentation') {
      assert.equal(args[0].browserId, originalId)
      assert.ok(frame)
      return manager.registerPresentation(event.sender, frame, args[0], { processId: frame.processId, frameToken: frame.frameToken })
    }
    if (method === 'updatePresentation') return manager.updatePresentation(event.sender, frame, args[0], args[1])
    if (method === 'removePresentation') return manager.removePresentation(event.sender, frame, args[0])
    if (method === 'activatePresentation') return await manager.activatePresentation(event.sender, frame, args[0], args[1])
    if (method === 'armPresentationCapture') return manager.armPresentationCapture(event.sender, frame, args[0])
    if (method === 'ackPresentationCapture') return manager.ackPresentationCapture(event.sender, frame, args[0], args[1])
    if (method === 'setup') return { original: originalSnapshot, sibling: siblingSnapshot }
    if (method === 'nativeBrowserVisibility') return manager.nativeBrowserVisibility()
    if (method === 'publishNativeOverlays') {
      pendingOverlayPublications++
      try {
        const result = await overlays.update(args[0])
        receipt.publications.push({ count: args[0].length, result })
        return result
      } finally { pendingOverlayPublications-- }
    }
    if (method === 'privateClipboard') {
      assert.equal(args[0].mimeType, 'image/png'); assert.ok(args[0].dataUrl.startsWith('data:image/png;base64,'))
      const decoded = nativeImage.createFromDataURL(args[0].dataUrl), size = decoded.getSize(), png = decoded.toPNG()
      assert.ok(!decoded.isEmpty()); assert.equal(size.width, args[0].width); assert.equal(size.height, args[0].height)
      const path = label + '-clipboard-' + (receipt.clipboard.length + 1) + '.png'; await writeFile(join(out, path), png)
      receipt.clipboard.push({ byteLength: args[0].byteLength, width: size.width, height: size.height,
        png: { path, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } })
      return { status: 'copied', sequence: receipt.clipboard.length }
    }
    if (method === 'privateClipboardText') { assert.equal(typeof args[0], 'string'); receipt.clipboardText.push(args[0]); return { status: 'copied', sequence: receipt.clipboardText.length } }
    if (method === 'exportScreenshot') {
      const input = args[0]
      const result = await exportScreenshotPng(input.image, { capturedAt: input.capturedAt }, {
        chooseFile: async () => join(out, label + '-processed-output-' + receipt.exports.length + '.png'),
        writeFile: writeScreenshotFile,
        resize: (bytes, size) => nativeImage.createFromBuffer(Buffer.from(bytes)).resize(size).toPNG()
      })
      receipt.exports.push({ capturedAt: input.capturedAt, result }); return result
    }
    if (method === 'pinScreenshot') {
      const input = args[0], image = input.image
      const result = await pins.call('image.pin', { hostId: 'local', operationId: input.operationId,
        image: { format: 'png', data: image.dataUrl.slice('data:image/png;base64,'.length), width: image.width, height: image.height, scale: 1 } }, { actor: pinActor })
      const lost = loseNextPinReply; loseNextPinReply = false
      receipt.pins.push({ operationId: input.operationId, result, replyLost: lost })
      if (lost) throw new Error('The private pin IPC reader lost the original creation response.')
      return result
    }
    if (method === 'inspectScreenshotPin') {
      const result = await pins.call('image.inspect', { hostId: 'local', operationId: args[0] }, { actor: pinActor })
      receipt.pinInspections.push({ operationId: args[0], result }); return result
    }
    if (method === 'filesRead' || method === 'filesWrite') {
      assert.equal(args[0], workspaceId, 'The annotation file operation retains its exact private Workspace')
      receipt.fileCalls ??= []
      receipt.fileCalls.push({ method, workspaceId: args[0], input: args[1] })
      return method === 'filesRead' ? await files.read(workspace, args[1]) : await files.write(workspace, args[1])
    }
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
    if (method === 'setAnnotationMarkers') return await manager.setAnnotationMarkers(args[0], args[1], args[2])
    if (method === 'cancelElementSelection') return await manager.cancelElementSelection(args[0])
    throw new Error('Unexpected private IO: ' + method)
  })
  await window.loadFile(join(root, 'index.html')); window.show(); window.focus(); window.webContents.focus()
  receipt.rendererDocument = { url: window.webContents.getURL(), webContentsId: window.webContents.id, windowId: window.id }
  window.webContents.debugger.attach('1.3')
  await until('the exact editor workface is actually foreground', async () => window.isVisible() && window.isFocused() && await evaluate('document.visibilityState === "visible" && document.hasFocus()'))
  receipt.windowPresentation = { visible: window.isVisible(), focused: window.isFocused(), focusedWindowId: BrowserWindow.getFocusedWindow()?.id,
    visibility: await evaluate('document.visibilityState'), documentFocused: await evaluate('document.hasFocus()') }
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
  const human = manager.takeControl(originalId)
  assert.equal(human.control?.owner, 'human', 'The screenshot editor starts after explicit human takeover of the original page')
  assert.equal(human.navigationId, originalSnapshot.navigationId)
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL_PILOT === '1') {
    receipt.scope = 'actual-Renderer-visual-pilot-only-not-feature-acceptance'
    await openEditor(); await click('Cancel', true); await closed('visual-pilot-initial-cancel')
    await visualScenes(); assert.deepEqual((await facts()).errors, []); receipt.passed = true; return
  }
  const originalCapturesBeforeEditing = receipt.counters.originalCapture
  const opened = await openEditor()
  assert.equal(receipt.calls.filter((row: any) => row.method === 'captureScreenshot').length, 1)
  if (process.env.AGENTMUX_SCREENSHOT_OUTPUTS_ONLY === '1') {
    receipt.scope = 'actual-BrowserPane-processed-output-vertical-slice-not-full-editor-regression'
    await click('Cover', true)
    await drag(imagePointOnScreen(await facts(), 80, 90), imagePointOnScreen(await facts(), 240, 190))
    const source = receipt.captures.at(-1).image
    await click('Crop', true)
    const view = await facts()
    await drag(imagePointOnScreen(view, 40, 40), imagePointOnScreen(view, source.width - 40, source.height - 40))
    await processedOutputs(null)
    await click('Cancel', true); await closed('processed-outputs-final-cancel')
    assert.equal(receipt.captures.length, 2, 'Only the two explicit output-scenario captures acquire Browser pixels')
    if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') await visualScenes()
    assert.deepEqual((await facts()).errors, receipt.expectedErrors)
    receipt.passed = true
    return
  }
  await measurePointerWork(opened)
  await click('Cancel', true); await click('Discard', true); await closed('native-pointer-cancel')
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
  await openEditor(); await capabilityEdits()
  await until('normal Copy completes and keeps the same Editor available', async () => receipt.clipboard.length === 2 && (await facts()).editor && !(await facts()).copying)
  assert.equal(original.getVisible(), false, 'Copy PNG keeps the original screenshot working surface')
  await click('Copy PNG', true)
  await until('the real Editor supports another explicit Copy', async () => receipt.clipboard.length === 3 && !(await facts()).copying)
  receipt.cases.push({ label: 'normal-copy-keeps-editor-and-allows-explicit-recopy', clipboard: receipt.clipboard.slice(), after: await facts() })
  await click('Cancel', true); await closed('copy-followed-by-explicit-cancel')
  await stage('actual-edits-and-pending-copy-Cancel-complete')
  assert.equal(receipt.captures.length, 6, 'The six explicit Desktop capture entries each produce one original image')
  assert.equal(receipt.counters.originalCapture - originalCapturesBeforeEditing, receipt.captures.length, 'Each Desktop image uses the original native capture consumer once')
  await advancedAnnotationEdits(); await stage('actual-annotation-file-and-geometry-consumers-complete')
  if (process.env.AGENTMUX_SCREENSHOT_VISUAL === '1') {
    await visualScenes()
  }
  assert.deepEqual((await facts()).errors, receipt.expectedErrors)
  receipt.passed = true
}
void run().catch(async error => {
  receipt.failure = { message: error.message, stack: error.stack }
  try { receipt.failure.facts = await facts(); receipt.failure.fields = await evaluate('[...document.querySelectorAll("textarea,select")].map(e=>({label:e.getAttribute("aria-label"),value:e.value,rect:e.getBoundingClientRect().toJSON()}))'); await shot('failure') } catch {}
}).finally(async () => {
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write('cleanup-renderer-start\n')
  try { if (window && !window.isDestroyed()) await evaluate('window.screenshotProbe?.dispose()') } catch {}
  process.stdout.write('cleanup-public-start\n')
  await publicServer?.stop()
  process.stdout.write('cleanup-files-start\n')
  await files?.dispose()
  pins?.dispose()
  process.stdout.write('cleanup-native-start\n')
  overlays?.dispose(); process.stdout.write('cleanup-overlays-complete\n')
  manager?.dispose(); process.stdout.write('cleanup-manager-complete\n')
  server?.close(); process.stdout.write('cleanup-server-complete\n')
  if (window && !window.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  process.stdout.write('cleanup-debugger-complete\n')
  window?.destroy(); process.stdout.write('cleanup-window-complete\n')
  app.exit(receipt.passed ? 0 : 1)
})
