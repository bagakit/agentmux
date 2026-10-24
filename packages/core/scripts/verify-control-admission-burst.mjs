import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const attempt = resolve(root, '.local/state/control-admission-burst', new Date().toISOString().replaceAll(':', '-'))
await mkdir(attempt, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const worker = resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')
const workerOutput = resolve(root, 'packages/core/dist/control-endpoint-listener-worker.js')
const originalWorker = await readFile(worker, 'utf8')
const receipt = { passed: false, userRuntimeTouched: false, sourceStable: false, source: {}, results: [] }
async function run(command, args, label, env = {}) {
  const output = []
  const result = await new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && !key.startsWith('CONTROL_ADMISSION_'))), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk))
    child.once('error', no); child.once('exit', (code, signal) => yes({ code, signal }))
  })
  const bytes = Buffer.concat(output)
  await writeFile(resolve(attempt, label + '.log'), bytes)
  return { ...result, command: [command, ...args], outputSHA256: sha(bytes) }
}
async function emitWorker(source) {
  await mkdir(dirname(workerOutput), { recursive: true })
  const result = await transform(source, { loader: 'ts', format: 'esm', target: 'node24', sourcefile: worker })
  await writeFile(workerOutput, result.code)
}
const variants = [{ name: 'candidate' },
  { name: 'restore-artificial-cap', test: '193 independent Unix clients', worker: true },
  { name: 'per-reader-unix', test: 'one Unix client delivers' },
  { name: 'cancel-peers', test: '193 independent subscription leases' },
  { name: 'wrong-subscription', test: '193 independent subscription leases' },
  { name: 'replay-unknown', test: 'a lost admitted write' },
  { name: 'queued-cancel-unknown', test: 'public shared reader cancellation preserves exact queued' },
  { name: 'restored', test: 'one Unix client delivers|193 independent Unix clients' }]
try {
  for (const file of ['packages/core/src/public-rpc-client.ts', 'packages/core/src/rpc-stream-transport.ts',
    'packages/core/src/rpc-ssh-transport.ts', 'packages/core/src/control-endpoint-publication.ts',
    'packages/core/src/control-endpoint-listener-worker.ts', 'packages/core/test/control-admission-burst.test.ts',
    'packages/core/test/control-admission-burst.config.mts', 'packages/core/test/control-endpoint-socket-handoff.test.ts',
    'packages/core/scripts/verify-control-admission-burst.mjs']) receipt.source[file] = sha(await readFile(resolve(root, file)))
  await emitWorker(originalWorker)
  // The actual public CLI, stdio leaf and private Native owner consume this build.
  // No Desktop/App package or user installation is created by this gate.
  const compiled = await run('pnpm', ['--filter', '@agentmux/core', 'build'], 'core-build')
  assert.equal(compiled.code, 0, 'Actual Core CLI/Native consumer build: ' + JSON.stringify(compiled))
  receipt.coreBuild = compiled
  for (const variant of process.argv.includes('--mutations') ? variants : [variants[0]]) {
    let evaluatedWorker = originalWorker
    if (variant.worker) {
      const anchor = '  pending.add(socket)'
      assert.equal(originalWorker.split(anchor).length, 2)
      evaluatedWorker = originalWorker.replace('let nextId = 0, sending = false', 'let awaitingBusinessAck = 0\nlet nextId = 0, sending = false')
        .replace(anchor, '  if (awaitingBusinessAck === 64) { socket.destroy(); return }\n  awaitingBusinessAck++\n' + anchor)
    }
    await emitWorker(evaluatedWorker)
    const report = resolve(attempt, variant.name + '.json'), loaded = resolve(attempt, variant.name + '-loaded.ndjson')
    const isMutant = !['candidate', 'restored'].includes(variant.name)
    const result = await run(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/control-admission-burst.config.mts',
      '--reporter=json', '--outputFile=' + report], variant.name, { CONTROL_ADMISSION_LOADED: loaded,
      ...(isMutant ? { CONTROL_ADMISSION_MUTANT: variant.name } : {}), ...(variant.test ? { CONTROL_ADMISSION_CASE: variant.test } : {}) })
    const tests = JSON.parse(await readFile(report, 'utf8'))
    const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    for (const input of inputs) {
      const actual = sha(await readFile(resolve(root, input.path)))
      assert.equal(input.originalSHA256, actual, 'Actual loaded candidate source: ' + input.path)
      receipt.source[input.path] = actual
    }
    const failed = tests.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    const count = tests.numPassedTests + tests.numFailedTests
    assert.ok(count > 0, 'No empty test authority: ' + variant.name)
    if (isMutant) {
      assert.notEqual(result.code, 0, 'Mutant must fail: ' + variant.name)
      assert.ok(failed.length > 0 && failed.some(test => test.fullName.includes(variant.test)), 'Expected behavioral failure: ' + variant.name)
      if (!variant.worker) assert.ok(inputs.some(input => input.mutation === variant.name && input.originalSHA256 !== input.loadedSHA256), 'Actual product mutant loaded')
    } else { assert.equal(result.code, 0, variant.name + ': ' + JSON.stringify(failed)); assert.equal(tests.numFailedTests, 0) }
    receipt.results.push({ name: variant.name, ...result, passed: tests.numPassedTests, failed: tests.numFailedTests,
      workerSourceSHA256: sha(evaluatedWorker), reportSHA256: sha(await readFile(report)), loadedSHA256: sha(await readFile(loaded)) })
  }
  const writer = await run(process.execPath, [resolve(root, 'packages/core/scripts/verify-rpc-stream-writer.mjs'), '--mutations'], 'writer')
  assert.equal(writer.code, 0, 'Real writer drain/cancel/close counterexamples and source mutants')
  receipt.writer = writer
  for (const [file, digest] of Object.entries(receipt.source)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Source stable: ' + file)
  receipt.sourceStable = true; receipt.passed = true
} finally {
  await emitWorker(originalWorker)
  await writeFile(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ ...receipt, source: Object.keys(receipt.source).length, attempt }))
}
