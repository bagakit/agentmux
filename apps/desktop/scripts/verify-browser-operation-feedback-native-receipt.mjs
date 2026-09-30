import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumeFrameBindingIncrement } from './browser-feedback-frame-binding-receipt.mjs'

// This consumes originals. A private Browser/profile restart cannot certify Desktop/Core recovery.
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export async function createOriginalReader(evidenceRoot) {
  const root = resolve(evidenceRoot)
  let originalRoot = root
  try {
    const archive = await json(resolve(root, 'archive.json'))
    assert.equal(archive.schema, 'agentmux.browser-feedback-evidence-archive.v1')
    originalRoot = resolve(archive.originalRoot)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  function archived(path) {
    const suffix = relative(originalRoot, resolve(path))
    assert.ok(suffix && suffix !== '..' && !suffix.startsWith('..' + sep) && !suffix.startsWith(sep), 'Original belongs to this receipt evidence root')
    return resolve(root, suffix)
  }
  async function original(row, image = false) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/)
    const bytes = await readFile(archived(row.path ?? row.snapshot))
    assert.equal(sha(bytes), row.sha256, 'Preserved original bytes match the receipt')
    if (row.bytes !== undefined) assert.equal(bytes.length, row.bytes)
    if (image) assert.deepEqual(bytes.subarray(0, 8), pngMagic, 'Actual PNG original exists')
    return bytes
  }
  original.originalRoot = originalRoot
  return original
}

function motionPoint(transform) {
  const match = /^translate\(([-\d.]+)px,\s*([-\d.]+)px\)$/.exec(transform)
  assert.ok(match, 'Actual local motion has real two-dimensional keyframes')
  const point = { x: Number(match[1]), y: Number(match[2]) }
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  return point
}
const motionDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

const ownerOf = sample => ({ operationId: sample.hud.operationId, navigationId: sample.hud.navigationId, token: sample.hud.token })
const framesFor = (row, samples) => row.frames.filter(frame => samples.some(sample =>
  frame.sampleAtOrBefore.sampleKind === sample.sampleKind && frame.sampleAtOrBefore.sampleSequence === sample.sequence &&
  frame.sampleAtOrBefore.returnedAt === sample.returnedAt && frame.sampleAtOrBefore.lagMs === frame.presentationAt - sample.returnedAt &&
  frame.presentationAt >= sample.returnedAt && frame.presentationAt - sample.returnedAt <= 40 &&
  JSON.stringify(frame.owner) === JSON.stringify(ownerOf(sample))))

export function assertIndexedMotionCases(raw) {
  const motion = raw.motion
  assert.equal(motion?.schema, 'agentmux.browser-feedback-motion.v2', 'Actual T024 motion originals are required')
  assert.equal(motion.scope, 'T-024-private-native-increment')
  assert.equal(motion.heldActions, false)
  assert.equal(motion.actionScriptSleeps, 0)
  assert.deepEqual(motion.foregroundCalls, [])
  assert.deepEqual(motion.systemMouseCalls, [])
  assert.ok(motion.caseIndices.length > 0 && motion.nativeFrames.length > 0, 'Motion cases and original compositor sequence are nonempty')
  assert.equal(new Set(motion.caseIndices.map(row => row.index)).size, motion.caseIndices.length)
  const cases = motion.caseIndices.map(row => {
    assert.ok(Number.isSafeInteger(row.index) && row.index >= 0 && row.index < raw.cases.length)
    assert.equal(raw.cases[row.index].label, row.label, 'A case index refers to the actual process original')
    return raw.cases[row.index]
  })
  assert.equal(new Set(motion.nativeFrames.map(frame => frame.path)).size, motion.nativeFrames.length)
  return cases
}

export function assertMotionCaseBindings(raw, row) {
  assert.equal(row.passed, true, row.failure?.message)
  assert.equal(row.heldAction, false)
  assert.equal(row.actionScriptSleep, false)
  assert.equal(row.actualReport.outcome.kind, 'completed')
  assert.equal(row.actualReport.runOperation.browserId, raw.original.browserId)
  assert.equal(row.actualReport.runOperation.phase, 'completed')
  assert.deepEqual(row.actualActionSteps, row.actualReport.runOperation.steps.filter(step => ['hover', 'pressKey', 'js', 'cdp'].includes(step.method)),
    'Derived action steps consume the actual original Main report')
  assert.equal(row.actualOperationCompletedAt, row.actualReport.runOperation.finishedAt ?? null)
  for (const field of ['nativeFocusBefore', 'nativeFocusAfter']) {
    assert.ok(Object.hasOwn(row, field) && (row[field] === null || (Number.isSafeInteger(row[field]) && row[field] > 0)),
      'Actual focused WebContents was observed, including a real null')
  }
  assert.equal(row.nativeFocusAfter, row.nativeFocusBefore, 'Actual focused WebContents did not change')
  assert.ok(row.actualActionSteps.length > 0 && row.frames.length > 0)
  assert.equal(new Set(row.samples.map(sample => sample.sequence)).size, row.samples.length)
  assert.equal(new Set(row.frames.map(frame => frame.path)).size, row.frames.length)
  for (const sample of row.samples) {
    assert.equal(sample.sampleKind, 'target')
    const target = row.targets.find(target => target.token === sample.hud.token)
    assert.ok(target)
    assert.deepEqual(sample.originalTarget, target)
    assert.equal(sample.currentContext.frameId, target.frameId)
    assert.equal(sample.currentContext.sessionId, target.sessionId)
    assert.ok(Number.isSafeInteger(sample.currentContext.contextId) && sample.currentContext.contextId > 0)
    if (sample.currentContext.owner === 'actual-original-product-sender') assert.equal(sample.currentContext.contextId, target.contextId)
    assert.equal(sample.hud.operationId, row.actualReport.runOperation.id)
    assert.equal(sample.hud.navigationId, target.issuedNavigationId)
    assert.ok(Number.isSafeInteger(sample.startedAt) && sample.returnedAt >= sample.startedAt &&
      sample.hud.now >= sample.startedAt && sample.hud.now <= sample.returnedAt)
  }
  for (const frame of row.frames) {
    const originalFrame = raw.motion.nativeFrames.find(item => item.path === frame.path)
    assert.deepEqual(frame, originalFrame, 'Case consumes all original presentation and sample metadata')
    assert.equal(frame.webContentsId, raw.original.contentsId)
    const samples = frame.sampleAtOrBefore.sampleKind === 'target' ? row.samples : row.topSamples
    assert.ok(framesFor(row, samples).includes(frame), 'The original PNG binds a real sample and its operation/navigation/token')
  }
}

