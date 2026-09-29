import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
assert.equal(process.argv[2], '--proof')
assert.equal(process.argv.length, 4)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = value => typeof value === 'string' ? value : value.sha256
async function bytes(path) {
  assert.equal(typeof path, 'string')
  const file = resolve(root, path), local = relative(root, file)
  assert.ok(local && local !== '..' && !local.startsWith('../') && !isAbsolute(local), `proof must stay in repository: ${path}`)
  return readFile(file)
}
async function bound(ref) {
  assert.ok(ref?.path && /^[a-f0-9]{64}$/u.test(ref.sha256), 'missing SHA-bound evidence')
  const value = await bytes(ref.path)
  assert.equal(digest(value), ref.sha256, ref.path)
  if (ref.bytes !== undefined) assert.equal(value.length, ref.bytes, ref.path)
  return value
}
const json = async ref => JSON.parse(await bound(ref))
async function report(ref, count, green) {
  const result = await json(ref)
  assert.equal(result.numTotalTests, count, ref.path)
  const tests = result.testResults.flatMap(file => file.assertionResults)
  assert.equal(tests.length, count, 'collected assertions must be nonempty and exact')
  assert.equal(tests.filter(test => test.status === 'passed').length, result.numPassedTests)
  const failed = tests.filter(test => test.status === 'failed')
  assert.equal(failed.length, result.numFailedTests)
  if (green) {
    assert.equal(result.success, true)
    assert.equal(result.numPassedTests, count)
    assert.equal(result.numFailedTests, 0)
  } else {
    assert.equal(result.success, false)
    assert.ok(failed.length > 0, 'semantic mutation did not fail')
    for (const test of failed) assert.ok(test.failureMessages.some(message => message.includes('AssertionError')), `not semantic AssertionRED: ${test.fullName}`)
  }
  return result
}
async function rows(ref) {
  const text = (await bound(ref)).toString().trim()
  assert.ok(text, 'actual loaded input cannot be empty')
  const result = text.split('\n').map(line => JSON.parse(line))
  assert.ok(result.length > 0)
  return result
}
function sameSource(source, expected) {
  assert.ok(Object.keys(source).length > 0, 'source snapshot must be nonempty')
  for (const [path, value] of Object.entries(expected)) assert.equal(identity(source[path] ?? ''), identity(value), path)
}
const proof = JSON.parse(await bytes(process.argv[3]))
assert.equal(proof.schema, 'agentmux.conversation-system-context-qualification.v1')
assert.equal(proof.featureId, 'f-2gu8f35yd')
assert.equal(proof.taskId, 'T-003')
assert.equal(proof.originalAppRuntimeRunControls, 0)
for (const [path, value] of Object.entries(proof.currentSource)) assert.equal(digest(await bytes(path)), identity(value), `current source differs: ${path}`)

