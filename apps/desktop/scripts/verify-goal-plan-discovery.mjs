import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const evidence = resolve(repository, '.bagakit/feature-tracker/goal-plan-discovery-artifacts/consumer-proof')
const config = 'apps/desktop/test/vitest.goal-plan-discovery.config.mts'
const incremental = process.argv[2] === 'recovery'
assert.ok(process.argv.length === 2 || process.argv.length === 3 && incremental, 'Select the complete gate or its finite recovery increment; no test selectors')
mkdirSync(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const workerSource = 'packages/core/src/control-endpoint-listener-worker.ts', worker = join(evidence, 'control-endpoint-listener-worker.mjs')
if (!incremental) await build({ entryPoints: [resolve(repository, workerSource)], outfile: worker, platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' })
const listenerAsset = { source: workerSource, sourceSHA256: hash(readFileSync(resolve(repository, workerSource))), compiledSHA256: hash(readFileSync(worker)) }
const mutations = [
  { id: 'planning-callback-opens-only', path: 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx',
    anchor: 'const tabId = mode ? await requestDemandPmoTask(demandId, mode) : await openDemandPmo(demandId)',
    replacement: 'const tabId = await openDemandPmo(demandId)' },
  { id: 'planning-input-is-an-open-request', path: 'apps/host/src/goal-discussions.ts',
    anchor: 'Make a plan for this existing Goal: ${goal.id}.', replacement: 'Open this existing Goal only: ${goal.id}.' },
  { id: 'saved-plan-dropped-before-renderer', path: 'apps/host/src/goal-projection.ts',
    anchor: '...(goal.plan ? { plan: goal.plan } : {}),', replacement: '...{},' },
  { id: 'unknown-planning-reference-is-replaced', path: 'apps/desktop/src/renderer/src/store.ts',
    anchor: 'const held = key === null ? undefined : useAppStore.getState().goalDiscussionRequests[key]', replacement: 'const held = undefined' }
]
function run(id, mutant) {
  const directory = join(evidence, id); mkdirSync(directory, { recursive: true })
  const loadedPath = join(directory, 'loaded.jsonl'), cliPath = join(directory, 'cli-loaded.jsonl'), resultPath = join(directory, 'result.json')
  writeFileSync(loadedPath, ''); writeFileSync(cliPath, '')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile', resultPath], {
    cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GOAL_PLAN_DISCOVERY_LOADED: loadedPath, GOAL_PLAN_DISCOVERY_CLI_LOADED: cliPath,
      GOAL_PLAN_DISCOVERY_EVIDENCE: directory, AGENTMUX_PRIVATE_LISTENER_ASSET: worker, ...(mutant ? { GOAL_PLAN_DISCOVERY_MUTANT: JSON.stringify(mutant) } : {}) }
  })
  writeFileSync(join(directory, 'console.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, 'The actual test process must complete')
  const json = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(json.numTotalTests, 6, 'The complete finite consumer must run; empty selections cannot pass')
  const loaded = readFileSync(loadedPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const path of ['apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
    'apps/host/src/goal-discussions.ts', 'apps/host/src/goal-projection.ts', 'packages/demand/src/demand-store.ts'])
    assert.ok(loaded.some(row => row.path === path), 'The real owner must be evaluated: ' + path)
  if (mutant) {
    assert.ok(result.status !== 0 && result.status !== null && json.numFailedTests > 0, 'The loaded mutation must fail a real consumer')
    assert.ok(json.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))), 'A collection or process failure cannot prove a mutation')
    assert.ok(loaded.some(row => row.path === mutant.path && row.mutant === mutant.id && row.loadedSHA256 !== row.originalSHA256), 'The mutated source must actually evaluate')
  } else {
    assert.equal(result.status, 0); assert.equal(json.numPassedTests, 6); assert.equal(json.numFailedTests, 0)
    const cli = readFileSync(cliPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(cli.some(row => row.path === 'packages/core/src/agentmux.ts' && row.consumer === 'public-cli'), 'The actual amux CLI must evaluate its original source')
    assert.equal(json.numPendingTests, 0)
  }
  return { id, status: result.status, total: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests,
    resultSHA256: hash(readFileSync(resultPath)), loaded, ...(mutant ? { mutation: mutant } : {}) }
}
const mutate = mutant => {
  assert.equal(readFileSync(resolve(repository, mutant.path), 'utf8').split(mutant.anchor).length, 2, 'One original mutation anchor is required: ' + mutant.id)
  return run(mutant.id, mutant)
}
let baseline, mutants
if (incremental) {
  const previous = JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8'))
  assert.equal(previous.success, true); assert.equal(previous.baseline.passed, 6); assert.equal(previous.restored.passed, 6)
  assert.deepEqual(previous.mutants.map(item => item.id), mutations.slice(0, -1).map(item => item.id), 'Reuse only the exact three completed mutations')
  for (const [path, sha256] of Object.entries(previous.sources)) assert.equal(hash(readFileSync(resolve(repository, path))), sha256, 'A changed owner invalidates reused evidence: ' + path)
  assert.deepEqual(previous.listenerAsset, listenerAsset, 'The exact original private listener asset must be reused')
  writeFileSync(join(evidence, 'prior-receipt.json'), JSON.stringify(previous, null, 2) + '\n')
  baseline = previous.baseline; mutants = [...previous.mutants, mutate(mutations.at(-1))]
} else { baseline = run('baseline'); mutants = mutations.map(mutate) }
const restored = run('restored')
const sources = Object.fromEntries([...new Set(baseline.loaded.map(row => row.path))].map(path => [path, hash(readFileSync(resolve(repository, path)))]))
for (const run of [baseline, restored]) for (const row of run.loaded)
  assert.equal(row.originalSHA256, sources[row.path], 'The evaluated candidate changed during proof: ' + row.path)
const receipt = { schema: 'agentmux.goal-plan-discovery-consumer-proof.v1', success: true, scope: 'Mounted production UI to original Unix Host, Core input and Domain file. Public amux CLI plan producer; controlled Native I/O, no model or Native daemon. No live Goals touched.',
  sources, listenerAsset, baseline, mutants, restored, harness: Object.fromEntries(['apps/desktop/test/goal-plan-discovery-product.test.tsx', config,
    'apps/desktop/scripts/verify-goal-plan-discovery.mjs'].map(path => [path, hash(readFileSync(resolve(repository, path)))])) }
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ schema: receipt.schema, success: true, baseline: baseline.passed, mutations: mutants.length, restored: restored.passed, evidence }))
