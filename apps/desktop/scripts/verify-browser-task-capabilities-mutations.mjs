import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const owner = 'apps/desktop/scripts/lib/browser-capability-proof-join.mjs'
const collector = 'apps/desktop/scripts/lib/browser-capability-cost-collector.mjs'
const wrapper = 'apps/desktop/scripts/verify-browser-task-capabilities.mjs'
const source = await readFile(new URL('./lib/browser-capability-proof-join.mjs', import.meta.url), 'utf8')
const initial = 'assert.equal(hash(bytes), expected, `Current candidate changed: ${path}`)'
const final = 'for (const path of Object.keys(candidate)) assert.equal(hash(await read(path)), candidate[path], `Candidate moved during proof consumption: ${path}`)'
const originalWorkbenchBinding = "assert.deepEqual(original, workbenchReceipt.receipt.firstUi.restored, 'Cost workbench before must be the actual original private Native workbench')"
const restoredWorkbenchBinding = "assert.deepEqual(restored, workbenchReceipt.receipt.secondUi.restored, 'Cost workbench after must be the actual restored private Native workbench')"
const mutations = [
    { label: 'empty-required-task-set-accepted', file: owner,
      before: "assert.deepEqual(manifest.tasks.map(task => task.id).sort(), [...BROWSER_CLOSEOUT_TASKS].sort(), 'Consume every required task exactly once')",
      after: '// Required task set ignored' },
    { label: 'source-milestone-treated-as-delivered', file: owner,
      before: "assert.equal(task.status, 'done', `${proof.id} is not formally done`)", after: '// Source milestone accepted' },
    { label: 'different-formal-gate-accepted', file: owner,
      before: 'assert.deepEqual(task.last_gate_commands.map(item => item.command), commands)', after: '// Gate contract ignored' },
    { label: 'candidate-source-drift-ignored', file: owner,
      before: source, after: source.replace(initial, '// Initial candidate bytes ignored').replace(final, '// Final candidate bytes ignored') },
    { label: 'old-source-proof-relabelled', file: owner,
      before: 'for (const [path, expected] of Object.entries(identity)) assert.equal(candidate[path], expected, `Proof names a different candidate: ${path}`)',
      after: '// Old input identity accepted' },
    { label: 'definition-only-caller-accepted', file: owner,
      before: 'assert.notEqual(caller.path, caller.definition)', after: '// Definition-only hit accepted' },
    { label: 'failed-native-receipt-accepted', file: owner,
      before: "assert.equal(receipt.completeGate, true, 'Native failure cannot become a successful join')", after: '// Failed native receipt accepted' },
    { label: 'ordinary-restart-identity-lost', file: owner,
      before: 'assert.equal(tab.layout.activeRegionId, expected.focus)', after: '// Restored focus ignored' },
    { label: 'author-self-review-accepted', file: owner,
      before: "assert.ok(review.reviewer && review.reviewer !== review.author, 'Image review must be independent')", after: '// Author signed own image review' },
    { label: 'unrelated-artifact-work-ignored', file: collector,
      before: "assert.equal(unrelated.events.length, 0, 'Unrelated actual callbacks must remain zero in the observed window')", after: "// Actual unrelated public callback delivery accepted" }
    ,{ label: 'failed-task-json-accepted', file: owner,
      before: "if (Object.hasOwn(value, 'passed')) assert.equal(value.passed, true, `Failed task evidence: ${path}`)", after: '// Explicit evidence failure ignored' },
    { label: 'empty-source-mutations-accepted', file: owner,
      before: "nonempty(value.cases, 'Source mutation packet must have actual cases')", after: '// Empty mutation packet accepted' },
    { label: 'behavior-red-log-unbound', file: owner,
      before: "assert.match(entries.get(redPath).toString(), /AssertionError/, 'Assembly failure is not behavior RED')", after: '// Assembly failure accepted as RED' },
    { label: 'restored-green-empty-tests', file: owner,
      before: "assert.match(entries.get(greenPath).toString(), /Tests\\s+[1-9]\\d* passed/, 'Restored GREEN must execute nonempty tests')", after: '// Empty restored test collection accepted' },
    { label: 'old-source-mutation-subject-relabelled', file: owner,
      before: "assert.ok(consumed.currentSubjects > 0, 'Old mutations cannot sign a changed current subject')", after: '// Old mutation subject accepted' },
    { label: 'comment-only-caller-accepted', file: owner,
      before: "assert.ok(actualCaller((await read(caller.path)).toString(), caller, program), `Caller disappeared: ${caller.symbol}`)", after: '// Comment-only caller accepted' },
    { label: 'forced-quit-counted-as-restart', file: owner,
      before: "assert.equal(exit.signal, null, 'Forced termination is not ordinary restart')", after: '// Forced termination accepted' },
    { label: 'crashed-quit-counted-as-restart', file: owner,
      before: "assert.equal(exit.exitCode, 0, 'Require ordinary successful App quit')", after: '// Nonzero exit accepted' },
    { label: 'original-group-layout-lost', file: owner, before: source,
      after: source.replace("assert.deepEqual(restored, receipt.firstUi.restored, 'Original Group, split layout and work surface must survive')", '// Lost Group and split tree accepted').replace(restoredWorkbenchBinding, '// Secondary restored workbench association also omitted') },
    { label: 'original-session-projection-lost', file: owner,
      before: "assert.deepEqual(receipt.secondUi.sessions, receipt.firstUi.sessions, 'Original Session projection must survive')", after: '// Lost original Session projection accepted' },
    { label: 'native-scenario-incomplete', file: owner,
      before: "assert.equal(receipt[completionFields[name]].complete, true, 'Require actual scenario completion')", after: '// Incomplete actual scenario accepted' },
    { label: 'local-recovery-incomplete', file: owner,
      before: "assert.equal(receipt.localRecovery.complete, true, 'Require the actual local failure and retained facts')", after: '// Incomplete local failure accepted' },
    { label: 'missing-navigation-local-recovery', file: owner,
      before: "'local-recovery:locator', 'local-recovery:navigation'", after: "'local-recovery:locator'" },
    { label: 'failed-independent-review-overruled', file: owner,
      before: "assert.equal(record.approved, true, 'The preserved independent review must actually approve')", after: '// Manifest overrules preserved needs-change' },
    { label: 'old-independent-review-relabelled', file: owner,
      before: "assert.equal(association.length, 1, 'Manifest cannot relabel an old independent review')", after: "if (!association.length) association.push({ frames: review.frames })" },
    { label: 'unreviewed-pixels-invented', file: owner,
      before: "assert.deepEqual(association[0].frames, review.frames, 'Manifest cannot invent reviewed images')", after: '// Manifest invents reviewed frames' },
    { label: 'unrelated-renderer-frame-reviewed', file: owner,
      before: "assert.equal(frame.renderer.sha256, actual[0].sha256, 'Reviewed Renderer image belongs to another frame')", after: '// Wrong Renderer frame accepted' },
    { label: 'unrelated-native-frame-reviewed', file: owner,
      before: "assert.equal(frame.native.sha256, actual[0].nativePage.sha256, 'Reviewed Native image belongs to another frame')", after: '// Wrong Native frame accepted' },
    { label: 'missing-native-case-image-review', file: owner,
      before: 'for (const name of nativeCases) assert.ok(reviewedCases.has(name), `Missing independent image review: ${name}`)', after: '// Missing case review accepted' },
    { label: 'foreign-cost-candidate-accepted', file: owner,
      before: "assert.equal(value.candidateCommit, manifest.candidate.commit, 'Measurement belongs to another candidate')", after: '// Old measurement commit accepted' },
    { label: 'unrelated-delivery-ignored', file: collector,
      before: "nonempty(related.events, 'Require actual related public callback deliveries')\n  assert.ok(related.events.some(terminal), 'Require actual completed producer replay')", after: "// The complete related callback and completion block omitted" },
    { label: 'unrelated-collection-work-ignored', file: collector,
      before: "assert.deepEqual(value.producer.totals, summarizeBrowserOutcomeCollection(value.producer.recordedResult, value.producer.operation), 'Collection totals must derive from raw original facts')", after: "// Invented Native collection aggregate accepted" },
    { label: 'healthy-run-identity-replaced', file: owner, before: source,
      after: source.replace("assert.equal(status.session.run.runId, continuity.subject.runId, 'The original healthy Run identity must survive')", '// Session Run identity ignored')
        .replace("assert.equal(status.run.runId, continuity.subject.runId, 'The original healthy Run identity must survive')", '// Public Run identity ignored') },
    { label: 'healthy-work-surface-lost', file: owner, before: source,
      after: source.replace("assert.deepEqual(restored, original, 'Original work surface must survive cost observation')", '// Lost work surface accepted').replace(restoredWorkbenchBinding, '// Secondary restored workbench association also omitted') },
    { label: 'consumption-time-candidate-drift-ignored', file: owner, before: final, after: '// Late candidate source movement accepted' },
    { label: 'current-bytes-at-old-main-commit', file: owner,
      before: 'assert.equal(hash(await readCommit(candidate.commit, path)), candidate.identity[path], `Candidate source is not from its recorded main commit: ${path}`)', after: '// New source associated with old main commit' },
    { label: 'consumer-observation-count-invented', file: collector,
      before: "assert.deepEqual(report.samples.map(sample => `${sample.kind}:${sample.subjectId}`).sort(), subjects.sort(), 'Every actual mounted Tab and Session must be sampled')", after: "// Mounted Source subject omitted" },
    { label: 'measured-read-volume-invented', file: collector,
      before: "physicalPayloadBytes += chunk.readCost.payloadBytes", after: "physicalPayloadBytes += chunk.returnedBytes" }
]

