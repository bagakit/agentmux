import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// This task-local verifier only reads original evidence. It never runs a producer or signs installation.
const root = resolve(import.meta.dirname, '../../..'), directory = '.artifacts/browser-clean-capture'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const mainOwners = ['apps/desktop/src/main/browser-control-feedback.ts', 'apps/desktop/src/main/browser-operation-feedback.ts',
  'apps/desktop/src/main/browser-feedback-presentation.ts', 'apps/desktop/src/main/browser-view-manager.ts']
const optionOwners = ['packages/browser/src/browser-screenshot-options.ts', 'packages/browser/src/browser-page-dispatch.ts',
  'packages/browser/src/browser-program-owner.ts', 'packages/browser/src/browser-selection-script.ts', 'packages/browser/src/model/page.ts',
  'packages/core/src/browser-capture-cli.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/browser-page-capability.ts']
const tests = ['apps/desktop/test/browser-feedback-presentation.test.ts', 'apps/desktop/test/browser-screenshot-source.test.ts',
  'apps/desktop/test/browser-screenshot-options.test.ts', 'packages/core/test/browser-capture-cli.test.ts']
const sharedTest = 'apps/desktop/test/browser-shared-owner-capture.test.ts'
const producerFiles = ['apps/desktop/scripts/verify-browser-clean-capture-native.mjs',
  ...['main.ts', 'page.html', 'frame.html', 'scenario.md'].map(file => 'apps/desktop/scripts/fixtures/browser-clean-capture/' + file)]
const unitOwners = ['packages/browser/src/browser-screenshot-options.ts', 'packages/browser/src/model/page.ts',
  'packages/core/src/browser-capture-cli.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/browser-page-capability.ts', ...tests.slice(2)]
const mainMutants = ['visible-owned-display', 'skip-top-restore', 'parent-tree-hijacks-oopif', 'expired-cue-blocks-healthy-capture',
  'skip-main-clean-owner', 'missing-frame-observation-budget', 'drop-pending-primer-resource-read']
const sourceMutants = ['discard-options', 'lose-output', 'wrong-density', 'wrong-coordinates', 'truncate-float-bounds', 'skip-retained-result', 'drop-shared-options']
const result = { passed: false, sourceQualified: false, nativeQualified: false, installedQualified: false,
  boundary: 'T001 exact Source/public CLI and private Electron/BVM page PNG. Shared external ProgramOwner runs its original Source/worker/dispatch with controlled native transport; external host overlays remain unconfirmed. No installed Desktop, user page, Provider/Run, OS compositor or hardware-focus qualification.' }