export function assertMotionWitness(row, witness) {
  assert.ok(Number.isSafeInteger(witness.targetIndex) && witness.targetIndex >= 0 && witness.targetIndex < row.targets.length)
  assert.deepEqual(witness.target, row.targets[witness.targetIndex], 'Witness consumes the actual resolved target')
  assert.deepEqual(witness.actualStep, row.actualReport.runOperation.steps.filter(step => step.method === witness.target.method)[witness.targetIndex],
    'Unawaited motion is measured against the original Main action, not a second timestamp DTO')
  assert.ok(Number.isSafeInteger(witness.actualStep.finishedAt) && witness.actualStep.finishedAt >= witness.actualStep.startedAt)
  assert.equal(new Set(witness.intermediateSampleSequences).size, witness.intermediateSampleSequences.length)
  assert.equal(new Set(witness.nativeFrameSequences).size, witness.nativeFrameSequences.length)
  const samples = row.samples.filter(sample => witness.intermediateSampleSequences.includes(sample.sequence))
  assert.ok(samples.length >= 2)
  assert.ok(motionDistance(witness.from, witness.to) > 4)
  let actionFinishedWhileMoving = false
  for (const sample of samples) {
    assert.equal(sample.sampleKind, 'target')
    assert.deepEqual(sample.originalTarget, witness.target)
    assert.equal(sample.currentContext.frameId, witness.target.frameId)
    assert.equal(sample.currentContext.sessionId, witness.target.sessionId)
    assert.ok(Number.isSafeInteger(sample.currentContext.contextId) && sample.currentContext.contextId > 0)
    if (sample.currentContext.owner === 'actual-original-product-sender') assert.equal(sample.currentContext.contextId, witness.target.contextId)
    assert.ok(Number.isSafeInteger(sample.startedAt) && sample.returnedAt >= sample.startedAt &&
      sample.hud.now >= sample.startedAt && sample.hud.now <= sample.returnedAt)
    assert.equal(sample.hud.token, witness.target.token)
    assert.equal(sample.hud.operationId, row.actualReport.runOperation.id)
    assert.equal(sample.hud.navigationId, witness.target.issuedNavigationId)
    const animation = sample.hud.pointer.animations.find(item => item.currentTime > 0 && item.currentTime < item.duration)
    assert.ok(animation, 'The actual sampled pointer is between its local animation endpoints')
    assert.deepEqual(motionPoint(animation.keyframes[0].transform), witness.from)
    assert.deepEqual(motionPoint(animation.keyframes.at(-1).transform), witness.to)
    assert.ok(motionDistance(sample.hud.pointer.rect, witness.from) > 1 && motionDistance(sample.hud.pointer.rect, witness.to) > 1)
    if (witness.actualStep.finishedAt < sample.startedAt) actionFinishedWhileMoving = true
  }
  assert.equal(actionFinishedWhileMoving, true, 'The actual action did not wait for the page-local move')
  const frames = row.frames.filter(frame => witness.nativeFrameSequences.includes(frame.sequence))
  assert.ok(frames.length >= 2 && new Set(frames.map(frame => frame.sha256)).size >= 2)
  for (const frame of frames) {
    assert.deepEqual(frame.owner, { operationId: witness.target.operationId, navigationId: witness.target.issuedNavigationId, token: witness.target.token })
    assert.ok(samples.some(sample => sample.sequence === frame.sampleAtOrBefore?.sampleSequence &&
      frame.sampleAtOrBefore.sampleKind === sample.sampleKind && frame.sampleAtOrBefore.returnedAt === sample.returnedAt &&
      frame.sampleAtOrBefore.lagMs === frame.presentationAt - sample.returnedAt &&
      sample.returnedAt <= frame.presentationAt && frame.presentationAt - sample.returnedAt <= 40), 'Real frame follows its bound intermediate geometry within the documented observation window')
  }
}

