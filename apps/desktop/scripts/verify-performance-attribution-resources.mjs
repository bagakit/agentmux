import { provePerformanceOwner } from './performance-owner-proof.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sampler = 'apps/desktop/src/main/process-resource-sampler.ts'
const bridge = 'apps/desktop/src/main/resource-usage-control.ts'
const preload = 'apps/desktop/src/preload/index.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const api = 'apps/desktop/src/renderer/src/lib/api.ts'
const metrics = 'packages/core/src/metrics.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const test = 'apps/desktop/test/performance-attribution-resources.test.ts'
const registered = 'apps/desktop/test/metrics-main-control.test.ts'
const proof = provePerformanceOwner({
  name: 'attribution-resources', owners: [sampler, bridge, preload, store, api, metrics, ipc],
  astOwners: [[store, '__AGENTMUX_RESOURCE_STORE_SOURCE__'], [api, '__AGENTMUX_RESOURCE_API_SOURCE__']],
  tests: [test, registered, 'packages/core/test/performance-public-diagnostics.test.ts'], minimumTests: 17,
  mutantTests: [test],
  mutants: [
    ['pid-instance-reused', sampler, 'const key = `${metric.pid}:${metric.creationTime}`', 'const key = `${metric.pid}`'],
    ['process-counter-units', sampler, '100_000 * (seconds - previous.seconds)', '100 * (seconds - previous.seconds)'],
    ['counter-reset-accepted', sampler, 'seconds >= previous.seconds && at > previous.at', 'true && at > previous.at'],
    ['interval-duration-lost', sampler, 'at - previous!.at : null', '1000 : null'],
    ['row-uses-group-peak', sampler, 'cpuPercent: cpuByPid.get(metric.pid) ?? null, intervalMs:', 'cpuPercent, intervalMs:'],
    ['detail-budget-lost', sampler, 'processes: [...selected.values()]', 'processes: allProcesses'],
    ['omission-lost', sampler, 'omittedProcesses: allProcesses.length - selected.size', 'omittedProcesses: 0'],
    ['cpu-hotspot-priority-lost', sampler,
      'const byCpu = [...allProcesses].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.rssKib - a.rssKib || a.pid - b.pid)',
      'const byCpu = [...allProcesses].sort((a, b) => a.pid - b.pid)'],
    ['rss-hotspot-priority-lost', sampler,
      'const byRss = [...allProcesses].sort((a, b) => b.rssKib - a.rssKib || (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || a.pid - b.pid)',
      'const byRss = [...allProcesses].sort((a, b) => a.pid - b.pid)'],
    ['aggregate-truncated-to-detail', sampler, 'return { processCount: metrics.length, rssKib, cpuPercent, groups, processes:',
      'return { processCount: metrics.length, rssKib: [...selected.values()].reduce((sum, row) => sum + row.rssKib, 0), cpuPercent, groups, processes:'],
    ['creation-time-disconnected', preload, 'creationTime = process.getCreationTime()', 'creationTime = null'],
    ['heap-kib-units-corrupted', preload, 'usedHeapKib: heap.usedHeapSize,', 'usedHeapKib: heap.usedHeapSize * 1024,'],
    ['heap-failure-fabricates-zero', preload, "heap: null, unavailable: 'Renderer V8 heap observation is unavailable.'",
      "heap: {usedHeapKib:0,totalHeapKib:0,physicalHeapKib:0,heapLimitKib:0}, unavailable: 'Renderer V8 heap observation is unavailable.'"],
    ['desktop-api-caller-disconnected', api, '    ...preload,', '    ...preload, readRendererMemory: undefined,'],
    ['store-memory-caller-disconnected', store, '...api.readRendererMemory()', '...{}'],
    ['os-process-generation-guard-lost', bridge, 'currentProcessId() !== processId', 'false'],
    ['reply-process-binding-lost', bridge, 'result.process.pid !== processId', 'false'],
    ['public-detail-budget-lost', metrics, 'processes: boundedArray(256, appProcessParser)', 'processes: boundedArray(4096, appProcessParser)'],
    ['public-type-budget-lost', metrics, '(v as string).length > 128', '(v as string).length > 4096'],
    ['public-interval-coherence-lost', metrics, 'if ((process.cpuPercent === null) !== (process.intervalMs === null)) invalid()', 'if (false) invalid()'],
    ['public-capacity-zero-accepted', metrics, 'logicalCpuCount: nullable(positiveCount)', 'logicalCpuCount: nullable(count)'],
    ['actual-main-renderer-caller-disconnected', ipc,
      'observeRendererResources(controlBridge, currentMetricsWindow, signal, () => args.window.webContents.isDestroyed() ? null : args.window.webContents.getOSProcessId())',
      "Promise.reject(new Error('Renderer reader disconnected by source mutant'))", [registered]]
  ],
  callers: [
    [ipc, 'observeRendererResources(controlBridge, currentMetricsWindow, signal,'],
    [store, '...api.readRendererMemory()'],
    [preload, 'const heap = process.getHeapStatistics()'],
    [bridge, 'process: result.process, memory: result.memory'],
    ['packages/core/src/public-rpc-service.ts', "request.operation === 'metrics.get'"],
    ['packages/core/src/public-rpc.ts', "'system.metrics.get': 'metrics.get'"],
    ['apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx', 'app.processes']
  ]
})

try {
  proof.receipt.astExecutions = []
  for (const run of proof.receipt.runs) {
    if (run.name === 'actual-main-renderer-caller-disconnected') continue
    const records = readFileSync(join(proof.directory, run.name + '.ast-loaded.jsonl.resources'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.some(value => value.operation === 'desktop-api'), 'actual Desktop API factory was not executed')
    if (run.name !== 'desktop-api-caller-disconnected') assert.ok(records.some(value => value.operation === 'metrics.renderer'), 'actual Store callback was not executed')
    for (const value of records) {
      assert.equal(value.invoked, true)
      assert.match(value.callbackSHA256, /^[a-f0-9]{64}$/u)
      assert.equal(value.sourceSHA256, run.loadedSources[value.path], 'AST must consume exactly the frozen loaded production source')
      if (run.name === 'normal') assert.equal(value.threw, false)
      proof.receipt.astExecutions.push({ run: run.name, ...value })
    }
  }
  proof.receipt.astValidated = true
  proof.receipt.nativeSandbox = 'Actual candidate Electron sandbox qualification is supplied by the capture receipt; method fixtures here prove source mappings/unknown/mutants.'
} catch (error) {
  proof.receipt.passed = false
  throw error
} finally {
  writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt, null, 2) + '\n')
}