async function ref(value) {
  assert.ok(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256), 'An immutable path/sha256 reference is required')
  const bytes = await readFile(resolve(root, value.path)); assert.equal(sha(bytes), value.sha256, 'Evidence bytes: ' + value.path)
  return bytes
}
const json = async value => JSON.parse((await ref(value)).toString())
async function graph(value) {
  const lines = (await ref(value)).toString().trim().split('\n').filter(Boolean)
  assert.ok(lines.length > 0, 'An actual nonempty loaded-source graph is required')
  return lines.map(line => JSON.parse(line))
}
const original = row => row.source ?? row.original
const assertions = report => report.testResults.flatMap(test => test.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
function loadedOwners(rows, sources, files) {
  for (const file of files) assert.ok(rows.some(row => row.file === file && original(row) === sources[file] && row.loaded === sources[file] && !row.mutated), 'Actual original consumer loaded: ' + file)
}
async function normal(run, sources, files, expected = run.expectedPassed ?? run.passed) {
  assert.ok(Number.isInteger(expected) && expected > 0, 'The normal/restored expected assertion count is required')
  if (run.exitCode !== undefined) assert.equal(run.exitCode, 0)
  const report = await json(run.report), cases = assertions(report)
  assert.equal(report.numFailedTests, 0); assert.equal(report.numPassedTests, expected)
  assert.equal(cases.length, expected); assert.ok(cases.every(test => test.status === 'passed'))
  if (run.log) await ref(run.log)
  loadedOwners(await graph(run.loaded), sources, files)
  return cases.length
}
async function mutation(run, sources, file = run.file, exit = run.exitCode) {
  assert.equal(exit, 1, 'A real failed process exit is required: ' + run.name)
  assert.ok(typeof file === 'string' && sources[file], 'An exact original mutated owner is required')
  if (run.report) {
    const report = await json(run.report), cases = assertions(report)
    assert.ok(cases.length > 0 && report.numFailedTests > 0 && cases.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'Original business assertion red: ' + run.name)
  } else {
    const log = (await ref(run.log)).toString()
    assert.ok(log.includes('AssertionError:') && /\bFAIL\s+[^\n]+ > /u.test(log) && /[1-9]\d* failed/u.test(log), 'Original nonempty failed business case, not import/setup failure: ' + run.name)
  }
  if (run.log) await ref(run.log)
  const loaded = await graph(run.loaded)
  assert.ok(loaded.some(row => row.file === file && original(row) === sources[file] && row.loaded !== original(row) && row.mutated === true), 'Actual Source mutation loaded: ' + run.name)
}
const sourceMap = rows => Array.isArray(rows) ? Object.fromEntries(rows.map(row => [row.file ?? row.path, row.sha256])) : rows
async function currentSources(sources, required) {
  assert.ok(sources && Object.keys(sources).length > 0)
  for (const file of required) assert.match(sources[file] ?? '', /^[a-f0-9]{64}$/u, 'Expected Source owner: ' + file)
  for (const [file, expected] of Object.entries(sources)) assert.equal(sha(await readFile(resolve(root, file))), expected, 'Current Source: ' + file)
}
try {
  assert.equal(process.argv.length, 2, 'Run without arguments; evidence producers are never invoked')
  const indexPath = directory + '/capture-evidence.json', indexBytes = await readFile(resolve(root, indexPath)), evidence = JSON.parse(indexBytes)
  assert.equal(evidence.schema, 'agentmux.browser-clean-capture.evidence.v1')
  const sources = evidence.sources
  await currentSources(sources, [...mainOwners, ...optionOwners, ...tests, sharedTest])
  const normalCount = await normal(evidence.source.normal, sources, unitOwners)
  const restoredCount = await normal(evidence.source.restored, sources, unitOwners)
  assert.equal(restoredCount, normalCount)
  assert.ok(Array.isArray(evidence.source.mutations))
  assert.deepEqual(evidence.source.mutations.map(run => run.name).sort(), [...sourceMutants].sort(), 'All required Source mutations, exactly once')
  for (const file of ['packages/core/src/browser-capture-cli.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/browser/src/browser-screenshot-options.ts'])
    assert.ok(evidence.source.mutations.some(run => run.file === file), 'Each options/alias/output owner has a bearing mutation: ' + file)
  for (const run of evidence.source.mutations) await mutation(run, sources)
  const sharedOwners = ['packages/browser/src/browser-program-owner.ts', sharedTest, 'packages/browser/src/browser-page-dispatch.ts', 'packages/browser/src/browser-screenshot-options.ts', 'packages/native-desktop/src/image.ts']
  await normal(evidence.source.shared.normal, sources, sharedOwners, 1)
  await normal(evidence.source.shared.restored, sources, sharedOwners, 1)

  const main = await json(evidence.mainEvidence)
  assert.equal(main.schema, 'agentmux.browser-clean-capture.main-source-evidence.v1'); assert.equal(main.sourceQualified, true)
  const mainSources = sourceMap(main.sources), mainFiles = [...mainOwners, ...tests.slice(0, 2)]
  await currentSources(mainSources, mainFiles)
  for (const file of mainFiles) assert.equal(mainSources[file], sources[file])
  const previousManifest = await json(main.previousManifest), currentManifest = await json(main.currentManifest), delta = await json(main.livenessDelta)
  const previous = Object.fromEntries(previousManifest.files.map(file => [file.path, file.afterSHA256]))
  const current = Object.fromEntries(currentManifest.files.map(file => [file.path, file.afterSHA256]))
  assert.deepEqual(delta.previousManifest, main.previousManifest)
  for (const file of mainFiles) {
    assert.equal(current[file], mainSources[file])
    if (previous[file] !== current[file]) assert.ok(delta.deltas.some(row => row.file === file && row.beforeSHA256 === previous[file] && row.afterSHA256 === current[file]), 'The original normal-to-current delta is explicit: ' + file)
  }
  for (const name of ['originalFull', 'originalRestored', 'boundedDelta', 'boundedRestored']) {
    const run = main.normal[name], bound = name.startsWith('original') ? previous : current
    assert.ok(run && Array.isArray(run.sourceBinding) && run.sourceBinding.length === mainFiles.length)
    for (const file of mainFiles) assert.ok(run.sourceBinding.some(row => row.file === file && row.sha256 === bound[file] && row.observed > 0))
    await normal(run, bound, mainFiles)
  }
  assert.deepEqual(main.mutations.map(run => run.name), mainMutants)
  const runs = (await Promise.all(main.mutantIndices.map(json))).flat()
  assert.equal(runs.length, mainMutants.length)
  for (const [index, run] of main.mutations.entries()) {
    const originalRun = runs.find(row => row.name === run.name)
    assert.equal(originalRun?.exit, 1); assert.equal(originalRun.bearing, true)
    assert.equal(originalRun.report, run.report.path); assert.equal(originalRun.loaded, run.loaded.path)
    await mutation(run, index < 5 ? previous : current, run.definition.file, originalRun.exit)
  }
  await ref(main.verificationHarness)

  const native = await json(evidence.native)
  assert.equal(native.schema, 'agentmux.browser-clean-capture.native.v1'); assert.equal(native.scope, 'full-native-slice')
  assert.equal(native.passed, true); assert.equal(native.prepared, true); assert.deepEqual(native.drift, [])
  assert.equal(native.process.exitCode, 0); assert.equal(native.process.exitConfirmed, true); assert.equal(native.process.timedOut, false)
  assert.deepEqual(native.cleanup.remaining, []); assert.equal(native.cleanup.removed, true)
  // The Desktop Native path consumes BVM. The external owner is qualified by its
  // separate actual worker/dispatch consumer above, not claimed as an embedded native owner.
  for (const file of [...mainOwners, ...optionOwners.filter(file => file !== 'packages/browser/src/browser-program-owner.ts')]) {
    assert.equal(native.source[file], sources[file], 'Final Native consumes current Source: ' + file)
    assert.ok(native.loaded.some(row => row.file === file && row.sourceSHA256 === sources[file] && row.transformed === false))
  }
  for (const file of producerFiles) assert.equal(sha(await readFile(resolve(root, file))), native.source[file], 'Current Native producer: ' + file)
  const actual = await json(native.actual)
  assert.equal(actual.schema, 'agentmux.browser-clean-capture.native-process.v1'); assert.equal(actual.scope, 'full-native-slice'); assert.equal(actual.passed, true)
  assert.equal(actual.pid, native.process.originalPid); assert.ok(Number.isInteger(actual.pid) && actual.pid > 0)
  assert.ok(Array.isArray(actual.cases) && actual.cases.length > 0 && Array.isArray(actual.frames) && actual.frames.length > 0)
  assert.deepEqual(native.frames, actual.frames)
  const labels = ['native-primer-failure-restores-owned-feedback', 'native-failure-restores-owned-feedback',
    'overlapping-captures-keep-feedback-hidden-until-last', 'navigation-during-native-capture-retains-later-document',
    'actual-public-out-of-bounds', 'original-trusted-element-selection-presentation-excluded', 'http-cli-hd-original-artifact']
  for (const protocol of ['http', 'file']) for (const action of ['public-iframe-cue', 'public-region', 'public-hd', 'clip-calibration-pixels', 'hd-calibration-pixels', 'cli-calibration-pixels', 'entire-actual-visual-viewport', 'immediate-original-human-takeover-readonly', 'clean-native-and-public-cli']) labels.push(protocol + '-' + action)
  for (const label of labels) assert.equal(actual.cases.filter(row => row.label === label).length, 1, 'Full Native case: ' + label)
  for (const frame of actual.frames) {
    const bytes = await readFile(resolve(root, frame.path))
    assert.equal(sha(bytes), frame.sha256); assert.equal(bytes.length, frame.bytes)
    assert.ok(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
    assert.deepEqual({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }, frame.dimensions)
    assert.ok(frame.dimensions.width > 0 && frame.dimensions.height > 0)
  }

  const mainReview = await json(evidence.sourceReview.main), optionsReview = await json(evidence.sourceReview.options)
  assert.equal(mainReview.accepted, true); assert.deepEqual(mainReview.mustFix, [])
  assert.equal(optionsReview.sourceReviewAccepted, true); assert.equal(optionsReview.codeReviewVerdict, 'accepted'); assert.deepEqual(optionsReview.mustFix, [])
  const mainReviewed = sourceMap(mainReview.sources), optionsReviewed = sourceMap(optionsReview.sources)
  await currentSources(mainReviewed, mainOwners); await currentSources(optionsReviewed, optionOwners.filter(file => file !== 'packages/browser/src/browser-selection-script.ts'))
  const sharedReview = await json(evidence.sourceReview.shared)
  assert.equal(sharedReview.status, 'accepted'); assert.equal(sharedReview.sourceReviewAccepted, true)
  assert.equal(sharedReview.sharedOwnerSourceQualified, true); assert.equal(sharedReview.externalNativePixelsQualified, false); assert.deepEqual(sharedReview.mustFix, [])
  await currentSources(sourceMap(sharedReview.sources), sharedOwners)
  const visual = await json(evidence.visualReview)
  assert.equal(visual.status, 'accepted'); assert.equal(visual.taskComplete, true); assert.deepEqual(visual.mustFix, [])
  assert.deepEqual(visual.receipt, evidence.native)
  assert.ok(typeof visual.reviewer === 'string' && visual.reviewer.length > 0 && Array.isArray(visual.frames) && visual.frames.length > 0)
  assert.equal(visual.frames.length, actual.frames.length, 'Every final PNG has an independent actual-view receipt')
  assert.equal(new Set(visual.frames.map(frame => frame.path)).size, actual.frames.length)
  await currentSources(sourceMap(visual.sources), ['apps/desktop/src/main/browser-view-manager.ts', 'packages/browser/src/browser-screenshot-options.ts'])
  for (const frame of visual.frames) assert.ok(frame.actuallyViewed === true && actual.frames.some(actual => actual.path === frame.path && actual.sha256 === frame.sha256), 'Independent review actually saw this original final PNG')

  const discovery = await json(evidence.discovery)
  assert.equal(discovery.passed, true); assert.equal(discovery.cleanup.completed, true)
  assert.deepEqual(discovery.runs.map(run => run.args), [['browser', 'capture', '--help'], ['browser', 'run', '--help'], ['browser', '--skill']])
  for (const run of discovery.runs) { assert.equal(run.exitCode, 0); await ref(run.output) }
  await currentSources(discovery.sources, ['packages/core/guides/actions/browser-run.md', 'packages/core/guides/modules/browser.md', 'packages/core/src/generated/agentmux-guides.ts'])
  for (const file of ['packages/core/src/agentmux.ts', 'packages/core/src/browser-capture-cli.ts', 'packages/core/src/agentmux-cli-commands.ts'])
    assert.equal(discovery.cli.inputs[file], sources[file], 'Current Source CLI discovery: ' + file)

  const types = await json(evidence.types.report), baseline = await json(evidence.types.baselineBinding)
  assert.ok(Array.isArray(types.ownedFiles) && Array.isArray(types.owned) && Array.isArray(types.all) && Array.isArray(types.loaded) && types.loaded.length > 0)
  for (const file of [...mainOwners, ...optionOwners, ...tests, sharedTest]) assert.ok(types.ownedFiles.includes(file) && types.loaded.some(row => row.file === file && row.sha256 === sources[file]), 'Actual current typed root: ' + file)
  assert.ok(Array.isArray(baseline.rows)); assert.match(baseline.baseHead, /^[a-f0-9]{40}$/u)
  const currentText = await readFile(resolve(root, baseline.file), 'utf8')
  const baseText = execFileSync('git', ['show', `${baseline.baseHead}:${baseline.file}`], { cwd: root, encoding: 'utf8' })
  assert.equal(sha(currentText), baseline.currentFileSHA256); assert.equal(sha(baseText), baseline.baseFileSHA256)
  const signature = row => JSON.stringify({ file: row.file, code: row.code, line: row.line, message: row.message })
  assert.deepEqual(types.owned.map(signature).sort(), baseline.rows.map(signature).sort(), 'Every remaining diagnostic is exactly bound to its unchanged original line')
  for (const row of baseline.rows) {
    assert.equal(row.file, baseline.file)
    const currentLine = currentText.split('\n')[row.line - 1], originalLine = baseText.split('\n')[row.originalLine - 1]
    assert.equal(typeof currentLine, 'string'); assert.equal(typeof originalLine, 'string')
    assert.equal(sha(currentLine), row.lineSHA256); assert.equal(sha(originalLine), row.lineSHA256)
  }
  Object.assign(result, { passed: true, sourceQualified: true, nativeQualified: true,
    evidence: { path: indexPath, sha256: sha(indexBytes) }, normal: normalCount, restored: restoredCount, sourceMutations: sourceMutants.length, mainMutations: mainMutants.length,
    sharedProgram: { normal: 1, restored: 1, nativeTransport: 'controlled' },
    actualNativeCases: actual.cases.length, pngs: actual.frames.length, reviewedPNGs: visual.frames.length, inheritedDiagnostics: baseline.rows.length, introducedDiagnostics: 0 })
} catch (error) { result.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
const output = resolve(root, directory + '/capture-qualification.json')
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ passed: result.passed, sourceQualified: result.sourceQualified, nativeQualified: result.nativeQualified, installedQualified: false, receipt: output, failure: result.failure?.message }))
