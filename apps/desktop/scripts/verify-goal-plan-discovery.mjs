import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
// Original six- and eight-case proofs remain immutable. The bounded increment
// adds one pending-origin consumer while retaining their exact scope and hashes.
const pendingOnly = process.argv[2] === 'pending-origin'
const evidence = resolve(repository, '.bagakit/feature-tracker/goal-plan-discovery-artifacts/', pendingOnly ? 'consumer-pending-origin-proof' : 'consumer-legacy-complete-proof')
const legacyProof = resolve(repository, '.bagakit/feature-tracker/goal-plan-discovery-artifacts/consumer-legacy-proof')
const config = 'apps/desktop/test/vitest.goal-plan-discovery.config.mts'
assert.ok(process.argv.length === 2 || process.argv.length === 3 && pendingOnly, 'Select the complete gate or its finite pending-origin increment; no test selectors')
mkdirSync(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const workerSource = 'packages/core/src/control-endpoint-listener-worker.ts', worker = join(evidence, 'control-endpoint-listener-worker.mjs')
const originalProof = resolve(repository, '.bagakit/feature-tracker/goal-plan-discovery-artifacts/consumer-proof')
const originalWorker = join(originalProof, 'control-endpoint-listener-worker.mjs')
if (existsSync(join(originalProof, 'receipt.json')) && existsSync(originalWorker)) {
  const original = JSON.parse(readFileSync(join(originalProof, 'receipt.json'), 'utf8')).listenerAsset
  assert.equal(hash(readFileSync(resolve(repository, workerSource))), original.sourceSHA256, 'Reuse only the unchanged original listener owner')
  const bytes = readFileSync(originalWorker); assert.equal(hash(bytes), original.compiledSHA256)
  writeFileSync(worker, bytes)
} else {
  assert.equal(pendingOnly, false, 'The bounded increment must reuse the original listener asset')
  await build({ entryPoints: [resolve(repository, workerSource)], outfile: worker, platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' })
}
const listenerAsset = { source: workerSource, sourceSHA256: hash(readFileSync(resolve(repository, workerSource))), compiledSHA256: hash(readFileSync(worker)) }
const mutations = [
  { id: 'planning-callback-opens-only', path: 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx',
    anchor: 'const tabId = mode ? await requestDemandPmoTask(demandId, mode) : await openDemandPmo(demandId)',
    replacement: 'const tabId = await openDemandPmo(demandId)' },
  { id: 'planning-input-is-an-open-request', path: 'apps/host/src/goal-discussions.ts',
    anchor: 'Make a plan for this existing Goal: ${goal.id}.', replacement: 'Open this existing Goal only: ${goal.id}.' },
  { id: 'saved-plan-dropped-before-renderer', path: 'apps/host/src/goal-projection.ts',
    anchor: '...hostGoalPlan(goal),', replacement: '...{},' },
  { id: 'unknown-planning-reference-is-replaced', path: 'apps/desktop/src/renderer/src/store.ts',
    anchor: 'const held = key === null ? undefined : useAppStore.getState().goalDiscussionRequests[key]', replacement: 'const held = undefined' }
]
function run(id, mutant) {
  const directory = join(evidence, id); mkdirSync(directory, { recursive: true })
  const loadedPath = join(directory, 'loaded.jsonl'), cliPath = join(directory, 'cli-loaded.jsonl'), resultPath = join(directory, 'result.json')
  writeFileSync(loadedPath, ''); writeFileSync(cliPath, '')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', config, '--reporter=json', '--outputFile', resultPath,
    ...(pendingOnly ? ['-t', '^legacy pending creation origin remains pending through real planning input and the saved graph$'] : [])], {
    cwd: repository, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GOAL_PLAN_DISCOVERY_LOADED: loadedPath, GOAL_PLAN_DISCOVERY_CLI_LOADED: cliPath,
      GOAL_PLAN_DISCOVERY_EVIDENCE: directory, AGENTMUX_PRIVATE_LISTENER_ASSET: worker, ...(mutant ? { GOAL_PLAN_DISCOVERY_MUTANT: JSON.stringify(mutant) } : {}) }
  })
  writeFileSync(join(directory, 'console.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined, 'The actual test process must complete')
  const json = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(json.numTotalTests, 9, 'The complete finite consumer must be discovered; empty selections cannot pass')
  const loaded = readFileSync(loadedPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const path of ['apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
    'apps/host/src/goal-discussions.ts', 'apps/host/src/goal-projection.ts', 'packages/demand/src/demand-store.ts'])
    assert.ok(loaded.some(row => row.path === path), 'The real owner must be evaluated: ' + path)
  if (mutant) {
    assert.ok(result.status !== 0 && result.status !== null && json.numFailedTests > 0, 'The loaded mutation must fail a real consumer')
    assert.ok(json.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError/u.test(message))), 'A collection or process failure cannot prove a mutation')
    assert.ok(loaded.some(row => row.path === mutant.path && row.mutant === mutant.id && row.loadedSHA256 !== row.originalSHA256), 'The mutated source must actually evaluate')
  } else {
    assert.equal(result.status, 0); assert.equal(json.numPassedTests, pendingOnly ? 1 : 9); assert.equal(json.numFailedTests, 0)
    const cli = readFileSync(cliPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(cli.some(row => row.path === 'packages/core/src/agentmux.ts' && row.consumer === 'public-cli'), 'The actual amux CLI must evaluate its original source')
    assert.equal(json.numPendingTests, pendingOnly ? 8 : 0)
  }
  return { id, status: result.status, total: json.numTotalTests, passed: json.numPassedTests, failed: json.numFailedTests,
    resultSHA256: hash(readFileSync(resultPath)), loaded, ...(mutant ? { mutation: mutant } : {}) }
}
const mutate = mutant => {
  assert.equal(readFileSync(resolve(repository, mutant.path), 'utf8').split(mutant.anchor).length, 2, 'One original mutation anchor is required: ' + mutant.id)
  return run(mutant.id, mutant)
}
if (pendingOnly) {
  const originalBytes = readFileSync(join(legacyProof, 'receipt.json')), original = JSON.parse(originalBytes)
  assert.equal(original.success, true); assert.equal(original.baseline.passed, 8); assert.equal(original.restored.passed, 8); assert.equal(original.mutants.length, 4)
  const reviewPath = join(evidence, 'source-reuse-review.json'), reviewedTransitions = []
  const review = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')) : undefined
  for (const [path, sha256] of Object.entries(original.sources)) if (!path.startsWith('apps/desktop/test/')) {
    const currentSHA256 = hash(readFileSync(resolve(repository, path)))
    if (currentSHA256 === sha256) continue
    assert.equal(review?.schema, 'agentmux.goal-plan-reviewed-peer-source-transition.v1', 'Changed product source invalidates bounded reuse: ' + path)
    assert.equal(review.transitions.length, 2, 'The bounded increment allows only its explicitly reviewed paired peer transition')
    const transition = review.transitions.find(item => item.path === path && item.oldSHA256 === sha256 && item.newSHA256 === currentSHA256)
    assert.ok(transition, 'Unreviewed product drift invalidates bounded reuse: ' + path)
    assert.equal(hash(readFileSync(resolve(repository, transition.diffPath))), transition.diffSHA256)
    for (const [commit, expected] of [[review.baseCommit, sha256], [review.peerCommit, currentSHA256]]) {
      const blob = spawnSync('git', ['show', commit + ':' + path], { cwd: repository })
      assert.equal(blob.status, 0); assert.equal(hash(blob.stdout), expected, 'The reviewed original Git blob must match exactly')
    }
    reviewedTransitions.push(transition)
  }
  if (review) assert.equal(reviewedTransitions.length, review.transitions.length, 'The exact reviewed peer pair must be observed together')
  const path = 'apps/desktop/test/goal-plan-discovery-product.test.tsx'
  const originalTest = readFileSync(join(legacyProof, 'original-harness/goal-plan-discovery-product.test.tsx'), 'utf8'), currentTest = readFileSync(resolve(repository, path), 'utf8')
  assert.equal(hash(originalTest), original.harness[path]); assert.ok(currentTest.startsWith(originalTest), 'The original eight consumer bodies must remain byte-for-byte unchanged')
  const increment = run('pending-origin')
  for (const path of ['apps/host/src/goal-pmo-origin.ts', 'apps/host/src/goal-participation-owner.ts']) assert.ok(increment.loaded.some(row => row.path === path), 'The current source-purpose and participation owners must evaluate')
  const sources = Object.fromEntries([...new Set(increment.loaded.map(row => row.path))].map(path => [path, hash(readFileSync(resolve(repository, path)))]))
  for (const row of increment.loaded) assert.equal(row.originalSHA256, sources[row.path], 'The evaluated pending-origin candidate changed: ' + row.path)
  const receipt = { schema: 'agentmux.goal-plan-legacy-origin-increment-proof.v1', success: true,
    scope: 'One actual Core/Host pending-origin consumer adds to the unchanged eight-case legacy proof. No repeated baseline or mutations; no model, Native daemon, or App-restart claim.',
    base: { path: '.bagakit/feature-tracker/goal-plan-discovery-artifacts/consumer-legacy-proof/receipt.json', sha256: hash(originalBytes), baseline: original.baseline, mutants: original.mutants, restored: original.restored },
    increment, sources, listenerAsset, existingTestBytesPreserved: true, reviewedPeerSourceTransitions: reviewedTransitions,
    harness: Object.fromEntries([path, config, 'apps/desktop/scripts/verify-goal-plan-discovery.mjs'].map(path => [path, hash(readFileSync(resolve(repository, path)))])) }
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ schema: receipt.schema, success: true, base: 8, mutations: 4, restored: 8, added: 1, evidence }))
} else {
const baseline = run('baseline'), mutants = mutations.map(mutate)
const restored = run('restored')
const sources = Object.fromEntries([...new Set(baseline.loaded.map(row => row.path))].map(path => [path, hash(readFileSync(resolve(repository, path)))]))
for (const run of [baseline, restored]) for (const row of run.loaded)
  assert.equal(row.originalSHA256, sources[row.path], 'The evaluated candidate changed during proof: ' + row.path)
const receipt = { schema: 'agentmux.goal-plan-discovery-consumer-proof.v1', success: true, scope: 'Mounted production UI to original Unix Host, Core input and Domain file. Public amux CLI plan producer; controlled Native I/O, no model or Native daemon. No live Goals touched.',
  sources, listenerAsset, baseline, mutants, restored, harness: Object.fromEntries(['apps/desktop/test/goal-plan-discovery-product.test.tsx', config,
    'apps/desktop/scripts/verify-goal-plan-discovery.mjs'].map(path => [path, hash(readFileSync(resolve(repository, path)))])) }
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ schema: receipt.schema, success: true, baseline: baseline.passed, mutations: mutants.length, restored: restored.passed, evidence }))
}
