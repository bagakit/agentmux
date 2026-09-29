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
    const owner = modules.find(item => item.path === sourcePaths[0]); assert.ok(owner); assert.equal(owner.originalSHA256, receipt.before[sourcePaths[0]])
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
  for (const mutation of ['wheel-disconnected', 'zoom-disconnected', 'viewport-reread']) {
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
    const accepted = 'docs/reviews/evidence/focus-timeline-navigation-2026-10-03/accepted/scene-final'
    const scenePath = process.env.AGENTMUX_FOCUS_NAVIGATION_SCENE_RECEIPT ?? `${accepted}/receipt.json`, reviewPath = process.env.AGENTMUX_FOCUS_NAVIGATION_VISUAL_REVIEW ?? `${accepted}/visual-review.json`
    const sceneFile = resolve(root, scenePath), reviewFile = resolve(root, reviewPath), sceneBytes = readFileSync(sceneFile), reviewBytes = readFileSync(reviewFile)
    const scene = JSON.parse(sceneBytes), review = JSON.parse(reviewBytes)
    assert.equal(scene.schema, 'agentmux.focus-timeline-navigation-scene-delivery.v1'); assert.equal(scene.passed, true)
    for (const file of sourcePaths.slice(0, 4)) assert.equal(scene.inputs[file], receipt.before[file])
    assert.deepEqual(scene.actual.controls, []); assert.equal(scene.cleanup.privateRootRemoved, true); assert.ok(scene.images.length >= 2)
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.length > 0); assert.equal(review.sceneReceiptSHA256, hash(sceneBytes))
    for (const image of scene.images) { assert.equal(hash(readFileSync(resolve(dirname(sceneFile), image.path))), image.sha256); assert.ok(review.viewedImages.some(item => item.path === image.path && item.sha256 === image.sha256 && item.observation?.trim().length > 0)) }
    receipt.scene = { file: scenePath, sha256: hash(sceneBytes), compiled: scene.compiled, images: scene.images }; receipt.visualReview = { file: reviewPath, sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }; receipt.taskDone = true
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ sourcePass: receipt.sourcePass, passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
