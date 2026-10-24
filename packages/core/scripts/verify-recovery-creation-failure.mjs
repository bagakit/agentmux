import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePath = 'packages/core/src/agent-session-recovery/lifecycle.ts'
const negativeReceipt = 'retains direct resume preparation for a foreign-operation negative receipt'
const restartRejected = 'an authoritative not-applied Start remains explicitly retryable'
const mutations = [
  { id: 'foreign-start-authorizes-retry', from: 'error.creationFailure?.operationId === lifecycleOperationId &&',
    to: 'error.creationFailure !== undefined &&', assertion: negativeReceipt },
  { id: 'input-receipt-authorizes-start-retry',
    from: "error.creationFailure?.operationId === lifecycleOperationId &&\n          error.creationFailure.disposition === 'not_applied'",
    to: "error.controlFailure?.disposition === 'not_applied'",
    assertion: 'retains direct resume preparation for a input-receipt negative receipt' },
  { id: 'unknown-start-authorizes-retry', from: "error.creationFailure.disposition === 'not_applied'",
    to: 'true', assertion: 'retains direct resume preparation for a unknown-start negative receipt' },
  { id: 'unknown-start-loses-storage-evidence', from: 'error instanceof AgentMuxError ? error.storageFailure : undefined)',
    to: 'undefined)', assertion: negativeReceipt },
  { id: 'unknown-start-loses-original-cause', from: "Object.defineProperty(failure, 'cause', { value: error })",
    to: 'void failure', assertion: negativeReceipt },
  { id: 'unknown-start-forgets-preparation',
    from: 'preserveUnconfirmedRun = true\n          const failure = new AgentMuxError(`Continue start is unconfirmed.',
    to: 'preserveUnconfirmedRun = false\n          const failure = new AgentMuxError(`Continue start is unconfirmed.', assertion: negativeReceipt },
  { id: 'restart-rejection-loses-storage-evidence', from: 'error.logId, error.creationFailure, error.storageFailure)',
    to: 'error.logId, error.creationFailure, undefined)', assertion: restartRejected },
  { id: 'restart-rejection-loses-original-cause', from: "Object.defineProperty(rejected, 'cause', { value: error })",
    to: 'void rejected', assertion: restartRejected }
]
const mutationIndex = process.argv.indexOf('--mutation')
const selected = mutationIndex < 0 ? mutations : mutations.filter(value => value.id === process.argv[mutationIndex + 1])
if (mutationIndex >= 0) assert.equal(selected.length, 1, '--mutation requires a known mutation ID')
const sha = value => createHash('sha256').update(value).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'amux-recovery-creation-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.recovery-creation-failure-proof.v1', passed: false,
  boundary: 'Actual source Core resume/reopen/restart and FileStore consumers. Direct resume/restart use private pinned Native processes; typed negative Start receipts are controlled at the adapter boundary. New Native/SDK artifact qualification belongs to the full integration gate. No user Runtime touched.',
  inputs: {}, baseline: null, mutations: [] }

async function run(name, mutation) {
  const report = join(directory, name + '.json'), config = join(directory, name + '.config.mts')
  const witness = join(directory, name + '.loaded.json')
  let plugin = ''
  if (mutation) {
    const source = await readFile(join(root, sourcePath), 'utf8')
    assert.equal(source.split(mutation.from).length, 2, mutation.id + ': unique owning source anchor required')
    const changed = source.replace(mutation.from, mutation.to)
    plugin = `plugins:[{name:'recovery-creation-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, sourcePath))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation source anchor unavailable');const next=code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)});writeFileSync(${JSON.stringify(witness)},JSON.stringify({source:sha(code),loaded:sha(next)}));return {code:next,map:null}}}}],`
    mutation.expectedLoaded = sha(changed)
  }
  await writeFile(config, `import { writeFileSync } from 'node:fs';import { createHash } from 'node:crypto';const sha=value=>createHash('sha256').update(value).digest('hex');import base from ${JSON.stringify(join(root, 'packages/core/test/recovery-creation-failure.config.mts'))};export default {...base,root:${JSON.stringify(root)},${plugin}test:{...base.test,${mutation ? 'testNamePattern:' + JSON.stringify(mutation.assertion) + ',' : ''}passWithNoTests:false,maxWorkers:1}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report],
      { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', (code, signal) => resolveRun({ code, signal, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(name + ': no valid report; infrastructure failure is not semantic RED. ' + result.output.slice(-4000)) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'An empty suite is not proof')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  assert.equal(result.signal, null, 'A killed process is not proof')
  const failures = assertions.filter(item => item.status === 'failed')
  let loaded
  if (mutation) {
    loaded = JSON.parse(await readFile(witness, 'utf8'))
    assert.equal(loaded.source, receipt.inputs[sourcePath]); assert.equal(loaded.loaded, mutation.expectedLoaded)
    assert.equal(result.code, 1, name + ': loaded mutation must fail. ' + result.output.slice(-4000))
    assert.ok(failures.some(item => item.fullName.includes(mutation.assertion) && item.failureMessages.some(message => /AssertionError|promise resolved|promise rejected/.test(message))),
      name + ': designated business assertion must fail, not collection or preparation. ' + JSON.stringify(failures) + result.output.slice(-4000))
  } else {
    assert.equal(result.code, 0, JSON.stringify(failures) + result.output.slice(-4000))
    assert.equal(data.numFailedTests, 0); assert.equal(data.numPassedTests, 14, 'All three recovery consumers must execute')
  }
  return { name, exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    reportSha256: sha(await readFile(report)), ...(mutation ? { source: sourcePath, loadedSha256: loaded.loaded,
      assertion: mutation.assertion, failures: failures.map(item => ({ name: item.fullName, messages: item.failureMessages })) } : {}) }
}

try {
  for (const path of [sourcePath, 'packages/core/test/durable-direct-resume.test.ts', 'packages/core/test/agent-session-restart.test.ts',
    'packages/core/test/retired-session-reopen.test.ts', 'packages/core/test/recovery-creation-failure.config.mts',
    'packages/core/scripts/verify-recovery-creation-failure.mjs']) receipt.inputs[path] = sha(await readFile(join(root, path)))
  receipt.baseline = await run('baseline')
  if (process.argv.includes('--mutations') || mutationIndex >= 0) for (const mutation of selected) receipt.mutations.push(await run(mutation.id, mutation))
  for (const [path, digest] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(join(root, path))), digest, 'Owned source changed; rerun proof: ' + path)
  receipt.passed = true
} finally {
  const at = process.argv.indexOf('--output')
  if (at >= 0) { assert.ok(process.argv[at + 1], '--output requires a path'); await writeFile(resolve(process.argv[at + 1]), JSON.stringify(receipt, null, 2) + '\n') }
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
