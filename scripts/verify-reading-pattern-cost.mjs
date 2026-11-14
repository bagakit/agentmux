import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const owner = 'packages/client-ui/src/lib/use-conversation-record-layout.ts'
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-reading-pattern-cost.mjs [baseline-receipt candidate-receipt]\n' +
    'Collect each receipt from the original checkout with verify-conversation-progressive-reading.mjs <evidence-dir> --scene=dense --reading-pattern --pattern-attempts=3.')
  process.exit(0)
}
const [baselinePath = '.local/reading-pattern-baseline-visible/receipt.json',
  candidatePath = '.local/reading-pattern-candidate-trials/receipt.json'] = process.argv.slice(2)

const sha = value => createHash('sha256').update(value).digest('hex')
function receipt(path) {
  const result = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  assert.equal(result.schema, 'agentmux.conversation-progressive-reading.v1')
  assert.equal(result.passed && result.executed && result.sourceBound, true, 'Load a completed, source-bound product run')
  assert.deepEqual(result.inputDrift, [])
  assert.ok(result.phases.length >= 3, 'Collect repeated original appends before comparing costs')
  assert.ok(result.phases.every(phase => phase.phase === 'seed' && phase.scene === 'dense'))
  const digest = result.inputs[owner]
  assert.ok(result.loaded.some(input => input.browser && input.path === owner && input.loadedSHA256 === digest))
  assert.equal(result.mobileBuild.source[owner], digest, 'Both hosts actually loaded the record layout owner')
  return result
}
const before = receipt(baselinePath)
const after = receipt(candidatePath)
assert.notEqual(before.inputs[owner], after.inputs[owner])
assert.equal(after.inputs[owner], sha(readFileSync(resolve(root, owner))), 'The sample must describe the current anchor owner')
assert.equal(before.phases.length, after.phases.length)
const benchmarkInputs = ['pnpm-lock.yaml',
  'apps/desktop/scripts/fixtures/conversation-progressive-reading/main.ts',
  'apps/desktop/scripts/fixtures/conversation-progressive-reading/anchor-sample.mjs',
  'apps/mobile/scripts/fixtures/conversation-progressive-reading/exercise.mjs',
  'apps/mobile/scripts/fixtures/conversation-progressive-reading/entry.tsx']
for (const path of benchmarkInputs) assert.ok(before.inputs[path] && before.inputs[path] === after.inputs[path], path + ' must be identical in both Renderer experiments')
const order = observed => observed.phases.map(({ attempt }) => attempt)
assert.deepEqual(order(before), order(after))
assert.equal(new Set(order(after)).size, after.phases.length)
const numbers = values => [...values].sort((a, b) => a - b)
const p95 = values => numbers(values)[Math.ceil(values.length * .95) - 1]
const median = values => numbers(values)[Math.floor(values.length / 2)]
const hostMetrics = (observed, host) => observed.phases.map(phase => {
  const result = host === 'Desktop' ? phase.actual : phase.actual.mobile
  const sample = result.anchorSample
  assert.equal(result.passed && sample.stillMounted, true, 'A successfully rendered original reader must report cost')
  assert.ok(sample.tailDistance > 64 && sample.rootNodeCount > 0 && sample.frames.length > 0)
  assert.ok(sample.frames.every(value => Number.isFinite(value) && value > 0))
  assert.ok(Number.isSafeInteger(sample.layoutKeyQueries) && sample.layoutKeyQueries >= 0)
  assert.equal(sample.recordId, host === 'Desktop' ? 'dense-desktop-anchor-sample-appended-answer' : 'dense-mobile-seed-anchor-sample-appended-answer')
  const difference = key => {
    const change = sample.after[key] - sample.before[key]
    assert.ok(Number.isFinite(change) && change >= 0, 'Missing or invalid Renderer counter ' + key)
    return change
  }
  return { frames: sample.frames, queries: sample.layoutKeyQueries, frameP95Ms: p95(sample.frames),
    appendAndPaintMs: 1000 * difference('Timestamp'), nodes: sample.rootNodeCount,
    taskMs: 1000 * difference('TaskDuration'), layoutMs: 1000 * difference('LayoutDuration'),
    styleMs: 1000 * difference('RecalcStyleDuration'), layoutCount: difference('LayoutCount'),
    styleCount: difference('RecalcStyleCount') }
})
const results = ['Desktop', 'Mobile'].map(host => {
  const baseline = hostMetrics(before, host), candidate = hostMetrics(after, host)
  const summaries = Object.keys(baseline[0]).filter(metric => metric !== 'frames').map(metric => {
    const original = baseline.map(row => row[metric]), current = candidate.map(row => row[metric])
    assert.ok([...original, ...current].every(Number.isFinite))
    const noise = Math.max(...original) - Math.min(...original)
    const delta = median(current) - median(original)
    return { metric, baseline: original, candidate: current, baselineNoise: noise, medianDelta: delta }
  })
  const counts = summaries.find(summary => summary.metric === 'queries')
  const improved = counts.medianDelta < -counts.baselineNoise &&
    counts.candidate.every((value, index) => value < counts.baseline[index])
  const frameDurations = trials => trials.flatMap(sample => sample.frames)
  const originalFrames = frameDurations(baseline), currentFrames = frameDurations(candidate)
  const frameBaselineNoise = summaries.find(summary => summary.metric === 'frameP95Ms').baselineNoise
  const pooledFrameP95 = { baseline: p95(originalFrames), candidate: p95(currentFrames), frameBaselineNoise,
    baselineFrames: originalFrames.length, candidateFrames: currentFrames.length }
  // Short per-trial samples make their p95 highly sensitive to one frame. Report
  // those trials above and check p95 across the repeated endpoint as a whole.
  const frameRegressed = Math.round((pooledFrameP95.candidate - pooledFrameP95.baseline - frameBaselineNoise) * 1000) > 0
  const timingRegressions = summaries.filter(summary => ['appendAndPaintMs', 'taskMs', 'layoutMs', 'styleMs'].includes(summary.metric)
    && summary.medianDelta > summary.baselineNoise).map(summary => summary.metric)
  if (frameRegressed) timingRegressions.push('pooledFrameP95')
  return { host, improved, summaries, pooledFrameP95, timingRegressions }
})
console.log(JSON.stringify({ baseline: before.candidate, candidate: after.candidate, results }, null, 2))
assert.ok(results.some(result => result.improved), 'A real original reading path must eliminate repeated layout-key queries')
assert.ok(results.every(({ summaries }) => summaries.find(summary => summary.metric === 'queries').medianDelta <= 0),
  'Do not move a repeated reading scan into the other host')
assert.ok(results.every(result => !result.timingRegressions.length), 'Repeated Renderer timing exceeds baseline variation')
