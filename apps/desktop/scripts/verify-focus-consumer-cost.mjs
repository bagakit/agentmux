import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const argument = process.argv.indexOf('--evidence')
if (argument >= 0) assert.ok(process.argv[argument + 1], '--evidence requires a directory')
const evidenceRoot = argument < 0 ? join(root, '.tmp/focus-consumer-cost') : resolve(process.argv[argument + 1])
const name = 'focus-consumer-cost', evidence = join(evidenceRoot, name)
const config = 'apps/desktop/test/vitest.focus-consumer-cost.config.mts'
const tests = ['apps/desktop/test/focus-consumer-cost.test.tsx', 'apps/desktop/test/focus-collection-concurrent.test.tsx']
const regressions = ['apps/desktop/test/focus-group-heading-menu.test.tsx', 'apps/desktop/test/focus-collection-layout.test.tsx']
const hook = 'apps/desktop/src/renderer/src/lib/use-focus-collection-lanes.ts'
const placements = 'apps/desktop/src/renderer/src/lib/use-focus-context-placements.ts'
const heading = 'apps/desktop/src/renderer/src/components/FocusLaneHeadingMenu.tsx'
const sources = ['vitest.config.ts', 'vitest.setup.ts', 'test/fixture-values.mjs',
  config, 'apps/desktop/test/vitest.mote-context.config.mts', 'apps/desktop/test/vitest.focus-collection-concurrent.config.mts',
  'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
  'apps/desktop/test/helpers/spatial-control-owner-fixture.ts', 'apps/desktop/test/fixtures/mote-workface.ts',
  'apps/desktop/test/fixtures/focus-filter-menu.ts', 'apps/desktop/scripts/lib/fixture-values.mjs',
  'apps/desktop/scripts/verify-focus-consumer-cost.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
  ...regressions, hook, placements, heading,
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/lib/focus-collection-lanes.ts', 'apps/desktop/src/renderer/src/lib/focus-project-lanes.ts',
  'apps/desktop/src/renderer/src/lib/focus-context.ts', 'apps/desktop/src/renderer/src/lib/workbench-navigation-catalog.ts',
  'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/desktop/src/shared/space-addresses.ts',
  'apps/desktop/src/renderer/src/lib/scratch-topic-snapshots.ts', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/FocusProjectLanes.tsx',
  'apps/desktop/src/renderer/src/components/FocusScanLaneContent.tsx',
  'apps/desktop/src/renderer/src/components/FocusLaneGroups.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextCards.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx',
  'apps/desktop/src/renderer/src/components/AgentContextContent.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextRow.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextState.tsx',
  'apps/desktop/src/renderer/src/lib/session-recency.ts',
  'apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/components/AgentMenuContent.tsx',
  'apps/desktop/src/renderer/src/components/AgentMenuIdentityActions.tsx',
  'apps/desktop/src/renderer/src/components/settings/FocusSettingsPreview.tsx',
  'apps/desktop/src/renderer/src/components/TopicCategoryMenu.tsx',
  'apps/desktop/src/renderer/src/components/TopicCategoryDialog.tsx',
  'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx',
  'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx',
  'apps/desktop/src/renderer/src/components/SpaceDirectoryImage.tsx',
  'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx',
  'apps/desktop/src/renderer/src/components/WorkspaceRowContextMenu.tsx',
  'apps/desktop/src/renderer/src/components/WorkbenchMenuSubmenu.tsx',
  'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
  'apps/desktop/src/renderer/src/lib/clipboard-copy.ts',
  'apps/desktop/src/renderer/src/lib/space-object-appearance.ts',
  'apps/desktop/src/renderer/src/lib/topic-knowledge-actions.ts',
  'apps/desktop/src/main/scratch-topics.ts', 'apps/desktop/src/main/workspace-files.ts',
  'apps/host/src/topic-knowledge.ts', 'apps/host/src/topic-spatial-owner.ts',
  'packages/core/src/public-rpc-topics.ts', 'packages/core/src/spatial-state.ts']
