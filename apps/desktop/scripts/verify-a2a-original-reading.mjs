import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { promisify } from 'node:util'
import { originalReadingMutations } from './a2a-original-reading-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const area = resolve(root, '.tmp/a2a-original-reading'), output = resolve(area, 'run-' + Date.now())
const hash = value => createHash('sha256').update(value).digest('hex')
const config = 'apps/desktop/test/vitest.a2a-original-reading.config.mts'
const sources = {}, runs = []
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--prepare')
if (!args.length) {
  const index = JSON.parse(await readFile(resolve(area, 'current.json'), 'utf8'))
  const receipt = JSON.parse(await readFile(resolve(root, index.receipt), 'utf8'))
  assert.equal(receipt.prepared, true)
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Current consumed source: ' + file)
  for (const [file, digest] of Object.entries(receipt.artifacts)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Bound evidence: ' + file)
  const capture = receipt.capture
  assert.equal(hash(await readFile(resolve(receipt.captureDirectory, 'capture.json'))), receipt.captureSha256)
  assert.equal(capture.completed, true); assert.equal(capture.privateRootRemoved, true)
  assert.deepEqual(capture.remainingPrivateProcesses, []); assert.deepEqual(capture.drift, [])
  for (const [file, identity] of Object.entries(capture.inputs)) assert.equal(hash(await readFile(resolve(root, file))), identity.sha256, 'Current Renderer source: ' + file)
  const review = JSON.parse(await readFile(resolve(area, 'visual-review.json'), 'utf8'))
  assert.equal(review.decision, 'approved'); assert.equal(review.sourceIdentity, capture.sourceIdentity)
  assert.equal(review.captureSha256, receipt.captureSha256)
  assert.ok(review.reviewedFrames.length > 0)
  assert.deepEqual(review.reviewedFrames, capture.render.frames.map(frame => ({ file: frame.file, sha256: frame.sha256 })))
  for (const frame of capture.render.frames) assert.equal(hash(await readFile(resolve(receipt.captureDirectory, frame.file))), frame.sha256)
  assert.ok(receipt.runs.length === originalReadingMutations.length + 2)
  assert.equal(receipt.bridge.exitCode, 0); assert.equal(receipt.bridgeMutation.exitCode, 1); assert.equal(receipt.bridgeRestored.exitCode, 0)
  assert.equal(receipt.types.exitCode, 0)
  console.log(JSON.stringify({ passed: true, receipt: index.receipt, mutations: originalReadingMutations.length + 1, images: review.reviewedFrames.length }))
  process.exit(0)
}
await mkdir(output, { recursive: true })
async function run(label, args, extra = {}) {
  let exitCode = 0, log
  try { const result = await exec(process.execPath, args, { cwd: root, env: { ...process.env, ...extra }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); log = result.stdout + result.stderr }
  catch (error) { assert.equal(error.killed, false, 'Interrupted runs cannot prove behavior'); exitCode = error.code; log = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(resolve(output, label + '.log'), log)
  return { exitCode, log: relative(root, resolve(output, label + '.log')), text: log }
}
async function tests(label, mutation) {
  const report = resolve(output, label + '.json'), loaded = resolve(output, label + '-inputs.jsonl')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
    ...(mutation ? ['packages/client-ui/test/a2a-original-reading.test.tsx'] : []), '--reporter=json', '--outputFile=' + report],
  { AGENTMUX_ORIGINAL_READING_MUTATION: mutation?.name ?? '', AGENTMUX_ORIGINAL_READING_LOADED: loaded })
  const data = JSON.parse(await readFile(report, 'utf8')), inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(data.numTotalTests >= 17); assert.equal(data.numPendingTests, 0); assert.equal(data.numTodoTests, 0)
  assert.ok(inputs.length > 0)
  for (const input of inputs) {
    assert.equal(input.original, hash(await readFile(resolve(root, input.path))), 'Actual consumed source: ' + input.path)
    if (sources[input.path]) assert.equal(sources[input.path], input.original, 'One candidate throughout proof')
    sources[input.path] = input.original
  }
  const changed = inputs.filter(input => input.original !== input.compiled)
  if (mutation) {
    assert.equal(result.exitCode, 1); assert.ok(data.numFailedTests > 0)
    assert.ok(data.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))))
    assert.deepEqual(changed.map(item => item.path), [mutation.path])
  } else { assert.equal(result.exitCode, 0, result.text); assert.equal(data.numFailedTests, 0); assert.equal(changed.length, 0) }
  runs.push({ label, mutation: mutation?.name ?? null, exitCode: result.exitCode, tests: data.numTotalTests, failures: data.numFailedTests, report: relative(root, report), log: result.log })
  console.log(label + ': ' + (mutation ? 'behavior RED' : 'GREEN'))
}
await tests('baseline')
for (const mutation of originalReadingMutations) await tests(mutation.name, mutation)
await tests('restored')
const bridgeArtifacts = []
async function bridgeTest(label, mutation = '') {
  const evidence = resolve(output, label + '-inputs')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.a2a-message-data.config.mts', 'apps/desktop/test/a2a-message-data-bridge.test.tsx'],
    { AGENTMUX_TEST_MESSAGE_DATA_MUTATION: mutation, AGENTMUX_MESSAGE_DATA_EVIDENCE: evidence })
  const inputs = JSON.parse(await readFile(resolve(evidence, 'mutation.json'), 'utf8'))
  const report = JSON.parse(await readFile(resolve(evidence, 'results.json'), 'utf8'))
  assert.ok(report.numTotalTests > 0); assert.equal(report.numPendingTests, 0)
  assert.ok(Object.keys(inputs.sources).length > 0)
  for (const [file, digest] of Object.entries(inputs.sources)) {
    assert.equal(hash(await readFile(resolve(root, file))), digest, 'Current actual bridge input: ' + file)
    if (sources[file]) assert.equal(sources[file], digest, 'One joined source candidate: ' + file)
    sources[file] = digest
  }
  if (mutation) {
    assert.equal(result.exitCode, 1); assert.match(result.text, /AssertionError/u)
    assert.equal(inputs.applied.length, 1); assert.notEqual(inputs.applied[0].original, inputs.applied[0].changed)
    assert.ok(report.numFailedTests > 0)
  } else { assert.equal(result.exitCode, 0, result.text); assert.equal(report.numFailedTests, 0); assert.equal(inputs.applied.length, 0) }
  bridgeArtifacts.push(...['mutation.json', 'results.json'].map(file => relative(root, resolve(evidence, file))))
  return { exitCode: result.exitCode, log: result.log }
}
const bridge = await bridgeTest('desktop-bridge')
const bridgeMutation = await bridgeTest('wrong-host-unchecked', 'originalResponseHost')
const bridgeRestored = await bridgeTest('desktop-bridge-restored')
const types = await run('types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/client-ui/tsconfig.json'])
assert.equal(types.exitCode, 0, types.text)
// Capture once; the following gate consumes the same source-bound independent visual review.
const captureDirectory = process.env.AGENTMUX_ORIGINAL_READING_CAPTURE ?? resolve(output, 'visual')
let capture
if (process.env.AGENTMUX_ORIGINAL_READING_CAPTURE) capture = JSON.parse(await readFile(resolve(captureDirectory, 'capture.json'), 'utf8'))
else { const { captureA2aOriginalReading } = await import('./fixtures/a2a-original-reading/capture.mjs'); capture = await captureA2aOriginalReading({ root, evidence: captureDirectory }) }
const captureSha256 = hash(await readFile(resolve(captureDirectory, 'capture.json')))
for (const file of ['apps/desktop/scripts/verify-a2a-original-reading.mjs', config, 'apps/desktop/scripts/a2a-original-reading-mutations.mjs',
  'apps/desktop/test/a2a-message-data-bridge.test.tsx', 'apps/desktop/test/vitest.a2a-message-data.config.mts',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts']) sources[file] = hash(await readFile(resolve(root, file)))
const artifacts = {}
for (const file of [...runs.flatMap(run => [run.log, run.report]), bridge.log, bridgeMutation.log, bridgeRestored.log, types.log, ...bridgeArtifacts]) artifacts[file] = hash(await readFile(resolve(root, file)))
const receipt = { passed: false, prepared: true, sources, artifacts, runs, bridge, bridgeMutation, bridgeRestored,
  types: { exitCode: types.exitCode, log: types.log }, captureDirectory, captureSha256, capture }
await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await writeFile(resolve(area, 'current.json'), JSON.stringify({ receipt: relative(root, resolve(output, 'receipt.json')) }) + '\n')
console.log(JSON.stringify({ prepared: true, receipt: relative(root, resolve(output, 'receipt.json')), next: 'Independent review of the current Renderer images is required.' }))
