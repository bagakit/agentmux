import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileOf = ref => resolve(root, ref.file)
let sourceRef
function product(file) {
  assert.ok(/^[a-f0-9]{40}$/.test(sourceRef), 'An exact reviewed Git candidate is required')
  return execFileSync('git', ['show', sourceRef + ':' + file], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
}
async function pinned(ref) {
  assert.ok(ref?.file && /^[a-f0-9]{64}$/.test(ref.sha256), 'An exact artifact is required')
  const bytes = await readFile(fileOf(ref))
  assert.equal(sha(bytes), ref.sha256, 'Artifact changed: ' + ref.file)
  return JSON.parse(bytes)
}
async function current(source, label) {
  assert.ok(Object.keys(source).length, 'Nonempty actual ' + label + ' Source required')
  for (const [file, digest] of Object.entries(source))
    assert.equal(sha(product(file)), digest, label + ' changed: ' + file)
}
async function rawRuns(proof, requireMutants) {
  assert.ok(proof.runs.length > 0 && Object.keys(proof.source).length > 0 && proof.callers.length > 0)
  const baseline = proof.runs.find(run => run.label === 'baseline')
  assert.ok(baseline && baseline.expected === 'GREEN')
  let names
  for (const run of proof.runs) {
    const reportBytes = await readFile(resolve(root, run.report)), loadedBytes = await readFile(resolve(root, run.loaded))
    assert.equal(sha(reportBytes), run.reportSha256); assert.equal(sha(loadedBytes), run.loadedSha256)
    const report = JSON.parse(reportBytes), tests = report.testResults.flatMap(suite => suite.assertionResults)
    assert.equal(report.numPendingTests, 0); assert.ok(tests.length > 0)
    const currentNames = tests.map(test => test.fullName).sort()
    if (!names) names = currentNames
    assert.deepEqual(currentNames, names); assert.equal(run.collected, tests.length); assert.equal(run.signal, null)
    const loaded = {}
    for (const line of loadedBytes.toString().trim().split('\n')) {
      const row = JSON.parse(line)
      assert.ok(!loaded[row.path] || loaded[row.path] === row.sha256); loaded[row.path] = row.sha256
    }
    for (const file of ['apps/desktop/src/renderer/src/lib/mote-goals.ts', 'apps/desktop/src/renderer/src/components/MoteCurrentWork.tsx',
      'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/store.ts',
      'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx']) assert.ok(loaded[file], 'Actual owning consumer must load: ' + file)
    if (run.expected === 'GREEN') {
      assert.equal(run.code, 0); assert.equal(report.success, true); assert.ok(tests.every(test => test.status === 'passed'))
      assert.deepEqual(loaded, proof.source)
    } else {
      assert.equal(run.expected, 'RED'); assert.notEqual(run.code, 0)
      assert.ok(tests.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError:|expected .* to /s.test(message))))
      const differences = Object.keys(loaded).filter(file => loaded[file] !== proof.source[file])
      assert.equal(differences.length, 1, 'Only one actual loaded product mutant may change')
    }
  }
  if (requireMutants) {
    assert.equal(proof.runs.filter(run => run.expected === 'RED').length, 6)
    assert.equal(proof.runs.length, 13)
  } else assert.equal(proof.runs.length, 1, 'Rebind is a bounded actual baseline, not repeated mutation qualification')
}

