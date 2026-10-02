import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2] ?? '--consume'
assert.ok(['--source', '--consume'].includes(mode)); assert.ok(process.argv.length <= 3)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const product = ['apps/desktop/src/renderer/src/components/FileExplorer.tsx',
  'apps/desktop/src/renderer/src/components/file-tree/useWorkspaceFileTree.ts']
const own = ['apps/desktop/test/workface-explorer-scope.test.tsx',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/vitest.owning.config.mts',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/vitest.adjacent.config.mts',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/tsconfig.owning.json',
  'apps/desktop/scripts/verify-workface-explorer-scope.mjs',
  'apps/desktop/scripts/capture-workface-explorer-scope.mjs',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/entry.mjs',
  'apps/desktop/scripts/fixtures/workface-explorer-scope/main.cjs']
const files = [...product, ...own, 'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
  'apps/desktop/src/renderer/src/lib/mote-workface.ts', 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts',
  'apps/desktop/test/fixtures/mote-workface.ts', 'vitest.dist-freshness.ts',
  'apps/desktop/test/file-explorer-scratch-physical-path.test.tsx',
  'apps/desktop/test/file-explorer-refresh.test.ts', 'apps/desktop/test/file-explorer-foundations.test.ts',
  'apps/desktop/test/file-explorer-open-as-project.integration.test.tsx']
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
if (mode === '--consume') {
  const sourcePath = process.env.AGENTMUX_WORKFACE_EXPLORER_SOURCE_RECEIPT
  const scenePath = process.env.AGENTMUX_WORKFACE_EXPLORER_SCENE_RECEIPT
  const reviewPath = process.env.AGENTMUX_WORKFACE_EXPLORER_VISUAL_REVIEW
  assert.ok(sourcePath && scenePath && reviewPath, 'Exact Source, actual compiled scene and independent review are required')
  const source = JSON.parse(await readFile(sourcePath, 'utf8')), scene = JSON.parse(await readFile(scenePath, 'utf8'))
  const review = JSON.parse(await readFile(reviewPath, 'utf8'))
  assert.equal(source.passed, true); assert.equal(source.owning.collected, 8); assert.equal(source.owning.passed, 8)
  assert.equal(source.mutations.length, 2); assert.ok(source.mutations.every(item => item.red.failed > 0 && item.green.passed === 8))
  assert.ok(source.adjacent.collected > 0 && source.adjacent.failed === 0)
  assert.equal(source.types.length, 2); assert.ok(source.types.every(item => item.code === 0))
  assert.deepEqual(source.sourceBefore, source.sourceAfter)
  const current = await bindings(), readiness = ['apps/desktop/scripts/verify-workface-explorer-scope.mjs',
    'apps/desktop/scripts/capture-workface-explorer-scope.mjs', 'apps/desktop/scripts/fixtures/workface-explorer-scope/main.cjs']
  const changed = Object.keys(current).filter(file => current[file] !== source.sourceAfter[file])
  assert.deepEqual((scene.readinessDelta ?? []).map(item => item.path).sort(), changed.sort(), 'Transparent exact validation-only readiness delta')
  for (const file of changed) {
    assert.ok(readiness.includes(file), 'Qualified product/tests/config cannot drift: ' + file)
    const delta = scene.readinessDelta.find(item => item.path === file)
    assert.equal(delta.before, source.sourceAfter[file]); assert.equal(delta.after, current[file]); assert.ok(delta.reason)
  }
  assert.equal(scene.passed, true); assert.equal(scene.sourceQualification.sha256, hash(await readFile(sourcePath)))
  assert.equal(review.verdict, 'pass'); assert.equal(review.guiReceiptSha256, hash(await readFile(scenePath)))
  assert.ok(review.reviewerAgentId && review.reviewerAgentId !== scene.authorAgentId)
  for (const [file, sha] of Object.entries(scene.inputs)) assert.equal(hash(await readFile(join(root, file))), sha, 'Actual scene input ' + file)
  assert.deepEqual(scene.inputs, scene.sourceAfter)
  assert.ok(scene.actual.correctScope && scene.actual.originalControls && scene.actual.exactCaller && scene.actual.originalChildRetained)
  assert.equal(scene.frames.length, 1); assert.equal(review.viewedImages.length, 1)
  for (const frame of scene.frames) {
    assert.equal(hash(await readFile(resolve(scenePath, '..', frame.path))), frame.sha256)
    assert.ok(review.viewedImages.some(item => item.path === frame.path && item.sha256 === frame.sha256 && item.observation))
  }
  assert.equal(scene.cleanup.remainingProcesses, 0)
  console.log(JSON.stringify({ passed: true, mode, source: sourcePath, scene: scenePath, boundary: 'Existing Workface file resource scope; no Native, healthy Run, installation or full Focus claim' }))
  process.exit(0)
}
const directory = join(root, '.tmp', 'workface-explorer-scope-source-' + globalThis.crypto.randomUUID()); await mkdir(directory, { recursive: true })
const before = await bindings(), receipt = { schema: 'agentmux.workface-explorer-scope-source.v1', passed: false,
  authorAgentId: '/root/focus_formal_resume_intake', sourceBefore: before, owning: null, mutations: [], adjacent: null, types: [], callers: {} }
