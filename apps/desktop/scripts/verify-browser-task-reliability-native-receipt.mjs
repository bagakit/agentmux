import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = (items, label) => { assert.ok(Array.isArray(items) && items.length > 0, label); return items }
const integer = value => Number.isSafeInteger(value) && value >= 0
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

async function original(path) {
  const bytes = await readFile(path)
  assert.ok(bytes.length > 0, 'Actual original bytes are nonempty')
  return { path: resolve(path), bytes: bytes.length, sha256: sha(bytes), value: decode(bytes) }
}

async function boundFile(base, row, compressed = false) {
  assert.ok(row && typeof row.path === 'string' && row.path && !isAbsolute(row.path), 'Original path is relative to its archive')
  const path = resolve(base, row.path), tail = relative(base, path)
  assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail), 'Original remains inside its evidence archive')
  const stored = await readFile(path), bytes = compressed ? gunzipSync(stored) : stored
  assert.ok(bytes.length > 0 && integer(row.bytes) && row.bytes > 0, 'Actual bound original is nonempty')
  assert.equal(bytes.length, row.bytes, 'Actual original byte count matches')
  assert.equal(sha(bytes), row.sha256, 'Actual original SHA matches')
  return bytes
}

/** This adapter recognizes the actual private producer, never full Desktop acceptance. */
export async function consumeTaskReliabilityPrivateOriginal(identity, base, reviewOriginal = null) {
  const receipt = identity.value
  assert.equal(receipt.schema, 'agentmux.browser-task-reliability-private-native.v1')
  assert.equal(receipt.scope, 'private-original-owners-component-increment')
  assert.ok(typeof receipt.author === 'string' && receipt.author && /^[a-f0-9]{40}$/.test(receipt.mainCommit))
  assert.equal(receipt.nativePassed, false, 'Private producer does not claim full Native')
  assert.equal(receipt.taskComplete, false, 'Private producer does not claim task completion')
  assert.deepEqual(receipt.sourceDrift, [], 'Actual loaded-source cut did not drift')
  const sources = new Map()
  for (const row of nonempty(receipt.inputs, 'Actual emitted source inputs are nonempty')) {
    assert.ok(!sources.has(row.path), 'Actual emitted source paths are unique')
    if (row.origin === 'fixed-main-git-blob') assert.equal(row.commit, receipt.mainCommit)
    const bytes = await boundFile(base, { ...row, path: row.snapshot }, true)
    sources.set(row.path, bytes)
  }
  const emitted = new Set()
  for (const name of ['main', 'preload', 'renderer']) {
    const metafile = decode(gunzipSync(await readFile(resolve(base, `${name}-metafile.json.gz`))))
    for (const output of Object.values(metafile.outputs)) {
      for (const [path, row] of Object.entries(output.inputs)) if (row.bytesInOutput > 0) {
        const actual = path.replace(/^fixed-main:/, '')
        if (isAbsolute(actual)) {
          const matches = [...sources.keys()].filter(source => actual.endsWith('/' + source))
          assert.equal(matches.length, 1, 'Absolute compiler input has one exact archived relative source')
          emitted.add(matches[0])
        } else emitted.add(actual)
      }
    }
  }
  assert.ok(emitted.size > 0, 'Actual compiler emitted-input scan is nonempty')
  assert.deepEqual([...emitted].sort(), [...sources.keys()].sort(), 'Actual metafiles bind the complete emitted source set')
  const helper = sources.get('apps/desktop/src/shared/browser-task-reliability.ts')?.toString()
  const control = sources.get('apps/desktop/src/main/browser-task-control.ts')?.toString()
  assert.ok(helper && control, 'Actual Main helper and its public read owner are emitted')
  assert.ok(control.includes('getBrowserTaskReliability({'), 'Actual definition-external Main caller is emitted')
  const compiled = new Map()
  for (const row of nonempty(receipt.compiled, 'Actual compiled originals are nonempty')) {
    assert.ok(!compiled.has(row.name), 'Compiled names are unique')
    compiled.set(row.name, await boundFile(base, { ...row, path: row.snapshot }, true))
  }
  for (const name of ['main.mjs', 'preload.cjs', 'renderer.js', 'renderer.css', 'index.html']) {
    assert.ok(compiled.has(name), 'Original executed bundle member exists: ' + name)
  }
  const phases = new Map()
  for (const row of nonempty(receipt.phases, 'Actual process phases are nonempty')) {
    assert.ok(['first', 'second'].includes(row.phase) && !phases.has(row.phase), 'Exactly one original per private process phase')
    assert.ok(integer(row.pid) && row.pid > 0)
    assert.equal(row.exit, 0); assert.equal(row.signal, null); assert.equal(row.timedOut, false)
    const raw = await boundFile(base, row.original), value = decode(raw)
    assert.equal(value.schema, 'agentmux.browser-task-reliability-private-native-process.v1')
    assert.equal(value.author, receipt.author); assert.equal(value.pid, row.pid); assert.equal(value.phase, row.phase)
    assert.ok(value.engine?.electron && value.nativeOwner?.originalWebContentsId > 0 && value.nativeOwner?.rendererWebContentsId > 0)
    assert.equal(value.taskComplete, false)
    phases.set(row.phase, value)
  }
  assert.equal(phases.size, 2, 'Two original process phases are present')
  const first = phases.get('first'), second = phases.get('second')
  assert.notEqual(first.pid, second.pid, 'Private restore uses distinct actual process IDs')
  assert.equal(first.engine.electron, second.engine.electron)
  const state = first.durable.state
  const asset = nonempty(state.assets, 'Original durable assets are nonempty')[0]
  assert.ok(asset.sourceRecordingId && asset.versions.length >= 2)
  const run = nonempty(state.runs, 'Original durable runs are nonempty').find(row => row.id === state.selectedRunId)
  assert.ok(run && run.browserId === asset.browserId && run.assetId === asset.id && run.status === 'completed')
  assert.ok(nonempty(run.operationIds, 'Selected run has original journal IDs').length > 0)
  const operation = nonempty(first.durable.operations, 'Original journal is nonempty').find(row => run.operationIds.includes(row.id) && row.outcome)
  assert.ok(operation, 'Selected run binds its original outcome operation')
  const registration = operation.outcome.registration, version = asset.versions.find(row => row.version === run.version)
  assert.ok(version?.completion?.criteria.length > 0, 'Original saved version has completion criteria')
  assert.deepEqual(registration.criteria, version.completion.criteria)
  assert.deepEqual(registration.assetRun, { runId: run.id, assetId: asset.id, version: run.version })
  assert.equal(registration.context.operationId, operation.id); assert.equal(registration.context.browserId, run.browserId)
  const verifications = nonempty(first.calls, 'Actual Main method calls are nonempty').filter(row => row.method === 'verifyOutcome')
  assert.ok(verifications.length >= 2, 'Original passed and nonpassed verifications both exist')
  for (const status of ['passed', 'unavailable']) {
    const row = verifications.find(call => call.result?.status === status && call.result?.assetRun?.runId === run.id)
    assert.ok(row && row.senderWebContentsId === first.nativeOwner.rendererWebContentsId && row.returnedAt >= row.startedAt)
    assert.deepEqual(row.result.context, registration.context)
    assert.deepEqual(row.result.assetRun, registration.assetRun)
    const conditions = nonempty(row.result.conditions, 'Original verification conditions are nonempty')
    assert.deepEqual(conditions.map(condition => condition.criterion), version.completion.criteria)
    for (const condition of conditions) assert.equal(condition.status, status)
  }
  const reads = first.calls.filter(row => row.method === 'controlTask' && row.request?.operation === 'browser.task.reliability')
  assert.ok(reads.length > 0, 'Actual Main public reliability reads are nonempty')
  for (const row of reads) {
    const result = row.result?.reliability
    assert.ok(result && row.senderWebContentsId === first.nativeOwner.rendererWebContentsId && row.returnedAt >= row.startedAt)
    for (const key of ['browserId', 'assetId', 'version']) assert.equal(result[key], row.request[key])
    assert.equal(result.assetId, asset.id); assert.equal(result.browserId, run.browserId)
    assert.ok(integer(result.population.terminalRuns) && integer(result.population.pendingRuns))
    assert.equal(result.samples.length, result.population.terminalRuns)
    const classifications = ['passed', 'not-met', 'unavailable', 'unknown', 'failed', 'stopped', 'interrupted']
    assert.deepEqual(Object.keys(result.counts).sort(), classifications.slice().sort())
    assert.equal(result.population.retainedRuns, result.population.terminalRuns + result.population.pendingRuns)
    const samples = new Set()
    for (const sample of result.samples) {
      assert.ok(!samples.has(sample.runId) && classifications.includes(sample.result)); samples.add(sample.runId)
      assert.ok(state.runs.find(candidate => candidate.id === sample.runId && candidate.assetId === result.assetId && candidate.browserId === result.browserId && candidate.version === result.version))
    }
    for (const classification of classifications) {
      assert.ok(integer(result.counts[classification]))
      assert.equal(result.counts[classification], result.samples.filter(sample => sample.result === classification).length, 'Public count matches its actual retained sample classification')
    }
    assert.equal(result.passRate, result.population.terminalRuns ? result.counts.passed / result.population.terminalRuns : null)
    if (result.selectedRunId) assert.equal(result.selectedRunId, run.id)
  }
  const versionReads = reads.map(row => row.result.reliability).filter(row => row.version === run.version)
  const passed = versionReads.find(row => row.counts.passed === 1 && row.population.terminalRuns === 1)
  const unavailable = versionReads.findLast(row => row.counts.unavailable === 1 && row.population.terminalRuns === 1)
  assert.ok(passed && unavailable && unavailable.counts.passed === 0, 'Same real retained run changes from 1/1 passed to 0/1 unavailable')
  assert.equal(passed.samples[0].runId, run.id); assert.equal(unavailable.samples[0].runId, run.id)
  assert.ok(passed.humanInterventions > 0 && run.humanCheckpoints.length > 0, 'Actual trusted human confirmations are retained')
  assert.ok(reads.some(row => row.result.reliability.version !== run.version && row.result.reliability.population.retainedRuns === 0 && row.result.reliability.passRate === null), 'Another saved version has no fake zero-sample success')
  assert.deepEqual(second.recovered.state, state, 'Real second owner recovers exact assets, versions, runs and selection')
  assert.equal(second.originalPage.clicks, 0, 'Recovery does not repeat the old actions in the new page')
  assert.equal(receipt.privateRootRemoved, true, 'Own private tree was removed')
  const images = nonempty(receipt.images, 'Original Native PNG collection is nonempty'), paths = new Set()
  for (const row of images) {
    assert.ok(!paths.has(row.path), 'Original image paths are unique'); paths.add(row.path)
    const phase = phases.get(row.phase)
    assert.ok(phase && row.pid === phase.pid)
    assert.ok(['renderer-chrome', 'original-native-page'].includes(row.kind), 'Private images cannot claim an OS composed window')
    assert.equal(row.webContentsId, row.kind === 'renderer-chrome' ? phase.nativeOwner.rendererWebContentsId : phase.nativeOwner.originalWebContentsId)
    const bytes = await boundFile(base, row)
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Actual original is a PNG')
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0)
    assert.ok(row.originalNativeBounds.width > 0 && row.originalNativeBounds.height > 0 && row.originalNativeVisible === true)
  }
  let visual = 'pending'
  if (reviewOriginal) {
    const review = reviewOriginal.value
    assert.equal(review.schema, 'agentmux.browser-task-reliability-independent-visual-review.v1')
    assert.equal(review.receiptSha256, identity.sha256); assert.equal(review.producerAuthor, receipt.author)
    assert.ok(review.independent === true && typeof review.reviewer === 'string' && review.reviewer && review.reviewer !== receipt.author)
    assert.equal(review.producerScope, receipt.scope)
    assert.ok(typeof review.scope === 'string' && review.scope.trim(), 'Independent review has an explicit observation boundary')
    assert.ok(['pass', 'fail'].includes(review.assessment) && review.nativePassed === false && review.taskComplete === false, 'Independent verdict is bounded to this image increment')
    assert.equal(nonempty(review.images, 'Independent image review collection is nonempty').length, images.length)
    const reviewed = new Set()
    for (const row of review.images) {
      assert.ok(!reviewed.has(row.path), 'Independent image paths are unique'); reviewed.add(row.path)
      const actual = images.find(image => image.path === row.path)
      assert.ok(actual && row.viewed === true)
      for (const key of ['phase', 'label', 'kind', 'sha256', 'bytes']) assert.equal(row[key], actual[key], 'Exact independent original tuple: ' + key)
      assert.ok(typeof row.assessment === 'string' && row.assessment.trim(), 'Actual per-frame visual assessment exists')
    }
    visual = review.assessment === 'fail' ? 'failed' : 'passed-increment-only'
  }
  return { sourceInputs: sources.size, compiledMembers: compiled.size, processIds: [first.pid, second.pid],
    selectedRunId: run.id, observedRates: [passed.passRate, unavailable.passRate], privateSelectedDurableRestore: true,
    images: images.length, visual, scope: receipt.scope, independentReview: reviewOriginal ? { sha256: reviewOriginal.sha256, bytes: reviewOriginal.bytes } : null }
}

