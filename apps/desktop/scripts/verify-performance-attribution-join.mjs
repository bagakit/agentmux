import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner } from './performance-owner-proof.mjs'
const store = 'apps/desktop/src/renderer/src/store.ts', api = 'apps/desktop/src/renderer/src/lib/api.ts'
const resources = 'apps/desktop/test/performance-attribution-resources.test.ts'
// Reuse unaffected mutations; exercise the changed shared Store and the complete
// public/Toolkit consumer again on the integrated candidate.
const proof = provePerformanceOwner({
  name: 'attribution-latest-main-join', config: 'apps/desktop/test/performance-attribution.config.mts',
  owners: ['apps/desktop/src/main/process-resource-sampler.ts', 'apps/desktop/src/main/resource-usage-control.ts',
    'apps/desktop/src/preload/index.ts', store, api, 'packages/core/src/metrics.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx',
    'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx'],
  astOwners: [[store, '__AGENTMUX_RESOURCE_STORE_SOURCE__'], [api, '__AGENTMUX_RESOURCE_API_SOURCE__']],
  tests: [resources, 'apps/desktop/test/metrics-main-control.test.ts', 'packages/core/test/performance-public-diagnostics.test.ts',
    'apps/desktop/test/performance-attribution.test.tsx'], minimumTests: 23, mutantTests: [resources],
  mutants: [['current-store-caller-disconnected', store, '...api.readRendererMemory()', '...{}']],
  callers: [['apps/desktop/src/renderer/src/components/performance/PerformancePanel.tsx', '<PerformanceOverview'],
    ['apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx', '<PerformancePanel'],
    ['apps/desktop/src/main/ipc.ts', 'observeRendererResources(controlBridge, currentMetricsWindow, signal,']]
})
try {
  proof.receipt.astExecutions = []
  for (const run of proof.receipt.runs) {
    const records = readFileSync(join(proof.directory, run.name + '.ast-loaded.jsonl.resources'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.some(value => value.operation === 'metrics.renderer'))
    assert.ok(records.some(value => value.operation === 'desktop-api'))
    for (const value of records) {
      assert.equal(value.invoked, true)
      assert.equal(value.sourceSHA256, run.loadedSources[value.path])
      if (run.name === 'normal') assert.equal(value.threw, false)
      proof.receipt.astExecutions.push({run:run.name,...value})
    }
  }
  proof.receipt.astValidated = true
} catch (error) {proof.receipt.passed = false;throw error}
finally {writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt,null,2)+'\n')}
