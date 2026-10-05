import { provePerformanceOwner } from './performance-owner-proof.mjs'
const owner = 'apps/desktop/src/renderer/src/components/performance/PerformanceAttribution.tsx'
const overview = 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx'
const test = 'apps/desktop/test/performance-attribution.test.tsx'
provePerformanceOwner({
  name: 'resource-attribution-overview', config: 'apps/desktop/test/performance-attribution.config.mts', owners: [owner, overview],
  tests: [test], minimumTests: 6,
  mutantTests: [test],
  mutants: [
    ['cores-denominator', owner, '(value / 100).toFixed(2)', '(value / 14).toFixed(2)'],
    ['unknown-basis-guessed', owner, "value == null || basis !== 'one-logical-core'", 'value == null'],
    ['pid-creation-fence-lost', owner, 'value.creationTime === renderer.process.creationTime', 'true'],
    ['window-generation-fence-lost', owner, 'renderer.window.generation === observation.window.generation', 'true'],
    ['pid-reuse-node-alias', owner, 'key={`${value.pid}:${value.creationTime}`}', 'key={value.pid}'],
    ['stale-read-painted-live', owner, "available = !paused && observation.app.state === 'available'", 'available = true'],
    ['previous-period-lost', owner, "const epoch = selected === 'previous' ? epochs.previous! : epochs.current", 'const epoch = epochs.current'],
    ['heap-guessed-from-rss', owner, 'resident(heap?.usedHeapKib)', 'resident(observation.app.data?.rssKib)'],
    ['consumer-disconnected', overview, '<PerformanceAttribution observation={observation} paused={paused} />', 'null'],
    ['pause-disconnected', overview, '<PerformanceAttribution observation={observation} paused={paused} />', '<PerformanceAttribution observation={observation} paused={false} />']
  ],
  callers: [
    ['apps/desktop/src/renderer/src/components/performance/PerformancePanel.tsx', '<PerformanceOverview'],
    [overview, '<PerformanceAttribution observation={observation} paused={paused} />'],
    ['apps/desktop/src/renderer/src/components/performance/PerformancePanel.tsx', '<ToolkitPopover'],
    ['apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx', '<PerformancePanel'],
    [test, 'root.render(<App />)']
  ]
})