export function assertRapidRetarget(rapid) {
  assert.equal(rapid.retarget.status, 'actual-current-position-proven')
  const prior = rapid.retarget.priorRead
  assert.equal(prior.exceptionDetails, undefined)
  assert.equal(prior.incomingToken, rapid.targets[2].token)
  assert.equal(prior.hud.token, rapid.targets[1].token)
  const presented = prior.hud.pointer?.rect ?? prior.hud.history?.point
  const rapidWitness = rapid.motionWitnesses.find(witness => witness.targetIndex === 2)
  assert.ok(rapidWitness)
  assert.deepEqual(rapid.retarget.next, { from: rapidWitness.from, to: rapidWitness.to }, 'Retarget binds the actual next animation keyframes')
  assert.ok(presented && motionDistance(rapid.retarget.next.from, presented) < 1.5)
  const priorAnimation = rapid.samples.find(sample => sample.sequence === rapid.retarget.previousAnimationSample)
  assert.equal(priorAnimation?.hud?.token, rapid.targets[1].token)
  assert.ok(priorAnimation.hud.pointer.animations.some(animation => animation.currentTime >= 0 && animation.currentTime < animation.duration),
    'The rapid preceding movement was actually observed, including a real zero-progress frame')
}

export function assertLocalBrowserRecovery(first, second) {
  assert.equal(first.versions.chrome, second.versions.chrome)
  assert.notEqual(first.pid, second.pid)
  for (const state of [first.retained, second.restored]) {
    for (const field of ['browserId', 'profileId', 'url']) assert.ok(typeof state[field] === 'string' && state[field].length > 0)
    assert.ok(typeof state.profileClicks === 'string' && /^[1-9]\d*$/.test(state.profileClicks), 'Recovery consumes actual nonempty prior page input')
  }
  assert.equal(second.restored.localBrowserInputRestored, true)
  assert.equal(first.retained.browserId, second.restored.browserId)
  assert.equal(first.retained.profileId, second.restored.profileId)
  assert.equal(first.retained.url, second.restored.url)
  assert.equal(first.retained.profileClicks, second.restored.profileClicks)
  assert.equal(second.restored.oldHudPresent, false)
}

export function assertRunningJsExecutor(raw, row) {
  const job = row.actualReport.result
  assert.equal(job.phase, 'completed')
  assert.ok(job.inputBytes > 0 && job.digests > 0 && job.outputBytes > 0)
  assert.ok(Number.isSafeInteger(job.startedAt) && Number.isSafeInteger(job.finishedAt) && job.finishedAt > job.startedAt)
  const running = row.topSamples.filter(sample => sample.hud?.executor && sample.hud.operationId === row.actualReport.runOperation.id &&
    sample.hud.phase === 'running' && (raw.phase === 'second' ? sample.hud.executor.animationName === 'none' : sample.hud.executor.animationName !== 'none') &&
    sample.hud.now >= job.startedAt && sample.hud.now < job.finishedAt)
  assert.ok(running.length > 0, 'An actual unfinished page job has an observed executor')
  assert.ok(framesFor(row, running).some(frame => frame.presentationAt >= job.startedAt && frame.presentationAt < job.finishedAt),
    'An actual running executor PNG was presented before the original job finished')
}

export function assertOpaqueExecutor(raw, row, method) {
  const samples = row.topSamples.filter(sample => sample.hud?.executor && sample.hud.operationId === row.actualReport.runOperation.id)
  assert.ok(samples.length > 0)
  const completed = samples.filter(sample => sample.hud.phase === 'completed')
  assert.ok(completed.length > 0)
  for (const sample of samples) {
    assert.equal(sample.sampleKind, 'top')
    assert.equal(sample.source, 'actual-original-webcontents-isolated-world-read')
    assert.equal(sample.webContentsId, raw.original.contentsId)
    assert.equal(sample.worldId, 1209)
    assert.ok(row.opaquePayloads.some(actual => actual.webContentsId === sample.webContentsId && actual.worldId === sample.worldId &&
      actual.issuedAt <= sample.hud.now && actual.payload.phase === sample.hud.phase &&
      actual.payload.method === method && actual.payload.operationId === sample.hud.operationId &&
      actual.payload.navigationId === sample.hud.navigationId && actual.payload.token === sample.hud.token),
      'The executor owner comes from the actual original product payload')
    assert.ok(Number.isSafeInteger(sample.startedAt) && sample.returnedAt >= sample.startedAt &&
      sample.hud.now >= sample.startedAt && sample.hud.now <= sample.returnedAt)
    assert.equal(sample.hud.operationId, row.actualReport.runOperation.id)
    assert.equal(sample.hud.point, null)
    assert.equal(sample.hud.pointer, null)
    assert.equal(sample.hud.hostPointerEvents, 'none')
  }
  for (const sample of completed) {
    assert.equal(sample.hud.executor.animationName, 'none')
    assert.equal(sample.hud.glow, null)
  }
  assert.ok(framesFor(row, completed).length > 0, 'Actual completed executor has a bound original PNG')
  if (method === 'js') assertRunningJsExecutor(raw, row)
}