export async function verifyTaskReliabilityNativeReceipt(args = []) {
  const report = { schema: 'agentmux.browser-task-reliability-native-consumer.v1', taskId: 'T-033',
    passed: false, nativePassed: false, taskComplete: false, outcome: 'pending', actions: [], evidence: null,
    reason: 'No exact Native reliability original was provided.',
    missing: ['Production control/Store and full BrowserPane Native execution', 'Original OS composed window/focus and human input',
      'Unchanged full Desktop layout/healthy Run preservation observations'] }
  try {
    if (args.length) {
      assert.ok([2, 4].includes(args.length) && args[0] === '--receipt' && args[1] && !args[1].startsWith('--') &&
        (args.length === 2 || args[2] === '--visual-review' && args[3] && !args[3].startsWith('--')), 'Only --receipt <original> [--visual-review <review>] is accepted')
      const identity = await original(args[1])
      report.evidence = { path: identity.path, sha256: identity.sha256, bytes: identity.bytes }
      const review = args.length === 4 ? await original(args[3]) : null
      report.partial = await consumeTaskReliabilityPrivateOriginal(identity, dirname(identity.path), review)
      report.outcome = 'partial'
      report.reason = 'Exact private original-owner behavior and bundle/image integrity were consumed. Its bounded scope cannot certify complete T033 Native or Desktop recovery.'
    }
  } catch (error) {
    report.outcome = error.code === 'ENOENT' ? 'pending' : 'rejected'
    report.reason = error.message; report.failure = { code: error.code ?? error.name }
  }
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: node apps/desktop/scripts/verify-browser-task-reliability-native-receipt.mjs [--receipt <original.json> [--visual-review <independent.json>]]\nRead-only partial adapter. Missing, rejected and incomplete Native evidence always exits 2. No build, install, page action or user restart.\n')
  } else {
    process.stdout.write(JSON.stringify(await verifyTaskReliabilityNativeReceipt(process.argv.slice(2)), null, 2) + '\n')
    process.exitCode = 2
  }
}
