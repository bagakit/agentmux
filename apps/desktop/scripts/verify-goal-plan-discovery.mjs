import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { goalPlanRequestMutations } from '../test/goal-plan-request-mutations.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({ options: { evidence: { type: 'string' } } })
assert.ok(values.evidence, 'Supply --evidence DIR for this proof output.')
const evidence = resolve(values.evidence)
const config = 'apps/desktop/test/vitest.goal-plan-request.config.mts'
const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = value => createHash('sha256').update(value).digest('hex')
const read = path => readFileSync(resolve(repository, path))
mkdirSync(evidence, { recursive: true })
const workerSource = 'packages/core/src/control-endpoint-listener-worker.ts', worker = join(evidence, 'control-endpoint-listener-worker.mjs')
// Compile this candidate, including dependencies, so output may live outside the checkout.
await build({ entryPoints: [resolve(repository, workerSource)], outfile: worker, platform: 'node', target: 'node24', format: 'esm', bundle: true, logLevel: 'silent' })
const listenerAsset = { source: workerSource, sourceSHA256: hash(read(workerSource)), compiledSHA256: hash(readFileSync(worker)) }
const mutations = [
  ...goalPlanRequestMutations.map(({ name, ...mutation }) => ({ ...mutation, id: name, port: 'request' })),
  { id: 'planning-callback-opens-only', path: 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx',
    anchor: 'const tabId = mode ? await requestDemandPmoTask(demandId, mode) : await openDemandPmo(demandId)',
    replacement: 'const tabId = await openDemandPmo(demandId)', port: 'discovery',
    oracle: 'a planning input reaches the Supervisor and only its saved public plan replaces the real empty Goal with the owner DAG' },
  { id: 'saved-plan-dropped-before-renderer', path: 'apps/host/src/goal-projection.ts',
    anchor: '...hostGoalPlan(goal),', replacement: '...{},', port: 'discovery',
    oracle: 'the original Goal record reaches the store and mounted graph before a delegation observer can repair it' },
  { id: 'unknown-planning-reference-is-replaced', path: 'apps/desktop/src/renderer/src/store.ts',
    anchor: 'const held = key === null ? undefined : useAppStore.getState().goalDiscussionRequests[key]', replacement: 'const held = undefined', port: 'discovery',
    oracle: 'lost planning receipt retains the original request through Renderer rehydrate without repeating input' }
]
assert.ok(goalPlanRequestMutations.length > 0 && mutations.length > goalPlanRequestMutations.length, 'Current routing and original consumer counterexamples are nonempty.')
assert.equal(new Set(mutations.map(item => item.id)).size, mutations.length)
const harness = [config, 'apps/desktop/test/vitest.goal-plan-discovery.config.mts', 'apps/desktop/test/goal-plan-request-mutations.mjs',
  'apps/desktop/test/goal-plan-discovery-product.test.tsx', 'apps/desktop/test/helpers/host-goal-discussion-fixture.ts',
  'apps/desktop/test/helpers/injected-context-core.ts', 'apps/desktop/test/helpers/isolate-core-environment.ts',
  'apps/desktop/scripts/fixtures/demand-current-work/vitest.config.mts', 'apps/desktop/scripts/verify-goal-plan-discovery.mjs', workerSource]
