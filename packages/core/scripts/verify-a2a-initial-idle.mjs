import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp', `a2a-initial-idle-${Date.now()}`)
const latestPath = join(root, '.tmp/a2a-initial-idle/latest.json')
const config = 'packages/core/test/a2a-initial-idle.config.mts'
const primary = ['packages/core/test/a2a-initial-idle.test.ts', 'packages/core/test/a2a-idle-input.test.ts']
const adjacent = ['packages/core/test/restored-prompt-predecessor.test.ts',
  'packages/core/test/native-turn-activity.test.ts', 'packages/core/test/codex-idle-queue.test.ts']
const mutations = [
  ['initial-opportunity-omitted', primary[0], 'source CLI sends a retained reference at initial idle', 1],
  ['native-opportunity-not-rechecked', primary[1], 'native idle (source|identity|working|unknown) changes before claim', 4],
  ['final-native-opportunity-not-rechecked', primary[1], '^settles an existing claim not-applied when its final native idle', 1],
  ['unknown-activity-denies-idle', primary[0], '^an unknown activity observation', 1],
  ['final-input-fence-omitted', primary[1], '^rechecks input bytes after the final awaited', 1],
  ['failed-claim-becomes-opportunity', primary[0], '^a rejected claim cannot create another idle opportunity', 1]
]
const hash = value => createHash('sha256').update(value).digest('hex')
const schema = 'agentmux.a2a-initial-idle-proof.v1'
const runtime = { node: process.version, platform: process.platform, arch: process.arch,
  executable: process.execPath, nodeOptions: process.env.NODE_OPTIONS ?? null }