const heldCommit = '    if (!pending) held.current = { index: visible && !hasTopics ? null : currentIndex, lanes }'
const commitEffect = `  useLayoutEffect(() => {\n    if (index) lastIndex.current = index\n    else if (visible && !hasTopics && !pending) lastIndex.current = null\n${heldCommit}\n  }, [index, visible, hasTopics, pending, currentIndex, lanes])`
const mutations = [
  { label: 'hidden-focus-rebuilds-complete-directory', file: hook,
    before: 'visible && hasTopics ? createFocusCollectionIndex(catalog, content)',
    after: 'hasTopics ? createFocusCollectionIndex(catalog, content)' },
  { label: 'closed-heading-eagerly-scans-categories', file: heading,
    before: '<CollectionHeadingMenuItems lane={lane} collapsed={collapsed} onToggle={onToggle} onChangeIcon={onChangeIcon} onRename={onRename} changeIcon={menu.changeIcon} />',
    after: '{CollectionHeadingMenuItems({ lane, collapsed, onToggle, onChangeIcon, onRename, changeIcon: menu.changeIcon })}' },
  { label: 'related-directory-change-keeps-stale-index', file: hook,
    before: '[visible, hasTopics, catalog, content])', after: '[visible, hasTopics])' },
  { label: 'abandoned-render-overwrites-committed-membership', file: hook,
    before: commitEffect,
    after: commitEffect.replace(`${heldCommit}\n`, '') + `\n${heldCommit}` },
  { label: 'held-context-borrows-current-lane-identity', file: hook,
    before: 'let source = original ?? lane', after: 'let source = lane' },
  { label: 'held-topic-merge-copies-accumulated-prefixes', file: hook,
    before: 'if (projected.collection) entry.topics.push(...projected.collection.topics)',
    after: 'if (projected.collection) entry.topics = [...entry.topics, ...projected.collection.topics]' },
  { label: 'current-bucket-remounts-active-agent-editor', file: placements,
    before: 'const bucket = previous && previous !== context.bucket && interacting.has(id) ? previous : context.bucket',
    after: 'const bucket = context.bucket' }
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [...new Set([...tests, ...sources, config])]
const sourceBefore = Object.fromEntries(await Promise.all(inputs.map(async file => {
  const bytes = await readFile(join(root, file)); assert.ok(bytes.length > 0, `Nonempty owning input: ${file}`)
  return [file, digest(bytes)]
})))
let mutationPath = join(evidence, 'receipt.json')
const reused = Boolean(process.env.AGENTMUX_MUTATION_RECEIPTS)
if (reused) {
  const paths = JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS)
  assert.ok(Array.isArray(paths) && paths.length > 0)
  const matching = []
  for (const path of paths) {
    const saved = JSON.parse(await readFile(resolve(path), 'utf8'))
    if (saved.name === name && JSON.stringify(saved.cases?.map(({ label, file, before, after }) => ({ label, file, before, after }))) === JSON.stringify(mutations)) matching.push(resolve(path))
  }
  assert.equal(matching.length, 1, 'Supply exactly one actual Focus cost mutation receipt')
  mutationPath = matching[0]
} else {
  await mkdir(evidence, { recursive: true })
  // These adjacent regressions run once against the candidate, not for every mutant.
  const result = await new Promise((yes, no) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', ...regressions, '--config', config, '--maxWorkers=1'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(join(evidence, 'regression-green.log'), result.output)
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
}
await verifyRendererSourceMutations({ name, evidenceRoot, owningConfig: config, tests, sources, mutations })
const directory = dirname(mutationPath)
const receiptBytes = await readFile(mutationPath), receipt = JSON.parse(receiptBytes)
assert.equal(receipt.passed, true); assert.deepEqual(receipt.sourceBefore, sourceBefore)
assert.deepEqual(receipt.sourceAfter, sourceBefore); assert.deepEqual(receipt.copyAfter, sourceBefore)
assert.deepEqual(receipt.cases.map(({ label, file, before, after }) => ({ label, file, before, after })), mutations)
assert.equal(receipt.cleanup.copyRemoved, true)
const regressionBytes = await readFile(join(directory, 'regression-green.log')), regressionLog = regressionBytes.toString()
for (const [file, count] of [['focus-group-heading-menu.test.tsx', 15], ['focus-collection-layout.test.tsx', 14]]) {
  assert.ok(regressionLog.includes(`${file} (${count} tests)`), `Actual adjacent regression: ${file}`)
}
assert.match(regressionLog, /Tests\s+29 passed \(29\)/); assert.doesNotMatch(regressionLog, /Tests\s+[1-9]\d* failed/)
const baselineBytes = await readFile(join(directory, 'baseline-green.log')), baseline = baselineBytes.toString()
assert.ok(baseline.includes('focus-consumer-cost.test.tsx (27 tests)'))
assert.ok(baseline.includes('focus-collection-concurrent.test.tsx (1 test)'))
assert.match(baseline, /Tests\s+28 passed \(28\)/); assert.doesNotMatch(baseline, /Tests\s+[1-9]\d* failed/)
const observations = baseline.split('\n').filter(line => line.startsWith('FOCUS_COST ')).map(line => JSON.parse(line.slice('FOCUS_COST '.length)))
const fields = ['renders', 'derive', 'index', 'project', 'zones', 'spaces', 'bindings', 'categories', 'bindingEntries', 'cachedIndexEntries', 'indexLookups', 'menuCategories', 'categoryFindCalls', 'categoryComparisons']
const fullReads = row => ['zones', 'spaces', 'bindings', 'categories', 'bindingEntries', 'cachedIndexEntries'].reduce((sum, key) => sum + row.counts[key], 0)
for (const row of observations) for (const field of fields) assert.ok(Number.isSafeInteger(row.counts[field]) && row.counts[field] >= 0, `Actual nonnegative count: ${field}`)
const phases = { 'initial-index': 3, hidden: 9, 'closed-menus': 3, 'visible-unrelated': 12, 'warm-visible-render': 3,
  'initial-hidden': 3, reveal: 3, 'no-topic': 3, 'related-membership': 1, 'opened-menu': 1 }
assert.equal(observations.length, Object.values(phases).reduce((sum, count) => sum + count, 0))
for (const [phase, count] of Object.entries(phases)) {
  const rows = observations.filter(row => row.phase === phase); assert.equal(rows.length, count, `Nonempty complete phase: ${phase}`)
  assert.deepEqual([...new Set(rows.map(row => row.noise))].sort((a, b) => a - b), count >= 3 ? [0, 100, 1000] : [100])
  for (const row of rows) {
    if (['hidden', 'visible-unrelated', 'warm-visible-render', 'initial-hidden', 'no-topic'].includes(phase)) { assert.equal(fullReads(row), 0); assert.equal(row.counts.index, 0) }
    if (['initial-index', 'reveal', 'related-membership'].includes(phase)) { assert.ok(fullReads(row) > 0); assert.ok(row.counts.index > 0); assert.ok(row.counts.renders > 0) }
    if (phase === 'warm-visible-render') { assert.ok(row.counts.renders > 0); assert.ok(row.counts.project > 0); assert.ok(row.counts.indexLookups > 0) }
    if (['initial-hidden', 'no-topic'].includes(phase)) assert.ok(row.counts.renders > 0)
    if (phase === 'closed-menus') assert.equal(row.counts.categoryComparisons, 0)
    if (phase === 'opened-menu') { assert.ok(row.counts.categoryComparisons > 0); assert.ok(row.counts.categoryFindCalls > 0) }
  }
}
for (const noise of [0, 100, 1000]) {
  assert.deepEqual(observations.filter(row => row.phase === 'hidden' && row.noise === noise).map(row => row.update).sort(), [0, 1, 2])
  for (const id of ['outside-terminal', 'outside-board']) assert.deepEqual(observations.filter(row => row.phase === 'visible-unrelated' && row.noise === noise && row.id === id).map(row => row.update).sort(), [0, 1])
}
const heldObservations = baseline.split('\n').filter(line => line.startsWith('FOCUS_HELD_COST ')).map(line => JSON.parse(line.slice('FOCUS_HELD_COST '.length)))
assert.deepEqual(heldObservations.map(row => row.width).sort((a, b) => a - b), [8, 32, 128])
for (const row of heldObservations) { assert.ok(Number.isSafeInteger(row.topicEntries) && row.topicEntries > 0); assert.ok(row.topicEntries <= row.width * 24) }
const sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, digest(await readFile(join(root, file)))])))
assert.deepEqual(sourceAfter, sourceBefore, 'The observed candidate must remain the same throughout validation')
const mutationArtifacts = []
for (const item of receipt.cases) for (const file of [item.log, item.restore.log, `${item.label}-red-loaded.json`, `${item.label}-restore-green-loaded.json`]) {
  const bytes = await readFile(join(directory, file)); assert.ok(bytes.length > 0)
  mutationArtifacts.push({ file, sha256: digest(bytes) })
}
const summary = { schema: 'agentmux.focus-consumer-cost.v1', passed: true,
  mutationReceipt: { file: 'receipt.json', sha256: digest(receiptBytes) },
  logs: [{ file: 'baseline-green.log', sha256: digest(baselineBytes) }, { file: 'regression-green.log', sha256: digest(regressionBytes) }],
  sourceBefore, sourceAfter, mutationArtifacts, consumerTests: 27, concurrentTests: 1, adjacentRegressionTests: 29, actualSourceMutants: mutations.length,
  observations, heldObservations, aggregationDirectoryReads: { fields: ['zones', 'spaces', 'bindings', 'categories', 'bindingEntries', 'cachedIndexEntries'],
    lookups: 'indexLookups counts direct original Map.get/has calls separately; iteration of the cached Maps is included in full traversal counts.' },
  heldTopicIteration: 'Original Array iterator entry steps for exact participating Context IDs, observed only during the related held update; original computation and DOM remain in place.',
  categoryComparisonObservations: { fields: ['menuCategories', 'categoryFindCalls', 'categoryComparisons'],
    scope: 'Actual original Category array access across the consumer, including upstream spatial catalog construction. Closed-menu local folding isolates heading work; other phases are not exclusively menu cost.' },
  boundaries: ['Actual GlobalFocusSurface and shared heading/menu owners; adjacent RecentFocusTimeline and SessionPane painting are excluded.',
    'Operation counts and actual DOM/control preservation, not elapsed-time or whole-application performance claims.',
    'Upstream spatial catalog Category comparisons are reported separately and are not erased by a zero Focus aggregation traversal count.',
    'No Provider process, user Runtime control, installation, new visual review or restart recovery is performed by this verifier.'],
  sharedTreeMutations: 0, runtimeControl: [], cleanup: receipt.cleanup }
if (reused) assert.deepEqual(JSON.parse(await readFile(join(directory, 'consumer-cost-receipt.json'), 'utf8')), summary)
else await writeFile(join(directory, 'consumer-cost-receipt.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify({ passed: true, exactEvidenceReused: reused, actualSourceMutants: mutations.length,
  consumerTests: 27, concurrentTests: 1, adjacentRegressionTests: 29, observations: observations.length,
  receipt: join(directory, 'consumer-cost-receipt.json') }))
