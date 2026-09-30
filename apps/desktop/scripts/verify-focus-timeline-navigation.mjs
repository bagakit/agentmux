import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, `.tmp/focus-timeline-navigation-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-time-window.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/test/focus-timeline-navigation.test.tsx', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/vitest.owning.config.mts']
const binding = () => Object.fromEntries(sourcePaths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const receipt = { schema: 'agentmux.focus-timeline-navigation-qualification.v1', passed: false, sourcePass: false, taskDone: false, before: binding(), stages: [], output: relative(root, output), boundary: 'Mounted production Timeline, public private FileStore/Reader and compiled presentation. No Runtime, ordinary App restart, installation or healthy-user Run qualification.' }
const config = 'apps/desktop/scripts/fixtures/focus-timeline-navigation/vitest.owning.config.mts'
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_NAVIGATION_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_NAVIGATION_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_NAVIGATION_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }
  receipt.stages.push(stage)
  if (!command) {
    const tests = JSON.parse(readFileSync(report)), modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const assertions = tests.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(item => item.status === 'failed')
    assert.ok(assertions.length > 0); assert.ok(modules.length > 0)
    const ownerPath = mutation === 'old-four-levels' ? sourcePaths[1] : sourcePaths[0]
    const owner = modules.find(item => item.path === ownerPath); assert.ok(owner); assert.equal(owner.originalSHA256, receipt.before[ownerPath])
    Object.assign(stage, { tests: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedOwner: owner })
    if (mutation) {
      assert.notEqual(result.status, 0); assert.ok(failed.length > 0)
      assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Every semantic failure must be an actually loaded assertion, not setup or timeout')
      assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
    } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(owner.sha256, owner.originalSHA256) }
  } else assert.equal(result.status, 0, `${label} failed; original output is retained`)
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`${label}: actual exit ${result.status}`)
  return stage
}
try {
  const baseline = run('baseline')
  for (const mutation of ['wheel-disconnected', 'blank-wheel-disconnected', 'zoom-disconnected', 'viewport-reread', 'old-four-levels']) {
    assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
    assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
  }
  run('original-T005', [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts', '--maxWorkers=1'])
  run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/tsconfig.owning.json'])
  const callers = { focusWheelTimeDelta: [sourcePaths[0], 'focusWheelTimeDelta(event, width,'], RecentFocusTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline '], wheel: [sourcePaths[0], "viewport.addEventListener('wheel', wheel"], zoom: [sourcePaths[0], 'onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}'] }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, needle]]) => { const source = readFileSync(resolve(root, file), 'utf8'), index = source.indexOf(needle); assert.ok(index >= 0, `${symbol} non-definition product caller`); return [symbol, { file, line: source.slice(0, index).split('\n').length, needle }] }))
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.sourcePass = true
  if (!process.argv.includes('--source-only')) {
    const accepted = '.tmp/focus-timeline-read-coverage-scene-recipient-proof-final'
    const scenePath = process.env.AGENTMUX_FOCUS_NAVIGATION_SCENE_RECEIPT ?? `${accepted}/receipt.json`, reviewPath = process.env.AGENTMUX_FOCUS_NAVIGATION_VISUAL_REVIEW ?? `${accepted}/visual-review.json`
    const sceneFile = resolve(root, scenePath), reviewFile = resolve(root, reviewPath), sceneBytes = readFileSync(sceneFile), reviewBytes = readFileSync(reviewFile)
    const scene = JSON.parse(sceneBytes), review = JSON.parse(reviewBytes)
    assert.equal(scene.schema, 'agentmux.focus-timeline-read-coverage-scene.v1'); assert.equal(scene.passed, true)
    for (const file of sourcePaths.slice(0, 4)) assert.equal(scene.inputs[file], receipt.before[file])
    assert.deepEqual(scene.actual.controls, []); assert.equal(scene.cleanup.privateRootRemoved, true); assert.ok(scene.images.length >= 2)
    const cost = scene.actual.cost200, blank = scene.actual.blankPan
    assert.equal(cost.actualActions, 200); assert.equal(cost.pointerOrKeyboardRunControls, 0)
    assert.deepEqual(Object.keys(cost.before.counts).sort(), ['catalog', 'page', 'projector', 'timeline'])
    for (const count of Object.values(cost.before.counts)) assert.ok(Number.isInteger(count) && count > 0)
    assert.deepEqual(cost.after.counts, cost.before.counts); assert.deepEqual(cost.before.controls, []); assert.deepEqual(cost.after.controls, [])
    assert.ok(cost.before.draft.length > 0); assert.equal(cost.after.draft, cost.before.draft)
    assert.equal(scene.actual.pinAfter.sameNode, true); assert.ok(scene.actual.pinBefore.selection.length > 0); assert.equal(scene.actual.pinAfter.selection, scene.actual.pinBefore.selection)
    assert.ok(blank.before.tracks.length > 0); assert.deepEqual(blank.blankStart.tracks, [])
    assert.ok(blank.pointer.x >= blank.actualHit.time.left && blank.pointer.x <= blank.actualHit.time.right)
    assert.ok(blank.pointer.nameX < blank.actualHit.time.left)
    assert.ok(['recent-focus__viewport', 'recent-focus__canvas', 'recent-focus__tracks', 'recent-focus__empty'].includes(blank.actualHit.className))
    assert.deepEqual(blank.wheelEvents.map(event => event.prevented), [true, true, true, true, false])
    assert.ok(blank.sameDirection.start < blank.blankStart.start); assert.ok(blank.reverse.start > blank.sameDirection.start); assert.ok(blank.shift.start < blank.reverse.start)
    assert.equal(blank.blankIdentity.start, blank.shift.start)
    for (const state of [blank.blankStart, blank.sameDirection, blank.reverse, blank.shift, blank.blankIdentity]) {
      assert.deepEqual(state.counts, blank.before.counts); assert.deepEqual(state.controls, []); assert.equal(state.draft, blank.before.draft)
    }
    assert.ok(scene.images.some(image => image.width === 320)); assert.ok(scene.images.some(image => image.width >= 1100))
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.length > 0); assert.equal(review.sceneReceiptSHA256, hash(sceneBytes))
    for (const image of scene.images) { assert.equal(hash(readFileSync(resolve(dirname(sceneFile), image.path))), image.sha256); assert.ok(review.viewedImages.some(item => item.path === image.path && item.sha256 === image.sha256 && item.observation?.trim().length > 0)) }
    receipt.scene = { file: scenePath, sha256: hash(sceneBytes), compiled: scene.compiled, images: scene.images }; receipt.visualReview = { file: reviewPath, sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }; receipt.taskDone = true
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ sourcePass: receipt.sourcePass, passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
