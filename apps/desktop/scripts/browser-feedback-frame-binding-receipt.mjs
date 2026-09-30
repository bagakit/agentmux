import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { inspectFeedbackFrame } from './fixtures/browser-operation-feedback/frame-pixels.mjs'

// A callback has no Chromium presentation timestamp. Read original pixels, treating
// readonly HUD geometry as a candidate, and keep the claim narrower than same-frame identity.
export function decodeOriginalFrame(bytes) {
  const run = spawnSync('python3', ['-c', 'from PIL import Image;import sys,io,struct;im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGBA");sys.stdout.buffer.write(struct.pack("<II",*im.size)+im.tobytes())'],
    { input: bytes, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(run.status, 0, run.stderr?.toString())
  assert.ok(run.stdout.length > 8, 'Original PNG decoded nonempty pixels')
  return { width: run.stdout.readUInt32LE(0), height: run.stdout.readUInt32LE(4), bytes: run.stdout.subarray(8), order: 'rgba' }
}

export function assertPaintedTweenProgress(witness, frames) {
  assert.ok(frames.length >= 2, 'Two original painted intermediate frames exist')
  const dx = witness.to.x - witness.from.x, dy = witness.to.y - witness.from.y
  const distance = Math.hypot(dx, dy)
  assert.ok(distance > 4, 'Actual animation endpoints differ')
  const progress = frames.map(frame => {
    const b = frame.recomputed.arrowPixels.cssBounds
    // The colored path is inset inside the original SVG; use a narrow glyph-sized
    // corridor and substantial forward travel, rather than treating float as tween.
    const x = b.x - witness.from.x, y = b.y - witness.from.y
    const along = (x * dx + y * dy) / distance
    const perpendicular = Math.abs(x * dy - y * dx) / distance
    assert.ok(perpendicular <= Math.max(b.width, b.height), 'Painted arrow lies along the actual from-to route')
    assert.ok(along > distance * 0.05 && along < distance * 0.98, 'Painted arrow is actually between endpoints')
    return { callbackAt: frame.captureCallbackAt, along, fraction: along / distance, perpendicular }
  }).sort((a, b) => a.callbackAt - b.callbackAt)
  const travel = progress.at(-1).along - progress[0].along
  assert.ok(travel > Math.max(6, distance * 0.1), 'Forward painted travel exceeds hover float and cached start')
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].along > progress[i - 1].along, 'Actual intermediate arrows progress toward the current target')
  return { from: witness.from, to: witness.to, distance, travel, progress }
}

const owner = sample => ({ operationId: sample.hud.operationId, navigationId: sample.hud.navigationId, token: sample.hud.token })
const key = color => {
  const match = /^rgba?\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)(?:,\s*([-\d.]+))?\)$/.exec(color)
  assert.ok(match, 'Actual computed color has supported numeric channels')
  return [+match[1], +match[2], +match[3], match[4] === undefined ? 1 : +match[4]].join(',')
}
function assertActualSample(raw, row, sample) {
  const target = row.targets.find(target => target.token === sample.hud.token)
  assert.ok(target && target.frameId && Number.isSafeInteger(target.contextId), 'Original resolved target and context are nonempty')
  assert.deepEqual(sample.originalTarget, target)
  assert.equal(sample.sampleKind, 'target')
  assert.equal(sample.currentContext.frameId, target.frameId)
  assert.equal(sample.currentContext.sessionId, target.sessionId)
  if (sample.currentContext.owner === 'actual-original-product-sender') assert.equal(sample.currentContext.contextId, target.contextId)
  assert.ok(Number.isSafeInteger(sample.currentContext.contextId) && sample.currentContext.contextId > 0)
  assert.equal(target.operationId, row.actualReport.runOperation.id)
  assert.equal(sample.hud.operationId, target.operationId)
  assert.equal(sample.hud.navigationId, target.issuedNavigationId)
  assert.equal(sample.hud.hostPointerEvents, 'none')
  assert.ok(sample.startedAt <= sample.hud.now && sample.hud.now <= sample.returnedAt)
  assert.equal(sample.hud.hostConnected, true)
  const observed = raw.framePaintObservation
  const expectedSpace = observed.displayColorSpace.includes('primaries:P3') ? 'display-p3'
    : /primaries:(BT709|SRGB)/.test(observed.displayColorSpace) ? 'srgb' : null
  assert.ok(expectedSpace, 'The actual observed display profile is supported, never guessed')
  assert.equal(observed.outputSpace, expectedSpace)
  assert.equal(observed.prepared.outputSpace, expectedSpace)
  assert.ok(Object.keys(observed.prepared.cache).length > 0)
  for (const [item, field, converted] of [[sample.hud.label, 'color', 'outputColor'], [sample.hud.label, 'backgroundColor', 'outputBackground'], [sample.hud.arrow, 'fill', 'outputFill']]) {
    assert.equal(item.paint.outputSpace, expectedSpace)
    const actual = observed.prepared.cache[key(item.paint[field])]
    assert.ok(actual, 'Actual computed paint consumes the setup conversion cache')
    assert.deepEqual(item.paint[converted], actual)
  }
}

