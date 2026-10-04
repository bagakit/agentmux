import { tmpdir as fixtureTmpdir } from 'node:os'
import { join as fixtureJoin, sep as fixtureSep } from 'node:path'
const fixtureRootPath = relative => { const temporary = relative.replace(/^(?:private\/)?tmp\//u, ''); return (temporary === relative ? fixtureJoin(fixtureTmpdir(), 'agentmux-fixtures') : fixtureTmpdir()) + fixtureSep + temporary.replaceAll('/', fixtureSep) }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, rm, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/codex-provider-failure-artifacts/core')
const config = 'packages/core/test/fixtures/provider-session-failure/vitest.owning.config.mts'
const typeConfig = 'packages/core/test/fixtures/provider-session-failure/tsconfig.owning.json'
const tests = ['packages/core/test/provider-session-failure.test.ts', 'packages/core/test/codex-error-classification.test.ts']
const sources = ['packages/core/src/providers/codex-errors.ts', 'packages/core/src/providers/codex-session-status.ts',
  'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'packages/core/src/providers/codex.ts',
  'packages/core/src/agent-provider.ts', 'packages/core/src/types.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-status-freshness.ts', 'packages/core/src/session-timeline.ts',
  'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agentmux-cli-commands.ts']
const sha = data => createHash('sha256').update(data).digest('hex')
await mkdir(evidence, { recursive: true })
const read = file => readFile(join(root, file), 'utf8')
const before = Object.fromEntries(await Promise.all([...sources, ...tests, config, typeConfig,
  'packages/core/scripts/verify-provider-session-failure.mjs'].map(async file => [file, sha(await read(file))])))
function run(args, env = {}) {
  return spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
}
function diagnostics(result) { return (result.stdout + result.stderr).split('\n').filter(line => /^.*\([0-9]+,[0-9]+\): error TS/.test(line)) }
const types = run(['node_modules/typescript/bin/tsc', '--project', typeConfig])
await writeFile(join(evidence, 'owning-types.log'), types.stdout + types.stderr)
const typeDiagnostics = diagnostics(types), owningDiagnostics = typeDiagnostics.filter(line => [...sources, ...tests].some(file => line.startsWith(file + '(')))
assert.deepEqual(owningDiagnostics, [], 'Owning type diagnostics must be empty')
assert.ok(types.status === 0 || typeDiagnostics.length > 0, 'Compiler failure without diagnostics cannot qualify')
// Compile the current source into a private candidate; never use another worker's dist bytes.
const candidate = join(evidence, 'candidate')
await rm(candidate, { recursive: true, force: true }); await mkdir(join(candidate, 'bin'), { recursive: true })
await writeFile(join(candidate, 'package.json'), '{"type":"module"}\n')
await symlink(join(root, 'packages/core/node_modules'), join(candidate, 'node_modules'), 'dir')
await copyFile(join(root, 'packages/core/bin/agentmux'), join(candidate, 'bin/agentmux'))
const compile = run(['node_modules/typescript/bin/tsc', '--project', 'packages/core/tsconfig.build.json',
  '--composite', 'false', '--incremental', 'false', '--noEmitOnError', 'false', '--outDir', join(candidate, 'dist')])
await writeFile(join(evidence, 'candidate-compile.log'), compile.stdout + compile.stderr)
const compileDiagnostics = diagnostics(compile)
assert.deepEqual(compileDiagnostics.filter(line => sources.some(file => line.startsWith(file + '('))), [], 'Candidate owning compile diagnostics')
assert.ok(compile.status === 0 || compileDiagnostics.length > 0, 'Compiler startup failure cannot qualify candidate')
assert.ok((await readFile(join(candidate, 'dist/agentmux.js'))).byteLength > 0)
const baseEnv = { AMX_FAILURE_CLI: join(candidate, 'bin/agentmux'), AMX_FAILURE_COMPILED: join(candidate, 'dist'), AMX_FAILURE_PROOF: evidence }
const mutations = ['capacity', 'failure-is-done', 'ignore-native-error', 'late-old-turn', 'late-stop', 'no-reconnect', 'old-run', 'batch-start-clock', 'late-phase']
const receipts = []
async function execute(label, mutation) {
  const loaded = join(evidence, label + '.loaded.jsonl'), report = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const result = run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', report],
    { ...baseEnv, AMX_FAILURE_MUTATION: mutation ?? '', AMX_FAILURE_LOADED: loaded })
  await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr)
  const actual = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(actual.numTotalTests >= 48 && actual.numTotalTestSuites > 0, 'Nonempty real owning collection required')
  const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const file of sources.filter(file => !file.endsWith(fixtureRootPath("types.ts")) && !file.includes(fixtureRootPath("agentmux-cli-")))) {
    assert.ok(inputs.some(input => input.path === file && input.originalSHA256 === before[file]), 'Exact candidate source must load: ' + file)
  }
  if (mutation) {
    assert.ok(inputs.some(input => input.mutation === mutation && input.sha256 !== input.originalSHA256), 'Actual mutation must be loaded')
    const failed = actual.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert.ok(result.status !== 0 && failed.length > 0 && failed.some(test => test.failureMessages.some(message => /AssertionError|expected /u.test(message))), 'Mutation must fail a behavioral assertion')
    return { mutation, result: 'assertion-red', failed: failed.map(test => test.fullName), loadedSHA256: sha(await readFile(loaded)) }
  }
  assert.equal(result.status, 0, 'Owning tests failed; see ' + label + '.log')
  assert.equal(actual.numFailedTests, 0)
  return { result: 'green', tests: actual.numPassedTests, loadedSHA256: sha(await readFile(loaded)) }
}
const baseline = await execute('baseline')
console.log(JSON.stringify({ baseline }))
for (const mutation of mutations) {
  const red = await execute('mutation-' + mutation, mutation), restored = await execute('restore-' + mutation)
  receipts.push({ ...red, restored }); console.log(JSON.stringify({ mutation, red: true, restored: true }))
}
const callers = {}
for (const [symbol, definition] of [['codexFailure(', 'packages/core/src/providers/codex-errors.ts'],
  ['observeCodexSessionStatus', 'packages/core/src/providers/codex-session-status.ts'],
  ['ensureNativeStatusObservation(', 'packages/core/src/client.ts'],
  ['statusAgent(', 'packages/core/src/client.ts'], ['isAgentActivityStatusSource(', 'packages/core/src/agent-status-freshness.ts']]) {
  const search = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'packages/core/src', 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(search.status, 0)
  const hits = search.stdout.trim().split('\n').filter(line => symbol === 'ensureNativeStatusObservation('
    ? !line.includes('private async ensureNativeStatusObservation(') : !line.startsWith(definition + ':'))
  assert.ok(hits.length > 0, 'Nonempty production consumers: ' + symbol); callers[symbol] = hits
}
for (const [file, fingerprint] of Object.entries(before)) assert.equal(sha(await read(file)), fingerprint, 'Candidate source changed during gate: ' + file)
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.provider-session-failure.v1', passed: true,
  inputs: before, callers, baseline, mutations: receipts,
  types: { completeGraphPassed: types.status === 0, owningDiagnostics, externalDiagnostics: typeDiagnostics.filter(line => !owningDiagnostics.includes(line)) },
  compile: { completeGraphPassed: compile.status === 0, diagnostics: compileDiagnostics, candidate: 'candidate/dist',
    cliSHA256: sha(await readFile(join(candidate, 'dist/agentmux.js'))) },
  boundary: 'Private exact native sources, real Core/Store/RPC/compiled CLI; original user Runs are never controlled. Actual source mutations use Vite transforms in private worker processes. Unrelated full-graph diagnostics remain explicit; no installed Desktop or complete build is certified.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidence, 'qualification.json') }))
