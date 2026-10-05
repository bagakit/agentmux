import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.env.AGENTMUX_EDITOR_FORMAT_EVIDENCE ?? join(root, '.bagakit/editor-format-implementation/evidence'))
const directory = join(evidence, 'control-listener-lifecycle')
const publication = 'packages/core/src/control-endpoint-publication.ts'
const worker = 'packages/core/src/control-endpoint-listener-worker.ts'
const tests = ['packages/core/test/control-endpoint-publication.integration.test.ts',
  'packages/core/test/control-endpoint-publication.test.ts', 'packages/core/test/control-endpoint-socket-handoff.test.ts']
const config = 'apps/desktop/test/control-listener-lifecycle.config.mts'
const inputs = [publication, worker, ...tests, config,
  'packages/core/test/fixtures/control-endpoint-publication-worker.mjs',
  'apps/desktop/scripts/verify-control-listener-lifecycle.mjs',
  'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(join(root, file)))])))
const mutationPath = join(evidence, 'control-listener-mutations/receipt.json')
const check = process.argv.includes('--check')
const originalReceipts = process.env.AGENTMUX_MUTATION_RECEIPTS
// This additional transport closure has its own exact receipt, separate from T001-T017.
if (check || process.env.AGENTMUX_CONTROL_LISTENER_RECEIPT) process.env.AGENTMUX_MUTATION_RECEIPTS = JSON.stringify([
  process.env.AGENTMUX_CONTROL_LISTENER_RECEIPT ?? mutationPath])
else delete process.env.AGENTMUX_MUTATION_RECEIPTS
try {
  await verifyRendererSourceMutations({ name: 'control-listener-mutations', evidenceRoot: evidence,
    tests: [tests[2]], sources: [publication, worker], owningConfig: config,
    mutations: [
      { label: 'closed-socket-is-not-listener-death', file: publication,
        before: '(handle instanceof Socket || handle == null)', after: 'handle instanceof Socket' },
      { label: 'dead-listener-must-republish', file: publication,
        before: 'if (this.current.alive) {', after: 'if (true) {' },
      { label: 'failed-link-must-release-owned-canonical', file: publication,
        before: 'await this.discard(listener, true) } catch (cleanup)', after: 'await this.discard(listener, false) } catch (cleanup)' }
    ] })
} finally {
  if (originalReceipts === undefined) delete process.env.AGENTMUX_MUTATION_RECEIPTS
  else process.env.AGENTMUX_MUTATION_RECEIPTS = originalReceipts
}
if (process.argv.includes('--mutations-only')) process.exit(0)

const run = async (command, args) => new Promise((yes, no) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, output }))
})
const nativePath = join(evidence, 'control-listener-native/receipt.json')
const verifyNative = async () => {
  const result = await run(process.execPath, ['apps/desktop/scripts/verify-control-listener-native.mjs', '--check', '--output=' + dirname(nativePath)])
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
}
const verifyNode = log => {
  assert.match(log, /Tests\s+18 passed/); assert.match(log, /Test Files\s+3 passed/)
  assert.doesNotMatch(log, /Tests\s+\d+ failed|Unhandled Errors/)
  for (const file of tests) assert.ok(log.includes(file), 'Actual original/new Node consumer: ' + file)
  const capacity = JSON.parse(log.split('\n').find(line => line.startsWith('{"socketHandoffBudget":')))
  assert.equal(capacity.socketHandoffBudget, 64); assert.equal(capacity.transferredAtCapacity, 64)
  assert.equal(capacity.overflowClosed, true); assert.equal(capacity.recovered, true); assert.equal(capacity.existingConnectionsPreserved, true)
  assert.ok(capacity.idleRssKiB > 0 && capacity.fullRssKiB > 0 && capacity.burstMs > 0)
  return capacity
}
await verifyNative()
if (check) {
  const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
  assert.equal(receipt.passed, true); assert.deepEqual(receipt.sourceBefore, await hashes()); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  const log = await readFile(join(directory, 'node.log'), 'utf8')
  assert.equal(receipt.node.logSha256, sha(log)); assert.deepEqual(receipt.node.capacity, verifyNode(log))
  assert.equal(receipt.node.code, 0); assert.equal(receipt.node.signal, null)
  assert.equal(receipt.nativeSha256, sha(await readFile(nativePath)))
  assert.equal(receipt.mutationsSha256, sha(await readFile(mutationPath)))
} else {
  await mkdir(directory, { recursive: true })
  const sourceBefore = await hashes(), result = await run('pnpm', ['exec', 'vitest', 'run', ...tests, '--maxWorkers=1'])
  await writeFile(join(directory, 'node.log'), result.output)
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  const capacity = verifyNode(result.output), sourceAfter = await hashes()
  assert.deepEqual(sourceAfter, sourceBefore)
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.control-listener-lifecycle.v1', passed: true,
    sourceBefore, sourceAfter, node: { code: result.code, signal: result.signal, logSha256: sha(result.output), capacity },
    nativeSha256: sha(await readFile(nativePath)), mutationsSha256: sha(await readFile(mutationPath)) }, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, exactLoadedMutants: 3, actualNodeConsumers: 18, nativeHistoricalCounterexample: true, receipt: join(directory, 'receipt.json') }))