// T024 adds observable motion; a previously passing static T023 receipt cannot certify it.
async function validateMotionProcess(raw, images, original) {
  const cases = assertIndexedMotionCases(raw)
  const motion = raw.motion
  for (const frame of motion.nativeFrames) {
    assert.equal(frame.source, 'original-webcontents-beginFrameSubscription-full-compositor-frame')
    assert.ok(Number.isSafeInteger(frame.presentationAt) && frame.size.width > 0 && frame.size.height > 0)
    assert.equal(frame.webContentsId, raw.original.contentsId, 'The frame belongs to this actual Browser WebContents')
    await original(frame, true)
    images.push({ ...frame, phase: raw.phase })
  }
  const required = raw.phase === 'first'
    ? ['motion-same-operation', 'motion-rapid-retarget', 'motion-cross-operation-expired', 'motion-hover-float', 'motion-named-key', 'motion-generic-key', 'motion-same-process-single-hover', 'motion-js-executor', 'motion-cdp-executor']
    : ['motion-reduced-static', 'motion-js-executor', 'motion-cdp-executor']
  for (const label of required) {
    const row = cases.find(item => item.label === label)
    assert.ok(row, 'An actual changed Native boundary was exercised: ' + label)
    assertMotionCaseBindings(raw, row)
  }
  for (const method of ['js', 'cdp']) {
    const row = cases.find(item => item.label === `motion-${method}-executor`)
    assertOpaqueExecutor(raw, row, method)
  }
  if (raw.phase === 'second') {
    const reduced = cases.find(item => item.label === 'motion-reduced-static')
    const samples = reduced.samples.filter(sample => sample.hud?.pointer)
    assert.ok(samples.length > 0)
    for (const sample of samples) {
      assert.equal(sample.hud.reducedMotion, true)
      assert.equal(sample.hud.arrow.animationName, 'none')
      assert.equal(sample.hud.pointer.animations.length, 0)
    }
    assert.ok(framesFor(reduced, samples).length > 0, 'Actual reduced-motion pointer has a bound original PNG')
    return
  }
  for (const label of ['motion-same-operation', 'motion-rapid-retarget', 'motion-cross-operation-expired']) {
    const row = cases.find(item => item.label === label)
    assert.ok(row.motionWitnesses?.length > 0, 'Real action/geometry/compositor witness is nonempty')
    for (const witness of row.motionWitnesses) {
      assertMotionWitness(row, witness)
    }
  }
  const cross = cases.find(item => item.label === 'motion-cross-operation-expired')
  assert.ok(Number.isSafeInteger(cross.previousOperation.caseIndex) && cross.previousOperation.caseIndex >= 0 && cross.previousOperation.caseIndex < raw.cases.length)
  const priorCase = raw.cases[cross.previousOperation.caseIndex]
  assert.equal(priorCase.label, cross.previousOperation.caseLabel)
  assert.equal(priorCase.label, 'motion-cross-operation-prior')
  assert.ok(Number.isSafeInteger(cross.previousOperation.targetIndex) && cross.previousOperation.targetIndex >= 0 && cross.previousOperation.targetIndex < priorCase.targets.length)
  const priorTarget = priorCase.targets[cross.previousOperation.targetIndex]
  assert.equal(cross.previousOperation.elapsedMs, cross.startedAt - priorTarget.originalSendCompletedAt)
  assert.ok(cross.previousOperation.elapsedMs > 900)
  const previous = cross.previousOperation.observedBeforeNext.hud
  assert.equal(previous.hostConnected, false)
  assert.equal(previous.pointer, null)
  assert.ok(previous.history?.point)
  assert.notEqual(priorCase.actualReport.runOperation.id, cross.actualReport.runOperation.id)
  assert.equal(cross.targets[0].frameId, priorTarget.frameId)
  assert.equal(cross.targets[0].issuedNavigationId, priorTarget.issuedNavigationId)
  assert.ok(cross.motionWitnesses.some(witness => motionDistance(witness.from, previous.history.point) < 1))
  const rapid = cases.find(item => item.label === 'motion-rapid-retarget')
  assertRapidRetarget(rapid)
  const hover = cases.find(item => item.label === 'motion-hover-float')
  const floated = hover.samples.filter(sample => hover.floatSamples.includes(sample.sequence))
  assert.ok(floated.length >= 2)
  const base = floated[0].hud, ys = []
  for (const sample of floated) {
    assert.equal(sample.hud.phase, 'completed')
    assert.equal(sample.hud.token, hover.targets[0].token)
    assert.equal(sample.hud.operationId, hover.actualReport.runOperation.id)
    assert.equal(sample.hud.pointer.animations.length, 0)
    assert.ok(motionDistance(sample.hud.point, base.point) <= 0.01)
    assert.ok(motionDistance(sample.hud.label.rect, base.label.rect) <= 0.1)
    assert.equal(sample.hud.label.text, base.label.text)
    ys.push(sample.hud.arrow.rect.y)
  }
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.3 && Math.max(...ys) - Math.min(...ys) <= 3.1,
    'Actual arrow floats slightly while the target anchor and label stay still')
  const floatFrames = framesFor(hover, floated)
  assert.ok(floatFrames.length >= 2 && new Set(floatFrames.map(frame => frame.sha256)).size >= 2,
    'At least two original PNGs show the actual settled arrow float')
  const presentedFloatY = floatFrames.map(frame => floated.find(sample => sample.sequence === frame.sampleAtOrBefore.sampleSequence).hud.arrow.rect.y)
  assert.ok(Math.max(...presentedFloatY) - Math.min(...presentedFloatY) > 0.3)
  for (const label of ['motion-named-key', 'motion-generic-key']) {
    const row = cases.find(item => item.label === label)
    assert.ok(row.targets.length > 0 && row.samples.length > 0)
    assert.equal(row.targets[0].keyLabel, label === 'motion-named-key' ? 'Enter' : '⌨')
    const keySamples = row.samples.filter(sample => sample.hud?.label?.text.includes(label === 'motion-named-key' ? 'Key Enter' : 'Key ⌨') &&
      sample.hud.token === row.targets[0].token)
    assert.ok(keySamples.length > 0 && framesFor(row, keySamples).length > 0, 'Actual named/symbol key feedback has a bound original PNG')
    assert.ok(row.originalEvents.length > 0)
    const keys = row.originalEvents.filter(event => event.type === 'keydown' && event.key === (label === 'motion-named-key' ? 'Enter' : 'Meta+Enter'))
    assert.equal(keys.length, 1, 'One actual key event reached the original page')
    if (label === 'motion-generic-key') {
      assert.deepEqual(keys[0].modifiers, { ctrl: false, alt: false, meta: false, shift: false })
      assert.equal(row.samples.some(sample => sample.hud?.label?.text.includes('Meta+Enter')), false)
    }
  }

}

