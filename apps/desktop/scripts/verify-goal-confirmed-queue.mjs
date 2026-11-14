import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { goalConfirmedDispatchMutations as mutations } from '../test/goal-confirmed-dispatch-mutations.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({ options: { evidence: { type: 'string' } } })
assert.ok(values.evidence, 'Supply --evidence DIR for this proof output.')
const evidence = resolve(values.evidence), config = 'apps/desktop/test/vitest.goal-confirmed-dispatch.config.mts'
mkdirSync(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = path => readFileSync(join(repository, path))
const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const workerSource = 'packages/core/src/control-endpoint-listener-worker.ts', worker = join(evidence, 'control-endpoint-listener-worker.mjs')
await build({ entryPoints: [join(repository, workerSource)], outfile: worker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
assert.ok(mutations.length > 0, 'A nonempty current production mutation set is required.')
const files = [...new Set([config, workerSource, 'apps/desktop/scripts/verify-goal-confirmed-queue.mjs',
  'apps/desktop/test/goal-confirmed-dispatch-product.test.ts', 'apps/desktop/test/goal-confirmed-dispatch-mutations.mjs',
  'apps/desktop/test/helpers/host-goal-transport.ts', 'apps/desktop/test/helpers/injected-context-core.ts',
  'apps/host/test/goal-cross-host-node-loader.mjs', ...mutations.map(item => item.path)])]
const candidate = Object.fromEntries(files.map(path => [path, hash(source(path))]))
const unchanged = () => { for (const [path, digest] of Object.entries(candidate)) assert.equal(hash(source(path)), digest, 'Proof candidate changed: ' + path) }
const exact = value => '^' + value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'
function run(name, mutation, oracle) {
  unchanged()
  const report = join(evidence, name + '.json'), loaded = join(evidence, name + '.loaded.jsonl'), cli = join(evidence, name + '.cli-loaded.jsonl')
  writeFileSync(loaded, ''); writeFileSync(cli, '')
  const env = { ...process.env, AGENTMUX_PRIVATE_LISTENER_ASSET: worker, GOAL_CONFIRMED_DISPATCH_LOADED: loaded, GOAL_PLAN_DISCOVERY_CLI_LOADED: cli }
  delete env.GOAL_CONFIRMED_DISPATCH_MUTANT; delete env.GOAL_PLAN_DISCOVERY_MUTANT; delete env.GOAL_PLAN_REQUEST_MUTANT
  if (mutation) env.GOAL_CONFIRMED_DISPATCH_MUTANT = JSON.stringify(mutation)
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', '--outputFile', report, ...(oracle ? ['--testNamePattern', exact(oracle)] : [])], { cwd: repository, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 << 20 })
  writeFileSync(join(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, 'The original test process must complete.')
  const bytes = readFileSync(report), value = JSON.parse(bytes)
  assert.equal(value.numRuntimeErrorTestSuites ?? 0, 0, 'Loading failures cannot qualify.')
  const ran = value.testResults.flatMap(file => file.assertionResults).filter(row => !['pending', 'skipped', 'todo'].includes(row.status))
  assert.ok(ran.length > 0, 'The current public owner suite must execute nonempty tests.')
  if (oracle) { assert.equal(ran.length, 1); assert.equal(ran[0].fullName, oracle) }
  const rows = readFileSync(loaded, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (mutation) {
    assert.ok(Number.isInteger(result.status) && result.status !== 0); assert.equal(ran[0].status, 'failed')
    assert.ok(ran[0].failureMessages.some(message => /AssertionError|expected|instead of rejecting/u.test(message)), 'Infrastructure errors are not semantic RED.')
    assert.ok(rows.some(row => row.path === mutation.path && row.mutation === mutation.id && row.originalSHA256 !== row.loadedSHA256), 'The mutated original owner must evaluate.')
  } else {
    assert.equal(result.status, 0); assert.ok(ran.every(row => row.status === 'passed'))
    if (!oracle) {
      assert.equal(value.numPendingTests, 0)
      assert.ok(readFileSync(cli, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row => row.path === 'packages/core/src/agentmux.ts' && row.consumer === 'public-cli'), 'The actual Source CLI must run.')
    }
  }
  unchanged()
  const proof = { name, report, reportSHA256: hash(bytes), executed: ran.length, failed: value.numFailedTests, loaded: rows, ...(oracle ? { oracle } : {}) }
  console.log(JSON.stringify({ name, executed: ran.length, failed: value.numFailedTests })); return proof
}
const receipt = { schema: 'agentmux.goal-confirmed-queue.proof.v2', passed: false, candidate,
  scope: 'Current actual Source CLI/public Unix RPC and Renderer Goal consumer → original Host Start/Dispatch/Demand → real Core, with controlled Native byte I/O. Original manual drafts/queues/Run retained. The removed Renderer clear mechanism is not recreated.',
  baseline: run('baseline'), mutations: [], userRunTouched: false, sharedTreeMutations: 0 }
for (const mutation of mutations) {
  let current = source(mutation.path).toString()
  for (const edit of mutation.edits ?? [mutation]) {
    assert.equal(current.split(edit.anchor).length, 2, 'One exact current owner anchor is required: ' + mutation.id)
    current = current.replace(edit.anchor, () => edit.replacement)
  }
  receipt.mutations.push({ ...mutation, red: run(mutation.id + '-red', mutation, mutation.oracle), restored: run(mutation.id + '-restored', undefined, mutation.oracle) })
}
unchanged(); receipt.passed = true
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, evidence, mutations: receipt.mutations.length }))
