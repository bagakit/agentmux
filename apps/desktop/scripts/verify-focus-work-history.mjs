import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(process.argv.length === 3 && ['--source', '--consume'].includes(mode), 'Use --source or --consume')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = 'apps/desktop/scripts/fixtures/focus-work-history/'
const timeline = 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
const product = [timeline, 'apps/desktop/src/renderer/src/lib/focus-work-history.ts',
  'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/styles/focus.css']
const files = [...product, 'apps/desktop/test/focus-work-history.test.tsx',
  'apps/desktop/test/fixtures/focus-history-public.tsx', 'apps/desktop/test/fixtures/focus-work-history-public-inputs.json',
  fixture + 'vitest.owning.config.mts', fixture + 'vitest.adjacent.config.mts', fixture + 'vitest.running.config.mts', fixture + 'tsconfig.owning.json',
  fixture + 'entry.mjs', fixture + 'main.cjs', fixture + 'preload.cjs', fixture + 'capture.mjs',
  'apps/desktop/test/focus-running-timeline.test.tsx', 'apps/desktop/test/focus-retired-history-renderer.test.tsx', 'apps/desktop/test/focus-timeline-read-coverage.test.tsx',
  'packages/core/package.json', 'packages/core/src/session-timeline.ts', 'packages/core/src/types.ts',
  'packages/core/dist/session-timeline.js', 'packages/core/dist/session-timeline.d.ts',
  'apps/desktop/scripts/verify-focus-work-history.mjs']
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async file => {
  const bytes = await readFile(join(root, file)); assert.ok(bytes.length, 'Nonempty actual input ' + file); return [file, hash(bytes)]
})))
const resolvedTimeline = await realpath(fileURLToPath(import.meta.resolve('@agentmux/core/timeline')))
assert.equal(resolvedTimeline, await realpath(join(root, 'packages/core/dist/session-timeline.js')), 'Same proof tree public pure Core module')
if (mode === '--consume') {
  const scenePath = process.env.AGENTMUX_FOCUS_WORK_SCENE_RECEIPT, reviewPath = process.env.AGENTMUX_FOCUS_WORK_VISUAL_REVIEW
  assert.ok(scenePath && reviewPath, 'Actual compiled scene and independent visual review required')
  const scene = JSON.parse(await readFile(scenePath, 'utf8')), review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(scene.passed, true); assert.equal(review.verdict, 'pass')
  assert.ok(scene.authorAgentId && review.reviewerAgentId && scene.authorAgentId !== review.reviewerAgentId)
  assert.equal(review.guiReceiptSha256, hash(await readFile(scenePath)))
  assert.deepEqual(scene.sourceAfter, scene.inputs)
  for (const file of product) assert.equal(hash(await readFile(join(root, file))), scene.inputs[file], 'Exact actual compiled product ' + file)
  assert.equal(scene.phases.length, 2); assert.notEqual(scene.phases[0].pid, scene.phases[1].pid)
  assert.equal(scene.phases[0].seedCount, 1); assert.equal(scene.phases[1].seedCount, 0)
  assert.equal(scene.restartPreserved, true); assert.equal(scene.workHistoryPreserved, true)
  assert.ok(scene.frames.length >= 2 && scene.frames.length <= 3)
  assert.ok(scene.frames.some(frame => frame.width <= 640) && scene.frames.some(frame => frame.width >= 1000))
  assert.equal(review.viewedImages.length, scene.frames.length)
  for (const frame of scene.frames) {
    assert.equal(hash(await readFile(resolve(scenePath, '..', frame.path))), frame.sha256)
    assert.ok(review.viewedImages.some(image => image.path === frame.path && image.sha256 === frame.sha256 && image.observation))
  }
  assert.equal(scene.cleanup.remainingProcesses, 0); assert.equal(scene.cleanup.rootRemoved, true)
  assert.equal(scene.userAppRunRuntimeControlled, false)
  console.log(JSON.stringify({ passed: true, mode, boundary: scene.boundary, wholeTaskDone: false })); process.exit(0)
}
const out = join(root, '.tmp', ("focus-work-history-source-" + (globalThis.crypto.randomUUID()) + "")); await mkdir(out, { recursive: true })
const before = await bindings(), receipt = { schema: 'agentmux.focus-work-history-source.v1', passed: false, sourcePassed: false,
  sourceBefore: before, publicModule: relative(root, resolvedTimeline), owning: null, mutations: [], adjacent: [], types: [], callers: {},
  boundary: 'Actual mounted Store/public Core FileStore reader consumption; accepted producer facts replayed without changing IDs/times. No Native Writer, physical Run/PID continuity, installation or full Focus qualification.' }
