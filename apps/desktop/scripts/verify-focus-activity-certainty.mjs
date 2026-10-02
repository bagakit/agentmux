import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
assert.equal(process.argv.length, 3, 'Use --source or --consume')
const mode = process.argv[2]
assert.ok(['--source', '--consume'].includes(mode), 'Use --source or --consume')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const product = ['packages/core/src/agent-status-freshness.ts',
  'apps/desktop/src/renderer/src/lib/focus-context.ts',
  'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextRow.tsx']
const files = [...product, 'packages/core/src/client.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/hook-normalizer.ts', 'packages/core/src/providers/codex.ts', 'packages/core/src/providers/grok.ts',
  'packages/core/package.json', 'packages/core/dist/agent-status-freshness.js', 'packages/core/dist/agent-status-freshness.d.ts',
  'packages/client-ui/package.json', 'vitest.dist-freshness.ts',
  'apps/desktop/src/renderer/src/lib/agent-observation.ts',
  'packages/core/test/activity-certainty.test.ts', 'packages/core/test/fixtures/activity-certainty-client.ts',
  'packages/core/scripts/fixtures/activity-certainty/vitest.core.config.mts',
  'packages/core/scripts/fixtures/activity-certainty/demand-freshness.ts',
  'apps/desktop/test/focus-activity-certainty.test.tsx',
  'apps/desktop/scripts/fixtures/focus-activity-certainty/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/focus-activity-certainty/vitest.adjacent.config.mts',
  'apps/desktop/scripts/fixtures/focus-activity-certainty/tsconfig.owning.json',
  'packages/core/test/provider-observation-contract.test.ts', 'packages/core/test/agent-status-freshness.test.ts',
  'apps/desktop/test/provider-observation-consumer.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts',
  'apps/desktop/scripts/verify-focus-activity-certainty.mjs',
  'apps/desktop/scripts/capture-focus-activity-certainty.mjs',
  'apps/desktop/scripts/fixtures/focus-activity-certainty/entry.mjs',
  'apps/desktop/scripts/fixtures/focus-activity-certainty/main.cjs']
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
if (mode === '--consume') {
  const scenePath = process.env.AGENTMUX_FOCUS_ACTIVITY_SCENE_RECEIPT
  const reviewPath = process.env.AGENTMUX_FOCUS_ACTIVITY_VISUAL_REVIEW
  assert.ok(scenePath && reviewPath, 'Exact actual scene and independent review required')
  const scene = JSON.parse(await readFile(scenePath, 'utf8')), review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(scene.passed, true); assert.equal(review.verdict, 'pass')
  assert.equal(review.guiReceiptSha256, hash(await readFile(scenePath)))
  assert.notEqual(review.reviewerAgentId, scene.authorAgentId, 'Image author cannot approve own visuals')
  assert.ok(scene.authorAgentId && review.reviewerAgentId)
  for (const file of product) assert.equal(hash(await readFile(join(root, file))), scene.inputs[file], 'Exact actual scene product ' + file)
  for (const [file, sha] of Object.entries(scene.inputs)) assert.equal(hash(await readFile(join(root, file))), sha, 'Exact actual scene input ' + file)
  assert.deepEqual(scene.sourceAfter, scene.inputs)
  assert.ok(scene.activityCertainty && scene.activityCertainty.bareUnknown && scene.activityCertainty.staleUnknown
    && scene.activityCertainty.confirmedIdle && scene.activityCertainty.confirmedWorking && scene.activityCertainty.exactNeutralCounts
    && scene.activityCertainty.keyboardEntry, 'Actual nonempty same-compiled certainty scene facts')
  assert.ok(scene.frames.length >= 2 && scene.frames.some(frame => frame.width <= 640) && scene.frames.some(frame => frame.width >= 1000))
  assert.equal(review.viewedImages.length, scene.frames.length)
  for (const frame of scene.frames) {
    assert.equal(hash(await readFile(resolve(scenePath, '..', frame.path))), frame.sha256)
    assert.ok(review.viewedImages.some(item => item.path === frame.path && item.sha256 === frame.sha256 && item.observation))
  }
  assert.equal(scene.cleanup.remainingProcesses, 0)
  console.log(JSON.stringify({ passed: true, mode, boundary: 'Source-bound lane certainty only; not Provider Writer, healthy physical Run, Native or installation' }))
  process.exit(0)
}
const directory = join(root, '.tmp', ("focus-activity-certainty-source-" + (globalThis.crypto.randomUUID()) + ""))
await mkdir(directory, { recursive: true })
const before = await bindings(), receipt = { schema: 'agentmux.focus-activity-certainty-source.v1', passed: false,
  sourceBefore: before, owning: [], mutations: [], adjacent: null, types: [], callers: {},
  boundary: 'Public Client Source/real private FileStore plus mounted production Store/Global/Row. Run transport is isolated; no Runtime/PTY/Writer/installation proof.' }
