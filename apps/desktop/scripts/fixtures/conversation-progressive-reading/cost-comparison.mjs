import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
export function immediateFirstMount(code) {
  const original = 'const [mounted, setMounted] = useState(!work || !heavy)'
  assert.equal(code.split(original).length, 2, 'Baseline must change exactly the original first-mount decision')
  const transformed = code.replace(original, 'const [mounted, setMounted] = useState(true)')
  return { code: transformed, receipt: { originalHash: hash(code), transformedHash: hash(transformed), original,
    replacement: 'const [mounted, setMounted] = useState(true)', boundary: 'Only the initial mounted decision changes; original Core reads, shells, body rendering, copy, selection and persistence paths remain.' } }
}
const quantile = (values, proportion) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * proportion))]
}
const median = values => quantile(values, 0.5)
export function readingCost(actual) {
  const metrics = actual.readingMetrics, first = metrics?.firstReadable
  assert.ok(first && actual.reads.length && metrics.frames.length, 'A cost trial must reach actual original readable frames')
  const start = Math.min(...actual.reads.map(read => read.started))
  assert.ok(first.at >= start)
  assert.ok(actual.appendCost)
  assert.ok(actual.appendCost.disposition?.accepted?.membership.some(row => row.present === true && row.record.source.kind === 'native' && row.record.source.recordId === actual.appendCost.recordId),
    'Pending selection-held frames cannot qualify as an append scheduling improvement')
  const firstSample = actual.samples.find(sample => sample.name === 'first-readable')
  assert.ok(firstSample, 'The original first-readable sample is required')
  const counters = [actual.taskMetricsStart, firstSample.taskMetrics, actual.taskMetrics].map(sample => {
    assert.equal(sample?.timeDomain, 'timeTicks', 'Original native task counters use the declared wall-clock domain')
    const values = sample.values
    assert.ok(Number.isFinite(values?.Timestamp) && Number.isFinite(values?.TaskDuration) && values.TaskDuration >= 0,
      'Original native task timestamps and occupancy are required')
    return values
  })
  for (let index = 1; index < counters.length; index++) assert.ok(
    counters[index].Timestamp >= counters[index - 1].Timestamp && counters[index].TaskDuration >= counters[index - 1].TaskDuration,
    'Original full and post-readable task windows remain ordered')
  assert.ok(metrics.longTasks.every(value => Number.isFinite(value) && value >= 0), 'Observed task durations remain valid')
  assert.ok(Array.isArray(metrics.longTaskEntries), 'Original plain task entries are required')
  assert.deepEqual(metrics.longTaskEntries.map(entry => entry.duration), metrics.longTasks, 'Observed task durations and original entries remain the same ordered collection')
  return { firstReadableMs: first.at - start, firstMounts: first.heavyMounts, firstShells: first.heavyShells,
    appendMounts: actual.appendCost.after - actual.appendCost.before, firstNodes: first.nodes, finalNodes: firstSample.ui.allNodes,
    reads: actual.reads.length, frameP50: quantile(metrics.frames, 0.5), frameP95: quantile(metrics.frames, 0.95),
    longTaskP95: quantile(metrics.longTasks, 0.95), observedBlockingMs: metrics.longTasks.reduce((sum, value) => sum + Math.max(0, value - 50), 0),
    rendererTaskMs: (counters[2].TaskDuration - counters[0].TaskDuration) * 1000,
    afterFirstReadableTaskMs: (counters[2].TaskDuration - counters[1].TaskDuration) * 1000,
    remounts: metrics.heavyMounts.filter(mount => mount.ordinal > 1).length,
    samples: { frames: metrics.frames.length, longTasks: metrics.longTasks.length, heavyMounts: metrics.heavyMounts.length } }
}
/** No human-supplied pass flags: comparisons are derived from executed trial data. */
export function compareReadingCosts(phases, transforms) {
  assert.ok(transforms.length === 1 && transforms[0].originalHash !== transforms[0].transformedHash)
  const scenes = []
  for (const scene of ['dense', 'longbody']) {
    const trials = phases.filter(phase => phase.scene === scene)
    assert.equal(trials.length, 6, 'Three complete pairs are required per input scene')
    const pairs = []
    for (let pair = 1; pair <= 3; pair++) {
      const values = trials.filter(trial => trial.pair === pair)
      assert.deepEqual(values.map(value => value.variant), pair % 2 ? ['scheduled', 'immediate'] : ['immediate', 'scheduled'])
      assert.ok(values.every(value => value.actual.passed), 'Both variants retain original correctness')
      pairs.push({ pair, order: values.map(value => value.variant), scheduled: readingCost(values.find(value => value.variant === 'scheduled').actual),
        immediate: readingCost(values.find(value => value.variant === 'immediate').actual) })
    }
    const distributions = Object.fromEntries(['firstReadableMs', 'frameP95', 'longTaskP95', 'observedBlockingMs', 'rendererTaskMs', 'afterFirstReadableTaskMs', 'firstMounts', 'appendMounts', 'reads', 'remounts'].map(metric => {
      const scheduled = pairs.map(pair => pair.scheduled[metric]), immediate = pairs.map(pair => pair.immediate[metric])
      const baselineRange = Math.max(...immediate) - Math.min(...immediate), differences = pairs.map(pair => pair.scheduled[metric] - pair.immediate[metric])
      return [metric, { scheduled, immediate, differences, baselineRange, medianDifference: median(differences),
        sustainedRegressionBeyondBaselineRange: differences.every(value => value > baselineRange) }]
    }))
    const failures = ['firstReadableMs', 'frameP95', 'longTaskP95', 'observedBlockingMs', 'rendererTaskMs', 'afterFirstReadableTaskMs']
      .filter(metric => distributions[metric].sustainedRegressionBeyondBaselineRange).map(metric => `${metric} worsens in every pair beyond observed baseline variation`)
    if (scene === 'longbody') {
      for (const metric of ['firstMounts', 'appendMounts']) if (distributions[metric].medianDifference >= 0) failures.push(`${metric} did not decrease`)
      if (pairs.some(pair => pair.scheduled.firstShells <= 0 || pair.scheduled.firstMounts >= pair.scheduled.firstShells)) failures.push('Scheduled first frame mounted every original heavy shell')
    }
    if (pairs.some(pair => pair.scheduled.remounts > 0 || pair.immediate.remounts > 0)) failures.push('An original heavy body remounted')
    scenes.push({ scene, pairs, distributions, failures, passed: failures.length === 0 })
  }
  return { schema: 'agentmux.conversation-reading-costs.v2', baseline: 'same-source-immediate-first-mount', transforms, scenes,
    passed: scenes.every(scene => scene.passed),
    boundary: 'Three paired trials per controlled transcript in the same environment. This compares only initial heavy-body scheduling. firstReadable is any visible original prose, including short user text; it does not measure completion of a long answer. Observed blocking sums only the portion after 50ms of the available original task entries, not Lighthouse FCP-to-TTI. Native timeTicks task occupancy uses both the actual start and the first-readable sample through the native endpoint; it includes fixture work, is not CPU time and is not atomic with the Renderer entry snapshot. Both windows independently retain the regression rule. Observed baseline range is a local noise bound, not a universal latency target or proof of all architecture changes.' }
}
