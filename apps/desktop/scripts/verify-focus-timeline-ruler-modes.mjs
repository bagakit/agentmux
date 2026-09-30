import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, `.tmp/focus-timeline-ruler-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const renderer = 'apps/desktop/src/renderer/src/'
const paths = [
  `${renderer}lib/focus-timeline-ruler.ts`,
  `${renderer}components/RecentFocusTimeline.tsx`,
  `${renderer}components/FocusMessagePreview.tsx`,
  `${renderer}components/FocusTimelineRulerSettings.tsx`,
  `${renderer}components/ConversationMessage.tsx`,
  `${renderer}store.ts`, `${renderer}styles/focus-timeline-ruler.css`,
  'apps/desktop/package.json', 'pnpm-lock.yaml',
  'apps/desktop/test/focus-timeline-ruler-modes.test.tsx',
  'apps/desktop/scripts/fixtures/focus-timeline-ruler/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/focus-timeline-ruler/tsconfig.owning.json'
]
const binding = () => Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))]))
const option = process.argv.indexOf('--slice')
const slice = option < 0 ? 'axis' : process.argv[option + 1]
assert.ok(['source', 'axis', 'join'].includes(slice), 'Use --slice source, axis or join')
if (slice === 'join') {
  await import('./verify-focus-timeline-join.mjs')
} else {
const receipt = {
  schema: 'agentmux.focus-timeline-ruler-qualification.v1', passed: false, sourcePass: false,
  taskDone: false, slice, before: binding(), stages: [],
  boundary: 'Real mounted Global/Timeline, public reader and private FileStore; no user Runtime/App/Run operations or packaging. Source qualification alone does not qualify compiled geometry, production build, restart or installation.'
}
const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`)
  const loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_RULER_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_RULER_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_RULER_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run',
    '--config', 'apps/desktop/scripts/fixtures/focus-timeline-ruler/vitest.owning.config.mts',
    '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }
  receipt.stages.push(stage); save()
  if (command) assert.equal(result.status, 0, `${label} failed; original output is retained`)
  else {
    const tests = JSON.parse(readFileSync(report))
    const assertions = tests.testResults.flatMap(file => file.assertionResults)
    const failed = assertions.filter(item => item.status === 'failed')
    assert.ok(assertions.length > 0, `${label}: no collected assertions; preparation errors are not semantic RED`)
    const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(modules.length > 0, `${label}: no actual loaded Source`)
    const relevant = modules.filter(item => Object.hasOwn(receipt.before, item.path))
    assert.ok(relevant.length > 0)
    for (const item of relevant) assert.equal(item.originalSHA256, receipt.before[item.path], `Source changed during qualification: ${item.path}`)
    const changed = relevant.filter(item => item.mutation === mutation && item.sha256 !== item.originalSHA256)
    Object.assign(stage, { tests: assertions.length, passed: tests.numPassedTests, failed: tests.numFailedTests,
      reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedMutants: changed })
    if (mutation) {
      assert.notEqual(result.status, 0)
      assert.ok(changed.length > 0, `${mutation}: product mutation was not actually loaded`)
      assert.ok(failed.length > 0, `${mutation}: no failed product assertions`)
      for (const item of failed) assert.ok(item.failureMessages.some(message => message.includes('AssertionError')), 'Compilation/setup errors do not qualify as RED')
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
  const bytes = readFileSync(resolve(root, path))
  return { path, sha256: hash(bytes), value: JSON.parse(bytes) }
}
try {
  const baseline = run('baseline')
  for (const mutation of ['aligned-publication', 'zone-fixed-offset', 'viewport-phase-reset', 'preview-zone-gap', 'date-zone-ignored', 'preference-not-persisted', 'system-zone-snapshot']) {
    assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
    assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
  }
  run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
  run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-timeline-ruler/tsconfig.owning.json'])
  const calls = {
    timeline: [`${renderer}components/GlobalFocusSurface.tsx`, '<RecentFocusTimeline '],
    ticks: [paths[1], 'focusRulerTicks('],
    settings: [paths[1], '<FocusTimelineRulerSettings '],
    previewTime: [paths[1], 'timeFormatters={time}'],
    commonTime: [paths[2], 'timeFormatter={time.clock}'],
    durablePreferences: [paths[1], 'setFocusTimelineRuler']
  }
  receipt.callers = Object.fromEntries(Object.entries(calls).map(([symbol, [path, needle]]) => {
    const source = readFileSync(resolve(root, path), 'utf8'), index = source.indexOf(needle)
    assert.ok(index >= 0, `${symbol}: product caller missing outside its definition`)
    return [symbol, { path, needle, line: source.slice(0, index).split('\n').length }]
  }))
  receipt.sourcePass = true; save()
  if (slice !== 'source') {
    const build = artifact('AGENTMUX_FOCUS_RULER_BUILD_RECEIPT')
    const scene = artifact('AGENTMUX_FOCUS_RULER_SCENE_RECEIPT')
    const review = artifact('AGENTMUX_FOCUS_RULER_VISUAL_REVIEW')
    assert.equal(build.value.passed, true)
    assert.ok(build.value.command?.includes('electron-vite'), 'Normal production build must be identifiable')
    for (const path of paths.slice(0, 9)) assert.equal(build.value.inputs[path], receipt.before[path])
    assert.equal(scene.value.passed, true); assert.ok(scene.value.images.length >= 2)
    for (const path of paths.slice(0, 7)) assert.equal(scene.value.inputs[path], receipt.before[path])
    assert.equal(review.value.verdict, 'pass'); assert.ok(review.value.reviewerAgentId?.length > 0)
    assert.equal(review.value.sceneReceiptSHA256, scene.sha256)
    for (const image of scene.value.images) {
      const imagePath = resolve(dirname(resolve(root, scene.path)), image.path)
      assert.equal(hash(readFileSync(imagePath)), image.sha256)
      assert.ok(review.value.viewedImages.some(viewed => viewed.sha256 === image.sha256 && viewed.observation?.trim().length > 0))
    }
    receipt.build = build; receipt.scene = scene; receipt.visualReview = review

  }
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  save(); console.log(JSON.stringify({ passed: receipt.passed, sourcePass: receipt.sourcePass, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) }))
}

}
