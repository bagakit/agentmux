import assert from 'node:assert/strict'
import test from 'node:test'
import { assertProjectionWorkPairs, controlledOutputTail, terminalOutputObservation, traceWorkMeasures } from '../scripts/fixtures/session-takeover/agent-operations-main.cjs'
import { createOperationOutputStream } from '../scripts/fixtures/session-takeover/operation-output-stream.mjs'

// Synthetic elapsed windows deliberately differ despite identical original work.
const samples = () => [0, 1, 2].flatMap(sample => [0, 384].map(unrelated => ({ sample, unrelated,
  durationMs: (unrelated ? 830 : 900) + sample * 20, projectionReads: 3, streamLines: 5, outputByteDelta: 100,
  outputSource: { kind: 'agent', hostId: 'original-host', agentSessionId: 'original-agent', run: { runId: 'original-run' } },
  response: { before: sample * 2 + Number(unrelated > 0), after: sample * 2 + Number(unrelated > 0) + 1 } })))

test('compares matched projection work without turning elapsed-window jitter into added invocations', () => {
  const result = assertProjectionWorkPairs(samples(), 1, 4)
  assert.equal(result.pairs.length, 3)
  assert.ok(result.pairs.every(pair => pair.baselineReads === pair.unrelatedReads && pair.unrelatedDurationMs < pair.baselineDurationMs))
})

test('rejects actual added projection work for the same native input and output', () => {
  const input = samples(); input[1].projectionReads++
  assert.throws(() => assertProjectionWorkPairs(input, 1, 4), /does not add projection invocations/)
})

test('rejects incomplete or differently exposed work instead of accepting empty comparisons', () => {
  assert.throws(() => assertProjectionWorkPairs(samples().slice(1), 1, 4), /Three nonempty/)
  const duplicate = samples(); duplicate[3].sample = 0
  assert.throws(() => assertProjectionWorkPairs(duplicate, 1, 4), assert.AssertionError)
  const output = samples(); output[1].streamLines--
  assert.throws(() => assertProjectionWorkPairs(output, 1, 4), /same original ordered output workload/)
  const input = samples(); input[1].response.after--
  assert.throws(() => assertProjectionWorkPairs(input, 1, 4), /one original native input/)
  const bytes = samples(); bytes[1].outputByteDelta++
  assert.throws(() => assertProjectionWorkPairs(bytes, 1, 4), /same original output byte workload/)
})

test('requires the original projection to have observed related operation changes first', () => {
  assert.throws(() => assertProjectionWorkPairs(samples(), 4, 4), /exercise the actual projection counter/)
})

test('the actual controlled producer emits an exact finite workload even when observation arrives late', { timeout: 5000 }, async () => {
  let observed = 0, complete
  const stopped = new Promise(resolve => { complete = resolve })
  const stream = createOperationOutputStream(bounded => {
    assert.equal(bounded, true)
    if (++observed === 5) complete()
  })
  try {
    stream.start(5)
    await stopped
    assert.equal(stream.running, false)
    await new Promise(resolve => setTimeout(resolve, 340))
    assert.equal(observed, 5)
  } finally { stream.stop() }
})

test('a new original output batch stops the prior interval and keeps its own exact workload', { timeout: 5000 }, async () => {
  let continuous = 0, bounded = 0, complete
  const stopped = new Promise(resolve => { complete = resolve })
  const stream = createOperationOutputStream(finite => {
    if (!finite) continuous++
    else if (++bounded === 5) complete()
  })
  try {
    stream.start()
    await new Promise(resolve => setTimeout(resolve, 190))
    assert.ok(continuous > 0)
    stream.start(5)
    const before = continuous
    await stopped
    await new Promise(resolve => setTimeout(resolve, 190))
    assert.equal(continuous, before); assert.equal(bounded, 5); assert.equal(stream.running, false)
  } finally { stream.stop() }
})


test('the exact original buffer must consume the real producer tail before a cohort is complete', { timeout: 5000 }, async () => {
  let output = '', emitted = 0, complete
  const done = new Promise(resolve => { complete = resolve })
  const buffer = [], stream = createOperationOutputStream(() => {
    const line = `Controlled live output ${String(++emitted).padStart(10, '0')}`
    output += line + '\r\n'
    if (emitted < 5) buffer.push(line)
    else complete()
  })
  const terminals = [{ regionId: 'original-region', viewObservation: { runId: 'original-run' }, buffer: { lines: buffer } }]
  try {
    stream.start(5); await done
    assert.equal(stream.running, false)
    const tail = controlledOutputTail(output)
    assert.ok(tail.endsWith('0000000005'))
    assert.equal(terminalOutputObservation(terminals, 'original-region', 'original-run', tail).consumed, false, 'Emit completion is not buffer consumption')
    buffer.push(tail)
    assert.equal(terminalOutputObservation(terminals, 'original-region', 'original-run', tail).consumed, true)
    assert.equal(terminalOutputObservation(terminals, 'other-region', 'original-run', tail).consumed, false)
    assert.equal(terminalOutputObservation(terminals, 'original-region', 'later-run', tail).consumed, false)
    assert.equal(terminalOutputObservation([...terminals, ...terminals], 'original-region', 'original-run', tail).consumed, false)
    assert.equal(controlledOutputTail('incomplete chunk'), undefined)
  } finally { stream.stop() }
})

const markedTrace = () => [
  { name: 'work-start', cat: 'blink.user_timing', ph: 'R', ts: 1000, pid: 7, tid: 11 },
  { name: 'work-end', cat: 'blink.user_timing', ph: 'R', ts: 11000, pid: 7, tid: 11 },
  { name: 'UpdateLayoutTree', ph: 'X', ts: 500, dur: 1000 },
  { name: 'Layout', ph: 'X', ts: 10000, dur: 3000 },
  { name: 'Paint', ph: 'X', ts: 9000, dur: 4000 }
]

test('actual trace helper clips crossing X events and keeps export costs separate from work duration', () => {
  const trace = markedTrace(), before = traceWorkMeasures(trace, 'work-start', 'work-end')
  assert.equal(before.durationMs, 10)
  assert.equal(before.measures.style.durationMs, 0.5)
  assert.equal(before.measures.layout.durationMs, 1)
  assert.equal(before.measures.paint.durationMs, 2)
  trace.push({ name: 'Paint', ph: 'X', ts: 15000, dur: 20000 })
  const exported = traceWorkMeasures(trace, 'work-start', 'work-end')
  assert.equal(exported.durationMs, before.durationMs, 'Trace export cannot dilute the work denominator')
  assert.deepEqual(exported.measures, before.measures)
  assert.equal(exported.wholeTraceMeasures.paint.durationMs, 24, 'Whole trace cost is retained rather than silently discarded')
  assert.equal(exported.wholeTraceMeasures.paint.events, 2)
})

test('trace work boundaries reject empty, duplicated, reversed or wrong-renderer marks', () => {
  assert.throws(() => traceWorkMeasures([], 'work-start', 'work-end'), /unique trace mark/)
  const duplicate = markedTrace(); duplicate.push(duplicate[0])
  assert.throws(() => traceWorkMeasures(duplicate, 'work-start', 'work-end'), /unique trace mark/)
  const reversed = markedTrace(); reversed[1].ts = 900
  assert.throws(() => traceWorkMeasures(reversed, 'work-start', 'work-end'), /positive duration/)
  const other = markedTrace(); other[1].tid++
  assert.throws(() => traceWorkMeasures(other, 'work-start', 'work-end'), assert.AssertionError)
})