const core = proof.core, coreReceipt = await json(core.receipt), coreSource = await json(core.source)
assert.equal(coreReceipt.schema, 'agentmux.core-system-context-qualification.v1')
assert.equal(coreReceipt.candidateCommit, core.commit)
assert.equal(coreSource.paths.length, 11, 'five Core sources plus six consumer/owning test inputs')
for (const entry of coreSource.paths) assert.equal(identity(proof.currentSource[entry.path]), entry.sha256, entry.path)
const integration = await json(core.integration)
assert.equal(integration.commit, core.commit)
assert.deepEqual([...integration.changedPaths].sort(), coreSource.paths.map(entry => entry.path).sort())
for (const entry of integration.ownBinding) assert.equal(entry.committedSha256, entry.workingSha256, entry.path)
await report(core.owning.report, 14, true)
await bound(core.owning.log)
await report(core.adjacent.report, 112, true)
await bound(core.adjacent.log)
const mutationReceipt = await json(core.mutationReceipt)
assert.equal(mutationReceipt.receipts.length, 6)
assert.deepEqual(core.mutations.map(pair => pair.name).sort(), ['missing-system-record', 'system-attributed-to-user', 'system-is-agent-activity'])
for (const pair of core.mutations) {
  for (const [mode, green] of [['mutant', false], ['restore', true]]) {
    const run = mutationReceipt.receipts.find(entry => entry.name === pair.name && entry.mode === mode)
    assert.ok(run?.qualified)
    assert.equal(run.cwd, root)
    assert.ok(run.argv.includes('--reporter=json'))
    assert.equal(run.exit, green ? 0 : 1)
    assert.equal(run.total, 14)
    assert.equal(run.sourceBefore, identity(proof.currentSource[pair.target]))
    assert.equal(run.sourceAfter, run.sourceBefore)
    assert.equal(run.sourceSha, pair[mode].source.sha256)
    const loaded = await rows(pair[mode].loaded)
    assert.equal(loaded.length, 1, 'one exact Core Source loader target required')
    assert.equal(loaded[0].moduleId.split('?')[0], resolve(root, pair.target))
    assert.ok(loaded[0].bytes > 0)
    await bound(pair[mode].source)
    assert.equal(pair[mode].report.sha256, run.reportSha)
    assert.equal(pair[mode].log.sha256, run.logSha)
    await report(pair[mode].report, 14, green)
    await bound(pair[mode].log)
  }
  assert.notEqual(pair.mutant.source.sha256, pair.restore.source.sha256)
  assert.equal(pair.restore.source.sha256, identity(proof.currentSource[pair.target]))
}
const coreTypes = await json(core.types.receipt)
assert.equal(coreTypes.length, 2)
for (const entry of coreTypes) {
  assert.equal(entry.exitCode, 0)
  assert.ok(entry.argv.includes('--noEmit'))
  assert.ok(entry.argv.includes('--incremental') && entry.argv.includes('--composite'))
  const ref = core.types.logs[entry.name]
  assert.equal(ref.sha256, entry.logSha256)
  const log = await bound(ref)
  assert.equal(log.length, entry.logBytes) // Successful type commands may have empty stdout.
}
const callers = await json(core.callers)
assert.ok(callers.entries.length > 0)
for (const entry of callers.entries) {
  assert.ok(entry.hits.length > 0, entry.symbol)
  for (const hit of entry.hits) {
    assert.notEqual(hit.path, entry.excludedDefinition)
    assert.ok(!hit.path.includes('/test/'))
    const source = (await bytes(hit.path)).toString()
    assert.ok(source.includes(hit.text), `${entry.symbol}: actual non-definition caller missing`)
  }
}
console.log('Core system context: 14 owning / 112 adjacent; three loaded semantic RED and exact restores verified.')
assert.equal(proof.status, 'complete', `qualification incomplete: ${(proof.missing ?? []).join('; ')}`)
assert.deepEqual(proof.missing, [])

