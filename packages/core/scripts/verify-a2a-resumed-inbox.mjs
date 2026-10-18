import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { resumedInboxMutations } from '../test/fixtures/a2a-resumed-inbox/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp/a2a-resumed-inbox')
const config = 'packages/core/test/a2a-resumed-inbox.config.mts', primary = 'packages/core/test/a2a-resumed-inbox.test.ts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch, nodeOptions: process.env.NODE_OPTIONS ?? null }
const schema = 'agentmux.a2a-resumed-inbox-proof.v1'
const validationPaths = [
  'packages/core/scripts/verify-a2a-resumed-inbox.mjs', config, primary,
  'packages/core/test/a2a-resumed-inbox-runtime.test.ts',
  'packages/core/test/fixtures/a2a-resumed-inbox/mutations.mjs', 'packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs',
  'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/helpers/source-object-cli.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/hosted-runtime-port.ts', 'packages/core/test/helpers/fixture-values.ts',
  'apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs',
  'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'packages/core/package.json',
  'node_modules/.modules.yaml', 'node_modules/vitest/package.json',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`
]
async function fingerprints(paths) { return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))]))) }
async function unchanged(values) {
  assert.ok(Object.keys(values).length > 0)
  for (const [path, expected] of Object.entries(values)) assert.equal(hash(await readFile(isAbsolute(path) ? path : join(root, path))), expected, 'Verification input changed: ' + path)
}
function assertStage(result, expected, red = false) {
  assert.deepEqual(result.inventory, expected); assert.equal(result.signal, null); assert.equal(result.pending, 0)
  assert.equal(result.tests, expected.length); assert.ok(result.tests > 0)
  if (red) { assert.ok(result.code > 0); assert.ok(result.failures > 0); assert.equal(result.failures, result.assertions); assert.ok(result.transformed.length > 0) }
  else { assert.equal(result.code, 0); assert.equal(result.failures, 0); assert.equal(result.transformed.length, 0) }
}
function assertProof(proof) {
  assert.equal(proof.schema, schema); assert.equal(proof.passed, true)
  assert.equal(proof.sourceOnly, true); assert.equal(proof.sharedTreeMutations, 0); assert.deepEqual(proof.runtime, runtime)
  assert.ok(proof.baseline.inventory.length >= 23); assertStage(proof.baseline, proof.baseline.inventory)
  assert.ok(proof.baseline.inventory.some(name => name.includes('real private resumed Runtime')))
  assert.ok(Object.hasOwn(proof.sourceHashes, 'packages/core/src/agentmux.ts'))
  assert.equal(proof.cases.length, resumedInboxMutations.length)
  for (const [index, mutation] of resumedInboxMutations.entries()) {
    const item = proof.cases[index], expected = proof.baseline.inventory.filter(name => new RegExp(mutation.test).test(name))
    assert.ok(expected.length > 0); assert.equal(item.mutation, mutation.name)
    assertStage(item.red, expected, true); assertStage(item.green, expected)
  }
  assertStage(proof.restored, proof.baseline.inventory)
}
await mkdir(base, { recursive: true })
try {
  const pointer = JSON.parse(await readFile(join(base, 'verified.json'), 'utf8'))
  const bytes = await readFile(pointer.receipt), proof = JSON.parse(bytes)
  assert.equal(hash(bytes), pointer.sha256); assertProof(proof)
  await unchanged(proof.validationHashes); await unchanged(proof.sourceHashes)
  for (const stage of [proof.baseline, ...proof.cases.flatMap(item => [item.red, item.green]), proof.restored]) await unchanged(stage.artifactHashes)
  process.stdout.write(JSON.stringify({ passed: true, reused: true, receipt: pointer.receipt, tests: proof.baseline.tests, mutations: proof.cases.length }) + '\n')
  process.exit(0)
} catch { /* A changed source or damaged artifact requires fresh evidence, never a stale green. */ }

const directory = join(base, randomUUID()); await mkdir(directory)
const validationHashes = await fingerprints(validationPaths), sourceHashes = {}, stages = []
const proof = { schema, sourceOnly: true, sharedTreeMutations: 0, runtime, directory, validationHashes, sourceHashes, passed: false, cases: [] }
async function stage(name, mutation, pattern) {
  const report = join(directory, name + '.json'), loaded = join(directory, name + '-loaded.ndjson'), cliLoaded = join(directory, name + '-cli-loaded.ndjson')
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
    ...(pattern ? [primary, '--testNamePattern', pattern] : []), '--reporter=json', '--outputFile=' + report]
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, detached: true, env: { ...process.env,
      AGENTMUX_RESUMED_INBOX_LOADED: loaded, AGENTMUX_RESUMED_INBOX_CLI_LOADED: cliLoaded,
      ...(mutation ? { AGENTMUX_RESUMED_INBOX_MUTATION: mutation } : { AGENTMUX_RESUMED_INBOX_MUTATION: '' }) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {} }, 180_000)
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); yes({ code, signal, timedOut, output }) })
  })
  await writeFile(join(directory, name + '.log'), result.output)
  assert.equal(result.timedOut, false, 'Original verification child timed out: ' + name)
  assert.equal(result.signal, null, 'Original verification child was interrupted: ' + name)
  const data = JSON.parse(await readFile(report, 'utf8'))
  const assertions = data.testResults.flatMap(item => item.assertionResults)
  const active = assertions.filter(item => item.status === 'passed' || item.status === 'failed')
  const failures = active.filter(item => item.status === 'failed')
  const rows = []
  const artifacts = [report, loaded, join(directory, name + '.log')]
  for (const path of [loaded, cliLoaded]) {
    let bytes
    try { bytes = await readFile(path, 'utf8') } catch (error) { if (path === cliLoaded && error.code === 'ENOENT') continue; throw error }
    rows.push(...bytes.trim().split('\n').filter(Boolean).map(row => JSON.parse(row)))
    if (!artifacts.includes(path)) artifacts.push(path)
  }
  assert.ok(rows.length > 0)
  const transformed = []
  for (const row of rows) {
    assert.equal(hash(await readFile(join(root, row.path))), row.originalSHA256, 'Source changed while original proof was running: ' + row.path)
    if (sourceHashes[row.path]) assert.equal(sourceHashes[row.path], row.originalSHA256)
    sourceHashes[row.path] = row.originalSHA256
    if (row.originalSHA256 !== row.sha256) { assert.equal(row.mutation, mutation); transformed.push(row.path) }
  }
  const output = { name, code: result.code, signal: result.signal, tests: active.length,
    inventory: active.map(item => item.fullName).sort(), pending: pattern ? 0 : assertions.length - active.length,
    failures: failures.length, assertions: failures.filter(item => item.failureMessages.some(text => text.includes('AssertionError'))).length,
    transformed: [...new Set(transformed)].sort(), artifactHashes: Object.fromEntries(await Promise.all(artifacts.map(async path => [path, hash(await readFile(path))]))) }
  assert.equal(new Set(output.inventory).size, output.inventory.length)
  stages.push(output); process.stdout.write(JSON.stringify({ stage: name, tests: output.tests, failures: output.failures, transformed: output.transformed }) + '\n')
  return output
}
try {
  proof.baseline = await stage('baseline')
  assertStage(proof.baseline, proof.baseline.inventory)
  for (const mutation of resumedInboxMutations) {
    const expected = proof.baseline.inventory.filter(name => new RegExp(mutation.test).test(name))
    assert.ok(expected.length > 0, 'Empty source mutation consumer: ' + mutation.name)
    const red = await stage(mutation.name + '-red', mutation.name, mutation.test); assertStage(red, expected, true)
    const green = await stage(mutation.name + '-green', undefined, mutation.test); assertStage(green, expected)
    proof.cases.push({ mutation: mutation.name, red, green })
  }
  proof.restored = await stage('restored'); assertStage(proof.restored, proof.baseline.inventory)
  await unchanged(validationHashes); await unchanged(sourceHashes)
  proof.passed = true; assertProof(proof)
} catch (error) {
  proof.error = { name: error.name, message: error.message, stack: error.stack }; proof.stages = stages
} finally {
  const receipt = join(directory, 'receipt.json'), bytes = JSON.stringify(proof, null, 2) + '\n'
  await writeFile(receipt, bytes); await writeFile(join(base, 'latest.json'), JSON.stringify({ receipt, passed: proof.passed }) + '\n')
  if (proof.passed) await writeFile(join(base, 'verified.json'), JSON.stringify({ receipt, sha256: hash(bytes) }) + '\n')
  process.stdout.write(JSON.stringify({ passed: proof.passed, receipt, error: proof.error?.message }) + '\n')
}
if (!proof.passed) process.exitCode = 1