async function independentReview(receiptBytes, receipt, images, root, reviewPath) {
  const review = await json(resolve(reviewPath ?? resolve(root, 'independent-visual-review.json')))
  assert.equal(review.schema, 'agentmux.browser-feedback-independent-visual-review.v1')
  assert.equal(review.scope, receipt.nativeScope === 'motion' ? 'private-native-browser-motion-increment' : 'private-native-browser-feedback')
  assert.equal(review.receiptSha256, sha(receiptBytes), 'Independent look binds the exact actual receipt')
  assert.equal(review.independent, true)
  assert.equal(review.passed, true)
  assert.match(review.reviewer, /^\/root\/[a-z0-9_]+$/)
  assert.notEqual(review.reviewer, receipt.author, 'The Native author does not sign their own aesthetic review')
  assert.ok(review.images.length > 0)
  for (const image of images) {
    const viewed = review.images.find(row => row.sha256 === image.sha256 && row.path === image.path &&
      row.phase === image.phase && row.label === image.label)
    assert.ok(viewed?.viewed === true && viewed.assessment, 'Each preserved original was actually inspected')
  }
}

async function frameBindingReview(receiptBytes, receipt, images, reviewPath) {
  const review = await json(resolve(reviewPath))
  assert.equal(review.schema, 'agentmux.browser-feedback-independent-visual-review.v1')
  assert.equal(review.scope, 'private-native-browser-frame-binding-increment')
  assert.equal(review.receiptSha256, sha(receiptBytes))
  assert.equal(review.independent, true)
  assert.equal(review.passed, true)
  assert.equal(review.nativeComplete, false)
  assert.equal(review.taskComplete, false)
  assert.match(review.reviewer, /^\/root\/[a-z0-9_]+$/)
  assert.notEqual(review.reviewer, receipt.author)
  assert.notEqual(review.reviewer, receipt.actualExecutor)
  assert.equal(review.images.length, images.length)
  for (const image of images) {
    const viewed = review.images.find(item => item.path === image.path && item.sha256 === image.sha256 && item.phase === image.phase && item.label === image.label)
    assert.ok(viewed?.viewed === true && viewed.passed === true && viewed.assessment?.length > 0)
    assert.equal(viewed.bytes, image.bytes)
    assert.equal(viewed.presentationTimestampEstablished, false)
    assert.equal(viewed.composedOsWindowCertified, false)
  }
}

