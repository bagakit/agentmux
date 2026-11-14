import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = resolve(root, '.tmp/hosted-exact-first-read/run-' + randomUUID())
await mkdir(output, { recursive: true })
const privateRuntime = await mkdtemp(resolve(tmpdir(), 'ax-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputPaths = [
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/types.ts',
  'packages/core/src/hosted.ts', 'packages/core/src/index.ts', 'packages/core/src/relay-hosted.ts',
  'packages/core/src/client-event-publisher.ts', 'packages/core/src/space-session-owner.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/renderer-performance.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-relay.ts',
  'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-wire.ts', 'packages/core/src/rpc-stream-transport.ts',
  'packages/core/test/hosted-exact-first-read.test.ts', 'packages/core/test/hosted-exact-first-read.config.mts',
  'packages/core/test/hosted-control-availability.test.ts', 'packages/core/test/hosted-metadata-opening.test.ts',
  'packages/core/test/hosted-session-scope.test.ts', 'packages/core/test/space-sessions.test.ts',
  'packages/core/test/relay-host-identity.test.ts', 'packages/core/test/helpers/relay-carrier-owner.ts',
  'packages/core/test/helpers/space-session-fixture.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/test/helpers/metadata-test-runtime.ts',
  'packages/core/test/relay-carrier.config.mts', 'packages/core/test/mobile-terminal-coalescing.config.mts',
  'packages/core/package.json', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
  'tsconfig.base.json', 'pnpm-lock.yaml', 'packages/core/scripts/verify-hosted-exact-first-read.mjs'
]
const fingerprint = async () => {
  const values = {}
  for (const file of new Set(inputPaths)) values[file] = hash(await readFile(resolve(root, file)))
  return values
}
const receipt = { passed: false, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  conditions: { node: process.version, platform: process.platform, arch: process.arch },
  inputs: await fingerprint(), rounds: [], isolation: 'Private original Host/Relay/DeviceAuthority; controlled Native I/O; no user Session or Run' }
const artifact = async file => ({ file: relative(root, file), sha256: hash(await readFile(file)) })
async function command(args, log, env = {}) {
  const fd = await open(log, 'w')
  try {
    return await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', fd.fd, fd.fd] })
      child.once('error', no)
      child.once('close', (exitCode, signal) => yes({ exitCode, signal }))
    })
  } finally { await fd.close() }
}
const ndjson = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
async function round(name, mutation, related = false) {
  const report = resolve(output, name + '.json'), loaded = resolve(output, name + '-loaded.jsonl')
  const graph = resolve(output, name + '-graph.jsonl'), log = resolve(output, name + '.log')
  const result = await command(['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/hosted-exact-first-read.config.mts',
    '--reporter=json', '--outputFile=' + report], log, {
    HOSTED_EXACT_LOADED: loaded, AGENTMUX_RELAY_INPUT_LOADED: graph,
    HOSTED_EXACT_MUTATION: mutation ?? '', HOSTED_EXACT_RELATED: related ? '1' : '',
    HOST_RELAY_CARRIER_MUTATION: '', HOST_RELAY_CARRIER_BASELINE: '', AGENTMUX_RELAY_INPUT_MUTATION: '', AGENTMUX_RELAY_INPUT_PATTERN: '',
    AGENTMUX_TEST_METADATA_PACKAGE: '', AGENTMUX_TEST_METADATA_MUTANT: '', AGENTMUX_TEST_RPC_CORE_ENTRY: '', AGENTMUX_TEST_RPC_SERVICE_ENTRY: '',
    AGENTMUX_STATE_DIRECTORY: resolve(output, name + '-state'), AGENTMUX_RUNTIME_DIRECTORY: privateRuntime,
    AGENTMUX_MESSAGE_QUEUE_PATH: resolve(output, name + '-messages.ndjson')
  })
  const raw = JSON.parse(await readFile(report, 'utf8'))
  const tests = raw.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  const fact = { name, mutation: mutation ?? null, ...result, executed: tests.length,
    passed: raw.numPassedTests, failed: raw.numFailedTests,
    report: await artifact(report), loaded: await artifact(loaded), graph: await artifact(graph), log: await artifact(log) }
  receipt.rounds.push(fact)
  await verifyRound(fact)
}
async function verifyArtifact(value) {
  assert.deepEqual(await artifact(resolve(root, value.file)), value, 'Original evidence bytes changed')
}
async function verifyRound(fact) {
  const { mutation } = fact, related = fact.name === 'related', result = fact
  for (const key of ['report', 'loaded', 'graph', 'log']) await verifyArtifact(fact[key])
  const raw = JSON.parse(await readFile(resolve(root, fact.report.file), 'utf8')), rows = await ndjson(resolve(root, fact.loaded.file))
  const tests = raw.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.equal(fact.executed, tests.length); assert.equal(fact.passed, raw.numPassedTests); assert.equal(fact.failed, raw.numFailedTests)
  assert.equal(result.signal, null)
  assert.ok(tests.length > 0 && raw.numTotalTestSuites > 0, 'A collected empty set cannot pass')
  if (mutation) {
    assert.equal(result.exitCode, 1); assert.equal(tests.length, 1); assert.equal(raw.numFailedTests, 1)
    assert.match(tests[0].failureMessages.join('\n'), /AssertionError:/)
    const changed = rows.filter(row => row.phase === 'evaluated' && row.mutation === mutation)
    assert.ok(changed.length > 0, 'Mutation must execute in the actual producer')
    for (const row of changed) { assert.equal(row.originalSHA256, receipt.inputs[row.file]); assert.notEqual(row.loadedSHA256, row.originalSHA256) }
  } else {
    assert.equal(result.exitCode, 0); assert.equal(raw.success, true); assert.equal(raw.numFailedTests, 0)
    assert.ok(tests.every(test => test.status === 'passed'))
    if (related) {
      assert.ok(tests.length >= 25); assert.equal(raw.numPendingTests, 0)
      assert.ok(rows.some(row => row.phase === 'evaluated' && row.file === 'packages/core/src/space-session-owner.ts' && row.loadedSHA256 === receipt.inputs[row.file]))
      for (const suffix of ['hosted-control-availability.test.ts', 'hosted-metadata-opening.test.ts', 'hosted-session-scope.test.ts', 'space-sessions.test.ts', 'relay-host-identity.test.ts']) {
        const suite = raw.testResults.find(value => value.name.endsWith(suffix))
        assert.ok(suite && suite.assertionResults.some(test => test.status === 'passed'), 'Related original consumer must execute: ' + suffix)
      }
    } else {
      assert.equal(tests.length, 6)
      for (const file of ['packages/core/src/hosted-client.ts', 'packages/core/src/relay-hosted.ts', 'packages/core/src/hosted.ts',
        'packages/core/src/client-event-publisher.ts', 'packages/core/src/public-rpc-service.ts']) {
        assert.ok(rows.some(row => row.phase === 'evaluated' && row.file === file && row.loadedSHA256 === receipt.inputs[file]), 'Actual owner not evaluated: ' + file)
      }
    }
  }
  const graph = await ndjson(resolve(root, fact.graph.file)); assert.ok(graph.length > 0)
  for (const row of graph) {
    assert.equal(hash(await readFile(resolve(root, row.path))), row.originalSHA256, 'Loaded dependency changed: ' + row.path)
  }
  assert.deepEqual(await fingerprint(), receipt.inputs, 'Owned verification inputs changed')
}
const latest = resolve(root, '.tmp/hosted-exact-first-read/latest.json')
async function reuse() {
  let pointer
  try { pointer = JSON.parse(await readFile(latest, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  await verifyArtifact(pointer)
  const previous = JSON.parse(await readFile(resolve(root, pointer.file), 'utf8'))
  assert.equal(previous.passed, true)
  if (JSON.stringify(previous.inputs) !== JSON.stringify(receipt.inputs) || JSON.stringify(previous.conditions) !== JSON.stringify(receipt.conditions)) return false
  assert.deepEqual(previous.rounds.map(row => row.name), ['baseline', 'wait-catalog', 'revoke-control', 'false-empty', 'read-receipt-echo', 'late-owner', 'old-catalog-body', 'restored', 'related'])
  assert.deepEqual(previous.rounds.map(row => row.mutation), [null, 'wait-catalog', 'revoke-control', 'false-empty', 'read-receipt-echo', 'late-owner', 'old-catalog-body', null, null])
  for (const fact of previous.rounds) await verifyRound(fact)
  assert.equal(previous.typecheck.exitCode, 0); assert.equal(previous.typecheck.signal, null)
  await verifyArtifact(previous.typecheck.log)
  assert.deepEqual(await fingerprint(), receipt.inputs)
  receipt.rounds = previous.rounds
  receipt.reusedMatrix = pointer
  return true
}
try {
  if (!await reuse()) {
    await round('baseline')
    for (const mutation of ['wait-catalog', 'revoke-control', 'false-empty', 'read-receipt-echo', 'late-owner', 'old-catalog-body']) await round(mutation, mutation)
    await round('restored')
    await round('related', undefined, true)
  }
  // Workspace declarations are borrowed and can change outside the runtime
  // graph. Recheck the original production tsc rather than caching that claim.
  const log = resolve(output, 'production-types.log')
  const result = await command(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/core/tsconfig.build.json',
    '--tsBuildInfoFile', resolve(output, 'production-types.tsbuildinfo')], log)
  receipt.typecheck = { ...result, log: await artifact(log) }
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null)
  assert.deepEqual(await fingerprint(), receipt.inputs)
  receipt.passed = true
} catch (error) {
  receipt.passed = false; receipt.error = String(error?.stack ?? error); process.exitCode = 1
} finally {
  await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed && !receipt.reusedMatrix) {
    await writeFile(latest + '.tmp', JSON.stringify(await artifact(resolve(output, 'receipt.json'))) + '\n')
    await rename(latest + '.tmp', latest)
  }
  await rm(privateRuntime, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: relative(root, resolve(output, 'receipt.json')) }) + '\n')
}
