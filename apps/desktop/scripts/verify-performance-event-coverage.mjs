import { provePerformanceOwner } from './performance-owner-proof.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const owner = 'apps/desktop/src/renderer/src/lib/renderer-performance.ts'
const test = 'apps/desktop/test/renderer-performance-event-coverage.test.tsx'
const proof = provePerformanceOwner({
  name: 'event-coverage',
  owners: [owner, 'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/metrics.ts',
    'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts', 'apps/desktop/src/renderer/src/components/TerminalView.tsx'],
  astOwners: [['apps/desktop/src/renderer/src/store.ts', '__AGENTMUX_RENDERER_STORE_SOURCE__'],
    ['apps/desktop/src/renderer/src/components/TerminalView.tsx', '__AGENTMUX_TERMINAL_VIEW_SOURCE__']],
  tests: [test, 'packages/core/test/performance-public-diagnostics.test.ts', 'apps/desktop/test/terminal-input-performance.test.ts'], minimumTests: 17,
  mutantTests: [test, 'apps/desktop/test/terminal-input-performance.test.ts'],
  mutants: [
    ['kind-bound-removed', owner, 'if (records.length === 6)', 'if (false)'],
    ['kind-fairness-lost', owner, 'const records = slowByKind[kind]', "const records = slowByKind['terminal-write']"],
    ['omission-lost', owner, 'records.shift(); slowEventsOmitted[kind]++', 'records.shift()'],
    ['delivery-order-wall-regression', owner, '.sort((a, b) => a.id - b.id)', '.sort((a, b) => a.observedAt - b.observedAt)'],
    ['native-occurrence-lost', owner, 'entry.duration, entry.startTime, start', 'entry.duration, start, start'],
    ['subthreshold-timing-lost', owner, '    rotate(deliveredAtMonoMs)\n', '    if (durationMs < 50) return\n    rotate(deliveredAtMonoMs)\n'],
    ['epoch-wall-regression', owner, 'Math.floor(deliveredAtMonoMs / 10_000)', 'Math.floor(wall() / 10_000)'],
    ['idle-rotation-lost', owner, '      rotate(start)\n', ''],
    ['late-count-lost', owner, 'else late[kind]++', 'else void kind'],
    ['unknown-count-lost', owner, 'if (occurredAtMonoMs === null) unknown[kind]++', 'if (occurredAtMonoMs === null) void kind'],
    ['partial-coverage-lost', owner, 'occurrence >= recordingSinceMonoMs', 'occurrence >= 0'],
    ['old-observer-generation-accepted', owner, 'observer = new Observer(list => {\n            if (observerOwners === 0 || generation !== observerGeneration) return', 'observer = new Observer(list => {\n            if (false) return'],
    ['snapshot-alias', owner, 'current: copyEpoch(currentEpoch)', 'current: currentEpoch'],
    ['session-body-retained', owner, "record('session-event', 'session-event', elapsed, start, delivered)", "record('session-event', _kind, elapsed, start, delivered)"],
    ['store-metrics-branch-disconnected', 'apps/desktop/src/renderer/src/store.ts', "request.operation === 'metrics.renderer'", "request.operation === 'metrics.renderer-disconnected'"],
    ['store-recorder-snapshot-disconnected', 'apps/desktop/src/renderer/src/store.ts', 'performance: rendererPerformance.snapshot()', 'performance: undefined'],
    ['interaction-event-start-disconnected', 'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts', 'slow(`${kind}-dispatch`, delayMs, stamp)', 'slow(`${kind}-dispatch`, delayMs)'],
    ['interaction-request-start-disconnected', 'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts', "slow('write-request', elapsed, startedAt)", "slow('write-request', elapsed)"],
    ['terminal-adapter-start-disconnected', 'apps/desktop/src/renderer/src/components/TerminalView.tsx', 'rendererPerformance.terminalInteraction(detail, duration, occurrenceMonoMs)', 'rendererPerformance.terminalInteraction(detail, duration)'],
    ['interaction-start-reconstructed', owner, "record('terminal-interaction', detail, duration, occurrenceMonoMs, delivered)", "record('terminal-interaction', detail, duration, delivered - duration, delivered)"],
    ['public-per-kind-bound-lost', 'packages/core/src/metrics.ts', '.filter(event => event.kind === kind).length > 6', '.filter(event => event.kind === kind).length > 30'],
    ['public-omission-field-lost', 'packages/core/src/metrics.ts', 'slowEvents: slowEventsParser, slowEventsOmitted: timingKindRecord(count),', 'slowEvents: slowEventsParser,']
  ],
  callers: [
    ['apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx', 'rendererPerformance.observeMainThread()'],
    ['apps/desktop/src/renderer/src/store.ts', "request.operation === 'metrics.renderer'"],
    ['apps/desktop/src/renderer/src/store.ts', 'performance: rendererPerformance.snapshot()'],
    ['apps/desktop/src/renderer/src/components/TerminalView.tsx', 'rendererPerformance.terminalWrite('],
    ['apps/desktop/src/main/resource-usage-control.ts', 'parseMetricsRendererResult(await bridge.execute('],
    ['packages/core/src/public-rpc-service.ts', "request.operation === 'metrics.get'"],
    ['packages/core/src/public-rpc.ts', "'system.metrics.get': 'metrics.get'"],
    ['packages/core/test/performance-public-diagnostics.test.ts', 'diagnostics']
  ]
})

try {
  proof.receipt.astExecutions = []
  for (const run of proof.receipt.runs) {
    const records = readFileSync(join(proof.directory, run.name + '.ast-loaded.jsonl.coverage'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.length, 2, 'actual Store callback and TerminalView adapter invocations expected per run')
    assert.deepEqual(records.map(value => value.operation).sort(), ['metrics.renderer', 'terminal-interaction-boundary'])
    for (const value of records) {
      assert.equal(value.invoked, true)
      assert.match(value.callbackSHA256, /^[a-f0-9]{64}$/u)
      assert.equal(value.sourceSHA256, run.loadedSources[value.path], 'AST execution must consume the same frozen source as the loaded owner')
      if (run.name === 'normal') assert.equal(value.threw, false)
      proof.receipt.astExecutions.push({ run: run.name, ...value })
    }
  }
  proof.receipt.astValidated = true
} catch (error) {
  proof.receipt.passed = false
  throw error
} finally {
  writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt, null, 2) + '\n')
}