async function run(label, executable, args, env = {}) {
  let code = 0, signal = null, output
  try { const result = await promisify(execFile)(executable, args, { cwd: root, env: { ...process.env, ...env }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); output = result.stdout + result.stderr }
  catch (error) { code = error.code; signal = error.signal; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(out, label + '.log'), output); return { code, signal, log: label + '.log' }
}
const expectedCount = 10
const code = await readFile(join(root, timeline), 'utf8')
const changes = {
  'drop-closed-working': { path: timeline, sourceSHA256: before[timeline], from: 'const workItems = retainedHere?.items ?? (context ? ownWorkItems : EMPTY_FOCUS_WORK_ITEMS)', to: 'const workItems = context ? ownWorkItems : EMPTY_FOCUS_WORK_ITEMS' },
  'current-state-only': { path: timeline, sourceSHA256: before[timeline], from: 'projectAgentWorkHistory(workItems,', to: "projectAgentWorkHistory(context?.state === 'working' ? workItems : EMPTY_FOCUS_WORK_ITEMS," }
}
for (const change of Object.values(changes)) assert.equal(code.split(change.from).length, 2, 'One exact loaded semantic expression')
const mutationMap = join(out, 'mutations.json'); await writeFile(mutationMap, JSON.stringify(changes, null, 2) + '\n')
async function test(label, mutation) {
  const report = join(out, label + '.json'), loaded = join(out, label + '.loaded.jsonl')
  const execution = await run(label, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + 'vitest.owning.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], {
    AGENTMUX_FOCUS_WORK_LOADED_SOURCE: loaded, ...(mutation ? { AGENTMUX_FOCUS_WORK_MUTATION: mutation, AGENTMUX_FOCUS_WORK_MUTATION_MAP: mutationMap } : {})
  })
  const actual = JSON.parse(await readFile(report, 'utf8')); assert.equal(actual.numTotalTests, expectedCount); assert.equal(actual.testResults.length, 1)
  assert.equal(actual.testResults[0].assertionResults.length, expectedCount)
  const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const file of product.slice(0, 3)) {
    const found = modules.filter(module => module.path === file); assert.ok(found.length, 'Nonempty actual loaded consumer ' + file)
    assert.ok(found.every(module => module.originalSHA256 === before[file]))
  }
  const changed = modules.filter(module => module.mutation)
  if (mutation) {
    assert.equal(changed.length, 1); assert.equal(changed[0].mutation, mutation); assert.notEqual(changed[0].originalSHA256, changed[0].sha256)
    assert.ok(execution.code > 0 && execution.signal === null); assert.ok(actual.numFailedTests > 0)
    assert.ok(actual.testResults.flatMap(file => file.assertionResults).some(item => item.failureMessages.some(text => text.includes('AssertionError'))), 'Actual loaded semantic AssertionRED, not preparation error')
  } else { assert.equal(execution.code, 0); assert.equal(actual.numFailedTests, 0); assert.equal(actual.numPassedTests, expectedCount); assert.deepEqual(changed, []) }
  return { ...execution, collected: actual.numTotalTests, passed: actual.numPassedTests, failed: actual.numFailedTests, report: relative(out, report), loaded: relative(out, loaded), changed }
}
try {
  receipt.owning = await test('baseline')
  for (const mutation of Object.keys(changes)) receipt.mutations.push({ mutation, red: await test(mutation + '-red', mutation), green: await test(mutation + '-restored') })
  for (const [label, config, count] of [['public-reader-adjacent', 'vitest.adjacent.config.mts', 2], ['current-running-adjacent', 'vitest.running.config.mts', 1]]) {
    const report = join(out, label + '.json'), execution = await run(label, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + config, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report])
    const adjacent = JSON.parse(await readFile(report, 'utf8')); assert.equal(adjacent.testResults.length, count); assert.ok(adjacent.numTotalTests > 0)
    receipt.adjacent.push({ label, ...execution, collected: adjacent.numTotalTests, passed: adjacent.numPassedTests, failed: adjacent.numFailedTests }); assert.equal(execution.code, 0); assert.equal(adjacent.numFailedTests, 0)
  }
  for (const [label, config] of [['production', 'apps/desktop/tsconfig.json'], ['owning', fixture + 'tsconfig.owning.json']]) {
    const check = await run(label + '-types', join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', config]); receipt.types.push({ label, ...check }); assert.equal(check.code, 0, await readFile(join(out, check.log), 'utf8'))
  }
  const globalPath = 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', global = await readFile(join(root, globalPath), 'utf8')
  assert.match(global, /<RecentFocusTimeline\b/); receipt.callers.RecentFocusTimeline = [globalPath]
  for (const symbol of ['projectAgentWorkHistory', 'createFocusWorkSelector', 'clipFocusWorkInterval', 'focusTimelineTrackKey']) {
    assert.match(code, new RegExp('\\b' + symbol + '\\(')); receipt.callers[symbol] = [timeline]
  }
  assert.match(await readFile(join(root, 'apps/desktop/src/renderer/src/styles/index.css'), 'utf8'), /focus\.css/); receipt.callers.workingHistoryCSS = ['apps/desktop/src/renderer/src/styles/index.css', timeline]
  receipt.sourceAfter = await bindings(); assert.deepEqual(receipt.sourceAfter, before); receipt.sourcePassed = true; receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { receipt.sourceAfter ??= await bindings(); await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, sourcePassed: receipt.sourcePassed, evidence: relative(root, out), failure: receipt.failure?.message, wholeTaskDone: false })) }