const ui = proof.ui
async function command(ref, expectedExit) {
  const run = await json(ref)
  assert.equal(run.exit, expectedExit)
  assert.ok(isAbsolute(run.cwd) && run.argv.length > 1, 'actual argv/cwd required')
  assert.deepEqual(run.sourceBefore, run.sourceAfter, 'source changed during actual command')
  sameSource(run.sourceBefore, ui.source)
  await bound({ path: run.log, sha256: run.logSHA256 })
  return run
}
const requiredUI = ['components/ActivityView.tsx', 'components/ConversationMessage.tsx', 'components/ConversationSpeakerAvatar.tsx', 'lib/conversation-speaker.ts']
async function loadedUI(ref, mutation) {
  const inputs = await rows(ref)
  for (const suffix of requiredUI) {
    const path = `apps/desktop/src/renderer/src/${suffix}`, matches = inputs.filter(input => input.path === path)
    assert.equal(matches.length, 1, path)
    assert.equal(matches[0].originalSHA256, identity(ui.source[path]), path)
  }
  const changed = inputs.filter(input => input.mutation !== undefined)
  if (mutation) {
    assert.equal(changed.length, 1, 'one actual loaded UI mutation required')
    assert.equal(changed[0].mutation, mutation)
    assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
  } else assert.deepEqual(changed, [])
}
sameSource(proof.currentSource, ui.source)
await report(ui.owning.report, 4, true)
await loadedUI(ui.owning.loaded)
await bound(ui.owning.log)
const summary = await json(ui.mutationSummary)
assert.equal(summary.length, 3)
assert.deepEqual(ui.mutations.map(pair => pair.name).sort(), ['system-folded-content', 'system-skip-kind', 'system-speaker-human'])
for (const pair of ui.mutations) {
  const result = summary.find(entry => entry.mutation === pair.name)
  assert.ok(result)
  assert.equal(result.exit, 1)
  assert.equal(result.total, 4)
  const red = await report(pair.red.report, 4, false)
  assert.equal(result.failed, red.numFailedTests)
  assert.equal(result.assertionErrors, red.numFailedTests)
  await loadedUI(pair.red.loaded, pair.name)
  await bound(pair.red.log)
}
// The three UI mutations changed loader output only, never physical source. One final
// unmutated loaded run restores every actual input; do not claim three physical restores.
const restored = await command(ui.exactRestore.command, 0)
assert.equal(restored.env.AGENTMUX_SYSTEM_CONTEXT_MUTATION, undefined)
await report(ui.exactRestore.report, 4, true)
await loadedUI(ui.exactRestore.loaded)
assert.equal(ui.types.length, 2, 'production and owning UI type receipts required')
for (const ref of ui.types) await command(ref, 0)
const visual = await json(proof.visual.manifest), review = await json(proof.visual.independentReview)
assert.equal(visual.passed, true)
assert.equal(visual.originalAppRuntimeRunControls, 0)
sameSource(visual.source, ui.source)
sameSource(proof.currentSource, visual.source)
const actualJs = await rows(proof.visual.actualLoadedJs)
for (const [path, value] of Object.entries(visual.source).filter(([path]) => /\.[jt]sx?$/u.test(path))) {
  const matches = actualJs.filter(input => input.path === path && input.sha256 === identity(value))
  assert.ok(matches.length > 0, `actual Vite input missing: ${path}`)
  for (const input of matches) await bound(input.retainedInput)
}
const styles = await json(visual.actualStyles)
assert.ok(styles.length > 0, 'actual browser-injected styles must be nonempty')
assert.equal(visual.actualStyles.ownRawCSSIncluded, true)
for (const [path] of Object.entries(ui.source).filter(([path]) => path.endsWith('.css'))) {
  const css = (await bytes(path)).toString()
  assert.ok(css.trim().length > 0)
  assert.ok(styles.some(style => style.text.includes(css)), `raw CSS absent from actual injected styles: ${path}`)
}
assert.equal(visual.scenes.length, 4, 'wide/narrow System open/closed scenes required')
assert.ok(visual.scenes.some(scene => scene.actualCSSWidth === 332))
assert.ok(visual.scenes.some(scene => scene.actualCSSWidth > 800))
assert.equal(review.status, 'pass')
assert.equal(review.source_review.status, 'pass')
assert.equal(review.visual_review.status, 'pass')
assert.deepEqual(review.source_review.open_p0_p1, [])
assert.deepEqual(review.visual_review.open_p0_p1, [])
sameSource(review.source, visual.source)
assert.equal(review.visual_manifest.sha256, proof.visual.manifest.sha256)
assert.equal(review.actual_styles.sha256, visual.actualStyles.sha256)
const reviewedImages = review.visual_review.actually_opened
assert.equal(reviewedImages.length, 4, 'all four scenes need actual independent image review')
for (const image of reviewedImages) assert.equal(image.actually_opened, 'view_image original')
const reviewedLoaded = await rows(proof.visual.reviewedLoaded)
assert.equal(proof.visual.reviewedLoaded.sha256, review.actual_loaded.sha256)
assert.equal(reviewedLoaded.length, review.actual_loaded.nonempty_record_count)
const fixtures = Object.keys(visual.source).filter(path => path.includes('/scripts/fixtures/') && path.endsWith('/entry.tsx'))
assert.equal(fixtures.length, 1, 'one actual scene fixture input required')
const fixture = (await bytes(fixtures[0])).toString()
assert.ok(fixture.length > 0)
let originalCopy
for (const scene of visual.scenes) {
  await bound(scene.image)
  assert.ok(reviewedImages.some(image => image.sha256 === scene.image.sha256 && image.actualCSSWidth === scene.actualCSSWidth), 'scene absent from independent visual review')
  assert.ok(review.reviewed_operations.some(operation => operation.sha256 === scene.operation.sha256 && operation.user_app_runtime_run_controls === 0 && operation.whole_original_guide_copied_exactly_once === true && operation.original_draft_kept === true), 'actual operation absent from finite review')
  const operation = await json(scene.operation)
  assert.equal(operation.width, scene.actualCSSWidth)
  assert.deepEqual(operation.controls, [])
  assert.equal(operation.draft, visual.originalDraft)
  assert.equal(operation.copies.length, 1, 'actual exact-copy observation must be nonempty')
  assert.ok(operation.copies[0].length > 0)
  originalCopy ??= operation.copies[0]
  assert.equal(operation.copies[0], originalCopy, 'the same original System record must be copied at either width')
  const literal = operation.copies[0].replace(/\\/gu, '\\\\').replace(/'/gu, "\\'").replace(/\n/gu, '\\n').replace(/\r/gu, '\\r')
  assert.ok(fixture.includes(`content: '${literal}'`), 'copy must equal the actual declared scene record, including markdown/newlines')
  if (scene.actualCSSWidth === 332) {
    assert.equal(operation.expanded, 'false')
    assert.ok(operation.active.includes('class="log-turn__system-toggle"'))
  } else assert.equal(operation.expanded, 'true')
}
assert.equal(visual.actualKeyboard.length, 2)
assert.equal(visual.actualCopy, 'one whole original guide string')
console.log(JSON.stringify({ result: 'PASS', coreOwning: 14, coreAdjacent: 112, coreMutations: 3, uiOwning: 4, uiMutations: 3, boundary: 'Captured System Core facts and current shared chat/compiled UI; no native mixed-history author inference, installation or full Terminal qualification' }))