export async function consumeFrameBindingIncrement(receipt, original) {
  assert.equal(receipt.schema, 'agentmux.browser-operation-feedback-native.v2')
  assert.equal(receipt.nativeScope, 'motion')
  assert.equal(receipt.nativeIncrement, 'frame-binding')
  assert.equal(receipt.taskComplete, false)
  assert.equal(receipt.desktopTabRegionFocusRestore, 'not-tested')
  assert.equal(receipt.healthyCoreRunRestore, 'not-tested')
  assert.ok(receipt.source.inputs.length > 0, 'The actual loaded candidate is nonempty')
  assert.deepEqual(receipt.source.drift, [])
  assert.equal(new Set(receipt.source.inputs.map(item => item.path)).size, receipt.source.inputs.length)
  for (const item of receipt.source.inputs) await original({ ...item, path: item.snapshot })
  await original({ path: receipt.source.bundlePath, sha256: receipt.source.bundleSha256, bytes: receipt.source.bundleBytes })
  const feedbackSource = receipt.source.inputs.find(item => item.relativePath === 'apps/desktop/src/main/browser-operation-feedback.ts')
  assert.ok(feedbackSource)
  for (const name of ['browser-view-manager.ts', 'browser-page-dispatch.ts']) assert.ok(receipt.source.inputs.some(item => item.path.endsWith('/' + name)))
  assert.equal(receipt.engine.packageVersion, receipt.engine.expectedElectron)
  assert.equal(receipt.fixture.strictCsp, true)
  assert.equal(receipt.fixture.trustedTypesRequired, true)
  assert.equal(receipt.cleanup.privateRootRemoved, true)
  assert.ok(receipt.cleanup.privateBytes <= 30 * 1024 * 1024)
  assert.deepEqual(receipt.phases.map(item => item.phase), ['first', 'second'])
  const images = [], phases = [], movements = []
  for (const phase of receipt.phases) {
    assert.equal(phase.process.exitCode, 0)
    assert.equal(phase.process.timedOut, false)
    const raw = JSON.parse(await original(phase.actualOriginal))
    phases.push(raw)
    assert.equal(raw.phase, phase.phase)
    assert.equal(raw.phaseCompleted, true)
    assert.ok(Number.isSafeInteger(raw.pid) && raw.pid > 0)
    assert.equal(raw.versions.electron, receipt.engine.expectedElectron)
    assert.equal(raw.motion.schema, 'agentmux.browser-feedback-motion.v2')
    assert.equal(raw.motion.scope, 'T-024-private-native-frame-binding-increment')
    assert.equal(raw.motion.heldActions, false)
    assert.equal(raw.motion.actionScriptSleeps, 0)
    assert.deepEqual(raw.motion.foregroundCalls, [])
    assert.deepEqual(raw.motion.systemMouseCalls, [])
    assert.equal(raw.motion.caseIndices.length, 1)
    const indexed = raw.motion.caseIndices[0], row = raw.cases[indexed.index]
    assert.ok(row && indexed.label === row.label)
    assert.equal(row.label, phase.phase === 'first' ? 'motion-same-operation' : 'motion-reduced-static')
    assert.equal(row.heldAction, false)
    assert.equal(row.actionScriptSleep, false)
    assert.equal(row.actualReport.outcome.kind, 'completed')
    assert.equal(row.actualReport.runOperation.browserId, raw.original.browserId)
    assert.equal(row.actualReport.runOperation.phase, 'completed')
    assert.equal(row.actualOperationCompletedAt, row.actualReport.runOperation.finishedAt)
    assert.ok(row.targets.length === 2 && row.samples.length > 0 && row.frames.length > 0)
    assert.equal(new Set(row.samples.map(sample => sample.sequence)).size, row.samples.length)
    assert.equal(new Set(row.frames.map(frame => frame.path)).size, row.frames.length)
    assert.equal(row.nativeFocusAfter, row.nativeFocusBefore)
    assert.ok(Object.hasOwn(row, 'nativeFocusBefore') && Object.hasOwn(row, 'nativeFocusAfter'))
    assert.equal(raw.framePaintObservation.sourceSha256, feedbackSource.sha256)
    assert.ok(raw.framePaintObservation.preparationStartedAt <= raw.framePaintObservation.preparationFinishedAt &&
      raw.framePaintObservation.preparationFinishedAt < row.actualReport.runOperation.startedAt)
    const frames = []
    for (const frame of row.frames) {
      assert.deepEqual(frame, raw.motion.nativeFrames.find(item => item.path === frame.path))
      assert.equal(frame.source, 'original-webcontents-beginFrameSubscription-full-compositor-frame')
      assert.equal(frame.webContentsId, raw.original.contentsId)
      assert.equal(frame.compositorPresentationAt, null, 'No invented presentation time')
      assert.equal(Object.hasOwn(frame, 'presentationAt'), false)
      const sample = row.samples.find(item => item.sequence === frame.sampleAtOrBefore.sampleSequence)
      assert.ok(sample)
      assertActualSample(raw, row, sample)
      assert.deepEqual(frame.candidateOwner, owner(sample))
      assert.equal(frame.sampleAtOrBefore.returnedAt, sample.returnedAt)
      assert.equal(frame.sampleAtOrBefore.lagMs, frame.captureCallbackAt - sample.returnedAt)
      assert.ok(frame.captureCallbackAt >= sample.returnedAt && frame.captureCallbackAt - sample.hud.now <= 40)
      const window = row.cameraWindows.find(item => item.firstMatchingSample.sampleSequence === sample.sequence ||
        (frame.captureCallbackAt >= item.evidenceStartedAt && frame.captureCallbackAt <= item.deadline))
      assert.ok(window && window.budgetMs === 260 && window.deadline === Math.min(window.matchingAt + 260, window.observedCueExpiresAt))
      const bitmap = decodeOriginalFrame(await original(frame, true))
      assert.deepEqual({ width: bitmap.width, height: bitmap.height }, frame.size)
      const recomputed = inspectFeedbackFrame(bitmap, sample)
      assert.equal(recomputed.compatible, true, 'Original PNG independently contains the candidate cue and phase: ' + recomputed.reason)
      assert.deepEqual(recomputed, frame.pixelEvidence, 'Producer flags never substitute for original pixel recomputation')
      frames.push({ ...frame, recomputed })
      images.push({ ...frame, phase: raw.phase, label: row.label })
    }
    if (phase.phase === 'first') {
      assert.equal(row.motionWitnesses.length, 1)
      const witness = row.motionWitnesses[0]
      assert.deepEqual(witness.target, row.targets[witness.targetIndex])
      const steps = row.actualReport.runOperation.steps.filter(step => step.method === witness.target.method)
      assert.deepEqual(witness.actualStep, steps[witness.targetIndex])
      const moving = row.samples.filter(sample => witness.intermediateSampleSequences.includes(sample.sequence))
      assert.ok(moving.length >= 2)
      for (const sample of moving) {
        assertActualSample(raw, row, sample)
        const animation = sample.hud.pointer.animations.find(item => item.currentTime > 0 && item.currentTime < item.duration)
        assert.ok(animation && animation.duration === 180)
        const point = value => { const m = /^translate\(([-\d.]+)px,\s*([-\d.]+)px\)$/.exec(value); assert.ok(m); return { x: +m[1], y: +m[2] } }
        assert.deepEqual(point(animation.keyframes[0].transform), witness.from)
        assert.deepEqual(point(animation.keyframes.at(-1).transform), witness.to)
      }
      assert.ok(moving.some(sample => witness.actualStep.finishedAt < sample.startedAt), 'Original action completed while the actual pointer animation still moved')
      movements.push(assertPaintedTweenProgress(witness, frames.filter(frame => witness.nativeFrameSequences.includes(frame.sequence))))
    } else {
      for (const frame of frames) {
        const sample = row.samples.find(item => item.sequence === frame.sampleAtOrBefore.sampleSequence)
        assert.equal(sample.hud.reducedMotion, true)
        assert.equal(sample.hud.pointer.animations.length, 0)
        assert.equal(sample.hud.arrow.animations.length, 0)
      }
    }
  }
  assert.notEqual(phases[0].pid, phases[1].pid)
  assert.equal(phases[0].retained.browserId, phases[1].restored.browserId)
  assert.equal(phases[0].retained.profileId, phases[1].restored.profileId)
  assert.equal(phases[1].restored.oldHudPresent, false)
  assert.ok(images.length >= 4)
  return { partialNativePassed: true, taskComplete: false, images, movements,
    pending: ['remaining T024 motion/opaque/frame/input Native matrix', 'actual OS window', 'independent aesthetic review',
      'installed Desktop Tab/Region/focus recovery', 'healthy Core Run recovery', 'nonempty prior page-input recovery'] }
}
