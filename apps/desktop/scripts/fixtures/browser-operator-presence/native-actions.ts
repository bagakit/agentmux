import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage, type WebContents } from 'electron'
import type { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { validateBrowserOperatorAvatarPng } from '../../../src/main/browser-operator-avatar.js'
import { inspectOriginalDocument, observeClickAcknowledgement } from './document-state.js'

function png(width: number, height: number) {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let index = 0; index < bitmap.length; index += 4) { bitmap[index] = 200; bitmap[index + 1] = 100; bitmap[index + 2] = 40; bitmap[index + 3] = 255 }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}
const dataUrl = (bytes: Buffer) => 'data:image/png;base64,' + bytes.toString('base64')
const operator = { id: 'original-agent', name: 'Original Agent' }

/** Actual native PNG decoding and BVM ownership; Renderer artwork is a separate consumer. */
export async function avatarAndFrames(manager: BrowserViewManager, contents: WebContents, url: string, receipt: any) {
  const avatar = dataUrl(png(64, 64)), non64 = dataUrl(png(32, 64)), oversized = dataUrl(Buffer.concat([png(64, 64), Buffer.alloc(65 * 1024)]))
  assert.equal(validateBrowserOperatorAvatarPng(avatar), avatar, 'The actual native decoder accepts the bounded 64px PNG')
  const identity = { browserId: 'original', operationId: 'avatar-original-owner', operatorId: operator.id }
  const row: any = { name: 'validated-avatar-original-owner', passed: false }
  receipt.cases.push(row)
  const report = await manager.runScript('original', 'const s=await snapshot();const n=s.nodes.find(n=>n.name==="Original action");await hover(n.ref);return n', operator, undefined, identity.operationId, () => {
    assert.equal(manager.setOperatorAvatar({ ...identity, browserId: 'absent', png: avatar }), false)
    assert.equal(manager.setOperatorAvatar({ ...identity, operationId: 'old-owner', png: avatar }), false, 'Old operation avatar bytes cannot enter a new live owner')
    assert.equal(manager.setOperatorAvatar({ ...identity, operatorId: 'another-agent', png: avatar }), false, 'A foreign operator cannot decorate the actual live owner')
    assert.equal(manager.setOperatorAvatar({ ...identity, png: non64 }), false, 'The actual setter rejects a different decoded size')
    assert.equal(manager.setOperatorAvatar({ ...identity, png: oversized }), false, 'The actual setter rejects oversized original PNG bytes')
    assert.equal(manager.setOperatorAvatar({ ...identity, png: avatar }), true, 'The actual live owner receives its validated image')
    assert.equal(manager.setOperatorAvatar({ ...identity, png: avatar }), false, 'The original operation has one immutable avatar')
  })
  assert.equal(report.outcome.kind, 'completed', 'Bad cosmetic requests preserve the healthy original action')
  const observed = await inspectOriginalDocument(contents, report.result as any)
  assert.equal(observed.state.connected, true)
  assert.equal(observed.state.image?.src, avatar, 'The actual native cue consumed the accepted original PNG')
  assert.equal(observed.state.image?.complete, true)
  assert.equal(observed.state.image?.width, 64); assert.equal(observed.state.image?.height, 64)
  assert.ok(observed.state.label.text.includes(operator.name))
  Object.assign(row, { passed: true, report, observed, artworkSource: 'nativeImage-generated test PNG; not Renderer canvas' })

  manager.setBounds('original', null)
  const hidden = await contents.executeJavaScriptInIsolatedWorld(1209, [{ code: '({action:!!globalThis.__agentMuxBrowserOperationFeedback?.host?.isConnected,control:!!globalThis.__agentMuxBrowserControlFeedback?.host?.isConnected})' }])
  assert.deepEqual(hidden, { action: false, control: false }, 'Explicit Main hide invalidates both visible decorations')
  manager.setBounds('original', { x: 0, y: 0, width: 800, height: 588 })
  const fresh = await manager.runScript('original', 'const s=await snapshot();const n=s.nodes.find(n=>n.name==="Original action");await hover(n.ref);return n', operator, undefined, 'fresh-owner', () => {
    assert.equal(manager.setOperatorAvatar({ ...identity, png: avatar }), false, 'An ended original owner cannot decorate a fresh operation')
  })
  assert.equal(fresh.outcome.kind, 'completed')
  const freshState = await inspectOriginalDocument(contents, fresh.result as any)
  assert.equal(freshState.state.image, null, 'Hide and a fresh owner never resurrect the old avatar')
  receipt.cases.push({ name: 'hide-and-new-owner-invalidate-avatar', passed: true, hidden, observed: freshState })

  await contents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify('<iframe style="display:block;width:700px;height:150px" title="Local document" src="' + url.replace('/original', '/frame?kind=local') + '"></iframe><iframe style="display:block;width:700px;height:150px" title="Separate document" src="' + url.replace('127.0.0.1', 'localhost').replace('/original', '/frame?kind=separate') + '"></iframe>')})`)
  // Snapshot discovers the actual two frame protocols. No guessed CDP identity is supplied.
  const frameRows: any[] = []
  for (const kind of ['local', 'separate']) {
    const frameCase: any = { name: 'actual-frame-pointer-label-and-ack', kind, passed: false }
    receipt.cases.push(frameCase)
    const moving = await manager.runScript('original', `await waitForElement(${JSON.stringify(kind + ' right')},6000);const s=await snapshot();const a=s.nodes.find(n=>n.name===${JSON.stringify(kind + ' left')});const b=s.nodes.find(n=>n.name===${JSON.stringify(kind + ' right')});if(!a||!b)throw new Error('Original frame controls not loaded');await hover(a.ref);await hover(b.ref);return b`, operator, undefined, 'move-' + kind)
    assert.equal(moving.outcome.kind, 'completed')
    // Chromium may not have assigned pending animations to its timeline before
    // the dispatch result returns. Request an actual compositor frame, without
    // moving either clock or extending the original completed-cue lifetime.
    const nativeFrame = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    assert.equal(nativeFrame.isEmpty(), false)
    const file = process.env.AGENTMUX_PRESENCE_LABEL + '-frame-' + kind + '.png', bytes = nativeFrame.toPNG()
    await writeFile(join(process.env.AGENTMUX_PRESENCE_OUTPUT!, file), bytes)
    receipt.captures.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), size: nativeFrame.getSize(),
      boundary: 'Original native page compositor frame; not OS whole-window or elapsed motion proof' })
    const moved = await inspectOriginalDocument(contents, moving.result as any)
    Object.assign(frameCase, { moved, nativeFrame: { file, size: nativeFrame.getSize() } })
    assert.equal(Boolean(moved.document.sessionId), kind === 'separate', 'Two actual documents use their distinct in-process and separate-session senders')
    assert.ok(moved.document.depth > 0)
    assert.equal(moved.state.connected, true)
    assert.ok(moved.state.label.text.includes(operator.name))
    assert.equal(moved.state.reducedMotion, false, 'The motion observation explicitly requires the native non-reduced preference')
    const pointer = moved.state.pointer.animations[0], label = moved.state.label.animations[0]
    assert.ok(pointer && label, 'Both the actual pointer and its label retain the native move')
    assert.equal(pointer.playState, 'running', 'The original pointer is running or pending its native timeline')
    assert.equal(label.playState, 'running', 'The label must not be paused by the original pending pointer clock')
    assert.equal(pointer.duration, 1000); assert.equal(label.duration, 1000)
    assert.equal(pointer.startTime, label.startTime, 'Pointer and name move on the same native animation clock')
    frameCase.timeline = { state: pointer.startTime === null ? 'pending-original-timeline' : 'original-clock-started',
      elapsedMotion: pointer.currentTime > 0 && label.currentTime > 0 ? 'observed' : 'not-observed',
      boundary: 'Original native Animation states and keyframes; a pending clock is not proof of elapsed visual motion.' }
    assert.equal(pointer.keyframes.length, 2); assert.equal(label.keyframes.length, 2)
    const translate = (value: string) => {
      const match = value.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/u)
      assert.ok(match, 'The actual native keyframe contains its source translation')
      return match.slice(1).map(Number)
    }
    const delta = (frames: any[]) => { const a = translate(frames[0].transform), b = translate(frames[1].transform); return b.map((value, index) => value - a[index]!) }
    const pointerDelta = delta(pointer.keyframes), labelDelta = delta(label.keyframes)
    frameCase.serializedDeltas = { pointer: pointerDelta, label: labelDelta, cssPixelRoundingTolerance: 0.01 }
    assert.ok(pointerDelta.every((value, index) => Math.abs(value - labelDelta[index]!) <= 0.01),
      'The unobstructed frame keeps the actual pointer and name moving together within serialized CSS rounding')
    const ack = observeClickAcknowledgement(contents)
    let clicked: any
    try { clicked = await manager.runScript('original', `const s=await snapshot();const n=s.nodes.find(n=>n.name===${JSON.stringify(kind + ' right')});await click(n.ref);return n`, operator, undefined, 'click-' + kind) }
    finally { ack.restore() }
    assert.equal(clicked.outcome.kind, 'completed')
    const confirmed = await inspectOriginalDocument(contents, clicked.result)
    assert.equal(ack.evidence.length, 1, 'Exactly one actual source-resolved click response was observed')
    assert.equal(ack.evidence[0].exception, null)
    assert.equal(confirmed.state.clicks, 1, 'The original frame received the healthy action')
    assert.deepEqual(confirmed.state.ripples, ['click-' + kind], 'Only the successful original dispatch ACK produces its ripple')
    Object.assign(frameCase, { passed: true, moved, ack: ack.evidence, confirmed })
    frameRows.push(moved.document)
  }
  assert.notEqual(frameRows[0].frameId, frameRows[1].frameId)
  const previousNavigation = manager.target('original')!.navigationId
  await manager.navigate('original', url + '?fresh-document')
  assert.notEqual(manager.target('original')!.navigationId, previousNavigation)
  const navigated = await contents.executeJavaScriptInIsolatedWorld(1209, [{ code: '({action:!!globalThis.__agentMuxBrowserOperationFeedback?.host?.isConnected,control:!!globalThis.__agentMuxBrowserControlFeedback?.host?.isConnected})' }])
  assert.deepEqual(navigated, { action: false, control: false }, 'A new actual document cannot retain old ownership or artwork')
  receipt.cases.push({ name: 'navigation-invalidates-original-decoration', passed: true, previousNavigation, navigationId: manager.target('original')!.navigationId, observed: navigated })
}