async function run(label, executable, args, environment = {}) {
  let code = 0, signal = null, output
  try { const actual = await promisify(execFile)(executable, args, { cwd: root, env: { ...process.env, ...environment }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); output = actual.stdout + actual.stderr }
  catch (error) { code = error.code; signal = error.signal; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(directory, label + '.log'), output); return { code, signal, log: label + '.log' }
}
async function owning(label, mutation) {
  const report = join(directory, label + '.json'), loaded = join(directory, label + '-loaded.jsonl')
  const actual = await run(label, process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/scripts/fixtures/workface-explorer-scope/vitest.owning.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report],
    { AGENTMUX_WORKFACE_EXPLORER_LOADED: loaded, AGENTMUX_WORKFACE_EXPLORER_MUTATION: mutation ?? '' })
  const result = JSON.parse(await readFile(report, 'utf8')), modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(result.numTotalTests, 8, 'Actual nonempty literal owning collection')
  for (const file of product) assert.ok(modules.some(item => item.path === file && item.sourceSHA256 === before[file]), 'Actual loaded production ' + file)
  const changed = modules.filter(item => item.mutated), failed = result.testResults.flatMap(file => file.assertionResults).filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(changed.length, 1); assert.equal(changed[0].mutation, mutation); assert.notEqual(changed[0].loadedSHA256, changed[0].sourceSHA256)
    assert.ok(actual.code > 0 && actual.signal === null && failed.length > 0)
    assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Behavior AssertionRED, not collect/timeout failure')
  } else { assert.equal(actual.code, 0); assert.equal(result.numPassedTests, 8); assert.deepEqual(changed, []) }
  return { ...actual, collected: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
    report: relative(directory, report), loaded: relative(directory, loaded), actualLoaded: modules.length, changed }
}
try {
  receipt.owning = await owning('owning')
  for (const mutation of ['active-resource', 'whole-root']) receipt.mutations.push({ mutation, red: await owning(mutation + '-red', mutation), green: await owning(mutation + '-restored') })
  const report = join(directory, 'adjacent.json')
  const actual = await run('adjacent', process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/scripts/fixtures/workface-explorer-scope/vitest.adjacent.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report])
  const adjacent = JSON.parse(await readFile(report, 'utf8')); assert.ok(adjacent.numTotalTests > 0)
  receipt.adjacent = { ...actual, collected: adjacent.numTotalTests, passed: adjacent.numPassedTests, failed: adjacent.numFailedTests }
  assert.equal(actual.code, 0); assert.equal(adjacent.numFailedTests, 0)
  for (const [symbol, file, pattern] of [['useWorkspaceFileTree', product[0], /useWorkspaceFileTree\(workspaceId \?\? 'missing-workspace', expanded, rootPath\)/],
    ['FileExplorer', 'apps/desktop/src/renderer/src/components/MoteWorkface.tsx', /<FileExplorer[\s\S]*?workspaceId=\{workspaceId\}[\s\S]*?rootPath=\{allFiles \? '' : scope.rootPath\}[\s\S]*?onOpenPath=\{open\} onOpenTerminal=\{terminal\}/]]) {
    assert.match(await readFile(join(root, file), 'utf8'), pattern, 'Actual non-definition caller ' + symbol); receipt.callers[symbol] = [file]
  }
  for (const [label, config] of [['production', 'apps/desktop/tsconfig.json'], ['owning', 'apps/desktop/scripts/fixtures/workface-explorer-scope/tsconfig.owning.json']]) {
    const actual = await run(label + '-types', join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', config], { NODE_OPTIONS: '--max-old-space-size=1536' })
    receipt.types.push({ label, ...actual }); assert.equal(actual.code, 0, await readFile(join(directory, actual.log), 'utf8'))
  }
  receipt.sourceAfter = await bindings(); assert.deepEqual(receipt.sourceAfter, before); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { receipt.sourceAfter ??= await bindings(); await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, directory), failure: receipt.failure?.message })) }
