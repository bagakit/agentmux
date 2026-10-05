import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner, proofRoot, sha } from './performance-owner-proof.mjs'

const sampler = 'apps/desktop/src/main/process-resource-sampler.ts'
const port = 'apps/desktop/src/main/resource-usage-control.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const bridge = 'apps/desktop/src/main/control-ipc-bridge.ts'
const rpc = 'packages/core/src/public-rpc-service.ts'
const focused = 'apps/desktop/test/performance-metrics-first-frame.test.ts'
const registered = 'apps/desktop/test/metrics-main-control.test.ts'
const lease = 'packages/core/test/metrics-control-host.test.ts'
const inputs = [import.meta.filename, join(proofRoot, 'vitest.config.ts'), join(proofRoot, 'vitest.dist-freshness.ts'),
  ...['packages/core/dist/agentmux.js', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-resource-guide.ts']
    .map(path => join(proofRoot, path))]
const before = Object.fromEntries(inputs.map(path => [path, sha(readFileSync(path))]))
const proof = provePerformanceOwner({
  name: 'metrics-first-frame', owners: [sampler, port, ipc, bridge, rpc],
  tests: [focused, registered, lease], minimumTests: 35, mutantTests: [focused],
  mutants: [
    ['no-answer-yet-called-failed', port,
      "window === null ? 'Current Renderer window is unavailable' : rendererFailure)",
      "window === null ? 'Current Renderer window is unavailable' : rendererFailure ?? 'Current Renderer has not answered')"],
    ['real-failure-called-pending', port,
      'const rendererFailure = matchesWindow(renderer.unavailableWindow) ? renderer.unavailable : null',
      'const rendererFailure = null'],
    ['stale-success-discarded', port,
      'sameWindow ? source(renderer.data, renderer.observedAt, rendererFailure)',
      'sameWindow ? source<MetricsRenderer>(null, null, rendererFailure)'],
    ...['windowId', 'webContentsId', 'generation'].map(field => [
      `failure-${field}-binding-lost`, port, `candidate.${field} === window.${field}`, 'true'
    ]),
    ['failure-bound-at-completion', sampler, 'unavailableWindow: attemptedWindow',
      'unavailableWindow: sources?.rendererWindow?.() ?? null'],
    ['attempt-window-aliased', sampler, 'attemptedWindow = window ? { ...window } : null', 'attemptedWindow = window ?? null'],
    ['ended-observation-failure-imported', sampler,
      'if (generation !== this.generation || controller.signal.aborted) return\n        this.renderer = { ...this.renderer, unavailable:',
      'this.renderer = { ...this.renderer, unavailable:'],
    ['registered-window-reader-disconnected', ipc, 'rendererWindow: currentMetricsWindow,', 'rendererWindow: () => null,', [registered]],
    ['bridge-deadline-disabled', bridge,
      "this.endObservation(\n          request.requestId,\n          bridgeError('CONTROL_TIMEOUT', 'Desktop Control request timed out.')\n        )",
      '/* actual bridge deadline disabled */'],
    ['get-exact-lease-not-disposed', rpc, 'if (subscription) release(subscription)', '/* exact get lease not disposed */', [lease]],
    ['get-late-lease-not-disposed', rpc, 'if (controller.signal.aborted) release(value)', 'if (false) release(value)', [lease]]
  ],
  callers: [
    [ipc, 'rendererWindow: currentMetricsWindow,'],
    [ipc, 'observeRendererResources(controlBridge, currentMetricsWindow, signal,'],
    [ipc, 'createResourceMetricsPort('],
    [sampler, 'const window = sources?.rendererWindow?.()'],
    [port, 'args.sampler.subscribe(sample =>'],
    [rpc, 'metrics.subscribe(resolve,'],
    ['packages/core/src/public-rpc.ts', "'system.metrics.get': 'metrics.get'"],
    ['packages/core/src/agentmux-cli-commands.ts', "empty('system.metrics.get', 'Read the first bounded metrics frame; sources may still be pending.')"]
  ]
})
try {
  const after = Object.fromEntries(inputs.map(path => [path, sha(readFileSync(path))]))
  assert.deepEqual(after, before, 'Actual scope driver/config/compiled CLI inputs changed during proof')
  proof.receipt.driverInputs = { before, after }
  const records = readFileSync(join(proof.directory, 'normal.ast-loaded.jsonl.first-frame'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(records.some(value => value.case === 'actual-unix-and-compiled-get-first-frame'))
  assert.ok(records.some(value => value.case === 'shared-real-watch-and-cli-get'))
  proof.receipt.executionEvidence = [{ run: 'normal', records }]
  proof.receipt.boundary = 'Actual injected sampler, actual bridge/port, registered Main and private Unix/compiled CLI. No user UI/Run, native input, restart or installation qualification.'
} catch (error) {
  proof.receipt.passed = false
  throw error
} finally {
  writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt, null, 2) + '\n')
}
