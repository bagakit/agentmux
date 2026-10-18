import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compareReadingCosts, immediateFirstMount, readingCost } from './fixtures/conversation-progressive-reading/cost-comparison.mjs'
import { observeReadingTasks } from './fixtures/conversation-progressive-reading/task-observation.mjs'

const counters = (Timestamp, TaskDuration) => ({ timeDomain: 'timeTicks', values: { Timestamp, TaskDuration } })
function actual(scene = 'dense', variant = 'scheduled') {
  const heavy = scene === 'longbody', immediate = variant === 'immediate'
  return { passed: true, reads: [{ started: 10 }],
    taskMetricsStart: counters(1, 0.1), taskMetrics: counters(3, 0.4),
    samples: [{ name: 'first-readable', ui: { allNodes: 100 }, taskMetrics: counters(2, 0.2) }],
    appendCost: { before: 0, after: heavy && immediate ? 1 : 0, recordId: 'append',
      disposition: { accepted: { membership: [{ present: true, record: { source: { kind: 'native', recordId: 'append' } } }] } } },
    readingMetrics: { firstReadable: { at: 20, heavyMounts: heavy && immediate ? 4 : 0, heavyShells: 4, nodes: 100 },
      frames: [16, 16], longTasks: [50, 60], longTaskEntries: [{ duration: 50 }, { duration: 60 }], heavyMounts: [] } }
}
function comparison(change = () => {}) {
  const phases = []
  for (const scene of ['dense', 'longbody']) for (let pair = 1; pair <= 3; pair++) {
    for (const variant of pair % 2 ? ['scheduled', 'immediate'] : ['immediate', 'scheduled']) {
      const value = actual(scene, variant)
      change(value, variant, scene)
      value.readingMetrics.longTaskEntries = value.readingMetrics.longTasks.map(duration => ({ duration }))
      phases.push({ scene, pair, variant, actual: value })
    }
  }
  const source = readFileSync(new URL('../../../packages/client-ui/src/components/ConversationProgressiveBody.tsx', import.meta.url), 'utf8')
  return compareReadingCosts(phases, [immediateFirstMount(source).receipt])
}

test('observed blocking is continuous at the entry threshold', () => {
  const value = actual()
  value.readingMetrics.longTasks = [49.9, 50, 50.1]
  value.readingMetrics.longTaskEntries = value.readingMetrics.longTasks.map(duration => ({ duration }))
  assert.ok(Math.abs(readingCost(value).observedBlockingMs - 0.1) < 1e-9)
  assert.equal(comparison().passed, true)
})

test('numeric costs cannot diverge from the retained ordered original entries', () => {
  for (const entries of [undefined, [], [{ duration: 60 }, { duration: 50 }], [{ duration: 50 }, { duration: 61 }]]) {
    const value = actual(); value.readingMetrics.longTaskEntries = entries
    assert.throws(() => readingCost(value), assert.AssertionError)
  }
})

test('native occupancy requires the original ordered timeTicks counters', () => {
  for (const change of [
    value => { delete value.taskMetricsStart },
    value => { value.taskMetrics.timeDomain = 'threadTicks' },
    value => { value.taskMetrics.values.TaskDuration = NaN },
    value => { value.taskMetrics.values.TaskDuration = 0.15 },
    value => { value.taskMetrics.values.Timestamp = 1.5 }
  ]) {
    const value = actual(); change(value)
    assert.throws(() => readingCost(value), assert.AssertionError)
  }
})

test('subthreshold task occupancy cannot disappear behind unchanged long-task entries', () => {
  const result = comparison((value, variant) => {
    if (variant === 'scheduled') {
      value.samples[0].taskMetrics.values.TaskDuration += 0.02
      value.taskMetrics.values.TaskDuration += 0.02
    }
  })
  assert.equal(result.passed, false)
  assert.ok(result.scenes.every(scene => scene.failures.some(failure => failure.startsWith('rendererTaskMs '))))
})

test('initial savings cannot offset a post-readable interaction regression', () => {
  const result = comparison((value, variant) => {
    if (variant === 'scheduled') value.samples[0].taskMetrics.values.TaskDuration -= 0.02
  })
  assert.equal(result.passed, false)
  assert.ok(result.scenes.every(scene => scene.distributions.rendererTaskMs.medianDifference === 0 &&
    scene.failures.some(failure => failure.startsWith('afterFirstReadableTaskMs '))))
})

test('sustained observed blocking still rejects the candidate', () => {
  const result = comparison((value, variant) => {
    if (variant === 'scheduled') value.readingMetrics.longTasks.push(100)
  })
  assert.equal(result.passed, false)
  assert.ok(result.scenes.every(scene => scene.failures.some(failure => failure.startsWith('observedBlockingMs '))))
})

test('observer snapshots drain queued original entries once and detach platform objects', () => {
  const previous = globalThis.PerformanceObserver
  let observer
  globalThis.PerformanceObserver = class {
    queue = []
    constructor(callback) { observer = this; this.callback = callback }
    observe(options) { assert.deepEqual(options, { type: 'longtask', buffered: true }) }
    takeRecords() { return this.queue.splice(0) }
    deliver(entries) { this.callback({ getEntries: () => entries }) }
  }
  try {
    const snapshot = observeReadingTasks()
    const entry = duration => ({ duration, toJSON() { return { duration,
      attribution: [{ toJSON() { return { name: 'unknown', containerType: 'window' } } }] } } })
    observer.deliver([entry(51)])
    observer.queue.push(entry(63))
    const first = snapshot()
    assert.deepEqual(first.longTasks, [51, 63])
    assert.deepEqual(first.longTaskEntries, [51, 63].map(duration => ({ duration,
      attribution: [{ name: 'unknown', containerType: 'window' }] })))
    assert.ok(Number.isFinite(first.observation.observedThrough))
    first.longTasks.push(999); first.longTaskEntries[0].duration = 999
    observer.deliver([])
    assert.deepEqual(snapshot().longTasks, [51, 63])
    assert.equal(snapshot().longTaskEntries[0].duration, 51)
    observer.queue.push(entry(72))
    assert.deepEqual(snapshot().longTasks, [51, 63, 72])
  } finally { globalThis.PerformanceObserver = previous }
})