const increment = [
  { label: 'native-passed-false-accepted', file: owner,
    before: "assert.equal(receipt.passed, true, 'Require the actual successful Native receipt')", after: '// Explicit Native failure accepted' },
  { label: 'native-failure-field-ignored', file: owner,
    before: "assert.equal(receipt.failure, null, 'Native failure must remain a failure')", after: '// Native failure detail ignored' },
  { label: 'native-cleanup-errors-ignored', file: owner,
    before: "assert.deepEqual(receipt.cleanup.errors, [], 'Native cleanup errors cannot pass')", after: '// Cleanup errors accepted' },
  { label: 'native-cleanup-processes-retained', file: owner,
    before: "assert.deepEqual(receipt.cleanup.remaining, [], 'Native processes must actually be reaped')", after: '// Retained private processes accepted' },
  { label: 'native-cleanup-root-not-removed', file: owner,
    before: "assert.equal(receipt.cleanup.temporaryRootRemoved, true, 'Native temporary root must actually be removed')", after: '// Temporary root retained' },
  { label: 'native-foreign-source-commit-accepted', file: owner,
    before: "assert.equal(receipt.sourceCommit, candidate.commit, 'Native belongs to another recorded candidate commit')", after: '// Foreign Native recorded commit accepted' },
  { label: 'native-missing-session-projections-accepted', file: owner,
    before: "assert.ok(Array.isArray(receipt.firstUi.sessions) && Array.isArray(receipt.secondUi.sessions), 'Require actual original Session projections, including an observed empty private projection')", after: '// Missing original Session projections accepted' },
  { label: 'native-incomplete-workbench-artifacts-accepted', file: owner, before: source,
    after: source.replace('assertPersistedWorkbench(receipt.firstUi.restored)\n  assertPersistedWorkbench(restored)', '// Both incomplete Native workbench artifacts accepted').replace(originalWorkbenchBinding, '// Secondary original association omitted').replace(restoredWorkbenchBinding, '// Secondary restored association omitted') },
  { label: 'cost-incomplete-workbench-artifacts-accepted', file: owner, before: source,
    after: source.replace('assertPersistedWorkbench(original)\n  assertPersistedWorkbench(restored)', '// Both incomplete cost workbench artifacts accepted').replace(originalWorkbenchBinding, '// Secondary original association omitted').replace(restoredWorkbenchBinding, '// Secondary restored association omitted') },
  { label: 'cost-fixed-observation-description-missing', file: collector,
      before: "assert.ok(typeof report.conditions.observation === 'string' && report.conditions.observation.trim(), 'Require actual fixed Source observation conditions')", after: "// Fixed actual Source observation description omitted" },
  { label: 'canonical-script-recorded-commit-skipped', file: owner,
    before: "path.includes('/src/') || path.includes('/scripts/')", after: "path.includes('/src/')" },
  { label: 'owning-join-candidate-inputs-omitted', file: owner,
    before: "for (const path of joinSources) assert.ok(candidate[path], 'Candidate must bind its owning proof join and canonical scripts')", after: '// Owning join and scripts omitted from candidate identity' },
  { label: 'invented-substring-mutation-schema-accepted', file: owner,
    before: 'if (!mutationSchemas.has(value.schema)) continue', after: "if (!String(value.schema).includes('source-mutation')) continue" },
  { label: 'actual-frame-sanitizer-packet-ignored', file: owner,
    before: "'agentmux.browser-frame-sanitizer-increment-mutations.v1',", after: '// Actual current frame sanitizer increment schema omitted' },
  mutations.find(item => item.label === 'healthy-run-identity-replaced'),
  { label: 'public-session-identity-replaced', file: owner, before: source,
    after: source.replace("assert.equal(status.session.agentSessionId, continuity.subject.agentSessionId, 'Public observation belongs to another Session')", '// Session identity ignored')
      .replace("assert.equal(status.run.agentSessionId, continuity.subject.agentSessionId, 'Public Run belongs to another Session')", '// Public Run owner ignored') },
  { label: 'public-process-unknown-accepted', file: owner,
    before: "assert.equal(status.observation.process, 'running', 'Public process observation must confirm running')", after: '// Unknown process observation accepted' },
  { label: 'public-process-replacement-accepted', file: owner,
    before: "assert.equal(after.run.pid, before.run.pid, 'A replacement process cannot sign original Run continuity')", after: '// A replacement process signs continuity' },
  { label: 'public-native-handle-replaced', file: owner,
    before: "if (before.session.nativeHandle) assert.deepEqual(after.session.nativeHandle, before.session.nativeHandle, 'Original Provider native handle must survive')", after: '// Provider native handle replacement ignored' },
  { label: 'public-session-workspace-replaced', file: owner,
    before: "for (const key of ['providerId', 'executorId', 'hostId', 'workspacePath', 'createdAt']) assert.equal(after.session[key], before.session[key], 'Original public Session identity must survive')", after: '// Public Session identity metadata replaced' },
  mutations.find(item => item.label === 'original-group-layout-lost'),
  mutations.find(item => item.label === 'healthy-work-surface-lost')
]
const continuity = [
  { label: 'fixed-observation-only-assumes-timer-delay', file: collector,
    before: 'while (Date.now() - bothOpenedAt < 100) {\n      await new Promise(done => setTimeout(done, 100 - (Date.now() - bothOpenedAt)))\n    }',
    after: 'await new Promise(done => setTimeout(done, 100))' },
  { label: 'public-healthy-run-relabeled-as-user-app-restart', file: owner,
    before: "assert.deepEqual(continuity.healthyRunBoundary, { kind: 'public-selected-original-agent-session' }, 'Public healthy Run continuity is separate from private Native restart')", after: '// Public healthy Run mislabeled as user App restart' },
  { label: 'private-workbench-boundary-relabeled-renderer-dto', file: owner,
    before: "assert.equal(continuity.workbenchBoundary.kind, 'private-native-ordinary-restart', 'Workbench continuity must name the actual private ordinary restart boundary')", after: '// Private ordinary restart boundary lost' },
  { label: 'foreign-native-receipt-signs-workbench-continuity', file: owner, before: source,
    after: source.replace("assert.ok(workbenchReceipt, 'Workbench continuity must bind an already validated actual Native receipt')", '// Foreign Native receipt association accepted').replace(originalWorkbenchBinding, '// Original Native receipt association ignored').replace(restoredWorkbenchBinding, '// Restored Native receipt association ignored') },
  { label: 'same-invented-workbench-signs-private-continuity', file: owner,
    before: originalWorkbenchBinding + '\n  ' + restoredWorkbenchBinding, after: '// Same invented before/after workbench accepted' }
]
const outcomeStart = source.indexOf('  const outcomes = [...nativeBySha.values()]'), outcomeEnd = source.indexOf('  const sourceMeasurements =', outcomeStart)
if (outcomeStart < 0 || outcomeEnd <= outcomeStart || !source.slice(outcomeStart, outcomeEnd).includes('original saved result bytes')) throw new Error('Native cost binding mutation must capture the complete actual source block')
const independent = [
  { label: 'actual-outcome-native-cost-binding-block-removed', file: owner,
    before: source.slice(outcomeStart, outcomeEnd), after: '// Detached Native costs can sign this candidate\n' },
  { label: 'prior-native-sibling-replay-not-completed', file: collector,
    before: "assert.ok(terminal(preparation.events.at(-1)), 'The actual prior replay must finish with the completed operation')", after: '// Incomplete actual prior replay accepted' },
  { label: 'prior-native-sibling-replay-starts-after-history', file: collector,
    before: "assert.equal(preparation.afterSequence, 0, 'Require the complete prior replay from its actual beginning')", after: '// A warm cursor mislabeled full replay' },
  { label: 'equal-missing-public-session-identities-accepted', file: owner,
    before: "for (const key of ['providerId', 'executorId', 'hostId', 'workspacePath']) assert.ok(typeof status.session[key] === 'string' && status.session[key].trim(), 'Require the actual original public Session identity fields')\n    assert.ok(Number.isSafeInteger(status.session.createdAt) && status.session.createdAt >= 0, 'Require the actual original public Session creation time')", after: '// Equal missing public identity fields accepted' },
  { label: 'fractional-native-process-identities-accepted', file: owner,
    before: 'Number.isSafeInteger(receipt.first.pid) && Number.isSafeInteger(receipt.second.pid) && ', after: '' },
  { label: 'local-caller-homonym-signs-cross-definition-binding', file: owner,
    before: "const inDefinition = symbol => resolved(symbol)?.declarations?.some(declaration => declaration.getSourceFile().fileName === '/' + caller.definition)", after: 'const inDefinition = symbol => Boolean(resolved(symbol)?.declarations?.length)' }
]
const callerScope = [{ label: 'compiled-candidate-bundles-treated-as-caller-source', file: owner,
  before: "path.includes('/src/') && /\\.[cm]?[jt]sx?$/.test(path)", after: "/\\.[cm]?[jt]sx?$/.test(path)" }]
const selected = process.argv.includes('--incremental-caller-source-scope') ? callerScope : process.argv.includes('--incremental-independent-6') ? independent : process.argv.includes('--incremental-continuity') ? continuity : process.argv.includes('--incremental-public-native') ? increment : [...new Map([...mutations, ...increment, ...continuity, ...independent, ...callerScope].map(item => [item.label, item])).values()]
await verifyRendererSourceMutations({
  name: `browser-task-capabilities-${process.argv.includes('--incremental-public-native') ? 'increment' : 'mutations'}-${randomUUID()}`,
  tests: ['apps/desktop/test/browser-task-capabilities-product.test.tsx', 'apps/desktop/test/browser-capability-cost-collector.test.ts', 'apps/desktop/test/browser-outcome-probe-scenario.test.ts'],
  sources: [owner, collector, wrapper, 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs', 'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs', 'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs'], mutations: selected
})