async function main(args = process.argv.slice(2)) {
  const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
  const receiptPath = resolve(option('--receipt') ?? 'docs/reviews/evidence/browser-operation-feedback-native/receipt.json')
  const root = dirname(receiptPath)
  const original = await createOriginalReader(root)
  const originalRoot = original.originalRoot
try {
  const receiptBytes = await readFile(receiptPath)
  const receipt = JSON.parse(receiptBytes)
  if (option('--scope') === 'frame-binding-increment') {
    const consumed = await consumeFrameBindingIncrement(receipt, original)
    const reviewPath = option('--review')
    if (reviewPath) await frameBindingReview(receiptBytes, receipt, consumed.images, reviewPath)
    console.log(JSON.stringify({ receipt: receiptPath, scope: 'frame-binding-increment',
      partialNativePassed: consumed.partialNativePassed, taskComplete: false,
      independentAestheticReview: reviewPath ? 'passed' : 'pending',
      movements: consumed.movements, pending: consumed.pending.filter(item => !reviewPath || item !== 'independent aesthetic review'),
      note: 'Original pixels prove cue/phase compatibility and directed intermediate travel. Candidate reads do not certify a compositor timestamp or unique same-frame owner.' }, null, 2))
    process.exitCode = 2
    return
  }
  const motionIncrement = option('--scope') === 'motion-increment'
  assert.equal(receipt.schema, motionIncrement ? 'agentmux.browser-operation-feedback-native.v2' : 'agentmux.browser-operation-feedback-native.v1')
  assert.match(receipt.author, /^\/root\/[a-z0-9_]+$/)
  if (motionIncrement) assert.equal(receipt.nativeScope, 'motion', 'An increment cannot substitute a full Native receipt')
  else assert.equal(receipt.passed, true, receipt.failure?.message)
  assert.ok(receipt.source.inputs.length > 0, 'Real loaded Source set is nonempty')
  assert.deepEqual(receipt.source.drift, [], 'Native sampled one stable Source candidate')
  assert.equal(new Set(receipt.source.inputs.map(row => row.path)).size, receipt.source.inputs.length)
  for (const row of receipt.source.inputs) await original({ ...row, path: row.snapshot })
  await original({ path: receipt.source.bundlePath, sha256: receipt.source.bundleSha256, bytes: receipt.source.bundleBytes })
  for (const suffix of ['/browser-view-manager.ts', '/browser-page-dispatch.ts', '/browser-operation-feedback.ts']) {
    assert.ok(receipt.source.inputs.some(row => row.path.endsWith(suffix)), 'The actual production consumer was loaded: ' + suffix)
  }
  assert.equal(receipt.fixture.strictCsp, true)
  assert.equal(receipt.fixture.trustedTypesRequired, true)
  assert.equal(receipt.engine.packageVersion, receipt.engine.expectedElectron)
  assert.equal(receipt.phases.length, 2)
  assert.deepEqual(receipt.phases.map(phase => phase.phase), ['first', 'second'])
  const images = []
  const actualPhases = []
  for (const phase of receipt.phases) {
    assert.equal(phase.process.exitCode, 0)
    assert.equal(phase.process.timedOut, false)
    const rawBytes = await readFile(resolve(root, `${phase.phase}-receipt.json`))
    const raw = JSON.parse(rawBytes)
    if (motionIncrement) {
      assert.equal(phase.actualOriginal.path, resolve(originalRoot, `${phase.phase}-receipt.json`))
      assert.equal(phase.actualOriginal.sha256, sha(rawBytes))
      assert.equal(phase.actualOriginal.bytes, rawBytes.length)
    } else assert.deepEqual(raw, phase.actual, 'Top-level receipt consumes the actual process original')
    actualPhases.push(raw)
    assert.equal(raw.phase, phase.phase)
    assert.equal(raw.phaseCompleted, true)
    if (!motionIncrement) assert.equal(raw.passed, true)
    assert.ok(Number.isInteger(raw.pid) && raw.pid > 0)
    assert.ok(raw.versions.electron && raw.versions.chrome)
    assert.equal(raw.versions.electron, receipt.engine.expectedElectron)
    if (!motionIncrement) assert.ok(raw.visual.nativePages.length > 0 && raw.visual.osWindows.length > 0)
    for (const image of raw.visual.nativePages) {
      assert.equal(image.source, 'original-webcontents-native-page')
      assert.ok(image.size.width > 0 && image.size.height > 0)
      await original(image, true); images.push({ ...image, phase: raw.phase })
    }
    for (const image of raw.visual.osWindows) {
      assert.equal(image.source, 'actual-exact-pid-os-window')
      assert.equal(image.pid, raw.pid)
      await original(image, true); images.push({ ...image, phase: raw.phase })
      const metadata = JSON.parse(await original({ path: image.metadata, sha256: image.metadataSha256, bytes: image.metadataBytes }))
      assert.equal(metadata.captured.result.snapshot.app.pid, raw.pid)
      assert.equal(metadata.captured.result.snapshot.window.id, image.windowId)
      assert.equal(metadata.captured.result.screenshotStatus.state, 'captured')
    }
  }
  const [first, second] = actualPhases
  await validateMotionProcess(first, images, original)
  await validateMotionProcess(second, images, original)
  assertLocalBrowserRecovery(first, second)
  assert.equal(receipt.localBrowserProfileRecovery.passed, true)
  assert.equal(receipt.localBrowserProfileRecovery.firstPid, first.pid)
  assert.equal(receipt.localBrowserProfileRecovery.secondPid, second.pid)
  assert.deepEqual(receipt.localBrowserProfileRecovery.first, first.retained)
  assert.deepEqual(receipt.localBrowserProfileRecovery.second, second.restored)
  if (motionIncrement) {
    const short = first.cases.find(row => row.label === 'motion-short-single-click')
    assert.ok(short, 'The original short-page counterexample was exercised')
    assert.equal(short.passed, true)
    assert.equal(short.singleAction, true)
    assert.equal(short.heldAction, false)
    assert.equal(short.repeatedAction, false)
    assert.equal(short.actualReport.outcome.kind, 'completed')
    const clickSteps = short.actualReport.runOperation.steps.filter(step => step.method === 'click')
    assert.equal(clickSteps.length, 1)
    assert.equal(short.target.node.backendNodeId, short.actualReport.result.node.backendNodeId)
    assert.equal(short.target.node.frameId, short.actualReport.result.node.frameId)
    assert.equal(short.target.hud.operationId, short.actualReport.runOperation.id)
    assert.equal(short.target.hud.navigationId, short.actualReport.result.navigationId)
    assert.equal(short.target.hud.phase, 'completed')
    assert.ok(short.target.hud.hostConnected && short.target.hud.pointer)
    assert.equal(short.nativeBounds.height, 260)
    assert.equal(short.native.webContentsId, first.original.contentsId)
    assert.deepEqual(short.native, first.visual.nativePages.find(image => image.path === short.native.path))
    assert.equal(short.native.presentation.at, short.native.observedPresentationFrames.find(frame => frame.at === short.native.presentation.at)?.at)
    assert.ok(short.native.presentation.at >= short.target.hud.now && short.native.presentation.at < short.target.hud.expiresAt)
    const child = first.cases.find(row => row.label === 'motion-same-process-single-hover')
    assert.equal(child.targets.length, 1)
    assert.equal(child.actualActionSteps.length, 1)
    const target = child.targets[0], step = child.actualActionSteps[0]
    assert.equal(step.method, 'hover')
    assert.ok(typeof child.actualMainFrameId === 'string' && child.actualMainFrameId.length > 0)
    assert.equal(target.sessionId, undefined)
    assert.notEqual(target.frameId, child.actualMainFrameId)
    assert.equal(child.lateScrollWitness.actualStepSequence, step.sequence)
    const early = child.samples.filter(sample => child.lateScrollWitness.earlyCueSampleSequences.includes(sample.sequence))
    assert.ok(early.length > 0)
    assert.equal(new Set(child.lateScrollWitness.earlyCueSampleSequences).size, early.length)
    for (const sample of early) {
      assert.equal(sample.sampleKind, 'target')
      assert.deepEqual(sample.originalTarget, target)
      assert.equal(sample.currentContext.frameId, target.frameId)
      assert.equal(sample.currentContext.sessionId, undefined)
      assert.ok(Number.isSafeInteger(sample.currentContext.contextId) && sample.currentContext.contextId > 0)
      assert.ok(sample.startedAt >= step.finishedAt && sample.returnedAt < sample.hud.expiresAt)
      assert.equal(sample.hud.expiresAt, child.lateScrollWitness.originalExpiresAt)
      assert.equal(sample.hud.operationId, child.actualReport.runOperation.id)
      assert.equal(sample.hud.navigationId, target.issuedNavigationId)
      assert.equal(sample.hud.token, target.token)
      assert.equal(sample.hud.phase, 'completed')
      assert.ok(sample.hud.hostConnected && sample.hud.pointer)
    }
    assert.ok(child.frames.some(frame => early.some(sample => frame.sampleAtOrBefore.sampleSequence === sample.sequence &&
      frame.sampleAtOrBefore.returnedAt === sample.returnedAt && frame.presentationAt >= sample.returnedAt &&
      frame.presentationAt < sample.hud.expiresAt && frame.owner.token === target.token)))
    const facts = child.postActionTarget.actualDocumentFacts
    assert.equal(facts.actualFrameId, target.frameId)
    assert.equal(child.postActionTarget.document.frameId, target.frameId)
    assert.ok(Number.isSafeInteger(facts.defaultContextId) && facts.defaultContextId > 0)
    assert.equal(child.lateScrollWitness.lateObservedAt, child.postActionTarget.observedAt)
    assert.ok(child.postActionTarget.observedAt >= early[0].returnedAt)
    assert.ok(facts.events.length > 0 && facts.events.some(event => event.type === 'scroll' && event.at >= step.finishedAt && event.at <= facts.at),
      'The actual original child document reports its queued post-action scroll')
    assert.equal(receipt.cleanup.privateRootRemoved, true)
    assert.ok(receipt.cleanup.privateBytes <= 30 * 1024 * 1024)
    await independentReview(receiptBytes, receipt, images, root, option('--review'))
    assert.equal(receipt.taskComplete, false)
    assert.equal(receipt.desktopTabRegionFocusRestore, 'not-tested')
    assert.equal(receipt.healthyCoreRunRestore, 'not-tested')
    console.log(JSON.stringify({ receipt: receiptPath, motionIncrementPassed: true, thinNativePassed: false, taskComplete: false,
      pending: ['full Native input and actual OS window matrix', 'actual installed Desktop Tab/Region/focus recovery', 'healthy Core Run retained and recoverable'],
      note: 'Only the explicitly selected motion increment is consumed. It does not certify the complete Native or installed product.' }, null, 2))
    process.exit(0)
  }
  assert.ok(first.cases.length > 0)
  for (const label of ['normal-click', 'normal-hover', 'normal-fill', 'narrow-hover', 'short-click', 'same-process-frame',
    'out-of-process-frame', 'bottom-right-target', 'same-operation-goto-new-document-click']) {
    const action = first.cases.find(row => row.label === label)
    assert.ok(action, 'Real Native action exists: ' + label)
    assert.equal(action.singleAction, true)
    assert.equal(action.heldAction, false)
    assert.equal(action.repeatedAction, false)
    assert.equal(action.actualReport.outcome.kind, 'completed')
    assert.equal(action.target.hud.phase, 'completed')
    assert.equal(action.target.hud.glow, null)
    assert.equal(action.target.hud.hostPointerEvents, 'none')
    assert.deepEqual(action.target.decorativeRefs, [])
    assert.ok(action.target.actualSourceSnapshotNodes > 0)
  }
  assert.ok(first.cases.find(row => row.label === 'narrow-hover').nativeBounds.width <= 240)
  const edge = first.cases.find(row => row.label === 'bottom-right-target').target
  assert.ok(edge.hud.label.rect.x >= 0 && edge.hud.label.rect.y >= 0)
  assert.ok(edge.hud.label.rect.x + edge.hud.label.rect.width <= edge.geometry.innerWidth)
  assert.ok(edge.hud.label.rect.y + edge.hud.label.rect.height <= edge.geometry.innerHeight)
  for (const label of ['oopif-cleared-by-new-operation', 'oopif-cleared-by-hide',
    'oopif-completed-cue-cleared-by-native-human-click', 'oopif-cleared-by-main-native-human-input']) {
    const clear = first.cases.find(row => row.label === label)
    assert.ok(clear, 'Actual child document clear was observed: ' + label)
    assert.equal(clear.observed.phase, 'clear'); assert.equal(clear.observed.point, null)
    assert.equal(clear.observed.hostConnected, false)
    assert.ok(clear.observed.now < clear.oldExpiresAt, 'Clear was caused by the event, not ordinary cue expiry')
  }
  const input = first.cases.find(row => row.label === 'oopif-native-input-reaches-original-child')
  assert.ok(input?.beforeInputHud.hostConnected && input.beforeInputHud.pointer)
  assert.equal(input.afterCounter, input.beforeCounter + 1)
  assert.ok(input.nativeEvents.some(event => event.type === 'click' && event.trusted))
  const active = first.cases.find(row => row.label === 'actual-async-page-work')
  assert.ok(active, 'An actual unfinished page job was captured')
  assert.equal(active.heldAction, false)
  assert.equal(active.actualReport.outcome.kind, 'completed')
  const job = active.actualReport.result
  assert.equal(job.phase, 'completed')
  for (const at of [job.startedAt, job.finishedAt, active.beforeImage.hud.now, active.native.startedAt,
    active.native.presentation.at, active.native.returnedAt, active.afterImage.at,
    active.afterImage.jobReadReturnedAt, active.afterImage.hudReadReturnedAt]) assert.ok(Number.isSafeInteger(at) && at > 0)
  assert.ok(job.inputBytes > 0 && job.digests > 0 && job.outputBytes > 0, 'The completed real page work is nonempty')
  assert.equal(active.beforeImage.job.phase, 'working')
  assert.equal(active.beforeImage.job.startedAt, job.startedAt)
  assert.equal(active.beforeImage.hud.phase, 'running')
  assert.equal(active.beforeImage.hud.operationId, active.actualReport.runOperation.id)
  assert.ok(active.beforeImage.hud.hostConnected && active.beforeImage.hud.glow)
  assert.ok(job.startedAt <= active.beforeImage.hud.now && active.beforeImage.hud.now <= active.native.startedAt)
  assert.ok(active.native.startedAt <= active.native.presentation.at && active.native.presentation.at <= active.native.returnedAt)
  assert.ok(active.native.returnedAt < job.finishedAt, 'The actual native frame returned before the real page work completed')
  assert.equal(active.afterImage.at, active.native.returnedAt)
  assert.equal(active.afterImage.workSettled, false)
  assert.ok(active.afterImage.jobReadReturnedAt >= active.afterImage.at && active.afterImage.hudReadReturnedAt >= active.afterImage.at)
  assert.deepEqual(active.native, first.visual.nativePages.find(row => row.label === active.label), 'The running witness binds the preserved native original')
  // Browser evaluation can queue until the genuine page Promise completes. Preserve that late
  // read; its completed value does not rewrite when the original Native frame was captured.
  const reduced = second.cases.find(row => row.label === 'reduced-motion-static')
  assert.ok(reduced, 'Reduced-motion was observed in a real document')
  assert.equal(reduced.target.hud.reducedMotion, true)
  assert.equal(reduced.target.hud.pointer.animationName, 'none')
  const unrelated = first.cases.find(row => row.label === 'unrelated-browser-zero-work')
  assert.ok(unrelated)
  assert.equal(unrelated.productCdpCalls, 0); assert.equal(unrelated.productHudCalls, 0)
  assert.equal(receipt.cleanup.privateRootRemoved, true)
  assert.ok(receipt.cleanup.privateBytes <= 30 * 1024 * 1024)
  await independentReview(receiptBytes, receipt, images, root, option('--review'))
  // Full Desktop Tab/Region/focus and a healthy Core Run are absent from this thin producer.
  // They must be supplied by the real installed-product restart, not inferred from these two PIDs.
  assert.equal(receipt.taskComplete, false)
  assert.equal(receipt.desktopTabRegionFocusRestore, 'not-tested')
  assert.equal(receipt.healthyCoreRunRestore, 'not-tested')
  const thin = option('--scope') === 'thin'
  console.log(JSON.stringify({ receipt: receiptPath, thinNativePassed: true, taskComplete: false,
    pending: ['actual installed Desktop Tab/Region/focus recovery', 'healthy Core Run retained and recoverable'],
    note: 'This limits this task claim. It does not block packaging or healthy work.' }, null, 2))
  if (!thin) process.exitCode = 2
} catch (error) {
  console.error(JSON.stringify({ receipt: receiptPath, thinNativePassed: false, taskComplete: false, error: error.message }))
  process.exitCode = 1
}

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
