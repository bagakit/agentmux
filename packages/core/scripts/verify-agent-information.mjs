import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { candidateHash as hash, fingerprintSources, nativeCandidateSources, compileNativeCandidate, runCandidateProgram } from './lib/native-candidate.mjs'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['contract', 'codex', 'claude', 'surface', 'integration'].includes(mode), 'Choose contract, codex, claude, surface or integration.')
const evidence = join(root, '.bagakit/agent-information-model/verification', mode)
// All modes reuse one private candidate. Source changes invalidate its compile receipt.
const candidate = join(root, '.local/agent-information/candidate')
const config = 'packages/core/test/agent-information-gate.config.mts'
const read = path => readFile(join(root, path))
await mkdir(evidence, { recursive: true })

const fingerprints = directory => fingerprintSources(root, directory)
const run = (args, env, timeout) => runCandidateProgram(root, process.execPath, args, env, timeout)
const { sources: productionSources, inputs: compileInputs } = await nativeCandidateSources(root)
const before = { ...compileInputs }
const oldMode = process.env.AMX_INFORMATION_MODE
process.env.AMX_INFORMATION_MODE = mode
const { informationTests, informationMutations } = await import('../test/agent-information-gate.config.mts')
if (oldMode === undefined) delete process.env.AMX_INFORMATION_MODE
else process.env.AMX_INFORMATION_MODE = oldMode
const tests = informationTests[mode]
assert.ok(tests.length && tests.every(path => typeof path === 'string' && !path.includes('*')), 'The gate must name exact nonempty test files.')
for (const path of tests) await read(path)
for (const path of [config, 'packages/core/scripts/verify-agent-information.mjs',
  'packages/core/test/fixtures/agent-information-loader.mjs', 'packages/core/test/fixtures/agent-information-native.mjs',
  'packages/core/test/fixtures/agent-information-owner.mjs', ...tests]) before[path] = hash(await read(path))
if (mode === 'codex' || mode === 'integration') before['packages/core/test/fixtures/codex-information-native-owner.mjs'] =
  hash(await read('packages/core/test/fixtures/codex-information-native-owner.mjs'))
if (mode === 'surface' || mode === 'integration') {
  Object.assign(before, await fingerprints('packages/client-ui/src'), await fingerprints('apps/desktop/src'))
  for (const path of ['apps/desktop/test/agent-information-surface.config.mts', 'apps/desktop/test/vitest.ui-controls-owning.config.mts',
    'apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts']) before[path] = hash(await read(path))
}

const { receipt: compiledReceipt, compiled: compiledInputs, reused } = await compileNativeCandidate(root, candidate, evidence, compileInputs)
process.stdout.write(JSON.stringify({ mode, compiled: 'ready', reused }) + '\n')

