import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const config = 'apps/desktop/scripts/fixtures/focus-project-history/vitest.observation-service.config.mts'
const product = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts']
const paths = [...product, config, 'apps/desktop/test/focus-native-observation-service.test.tsx', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.observation-service.json']
const output = resolve(root, `.tmp/focus-observation-service-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const binding = () => Object.fromEntries(paths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const receipt = { schema: 'agentmux.focus-observation-service-qualification.v1', passed: false, sourcePass: false, visualPass: false, taskDone: false, before: binding(), stages: [], boundary: 'Real private FileStore/public reader/observer and mounted Global Focus; light compiled Timeline service presentation. No healthy Runtime, Writer, ordinary restart or installation qualification.' }
const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function run(label, mutation, selection, command) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_OBSERVATION_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_OBSERVATION_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_OBSERVATION_MUTATION = mutation
  const args = command ?? [process.execPath, '--max-old-space-size=768', 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', ...(selection ? ['-t', selection] : []), '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, mutation: mutation ?? null, error: result.error?.message }
  receipt.stages.push(stage); save()
  if (command) assert.equal(result.status, 0, `${label}: actual failure is retained`)
  else {
    const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults), actual = assertions.filter(item => item.status !== 'pending' && item.status !== 'skipped')
    assert.ok(actual.length > 0, 'Actual literal collection must be nonempty')
    const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(modules.length > 0)
    const owner = modules.find(item => item.path === product[0]); assert.ok(owner)
    assert.equal(owner.originalSHA256, receipt.before[product[0]])
    Object.assign(stage, { actualTests: actual.length, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), owner })
    if (mutation) {
      assert.notEqual(result.status, 0)
      const failures = actual.filter(item => item.status === 'failed'); assert.ok(failures.length > 0)
      assert.ok(failures.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Preparation errors are not semantic RED')
      assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
    } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(owner.sha256, owner.originalSHA256) }
  }
  save()
}
try {
  run('baseline')
  for (const [mutation, selection] of [['drop-service', 'unsupported observer|actual source burst'], ['clear-without-refill', 'real frozen window refills'], ['hidden-observation', 'collapsed Focus']]) {
    run(mutation, mutation, selection); run(`${mutation}-exact-restore`, undefined, selection)
  }
  run('production-types', undefined, undefined, [process.execPath, '--max-old-space-size=768', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  run('owning-types', undefined, undefined, [process.execPath, '--max-old-space-size=768', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-project-history/tsconfig.observation-service.json'])
  const callers = { RecentFocusTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline '], useSessionUserMessages: [product[0], 'const latest = useSessionUserMessages(control, { enabled })'], FocusMessageReaderService: [product[0], 'serviceNotice: inputObservationNotice, windowFrozen: !historical && latest.windowFrozen'] }
  receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, needle]]) => {
    const source = readFileSync(resolve(root, file), 'utf8'), index = source.indexOf(needle); assert.ok(index >= 0, `${symbol}: nonempty actual product caller outside definition owner`)
    return [symbol, { file, line: source.slice(0, index).split('\n').length, needle }]
  }))
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.sourcePass = true; save()
  if (!process.argv.includes('--source-only')) {
    const sceneFile = resolve(root, process.env.AGENTMUX_FOCUS_OBSERVATION_SCENE_RECEIPT ?? '.tmp/focus-observation-service-visual/receipt.json')
    const reviewFile = resolve(root, process.env.AGENTMUX_FOCUS_OBSERVATION_VISUAL_REVIEW ?? resolve(dirname(sceneFile), 'visual-review.json'))
    const sceneBytes = readFileSync(sceneFile), reviewBytes = readFileSync(reviewFile), scene = JSON.parse(sceneBytes), review = JSON.parse(reviewBytes)
    assert.equal(scene.schema, 'agentmux.focus-observation-service-scene.v1'); assert.equal(scene.passed, true)
    for (const file of product) assert.equal(scene.inputs[file], receipt.before[file])
    assert.equal(scene.actual.pending.sameBody, true); assert.equal(scene.actual.pending.sameRange, true)
    assert.deepEqual(scene.actual.controls, []); assert.equal(scene.cleanup.privateRootRemoved, true)
    assert.equal(scene.images.length, 4); assert.ok(scene.images.some(frame => frame.width === 640)); assert.ok(scene.images.some(frame => frame.width === 1000))
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.trim().length > 0); assert.equal(review.sceneReceiptSHA256, hash(sceneBytes))
    for (const image of scene.images) { assert.equal(hash(readFileSync(resolve(dirname(sceneFile), image.path))), image.sha256); assert.ok(review.viewedImages.some(item => item.path === image.path && item.sha256 === image.sha256 && item.observation?.trim().length > 0)) }
    receipt.scene = { file: relative(root, sceneFile), sha256: hash(sceneBytes), images: scene.images, compiled: scene.compiled }
    receipt.visualReview = { file: relative(root, reviewFile), sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }; receipt.visualPass = true
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { save(); console.log(JSON.stringify({ passed: receipt.passed, sourcePass: receipt.sourcePass, visualPass: receipt.visualPass, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
