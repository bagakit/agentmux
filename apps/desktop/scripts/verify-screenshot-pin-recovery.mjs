import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'Pin recovery verification has no skipped slices')
const source = 'apps/desktop/src/renderer/src/lib/use-screenshot-pin.ts'
const testFile = 'apps/desktop/test/screenshot-pin-recovery.test.tsx'
const hash = value => createHash('sha256').update(value).digest('hex')
const original = await readFile(source, 'utf8')
const mutations = [
  { id: 'retain-original', from: 'operation.current = id', to: 'operation.current = null', expected: 'retains the original pin after a lost response' },
  { id: 'exact-inspection', from: 'await ports.inspect(id)', to: 'await ports.inspect("unrelated-operation")', expected: 'retains the original pin after a lost response' },
  { id: 'same-operation', from: "record?.operationId === id && record.method === 'image.pin'", to: "true && record?.method === 'image.pin'", expected: 'keeps another-operation evidence unknown' },
  { id: 'unknown-remains', from: "record.state === 'completed' || record.state === 'failed'", to: 'true', expected: 'keeps pending evidence unknown' }
]
const inputs = [source, testFile, 'apps/desktop/test/screenshot-pin-recovery.config.mts', 'apps/desktop/scripts/verify-screenshot-pin-recovery.mjs',
  'apps/desktop/src/renderer/screenshot-editor/SystemScreenshotEditorView.tsx', 'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx',
  'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx', 'apps/desktop/src/renderer/src/components/image-annotation/AnnotationOriginalMenu.tsx']
const fingerprints = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(file))])))
await mkdir(resolve('.local/screenshot-pin-recovery'), { recursive: true })
const out = await mkdtemp(resolve('.local/screenshot-pin-recovery/run-')), sourceHashes = await fingerprints()
const receipt = { schema: 'agentmux.screenshot-pin-recovery-proof.v1', passed: false, sourceHashes, runs: [],
  boundary: 'Actual shared recovery hook and production System host/shared editor with controlled PNG compositor and IPC ports. Native pin windows/public owner and actual isolated bridge are verified separately.' }
async function run(label, mutation) {
  const loaded = join(out, label + '.loaded.ndjson'), report = join(out, label + '.tests.json')
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/screenshot-pin-recovery.config.mts', testFile, '--reporter=json', '--outputFile=' + report], {
      cwd: process.cwd(), env: { ...process.env, SCREENSHOT_PIN_RECOVERY_LOADED: loaded, SCREENSHOT_PIN_RECOVERY_MUTATION: mutation ? JSON.stringify(mutation) : '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 35000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, timedOut, log }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timedOut, false, 'An infrastructure timeout cannot kill a behavior mutation')
  assert.equal(result.signal, null, 'Termination cannot prove behavior')
  const tests = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(tests.testResults.length, 1, 'Only the intended recovery suite may execute')
  assert.equal(tests.testResults[0].name, resolve(testFile), 'Use the exact production consumer suite')
  assert.equal(tests.testResults[0].message, '', 'Collection failure cannot prove behavior')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const assertions = tests.testResults[0].assertionResults
  assert.equal(assertions.length, 9, 'A nonempty complete consumer set is required')
  assert.ok(assertions.every(test => ['passed', 'failed'].includes(test.status)), 'Skipped assertions cannot sign recovery')
  const rows = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.length > 0 && rows.every(row => row.source === hash(original) && row.consumed === hash(mutation ? original.replace(mutation.from, mutation.to) : original) && row.mutation === (mutation?.id ?? null)), 'The actual hook must consume this exact loaded source')
  if (mutation) {
    assert.notEqual(result.code, 0, 'Recovery mutation survived: ' + mutation.id)
    const owned = assertions.find(test => test.fullName.includes(mutation.expected))
    assert.equal(owned?.status, 'failed', 'The owning assertion must fail: ' + mutation.id)
    assert.match(owned.failureMessages.join('\n'), /AssertionError/)
  } else { assert.equal(result.code, 0, result.log); assert.ok(assertions.every(test => test.status === 'passed')) }
  receipt.runs.push({ label, code: result.code, assertions: assertions.length, loaded: rows })
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}
try {
  for (const mutation of mutations) assert.equal(original.split(mutation.from).length, 2, 'Recovery mutation must be unique: ' + mutation.id)
  await run('baseline')
  for (const mutation of mutations) await run(mutation.id, mutation)
  await run('restored')
  assert.deepEqual(await fingerprints(), sourceHashes, 'The recovery candidate changed during verification')
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(resolve('.tmp/screenshot-pin-recovery-tests'), { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(out, 'receipt.json') }))