const sources = Object.fromEntries([...new Set([...harness, ...mutations.map(item => item.path)])].sort().map(path => [path, hash(read(path))]))
const unchanged = () => { for (const [path, digest] of Object.entries(sources)) assert.equal(hash(read(path)), digest, 'Proof candidate changed: ' + path) }
const exact = value => '^' + value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'
const rows = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
function run(id, { mutant, oracle } = {}) {
  unchanged()
  const directory = join(evidence, id); mkdirSync(directory, { recursive: true })
  const loadedPath = join(directory, 'loaded.jsonl'), requestPath = join(directory, 'request-loaded.jsonl')
  const cliPath = join(directory, 'cli-loaded.jsonl'), resultPath = join(directory, 'result.json')
  for (const path of [loadedPath, requestPath, cliPath]) writeFileSync(path, '')
  const env = { ...process.env, GOAL_PLAN_DISCOVERY_LOADED: loadedPath, GOAL_PLAN_REQUEST_LOADED: requestPath,
    GOAL_PLAN_DISCOVERY_CLI_LOADED: cliPath, GOAL_PLAN_DISCOVERY_EVIDENCE: directory, AGENTMUX_PRIVATE_LISTENER_ASSET: worker }
  delete env.GOAL_PLAN_DISCOVERY_MUTANT; delete env.GOAL_PLAN_REQUEST_MUTANT
  if (mutant) env[mutant.port === 'request' ? 'GOAL_PLAN_REQUEST_MUTANT' : 'GOAL_PLAN_DISCOVERY_MUTANT'] = JSON.stringify(mutant)
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', '--outputFile', resultPath, ...(oracle ? ['--testNamePattern', exact(oracle)] : [])], {
    cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env
  })
  writeFileSync(join(directory, 'console.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, 'The actual test process must complete: ' + id)
  const json = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(json.numRuntimeErrorTestSuites ?? 0, 0, 'Collection/load failures are not semantic proof: ' + id)
  const executed = json.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
  assert.ok(executed.length > 0, 'The current suite must execute nonempty tests: ' + id)
  if (oracle) { assert.equal(executed.length, 1); assert.equal(executed[0].fullName, oracle) }
  const loaded = rows(loadedPath), requestLoaded = rows(requestPath)
  if (mutant) {
    assert.ok(Number.isInteger(result.status) && result.status !== 0, 'The mutation must fail a real consumer: ' + id)
    assert.equal(executed[0].status, 'failed')
    assert.ok(executed[0].failureMessages.some(message => /AssertionError|expected|instead of rejecting/u.test(message)), 'Infrastructure failure is not semantic RED: ' + id)
    const ownerRows = mutant.port === 'request' ? requestLoaded : loaded
    assert.ok(ownerRows.some(row => row.path === mutant.path && row.mutant === mutant.id && row.loadedSHA256 !== row.originalSHA256), 'The mutated owner must evaluate: ' + id)
  } else {
    assert.equal(result.status, 0, 'The current candidate must pass: ' + id)
    assert.ok(executed.every(test => test.status === 'passed'))
    if (!oracle) {
      assert.equal(json.numPendingTests, 0); assert.equal(json.numPassedTests, json.numTotalTests)
      for (const path of ['apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
        'apps/host/src/goal-discussions.ts', 'apps/host/src/goal-projection.ts', 'packages/demand/src/demand-store.ts'])
        assert.ok(loaded.some(row => row.path === path), 'The real owner must evaluate: ' + path)
      assert.ok(rows(cliPath).some(row => row.path === 'packages/core/src/agentmux.ts' && row.consumer === 'public-cli'), 'The actual public CLI must evaluate its source.')
      for (const row of loaded) {
        assert.equal(row.originalSHA256, hash(read(row.path)), 'The source-loaded owner changed: ' + row.path)
        sources[row.path] = row.originalSHA256
      }
    }
  }
  unchanged()
  const proof = { id, status: result.status, total: json.numTotalTests, executed: executed.length, passed: json.numPassedTests, failed: json.numFailedTests,
    resultSHA256: hash(readFileSync(resultPath)), loaded, requestLoaded, ...(oracle ? { oracle } : {}), ...(mutant ? { mutation: mutant } : {}) }
  console.log(JSON.stringify({ id, executed: proof.executed, passed: proof.passed, failed: proof.failed }))
  return proof
}
const baseline = run('baseline'), mutants = []
for (const mutant of mutations) {
  let source = read(mutant.path).toString()
  for (const edit of mutant.edits ?? [mutant]) {
    assert.equal(source.split(edit.anchor).length, 2, 'One exact current mutation anchor is required: ' + mutant.id)
    source = source.replace(edit.anchor, () => edit.replacement)
  }
  assert.notEqual(hash(source), sources[mutant.path])
  const red = run(mutant.id + '-red', { mutant, oracle: mutant.oracle })
  const restored = run(mutant.id + '-restored', { oracle: mutant.oracle })
  mutants.push({ ...mutant, red, restored })
}
unchanged()
assert.equal(hash(read(workerSource)), listenerAsset.sourceSHA256); assert.equal(hash(readFileSync(worker)), listenerAsset.compiledSHA256)
const receipt = { schema: 'agentmux.goal-plan-discovery-consumer-proof.v2', success: true,
  scope: 'Current mounted production UI, original Unix Host/Core/Demand, actual source public CLI. Controlled Native I/O; no live user Goal or installed Native/restart claim.',
  sources, listenerAsset, baseline, mutants, restored: mutants.map(item => item.restored), sharedTreeMutations: 0 }
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ schema: receipt.schema, success: true, baseline: baseline.passed, mutations: mutants.length, evidence }))
