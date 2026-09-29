import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

// This consumes originals. A private Browser/profile restart cannot certify Desktop/Core recovery.
const args = process.argv.slice(2)
const option = name => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}
const receiptPath = resolve(option('--receipt') ?? 'docs/reviews/evidence/browser-operation-feedback-native/receipt.json')
const root = dirname(receiptPath)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
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

try {
  const receiptBytes = await readFile(receiptPath)
  const receipt = JSON.parse(receiptBytes)
  assert.equal(receipt.schema, 'agentmux.browser-operation-feedback-native.v1')
  assert.match(receipt.author, /^\/root\/[a-z0-9_]+$/)
  assert.equal(receipt.passed, true, receipt.failure?.message)
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
  for (const phase of receipt.phases) {
    assert.equal(phase.process.exitCode, 0)
    assert.equal(phase.process.timedOut, false)
    const raw = await json(resolve(root, `${phase.phase}-receipt.json`))
    assert.deepEqual(raw, phase.actual, 'Top-level receipt consumes the actual process original')
    assert.equal(raw.phase, phase.phase)
    assert.equal(raw.passed, true)
    assert.ok(Number.isInteger(raw.pid) && raw.pid > 0)
    assert.ok(raw.versions.electron && raw.versions.chrome)
    assert.equal(raw.versions.electron, receipt.engine.expectedElectron)
    assert.ok(raw.visual.nativePages.length > 0 && raw.visual.osWindows.length > 0)
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
  const first = receipt.phases[0].actual, second = receipt.phases[1].actual
  assert.equal(first.versions.chrome, second.versions.chrome)
  assert.notEqual(first.pid, second.pid)
  assert.equal(receipt.localBrowserProfileRecovery.passed, true)
  assert.equal(second.restored.localBrowserInputRestored, true)
  assert.equal(first.retained.browserId, second.restored.browserId)
  assert.equal(first.retained.profileId, second.restored.profileId)
  assert.equal(first.retained.url, second.restored.url)
  assert.equal(first.retained.profileClicks, second.restored.profileClicks)
  assert.equal(second.restored.oldHudPresent, false)
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
  const review = await json(resolve(option('--review') ?? resolve(root, 'independent-visual-review.json')))
  assert.equal(review.schema, 'agentmux.browser-feedback-independent-visual-review.v1')
  assert.equal(review.scope, 'private-native-browser-feedback')
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
