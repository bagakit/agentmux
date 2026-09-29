import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.env.AGENTMUX_FOCUS_ORDER_OUTPUT ?? resolve(root, `.tmp/focus-timeline-order-qualification-${Date.now()}`))
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const renderer = 'apps/desktop/src/renderer/src/'
const paths = [
  `${renderer}lib/focus-history-timeline.ts`, `${renderer}components/RecentFocusTimeline.tsx`,
  `${renderer}components/FocusMessagePreview.tsx`, `${renderer}lib/focus-time-window.ts`,
  `${renderer}lib/conversation-speaker.ts`, `${renderer}components/ConversationMessage.tsx`,
  `${renderer}store.ts`, `${renderer}styles/focus.css`, `${renderer}styles/focus-timeline-ruler.css`,
  'apps/desktop/package.json', 'packages/core/package.json', 'pnpm-lock.yaml',
  'apps/desktop/test/focus-timeline-order-stability.test.tsx',
  'apps/desktop/scripts/fixtures/focus-timeline-order/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/focus-timeline-order/tsconfig.owning.json',
  'apps/desktop/scripts/verify-focus-timeline-order.mjs'
]
const binding = () => Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))]))
const option = process.argv.indexOf('--slice'), slice = option < 0 ? 'source-visual' : process.argv[option + 1]
assert.ok(['source', 'source-visual'].includes(slice), 'Use --slice source or source-visual')
const receipt = { schema: 'agentmux.focus-timeline-order-qualification.v1', passed: false, sourcePass: false,
  taskDone: false, slice, sourceRoot: root, before: binding(), stages: [],
  boundary: 'Mounted production Timeline and public Provider Reader/private FileStore. Compiled scenes use isolated typed presentation I/O. No Core/full-App build, Runtime, user App/Run operation, packaging, restart or installation qualification. Tracker completion belongs to its owning gate.' }
const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_ORDER_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_ORDER_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_ORDER_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
    'apps/desktop/scripts/fixtures/focus-timeline-order/vitest.owning.config.mts', '--maxWorkers=1',
    '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }
  receipt.stages.push(stage); save()
  if (command) assert.equal(result.status, 0, `${label} failed; original output is retained`)
  else {
    const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults)
    assert.ok(assertions.length > 0, `${label}: actual nonempty assertions are required`)
    const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const relevant = modules.filter(item => Object.hasOwn(receipt.before, item.path))
    assert.ok(relevant.length > 0, `${label}: actual loaded product Source is required`)
    for (const item of relevant) assert.equal(item.originalSHA256, receipt.before[item.path], `Source changed during qualification: ${item.path}`)
    Object.assign(stage, { tests: assertions.length, passed: tests.numPassedTests, failed: tests.numFailedTests,
      reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)) })
    if (mutation) {
      const changed = relevant.filter(item => item.mutation === mutation && item.sha256 !== item.originalSHA256)
      const failed = assertions.filter(item => item.status === 'failed')
      assert.notEqual(result.status, 0); assert.ok(changed.length > 0, 'The semantic mutant must actually load')
      assert.ok(failed.length > 0, 'The semantic mutant must fail product assertions')
      for (const item of failed) assert.ok(item.failureMessages.some(message => message.includes('AssertionError')), 'Preparation/compilation errors are not semantic RED')
      stage.loadedMutants = changed; stage.assertionFailures = failed.map(item => item.fullName)
    } else {
      assert.equal(result.status, 0); assert.equal(tests.success, true)
      for (const item of relevant) assert.equal(item.sha256, item.originalSHA256)
    }
  }
  save(); console.log(`${label}: actual exit ${result.status}`)
  return stage
}
function artifact(environment) {
  const path = process.env[environment]
  assert.ok(path, `${environment}: an actual exact-input receipt is required`)
  const absolute = resolve(root, path), bytes = readFileSync(absolute)
  return { path: absolute, sha256: hash(bytes), value: JSON.parse(bytes) }
}
try {
  const baseline = run('baseline')
  for (const mutation of ['window-order', 'name-order', 'activity-reorder']) {
    assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
    assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
  }
  run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-timeline-order/tsconfig.owning.json'])
  const calls = {
    timeline: [`${renderer}components/GlobalFocusSurface.tsx`, '<RecentFocusTimeline '],
    candidates: [paths[1], 'focusTimelineOrderCandidates(contexts,'],
    entryRank: [paths[1], 'createFocusTimelineOrder(orderCandidates)'],
    preserveRank: [paths[1], 'extendFocusTimelineOrder(before, orderCandidates)'],
    orderedRows: [paths[1], 'orderFocusTimelineProjects(']
  }
  receipt.callers = Object.fromEntries(Object.entries(calls).map(([symbol, [path, needle]]) => {
    const source = readFileSync(resolve(root, path), 'utf8'), index = source.indexOf(needle)
    assert.ok(index >= 0, `${symbol}: a nondefinition product caller is required`)
    return [symbol, { path, needle, line: source.slice(0, index).split('\n').length }]
  }))
  receipt.sourcePass = true; save()
  if (slice === 'source-visual') {
    const scene = artifact('AGENTMUX_FOCUS_ORDER_SCENE_RECEIPT'), review = artifact('AGENTMUX_FOCUS_ORDER_VISUAL_REVIEW')
    assert.equal(scene.value.passed, true); assert.ok(scene.value.images.length >= 4)
    for (const path of paths.slice(0, 9)) assert.equal(scene.value.inputs[path], receipt.before[path], `Current scene input required: ${path}`)
    assert.equal(review.value.verdict, 'pass'); assert.ok(review.value.reviewerAgentId?.length > 0)
    assert.equal(review.value.sceneReceiptSHA256, scene.sha256)
    for (const image of scene.value.images) {
      const imagePath = resolve(dirname(scene.path), image.path)
      assert.equal(hash(readFileSync(imagePath)), image.sha256)
      assert.ok(review.value.viewedImages.some(viewed => viewed.sha256 === image.sha256 && viewed.observation?.trim().length > 0))
    }
    receipt.scene = scene; receipt.visualReview = review
  }
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  save(); console.log(JSON.stringify({ passed: receipt.passed, sourcePass: receipt.sourcePass, taskDone: false, receipt: relative(root, resolve(output, 'receipt.json')) }))
}
