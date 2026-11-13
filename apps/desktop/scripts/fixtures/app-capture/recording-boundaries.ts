import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppRecordingOwner } from '../../../src/main/app-recording.js'
import { createAppCapturePort } from '../../../src/main/app-capture-owner.js'
import { withCaptureProof, type CaptureProof } from './bootstrap.js'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
async function ready(context: CaptureProof, name: string) {
  for (let i = 0; i < 40; i++) {
    if (await context.window.webContents.executeJavaScript(`typeof globalThis[${JSON.stringify(name)}]==='function'`)) return
    await delay(30)
  }
  throw new Error('The actual Renderer did not retain the original pending observation.')
}

void withCaptureProof(async context => {
  const originalPort = context.captures.call, owners: AppRecordingOwner[] = []
  const actor = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
  const windows = BrowserWindow.getAllWindows().length
  try {
    const firstPixels = await context.cli('app.capture', { target: context.target })
    assert.equal(firstPixels.ok, true, 'The real pixel source must be presented before a pending observation is tested: ' + JSON.stringify(firstPixels))
    let captures = 0
    const directory = join(context.root, 'pending-recordings')
    const pending = new AppRecordingOwner({ directory, capture: async target => {
      captures++
      const frame = await context.source.capture(target)
      // An actual healthy Chromium document can keep an observation Promise open.
      // This is a consumer fault injection, not a fictitious dead Renderer.
      await context.window.webContents.executeJavaScript('new Promise(resolve=>{globalThis.releasePendingRecording=resolve})')
      return frame
    } })
    owners.push(pending); context.captures.call = createAppCapturePort(context.source, pending).call
    const id = 'pending-original'
    assert.equal((await context.cli('app.record.start', { operationId: id, target: context.target, durationMs: 1000, fps: 8 })).ok, true)
    await ready(context, 'releasePendingRecording')
    assert.equal(await context.window.webContents.executeJavaScript('6*7'), 42, 'The original Renderer remains healthy during a pending observation')
    const path = join(directory, `${hash(id)}.json`), before = await readFile(path)
    const shadow = new AppRecordingOwner({ directory, capture: async () => { throw new Error('A second observer cannot restart the original producer') } })
    owners.push(shadow)
    const observed = await shadow.call('app.record.inspect', { operationId: id }, { actor })
    assert.equal(observed.recording?.state, 'starting', 'a live original producer cannot be declared interrupted')
    assert.deepEqual(await readFile(path), before, 'A second observer cannot rewrite a healthy original producer')
    await assert.rejects(shadow.call('app.record.stop', { operationId: id }, { actor }), { code: 'APP_RECORDING_OWNER_UNCONFIRMED' })
    const stopAt = performance.now(), stopped = await context.cli('app.record.stop', { operationId: id })
    assert.equal(stopped.ok, true, JSON.stringify(stopped)); assert.equal(stopped.result.recording.state, 'stopping')
    assert.ok(performance.now() - stopAt < 2000, 'Stop observation is bounded while the native source remains unconfirmed')
    assert.ok(stopped.result.recording.issues.some((message: string) => message.includes('unsettled') || message.includes('not settled')))
    const disposeAt = performance.now(); await pending.dispose()
    assert.ok(performance.now() - disposeAt < 2000, 'Dispose must not wait forever for a healthy page observation')
    const disposed = await pending.call('app.record.inspect', { operationId: id }, { actor })
    assert.equal(disposed.recording?.state, 'interrupted', 'disposal ends only this recording observer and retains unknown native completion')
    assert.equal(disposed.recording?.finishedAt, null)
    await context.window.webContents.executeJavaScript('globalThis.releasePendingRecording();delete globalThis.releasePendingRecording')
    await delay(100)
    const late = await pending.call('app.record.inspect', { operationId: id }, { actor })
    assert.equal(late.recording?.state, 'interrupted'); assert.equal(late.recording?.frameCount, 0, 'A late source result cannot append or replace a disposed original')
    assert.equal(captures, 1); assert.equal(await context.window.webContents.executeJavaScript('6*7'), 42)
    context.report.checks.push('real-pending-Renderer-stays-usable', 'original-live-producer-is-not-rewritten', 'bounded-stop-observation', 'bounded-dispose', 'late-result-keeps-original-state')

    let samples = 0
    const deadline = new AppRecordingOwner({ directory: join(context.root, 'deadline-recordings'), capture: async target => {
      const frame = await context.source.capture(target)
      if (++samples === 2) await context.window.webContents.executeJavaScript('new Promise(resolve=>{globalThis.releaseDeadlineRecording=resolve})')
      return frame
    } })
    owners.push(deadline); context.captures.call = createAppCapturePort(context.source, deadline).call
    const deadlineId = 'deadline-original'
    assert.equal((await context.cli('app.record.start', { operationId: deadlineId, target: context.target, durationMs: 1000, fps: 8 })).ok, true)
    await ready(context, 'releaseDeadlineRecording'); await delay(1100)
    await context.window.webContents.executeJavaScript('globalThis.releaseDeadlineRecording();delete globalThis.releaseDeadlineRecording')
    let final
    for (let i = 0; i < 30; i++) {
      final = await context.cli('app.record.inspect', { operationId: deadlineId })
      if (final.result.recording.state === 'completed') break
      await delay(40)
    }
    assert.equal(final.result.recording.state, 'completed', JSON.stringify(final))
    assert.equal(final.result.recording.frameCount, 1, 'A frame delivered after the original duration deadline cannot be appended')
    assert.equal(BrowserWindow.getAllWindows().length, windows, 'Every dedicated encoder ends without closing the original page')
    context.report.checks.push('late-duration-frame-omitted', 'encoder-released-original-page-kept')

    context.captures.call = originalPort
    const contents = context.window.webContents, originalCapture = contents.capturePage.bind(contents)
    for (const shape of ['geometry', 'navigation']) {
      context.browsers.setBounds(context.browserId, { x: 300, y: 180, width: 400, height: 260 })
      let attempts = 0, changed = false
      contents.capturePage = async (...args: Parameters<typeof contents.capturePage>) => {
        const pixels = await originalCapture(...args)
        if (++attempts === 2) {
          changed = true
          if (shape === 'geometry') context.browsers.setBounds(context.browserId, { x: 320, y: 180, width: 380, height: 260 })
          else {
            const page = context.browsers.captureWorkbenchViews(context.window).find(page => page.browserId === context.browserId)!
            const url = new URL(page.view.webContents.getURL()); url.pathname = '/changed-native-document'
            await context.browsers.navigate(context.browserId, url.href)
            await page.view.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
          }
        }
        return pixels
      }
      try {
        const operationId = `frame-gap-${shape}`, start = await context.cli('app.record.start', { operationId, target: context.target, durationMs: 1200, fps: 8 })
        assert.equal(start.ok, true, JSON.stringify(start))
        let result
        for (let i = 0; i < 40; i++) {
          result = await context.cli('app.record.inspect', { operationId })
          if (['completed', 'partial', 'failed', 'interrupted'].includes(result.result.recording.state)) break
          await delay(40)
        }
        assert.ok(changed, 'The native source must actually change during capture')
        assert.equal(result.result.recording.state, 'partial', 'A same-document frame gap must retain the original recording')
        assert.ok(result.result.recording.gaps.some((gap: any) => gap.code === 'APP_CAPTURE_FRAME_CHANGED' && gap.startedAt <= gap.observedAt))
        assert.ok(result.result.recording.frameCount >= 2, 'The same original sampler continues with new frames after a gap')
        assert.equal(result.result.recording.requestedAt, start.result.recording.requestedAt)
        assert.deepEqual(result.result.recording.target, context.target)
        const artifact = await context.cli('app.record.read', { operationId }, join(context.root, `partial-${shape}.webm`))
        assert.equal(artifact.ok, true, JSON.stringify(artifact)); assert.notEqual(artifact.cliExitCode, 0, 'Partial CLI retains a nonzero outcome while exporting actual bytes')
        assert.ok((await readFile(join(context.root, `partial-${shape}.webm`))).length > 0)
        context.report.checks.push(`same-record-survives-native-${shape}-gap`)
      } finally { contents.capturePage = originalCapture }
    }
  } finally {
    await context.window.webContents.executeJavaScript('globalThis.releasePendingRecording?.();globalThis.releaseDeadlineRecording?.()').catch(() => {})
    for (const owner of owners) await owner.dispose()
    context.captures.call = originalPort
  }
})