// Bind verification machinery too: unchanged product sources alone cannot qualify a changed oracle.
const validationPaths = [
  'packages/core/scripts/verify-a2a-initial-idle.mjs', config, ...primary, ...adjacent,
  'packages/core/test/helpers/public-rpc-owner.ts', 'packages/core/test/helpers/source-object-cli.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/fixture-values.ts',
  'packages/core/test/fixtures/a2a-initial-idle/source-loader.mjs',
  'apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs',
  'packages/core/src/control-endpoint-listener-worker.ts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
  'node_modules/.modules.yaml', 'node_modules/vitest/package.json', 'node_modules/vitest/vitest.mjs',
  ...['core', 'identity', 'demand', 'relay', 'diagnostic-evidence'].flatMap(name =>
    [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`])
].sort()
async function fingerprints(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(root, path)))])))
}
async function checkFingerprints(values, label) {
  assert.ok(values && Object.keys(values).length > 0, label + ': missing fingerprints')
  for (const [path, sha] of Object.entries(values)) assert.equal(hash(await readFile(join(root, path))), sha, label + ': ' + path)
}
function checkInventory(proof) {
  assert.equal(proof.schema, schema); assert.equal(proof.passed, true)
  assert.equal(proof.sourceOnly, true); assert.equal(proof.sharedTreeMutations, 0)
  const check = (result, count, red = false) => {
    assert.equal(result.tests, count); assert.equal(result.inventory.length, count)
    assert.equal(new Set(result.inventory).size, count)
    assert.equal(result.signal, null)
    if (red) {
      assert.ok(result.code > 0 && result.assertionFailures > 0)
      assert.equal(result.failures, result.assertionFailures)
      assert.ok(result.transformed.length > 0)
    } else {
      assert.equal(result.code, 0); assert.equal(result.failures, 0)
      assert.equal(result.assertionFailures, 0); assert.equal(result.transformed.length, 0)
    }
  }
  check(proof.baseline, 41); check(proof.adjacent, 23)
  assert.ok(proof.baseline.cliSources.includes('packages/core/src/agentmux.ts'))
  assert.equal(proof.cases.length, mutations.length)
  for (const [index, [mutation, , , count]] of mutations.entries()) {
    const item = proof.cases[index]
    assert.equal(item.mutation, mutation); check(item.red, count, true); check(item.green, count)
    assert.deepEqual(item.red.inventory, item.green.inventory)
    assert.ok(item.red.inventory.every(name => proof.baseline.inventory.includes(name)))
    assert.ok(item.red.transformed.every(source => source.mutation === mutation && source.sha256 !== source.originalSHA256))
  }
}
const validationInputs = await fingerprints(validationPaths)
// Reuse only an intact successful proof of this exact source graph and verification inputs.
// The tracker may then bind the same command to a newer unrelated worktree candidate without rerunning it.
let cached
try {
  const pointer = JSON.parse(await readFile(latestPath, 'utf8'))
  const content = await readFile(pointer.receipt)
  assert.equal(hash(content), pointer.sha256)
  const proof = JSON.parse(content)
  checkInventory(proof)
  assert.deepEqual(proof.runtime, runtime); assert.deepEqual(proof.validationInputs, validationInputs)
  await checkFingerprints(proof.sourceGraph, 'Cached loaded source changed')
  await checkFingerprints(proof.artifacts, 'Cached evidence changed')
  cached = pointer.receipt
} catch { /* Missing, failed, incomplete or stale evidence requires the normal full gate. */ }
if (cached) {
  process.stdout.write(JSON.stringify({ passed: true, sourceOnly: true, reused: true, receipt: cached }) + '\n')
  process.exit(0)
}
const receipt = { schema, runtime, validationInputs, sourceOnly: true, sharedTreeMutations: 0, passed: false, cases: [],
  boundary: 'Actual source CLI/RPC -> Core journal/notification -> Input owner -> deterministic Provider queue receipt. Native evidence uses original Codex records. Runtime/Provider transport are private ports; installed app and model adoption are not qualified.' }
await mkdir(evidence, { recursive: true })
const graph = new Map()
const artifacts = new Map()
async function run(label, selected, mutation, pattern, expectedActive) {
  const reportPath = join(evidence, label + '.json'), loadedPath = join(evidence, label + '.loaded.jsonl')
  const cliLoadedPath = join(evidence, label + '.cli-loaded.jsonl')
  await writeFile(loadedPath, '')
  await writeFile(cliLoadedPath, '')
  const env = { ...process.env, AGENTMUX_INITIAL_IDLE_LOADED: loadedPath, AGENTMUX_INITIAL_IDLE_CLI_LOADED: cliLoadedPath }
  delete env.AGENTMUX_TEST_RPC_CORE_ENTRY; delete env.AGENTMUX_INITIAL_IDLE_MUTATION
  if (mutation) env.AGENTMUX_INITIAL_IDLE_MUTATION = mutation
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, ...selected,
      ...(pattern ? ['-t', pattern] : []), '--reporter=json', '--outputFile=' + reportPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, log }))
  })
  await writeFile(join(evidence, label + '.log'), result.log)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const active = report.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  const failures = active.filter(test => test.status === 'failed')
  const assertionFailures = failures.filter(test => test.failureMessages.some(message => message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message)))
  assert.equal(result.signal, null, label + ': interrupted process is not behavior proof')
  assert.ok(active.length > 0, label + ': no executed behavior assertions')
  if (expectedActive !== undefined) assert.equal(active.length, expectedActive, label + ': wrong bounded test inventory')
  const records = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const cliLoaded = await records(cliLoadedPath)
  const loaded = [...await records(loadedPath), ...cliLoaded]
  assert.ok(loaded.length > 0, label + ': missing source graph')
  for (const item of loaded) {
    assert.ok(!item.path.includes('/dist/'), label + ': compiled source cannot qualify a source-only proof: ' + item.path)
    assert.equal(hash(await readFile(join(root, item.path))), item.originalSHA256, label + ': candidate changed during load: ' + item.path)
    if (graph.has(item.path)) assert.equal(graph.get(item.path), item.originalSHA256, label + ': candidate changed between runs: ' + item.path)
    graph.set(item.path, item.originalSHA256)
  }
  const transformed = loaded.filter(item => item.mutation)
  if (mutation) {
    assert.ok(result.code > 0 && assertionFailures.length > 0, label + ': mutation must fail behavior assertions')
    assert.equal(failures.length, assertionFailures.length, label + ': non-assertion failures are not behavior proof')
    assert.ok(transformed.length > 0, label + ': source mutation did not load')
    assert.ok(transformed.every(item => item.mutation === mutation && item.sha256 !== item.originalSHA256), label + ': wrong source transform')
  } else {
    assert.equal(result.code, 0, label + ': baseline failed; inspect original log')
    assert.equal(failures.length, 0); assert.equal(transformed.length, 0)
  }
  for (const path of [reportPath, loadedPath, cliLoadedPath]) artifacts.set(relative(root, path), hash(await readFile(path)))
  return { report: reportPath, loaded: loadedPath, cliLoaded: cliLoadedPath, code: result.code, signal: result.signal,
    tests: active.length, failures: failures.length, assertionFailures: assertionFailures.length,
    inventory: active.map(test => test.fullName).sort(), transformed, cliSources: [...new Set(cliLoaded.map(item => item.path))].sort() }
}
try {
  receipt.baseline = await run('baseline', primary, undefined, undefined, 41)
  receipt.adjacent = await run('adjacent', adjacent, undefined, undefined, 23)
  for (const [mutation, test, pattern, count] of mutations) {
    const red = await run(mutation + '-red', [test], mutation, pattern, count)
    const green = await run(mutation + '-green', [test], undefined, pattern, count)
    assert.deepEqual(red.inventory, green.inventory)
    receipt.cases.push({ mutation, red, green })
    process.stdout.write(mutation + ': assertion RED -> GREEN\n')
  }
  receipt.sourceGraph = Object.fromEntries([...graph].sort(([a], [b]) => a.localeCompare(b)))
  receipt.artifacts = Object.fromEntries(artifacts)
  await checkFingerprints(receipt.sourceGraph, 'Final loaded source changed')
  await checkFingerprints(validationInputs, 'Final verification input changed')
  receipt.passed = true
  checkInventory(receipt)
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
if (receipt.failure) receipt.passed = false
const receiptPath = join(evidence, 'receipt.json'), content = JSON.stringify(receipt, null, 2) + '\n'
await writeFile(receiptPath, content)
assert.equal(receipt.passed, true, receipt.failure?.message + '\n' + evidence)
await mkdir(join(root, '.tmp/a2a-initial-idle'), { recursive: true })
const pendingPointer = latestPath + '.' + process.pid
await writeFile(pendingPointer, JSON.stringify({ receipt: receiptPath, sha256: hash(content) }) + '\n')
await rename(pendingPointer, latestPath)
process.stdout.write(JSON.stringify({ passed: true, sourceOnly: true, reused: false, receipt: receiptPath }) + '\n')