const output = join(root, '.tmp/mote-daily-work')
await mkdir(output, { recursive: true })
const receipt = { task: 'T-002', passed: false, boundary: 'Original current-work caller, exact independently reviewed original Goal backend, bounded current Source/types and original operated Renderer evidence. No model, package, installation or user Run claim.' }
try {
  const locator = JSON.parse(await readFile(join(output, 'approved.json'), 'utf8'))
  const source = await pinned(locator.sourceGate), rebind = await pinned(locator.rebind), renderer = await pinned(locator.renderer)
  const review = await pinned(locator.review), manifest = await pinned(locator.manifest), backendLocator = await pinned(locator.backendLocator)
  sourceRef = locator.sourceRef
  assert.equal(review.sourceRef, sourceRef, 'Independent review must bind the exact deliverable Git candidate')
  receipt.sourceRef = sourceRef
  assert.equal(review.approved, true); assert.equal(review.status, 'approved'); assert.ok(review.taskIds.includes('T-002'))
  for (const [reviewKey, locatorKey] of [['sourceGate', 'sourceGate'], ['sourceRebind', 'rebind'], ['renderer', 'renderer'], ['candidateManifest', 'manifest']])
    assert.equal(review[reviewKey].sha256, locator[locatorKey].sha256, 'Independent review must bind ' + reviewKey)
  for (const key of ['receipt', 'review', 'manifest']) assert.deepEqual(review.backend[key], backendLocator[key], 'Review must bind exact T001 ' + key)
  const backend = await pinned(backendLocator.receipt), backendReview = await pinned(backendLocator.review), backendManifest = await pinned(backendLocator.manifest)
  assert.equal(backend.task, 'T-001'); assert.equal(backendReview.approved, true); assert.ok(backendReview.tasks.includes('T-001'))
  assert.equal(backendReview.sourceGate.sha256, backendLocator.receipt.sha256)
  assert.equal(backendReview.candidateManifest.sha256, backendLocator.manifest.sha256)
  assert.deepEqual(backend.candidateManifest, backendLocator.manifest)
  await current(backendManifest.paths, 'Reviewed Goal backend')
  const backendProcess = spawnSync(process.execPath, [join(root, 'apps/desktop/scripts/fixtures/mote-daily-goal/qualify-gate.mjs'), '--task', 'T-001'],
    { cwd: root, env: { ...process.env, AGENTMUX_DAILY_GOAL_QUALIFICATION: fileOf(locator.backendLocator) }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(backendProcess.status, 0, backendProcess.stdout + backendProcess.stderr)
  receipt.backendQualification = { locator: locator.backendLocator, output: backendProcess.stdout }
  assert.equal(source.task, 'T-002'); assert.equal(source.passed, true); assert.equal(source.sourceQualified, true)
  await rawRuns(source, true)
  assert.equal(rebind.task, 'T-002'); assert.equal(rebind.passed, true); assert.equal(rebind.sourceRebound, true)
  await rawRuns(rebind, false); assert.equal(rebind.types.diagnostics.length, 0)
  await current({ ...rebind.source, ...rebind.types.source }, 'Current-work actual loaded/type graph')
  await current(manifest.paths, 'Current-work product')
  for (const [file, digest] of Object.entries(source.source)) {
    assert.ok(rebind.source[file], 'Original actual consumer missing: ' + file)
    if (digest !== rebind.source[file]) assert.equal(backendManifest.paths[file], rebind.source[file], 'Unreviewed change outside the exact Goal backend: ' + file)
  }
  assert.equal(renderer.passed, true); assert.equal(renderer.process.exitCode, 0); assert.equal(renderer.renderer.passed, true)
  assert.ok(renderer.renderer.operations.length > 0 && Object.keys(renderer.images).length >= 6)
  for (const [file, digest] of Object.entries(renderer.images)) assert.equal(sha(await readFile(join(dirname(fileOf(locator.renderer)), basename(file)))), digest)
  for (const [file, digest] of Object.entries(renderer.source)) {
    if (!/^(apps\/desktop\/src|packages\/)/.test(file)) continue
    const actual = sha(product(file))
    if (actual !== digest) assert.equal(backendManifest.paths[file], actual, 'Unreviewed Renderer import change: ' + file)
  }
  for (const file of ['apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/continuous-progress.ts']) {
    assert.ok(backendManifest.paths[file], 'Exact shared backend input required: ' + file)
    assert.equal(rebind.source[file] ?? rebind.types.source[file], backendManifest.paths[file], 'Actual current-work caller must load reviewed shared input: ' + file)
  }
  receipt.qualifications = locator; receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
const file = join(output, 'normal-' + globalThis.crypto.randomUUID() + '.json')
await writeFile(file, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, task: 'T-002', receipt: relative(root, file) }))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
