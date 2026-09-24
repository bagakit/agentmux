import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const collector = 'apps/desktop/scripts/lib/browser-capability-cost-collector.mjs'
const validator = 'apps/desktop/scripts/lib/browser-capability-proof-join.mjs'
const reader = 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs'
const wrapper = 'apps/desktop/scripts/verify-browser-task-capabilities.mjs'
const source = await readFile(new URL('./lib/browser-capability-proof-join.mjs', import.meta.url), 'utf8')
const final = 'for (const path of Object.keys(candidate)) assert.equal(hash(await read(path)), candidate[path], `Candidate moved during proof consumption: ${path}`)'
const changed = [
  { label: 'historical-frame-owner-context-ignored', file: validator,
    before: source.slice(source.indexOf('      assert.ok(Array.isArray(actual.nativeBounds)'), source.indexOf('      assert.ok(actual.nativePage.bounds.width')),
    after: '// This historical frame owner context ignored\n' },
  { label: 'historical-frame-owner-identity-mismatch-accepted', file: validator,
    before: "assert.equal(actual.nativePage.webContentsId, actual.nativeBounds[0].webContentsId, 'Shown pixels must bind this frame owner context')", after: '// Another frame owner context accepted' },
  { label: 'historical-frame-url-mismatch-accepted', file: validator,
    before: "assert.equal(actual.nativePage.browserUrl, actual.nativeBounds[0].browserUrl, 'Shown pixels must bind this frame URL context')", after: '// Another historical frame URL accepted' },
  { label: 'historical-frame-owner-bounds-mismatch-accepted', file: validator,
    before: "for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(actual.nativeBounds[0][key]) && Math.abs(actual.nativePage.bounds[key] - actual.nativeBounds[0][key]) <= 2, 'Shown pixels must bind this frame actual owner bounds')", after: '// Another historical owner geometry accepted' },
  { label: 'historical-frame-url-erased-by-final-restart-url', file: validator,
    before: "assert.equal(actual.nativePage.browserUrl, actual.nativeBounds[0].browserUrl, 'Shown pixels must bind this frame URL context')",
    after: "assert.equal(actual.nativePage.browserUrl, actual.nativeBounds[0].browserUrl, 'Shown pixels must bind this frame URL context')\n      assert.ok(expected.regions.some(region => region.url === actual.nativePage.browserUrl), 'Wrongly require historical URL to equal final restart URL')" },
  { label: 'source-workspace-scope-omitted', file: collector,
    before: "assert.deepEqual(value.reports.map(report => report.case).sort(), ['actual-workspace-projections', 'selected-tab-session-observers'], 'Consume both production Workspace and selector scopes')", after: '// Only the selected green scope consumed' },
  { label: 'source-workspace-failure-overruled', file: collector,
    before: "assert.equal(report.passed, true, 'A failed actual Source consumer cannot sign costs')", after: '// Failed actual Source consumer signed' },
  { label: 'source-consumer-bytes-moved-during-measurement', file: collector,
    before: "assert.deepEqual(report.sourceAfter, report.sourceIdentity, 'Source consumer bytes changed during measurement')", after: '// Moving Source consumer bytes accepted' },
  { label: 'source-model-relabeled-native-producer', file: collector,
    before: "assert.deepEqual(report.producer, { kind: 'source-real-useAppStore', browserProducerInvoked: false, nativeAppLaunched: false }, 'Source consumer scope must remain explicit')", after: '// Source model relabeled Native product measurement' },
  { label: 'source-fixed-observation-conditions-omitted', file: collector,
    before: "assert.ok(typeof report.conditions.observation === 'string' && report.conditions.observation.trim(), 'Require actual fixed Source observation conditions')", after: '// Counts treated as observation conditions' },
  { label: 'source-global-notification-count-invented', file: collector,
    before: "assert.equal(report.globalStoreNotifications, updated.filter(event => event.kind === 'global-store-notify').length, 'Global notifications must derive from raw events')", after: '// Invented global notification count accepted' },
  { label: 'source-selector-call-count-invented', file: collector,
    before: "assert.equal(sample.selectorCalls, events.filter(event => event.kind === 'selector-call').length, 'Selector calls must derive from actual raw observations')", after: '// Invented selector call count accepted' },
  { label: 'source-observer-render-count-invented', file: collector,
    before: "assert.equal(sample.renders, events.filter(event => event.kind === 'observer-render').length, 'Observer renders must derive from actual raw observations')", after: '// Invented observer render count accepted' },
  { label: 'source-workspace-commit-count-invented', file: collector,
    before: "assert.equal(sample.commits, events.filter(event => event.kind === 'workspace-commit').length, 'Workspace commits must derive from actual raw observations')", after: '// Invented Workspace commit count accepted' },
  { label: 'source-unrelated-observer-render-amplification-accepted', file: collector,
    before: "if (!sample.related) assert.equal(sample.renders, 0, 'Unrelated Source observer renders must remain zero')", after: '// Actual unrelated observer amplification accepted' },
  { label: 'source-unrelated-workspace-commit-amplification-accepted', file: collector,
    before: "if (!sample.related) assert.equal(sample.commits, 0, 'Unrelated production Workspace commits must remain zero')", after: '// Actual unrelated Workspace amplification accepted' },
  { label: 'source-mounted-agent-subject-omitted', file: collector,
    before: "assert.deepEqual(report.samples.map(sample => `${sample.kind}:${sample.subjectId}`).sort(), subjects.sort(), 'Every actual mounted Tab and Session must be sampled')", after: '// A mounted Agent subject omitted from sampling' },
  { label: 'source-mounted-workspace-subject-omitted', file: collector,
    before: "assert.deepEqual(report.samples.map(sample => sample.id).sort(), Object.keys(report.conditions.fixtureLayouts).sort(), 'Every actual mounted Workspace must be sampled')", after: '// A mounted Workspace omitted from sampling' },
  { label: 'source-unrecorded-raw-consumer-work-ignored', file: collector,
    before: "assert.ok(report.rawEvents.every(event => report.samples.some(sample => sample.id === event.consumerId) || event.kind === 'global-store-notify'), 'Raw consumer events must belong to an actual sampled consumer')", after: '// Unrecorded raw consumer work ignored' },
  { label: 'native-raw-cost-consumer-call-removed', file: validator, before: 'assertNativeBrowserMeasurements(nativeMeasurements)', after: '// Native raw cost validator never called' },
  { label: 'source-mounted-cost-consumer-call-removed', file: validator, before: 'assertSourceBrowserConsumers(sourceMeasurements)', after: '// Source mounted cost validator never called' },
  { label: 'historical-official-transferred-path-reverted', file: wrapper,
    before: '.bagakit/feature-tracker/features-transferred/f-2ew8fzgff/tasks.json', after: '.bagakit/feature-tracker/features/f-2ew8fzgff/tasks.json' }
]
assertMutationAnchors()
function assertMutationAnchors() {
  const start = source.indexOf('      assert.ok(Array.isArray(actual.nativeBounds)'), end = source.indexOf('      assert.ok(actual.nativePage.bounds.width')
  if (start < 0 || end <= start || !changed[0].before.includes('Shown pixels must bind this frame URL context')) throw new Error('Historical frame context mutation must scan a nonempty actual source block')
}
await verifyRendererSourceMutations({
  name: `browser-capability-cost-and-native-increment-${randomUUID()}`,
  tests: ['apps/desktop/test/browser-capability-cost-collector.test.ts', 'apps/desktop/test/browser-task-capabilities-product.test.tsx', 'apps/desktop/test/browser-outcome-probe-scenario.test.ts'],
  sources: [collector, validator, reader, wrapper, 'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs', 'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs'],
  mutations: process.argv.includes('--incremental-final') ? changed : [
    { label: 'actual-reader-physical-read-cost-discarded', file: reader, before: ', readCost: chunk.readCost', after: '' },
    { label: 'physical-read-volume-replaced-by-return-length', file: collector,
      before: 'physicalPayloadBytes += chunk.readCost.payloadBytes', after: 'physicalPayloadBytes += chunk.returnedBytes' },
    { label: 'property-reads-counted-as-extraction-calls', file: collector,
      before: 'extractCalls: extracts.length', after: 'extractCalls: work.reads' },
    { label: 'manual-aggregate-signs-native-cost', file: collector,
      before: "assert.deepEqual(value.producer.totals, summarizeBrowserOutcomeCollection(value.producer.recordedResult, value.producer.operation), 'Collection totals must derive from raw original facts')", after: '// Manual aggregate accepted' },
    { label: 'unrelated-actual-callback-amplification-ignored', file: collector,
      before: "assert.equal(unrelated.events.length, 0, 'Unrelated actual callbacks must remain zero in the observed window')", after: '// Unrelated real callback amplification ignored' },
    { label: 'prior-real-sequence-replaced-by-array-index', file: collector,
      before: "assert.equal(unrelated.afterSequence, preparation.events.at(-1).sequence, 'Use the actual prior final sequence, not an array index')", after: '// Invented cursor accepted' },
    { label: 'short-observation-window-signed', file: collector,
      before: "assert.ok(window.endedAt - window.bothOpenedAt >= window.fixedQuietWindowMs, 'Require the complete actual fixed observation window')", after: '// Short fixed window accepted' },
    { label: 'same-browser-operation-signs-unrelated-sample', file: collector,
      before: "assert.notEqual(related.operationId, unrelated.operationId, 'An unrelated sample must be another real operation')\n  assert.notEqual(related.browserId, unrelated.browserId, 'An unrelated sample must be another actual Browser')", after: '// Same actual operation and Browser mislabeled unrelated' },
    { label: 'recorded-ancestor-new-source-accepted', file: validator,
      before: 'assert.equal(hash(await readCommit(candidate.commit, path)), candidate.identity[path], `Candidate source is not from its recorded main commit: ${path}`)', after: '// New bytes at old recorded ancestor accepted' },
    { label: 'fixed-candidate-late-byte-drift-ignored', file: validator, before: final, after: '// Candidate cut files changed during consumption' },
    { label: 'native-validator-canonical-byte-check-omitted', file: validator,
      before: "assert.equal(hash(value), reference.sha256, 'Preserved actual image bytes changed')", after: '// Changed actual image bytes accepted by reusable validator' },
    { label: 'parked-native-owner-not-unique', file: validator,
      before: "assert.equal(actual.nativePage.owners.length, 1, 'Require the original unique parked Native owner')", after: '// Duplicate actual parked Native owners accepted' },
    { label: 'parked-native-owner-fact-ignored', file: validator,
      before: "assert.equal(owner.parked, true, 'Native owner must actually be parked')", after: '// Non-parked actual Native owner accepted' },
    { label: 'shown-native-owner-identity-removed', file: validator,
      before: "assert.ok(Number.isSafeInteger(actual.nativePage.webContentsId) && actual.nativePage.webContentsId > 0, 'Require actual shown Native owner identity')", after: '// Shown Native owner identity omitted' }
  , ...changed]
})