async function run(label, executable, args, environment = {}) {
  let code = 0, signal = null, output
  try { const result = await promisify(execFile)(executable, args, { cwd: root,
    env: { ...process.env, ...environment }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }); output = result.stdout + result.stderr }
  catch (error) { code = error.code; signal = error.signal; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(directory, `${label}.log`), output)
  return { code, signal, log: `${label}.log` }
}
const configs = { core: 'packages/core/scripts/fixtures/activity-certainty/vitest.core.config.mts',
  desktop: 'apps/desktop/scripts/fixtures/focus-activity-certainty/vitest.owning.config.mts' }
async function test(family, label, mutation) {
  const report = join(directory, `${label}.json`), loaded = join(directory, `${label}-loaded.jsonl`)
  const execution = await run(label, process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configs[family],
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { AGENTMUX_ACTIVITY_CERTAINTY_LOADED: loaded,
      ...(mutation ? { AGENTMUX_ACTIVITY_CERTAINTY_MUTATION: mutation } : {}),
      AGENTMUX_ACTIVITY_CERTAINTY_SCENE_SEED: label === 'core-owning' ? join(directory, 'public-scene-seed.json') : '' })
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.numTotalTests, family === 'core' ? 6 : 7, 'Nonempty literal owning count')
  const observed = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const required = family === 'core' ? [product[0]] : product.slice(1)
  for (const file of required) {
    const actual = observed.filter(item => item.path === file); assert.ok(actual.length, 'Actual loaded production module ' + file)
    assert.ok(actual.every(item => item.sourceSHA256 === before[file]))
  }
  const changed = observed.filter(item => item.mutated)
  const failed = result.testResults.flatMap(file => file.assertionResults).filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(changed.length, 1); assert.notEqual(changed[0].sourceSHA256, changed[0].loadedSHA256)
    assert.equal(changed[0].mutation, mutation); assert.ok(execution.code > 0 && execution.signal === null)
    assert.ok(failed.length > 0); assert.ok(failed.every(item => item.failureMessages.some(text => text.includes('AssertionError'))), 'Semantic AssertionRED, not bootstrap failure')
  } else { assert.equal(execution.code, 0); assert.equal(result.numPassedTests, result.numTotalTests); assert.deepEqual(changed, []) }
  return { ...execution, collected: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
    report: relative(directory, report), loaded: relative(directory, loaded), actualLoaded: observed.length, changed }
}
try {
  receipt.owning.push(await test('core', 'core-owning'))
  receipt.owning.push(await test('desktop', 'desktop-owning'))
  for (const [family, mutation] of [['core', 'bare-idle'], ['core', 'stale-idle'], ['desktop', 'hide-unknown']]) {
    receipt.mutations.push({ mutation, red: await test(family, mutation + '-red', mutation),
      green: await test(family, mutation + '-restored') })
  }
  const adjacentReport = join(directory, 'adjacent.json')
  receipt.adjacent = await run('adjacent', process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/scripts/fixtures/focus-activity-certainty/vitest.adjacent.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + adjacentReport])
  const adjacent = JSON.parse(await readFile(adjacentReport, 'utf8')); assert.ok(adjacent.numTotalTests > 0)
  receipt.adjacent = { ...receipt.adjacent, collected: adjacent.numTotalTests, passed: adjacent.numPassedTests, failed: adjacent.numFailedTests }
  assert.equal(receipt.adjacent.code, 0); assert.equal(adjacent.numFailedTests, 0)
  for (const [symbol, file, pattern] of [['observeAgent', 'packages/core/src/client.ts', /const observation = observeAgent\(\{/],
    ['observeAgentSession', product[1], /observeAgentSession\(session, now\)/],
    ['focusNeutralGroupSummary', product[2], /focusNeutralGroupSummary\(grouped\)/]]) {
    assert.match(await readFile(join(root, file), 'utf8'), pattern, 'Non-definition production caller ' + symbol)
    receipt.callers[symbol] = [file]
  }
  for (const [label, config] of [['core-production', 'packages/core/tsconfig.build.json'], ['desktop-production', 'apps/desktop/tsconfig.json'],
    ['owning', 'apps/desktop/scripts/fixtures/focus-activity-certainty/tsconfig.owning.json']]) {
    const actual = await run(label + '-types', join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', config,
      ...(label === 'core-production' ? ['--tsBuildInfoFile', join(directory, label + '.tsbuildinfo')] : [])], { NODE_OPTIONS: '--max-old-space-size=1536' })
    receipt.types.push({ label, ...actual }); assert.equal(actual.code, 0, await readFile(join(directory, actual.log), 'utf8'))
  }
  receipt.sourceAfter = await bindings(); assert.deepEqual(receipt.sourceAfter, before); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { receipt.sourceAfter ??= await bindings(); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, directory), failure: receipt.failure?.message, wholeTaskDone: false })) }
