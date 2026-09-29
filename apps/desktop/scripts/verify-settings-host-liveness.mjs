import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidenceBase = resolve(root, '.bagakit/design/settings-followups-20261004/host-liveness-evidence/mutations')
const config = 'apps/desktop/scripts/fixtures/settings-host-liveness/vitest.config.mts'
const fixture = 'apps/desktop/test/settings-host-liveness.test.tsx'
const command = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const sourcePaths = [
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx'
]
const before = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
await mkdir(evidenceBase, { recursive: true })
const evidence = await mkdtemp(resolve(evidenceBase, 'run-'))
const proofPaths = [config, fixture, 'apps/desktop/scripts/verify-settings-host-liveness.mjs',
  'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'vitest.setup.ts']
const proofInputs = Object.fromEntries(await Promise.all(proofPaths.map(async path => {
  const bytes = await readFile(resolve(root, path)), snapshot = resolve(evidence, 'proof', path)
  await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
  return [path, hash(bytes)]
})))
let baselineInputs
const results = []

async function run(name, mutant, expectedOracle) {
  const output = resolve(evidence, name)
  await mkdir(output, { recursive: true })
  const args = ['exec', 'vitest', 'run', '--config', config, fixture,
    '--maxWorkers=1', '--reporter=json', '--outputFile', resolve(output, 'vitest.json')]
  const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false',
    AGENTMUX_HOST_LIVENESS_EVIDENCE: output, AGENTMUX_HOST_LIVENESS_MUTANT: mutant }
  let exitCode = 0, stdout = '', stderr = ''
  try {
    const value = await command('pnpm', args, { cwd: root, env, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 })
    stdout = value.stdout; stderr = value.stderr
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : -1
    stdout = error.stdout ?? ''; stderr = error.stderr ?? ''
  }
  await writeFile(resolve(output, 'run.log'), stdout + stderr)
  const report = await json(resolve(output, 'vitest.json'))
  assert.ok(report.numTotalTests > 0, `${name}: test collection must be nonempty`)
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0, `${name}: actual assertions must be collected`)
  const inputs = await json(resolve(output, 'source-inputs.json'))
  if (!baselineInputs) {
    baselineInputs = inputs
    for (const path of Object.keys(inputs)) {
      const snapshot = resolve(evidence, 'source', path)
      await mkdir(dirname(snapshot), { recursive: true })
      const bytes = await readFile(resolve(root, path))
      assert.equal(hash(bytes), inputs[path], `${name}: candidate source changed`)
      await writeFile(snapshot, bytes)
    }
  } else assert.deepEqual(inputs, baselineInputs, `${name}: all cases must consume the same source candidate`)
  const loaded = (await readFile(resolve(output, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0, `${name}: loaded-source collection must be nonempty`)
  for (const [path, originalHash] of Object.entries(inputs)) {
    const consumed = loaded.filter(value => value.path === path)
    assert.ok(consumed.length > 0, `${name}: actual source was not loaded: ${path}`)
    assert.ok(consumed.every(value => value.originalSHA256 === originalHash), `${name}: original source hash differs`)
  }
  const owning = await json(resolve(output, `owning-${mutant}.json`))
  assert.ok(owning.reports.length > 0, `${name}: runtime collection must be nonempty`)
  let oracle
  if (expectedOracle) {
    assert.notEqual(exitCode, 0, `${name}: source mutant remained GREEN`)
    const failed = assertions.filter(value => value.status === 'failed' && expectedOracle.test(value.fullName))
    assert.ok(failed.length > 0, `${name}: the owning behavior oracle did not fail`)
    assert.ok(failed.some(value => value.failureMessages.some(message => message.includes('AssertionError'))),
      `${name}: setup/compile/TypeError does not prove behavior RED`)
    oracle = failed.map(value => value.fullName)
  } else {
    assert.equal(exitCode, 0, `${name}: baseline/restore must be GREEN; see ${output}/run.log`)
    assert.equal(report.numFailedTests, 0)
    assert.equal(owning.reports.length, 9)
    assert.ok(owning.reports.every(value => value.passed), `${name}: all nonempty behavior cases must pass`)
    const matrices = owning.reports.filter(value => value.case === 'inactive-liveness')
    assert.equal(matrices.length, 6)
    assert.ok(matrices.every(value => value.positive.hostSessionPredicateVisits > 0), `${name}: active positive work must be nonempty`)
    assert.equal(owning.reports.filter(value => value.case.startsWith('main-guard-')).length, 2)
  }
  results.push({ name, mutant, exitCode, collectedTests: report.numTotalTests, oracle,
    inputs, loadedSourceSHA256: hash(await readFile(resolve(output, 'loaded-source.jsonl'))),
    vitestSHA256: hash(await readFile(resolve(output, 'vitest.json'))),
    owningSHA256: hash(await readFile(resolve(output, `owning-${mutant}.json`))) })
  console.log(`${name}: ${expectedOracle ? 'AssertionRED' : 'GREEN'} (${report.numTotalTests} collected)`)
}

await run('baseline', 'baseline')
if (process.argv.includes('--mutations')) {
  await run('module-active', 'module-active', /inactive liveness/u)
  await run('sessions-live', 'sessions-live', /inactive liveness/u)
  await run('checks-live', 'checks-live', /inactive liveness/u)
  await run('frozen-hidden-baseline', 'frozen-hidden-baseline', /hidden config baseline/u)
  await run('restored', 'baseline')
}
const after = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
assert.deepEqual(after, before, 'Actual Main product source bytes must never be mutated')
const proofAfter = Object.fromEntries(await Promise.all(proofPaths.map(async path => [path, hash(await readFile(resolve(root, path)))])))
assert.deepEqual(proofAfter, proofInputs, 'Proof source/config bytes must remain the qualified candidate')
const receipt = { schema: 'agentmux.host-liveness-source-mutations.v1', completed: true,
  sourceIdentity: hash(JSON.stringify(baselineInputs)), originalProductSource: before, exactSourceAfter: after,
  proofInputs, evidenceDirectory: evidence, sourceWriterUsed: false, mutationsInVitestTransformOnly: true, results }
await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await writeFile(resolve(evidenceBase, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(`receipt: ${resolve(evidence, 'receipt.json')}`)