async function execute(label, mutation) {
  const loadedPath = join(evidence, label + '.loaded.jsonl'), compiledPath = join(evidence, label + '.compiled-loaded.jsonl')
  const reportPath = join(evidence, label + '.json')
  await writeFile(loadedPath, ''); await writeFile(compiledPath, '')
  const edit = mutation ? informationMutations[mutation] : undefined
  assert.ok(!mutation || edit, 'A real implementation edit must define the mutation: ' + mutation)
  const compiledEdit = edit && mutation === 'public-information-detached' ? { ...edit, mutation,
    path: edit.path.replace(/^packages\/(core|providers)\/src\//u, '$1/dist/').replace(/\.ts$/u, '.js') } : undefined
  const ownerSubset = mode === 'integration' && (mutation || label === 'restored')
  const selected = ownerSubset ? ['packages/core/test/agent-information-contract.test.ts']
    : (mutation || label === 'restored') && mode === 'codex' ? ['packages/core/test/codex-information.test.ts']
    : (mutation || label === 'restored') && mode === 'claude' ? ['packages/core/test/claude-information.test.ts'] : tests
  // Node owners and mounted Renderer consumers require their original package conditions.
  const rendered = new Set(informationTests.surface.filter(path => path.endsWith('.tsx')))
  const batches = ['integration', 'surface'].includes(mode) && !ownerSubset
    ? [{ name: 'node', files: selected.filter(path => !rendered.has(path)), surface: false },
      { name: 'surface', files: selected.filter(path => rendered.has(path)), surface: true }]
    : [{ name: mode, files: selected, surface: mode === 'surface' }]
  const reports = [], results = []
  for (const batch of batches) {
    assert.ok(batch.files.length, 'Each execution environment must have an exact nonempty test set.')
    const output = batches.length === 1 ? reportPath : join(evidence, label + '-' + batch.name + '.json')
    results.push(await run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', output,
      ...batch.files], {
      AMX_INFORMATION_MODE: mode, AMX_INFORMATION_SURFACE: batch.surface ? '1' : '',
      AMX_INFORMATION_MUTATION: mutation ?? '', AMX_INFORMATION_LOADED: loadedPath,
      AMX_INFORMATION_CANDIDATE: candidate, AMX_INFORMATION_COMPILED_LOADED: compiledPath,
      AMX_INFORMATION_COMPILED_EDIT: compiledEdit ? JSON.stringify(compiledEdit) : '',
      AGENTMUX_TEST_RPC_CORE_ENTRY: '', AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux')
    }))
    reports.push(JSON.parse(await readFile(output, 'utf8')))
  }
  const result = { code: results.every(value => value.code === 0) ? 0 : 1 }
  await writeFile(join(evidence, label + '.log'), results.map(value => value.stdout + value.stderr).join('\n'))
  const report = reports.length === 1 ? reports[0] : {
    success: reports.every(value => value.success), testResults: reports.flatMap(value => value.testResults),
    ...Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests',
      'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'].map(key =>
      [key, reports.reduce((sum, value) => sum + (value[key] ?? 0), 0)])) }
  if (reports.length > 1) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  assert.ok(report.numTotalTests > 0 && report.testResults.length > 0, 'The behavior set must be nonempty.')
  const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const loaded = await lines(loadedPath), compiled = await lines(compiledPath)
  assert.ok(loaded.length, 'The tests must load the actual candidate source.')
  for (const input of loaded) assert.equal(input.originalSHA256, before[input.path], 'The source candidate changed or escaped its worktree: ' + input.path)
  for (const input of compiled) assert.equal(input.originalSHA256, compiledInputs[input.path], 'The wrong compiled candidate loaded: ' + input.path)
  if (['contract', 'integration'].includes(mode) && !ownerSubset) for (const path of ['core/dist/client.js', 'core/dist/public-rpc-service.js', 'core/dist/agentmux.js']) {
    assert.ok(compiled.some(input => input.path === path), 'The public product consumer must actually load: ' + path)
  }
  if (mode === 'surface') assert.ok(compiled.some(input => input.path === 'core/dist/public-rpc-server.js'),
    'The production Main route must consume the actual compiled Server and its private listener asset.')
  if (mutation) {
    const implementations = [...loaded, ...compiled].filter(input => input.mutation === mutation && input.sha256 !== input.originalSHA256)
    const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert.ok(implementations.length, 'The actual mutant implementation must load: ' + mutation)
    assert.ok(result.code !== 0 && failed.some(test => test.failureMessages.some(message => /AssertionError|expected |promise (?:resolved .* instead of rejecting|rejected .* instead of resolving)/u.test(message))),
      'The mutation must fail a behavior assertion, rather than collection or a timeout: ' + mutation)
    return { mutation, result: 'assertion-red', failed: failed.map(test => test.fullName), implementations }
  }
  assert.equal(result.code, 0, 'Candidate behavior failed; see ' + label + '.log.')
  assert.equal(report.numFailedTests, 0); assert.ok(report.numPassedTests > 0, 'Skipped-only tests cannot qualify.')
  return { result: 'green', tests: report.numPassedTests, files: report.testResults.map(file => relative(root, file.name)) }
}

const baseline = await execute('baseline')
process.stdout.write(JSON.stringify({ mode, baseline }) + '\n')
const mutations = mode === 'contract' ? ['wrong-native-information', 'fake-model-ack', 'public-information-detached']
  : mode === 'codex' ? ['codex-native-identity', 'codex-fake-ack', 'codex-original-request-id', 'codex-reset-unit', 'codex-duplicate-dispatch']
  : mode === 'claude' ? ['claude-information-detached', 'claude-information-repeated', 'claude-reset-unit', 'claude-information-not-saved', 'claude-old-sequence', 'claude-gap-ignored']
  : mode === 'surface' ? ['surface-push-disconnected', 'surface-unknown-ack-applied', 'surface-remote-host-detached']
  : ['owner-sdk-reference', 'owner-null-retained', 'owner-newer-ack-erased']
const reds = []
for (const mutation of mutations) {
  reds.push(await execute('mutation-' + mutation, mutation))
  process.stdout.write(JSON.stringify({ mode, mutation, result: 'assertion-red' }) + '\n')
}
const restored = mutations.length ? await execute('restored') : baseline
for (const [path, sha] of Object.entries(before)) assert.equal(hash(await read(path)), sha, 'The candidate changed during qualification: ' + path)
assert.deepEqual({ ...await fingerprints('packages/core/src'), ...await fingerprints('packages/providers/src') }, productionSources,
  'New or removed production sources invalidate this exact candidate qualification.')
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.agent-information.v1', mode,
  passed: true, inputs: before, compiled: { ...compiledReceipt, inputs: compiledInputs }, baseline, mutations: reds, restored,
  boundary: 'Exact candidate Core and Providers, real Control/RPC and compiled CLI, with isolated Provider/Runtime fixture inputs. Native vendor validation and rendered visual review remain separately attributed evidence; no user Run or installed Desktop is operated.' }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ mode, passed: true, qualification: relative(root, join(evidence, 'qualification.json')) }) + '\n')
if (mode === 'integration') await rm(candidate, { recursive: true, force: true })
